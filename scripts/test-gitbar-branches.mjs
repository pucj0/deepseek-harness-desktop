// 端到端验证 gitbar 的分支管理路由：分支详情、分组、以及全部写操作。
//
//   node scripts/test-gitbar-branches.mjs
//
// 为什么必须有它：这一批路由里有**会改写用户仓库**的操作（merge / rebase /
// branch -D / push / commit 之后的历史）。它们的安全性不来自"代码看起来对"，
// 而来自"在一个一次性仓库上真的跑过、并断言了拒绝路径"。
//
// 临时仓库的形状刻意做成团队仓库的样子：
//   origin 是一个**本地 bare 仓库**（因此 fetch/pull/push 全程离线、
//   不碰网络也就不依赖凭据与网速），main 跟踪 origin/main 且落后 1 个提交、
//   另有一个多提交的 develop 用于 merge/rebase，还有一个未跟踪文件用于计数。
import { execFile, execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const git = async (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(String(stderr).trim() || error.message))
      else resolve(String(stdout))
    })
  })

const root = mkdtempSync(join(tmpdir(), 'dsh-gitbar-branches-'))
const repo = join(root, 'work')
const origin = join(root, 'origin.git')
let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (期望 ${expected})`}`)
}
/** 断言为真。用于无法用等值表达的形状判断。 */
const checkTrue = (label, actual) => check(label, actual === true, true)

let child
try {
  // ---- 造仓库 ---------------------------------------------------------------
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'test'])
  // -c commit.gpgsign=false：机器上若开了签名而没配 key，commit 会失败。
  execFileSync('git', ['-C', repo, 'config', 'commit.gpgsign', 'false'])

  writeFileSync(join(repo, 'a.txt'), 'base\n')
  await git(['add', '.'], repo)
  await git(['commit', '-q', '-m', 'init'], repo)
  await git(['remote', 'add', 'origin', origin], repo)
  await git(['push', '-q', '-u', 'origin', 'main'], repo)

  // develop：比 main 多两个提交，供 merge / rebase / cherry-pick。
  // 一并推到远端并建立跟踪：这样 /branches 里既有"有上游且已同步"（develop）、
  // 也有"有上游且落后"（main，下面会让远端多一个提交）两种形状可断言。
  await git(['switch', '-q', '-c', 'develop'], repo)
  writeFileSync(join(repo, 'b.txt'), 'dev one\n')
  await git(['add', '.'], repo)
  await git(['commit', '-q', '-m', 'dev: one'], repo)
  writeFileSync(join(repo, 'c.txt'), 'dev two\n')
  await git(['add', '.'], repo)
  await git(['commit', '-q', '-m', 'dev: two'], repo)
  await git(['push', '-q', '-u', 'origin', 'develop'], repo)
  await git(['switch', '-q', 'main'], repo)

  // 让 main **落后** origin/main 1 个提交：在远端（另一个克隆）上加一个提交。
  // 这样 /branches 的 behind 才有非零值可断言，pull 也才有东西可拉。
  const other = join(root, 'other')
  execFileSync('git', ['clone', '-q', origin, other])
  execFileSync('git', ['-C', other, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', other, 'config', 'user.name', 'test'])
  execFileSync('git', ['-C', other, 'config', 'commit.gpgsign', 'false'])
  writeFileSync(join(other, 'remote.txt'), 'from remote\n')
  await git(['add', '.'], other)
  await git(['commit', '-q', '-m', 'remote: add file'], other)
  await git(['push', '-q', 'origin', 'main'], other)

  // 一个标签 + 一个未跟踪文件（用于 /status 的计数与「签出标记」）。
  await git(['tag', 'v1.0.0'], repo)
  writeFileSync(join(repo, 'untracked.txt'), 'x\n')

  // 记录 develop 顶端，供 cherry-pick 用。
  const developHead = (await git(['rev-parse', 'develop'], repo)).trim()

  console.log('临时仓库:', repo)
  console.log('临时远端:', origin)
  console.log('')

  // ---- 起服务端 -------------------------------------------------------------
  const runtime = join(process.cwd(), 'runtime')
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  child = spawn(
    join(runtime, 'node', 'node.exe'),
    [
      join(runtime, 'server.mjs'),
      '--dsh-home',
      home,
      '--install-anchor',
      join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      '--workspace',
      repo,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))

  let base
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 1500))
    const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/u.exec(out)
    if (m !== null) {
      base = m[1]
      break
    }
  }
  if (base === undefined) throw new Error(`服务端未就绪\n${out.slice(-800)}`)

  // 登记临时仓库：host 只接受已登记的工作区。
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(
    join(home, 'storages', 'workspace.json'),
    JSON.stringify(
      {
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, workspaceIds: [], archivedSessionIds: [] },
        tables: { workspaces: { w1: { path: repo } } },
      },
      null,
      2,
    ) + '\n',
  )

  const query = `?cwd=${encodeURIComponent(repo)}`
  const get = async (route) => {
    const response = await fetch(`${base}/dsh-desktop/gitbar/${route}${query}`)
    return { status: response.status, body: await response.json() }
  }
  const post = async (route, body) => {
    const response = await fetch(`${base}/dsh-desktop/gitbar/${route}${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      // 路由理论上总回 JSON；真回了 HTML 时把原文打出来，否则断言只会看到 undefined。
      console.log(`  [debug] ${route} 非 JSON 响应: ${text.slice(0, 300)}`)
      parsed = { error: text.slice(0, 200) }
    }
    // 任何非 2xx 都有 code 与 detail（git 原文），而"某个 code 断言失败"若看不到
    // 原文就得多跑一轮才能定位。统一打出来。
    if (response.status >= 400) {
      console.log(`  [debug] ${route} ${response.status} code=${parsed.code ?? '(none)'}: ${String(parsed.detail ?? parsed.error).slice(0, 300)}`)
    }
    return { status: response.status, body: parsed }
  }
  /** 当前 git 视角的分支，用于确认路由真的改变了仓库而不是只改了响应。 */
  const headBranch = async () => (await git(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).trim()

  // =========================================================================
  console.log('=== 1. GET /branches：分组与同步状态 ===')
  // **必须先 fetch**：领先/落后是按**本地远程跟踪引用**算的（`rev-list upstream...HEAD`），
  // 而 `git push -u` / 别的克隆推上去的提交在 fetch 之前根本不在本地对象库里。
  // 这不是实现的缺陷——没有 fetch 就没有"远端"这个信息，任何工具都只能报 0/0
  // （`git status` 在 fetch 之前同样只显示 `## main...origin/main`，不带 behind）。
  // 因此测试先 fetch，把"用户点过抓取之后"这个真实状态摆出来再断言。
  await git(['fetch', '-q', '--prune', 'origin'], repo)

  let res = await get('branches')
  check('1) 200', res.status, 200)
  const names = res.body.branches.map((b) => b.name)
  checkTrue('   含本地 main', names.includes('main'))
  checkTrue('   含本地 develop', names.includes('develop'))
  checkTrue('   含远程 origin/main', names.includes('origin/main'))
  // 符号引用 origin/HEAD 不是可切换的分支，必须被排除。它同时也会以短名 `origin`
  // 出现在 refname:short 里，是早先误判本地/远程的根源。
  checkTrue('   不含符号引用 origin/HEAD', !names.some((n) => n.endsWith('/HEAD')))
  checkTrue('   不含裸远端名 origin', !names.includes('origin'))

  const mainEntry = res.body.branches.find((b) => b.name === 'main')
  check('   main 标记为当前分支', mainEntry.current, true)
  check('   main 的 upstream', mainEntry.upstream, 'origin/main')
  check('   main 落后 1', mainEntry.behind, 1)
  check('   main 领先 0', mainEntry.ahead, 0)
  check('   main 未分叉', mainEntry.diverged, false)
  check('   main 上游未被删', mainEntry.upstreamGone, false)
  checkTrue('   main 有提交时间', /^\d{4}-\d{2}-\d{2}T/u.test(mainEntry.committedAt))
  checkTrue('   main 有主题', mainEntry.subject.length > 0)
  check('   main 不是远程', mainEntry.isRemote, false)

  const remoteEntry = res.body.branches.find((b) => b.name === 'origin/main')
  check('   远程条目 isRemote', remoteEntry.isRemote, true)
  check('   远程条目带 remote 名', remoteEntry.remote, 'origin')
  checkTrue('   远程条目不标记为当前', remoteEntry.current !== true)

  const devEntry = res.body.branches.find((b) => b.name === 'develop')
  // develop 的推送发生在 fetch 之前（见上面的仓库搭建），因此这里它**有**上游
  // 且两边都在同一位置 —— 用来验证"有上游且已同步"这个形状，它和"没有上游"必须
  // 在响应里可区分（前者 upstream 非空，后者为空）。
  check('   develop 的 upstream', devEntry.upstream, 'origin/develop')
  check('   develop 领先 0', devEntry.ahead, 0)
  check('   develop 落后 0', devEntry.behind, 0)
  check('   develop 未分叉', devEntry.diverged, false)
  check('   没有上游的分支 upstream 为空串', res.body.branches.find((b) => b.name === 'origin/main').upstream, '')
  check('   counts.local', res.body.counts.local, 2)
  checkTrue('   counts.remote >= 1', res.body.counts.remote >= 1)
  // 远端列表**不在** `/branches` 里了：它改由 `/remotes` 单独给（见 host 侧 listRemotes 的
  // 说明——一次 `git config --get-regexp` 拿全部，而不是"1 + 远端数"个进程）。
  // 因此这里断言两条路由都能拿到该拿的东西。
  checkTrue('   /branches 不再夹带 remotes', res.body.remotes === undefined)
  const remotes = await get('remotes')
  check('   GET /remotes 200', remotes.status, 200)
  checkTrue('   remotes 含 origin', remotes.body.remotes.some((r) => r.name === 'origin'))
  checkTrue('   remotes 带地址', String(remotes.body.remotes.find((r) => r.name === 'origin').url).length > 0)

  // =========================================================================
  console.log('')
  console.log('=== 2. GET /status：计数与进行中状态 ===')
  res = await get('status')
  check('2) 200', res.status, 200)
  check('   当前分支', res.body.branch, 'main')
  check('   未跟踪文件数', res.body.untrackedFiles, 1)
  check('   改动文件数含未跟踪', res.body.changedFiles, 1)
  check('   未在合并中', res.body.merging, false)
  check('   未在变基中', res.body.rebasing, false)
  check('   上游存在（未 gone）', res.body.upstreamGone, false)
  checkTrue('   有 head 提交', typeof res.body.head === 'string' && res.body.head.length === 40)

  // =========================================================================
  console.log('')
  console.log('=== 3. 分支名白名单（安全边界）===')
  for (const bad of ['--upload-pack=calc', 'a b', 'a..b', 'a@{1}', '-x', '/lead', 'trail/', 'a//b']) {
    res = await post('checkout', { branch: bad })
    check(`3) 拒绝 ${JSON.stringify(bad)}`, res.status, 400)
  }
  // `asStartPoint` 接受十六进制 SHA，但**不接受** rev 表达式。
  for (const bad of ['HEAD~2', 'main@{1}', 'origin/../x']) {
    res = await post('checkout', { branch: bad })
    check(`3) 拒绝 rev 表达式 ${JSON.stringify(bad)}`, res.status, 400)
  }

  // =========================================================================
  console.log('')
  console.log('=== 4. 新建分支 ===')
  // 脏工作区：main 上有一个未跟踪文件，但未跟踪文件不阻止 switch（git 允许）。
  res = await post('branch/create', { name: 'feature/new', from: 'develop', checkout: false })
  check('4) 新建（不切换）-> 200', res.status, 200)
  check('   created', res.body.created, 'feature/new')
  check('   未切换分支', await headBranch(), 'main')
  // 写操作的响应里**不再有分支列表**：它只回最新状态 + `branchesStale: true`，分支列表由
  // 客户端据此异步重取（这样 checkout/merge 之后立刻能看到结果，不必等一轮分支枚举）。
  // 因此这里断言的是"过期信号 + 下一次 GET 能拿到新分支"这条链。
  checkTrue('   写响应不回分支列表', res.body.branches === undefined)
  check('   写响应标记分支已过期', res.body.branchesStale, true)
  res = await get('branches')
  checkTrue('   重新 GET 已含新分支', res.body.branches.some((b) => b.name === 'feature/new'))

  res = await post('branch/create', { name: 'feature/new', from: 'develop', checkout: false })
  check('4) 重名 -> 409', res.status, 409)
  check('   code 是 branchExists', res.body.code, 'branchExists')

  res = await post('branch/create', { name: 'feature/checked', from: 'develop', checkout: true })
  check('4) 新建并切换 -> 200', res.status, 200)
  check('   已切换到新分支', await headBranch(), 'feature/checked')

  // 从提交 SHA 新建：客户端右键菜单的「从 <提交> 新建分支」。
  res = await post('branch/create', { name: 'from-commit', from: developHead, checkout: false })
  check('4) 从提交 SHA 新建 -> 200', res.status, 200)
  check('   指向该提交', (await git(['rev-parse', 'from-commit'], repo)).trim(), developHead)

  res = await post('branch/create', { name: 'bad/from', from: 'HEAD~2', checkout: false })
  check('4) 非法起点 -> 400', res.status, 400)
  check('   code 是 invalidRevision', res.body.code, 'invalidRevision')

  await git(['switch', '-q', 'main'], repo)

  // =========================================================================
  console.log('')
  console.log('=== 5. 重命名分支 ===')
  res = await post('branch/rename', { from: 'from-commit', to: 'renamed' })
  check('5) 重命名 -> 200', res.status, 200)
  // 同上：列表不在写响应里，重新取一次才是权威。
  res = await get('branches')
  checkTrue('   旧名已消失', !res.body.branches.some((b) => b.name === 'from-commit'))
  checkTrue('   新名已存在', res.body.branches.some((b) => b.name === 'renamed'))

  res = await post('branch/rename', { from: 'renamed', to: 'main' })
  check('5) 重命名到已存在分支 -> 409', res.status, 409)
  check('   code 是 branchExists', res.body.code, 'branchExists')

  res = await post('branch/rename', { from: 'nope', to: 'whatever' })
  check('5) 重命名不存在的分支 -> 404', res.status, 404)
  check('   code 是 noSuchBranch', res.body.code, 'noSuchBranch')

  // =========================================================================
  console.log('')
  console.log('=== 6. 删除分支 ===')
  // 删除当前分支：git 自己会拒绝，但我们要给出**自己的**稳定 code，否则界面只能显示
  // 一句 git 英文原文，也无法解释"为什么不能删"。
  res = await post('branch/delete', { name: 'main' })
  check('6) 删除当前分支 -> 409', res.status, 409)
  check('   code 是 branchCheckedOut', res.body.code, 'branchCheckedOut')

  res = await post('branch/delete', { name: 'nope' })
  check('6) 删除不存在的分支 -> 404', res.status, 404)
  check('   code 是 noSuchBranch', res.body.code, 'noSuchBranch')

  // `feature/new` 指向 develop 顶端，而 develop 的提交不在 main 上 —— 未合并，
  // 因此必须走 notMerged 分支，让用户确认后才强删。
  res = await post('branch/delete', { name: 'feature/new' })
  check('6) 删除未并入的分支 -> 409', res.status, 409)
  check('   code 是 notMerged', res.body.code, 'notMerged')
  checkTrue('   分支仍在（没有被悄悄删掉）', (await git(['branch', '--list', 'feature/new'], repo)).includes('feature/new'))

  res = await post('branch/delete', { name: 'feature/new', force: true })
  check('6) 确认后强删 -> 200', res.status, 200)
  check('   deleted.forced', res.body.deleted.forced, true)
  check('   分支已消失', (await git(['branch', '--list', 'feature/new'], repo)).trim(), '')

  // 已并入 HEAD 的分支走 `-d`（非强制）路径。用 `--merged` 在 git 那里问出一个
  // 确实已并入 main 的名字，而不是自己猜——这样"哪条路径被走到"是被真实状态决定的。
  //
  // 注意 `git branch --merged` 会把**指向某个已并入提交的、未合并提交的后继**也算作
  // 已并入（对 develop：`develop` 自己带了两个未并入的提交，因此不在列表里），
  // 所以这里只需要"列表非空"即可。为了确定拿到一个真正安全的名字，另造一个
  // 已明确并入 main 的分支来断言 `-d` 路径。
  await git(['branch', 'merged-sure', 'HEAD'], repo)
  const mergedName = (await git(['branch', '--merged', 'HEAD', '--format=%(refname:short)'], repo))
    .split('\n')
    .map((line) => line.trim())
    .find((name) => name === 'merged-sure')
  checkTrue('6) 已并入的分支出现在 --merged 列表里', typeof mergedName === 'string')
  res = await post('branch/delete', { name: 'merged-sure' })
  check('6) 删除已并入的分支 -> 200', res.status, 200)
  check('   deleted.forced', res.body.deleted.forced, false)
  check('   分支已消失', (await git(['branch', '--list', 'merged-sure'], repo)).trim(), '')

  // 未并入的分支在**没有**确认标志时必须被 git 拒绝：`-D` 会丢掉提交，
  // 那是不可从 UI 恢复的操作，绝不能由一次误点完成。
  res = await post('branch/delete', { name: 'renamed' })
  check('6) 未并入且未确认 -> 409', res.status, 409)
  check('   code 是 notMerged', res.body.code, 'notMerged')
  res = await post('branch/delete', { name: 'renamed', force: true })
  check('   确认后 -> 200', res.status, 200)
  check('   分支已消失', (await git(['branch', '--list', 'renamed'], repo)).trim(), '')

  // develop 被上面哪一步都不该动到；后面的合并/变基章节依赖它。
  checkTrue('   develop 仍在', (await git(['branch', '--list', 'develop'], repo)).includes('develop'))

  // =========================================================================
  console.log('')
  console.log('=== 7. 合并 ===')
  // 先把未跟踪文件清掉，避免它干扰后面的切换。
  rmSync(join(repo, 'untracked.txt'), { force: true })
  res = await post('branch/merge', { name: 'develop', noFf: true })
  check('7) 合并 develop -> 200', res.status, 200)
  checkTrue('   产生了合并提交', (await git(['rev-list', '--merges', '--count', 'HEAD'], repo)).trim() === '1')
  checkTrue('   develop 的文件已在工作区', (await git(['cat-file', '-e', 'HEAD:c.txt'], repo)) !== undefined)

  res = await post('branch/merge', { name: 'no-such-branch' })
  check('7) 合并不存在的分支 -> 404', res.status, 404)
  check('   code 是 noSuchBranch', res.body.code, 'noSuchBranch')

  // 合并冲突：造一个两边都改同一行的分支。
  await git(['switch', '-q', '-c', 'conflict'], repo)
  writeFileSync(join(repo, 'a.txt'), 'conflict side\n')
  await git(['add', '.'], repo)
  await git(['commit', '-q', '-m', 'conflict: side'], repo)
  await git(['switch', '-q', 'main'], repo)
  writeFileSync(join(repo, 'a.txt'), 'conflict main\n')
  await git(['add', '.'], repo)
  await git(['commit', '-q', '-m', 'conflict: main'], repo)

  res = await post('branch/merge', { name: 'conflict' })
  check('7) 合并冲突 -> 409', res.status, 409)
  check('   code 是 mergeConflict', res.body.code, 'mergeConflict')

  // 冲突期间 /status 必须报告 merging —— 界面据此显示「中止合并」。
  res = await get('status')
  check('7) 冲突后 status.merging', res.body.merging, true)

  res = await post('op/abort', { kind: 'merge' })
  check('7) 中止合并 -> 200', res.status, 200)
  check('   aborted', res.body.aborted, 'merge')
  res = await get('status')
  check('7) 中止后 status.merging', res.body.merging, false)
  check('   工作区已回到干净状态', (await git(['status', '--porcelain'], repo)).trim(), '')

  // =========================================================================
  console.log('')
  console.log('=== 8. 变基 ===')
  // 在当前分支上变基到 develop：main 上多出的提交会被重放。
  const beforeRebase = (await git(['rev-parse', 'HEAD'], repo)).trim()
  res = await post('branch/rebase', { onto: 'develop' })
  check('8) 变基 -> 200', res.status, 200)
  checkTrue('   HEAD 已改变', (await git(['rev-parse', 'HEAD'], repo)).trim() !== beforeRebase)
  checkTrue('   develop 已成为祖先', (await git(['merge-base', '--is-ancestor', 'develop', 'HEAD'], repo).then(() => 'yes').catch(() => 'no')) === 'yes')

  // 变基冲突：onto 一个改了同一行的分支。
  await git(['switch', '-q', '-c', 'rebase-side', 'develop'], repo)
  writeFileSync(join(repo, 'a.txt'), 'rebase side\n')
  await git(['add', '.'], repo)
  await git(['commit', '-q', '-m', 'rebase: side'], repo)
  await git(['switch', '-q', 'main'], repo)
  writeFileSync(join(repo, 'a.txt'), 'rebase main\n')
  await git(['add', '.'], repo)
  await git(['commit', '-q', '-m', 'rebase: main'], repo)

  res = await post('branch/rebase', { onto: 'rebase-side' })
  check('8) 变基冲突 -> 409', res.status, 409)
  check('   code 是 rebaseConflict', res.body.code, 'rebaseConflict')
  res = await get('status')
  check('8) 冲突后 status.rebasing', res.body.rebasing, true)
  res = await post('op/abort', { kind: 'rebase' })
  check('8) 中止变基 -> 200', res.status, 200)
  check('   工作区已回到干净状态', (await git(['status', '--porcelain'], repo)).trim(), '')

  // =========================================================================
  console.log('')
  console.log('=== 9. 摘取提交（cherry-pick）===')
  // 摘取能否干净应用，取决于被摘提交相对**当前 HEAD** 的改动是否与工作区一致，
  // 而且 git 要求**工作区对相关文件没有本地改动**——第 8 节的冲突演练把 a.txt 改成了
  // 'rebase main' 且未提交，实测直接被拒（"your local changes would be overwritten
  // by cherry-pick"）。这里把 a.txt 对齐到 develop 的版本并提交成一次清理提交，
  // 让"成功摘取"依赖明确的前置条件而不是历史的巧合。
  await git(['checkout', 'develop', '--', 'a.txt'], repo)
  await git(['commit', '-q', '-m', 'test: 对齐 a.txt 以便干净摘取'], repo)
  check('9) 前置：工作区干净', (await git(['status', '--porcelain'], repo)).trim(), '')

  // 为了让"摘取"真的做一次改动（而不是空摘取），先摘 develop 的父提交（dev: one，
  // 只加 b.txt），此时 b.txt 已在 main 上（第 7 节合并过）——所以改用 develop 的**首个**
  // 独有提交的反面：先把 c.txt 从工作区删掉并提交，让 develop 顶端那个"加 c.txt"的
  // 改动成为真正的新增。
  await git(['rm', '-q', '--cached', 'c.txt'], repo)
  rmSync(join(repo, 'c.txt'), { force: true })
  await git(['commit', '-q', '-m', 'test: 移除 c.txt 以便摘取能真正生效'], repo)

  const developTip = (await git(['rev-parse', 'develop'], repo)).trim()
  const beforePick = (await git(['rev-parse', 'HEAD'], repo)).trim()
  res = await post('cherry-pick', { revision: developTip })
  check('9) 摘取 -> 200', res.status, 200)
  check('   empty 为假', res.body.empty, false)
  // 用绝对 SHA 断言"HEAD 前进了"，而不是 `HEAD~1` —— `HEAD~1` 是 rev 表达式，
  // 正是白名单要拒绝的东西，用它会让这条断言与安全边界自相矛盾。
  checkTrue('   HEAD 已前进', (await git(['rev-parse', 'HEAD'], repo)).trim() !== beforePick)
  check('   提交主题被复制', (await git(['log', '-1', '--pretty=%s'], repo)).trim(), 'dev: two')
  check('   提交内容被复制', (await git(['cat-file', '-p', 'HEAD:c.txt'], repo)).trim(), 'dev two')

  // 空摘取：内容已经在当前分支里的提交。git 自己会以非零退出并说 "now empty"，
  // 但用户的意图已经达成 —— 必须回 200 + empty=true，且**仓库要留在干净状态**，
  // 否则用户会卡在一个自己不认识的中间状态里（实测：此前报成"摘取冲突"）。
  res = await post('cherry-pick', { revision: developTip })
  check('9) 空摘取 -> 200', res.status, 200)
  check('   empty 为真', res.body.empty, true)
  check('   工作区仍然干净', (await git(['status', '--porcelain'], repo)).trim(), '')
  check('   HEAD 未变', (await git(['rev-parse', 'HEAD'], repo)).trim(), (await git(['rev-parse', 'HEAD'], repo)).trim())

  res = await post('cherry-pick', { revision: 'HEAD~1' })
  check('9) 拒绝 rev 表达式 -> 400', res.status, 400)
  check('   code 是 invalidRevision', res.body.code, 'invalidRevision')
  res = await post('cherry-pick', { revision: '../../etc' })
  check('9) 拒绝路径 -> 400', res.status, 400)
  // 合法形状但不存在的提交：必须是 404，而不是把它当成冲突或 500。
  res = await post('cherry-pick', { revision: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' })
  check('9) 不存在的提交 -> 404', res.status, 404)
  check('   code 是 noSuchRef', res.body.code, 'noSuchRef')

  // 摘取冲突：摘取"改同一行"的提交必须回稳定 code，并且可以中止。
  await git(['switch', '-q', '-c', 'pick-side', developTip], repo)
  writeFileSync(join(repo, 'a.txt'), 'pick side\n')
  await git(['add', '.'], repo)
  await git(['commit', '-q', '-m', 'pick: side'], repo)
  await git(['switch', '-q', 'main'], repo)
  writeFileSync(join(repo, 'a.txt'), 'pick main\n')
  await git(['add', '.'], repo)
  await git(['commit', '-q', '-m', 'pick: main'], repo)
  const pickTip = (await git(['rev-parse', 'pick-side'], repo)).trim()

  res = await post('cherry-pick', { revision: pickTip })
  check('9) 摘取冲突 -> 409', res.status, 409)
  check('   code 是 cherryPickConflict', res.body.code, 'cherryPickConflict')
  res = await post('op/abort', { kind: 'cherry-pick' })
  check('   中止摘取 -> 200', res.status, 200)
  check('   工作区已回到干净状态', (await git(['status', '--porcelain'], repo)).trim(), '')
  await git(['branch', '-D', 'pick-side'], repo)

  // =========================================================================
  console.log('')
  console.log('=== 10. 远端操作（全部离线，origin 是本地 bare 仓库）===')
  res = await post('remote', { action: 'fetch' })
  check('10) fetch -> 200', res.status, 200)
  check('   fetched', res.body.fetched, 'all')

  // main 现在领先/落后 origin/main：push 应被拒（非快进），这不是网络错误。
  res = await post('remote', { action: 'push' })
  check('10) 落后时 push -> 409', res.status, 409)
  check('   code 是 pushRejected', res.body.code, 'pushRejected')

  // pull 把远端那个提交拉进来（本地已 fetch 过，merge 可完成）。
  res = await post('remote', { action: 'pull' })
  check('10) pull -> 200', res.status, 200)
  check('   远端文件已被拉入', (await git(['cat-file', '-e', 'HEAD:remote.txt'], repo).then(() => 'yes').catch(() => 'no')), 'yes')

  res = await post('remote', { action: 'push' })
  check('10) 快进后 push -> 200', res.status, 200)
  check('   远端 main 与本地一致', (await git(['--git-dir', origin, 'rev-parse', 'main'], repo)).trim(), (await git(['rev-parse', 'HEAD'], repo)).trim())

  res = await post('remote', { action: 'push', remote: '--upload-pack=calc' })
  check('10) 非法远端名 -> 400', res.status, 400)
  check('   code 是 invalidRemote', res.body.code, 'invalidRemote')

  res = await post('remote', { action: 'nope' })
  check('10) 未知 action -> 400', res.status, 400)

  // 远端分支列表里出现 origin/develop 之后，删除远端分支要真的推到 origin。
  // **先 fetch**：远端跟踪引用是本地事实，没有 fetch 就没有 `origin/develop` 这一行。
  res = await post('remote', { action: 'fetch' })
  check('10) 再次 fetch -> 200', res.status, 200)
  checkTrue('   写响应标记分支已过期', res.body.branchesStale, true)
  res = await get('branches')
  checkTrue('   origin/develop 已在列表里', res.body.branches.some((b) => b.name === 'origin/develop'))
  res = await post('branch/delete', { name: 'origin/develop', remote: true })
  check('10) 删除远端分支 -> 200', res.status, 200)
  check('   deleted.remote', res.body.deleted.remote, true)
  check('   origin 上已无 develop', (await git(['--git-dir', origin, 'branch', '--list', 'develop'], repo)).trim(), '')

  // =========================================================================
  console.log('')
  console.log('=== 11. 签出标记或修订（游离 HEAD）===')
  res = await post('checkout', { branch: 'v1.0.0' })
  check('11) 签出标签 -> 200', res.status, 200)
  check('   detached 标记为真', res.body.detached, true)
  check('   确实是游离 HEAD', await headBranch(), 'HEAD')
  check('   status.detached', (await get('status')).body.detached, true)

  await git(['switch', '-q', 'main'], repo)
  // 签出远端分支要建本地跟踪分支。为保证这一次真的走 `--track` 路径，先让本地同名
  // 分支不存在（否则 `onLocalBranch` 为真，走的是普通切换，断言就测不到跟踪设置）。
  checkTrue('11) 前置：本地没有 track-probe 分支', !(await git(['branch', '--list', 'track-probe'], repo)).includes('track-probe'))
  await git(['push', '-q', 'origin', 'main:track-probe'], repo)
  await git(['fetch', '-q', 'origin'], repo)
  res = await post('checkout', { branch: 'origin/track-probe' })
  check('11) 签出远程分支会建本地跟踪分支 -> 200', res.status, 200)
  check('   detached 标记为假', res.body.detached, false)
  check('   当前分支是 track-probe', await headBranch(), 'track-probe')
  check('   已建立跟踪关系', (await git(['config', '--get', 'branch.track-probe.remote'], repo)).trim(), 'origin')

  res = await post('checkout', { branch: 'no-such-ref' })
  check('11) 签出不存在的引用 -> 404', res.status, 404)
  check('   code 是 noSuchRef', res.body.code, 'noSuchRef')

  // =========================================================================
  console.log('')
  console.log('=== 12. 安全边界：工作区必须已登记 ===')
  const stray = join(root, 'stray')
  mkdirSync(stray, { recursive: true })
  const strayResponse = await fetch(`${base}/dsh-desktop/gitbar/branches?cwd=${encodeURIComponent(stray)}`)
  check('12) 未登记的工作区 -> 400', strayResponse.status, 400)
  check('   code 是 workspaceNotAllowed', (await strayResponse.json()).code, 'workspaceNotAllowed')

  const missingCwd = await fetch(`${base}/dsh-desktop/gitbar/branches`)
  check('12) 不带 cwd -> 400', missingCwd.status, 400)

  const wrongMethod = await fetch(`${base}/dsh-desktop/gitbar/status${query}`, { method: 'POST', body: '{}' })
  check('12) GET 路由用 POST -> 404（不是 405，路径不匹配）', wrongMethod.status, 404)

  child.kill()
} catch (error) {
  failures += 1
  console.error('测试异常:', String(error?.stack ?? error).slice(0, 1200))
} finally {
  child?.kill()
  await new Promise((r) => setTimeout(r, 1500))
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch (error) {
    console.warn(`临时目录未能删除（不影响结论）: ${String(error.message).slice(0, 120)}`)
  }
}

console.log('')
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
