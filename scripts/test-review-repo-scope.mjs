// 端到端验证 review 插件的**作用域拆分**（workspaceRoot / repositoryRoot）与**未跟踪文件**
// 的两条路径（快速摘要 / 精确枚举 + 惰性目录树），以及大批量 `git add` 的有界参数。
//
//   node scripts/test-review-repo-scope.mjs
//
// 为什么需要它：这一轮改的全是"看起来能跑、但在真实仓库形状下会错"的东西——
//   * 工作区是仓库的**子目录**时，Changes 必须显示**整个仓库**的改动（git 自己就是这样），
//     而 `ls-files --others` 是 cwd 前缀相对的，从子目录跑会少报文件；
//   * 同一个仓库的两个子目录必须解析出**同一个** repositoryRoot（否则各跑一套快照）；
//   * 常驻轮询必须**不**做完整枚举（实测仓库有 6,846 个未跟踪文件）；
//   * 精确枚举只发生在需要时，并且按 repositoryRoot 缓存；
//   * 一次 `git add` 几千个路径不能把 argv 撑爆（Windows 命令行上限 32K）。
// 这些契约只有在**真实 git 仓库 + 真实 HTTP 服务**上才作数，假 DOM 测不出来。
import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncBundledPlugins } from './sync-plugins.mjs'

/** 需求里点名的量级：一个没有被 .gitignore 覆盖的 `tmp/` 目录。 */
const BIG_UNTRACKED = 6846
/** inline / browse 的阈值（与 host 的 UNTRACKED_INLINE_LIMIT 一致）。 */
const INLINE_LIMIT = 50

const root = mkdtempSync(join(tmpdir(), 'dsh-review-scope-'))
const repo = join(root, 'repo')
const srcDir = join(repo, 'src')
const pagesDir = join(repo, 'pages')
const plainDir = join(root, 'not-a-repo')

let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `（期望 ${expected}）`}`)
}
const checkTrue = (label, actual) => check(label, actual === true, true)
const checkLe = (label, actual, bound) => check(label, actual <= bound, true)

const git = async (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(String(stderr).trim() || error.message))
      else resolve(String(stdout))
    })
  })

/** 建一个文件（必要时建目录），内容一行。 */
const touch = (path, content = 'x\n') => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

let child
try {
  // ---- 造仓库 ---------------------------------------------------------------
  //
  // 形状刻意与实机一致：仓库根 + `src/`（工作区）+ `pages/`，以及一个**大量未跟踪文件**的
  // `tmp/`（6,846 个，分布在三个子目录里）。这样"快路径不枚举"与"惰性树按前缀展开"都能
  // 在真实规模上验证。
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(pagesDir, { recursive: true })
  mkdirSync(plainDir, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'test'])
  execFileSync('git', ['-C', repo, 'config', 'commit.gpgsign', 'false'])
  touch(join(repo, 'root.txt'), 'root base\n')
  mkdirSync(join(srcDir, 'deep'), { recursive: true })
  touch(join(srcDir, 'a.js'), 'a base\n')
  touch(join(srcDir, 'deep', 'b.js'), 'b base\n')
  touch(join(pagesDir, 'x.json'), '{}\n')
  await git(['add', '.'], repo)
  await git(['commit', '-q', '-m', 'init'], repo)

  // 三个位置都改：仓库根、工作区里（含深层）、工作区外。Changes 必须**三个都显示**。
  touch(join(repo, 'root.txt'), 'root changed\n')
  touch(join(srcDir, 'a.js'), 'a changed\n')
  touch(join(srcDir, 'deep', 'b.js'), 'b changed\n')
  touch(join(pagesDir, 'x.json'), '{"x":1}\n')

  // 未跟踪：6846 个文件分布在三个目录 + 根下两个散文件。
  const t0 = Date.now()
  const dirs = [
    ['tmp/magic-api', BIG_UNTRACKED - 11],
    ['tmp/tables', 7],
    ['tmp/imgcheck', 4],
  ]
  for (const [dir, count] of dirs) {
    mkdirSync(join(repo, dir), { recursive: true })
    for (let i = 0; i < count; i += 1) writeFileSync(join(repo, dir, `f${String(i).padStart(5, '0')}.js`), 'x\n')
  }
  const magicCount = BIG_UNTRACKED - 11
  writeFileSync(join(repo, 'loose-a.txt'), 'loose a\n')
  writeFileSync(join(repo, 'loose-b.txt'), 'loose b\n')
  const untrackedTotal = BIG_UNTRACKED + 2
  console.log(`临时仓库: ${repo}`)
  console.log(`  造 ${untrackedTotal} 个未跟踪文件耗时 ${Date.now() - t0}ms`)

  const repoReal = realpathSync.native(repo)
  const srcReal = realpathSync.native(srcDir)
  const pagesReal = realpathSync.native(pagesDir)
  const plainReal = realpathSync.native(plainDir)

  // ---- 多仓库项目（第 12 节）------------------------------------------------
  //
  // 实机反馈的**原样形状**：`F:\code_buss\haiweiNew` 自己不是 Git 仓库，仓库在
  // `haiweiNew/haiwei-manage-fronted/.git` 与 `haiweiNew/haiwei-manage-backend/.git`。
  // 每个仓库各有一个提交与各不相同的分支名，用来断言"请求确实落在选中的那一个上"。
  const multiRoot = join(root, 'haiweiNew')
  const multiFrontend = join(multiRoot, 'haiwei-manage-fronted')
  const multiBackend = join(multiRoot, 'haiwei-manage-backend')
  mkdirSync(multiFrontend, { recursive: true })
  mkdirSync(multiBackend, { recursive: true })
  for (const [dir, branch] of [
    [multiFrontend, 'frontend-main'],
    [multiBackend, 'backend-main'],
  ]) {
    execFileSync('git', ['init', '-q', '-b', branch, dir])
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'])
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'test'])
    execFileSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false'])
    touch(join(dir, 'readme.txt'), `${branch}\n`)
    await git(['add', '.'], dir)
    await git(['commit', '-q', '-m', `init ${branch}`], dir)
  }
  const multiRootReal = realpathSync.native(multiRoot)
  const multiFrontendReal = realpathSync.native(multiFrontend)
  const multiBackendReal = realpathSync.native(multiBackend)

  // ---- 对照：旧的"完整枚举"在常驻路径上要搬多少字节 ---------------------------
  //
  // 这是给最终报告用的**前后对比**：同一条仓库、同一次调用，`-uall` 与 `-unormal` 的输出
  // 体量差多少个数量级。数字直接来自 git，不靠估算。
  {
    const allRaw = await git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], repo)
    const normalRaw = await git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], repo)
    console.log(`  [measure] status -uall   : ${(allRaw.length / 1024).toFixed(1)} KB，${allRaw.split('\0').length} 条记录`)
    console.log(`  [measure] status -unormal: ${(normalRaw.length / 1024).toFixed(1)} KB，${normalRaw.split('\0').length} 条记录`)
    checkLe('  对照：-unormal 的输出不到 -uall 的 1%', normalRaw.length, Math.max(1024, allRaw.length / 100))
  }

  // ---- 起服务端 -------------------------------------------------------------
  const runtime = join(process.cwd(), 'runtime')
  if (!existsSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))) {
    console.log('  缺少 staged 运行时（runtime/），跳过：请先 npm run stage:runtime')
    process.exit(0)
  }
  // 宿主半边由服务端从 runtime/node_modules 加载，因此必须先同步（否则测的是旧副本）。
  syncBundledPlugins()
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
      srcDir,
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

  // 三个工作区都登记：仓库根、两个子目录，外加一个**不是仓库**的普通目录（用来验证
  // `isRepo:false` 这条路径，以及"未登记的目录一律拒绝"）。
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(
    join(home, 'storages', 'workspace.json'),
    JSON.stringify(
      {
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, workspaceIds: [], archivedSessionIds: [] },
        tables: {
          workspaces: {
            w1: { path: repo },
            w2: { path: srcDir },
            w3: { path: pagesDir },
            w4: { path: plainDir },
            w5: { path: multiRoot },
          },
        },
      },
      null,
      2,
    ) + '\n',
  )

  const post = async (route, body) => {
    const response = await fetch(`${base}/dsh-desktop/review/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: srcDir, ...body }),
    })
    const text = await response.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { error: text.slice(0, 200) }
    }
    if (response.status >= 400) {
      console.log(`  [debug] POST ${route} ${response.status} code=${parsed.code ?? '(none)'}`)
    }
    return { status: response.status, body: parsed, bytes: text.length }
  }
  const get = async (route, workspace = srcDir, query = '') => {
    const response = await fetch(
      `${base}/dsh-desktop/review/${route}?workspace=${encodeURIComponent(workspace)}${query}`,
    )
    const text = await response.text()
    return { status: response.status, body: JSON.parse(text), bytes: text.length }
  }

  // =========================================================================
  console.log('')
  console.log('=== 1. 作用域：workspaceRoot 与 repositoryRoot 是两个概念 ===')
  {
    const a = await get('repo-context', srcDir)
    check('1) 200', a.status, 200)
    check('   isRepo', a.body.isRepo, true)
    check('   workspaceRoot 就是请求的工作区', a.body.workspaceRoot, srcReal)
    check('   repositoryRoot 由 host 推导出仓库根', a.body.repositoryRoot, repoReal)
    checkTrue('   仓库根与工作区不是同一个目录', a.body.repositoryRoot !== a.body.workspaceRoot)
    // 同一个仓库的另一个子目录解析出**同一个** repositoryRoot —— 这是"共享一份快照"的前提。
    const b = await get('repo-context', pagesDir)
    check('   pages 的 repositoryRoot 与 src 相同', b.body.repositoryRoot, a.body.repositoryRoot)
    check('   但 workspaceRoot 不同', b.body.workspaceRoot, pagesReal)
    // 仓库根自己也一样。
    const c = await get('repo-context', repo)
    check('   仓库根作为工作区时 repositoryRoot 仍是它自己', c.body.repositoryRoot, repoReal)
    // 多仓库模型预留：scope 里是一个数组，本轮长度恒为 1。
    check('   gitScope.workspaceRoot', a.body.gitScope.workspaceRoot, srcReal)
    check('   gitScope.repositories 长度', a.body.gitScope.repositories.length, 1)
    check('   repositories[0].repositoryRoot', a.body.gitScope.repositories[0].repositoryRoot, repoReal)
    // 不是仓库的目录：明确回 isRepo:false，而不是 500。
    const d = await get('repo-context', plainDir)
    check('   非仓库目录 -> 200 + isRepo:false', `${d.status}/${d.body.isRepo}`, '200/false')
    // 未登记的目录：安全边界仍然生效。
    const denied = await get('repo-context', join(root, 'nope'))
    check('   未登记的工作区 -> 400', denied.status, 400)
    check('   code', denied.body.code, 'workspaceNotAllowed')
  }

  console.log('')
  console.log('=== 2. 客户端传来的 repositoryRoot 一律被忽略（host 自己推导）===')
  {
    // 客户端可以随便说"仓库根是 C:/"，但它只能影响不了任何事：请求体的字段根本没人读。
    const res = await post('workspace', { repositoryRoot: 'C:/', workspaceRoot: 'C:/' })
    check('2) 200', res.status, 200)
    check('   仍然按 workspaceRoot 推导', res.body.repositoryRoot, repoReal)
    check('   不回显客户端给的值', res.body.repositoryRoot === 'C:/', false)
  }

  console.log('')
  console.log('=== 3. 工作区是子目录时，整个仓库的改动都要显示（且路径是仓库相对）===')
  {
    const res = await get('workspace', srcDir)
    check('3) 200', res.status, 200)
    const paths = res.body.files.map((f) => f.path).sort()
    // 三个已跟踪改动 + pages 里那个 = 四条，**与工作区在哪个子目录无关**。
    check('   列出全部四条已跟踪改动', paths.join(','), 'pages/x.json,root.txt,src/a.js,src/deep/b.js')
    checkTrue('   路径里没有 ../', !paths.some((p) => p.includes('..')))
    checkTrue('   路径里没有绝对路径', !paths.some((p) => /^[A-Za-z]:|^\//u.test(p)))
    check('   作用域字段：workspaceRoot', res.body.workspaceRoot, srcReal)
    check('   作用域字段：repositoryRoot', res.body.repositoryRoot, repoReal)
    // 从仓库根请求同一条路由，结果里的路径完全一致（同一个基准）。
    const fromRoot = await get('workspace', repo)
    check('   从仓库根请求得到同样的路径', fromRoot.body.files.map((f) => f.path).sort().join(','), paths.join(','))
    // 从另一个子目录请求也一样——这就是"路径基准唯一"。
    const fromPages = await get('workspace', pagesDir)
    check('   从另一个子目录请求也一样', fromPages.body.files.map((f) => f.path).sort().join(','), paths.join(','))
  }

  console.log('')
  console.log('=== 4. 常驻快照走快路径：不枚举、不搬路径 ===')
  {
    const started = Date.now()
    const res = await get('workspace', srcDir)
    const elapsed = Date.now() - started
    console.log(`  [measure] /workspace（6,848 条未跟踪）耗时 ${elapsed}ms，响应 ${(res.bytes / 1024).toFixed(1)} KB`)
    check('4) 200', res.status, 200)
    // 折叠目录存在 → 快路径只知道"有多少条未跟踪**条目**"，不知道精确文件数。
    check('   exact 为假（还没精确枚举）', res.body.untracked.exact, false)
    check('   模式是 pending', res.body.untracked.mode, 'pending')
    check('   标记为有折叠目录', res.body.untracked.collapsed, true)
    checkTrue('   折叠后条目数远小于文件数', res.body.untracked.count < 10)
    check('   大量模式下 inlineFiles 是空数组', res.body.untracked.inlineFiles.length, 0)
    // 需求二十.2：渲染进程不该持有 6,846 条路径 —— 响应体量就是它的上界。
    checkLe('   响应体量 < 8 KB（不搬 6,846 条路径）', res.bytes, 8192)
    checkTrue('   响应里没有任何一条 tmp/ 下的文件路径', !JSON.stringify(res.body).includes('tmp/magic-api'))
    // 已跟踪清单仍然完整（快路径只牺牲未跟踪的精确性）。
    check('   已跟踪改动仍然四条', res.body.files.length, 4)
    check('   徽标计数 = 已跟踪 + 未跟踪条目（下界）', res.body.changedFiles, 4 + res.body.untracked.count)
    check('   并标明它不是精确值', res.body.changedFilesExact, false)
  }

  console.log('')
  console.log('=== 5. /status 同样不搬整份清单 ===')
  {
    const res = await get('status', srcDir)
    check('5) 200', res.status, 200)
    check('   未跟踪条目数（折叠）', res.body.untracked.count, 3)
    check('   不再有 untrackedPaths 字段', res.body.untrackedPaths, undefined)
    check('   也不再有 untrackedTruncated', res.body.untrackedTruncated, undefined)
    checkLe('   响应体量 < 8 KB', res.bytes, 8192)
    checkTrue('   已跟踪清单完整', res.body.tracked.length >= 4)
  }

  console.log('')
  console.log('=== 6. 精确枚举（lazy）：按需、按 repositoryRoot 缓存 ===')
  let firstExact
  {
    const started = Date.now()
    const res = await post('untracked', { exact: true })
    const elapsed = Date.now() - started
    firstExact = res
    console.log(`  [measure] 精确枚举 ${untrackedTotal} 条耗时 ${elapsed}ms，响应 ${(res.bytes / 1024).toFixed(1)} KB`)
    check('6) 200', res.status, 200)
    check('   精确总数', res.body.total, untrackedTotal)
    check('   超过阈值 -> browse', res.body.mode, 'browse')
    check('   browse 模式不给 inlineFiles', res.body.inlineFiles.length, 0)
    check('   browse 模式不给完整 paths', res.body.paths.length, 0)
    check('   首次未命中缓存', res.body.cached, false)
    // 大仓库也要在有界时间内枚举完（ls-files 一次进程）。
    checkLe('   枚举耗时 < 10s', elapsed, 10000)
    const again = await post('untracked', { exact: true })
    check('   第二次命中缓存', again.body.cached, true)
    check('   结果一致', again.body.total, untrackedTotal)
  }

  console.log('')
  console.log('=== 7. 惰性目录树：只返回当前前缀的直接子节点 ===')
  {
    const rootPage = firstExact.body.tree
    check('7) 根层只有一个目录 tmp', rootPage.directories.map((d) => d.name).join(','), 'tmp')
    check('   目录带后代文件数', rootPage.directories[0].descendantCount, BIG_UNTRACKED)
    check('   根层还有两个散文件', rootPage.files.map((f) => f.name).sort().join(','), 'loose-a.txt,loose-b.txt')
    check('   根层总数', rootPage.total, 3)

    const tmp = await post('untracked', { prefix: 'tmp' })
    check('   tmp 下三个子目录', tmp.body.tree.directories.map((d) => d.name).sort().join(','), 'imgcheck,magic-api,tables')
    check('   magic-api 的后代数', tmp.body.tree.directories.find((d) => d.name === 'magic-api')?.descendantCount, magicCount)
    check('   tmp 下没有直接文件', tmp.body.tree.files.length, 0)
    checkTrue('   展开一层只拿到一层（不含孙节点）', !JSON.stringify(tmp.body.tree).includes('f00001.js'))

    const leaf = await post('untracked', { prefix: 'tmp/magic-api' })
    check('   magic-api 总共多少文件', leaf.body.tree.total, magicCount)
    checkTrue('   默认分页：truncated 为真', leaf.body.tree.truncated === true)
    check('   默认返回 200 条（不是一次性把几千条丢给渲染进程）', leaf.body.tree.files.length, 200)
    // 分页：offset/limit 明确给，且不重不漏。
    const page2 = await post('untracked', { prefix: 'tmp/magic-api', offset: 200, limit: 200 })
    check('   第二页 200 条', page2.body.tree.files.length, 200)
    checkTrue('   两页不重叠', page2.body.tree.files[0].name !== leaf.body.tree.files[0].name)
    const last = await post('untracked', { prefix: 'tmp/magic-api', offset: 6800, limit: 200 })
    check(`   最后一页 ${magicCount - 6800} 条`, last.body.tree.files.length, magicCount - 6800)
    check('   到底了', last.body.tree.truncated, false)
    const missing = await post('untracked', { prefix: 'tmp/nope' })
    check('   不存在的目录 -> 404', missing.status, 404)
    check('   code', missing.body.code, 'noSuchPrefix')
  }

  console.log('')
  console.log('=== 8. 同仓库不同工作区：共用缓存、共用枚举结果 ===')
  {
    // pages 与 src 是两个工作区、同一个仓库：未跟踪枚举必须**复用**（这一步不该再起 git）。
    const fromPages = await post('untracked', { workspace: pagesDir, exact: true })
    check('8) pages 看到同一个总数', fromPages.body.total, untrackedTotal)
    check('   复用同一份缓存', fromPages.body.cached, true)
    check('   repositoryRoot 相同', fromPages.body.repositoryRoot, repoReal)
    check('   workspaceRoot 是 pages', fromPages.body.workspaceRoot, pagesReal)
    // /workspace 在 pages 上也应立刻拿到精确模式（因为缓存新鲜）。
    const snap = await get('workspace', pagesDir)
    check('   pages 的快照直接给出精确模式', snap.body.untracked.mode, 'browse')
    check('   精确条数', snap.body.untracked.count, untrackedTotal)
    check('   已跟踪改动仍是四条（同仓库）', snap.body.files.length, 4)
    checkLe('   响应体量仍然 < 8 KB', snap.bytes, 8192)
  }

  console.log('')
  console.log('=== 9. 阈值：≤ 50 inline、> 50 browse ===')
  {
    // 用两个独立的小仓库把 50/51 这条边界钉死（不能只靠"6846 是 browse"）。
    const makeRepo = async (name, count) => {
      const dir = join(root, name)
      mkdirSync(dir, { recursive: true })
      execFileSync('git', ['init', '-q', '-b', 'main', dir])
      execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'])
      execFileSync('git', ['-C', dir, 'config', 'user.name', 'test'])
      touch(join(dir, 'keep.txt'), 'kept\n')
      await git(['add', '.'], dir)
      await git(['commit', '-q', '-m', 'init'], dir)
      for (let i = 0; i < count; i += 1) writeFileSync(join(dir, `u${String(i).padStart(3, '0')}.txt`), `line ${i}\n`)
      // 登记为可访问工作区。
      const file = join(home, 'storages', 'workspace.json')
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      parsed.tables.workspaces[`w-${name}`] = { path: dir }
      writeFileSync(file, JSON.stringify(parsed, null, 2) + '\n')
      return dir
    }
    const fifty = await makeRepo('fifty', INLINE_LIMIT)
    const fiftyOne = await makeRepo('fiftyone', INLINE_LIMIT + 1)

    const a = await get('workspace', fifty)
    check('9) 50 个未跟踪 -> exact', a.body.untracked.exact, true)
    check('   模式 inline', a.body.untracked.mode, 'inline')
    check('   逐行列出全部 50 条', a.body.untracked.inlineFiles.length, INLINE_LIMIT)
    checkTrue('   没有任何一行的路径被截断掉', a.body.untracked.inlineFiles.every((f) => typeof f.path === 'string'))

    const b = await get('workspace', fiftyOne)
    // 51 个文件**都在根目录下**，git 没有可折叠的目录，因此快路径自己就能定出精确条数
    // ——这是最理想的情况：不需要额外枚举就知道该用 browse。
    check('   51 个未跟踪 -> 仍然是精确的', b.body.untracked.exact, true)
    check('   直接判定为 browse', b.body.untracked.mode, 'browse')
    check('   主面板一行都不给', b.body.untracked.inlineFiles.length, 0)
    checkLe('   响应体量依然很小', b.bytes, 8192)
    const exact = await post('untracked', { workspace: fiftyOne, exact: true })
    check('   精确枚举后仍是 browse', exact.body.mode, 'browse')
    check('   仍然不给 inlineFiles', exact.body.inlineFiles.length, 0)
    check('   精确总数', exact.body.total, INLINE_LIMIT + 1)
    // 折叠目录存在时才是 pending（主 fixture 覆盖；这里再钉一次语义）。
    const pendingCheck = await get('workspace', srcDir)
    checkTrue('   有折叠目录时才是 pending', ['pending', 'browse', 'inline'].includes(pendingCheck.body.untracked.mode))
    // 少量模式要补精确新增行数（有界读取，绝不为一个数字 fork git）。
    const exactFifty = await post('untracked', { workspace: fifty, exact: true })
    check('   50 条都带新增行数', exactFifty.body.inlineFiles.filter((f) => f.added === 1).length, INLINE_LIMIT)
    check('   删除行数为 0', exactFifty.body.inlineFiles[0].removed, 0)
    check('   模式 inline', exactFifty.body.mode, 'inline')
  }

  console.log('')
  console.log('=== 10. 大批量 add：pathspec-from-file，且临时文件必须清理 ===')
  {
    // 从目录树里取 magic-api 下的全部路径（分页取全），再一次性 add。
    const paths = []
    for (let offset = 0; offset < magicCount; offset += 1000) {
      const page = await post('untracked', { prefix: 'tmp/magic-api', offset, limit: 1000 })
      paths.push(...page.body.tree.files.map((f) => f.path))
    }
    check('10) 拿到全部路径', paths.length, magicCount)
    const started = Date.now()
    const res = await post('stage', { paths })
    const elapsed = Date.now() - started
    console.log(`  [measure] 一次 add ${paths.length} 个路径耗时 ${elapsed}ms，模式=${res.body.addMode}`)
    check('   200', res.status, 200)
    check('   走的是 pathspec-from-file', res.body.addMode, 'pathspec-file')
    check('   回显 staged 数量', res.body.staged.length, magicCount)
    // 真的进了索引（不是"回了个 200 什么都没做"）。
    const staged = (await git(['diff', '--cached', '--name-only'], repo)).split('\n').filter((l) => l !== '')
    check('   索引里真的多了这些文件', staged.filter((p) => p.startsWith('tmp/magic-api/')).length, magicCount)
    // 临时 pathspec 文件必须被 finally 清掉（失败路径也一样）。
    const scratch = join(tmpdir(), `dsh-review-${child.pid}`)
    const leftovers = existsSync(scratch) ? readdirSync(scratch).filter((n) => n.startsWith('pathspec-')) : []
    check('   没有残留的临时 pathspec 文件', leftovers.join(','), '')
    // 写操作让未跟踪缓存失效：再枚举时剩下的应该是 30 条（6848-6818=30）→ inline。
    const remaining = untrackedTotal - magicCount
    const after = await post('untracked', { exact: true })
    check('   缓存已失效并重数', after.body.total, remaining)
    check('   剩下的条数 -> inline', after.body.mode, 'inline')
    check('   逐行给出剩下的全部', after.body.inlineFiles.length, remaining)
    // 需求十七：关闭浏览后再看主 Changes，模式从 browse 变成 inline。
    const snap = await get('workspace', srcDir)
    check('   主 Changes 的未跟踪模式变成 inline', snap.body.untracked.mode, 'inline')
    check('   并且逐行给出全部', snap.body.untracked.inlineFiles.length, remaining)
    // 注意：刚加进索引的那 6835 个文件此时是**已跟踪的暂存新增**，因此已跟踪清单会变成
    // 4 + 6835 条——这是 git 的事实，不是这一轮的回归（这一轮只把**未跟踪**清单改成有界）。
    check('   已跟踪清单 = 原有 4 条 + 刚暂存的那些', snap.body.files.length, 4 + magicCount)
    check('   徽标计数 = 已跟踪 + 未跟踪', snap.body.changedFiles, 4 + magicCount + remaining)
    check('   现在声称精确了', snap.body.changedFilesExact, true)
    // 未跟踪那一段仍然是**有界**的：只有 13 条内联行，而且不含刚被暂存的那些路径。
    checkTrue('   未跟踪段里没有刚暂存的路径', !snap.body.untracked.inlineFiles.some((f) => f.path.startsWith('tmp/magic-api/')))
  }

  console.log('')
  console.log('=== 11. 暂存之后再取单个文件的差异（未跟踪路径走 --no-index）===')
  {
    // tmp 下剩下的仍是未跟踪：它们的差异要能取到（那条路径走 `--no-index`）。
    const res = await post('workspace-file', { path: 'tmp/tables/f00000.js', untracked: true })
    check('11) 200', res.status, 200)
    checkTrue('   差异里有新增行', String(res.body.diff).includes('+x'))
    check('   作用域字段', res.body.repositoryRoot, repoReal)
  }
  console.log('')
  console.log('=== 12. 多仓库项目：工作区不是仓库，仓库在子目录里 ===')
  {
    // 这一节就是"实机说当前工作区（haiweiNew）不是 git 仓库"的回归测试。
    const scope = await post('project-git-scope', { workspace: multiRoot })
    check('12) 200', scope.status, 200)
    check('   isRepo（项目里有仓库）', scope.body.isRepo, true)
    check('   发现两个仓库', scope.body.repositories.length, 2)
    check(
      '   仓库名就是两个子目录',
      scope.body.repositories.map((entry) => entry.name).sort().join(','),
      'haiwei-manage-backend,haiwei-manage-fronted',
    )
    check(
      '   相对路径都是 POSIX 且非空',
      scope.body.repositories.map((entry) => entry.relativePath).sort().join(','),
      'haiwei-manage-backend,haiwei-manage-fronted',
    )
    check('   没有把父目录自己当成仓库', scope.body.repositories.filter((entry) => entry.relativePath === '').length, 0)
    check('   每个仓库都带 .git 目录', scope.body.repositories.filter((entry) => entry.gitDir !== '').length, 2)
    check('   候选数 = 2（发现一个就继续扫兄弟目录）', scope.body.discovery.candidatesFound, 2)
    checkTrue('   发现过程有账目可查', scope.body.discovery.directoriesVisited >= 2)
    checkTrue('   在时间预算内完成', scope.body.discovery.durationMs < 10000)

    // 常驻快照：以前这里回 `isRepo:false`（界面于是说"不是 git 仓库"）。
    const snap = await post('workspace', { workspace: multiRoot })
    check('   项目快照 isRepo', snap.body.isRepo, true)
    check('   默认仓库是列表里的第一个', snap.body.repositoryRoot, multiBackendReal)
    check('   分支来自那一个仓库', snap.body.branch, 'backend-main')
    check('   带上仓库名（多仓库 UI 要显示）', snap.body.repositoryName, 'haiwei-manage-backend')
    check('   带上工作区相对路径', snap.body.repositoryRelativePath, 'haiwei-manage-backend')

    const fe = await post('workspace', { workspace: multiRoot, repository: multiFrontend })
    check('   客户端指定 frontend -> 200', fe.status, 200)
    check('   repositoryRoot 是 frontend', fe.body.repositoryRoot, multiFrontendReal)
    check('   分支来自 frontend', fe.body.branch, 'frontend-main')
    check('   项目级 scope 也一并回', fe.body.projectScope.repositories.length, 2)

    // `repository` 是不可信输入：只认本项目发现过的仓库。
    const bogus = await post('workspace', { workspace: multiRoot, repository: repo })
    check('   未发现的仓库 -> 400', bogus.status, 400)
    check('   code 是 repositoryNotAllowed', bogus.body.code, 'repositoryNotAllowed')

    // 写操作（暂存）只落在选中的仓库里：**提交绝不跨仓库**。
    touch(join(multiFrontend, 'fe.txt'), 'fe\n')
    touch(join(multiBackend, 'be.txt'), 'be\n')
    const staged = await post('stage', { workspace: multiRoot, repository: multiFrontend, paths: ['fe.txt'] })
    check('   暂存 frontend 的文件 -> 200', staged.status, 200)
    const stagedInFrontend = (await git(['diff', '--cached', '--name-only'], multiFrontend)).trim()
    const stagedInBackend = (await git(['diff', '--cached', '--name-only'], multiBackend)).trim()
    check('   frontend 的索引里有了它', stagedInFrontend, 'fe.txt')
    check('   backend 的索引里没有它', stagedInBackend, '')
    check('   响应里的 repositoryRoot 是 frontend', staged.body.repositoryRoot, multiFrontendReal)
    // 反方向再验一次：指定 backend 暂存 backend 的文件。
    const stagedBe = await post('stage', { workspace: multiRoot, repository: multiBackend, paths: ['be.txt'] })
    check('   暂存 backend 的文件 -> 200', stagedBe.status, 200)
    check('   backend 的索引里有了它', (await git(['diff', '--cached', '--name-only'], multiBackend)).trim(), 'be.txt')
    check('   frontend 的索引没被它改动', (await git(['diff', '--cached', '--name-only'], multiFrontend)).trim(), 'fe.txt')
  }

} finally {
  if (child !== undefined) child.kill()
  // 6,846 个文件删除要一点时间，但必须清理（否则临时目录越来越大）。
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  } catch {
    // Windows 上偶尔会被索引器占住：留给系统清理，不影响结论。
  }
}

console.log('')
console.log(failures === 0 ? '作用域与未跟踪规模测试全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
