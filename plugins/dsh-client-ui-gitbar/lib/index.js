// gitbar 的 host 半边。
//
// 职责：在 webServer 上注册一组 git 路由，供客户端半边取分支信息、执行分支与远端
// 操作、以及提交工作区改动。UI 本身完全在 client.js 里实现。
//
// 为什么走 HTTP 而不是在渲染进程里跑 git：渲染进程是 sandbox + contextIsolation
// 的纯 web 环境，没有 Node 能力，也不应该获得——那正是外壳一直坚持的边界。git 由
// host 侧用 execFile 调用，客户端只发请求。
//
// 安全约束（这些不是可选的，见 createGitHandler 的注释）：
//   1. **操作是白名单枚举**，不是"白名单 git 子命令"——每个操作由 host 自己拼出
//      参数数组，客户端只能提供分支名、远端名、选项布尔值这类标量。
//      （早先的写法是"客户端给分支名，host 拼一条 checkout"。那在当时只有 checkout
//      一个操作时是安全的，但一旦把 merge / rebase / push / branch -D 都加进来，
//      "分支名"就会出现在参数数组的第四个、第五个位置，白名单子命令再也兜不住它。
//      现在参数形状由 host 决定，客户端无法影响参数个数与顺序。）
//   2. 所有字符串参数过严格形状校验，且**位置固定**；不接受任何以 `-` 开头的值。
//   3. 用 execFile（参数数组）而不是 exec（shell 字符串），从根上避免 shell 注入。
//   4. 写入路径之间的 `--` 分隔符一律带上，避免路径/分支被当成选项。
//   5. 不做自动 stash、不加 --force、不 --discard-changes：切换分支会改变用户工作区，
//      必须由用户明确选择。
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createProjectGitScope, createRepoContextResolver } from './repo-context.js'

/** 插件名，用于诊断与 effect 标签。 */
export const name = 'gitbar'

/** 必须先有 webServer 服务，路由才有地方注册。 */
export const inject = ['webServer']

/**
 * 路由前缀。
 *
 * 用 `/dsh-desktop/` 前缀是为了与 dsh 自身的路由区分开，将来排查时一眼能看出这是
 * 外壳侧插件提供的。
 */
const ROUTE_PREFIX = '/dsh-desktop/gitbar'

/**
 * 允许作为分支名/远端名的格式。
 *
 * 刻意收紧到"像 refname"的字符集：Git 允许的名字比这宽得多，但这里的目标是**不可能**
 * 构造出选项或路径穿越。逐个否定的含义：
 *   `(?![-./])`      不以 `-`、`.`、`/` 开头 —— 挡住选项注入（`--upload-pack=…`）
 *                    与相对路径/路径穿越的起点
 *   `(?!.*\.\.)`     不含 `..` —— 挡住路径穿越，也是 git 自己拒绝的 refname 形状
 *   `(?!.*\/\/)`     不含 `//`
 *   `(?!.*\/$)`      不以 `/` 结尾
 *   `[A-Za-z0-9._/-]` 只允许 refname 的安全子集；`@{`、`~`、`^`、`:`、空格、`\` 都不在
 *                    其中，因此 rev 表达式（`main@{1}`、`HEAD~2`）与 Windows 路径分隔符
 *                    都无法通过
 *
 * 注意 `/` 是允许的（`feature/x` 是合法分支名）。
 */
const REF_PATTERN = /^(?![-./])(?!.*\.\.)(?!.*\/\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/u

/** 远端名。比分支名更严：不接受 `/`，因为远端名不能带层级。 */
const REMOTE_PATTERN = /^(?!-)[A-Za-z0-9._-]{1,100}$/u

/**
 * 提交对象标识。
 *
 * 只接受十六进制：客户端能给出的 rev 只来自我们自己的 graph 路由（它回的是完整 SHA），
 * 这里放宽到 4~40 位以兼容短 SHA。**不接受符号引用**（`HEAD~2`、`main@{1}`）——那些都是
 * rev 表达式，放进来等于把"客户端能表达任意 rev"这件事重新打开。
 */
const REVISION_PATTERN = /^[0-9a-f]{4,40}$/u

/** git 命令的默认超时。仓库很大时 `status` 可能略慢，但不该拖住 UI。 */
const GIT_TIMEOUT_MS = 8000

/**
 * `for-each-ref --format` 里两列之间的分隔符（见 `describeRevision`）。
 *
 * 用制表符是安全的：`git check-ref-format` 禁止 refname 里出现任何 ASCII 控制字符
 * （制表符在其中），因此它不可能与 refname 本身冲突。
 */
const REF_FIELD_SEPARATOR = '\t'

/**
 * 仓库探测（一次 `rev-parse`，同时取工作树顶层与 git 目录）的超时。
 *
 * 它只回答"这个目录属于哪个仓库"，正常在毫秒级返回；给 5 秒是为了让异常快速失败，
 * 而不是让一条每 10 秒一次的轮询请求挂满 8 秒。
 */
const REPO_PROBE_TIMEOUT_MS = 5000

/**
 * 联网操作的超时。
 *
 * **必须比本地操作长得多**：fetch/pull/push 要等远端握手与传输，8 秒在慢网络或大 diff
 * 下必然误杀（表现为"推送失败"，而其实只是还在传）。这也是唯一需要区分的超时。
 */
const GIT_NETWORK_TIMEOUT_MS = 180000

/** 单次响应体的上限，防止收集分支列表时把大仓库的极端输出全塞进内存。 */
const MAX_BRANCHES = 2000

/**
 * 精确领先/落后（`/branch/sync`）一次最多算多少个分支。
 *
 * 这是"按需补算"这条路径上的**硬上界**：客户端只会为"当前可见/选中"的分支请求它，
 * 而这里是最后一层防线——即使客户端被改坏或恶意请求，也不会出现"一次请求启动上千个
 * git 进程"这种把机器拖垮的形状。
 */
const SYNC_MAX_NAMES = 64

/**
 * 精确领先/落后时的并发上限。
 *
 * 每个 `rev-list` 都是**一个独立的 git.exe**。早先的实现对每个有上游的分支都起一个
 * （`Promise.all` 不限并发），300 个分支就是 300 个进程同时抢 CPU——这正是"分支列表
 * 加载慢"的直接原因。这里把同时活着的进程数钉在 4 个。
 */
const SYNC_CONCURRENCY = 4

/**
 * 运行一条 git 命令。
 *
 * **一律带上 `-c core.fileMode=false`**：Windows 表达不了可执行位，而仓库若带着
 * `core.fileMode=true`（从 Linux 仓库带过来的配置极常见），`git status` 会把
 * `docker/entrypoint.sh` 这类"HEAD 是 100755、工作区是 100644"的文件报成已修改——
 * 内容一个字没变，徽章上的改动数却是 1。带上该标志后 git 不再比较可执行位，
 * 实测改动数从 1 变 0（审查插件那边同理，见 dsh-client-ui-review 的说明）。
 *
 * 同时带上 `-c color.ui=false`：`push` / `merge` 之类的输出会被 git 按 TTY 判定着色，
 * 而我们的报错文本要直接展示给用户（`describeError` 的 detail）。默认的 `auto` 在管道里
 * 本就该关，但用户若在全局配了 `color.ui=always`，输出里就会混进 ANSI 序列，
 * 在界面上显示成一串 `ESC[31m`。显式关掉比信任用户配置可靠。
 *
 * @param args - 参数数组（不含 `git` 本身）。
 * @param cwd - 仓库工作目录。
 * @param options - `timeoutMs` 覆盖默认超时（联网操作需要）。
 * @returns stdout；失败时抛出带 stderr 的错误。
 */
function git(args, cwd, options) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      // `-C <dir>` 而不是 cwd 选项：显式指定仓库目录，且不依赖进程当前目录。
      ['-c', 'core.fileMode=false', '-c', 'color.ui=false', '-C', cwd, ...args],
      {
        timeout: options?.timeoutMs ?? GIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        // 有些操作必须非交互（见 NON_INTERACTIVE_ENV）：`rebase --continue` 会开编辑器，
        // push/fetch 遇到要密码时会**挂在终端提示上**直到超时。给子进程的 env 是叠加的，
        // 不覆盖用户自己的 git 配置。
        ...(options?.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          // push/merge 这类操作会把有用信息写进 stdout（"Everything up-to-date"、
          // 或冲突文件清单），只在 stderr 空时才退回 stdout，否则用户看不到真正原因。
          const message = String(stderr).trim() || String(stdout).trim() || error.message
          reject(new Error(message))
          return
        }
        resolve(String(stdout))
      },
    )
  })
}

/**
 * 需要非交互执行的操作的环境变量。
 *
 * `GIT_EDITOR` / `GIT_SEQUENCE_EDITOR`：`rebase --continue` 与 `cherry-pick --continue`
 * 在提交前会**打开编辑器**让人确认提交信息。宿主是个没有终端的子进程，一旦编辑器被
 * 打开就会永久挂住（直到 240 秒超时），用户看到的是"点了继续没反应"。
 * `GIT_TERMINAL_PROMPT=0`：fetch/push 需要凭据时立刻失败，而不是等着人在不存在的
 * 终端里输入——失败信息（`could not read Username`）才能被映射成"需要凭据"而不是超时。
 *
 * `true` 是 Git for Windows 自带 sh 里的内建命令，`GIT_EDITOR=true` 在 Windows 上同样
 * 有效（这也是其它 Electron Git 扩展的通行做法）。
 */
const NON_INTERACTIVE_ENV = {
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
}


/**
 * 解析外壳启动时的工作区。
 *
 * 优先取外壳注入的环境变量：`server.mjs` 在启动时已经知道工作区，注入它比让插件
 * 靠 `process.cwd()` 猜测更可靠（当前目录会被其它代码改变）。两者都拿不到时不报错，
 * 而是返回 undefined 由调用方给出明确诊断。
 *
 * @returns 绝对路径，或 undefined。
 */
function shellWorkspace() {
  const injected = process.env.DSH_DESKTOP_WORKSPACE
  if (typeof injected === 'string' && injected !== '') return injected
  return process.cwd()
}

/**
 * 收集允许被当作工作区的目录。
 *
 * = 外壳启动时的工作区 + 应用侧登记过的所有工作区。后者存在
 * `<home>/storages/workspace.json`（同一份文件应用界面用来列出可选项目）。
 *
 * 读不到或不认识该文件时退化为"只有外壳工作区"，而不是抛错——本地化/多项目是增强，
 * 不该因为它而让整个插件挂不上。
 *
 * @returns 绝对路径数组（可能只含外壳工作区）。
 */
function collectAllowedRoots() {
  const roots = new Set()
  const shell = shellWorkspace()
  if (shell !== undefined) roots.add(shell)

  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') {
    const file = join(home, 'storages', 'workspace.json')
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const table = parsed?.tables?.workspaces
      if (table !== null && typeof table === 'object') {
        for (const record of Object.values(table)) {
          const root = record?.root ?? record?.path
          if (typeof root === 'string' && root !== '') roots.add(root)
        }
      }
    } catch {
      // 文件不存在或结构变化——只用外壳工作区即可。
    }
  }
  return [...roots]
}

/**
 * 找到这个仓库真正的 git 目录。
 *
 * 为什么不直接拼 `<cwd>/.git`：在 worktree 与 submodule 里 `.git` 是一个**文件**
 * （`gitdir: …`），所有进行中操作的标记都在别处。此前只按 `.git/…` 找，于是 worktree
 * 里"合并进行中"永远检测不到（冲突面板也不会出现）。常见的 `.git` 目录形态走零成本的
 * stat 判断，只有它是文件时才多起一次 `rev-parse`。
 *
 * @param cwd - 仓库根。
 * @returns git 目录绝对路径，或 undefined（读不到）。
 */
async function resolveGitDir(cwd) {
  const dotGit = join(cwd, '.git')
  try {
    if (statSync(dotGit).isDirectory()) return dotGit
  } catch {
    // 下面退回 rev-parse。
  }
  try {
    const raw = (await git(['rev-parse', '--absolute-git-dir'], cwd)).trim()
    return raw === '' ? undefined : raw
  } catch {
    return undefined
  }
}

/** 读一个标记文件的首行（`MERGE_MSG` / `rebase-merge/onto` 之类），读不到返回 undefined。 */
function readMarkerLine(gitDir, relative) {
  try {
    const value = readFileSync(join(gitDir, relative), 'utf8').split('\n')[0].trim()
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

/**
 * 把某个版本号描述成人能读的名字：优先"指向它的分支"，否则短 SHA + 提交标题。
 *
 * 冲突界面上「Current: main / Incoming: feature/foo」比「OURS / THEIRS」有用得多，而
 * git 只给了 SHA。指向它的分支用 `for-each-ref --points-at` 问（合并时 MERGE_HEAD 通常
 * 正是被合并分支的尖端）；查不到（合并一个已被移动的分支、或直接合并某个提交）就退回
 * 短 SHA + 提交标题，仍然比裸 SHA 清楚。
 *
 * **类型只按 ref namespace 判断，绝不用"名字里有没有 `/`"。** 那个判断两个方向都会错：
 *   * `feature/login`、`bugfix/foo` 都是**合法且常见**的本地分支名，含 `/` 却被当成远端；
 *   * `refs/remotes/origin/HEAD` 的短名恰好是 `origin`（**不含** `/`），于是"取第一个不含
 *     `/` 的名字"会选中远端符号引用。
 * 实测（本仓库的回归测试钉住）：本地 `feature/foo` 与远端 `origin/HEAD` 同时指向一个提交
 * 时，旧写法返回的是 `origin`。
 *
 * 因此这里拿**完整 refname** 分类（`refs/heads/*` = 本地分支，`refs/remotes/*` = 远端
 * 跟踪分支），显示名仍用 git 自己的 `%(refname:short)`（`origin/feature/login`，而不是
 * 带 namespace 的完整名字）。
 *
 * @param cwd - 仓库根。
 * @param revision - 版本号（如 `MERGE_HEAD`、`CHERRY_PICK_HEAD`、`REVERT_HEAD`、`HEAD`）。
 * @returns 展示用标签。
 */
async function describeRevision(cwd, revision) {
  try {
    const rows = (await git(
      ['for-each-ref', `--format=%(refname)${REF_FIELD_SEPARATOR}%(refname:short)`, `--points-at=${revision}`, 'refs/heads', 'refs/remotes'],
      cwd,
    ))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => {
        const cut = line.indexOf(REF_FIELD_SEPARATOR)
        return cut === -1
          ? { full: line, short: line }
          : { full: line.slice(0, cut), short: line.slice(cut + 1).trim() }
      })
    // 本地分支优先于远端跟踪分支：用户认的是 `feature/login`，不是 `origin/feature/login`。
    // 多个候选时取 `for-each-ref` 的顺序（按 refname 排序），因此结果是确定的。
    const locals = rows.filter((row) => row.full.startsWith('refs/heads/'))
    if (locals.length > 0) return locals[0].short
    const remotes = rows.filter((row) => row.full.startsWith('refs/remotes/'))
    if (remotes.length > 0) {
      // `refs/remotes/origin/HEAD` 是**符号引用**，短名是 `origin`：只有当它是唯一指向这个
      // 提交的远端引用时才用它，否则优先更具体的 `origin/<branch>`。
      const concrete = remotes.find((row) => !row.full.endsWith('/HEAD'))
      return (concrete ?? remotes[0]).short
    }
  } catch {
    // 继续用短 SHA。
  }
  try {
    const short = (await git(['rev-parse', '--short', revision], cwd)).trim()
    const subject = (await git(['log', '-1', '--format=%s', revision], cwd)).trim()
    return subject === '' ? short : `${short} ${subject}`
  } catch {
    return revision
  }
}

/**
 * 检测仓库进行中的操作（merge / rebase / cherry-pick / revert）。
 *
 * 这是"冲突解决模式"的唯一判据，**在 backend 里做**：UI 不去读 `.git`。
 * 注意语义：git 的 `ours`（stage 2）在 **rebase** 下是"你变基到的那个分支"，
 * `theirs`（stage 3）才是"你正在重放的提交"——与 merge 正好相反。界面必须能显示
 * 真实名字，所以这里把两侧都解析出来，并用 `labelsSwapped` 告诉界面这一点。
 *
 * @param cwd - 仓库根。
 * @param conflictsHint - 已经算好的冲突文件清单（`/status` 的 porcelain 解析里就有）。
 *   传入它可以省掉一次 `status` 进程——这条路径挂在每 10 秒一次的轮询上，而**只有在有
 *   冲突时才需要**它，因此传进来是最省的。不传时这里自己取一次。
 * @returns `{ type, currentLabel, incomingLabel, labelsSwapped }` 或 null（没有进行中的操作）。
 */
async function readOperation(cwd, conflictsHint) {
  const gitDir = await resolveGitDir(cwd)
  if (gitDir === undefined) return null
  const has = (relative) => existsSync(join(gitDir, relative))

  /** 当前侧（git 的 ours / stage 2）的展示名。 */
  const oursLabel = async () => {
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).catch(() => '')).trim()
    if (branch !== '' && branch !== 'HEAD') return branch
    const short = (await git(['rev-parse', '--short', 'HEAD'], cwd).catch(() => '')).trim()
    return short === '' ? 'HEAD' : `detached at ${short}`
  }

  if (has('MERGE_HEAD')) {
    return {
      type: 'merge',
      currentLabel: await oursLabel(),
      incomingLabel: await describeRevision(cwd, 'MERGE_HEAD'),
      // merge：ours = 当前分支，theirs = 被合并进来的分支，与界面一致。
      labelsSwapped: false,
    }
  }

  const rebasing = has('rebase-merge') || has('rebase-apply')
  if (rebasing) {
    const dir = has('rebase-merge') ? 'rebase-merge' : 'rebase-apply'
    // `head-name` 是"被变基的分支"（= git 的 theirs），`onto` 是"变基到哪"（= git 的 ours）。
    const headName = readMarkerLine(gitDir, `${dir}/head-name`)
    const onto = readMarkerLine(gitDir, `${dir}/onto`)
    const rebased = headName === undefined ? undefined : headName.replace(/^refs\/heads\//u, '')
    const ontoShort = onto === undefined ? undefined : (await git(['rev-parse', '--short', onto], cwd).catch(() => '')).trim()
    return {
      type: 'rebase',
      currentLabel: ontoShort === undefined || ontoShort === '' ? 'onto' : `onto ${ontoShort}`,
      incomingLabel: rebased === undefined ? await oursLabel() : rebased,
      labelsSwapped: true,
    }
  }

  if (has('CHERRY_PICK_HEAD')) {
    return {
      type: 'cherry-pick',
      currentLabel: await oursLabel(),
      incomingLabel: await describeRevision(cwd, 'CHERRY_PICK_HEAD'),
      labelsSwapped: false,
    }
  }

  if (has('REVERT_HEAD')) {
    return {
      type: 'revert',
      currentLabel: await oursLabel(),
      incomingLabel: await describeRevision(cwd, 'REVERT_HEAD'),
      labelsSwapped: false,
    }
  }

  /**
   * 没有任何"进行中的操作"标记，但索引里还有未合并条目。
   *
   * `git stash apply/pop` 冲突时就是这样：git **不写 MERGE_HEAD**（它只留下未合并的索引
   * 条目与 `.git/AUTO_MERGE`），因此没有任何操作标记可读。这里**不伪造** merge 操作
   * （那会让界面显示"合并进行中"并给出一个 git 根本不接受的「继续合并」），而是给一个
   * 如实的类型：
   *   * 两侧标记名是 stash 自己那一组（`Updated upstream` / `Stashed changes`）→ `stash`；
   *   * 其余无标记冲突（`git apply -3`、`git checkout --merge` 等）→ `unmerged`。
   * 两者的共同点是**都没有「继续」这个动作**：解决完冲突、把文件标记为已解决即可。
   */
  const conflicts = Array.isArray(conflictsHint) ? conflictsHint : await listConflictEntries(cwd)
  if (conflicts.length > 0) {
    const stashConflict = looksLikeStashConflict(cwd, conflicts)
    return {
      type: stashConflict ? 'stash' : 'unmerged',
      currentLabel: stashConflict ? STASH_MARKER_OURS : await oursLabel(),
      incomingLabel: stashConflict ? STASH_MARKER_THEIRS : '',
      labelsSwapped: false,
      /** 无标记冲突：界面据此**不**给「继续 / 中止」（git 也没有这样的命令）。 */
      markerless: true,
    }
  }

  return null
}

/** 当前分支名；游离 HEAD 时返回 undefined（`rev-parse` 会给出 `HEAD`）。 */
async function currentBranchName(cwd) {
  try {
    const name = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim()
    return name === '' || name === 'HEAD' ? undefined : name
  } catch {
    return undefined
  }
}

/**
 * 「第一次推送该推到哪个远端」。
 *
 * 这个函数存在的唯一理由是一个**必须显式给远端**的 git 语义：`git push --set-upstream`
 * 光杆会以 "no upstream branch" 失败，而只给分支时 git 会把 `feature:feature` 当成**远端名**
 * （实测报 `'feature:feature' does not appear to be a git repository`）。因此"发布分支"
 * 与"推送某个非当前分支"都必须自己解析出一个远端名。
 *
 * 取值顺序与 git 自己的默认一致：`remote.pushDefault` → `branch.<name>.remote` → 远端列表里
 * 第一个可用的。`.`（git 用它表示"本地这个仓库"）不是一个可推送的远端，跳过。
 *
 * @param cwd - 仓库根。
 * @param branch - 目标分支名（可省略：省略时跳过 `branch.<name>.remote`）。
 * @returns 已通过 `REMOTE_PATTERN` 的远端名，或 undefined。
 */
async function resolvePushRemote(cwd, branch) {
  const configValue = async (key) => {
    try {
      return (await git(['config', '--get', key], cwd)).trim()
    } catch {
      // 没有这个配置项：git config 以非零退出，这是常态而不是错误。
      return ''
    }
  }
  const candidates = [await configValue('remote.pushDefault')]
  if (branch !== undefined) candidates.push(await configValue(`branch.${branch}.remote`))
  try {
    candidates.push(...(await git(['remote'], cwd)).split('\n').map((line) => line.trim()))
  } catch {
    // 一个远端都没有：让调用方给出 noRemote。
  }
  return candidates.find((name) => name !== '' && name !== '.' && REMOTE_PATTERN.test(name))
}

/**
 * 从 porcelain v2 的输出里取出未合并（冲突）条目。
 *
 * `u` 记录的形状：`u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`。XY 两列是
 * git 的既有语义（`UU` 两边都改、`AA` 两边都新增、`DU`/`UD` 删除与修改冲突…），界面按它
 * 显示冲突类型，因此原样带出去而不是折叠成一个布尔。
 *
 * `-z` 下路径是 NUL 分隔、**不做引号转义**，含空格/中文的路径都能原样取到。
 *
 * @param raw - `status --porcelain=v2 --branch -z` 的原始输出。
 * @returns `{ path, code }` 数组。
 */
function parseConflicts(raw) {
  const fields = String(raw).split('\0')
  const conflicts = []
  for (const line of fields) {
    if (!line.startsWith('u ')) continue
    const parts = line.split(' ')
    // 路径在最后一段（`-z` 下无引号转义，因此可以直接 join 回去）。
    const path = parts.slice(10).join(' ')
    if (path === '') continue
    conflicts.push({ path, code: parts[1] ?? 'UU' })
  }
  return conflicts
}

/**
 * 读取当前分支与工作区状态。
 *
 * 一次 `status --porcelain=v2 --branch` 同时给出分支、上游、领先/落后与改动文件数，
 * 比多次调用更省进程也更一致（多次调用之间用户可能刚好切了分支）。
 *
 * @param cwd - 工作区路径。
 * @returns 供客户端渲染的状态对象。
 */
async function readStatus(cwd) {
  const raw = await git(['status', '--porcelain=v2', '--branch', '-z'], cwd)

  const state = {
    isRepo: true,
    branch: '',
    detached: false,
    upstream: '',
    ahead: 0,
    behind: 0,
    changedFiles: 0,
    untrackedFiles: 0,
    /** 上游被删掉了（`[gone]`）：界面要提示"远端分支已不存在"，而不是显示 0/0。 */
    upstreamGone: false,
    /** 合并/变基进行中：有冲突待解决时界面要给出"中止"入口。 */
    merging: false,
    rebasing: false,
    /** 进行中的操作（merge/rebase/cherry-pick/revert）或 null。 */
    operation: null,
    /** 未解决的冲突文件：`{ path, code }`。 */
    conflicts: [],
    /** 尚无提交（空仓库）：界面显示"No commits yet"而不是报错。 */
    noCommits: false,
    /** 当前分支是否有上游；没有时 UI 提供「发布分支」。 */
    hasUpstream: false,
  }

  // `-z` 下记录以 NUL 分隔，字段仍以空格分隔，因此先按 NUL 切开再逐条解析。
  for (const line of raw.split('\0')) {
    if (line.startsWith('# branch.head ')) {
      const value = line.slice('# branch.head '.length).trim()
      // git 在游离 HEAD 上会给出 "(detached)"。
      if (value === '(detached)') state.detached = true
      else state.branch = value
    } else if (line.startsWith('# branch.upstream ')) {
      state.upstream = line.slice('# branch.upstream '.length).trim()
    } else if (line.startsWith('# branch.ab ')) {
      const match = /\+(\d+)\s+-(\d+)/u.exec(line)
      if (match !== null) {
        state.ahead = Number(match[1])
        state.behind = Number(match[2])
      }
    } else if (line.startsWith('# branch.oid ')) {
      const value = line.slice('# branch.oid '.length).trim()
      // 空仓库时是 "(initial)"，此时没有提交可展示。
      if (value === '(initial)') state.noCommits = true
      else state.head = value
    } else if (line.startsWith('? ')) {
      state.untrackedFiles += 1
    } else if (line.startsWith('u ')) {
      // 冲突条目由 parseConflicts 统一解析（下面再用一次，保证两处判定一致）。
      state.changedFiles += 1
    } else if (line !== '' && !line.startsWith('#')) {
      state.changedFiles += 1
    }
  }
  state.conflicts = parseConflicts(raw)
  state.conflictCount = state.conflicts.length
  state.hasUpstream = state.upstream !== ''

  // 未跟踪文件也计入改动文件总数：徽章上的 `*N` 表示"工作区与 HEAD 的差异条数"，
  // 把新增文件排除在外会让用户以为"文件没被识别"。但两组分开计数，界面可以分别显示。
  state.changedFiles += state.untrackedFiles

  // 进行中的操作。`merging` / `rebasing` 保留（既有客户端在用），新代码读 `operation`。
  // 把刚解析出来的冲突清单传进去：无标记冲突（stash apply 等）的判定需要它，而这里正好有。
  state.operation = await readOperation(cwd, state.conflicts)
  state.merging = state.operation?.type === 'merge'
  state.rebasing = state.operation?.type === 'rebase'
  if (state.upstream !== '') {
    // `status --branch` 在上游被删时不写 ab 行，用一条 for-each-ref 语义的判定代替：
    // 上游 ref 不存在即为 gone。
    try {
      await git(['show-ref', '--verify', '--quiet', `refs/remotes/${state.upstream}`], cwd)
    } catch {
      state.upstreamGone = true
    }
  }
  return state
}


/**
 * 计算一个分支相对其上游的领先/落后提交数——**精确值，每调用一次起一个 git 进程**。
 *
 * 因此它只出现在两条路径上（见 listBranches 与 readBranchSync 的说明）：
 *   1. `/branch/sync`：为"当前可见/选中"的分支按需补算，并发上限 SYNC_CONCURRENCY；
 *   2. 没有第二条——首屏分支列表**不再**走它。
 *
 * **不能只看 `%(upstream:track)`。** 那个字段只在**本地远程跟踪引用**（`refs/remotes/…`）
 * 已经存在并且已过期时才报 `[behind N]`；本地跟踪引用缺失时它安静地给出空字符串，
 * 而 `git status` 却会按远端实际情况算出 `[behind 1]`（实测：临时仓库里 `push -u` 之后
 * `for-each-ref` 的 track 为空、`status` 报 behind 1）。直接用 track 的结果就是界面上
 * 所有分支的领先/落后恒为 0，而右侧又显示"落后 1"——同一次刷新里自相矛盾。
 *
 * **也不能拿 HEAD 当分支的尖端。** 这一条踩得最深：对"当前分支"用 HEAD 恰好正确，
 * 因此只在**非当前**分支上错，而且错得很像真的——实测 `develop` 实际与上游齐平，
 * 却被报成"领先 0、落后 2"（因为当时 HEAD 在 main 上，`origin/develop...HEAD` 量的是
 * develop 与 main 的差异）。界面上表现为"所有其它分支都显示莫名其妙的落后数"。
 * 因此这里显式传入该分支自己的引用（完整 ref，不用短名——分支名可能与路径同名，
 * 完整 ref 不会有这种歧义）。
 *
 * `--left-right --count <up>...<branch>` 的三点（`...`）表示"相对合并基点"，正是 IDE
 * 显示的语义；输出是 `<左>\t<右>`，这里 `左 = upstream`、`右 = branch`，所以左是落后、
 * 右是领先。
 *
 * `--end-of-options` 把引用与选项隔开：引用虽然已被 for-each-ref 规整过，但这行是
 * "引用被当成选项"最容易发生的位置，隔开一次不花成本。
 *
 * @param cwd - 工作区路径。
 * @param upstream - 上游短名（如 `origin/main`）；空串表示没有上游。
 * @param branchRef - 该分支的完整引用（`refs/heads/…` 或 `refs/remotes/…`）。
 * @param track - `%(upstream:track)` 的原文，用于判定 `[gone]` 与兜底数字。
 * @returns `{ ahead, behind, gone, diverged }`；rev-list 不可用时退回 track 的数字。
 */
async function readUpstreamCounts(cwd, upstream, branchRef, track) {
  const parsed = parseTrack(track)
  if (upstream === '') return { ahead: 0, behind: 0, gone: false, diverged: false }
  try {
    const raw = await git(
      ['rev-list', '--left-right', '--count', '--end-of-options', `${upstream}...${branchRef}`],
      cwd,
    )
    const [behindRaw, aheadRaw] = raw.trim().split(/\s+/u)
    const behind = Number(behindRaw)
    const ahead = Number(aheadRaw)
    if (!Number.isFinite(behind) || !Number.isFinite(ahead)) throw new Error(`unparsable rev-list output: ${raw.trim()}`)
    return { ahead, behind, gone: false, diverged: ahead > 0 && behind > 0 }
  } catch {
    // 上游引用不存在（被删 / 还没 fetch）——界面要提示"上游已不存在"，
    // 而不是显示一个看起来很正常的 0/0。
    return { ahead: parsed.ahead, behind: parsed.behind, gone: true, diverged: false }
  }
}

/**
 * 解析 `%(upstream:track)` 的输出。
 *
 * git 在这里给出的是给人类看的文本，只有三种形状：
 *   ``            —— 有上游且在同步位置
 *   `[gone]`      —— 上游 ref 已不存在
 *   `[ahead 2]` / `[behind 3]` / `[ahead 2, behind 3]`
 * 因此用正则取数字而不是当机器可读格式解析；拿不到就退回 0。
 *
 * 注意它只作为 rev-list 的**兜底**：见 readUpstreamCounts 的说明。
 *
 * @param track - 该字段的原始文本。
 * @returns `{ ahead, behind, gone }`。
 */
function parseTrack(track) {
  const text = typeof track === 'string' ? track.trim() : ''
  if (text === '') return { ahead: 0, behind: 0, gone: false }
  if (text === '[gone]') return { ahead: 0, behind: 0, gone: true }
  const ahead = /ahead\s+(\d+)/u.exec(text)
  const behind = /behind\s+(\d+)/u.exec(text)
  return {
    ahead: ahead === null ? 0 : Number(ahead[1]),
    behind: behind === null ? 0 : Number(behind[1]),
    gone: false,
  }
}

/**
 * `for-each-ref` 用的字段列表（按位置解析，见 listBranches）。
 *
 * `%(symref)` 是必需的：`refs/remotes/` 下有 `origin/HEAD` 这类**符号引用**，它不是可切换
 * 的分支，但 `%(refname:short)` 会把它显示成 `origin`（**不带斜杠**）——早先靠"名字里有没有
 * 斜杠"区分本地/远程，就把它误判成了本地分支（实测踩到过）。用 `%(symref)` 直接判掉。
 */
const REF_FORMAT = [
  '%(refname)',
  '%(refname:short)',
  '%(HEAD)',
  '%(symref)',
  '%(upstream:short)',
  '%(upstream:track)',
  '%(committerdate:iso-strict)',
  '%(objectname)',
  '%(contents:subject)',
].join('\x1f')

/**
 * 列出分支，带上界面分组所需的全部字段。
 *
 * 只列本地是不够的。实测一个真实仓库：本地 4 个分支、远程 27 个——团队协作时大部分
 * 分支只存在于远程，用户想在界面上切换却看不到它们，会直接得出"这个功能没用"的结论。
 *
 * **一次 for-each-ref 查询两个 refname 空间**，而不是两次调用：现在需要每个分支的
 * 提交时间与上游状态，两次调用会让"最近"分组与"本地/远程"两个列表取到不同时刻的快照，
 * 在同一次刷新里自相矛盾。
 *
 * **首屏只起 1 个 git 进程。** 这是这一版最重要的性质：ahead/behind 先用 for-each-ref
 * 的 `%(upstream:track)` 展示（`syncExact: false`），精确值由客户端对**可见**分支发
 * `/branch/sync` 异步补算。此前的写法是"对每个有上游的分支各跑一次 rev-list"，300 个
 * 分支就有 300 个 git.exe 同时启动，而 `MAX_BRANCHES` 又是在 enrichment **之后**才截断
 * ——那既慢又把机器打满（实测"分支列表要等好几秒"）。现在的顺序是：
 *
 *     for-each-ref（1 个进程） → 解析 → 排序 → 截断 → 返回
 *                                                    ↑ 到此为止，没有任何按分支数的进程
 *
 * 排序与截断必须发生在补算之前：否则给第 2001 个分支白算一次。
 *
 * 每个条目带 `syncExact`：
 *   true   没有上游，0/0 是精确的（没什么可算）；
 *   false  数字来自 track，是"先展示"的值，精确值由 `/branch/sync` 后补。
 *
 * 当前分支的精确 ahead/behind 由 `/status`（`# branch.ab`）给出——那是 git 自己算的，
 * 客户端用它覆盖当前分支那一行；`/branches` 因此不需要为它额外起一个进程。
 *
 * 切换远程分支时用 `git switch <短名>`：git 会自动创建同名的本地跟踪分支，这正是
 * 用户在 IDE 里期待的行为，不需要 `-b` 或 `--track`。
 *
 * @param cwd - 工作区路径。
 * @returns `{ branches, counts: { local, remote }, truncated }`，本地在前。
 */
async function listBranches(cwd) {
  const raw = await git(['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads/', 'refs/remotes/'], cwd)

  const local = []
  const remote = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    const [refname, short, head, symref, upstream, track, date, object, subject] = line.split('\x1f')
    // 符号引用（`origin/HEAD`）不是可切换的分支。
    if (refname === undefined || (symref ?? '').trim() !== '') continue
    const isRemote = refname.startsWith('refs/remotes/')
    const prefix = isRemote ? 'refs/remotes/' : 'refs/heads/'
    const name = String(short ?? '').trim() !== '' ? String(short).trim() : refname.slice(prefix.length)
    if (name === '' || name.endsWith('/HEAD')) continue

    const { ahead, behind, gone } = parseTrack(track)
    const upstreamName = (upstream ?? '').trim()
    const entry = {
      name,
      isRemote,
      current: (head ?? '').trim() === '*',
      // 远端短名（`origin`）：远程分支行要用它做推送/删除的目标。
      remote: isRemote && name.includes('/') ? name.slice(0, name.indexOf('/')) : '',
      // 上游只回**短名**（`origin/develop`），界面显示时还会再切掉远端前缀。
      upstream: upstreamName,
      // 上游被删（`[gone]`）由 for-each-ref 的 track 字段直接给出，不需要额外判定。
      upstreamGone: gone,
      ahead,
      behind,
      // 两边各有提交：界面要提示"已分叉"，那与单纯的"落后"需要不同的动作。
      diverged: ahead > 0 && behind > 0,
      // 这两个数字是不是精确值（见函数头）。没有上游时 0/0 就是精确的。
      syncExact: upstreamName === '',
      // 已提交时间：界面按它排「最近」分组。ISO-8601 带时区，客户端 new Date() 可直接解析。
      committedAt: (date ?? '').trim(),
      hash: (object ?? '').trim(),
      subject: (subject ?? '').trim(),
      // 下面两个是内部字段，不入响应：
      //   ref   —— 完整引用，补算精确领先/落后时要用它当"分支尖端"（见 readUpstreamCounts）
      //   track —— `%(upstream:track)` 原文，只用于判定 `[gone]` 与兜底数字。
      // 它们是给人类看的文本，让客户端解析等于把 git 的输出格式变成前后端契约。
      ref: refname,
      track: (track ?? '').trim(),
    }
    ;(isRemote ? remote : local).push(entry)
  }

  // 本地在前（用户最常切的是本地），各自按名字排序，**先截断再返回**——补算完全在
  // 客户端按可见性发起，host 这里不再为任何分支起第二个进程。
  const byName = (a, b) => a.name.localeCompare(b.name)
  local.sort(byName)
  remote.sort(byName)
  const all = [...local, ...remote]
  const truncated = all.length > MAX_BRANCHES
  // 内部字段别流到客户端。
  for (const entry of all) {
    delete entry.track
    delete entry.ref
  }
  return {
    branches: all.slice(0, MAX_BRANCHES),
    counts: { local: local.length, remote: remote.length },
    truncated,
  }
}

/**
 * 为指定的一批分支补算**精确**的领先/落后（`/branch/sync`）。
 *
 * 为什么由客户端挑名字：只有它知道哪些行此刻真的可见（分组折叠、搜索过滤、滚动都在
 * 客户端）。host 端只负责两件事——**限制规模**（SYNC_MAX_NAMES）与**限制并发**
 * （SYNC_CONCURRENCY），因此 300 个分支的仓库也不会出现进程雪崩。
 *
 * 名字一律重新解析：客户端给的名字先在这一次 for-each-ref（1 个进程）里查回它自己的
 * 完整引用与上游，查不到的（已删除、被过滤掉、伪造的）直接跳过。这样即使名字是伪造的，
 * 也不会成为"客户端能指定任意 rev"的入口（见本文件头部的安全约束）。
 *
 * **字段名与 `/branches` 完全一致**：都叫 `syncExact`。此前这里回的是 `exact`，而客户端
 * 的条目上是 `syncExact`——合并之后条目上会同时挂着 `exact: true` 与 `syncExact: false`，
 * 于是"这个分支已经精确过了"永远判不出来，补算请求被一轮轮重复触发（直到把整个仓库的分支
 * 都算一遍）。**同一个概念只能有一个字段名**，这条比"哪个名字更好"重要得多。
 *
 * @param cwd - 工作区路径。
 * @param names - 客户端请求的分支短名（本地或远程）。
 * @returns `{ sync: { [name]: { ahead, behind, diverged, upstreamGone, syncExact } } }`。
 */
async function readBranchSync(cwd, names) {
  const wanted = new Set()
  for (const name of names) {
    if (typeof name === 'string' && name !== '') wanted.add(name)
    if (wanted.size >= SYNC_MAX_NAMES) break
  }
  if (wanted.size === 0) return { sync: {} }

  const raw = await git(['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads/', 'refs/remotes/'], cwd)
  const targets = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    const [refname, short, , symref, upstream, track] = line.split('\x1f')
    if (refname === undefined || (symref ?? '').trim() !== '') continue
    const isRemote = refname.startsWith('refs/remotes/')
    const prefix = isRemote ? 'refs/remotes/' : 'refs/heads/'
    const name = String(short ?? '').trim() !== '' ? String(short).trim() : refname.slice(prefix.length)
    if (!wanted.has(name)) continue
    const upstreamName = (upstream ?? '').trim()
    if (upstreamName === '') {
      // 没有上游：0/0 本来就是精确的，不必为它起进程。
      targets.push([name, undefined])
      continue
    }
    targets.push([name, { upstream: upstreamName, ref: refname, track: (track ?? '').trim() }])
  }

  const sync = {}
  // 受限并发的工作队列。用"固定数量的工人从同一个游标取活"而不是 `Promise.all`：
  // 后者的并发数等于数组长度，正是要避免的形状。
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= targets.length) return
      const [name, target] = targets[index]
      if (target === undefined) {
        sync[name] = { ahead: 0, behind: 0, diverged: false, upstreamGone: false, syncExact: true }
        continue
      }
      const result = await readUpstreamCounts(cwd, target.upstream, target.ref, target.track)
      sync[name] = {
        ahead: result.ahead,
        behind: result.behind,
        diverged: result.diverged,
        upstreamGone: result.gone,
        syncExact: true,
      }
    }
  }
  const workers = []
  for (let i = 0; i < Math.min(SYNC_CONCURRENCY, targets.length); i += 1) workers.push(worker())
  await Promise.all(workers)
  return { sync }
}

/**
 * 列出远端名与它们的地址。
 *
 * 界面的"推送"需要知道有哪些远端可选；只有一个远端时客户端可以自动选中，
 * 多个时让用户选。
 *
 * **一次 `git config --get-regexp` 拿全部**，而不是 `git remote` + 每个远端一次
 * `remote get-url`：后者在远端多的仓库上是 1+N 个进程，而这里恒为 1 个。输出形如
 * `remote.origin.url https://…`，按第一个空白切成"键 / 值"。正则结尾的 `\.url$`
 * 天然排除 `remote.<name>.pushurl`（它结尾是 `hurl`，不是 `.url`）。
 *
 * 没有配置任何远端时 `--get-regexp` 以非零退出（"没有任何匹配"不是错误），因此这里
 * 把失败当作空列表。
 *
 * @param cwd - 工作区路径。
 * @returns `{ name, url }` 数组。
 */
async function listRemotes(cwd) {
  let raw = ''
  try {
    raw = await git(['config', '--get-regexp', '^remote\\..*\\.url$'], cwd)
  } catch {
    return []
  }
  const remotes = []
  const seen = new Set()
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    const match = /^remote\.(.+)\.url\s+(.+)$/u.exec(line.trim())
    if (match === null) continue
    const name = match[1]
    // 同一个远端配了多个 url 时只取第一个：下游（push 的目标、选择器）只需要一个。
    if (seen.has(name)) continue
    seen.add(name)
    remotes.push({ name, url: match[2] })
  }
  return remotes
}

/**
 * 给响应体写 JSON。
 *
 * @param response - HTTP 响应。
 * @param status - 状态码。
 * @param payload - 可序列化的负载。
 */
function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  // 分支状态会随用户操作（切分支、改文件）立刻变化，不能缓存。
  response.setHeader('cache-control', 'no-store')
  response.end(body)
}

/**
 * 读取并限制请求体，避免 unbounded 读取。
 *
 * @param request - HTTP 请求。
 * @returns 请求体文本（上限 8 KiB）。
 */
async function readSmallBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 8192) throw new Error('request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 判断仓库当前是否有未提交改动（含未跟踪文件）。
 *
 * 用 `status --porcelain` 而不是只看已跟踪改动：未跟踪文件同样可能被 checkout 拦下
 * （目标分支里存在同名文件时），此时只报"暂存并切换"才准确。
 *
 * @param cwd - 工作区路径。
 * @returns 是否有未提交改动。
 */
async function isDirty(cwd) {
  const raw = await git(['status', '--porcelain'], cwd)
  return raw.trim() !== ''
}

/**
 * 把未提交改动存进 stash，并返回列表里新生成的那一条。
 *
 * 只在用户明确要求时调用（「储藏改动」「储藏并切换」）——**绝不自动执行**。stash 是可恢复的
 * （`git stash pop`），但仍是替用户移动了他的工作区状态，必须由他决定。
 *
 * 两条与 `git stash push` 自身行为有关的实现细节：
 *   * 没有任何可储藏的东西时 git **以 0 退出**并打印 "No local changes to save"（措辞跨版本
 *     不同，退出码不可靠）。因此这里对比调用前后的 stash **提交 SHA**：没变就是没存进去，
 *     否则会把上一次的储藏当成"刚刚新建的"报给用户。
 *   * 未跟踪文件默认**不**包含（只有 `includeUntracked` 才加 `-u`）：把未跟踪文件一起搬进
 *     储藏，用户回头看工作区时会以为文件被删了。只有用户明确勾选才这么做。
 *
 * @param cwd - 仓库根。
 * @param options - `{ message?, includeUntracked? }`；message 为空时让 git 写它自己的 WIP 主题。
 * @returns 成功时 `{ stashed: true, ref, message, ... }`；没存进去时 `{ stashed: false }`。
 */
async function stashChanges(cwd, options) {
  if (!(await isDirty(cwd))) return { stashed: false }
  const message = typeof options?.message === 'string' ? options.message.trim() : ''
  const before = await listStashes(cwd)
  const args = ['stash', 'push']
  if (options?.includeUntracked === true) args.push('-u')
  if (message !== '') args.push('-m', message)
  await git(args, cwd)
  const after = await listStashes(cwd)
  if (after.length === 0 || (before.length > 0 && after[0].sha === before[0].sha)) return { stashed: false }
  return { stashed: true, ...after[0] }
}

/**
 * stash 引用的形状：**只认 `stash@{n}`**。
 *
 * `git stash apply/drop` 接受任意提交（`stash apply HEAD` 会成功！），而"把任意提交的
 * 改动糊到工作区上"不是这个界面该提供的能力——那是 cherry-pick/checkout 的事，而且
 * 用户点的是"应用这个储藏"，参数却可以是别的提交，这种不一致迟早出事。因此白名单化：
 * 只接受 `stash@{数字}`，并且下面还会核对它确实在当前仓库的 stash 列表里。
 */
const STASH_REF_PATTERN = /^stash@\{\d+\}$/u

/**
 * git 为 **stash 冲突**写进文件的两侧标记名。
 *
 * 这是"这次冲突来自 stash"唯一**持久**的判据：`git stash apply/pop` 冲突时 git 不写
 * MERGE_HEAD（只留下未合并的索引条目与 `.git/AUTO_MERGE`），因此重启之后没有任何
 * "进行中的操作"标记可读。而 git 自己给 stash 合并用的两侧名字是固定的英文常量
 * （`Updated upstream` / `Stashed changes`，见 git 的 builtin/stash.c），它随文件一起
 * 留在工作区里，与界面语言无关。
 */
const STASH_MARKER_OURS = 'Updated upstream'
const STASH_MARKER_THEIRS = 'Stashed changes'

/**
 * 从 stash 的 reflog 主题里取出**原分支**与**用户写的消息**。
 *
 * git 没有"stash 的原分支"这个独立字段，它只在 reflog 主题（`%gs`）里以固定前缀写着：
 *   * `git stash push -m X`      → `On <branch>: X`
 *   * `git stash push`（无消息） → `WIP on <branch>: <short-sha> <subject>`
 *
 * 这是 git 自己的约定（十几年未变），不是"人类可读输出"——拿它当解析对象的前提是
 * 用 `--format` 拿到稳定字段，而前缀本身必须剥掉，否则列表里每条消息都顶着 `On main:`。
 * 分支名里不可能有 `:`（git 的 ref 名规则禁止），因此按**第一个** `: ` 切分没有歧义。
 *
 * @param subject - `git stash list --format=%gs` 给出的主题。
 * @returns `{ branch, message }`；认不出形状时 branch 为空、message 为原文。
 */
function parseStashSubject(subject) {
  const text = String(subject ?? '').trim()
  const withMessage = /^On ([^:]+): ([\s\S]*)$/u.exec(text)
  if (withMessage !== null) return { branch: withMessage[1].trim(), message: withMessage[2].trim() }
  const wip = /^WIP on ([^:]+):/u.exec(text)
  if (wip !== null) return { branch: wip[1].trim(), message: '' }
  return { branch: '', message: text }
}

/**
 * 读当前仓库的 stash 列表（严格属于**这个**仓库：cwd 已是 repositoryRoot）。
 *
 * 用 `--format` 而不是 `git stash list` 的默认文本：默认文本是给人看的
 * （`stash@{0}: On main: msg`），解析它等于把"引号、空格、消息里带冒号"这些都变成坑。
 * 这里用 `%x00` 分隔字段、`%x1e` 分隔记录，因此**消息里的换行与冒号都不影响解析**。
 * `%cI` 是严格 ISO-8601 的提交时间（带时区偏移），客户端不会因为解释时间而猜时区。
 *
 * `%P` 给出 stash 提交的父提交：两个 = 普通储藏，三个 = 用了 `-u`（第三个父提交装的是
 * 未跟踪文件）。因此"这个储藏里有没有未跟踪文件"是**从 git 对象里读出来的事实**，
 * 不需要解析任何文本。
 *
 * @param cwd - 仓库根。
 * @returns `{ ref, index, subject, message, branch, date, sha, hasUntracked }` 数组（新的在前）。
 */
async function listStashes(cwd) {
  const raw = await git(['stash', 'list', '--format=%gd%x00%gs%x00%cI%x00%H%x00%P%x1e'], cwd)
  const stashes = []
  for (const record of raw.split('\u001e')) {
    if (record.trim() === '') continue
    const fields = record.split('\u0000')
    if (fields.length < 5) continue
    const ref = fields[0].trim()
    const parsed = /^stash@\{(\d+)\}$/u.exec(ref)
    if (parsed === null) continue
    const parents = fields[4].trim() === '' ? [] : fields[4].trim().split(/\s+/u)
    const { branch, message } = parseStashSubject(fields[1])
    stashes.push({
      ref,
      index: Number(parsed[1]),
      subject: fields[1].trim(),
      message,
      branch,
      date: fields[2].trim(),
      sha: fields[3].trim(),
      hasUntracked: parents.length >= 3,
    })
  }
  return stashes
}

/**
 * 校验一个请求里的 stash 引用确实存在，并返回它的条目。
 *
 * 先按形状白名单（`stash@{n}`），再核对它出现在当前仓库的列表里——只做前者会让
 * `stash@{7}`（不存在）走到 git 那里换来一句英文 `fatal`；只做后者则会让任意提交蒙混过关。
 *
 * @param cwd - 仓库根。
 * @param value - 请求给出的引用。
 * @returns stash 条目，或 undefined。
 */
async function findStash(cwd, value) {
  if (typeof value !== 'string' || !STASH_REF_PATTERN.test(value.trim())) return undefined
  const ref = value.trim()
  const stashes = await listStashes(cwd)
  return stashes.find((entry) => entry.ref === ref)
}

/**
 * 当前未合并（冲突）的路径。
 *
 * `--diff-filter=U` 是"索引里仍有未解决条目"的权威判据，`git stash apply` 冲突之后
 * 就是靠它把"这次 apply 是冲突"与"别的失败"分开的（`stash apply` 在两种情况下都以
 * 非零退出，退出码本身说明不了任何事）。
 *
 * @param cwd - 仓库根。
 * @returns 路径数组。
 */
async function listUnmergedPaths(cwd) {
  const raw = await git(['diff', '--name-only', '--diff-filter=U', '-z'], cwd).catch(() => '')
  return raw.split('\u0000').filter((path) => path !== '')
}

/**
 * 读一个冲突文件里的两侧标记名（`<<<<<<< X` / `>>>>>>> Y`）。
 *
 * 只读前若干 KiB：冲突标记总在文件里，而一个几百 MB 的生成物不该为了判定"是谁引起的冲突"
 * 被整份读进内存。
 *
 * @param cwd - 仓库根。
 * @param path - 仓库相对路径。
 * @returns `{ ours, theirs }`（读不到时都是空串）。
 */
function readConflictMarkerLabels(cwd, path) {
  try {
    const text = readFileSync(join(cwd, path), { encoding: 'utf8', flag: 'r' }).slice(0, 64 * 1024)
    const ours = /^<{7}\s?(.*)$/mu.exec(text)
    const theirs = /^>{7}\s?(.*)$/mu.exec(text)
    return { ours: ours === null ? '' : ours[1].trim(), theirs: theirs === null ? '' : theirs[1].trim() }
  } catch {
    return { ours: '', theirs: '' }
  }
}

/**
 * 判断一组未合并条目是不是 **`git stash apply/pop` 留下的冲突**。
 *
 * 依据是 git 自己写进文件的两侧标记名（见 STASH_MARKER_OURS 的说明）：它随工作区文件
 * 持久存在，重启、换进程都还在，而且只在 stash 冲突里出现（merge/rebase/cherry-pick
 * 用的是分支名或提交描述，`git apply -3` 用的是 `ours`/`theirs` 之外的提交名）。
 *
 * 只检查**第一个**冲突文件：一次 stash 冲突里所有文件的两侧名字都由同一个调用写死，
 * 而每个文件都读一遍在"几十个冲突文件"时是白花的 I/O。
 *
 * @param cwd - 仓库根。
 * @param conflicts - `{ path }` 数组（未合并条目）。
 * @returns 是 stash 冲突则 true。
 */
function looksLikeStashConflict(cwd, conflicts) {
  if (!Array.isArray(conflicts) || conflicts.length === 0) return false
  const labels = readConflictMarkerLabels(cwd, conflicts[0].path)
  return labels.ours === STASH_MARKER_OURS && labels.theirs === STASH_MARKER_THEIRS
}

/**
 * 用 porcelain 的 `u` 记录列出冲突文件（含冲突类型 `UU`/`AA`/`DU`…）。
 *
 * 与 `listUnmergedPaths` 的区别：那个只给路径，这个还带 git 的 XY 冲突类型，界面按它
 * 显示冲突种类。判定"是不是 stash 冲突"只需要路径，因此那条路径上不必多花一次进程。
 *
 * @param cwd - 仓库根。
 * @returns `{ path, code }` 数组。
 */
async function listConflictEntries(cwd) {
  const raw = await git(['status', '--porcelain=v2', '-z'], cwd)
  return parseConflicts(raw)
}


/**
 * `workspaceRoot → RepoContext` 的解析器。
 *
 * 与 review 插件**共用同一份实现**（`lib/repo-context.js` 逐字节相同的副本 + 一个 parity
 * 测试钉住）。这一点是硬要求：同一个工作区里，gitbar 的分支徽章与 review 的 Changes /
 * Log / stage / commit **必须操作同一个仓库根**，否则在"工作区是仓库子目录"时会出现
 * "徽章显示 A 仓库、Changes 显示 B 仓库"这类对不上的现象。
 *
 * 两个插件是各自独立的包（启动时整目录同步进 runtime 的 node_modules），跨包 import 会
 * 让"另一个插件不存在"变成加载期错误，因此只能各持一份副本。
 */
const repoContext = createRepoContextResolver({
  runGit: (args, cwd) => git(args, cwd, { timeoutMs: REPO_PROBE_TIMEOUT_MS }),
  realpath: (value) => realpathSync.native(value),
})

/**
 * 给响应附上作用域字段（工作区 / 仓库 / 多仓库模型预留的 scope）。
 *
 * @param workspace - 已校验的工作区路径。
 * @param context - 解析结果（可能 undefined："这里不是仓库"）。
 * @param scope - 项目级作用域（`resolveProjectScope` 的结果，可选）。
 * @returns 可直接铺进响应的字段。
 */
function scopeFields(workspace, context, scope) {
  const projectScope =
    scope === undefined || scope === null
      ? {}
      : {
          projectScope: {
            workspaceRoot: scope.workspaceRoot,
            repositories: scope.repositories,
            discovery: scope.discovery,
          },
        }
  if (context === undefined) return { workspaceRoot: workspace, ...projectScope }
  return {
    workspaceRoot: context.workspaceRoot,
    repositoryRoot: context.repositoryRoot,
    ...(context.gitDir === '' ? {} : { gitDir: context.gitDir }),
    ...(context.relativePath === undefined ? {} : { repositoryRelativePath: context.relativePath }),
    ...(context.name === undefined ? {} : { repositoryName: context.name }),
    gitScope: createProjectGitScope(context),
    ...projectScope,
  }
}

/**
 * 解析"这次请求要操作哪个仓库"。
 *
 * 客户端可以在 `?repository=` / 请求体里指定多仓库项目中的某一个；它是**不可信输入**，
 * 因此只认"这个工作区的 ProjectGitScope 里确实有它"的路径（realpath 比较）——否则
 * `repository=C:/` 又能越过工作区安全边界，让宿主对任意目录跑 git 与读写。
 *
 * 没指定时的顺序与 review 插件**逐字相同**：工作区自己所属的仓库 → 列表里的第一个。
 * 两个插件必须一致，否则同一个项目里 gitbar 的分支徽章与 review 的 Changes 会操作
 * 两个不同的仓库。
 *
 * @param workspace - 已校验的工作区路径。
 * @param repository - 客户端指定的仓库根（可选）。
 * @param options - `{ projectScope }`：是否**强制**把项目级仓库列表算出来（见下）。
 * @returns `{ context, scope, error }`；`error === 'repositoryNotAllowed'` 时拒绝。
 */
async function resolveScopedRepo(workspace, repository, options) {
  const context = await repoContext.resolve(workspace)
  /**
   * 要不要**现在**把项目级仓库列表算出来。
   *
   * 这是"每条轮询路径都多起一个 git 进程"的那道闸门。发现本身要跑一次 `rev-parse`
   * 探针（第一次在 250 ms 预算内，之后 60 秒内命中缓存），因此**不能无条件跑**：
   *   * 客户端指定了 `repository`：必须校验它，因此要列表；
   *   * 工作区自己不是仓库：只有列表能告诉我们子仓库在哪（实机那条 bug 的修复点）；
   *   * 路由自己声明需要（徽章要显示"几个仓库"、作用域查询）。
   * 其余情况（工作区自己是仓库、客户端也没指定）只用**已有缓存**——于是单仓库项目的首屏
   * 分支列表仍然是"2 个 git 进程"（探针 + for-each-ref），与 1.5.2 逐字一致，而
   * `?repository=` 与"工作区不是仓库"两条路照常工作。
   */
  const explicit = typeof repository === 'string' && repository !== ''
  const wanted = options?.projectScope === true || explicit || context === undefined
  const scope = wanted ? await repoContext.resolveProjectScope(workspace) : repoContext.peekProjectScope(workspace)
  const repositories = Array.isArray(scope?.repositories) ? scope.repositories : []
  const pick = (entry) => ({
    workspaceRoot: workspace,
    repositoryRoot: entry.repositoryRoot,
    gitDir: entry.gitDir,
    relativePath: entry.relativePath,
    name: entry.name,
  })
  if (explicit) {
    let real
    try {
      real = realpathSync.native(repository)
    } catch {
      real = undefined
    }
    const match = real === undefined ? undefined : repositories.find((entry) => entry.repositoryRoot === real)
    if (match === undefined) return { context: undefined, scope, error: 'repositoryNotAllowed' }
    return { context: pick(match), scope, error: '' }
  }
  const own = repositories.find((entry) => entry.relativePath === '')
  if (own !== undefined) return { context: pick(own), scope, error: '' }
  if (repositories.length >= 1) return { context: pick(repositories[0]), scope, error: '' }
  // 列表里没有仓库（没强制发现、缓存也是空的）：工作区自己所属的仓库仍然算数
  // ——这正是 1.5.2 的单仓库路径。
  return { context, scope, error: '' }
}

/**
 * 解析本次请求要操作的工作区。
 *
 * **必须是每次请求传入的**，不能用外壳启动时的那个。原因：应用内可以给会话选择
 * 工作区（侧边栏「选择工作区」），它与外壳的 `--workspace` 是两回事。实测踩到过：
 * 外壳工作区是 `mmsm-amis`、会话切到了 `scheduler-service-task`，徽章却一直显示
 * 前一个仓库的分支——因为 host 拿的是固定的外壳工作区。
 *
 * 安全约束：只接受**已存在于 allowedRoots** 的路径。否则任何能访问 loopback 的
 * 页面都能让 host 对任意目录执行 git 命令，那是明显的越权面。
 * 用 realpath 比较以消除 `..` 与符号链接造成的等价路径绕过。
 *
 * @param requestUrl - 请求的 URL 对象。
 * @param allowedRoots - 允许的工作区集合（外壳工作区 + 已登记的应用工作区）。
 * @returns 绝对路径，或 undefined（不在允许集合内）。
 */
function resolveRequestWorkspace(requestUrl, allowedRoots) {
  const requested = requestUrl.searchParams.get('cwd')
  // 必须同时判 null 与空串：`URLSearchParams.get()` 在参数缺失时返回 **null**，
  // 只判 undefined/'' 会让 null 漏下去，随后 realpathSync 抛出
  // "The path argument must be of type string. Received null"（实测踩到过，
  // 表现为本该 400 的请求变成 500）。
  if (typeof requested !== 'string' || requested === '') return undefined
  if (!isAbsolute(requested)) return undefined

  let real
  try {
    real = realpathSync.native(requested)
  } catch {
    return undefined
  }
  for (const root of allowedRoots) {
    try {
      if (realpathSync.native(root) === real) return real
    } catch {
      // 允许集合里的某个根已不存在——跳过，不影响其它根。
    }
  }
  return undefined
}

/**
 * 把一个"写操作"包成统一形状：成功回**新的状态**（+远端列表），失败回稳定的 code。
 *
 * 统一形状的理由：写操作会改变 HEAD / 分支集合 / 工作区三者中的任意组合，客户端无论
 * 执行哪一个，回来都要刷新同样的几样东西。让每个路由各自决定回什么，就会出现"切分支
 * 后分支列表是旧的"这类只在某个路径上出现的 bug。
 *
 * **分支列表不在这个响应里。** 这是有意的：写操作（checkout/merge/rebase/…）之后用户
 * 最想立刻看到的是"现在在哪个分支、工作区什么状态"，而分支列表即使只起一个
 * `for-each-ref` 也要多等一次进程；如果它需要精确领先/落后就更慢。因此这里只回
 * `readStatus`（一次 `status --porcelain=v2 --branch`）与远端列表，并带
 * `branchesStale: true` 告诉客户端"你手上的分支列表已经过期了，自己去刷"。
 * 客户端据此 invalidate 分支那一份状态并异步重取——刷新发生在它自己的加载态里，
 * 不阻塞写操作的反馈。
 *
 * `code` 必须与 git 的英文原文分开：host 不知道界面语言，客户端按 code 渲染当前语言的
 * 短句，git 原文只放在 `detail` 里作为权威信息原样展示（翻译它反而失真）。
 *
 * @param cwd - 仓库根（所有 git 命令的 cwd，见 lib/repo-context.js）。
 * @param scope - 作用域字段（工作区 / 仓库），铺进成功响应。
 * @param response - HTTP 响应。
 * @param run - 实际执行 git 的函数，返回 `{ stash?, notice? }` 之类的附加信息。
 * @param onError - 把异常映射成 `{ status, code, detail }`；不返回则用通用映射。
 * @param onErrorExtra - 失败时补充的字段（可选）。**"储藏并切换"必须用它**：checkout 失败
 *   时那次储藏已经真实发生，而储藏列表只存在于这个进程刚写下的 git 状态里——错误响应若
 *   不带回它，用户就只看到"切换失败"，根本不知道自己的改动已经进了 stash。这样的事故
 *   （用户以为改动丢了）比失败本身严重得多。
 * @returns 无。
 */
async function runWrite(cwd, scope, response, run, onError, onErrorExtra) {
  try {
    const extra = (await run()) ?? {}
    // 状态与远端列表互不依赖，并发取。
    const [status, remotes] = await Promise.all([readStatus(cwd), listRemotes(cwd)])
    sendJson(response, 200, {
      ...status,
      remotes,
      branchesStale: true,
      ...scope,
      ...extra,
    })
  } catch (error) {
    const extra = typeof onErrorExtra === 'function' ? ((await onErrorExtra()) ?? {}) : {}
    const mapped = onError?.(error)
    if (mapped !== undefined) {
      sendJson(response, mapped.status, {
        error: mapped.code,
        code: mapped.code,
        detail: String(error?.message ?? error),
        ...extra,
      })
      return
    }
    // 未预期错误：仍然回一个稳定的 code（`unknown`），避免客户端拿到无 code 的响应
    // 而只能显示 git 英文原文。
    sendJson(response, 500, {
      error: 'unknown',
      code: 'unknown',
      detail: String(error?.message ?? error),
      ...extra,
    })
  }
}

/**
 * 判断 `-c core.fileMode=false` 下 git 报出的失败是否"工作区有未提交改动"。
 *
 * git 在拒绝覆盖本地改动时的报错文本跨版本稳定（"Your local changes to the following
 * files would be overwritten by checkout"），但不同子命令措辞不同（merge 用的是
 * "Your local changes ... would be overwritten by merge"）。因此按关键子串判定，
 * 拿不准就归到 unknown——**宁可让用户看到 git 原文，也不要错误地建议他暂存**。
 *
 * @param message - git 的报错文本。
 * @returns 判定结果。
 */
function looksLikeLocalChanges(message) {
  return /would be overwritten by|commit your changes or stash them|Please commit your changes/iu.test(message)
}

/**
 * 校验一个分支名参数。
 *
 * @param value - 请求给出的值。
 * @returns 通过校验则返回名字，否则 undefined。
 */
function asRef(value) {
  return typeof value === 'string' && REF_PATTERN.test(value) ? value : undefined
}

/**
 * 读一个提交的概要（HEAD 或任意修订）。
 *
 * `%B` 是**完整**提交信息（含正文），amend 要靠它把原信息填回输入框；`%P` 是父提交，
 * 「撤销最后一次提交」要用第一个父提交当作 reset 的目标（根提交没有父，那种情况走
 * `root: true` 那条路）。
 *
 * @param cwd - 仓库根。
 * @param revision - 已校验的修订（默认 HEAD）。
 * @returns `{ sha, short, subject, message, author, email, date, parents }`，或 undefined。
 */
async function readCommitSummary(cwd, revision = 'HEAD') {
  const raw = await git(
    ['show', '--no-patch', '--no-abbrev', '--format=%H%x1f%h%x1f%s%x1f%B%x1f%an%x1f%ae%x1f%cI%x1f%P', revision],
    cwd,
  ).catch(() => undefined)
  if (raw === undefined) return undefined
  const fields = String(raw).replace(/\n$/u, '').split('\u001f')
  if (fields.length < 8) return undefined
  const parents = fields[7].trim() === '' ? [] : fields[7].trim().split(/\s+/u)
  return {
    sha: fields[0].trim(),
    short: fields[1].trim(),
    subject: fields[2].trim(),
    // 结尾的换行是 git 的格式（`%B` 后面跟一个换行），去掉它，界面上再把正文原样显示。
    message: fields[3].replace(/\n$/u, ''),
    author: fields[4].trim(),
    email: fields[5].trim(),
    date: fields[6].trim(),
    parents,
  }
}

/**
 * 这个提交是否**已经发布**（存在于某个远端跟踪引用里）。
 *
 * 判定的两条路，都必须走 git 自己：
 *   1. 有上游（当前分支配了 `branch.<name>.remote`/`merge`）→ `merge-base --is-ancestor`
 *      问"HEAD 是不是上游的祖先"。是 ⇒ 远端已经有它了；
 *   2. 没有上游 → 用 `for-each-ref --contains` 问"有没有任何远端跟踪引用包含它"。这一条
 *      覆盖了"刚 fetch 下来的别人的分支里有同一个提交"这种没有上游配置的情形。
 *
 * 两种都不是时才算"尚未发布"。**不能**用 `ahead === 0` 代替：那说的是"本地没有未推送的
 * 提交"，与"这一个提交在不在远端"是两件事（rebase/amend 之后 ahead 会变，而远端那份
 * 老提交仍然在）。
 *
 * @param cwd - 仓库根。
 * @param revision - 已校验的修订。
 * @returns `{ published, upstream }`。
 */
async function readPublishedState(cwd, revision) {
  const upstream = (await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${revision}@{upstream}`], cwd).catch(() => '')).trim()
  if (upstream !== '') {
    try {
      await git(['merge-base', '--is-ancestor', revision, upstream], cwd)
      return { published: true, upstream }
    } catch {
      return { published: false, upstream }
    }
  }
  const containing = await git(['for-each-ref', '--contains', revision, '--format=%(refname:short)', 'refs/remotes'], cwd).catch(() => '')
  return { published: containing.trim() !== '', upstream: '' }
}

/**
 * 把请求里的修订解析成一个**当前仓库里确实存在**的提交 SHA。
 *
 * 只接受 40 位十六进制（界面的修订来自提交图，本来就是完整 SHA）：这样"reset 到别的
 * 仓库的提交"在**结构上**不可能发生——那个 SHA 在 `cwd` 这个仓库里根本解析不出来。
 * 比接受 `HEAD~3` 之类的 rev 表达式更安全：后者能把任意 rev 语法带进来，而这个入口
 * 只需要"图上那一条提交"。
 *
 * @param cwd - 仓库根。
 * @param value - 请求给出的修订。
 * @returns 完整 SHA，或 undefined。
 */
async function resolveCommitSha(cwd, value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value.trim())) return undefined
  const sha = (await git(['rev-parse', '--verify', '--quiet', `${value.trim()}^{commit}`], cwd).catch(() => '')).trim()
  return sha === '' ? undefined : sha
}

/**
 * reset 的三种模式（与 git 的三个开关一一对应）。
 *
 * 语义差别是这个界面的核心信息，因此集中在这里并写明：
 *   * `soft`  —— 只移动 HEAD，索引与工作区都不动（改动保持 staged）；
 *   * `mixed` —— 移动 HEAD 并重置索引，工作区不动（改动变成未暂存）；
 *   * `hard`  —— 三者一起重置（**已跟踪文件的本地修改会被丢弃**，未跟踪文件保留）。
 */
const RESET_MODES = new Set(['soft', 'mixed', 'hard'])

/**
 * 创建 git 路由的处理器。
 *
 * 路由形状：
 *   GET  /status                 当前分支与工作区状态
 *   GET  /branches               分支列表（含分组与同步所需字段，**不含**精确领先/落后）
 *   GET  /remotes                远端名与地址
 *   GET  /branch/sync            为指定分支补算精确的领先/落后（限规模与并发）
 *   POST /checkout               切换分支 / 签出标记或修订（可选 stash）
 *   POST /branch/create          新建分支（可选切过去）
 *   POST /branch/rename          重命名分支
 *   POST /branch/delete          删除分支（本地或远端）
 *   POST /branch/merge           合并到当前分支
 *   POST /branch/rebase          变基
 *   POST /cherry-pick            摘取一个提交
 *   POST /remote                 fetch / pull / push
 *   POST /op/abort               中止进行中的合并/变基/摘取
 *
 * @returns `(request, response)` 处理器。
 */
function createGitHandler() {
  return async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')

      // 每次请求都解析工作区，并且**每次都重读**允许集合。
      //
      // 重读的原因：应用侧的 `workspace.json` 会在运行中被更新（用户新选一个项目），
      // 而在 apply 时算一次就会把新项目挡在门外。重读一个小 JSON 的成本可以忽略。
      const workspace = resolveRequestWorkspace(url, collectAllowedRoots())
      if (workspace === undefined) {
        sendJson(response, 400, {
          error: 'workspace not allowed',
          code: 'workspaceNotAllowed',
          detail: 'cwd must be one of the workspaces known to this app',
        })
        return
      }

      // ---- 工作区 → 仓库：**唯一的**作用域解析点 ---------------------------
      //
      // 从这里往下，所有 git 命令的 cwd 都是 `cwd`（= repositoryRoot，拿不到时退回工作区
      // 本身，让 git 自己报"不是仓库"）。这一条同时修掉一个真实缺陷：合并/变基的标记
      // （`.git/MERGE_HEAD`）以前是按 `<工作区>/.git/...` 找的，工作区是仓库子目录时
      // 那个路径根本不存在，于是"正在进行合并"永远显示不出来。
      //
      // 多仓库项目（工作区自己不是仓库、子目录里有两个仓库）时，客户端会在
      // `?repository=` 里说明"现在在看哪一个"——它同样只由 host 校验（见 resolveScopedRepo）。
      const requestedRepository = url.searchParams.get('repository')
      const path = url.pathname
      /**
       * 哪些路由**必须**现在就有项目级仓库列表：
       *   * `/status`：徽章要显示"Git · N 个仓库"并给出选择器，它是客户端唯一会读
       *     `projectScope` 的响应（客户端的 `rememberProjectRepositories` 只认 `status`）；
       *   * `/repo-context`：它本身就是"作用域查询"，回一个空列表没有意义。
       * 其它路由（`/branches`、`/branch/sync`、写操作、…）只用已有缓存，因此不会在每次
       * 轮询上多起一个探针进程（实测：单仓库首屏 `/branches` 仍是 2 个 git 进程）。
       */
      const wantsProjectScope = path === `${ROUTE_PREFIX}/status` || path === `${ROUTE_PREFIX}/repo-context`
      const { context, scope: projectScope, error: scopeError } = await resolveScopedRepo(workspace, requestedRepository, {
        projectScope: wantsProjectScope,
      })
      if (scopeError === 'repositoryNotAllowed') {
        sendJson(response, 400, {
          error: 'repository not allowed',
          code: 'repositoryNotAllowed',
          detail: 'repository must be one of the repositories discovered in this workspace',
        })
        return
      }
      const cwd = context === undefined ? workspace : context.repositoryRoot
      const scope = scopeFields(workspace, context, projectScope)

      // 作用域查询：客户端据此确认"两个目录其实是同一个仓库"，并据此渲染多仓库徽标。
      if (path === `${ROUTE_PREFIX}/repo-context`) {
        sendJson(response, 200, { isRepo: context !== undefined, ...scope })
        return
      }

      // ---- 只读 ------------------------------------------------------------
      if (request.method === 'GET') {
        if (path === `${ROUTE_PREFIX}/status`) {
          // 不是仓库时明确回 isRepo:false，而不是让 git 的英文报错冒成 500——徽章据此
          // 安静地不显示（用户在一个非仓库目录里工作时不该看到一个红色错误）。
          if (context === undefined) {
            sendJson(response, 200, { isRepo: false, ...scope })
            return
          }
          sendJson(response, 200, { ...(await readStatus(cwd)), ...scope })
          return
        }
        if (path === `${ROUTE_PREFIX}/branches`) {
          // 首屏分支列表**只起一个 git 进程**（for-each-ref），精确的领先/落后由
          // `/branch/sync` 对可见分支按需补算（见 listBranches 的说明）。
          const { branches, counts, truncated } = await listBranches(cwd)
          sendJson(response, 200, { branches, counts, ...scope, ...(truncated ? { truncated: true } : {}) })
          return
        }
        if (path === `${ROUTE_PREFIX}/remotes`) {
          // 远端列表单独一条路由：它只在需要时（面板打开、推送对话框）取一次，
          // 不拖慢分支列表（见 listRemotes 的说明）。
          sendJson(response, 200, { remotes: await listRemotes(cwd), ...scope })
          return
        }
        if (path === `${ROUTE_PREFIX}/branch/sync`) {
          // 精确领先/落后补算。`?names=a,b,c`——**只读，所以是 GET**：它不改变仓库，
          // 用 POST 会让"读/写"这条分界线在客户端的请求记录里消失（而这个文件里
          // 其它读接口都是 GET）。
          //
          // 用逗号分隔而不是重复的 `name=` 参数：分支名的字符集（REF_PATTERN）里
          // **没有逗号**，因此切分无歧义，而 URL 也不会因为几十个分支名变得很长。
          const raw = url.searchParams.get('names') ?? ''
          const names = raw === '' ? [] : raw.split(',')
          sendJson(response, 200, { ...(await readBranchSync(cwd, names)), ...scope })
          return
        }
        if (path === `${ROUTE_PREFIX}/stash/list`) {
          // 储藏列表是**只读**的，因此是 GET（与 `/branches`、`/remotes` 一致：读不改变
          // 仓库，用 POST 会让"读 / 写"这条分界线在客户端的请求记录里消失）。
          const stashes = context === undefined ? [] : await listStashes(cwd)
          sendJson(response, 200, { isRepo: context !== undefined, ...scope, stashes, stashCount: stashes.length })
          return
        }
        // 当前 HEAD 的完整信息（amend 要把原信息填回输入框；撤销提交要知道它的父提交）。
        // 顺带算出"这个提交是否已经发布"，因为那决定了 amend 要不要给出改写历史的警告——
        // 而这只有宿主知道（upstream 与远端跟踪引用都在它手里）。
        if (path === `${ROUTE_PREFIX}/head-commit`) {
          if (context === undefined) {
            sendJson(response, 200, { isRepo: false, ...scope })
            return
          }
          const head = await readCommitSummary(cwd, 'HEAD')
          if (head === undefined) {
            // 尚无提交的仓库：这不是错误，界面据此禁用 amend / 撤销。
            sendJson(response, 200, { isRepo: true, ...scope, head: null, published: false, upstream: '', branch: '', hasCommits: false })
            return
          }
          const { published, upstream } = await readPublishedState(cwd, 'HEAD')
          sendJson(response, 200, {
            isRepo: true,
            ...scope,
            head,
            published,
            upstream,
            branch: (await currentBranchName(cwd)) ?? '',
            hasCommits: true,
          })
          return
        }
        // reset 之前的预览：HEAD 现在在哪、要移到哪、会影响几个提交。
        //
        // 与 `/reset` 分开成一条读路由是有意的：预览必须在用户**决定之前**就能看到
        // （他可能看到"会影响 30 个提交"就取消），而写路由只在真的执行时才被调用。
        if (path === `${ROUTE_PREFIX}/reset/preview`) {
          const requested = url.searchParams.get('revision')
          if (context === undefined) {
            sendJson(response, 200, { isRepo: false, ...scope })
            return
          }
          const target = requested === 'ROOT' ? undefined : await resolveCommitSha(cwd, requested)
          const root = requested === 'ROOT'
          if (!root && target === undefined) {
            sendJson(response, 404, { error: 'no such revision', code: 'noSuchRevision' })
            return
          }
          const current = await readCommitSummary(cwd, 'HEAD')
          const targetSummary = root ? null : await readCommitSummary(cwd, target)
          // `affected` = 这次 reset 会把多少个提交移出当前分支（还原目标在 HEAD 之前时，
          // 就是"将被丢弃的提交数"）；`ahead` = 目标上比 HEAD 多的提交（reset 会**前进**）。
          const affected = root
            ? Number((await git(['rev-list', '--count', 'HEAD'], cwd).catch(() => '0')).trim()) || 0
            : Number((await git(['rev-list', '--count', `${target}..HEAD`], cwd).catch(() => '0')).trim()) || 0
          const ahead = root || target === undefined
            ? 0
            : Number((await git(['rev-list', '--count', `HEAD..${target}`], cwd).catch(() => '0')).trim()) || 0
          const published = current === undefined ? { published: false, upstream: '' } : await readPublishedState(cwd, 'HEAD')
          const targetPublished = target === undefined ? { published: false, upstream: '' } : await readPublishedState(cwd, target)
          sendJson(response, 200, {
            isRepo: true,
            ...scope,
            current: current ?? null,
            target: targetSummary ?? null,
            root,
            affected,
            ahead,
            published: published.published,
            upstream: published.upstream,
            targetPublished: targetPublished.published,
            branch: (await currentBranchName(cwd)) ?? '',
          })
          return
        }
        sendJson(response, 404, { error: 'not found' })
        return
      }

      if (request.method !== 'POST') {
        response.setHeader('allow', 'GET, POST')
        sendJson(response, 405, { error: 'method not allowed' })
        return
      }

      // ---- 写操作 ----------------------------------------------------------
      // 请求体一次解析，供下面各分支使用。
      let payload
      try {
        payload = JSON.parse(await readSmallBody(request))
      } catch (error) {
        sendJson(response, 400, { error: `invalid body: ${String(error.message)}` })
        return
      }

      // 切换分支 / 签出标记或修订。表单 `{ branch, stash?, message?, includeUntracked? }`。
      if (path === `${ROUTE_PREFIX}/checkout`) {
        // 这里接受"分支名或提交 SHA"：界面的「签出标记或修订…」要能切到标签。
        // 标签名会走 asRef 分支（与分支名同一字符集），提交 SHA 走十六进制分支。
        const target = asStartPoint(payload?.branch)
        if (target === undefined) {
          sendJson(response, 400, { error: 'invalid branch name', code: 'invalidBranch' })
          return
        }
        // 储藏消息由**客户端**给：宿主不知道界面语言，而这条消息会出现在储藏列表里
        // （用户看得见），因此不能在宿主里硬编码某一种语言的文案。
        const stashMessage = normalizeStashMessage(payload?.message)
        if (stashMessage === undefined) {
          sendJson(response, 400, { error: 'invalid stash message', code: 'invalidStashMessage' })
          return
        }
        // 用户明确要求先储藏：只有这种情况才动 stash，绝不自动执行。
        let stash = { stashed: false }
        if (payload?.stash === true) {
          try {
            if (!(await isDirty(cwd))) {
              sendJson(response, 400, { error: 'nothing to stash', code: 'nothingToStash' })
              return
            }
            stash = await stashChanges(cwd, { message: stashMessage, includeUntracked: payload?.includeUntracked === true })
          } catch (error) {
            sendJson(response, 409, { error: 'stash failed', code: 'stashFailed', detail: String(error.message) })
            return
          }
        }
        await runWrite(
          cwd,
          scope,
          response,
          async () => {
            // 目标可能是**本地分支、远端分支、或标签/提交**，而 `git switch` 对三者的
            // 参数形状完全不同。这不是理论问题——实测 `switch --track v1.0.0` 报
            // "fatal: a branch is expected, got tag 'v1.0.0'"，而 `switch -- refs/heads/main`
            // 也报同样的错（它只接受短名）。因此先判定它属于哪一类，再决定参数形状：
            //   本地分支  `switch -- <短名>`            —— 直接用短名
            //   远端分支  `switch --track -- <完整 ref>` —— 建本地跟踪分支
            //   标签/提交 `switch --detach -- <名字>`    —— 显式游离 HEAD
            //               （不带 `--detach` 时 git 会拒绝，并提示加它）
            const exists = async (ref) => {
              try {
                await git(['show-ref', '--verify', '--quiet', ref], cwd)
                return true
              } catch {
                return false
              }
            }
            const onLocalBranch = await exists(`refs/heads/${target}`)
            const onRemoteBranch = !onLocalBranch && (await exists(`refs/remotes/${target}`))
            // 不加 --force / --discard-changes：有未提交改动时 git 自己会拒绝，
            // 把这个决定留给用户，而不是替他丢弃或暂存改动。
            const args = onLocalBranch
              ? ['switch', '--', target]
              : onRemoteBranch
                ? ['switch', '--track', '--', `refs/remotes/${target}`]
                : ['switch', '--detach', '--', target]
            await git(args, cwd)
            // 标签或提交会进入游离 HEAD：界面必须告诉用户，否则他下一次提交就成了
            // "没有分支的提交"，很难自己看出来。
            return { stash, detached: !onLocalBranch && !onRemoteBranch }
          },
          (error) => {
            const message = String(error?.message ?? error)
            if (looksLikeLocalChanges(message)) return { status: 409, code: 'localChanges' }
            if (/not found|did not match any|invalid reference|a branch is expected|a branch named .* already exists/iu.test(message)) {
              return { status: 404, code: 'noSuchRef' }
            }
            return undefined
          },
          // 失败也要把"储藏已经建好了"带回去：这是**不可丢**的信息（见 runWrite 的说明）。
          () => (stash.stashed === true ? { stash } : {}),
        )
        return
      }

      // 新建分支。表单 `{ name, from?, checkout? }`。
      if (path === `${ROUTE_PREFIX}/branch/create`) {
        const target = asRef(payload?.name)
        // from 可以是分支名，也可以是提交 SHA（"从某个提交新建分支"）。为空表示从 HEAD。
        const start = payload?.from === undefined || payload.from === '' ? undefined : asStartPoint(payload.from)
        if (target === undefined) {
          sendJson(response, 400, { error: 'invalid branch name', code: 'invalidBranch' })
          return
        }
        if (start === undefined && payload?.from !== undefined && payload.from !== '') {
          sendJson(response, 400, { error: 'invalid start point', code: 'invalidRevision' })
          return
        }
        const checkout = payload?.checkout === true
        await runWrite(
          cwd,
          scope,
          response,
          async () => {
            // 先判重名：`switch -c` 的报错与"名字非法"的报错混在一起，客户端无法区分，
            // 而这两种情况给用户的提示完全不同（一个是"换个名字"，一个是"名字写错了"）。
            try {
              await git(['show-ref', '--verify', '--quiet', `refs/heads/${target}`], cwd)
              const conflict = new Error(`branch '${target}' already exists`)
              conflict.known = { status: 409, code: 'branchExists' }
              throw conflict
            } catch (error) {
              if (error?.known !== undefined) throw error
              // 不存在正是期望结果。
            }
            const args = checkout
              ? ['switch', '-c', target, ...(start === undefined ? [] : [start])]
              : ['branch', target, ...(start === undefined ? [] : [start])]
            await git(args, cwd)
            return { created: target }
          },
          (error) => error?.known,
        )
        return
      }

      // 重命名分支。表单 `{ from, to }`。
      if (path === `${ROUTE_PREFIX}/branch/rename`) {
        const from = asRef(payload?.from)
        const to = asRef(payload?.to)
        if (from === undefined || to === undefined) {
          sendJson(response, 400, { error: 'invalid branch name', code: 'invalidBranch' })
          return
        }
        await runWrite(
          cwd,
          scope,
          response,
          async () => {
            // `-m` 是重命名，`-M` 是强制重命名（会覆盖同名分支）。这里用 `-m`：
            // 覆盖一个已有分支是破坏性的，不该由一次误点完成。
            await git(['branch', '-m', from, to], cwd)
            return { renamed: { from, to } }
          },
          (error) => {
            const message = String(error?.message ?? error)
            if (/already exists/iu.test(message)) return { status: 409, code: 'branchExists' }
            if (/no branch named|not found/iu.test(message)) return { status: 404, code: 'noSuchBranch' }
            return undefined
          },
        )
        return
      }

      // 删除分支。表单 `{ name, remote? , force? }`。
      if (path === `${ROUTE_PREFIX}/branch/delete`) {
        const target = asRef(payload?.name)
        if (target === undefined) {
          sendJson(response, 400, { error: 'invalid branch name', code: 'invalidBranch' })
          return
        }
        const remote = payload?.remote === true
        await runWrite(
          cwd,
          scope,
          response,
          async () => {
            if (remote) {
              // 远程分支：`origin/feature/x` → 推一个删除到 origin。
              if (!target.includes('/')) {
                const bad = new Error('remote branch name must include the remote')
                bad.known = { status: 400, code: 'invalidBranch' }
                throw bad
              }
              const remoteName = target.slice(0, target.indexOf('/'))
              if (!REMOTE_PATTERN.test(remoteName)) {
                const bad = new Error('invalid remote name')
                bad.known = { status: 400, code: 'invalidBranch' }
                throw bad
              }
              const branch = target.slice(remoteName.length + 1)
              if (branch === '') {
                const bad = new Error('empty branch name')
                bad.known = { status: 400, code: 'invalidBranch' }
                throw bad
              }
              await git(['push', remoteName, '--delete', branch], cwd, {
                timeoutMs: GIT_NETWORK_TIMEOUT_MS,
              })
              return { deleted: { name: target, remote: true } }
            }

            // 本地分支：先挡掉"删除当前分支"与"未合并"两种需要用户明确决定的情况。
            const status = await readStatus(cwd)
            if (status.branch === target) {
              const bad = new Error('cannot delete the branch you are on')
              bad.known = { status: 409, code: 'branchCheckedOut' }
              throw bad
            }
            try {
              await git(['show-ref', '--verify', '--quiet', `refs/heads/${target}`], cwd)
            } catch {
              const bad = new Error(`no branch named '${target}'`)
              bad.known = { status: 404, code: 'noSuchBranch' }
              throw bad
            }
            // `--is-ancestor` 返回 0 = 已并入 HEAD，1 = 未并入。
            // 未并入时不直接删，而是回一个 code 让用户在界面上确认——`-D` 会丢掉提交，
            // 那是不可从 UI 恢复的操作，必须有人明确点过。
            let merged = true
            try {
              await git(['merge-base', '--is-ancestor', target, 'HEAD'], cwd)
            } catch {
              merged = false
            }
            if (!merged && payload?.force !== true) {
              const bad = new Error(`branch '${target}' is not fully merged`)
              bad.known = { status: 409, code: 'notMerged' }
              throw bad
            }
            await git(['branch', merged ? '-d' : '-D', '--', target], cwd)
            return { deleted: { name: target, remote: false, forced: !merged } }
          },
          (error) => error?.known,
        )
        return
      }

      // 合并到当前分支。表单 `{ name, noFf? }`。
      if (path === `${ROUTE_PREFIX}/branch/merge`) {
        const source = asRef(payload?.name)
        if (source === undefined) {
          sendJson(response, 400, { error: 'invalid branch name', code: 'invalidBranch' })
          return
        }
        await runWrite(
          cwd,
          scope,
          response,
          async () => {
            // 默认允许快进（与命令行一致）。`noFf` 时强制产生一个合并提交，
            // 这是团队里常见的"保留合并点"偏好。
            const args = ['merge', '--no-edit', ...(payload?.noFf === true ? ['--no-ff'] : []), '--', source]
            await git(args, cwd)
            return {}
          },
          (error) => {
            const message = String(error?.message ?? error)
            // 冲突：git 已把冲突写进索引，工作区处于"合并中"。回一个专门的 code，
            // 界面据此提示"解决冲突或中止合并"，而不是笼统的"合并失败"。
            if (/CONFLICT|Automatic merge failed|fix conflicts/iu.test(message)) {
              return { status: 409, code: 'mergeConflict' }
            }
            if (looksLikeLocalChanges(message)) return { status: 409, code: 'localChanges' }
            if (/not something we can merge|did not match any/iu.test(message)) {
              return { status: 404, code: 'noSuchBranch' }
            }
            return undefined
          },
        )
        return
      }

      // 变基。表单 `{ onto, branch? }`。
      if (path === `${ROUTE_PREFIX}/branch/rebase`) {
        const onto = asRef(payload?.onto)
        if (onto === undefined) {
          sendJson(response, 400, { error: 'invalid branch name', code: 'invalidBranch' })
          return
        }
        await runWrite(
          cwd,
          scope,
          response,
          async () => {
            await git(['rebase', onto], cwd)
            return {}
          },
          (error) => {
            const message = String(error?.message ?? error)
            if (/CONFLICT|Resolve all conflicts|could not apply/iu.test(message)) {
              return { status: 409, code: 'rebaseConflict' }
            }
            if (looksLikeLocalChanges(message)) return { status: 409, code: 'localChanges' }
            return undefined
          },
        )
        return
      }

      // 摘取提交。表单 `{ revision }`。
      if (path === `${ROUTE_PREFIX}/cherry-pick`) {
        const revision = typeof payload?.revision === 'string' && REVISION_PATTERN.test(payload.revision) ? payload.revision : undefined
        if (revision === undefined) {
          sendJson(response, 400, { error: 'invalid revision', code: 'invalidRevision' })
          return
        }
        await runWrite(
          cwd,
          scope,
          response,
          async () => {
            // 先判"这次摘取会不会是空的"：目标提交的改动已经以同样内容存在于当前分支时，
            // `cherry-pick` 会**修改工作区或索引之后**才说"nothing to commit"并以非零退出，
            // 或者干脆报 `The previous cherry-pick is now empty`。
            //
            // 实测踩到过：用户从提交图上摘一个"内容已经在当前分支里"的提交，界面报
            // "摘取冲突"（因为 git 那句话里带 'could not apply' 之类的字样），而仓库其实
            // 已经干净——用户完全无从判断发生了什么。这里提前判掉，并把"这个提交的内容
            // 已经在当前分支里"作为结果告诉界面。
            //
            // 用 `git cherry` 而不是自己去比树：它正是为这个问题存在的（比较 patch-id），
            // 能识别"改动相同但提交对象不同"的情形（例如已被变基或改写过的提交）。
            try {
              const cherry = await git(['cherry', 'HEAD', revision, `${revision}^`], cwd)
              if (/^-\s/u.test(cherry)) return { cherryPicked: revision, empty: true }
            } catch {
              // `cherry` 在首提交（无父）等边界上会失败——那不影响摘取本身，继续走正常路径。
            }

            try {
              await git(['cherry-pick', revision], cwd)
            } catch (error) {
              const message = String(error?.message ?? error)
              // 空摘取同样是"结果已存在"，不是失败。此时 git 可能已经把 HEAD 留在
              // 一个空提交的中间状态，必须 `--abort` 回到干净状态再回话——否则用户
              // 会卡在一个自己不认识的状态里。
              if (/cherry-pick is now empty|nothing to commit|The previous cherry-pick/iu.test(message)) {
                await git(['cherry-pick', '--abort'], cwd).catch(() => undefined)
                return { cherryPicked: revision, empty: true }
              }
              throw error
            }
            return { cherryPicked: revision, empty: false }
          },
          (error) => {
            const message = String(error?.message ?? error)
            if (/CONFLICT|could not apply/iu.test(message)) return { status: 409, code: 'cherryPickConflict' }
            // git 对"这个对象不存在"措辞有多种：`bad object` / `bad revision` /
            // `unknown revision` / `invalid reference`。任何一种都该是 404，
            // 而不是落到通用的 500——否则界面显示"未知错误"，而真正的原因是用户
            // 点了图上一个已经不在本地对象库里的提交。
            if (/bad object|bad revision|unknown revision|invalid reference|not a valid object/iu.test(message)) {
              return { status: 404, code: 'noSuchRef' }
            }
            return undefined
          },
        )
        return
      }

      // 远端操作。表单 `{ action, remote?, branch?, setUpstream?, tags? }`。
      if (path === `${ROUTE_PREFIX}/remote`) {
        const action = payload?.action
        const remote = payload?.remote === undefined || payload.remote === '' ? undefined : String(payload.remote)
        if (remote !== undefined && !REMOTE_PATTERN.test(remote)) {
          sendJson(response, 400, { error: 'invalid remote name', code: 'invalidRemote' })
          return
        }
        const branch = payload?.branch === undefined || payload.branch === '' ? undefined : asRef(payload.branch)
        if (payload?.branch !== undefined && payload.branch !== '' && branch === undefined) {
          sendJson(response, 400, { error: 'invalid branch name', code: 'invalidBranch' })
          return
        }

        const network = { timeoutMs: GIT_NETWORK_TIMEOUT_MS, env: NON_INTERACTIVE_ENV }
        if (action === 'fetch') {
          await runWrite(
            cwd,
            scope,
            response,
            async () => {
              // `--prune`：远端已删的分支在本地也清掉，否则"最近"分组里会一直挂着
              // 早已不存在的分支。不加 `--tags`（那会拉全部标签，慢且吵）。
              await git(['fetch', '--prune', ...(remote === undefined ? [] : [remote])], cwd, network)
              return { fetched: remote ?? 'all' }
            },
            (error) => (/could not read|Could not resolve|unable to access|Authentication failed/iu.test(String(error?.message ?? error))
              ? { status: 502, code: 'networkFailed' }
              : undefined),
          )
          return
        }
        if (action === 'pull') {
          await runWrite(
            cwd,
            scope,
            response,
            async () => {
              // 不加 --rebase/--no-rebase：用户的 pull.rebase 配置由 git 自己决定，
              // 我们不该在插件里替他选一种历史形状。
              await git(['pull', '--no-edit', ...(remote === undefined ? [] : [remote]), ...(branch === undefined ? [] : [branch])], cwd, network)
              return {}
            },
            (error) => {
              const message = String(error?.message ?? error)
              if (/CONFLICT|Automatic merge failed/iu.test(message)) return { status: 409, code: 'mergeConflict' }
              if (looksLikeLocalChanges(message)) return { status: 409, code: 'localChanges' }
              if (/could not read|Could not resolve|unable to access|Authentication failed|no tracking information/iu.test(message)) {
                return { status: 502, code: 'networkFailed' }
              }
              return undefined
            },
          )
          return
        }
        if (action === 'push') {
          const setUpstream = payload?.setUpstream === true
          /**
           * 强推必须**显式**请求：`--force-with-lease` 而不是裸 `--force`。
           *
           * `--force` 会无条件覆盖远端，包括协作者在你 fetch 之后推上去的提交；
           * `--force-with-lease` 在远端与本地记录不一致时会拒绝，因此只在"确实是你在
           * 改写的分支"上生效。UI 仍然会二次确认（这是少数必须确认的操作之一）。
           */
          const forceWithLease = payload?.forceWithLease === true
          /**
           * 远端名与 refspec。
           *
           * 需要"显式远端 + 显式 refspec"的只有两种形态，而这两种恰好是这次新增的能力：
           *   * `setUpstream`（第一次推送 / 发布分支）
           *   * 推送**某个指定分支**（分支行菜单里的「推送」）
           *
           * `git push -u origin`、`git push -u` 都不会设置上游（前者报 "no upstream
           * branch"，后者仍缺 refspec），`git push -u feature:feature` 更是把
           * `feature:feature` 当远端名。因此这里自己把两面都补全。**普通的
           * `git push`（当前分支、已有上游）一个参数都不加**，push.default 由用户配置决定。
           */
          const needsTarget = setUpstream || branch !== undefined
          const source = branch ?? (needsTarget ? await currentBranchName(cwd) : undefined)
          const target = needsTarget ? remote ?? (await resolvePushRemote(cwd, source)) : undefined
          if (needsTarget && target === undefined) {
            // 一个远端都没配：这是"没地方可推"，与网络失败、被拒绝都不同。
            sendJson(response, 409, { error: 'no remote configured', code: 'noRemote' })
            return
          }
          if (needsTarget && source === undefined) {
            // 游离 HEAD：没有分支名可以建立跟踪关系（`git push -u` 在这里也没有意义）。
            sendJson(response, 409, { error: 'detached HEAD', code: 'detachedHead' })
            return
          }
          await runWrite(
            cwd,
            scope,
            response,
            async () => {
              const args = ['push']
              // 只有明确要求时才 `--set-upstream`：它会改变本地的跟踪配置。
              if (setUpstream) args.push('--set-upstream')
              if (forceWithLease) args.push('--force-with-lease')
              if (target !== undefined) args.push(target)
              if (source !== undefined) args.push(`${source}:${source}`)
              await git(args, cwd, network)
              return { pushed: source ?? 'HEAD', remote: target ?? '', forceWithLease }
            },
            (error) => {
              const message = String(error?.message ?? error)
              // 顺序有意义：先判"没有上游"（它也会带上 rejected 之类的字样），
              // 否则用户看到的是"推送被拒绝"，而真正要做的是「发布分支」。
              if (/has no upstream branch|no upstream branch/iu.test(message)) {
                return { status: 409, code: 'noUpstream' }
              }
              if (/stale info|force-with-lease|fetch first/iu.test(message)) {
                return { status: 409, code: 'pushRejected' }
              }
              if (/rejected|non-fast-forward|behind/iu.test(message)) {
                return { status: 409, code: 'pushRejected' }
              }
              if (/could not read Username|Authentication failed|Permission denied|terminal prompts disabled/iu.test(message)) {
                return { status: 502, code: 'authFailed' }
              }
              if (/does not appear to be a git repository|No such remote|no remote/iu.test(message)) {
                return { status: 409, code: 'noRemote' }
              }
              if (/could not read|Could not resolve|unable to access|Connection refused|timed out/iu.test(message)) {
                return { status: 502, code: 'networkFailed' }
              }
              return undefined
            },
          )
          return
        }
        sendJson(response, 400, { error: 'unknown remote action', code: 'unknown' })
        return
      }

      // ---- 把当前分支重置到某个提交 -----------------------------------------
      //
      // 表单 `{ revision, mode, root?, acknowledgeDestructive? }`。
      //   revision  提交 SHA（来自提交图；必须是**这个**仓库里的提交）
      //   root      true 表示"重置到第一个提交之前"（撤销根提交；只有 soft/mixed 支持）
      //   mode      soft | mixed | hard
      //   acknowledgeDestructive  hard 必须显式带上：界面的强确认按钮才会加它
      //
      // 这是**改写当前分支位置**的操作，因此校验比只读路由严格得多：模式白名单、修订必须
      // 能在这个仓库里解析成提交、hard 必须显式确认。绝不接受 `HEAD~3` 这类 rev 表达式——
      // 那个入口只需要"图上那一条提交"。
      if (path === `${ROUTE_PREFIX}/reset`) {
        const mode = typeof payload?.mode === 'string' ? payload.mode : ''
        if (!RESET_MODES.has(mode)) {
          sendJson(response, 400, { error: 'unknown reset mode', code: 'invalidResetMode' })
          return
        }
        const root = payload?.root === true
        if (root && mode === 'hard') {
          // git 没有"重置到没有提交的状态并丢弃工作区"这条命令；硬要做到它只能靠
          // `read-tree --empty` 加删文件，那已经超出"安全的历史恢复"的范畴。
          sendJson(response, 400, { error: 'hard reset to the root is not supported', code: 'unsupportedReset' })
          return
        }
        // 破坏性动作的显式确认：hard 会丢弃已跟踪文件的本地修改，因此**必须**由请求自己
        // 声明"用户已经确认过"。界面在强确认弹窗的确定按钮里才带上它，于是"误发一次
        // hard reset"在协议层就不可能发生。
        if (mode === 'hard' && payload?.acknowledgeDestructive !== true) {
          sendJson(response, 400, { error: 'destructive reset requires acknowledgement', code: 'destructiveNotAcknowledged' })
          return
        }
        let target
        if (root) {
          const head = await readCommitSummary(cwd, 'HEAD')
          if (head === undefined) {
            sendJson(response, 409, { error: 'no commits', code: 'noCommits' })
            return
          }
          target = undefined
        } else {
          target = await resolveCommitSha(cwd, payload?.revision)
          if (target === undefined) {
            sendJson(response, 404, { error: 'no such revision', code: 'noSuchRevision' })
            return
          }
        }
        const previous = await readCommitSummary(cwd, 'HEAD')
        /**
         * 这次 reset 会移出当前分支的提交数——**必须在动手之前算**。
         *
         * 动手之后 HEAD 已经指向目标（root 那条路更是连 HEAD 都没有了），再问"从目标到
         * HEAD 有多少个提交"只会得到 0 或一句报错。因此这里的顺序是有意的。
         */
        const affected =
          previous === undefined
            ? 0
            : Number(
                (await git(['rev-list', '--count', target === undefined ? previous.sha : `${target}..${previous.sha}`], cwd).catch(() => '0')).trim(),
              ) || 0
        const published = previous === undefined ? false : (await readPublishedState(cwd, previous.sha)).published
        await runWrite(
          cwd,
          scope,
          response,
          async () => {
            if (target === undefined) {
              // 撤销"第一个提交"：`update-ref -d HEAD` 把 HEAD 从引用里去掉，索引与工作区
              // 都不动 —— 这正是 `reset --soft` 在没有父提交时的等价物。`mixed` 再多一步
              // `read-tree --empty`（索引清空、工作区保留）。
              if (mode === 'mixed') await git(['read-tree', '--empty'], cwd)
              await git(['update-ref', '-d', 'HEAD'], cwd)
            } else {
              await git(['reset', `--${mode}`, target], cwd)
            }
            return {
              reset: {
                mode,
                root,
                affected,
                target: target === undefined ? null : (await readCommitSummary(cwd, target)) ?? null,
                // 撤销入口要用它：reset 之前 HEAD 在哪。`ORIG_HEAD` 也是 git 自己留下的一份，
                // 但那是给命令行用的，界面上的"撤销这次 reset"必须拿得到确切的值。
                previousHead: previous ?? null,
                published,
              },
            }
          },
          (error) => {
            const message = String(error?.message ?? error)
            if (/not a valid object|unknown revision|bad revision/iu.test(message)) return { status: 404, code: 'noSuchRevision' }
            if (/uncommitted changes|would be overwritten/iu.test(message)) return { status: 409, code: 'localChanges' }
            return undefined
          },
        )
        return
      }

      // ---- 储藏（stash）-----------------------------------------------------
      //
      // 全部走**同一个 cwd**（= 当前 repositoryRoot），因此多仓库项目里 frontend 的储藏
      // 不可能出现在 backend 的列表里：储藏是仓库自己的 reflog（`refs/stash`），换仓库就是
      // 换 cwd，没有任何共享状态。这一条不是靠界面过滤实现的，而是结构上就成立。
      //
      // 消息与 untracked 选项由客户端给：宿主不知道界面语言，而储藏消息会出现在列表里
      // 给用户看（见 normalizeStashMessage）。
      // 创建储藏。表单 `{ message?, includeUntracked? }`。
      if (path === `${ROUTE_PREFIX}/stash/push`) {
        const message = normalizeStashMessage(payload?.message)
        if (message === undefined) {
          sendJson(response, 400, { error: 'invalid stash message', code: 'invalidStashMessage' })
          return
        }
        const includeUntracked = payload?.includeUntracked === true
        // 未合并条目还在时 `git stash push` 会以 "needs merge / could not write index" 失败。
        // 那句话说给用户听毫无意义（真正要做的是先解决冲突），因此提前判定并给出专门的 code。
        const unmerged = await listUnmergedPaths(cwd)
        if (unmerged.length > 0) {
          sendJson(response, 409, { error: 'unmerged files', code: 'unmerged', detail: String(unmerged.length) })
          return
        }
        // 先判"有没有东西可存"：只有未跟踪文件、而用户没勾选包含未跟踪时，`git stash push`
        // 会**以 0 退出**且什么也不做（见 stashChanges 的说明），那种"点了没反应"必须避免。
        const trackedChanges = await countTrackedChanges(cwd)
        const untrackedChanges = await countUntrackedFiles(cwd)
        if (trackedChanges === 0 && !(includeUntracked && untrackedChanges > 0)) {
          sendJson(response, 400, { error: 'nothing to stash', code: 'nothingToStash' })
          return
        }
        await runWrite(cwd, scope, response, async () => {
          const stash = await stashChanges(cwd, { message, includeUntracked })
          if (stash.stashed !== true) {
            // 上面的预检之后仍然没存进去：git 的判定比我们的预检更细（例如改动只是
            // "文件模式"而 `core.fileMode=false` 下 git 认为没有变化）。照实回报。
            return { stash: { stashed: false } }
          }
          return { stash, stashed: true }
        })
        return
      }

      // 应用 / 弹出储藏。表单 `{ ref }`。
      if (path === `${ROUTE_PREFIX}/stash/apply` || path === `${ROUTE_PREFIX}/stash/pop`) {
        const popping = path.endsWith('/pop')
        const entry = await findStash(cwd, payload?.ref)
        if (entry === undefined) {
          sendJson(response, 404, { error: 'no such stash', code: 'noSuchStash' })
          return
        }
        // 索引里还有未解决的冲突时，git 会拒绝（"needs merge / could not write index"）。
        // 这必须**提前**判定：否则下面那条"尝试之后仍有未合并条目 ⇒ 是冲突"的判定会把这
        // 次拒绝误报成"应用成功但有冲突"，用户会以为自己刚应用的储藏已经生效了。
        const beforeUnmerged = await listUnmergedPaths(cwd)
        if (beforeUnmerged.length > 0) {
          sendJson(response, 409, { error: 'unmerged files', code: 'unmerged', detail: String(beforeUnmerged.length) })
          return
        }
        await runWrite(
          cwd,
          scope,
          response,
          async () => {
            try {
              await git(['stash', popping ? 'pop' : 'apply', entry.ref], cwd, { env: NON_INTERACTIVE_ENV })
            } catch (error) {
              /**
               * `git stash apply/pop` **以非零退出**有两个完全不同的原因：真的失败，
               * 或者"应用了但留下冲突"。退出码分不出来，索引能分：还有未合并条目就是冲突。
               *
               * 冲突**不是失败**：文件已经写进工作区（带标记），接下来该进冲突面板逐块解决。
               * 另外 `pop` 在冲突时**不会**删掉储藏（git 的行为），所以这里照实回报 `kept`。
               */
              const conflicts = await listConflictEntries(cwd)
              if (conflicts.length === 0) throw error
              return {
                applied: true,
                conflicted: true,
                conflicts,
                stash: { ...entry, kept: true, popped: false },
              }
            }
            // 成功：`apply` 一定保留储藏，`pop` 一定删掉它。重读一次列表来**确认**，
            // 而不是照抄我们期望的行为（列表是权威）。
            const rest = await listStashes(cwd)
            const stillThere = rest.some((candidate) => candidate.ref === entry.ref && candidate.sha === entry.sha)
            return {
              applied: true,
              conflicted: false,
              conflicts: [],
              stash: { ...entry, kept: stillThere, popped: popping && !stillThere },
            }
          },
          (error) => {
            const message = String(error?.message ?? error)
            if (looksLikeLocalChanges(message)) return { status: 409, code: 'localChanges' }
            if (/needs merge|could not write index/iu.test(message)) return { status: 409, code: 'unmerged' }
            return undefined
          },
          // 应用/弹出失败时储藏**仍然在**（`apply` 本来就不删，`pop` 失败也不删），
          // 把这个事实带回去，界面才能说清"你的改动还在储藏里"。
          () => ({ stash: { ...entry, kept: true } }),
        )
        return
      }

      // 删除储藏（破坏性动作，界面必须二次确认）。表单 `{ ref }`。
      if (path === `${ROUTE_PREFIX}/stash/drop`) {
        const entry = await findStash(cwd, payload?.ref)
        if (entry === undefined) {
          sendJson(response, 404, { error: 'no such stash', code: 'noSuchStash' })
          return
        }
        await runWrite(cwd, scope, response, async () => {
          await git(['stash', 'drop', entry.ref], cwd, { env: NON_INTERACTIVE_ENV })
          return { dropped: entry.ref, stash: { ...entry, stashed: false } }
        })
        return
      }

      // 结束进行中的合并/变基/摘取/还原（冲突全部解决之后）。表单 `{}`。
      //
      // 这是「冲突解决」的最后一步，必须按**当前实际进行中的操作**选命令：合并是
      // "把已解决的索引提交成一个合并提交"，变基/摘取/还原是 `--continue`。四者的命令
      // 完全不同，猜错会让用户停在一个自己不认识的中间状态里。
      if (path === `${ROUTE_PREFIX}/op/continue`) {
        const operation = await readOperation(cwd)
        if (operation === null) {
          sendJson(response, 409, { error: 'no operation in progress', code: 'noOperation' })
          return
        }
        await runWrite(
          cwd,
          scope,
          response,
          async () => {
            try {
              if (operation.type === 'merge') {
                // `--no-edit` 用 MERGE_MSG：宿主没有终端，不能让它去开编辑器。
                await git(['commit', '--no-edit'], cwd, { env: NON_INTERACTIVE_ENV })
              } else if (operation.type === 'rebase') {
                await git(['rebase', '--continue'], cwd, { env: NON_INTERACTIVE_ENV })
              } else if (operation.type === 'cherry-pick') {
                await git(['cherry-pick', '--continue'], cwd, { env: NON_INTERACTIVE_ENV })
              } else {
                await git(['revert', '--continue'], cwd, { env: NON_INTERACTIVE_ENV })
              }
            } catch (error) {
              /**
               * 变基/摘取是**一次一个提交**地往下走的：解决完当前这个提交，`--continue`
               * 继续处理下一个，而下一个提交再次冲突时命令仍然以非零退出。这在多轮冲突里
               * 是**正常的前进**，不是失败——把它当失败，界面会停在一句"还有冲突没解决"上，
               * 而磁盘其实已经进入下一轮，用户只能自己发现并手动重新读取。
               *
               * 判定依据是宿主自己重新读到的状态（git 是权威，不解析 git 的提示文案）：
               * 操作仍在进行中**且**索引里确实还有未合并的路径 ⇒ 前进到了下一次冲突。
               * 合并只有一轮，保持原有语义（索引不干净就是"还没解决完"）。
               */
              if (operation.type !== 'merge') {
                const running = await readOperation(cwd)
                const unmerged = await git(['diff', '--name-only', '--diff-filter=U'], cwd).catch(() => '')
                const pending = unmerged
                  .split('\n')
                  .map((line) => line.trim())
                  .filter((line) => line !== '')
                if (running !== null && running.type === operation.type && pending.length > 0) {
                  return { continued: operation.type, stoppedAtNextConflict: true, conflicts: pending.length, paths: pending }
                }
              }
              throw error
            }
            return { continued: operation.type }
          },
          (error) => {
            const message = String(error?.message ?? error)
            // 还有没解决的冲突：git 会拒绝提交/继续。这是"还没做完"，不是失败。
            if (/unmerged|needs merge|you have unmerged files|Resolve all conflicts|conflict/iu.test(message)) {
              return { status: 409, code: 'conflictPending' }
            }
            if (/nothing to commit|no cherry-pick or revert in progress|no rebase in progress|not currently merging/iu.test(message)) {
              return { status: 409, code: 'noOperation' }
            }
            if (/would be overwritten|local changes/iu.test(message)) return { status: 409, code: 'localChanges' }
            return undefined
          },
        )
        return
      }

      // 中止进行中的合并/变基/摘取/还原。表单 `{ kind }`。
      if (path === `${ROUTE_PREFIX}/op/abort`) {
        const kind = payload?.kind
        const args =
          kind === 'merge'
            ? ['merge', '--abort']
            : kind === 'rebase'
              ? ['rebase', '--abort']
              : kind === 'cherry-pick'
                ? ['cherry-pick', '--abort']
                : kind === 'revert'
                  ? ['revert', '--abort']
                  : undefined
        if (args === undefined) {
          sendJson(response, 400, { error: 'unknown operation', code: 'unknown' })
          return
        }
        await runWrite(cwd, scope, response, async () => {
          await git(args, cwd, { env: NON_INTERACTIVE_ENV })
          return { aborted: kind }
        })
        return
      }

      sendJson(response, 404, { error: 'not found' })
    } catch (error) {
      // 任何未预期错误都转成 JSON，避免客户端拿到 HTML 错误页而无法解析。
      sendJson(response, 500, { error: 'unknown', code: 'unknown', detail: String(error?.message ?? error) })
    }
  }
}

/**
 * 已跟踪改动的条数（不含未跟踪文件）。
 *
 * `git stash push` 在"只有未跟踪文件、又没带 `-u`"时会以 0 退出且什么也不做，因此
 * 「有没有东西可储藏」必须分开数：未跟踪文件要不要算进去取决于用户有没有勾选。
 *
 * @param cwd - 仓库根。
 * @returns 条数。
 */
async function countTrackedChanges(cwd) {
  const raw = await git(['status', '--porcelain', '-z', '--untracked-files=no'], cwd)
  return raw.split('\u0000').filter((record) => record !== '').length
}

/**
 * 未跟踪文件的条数。
 *
 * 用 `--untracked-files=normal`（而不是 `all`）：折叠目录与逐个文件在这一步没有区别——
 * 只需要知道"有没有"，`all` 在几千个未跟踪文件的仓库里会白花时间枚举。
 *
 * @param cwd - 仓库根。
 * @returns 条数。
 */
async function countUntrackedFiles(cwd) {
  const raw = await git(['status', '--porcelain', '-z', '--untracked-files=normal'], cwd)
  return raw.split('\u0000').filter((record) => record.startsWith('?? ')).length
}

/**
 * 校验并规整一个 stash 消息。
 *
 * 消息会成为 stash 提交的主题、并在列表里显示给用户，因此：去掉首尾空白、去掉控制字符
 * （它们会让 `git stash list` 的输出难以阅读，也让列表里那一行断成两截）、限制长度。
 * NUL 是**禁用**的（它是下面 `--format` 解析的字段分隔符）。空串表示"让 git 写它自己的
 * WIP 主题"，这是合法的，不是错误。
 *
 * @param value - 请求给出的消息（可以是 undefined）。
 * @returns 规整后的消息；输入形状非法（不是字符串）时返回 undefined。
 */
function normalizeStashMessage(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') return undefined
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .trim()
    .slice(0, 200)
  return cleaned
}

/**
 * 校验并规整"起点"参数（新建分支的 from、签出的修订、比较用的基准）。
 *
 * 允许两种形状：一个合法的分支名，或一个十六进制提交 SHA。**不接受其它 rev 表达式**
 * （`HEAD~1`、`main@{2}`）——它们能把任意 rev 语法带进来，而这正是白名单要挡住的东西。
 *
 * @param value - 请求给出的值。
 * @returns 规整后的字符串，或 undefined。
 */
function asStartPoint(value) {
  if (typeof value !== 'string') return undefined
  if (REVISION_PATTERN.test(value)) return value
  return asRef(value)
}

/**
 * 挂载插件。
 * @param ctx - host 侧 cordis 上下文。
 */
export function apply(ctx) {
  // 工作区在**每次请求**里解析（见 createGitHandler），因为会话可以选择自己的项目：
  // 那只存在应用侧状态里（`<home>/storages/workspace.json`），外壳启动时的
  // `--workspace` 只是其中之一。不这样处理，用户切换项目后徽章会继续显示上一个
  // 仓库的分支——实测踩到过。
  const handler = createGitHandler()

  // 注册为多条精确路由而不是一条前缀路由：webServer 的 kind 只有 exact 与 prefix
  // 两类语义，用精确路径可以让"哪些路径属于本插件"在注册表里一目了然。
  const routes = [
    `${ROUTE_PREFIX}/status`,
    `${ROUTE_PREFIX}/branches`,
    `${ROUTE_PREFIX}/remotes`,
    `${ROUTE_PREFIX}/branch/sync`,
    `${ROUTE_PREFIX}/checkout`,
    `${ROUTE_PREFIX}/head-commit`,
    `${ROUTE_PREFIX}/reset`,
    `${ROUTE_PREFIX}/reset/preview`,
    `${ROUTE_PREFIX}/stash/list`,
    `${ROUTE_PREFIX}/stash/push`,
    `${ROUTE_PREFIX}/stash/apply`,
    `${ROUTE_PREFIX}/stash/pop`,
    `${ROUTE_PREFIX}/stash/drop`,
    `${ROUTE_PREFIX}/branch/create`,
    `${ROUTE_PREFIX}/branch/rename`,
    `${ROUTE_PREFIX}/branch/delete`,
    `${ROUTE_PREFIX}/branch/merge`,
    `${ROUTE_PREFIX}/branch/rebase`,
    `${ROUTE_PREFIX}/cherry-pick`,
    `${ROUTE_PREFIX}/remote`,
    `${ROUTE_PREFIX}/op/abort`,
    `${ROUTE_PREFIX}/op/continue`,
  ]
  for (const path of routes) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }), `gitbar: ${path}`)
  }
}
