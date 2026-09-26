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
import { isAbsolute, join, resolve, sep } from 'node:path'
import { collectCommitContext, createCommitMessageGenerator } from './commit-message.js'
import { createProjectGitScope, createRepoContextResolver } from './repo-context.js'

// 「AI 补充提交信息」的其余部分（上限、提示词构造、输出规范化、失败翻译）从 host 侧
// 原样再导出一份：它们是纯函数，`scripts/test-review-commit-message.mjs` 直接断言，
// 不必起服务器。客户端 bundle 用不到它们（那里只有一条 `/commit-message` 请求）。
export {
  COMMIT_MESSAGE_LIMITS,
  COMMIT_MESSAGE_TIMEOUT_CODE,
  buildCommitMessagePrompt,
  collectCommitContext,
  createCommitMessageGenerator,
  describeLlmFailure,
  normalizeCommitMessage,
} from './commit-message.js'

/** 插件名，用于诊断与 effect 标签。 */
export const name = 'review'

/** 必须先有 webServer 服务，路由才有地方注册。 */
export const inject = ['webServer']

/** 路由前缀，与 gitbar 的做法一致，便于分辨"这是外壳侧插件提供的"。 */
const ROUTE_PREFIX = '/dsh-desktop/review'

/** git 命令超时。**基线快照要遍历整个工作区，实测在带大量未跟踪文件的仓库上接近 100 秒**，
 * 因此这里给足余量；而每次轮询走的"只哈希变化文件"路径是毫秒级的。 */
const GIT_TIMEOUT_MS = 240000

/**
 * 探测类 git 命令（`rev-parse`）的超时。
 *
 * 它们回答的是"这个目录属于哪个仓库"，输入只有路径、输出只有一行，正常在毫秒级返回。
 * 给 5 秒是为了让"磁盘掉了/仓库损坏"这类异常快速失败，而不是让一条轮询请求挂 4 分钟。
 */
const REPO_PROBE_TIMEOUT_MS = 5000

/**
 * 联网操作的超时。
 *
 * `push` 要等远端握手与传输，用本地操作的 240 秒虽然也够，但"提交并推送"里用户是盯着
 * 界面的——超时太长会让一次网络故障表现为长时间无响应。180 秒与 gitbar 那边一致。
 */
const GIT_NETWORK_TIMEOUT_MS = 180000

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
  // 单个文件的差异也可能很大（一份生成物、一个巨大的 JSON），因此同样放宽缓冲：
  // "32 MB 对单文件够用"只是通常成立，而它不成立时的表现是整条路由 500。
  let raw = await git(args, cwd, undefined, diffBufferFor(1))
  /**
   * 改名提交要特殊处理：**带了 pathspec 就看不到改名**。
   *
   * `git diff <rev>^ <rev> -- <新路径>` 只在两端都受限的那一个路径上比较，于是 git 根本
   * 看不到"它原来叫别的名字"，结果是一份空的（或整份新增的）差异，而不是一次改名。而
   * "这个文件在这一步被改名了"恰恰是文件历史里最需要看清的一步。
   *
   * 因此只有在"这份差异里没有改名信息"时才多花一次 `--name-status`（一次进程），把它配对
   * 出来的**两个路径一起**放进 pathspec，git 就能正常识别改名了。
   */
  if (!/^rename (from|to) /mu.test(raw) && !/^similarity index /mu.test(raw)) {
    const pair = await readRenamePair(cwd, base, revision, normalizePath(path))
    if (pair !== undefined) {
      raw = await git(
        ['diff', '--unified=3', '--find-renames', base === undefined ? '--root' : base, revision, '--', pair.from, pair.to],
        cwd,
        undefined,
        diffBufferFor(2),
      )
    }
  }
  // `Binary files … differ` 之类没有可展示的行，界面上要区别对待。
  const binary = /^Binary files |^GIT binary patch/mu.test(raw)
  const truncated = raw.length > MAX_DIFF_BYTES
  return { diff: truncated ? raw.slice(0, MAX_DIFF_BYTES) : raw, truncated, binary }
}

/**
 * 找一次提交里与某个路径相关的改名配对。
 *
 * 只看**这一次提交**的 name-status（`--no-renames` 之外还要 `--find-renames`），因此代价
 * 与提交大小成正比、与历史长度无关。返回的 `{ from, to }` 会一起作为 pathspec 传给
 * `git diff`，让改名检测在两端都可见。
 *
 * @param cwd - 仓库根。
 * @param base - 父提交（根提交时 undefined）。
 * @param revision - 该提交。
 * @param path - 请求的路径（可能是改名后的新名字，也可能是旧名字）。
 * @returns `{ from, to }`，或 undefined。
 */
async function readRenamePair(cwd, base, revision, path) {
  const raw = await git(
    ['diff', '--name-status', '-z', '--find-renames', base === undefined ? '--root' : base, revision],
    cwd,
    undefined,
    GIT_MAX_BUFFER,
  ).catch(() => '')
  for (const entry of parseNameStatus(raw)) {
    if (entry.status !== 'R' || typeof entry.from !== 'string' || entry.from === '') continue
    if (entry.from === path || entry.path === path) return { from: entry.from, to: entry.path }
  }
  return undefined
}

/** 图形路由允许的 ref 形状：分支名/标签名，不含 rev 表达式。 */
const REF_PATTERN_GRAPH = /^(?![-./])(?!.*\.\.)(?!.*\/\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/u

/**
 * 把 `git status --porcelain` 解析成"路径 → 索引态/工作区态"的查表。
 *
 * `XY` 两列是**两个独立的维度**：`X` 是索引相对 HEAD 的状态，`Y` 是工作区相对索引的
 * 状态。实测确认过的四种形状：
 *   `A  new-staged.txt`  只有已暂存
 *   ` M unstaged.txt`    只有未暂存
 *   `MM both.txt`        **两边都有**（同一个文件会同时出现在两组里，这是对的）
 *   `?? untracked.txt`   未跟踪（此时**不取 X**：untracked 的 X 是 `?`，它不是"已暂存"）
 *
 * 为什么查表而不是把 status 直接当数据源：文件列表（内容与增删行数）来自差异路由，
 * 而这个查表只补"索引态"这一维度，两者合并成**一次请求的同一份数据**，
 * 界面上的分组与列表因此不可能对不上。
 *
 * @param raw - `git status --porcelain` 的原文。
 * @returns `Map<path, { staged, unstaged, untracked, index, worktree }>`。
 */
function indexStates(raw) {
  const table = new Map()
  for (const line of raw.split('\n')) {
    if (line.length < 4) continue
    const index = line[0]
    const worktree = line[1]
    let path = line.slice(3)
    if (path.startsWith('"') && path.endsWith('"')) {
      path = path.slice(1, -1).replace(/\\(["\\])/gu, '$1')
    }
    if (index === '!' || worktree === '!') continue
    const untracked = index === '?' || worktree === '?'
    table.set(path, {
      index,
      worktree,
      untracked,
      // 未跟踪的文件不计入"已暂存"：它的 X 是 `?`，语义上不是索引里的改动。
      staged: !untracked && index !== ' ',
      unstaged: !untracked && worktree !== ' ',
    })
  }
  return table
}

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
 * `porcelain=v2` 的一条记录 → 界面认识的条目。
 *
 * v2 的两列 `XY` 与 v1 的语义相同，但**未修改用 `.` 而不是空格**。界面上的分组判定
 * （客户端的 `classifyEntry`）一直按"空格 = 干净"写，因此这里把 `.` 换回空格，
 * 让两套格式共用同一处判定——否则"已暂存 / 更改"的分组会因为一个点而全错。
 *
 * 展示用的字母取"工作区那一列"优先：用户看到的内容差异更接近它（例如 `MM` 取 `M`、
 * `AM` 取 `M`、`A.` 取 `A`）。两列都干净（重命名之外的罕见情形）时退回 `M`。
 *
 * @param path - 仓库内相对路径。
 * @param xy - 两列状态，例如 `M.`、`.M`、`MM`、`R.`。
 * @returns `{ path, status, index, worktree, staged, unstaged, untracked }`。
 */
function entryFromXY(path, xy) {
  const index = typeof xy === 'string' && xy.length >= 1 ? xy[0] : '.'
  const worktree = typeof xy === 'string' && xy.length >= 2 ? xy[1] : '.'
  const letter = worktree !== '.' ? worktree : index
  return {
    path,
    status: letter === '.' || letter === ' ' ? 'M' : letter,
    // 与 v1 对齐：未修改是空格。
    index: index === '.' ? ' ' : index,
    worktree: worktree === '.' ? ' ' : worktree,
    staged: index !== '.' && index !== ' ',
    unstaged: worktree !== '.' && worktree !== ' ',
    untracked: false,
  }
}

/**
 * 解析 `git status --porcelain=v2 --branch -z --untracked-files=all`。
 *
 * **为什么换成 v2**：项目级快照只需要"有哪些文件、各自的索引/工作区状态、当前分支与
 * HEAD"。以前那条路由为了拿到同样的信息，先 `git add -A` + `write-tree` 造一棵临时索引树
 * （6,639 个改动路径的仓库上约 4 秒），再算一份**全仓库统一差异**（同一仓库 45.9 MB）——
 * 而右上角那个数字只需要文件个数。v2 一条命令就给出全部状态，且不产生任何差异正文。
 *
 * `-z` 而不是普通模式：NUL 分隔下 git **完全不做引号转义**，含空格、中文、引号的路径
 * 都是原样字节，不需要再实现一套 C 风格反转义（v1 的 `parsePorcelain` 只处理了最简单的
 * 两种转义，非 ASCII 路径会被 `core.quotePath` 加引号，那是个潜在的坑）。
 *
 * 记录形状（实测确认，见 `scripts/test-review-workspace-status.mjs`）：
 *   `# branch.oid <oid>|(initial)`   `# branch.head <name>|(detached)`
 *   `# branch.upstream <name>`       `# branch.ab +<ahead> -<behind>`
 *   `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
 *   `2 <XY> <sub> … <X><score> <path>` + 紧跟一段 NUL 字段 = 原路径（重命名/复制）
 *   `u <XY> …×9 <path>`（冲突）   `? <path>`（未跟踪）   `! <path>`（被忽略）
 *
 * @param raw - 命令原文。
 * @returns `{ branch, head, detached, initial, upstream, ahead, behind, files }`。
 */
function parseStatusV2(raw) {
  const fields = String(raw).split('\0')
  let branch = ''
  let head = ''
  let detached = false
  let initial = false
  let upstream = ''
  let ahead = 0
  let behind = 0
  const files = []
  for (let i = 0; i < fields.length; i += 1) {
    const line = fields[i]
    if (line === '') continue
    if (line.startsWith('# ')) {
      const body = line.slice(2)
      const cut = body.indexOf(' ')
      const key = cut < 0 ? body : body.slice(0, cut)
      const value = cut < 0 ? '' : body.slice(cut + 1)
      if (key === 'branch.oid') {
        if (value === '(initial)') initial = true
        else head = value
      } else if (key === 'branch.head') {
        if (value === '(detached)') detached = true
        else branch = value
      } else if (key === 'branch.upstream') upstream = value
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/u.exec(value)
        if (match !== null) {
          ahead = Number(match[1])
          behind = Number(match[2])
        }
      }
      continue
    }
    const kind = line[0]
    if (kind === '?') {
      // 未跟踪：它没有索引/工作区两列（v2 把 X 记成 `?`），因此显式给三个布尔值，
      // 而不是让客户端从字母去猜。
      files.push({ path: line.slice(2), status: 'A', index: '?', worktree: '?', staged: false, unstaged: false, untracked: true })
      continue
    }
    if (kind === '!') continue
    if (kind === '1') {
      const parts = line.split(' ')
      files.push(entryFromXY(parts.slice(8).join(' '), parts[1] ?? '..'))
      continue
    }
    if (kind === '2') {
      const parts = line.split(' ')
      // **先取路径再跳过原路径**：`-z` 下重命名是两条 NUL 记录，不跳过就会多出一条
      // 名字是旧路径的"幽灵文件"。
      const path = parts.slice(9).join(' ')
      i += 1
      files.push(entryFromXY(path, parts[1] ?? '..'))
      continue
    }
    if (kind === 'u') {
      const parts = line.split(' ')
      // 未合并（冲突）条目：`u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`。
      // 单独打标记而不是当成普通改动，因为界面上它属于**自己的分组**（冲突要最先看到），
      // 而且它既不是"已暂存"也不是"未暂存"——`classifyEntry` 会据 `conflict` 跳过这两组。
      files.push({
        ...entryFromXY(parts.slice(10).join(' '), parts[1] ?? '..'),
        conflict: true,
        code: parts[1] ?? 'UU',
      })
      continue
    }
  }
  return { branch, head, detached, initial, upstream, ahead, behind, files }
}

/**
 * `git diff --numstat` 的一行 → `{ path, added, removed }`。
 *
 * 只取增删行数（不含正文），因此它是"元数据级"的命令：即使仓库有几千个改动文件，
 * 输出也只有几十 KB。重命名在 numstat 里是 `old => new` 甚至
 * `dir/{old => new}.ts` 的紧凑写法，这里把它还原成**新路径**，与 status 的路径对齐
 * ——不对齐的话那一行的增删数字会静默丢失（显示成 `·`），而这是最难发现的一类错。
 *
 * @param line - numstat 的一行。
 * @returns `{ path, added, removed }` 或 null。
 */
function parseNumstatLine(line) {
  const parts = line.split('\t')
  if (parts.length < 3) return null
  const rawPath = parts.slice(2).join('\t')
  // `a/{old => new}/b.ts` → `a/new/b.ts`；`old => new` → `new`。
  const compact = /^(.*)\{(.*) => (.*)\}(.*)$/u.exec(rawPath)
  const path =
    compact === null
      ? (rawPath.includes(' => ') ? rawPath.slice(rawPath.lastIndexOf(' => ') + 4) : rawPath)
      : `${compact[1]}${compact[3]}${compact[4]}`
  return {
    path,
    added: parts[0] === '-' ? null : Number(parts[0]),
    removed: parts[1] === '-' ? null : Number(parts[1]),
  }
}

/**
 * 把 numstat 的增删行数并到 status 得到的文件列表上，并丢掉**没有内容差异**的条目。
 *
 * 三类条目在这里被处理：
 *   * **未跟踪文件**：`git diff HEAD` 里没有它（还没进版本库），保留，`added/removed` 为
 *     `null`（界面上显示 `·`，点开时才按需取差异，见 `/workspace-file`）；
 *   * **有内容差异的已跟踪文件**：带上 numstat 的行数；
 *   * **已跟踪、但 numstat 里根本没有它的文件**：**丢弃**。
 *
 * 最后一类为什么必须丢：`status` 报"改了"而 `diff HEAD` 说"没差异"的情形在 Windows 上是
 * 真实存在的——最典型的是 `core.autocrlf=true` 时 `git restore --source HEAD --worktree`
 * 之后，工作区文件变成 CRLF，`status` 因为 stat 缓存仍报 `M`，而 `diff --numstat HEAD`
 * 是**空的**（内容按 git 的规范化后完全一致）。这正是本插件自己的 `revert` 会走的那条路：
 * 不丢的话，"还原"之后那个文件还挂在改动列表里，用户会以为还原失败。旧实现碰不到这个坑
 * 只是因为它走"临时索引树 vs HEAD"的比较，天然按内容判定。
 *
 * 另有 `isMetadataOnly` 兜住"numstat 是 0/0 的纯模式变化"（索引里已经记着另一个 mode 的
 * 仓库会出现），规则与旧实现一致。
 *
 * @param files - status 解析出的文件条目。
 * @param numstat - `git diff --numstat HEAD` 的原文。
 * @returns 新的文件数组（不改入参）。
 */
function withLineCounts(files, numstat) {
  const counts = new Map()
  for (const line of String(numstat).split('\n')) {
    const entry = parseNumstatLine(line)
    if (entry !== null) counts.set(entry.path, entry)
  }
  const merged = []
  for (const file of files) {
    const count = counts.get(file.path)
    if (count === undefined) {
      if (file.untracked === true) merged.push({ ...file, added: null, removed: null })
      continue
    }
    merged.push({ ...file, added: count.added, removed: count.removed })
  }
  return merged.filter((file) => !isMetadataOnly(file))
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
 * `git` 的 stdout 缓冲上限（默认 32 MB）。
 *
 * 这个默认值对元数据类输出（numstat / name-status / log）绰绰有余，**但对完整统一
 * 差异不够**：实测 `E:\workspace\mmsm-amis` 上一个没有被 `.gitignore` 覆盖的 `tmp/`
 * 目录（6,635 个日志文件、37.7 MB）会让 `git diff --unified=3` 输出 **45.9 MB /
 * 1,062,664 行**，直接把 32 MB 的缓冲撑爆，`execFile` 报
 * `stdout maxBuffer length exceeded`。
 *
 * 后果不是"少显示一部分"，而是**整条 `/review/workspace` 返回 500** —— 界面上的表现是
 * "这个项目当前没有未提交的改动"（0 个文件），而"最近提交"照常显示 20 条，于是看起来
 * 像是"项目级 git 取不到数据"。这一个错误信息就够定位了，但它藏在 HTTP 500 的正文里，
 * 不主动去看是看不到的。
 */
const GIT_MAX_BUFFER = 32 * 1024 * 1024

/**
 * 大差异命令的缓冲上限（256 MB）。
 *
 * 只在"输出体量与改动文件数成正比"的命令上放宽（统一差异）。为什么能估准：统一差异的
 * 体积 ≈ 每文件的行数 × 平均行长，而文件数由 numstat 一次拿到，所以
 * `max(64 MB, 每文件 4 KB × 文件数)` 对"一堆小文件"和"少量大文件"都够用，同时给
 * 病态仓库留了一个有界的上限——超了就走"截断"而不是把进程打死。
 */
const GIT_MAX_BUFFER_LARGE = 256 * 1024 * 1024

/** 估算统一差异需要的缓冲：以改动文件数为准，下限 64 MB。 */
function diffBufferFor(fileCount) {
  const estimate = Math.max(64 * 1024 * 1024, Number(fileCount) * 4096)
  return Math.min(estimate, GIT_MAX_BUFFER_LARGE)
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
 * 另外带上 **`-c core.quotePath=false`**：默认配置下 git 会把**非 ASCII**（中文文件名很
 * 常见）与含特殊字符的路径按 C 风格转义成 `"\346\226\207..."`，于是我们自己按路径做的
 * 匹配（numstat ↔ status、差异切片）会静默失配——表现是"中文名的文件不显示行数/差异"。
 * `-z` 输出的那些路由本来就不转义，这条让不带 `-z` 的（numstat、name-status）也一致。
 *
 * @param args - 参数数组（不含 `git`）。
 * @param cwd - 仓库目录。
 * @param env - 额外环境变量（用于传入临时 index）。
 * @param maxBuffer - stdout 上限，默认 `GIT_MAX_BUFFER`。
 * @param timeoutMs - 超时，默认 `GIT_TIMEOUT_MS`（联网操作用 `GIT_NETWORK_TIMEOUT_MS`）。
 * @param allowExit - 允许"退出码 1 且 stdout 非空"，用于 `--no-index` 这类**用退出码
 *   表达"有差异"**的命令：那种情况下 stdout 就是要展示的差异，不是失败。
 * @returns stdout。
 */
function git(args, cwd, env, maxBuffer = GIT_MAX_BUFFER, timeoutMs = GIT_TIMEOUT_MS, allowExit = false) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.fileMode=false', '-c', 'core.quotePath=false', '-C', cwd, ...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        if (error !== null && !(allowExit && error.code === 1 && String(stdout) !== '')) {
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
 * 一批 `git add` 的 argv 预算（字符数）。
 *
 * Windows 的 `CreateProcess` 命令行上限是 32,767 个字符，而 `execFile` 还要为每个参数
 * 加引号与转义。路径数上限（`ADD_BATCH_MAX`）单独用是不够的：500 个 200 字符的深层
 * 路径就是 10 万字符，早就爆了。因此**两个上限一起用**，先到哪个算哪个。
 */
const ADD_ARGV_BUDGET = 7000

/** 一批 `git add` 最多带多少个路径（另一条独立上限，见 ADD_ARGV_BUDGET）。 */
const ADD_BATCH_MAX = 500

/** 临时 pathspec 文件的序号（文件名里带它，避免同一进程内并发时撞名）。 */
let pathspecSerial = 0

/**
 * 把一批路径加进索引，**参数长度有界**。
 *
 * 为什么不能直接 `git add -- <paths...>`：用户可以在「浏览」里全选几千个未跟踪文件，
 * 那个 argv 一定会超过 Windows 的命令行上限，表现是 `spawn ENAMETOOLONG` 或 git 报
 * "filename too long"，而**用户看到的只是"加入 git 失败了"**。
 *
 * 首选 `--pathspec-from-file`（git ≥ 2.25）：路径写进一个临时文件、以 NUL 分隔，
 * 完全绕开命令行长度。临时文件在 `finally` 里删掉（失败路径也要删，否则临时目录会
 * 随着每次失败慢慢堆积）。
 *
 * 老 git 不认这个选项时退回**有界批处理**（按路径数与总字符数双上限切批），代价是多
 * 跑几个 git 进程，但正确性不变。
 *
 * @param cwd - 仓库根。
 * @param paths - 仓库相对路径（已过形状校验）。
 * @returns `{ mode, batches }`：用了哪条路径、跑了几批（诊断与测试用）。
 */
async function addPaths(cwd, paths) {
  const normalized = paths.map((path) => String(path).replace(/\\/gu, '/'))
  const file = join(scratchDir(), `pathspec-${pathspecSerial++}.txt`)
  try {
    // NUL 分隔 + `--pathspec-file-nul`：路径里的空格、引号、中文都不需要转义。
    writeFileSync(file, `${normalized.join('\0')}\0`, 'utf8')
    try {
      await git(['add', `--pathspec-from-file=${file}`, '--pathspec-file-nul'], cwd)
      return { mode: 'pathspec-file', batches: 1 }
    } catch (error) {
      // 只有"这个 git 不认这个选项"才退回批处理；真正的 add 失败（路径不存在、
      // 索引锁）必须原样抛出去，否则错误会被吞掉、界面显示"成功了"。
      if (!/unknown option|unrecognized option|usage: git add/iu.test(String(error?.message ?? error))) throw error
    }
  } finally {
    rmSync(file, { force: true })
  }

  const batches = []
  let current = []
  let size = 0
  for (const path of normalized) {
    if (current.length >= ADD_BATCH_MAX || (current.length > 0 && size + path.length + 1 > ADD_ARGV_BUDGET)) {
      batches.push(current)
      current = []
      size = 0
    }
    current.push(path)
    size += path.length + 1
  }
  if (current.length > 0) batches.push(current)
  for (const batch of batches) {
    await git(['add', '--', ...batch], cwd)
  }
  return { mode: 'batched', batches: batches.length }
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
 * 为某个会话 + 某个**仓库**取得临时 index 路径。
 *
 * 按"会话 + 仓库根"保持同一个 index 文件：git 会在里面记录 stat 缓存，因此后续快照
 * 只需重新哈希真正变化的文件，而不是每次遍历整棵树。
 *
 * **仓库根必须参与命名**（而不是工作区）：project 级面板的请求对所有项目共用同一个会话
 * 标识（`default`），只用会话命名会让切到另一个项目后的 git 被喂上一份**别的仓库的
 * 索引**——轻则结果错乱，重则直接报错。用工作区命名则更糟：同一个仓库的两个子目录会
 * 各拿一份索引，于是"两个目录看到的数据不一致"且首次快照的代价付两遍。仓库路径用哈希
 * 进入文件名：它可能很长且含不适合做文件名的字符。
 *
 * @param sessionId - 会话标识。
 * @param repositoryRoot - 仓库顶层绝对路径。
 * @returns index 文件绝对路径。
 */
function indexFor(sessionId, repositoryRoot) {
  // 会话 id 来自客户端，做个保守的字符过滤以免拼出意外路径。
  const safe = String(sessionId).replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 80)
  const key = createHash('sha1').update(String(repositoryRoot)).digest('hex').slice(0, 10)
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
 * 从零给仓库拍一张完整快照（遍历整棵树），返回树对象 SHA。
 *
 * **只在记录基线时调用**：它要为所有变动文件重新计算哈希，代价与它们数量成正比。
 * 实测在带 6640 个变动路径的仓库上约 4 秒（首次索引为空时更慢），因此不能放进轮询路径。
 *
 * 全程只读：git 只写我们自己指定的临时 index，不动仓库状态。
 * @param repositoryRoot - 仓库顶层路径（git 的 cwd）。
 * @param sessionId - 会话标识（决定临时 index 的归属）。
 * @returns 树对象 SHA。
 */
async function snapshot(repositoryRoot, sessionId) {
  const indexPath = indexFor(sessionId, repositoryRoot)
  const env = { GIT_INDEX_FILE: indexPath }
  try {
    return await withIndexLockRecovery(indexPath, async () => {
      // 空仓库没有 HEAD 可读——从空 index 开始即可。
      await git(['read-tree', 'HEAD'], repositoryRoot, env).catch(() => undefined)
      // -A：已跟踪的修改与删除、新增文件、以及按 .gitignore 规则纳入的未跟踪文件。
      await git(['add', '-A'], repositoryRoot, env)
      return (await git(['write-tree'], repositoryRoot, env)).trim()
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
 * 去重键与索引命名都用**仓库根**：同一个仓库的两个子工作区因此共用同一份索引与同一个
 * 在途快照，不会各跑一遍全量哈希。
 *
 * @param repositoryRoot - 仓库顶层路径（git 的 cwd）。
 * @param sessionId - 会话标识。
 * @returns 树对象 SHA。
 */
async function currentTree(repositoryRoot, sessionId) {
  const key = `${sessionId}|${repositoryRoot}`
  const running = inFlightSnapshots.get(key)
  if (running !== undefined) return running

  const task = (async () => {
    const indexPath = indexFor(`${sessionId}-current`, repositoryRoot)
    const env = { GIT_INDEX_FILE: indexPath }
    return withIndexLockRecovery(indexPath, async () => {
      // 索引首次使用（或损坏）时从 HEAD 起一个基准，让后续的 add -A 有比较对象。
      //
      // 绝不能在每次调用时都 read-tree：那会重置索引、连带丢掉 stat 缓存，add -A 于是
      // 每次都退化成全量重新哈希（实测 4.3 秒而不是 0.22 秒）。这个代价不明显，因为结果
      // 依然正确——只是慢，所以很容易一直留着。
      if (!existsSync(indexPath)) {
        await git(['read-tree', 'HEAD'], repositoryRoot, env).catch(() => undefined)
      }
      await git(['add', '-A'], repositoryRoot, env)
      return (await git(['write-tree'], repositoryRoot, env)).trim()
    })
  })().finally(() => {
    inFlightSnapshots.delete(key)
  })

  inFlightSnapshots.set(key, task)
  return task
}

/**
 * `workspaceRoot → RepoContext` 的解析器（见 lib/repo-context.js 的说明）。
 *
 * **所有 Git 路由都以 `repositoryRoot` 为 cwd**：git 的路径输出是**仓库相对**的
 * （`status` / `diff` 实测如此），而 `ls-files --others` 这类命令是**cwd 前缀相对**的
 * ——从子目录跑会少报文件。统一到仓库根之后，两件事同时成立：路径基准唯一（界面不会
 * 时而 `../src/a.js` 时而 `src/a.js`），未跟踪枚举也完整。
 *
 * 探测用短超时（5 秒）：它只是**一次** `rev-parse`（同时取 toplevel 与 git 目录），超过这个
 * 时间说明磁盘/仓库异常，拖住整个路由没有意义。
 */
const repoContext = createRepoContextResolver({
  runGit: (args, cwd) => git(args, cwd, undefined, GIT_MAX_BUFFER, REPO_PROBE_TIMEOUT_MS),
  realpath: (value) => realpathSync.native(value),
})

/**
 * 只把项目级 scope 铺进响应（没有可用仓库时用）。
 *
 * @param scope - `resolveProjectScope` 的结果（可能 undefined）。
 * @returns 可直接铺进响应的字段。
 */
function projectScopeFields(scope) {
  if (scope === undefined || scope === null) return {}
  return {
    projectScope: {
      workspaceRoot: scope.workspaceRoot,
      repositories: scope.repositories,
      discovery: scope.discovery,
    },
  }
}

/**
 * 解析一个工作区所属的仓库。
 *
 * @param workspace - 已通过 `validateWorkspace` 的真实工作区路径。
 * @returns `{ workspaceRoot, repositoryRoot, gitDir }`；不是仓库时 undefined。
 */
async function resolveRepo(workspace) {
  return repoContext.resolve(workspace)
}

/**
 * 从一条 scope 记录构造"当前请求要操作的那个仓库"。
 *
 * 客户端给的 `repository` 是**不可信输入**，因此这里只认"这个 workspaceRoot 的
 * ProjectGitScope 里确实有它"的路径（realpath 比较）：否则 `repository=C:/` 又能越过
 * 工作区安全边界，让宿主对任意目录跑 git 与读写。
 *
 * @param workspace - 已校验的工作区路径。
 * @param repository - 客户端指定的仓库根（可选）。
 * @param options - `{ projectScope }`：是否强制现在就把项目级仓库列表算出来（见下）。
 * @returns `{ context, scope, error }`：`error` 为 `'repositoryNotAllowed'` 时拒绝。
 */
async function resolveScopedRepo(workspace, repository, options) {
  const context = await repoContext.resolve(workspace)
  /**
   * 要不要**现在**把项目级仓库列表算出来。
   *
   * 发现要跑一次 `rev-parse` 探针（第一次在 250 ms 预算内，之后 60 秒内命中缓存），因此
   * 不能无条件跑——否则每条轮询路由都会多起一个 git 进程。三种情况才需要它：
   *   * 客户端指定了 `repository`：必须校验它确实属于这个项目；
   *   * 工作区自己不是仓库：只有列表能回答"子目录里的仓库在哪"（实机误报的修复点）；
   *   * 路由声明需要（作用域查询本身就是问这个）。
   * 其余情况只用已有缓存；客户端的 `projectScopes` 会先打一次 `/project-git-scope`，
   * 因此缓存通常是热的。
   */
  const explicit = typeof repository === 'string' && repository !== ''
  const wanted = options?.projectScope === true || explicit || context === undefined
  const scope = wanted ? await repoContext.resolveProjectScope(workspace) : repoContext.peekProjectScope(workspace)
  const repositories = Array.isArray(scope?.repositories) ? scope.repositories : []
  const pick = (entry) =>
    entry === undefined
      ? undefined
      : { workspaceRoot: workspace, repositoryRoot: entry.repositoryRoot, gitDir: entry.gitDir, relativePath: entry.relativePath, name: entry.name }
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
  // 没指定：优先"工作区自己所属的仓库"（1.5.2 的行为），其次是**列表里的第一个**。
  //
  // 第二条与客户端 `projectScopes.activeOf` 的规则**逐字相同**，这是有意的：客户端
  // 默认选中哪一个，宿主就必须解析到同一个——否则会出现"选择器上写着 frontend、
  // 面板里的却是 backend"。发现顺序是确定的（浅层优先、同层按名字），因此默认项稳定。
  // 它同时修掉了实机的那个 bug：工作区自己不是仓库、子目录里有仓库时，以前这里回
  // "没有仓库"，界面于是说"当前工作区不是 git 仓库"。
  const own = repositories.find((entry) => entry.relativePath === '')
  if (own !== undefined) return { context: pick(own), scope, error: '' }
  if (repositories.length >= 1) return { context: pick(repositories[0]), scope, error: '' }
  // 列表是空的（没强制发现、缓存也空）：工作区自己所属的仓库仍然算数（1.5.2 单仓库路径）。
  return { context, scope, error: '' }
}

/**
 * 给响应附上作用域信息（工作区 / 仓库 / 项目级 ProjectGitScope）。
 *
 * 客户端要靠 `repositoryRoot` 决定"这份快照属于哪个仓库"——同仓库的两个子目录必须
 * 共用同一份快照与同一套轮询（见客户端 gitSnapshots 的说明）；`projectScope` 则是
 * 这一版新增的"一个工作区里有哪些仓库"，多仓库 UI（Changes 分组、Log 选择器、
 * badge 聚合）都读它。
 *
 * @param context - 当前仓库的上下文。
 * @param scope - `resolveProjectScope` 的结果（可选）。
 * @returns 可直接铺进响应的字段。
 */
function scopeFields(context, scope) {
  return {
    workspaceRoot: context.workspaceRoot,
    repositoryRoot: context.repositoryRoot,
    ...(context.gitDir === '' ? {} : { gitDir: context.gitDir }),
    ...(context.relativePath === undefined ? {} : { repositoryRelativePath: context.relativePath }),
    ...(context.name === undefined ? {} : { repositoryName: context.name }),
    gitScope: createProjectGitScope(context),
    ...(scope === undefined || scope === null
      ? {}
      : {
          projectScope: {
            workspaceRoot: scope.workspaceRoot,
            repositories: scope.repositories,
            discovery: scope.discovery,
          },
        }),
  }
}

// ===========================================================================
// 未跟踪文件：快路径 / 精确枚举 / 浏览树
// ===========================================================================
//
// 这套东西存在的唯一理由是**规模**：实测过一个仓库有 6,846 个未跟踪文件（一个没有被
// `.gitignore` 覆盖的 `tmp/`）。如果常驻轮询每次都做完整枚举、再把 6846 条路径塞给
// 渲染进程，那么"每 10 秒搬 6846 个对象"会一直存在，而且大多数时候用户根本没打开
// Changes 页签。
//
// 因此分成两条路径：
//   * **快路径**（常驻轮询、右上角徽标）：`--untracked-files=normal`，git 会把整块
//     未跟踪目录折叠成一条 `tmp/`，因此返回的条目数与目录深度成正比，而不是与文件数
//     成正比。它回答"有多少条未跟踪条目"（可能是估计值，`exact: false`）。
//   * **精确枚举**（用户打开 Changes 需要判定 inline/browse、或点了「浏览」、或写操作
//     之后）：`ls-files --others --exclude-standard -z` 拿完整清单，按 repositoryRoot
//     缓存 20 秒，并据此建一棵目录树供「浏览」按前缀惰性取子节点。

/**
 * inline / browse 的阈值。
 *
 * ≤ 它就**逐行列出全部**未跟踪文件（IDEA 的"少量模式"）；> 它则主面板**一行都不列**，
 * 只给"6,846 个文件 + 浏览"。旧实现是"最多列前 50 个、剩下的说一句还有 N 个"——那既不
 * 是完整列表也不是概要，用户既看不到全部、也不知道该去哪里看剩下的。
 */
const UNTRACKED_INLINE_LIMIT = 50

/** 统计新增行数时的读取上限。 */
const MAX_COUNT_FILE_BYTES = 1024 * 1024
const MAX_TOTAL_COUNT_BYTES = 8 * 1024 * 1024

/** 精确枚举结果的缓存 TTL（毫秒）。写操作会立刻让它失效，因此这里只是兜底。 */
const UNTRACKED_TTL_MS = 20000

/** 「浏览」一个目录默认/最多返回多少个子节点（同级几千个文件时靠它分页）。 */
const UNTRACKED_PAGE_DEFAULT = 200
const UNTRACKED_PAGE_MAX = 1000

/** repositoryRoot → `{ at, paths, tree }`（精确枚举的缓存）。 */
const untrackedCache = new Map()

/**
 * 把一条未跟踪路径转成界面认识的条目。
 *
 * `added`/`removed` 先给 `null`（界面显示 `+·`），精确行数由 `countUntrackedLines`
 * 在有界预算内补上——两者分开是因为"有多少个未跟踪文件"必须随时可用，而"每个文件
 * 有多少行"可以在读得起的时候再算。
 *
 * @param path - 仓库相对路径。
 * @returns 文件条目。
 */
function untrackedEntry(path) {
  return {
    path,
    status: 'A',
    index: '?',
    worktree: '?',
    staged: false,
    unstaged: false,
    untracked: true,
    added: null,
    removed: null,
  }
}

/**
 * 判断一段字节是否是二进制内容。
 *
 * 只看前 8000 字节里有没有 NUL：这是 git 自己用的同一条启发式（`buffer_is_binary`）。
 * 二进制文件的行数没有意义（`git diff --numstat` 也回 `-`），因此宁可不显示数字。
 *
 * @param buffer - 文件前若干字节。
 * @returns 是二进制则 true。
 */
function looksBinary(buffer) {
  return buffer.includes(0)
}

/**
 * 给少量未跟踪文件补上"新增行数"。
 *
 * 三条边界都是必须的，否则一个 500 MB 的日志文件会让整条路由（以及宿主进程）卡住：
 *   * 单文件超过 `MAX_COUNT_FILE_BYTES` 不读，只留 `·`；
 *   * 一轮读取的总字节超过 `MAX_TOTAL_COUNT_BYTES` 就停止补算，后面的保持 `·`；
 *   * 二进制不读全文、也不给数字。
 *
 * **绝不为了一个数字去 fork 一个 git 进程**：那是每文件一次进程，50 个文件就是 50 次。
 *
 * @param cwd - 仓库根。
 * @param entries - 未跟踪条目（会被就地补上 added）。
 * @returns 同一批条目。
 */
function countUntrackedLines(cwd, entries) {
  let budget = MAX_TOTAL_COUNT_BYTES
  for (const entry of entries) {
    if (budget <= 0) break
    const absolute = resolve(cwd, entry.path)
    let size
    try {
      size = statSync(absolute).size
    } catch {
      // 枚举之后文件被删掉了：保持 `·`，不做任何猜测。
      continue
    }
    if (size > MAX_COUNT_FILE_BYTES || size > budget) continue
    let buffer
    try {
      buffer = readFileSync(absolute)
    } catch {
      continue
    }
    budget -= buffer.length
    if (looksBinary(buffer.subarray(0, 8000))) {
      entry.binary = true
      continue
    }
    // 行数按 `\n` 数：与 `git diff --numstat` 对新增文件的算法一致（最后一行没有换行
    // 也算一行）。
    let lines = 0
    for (const byte of buffer) {
      if (byte === 10) lines += 1
    }
    if (buffer.length > 0 && buffer[buffer.length - 1] !== 10) lines += 1
    entry.added = lines
    entry.removed = 0
  }
  return entries
}

/**
 * 把一份扁平的未跟踪路径清单建成目录树。
 *
 * 建树只做一次（跟着枚举缓存走）：6846 条路径的树在内存里是几 MB 量级，而"每次展开
 * 一个目录都重新过滤一遍全表"是 O(N × 展开次数)。
 *
 * @param paths - 仓库相对路径数组（字典序）。
 * @returns 根节点 `{ dirs: Map<name, node>, files: string[] }`。
 */
function buildUntrackedTree(paths) {
  const root = { dirs: new Map(), files: [] }
  for (const path of paths) {
    const parts = path.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i += 1) {
      const name = parts[i]
      let next = node.dirs.get(name)
      if (next === undefined) {
        next = { dirs: new Map(), files: [] }
        node.dirs.set(name, next)
      }
      node = next
    }
    if (parts.length > 0 && parts[parts.length - 1] !== '') node.files.push(parts[parts.length - 1])
  }
  return root
}

/** 一个目录子树里的文件总数（含所有层级）。 */
function countDescendants(node) {
  let total = node.files.length
  for (const child of node.dirs.values()) total += countDescendants(child)
  return total
}

/**
 * 按前缀走进树里。
 *
 * @param root - 树根。
 * @param prefix - 目录前缀（`''` = 仓库根；末尾斜杠可选）。
 * @returns 节点；前缀不存在时 undefined。
 */
function descendUntracked(root, prefix) {
  const clean = String(prefix ?? '').replace(/^\/+|\/+$/gu, '')
  if (clean === '') return root
  let node = root
  for (const part of clean.split('/')) {
    const next = node.dirs.get(part)
    if (next === undefined) return undefined
    node = next
  }
  return node
}

/**
 * 列出某个前缀下的**直接子节点**（目录 + 文件），并分页。
 *
 * 只给直接子节点是"lazy tree"的关键：展开 `tmp/magic-api` 时再按
 * `prefix=tmp/magic-api` 请求一次，而不是一次把 6846 条全丢给渲染进程。
 *
 * @param root - 树根。
 * @param prefix - 目录前缀。
 * @param offset - 起始下标（对"目录 + 文件"合并排序后的列表）。
 * @param limit - 最多返回多少项。
 * @returns `{ prefix, directories, files, total, offset, limit, truncated }` 或 undefined。
 */
function listUntrackedChildren(root, prefix, offset, limit) {
  const clean = String(prefix ?? '').replace(/^\/+|\/+$/gu, '')
  const node = descendUntracked(root, clean)
  if (node === undefined) return undefined
  const directories = [...node.dirs.entries()]
    .map(([name, child]) => ({
      name,
      path: clean === '' ? name : `${clean}/${name}`,
      descendantCount: countDescendants(child),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const files = [...node.files]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, path: clean === '' ? name : `${clean}/${name}` }))
  const size = directories.length + files.length
  const from = Math.max(0, offset)
  const take = Math.max(0, limit)
  // 目录在前、文件在后（与 IDEA 一致）：分页也要按这个顺序切，否则用户会看到"目录
  // 翻着翻着夹进来一堆文件"。
  const all = [...directories, ...files]
  const page = all.slice(from, from + take)
  return {
    prefix: clean,
    directories: page.filter((item) => item.descendantCount !== undefined),
    files: page.filter((item) => item.descendantCount === undefined),
    total: size,
    directoryCount: directories.length,
    fileCount: files.length,
    offset: from,
    limit: take,
    truncated: from + page.length < size,
  }
}

/**
 * 取（必要时枚举）某个仓库的完整未跟踪清单。
 *
 * 缓存键是 **repositoryRoot**：同一个仓库的两个子工作区因此共用一份枚举，切目录不会
 * 让"6,846 个文件"重新数一遍。
 *
 * @param cwd - 仓库根。
 * @param options - `{ force }`：写操作之后强制重枚举。
 * @returns `{ at, paths, tree, cached }`。
 */
async function readUntracked(cwd, options = {}) {
  const cached = untrackedCache.get(cwd)
  if (options.force !== true && cached !== undefined && Date.now() - cached.at < UNTRACKED_TTL_MS) {
    return { ...cached, cached: true }
  }
  const raw = await git(['ls-files', '--others', '--exclude-standard', '-z'], cwd, undefined, GIT_MAX_BUFFER_LARGE)
  const paths = String(raw)
    .split('\0')
    .filter((line) => line !== '')
    .sort((a, b) => a.localeCompare(b))
  const entry = { at: Date.now(), paths, tree: buildUntrackedTree(paths) }
  // 条数上限：只留最近使用的 16 个仓库（每个的清单可能是几百 KB）。
  untrackedCache.delete(cwd)
  untrackedCache.set(cwd, entry)
  while (untrackedCache.size > 16) {
    const oldest = untrackedCache.keys().next()
    if (oldest.done === true) break
    untrackedCache.delete(oldest.value)
  }
  return { ...entry, cached: false }
}

/** 让某个仓库的未跟踪枚举缓存失效（写操作之后调用）。 */
function invalidateUntracked(cwd) {
  untrackedCache.delete(cwd)
}

/**
 * 快路径下的未跟踪摘要。
 *
 * @param cwd - 仓库根。
 * @param entries - 快路径拿到的未跟踪条目（`-unormal`，目录已折叠）。
 * @returns `{ count, exact, mode, inlineFiles, collapsed }`。
 */
function describeUntrackedFast(cwd, entries) {
  const collapsed = entries.some((entry) => entry.path.endsWith('/'))
  const cached = untrackedCache.get(cwd)
  const fresh = cached !== undefined && Date.now() - cached.at < UNTRACKED_TTL_MS
  // 有精确缓存就用它：轮询路径因此能顺带把"上一轮已经数清楚的"结果带上，索引/界面都
  // 不必再等一次枚举。
  if (fresh) {
    const count = cached.paths.length
    const mode = count <= UNTRACKED_INLINE_LIMIT ? 'inline' : 'browse'
    return {
      count,
      exact: true,
      mode,
      collapsed: false,
      inlineFiles: mode === 'inline' ? cached.paths.map(untrackedEntry) : [],
    }
  }
  const exact = !collapsed
  const count = entries.length
  const mode = exact ? (count <= UNTRACKED_INLINE_LIMIT ? 'inline' : 'browse') : 'pending'
  return {
    count,
    exact,
    mode,
    collapsed,
    // 少量且确切时先把路径给出去（行数留 `·`），让首屏就有可点的行；精确行数由
    // `/untracked` 的精确枚举补上。
    inlineFiles: mode === 'inline' ? entries.map((entry) => untrackedEntry(entry.path)) : [],
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
 * 请求体的字节上限。
 *
 * 曾经是 8 KiB——那时所有请求体都只有路径清单和小标量。现在「浏览未跟踪文件」会把用户
 * 勾选的一整批路径发回来（实测 6,818 个路径的 JSON 约 200 KB），8 KiB 会让"全选后加入
 * git"变成 400 `invalid body`，而界面上只看到"加入 git 失败了"。
 *
 * 2 MiB 的余量：路径形状已经过 `SAFE_PATH_PATTERN` 校验（≤1024 字符、无 `..`、非绝对），
 * 因此这里挡的是"有人往这个路由灌垃圾"，而不是正常使用。
 */
const MAX_BODY_BYTES = 2 * 1024 * 1024

/**
 * 读取并限制请求体。
 * @param request - HTTP 请求。
 * @returns 请求体文本（上限 `MAX_BODY_BYTES`）。
 */
async function readSmallBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
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
 * 取"基线 vs 当前"的完整统一差异，缓冲按改动文件数放宽。
 *
 * 为什么需要单独一层、而不是直接 `git(['diff', '--unified=3', …])`：统一差异的体量
 * 与改动**文件数**成正比（实测 6,639 个文件 → 45.9 MB），固定 32 MB 缓冲会让整条路由
 * 500。这里按 numstat 给出的文件数估一个够用的上限。
 *
 * 仍然撑爆时**不再抛出**，而是返回空差异 + `oversized`：此时文件列表（numstat /
 * name-status 的体积只有 2.3 MB，一定拿得到）照常显示，用户能看到"改了哪些文件"，
 * 只是看不到逐行内容。这比"整块面板变成 0 个改动"好得多——后者会让人以为项目级 git
 * 完全取不到数据。
 *
 * @param cwd - 工作区路径。
 * @param from - 基线对象。
 * @param to - 当前树对象。
 * @param fileCount - 改动文件数（来自 numstat），用于估算缓冲。
 * @returns `{ diff, oversized }`。
 */
async function readUnifiedDiff(cwd, from, to, fileCount) {
  try {
    const diff = await git(['diff', '--unified=3', from, to], cwd, undefined, diffBufferFor(fileCount))
    return { diff, oversized: false }
  } catch (error) {
    const message = String(error?.message ?? error)
    if (/maxBuffer/iu.test(message)) return { diff: '', oversized: true }
    throw error
  }
}

/**
 * 工作区里**单个文件**相对 HEAD 的差异。
 *
 * 与全仓库统一差异的区别是代价：真实仓库里那份是 45.9 MB / 数秒，而用户一次只看一两个
 * 文件；因此这里只对**一个路径**算差异，缓冲也按单文件估（`diffBufferFor(1)`）。
 *
 * 未跟踪文件要走 `--no-index` 与空文件比：它还没进版本库，`git diff HEAD -- <path>`
 * 对它一个字都不给（这正是"点了未跟踪文件看不到内容"的原因）。`--no-index` 在有差异时
 * 退出码是 1，那是正常结果（见 `git()` 的 `allowExit`）。
 *
 * 二进制与超长内容的处理与 `/commit-file` 一致：识别 `Binary files … differ`，并在
 * `MAX_DIFF_BYTES` 处截断（界面按 `truncated` 提示）。
 *
 * @param cwd - 工作区路径。
 * @param revision - 已校验的提交 SHA，或 `HEAD`。
 * @param path - 已校验的相对路径（正斜杠）。
 * @param untracked - 该文件当前是否未跟踪（来自同一次 status 快照）。
 * @returns `{ diff, truncated, binary }`。
 */
async function readWorkspaceFileDiff(cwd, revision, path, untracked) {
  const raw = untracked
    ? await git(
        ['diff', '--no-index', '--unified=3', '--', '/dev/null', path],
        cwd,
        undefined,
        diffBufferFor(1),
        GIT_TIMEOUT_MS,
        true,
      )
    : await git(['diff', '--unified=3', revision, '--', path], cwd, undefined, diffBufferFor(1))
  const binary = /^Binary files |^GIT binary patch/mu.test(raw)
  const truncated = raw.length > MAX_DIFF_BYTES
  return { diff: truncated ? raw.slice(0, MAX_DIFF_BYTES) : raw, truncated, binary }
}

/**
 * 冲突标记的扫描器：把一份带冲突标记的文件切成"普通文本 / 冲突块"两类片段。
 *
 * 为什么由 backend 做：渲染进程既不该读 `.git`，也不该自己解析 `<<<<<<<`；而"接受某
 * 一侧"这件事必须在**服务端**重组文件——那才有唯一一份实现，也才能顺手校验结果里还有
 * 没有残留标记。
 *
 * 标记形状（git 的 `merge.conflictStyle` 默认 `merge`，`zdiff3`/`diff3` 会多一个 `|||||||`
 * 基础段，这里都支持）：
 *
 *     <<<<<<< ours
 *     ...当前侧...
 *     ||||||| base      ← 可选（diff3 风格）
 *     ...基础版本...
 *     =======
 *     ...对方侧...
 *     >>>>>>> theirs
 *
 * 行尾统一按 `\n` 处理但**保留原文行尾**：`split(/\r?\n/)` 之后用原文的行分隔符重组，
 * 否则一个 CRLF 仓库里的文件会被整体改成 LF（那是用户没做过的改动）。
 *
 * @param text - 文件原文。
 * @returns `{ segments, blocks, hasMarkers }`；segments 是 `{ kind: 'text'|'block', ... }`。
 */
function scanConflictSegments(text) {
  const source = String(text)
  // 保留 CRLF：先按行切开，但记住每一行原本用什么结尾。
  const lines = source.split('\n')
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const strip = (line) => (line.endsWith('\r') ? line.slice(0, -1) : line)

  const segments = []
  const blocks = []
  let buffer = []
  let index = 0

  const flushText = () => {
    if (buffer.length === 0) return
    segments.push({ kind: 'text', text: buffer.join('\n') })
    buffer = []
  }

  for (let cursor = 0; cursor < lines.length; cursor += 1) {
    const line = strip(lines[cursor])
    if (!line.startsWith('<<<<<<<')) {
      buffer.push(lines[cursor])
      continue
    }
    // 收集一个冲突块：ours → 可选 base → theirs。
    //
    // 每一侧都收两份：`raw`（保留行尾的 `\r`，用于**写回**时保持用户的换行风格）与
    // `clean`（去掉 `\r`，用于**展示**与逐块选择）。只留 raw 会让界面上拿到的文本拖着一个
    // 看不见的裸 `\r`——比较、复制、再参与重组时都会出怪事。
    const start = cursor
    const raw = { ours: [], base: [], theirs: [] }
    const clean = { ours: [], base: [], theirs: [] }
    let section = 'ours'
    let end = -1
    let markerLabels = { ours: line.slice(7).trim(), theirs: '' }
    for (cursor += 1; cursor < lines.length; cursor += 1) {
      const current = strip(lines[cursor])
      if (section === 'ours' && current.startsWith('|||||||')) {
        section = 'base'
        continue
      }
      if (section !== 'theirs' && current.startsWith('=======')) {
        section = 'theirs'
        continue
      }
      if (section === 'theirs' && current.startsWith('>>>>>>>')) {
        markerLabels = { ...markerLabels, theirs: current.slice(7).trim() }
        end = cursor
        break
      }
      raw[section].push(lines[cursor])
      clean[section].push(current)
    }
    if (end === -1) {
      // 标记不完整（用户正在手编、或文件被改坏）：按普通文本处理，别把它吞掉。
      buffer.push(lines[start])
      continue
    }
    flushText()
    const block = {
      index,
      startLine: start + 1,
      endLine: end + 1,
      ours: clean.ours.join('\n'),
      theirs: clean.theirs.join('\n'),
      ...(clean.base.length === 0 ? {} : { base: clean.base.join('\n') }),
      /** 写回时用这两份（保留原始行尾）。 */
      rawOurs: raw.ours.join('\n'),
      rawTheirs: raw.theirs.join('\n'),
      ...(raw.base.length === 0 ? {} : { rawBase: raw.base.join('\n') }),
      oursLabel: markerLabels.ours,
      theirsLabel: markerLabels.theirs,
    }
    blocks.push(block)
    segments.push({ kind: 'block', ...block })
    index += 1
    // for 的 cursor += 1 会跳过 `>>>>>>>` 那一行——正是我们要的。
  }
  flushText()

  return { segments, blocks, hasMarkers: blocks.length > 0, eol }
}

/**
 * 按"逐块选择"重组文件内容。
 *
 * @param text - 带标记的文件原文。
 * @param resolutions - `{ [blockIndex]: 'ours' | 'theirs' | 'both' }`；缺省表示"还没决定"，
 *   那一块**保持原样**（这样用户可以先解决一半再保存）。
 * @param order - `both` 时两侧的先后：`ours-first`（默认）或 `theirs-first`。
 * @returns `{ content, blocks, unresolved, hasMarkers }`。
 */
function composeConflictText(text, resolutions, order) {
  const scan = scanConflictSegments(text)
  const pick = resolutions ?? {}
  let unresolved = 0
  const parts = []
  for (const segment of scan.segments) {
    if (segment.kind === 'text') {
      parts.push(segment.text)
      continue
    }
    const choice = pick[String(segment.index)]
    if (choice === 'ours') {
      parts.push(segment.rawOurs ?? segment.ours)
    } else if (choice === 'theirs') {
      parts.push(segment.rawTheirs ?? segment.theirs)
    } else if (choice === 'both') {
      const first = order === 'theirs-first' ? (segment.rawTheirs ?? segment.theirs) : (segment.rawOurs ?? segment.ours)
      const second = order === 'theirs-first' ? (segment.rawOurs ?? segment.ours) : (segment.rawTheirs ?? segment.theirs)
      parts.push([first, second].filter((value) => value !== '').join('\n'))
    } else {
      unresolved += 1
      // 未决定：原样保留标记与两侧内容（包含可选的 base 段），不丢信息。
      const marked = [`<<<<<<< ${segment.oursLabel}`]
      if (segment.base !== undefined) marked.push('||||||| base', segment.rawBase ?? segment.base)
      marked.push(segment.rawOurs ?? segment.ours, '=======', segment.rawTheirs ?? segment.theirs, `>>>>>>> ${segment.theirsLabel}`)
      parts.push(marked.join('\n'))
    }
  }
  return {
    content: parts.join('\n'),
    blocks: scan.blocks,
    unresolved,
    hasMarkers: scan.hasMarkers,
    eol: scan.eol,
  }
}

/**
 * 解析 `git ls-files -u -z -- <path>` 的输出，得到索引里存在哪些未合并阶段。
 *
 * 形状：`<mode> <sha> <stage>\t<path>\0`。阶段 1/2/3 分别是 base / ours / theirs——
 * 界面据此判断"这个冲突有没有基础版本"（两边都是新增文件时没有 stage 1）。
 *
 * @param raw - `-z` 输出。
 * @returns `{ stage, mode, sha }[]`。
 */
function parseUnmergedStages(raw) {
  const stages = []
  for (const record of String(raw).split('\0')) {
    if (record === '') continue
    const tab = record.indexOf('\t')
    const meta = (tab === -1 ? record : record.slice(0, tab)).trim().split(/\s+/u)
    if (meta.length < 3) continue
    const stage = Number(meta[2])
    if (stage !== 1 && stage !== 2 && stage !== 3) continue
    stages.push({ stage, mode: meta[0], sha: meta[1] })
  }
  return stages
}

/**
 * 读取工作区里某个文件的文本（读不到返回 undefined：冲突文件可能被删了）。
 * @param absolute - 绝对路径。
 * @returns 文本，或 undefined。
 */
function readWorktreeText(absolute) {
  try {
    if (!statSync(absolute).isFile()) return undefined
    return readFileSync(absolute, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * 轻量检测"进行中的操作类型"。
 *
 * 只做几次 `statSync`（git 在冲突期间会留下这些标记），**不起 git 进程**——这条路径挂在
 * 每 10 秒一次的 `/workspace` 轮询上，多一个子进程就是每 10 秒一次的固定开销。
 *
 * `.git` 在 worktree/submodule 里是**文件**，此时标记不在 `<cwd>/.git/` 下；那种情况这里
 * 返回空串（界面退回"不在任何操作中"），而不是去多跑一次 rev-parse——真正需要精确判定的
 * 地方（continue/abort）在 gitbar 宿主里，那边会解析真实的 git 目录。
 *
 * 无标记冲突（`git stash apply/pop` 冲突时 git **不写** MERGE_HEAD）由调用方通过
 * `conflictsHint` 告知：那时**读一下冲突文件里的两侧标记名**就能确定它来自 stash
 * （`Updated upstream` / `Stashed changes` 是 git 自己写进文件的常量），这是唯一持久的
 * 判据。没有它时返回 `unmerged`——"有冲突但没有可继续的操作"，同样是如实回答。
 *
 * @param cwd - 仓库根。
 * @param conflictsHint - `{ path }` 数组（冲突文件）；不传时不做无标记判定。
 * @returns `'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'stash' | 'unmerged' | ''`。
 */
function readOperationType(cwd, conflictsHint) {
  const marker = (relative) => {
    try {
      statSync(join(cwd, '.git', relative))
      return true
    } catch {
      return false
    }
  }
  if (marker('MERGE_HEAD')) return 'merge'
  if (marker('rebase-merge') || marker('rebase-apply')) return 'rebase'
  if (marker('CHERRY_PICK_HEAD')) return 'cherry-pick'
  if (marker('REVERT_HEAD')) return 'revert'
  const conflicts = Array.isArray(conflictsHint) ? conflictsHint : []
  if (conflicts.length === 0) return ''
  const path = typeof conflicts[0]?.path === 'string' ? conflicts[0].path : ''
  try {
    const text = readFileSync(join(cwd, path), 'utf8').slice(0, 64 * 1024)
    const ours = /^<{7}\s?(.*)$/mu.exec(text)
    const theirs = /^>{7}\s?(.*)$/mu.exec(text)
    if (ours !== null && theirs !== null && ours[1].trim() === 'Updated upstream' && theirs[1].trim() === 'Stashed changes') {
      return 'stash'
    }
  } catch {
    // 读不到（文件被删、权限）：退回下面那个如实的 `unmerged`。
  }
  return 'unmerged'
}

/**
 * 快速数一下这个仓库有几个储藏（**不起 git 进程**）。
 *
 * 走的是一条与"储藏"同寿的文件：`refs/stash` 的 reflog（`git stash` 每压一次就追加一行，
 * `git stash drop` 会重写它）。它只在"用作刷新信号"时被读——真正的列表走 `/stash/list`，
 * 因此这里读不到（worktree/submodule 里 `.git` 是文件）只意味着"少一个刷新触发"，不会
 * 让界面显示错误的东西。`/workspace` 每 10 秒被轮询一次，多起一个 `git stash list`
 * 进程是不可接受的，这就是它存在的理由。
 *
 * @param cwd - 仓库根。
 * @returns 储藏条数（读不到时为 0）。
 */
function countStashesFast(cwd) {
  try {
    return readFileSync(join(cwd, '.git', 'logs', 'refs', 'stash'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '').length
  } catch {
    return 0
  }
}

/**
 * 解析 `git diff --name-status -z` 的输出。
 *
 * 记录形状：`M\0path\0`；重命名/复制是**三条**（`R100\0old\0new\0`），因此不能简单地
 * "两两成对"地切。`-z` 下路径不做引号转义，含空格与中文的路径都能原样取到。
 *
 * @param raw - 原始输出。
 * @returns `{ path, status }` 数组。
 */
function parseNameStatus(raw) {
  const fields = String(raw).split('\u0000')
  const entries = []
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index]
    if (status === '') continue
    const letter = status[0]
    if (letter === 'R' || letter === 'C') {
      const from = fields[index + 1]
      const to = fields[index + 2]
      index += 2
      if (to === undefined) break
      // 重命名在**储藏里**只需要一个可点开的路径：显示新名字，差异仍按整体算。
      entries.push({ path: normalizePath(to), status: letter, from: from === undefined ? '' : from })
      continue
    }
    const path = fields[index + 1]
    index += 1
    if (path === undefined) break
    entries.push({ path: normalizePath(path), status: letter })
  }
  return entries
}

/**
 * 读取一个储藏的内容清单。
 *
 * 与 `git stash show` 分开成两条命令是有意的：`stash show -u` 的 `-u` 需要 git ≥ 2.32，
 * 而这里用的两条命令（`diff --name-status` 与 `ls-tree`）从 git 1.6 起就存在且形状稳定。
 * 未跟踪文件在储藏里是**第三个父提交**（`stash@{n}^3`，它没有父提交）的一棵树，
 * 因此"哪些是未跟踪"是读 git 对象读出来的，不解析任何文本。
 *
 * @param cwd - 仓库根。
 * @param sha - 储藏提交的完整 SHA。
 * @returns `{ files, hasUntracked }`。
 */
async function readStashFiles(cwd, sha) {
  const parents = (await git(['show', '--no-patch', '--pretty=format:%P', sha], cwd)).trim()
  const tracked = parseNameStatus(await git(['diff', '--name-status', '-z', '--find-renames', `${sha}^1`, sha], cwd, undefined, GIT_MAX_BUFFER))
  const hasUntracked = parents.split(/\s+/u).filter((value) => value !== '').length >= 3
  let untracked = []
  if (hasUntracked) {
    const raw = await git(['ls-tree', '-r', '--name-only', '-z', `${sha}^3`], cwd, undefined, GIT_MAX_BUFFER).catch(() => '')
    untracked = raw
      .split('\u0000')
      .filter((path) => path !== '')
      .map((path) => ({ path: normalizePath(path), status: 'A', untracked: true }))
  }
  return { files: [...tracked, ...untracked], hasUntracked }
}

/**
 * 一条储藏里单个文件的差异。
 *
 * 已跟踪文件复用 `readCommitFileDiff`（储藏提交与普通提交在这里没有区别：都比它的第一个
 * 父提交）；未跟踪文件在第三个父提交里，`git show <sha^3> -- <path>` 会把它渲染成一整份
 * 新增（该提交没有父提交，git 自己按 `--root` 处理），因此**不需要伪造一个空树**。
 *
 * @param cwd - 仓库根。
 * @param sha - 储藏提交的完整 SHA。
 * @param path - 已校验的相对路径。
 * @returns `{ diff, truncated, binary }`。
 */
async function readStashFileDiff(cwd, sha, path) {
  const target = normalizePath(path)
  const trackedRaw = await git(['diff', '--name-only', '-z', `${sha}^1`, sha, '--', target], cwd, undefined, GIT_MAX_BUFFER).catch(() => '')
  if (trackedRaw.split('\u0000').some((entry) => entry !== '')) return await readCommitFileDiff(cwd, sha, target)
  const untracked = await git(['ls-tree', '-r', '--name-only', '-z', `${sha}^3`, '--', target], cwd, undefined, GIT_MAX_BUFFER).catch(() => '')
  if (!untracked.split('\u0000').some((entry) => entry !== '')) return undefined
  const raw = await git(['show', '--format=', '--unified=3', `${sha}^3`, '--', target], cwd, undefined, diffBufferFor(1))
  const binary = /^Binary files |^GIT binary patch/mu.test(raw)
  const truncated = raw.length > MAX_DIFF_BYTES
  return { diff: truncated ? raw.slice(0, MAX_DIFF_BYTES) : raw, truncated, binary }
}

/** 储藏提交的 SHA 可以在请求里带上（列表已经算过），但**必须**自己再校验一次。 */
const STASH_SHA_PATTERN = /^[0-9a-f]{40}$/u

/**
 * 把请求里的储藏引用解析成一个**确实是储藏**的提交 SHA。
 *
 * 只认 `stash@{n}`：`stash apply` 接受任意提交，而这个界面上的"储藏"是一个具体的东西。
 * `--verify` 之后还要确认它真的是 `refs/stash` 的 reflog 条目之一，否则 `stash@{9}`
 * （不存在）会被 git 解析成别的意思或者报一句英文 fatal。
 *
 * @param cwd - 仓库根。
 * @param ref - 请求给出的引用。
 * @returns 完整 SHA，或 undefined。
 */
async function resolveStashRef(cwd, ref) {
  if (typeof ref !== 'string' || !/^stash@\{\d+\}$/u.test(ref.trim())) return undefined
  const target = ref.trim()
  const listed = await git(['stash', 'list', '--format=%gd%x00%H%x1e'], cwd).catch(() => '')
  for (const record of listed.split('\u001e')) {
    if (record.trim() === '') continue
    const [selector, sha] = record.split('\u0000')
    if (selector?.trim() === target && STASH_SHA_PATTERN.test(String(sha ?? '').trim())) return String(sha).trim()
  }
  return undefined
}

/**
 * 把比较用的修订解析成一个提交 SHA。
 *
 * 与 `/commit-file` 只接受 40 位 SHA 不同：比较的**两端可以是引用**（"main 与当前分支比"、
 * "v1.0 与 HEAD 比"），因此这里放宽到"完整 SHA，或图里合法形状的 ref 名"。安全性由两点
 * 保证：形状先过白名单（`REF_PATTERN_GRAPH` 与 `REVISION_PATTERN`），再由 git 自己用
 * `rev-parse --verify <rev>^{commit}` 确认它在这个仓库里真的能解析成提交——**rev 表达式
 * （`HEAD~3`、`main@{2}`）进不来**，因为它们不在任何一个白名单里。
 *
 * @param cwd - 仓库根。
 * @param value - 请求给出的修订。
 * @returns 完整 SHA，或 undefined。
 */
async function resolveCompareRevision(cwd, value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text === '') return undefined
  if (!REVISION_PATTERN.test(text) && !REF_PATTERN_GRAPH.test(text)) return undefined
  const sha = (await git(['rev-parse', '--verify', '--quiet', `${text}^{commit}`], cwd).catch(() => '')).trim()
  return REVISION_PATTERN.test(sha) ? sha : undefined
}

/**
 * 一次比较里某一端的提交概要（`%H%x1f%h%x1f%s%x1f%an%x1f%cI`）。
 * @param cwd - 仓库根。
 * @param sha - 提交 SHA。
 * @returns `{ sha, short, subject, author, date }`。
 */
async function readCommitHeader(cwd, sha) {
  const raw = await git(['show', '--no-patch', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI', sha], cwd)
  const fields = String(raw).replace(/\n$/u, '').split('\u001f')
  return {
    sha: String(fields[0] ?? '').trim(),
    short: String(fields[1] ?? '').trim(),
    subject: String(fields[2] ?? '').trim(),
    author: String(fields[3] ?? '').trim(),
    date: String(fields[4] ?? '').trim(),
  }
}

/**
 * 两个修订之间的差异：提交数（各自独有）与改动文件清单。
 *
 * `git rev-list --left-right --count a...b` 给的是**两侧各自独有**的提交数（三点表示
 * "相对合并基点"），这正是 IDEA 说的 ahead/behind。文件清单用 `--name-status -z`
 * （路径不做引号转义）并带 `--find-renames`：改名在比较视图里应当显示成一次改名，
 * 而不是"删一个 + 加一个"。
 *
 * @param cwd - 仓库根。
 * @param a - 一端的 SHA。
 * @param b - 另一端的 SHA。
 * @returns `{ onlyA, onlyB, files }`。
 */
async function readComparison(cwd, a, b) {
  const counts = (await git(['rev-list', '--left-right', '--count', `${a}...${b}`], cwd)).trim().split(/\s+/u)
  const files = parseNameStatus(
    await git(['diff', '--name-status', '-z', '--find-renames', a, b], cwd, undefined, GIT_MAX_BUFFER),
  )
  return {
    // 名字用 `onlyA` / `onlyB`（而不是 ahead/behind）：谁比谁领先取决于你把哪一端当"当前"，
    // 含糊的 ahead/behind 在"提交 ↔ 当前"与"分支 ↔ 分支"两种用法里会互相矛盾。
    onlyA: Number(counts[0] ?? 0) || 0,
    onlyB: Number(counts[1] ?? 0) || 0,
    files,
  }
}

/**
 * 两个修订之间某个文件的差异（比较视图里点开一个文件时用）。
 *
 * 与 `readCommitFileDiff` 同一套截断与二进制判定，只是两端都是调用方给的（不是 `rev^`）。
 *
 * @param cwd - 仓库根。
 * @param a - 一端的 SHA。
 * @param b - 另一端的 SHA。
 * @param path - 已校验的相对路径。
 * @returns `{ diff, truncated, binary }`。
 */
async function readCompareFileDiff(cwd, a, b, path) {
  const raw = await git(['diff', '--unified=3', a, b, '--', normalizePath(path)], cwd, undefined, diffBufferFor(1))
  const binary = /^Binary files |^GIT binary patch/mu.test(raw)
  const truncated = raw.length > MAX_DIFF_BYTES
  return { diff: truncated ? raw.slice(0, MAX_DIFF_BYTES) : raw, truncated, binary }
}

/**
 * 创建审查路由的处理器。
 * @returns `(request, response)` 处理器。
 */
function createReviewHandler(ctx) {
  // AI 补充提交信息走宿主正式能力（`ctx.llm` + `ctx.agentDefaultModel`，见
  // lib/commit-message.js）。**服务在调用时才解析**：宿主没有模型 provider 时面板照样能开。
  const commitMessageGenerator =
    ctx === undefined ? undefined : createCommitMessageGenerator(ctx)
  const onCommitMessage =
    commitMessageGenerator === undefined ? undefined : (context) => commitMessageGenerator.generateCommitMessage(context)

  return async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')

      let payload = {}
      if (request.method === 'POST') {
        try {
          payload = JSON.parse(await readSmallBody(request))
        } catch (error) {
          // 稳定的 code（`invalidBody`）：客户端据此显示本语言的短句，而不是把
          // "request body too large" 这种内部文本端给用户。
          const tooLarge = /too large/iu.test(String(error?.message ?? error))
          sendJson(response, tooLarge ? 413 : 400, {
            error: 'invalid body',
            code: 'invalidBody',
            detail: String(error.message),
          })
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

      // ---- 工作区 → 仓库：**唯一的**作用域解析点 -----------------------------
      //
      // 从这里往下，所有 git 命令的 cwd 都是 `cwd`（= repositoryRoot）。这不是风格问题：
      //   * git 的 `status` / `diff` 输出路径是**仓库相对**的，而 `ls-files --others`
      //     是**cwd 前缀相对**的——从子目录跑会少报未跟踪文件；
      //   * 同一个仓库的两个子目录必须共用同一份快照、同一份临时索引与同一套轮询。
      // 因此"所有路由都从仓库根跑"同时解决了路径基准与共享这两件事。
      //
      // 客户端只送 workspaceRoot；repositoryRoot 一律由 host 推导，绝不接受客户端传入
      // （否则 `repositoryRoot=C:/` 就能越过工作区安全边界）。
      const requestedRepository = payload.repository ?? url.searchParams.get('repository')

      // 项目级作用域：一个工作区有哪些仓库（含 discovery 诊断），客户端据此渲染多仓库 UI。
      if (url.pathname === `${ROUTE_PREFIX}/project-git-scope`) {
        const scope = await repoContext.resolveProjectScope(workspace, {
          force: payload.force === true || url.searchParams.get('force') === '1',
        })
        sendJson(response, 200, {
          isRepo: scope.repositories.length > 0,
          workspaceRoot: scope.workspaceRoot,
          repositories: scope.repositories,
          discovery: scope.discovery,
        })
        return
      }

      /**
       * `/repo-context` 本身就是"作用域查询"，必须现在就有列表；其它路由（`/workspace`、
       * `/status`、`/untracked`、写操作…）只用已有缓存——客户端的 `projectScopes` 会先打
       * 一次 `/project-git-scope`，因此缓存通常是热的，而没热的时候不值得为每条轮询多起
       * 一个探针进程（见 resolveScopedRepo 的说明）。
       */
      const { context, scope, error: scopeError } = await resolveScopedRepo(workspace, requestedRepository, {
        projectScope: url.pathname === `${ROUTE_PREFIX}/repo-context`,
      })
      if (scopeError === 'repositoryNotAllowed') {
        sendJson(response, 400, {
          error: 'repository not allowed',
          code: 'repositoryNotAllowed',
          detail: 'repository must be one of the repositories discovered in this workspace',
        })
        return
      }

      // 作用域本身也要能被查询：客户端用它决定"这份数据属于哪个仓库"。
      if (url.pathname === `${ROUTE_PREFIX}/repo-context`) {
        sendJson(
          response,
          200,
          context === undefined
            ? { isRepo: false, workspaceRoot: workspace, ...projectScopeFields(scope) }
            : { isRepo: true, ...scopeFields(context, scope) },
        )
        return
      }

      // 没有可用的仓库：所有其它路由统一回 `isRepo: false`（界面据此显示"不是 Git 仓库"），
      // 但**带上 scope**——工作区本身不是仓库、下面却有仓库时，界面要能据此进多仓库 UI，
      // 而不是一口咬定"当前项目不是 Git 项目"（1.5.2 的实机缺口）。
      if (context === undefined) {
        sendJson(response, 200, { isRepo: false, workspaceRoot: workspace, ...projectScopeFields(scope) })
        return
      }
      const cwd = context.repositoryRoot

      // ---- 记录基线：本轮开始时调用一次 ------------------------------------
      if (url.pathname === `${ROUTE_PREFIX}/baseline`) {
        if (request.method !== 'POST') {
          response.setHeader('allow', 'POST')
          sendJson(response, 405, { error: 'method not allowed' })
          return
        }
        const revision = await snapshot(cwd, sessionId)
        // 顺手把"当前侧"的常驻索引也建起来，让第一次取差异就不必再付一次全量代价。
        // 不做这一步的话，首次 add -A 要重新哈希所有变化文件（实测约 4 秒），
        // 而它发生在用户刚点开面板时——最不该等的那一刻。
        await currentTree(cwd, sessionId).catch(() => undefined)
        // 基线记的是**仓库**（不是工作区）：会话在同一个仓库里换了子目录时，本轮基线依然
        // 有效，不该被清掉重拍。
        baselines.set(sessionId, { revision, repositoryRoot: cwd, takenAt: Date.now() })
        sendJson(response, 200, { isRepo: true, revision, ...scopeFields(context, scope) })
        return
      }

      // ---- 取差异：基线 vs 当前工作区 ---------------------------------------
      if (url.pathname === `${ROUTE_PREFIX}/changes`) {
        const stored = baselines.get(sessionId)
        if (stored === undefined) {
          sendJson(response, 200, { isRepo: true, noBaseline: true })
          return
        }
        // 仓库换了（会话切了项目）：旧基线无意义，要求重新记录。
        //
        // 判据是**仓库根**而不是工作区：会话在同一个仓库里从 `repo/src` 换到 `repo/pages`
        // 时基线依然有效——那正是"同仓库切工作区不许清空 Changes"的一条。
        if (stored.repositoryRoot !== cwd) {
          sendJson(response, 200, { isRepo: true, noBaseline: true, workspaceChanged: true })
          return
        }

        // 当前侧的树：用**常驻索引**构建，git 借此跳过未变文件（见 currentTree 的说明）。
        //
        // 早先试过"先算出变化路径、只哈希它们"，但收窄没有效果：那个仓库里 tmp/ 下的
        // 6636 个日志文件其实是被 git 跟踪的（只是工作区副本未提交），因此基线快照本来
        // 就把它们算了进去，收窄集合依然是 6640 条。让索引保持热才是真正的办法。
        const current = await currentTree(cwd, sessionId)

        const [stat, names] = await Promise.all([
          git(['diff', '--numstat', stored.revision, current], cwd),
          git(['diff', '--name-status', stored.revision, current], cwd),
        ])
        // `metadataOnly`：只要"改了哪些文件、各几行"，**不要差异正文**。
        //
        // 输入框上方那个改动数字每 10 秒轮询一次，而全仓库统一差异在真实仓库里是
        // 45.9 MB / 数秒——那份正文只有在用户点开某个文件时才需要。轮询路径必须能
        // 明确地"只要元数据"，否则"后台每 10 秒重算一次全仓库差异"这件事会一直存在。
        const metadataOnly = payload.metadataOnly === true || url.searchParams.get('metadataOnly') === '1'
        const { diff, oversized } = metadataOnly
          ? { diff: '', oversized: false }
          : await readUnifiedDiff(cwd, stored.revision, current, stat.split('\n').length)
        // 索引态一并取回：会话内的"本轮修改"列表同样要能看出哪些已暂存（见 indexStates）。
        const porcelain = await git(['status', '--porcelain'], cwd).catch(() => '')

        // --numstat 给出每条文件的新增/删除行数，与 --name-status 的顺序一致。
        // 注意别把这个局部量叫 `payload`：那会**遮蔽**请求体，而同一个块作用域里的
        // `payload.metadataOnly`（见上）在声明之前就是 TDZ，整套读取直接 500。
        const described = describeDiff({ stat, names, diff })
        const states = indexStates(porcelain)
        const files = described.files.map((file) => ({
          ...file,
          ...(states.get(file.path) ?? { staged: false, unstaged: true, untracked: false }),
        }))
        sendJson(response, 200, {
          isRepo: true,
          scope: 'turn',
          revision: stored.revision,
          takenAt: stored.takenAt,
          ...scopeFields(context, scope),
          ...described,
          files,
          ...(oversized ? { diffOversized: true } : {}),
        })
        return
      }

      // ---- 仓库级**轻量**快照：文件清单 + 索引态 + 分支（项目级面板用）--------
      //
      // 与 /changes 的区别在于语义：那个回答"本轮改了什么"（基线是本轮开始时的快照），
      // 这个回答"这个项目现在有什么改动"（基线是 HEAD）。项目页还没有任何一轮对话，
      // 所以那里只能用后者。
      //
      // **这条路由是轮询路径（每 10 秒），因此只做有界的工作**：
      //   * `status --porcelain=v2 --branch -z --untracked-files=normal` 一次拿到
      //     分支/HEAD/已跟踪改动，以及**已折叠的**未跟踪条目；
      //   * `diff --numstat HEAD` 拿每个已跟踪文件的增删**行数**（不含正文，几十 KB）。
      //
      // `--untracked-files=normal`（而不是 `all`）是这一版的关键：git 会把整块未跟踪
      // 目录折叠成一条 `tmp/`，因此 6,846 个未跟踪文件在轮询里只是 1~2 条记录。完整
      // 枚举推迟到真的需要时（见 /untracked 与客户端的 inline/browse 判定）。
      // 以前它还会 `add -A` + `write-tree` 造临时索引树、再算一份**全仓库统一差异**，
      // 而右上角那个数字只需要文件个数：6,639 个改动路径的仓库上那是 4 秒 + 45.9 MB，
      // 且每 10 秒重来一次（实测就是"切过去要等很久"的根因）。
      // 单文件的逐行差异改为点了才取（见 /workspace-file）。
      if (url.pathname === `${ROUTE_PREFIX}/workspace`) {
        const [statusRaw, numstat] = await Promise.all([
          git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], cwd, undefined, GIT_MAX_BUFFER_LARGE),
          // `HEAD` 不存在（尚无提交）时这条会失败；那不是错误，只是没有可比对的基线。
          git(['diff', '--numstat', 'HEAD'], cwd).catch(() => ''),
        ])
        const parsed = parseStatusV2(statusRaw)
        // 已跟踪与未跟踪分开：未跟踪不再混在 `files` 里（那份清单要能上千条），而是走
        // `untracked` 这个有界的摘要对象。`files` 就是"已跟踪改动"（= trackedFiles）。
        const trackedEntries = parsed.files.filter((file) => file.untracked !== true)
        const untrackedEntries = parsed.files.filter((file) => file.untracked === true)
        // 尚无提交的仓库：`git diff HEAD` 会失败，`numstat` 是空串。这时不能按 numstat
        // 过滤（否则已暂存的文件会被全部丢掉），直接保留 status 的结果，由 `empty` 让界面
        // 显示"尚无提交"。
        const files = parsed.initial
          ? trackedEntries.map((file) => ({ ...file, added: null, removed: null }))
          : withLineCounts(trackedEntries, numstat)
        /**
         * 冲突文件必须**无条件**留在 `files` 里。
         *
         * `withLineCounts` 会丢掉"status 说有改动、numstat 里却没有它"的已跟踪文件——
         * 而未合并路径正是这种情形（`git diff HEAD` 对它们不产出普通的 numstat 行）。
         * 丢掉它们的后果最严重：界面上"冲突"那一组会是空的，用户在最需要看到冲突的时候
         * 什么也看不到。
         */
        const conflicts = trackedEntries.filter((file) => file.conflict === true)
        for (const entry of conflicts) {
          if (!files.some((file) => file.path === entry.path)) {
            files.push({ ...entry, added: null, removed: null })
          }
        }
        const untracked = describeUntrackedFast(cwd, untrackedEntries)
        sendJson(response, 200, {
          isRepo: true,
          scope: 'workspace',
          ...scopeFields(context, scope),
          /** 当前分支名（游离 HEAD 时为空串）。 */
          branch: parsed.branch,
          /** HEAD 的提交对象；尚无提交时为空串（`empty` 为 true）。 */
          head: parsed.head,
          detached: parsed.detached,
          upstream: parsed.upstream,
          ahead: parsed.ahead,
          behind: parsed.behind,
          // 尚无提交的仓库：没有 HEAD 可比较，界面说"改动"会误导（用户会以为文件丢了）。
          empty: parsed.initial || parsed.head === '',
          /** 已跟踪改动（等价于需求里的 `trackedFiles`）。 */
          files,
          /**
           * 未解决的冲突文件：`{ path, code }`。code 是 porcelain 的 XY（`UU`/`AA`/`DU`…），
           * 界面按它显示冲突类型。
           */
          conflicts: conflicts.map((file) => ({ path: file.path, code: file.code ?? 'UU' })),
          conflictCount: conflicts.length,
          /**
           * 进行中的操作**类型**（`merge`/`rebase`/`cherry-pick`/`revert`，没有则为空串；
           * 无标记冲突是 `stash` 或 `unmerged`）。
           *
           * 这里只给类型：冲突界面上"Current / Incoming 各是谁"由冲突标记自己写着
           * （`<<<<<<< HEAD` / `>>>>>>> feature/foo`），比让宿主再猜一遍更准。类型用来决定
           * 「提交合并 / 继续变基 / 继续摘取」与「中止」的文案和动作。
           */
          operationType: readOperationType(cwd, conflicts),
          /**
           * 未跟踪摘要：`{ count, exact, mode, collapsed, inlineFiles }`。
           *
           *   `mode: 'inline'`  少量（≤ 50）→ 界面逐行列出 `inlineFiles`
           *   `mode: 'browse'`  大量（> 50）→ 界面只显示数量 + 「浏览」，**不持有**路径
           *   `mode: 'pending'` 快路径只看到折叠目录，还不知道精确条数
           *
           * 大量模式下 `inlineFiles` 是空数组：渲染进程因此**不会**持有 6,846 条路径。
           */
          untracked,
          // 徽标用的总数：已跟踪改动 + 未跟踪条目。折叠目录存在时它是**下界**
          // （`untracked.exact === false`），界面上不该声称精确。
          changedFiles: files.length + untracked.count,
          changedFilesExact: untracked.exact,
          /**
           * 储藏条数（**不起 git 进程**，见 `countStashesFast`）。
           *
           * 它只是"该刷新储藏列表了"的信号：真正的列表走 gitbar 的 `/stash/list`。放进来
           * 是因为这个响应每 10 秒轮询一次，而在终端里 `git stash push` 之后面板应当自己
           * 更新——用一个文件的行数换掉每 10 秒一个 git 进程。
           */
          stashCount: countStashesFast(cwd),
        })
        return
      }

      // ---- 冲突：一个文件的三路内容 + 冲突块 --------------------------------
      //
      // 渲染进程既不该读 `.git`，也不该自己解析 `<<<<<<<`：索引里的三个阶段（base/ours/
      // theirs）只有宿主能取，而"接受某一侧"必须在服务端重组——那才有唯一一份实现。
      //
      // 三个阶段的语义（git 的定义，UI 必须照原样用，不能自己改叫法）：
      //   :1: = base   共同祖先（两边都是新增文件时不存在）
      //   :2: = ours   **进行中的操作**下的"我方"（merge 时是当前分支；rebase 时是变基到
      //                的那个分支——这一点与直觉相反，所以界面显示的是标记里的真实名字）
      //   :3: = theirs 对方
      if (url.pathname === `${ROUTE_PREFIX}/conflict`) {
        const filePath = payload.path ?? url.searchParams.get('path')
        if (typeof filePath !== 'string' || !SAFE_PATH_PATTERN_GRAPH.test(filePath)) {
          sendJson(response, 400, { error: 'unsafe path', code: 'unsafePath' })
          return
        }
        const target = normalizePath(filePath)
        const absolute = resolve(cwd, target)
        // 纵深防御：SAFE_PATH_PATTERN 已挡住绝对路径与 `..`，这里再确认它真的落在仓库里。
        if (absolute !== resolve(cwd) && !absolute.startsWith(`${resolve(cwd)}${sep}`)) {
          sendJson(response, 400, { error: 'path escapes repository', code: 'unsafePath' })
          return
        }
        const stageRaw = await git(['ls-files', '-u', '-z', '--', target], cwd).catch(() => '')
        const stages = parseUnmergedStages(stageRaw)
        const readStage = async (stage) => {
          if (!stages.some((entry) => entry.stage === stage)) return undefined
          return await git(['show', `:${stage}:${target}`], cwd, undefined, GIT_MAX_BUFFER).catch(() => undefined)
        }
        const [base, ours, theirs] = await Promise.all([readStage(1), readStage(2), readStage(3)])
        const worktree = readWorktreeText(absolute)
        // 冲突块从**工作区文件**里解析（那才是用户现在看到、也是要写回去的那份文本）。
        const scan = scanConflictSegments(worktree ?? '')
        // 冲突类型（`UU`/`AA`/`DU`…）只在 porcelain 的 `u` 记录里，`ls-files -u` 没有。
        const statusRaw = await git(['status', '--porcelain=v2', '-z', '--', target], cwd).catch(() => '')
        const record = statusRaw.split('\0').find((line) => line.startsWith('u '))
        const code = record === undefined ? '' : (record.split(' ')[1] ?? 'UU')
        sendJson(response, 200, {
          isRepo: true,
          ...scopeFields(context, scope),
          path: target,
          code,
          stages,
          // 三个阶段的完整文本（缺某个阶段就是 undefined：例如 AA 没有 base）。
          ...(base === undefined ? {} : { base }),
          ...(ours === undefined ? {} : { ours }),
          ...(theirs === undefined ? {} : { theirs }),
          ...(worktree === undefined ? {} : { worktree }),
          /** 冲突块（含两侧文本与标记里的原始名字）。 */
          blocks: scan.blocks,
          blockCount: scan.blocks.length,
          hasMarkers: scan.hasMarkers,
          operationType: readOperationType(cwd, [{ path: target }]),
        })
        return
      }

      // ---- 冲突：按逐块选择重组并写回 ---------------------------------------
      //
      // 表单 `{ path, resolutions?, order?, content?, markResolved?, allowMarkers? }`。
      //   resolutions  `{ 块序号: 'ours' | 'theirs' | 'both' }`，`both` 时用 order 决定先后
      //   content      直接采用这份文本（用户在 Result 里手动编辑过）
      //   markResolved true 时在**确认没有残留标记**之后 `git add` —— 也就是「标记为已解决」
      //
      // 「标记为已解决」必须校验残留标记：把带 `<<<<<<<` 的文件加进索引，会让用户以为冲突
      // 解决了，而提交里留下的是标记文本（这是最难发现的一类错误）。要强行跳过必须显式传
      // allowMarkers。
      if (url.pathname === `${ROUTE_PREFIX}/conflict-resolve`) {
        if (request.method !== 'POST') {
          response.setHeader('allow', 'POST')
          sendJson(response, 405, { error: 'method not allowed' })
          return
        }
        const filePath = payload.path
        if (typeof filePath !== 'string' || !SAFE_PATH_PATTERN_GRAPH.test(filePath)) {
          sendJson(response, 400, { error: 'unsafe path', code: 'unsafePath' })
          return
        }
        const target = normalizePath(filePath)
        const absolute = resolve(cwd, target)
        if (absolute !== resolve(cwd) && !absolute.startsWith(`${resolve(cwd)}${sep}`)) {
          sendJson(response, 400, { error: 'path escapes repository', code: 'unsafePath' })
          return
        }
        const source = typeof payload.content === 'string' ? payload.content : undefined
        const hasResolutions = payload.resolutions !== null && typeof payload.resolutions === 'object'
        const onDisk = readWorktreeText(absolute)
        if (source === undefined && onDisk === undefined && payload.markResolved !== true) {
          // 工作区里没有这个文件、也没给内容：多半是用户把它删掉了（删除也是一种解决方式），
          // 这种情况交给 `markResolved` 用 `git add` 记录删除；单独读它则是 404。
          sendJson(response, 404, { error: 'no such path', code: 'noSuchPath' })
          return
        }
        const current = source ?? onDisk ?? ''
        /**
         * 只算不写（`preview: true`）。
         *
         * 冲突解决面板里点「用当前 / 用对方 / 两者都要」只应该**立刻更新 Result 面板**，
         * 而不是顺手把工作区文件改掉——真正写回文件是「应用选择 / 保存结果 / 标记为已解决」
         * 那几步的事。因此这里复用同一套重组实现（不新增第二份"预览用"的合并逻辑），
         * 只是跳过落盘与 `git add`。
         */
        const preview = payload.preview === true
        const composed =
          source === undefined
            ? composeConflictText(current, payload.resolutions, payload.order)
            : { content: source, blocks: scanConflictSegments(source).blocks, unresolved: 0 }
        // 只有真的要改文件时才写：既没有 content 也没有 resolutions 的请求是纯读取。
        const shouldWrite = (source !== undefined || hasResolutions) && !preview
        if (shouldWrite) {
          try {
            writeFileSync(absolute, composed.content, 'utf8')
          } catch (error) {
            sendJson(response, 409, {
              error: 'cannot write file',
              code: 'writeFailed',
              detail: String(error?.message ?? error),
            })
            return
          }
        }
        // 校验以**磁盘上的内容**为准：markResolved 要挡住的正是"写进去的文件里还留着标记"。
        // 预览没有写盘，因此校验针对刚算出来的那份内容（它就是要给用户看的东西）。
        const verify = preview
          ? scanConflictSegments(composed.content)
          : scanConflictSegments(readWorktreeText(absolute) ?? composed.content)
        // 预览是**只读**的：即使请求里带上了 markResolved，也不能给一个自己没写过的文件
        // 做 `git add`。这条保证由宿主自己守（而不是指望客户端每次都记得别带这个字段）。
        const markResolved = payload.markResolved === true && !preview
        if (markResolved) {
          if (verify.hasMarkers && payload.allowMarkers !== true) {
            sendJson(response, 409, {
              error: 'conflict markers remain',
              code: 'markersRemain',
              detail: `${verify.blocks.length}`,
            })
            return
          }
          try {
            await git(['add', '--', target], cwd)
          } catch (error) {
            sendJson(response, 409, {
              error: 'stage failed',
              code: 'stageFailed',
              detail: String(error?.message ?? error),
            })
            return
          }
          invalidateUntracked(cwd)
        }
        sendJson(response, 200, {
          isRepo: true,
          ...scopeFields(context, scope),
          path: target,
          content: composed.content,
          blocks: verify.blocks,
          blockCount: verify.blocks.length,
          unresolved: composed.unresolved ?? 0,
          hasMarkers: verify.hasMarkers,
          markedResolved: markResolved,
          /** 只算不写：界面据此知道工作区文件没被改动。 */
          preview,
        })
        return
      }

      // ---- 工作区里**单个文件**的差异（点了才取）-----------------------------
      //
      // 与 /commit-file 对称：那条是"某次提交里这个文件改了什么"，这条是"工作区里这个
      // 文件相对 HEAD 改了什么"。分开的理由是**代价**：全仓库统一差异在真实仓库里是
      // 45.9 MB / 数秒，而用户一次只看一两个文件。
      //
      // 未跟踪文件不在 `git diff HEAD` 里（它还没进版本库），要用 `--no-index` 与空文件
      // 比；`--no-index` 在"有差异"时退出码是 1，那是正常结果而不是失败（见 git() 的
      // allowExit）。
      if (url.pathname === `${ROUTE_PREFIX}/workspace-file`) {
        const filePath = payload.path ?? url.searchParams.get('path')
        if (typeof filePath !== 'string' || !SAFE_PATH_PATTERN_GRAPH.test(filePath)) {
          sendJson(response, 400, { error: 'unsafe path', code: 'unsafePath' })
          return
        }
        const requested = payload.revision ?? url.searchParams.get('revision')
        const revision = typeof requested === 'string' && REVISION_PATTERN.test(requested) ? requested : 'HEAD'
        const normalized = normalizePath(filePath)
        // 路径是**仓库相对**的，因此基准是仓库根（客户端拿到的路径也来自仓库根的
        // `status`，两者同源）。
        const absolute = resolve(cwd, normalized)
        try {
          // 未跟踪文件必须**真的在工作区里**：`git diff --no-index /dev/null <缺失路径>` 会
          // 以 git 自己的错误退出，而那会被当成 500。先判一次，直接给 404。
          if (payload.untracked === true && !existsSync(absolute)) {
            sendJson(response, 404, { error: 'no such path', code: 'noSuchPath' })
            return
          }
          const result = await readWorkspaceFileDiff(cwd, revision, normalized, payload.untracked === true)
          // 差异为空**且**工作区里没有这个路径 → 这个路径不存在（状态过期、或刚被删掉），
          // 那是 404 而不是"没有改动"。`git diff HEAD -- <不存在的路径>` 本身是**成功但空**
          // 的，光看 git 的退出码分不出来。
          if (result.diff === '' && !existsSync(absolute)) {
            sendJson(response, 404, { error: 'no such path', code: 'noSuchPath' })
            return
          }
          sendJson(response, 200, { isRepo: true, path: normalized, ...scopeFields(context, scope), ...result })
        } catch (error) {
          // 路径不在仓库里（用户刚删掉、或状态已过期）：这是 404 而不是 500。
          if (/did not match|no such path|exists on disk, but not in|unknown revision|bad revision|could not access/iu.test(String(error?.message ?? error))) {
            sendJson(response, 404, { error: 'no such path', code: 'noSuchPath' })
            return
          }
          throw error
        }
        return
      }

      // ---- AI 一键补充提交信息 ----------------------------------------------
      //
      // 输入**只来自客户端勾选的那批路径**（`commitPaths`）：不是"整个工作区"。这一条是
      // 权限与成本两方面的硬要求——用户没勾的文件不该出现在提示词里，而大仓库的整树 diff
      // 也不是一条辅助请求能承受的。
      //
      // 生成走宿主正式能力（见 lib/commit-message.js 的说明），失败时给**稳定的 code**，
      // 由界面显示成一句非阻塞提示；这里绝不 500（那会让界面以为插件坏了）。
      if (url.pathname === `${ROUTE_PREFIX}/commit-message`) {
        if (request.method !== 'POST') {
          response.setHeader('allow', 'POST')
          sendJson(response, 405, { error: 'method not allowed' })
          return
        }
        if (typeof onCommitMessage !== 'function') {
          sendJson(response, 501, { error: 'ai unavailable', code: 'aiUnavailable', detail: '宿主没有装载 AI 补充能力' })
          return
        }
        const requested = Array.isArray(payload.files) ? payload.files : []
        if (requested.length === 0) {
          sendJson(response, 400, { error: 'files is required', code: 'noFiles' })
          return
        }
        // 形状校验：路径只能是仓库内的相对路径（与还原同一套规则）。**逐个校验而不是
        // 只校验前 N 个**——上限之外的那些根本不该被接受。
        const files = []
        for (const item of requested) {
          const path = typeof item === 'string' ? item : item?.path
          if (typeof path !== 'string' || !SAFE_PATH_PATTERN.test(path)) {
            sendJson(response, 400, { error: `unsafe path: ${String(path).slice(0, 80)}`, code: 'unsafePath' })
            return
          }
          files.push({
            path: normalizePath(path),
            status: typeof item?.status === 'string' ? item.status.slice(0, 4) : '',
            added: Number.isFinite(item?.added) ? item.added : undefined,
            removed: Number.isFinite(item?.removed) ? item.removed : undefined,
            untracked: item?.untracked === true,
          })
        }
        const revision = REVISION_PATTERN.test(String(payload.revision ?? '')) ? payload.revision : 'HEAD'
        // 名字不要叫 `context`：外层那个 `context` 是仓库作用域，同名会遮蔽它。
        const commitContext = await collectCommitContext({
          branch: payload.branch,
          files,
          readDiff: (path, untracked) => readWorkspaceFileDiff(cwd, revision, path, untracked),
        })
        try {
          const result = await onCommitMessage(commitContext)
          sendJson(response, 200, {
            isRepo: true,
            ...scopeFields(context, scope),
            message: result.message,
            subject: result.subject,
            bullets: result.bullets,
            model: result.model,
            stats: result.promptStats,
            // 模型达到了输出预算但仍然给出了可用文本：**这是成功**，只是要告诉界面
            // "这份内容是截断的"，让它显示一条非阻塞提示（不是红色失败）。
            ...(result.truncated === true ? { truncated: true } : {}),
            ...(typeof result.finishReason === 'string' && result.finishReason !== '' ? { finishReason: result.finishReason } : {}),
          })
        } catch (error) {
          const code = typeof error?.code === 'string' ? error.code : 'aiFailed'
          // 能力缺失是 501（"宿主没这个能力"），调用失败是 502（"有这个能力但这次没成"）。
          const status = code === 'aiUnavailable' ? 501 : 502
          sendJson(response, status, {
            error: String(error?.message ?? error).slice(0, 300),
            code,
            detail: String(error?.message ?? error).slice(0, 500),
            ...(Array.isArray(error?.missing) ? { missing: error.missing } : {}),
          })
        }
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
          // 基线记在**仓库**上：会话在同一个仓库里换了子目录时基线依然适用。
          if (stored === undefined || stored.repositoryRoot !== cwd) {
            sendJson(response, 400, { error: 'no baseline recorded for this turn', code: 'noBaseline' })
            return
          }
          source = stored.revision
        } else {
          source = (await git(['rev-parse', 'HEAD'], cwd)).trim()
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
            await git(['cat-file', '-e', `${source}:${path}`], cwd)
          } catch {
            existsInSource = false
          }
          if (existsInSource) {
            await git(['restore', '--source', source, '--worktree', '--', path], cwd)
            restored.push(path)
          } else {
            // 工作区里若确实存在就删掉；不存在则视为已经还原。
            const absolute = resolve(cwd, path)
            if (existsSync(absolute)) rmSync(absolute, { force: true })
            deleted.push(path)
          }
        }
        // 还原会改工作区：未跟踪清单（新增文件被删掉）必须重数。
        invalidateUntracked(cwd)
        sendJson(response, 200, { isRepo: true, ...scopeFields(context, scope), restored, deleted, source })
        return
      }

      // ---- 提交历史：项目级面板用 -------------------------------------------
      //
      // 项目面板只显示"当前有什么改动"不够——用户还需要"最近发生过什么"。这里给出
      // 最近的提交记录。之所以放在本插件（而不是新开一个），是因为它服务于同一块面板，
      // 且同样需要"只读、按工作区解析"这两条既有约束。
      if (url.pathname === `${ROUTE_PREFIX}/history`) {
        const limitRaw = Number(payload.limit ?? 20)
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 100) : 20
        // %x1f（单元分隔符）与 %x1e（记录分隔符）——用它们而不是 \t/\n，因为提交标题
        // 里可能含制表符，而 author 名里可能含各种空白。
        const raw = await git(
          ['log', `-${limit}`, '--date=short', '--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1e'],
          cwd,
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
          await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).catch(() => '')
        ).trim()
        sendJson(response, 200, { isRepo: true, ...scopeFields(context, scope), branch, commits })
        return
      }

      // ---- 提交历史图：一页提交（含父提交与 refs）--------------------------
      //
      // 与 /history 的区别：那个是"最近发生了什么"的扁平列表（只给标题与作者），
      // 这个是**画图**用的——必须带 `%p`（父提交，决定连线）与 `%D`（refs，决定分支
      // 标签与"当前分支"），并且必须分页。两条路由都保留：侧栏"更改"区块用 /history，
      // 主区域的提交图用 /graph。
      if (url.pathname === `${ROUTE_PREFIX}/graph`) {
        const limitRaw = Number(payload.limit ?? url.searchParams.get('limit') ?? GRAPH_PAGE_DEFAULT)
        const skipRaw = Number(payload.skip ?? url.searchParams.get('skip') ?? 0)
        const limit = Number.isFinite(limitRaw) ? limitRaw : GRAPH_PAGE_DEFAULT
        const skip = Number.isFinite(skipRaw) ? skipRaw : 0
        const ref = payload.ref ?? url.searchParams.get('ref') ?? ''
        const page = await readGraph(cwd, { limit, skip, ref })
        if (page.invalidRef === true) {
          sendJson(response, 400, { error: 'invalid ref', code: 'invalidRef' })
          return
        }
        // 当前分支单独给一次：客户端要在图里高亮"HEAD 所在的分支名"，
        // 而 `%D` 只在**恰好有 ref 指向的提交**上带这个信息，当前分支的尖端之外拿不到。
        const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).catch(() => '')).trim()
        sendJson(response, 200, {
          isRepo: true,
          ...scopeFields(context, scope),
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
        const revision = payload.revision ?? url.searchParams.get('revision')
        if (typeof revision !== 'string' || !REVISION_PATTERN.test(revision)) {
          sendJson(response, 400, { error: 'invalid revision', code: 'invalidRevision' })
          return
        }
        try {
          sendJson(response, 200, { isRepo: true, ...scopeFields(context, scope), ...(await readCommit(cwd, revision)) })
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
        const result = await readCommitFileDiff(cwd, revision, filePath)
        sendJson(response, 200, { isRepo: true, ...scopeFields(context, scope), path: filePath, ...result })
        return
      }

      // ---- 两个修订之间的比较（提交 ↔ 当前、提交 A ↔ B、分支 ↔ 当前）----------
      //
      // 比较**不引入第二套差异实现**：文件清单是 `git diff --name-status`，单文件差异走
      // `/compare-file`（与 `/commit-file` 同一个渲染器，只是两端由调用方给出）。
      if (url.pathname === `${ROUTE_PREFIX}/compare`) {
        const a = await resolveCompareRevision(cwd, payload.a ?? url.searchParams.get('a'))
        const b = await resolveCompareRevision(cwd, payload.b ?? url.searchParams.get('b'))
        if (a === undefined || b === undefined) {
          sendJson(response, 404, { error: 'no such revision', code: 'noSuchRevision' })
          return
        }
        const [headerA, headerB, comparison] = await Promise.all([readCommitHeader(cwd, a), readCommitHeader(cwd, b), readComparison(cwd, a, b)])
        sendJson(response, 200, {
          isRepo: true,
          ...scopeFields(context, scope),
          a: headerA,
          b: headerB,
          same: a === b,
          onlyA: comparison.onlyA,
          onlyB: comparison.onlyB,
          files: comparison.files,
          fileCount: comparison.files.length,
        })
        return
      }
      if (url.pathname === `${ROUTE_PREFIX}/compare-file`) {
        const a = await resolveCompareRevision(cwd, payload.a ?? url.searchParams.get('a'))
        const b = await resolveCompareRevision(cwd, payload.b ?? url.searchParams.get('b'))
        const filePath = payload.path ?? url.searchParams.get('path')
        if (a === undefined || b === undefined) {
          sendJson(response, 404, { error: 'no such revision', code: 'noSuchRevision' })
          return
        }
        if (typeof filePath !== 'string' || !SAFE_PATH_PATTERN_GRAPH.test(filePath)) {
          sendJson(response, 400, { error: 'unsafe path', code: 'unsafePath' })
          return
        }
        const result = await readCompareFileDiff(cwd, a, b, filePath)
        sendJson(response, 200, { isRepo: true, ...scopeFields(context, scope), path: normalizePath(filePath), a, b, ...result })
        return
      }

      // ---- 储藏：内容清单与单个文件的差异 ------------------------------------
      //
      // 只读，且**只做"一个储藏里有什么"**：列表与所有写操作都在 gitbar 宿主里（那里也是
      // `refs/stash` 的唯一所有者）。差异本身复用 `readCommitFileDiff`——储藏就是一个提交，
      // 所以"查看储藏里的改动"与"查看一次提交里的改动"是同一件事，不另建一套差异实现。
      if (url.pathname === `${ROUTE_PREFIX}/stash/show`) {
        const ref = payload.ref ?? url.searchParams.get('ref')
        const sha = await resolveStashRef(cwd, ref)
        if (sha === undefined) {
          sendJson(response, 404, { error: 'no such stash', code: 'noSuchStash' })
          return
        }
        const { files, hasUntracked } = await readStashFiles(cwd, sha)
        sendJson(response, 200, {
          isRepo: true,
          ...scopeFields(context, scope),
          ref: String(ref).trim(),
          sha,
          hasUntracked,
          files,
          fileCount: files.length,
        })
        return
      }
      if (url.pathname === `${ROUTE_PREFIX}/stash-file`) {
        const ref = payload.ref ?? url.searchParams.get('ref')
        const filePath = payload.path ?? url.searchParams.get('path')
        const sha = await resolveStashRef(cwd, ref)
        if (sha === undefined) {
          sendJson(response, 404, { error: 'no such stash', code: 'noSuchStash' })
          return
        }
        if (typeof filePath !== 'string' || !SAFE_PATH_PATTERN_GRAPH.test(filePath)) {
          sendJson(response, 400, { error: 'unsafe path', code: 'unsafePath' })
          return
        }
        const result = await readStashFileDiff(cwd, sha, filePath)
        if (result === undefined) {
          sendJson(response, 404, { error: 'no such path in stash', code: 'noSuchPath' })
          return
        }
        sendJson(response, 200, { isRepo: true, ...scopeFields(context, scope), ref: String(ref).trim(), path: normalizePath(filePath), ...result })
        return
      }

      // ---- 仓库状态：已跟踪改动与未跟踪文件分开两组 --------------------------
      //
      // 与 /workspace 的区别：那个给的是"基线树 vs 工作区"的**差异内容**（用来渲染
      // 逐行 diff），这个给的是 git 视角的**状态分类**（索引态/工作区态、未跟踪、以及
      // 冲突态）。界面上"已跟踪更改"与"未跟踪文件"要分成两个区块，而分类只有
      // `status --porcelain` 能准确给出——从差异内容反推分类会在重命名、删除等情形上出错。
      //
      // 未跟踪清单**不再整份塞进响应**：实测过 6,846 个未跟踪文件，每次轮询都拖着这样
      // 一份长列表正是本轮要消灭的开销。这里只给数量与模式，完整清单走 /untracked。
      if (url.pathname === `${ROUTE_PREFIX}/status`) {
        const raw = await git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], cwd, undefined, GIT_MAX_BUFFER_LARGE)
        const parsed = parseStatusV2(raw)
        const tracked = parsed.files.filter((entry) => entry.untracked !== true)
        const untrackedEntries = parsed.files.filter((entry) => entry.untracked === true)
        const untracked = describeUntrackedFast(cwd, untrackedEntries)
        sendJson(response, 200, {
          isRepo: true,
          ...scopeFields(context, scope),
          branch: parsed.branch,
          head: parsed.head,
          detached: parsed.detached,
          tracked,
          trackedCount: tracked.length,
          untrackedCount: untracked.count,
          untracked,
          changedFiles: tracked.length + untracked.count,
        })
        return
      }

      // ---- 未跟踪文件：精确枚举 + 惰性目录树 ---------------------------------
      //
      // 这是**唯一**会做完整枚举的地方，而它只在三种情况下被调用：
      //   1. 用户打开 Changes，需要精确判定 inline（≤ 50）/ browse（> 50）；
      //   2. 用户点了「浏览」（按 prefix 取直接子节点，一次只返回一层）；
      //   3. 写操作之后（缓存已被 invalidate，客户端会带 force）。
      // 常驻的 `/workspace` 轮询**绝不**走到这里。
      //
      // 请求形状：
      //   `{ exact: true }`           → 精确条数 + 模式（inline 时带完整 inlineFiles）
      //   `{ prefix, offset, limit }` → 该目录的直接子节点（lazy tree + 分页）
      //   `{ force: true }`           → 忽略缓存重枚举
      if (url.pathname === `${ROUTE_PREFIX}/untracked`) {
        const force = payload.force === true || url.searchParams.get('force') === '1'
        const snapshotUntracked = await readUntracked(cwd, { force })
        const total = snapshotUntracked.paths.length
        const mode = total <= UNTRACKED_INLINE_LIMIT ? 'inline' : 'browse'
        const prefix = String(payload.prefix ?? url.searchParams.get('prefix') ?? '')
        const offsetRaw = Number(payload.offset ?? url.searchParams.get('offset') ?? 0)
        const limitRaw = Number(payload.limit ?? url.searchParams.get('limit') ?? UNTRACKED_PAGE_DEFAULT)
        const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.trunc(offsetRaw)) : 0
        const limit = Number.isFinite(limitRaw)
          ? Math.min(Math.max(Math.trunc(limitRaw), 1), UNTRACKED_PAGE_MAX)
          : UNTRACKED_PAGE_DEFAULT
        const page = listUntrackedChildren(snapshotUntracked.tree, prefix, offset, limit)
        if (page === undefined) {
          sendJson(response, 404, { error: 'no such directory', code: 'noSuchPrefix' })
          return
        }
        // inline 模式才给完整清单（含精确新增行数）；browse 模式给空数组，渲染进程因此
        // 不会持有几千条路径。
        const inlineFiles =
          mode === 'inline' ? countUntrackedLines(cwd, snapshotUntracked.paths.map(untrackedEntry)) : []
        sendJson(response, 200, {
          isRepo: true,
          ...scopeFields(context, scope),
          total,
          mode,
          exact: true,
          cached: snapshotUntracked.cached,
          updatedAt: snapshotUntracked.at,
          inlineFiles,
          /** 目录树的一层（`prefix` 为空时就是仓库根的直接子节点）。 */
          tree: page,
          /** 兼容旧形状：少量模式下给完整清单（字典序）；大量模式下是空数组。 */
          paths: mode === 'inline' ? snapshotUntracked.paths : [],
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
        const staging = url.pathname.endsWith('/stage')
        /**
         * 「加入 Git」里勾了**全选**时的一种特殊形状：`{ all: 'untracked' }`。
         *
         * 为什么不让客户端把那几千条路径发回来：需求十五/二十.2 明确要求渲染进程**不持有**
         * 那些路径。这里由 host 用它自己那份（本来就有的）完整清单去 add，客户端只发一个
         * 字符串。这也顺手避免了"2 MiB 的请求体"这条路。
         */
        const stageAllUntracked = staging && payload.all === 'untracked'
        const requestedPaths = Array.isArray(payload.paths) ? payload.paths : []
        if (requestedPaths.length === 0 && !stageAllUntracked) {
          sendJson(response, 400, { error: 'paths is required', code: 'noPaths' })
          return
        }
        const bad = requestedPaths.find((item) => typeof item !== 'string' || !SAFE_PATH_PATTERN_GRAPH.test(item))
        if (bad !== undefined) {
          sendJson(response, 400, { error: `unsafe path: ${String(bad).slice(0, 80)}`, code: 'unsafePath' })
          return
        }
        let normalized = requestedPaths.map(normalizePath)
        let addMode = ''
        try {
          if (staging) {
            if (stageAllUntracked) {
              // 强制重数一次：用户点的是"把现在这些全加进去"，用旧缓存会把刚创建的文件漏掉。
              const all = await readUntracked(cwd, { force: true })
              normalized = all.paths
              if (normalized.length === 0) {
                sendJson(response, 200, { isRepo: true, ...scopeFields(context, scope), staged: [], stagedCount: 0 })
                return
              }
            }
            // 大批量路径（「浏览」里全选几千个未跟踪文件）必须走有界的 add：见 addPaths。
            addMode = (await addPaths(cwd, normalized)).mode
          } else {
            // 仓库尚无 HEAD 时 `restore --staged` 没有源可恢复，用 `rm --cached`：
            // 那正是"把这个文件从索引里去掉、但保留工作区文件"的语义。
            const hasHead = (await git(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd).then(() => true).catch(() => false))
            if (hasHead) await git(['restore', '--staged', '--', ...normalized], cwd)
            else await git(['rm', '--cached', '--quiet', '--', ...normalized], cwd)
          }
        } catch (error) {
          sendJson(response, 409, {
            error: staging ? 'stage failed' : 'unstage failed',
            code: staging ? 'stageFailed' : 'unstageFailed',
            detail: String(error?.message ?? error),
          })
          return
        }
        // 索引变了 → 未跟踪清单（以及"这个文件还是未跟踪吗"）立刻过期。
        invalidateUntracked(cwd)
        sendJson(response, 200, {
          isRepo: true,
          ...scopeFields(context, scope),
          ...(addMode === '' ? {} : { addMode }),
          staged: staging ? normalized : [],
          stagedCount: staging ? normalized.length : 0,
          unstaged: staging ? [] : normalized,
        })
        return
      }

      if (url.pathname === `${ROUTE_PREFIX}/commit`) {
        if (request.method !== 'POST') {
          response.setHeader('allow', 'POST')
          sendJson(response, 405, { error: 'method not allowed' })
          return
        }
        const message = typeof payload.message === 'string' ? payload.message.trim() : ''
        if (message === '') {
          // 空提交信息是 git 自己也会拒绝的，但那会回一个英文长句；这里先挡掉并给出
          // 稳定 code，界面才能说"请填写提交信息"。
          sendJson(response, 400, { error: 'empty message', code: 'emptyMessage' })
          return
        }
        // ---- 可选的"只提交这些文件" ------------------------------------------
        //
        // 界面上的勾选框要能挑着提交（IDEA 的提交对话框就是这样）。做法是先把选中的路径
        // `git add` 进索引再提交——**只 add 选中的那些**，其余不碰。
        //
        // 路径必须逐个过形状校验：这是"客户端能提供路径"的第三个入口（前两个是 revert 与
        // stage），规则与它们一致——只接受仓库内的相对路径、挡掉绝对路径与 `..`。
        const commitPaths = Array.isArray(payload.paths) ? payload.paths : []
        if (commitPaths.length > 0) {
          const bad = commitPaths.find((item) => typeof item !== 'string' || !SAFE_PATH_PATTERN.test(item))
          if (bad !== undefined) {
            sendJson(response, 400, { error: `unsafe path: ${String(bad).slice(0, 80)}`, code: 'unsafePath' })
            return
          }
          try {
            // 与 /stage 同一条有界路径：勾选的文件可能有几千个（「浏览」里全选）。
            await addPaths(cwd, commitPaths)
          } catch (error) {
            sendJson(response, 409, {
              error: 'stage failed',
              code: 'stageFailed',
              detail: String(error?.message ?? error),
            })
            return
          }
        }

        // 暂存区为空时 git 会以非零退出（"nothing to commit"）。提前判掉，并区分
        // "没有任何改动"与"有改动但没暂存"——这两种情况该给用户的下一步完全不同。
        const statusRaw = await git(['status', '--porcelain'], cwd)
        const { tracked } = parsePorcelain(statusRaw)
        const staged = tracked.filter((entry) => entry.index !== ' ' && entry.index !== '?')
        /**
         * 修改最后一次提交（`git commit --amend`）。
         *
         * 三件事必须分开看，它们决定了这里与普通提交的三处不同：
         *   1. **不要求暂存区非空**：只改提交信息是完全正常的用法（"标题写错了"），而
         *      `--amend` 在没有暂存内容时照样工作；
         *   2. **两者都没变就要拒绝**：信息与 HEAD 一样、暂存区又是空的，那么 `--amend`
         *      只会改写 committer 时间、换一个 SHA（如果这个提交已经推送过，那就白白造成了
         *      "历史被改写"），对用户没有任何价值。因此提前回 `nothingToAmend`；
         *   3. **只动 HEAD**：`--amend` 的语义就是替换最后一次提交，更早的历史一个字都不碰
         *      （这是它和 rebase 的分界线，也是这个功能敢放在提交框旁边的理由）。
         */
        const amend = payload.amend === true
        if (amend) {
          const headExists = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd).then(() => true).catch(() => false)
          if (!headExists) {
            sendJson(response, 409, { error: 'no commit to amend', code: 'noCommitToAmend' })
            return
          }
          const headMessage = String(await git(['log', '-1', '--format=%B'], cwd).catch(() => '')).replace(/\n$/u, '')
          if (staged.length === 0 && headMessage.trim() === message) {
            sendJson(response, 409, { error: 'nothing to amend', code: 'nothingToAmend' })
            return
          }
        } else if (staged.length === 0) {
          sendJson(response, 409, {
            error: 'nothing staged',
            code: tracked.length > 0 ? 'nothingStaged' : 'nothingToCommit',
          })
          return
        }
        try {
          // `-F -` 从标准输入读提交信息太绕；这里用 `-m`，它是参数数组里的一个元素，
          // 不会被 shell 解释。多行信息由 `-m` 重复传递，但界面只给单行，因此不需要。
          await git(amend ? ['commit', '--amend', '-m', message] : ['commit', '-m', message], cwd)
        } catch (error) {
          sendJson(response, 409, {
            error: 'commit failed',
            code: 'commitFailed',
            detail: String(error?.message ?? error),
          })
          return
        }
        const head = (await git(['rev-parse', 'HEAD'], cwd).catch(() => '')).trim()

        // ---- 可选的"提交并推送" ----------------------------------------------
        //
        // 与 IDEA 的 Commit and Push 对应。推送**失败不算提交失败**：提交已经落到本地历史
        // 里了，把两者混在一个错误里会让用户以为什么都没发生，进而重复提交一次。
        // 因此成功时回 `pushed: true`，推送失败时回 `pushed: false` + `pushError`，
        // HTTP 仍是 200——界面据此显示"已提交，但推送失败：…"。
        let pushed
        let pushError
        if (payload.push === true) {
          try {
            // 不加远端与分支：用仓库自己的上游配置（`git push` 的默认行为）。
            // 指定远端会把"该推到哪"这个决定从用户的 git 配置里抢过来。
            await git(['push'], cwd, undefined, GIT_MAX_BUFFER, GIT_NETWORK_TIMEOUT_MS)
            pushed = true
          } catch (error) {
            pushed = false
            pushError = String(error?.message ?? error)
          }
        }

        // 提交动了索引与 HEAD：未跟踪清单必须重数（刚提交的那些文件不再是未跟踪）。
        invalidateUntracked(cwd)
        sendJson(response, 200, {
          isRepo: true,
          ...scopeFields(context, scope),
          committed: true,
          // 让界面知道这是一次 amend（提示语要说"已修改最后一次提交"，而不是"已提交"）。
          amended: amend,
          head,
          ...(pushed === undefined ? {} : { pushed }),
          ...(pushError === undefined ? {} : { pushError }),
        })
        return
      }

      // ---- 单个文件的变更记录（点文件看历史）--------------------------------
      //
      // 对应 IDEA 文件行右侧的"显示历史"。用 `--follow`：重命名之后仍然能追到改名前的
      // 提交，否则历史会在改名那一处断掉——而那正是用户最想看的"这个文件原来是什么"。
      if (url.pathname === `${ROUTE_PREFIX}/file-history`) {
        const filePath = payload.path ?? url.searchParams.get('path')
        if (typeof filePath !== 'string' || !SAFE_PATH_PATTERN.test(filePath)) {
          sendJson(response, 400, { error: 'unsafe path', code: 'unsafePath' })
          return
        }
        const limitRaw = Number(payload.limit ?? url.searchParams.get('limit') ?? 20)
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 100) : 20
        let raw
        try {
          raw = await git(
            [
              'log',
              '--follow',
              '--no-abbrev',
              `--max-count=${limit}`,
              '--date=short',
              '--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1e',
              '--',
              filePath.replace(/\\/gu, '/'),
            ],
            cwd,
          )
        } catch (error) {
          // 未跟踪的文件没有历史，这不是错误：返回空列表，界面显示"尚无提交记录"。
          if (/does not have any commits|unknown revision|bad revision/iu.test(String(error?.message ?? error))) {
            sendJson(response, 200, { isRepo: true, ...scopeFields(context, scope), path: filePath, commits: [] })
            return
          }
          throw error
        }
        const commits = raw
          .split('\x1e')
          .map((record) => record.replace(/^\n/u, ''))
          .filter((record) => record.trim() !== '')
          .map((record) => {
            const [hash, short, author, date, ...rest] = record.split('\x1f')
            return {
              hash: String(hash ?? '').trim(),
              short: String(short ?? '').trim(),
              author: String(author ?? '').trim(),
              date: String(date ?? '').trim(),
              subject: rest.join('\x1f').trim(),
            }
          })
        sendJson(response, 200, { isRepo: true, ...scopeFields(context, scope), path: filePath, commits })
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

  const handler = createReviewHandler(ctx)
  for (const path of [
    `${ROUTE_PREFIX}/repo-context`,
    `${ROUTE_PREFIX}/project-git-scope`,
    `${ROUTE_PREFIX}/baseline`,
    `${ROUTE_PREFIX}/changes`,
    `${ROUTE_PREFIX}/workspace`,
    `${ROUTE_PREFIX}/workspace-file`,
    `${ROUTE_PREFIX}/conflict`,
    `${ROUTE_PREFIX}/conflict-resolve`,
    `${ROUTE_PREFIX}/commit-message`,
    `${ROUTE_PREFIX}/revert`,
    `${ROUTE_PREFIX}/history`,
    `${ROUTE_PREFIX}/roots`,
    `${ROUTE_PREFIX}/graph`,
    `${ROUTE_PREFIX}/commit-detail`,
    `${ROUTE_PREFIX}/commit-file`,
    `${ROUTE_PREFIX}/compare`,
    `${ROUTE_PREFIX}/compare-file`,
    `${ROUTE_PREFIX}/stash/show`,
    `${ROUTE_PREFIX}/stash-file`,
    `${ROUTE_PREFIX}/file-history`,
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
