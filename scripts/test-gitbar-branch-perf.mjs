// 分支列表的**子进程上界**回归：300 个分支不许产生 300 个 git 进程。
//
//   node scripts/test-gitbar-branch-perf.mjs
//
// 为什么需要它：这是"分支列表要等好几秒"的根因所在——旧实现对**每个有上游的分支**各跑一次
// `rev-list`（`Promise.all` 还不限并发），而 `MAX_BRANCHES` 又是在这轮 enrichment **之后**
// 才截断。300 个分支就是 300 个 git.exe 同时启动，进程数与分支数线性相关。
//
// 怎么数进程：给服务端进程设 `GIT_TRACE2_EVENT=<文件>`，git 自己会把每个进程的
// `{"event":"start"}` 追加进去（子进程继承环境变量），于是"这一次 HTTP 请求起了几个 git"
// 就是可测量的事实，而不是"看代码觉得应该只有一个"。事件里带 `sid` 与时间戳，因此还能算出
// **同时活着**的进程数（并发上限的断言点）。
//
// 这个文件同时给出**前/后对比**：同一台机器、同一个仓库、同一个计数器下，把旧算法
// （for-each-ref + 每分支一次 rev-list）跑一遍，用它的进程数作为对照。
import { execFile, execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncBundledPlugins } from './sync-plugins.mjs'

/**
 * `GIT_TRACE2_EVENT` 指向的文件：被计数的 git 进程都会往这里追加一条 start 事件。
 *
 * 先声明成模块级变量，`git()` 与旧算法对照都要用它——**测量必须与被测代码走同一条路径**：
 * 只给服务端子进程设环境变量、却在测试进程里直接跑 git，对照那一半就会数出 0 个进程
 * （实测踩到过：对照断言变成"旧算法 0 个进程"，看起来像是新实现更差）。
 */
const trace = join(tmpdir(), `dsh-gitbar-perf-trace-${process.pid}.json`)

const git = async (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TRACE2_EVENT: trace } },
      (error, stdout, stderr) => {
        if (error !== null) reject(new Error(String(stderr).trim() || error.message))
        else resolve(String(stdout))
      },
    )
  })

/** 分支数量。300 是需求里点名的量级。 */
const BRANCH_COUNT = 300
/** `/branch/sync` 一次请求补算多少个分支（与客户端的 SYNC_BATCH 一致）。 */
const SYNC_BATCH = 32

// **先把 plugins/ 同步到 runtime/node_modules**：宿主半边是由服务端从那儿加载的，
// 不同步的话这个测试跑的是上一次同步过去的旧代码——而它恰恰是要证明"新实现才是 1 个进程"
// 的那个测试。`package.json` 里的 `test:startup` 也是这个约定（先 sync 再测）。
syncBundledPlugins()

const root = mkdtempSync(join(tmpdir(), 'dsh-gitbar-perf-'))
const repo = join(root, 'work')
const origin = join(root, 'origin.git')
let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `（期望 ${expected}）`}`)
}
const checkTrue = (label, actual) => check(label, actual === true, true)
const checkLe = (label, actual, bound) => {
  const ok = actual <= bound
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `（期望 ≤ ${bound}）`}`)
}

/**
 * 从 trace 文件里数 git 进程。
 *
 * 返回 `{ count, maxConcurrent }`：`count` 是 `start` 事件的条数；`maxConcurrent` 由每个
 * 进程 start/exit 的**墙上时钟**（`time` 字段）算出——它直接回答"有没有一次起上百个进程"。
 *
 * 注意**不能**用 `t_abs`：它是"相对本进程启动"的时间，每个进程都从 0 开始，于是所有区间
 * 看起来都重叠（实测：并发上限明明是 4，却量出 33）。
 *
 * @param text - trace 文件的内容（JSON Lines）。
 * @returns 统计结果。
 */
function countGitProcesses(text) {
  const spans = new Map()
  let count = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const at = Date.parse(event.time)
    const sid = event.sid
    if (event.event === 'start') {
      count += 1
      spans.set(sid, { start: at, end: at })
    } else if (event.event === 'exit' && spans.has(sid)) {
      spans.get(sid).end = at
    }
  }
  // 最大重叠：把所有 start/exit 当作区间端点排序后扫一遍。
  const points = []
  for (const span of spans.values()) {
    points.push({ at: span.start, delta: 1 })
    points.push({ at: span.end, delta: -1 })
  }
  points.sort((a, b) => a.at - b.at || a.delta - b.delta)
  let live = 0
  let maxConcurrent = 0
  for (const point of points) {
    live += point.delta
    if (live > maxConcurrent) maxConcurrent = live
  }
  return { count, maxConcurrent }
}

/** 清空 trace 文件（下一次测量只统计之后的进程）。 */
function resetTrace() {
  try {
    writeFileSync(trace, '')
  } catch {
    // 目录还没建好（第一次测量之前）：`git()` 会自己创建它。
  }
}
/** 读 trace 并统计。 */
function readTrace() {
  try {
    return countGitProcesses(readFileSync(trace, 'utf8'))
  } catch {
    return { count: 0, maxConcurrent: 0 }
  }
}

let child
try {
  // ---- 造仓库：300 个本地分支，每个都"有上游" -------------------------------------
  //
  // 关键点：每个分支都必须**有 upstream**，否则新旧实现都不会为它起 rev-list，测出来
  // 的进程数会假性偏低。上游用配置直接建立（`branch.<name>.remote/merge`），不需要真的
  // push 300 次——跟踪引用 origin/main 存在，rev-list 就能算。
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'test'])
  execFileSync('git', ['-C', repo, 'config', 'commit.gpgsign', 'false'])
  writeFileSync(join(repo, 'a.txt'), 'base\n')
  await git(['add', '.'], repo)
  await git(['commit', '-q', '-m', 'init'], repo)
  await git(['remote', 'add', 'origin', origin], repo)
  await git(['push', '-q', '-u', 'origin', 'main'], repo)
  await git(['fetch', '-q', 'origin'], repo)

  {
    // 用 plumbing 一次创建 300 个分支：`update-ref --stdin` 比 300 次 `git branch` 快得多
    // （后者就是 300 个进程——那是被测对象本身，不该出现在夹具里）。
    const head = (await git(['rev-parse', 'HEAD'], repo)).trim()
    const lines = []
    for (let i = 0; i < BRANCH_COUNT; i += 1) {
      const name = `feature/branch-${String(i).padStart(3, '0')}`
      lines.push(`create refs/heads/${name} ${head}`)
    }
    await new Promise((resolve, reject) => {
      const proc = execFile('git', ['-C', repo, 'update-ref', '--stdin'], (error, stdout, stderr) => {
        if (error !== null) reject(new Error(String(stderr) || error.message))
        else resolve(stdout)
      })
      proc.stdin.end(lines.join('\n') + '\n')
    })
    // 上游配置同样走 stdin（`git config --stdin` 不存在，因此用一次 `--file` 写入）。
    const configLines = []
    for (let i = 0; i < BRANCH_COUNT; i += 1) {
      const name = `feature/branch-${String(i).padStart(3, '0')}`
      configLines.push(`[branch "${name}"]`)
      configLines.push('\tremote = origin')
      configLines.push('\tmerge = refs/heads/main')
    }
    const configPath = join(repo, '.git', 'config')
    writeFileSync(configPath, readFileSync(configPath, 'utf8') + '\n' + configLines.join('\n') + '\n')
  }
  const localCount = (await git(['for-each-ref', '--format=%(refname)', 'refs/heads/'], repo)).trim().split('\n').length
  check('0) 夹具：本地分支数量', localCount, BRANCH_COUNT + 1)
  const upstreamSample = (await git(['for-each-ref', '--format=%(upstream:short)', 'refs/heads/feature/branch-000'], repo)).trim()
  check('   夹具：分支确实有上游', upstreamSample, 'origin/main')

  // ---- 起服务端（带 trace2 计数）-------------------------------------------------
  const runtime = join(process.cwd(), 'runtime')
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  resetTrace()
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
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TRACE2_EVENT: trace } },
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
  const get = async (route, extra = '') => {
    const response = await fetch(`${base}/dsh-desktop/gitbar/${route}${query}${extra}`)
    return { status: response.status, body: await response.json() }
  }

  // =========================================================================
  console.log('')
  console.log('=== 1. GET /branches：首屏只起一个 git 进程 ===')
  let res
  resetTrace()
  {
    const started = Date.now()
    res = await get('branches')
    const elapsed = Date.now() - started
    console.log(`  [measure] /branches 耗时 ${elapsed}ms`)
  }
  const listed = readTrace()
  check('1) 200', res.status, 200)
  // 300 个本地分支 + main 都在，且**没有被 enrichment 卡住**。
  check('   返回了全部本地分支', res.body.branches.filter((b) => !b.isRemote).length, BRANCH_COUNT + 1)
  check('   计数与列表一致', res.body.counts.local, BRANCH_COUNT + 1)
  checkLe('   git 进程数 ≤ 2（for-each-ref 一次）', listed.count, 2)
  console.log(`  [measure] 旧实现会是 ${BRANCH_COUNT + 1} 次 for-each-ref/rev-list 起步`)

  console.log('')
  console.log('=== 2. 对照：旧算法（每分支一次 rev-list）在同一仓库上的进程数 ===')
  // 这不是"照着旧代码跑一遍"，而是**旧算法的形状**：一次 for-each-ref 拿到所有有上游的
  // 分支，然后对每一个并发跑一次 rev-list。它测出来的就是当初那 300 个进程。
  {
    resetTrace()
    const raw = await git(['for-each-ref', '--format=%(refname)%09%(upstream:short)', 'refs/heads/'], repo)
    const targets = raw
      .split('\n')
      .map((line) => line.split('\t'))
      .filter(([, upstream]) => (upstream ?? '').trim() !== '')
      .map(([ref, upstream]) => [ref, upstream.trim()])
    await Promise.all(targets.map(([ref, upstream]) => git(['rev-list', '--left-right', '--count', `${upstream}...${ref}`], repo)))
    const legacy = readTrace()
    console.log(`  [measure] 旧算法：${legacy.count} 个 git 进程，最高同时 ${legacy.maxConcurrent} 个`)
    checkLe('   旧算法在 300 分支上的进程数 ≥ 300', 300, legacy.count)
    checkTrue('   新实现在同一仓库上少了一个数量级', legacy.count > listed.count * 50)
  }

  console.log('')
  console.log('=== 3. /branch/sync：只按请求的可见分支补算，且并发 ≤ 4 ===')
  {
    const names = Array.from({ length: SYNC_BATCH }, (_, i) => `feature/branch-${String(i).padStart(3, '0')}`)
    resetTrace()
    const sync = await get('branch/sync', `&names=${encodeURIComponent(names.join(','))}`)
    const measured = readTrace()
    console.log(`  [measure] /branch/sync（${SYNC_BATCH} 个分支）：${measured.count} 个进程，最高同时 ${measured.maxConcurrent} 个`)
    check('3) 200', sync.status, 200)
    check('   每个请求的分支都有结果', Object.keys(sync.body.sync ?? {}).length, SYNC_BATCH)
    check('   结果标为精确值', sync.body.sync[names[0]]?.exact, true)
    // 1 次 for-each-ref 解析名字 + 每个名字一次 rev-list。
    checkLe('   进程数 ≤ 名字数 + 1', measured.count, SYNC_BATCH + 1)
    checkLe('   最高并发 ≤ 4', measured.maxConcurrent, 4)
    // 上限：即使客户端要 300 个名字，也只按 SYNC_MAX_NAMES（64）封顶。
    resetTrace()
    const all = Array.from({ length: BRANCH_COUNT + 1 }, (_, i) => (i === 0 ? 'main' : `feature/branch-${String(i - 1).padStart(3, '0')}`))
    const capped = await get('branch/sync', `&names=${encodeURIComponent(all.join(','))}`)
    const cappedTrace = readTrace()
    console.log(`  [measure] /branch/sync（请求 ${all.length} 个名字）：${cappedTrace.count} 个进程`)
    check('   超出上限时按 64 封顶', Object.keys(capped.body.sync ?? {}).length, 64)
    checkLe('   进程数 ≤ 64 + 1', cappedTrace.count, 65)
  }

  console.log('')
  console.log('=== 4. 首屏分支列表的正确性（进程少不等于结果对）===')
  {
    const entry = res.body.branches.find((b) => b.name === 'main')
    check('4) 当前分支被标记', entry?.current, true)
    check('   current 分支与 git 一致', (await git(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).trim(), 'main')
    check('   有上游的分支带 upstream 短名', entry?.upstream, 'origin/main')
    // 首屏的数字来自 for-each-ref 的 track 字段，因此标为"非精确"；客户端会用
    // `/status`（当前分支）与 `/branch/sync`（可见分支）把它补成精确值。
    check('   首屏数字标为 syncExact=false', entry?.syncExact, false)
    check('   没有上游的分支 syncExact=true（0/0 本来就是精确的）', res.body.branches.find((b) => b.upstream === '')?.syncExact, true)
    checkTrue('   分支条目带提交时间', /^\d{4}-\d{2}-\d{2}T/u.test(String(entry?.committedAt)))
  }
} catch (error) {
  failures += 1
  console.error(`\n[异常] ${error?.stack ?? error}`)
} finally {
  if (child !== undefined) child.kill()
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // 临时目录清理失败不影响结论。
  }
}

console.log('')
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
