// 只用 node:fs 的两个原语（列目录 / 判存在），而且默认实现可以被注入替换——单测因此能在
// **纯内存**的合成树上跑 10,000+ 目录的性能用例，不必真在磁盘上建出来。
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'

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
//
// 第二轮扩展：`workspaceRoot` 下面的**独立仓库**（项目级 Git 作用域）。
//
//   F:\code_buss\haiweiNew                       ← 用户打开的工作区，自己不是仓库
//   ├── haiwei-manage-fronted/.git               ← 真正的仓库
//   └── …
//
// 这种形状下只跑一次 `rev-parse` 会回答"不是 git 仓库"，面板就废了。因此这里再加一层
// **有界**的目录发现：只在 maxDepth 层以内找 `.git` 标记，只 listDirectory + exists
// （从不读文件内容），并按 maxDirs / 时间预算硬性截断。`createProjectGitScope` 那条
// "不通过递归扫硬盘找 `.git`"的注释说的是**无界**递归，这里是有界的，且快路径
// （自身 + 第一层子目录）就已经覆盖了绝大多数真实工程形状。

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
 * 项目级仓库发现的边界（一次发现的硬上限，见各字段说明）。
 *
 * 每个数字都是"宁可少发现一个仓库，也不能让一次轮询卡住"的取舍：
 *
 *   maxDepth 4       真实工程里仓库最多埋在 `组/项目/前端/` 这种三四层下；再深要么是
 *                    依赖目录（已排除），要么应该把 workspaceRoot 指过去。层数语义见
 *                    `scan`：相对 workspaceRoot 的第一层子目录 = 1。
 *   maxDirs 4000     一次发现最多访问 4000 个目录（**硬上限**：批量取目录时会按剩余名额
 *                    收窄）。10,000+ 目录的树到这里被截断（结果标 `complete:false`），
 *                    而不是把事件循环占满。
 *   concurrency 8    并发 listDirectory。8 足够把"几百个目录的第一层"从 N 次串行往返
 *                    压成一次，又不会瞬间丢出上千个 fs 请求把 IO 队列打爆。
 *   fastBudgetMs 250 快路径（自身 + 第一层）的**总**时间预算。这一层必须在下一次
 *                    轮询之前给出答案，因此宁可返回"还没扫完"，也不能等。
 *   ttlMs 60000      项目级作用域（"这个工作区下面有哪些仓库"）比 workspaceRoot→
 *                    repositoryRoot 变得慢得多：用户重新组织目录的间隔以分钟计。
 *   excludeDirs      名字命中即**不下钻**（大小写不敏感）：这些目录里出现的 `.git`
 *                    是依赖/构建产物（`node_modules/foo/.git`、`dist/.git`），报出来
 *                    只会让面板列出一堆幽灵仓库。
 */
export const PROJECT_SCOPE_LIMITS = Object.freeze({
  maxDepth: 4, // 相对 workspaceRoot 的层数：第一层子目录 = 1
  maxDirs: 4000, // 一次发现最多访问多少个目录
  concurrency: 8, // 并发 listDirectory 数
  fastBudgetMs: 250, // 快路径（自身 + 第一层子目录）的时间预算
  ttlMs: 60000, // ProjectGitScope 缓存 TTL
  excludeDirs: Object.freeze(['.git', 'node_modules', 'dist', 'build', 'target', 'out', 'coverage', '.cache', '.gradle', '.idea', '.next', '.nuxt', 'vendor', '__pycache__']),
})

/**
 * 是否跳过这个目录名（不下钻、也不报它自己）。
 *
 * 逐个小写比较而不是建 Set：14 个常量比较的开销可以忽略（每次访问目录一次），而模块级
 * 的 Set 会让"常量是冻结的字面量"这件事变得不显然。
 *
 * @param name - 目录名（单段）。
 * @returns 命中排除名单则 true。
 */
function isExcludedDirName(name) {
  const lower = String(name).toLowerCase()
  return PROJECT_SCOPE_LIMITS.excludeDirs.some((item) => item.toLowerCase() === lower)
}

/** 取路径的最后一段（去掉结尾分隔符后从最后一个分隔符切开）。 */
function lastSegment(value) {
  const parts = toNativePath(value).split('/').filter((part) => part !== '')
  return parts.length === 0 ? '' : parts[parts.length - 1]
}

/** 目录发现：被跳过（排除名单）的目录会计入 `skipped`，供测试断言"根本没 list"。 */
function createDiscoveryState() {
  return {
    visited: 0,
    candidates: 0,
    probes: 0,
    truncated: false,
    skipped: 0,
    startedAt: 0,
    found: [],
    seen: new Set(),
    // 预算账目的两个辅助计数（见 scan 的说明）：
    //   * `deepQueued`：入队过的 depth > 1 目录总数（也就是"快路径之外"的目录）；
    //   * `deepVisited`：其中真正被访问过的数量。
    // 两者的差就是 `pendingAfter`——"还有多少快路径之外的目录没看"，也正是 `complete` 的
    // 判据。用两个计数器而不是遍历队列，是为了让这段跑在轮询路径上的代码保持 O(1) 收尾。
    deepQueued: 0,
    deepVisited: 0,
  }
}

/** 把一个已确认的仓库收进结果：按 canonical `repositoryRoot` 去重。 */
function addRepository(state, entry) {
  if (entry.repositoryRoot === '') return
  if (state.seen.has(entry.repositoryRoot)) return
  state.seen.add(entry.repositoryRoot)
  state.found.push(entry)
}

/**
 * 组装一个 ProjectGitScope。
 *
 * `createProjectGitScope` 那个单仓库形状仍然保留（`scopeFields` 还在用它），这里的形状
 * 是**项目级**的扩展：`repositories` 里每一项带 `relativePath`（仓库相对工作区的位置）
 * 与 `name`，客户端据此把"哪个仓库"铺成列表。同样**不通过无界递归**扫硬盘：所有发现都
 * 经过 `PROJECT_SCOPE_LIMITS` 的层数/目录数/时间三重截断。
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
 * @param options - `{ runGit, realpath, max, ttlMs, negativeTtlMs, now, listDirectory, exists, limits }`。
 *   `runGit(args, cwd)` 返回 stdout（Promise 或字符串），失败时抛错/拒绝。
 *   `realpath(value)` 解析真实路径（拿不到时退回分隔符归一化）。
 *   `listDirectory(path)` 列目录（见下），`exists(path)` 判存在；默认走 node:fs。
 *   `limits` 覆盖 `PROJECT_SCOPE_LIMITS` 的个别字段（测试用它把预算压到毫秒级）。
 * @returns 解析器。
 */
export function createRepoContextResolver(options) {
  const runGit = options.runGit
  const realpath =
    typeof options.realpath === 'function'
      ? options.realpath
      : (value) => value
  // 目录发现的两个原语由调用方注入，因此单测可以在**纯内存**的合成树上跑（10,000+ 目录
  // 的性能用例绝不能真在磁盘上建出来）。
  const listDirectory =
    typeof options.listDirectory === 'function'
      ? options.listDirectory
      : async (path) => {
          try {
            const entries = await readdir(path, { withFileTypes: true })
            return entries.map((entry) => ({
              name: entry.name,
              isDirectory: entry.isDirectory(),
              isFile: entry.isFile(),
            }))
          } catch {
            // 目录不可读（权限、正好被删）：当成空目录，发现流程继续跑别的分支，
            // 绝不因为一个坏目录让整个面板报错。
            return []
          }
        }
  const exists = typeof options.exists === 'function' ? options.exists : (path) => existsSync(path)
  const limits = { ...PROJECT_SCOPE_LIMITS, ...(options.limits ?? {}) }
  const scopeTtlMs = Number.isFinite(limits.ttlMs) && limits.ttlMs >= 0 ? limits.ttlMs : PROJECT_SCOPE_LIMITS.ttlMs
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

  const scopeRoot = (workspaceRoot) => (typeof workspaceRoot === 'string' ? toNativePath(workspaceRoot) : '')

  /**
   * 用一次 `rev-parse` 确认一个候选目录**真的是**仓库。
   *
   * 为什么必须回问 git、而不是"看到 `.git` 就当仓库"：`.git` 可能是普通目录、可能是指向
   * worktree 元数据的**文件**（submodule / worktree）、还可能是残留的空目录。只有
   * `--show-toplevel --absolute-git-dir` 的输出才是权威（并且顺手拿到真实 git 目录，
   * submodule 下它与 `<dir>/.git` 不是一回事）。失败只说明"这个候选不是仓库"，不抛。
   */
  const probeAt = async (workspaceRoot, directory) => {
    let raw
    try {
      raw = String(await runGit(['rev-parse', '--show-toplevel', '--absolute-git-dir'], directory))
    } catch {
      return undefined
    }
    const parts = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
    if (parts.length === 0 || parts[0] === parts[1]) return undefined
    if (!isAbsoluteLike(parts[0])) return undefined
    const repositoryRoot = safeRealpath(parts[0])
    return {
      repositoryRoot,
      gitDir: parts[1] === undefined ? '' : safeRealpath(parts[1]),
      relativePath: directory === workspaceRoot ? '' : directory.slice(workspaceRoot.length + 1),
      name: lastSegment(repositoryRoot),
    }
  }

  /**
   * 有界的目录发现：一个 async generator，**恰好 yield 一次**，位置在快路径（depth 0/1）
   * 处理完之后——那一次 yield 就是"快路径的答案已经定稿、剩下的交给后台"的信号。
   *
   * 为什么是 generator 而不是跑两遍：快路径与后台的 BFS 必须共享同一份队列与同一份预算
   * 账目（否则 `directoriesVisited` 这类计数对不上），而调用方又必须能在快路径末尾**立刻**
   * 拿到答案。generator 把这两件事同时做到：`next()` 返回 `{ done:false }` 表示"快路径
   * 扫完了、还有更深的目录"；返回 `{ done:true, value }` 表示整次发现结束。
   *
   * 顺序是 BFS：先整个第一层，再第二层……因此 `frontend/.git` 与 `backend/.git` 处于同一
   * 层、都会被访问到——**发现一个仓库绝不停下**，否则兄弟仓库会漏。depth 达到 `maxDepth`
   * 的目录仍然会被检查 `.git`（它自己可能就是仓库根），只是不再往下走。
   *
   * 预算账目（每一项都只在一个地方 +1，因此"访问了多少 / 探测了多少"永远可核对）：
   *   * `directoriesVisited`：每出队一个目录 +1（列了目录），每执行一次 `exists(<dir>/.git)`
   *     再 +1（查了标记）——因此它数的是"列过或查过的目录数"；
   *   * `candidatesFound`：只在 `.git` 标记存在时 +1；
   *   * `gitProbes`：只在真的跑了 `rev-parse` 时 +1，所以它与**候选数**成正比，与访问过的
   *     目录数无关（10,000 个目录里只有 3 个候选，就是 4 次进程）。
   *
   * @param workspaceRoot - 工作区（已归一化）。
   * @param containing - `probe(workspaceRoot)` 的结果（可能是 undefined）。
   * @param state - 发现状态（预算账目写在这里）。
   * @param deepUntil - 后台那一段的截止时刻（注入时钟）。
   */
  async function* scan(workspaceRoot, containing, state, deepUntil) {
    const directory = (path) => toNativePath(path)
    const workspace = directory(workspaceRoot)
    const fastDeadline = now() + limits.fastBudgetMs
    // 容器仓库（工作区自己所属的那个）先入列：`relativePath` 是空串、`name` 取仓库根的最后
    // 一段。它同时也满足"工作区自己就是一个候选"的情况——按 canonical `repositoryRoot`
    // 去重之后仍然只有一条。
    if (containing !== undefined) {
      addRepository(state, {
        repositoryRoot: containing.repositoryRoot,
        gitDir: containing.gitDir,
        relativePath: '',
        name: lastSegment(containing.repositoryRoot),
      })
    }
    const queue = [{ path: workspace, depth: 0 }]
    // 队首下标，替代 `Array#shift`：队列在宽目录树上很容易上万条，而这段代码跑在**轮询
    // 路径**上（每次发现都要过一遍），O(n) 的搬移不值得。
    let head = 0
    let until = fastDeadline
    let truncated = false
    let phase = 'fast'

    /**
     * 从队首取下一批（最多 `concurrency` 个），并保证**记账上界 `maxDirs` 是硬上限**：
     * 一次批量里最多只剩多少个名额就取多少个。否则"批次先取满、再在本轮里逐个 +2"会让
     * `directoriesVisited` 冲过 `maxDirs`（宽树上一次最多超 `2 × concurrency`），而
     * `maxDirs` 的意义就是"一次发现最多访问多少个目录"。
     */
    const takeBatch = () => {
      const room = Math.ceil((limits.maxDirs - state.visited) / 2)
      const limit = Math.max(0, Math.min(limits.concurrency, room))
      const batch = []
      while (batch.length < limit && head < queue.length) {
        batch.push(queue[head])
        head += 1
      }
      return batch
    }

    while (true) {
      // 时间预算只在**访问目录之间**检查：单次 listDirectory 可能很慢，但不能因为它慢就把
      // 已经开始的这一轮记账丢在半路（`visited` 与实际发生的调用必须一致）。
      if (now() >= until) {
        truncated = true
        break
      }
      const batch = takeBatch()
      if (batch.length === 0) {
        // 队列空了、或者 `maxDirs` 已经用满。后者是截断。
        if (state.visited >= limits.maxDirs) truncated = true
        break
      }

      const listed = await Promise.all(
        batch.map(async (item) => {
          state.visited += 1
          // `deepVisited` 必须与 `deepQueued`（同样是 depth > 1）配对，否则相减出来的
          // `pendingAfter` 会把已经访问过的浅目录算成"没看的更深目录"，`complete` 永远为 false。
          if (item.depth > 1) state.deepVisited += 1
          const names = await listDirectory(item.path)
          return { item, names }
        }),
      )

      for (const { item, names } of listed) {
        state.visited += 1
        if (exists(`${item.path}/.git`)) {
          state.candidates += 1
          state.probes += 1
          const entry = await probeAt(workspace, item.path)
          if (entry !== undefined) addRepository(state, entry)
        }
        // 到了 maxDepth 就不再往下走（这**不算**截断——见函数末尾的说明），但**报出这个
        // 目录本身**：它可能就是仓库根。
        if (item.depth >= limits.maxDepth) continue
        for (const child of names) {
          if (child.isDirectory !== true) continue
          // 排除名单里的目录：不下钻、也不报它自己。依赖/构建产物里的 `.git`
          // （node_modules/foo/.git）是幽灵仓库，报出来只会污染面板。
          if (isExcludedDirName(child.name)) {
            state.skipped += 1
            continue
          }
          const depth = item.depth + 1
          // 快路径边界用的判据是"depth >= 2 已经出现"，因此这里数的是**所有** depth > 1 的
          // 入队目录（不是 depth > maxDepth——那样在第一层全是浅目录时会一个都不数，快路径
          // 会被误判成"整棵树扫完了"）。
          if (depth > 1) state.deepQueued += 1
          queue.push({ path: directory(`${item.path}/${child.name}`), depth })
        }
      }

      // 快路径边界：第一批 depth 0、之后全是 depth 1，直到底层 BFS 开始产出 depth 2（或更高）
      // 的目录。"有 depth >= 2 入队"这个判据意味着 depth 0/1 都已经处理完了：
      //   * 换成一个"队列里还剩几个 depth-1"的计数器会错在"第一层全是叶子目录"——计数器会在
      //     还没产出任何 depth-2 时归零，于是快路径被误判成"整棵树扫完了"，后台永远不跑
      //     （真机的形状恰好就是这样：第一层几百上千个叶子目录，仓库埋在其中一个的子目录里）；
      //   * 换成"队列非空"会错在 depth 0 刚列完就交棒，快路径连第一层都没看。
      if (phase === 'fast' && state.deepQueued > 0) {
        phase = 'deep'
        until = deepUntil
        // 队列里还有东西 -> 后台那一段有事可做；没有的话（极罕见：deepQueued 来自
        // maxDirs 截断后的残留）主循环会自然退出。
        if (head < queue.length) yield { fast: true }      }
    }

    // `truncated` 覆盖两种**真的没扫完**：撞到 `maxDirs`，或时间预算耗尽。走到 maxDepth
    // 而停**不算**——那只是"不许再往下看"，由 `pendingAfter`（入队过但没访问的更深目录数）
    // 表达：如果它是 0，说明最深那一层本来就没有子目录，这次发现其实是完整的。
    const pendingAfter = state.deepQueued - state.deepVisited
    state.truncated = truncated || pendingAfter > 0
    return { pendingAfter, truncated: state.truncated }
  }

  /**
   * 把发现的中间/最终状态定稿成一个 ProjectGitScope。
   *
   * @param pendingOverride - 快路径那一份要显式声明"还没扫完"（`pendingAfter:1`）；整次发现
   *   结束时用真实的 `deepQueued - deepVisited`。
   */
  const stateToScope = (workspaceRoot, state, pendingOverride, truncatedOverride) => {
    const pendingAfter = pendingOverride ?? state.deepQueued - state.deepVisited
    const truncated = truncatedOverride ?? state.truncated
    return {
      workspaceRoot,
      repositories: state.found.map((entry) => ({
        repositoryRoot: entry.repositoryRoot,
        gitDir: entry.gitDir,
        relativePath: entry.relativePath,
        name: entry.name,
      })),
      discovery: {
        // 只有"整棵树扫完、且没有任何截断"才算完整：`maxDepth` 留下的目录也算没扫完。
        complete: pendingAfter === 0 && truncated === false,
        directoriesVisited: state.visited,
        candidatesFound: state.candidates,
        gitProbes: state.probes,
        durationMs: now() - state.startedAt,
        // 两个截断来源都要如实上报：maxDirs / 时间预算的提前退出（truncated），以及
        // maxDepth 留下的未访问目录（pendingAfter > 0，同样是"这次没扫完"）。
        truncatedByBudget: truncated === true || pendingAfter > 0,
        // 缓存里存的一律是 `false`，只有读缓存的那两条路径（`resolveProjectScope` 命中、
        // `peekProjectScope`）才把它翻成 true——这样"this is a reuse, not a fresh scan"
        // 永远是真的。
        cached: false,
      },
    }
  }

  /** workspaceRoot → `{ scope, at }`（项目级作用域缓存，与单仓库缓存同一套有界淘汰）。 */
  const scopeCache = new Map()
  /** workspaceRoot → 在途发现的**快路径** promise（single-flight：并发调用加入同一次扫描）。 */
  const scopeInflight = new Map()
  /** 单调递增的代次：`invalidateProjectScope` 让它 +1，令在途/旧的后台 BFS 结果作废。 */
  let scopeGeneration = 0

  const scopeFresh = (entry) => entry !== undefined && now() - entry.at < scopeTtlMs

  const rememberScope = (workspaceRoot, scope) => {
    // 与 `remember` 同理：先删再插才是"最近使用"，否则被反复访问的条目会最先被淘汰。
    scopeCache.delete(workspaceRoot)
    scopeCache.set(workspaceRoot, { scope, at: now() })
    while (scopeCache.size > max) {
      const oldest = scopeCache.keys().next()
      if (oldest.done === true) break
      scopeCache.delete(oldest.value)
    }
  }

  /** 后台把深层的 BFS 跑完，并**替换**缓存里那份快路径结果（快路径只是"临时的 partial"）。 */
  const drainDeep = (workspaceRoot, state, iterator, generation) => {
    const settle = () => {
      if (generation !== scopeGeneration) return // 期间被 invalidate 过：结果作废。
      const scope = stateToScope(workspaceRoot, state)
      scope.discovery.cached = true
      rememberScope(workspaceRoot, scope)
    }
    return (async () => {
      try {
        while (true) {
          const step = await iterator.next()
          if (step.done === true) {
            settle()
            return
          }
        }
      } catch {
        // 后台阶段出错（注入的 fs/runGit 抛了非预期错误）：保留快路径那次的结果。
        // 这里不记日志——它已经在请求路径之外，没有一个调用方可以接收这个错误。
      }
    })()
  }

  const startProjectScope = (workspaceRoot) => {
    const generation = scopeGeneration
    const state = createDiscoveryState()
    state.startedAt = now()
    // 注意这里**不能**用 `return task.finally(...)`：`.finally()` 返回的是**另一个** promise，
    // 存进 `scopeInflight` 之后，`resolveProjectScope` 拿到的却是它、而 `finally` 回调里的
    // 比较又看的是原 promise，于是单飞彻底失效（两次并发调用会各扫一遍）。因此只存一个
    // promise，并在它自己的 finally 里清理。
    const task = (async () => {
      try {
        const containing = await probe(workspaceRoot)
        const iterator = scan(workspaceRoot, containing, state, now() + limits.fastBudgetMs * 8)
        const step = await iterator.next()
        if (step.done === true) {
          // 整棵树在快路径内就扫完了（第一层之外没有更深的内容）：后台那一段没有必要。
          // **必须**立刻入缓存——否则下一次调用会从头再扫一遍。
          const scope = stateToScope(workspaceRoot, state)
          rememberScope(workspaceRoot, scope)
          return scope
        }
        // 这里拿到的是"快路径已定稿"的那一次 yield（见 scan），**后台还没跑**。因此这一份
        // 一定是 partial：显式传 `pendingAfter:1` / `truncated:true`，不去读生成器里那份
        // 还没写全的 `state.truncated`。`directoriesVisited`/`gitProbes` 已是快路径的真实账目。
        void drainDeep(workspaceRoot, state, iterator, generation)
        return stateToScope(workspaceRoot, state, 1, true)
      } finally {
        if (scopeInflight.get(workspaceRoot) === task) scopeInflight.delete(workspaceRoot)
      }
    })()
    scopeInflight.set(workspaceRoot, task)
    return task
  }

  return {
    /**
     * 项目级 Git 作用域：workspaceRoot 自身所属的仓库 + 它下面发现的独立仓库（dedupe 后）。
     *
     * **两段式**：第一段只扫"自身 + 第一层子目录"，扫完就返回；如果还有更深的目录，第二段
     * （BFS，深到 maxDepth）在后台继续，跑完后**替换**缓存里的这一份。因此调用方第一次
     * 拿到 `complete:false`、稍后再拿就是 `complete:true`，而任何一次调用都不会等第二段。
     *
     * @param workspaceRoot - 已通过安全校验的真实工作区路径。
     * @param options - `{ force }`：`force:true` 绕过缓存（写操作之后用），但仍遵守
     *   single-flight——并发的强制刷新只跑一次。
     * @returns 见上方形状说明；永远不抛（发现失败退化成"没有仓库"）。
     */
    async resolveProjectScope(workspaceRoot, options) {
      const force = options?.force === true
      if (typeof workspaceRoot !== 'string' || workspaceRoot === '') {
        return stateToScope('', createDiscoveryState(), 0, false)
      }
      if (force === false) {
        const entry = scopeCache.get(workspaceRoot)
        if (scopeFresh(entry)) {
          // 命中缓存：只改这一个标志（拷贝一份，避免把 cached:true 写回缓存本身）。
          return { ...entry.scope, discovery: { ...entry.scope.discovery, cached: true } }
        }
      }
      const running = scopeInflight.get(workspaceRoot)
      if (running !== undefined) return running
      return startProjectScope(workspaceRoot)
    },

    /**
     * 只看项目级作用域缓存，不发起任何扫描。
     * @param workspaceRoot - 工作区路径。
     * @returns 缓存里的 scope（`cached:true`）；没缓存或已过期时 undefined。
     */
    peekProjectScope(workspaceRoot) {
      const entry = scopeCache.get(String(scopeRoot(workspaceRoot)))
      if (scopeFresh(entry) === false) return undefined
      return { ...entry.scope, discovery: { ...entry.scope.discovery, cached: true } }
    },

    /**
     * 丢掉项目级作用域的缓存（`git init`、删除 `.git`、目录重组之后调用）。
     * @param workspaceRoot - 工作区路径；不传则清空全部。
     */
    invalidateProjectScope(workspaceRoot) {
      // 代次 +1：已经在后台跑着的那次发现即使跑完也不再回写缓存（它看到的可能是旧目录）。
      scopeGeneration += 1
      if (typeof workspaceRoot === 'string' && workspaceRoot !== '') {
        scopeCache.delete(workspaceRoot)
        scopeInflight.delete(workspaceRoot)
      } else {
        scopeCache.clear()
        scopeInflight.clear()
      }
    },

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
