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
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

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
 * 读取当前分支与工作区状态。
 *
 * 一次 `status --porcelain=v2 --branch` 同时给出分支、上游、领先/落后与改动文件数，
 * 比多次调用更省进程也更一致（多次调用之间用户可能刚好切了分支）。
 *
 * @param cwd - 工作区路径。
 * @returns 供客户端渲染的状态对象。
 */
async function readStatus(cwd) {
  const raw = await git(['status', '--porcelain=v2', '--branch'], cwd)

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
  }

  for (const line of raw.split('\n')) {
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
      if (value !== '(initial)') state.head = value
    } else if (line.startsWith('? ')) {
      state.untrackedFiles += 1
    } else if (line !== '' && !line.startsWith('#')) {
      state.changedFiles += 1
    }
  }

  // 未跟踪文件也计入改动文件总数：徽章上的 `*N` 表示"工作区与 HEAD 的差异条数"，
  // 把新增文件排除在外会让用户以为"文件没被识别"。但两组分开计数，界面可以分别显示。
  state.changedFiles += state.untrackedFiles

  // 进行中的操作：git 在冲突时会留下这些目录。用来决定是否显示"中止合并/变基"。
  const marker = (relative) => {
    try {
      realpathSync.native(join(cwd, relative))
      return true
    } catch {
      return false
    }
  }
  // `.git` 可能是文件（worktree / submodule），此时这些标记在别处；读不到就当没有，
  // 不为了这个额外跑一次 `rev-parse --git-dir`。
  state.merging = marker('.git/MERGE_HEAD')
  state.rebasing = marker('.git/rebase-merge') || marker('.git/rebase-apply')
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
 * @param cwd - 工作区路径。
 * @param names - 客户端请求的分支短名（本地或远程）。
 * @returns `{ sync: { [name]: { ahead, behind, diverged, upstreamGone, exact } } }`。
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
        sync[name] = { ahead: 0, behind: 0, diverged: false, upstreamGone: false, exact: true }
        continue
      }
      const result = await readUpstreamCounts(cwd, target.upstream, target.ref, target.track)
      sync[name] = {
        ahead: result.ahead,
        behind: result.behind,
        diverged: result.diverged,
        upstreamGone: result.gone,
        exact: true,
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
 * 把未提交改动存进 stash（含未跟踪文件），并返回 stash 引用。
 *
 * 只在用户明确点了「暂存并切换」时调用——**绝不自动执行**。stash 是可恢复的
 * （`git stash pop`），但仍是替用户移动了他的工作区状态，必须由他决定。
 *
 * @param cwd - 工作区路径。
 * @param branch - 目标分支名，仅用于生成可辨认的 stash 消息。
 * @returns 成功时的 `{ stashed: true, ref }`；无改动可暂存时 `{ stashed: false }`。
 */
async function stashChanges(cwd, branch) {
  if (!(await isDirty(cwd))) return { stashed: false }
  // -u 把未跟踪文件一并纳入：否则它们可能在切换后被目标分支的同名文件覆盖或残留。
  await git(['stash', 'push', '-u', '-m', `dsh-gitbar: 切换到 ${branch} 前的自动暂存`], cwd)
  const ref = (await git(['rev-parse', '--short', 'stash'], cwd)).trim()
  return { stashed: true, ref }
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
 * @param workspace - 已校验的工作区路径。
 * @param response - HTTP 响应。
 * @param run - 实际执行 git 的函数，返回 `{ stash?, notice? }` 之类的附加信息。
 * @param onError - 把异常映射成 `{ status, code, detail }`；不返回则用通用映射。
 * @returns 无。
 */
async function runWrite(workspace, response, run, onError) {
  try {
    const extra = (await run()) ?? {}
    // 状态与远端列表互不依赖，并发取。
    const [status, remotes] = await Promise.all([readStatus(workspace), listRemotes(workspace)])
    sendJson(response, 200, {
      ...status,
      remotes,
      branchesStale: true,
      ...extra,
    })
  } catch (error) {
    const mapped = onError?.(error)
    if (mapped !== undefined) {
      sendJson(response, mapped.status, {
        error: mapped.code,
        code: mapped.code,
        detail: String(error?.message ?? error),
      })
      return
    }
    // 未预期错误：仍然回一个稳定的 code（`unknown`），避免客户端拿到无 code 的响应
    // 而只能显示 git 英文原文。
    sendJson(response, 500, {
      error: 'unknown',
      code: 'unknown',
      detail: String(error?.message ?? error),
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

      const path = url.pathname

      // ---- 只读 ------------------------------------------------------------
      if (request.method === 'GET') {
        if (path === `${ROUTE_PREFIX}/status`) {
          sendJson(response, 200, await readStatus(workspace))
          return
        }
        if (path === `${ROUTE_PREFIX}/branches`) {
          // 首屏分支列表**只起一个 git 进程**（for-each-ref），精确的领先/落后由
          // `/branch/sync` 对可见分支按需补算（见 listBranches 的说明）。
          const { branches, counts, truncated } = await listBranches(workspace)
          sendJson(response, 200, { branches, counts, ...(truncated ? { truncated: true } : {}) })
          return
        }
        if (path === `${ROUTE_PREFIX}/remotes`) {
          // 远端列表单独一条路由：它只在需要时（面板打开、推送对话框）取一次，
          // 不拖慢分支列表（见 listRemotes 的说明）。
          sendJson(response, 200, { remotes: await listRemotes(workspace) })
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
          sendJson(response, 200, await readBranchSync(workspace, names))
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

      // 切换分支 / 签出标记或修订。表单 `{ branch, stash? }`。
      if (path === `${ROUTE_PREFIX}/checkout`) {
        // 这里接受"分支名或提交 SHA"：界面的「签出标记或修订…」要能切到标签。
        // 标签名会走 asRef 分支（与分支名同一字符集），提交 SHA 走十六进制分支。
        const target = asStartPoint(payload?.branch)
        if (target === undefined) {
          sendJson(response, 400, { error: 'invalid branch name', code: 'invalidBranch' })
          return
        }
        // 用户明确要求先暂存：只有这种情况才动 stash，绝不自动执行。
        let stash = { stashed: false }
        if (payload?.stash === true) {
          try {
            if (!(await isDirty(workspace))) {
              sendJson(response, 400, { error: 'nothing to stash', code: 'nothingToStash' })
              return
            }
            stash = await stashChanges(workspace, target)
          } catch (error) {
            sendJson(response, 409, { error: 'stash failed', code: 'stashFailed', detail: String(error.message) })
            return
          }
        }
        await runWrite(
          workspace,
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
                await git(['show-ref', '--verify', '--quiet', ref], workspace)
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
            await git(args, workspace)
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
          workspace,
          response,
          async () => {
            // 先判重名：`switch -c` 的报错与"名字非法"的报错混在一起，客户端无法区分，
            // 而这两种情况给用户的提示完全不同（一个是"换个名字"，一个是"名字写错了"）。
            try {
              await git(['show-ref', '--verify', '--quiet', `refs/heads/${target}`], workspace)
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
            await git(args, workspace)
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
          workspace,
          response,
          async () => {
            // `-m` 是重命名，`-M` 是强制重命名（会覆盖同名分支）。这里用 `-m`：
            // 覆盖一个已有分支是破坏性的，不该由一次误点完成。
            await git(['branch', '-m', from, to], workspace)
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
          workspace,
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
              await git(['push', remoteName, '--delete', branch], workspace, {
                timeoutMs: GIT_NETWORK_TIMEOUT_MS,
              })
              return { deleted: { name: target, remote: true } }
            }

            // 本地分支：先挡掉"删除当前分支"与"未合并"两种需要用户明确决定的情况。
            const status = await readStatus(workspace)
            if (status.branch === target) {
              const bad = new Error('cannot delete the branch you are on')
              bad.known = { status: 409, code: 'branchCheckedOut' }
              throw bad
            }
            try {
              await git(['show-ref', '--verify', '--quiet', `refs/heads/${target}`], workspace)
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
              await git(['merge-base', '--is-ancestor', target, 'HEAD'], workspace)
            } catch {
              merged = false
            }
            if (!merged && payload?.force !== true) {
              const bad = new Error(`branch '${target}' is not fully merged`)
              bad.known = { status: 409, code: 'notMerged' }
              throw bad
            }
            await git(['branch', merged ? '-d' : '-D', '--', target], workspace)
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
          workspace,
          response,
          async () => {
            // 默认允许快进（与命令行一致）。`noFf` 时强制产生一个合并提交，
            // 这是团队里常见的"保留合并点"偏好。
            const args = ['merge', '--no-edit', ...(payload?.noFf === true ? ['--no-ff'] : []), '--', source]
            await git(args, workspace)
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
          workspace,
          response,
          async () => {
            await git(['rebase', onto], workspace)
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
          workspace,
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
              const cherry = await git(['cherry', 'HEAD', revision, `${revision}^`], workspace)
              if (/^-\s/u.test(cherry)) return { cherryPicked: revision, empty: true }
            } catch {
              // `cherry` 在首提交（无父）等边界上会失败——那不影响摘取本身，继续走正常路径。
            }

            try {
              await git(['cherry-pick', revision], workspace)
            } catch (error) {
              const message = String(error?.message ?? error)
              // 空摘取同样是"结果已存在"，不是失败。此时 git 可能已经把 HEAD 留在
              // 一个空提交的中间状态，必须 `--abort` 回到干净状态再回话——否则用户
              // 会卡在一个自己不认识的状态里。
              if (/cherry-pick is now empty|nothing to commit|The previous cherry-pick/iu.test(message)) {
                await git(['cherry-pick', '--abort'], workspace).catch(() => undefined)
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

        const network = { timeoutMs: GIT_NETWORK_TIMEOUT_MS }
        if (action === 'fetch') {
          await runWrite(
            workspace,
            response,
            async () => {
              // `--prune`：远端已删的分支在本地也清掉，否则"最近"分组里会一直挂着
              // 早已不存在的分支。不加 `--tags`（那会拉全部标签，慢且吵）。
              await git(['fetch', '--prune', ...(remote === undefined ? [] : [remote])], workspace, network)
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
            workspace,
            response,
            async () => {
              // 不加 --rebase/--no-rebase：用户的 pull.rebase 配置由 git 自己决定，
              // 我们不该在插件里替他选一种历史形状。
              await git(['pull', '--no-edit', ...(remote === undefined ? [] : [remote]), ...(branch === undefined ? [] : [branch])], workspace, network)
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
          await runWrite(
            workspace,
            response,
            async () => {
              const args = ['push']
              // 只有明确要求时才 `--set-upstream`：它会改变本地的跟踪配置。
              if (setUpstream) args.push('--set-upstream')
              if (remote !== undefined) args.push(remote)
              if (branch !== undefined) args.push(`${branch}:${branch}`)
              // **不提供 --force 的任何形式**：强推会重写远端历史，从 UI 一键可达太危险。
              // 需要它的人在终端里做。
              await git(args, workspace, network)
              return {}
            },
            (error) => {
              const message = String(error?.message ?? error)
              if (/rejected|non-fast-forward|fetch first|behind/iu.test(message)) {
                return { status: 409, code: 'pushRejected' }
              }
              if (/could not read|Could not resolve|unable to access|Authentication failed|Permission denied/iu.test(message)) {
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

      // 中止进行中的合并/变基/摘取。表单 `{ kind }`。
      if (path === `${ROUTE_PREFIX}/op/abort`) {
        const kind = payload?.kind
        const args =
          kind === 'merge'
            ? ['merge', '--abort']
            : kind === 'rebase'
              ? ['rebase', '--abort']
              : kind === 'cherry-pick'
                ? ['cherry-pick', '--abort']
                : undefined
        if (args === undefined) {
          sendJson(response, 400, { error: 'unknown operation', code: 'unknown' })
          return
        }
        await runWrite(workspace, response, async () => {
          await git(args, workspace)
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
    `${ROUTE_PREFIX}/branch/create`,
    `${ROUTE_PREFIX}/branch/rename`,
    `${ROUTE_PREFIX}/branch/delete`,
    `${ROUTE_PREFIX}/branch/merge`,
    `${ROUTE_PREFIX}/branch/rebase`,
    `${ROUTE_PREFIX}/cherry-pick`,
    `${ROUTE_PREFIX}/remote`,
    `${ROUTE_PREFIX}/op/abort`,
  ]
  for (const path of routes) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }), `gitbar: ${path}`)
  }
}
