// 端到端验证 review 插件的**提交图**与**暂存/提交**路由。
//
//   node scripts/test-review-graph.mjs
//
// 为什么需要它：这两批路由里有本项目风险最高的写操作（`git add` 与 `git commit` 会真的
// 改动仓库索引与历史），以及一个纯新增的只读视图（提交图）。前者必须在一个一次性仓库上
// 真的跑一遍才敢说"它是对的"；后者的契约（父提交、refs、分页、`--all`）全是形状问题，
// 只有对着真实 git 输出断言才作数。
//
// 临时仓库刻意造出画图需要的形状：一条主线、一个分叉后合并回来的分支（产生**合并提交**）、
// 一个标签、以及一个未跟踪文件。
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

const root = mkdtempSync(join(tmpdir(), 'dsh-review-graph-'))
const repo = join(root, 'work')
let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `（期望 ${expected}）`}`)
}
const checkTrue = (label, actual) => check(label, actual === true, true)

let child
try {
  // ---- 造仓库 ---------------------------------------------------------------
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'test'])
  execFileSync('git', ['-C', repo, 'config', 'commit.gpgsign', 'false'])

  writeFileSync(join(repo, 'a.txt'), 'base\n')
  await git(['add', '.'], repo)
  await git(['commit', '-q', '-m', 'init'], repo)
  await git(['tag', 'v0.1.0'], repo)

  // 分叉：feature 上两个提交，然后合并回 main —— 于是历史里有一个合并提交（两个父提交）。
  await git(['switch', '-q', '-c', 'feature'], repo)
  writeFileSync(join(repo, 'b.txt'), 'feature one\n')
  await git(['add', '.'], repo)
  await git(['commit', '-q', '-m', 'feature: one'], repo)
  writeFileSync(join(repo, 'c.txt'), 'feature two\n')
  await git(['add', '.'], repo)
  await git(['commit', '-q', '-m', 'feature: two'], repo)
  await git(['switch', '-q', 'main'], repo)
  writeFileSync(join(repo, 'd.txt'), 'main side\n')
  await git(['add', '.'], repo)
  await git(['commit', '-q', '-m', 'main: side'], repo)
  await git(['merge', '-q', '--no-ff', '--no-edit', 'feature'], repo)

  // 用于"已跟踪改动"与"未跟踪文件"的两种状态。
  writeFileSync(join(repo, 'a.txt'), 'changed\n')
  writeFileSync(join(repo, 'untracked.txt'), 'u\n')
  await git(['rm', '-q', '--cached', 'd.txt'], repo)

  const headShort = (await git(['rev-parse', '--short', 'HEAD'], repo)).trim()
  const headFull = (await git(['rev-parse', 'HEAD'], repo)).trim()
  const mergeCount = (await git(['rev-list', '--merges', '--count', 'HEAD'], repo)).trim()
  /** 根提交，后面多节都要用它（首提交的差异、多分支可达）。 */
  const rootHash = (await git(['rev-list', '--max-parents=0', 'HEAD'], repo)).trim()

  console.log('临时仓库:', repo)
  console.log(`  HEAD=${headShort} 合并提交数=${mergeCount}`)
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

  const post = async (route, body) => {
    const response = await fetch(`${base}/dsh-desktop/review/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: repo, ...body }),
    })
    const text = await response.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { error: text.slice(0, 200) }
    }
    if (response.status >= 400) {
      console.log(`  [debug] ${route} ${response.status} code=${parsed.code ?? '(none)'}: ${String(parsed.detail ?? parsed.error).slice(0, 240)}`)
    }
    return { status: response.status, body: parsed }
  }
  const get = async (route, query = '') => {
    const response = await fetch(`${base}/dsh-desktop/review/${route}?workspace=${encodeURIComponent(repo)}${query}`)
    return { status: response.status, body: await response.json() }
  }

  // =========================================================================
  console.log('=== 1. GET /graph：父提交与 refs ===')
  let res = await get('graph')
  check('1) 200', res.status, 200)
  check('   isRepo', res.body.isRepo, true)
  check('   当前分支', res.body.branch, 'main')
  const commits = res.body.commits
  checkTrue('   有提交', Array.isArray(commits) && commits.length > 0)
  // 合并提交必须带**两个父提交**，否则图里画不出分叉。
  const merge = commits.find((c) => c.parents.length === 2)
  checkTrue('   含一个两父提交的合并提交', merge !== undefined)
  check('   合并提交就是 HEAD', merge?.hash, headFull)
  // 首提交没有父提交。
  const rootCommit = commits.find((c) => c.parents.length === 0)
  checkTrue('   含无父提交的根提交', rootCommit !== undefined)
  // refs：HEAD 指向 main，标签落在根提交上，feature 分支还指向它那两个提交。
  checkTrue('   HEAD 那条带 headBranch=main', commits.some((c) => c.headBranch === 'main'))
  checkTrue('   根提交带标签 v0.1.0', commits.some((c) => c.tags.includes('v0.1.0')))
  checkTrue('   feature 分支出现在 localBranches 里', commits.some((c) => c.localBranches.includes('feature')))
  // 每条提交都要有画图需要的字段。
  const first = commits[0]
  checkTrue('   有短哈希', /^[0-9a-f]{4,}$/u.test(first.short))
  checkTrue('   有作者', first.author.length > 0)
  checkTrue('   有 ISO 提交时间', /^\d{4}-\d{2}-\d{2}T/u.test(first.committedAt))
  checkTrue('   有标题', first.subject.length > 0)
  checkTrue('   父提交是完整 40 位哈希', commits.every((c) => c.parents.every((p) => /^[0-9a-f]{40}$/u.test(p))))

  console.log('')
  console.log('=== 2. 拓扑序：父提交必须出现在子提交之后 ===')
  {
    const index = new Map(commits.map((c, i) => [c.hash, i]))
    let violated = 0
    for (const [i, commit] of commits.entries()) {
      for (const parent of commit.parents) {
        const at = index.get(parent)
        if (at !== undefined && at <= i) violated += 1
      }
    }
    // 这一条是"图上的线为什么不会往上指"的全部依据。`--topo-order` 掉了的话，
    // 变基或时钟漂移产生的旧时间戳会让父提交排在子提交前面。
    check('2) 没有任何父提交排在子提交之前', violated, 0)
  }

  console.log('')
  console.log('=== 3. 分页：hasMore 与 skip 不重叠不遗漏 ===')
  const all = await get('graph', '&limit=100')
  const total = all.body.commits.length
  // 本仓库共 5 个提交（init / feature:one / feature:two / main:side / merge）。
  checkTrue('3) 一次性取回全部', total >= 5)
  const page1 = await get('graph', '&limit=3')
  check('   第一页 3 条', page1.body.commits.length, 3)
  check('   还有下一页', page1.body.hasMore, true)
  check('   nextSkip', page1.body.nextSkip, 3)
  const page2 = await get('graph', '&limit=3&skip=3')
  // 第二页只剩 2 条（5 - 3）。断言"到末尾时会缩短"，而不是硬写 3——后者会在仓库
  // 提交数变化时变成一条假失败。
  check('   第二页取到剩余条数', page2.body.commits.length, total - 3)
  check('   第二页到底了', page2.body.hasMore, false)
  // 两页不能重叠：这是分页最容易错的地方（少加/多加一个 offset）。
  const page1Hashes = new Set(page1.body.commits.map((c) => c.hash))
  check('   两页无重叠', page2.body.commits.some((c) => page1Hashes.has(c.hash)), false)
  // 拼起来要与一次性取回的前若干条完全一致：顺序、内容都不能变。
  const expected = all.body.commits.slice(0, page1.body.commits.length + page2.body.commits.length).map((c) => c.hash).join(',')
  check('   两页拼接与全量同序一致', [...page1.body.commits, ...page2.body.commits].map((c) => c.hash).join(','), expected)
  // 取到末尾时 hasMore 必须是 false，否则界面会一直显示"加载更多"。
  const tail = await get('graph', `&limit=100&skip=${total}`)
  check('   越过末尾时没有提交', tail.body.commits.length, 0)
  check('   越过末尾时 hasMore 为假', tail.body.hasMore, false)
  const exact = await get('graph', `&limit=${total}`)
  check('   恰好取完时 hasMore 为假', exact.body.hasMore, false)

  console.log('')
  console.log('=== 4. ref 筛选 ===')
  const featureOnly = await get('graph', '&ref=feature')
  check('4) 200', featureOnly.status, 200)
  checkTrue('   feature 只有自己那条线（提交数少于全量）', featureOnly.body.commits.length < total)
  checkTrue('   不含合并提交', !featureOnly.body.commits.some((c) => c.parents.length === 2))
  // 不带 ref 时必须看全部分支，否则图上永远只有一个分支、看不到分叉。
  checkTrue('   全量视图里含 feature 的提交', commits.some((c) => c.subject === 'feature: two'))
  const badRef = await get('graph', '&ref=--upload-pack=calc')
  check('   非法 ref -> 400', badRef.status, 400)
  check('   code 是 invalidRef', badRef.body.code, 'invalidRef')

  console.log('')
  console.log('=== 5. GET /commit-detail：改动文件与所在分支 ===')
  res = await get('commit-detail', `&revision=${headFull}`)
  check('5) 200', res.status, 200)
  check('   提交哈希', res.body.commit.hash, headFull)
  check('   合并提交有两个父提交', res.body.commit.parents.length, 2)
  checkTrue('   有改动文件列表', Array.isArray(res.body.files) && res.body.files.length > 0)
  checkTrue('   文件项带状态与增删行数', res.body.files.every((f) => typeof f.path === 'string' && typeof f.status === 'string' && 'added' in f))
  checkTrue('   含 feature 带进来的文件', res.body.files.some((f) => f.path === 'c.txt'))
  // "在 N 个分支中"：合并提交本身只**可达于** main —— feature 指向它的第一个父提交，
  // 不是合并提交，所以 git 自己的 `branch --contains` 也只列出 main（已交叉验证）。
  // 这里要的是"能算出可达集合"，而不是"合并提交属于两个分支"那种想当然的说法。
  checkTrue('   含所在分支列表', Array.isArray(res.body.containingBranches))
  check('   合并提交可达于 main', res.body.containingBranches.join(','), 'main')
  // 首提交：没有父提交，必须走 `show` 把文件全算成新增，而不是报错。
  res = await get('commit-detail', `&revision=${rootHash}`)
  check('   根提交 -> 200', res.status, 200)
  check('   根提交无父提交', res.body.commit.parents.length, 0)
  check('   根提交的文件是新增', res.body.files.map((f) => `${f.status}:${f.path}`).join(','), 'A:a.txt')

  res = await get('commit-detail', '&revision=HEAD~1')
  check('5) 拒绝 rev 表达式 -> 400', res.status, 400)
  check('   code 是 invalidRevision', res.body.code, 'invalidRevision')
  res = await get('commit-detail', `&revision=${'d'.repeat(40)}`)
  check('   不存在的提交 -> 404', res.status, 404)
  check('   code 是 noSuchRef', res.body.code, 'noSuchRef')

  console.log('')
  console.log('=== 6. GET /commit-file：单个文件的差异 ===')
  res = await get('commit-file', `&revision=${headFull}&path=c.txt`)
  check('6) 200', res.status, 200)
  checkTrue('   差异里有新增行', res.body.diff.includes('+feature two'))
  check('   不是二进制', res.body.binary, false)
  check('   未截断', res.body.truncated, false)
  res = await get('commit-file', `&revision=${headFull}&path=../outside.txt`)
  check('   路径穿越 -> 400', res.status, 400)
  check('   code 是 unsafePath', res.body.code, 'unsafePath')
  res = await get('commit-file', `&revision=${headFull}&path=/etc/passwd`)
  check('   绝对路径 -> 400', res.status, 400)

  console.log('')
  console.log('=== 7. GET /status：已跟踪与未跟踪分开 ===')
  res = await get('status')
  check('7) 200', res.status, 200)
  const trackedPaths = res.body.tracked.map((entry) => entry.path)
  checkTrue('   已跟踪里含被修改的 a.txt', trackedPaths.includes('a.txt'))
  // d.txt 被 `rm --cached` 了：它的工作区文件还在，但索引里没有 → git 记为已删除
  // （`D `），同时它也是未跟踪文件。两个事实同时成立，界面上两处都要显示。
  checkTrue('   已跟踪里含被取消暂存的 d.txt', trackedPaths.includes('d.txt'))
  // 未跟踪的文件有**两个**：显式创建的 untracked.txt，以及 d.txt —— "取消暂存一个
  // 新增文件"的真实结果就是它变成未跟踪。这正是界面要把"已跟踪更改"与"未跟踪文件"
  // 分成两个区块的原因：同一个文件可能同时出现在两边，而两边的可执行操作不同。
  check('   未跟踪计数', res.body.untrackedCount, 2)
  checkTrue('   未跟踪样本含 untracked.txt', res.body.untrackedSample.includes('untracked.txt'))
  checkTrue('   未跟踪样本含 d.txt', res.body.untrackedSample.includes('d.txt'))
  checkTrue('   不在"已跟踪"里重复未跟踪文件', !trackedPaths.includes('untracked.txt'))
  checkTrue('   每条已跟踪项带索引/工作区两列状态', res.body.tracked.every((e) => e.index.length === 1 && e.worktree.length === 1))

  console.log('')
  console.log('=== 8. GET /untracked：未跟踪清单 ===')
  res = await get('untracked')
  check('8) 200', res.status, 200)
  check('   路径列表（字典序）', res.body.paths.slice().sort().join(','), 'd.txt,untracked.txt')
  check('   总数', res.body.total, 2)
  check('   未截断', res.body.truncated, false)

  console.log('')
  console.log('=== 9. 暂存与取消暂存（本插件风险最高的写操作）===')
  // 越界路径必须先被挡住，且不能碰索引。
  res = await post('stage', { paths: ['../outside.txt'] })
  check('9) 路径穿越 -> 400', res.status, 400)
  check('   code 是 unsafePath', res.body.code, 'unsafePath')
  res = await post('stage', { paths: [] })
  check('   空路径 -> 400', res.status, 400)
  check('   code 是 noPaths', res.body.code, 'noPaths')
  res = await post('stage', { paths: ['/etc/passwd'] })
  check('   绝对路径 -> 400', res.status, 400)

  res = await post('stage', { paths: ['untracked.txt'] })
  check('   暂存未跟踪文件 -> 200', res.status, 200)
  check('   返回 staged 列表', res.body.staged.join(','), 'untracked.txt')
  check('   索引里出现该文件', (await git(['diff', '--cached', '--name-only'], repo)).includes('untracked.txt'), 'true')

  res = await post('unstage', { paths: ['untracked.txt'] })
  check('   取消暂存 -> 200', res.status, 200)
  check('   索引里不再有该文件', (await git(['diff', '--cached', '--name-only'], repo)).includes('untracked.txt'), 'false')
  check('   工作区文件还在', (await git(['status', '--porcelain'], repo)).includes('?? untracked.txt'), 'true')

  console.log('')
  console.log('=== 10. 提交 ===')
  const beforeAll = (await git(['rev-parse', 'HEAD'], repo)).trim()
  res = await post('commit', { message: '   ' })
  check('10) 空提交信息 -> 400', res.status, 400)
  check('   code 是 emptyMessage', res.body.code, 'emptyMessage')

  // 暂存区此刻**不是**空的：前面 `git rm --cached d.txt` 把"删除 d.txt"这个改动留在了
  // 暂存区里，因此这一次提交会真的成功。要测"没有暂存内容"，得先把索引清干净。
  // 这也说明了一件事：`rm --cached` 同时留下"已跟踪 → 已删除"与"未跟踪"两种痕迹，
  // 是两个独立的事实，不能只看其中一个。
  check('   此刻暂存区里只有 d.txt 的删除', (await git(['diff', '--cached', '--name-only'], repo)).trim(), 'd.txt')
  res = await post('unstage', { paths: ['d.txt'] })
  check('   取消暂存 d.txt -> 200', res.status, 200)
  res = await post('commit', { message: 'should not happen' })
  check('   没有暂存内容 -> 409', res.status, 409)
  check('   code 是 nothingStaged', res.body.code, 'nothingStaged')
  check('   返回被拒时 HEAD 没有动', (await git(['rev-parse', 'HEAD'], repo)).trim(), beforeAll)

  // 真的暂存全部并提交。
  res = await post('stage', { paths: ['a.txt', 'd.txt', 'untracked.txt'] })
  check('   暂存三个文件 -> 200', res.status, 200)
  const beforeHead = (await git(['rev-parse', 'HEAD'], repo)).trim()
  res = await post('commit', { message: 'test: 由审查插件提交' })
  check('   提交 -> 200', res.status, 200)
  check('   committed', res.body.committed, true)
  const afterHead = (await git(['rev-parse', 'HEAD'], repo)).trim()
  checkTrue('   HEAD 已前进', afterHead !== beforeHead)
  check('   提交信息正确', (await git(['log', '-1', '--pretty=%s'], repo)).trim(), 'test: 由审查插件提交')
  check('   提交后工作区干净', (await git(['status', '--porcelain'], repo)).trim(), '')
  check('   响应里带新的 HEAD', res.body.head, afterHead)
  // 提交只允许追加历史，**不能**改写：HEAD 的父提交必须是原来的 HEAD。
  check('   新提交的父提交是原来的 HEAD', (await git(['rev-parse', 'HEAD^'], repo)).trim(), beforeHead)

  // 提交完全干净之后：没有任何改动。
  res = await post('commit', { message: 'again' })
  check('   无任何改动时 -> 409', res.status, 409)
  check('   code 是 nothingToCommit', res.body.code, 'nothingToCommit')

  console.log('')
  console.log('=== 10b. "在 N 个分支中"：真正的多分支可达 ===')
  // feature 的尖端是**在 main 上创建的合并提交**，因此它本来就同时可达于
  // feature / feature2（同一个提交两个名字）与 main。用一个"只属于一个分支"的提交
  // 反而验不出参数顺序写反的 bug——那正是这条断言的用处：它要求三个名字都出现。
  await git(['branch', 'feature2', 'feature'], repo)
  const featureTip = (await git(['rev-parse', 'feature'], repo)).trim()
  res = await get('commit-detail', `&revision=${featureTip}`)
  check('10b) 200', res.status, 200)
  check(
    '   feature 尖端可达于三个分支（含两个同指一个提交的名字）',
    res.body.containingBranches.slice().sort().join(','),
    'feature,feature2,main',
  )
  // 根提交在合并之后可达于全部三个分支，且 `main` 在合并前就含它。
  check(
    '   根提交可达于全部三个分支',
    (await get('commit-detail', `&revision=${rootHash}`)).body.containingBranches.slice().sort().join(','),
    'feature,feature2,main',
  )
  // 只有 feature 走线才有的提交：可达于 feature / feature2，**不含 main 的走线**？不对——
  // 它已被合并进 main，因此 main 也含它。反过来，`main: side` 那个提交不在 feature 上，
  // 于是它只可达于 main —— 这一条才真正区分"两个方向"。
  const sideHash = (await git(['rev-list', '--max-count=1', '--grep=main: side', 'HEAD'], repo)).trim()
  checkTrue('   找到 main: side 提交', sideHash.length === 40)
  check('   只在 main 上的提交只可达于 main', (await get('commit-detail', `&revision=${sideHash}`)).body.containingBranches.join(','), 'main')

  console.log('')
  console.log('=== 11. 安全边界：工作区必须已登记 ===')
  const stray = join(root, 'stray')
  mkdirSync(stray, { recursive: true })
  const strayGraph = await fetch(`${base}/dsh-desktop/review/graph?workspace=${encodeURIComponent(stray)}`)
  check('11) 未登记的工作区 -> 400', strayGraph.status, 400)
  check('   code 是 workspaceNotAllowed', (await strayGraph.json()).code, 'workspaceNotAllowed')
  const strayStage = await fetch(`${base}/dsh-desktop/review/stage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: stray, paths: ['x'] }),
  })
  check('   stage 也拒绝未登记工作区', strayStage.status, 400)

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
