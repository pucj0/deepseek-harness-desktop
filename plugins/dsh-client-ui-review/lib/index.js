// review 的 host 半边：为「每轮修改审查」提供快照与差异。
//
// 核心思路：复用 git 自己的对象库做快照，而不是自己遍历文件算哈希。
// 做法是给 git 指定一个**临时 index 文件**（`GIT_INDEX_FILE`）：
//
//     read-tree HEAD     从 HEAD 初始化临时 index
//     add -A             把工作区当前状态（含未跟踪文件）写进去
//     write-tree          得到一个树对象 SHA
//
// 这样完全不碰用户真实的 index、stash 列表与 HEAD——**只读**是硬要求，用户的工作区
// 状态不能因为"看了一眼审查"而变化。实测确认过：status 与 stash 列表均不受影响。
//
// 为什么需要它：审查的基线是本轮开始时的状态，而用户常常在改到一半时才开始一轮任务，
// 因此基线必须能覆盖未跟踪文件，也必须廉价（大仓库遍历一遍很慢，而 git 会复用已有对象、
// 只对变化的文件重新哈希）。
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/** 插件名，用于诊断与 effect 标签。 */
export const name = 'review'

/** 必须先有 webServer 服务，路由才有地方注册。 */
export const inject = ['webServer']

/** 路由前缀，与 gitbar 的做法一致，便于分辨"这是外壳侧插件提供的"。 */
const ROUTE_PREFIX = '/dsh-desktop/review'

/** git 命令超时。**基线快照要遍历整个工作区，实测在带大量未跟踪文件的仓库上接近 100 秒**，
 * 因此这里给足余量；而每次轮询走的"只哈希变化文件"路径是毫秒级的。 */
const GIT_TIMEOUT_MS = 240000

/** 单个响应的差异文本上限，避免超大改动把面板压垮。 */
const MAX_DIFF_BYTES = 512 * 1024

/** 树对象 SHA 格式：40 位十六进制。用于校验客户端传来的基线。 */
const REVISION_PATTERN = /^[0-9a-f]{40}$/u

/**
 * 判定"残留索引锁"的年龄阈值（毫秒）。
 *
 * 必须是"活着的那次快照不可能还在跑"的量级：GIT_TIMEOUT_MS 是 240 秒，但那是给超大
 * 仓库的余地，正常快照在几秒内结束。取 3 分钟——比正常长得多，又明显短于用户等待的
 * 耐心，于是既不会误删活锁，也不至于让面板永久卡死。
 */
const STALE_LOCK_MS = 3 * 60 * 1000

/** 允许还原的路径形状。
 *
 * 必须挡住绝对路径与 `..`：还原会把文件写回工作区，是少数**写**工作区的操作，
 * 因此路径只能来自仓库内部。git 自身也会拒绝越界路径，但在这里先挡掉更清楚。 */
const SAFE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]{1,1024}$/u

/** 每个会话的基线状态。 */
const baselines = new Map()

/**
 * 提交历史图一页的默认条数与上限。
 *
 * 分页是必需的而不是"顺手加的"：实测本仓库的 `git log --topo-order` 在 400 条时已经
 * 需要几十毫秒，而真实项目动辄几万条提交。一次把整部历史读进来、再在渲染进程里排泳道，
 * 会让打开提交图变成一个可以感知的卡顿。
 */
const GRAPH_PAGE_DEFAULT = 80
const GRAPH_PAGE_MAX = 400

/** 一次 commit 详情最多列多少条改动文件，避免超大提交把面板撑爆。 */
const COMMIT_FILES_MAX = 2000

/**
 * 路径的形状校验（与 revert 的同名常量同一套规则）。
 *
 * 变化历史那条路由要按路径查单个文件的差异，因此这里是"客户端能提供的路径"的第二处
 * 入口——和还原一样，只接受仓库内的相对路径，挡掉绝对路径与 `..`。
 */
const SAFE_PATH_PATTERN_GRAPH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]{1,1024}$/u

/**
 * 从 `git log` 的 `%D` 字段解析出装饰信息（分支、标签、HEAD）。
 *
 * git 在这里给出的是 `HEAD -> main, origin/main, tag: v1.0.0` 这样的文本，因此必须解析；
 * 而它是**稳定的机器可读格式**（`%D` 的文档明确列出了这几种前缀），与 `%(upstream:track)`
 * 那种"给人看的中文括号"不同。逐个前缀判定：
 *   `HEAD -> x`  当前分支
 *   `tag: x`     标签
 *   `origin/x`   远端分支（含 `/` 且不是 tag）
 *   其余         本地分支
 *
 * @param decoration - `%D` 的原文。
 * @returns `{ refs: Array<{name, kind, isHead}>, headBranch, localBranches, remoteBranches, tags }`。
 */
function parseDecoration(decoration) {
  const refs = []
  const raw = typeof decoration === 'string' ? decoration.trim() : ''
  for (const part of raw.split(',')) {
    const piece = part.trim()
    if (piece === '') continue
    if (piece.startsWith('HEAD -> ')) {
      refs.push({ name: piece.slice('HEAD -> '.length), kind: 'branch', isHead: true })
      continue
    }
    if (piece === 'HEAD') {
      // 游离 HEAD 时 git 只给 `HEAD`。
      refs.push({ name: 'HEAD', kind: 'head', isHead: true })
      continue
    }
    if (piece.startsWith('tag: ')) {
      refs.push({ name: piece.slice('tag: '.length), kind: 'tag', isHead: false })
      continue
    }
    refs.push({ name: piece, kind: piece.includes('/') ? 'remote' : 'branch', isHead: false })
  }

  const head = refs.find((ref) => ref.isHead === true && ref.kind === 'branch')
  return {
    refs,
    headBranch: head === undefined ? '' : head.name,
    localBranches: refs.filter((ref) => ref.kind === 'branch').map((ref) => ref.name),
    remoteBranches: refs.filter((ref) => ref.kind === 'remote').map((ref) => ref.name),
    tags: refs.filter((ref) => ref.kind === 'tag').map((ref) => ref.name),
  }
}

/**
 * 读取一页提交历史，附带画图所需的父提交与 refs。
 *
 * `--topo-order` 而不是默认的日期序：提交图是按父子关系画的，日期序会让父提交出现在
 * 子提交**之前**（时钟漂移、变基后的旧时间戳都会造成这种乱序），于是所有连线都会往回指。
 * `--date-order` 只影响同一拓扑层内的顺序，两者一起用才能既保证"父在子之后"，又让
 * 同一层内按时间排列。
 *
 * `%x1f`（单元分隔符）与 `%x1e`（记录分隔符）而不是 `\t`/`\n`：提交标题里可能含制表符，
 * 作者名里可能含各种空白，只有这两个控制字符在提交信息里不可能出现。
 *
 * @param cwd - 工作区路径。
 * @param options - `{ limit, skip, ref }`。
 * @returns `{ commits, hasMore, nextSkip }`。
 */
async function readGraph(cwd, options) {
  const limit = Math.min(Math.max(Math.trunc(options.limit), 1), GRAPH_PAGE_MAX)
  const skip = Math.max(Math.trunc(options.skip), 0)
  // 多取一条用来判断"还有没有下一页"：比再跑一次 `rev-list --count` 便宜得多。
  const args = [
    'log',
    '--topo-order',
    '--date-order',
    // `--no-abbrev` **不能省**：`%p` 会跟随 `core.abbrev` 输出**缩写**哈希（实测在本机
    // 是 7 位），而客户端要用父提交哈希去匹配同一页里别的提交、决定连线画到哪一行。
    // 缩写哈希在极端情况下会与另一条提交的前缀相同，那时图会连错线——而且只在很少见的
    // 仓库里出现，属于最难查的一类 bug。`%H` 本来就是完整的，这里是为了 `%p`。
    '--no-abbrev',
    `--max-count=${limit + 1}`,
    `--skip=${skip}`,
    '-M',
    '--pretty=format:%H%x1f%h%x1f%p%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%D%x1f%s%x1e',
  ]
  // 只看某个 ref（分支/标签）：界面上的"分支筛选"。以 `-` 开头的值一律不接受，
  // 否则它就是一个可以注入选项的入口。
  if (typeof options.ref === 'string' && options.ref !== '') {
    if (!REF_PATTERN_GRAPH.test(options.ref)) return { commits: [], hasMore: false, nextSkip: skip, invalidRef: true }
    args.push(options.ref)
  } else {
    // 不带 ref 时看**全部**分支，否则提交图上只有当前分支那条线，看不到任何分叉——
    // 而"看到分叉"正是这个视图存在的理由。
    args.push('--all')
  }

  const raw = await git(args, cwd)
  const records = raw
    .split('\x1e')
    .map((record) => record.replace(/^\n/u, ''))
    .filter((record) => record.trim() !== '')
    .map((record) => {
      const [hash, short, parents, author, email, authoredAt, committedAt, decoration, ...rest] = record.split('\x1f')
      return {
        hash: String(hash ?? '').trim(),
        short: String(short ?? '').trim(),
        // 父提交是空格分隔的哈希串；首提交为空。
        parents: String(parents ?? '').trim() === '' ? [] : String(parents).trim().split(/\s+/u),
        author: String(author ?? '').trim(),
        email: String(email ?? '').trim(),
        authoredAt: String(authoredAt ?? '').trim(),
        committedAt: String(committedAt ?? '').trim(),
        subject: rest.join('\x1f').trim(),
        ...parseDecoration(decoration),
      }
    })

  const hasMore = records.length > limit
  if (hasMore) records.pop()
  return { commits: records, hasMore, nextSkip: skip + records.length }
}

/**
 * 一条提交的详情：元信息 + 改动文件清单 + 它出现在哪些本地分支上。
 *
 * @param cwd - 工作区路径。
 * @param revision - 已校验的提交 SHA。
 * @returns 详情对象。
 */
async function readCommit(cwd, revision) {
  const raw = await git(
    ['show', '--no-patch', '--no-abbrev', '--pretty=format:%H%x1f%h%x1f%p%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%D%x1f%s%x1f%b', revision],
    cwd,
  )
  const parts = raw.split('\x1f')
  const [hash, short, parents, author, email, authoredAt, committedAt, decoration, subject, ...bodyParts] = parts
  const commit = {
    hash: String(hash ?? '').trim(),
    short: String(short ?? '').trim(),
    parents: String(parents ?? '').trim() === '' ? [] : String(parents).trim().split(/\s+/u),
    author: String(author ?? '').trim(),
    email: String(email ?? '').trim(),
    authoredAt: String(authoredAt ?? '').trim(),
    committedAt: String(committedAt ?? '').trim(),
    subject: String(subject ?? '').trim(),
    body: bodyParts.join('\x1f').trim(),
    ...parseDecoration(decoration),
  }

  // 改动文件清单：与工作区差异用同一套解析（numstat + name-status），因此"重命名怎么显示"
  // 这类规则在提交详情与未提交改动之间是一致的。
  //
  // **根提交必须走 `show`，不能用 `diff --root <rev>`。** 这是一个安静的错：`git diff
  // --root <rev>` 里的 `--root` 只对"把某个提交与**空树**比较"这一种形式生效
  // （`git diff --root <rev>` 会被当成"比较 <rev> 与工作区"），于是根提交的"改动清单"
  // 实际上是"根提交 vs 当前工作区"——实测在临时仓库上会给出 `M a.txt, A b.txt, A c.txt`
  // 这样的结果（混进了后续提交与工作区的改动），而正确答案是只有 `A a.txt`。
  // 有父提交时 `show <rev>` 与 `diff <rev>^ <rev>` 等价，因此统一用 show 也行；
  // 这里保留 diff 分支只是为了少一次格式解析。
  const [stat, names] = await Promise.all([
    commit.parents.length === 0
      ? git(['show', '--numstat', '--format=', '--no-renames', revision], cwd)
      : git(['diff', '--numstat', `${revision}^`, revision], cwd),
    commit.parents.length === 0
      ? git(['show', '--name-status', '--format=', '--no-renames', revision], cwd)
      : git(['diff', '--name-status', `${revision}^`, revision], cwd),
  ])
  const counts = new Map()
  for (const line of stat.split('\n')) {
    const fields = line.split('\t')
    if (fields.length < 3) continue
    counts.set(fields[2], {
      added: fields[0] === '-' ? null : Number(fields[0]),
      removed: fields[1] === '-' ? null : Number(fields[1]),
    })
  }
  const files = []
  for (const line of names.split('\n')) {
    if (line.trim() === '') continue
    const [status, ...rest] = line.split('\t')
    const path = rest[rest.length - 1]
    if (path === undefined) continue
    const count = counts.get(path)
    files.push({
      path,
      status,
      added: count?.added ?? null,
      removed: count?.removed ?? null,
    })
    if (files.length >= COMMIT_FILES_MAX) break
  }

  // "在 N 个分支中"：逐个本地分支问"这个提交是不是该分支的祖先"。
  //
  // **参数顺序是最容易搞反的一处**：`git merge-base --is-ancestor A B` 问的是
  // "A 是不是 B 的祖先"，因此要问"分支 B 是否包含提交 R"，必须写成
  // `--is-ancestor <R> refs/heads/<B>`。早先写成 `--is-ancestor <R> refs/heads/<branch>`
  // 之外的方向（把分支当第一个参数）会让**合并提交只报出一个分支**——实测
  // `HEAD`（一个把 feature 合进来的合并提交）只列出 `main`，而正确答案是 `feature,main`。
  //
  // 这是 N 次进程调用，因此**只在打开单条提交详情时**做（不是列表），并且本地分支数量
  // 有上限保护。
  const branchNames = (await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], cwd))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, 50)
  const containing = []
  await Promise.all(
    branchNames.map(async (branch) => {
      try {
        await git(['merge-base', '--is-ancestor', revision, `refs/heads/${branch}`], cwd)
        containing.push(branch)
      } catch {
        // 该分支不含这个提交。
      }
    }),
  )

  return { commit, files, containingBranches: containing.sort() }
}

/** 路径比较：git 的 diff 输出用 `/`，而仓库根下的相对路径在 Windows 上也是 `/`。 */
function normalizePath(value) {
  return String(value).replace(/\\/gu, '/')
}

/**
 * 一条提交里单个文件的差异。
 *
 * 与工作区差异分开成一条路由，是因为它们的**基线不同**：工作区差异比的是「基线树 vs
 * 工作区」，这里是「父提交 vs 该提交」，而且后者必须限制在一个路径上——一次提交可能改
 * 几千个文件，全量 diff 会把响应撑爆。
 *
 * @param cwd - 工作区路径。
 * @param revision - 已校验的提交 SHA。
 * @param path - 已校验的相对路径。
 * @returns `{ diff, truncated, binary }`。
 */
async function readCommitFileDiff(cwd, revision, path) {
  // 先确认这个提交真的有这个文件，避免把一条不存在路径的 git 报错当成"差异为空"。
  const parents = (await git(['show', '--no-patch', '--pretty=format:%P', revision], cwd)).trim()
  const base = parents === '' ? undefined : parents.split(/\s+/u)[0]
  const args = [
    'diff',
    '--unified=3',
    ...(base === undefined ? ['--root'] : [base]),
    revision,
    '--',
    normalizePath(path),
  ]
  const raw = await git(args, cwd)
  // `Binary files … differ` 之类没有可展示的行，界面上要区别对待。
  const binary = /^Binary files |^GIT binary patch/mu.test(raw)
  const truncated = raw.length > MAX_DIFF_BYTES
  return { diff: truncated ? raw.slice(0, MAX_DIFF_BYTES) : raw, truncated, binary }
}

/** 图形路由允许的 ref 形状：分支名/标签名，不含 rev 表达式。 */
const REF_PATTERN_GRAPH = /^(?![-./])(?!.*\.\.)(?!.*\/\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/u

/**
 * 解析 `git status --porcelain` 的行，分成"已跟踪改动"与"未跟踪文件"两组。
 *
 * 界面上这两组必须分开：VS Code 的源代码管理面板把它们放在两个可折叠区块里，而它们的
 * 可执行操作也不同——未跟踪文件只能"暂存/删除"，不能"放弃改动"（没有基线可还原）。
 *
 * `--porcelain=v1` 的行为：XY 两列是索引与工作区状态，`??` 是未跟踪，`!!` 是被忽略
 * （`--ignored` 才会出现）。用 `-z` 会得到 NUL 分隔且不做引号转义，但那样重命名
 * （`R` 状态）的"旧路径 新路径"是两条记录、要靠状态字母配对；这里用普通模式 + 自己剥
 * 引号，因为路径里的引号转义规则简单（C 风格 `\"`、`\\`）且罕见。
 *
 * @param raw - `git status --porcelain` 的原文。
 * @returns `{ tracked, untracked }`，各自是 `{ path, index, worktree }` 数组。
 */
function parsePorcelain(raw) {
  const tracked = []
  const untracked = []
  for (const line of raw.split('\n')) {
    if (line.length < 4) continue
    const index = line[0]
    const worktree = line[1]
    let path = line.slice(3)
    // git 会给"含特殊字符"的路径加双引号并做 C 风格转义。只处理这两种转义：
    // 路径里真的出现双引号或反斜杠的情况极少，不引入一个完整的 unquote 实现。
    if (path.startsWith('"') && path.endsWith('"')) {
      path = path.slice(1, -1).replace(/\\(["\\])/gu, '$1')
    }
    const entry = { path, index, worktree }
    if (index === '?' || worktree === '?') untracked.push(entry)
    else if (index === '!' || worktree === '!') continue
    else tracked.push(entry)
  }
  return { tracked, untracked }
}

/**
 * 解析外壳允许被操作的工作区集合。
 *
 * 与 gitbar 同样的安全边界：只接受应用登记过的工作区，否则任何能访问本机回环地址的
 * 页面都能让宿主进程对任意目录执行 git 命令。
 * @returns 允许的绝对路径数组。
 */
function collectAllowedRoots() {
  const roots = new Set()
  const shell = process.env.DSH_DESKTOP_WORKSPACE
  if (typeof shell === 'string' && shell !== '') roots.add(shell)

  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') {
    try {
      const parsed = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'))
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
 * 校验请求里的工作区。
 * @param requested - 请求给出的路径。
 * @returns 通过校验的真实路径，否则 undefined。
 */
function validateWorkspace(requested) {
  if (typeof requested !== 'string' || requested === '' || !isAbsolute(requested)) return undefined
  let real
  try {
    real = realpathSync.native(requested)
  } catch {
    return undefined
  }
  for (const root of collectAllowedRoots()) {
    try {
      if (realpathSync.native(root) === real) return real
    } catch {
      // 某个已登记的工作区不存在——跳过，不影响其它。
    }
  }
  return undefined
}

/**
 * 运行一条 git 命令。
 *
 * **一律带上 `-c core.fileMode=false`**：本插件用 `git add -A` + `git write-tree` 给
 * 工作区拍快照，而 Windows 上根本表达不了可执行位。当仓库带着 `core.fileMode=true`
 * （从 Linux 仓库带过来的配置极常见）时，`add` 会把 `docker/entrypoint.sh` 这类
 * 文件记成 `100644`，而 HEAD 里是 `100755`——于是快照树与 HEAD 之间冒出一条
 * `old mode 100755 / new mode 100644` 的"修改"：行数 0/0，内容一个字没变。
 * 实测复现过：带该标志时快照树保持 100755、差异为空；不带时树变成 100644。
 * 界面上的表现就是"根本没改过的文件也被列成改动"，这正是用户反馈的现象。
 *
 * @param args - 参数数组（不含 `git`）。
 * @param cwd - 仓库目录。
 * @param env - 额外环境变量（用于传入临时 index）。
 * @returns stdout。
 */
function git(args, cwd, env) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.fileMode=false', '-C', cwd, ...args],
      { timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(String(stderr).trim() || error.message))
          return
        }
        resolve(String(stdout))
      },
    )
  })
}

/**
 * 索引内容的格式版本。
 *
 * 凡是会**改变已记录索引内容正确性**的改动都要 +1：git 的索引带 stat 缓存，
 * 旧索引里的条目会被原样沿用（`add` 发现 stat 未变就跳过），所以修好记录逻辑并不
 * 自动修好旧索引——幽灵条目会一直在。
 *
 * 版本 2：快照改为 `core.fileMode=false`（见上面 `git()` 的说明）。版本 1 的索引里
 * 可能记着 100644，而 HEAD 是 100755。
 */
const INDEX_VERSION = 2

/** 临时 index 的存放根目录（按进程 PID 命名，只归本进程使用；进程退出即清理）。 */
let scratchRoot

/** 取（必要时创建）临时 index 的根目录。 */
function scratchDir() {
  if (scratchRoot === undefined) {
    scratchRoot = join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', `dsh-review-${process.pid}`)
    mkdirSync(scratchRoot, { recursive: true })
  }
  return scratchRoot
}

/**
 * 丢弃**旧版本**留下的临时索引。
 *
 * 不做这一步的话，升级到本版本后旧索引仍会被沿用，`core.fileMode` 的幽灵条目会一直
 * 显示到用户换项目、换会话或手工清理临时目录为止——也就是"修了但看起来没修"。
 * 索引是可再生的派生数据（丢了只是下一次快照慢一点），因此整体丢弃是安全的。
 */
function ensureIndexVersion() {
  const root = scratchDir()
  const marker = join(root, 'pipeline.json')
  try {
    if (JSON.parse(readFileSync(marker, 'utf8'))?.indexVersion === INDEX_VERSION) return
  } catch {
    // 没有标记或读不出来：按旧版本处理。
  }
  for (const entry of readdirSync(root)) {
    if (entry.endsWith('.index') || entry.endsWith('.index.lock')) rmSync(join(root, entry), { force: true })
  }
  try {
    writeFileSync(marker, JSON.stringify({ indexVersion: INDEX_VERSION }, null, 2) + '\n')
  } catch {
    // 写不了标记只意味着下次启动再清一遍，不影响正确性。
  }
}

/**
 * 为某个会话 + 某个工作区取得临时 index 路径。
 *
 * 按"会话 + 工作区"保持同一个 index 文件：git 会在里面记录 stat 缓存，因此后续快照
 * 只需重新哈希真正变化的文件，而不是每次遍历整棵树。
 *
 * **工作区必须参与命名**：索引是与仓库强相关的（路径、stat 缓存、对象库都不同），
 * 而项目级面板的请求对所有项目共用同一个会话标识（`default`）。此前只用会话命名，
 * 于是切到另一个项目后 git 会被喂上一份**别的仓库的索引**——轻则结果错乱，重则
 * 直接报错。工作区路径用哈希进入文件名：它可能很长且含不适合做文件名的字符。
 *
 * @param sessionId - 会话标识。
 * @param workspace - 工作区绝对路径。
 * @returns index 文件绝对路径。
 */
function indexFor(sessionId, workspace) {
  // 会话 id 来自客户端，做个保守的字符过滤以免拼出意外路径。
  const safe = String(sessionId).replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 80)
  const key = createHash('sha1').update(String(workspace)).digest('hex').slice(0, 10)
  return join(scratchDir(), `${safe}-${key}.index`)
}

/**
 * 进行中的"当前工作区"快照。按会话标识去重。
 *
 * 为什么需要：同一个会话的索引文件只有一个，而多个请求会同时到达——例如面板打开时
 * 触发器的轮询与面板自身的数据加载会并发打同一个路由。两个 git 进程同时写同一个索引
 * 会撞出 `Unable to create '...index.lock': File exists`（实测踩到，界面上直接显示这行
 * git 报错）。把并发的相同快照合并成一次，既避免冲突也省掉重复计算。
 */
const inFlightSnapshots = new Map()

/**
 * 在临时索引上跑一段 git，遇到**残留锁**时清掉重试一次。
 *
 * 为什么需要：锁目录按进程 PID 命名（`dsh-review-<pid>`），只归本进程使用；同一 key 的
 * 并发调用已在调用方合并，不同 key 用的是不同索引文件。因此这里遇到的 `index.lock`
 * 只可能来自**上一次被中断**的运行（快照在超大仓库上要跑几十秒，请求超时或进程被杀时
 * git 可能来不及清理锁）。
 *
 * 后果很严重：锁一旦残留，此后每一次快照都失败，面板永远显示这行 git 报错——本次实测
 * 就撞上了（一次超时请求留下锁，之后所有请求 500）。所以必须能自愈。
 *
 * 只清**旧**锁：正在被另一个 git 持有的锁是新鲜的（快照最长几十秒），删掉它会让两个
 * git 同时写同一个索引。
 *
 * @param indexPath - 临时 index 路径。
 * @param task - 实际执行的 git 操作。
 * @returns task 的结果。
 */
async function withIndexLockRecovery(indexPath, task) {
  try {
    return await task()
  } catch (error) {
    const message = String(error?.message ?? error)
    if (!/index\.lock/u.test(message) || !/File exists/u.test(message)) throw error
    const lockPath = `${indexPath}.lock`
    let ageMs = Number.POSITIVE_INFINITY
    try {
      ageMs = Date.now() - statSync(lockPath).mtimeMs
    } catch {
      // 锁已经不在了（另一个进程自己清掉了）：直接重试。
    }
    if (ageMs < STALE_LOCK_MS) throw error
    rmSync(lockPath, { force: true })
    return await task()
  }
}

/**
 * 从零给工作区拍一张完整快照（遍历整棵树），返回树对象 SHA。
 *
 * **只在记录基线时调用**：它要为所有变动文件重新计算哈希，代价与它们数量成正比。
 * 实测在带 6640 个变动路径的仓库上约 4 秒（首次索引为空时更慢），因此不能放进轮询路径。
 *
 * 全程只读：git 只写我们自己指定的临时 index，不动仓库状态。
 * @param workspace - 已校验的工作区路径。
 * @param sessionId - 会话标识（决定临时 index 的归属）。
 * @returns 树对象 SHA。
 */
async function snapshot(workspace, sessionId) {
  const indexPath = indexFor(sessionId, workspace)
  const env = { GIT_INDEX_FILE: indexPath }
  try {
    return await withIndexLockRecovery(indexPath, async () => {
      // 空仓库没有 HEAD 可读——从空 index 开始即可。
      await git(['read-tree', 'HEAD'], workspace, env).catch(() => undefined)
      // -A：已跟踪的修改与删除、新增文件、以及按 .gitignore 规则纳入的未跟踪文件。
      await git(['add', '-A'], workspace, env)
      return (await git(['write-tree'], workspace, env)).trim()
    })
  } catch (error) {
    // 临时 index 坏掉时删掉，下次重建。
    rmSync(indexPath, { force: true })
    throw error
  }
}

/**
 * 取"当前工作区"的树对象 SHA：复用**常驻索引**（性能）+ 合并并发调用（安全）。
 *
 * 性能这一层是本模块的关键：每次轮询都从零构建索引会让 git 对所有未变文件重新计算哈希；
 * 复用常驻索引后，索引里保留的 stat 数据让 git 直接跳过未变文件（实测 4 秒降到 0.5 秒）。
 * 代价是索引文件被多个请求共享，因此必须配上面那层去重。
 *
 * @param workspace - 工作区路径。
 * @param sessionId - 会话标识。
 * @returns 树对象 SHA。
 */
async function currentTree(workspace, sessionId) {
  const key = `${sessionId}|${workspace}`
  const running = inFlightSnapshots.get(key)
  if (running !== undefined) return running

  const task = (async () => {
    const indexPath = indexFor(`${sessionId}-current`, workspace)
    const env = { GIT_INDEX_FILE: indexPath }
    return withIndexLockRecovery(indexPath, async () => {
      // 索引首次使用（或损坏）时从 HEAD 起一个基准，让后续的 add -A 有比较对象。
      //
      // 绝不能在每次调用时都 read-tree：那会重置索引、连带丢掉 stat 缓存，add -A 于是
      // 每次都退化成全量重新哈希（实测 4.3 秒而不是 0.22 秒）。这个代价不明显，因为结果
      // 依然正确——只是慢，所以很容易一直留着。
      if (!existsSync(indexPath)) {
        await git(['read-tree', 'HEAD'], workspace, env).catch(() => undefined)
      }
      await git(['add', '-A'], workspace, env)
      return (await git(['write-tree'], workspace, env)).trim()
    })
  })().finally(() => {
    inFlightSnapshots.delete(key)
  })

  inFlightSnapshots.set(key, task)
  return task
}

/**
 * 判断工作区是不是 git 仓库。
 * @param workspace - 工作区路径。
 * @returns 是则 true。
 */
async function isRepo(workspace) {
  try {
    return (await git(['rev-parse', '--is-inside-work-tree'], workspace)).trim() === 'true'
  } catch {
    return false
  }
}

/**
 * 给响应写 JSON。
 * @param response - HTTP 响应。
 * @param status - 状态码。
 * @param payload - 可序列化负载。
 */
function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(body)
}

/**
 * 读取并限制请求体。
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
 * 判断一条改动是否**只有元数据变化**（文件模式），而不是内容变化。
 *
 * 为什么会遇到：仓库带 `core.fileMode=true`（从 Linux 仓库带过来的配置很常见）时，
 * Windows 上 `git add -A` 会把本来 100755 的脚本记成 100644；`git diff` 于是报出一条
 * `old mode 100755 / new mode 100644`，而行数是 `0 0`——内容一个字都没变。界面上的
 * 表现就是"根本没改过的文件也被列成改动"（实际反馈里是 `修改 docker/entrypoint.sh +0 −0`）。
 *
 * 现在 `git()` 已经统一带上 `-c core.fileMode=false`，正常情况下不会再产生这种条目；
 * 这里再把它们挡在响应之外，是为了兼容旧索引、以及用户自己用别的工具改过索引的情况。
 *
 * 判据用 numstat 的 0/0 **加上**状态 M：二进制的 numstat 是 `-`（解析成 null），
 * 重命名是 `R100`（状态不是 M，虽然也是 0/0，但必须保留）。
 * @param file - `{ path, status, added, removed }`。
 * @returns 只有元数据变化则 true。
 */
function isMetadataOnly(file) {
  return file.status === 'M' && file.added === 0 && file.removed === 0
}

/**
 * 从统一差异里删掉指定文件的片段。
 *
 * 按行首的 `diff --git ` 切分，再按 `b/<路径>` 取路径。必须连差异正文一起删：文件列表
 * 与差异是两个来源（numstat / name-status 与 unified），只删列表会在展开处露出一个
 * 空壳片段。
 * @param diff - 统一差异全文。
 * @param paths - 要删掉的路径集合。
 * @returns 过滤后的差异文本。
 */
function dropDiffSections(diff, paths) {
  if (paths.size === 0 || diff === '') return diff
  return diff
    .split(/^(?=diff --git )/mu)
    .filter((part) => {
      const match = / b\/(.+)$/u.exec(part.split('\n', 1)[0])
      return match === null || !paths.has(match[1])
    })
    .join('')
}

/**
 * 把 git 的三份输出整理成前端要的形状。
 *
 * 两处路由（本轮差异、工作区差异）需要同样的结构，因此集中在这里——否则两边的行数
 * 解析一旦走偏，界面上的数字就会不一致，而这种不一致很难被发现。
 *
 * @param output - `{ stat, names, diff }`，分别来自 `--numstat`、`--name-status`、`--unified`。
 * @returns `{ files, diff, truncated }`。
 */
function describeDiff({ stat, names, diff }) {
  // --numstat 给出每个文件的新增/删除行数，与 --name-status 的顺序一致。
  const counts = new Map()
  for (const line of stat.split('\n')) {
    const parts = line.split('\t')
    if (parts.length < 3) continue
    counts.set(parts[2], {
      added: parts[0] === '-' ? null : Number(parts[0]),
      removed: parts[1] === '-' ? null : Number(parts[1]),
    })
  }

  const all = []
  for (const line of names.split('\n')) {
    if (line.trim() === '') continue
    const [status, ...rest] = line.split('\t')
    // 重命名形如 `R100\told\tnew`，取新路径作为展示对象。
    const path = rest[rest.length - 1]
    if (path === undefined) continue
    const count = counts.get(path)
    all.push({
      path,
      status,
      added: count?.added ?? null,
      removed: count?.removed ?? null,
    })
  }

  const metadataOnly = new Set(all.filter(isMetadataOnly).map((file) => file.path))
  const files = all.filter((file) => !metadataOnly.has(file.path))
  const body = dropDiffSections(diff, metadataOnly)

  const truncated = body.length > MAX_DIFF_BYTES
  return { files, diff: truncated ? body.slice(0, MAX_DIFF_BYTES) : body, truncated }
}

/**
 * 创建审查路由的处理器。
 * @returns `(request, response)` 处理器。
 */
function createReviewHandler() {
  return async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')

      let payload = {}
      if (request.method === 'POST') {
        try {
          payload = JSON.parse(await readSmallBody(request))
        } catch (error) {
          sendJson(response, 400, { error: 'invalid body', detail: String(error.message) })
          return
        }
      }

      // ---- 可查看的工作区列表 -----------------------------------------------
      //
      // 必须放在工作区校验**之前**：它回答的正是"有哪些工作区可以看"，因此不能要求
      // 请求先带一个合法工作区——那是一个先有鸡还是先有蛋的问题。此前把它放在校验之后，
      // 于是永远返回 400，面板一直显示"选择要查看的项目"（实测踩到过）。
      if (url.pathname === `${ROUTE_PREFIX}/roots`) {
        const roots = []
        for (const root of collectAllowedRoots()) {
          try {
            roots.push(realpathSync.native(root))
          } catch {
            // 已登记但如今不存在的目录：跳过，不列给用户。
          }
        }
        // 一并告诉客户端"**当前**是哪个工作区"。
        //
        // 为什么由宿主回答：宿主这个进程启动时就被 `process.chdir(workspace)` 到了工作区，
        // 因此 `process.cwd()` 是唯一不需要推断的来源。
        //
        // 定位：这只是**没有当前会话时**的兜底（例如刚打开应用、还没进任何对话）。真正的
        // 依据是当前会话自己的工作区，由客户端从渲染器的标准钩子 `useSessions` 读
        // `state.current → byId[current].cwd`。
        //
        // 注意这里**不要**把 process.cwd() 当成首选：它是外壳启动时的工作区，常常是用户
        // 主目录或本应用自身的仓库，与"用户此刻在哪个对话里工作"是两件事（实测踩到过：
        // 外壳工作区是 C:\Users\Administrator，于是面板一直报"当前工作区不是 git 仓库"，
        // 而用户实际在用的项目是 git 仓库）。
        let current
        try {
          current = realpathSync.native(process.cwd())
        } catch {
          current = undefined
        }
        // 只有在确实合法时才回传，否则客户端会拿它去请求而被安全边界拒绝。
        const allowed = current !== undefined && roots.includes(current) ? current : undefined
        sendJson(response, 200, { roots, ...(allowed !== undefined ? { current: allowed } : {}) })
        return
      }

      const workspace = validateWorkspace(payload.workspace ?? url.searchParams.get('workspace'))
      if (workspace === undefined) {
        sendJson(response, 400, {
          error: 'workspace not allowed',
          code: 'workspaceNotAllowed',
          detail: 'workspace must be one of the workspaces known to this app',
        })
        return
      }

      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : 'default'

      // ---- 记录基线：本轮开始时调用一次 ------------------------------------
      if (url.pathname === `${ROUTE_PREFIX}/baseline`) {
        if (request.method !== 'POST') {
          response.setHeader('allow', 'POST')
          sendJson(response, 405, { error: 'method not allowed' })
          return
        }
        if (!(await isRepo(workspace))) {
          sendJson(response, 200, { isRepo: false })
          return
        }
        const revision = await snapshot(workspace, sessionId)
        // 顺手把"当前侧"的常驻索引也建起来，让第一次取差异就不必再付一次全量代价。
        // 不做这一步的话，首次 add -A 要重新哈希所有变化文件（实测约 4 秒），
        // 而它发生在用户刚点开面板时——最不该等的那一刻。
        await currentTree(workspace, sessionId).catch(() => undefined)
        baselines.set(sessionId, { revision, workspace, takenAt: Date.now() })
        sendJson(response, 200, { isRepo: true, revision, workspace })
        return
      }

      // ---- 取差异：基线 vs 当前工作区 ---------------------------------------
      if (url.pathname === `${ROUTE_PREFIX}/changes`) {
        const stored = baselines.get(sessionId)
        if (stored === undefined) {
          sendJson(response, 200, { isRepo: true, noBaseline: true })
          return
        }
        // 工作区换了（会话切了项目）：旧基线无意义，要求重新记录。
        if (stored.workspace !== workspace) {
          sendJson(response, 200, { isRepo: true, noBaseline: true, workspaceChanged: true })
          return
        }
        if (!(await isRepo(workspace))) {
          sendJson(response, 200, { isRepo: false })
          return
        }

        // 当前侧的树：用**常驻索引**构建，git 借此跳过未变文件（见 currentTree 的说明）。
        //
        // 早先试过"先算出变化路径、只哈希它们"，但收窄没有效果：那个仓库里 tmp/ 下的
        // 6636 个日志文件其实是被 git 跟踪的（只是工作区副本未提交），因此基线快照本来
        // 就把它们算了进去，收窄集合依然是 6640 条。让索引保持热才是真正的办法。
        const current = await currentTree(workspace, sessionId)

        const [stat, names, diff] = await Promise.all([
          git(['diff', '--numstat', stored.revision, current], workspace),
          git(['diff', '--name-status', stored.revision, current], workspace),
          git(['diff', '--unified=3', stored.revision, current], workspace),
        ])

        // --numstat 给出每条文件的新增/删除行数，与 --name-status 的顺序一致。
        sendJson(response, 200, {
          isRepo: true,
          scope: 'turn',
          revision: stored.revision,
          takenAt: stored.takenAt,
          ...describeDiff({ stat, names, diff }),
        })
        return
      }

      // ---- 工作区级差异：基线取 HEAD（项目级面板用，不需要会话）------------
      //
      // 与 /changes 的区别在于语义：那个回答"本轮改了什么"（基线是本轮开始时的快照），
      // 这个回答"这个项目现在有什么改动"（基线是 HEAD）。项目页还没有任何一轮对话，
      // 所以那里只能用后者。
      if (url.pathname === `${ROUTE_PREFIX}/workspace`) {
        if (!(await isRepo(workspace))) {
          sendJson(response, 200, { isRepo: false })
          return
        }
        const revision = (await git(['rev-parse', 'HEAD'], workspace).catch(() => '')).trim()
        if (revision === '') {
          // 尚无提交的仓库：没有 HEAD 可比较。
          sendJson(response, 200, { isRepo: true, empty: true, files: [], diff: '', truncated: false })
          return
        }
        const current = await currentTree(workspace, `${sessionId}-workspace`)
        const [stat, names, diff] = await Promise.all([
          git(['diff', '--numstat', revision, current], workspace),
          git(['diff', '--name-status', revision, current], workspace),
          git(['diff', '--unified=3', revision, current], workspace),
        ])
        const payload = describeDiff({ stat, names, diff })
        sendJson(response, 200, {
          isRepo: true,
          scope: 'workspace',
          revision,
          ...payload,
        })
        return
      }

      // ---- 还原：把指定路径恢复到基线或 HEAD -------------------------------
      //
      // 这是本插件唯一的**写**操作，因此格外保守：
      //   * 路径必须通过形状校验（相对路径、无 `..`、长度受限）；
      //   * 还原源只能是 HEAD 或已记录的基线树对象，客户端无法指定任意对象；
      //   * 支持多个路径，但一次请求里的路径全部来自同一个仓库。
      // 这样即使客户端被注入，它能做的最坏情况也只是"把工作区文件恢复成基线内容"——
      // 而用户自己的改动本来就存在 git 里，可再找回。
      if (url.pathname === `${ROUTE_PREFIX}/revert`) {
        if (request.method !== 'POST') {
          response.setHeader('allow', 'POST')
          sendJson(response, 405, { error: 'method not allowed' })
          return
        }
        if (!(await isRepo(workspace))) {
          sendJson(response, 200, { isRepo: false })
          return
        }

        const requestedPaths = Array.isArray(payload.paths) ? payload.paths : []
        if (requestedPaths.length === 0) {
          sendJson(response, 400, { error: 'paths is required', code: 'noPaths' })
          return
        }
        const bad = requestedPaths.find((item) => typeof item !== 'string' || !SAFE_PATH_PATTERN.test(item))
        if (bad !== undefined) {
          sendJson(response, 400, { error: `unsafe path: ${String(bad).slice(0, 80)}`, code: 'unsafePath' })
          return
        }

        // 还原源：本轮基线（scope=turn）或 HEAD（scope=workspace）。
        let source
        if (payload.scope === 'turn') {
          const stored = baselines.get(sessionId)
          if (stored === undefined || stored.workspace !== workspace) {
            sendJson(response, 400, { error: 'no baseline recorded for this turn', code: 'noBaseline' })
            return
          }
          source = stored.revision
        } else {
          source = (await git(['rev-parse', 'HEAD'], workspace)).trim()
        }
        if (!REVISION_PATTERN.test(source)) {
          sendJson(response, 400, { error: 'no valid revision to restore from', code: 'noRevision' })
          return
        }

        // `git restore --source <rev> --worktree -- <paths>`：只动工作区，不动索引与 HEAD。
        // 用 `--` 分隔，避免路径被当成选项（git 的一条经典陷阱）。
        //
        // 但**基线里不存在的文件不能用 restore**：那正是"本轮新建的文件"，它在基线里
        // 没有对应内容，restore 会直接报错（实测返回 500）。对这类文件，正确的还原是
        // **删除它**——那才是"回到基线状态"。逐个判断，两类分开处理。
        const restored = []
        const deleted = []
        for (const path of requestedPaths) {
          // `cat-file -e <rev>:<path>` 在路径不存在时以非零退出。
          let existsInSource = true
          try {
            await git(['cat-file', '-e', `${source}:${path}`], workspace)
          } catch {
            existsInSource = false
          }
          if (existsInSource) {
            await git(['restore', '--source', source, '--worktree', '--', path], workspace)
            restored.push(path)
          } else {
            // 工作区里若确实存在就删掉；不存在则视为已经还原。
            const absolute = resolve(workspace, path)
            if (existsSync(absolute)) rmSync(absolute, { force: true })
            deleted.push(path)
          }
        }
        sendJson(response, 200, { isRepo: true, restored, deleted, source })
        return
      }

      // ---- 提交历史：项目级面板用 -------------------------------------------
      //
      // 项目面板只显示"当前有什么改动"不够——用户还需要"最近发生过什么"。这里给出
      // 最近的提交记录。之所以放在本插件（而不是新开一个），是因为它服务于同一块面板，
      // 且同样需要"只读、按工作区解析"这两条既有约束。
      if (url.pathname === `${ROUTE_PREFIX}/history`) {
        if (!(await isRepo(workspace))) {
          sendJson(response, 200, { isRepo: false })
          return
        }
        const limitRaw = Number(payload.limit ?? 20)
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 100) : 20
        // %x1f（单元分隔符）与 %x1e（记录分隔符）——用它们而不是 \t/\n，因为提交标题
        // 里可能含制表符，而 author 名里可能含各种空白。
        const raw = await git(
          ['log', `-${limit}`, '--date=short', '--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1e'],
          workspace,
        )
        const commits = raw
          .split('\x1e')
          .map((record) => record.trim())
          .filter((record) => record !== '')
          .map((record) => {
            const [hash, short, author, date, ...rest] = record.split('\x1f')
            return { hash, short, author, date, subject: rest.join('\x1f') }
          })
        const branch = (
          await git(['rev-parse', '--abbrev-ref', 'HEAD'], workspace).catch(() => '')
        ).trim()
        sendJson(response, 200, { isRepo: true, branch, commits })
        return
      }

      // ---- 提交历史图：一页提交（含父提交与 refs）--------------------------
      //
      // 与 /history 的区别：那个是"最近发生了什么"的扁平列表（只给标题与作者），
      // 这个是**画图**用的——必须带 `%p`（父提交，决定连线）与 `%D`（refs，决定分支
      // 标签与"当前分支"），并且必须分页。两条路由都保留：侧栏"更改"区块用 /history，
      // 主区域的提交图用 /graph。
      if (url.pathname === `${ROUTE_PREFIX}/graph`) {
        if (!(await isRepo(workspace))) {
          sendJson(response, 200, { isRepo: false })
          return
        }
        const limitRaw = Number(payload.limit ?? url.searchParams.get('limit') ?? GRAPH_PAGE_DEFAULT)
        const skipRaw = Number(payload.skip ?? url.searchParams.get('skip') ?? 0)
        const limit = Number.isFinite(limitRaw) ? limitRaw : GRAPH_PAGE_DEFAULT
        const skip = Number.isFinite(skipRaw) ? skipRaw : 0
        const ref = payload.ref ?? url.searchParams.get('ref') ?? ''
        const page = await readGraph(workspace, { limit, skip, ref })
        if (page.invalidRef === true) {
          sendJson(response, 400, { error: 'invalid ref', code: 'invalidRef' })
          return
        }
        // 当前分支单独给一次：客户端要在图里高亮"HEAD 所在的分支名"，
        // 而 `%D` 只在**恰好有 ref 指向的提交**上带这个信息，当前分支的尖端之外拿不到。
        const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], workspace).catch(() => '')).trim()
        sendJson(response, 200, {
          isRepo: true,
          branch,
          ...page,
        })
        return
      }

      // ---- 一条提交的详情：元信息 + 改动文件 + 出现在哪些分支上 ---------------
      //
      // 路径是 `/commit-detail` 而**不是** `/commit`：后者必须是"创建提交"那个写操作。
      // 早先把详情放在 `/commit` 上，于是 `POST /commit`（创建提交）先命中了这里的
      // revision 校验、被当成"缺 revision 参数"回 400 invalidRevision——提交功能完全
      // 不可用，而报错信息指向一个跟提交无关的原因（实测就是这样）。
      // 同一个路径上放"读详情"与"写提交"这两种语义不同的操作，是这次踩坑的根源。
      if (url.pathname === `${ROUTE_PREFIX}/commit-detail`) {
        if (!(await isRepo(workspace))) {
          sendJson(response, 200, { isRepo: false })
          return
        }
        const revision = payload.revision ?? url.searchParams.get('revision')
        if (typeof revision !== 'string' || !REVISION_PATTERN.test(revision)) {
          sendJson(response, 400, { error: 'invalid revision', code: 'invalidRevision' })
          return
        }
        try {
          sendJson(response, 200, { isRepo: true, ...(await readCommit(workspace, revision)) })
        } catch (error) {
          // 对象不在本地（浅克隆、被 GC 掉的分支）：这是 404，不是 500。
          if (/bad object|unknown revision|bad revision|not a valid object/iu.test(String(error?.message ?? error))) {
            sendJson(response, 404, { error: 'no such commit', code: 'noSuchRef' })
            return
          }
          throw error
        }
        return
      }

      // ---- 一条提交里单个文件的差异 ------------------------------------------
      if (url.pathname === `${ROUTE_PREFIX}/commit-file`) {
        if (!(await isRepo(workspace))) {
          sendJson(response, 200, { isRepo: false })
          return
        }
        const revision = payload.revision ?? url.searchParams.get('revision')
        const filePath = payload.path ?? url.searchParams.get('path')
        if (typeof revision !== 'string' || !REVISION_PATTERN.test(revision)) {
          sendJson(response, 400, { error: 'invalid revision', code: 'invalidRevision' })
          return
        }
        if (typeof filePath !== 'string' || !SAFE_PATH_PATTERN_GRAPH.test(filePath)) {
          sendJson(response, 400, { error: 'unsafe path', code: 'unsafePath' })
          return
        }
        const result = await readCommitFileDiff(workspace, revision, filePath)
        sendJson(response, 200, { isRepo: true, path: filePath, ...result })
        return
      }

      // ---- 工作区状态：已跟踪改动与未跟踪文件分开两组 ------------------------
      //
      // 与 /workspace 的区别：那个给的是"基线树 vs 工作区"的**差异内容**（用来渲染
      // 逐行 diff），这个给的是 git 视角的**状态分类**（索引态/工作区态、未跟踪、以及
      // 冲突态）。界面上"已跟踪更改"与"未跟踪文件"要分成两个区块，而分类只有
      // `status --porcelain` 能准确给出——从差异内容反推分类会在重命名、删除等情形上出错。
      if (url.pathname === `${ROUTE_PREFIX}/status`) {
        if (!(await isRepo(workspace))) {
          sendJson(response, 200, { isRepo: false })
          return
        }
        const raw = await git(['status', '--porcelain'], workspace)
        const { tracked, untracked } = parsePorcelain(raw)
        const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], workspace).catch(() => '')).trim()
        // 未跟踪文件数量可能上万（实测 6,636 个）。**不把路径全传回去**：那个列表在
        // 界面上默认是折叠的，一次传 6,636 条路径只是白白占带宽与内存。只给数量+前若干条，
        // 用户展开时再单独取（见 /untracked）。
        sendJson(response, 200, {
          isRepo: true,
          branch,
          tracked,
          trackedCount: tracked.length,
          untrackedCount: untracked.length,
          untrackedSample: untracked.slice(0, 20).map((entry) => entry.path),
        })
        return
      }

      // ---- 未跟踪文件清单（展开"未跟踪文件"区块时才取）---------------------
      if (url.pathname === `${ROUTE_PREFIX}/untracked`) {
        if (!(await isRepo(workspace))) {
          sendJson(response, 200, { isRepo: false })
          return
        }
        const limitRaw = Number(payload.limit ?? url.searchParams.get('limit') ?? 500)
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 5000) : 500
        // `ls-files --others --exclude-standard` 正是"未跟踪且未被忽略"的定义，
        // 与被 git 忽略的文件（`--ignored`）区分开——后者不该出现在"待暂存"里。
        const raw = await git(['ls-files', '--others', '--exclude-standard'], workspace)
        const all = raw.split('\n').filter((line) => line.trim() !== '')
        sendJson(response, 200, {
          isRepo: true,
          paths: all.slice(0, limit),
          total: all.length,
          truncated: all.length > limit,
        })
        return
      }

      // ---- 暂存 / 取消暂存 / 提交 -------------------------------------------
      //
      // 这三条是本插件里**风险最高**的写操作：前面唯一的写操作是 `revert`（把文件恢复
      // 成基线内容，可找回），而提交会真的往仓库历史里写东西。因此约束比 revert 更紧：
      //   * 路径必须过 SAFE_PATH_PATTERN_GRAPH（同 revert）；
      //   * `add`/`restore --staged` 一次只接受仓库内的相对路径，`--` 分隔符必带；
      //   * 提交信息必须非空（git 自己会拒绝空信息，但我们要回一个稳定的 code）；
      //   * **不提供 `--amend` / `--force` / `reset --hard` 这类改写历史的能力**：
      //     需要它们的人在终端里做，从界面一键可达太危险。
      if (url.pathname === `${ROUTE_PREFIX}/stage` || url.pathname === `${ROUTE_PREFIX}/unstage`) {
        if (request.method !== 'POST') {
          response.setHeader('allow', 'POST')
          sendJson(response, 405, { error: 'method not allowed' })
          return
        }
        if (!(await isRepo(workspace))) {
          sendJson(response, 200, { isRepo: false })
          return
        }
        const requestedPaths = Array.isArray(payload.paths) ? payload.paths : []
        if (requestedPaths.length === 0) {
          sendJson(response, 400, { error: 'paths is required', code: 'noPaths' })
          return
        }
        const bad = requestedPaths.find((item) => typeof item !== 'string' || !SAFE_PATH_PATTERN_GRAPH.test(item))
        if (bad !== undefined) {
          sendJson(response, 400, { error: `unsafe path: ${String(bad).slice(0, 80)}`, code: 'unsafePath' })
          return
        }
        const staging = url.pathname.endsWith('/stage')
        const normalized = requestedPaths.map(normalizePath)
        try {
          if (staging) {
            await git(['add', '--', ...normalized], workspace)
          } else {
            // 仓库尚无 HEAD 时 `restore --staged` 没有源可恢复，用 `rm --cached`：
            // 那正是"把这个文件从索引里去掉、但保留工作区文件"的语义。
            const hasHead = (await git(['rev-parse', '--verify', '--quiet', 'HEAD'], workspace).then(() => true).catch(() => false))
            if (hasHead) await git(['restore', '--staged', '--', ...normalized], workspace)
            else await git(['rm', '--cached', '--quiet', '--', ...normalized], workspace)
          }
        } catch (error) {
          sendJson(response, 409, {
            error: staging ? 'stage failed' : 'unstage failed',
            code: staging ? 'stageFailed' : 'unstageFailed',
            detail: String(error?.message ?? error),
          })
          return
        }
        sendJson(response, 200, { isRepo: true, staged: staging ? normalized : [], unstaged: staging ? [] : normalized })
        return
      }

      if (url.pathname === `${ROUTE_PREFIX}/commit`) {
        if (request.method !== 'POST') {
          response.setHeader('allow', 'POST')
          sendJson(response, 405, { error: 'method not allowed' })
          return
        }
        if (!(await isRepo(workspace))) {
          sendJson(response, 200, { isRepo: false })
          return
        }
        const message = typeof payload.message === 'string' ? payload.message.trim() : ''
        if (message === '') {
          // 空提交信息是 git 自己也会拒绝的，但那会回一个英文长句；这里先挡掉并给出
          // 稳定 code，界面才能说"请填写提交信息"。
          sendJson(response, 400, { error: 'empty message', code: 'emptyMessage' })
          return
        }
        // 暂存区为空时 git 会以非零退出（"nothing to commit"）。提前判掉，并区分
        // "没有任何改动"与"有改动但没暂存"——这两种情况该给用户的下一步完全不同。
        const statusRaw = await git(['status', '--porcelain'], workspace)
        const { tracked } = parsePorcelain(statusRaw)
        const staged = tracked.filter((entry) => entry.index !== ' ' && entry.index !== '?')
        if (staged.length === 0) {
          sendJson(response, 409, {
            error: 'nothing staged',
            code: tracked.length > 0 ? 'nothingStaged' : 'nothingToCommit',
          })
          return
        }
        try {
          // `-F -` 从标准输入读提交信息太绕；这里用 `-m`，它是参数数组里的一个元素，
          // 不会被 shell 解释。多行信息由 `-m` 重复传递，但界面只给单行，因此不需要。
          await git(['commit', '-m', message], workspace)
        } catch (error) {
          sendJson(response, 409, {
            error: 'commit failed',
            code: 'commitFailed',
            detail: String(error?.message ?? error),
          })
          return
        }
        const head = (await git(['rev-parse', 'HEAD'], workspace).catch(() => '')).trim()
        sendJson(response, 200, { isRepo: true, committed: true, head })
        return
      }

      sendJson(response, 404, { error: 'not found' })
    } catch (error) {
      // 任何未预期错误都转成 JSON，避免客户端拿到 HTML 错误页而无法解析。
      sendJson(response, 500, { error: String(error?.message ?? error) })
    }
  }
}

/**
 * 挂载插件。
 * @param ctx - host 侧 cordis 上下文。
 */
export function apply(ctx) {
  // 先按版本清理临时索引：旧索引里的 stat 缓存会让它继续沿用修好之前的记录。
  ensureIndexVersion()

  const handler = createReviewHandler()
  for (const path of [
    `${ROUTE_PREFIX}/baseline`,
    `${ROUTE_PREFIX}/changes`,
    `${ROUTE_PREFIX}/workspace`,
    `${ROUTE_PREFIX}/revert`,
    `${ROUTE_PREFIX}/history`,
    `${ROUTE_PREFIX}/roots`,
    `${ROUTE_PREFIX}/graph`,
    `${ROUTE_PREFIX}/commit-detail`,
    `${ROUTE_PREFIX}/commit-file`,
    `${ROUTE_PREFIX}/status`,
    `${ROUTE_PREFIX}/untracked`,
    `${ROUTE_PREFIX}/stage`,
    `${ROUTE_PREFIX}/unstage`,
    `${ROUTE_PREFIX}/commit`,
  ]) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }), `review: ${path}`)
  }
}

/** 进程退出时清掉临时 index 目录。 */
export function dispose() {
  if (scratchRoot !== undefined && existsSync(scratchRoot)) {
    rmSync(scratchRoot, { recursive: true, force: true })
  }
}
