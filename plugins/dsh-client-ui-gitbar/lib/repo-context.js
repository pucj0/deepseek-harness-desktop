// 工作区 → 仓库的解析：把「用户打开的目录」与「Git 工作树的顶层」拆成两个概念。
//
//   workspaceRoot    用户/会话打开的那个目录（会话 cwd），也是安全边界的单位。
//   repositoryRoot   该目录所属 Git 工作树的**真实顶层**，由 host 用
//                    `git rev-parse --show-toplevel` 在 workspaceRoot 里推导。
//
// 为什么要拆：项目级 Git 面板以前把 workspaceRoot 同时当成"Git 的 cwd"、"路径展示基准"、
// "快照缓存键"与"仓库身份"。当用户打开的是仓库里的一个子目录（例如
// `D:/project/mmsm-amis/pages/mse`）时，这四件事会同时出错：
//   * `git ls-files --others` 这类**带前缀语义**的命令只报该子目录下的文件，于是"未跟踪
//     文件"少了一大截；
//   * 同一个仓库的两个子目录被当成两个不同的仓库，各跑一套 status 轮询与快照；
//   * 路径基准随调用点变化，界面上时而 `../src/a.js` 时而 `src/a.js`。
// 因此 repositoryRoot **只能由 host 推导**，绝不接受客户端传入（否则客户端可以传
// `repositoryRoot=C:/` 越过工作区安全边界，让 host 对任意目录跑 git 与读写）。
//
// 这个文件在两个 host 插件（review / gitbar）里各有一份**逐字节相同**的副本：两个插件是
// 各自独立的包（启动时整目录同步进 runtime 的 node_modules），跨包 import 会让"另一个
// 插件不存在"变成加载期错误。`scripts/test-repo-context-parity.mjs` 钉住两份一致，并对
// 真实的临时仓库跑一遍，确认两边解析出的仓库根完全相同。
//
// 纯函数 + 依赖注入：`runGit` 由调用方传入（两个插件自己的 git() 包装在超时/缓冲上设置
// 不同），因此这里没有 child_process、没有全局状态，可以离线单测。

/** 缓存条数上限：工作区数量级很小（会话数），给足余量同时保证有界。 */
export const REPO_CONTEXT_CACHE_MAX = 64

/**
 * 正向结果的存活时间。
 *
 * 取 5 分钟：`workspaceRoot → repositoryRoot` 几乎不变，但仓库本身会变——用户在子目录里
 * `git init`、或者删掉 `.git` 都会改变答案（负向结果有更短的 TTL 兜住这一点）。5 分钟
 * 的过期意味着"最坏情况下界面在 5 分钟后自己纠正"，而在此期间省掉的是**每次 status
 * 轮询都要多跑的两个 git 进程**（rev-parse ×2）。
 */
export const REPO_CONTEXT_TTL_MS = 5 * 60 * 1000

/**
 * 负向结果（"这里不是仓库"）的存活时间。
 *
 * 必须比正向短得多：`git init` 之后用户立刻回到面板，期待看到"这是个仓库了"。10 秒既
 * 挡住了轮询路径上的重复探测（每 10 秒一次 poll ≈ 命中一次），又不会让用户等太久。
 */
export const REPO_CONTEXT_NEGATIVE_TTL_MS = 10 * 1000

/**
 * 把 git 报出的路径统一成"本机风格"。
 *
 * Windows 上 `rev-parse --show-toplevel` 回的是**正斜杠**路径
 * （`C:/Users/x/proj`），而 `fs.realpathSync.native` 与工作区校验回的是反斜杠。两者混用
 * 会让"同一个目录"变成两个字符串，于是缓存与比较全部失效。这里只统一分隔符，不做
 * 大小写折叠（真实路径已经在 realpath 之后）。
 *
 * @param value - 路径。
 * @returns 统一分隔符后的路径。
 */
export function toNativePath(value) {
  return String(value).replace(/\\/gu, '/')
}

/**
 * 粗判一个字符串是否是绝对路径。
 *
 * 只用于"裸仓库"这个边界：`git rev-parse --show-toplevel --absolute-git-dir` 在裸仓库里
 * 只输出 git 目录那一行，于是 `parts[0]` 会是 git 目录而不是工作树顶层。区分办法是
 * "第一行像不像绝对路径"——Windows 盘符（`C:/…`）、UNC（`//server/…`）、以及 POSIX
 * 的 `/…` 都算。
 *
 * @param value - 候选路径。
 * @returns 像绝对路径则 true。
 */
export function isAbsoluteLike(value) {
  const text = String(value)
  return /^[A-Za-z]:[\\/]/u.test(text) || text.startsWith('\\\\') || text.startsWith('//') || text.startsWith('/')
}

/**
 * 组装一个 ProjectGitScope。
 *
 * 本轮一个项目只有一个仓库，但**数据形状不要写死** `workspaceRoot === repositoryRoot`：
 * 以后 `project/{frontend,backend}` 各带一个 `.git` 时，这里扩成两个 RepoContext 即可，
 * 客户端与路由不需要改形状。也**不通过递归扫硬盘找 `.git`**（那在大仓库上是灾难）。
 *
 * @param context - 单个仓库上下文 `{ workspaceRoot, repositoryRoot, gitDir? }`。
 * @returns `{ workspaceRoot, repositoryRoot, repositories: [context] }`。
 */
export function createProjectGitScope(context) {
  return {
    workspaceRoot: context.workspaceRoot,
    repositoryRoot: context.repositoryRoot,
    repositories: [
      {
        workspaceRoot: context.workspaceRoot,
        repositoryRoot: context.repositoryRoot,
        gitDir: context.gitDir ?? '',
      },
    ],
  }
}

/**
 * 创建一个 `workspaceRoot → RepoContext` 的解析器。
 *
 * 两个特性使它适合放在轮询路径上：
 *   * **bounded cache**：正/负结果都缓存，条数上限 `REPO_CONTEXT_CACHE_MAX`（先进先出
 *     淘汰），因此长时间运行不会无限增长；
 *   * **single-flight**：同一个 workspaceRoot 的并发解析只跑一次 git，多个路由（status /
 *     workspace / graph / …）同时打进来不会各跑一遍 rev-parse。
 *
 * @param options - `{ runGit, realpath, max, ttlMs, negativeTtlMs, now }`。
 *   `runGit(args, cwd)` 返回 stdout（Promise 或字符串），失败时抛错/拒绝。
 *   `realpath(value)` 解析真实路径（拿不到时退回分隔符归一化）。
 * @returns 解析器。
 */
export function createRepoContextResolver(options) {
  const runGit = options.runGit
  const realpath =
    typeof options.realpath === 'function'
      ? options.realpath
      : (value) => value
  const max = Number.isFinite(options.max) && options.max > 0 ? Math.trunc(options.max) : REPO_CONTEXT_CACHE_MAX
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= 0 ? options.ttlMs : REPO_CONTEXT_TTL_MS
  const negativeTtlMs =
    Number.isFinite(options.negativeTtlMs) && options.negativeTtlMs >= 0 ? options.negativeTtlMs : REPO_CONTEXT_NEGATIVE_TTL_MS
  const now = typeof options.now === 'function' ? options.now : () => Date.now()

  /** workspaceRoot → `{ context, at }`；`context === undefined` 表示"不是仓库"（负缓存）。 */
  const cache = new Map()
  /** workspaceRoot → 在途的解析 promise（single-flight）。 */
  const inflight = new Map()

  const remember = (workspaceRoot, context) => {
    // 重新插入也要先删：Map 的迭代顺序是插入顺序，删掉再放回去才算是"最近使用"，
    // 否则被反复访问的那一条会在淘汰时最先出局。
    cache.delete(workspaceRoot)
    cache.set(workspaceRoot, { context, at: now() })
    while (cache.size > max) {
      const oldest = cache.keys().next()
      if (oldest.done === true) break
      cache.delete(oldest.value)
    }
  }

  const safeRealpath = (value) => {
    try {
      return realpath(value)
    } catch {
      // 路径不存在（例如仓库根刚好被删掉）：退回归一化后的原文，至少形状一致。
      return toNativePath(value)
    }
  }

  /** 真的去问 git。失败一律当成"不是仓库"，不抛给调用方。 */
  const probe = async (workspaceRoot) => {
    let raw
    try {
      // **一次调用拿两个字段**：`rev-parse` 支持多个 `--` 选项，输出按行对应。
      // 分成两次调用会让每条轮询路径的首次请求多起一个进程——而这个探针在 gitbar 那边
      // 有"一次请求的 git 进程数 ≤ 2"的性能断言（见 scripts/test-gitbar-branch-perf.mjs），
      // 那正是为了防住"每轮都多起几个进程"这类回退。
      raw = String(await runGit(['rev-parse', '--show-toplevel', '--absolute-git-dir'], workspaceRoot))
    } catch {
      return undefined
    }
    const parts = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
    // 裸仓库没有工作树：`--show-toplevel` 不输出，只剩 git 目录。那种目录不是本插件
    // 认的"工作区"（面板要的是能列出文件的工作树），因此按"不是仓库"处理。判据是
    // 第一行必须像一个绝对路径，且与第二行不同（同一行说明只回了一个字段）。
    if (parts.length === 0 || parts[0] === parts[1]) return undefined
    if (!isAbsoluteLike(parts[0])) return undefined
    return {
      workspaceRoot,
      repositoryRoot: safeRealpath(parts[0]),
      // gitDir 不是判断"是不是仓库"的依据（worktree / submodule 下两者可以指向完全
      // 不同的地方），因此它只是附带信息，拿不到不影响结论。
      gitDir: parts[1] === undefined ? '' : safeRealpath(parts[1]),
    }
  }

  const isFresh = (entry) => {
    if (entry === undefined) return false
    const ttl = entry.context === undefined ? negativeTtlMs : ttlMs
    return now() - entry.at < ttl
  }

  return {
    /**
     * 解析一个工作区。
     *
     * @param workspaceRoot - 已通过安全校验的真实工作区路径。
     * @returns `{ workspaceRoot, repositoryRoot, gitDir }`；不是仓库时 undefined。
     */
    async resolve(workspaceRoot) {
      if (typeof workspaceRoot !== 'string' || workspaceRoot === '') return undefined
      const cached = cache.get(workspaceRoot)
      if (isFresh(cached)) return cached.context
      const running = inflight.get(workspaceRoot)
      if (running !== undefined) return running
      const task = (async () => {
        try {
          const context = await probe(workspaceRoot)
          remember(workspaceRoot, context)
          return context
        } finally {
          if (inflight.get(workspaceRoot) === task) inflight.delete(workspaceRoot)
        }
      })()
      inflight.set(workspaceRoot, task)
      return task
    },

    /**
     * 只看缓存，不发起 git。
     * @param workspaceRoot - 工作区路径。
     * @returns 缓存里的上下文；没缓存或已过期时 undefined。
     */
    peek(workspaceRoot) {
      const entry = cache.get(workspaceRoot)
      return isFresh(entry) ? entry.context : undefined
    },

    /**
     * 丢掉一个工作区的缓存（写操作改变仓库形态时调用：`git init`、删除 `.git`）。
     * @param workspaceRoot - 工作区路径；不传则清空全部。
     */
    invalidate(workspaceRoot) {
      if (typeof workspaceRoot === 'string' && workspaceRoot !== '') cache.delete(workspaceRoot)
      else cache.clear()
    },

    /** 当前缓存条数（诊断与测试用）。 */
    size() {
      return cache.size
    },

    /** 在途解析数量（诊断与测试用）。 */
    pending() {
      return inflight.size
    },
  }
}
