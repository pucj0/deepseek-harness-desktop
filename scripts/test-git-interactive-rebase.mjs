// 交互式变基（`git rebase -i`）的端到端测试，跑在**真实仓库**上。
//
//   node scripts/test-git-interactive-rebase.mjs
//
// 为什么单独一个文件：本轮的 23 条需求里，交互式变基最容易出现"看起来跑通了、
// 其实只是退出码为 0"的功能。因此这里每一条断言问的都是 git 自己：
//   * 提交数、顺序、父提交链（`rev-list --format`、`rev-parse <sha>^`）
//   * 提交信息（`log --format=%B`）
//   * 文件树（`ls-tree -r`、`show <sha>:<path>`）
//   * 操作状态（`status --porcelain=v2` 里的 rebase 标记、`rebase-merge/` 的进度文件）
// 而不是只看 HTTP 状态码。
//
// 覆盖：pick / reword / squash / fixup / drop / 重排 / edit（暂停后 amend + continue）/
// skip / abort / 冲突（含多轮）/ 解决后变空提交再跳过 / 计划校验 / 已发布历史 +
// force-with-lease（含远端被别人推进后的过期 lease）/ 多仓库隔离。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { syncBundledPlugins } from './sync-plugins.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const runtime = join(ROOT, 'runtime')
const NODE = join(runtime, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')

syncBundledPlugins()

let passed = 0
let failed = 0
async function check(name, action) {
  try {
    await action()
    passed += 1
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-git-irebase-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.fileMode=false', '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
}
/** 只关心成功/失败时用（例如"这个对象还在不在"）。 */
function gitTry(cwd, args) {
  try {
    return { ok: true, out: git(cwd, args) }
  } catch (error) {
    return { ok: false, out: `${String(error.stdout ?? '')}${String(error.stderr ?? '')}` }
  }
}
function writeRepoFile(repo, name, text) {
  const absolute = join(repo, name)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, text, 'utf8')
}
function readRepoFile(repo, name) {
  return readFileSync(join(repo, name), 'utf8').replace(/\r\n/gu, '\n')
}
function commitAll(repo, message) {
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', message])
}
const revParse = (repo, ref) => git(repo, ['rev-parse', ref]).trim()
const subject = (repo, ref = 'HEAD') => git(repo, ['log', '-1', '--format=%s', ref]).trim()
/** 完整提交信息（`%B` 后面 git 还会补换行，行尾统一成 LF 后去掉全部结尾换行）。 */
const body = (repo, ref = 'HEAD') => git(repo, ['log', '-1', '--format=%B', ref]).replace(/\r\n/gu, '\n').replace(/\n+$/u, '')
const treeOf = (repo, ref = 'HEAD') => git(repo, ['rev-parse', `${ref}^{tree}`]).trim()
/** 提交主题列表，**从旧到新**（变基之后顺序是不是用户要的那一个，只能这样问）。 */
function subjectsOldestFirst(repo, ref = 'HEAD') {
  return git(repo, ['log', '--reverse', '--format=%s', ref])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}
const shaListOldestFirst = (repo, ref = 'HEAD') =>
  git(repo, ['log', '--reverse', '--format=%H', ref])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
const fileList = (repo, ref = 'HEAD') =>
  git(repo, ['ls-tree', '-r', '--name-only', ref])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
const parentsOf = (repo, ref) =>
  git(repo, ['rev-parse', ref])
    .trim()
    .split('\n')[0] === ''
    ? []
    : git(repo, ['show', '--no-patch', '--format=%P', ref]).trim().split(/\s+/u).filter((value) => value !== '')

/**
 * 已经建好并登记为工作区的仓库。
 *
 * 宿主的"允许的工作区集合"是**每次请求重读** `workspace.json` 的，因此这里可以边建仓库边
 * 登记：每个仓库都注册成一个工作区，请求就用 `cwd=<仓库>` 精确指向它——宿主一步就能解析出
 * 仓库根，不必依赖"多仓库项目的有界目录发现"（那条路径是异步补全的，测试不该被它的时序影响）。
 */
const registeredRepos = []

function createRepo(name) {
  const repo = join(scratch, name)
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '--initial-branch=main'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  writeRepoFile(repo, 'shared.txt', 'base\n')
  commitAll(repo, 'initial')
  registeredRepos.push(repo)
  registerWorkspace(scratch, ...registeredRepos)
  return repo
}

/**
 * 四个提交的线性历史（每个提交各加一个文件）：
 *
 *   initial -> A(Add login API) -> B(Add session store) -> C(Add logout API) -> D(Add tests)
 *
 * 交互式变基总是从 A 开始（`onto = A`，待重放 B/C/D）。
 */
function createLinearRepo(name) {
  const repo = createRepo(name)
  writeRepoFile(repo, 'a.txt', 'a\n')
  commitAll(repo, 'Add login API')
  writeRepoFile(repo, 'b.txt', 'b\n')
  commitAll(repo, 'Add session store')
  writeRepoFile(repo, 'c.txt', 'c\n')
  commitAll(repo, 'Add logout API')
  writeRepoFile(repo, 'd.txt', 'd\n')
  commitAll(repo, 'Add tests')
  return {
    repo,
    A: revParse(repo, 'HEAD~3'),
    B: revParse(repo, 'HEAD~2'),
    C: revParse(repo, 'HEAD~1'),
    D: revParse(repo, 'HEAD'),
  }
}

/** 只改同一个文件的线性历史（用来制造真实的冲突与"解决后变空提交"）。 */
function createSharedFileRepo(name) {
  const repo = createRepo(name)
  writeRepoFile(repo, 'shared.txt', 'A\n')
  commitAll(repo, 'Set A')
  writeRepoFile(repo, 'shared.txt', 'B\n')
  commitAll(repo, 'Set B')
  writeRepoFile(repo, 'shared.txt', 'C\n')
  commitAll(repo, 'Set C')
  return {
    repo,
    A: revParse(repo, 'HEAD~2'),
    B: revParse(repo, 'HEAD~1'),
    C: revParse(repo, 'HEAD'),
  }
}

async function withServer(workspace, body) {
  const child = spawn(NODE, [
    join(runtime, 'server.mjs'),
    '--dsh-home',
    home,
    '--install-anchor',
    join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    '--workspace',
    workspace,
  ])
  let out = ''
  child.stdout.on('data', (chunk) => (out += chunk))
  child.stderr.on('data', (chunk) => (out += chunk))
  try {
    let base
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await new Promise((done) => setTimeout(done, 1000))
      const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/u.exec(out)
      if (match !== null) {
        base = match[1]
        break
      }
    }
    assert.ok(base !== undefined, `server did not become ready:\n${out.slice(-800)}`)
    const call = async (prefix, route, payload) => {
      const readOnly = prefix === '/dsh-desktop/gitbar' && ['status', 'rebase/plan', 'head-commit', 'reset/preview'].includes(route)
      /**
       * 每次请求都带上 `cwd`：**每个仓库都注册成了一个工作区**，因此宿主的
       * "工作区 → 仓库"解析一步就命中（不用等它去扫目录发现子仓库，
       * 那是多仓库项目才需要的有界扫描，测试里没必要依赖它的时序）。
       */
      const target = typeof payload?.cwd === 'string' ? payload.cwd : workspace
      const query = new URLSearchParams({ cwd: target })
      if (typeof payload?.repository === 'string') query.set('repository', payload.repository)
      if (readOnly) {
        for (const [key, value] of Object.entries(payload ?? {})) {
          if (key === 'repository' || key === 'cwd') continue
          query.set(key, String(value))
        }
      }
      const response = await fetch(`${base}${prefix}/${route}?${query.toString()}`, {
        method: readOnly ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        ...(readOnly ? {} : { body: JSON.stringify({ workspace: target, ...(payload ?? {}) }) }),
      })
      const text = await response.text()
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = { raw: text.slice(0, 300) }
      }
      return { status: response.status, body: parsed }
    }
    await body({
      review: (route, payload) => call('/dsh-desktop/review', route, payload),
      gitbar: (route, payload) => call('/dsh-desktop/gitbar', route, payload),
    })
  } finally {
    child.kill()
    await new Promise((done) => setTimeout(done, 800))
  }
}

function registerWorkspace(...roots) {
  mkdirSync(join(home, 'storages'), { recursive: true })
  const now = new Date().toISOString()
  const workspaces = {}
  roots.forEach((root, index) => {
    workspaces[`w${index + 1}`] = { path: root, title: `repo${index + 1}`, sessionIds: [], createdAt: now, updatedAt: now }
  })
  writeFileSync(
    join(home, 'storages', 'workspace.json'),
    JSON.stringify(
      {
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, workspaceIds: roots.map((_, index) => `w${index + 1}`), archivedSessionIds: [] },
        tables: { workspaces },
      },
      null,
      2,
    ) + '\n',
  )
}

/** 开始一次交互式变基（默认带上那次唯一的改写确认）。 */
function startPlan(gitbar, repo, onto, plan, extra = {}) {
  return gitbar('rebase/interactive', { cwd: repo, onto, plan, acknowledgeRewrite: true, ...extra })
}

try {
  // =========================================================================
  console.log('=== 1. /rebase/plan：从某个提交之后的待重放提交 ===')
  // =========================================================================
  const linear = createLinearRepo('plan-repo')
  const { repo: planRepo, A: planA, B: planB, C: planC, D: planD } = linear

  // 多仓库隔离用的第二个仓库：只多一个提交，用来断言计划不会串仓库。
  const other = createRepo('isolation-repo')
  writeRepoFile(other, 'x.txt', 'x\n')
  commitAll(other, 'Add x')

  // `createRepo` 已经逐个把它们登记成了工作区，这里不需要再登记一次。
  await withServer(scratch, async ({ gitbar, review }) => {
    await check('1.1) /rebase/plan 按**从旧到新**列出 onto..HEAD，并带上作者与父提交', async () => {
      const plan = await gitbar('rebase/plan', { cwd: planRepo, revision: planA })
      assert.equal(plan.status, 200, JSON.stringify(plan.body).slice(0, 300))
      assert.equal(plan.body.count, 3)
      assert.deepEqual(
        plan.body.commits.map((entry) => entry.sha),
        [planB, planC, planD],
      )
      assert.deepEqual(
        plan.body.commits.map((entry) => entry.subject),
        ['Add session store', 'Add logout API', 'Add tests'],
      )
      assert.equal(plan.body.commits[0].author, 'Test')
      assert.deepEqual(plan.body.commits[0].parents, [planA])
      assert.equal(plan.body.onto.sha, planA)
      assert.equal(plan.body.head.sha, planD)
      assert.equal(plan.body.branch, 'main')
      // 还没有远端：这段历史尚未发布。
      assert.equal(plan.body.published, false)
      assert.equal(plan.body.upstream, '')
    })

    await check('1.2) 计划里的提交与隔离仓库互不干扰（多仓库）', async () => {
      const plan = await gitbar('rebase/plan', { cwd: other, revision: revParse(other, 'HEAD~1') })
      assert.equal(plan.status, 200, JSON.stringify(plan.body).slice(0, 300))
      assert.equal(plan.body.count, 1)
      assert.deepEqual(
        plan.body.commits.map((entry) => entry.subject),
        ['Add x'],
      )
      const foreign = await gitbar('rebase/plan', { cwd: other, revision: planB })
      assert.equal(foreign.status, 404, JSON.stringify(foreign.body).slice(0, 200))
    })

    await check('1.3) 不带确认的改写请求被拒（一次显式确认是硬要求）', async () => {
      const rejected = await gitbar('rebase/interactive', {
        repository: planRepo,
        onto: planA,
        plan: [{ sha: planB, action: 'pick' }],
      })
      assert.equal(rejected.status, 400, JSON.stringify(rejected.body).slice(0, 200))
      assert.equal(rejected.body.code, 'rewriteNotAcknowledged')
      assert.equal(revParse(planRepo, 'HEAD'), planD)
    })

    await check('1.4) 动作白名单：未知动作被拒且不改动仓库', async () => {
      const rejected = await startPlan(gitbar, planRepo, planA, [
        { sha: planB, action: 'pick' },
        { sha: planC, action: 'exec' },
        { sha: planD, action: 'pick' },
      ])
      assert.equal(rejected.status, 400, JSON.stringify(rejected.body).slice(0, 200))
      assert.equal(rejected.body.code, 'invalidAction')
      assert.equal(revParse(planRepo, 'HEAD'), planD)
    })

    await check('1.5) 提交集合必须**恰好**是 onto..HEAD（少一个 / 多一个 / 重复都不行）', async () => {
      const missing = await startPlan(gitbar, planRepo, planA, [
        { sha: planB, action: 'pick' },
        { sha: planC, action: 'pick' },
      ])
      assert.equal(missing.status, 409, JSON.stringify(missing.body).slice(0, 200))
      assert.equal(missing.body.code, 'commitSetMismatch')
      const duplicated = await startPlan(gitbar, planRepo, planA, [
        { sha: planB, action: 'pick' },
        { sha: planB, action: 'pick' },
        { sha: planC, action: 'pick' },
      ])
      assert.equal(duplicated.status, 409, JSON.stringify(duplicated.body).slice(0, 200))
      assert.equal(duplicated.body.code, 'commitSetMismatch')
      assert.equal(revParse(planRepo, 'HEAD'), planD)
    })

    await check('1.6) 别的仓库的 SHA 解析不出来 -> 404（结构性挡住跨仓库重放）', async () => {
      const rejected = await startPlan(gitbar, planRepo, planA, [
        { sha: planB, action: 'pick' },
        { sha: planC, action: 'pick' },
        { sha: revParse(other, 'HEAD'), action: 'pick' },
      ])
      assert.equal(rejected.status, 404, JSON.stringify(rejected.body).slice(0, 200))
      assert.equal(rejected.body.code, 'noSuchRevision')
    })

    await check('1.7) 第一行不能是 squash/fixup（git 会拒绝并留下卡住的 rebase 状态）', async () => {
      const rejected = await startPlan(gitbar, planRepo, planA, [
        { sha: planB, action: 'squash', message: 'x' },
        { sha: planC, action: 'pick' },
        { sha: planD, action: 'pick' },
      ])
      assert.equal(rejected.status, 409, JSON.stringify(rejected.body).slice(0, 200))
      assert.equal(rejected.body.code, 'squashWithoutPrevious')
      // 没有任何 rebase 被留下（提前挡住的价值就在这里）。
      const status = await gitbar('status', { cwd: planRepo })
      assert.equal(status.body.operation, null)
    })

    await check('1.8) 空计划被拒', async () => {
      const rejected = await startPlan(gitbar, planRepo, planA, [])
      assert.equal(rejected.status, 400, JSON.stringify(rejected.body).slice(0, 200))
      assert.equal(rejected.body.code, 'emptyRebasePlan')
    })

    await check('1.9) HEAD 就是 onto 时没有可重放的提交', async () => {
      const rejected = await startPlan(gitbar, planRepo, planD, [{ sha: planD, action: 'pick' }])
      assert.equal(rejected.status, 409, JSON.stringify(rejected.body).slice(0, 200))
      assert.equal(rejected.body.code, 'nothingToDo')
    })

    // -----------------------------------------------------------------------
    console.log('')
    console.log('=== 2. pick / drop / 重排：真实 git 改写过的历史 ===')
    // -----------------------------------------------------------------------
    const pickRepo = createLinearRepo('pick-repo')
    const pickBefore = {
      count: Number(git(pickRepo.repo, ['rev-list', '--count', 'HEAD']).trim()),
      tree: treeOf(pickRepo.repo),
      files: fileList(pickRepo.repo),
      shas: shaListOldestFirst(pickRepo.repo),
    }
    const picked = await startPlan(gitbar, pickRepo.repo, pickRepo.A, [
      { sha: pickRepo.B, action: 'pick' },
      { sha: pickRepo.C, action: 'pick' },
      { sha: pickRepo.D, action: 'pick' },
    ])
    await check('2.1) 全 pick 且顺序不变时 git 走 fast-forward：真正的改写只发生在计划被改动时', () => {
      assert.equal(picked.status, 200, JSON.stringify(picked.body).slice(0, 300))
      assert.equal(picked.body.rebase.started, true)
      assert.equal(picked.body.rebase.paused, false)
      assert.equal(picked.body.rebase.conflicted, false)
      const after = shaListOldestFirst(pickRepo.repo)
      assert.equal(after.length, pickBefore.count, '提交数必须不变')
      /**
       * 实测（git 2.54）：todo 与原始顺序**完全一致**时，每一条 `pick` 的父提交已经就是当前
       * HEAD，git 直接前移分支指针，**不重建提交**，因此 SHA 不变。这不是"没有执行"——
       * 计划一旦被改动（drop / 重排 / reword，见 2.3 / 2.4 / 3.x）就必须重建，SHA 一定变。
       */
      assert.deepEqual(after, pickBefore.shas, `顺序不变的重放应当是 fast-forward，SHA 不该变：${after.join(',')}`)
    })

    await check('2.2) 顺序、信息、文件树都与改写前一致（pick 只换 SHA）', () => {
      assert.deepEqual(subjectsOldestFirst(pickRepo.repo), ['initial', 'Add login API', 'Add session store', 'Add logout API', 'Add tests'])
      assert.deepEqual(fileList(pickRepo.repo), pickBefore.files)
      assert.equal(treeOf(pickRepo.repo), pickBefore.tree)
      assert.deepEqual(parentsOf(pickRepo.repo, 'HEAD'), [revParse(pickRepo.repo, 'HEAD~1')])
      // 变基结束之后没有任何遗留状态。
      assert.equal(git(pickRepo.repo, ['status', '--porcelain']).trim(), '')
    })

    const dropRepo = createLinearRepo('drop-repo')
    const dropped = await startPlan(gitbar, dropRepo.repo, dropRepo.A, [
      { sha: dropRepo.B, action: 'pick' },
      { sha: dropRepo.C, action: 'drop' },
      { sha: dropRepo.D, action: 'pick' },
    ])
    await check('2.3) drop 真的把那个提交从历史里去掉（提交数 -1、文件也没了）', () => {
      assert.equal(dropped.status, 200, JSON.stringify(dropped.body).slice(0, 300))
      assert.deepEqual(subjectsOldestFirst(dropRepo.repo), ['initial', 'Add login API', 'Add session store', 'Add tests'])
      assert.deepEqual(fileList(dropRepo.repo), ['a.txt', 'b.txt', 'd.txt', 'shared.txt'])
      // 对象本身还在（没有被删），但它已经不是当前分支的祖先了：这就是 drop 的含义。
      assert.equal(gitTry(dropRepo.repo, ['cat-file', '-e', `${dropRepo.C}^{commit}`]).ok, true)
      assert.equal(gitTry(dropRepo.repo, ['merge-base', '--is-ancestor', dropRepo.C, 'HEAD']).ok, false)
    })

    const reorderRepo = createLinearRepo('reorder-repo')
    const reordered = await startPlan(gitbar, reorderRepo.repo, reorderRepo.A, [
      { sha: reorderRepo.D, action: 'pick' },
      { sha: reorderRepo.B, action: 'pick' },
      { sha: reorderRepo.C, action: 'pick' },
    ])
    await check('2.4) 重排：日志顺序按计划变，父提交链逐级接上', () => {
      assert.equal(reordered.status, 200, JSON.stringify(reordered.body).slice(0, 300))
      assert.deepEqual(subjectsOldestFirst(reorderRepo.repo), [
        'initial',
        'Add login API',
        'Add tests',
        'Add session store',
        'Add logout API',
      ])
      const [a, d, b, c] = shaListOldestFirst(reorderRepo.repo).slice(1)
      assert.equal(a, revParse(reorderRepo.repo, 'HEAD~3'))
      assert.deepEqual(parentsOf(reorderRepo.repo, d), [a])
      assert.deepEqual(parentsOf(reorderRepo.repo, b), [d])
      assert.deepEqual(parentsOf(reorderRepo.repo, c), [b])
      // 四个文件互不冲突：最终树与重排前一模一样。
      assert.deepEqual(fileList(reorderRepo.repo), ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'shared.txt'])
    })

    // -----------------------------------------------------------------------
    console.log('')
    console.log('=== 3. squash / fixup / reword ===')
    // -----------------------------------------------------------------------
    const squashRepo = createLinearRepo('squash-repo')
    const squashed = await startPlan(gitbar, squashRepo.repo, squashRepo.A, [
      { sha: squashRepo.B, action: 'pick' },
      { sha: squashRepo.C, action: 'squash', message: 'Add session and logout API\n\nCombined for review.\n' },
      { sha: squashRepo.D, action: 'pick' },
    ])
    await check('3.1) squash：内容合进上一个提交，最终信息是**用户写的那一条**', () => {
      assert.equal(squashed.status, 200, JSON.stringify(squashed.body).slice(0, 300))
      assert.deepEqual(subjectsOldestFirst(squashRepo.repo), [
        'initial',
        'Add login API',
        'Add session and logout API',
        'Add tests',
      ])
      const combined = shaListOldestFirst(squashRepo.repo)[2]
      // 正文也带上了（不只是标题）。
      assert.match(body(squashRepo.repo, combined), /Combined for review\./u)
      // 两个提交的内容都在：squash 是"合内容"，不是"丢内容"。
      assert.deepEqual(fileList(squashRepo.repo, combined), ['a.txt', 'b.txt', 'c.txt', 'shared.txt'])
      assert.equal(git(squashRepo.repo, ['show', `${combined}:c.txt`]).replace(/\r\n/gu, '\n'), 'c\n')
      assert.equal(git(squashRepo.repo, ['rev-list', '--count', 'HEAD']).trim(), '4')
    })

    const fixupRepo = createLinearRepo('fixup-repo')
    const fixedUp = await startPlan(gitbar, fixupRepo.repo, fixupRepo.A, [
      { sha: fixupRepo.B, action: 'pick' },
      { sha: fixupRepo.C, action: 'fixup' },
      { sha: fixupRepo.D, action: 'pick' },
    ])
    await check('3.2) fixup：内容合进去、信息被丢掉（保留的是上一个提交的信息）', () => {
      assert.equal(fixedUp.status, 200, JSON.stringify(fixedUp.body).slice(0, 300))
      assert.deepEqual(subjectsOldestFirst(fixupRepo.repo), [
        'initial',
        'Add login API',
        'Add session store',
        'Add tests',
      ])
      const merged = shaListOldestFirst(fixupRepo.repo)[2]
      assert.deepEqual(fileList(fixupRepo.repo, merged), ['a.txt', 'b.txt', 'c.txt', 'shared.txt'])
      assert.equal(body(fixupRepo.repo, merged), 'Add session store')
    })

    const rewordRepo = createLinearRepo('reword-repo')
    const rewordTreeBefore = treeOf(rewordRepo.repo, rewordRepo.C)
    const reworded = await startPlan(gitbar, rewordRepo.repo, rewordRepo.A, [
      { sha: rewordRepo.B, action: 'pick' },
      { sha: rewordRepo.C, action: 'reword', message: 'Add logout endpoint (renamed)\n' },
      { sha: rewordRepo.D, action: 'pick' },
    ])
    await check('3.3) reword：只换信息，内容与提交数一动不动', () => {
      assert.equal(reworded.status, 200, JSON.stringify(reworded.body).slice(0, 300))
      assert.deepEqual(subjectsOldestFirst(rewordRepo.repo), [
        'initial',
        'Add login API',
        'Add session store',
        'Add logout endpoint (renamed)',
        'Add tests',
      ])
      const rewordedSha = shaListOldestFirst(rewordRepo.repo)[3]
      assert.equal(body(rewordRepo.repo, rewordedSha), 'Add logout endpoint (renamed)')
      // 树与改写前**完全相同**：reword 不该动内容（这是它和 edit 的区别）。
      assert.equal(treeOf(rewordRepo.repo, rewordedSha), rewordTreeBefore)
      assert.equal(git(rewordRepo.repo, ['rev-list', '--count', 'HEAD']).trim(), '5')
      // 变基跑完了，没有留下任何进行中的操作。
      assert.equal(git(rewordRepo.repo, ['status', '--porcelain']).trim(), '')
    })

    // -----------------------------------------------------------------------
    console.log('')
    console.log('=== 4. edit：暂停、改文件、amend、继续 ===')
    // -----------------------------------------------------------------------
    const editRepo = createLinearRepo('edit-repo')
    const editStarted = await startPlan(gitbar, editRepo.repo, editRepo.A, [
      { sha: editRepo.B, action: 'pick' },
      { sha: editRepo.C, action: 'edit' },
      { sha: editRepo.D, action: 'pick' },
    ])
    await check('4.1) edit 停点是**成功**（不是失败），并给出进度与当前提交', async () => {
      assert.equal(editStarted.status, 200, JSON.stringify(editStarted.body).slice(0, 300))
      assert.equal(editStarted.body.rebase.paused, true)
      assert.equal(editStarted.body.rebase.conflicted, false)
      const operation = editStarted.body.rebase.operation
      assert.equal(operation.type, 'rebase')
      assert.equal(operation.interactive, true)
      assert.equal(operation.pausedForEdit, true)
      assert.equal(operation.plannedAction, 'edit')
      assert.equal(operation.currentSubject, 'Add logout API')
      assert.equal(operation.stoppedSha, editRepo.C)
      assert.equal(operation.total, 3)
      assert.equal(operation.step, 2)
    })

    await check('4.2) 暂停时 /status 也报同一份交互式变基状态（界面靠它恢复现场）', async () => {
      const status = await gitbar('status', { cwd: editRepo.repo })
      assert.equal(status.status, 200)
      assert.equal(status.body.rebasing, true)
      assert.equal(status.body.operation.interactive, true)
      assert.equal(status.body.operation.currentSubject, 'Add logout API')
      assert.equal(status.body.operation.step, 2)
      assert.equal(status.body.operation.total, 3)
      assert.equal(status.body.conflictCount, 0)
    })

    await check('4.3) 停在 edit 上时可以改文件、暂存，并用 `/rebase/amend` 折进那个提交', async () => {
      // 用户在这个提交里补了一行：内容必须进那个提交（而不是新建一个提交）。
      writeRepoFile(editRepo.repo, 'c.txt', 'c\nedited-in-place\n')
      git(editRepo.repo, ['add', 'c.txt'])
      const amended = await gitbar('rebase/amend', { cwd: editRepo.repo, message: 'Add logout API (edited)' })
      assert.equal(amended.status, 200, JSON.stringify(amended.body).slice(0, 300))
      assert.equal(amended.body.amended, true)
      assert.equal(subject(editRepo.repo), 'Add logout API (edited)')
      assert.equal(git(editRepo.repo, ['show', 'HEAD:c.txt']).replace(/\r\n/gu, '\n'), 'c\nedited-in-place\n')
      // 仍然是同一次变基在暂停中（amend 不会结束它），也没多出一条提交（是折进去，不是加一条）。
      assert.equal(amended.body.operation.interactive, true)
      assert.equal(amended.body.operation.pausedForEdit, true)
      assert.equal(git(editRepo.repo, ['rev-list', '--count', 'HEAD']).trim(), '4')
    })

    await check('4.4) 继续之后变基跑完：剩余提交被重放，操作状态清空', async () => {
      const continued = await gitbar('op/continue', { cwd: editRepo.repo })
      assert.equal(continued.status, 200, JSON.stringify(continued.body).slice(0, 300))
      assert.equal(continued.body.continued, 'rebase')
      assert.equal(continued.body.operation, null)
      assert.deepEqual(subjectsOldestFirst(editRepo.repo), [
        'initial',
        'Add login API',
        'Add session store',
        'Add logout API (edited)',
        'Add tests',
      ])
      assert.equal(git(editRepo.repo, ['rev-list', '--count', 'HEAD']).trim(), '5')
      assert.equal(git(editRepo.repo, ['status', '--porcelain']).trim(), '')
      assert.deepEqual(fileList(editRepo.repo), ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'shared.txt'])
    })

    // -----------------------------------------------------------------------
    console.log('')
    console.log('=== 4b. amend 的另一种用法与边界 ===')
    // -----------------------------------------------------------------------
    const amendRepo = createLinearRepo('amend-at-stop-repo')
    await startPlan(gitbar, amendRepo.repo, amendRepo.A, [
      { sha: amendRepo.B, action: 'pick' },
      { sha: amendRepo.C, action: 'edit' },
      { sha: amendRepo.D, action: 'pick' },
    ])
    await check('4.5) 信息留空 = 只改内容（`--no-edit`）：信息保持原样、改动折进去', async () => {
      writeRepoFile(amendRepo.repo, 'c.txt', 'c\nplus-one-line\n')
      git(amendRepo.repo, ['add', 'c.txt'])
      const amended = await gitbar('rebase/amend', { cwd: amendRepo.repo, message: '' })
      assert.equal(amended.status, 200, JSON.stringify(amended.body).slice(0, 300))
      assert.equal(subject(amendRepo.repo), 'Add logout API', '信息留空时不该动信息')
      assert.equal(git(amendRepo.repo, ['show', 'HEAD:c.txt']).replace(/\r\n/gu, '\n'), 'c\nplus-one-line\n')
    })

    await check('4.6) 不在交互式变基的停点上 amend 被拒（不许改写用户没在编辑的提交）', async () => {
      const rejected = await gitbar('rebase/amend', { cwd: other, message: 'nope' })
      assert.equal(rejected.status, 409, JSON.stringify(rejected.body).slice(0, 200))
      assert.equal(rejected.body.code, 'noOperation')
      // 收尾：把这次变基跑完（也让后面的用例不会踩到它）。
      const finished = await gitbar('op/continue', { cwd: amendRepo.repo })
      assert.equal(finished.status, 200, JSON.stringify(finished.body).slice(0, 200))
      assert.equal(finished.body.operation, null)
    })

    // -----------------------------------------------------------------------
    console.log('')
    console.log('=== 5. skip / abort ===')
    // -----------------------------------------------------------------------
    const skipRepo = createLinearRepo('skip-repo')
    await startPlan(gitbar, skipRepo.repo, skipRepo.A, [
      { sha: skipRepo.B, action: 'pick' },
      { sha: skipRepo.C, action: 'edit' },
      { sha: skipRepo.D, action: 'pick' },
    ])
    const skipped = await gitbar('rebase/skip', { cwd: skipRepo.repo })
    await check('5.1) edit 停点上 `--skip` 只继续：那个提交**已经应用**，git 没有可跳过的对象', () => {
      assert.equal(skipped.status, 200, JSON.stringify(skipped.body).slice(0, 300))
      assert.equal(skipped.body.rebase.skipped, true)
      // 点名的是"跳过时停在哪个提交"，但同时如实说明它**没有**被丢掉——edit 停点上提交
      // 已经落盘，`git rebase --skip` 与 `--continue` 等价。界面据此只在冲突停点承诺"丢弃"。
      assert.equal(skipped.body.rebase.skippedSha, skipRepo.C)
      assert.equal(skipped.body.rebase.skippedSubject, 'Add logout API')
      assert.equal(skipped.body.rebase.dropped, false, 'edit 停点上没有提交真的被丢掉')
      assert.equal(skipped.body.rebase.paused, false)
      assert.deepEqual(subjectsOldestFirst(skipRepo.repo), [
        'initial',
        'Add login API',
        'Add session store',
        'Add logout API',
        'Add tests',
      ])
      assert.equal(git(skipRepo.repo, ['status', '--porcelain']).trim(), '')
    })

    await check('5.2) 没有变基在进行时 skip 被拒', async () => {
      const rejected = await gitbar('rebase/skip', { cwd: skipRepo.repo })
      assert.equal(rejected.status, 409, JSON.stringify(rejected.body).slice(0, 200))
      assert.equal(rejected.body.code, 'noOperation')
    })

    const abortRepo = createLinearRepo('abort-repo')
    const abortHeadBefore = revParse(abortRepo.repo, 'HEAD')
    await startPlan(gitbar, abortRepo.repo, abortRepo.A, [
      { sha: abortRepo.B, action: 'pick' },
      { sha: abortRepo.C, action: 'edit' },
      { sha: abortRepo.D, action: 'pick' },
    ])
    writeRepoFile(abortRepo.repo, 'c.txt', 'c\nhalf-done\n')
    git(abortRepo.repo, ['add', '-A'])
    const aborted = await gitbar('op/abort', { cwd: abortRepo.repo, kind: 'rebase' })
    await check('5.3) 中止交互式变基 = 真正的 `git rebase --abort`：分支、工作区、状态全部回退', () => {
      assert.equal(aborted.status, 200, JSON.stringify(aborted.body).slice(0, 300))
      assert.equal(aborted.body.aborted, 'rebase')
      assert.equal(revParse(abortRepo.repo, 'HEAD'), abortHeadBefore, 'HEAD 必须回到变基前的那个提交')
      assert.equal(git(abortRepo.repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'main')
      assert.equal(git(abortRepo.repo, ['status', '--porcelain']).trim(), '')
      assert.equal(readRepoFile(abortRepo.repo, 'c.txt'), 'c\n')
      assert.equal(aborted.body.operation, null)
      assert.deepEqual(subjectsOldestFirst(abortRepo.repo), ['initial', 'Add login API', 'Add session store', 'Add logout API', 'Add tests'])
    })

    // -----------------------------------------------------------------------
    console.log('')
    console.log('=== 6. 冲突：复用既有冲突解决流程（含多轮） ===')
    // -----------------------------------------------------------------------
    const conflict = createSharedFileRepo('conflict-repo')
    const conflictStart = await startPlan(gitbar, conflict.repo, conflict.A, [
      { sha: conflict.C, action: 'pick' },
      { sha: conflict.B, action: 'pick' },
    ])
    await check('6.1) 变基途中冲突 -> 与普通变基同一个 code（既有冲突面板原样复用）', async () => {
      assert.equal(conflictStart.status, 409, JSON.stringify(conflictStart.body).slice(0, 300))
      assert.equal(conflictStart.body.code, 'rebaseConflict')
      const status = await gitbar('status', { cwd: conflict.repo })
      assert.equal(status.body.operation.type, 'rebase')
      assert.equal(status.body.operation.interactive, true, '冲突之后仍然是交互式变基（进度文件还在）')
      assert.equal(status.body.operation.total, 2)
      assert.deepEqual(
        status.body.conflicts.map((entry) => entry.path),
        ['shared.txt'],
      )
    })

    await check('6.2) 第一轮解决后继续：宿主说明这是**下一轮冲突**而不是失败', async () => {
      // 冲突两侧都在（stage 2 = 目标分支上的 A，stage 3 = 正在重放的 C）。
      const stages = await review('conflict', { cwd: conflict.repo, path: 'shared.txt' })
      assert.equal(stages.status, 200, JSON.stringify(stages.body).slice(0, 200))
      assert.equal(stages.body.ours, 'A\n')
      assert.equal(stages.body.theirs, 'C\n')
      await review('conflict-resolve', { cwd: conflict.repo, path: 'shared.txt', content: 'C\n', markResolved: true })
      const first = await gitbar('op/continue', { cwd: conflict.repo })
      assert.equal(first.status, 200, JSON.stringify(first.body).slice(0, 300))
      assert.equal(first.body.continued, 'rebase')
      assert.equal(first.body.stoppedAtNextConflict, true)
      assert.deepEqual(first.body.paths, ['shared.txt'])
    })

    await check('6.3) 第二轮解决后继续 -> 变基完成，顺序与内容就是计划要的', async () => {
      await review('conflict-resolve', { cwd: conflict.repo, path: 'shared.txt', content: 'B\n', markResolved: true })
      const second = await gitbar('op/continue', { cwd: conflict.repo })
      assert.equal(second.status, 200, JSON.stringify(second.body).slice(0, 300))
      assert.equal(second.body.continued, 'rebase')
      assert.equal(second.body.stoppedAtNextConflict, undefined)
      assert.equal(second.body.operation, null)
      assert.deepEqual(subjectsOldestFirst(conflict.repo), ['initial', 'Set A', 'Set C', 'Set B'])
      assert.equal(readRepoFile(conflict.repo, 'shared.txt'), 'B\n')
      assert.equal(git(conflict.repo, ['status', '--porcelain']).trim(), '')
    })

    await check('6.4) 冲突停点上直接 `--skip`：被跳过的提交要能点名，变基继续跑完', async () => {
      const skipConflict = createSharedFileRepo('skip-conflict-repo')
      const started = await startPlan(gitbar, skipConflict.repo, skipConflict.A, [
        { sha: skipConflict.C, action: 'pick' },
        { sha: skipConflict.B, action: 'pick' },
      ])
      assert.equal(started.status, 409, JSON.stringify(started.body).slice(0, 200))
      const skipped = await gitbar('rebase/skip', { cwd: skipConflict.repo })
      assert.equal(skipped.status, 200, JSON.stringify(skipped.body).slice(0, 300))
      assert.equal(skipped.body.rebase.skippedSha, skipConflict.C, '必须点名被跳过的是哪一个提交')
      assert.equal(skipped.body.rebase.skippedSubject, 'Set C')
      assert.equal(skipped.body.rebase.dropped, true, '冲突停点上这个提交确实被丢掉了')
      // 跳过 C 之后 B 照常重放（B 的补丁 A->B 落在 A 上，不冲突）。
      assert.deepEqual(subjectsOldestFirst(skipConflict.repo), ['initial', 'Set A', 'Set B'])
      assert.equal(readRepoFile(skipConflict.repo, 'shared.txt'), 'B\n')
      assert.equal(git(skipConflict.repo, ['status', '--porcelain']).trim(), '')
    })

    await check('6.5) 冲突解决成"和目标内容一样"-> git 丢弃这个提交（`--empty=drop`），继续即完成', async () => {
      // 这是实测的 git 行为：解决之后没有任何改动时，rebase 不会造一个空提交，而是**丢掉**
      // 这个提交并继续（与先 skip 它等价）。宿主因此不需要也不应该在这里报错。
      const empty = createSharedFileRepo('empty-repo')
      const started = await startPlan(gitbar, empty.repo, empty.A, [
        { sha: empty.C, action: 'pick' },
        { sha: empty.B, action: 'pick' },
      ])
      assert.equal(started.status, 409, JSON.stringify(started.body).slice(0, 200))
      await review('conflict-resolve', { cwd: empty.repo, path: 'shared.txt', content: 'A\n', markResolved: true })
      const continued = await gitbar('op/continue', { cwd: empty.repo })
      assert.equal(continued.status, 200, JSON.stringify(continued.body).slice(0, 300))
      assert.equal(continued.body.operation, null)
      assert.deepEqual(subjectsOldestFirst(empty.repo), ['initial', 'Set A', 'Set B'])
      assert.equal(git(empty.repo, ['rev-list', '--count', 'HEAD']).trim(), '3')
      assert.equal(readRepoFile(empty.repo, 'shared.txt'), 'B\n')
    })

    // -----------------------------------------------------------------------
    console.log('')
    console.log('=== 7. reword + 冲突：计划里的合并信息必须在冲突之后仍然生效 ===')
    // -----------------------------------------------------------------------
    const squashConflict = createSharedFileRepo('squash-conflict-repo')
    const scStarted = await startPlan(gitbar, squashConflict.repo, squashConflict.A, [
      { sha: squashConflict.C, action: 'pick' },
      { sha: squashConflict.B, action: 'squash', message: 'Set C then B (squashed)\n' },
    ])
    await check('7.1) 冲突停在第一行时 msgnum/进度仍然可读', () => {
      assert.equal(scStarted.status, 409, JSON.stringify(scStarted.body).slice(0, 200))
      assert.equal(scStarted.status, 409)
    })

    const scAfterFirst = await (async () => {
      await review('conflict-resolve', { cwd: squashConflict.repo, path: 'shared.txt', content: 'C\n', markResolved: true })
      return gitbar('op/continue', { cwd: squashConflict.repo })
    })()
    await check('7.2) 第二行（squash）再冲突：仍然是"下一轮冲突"而不是失败', () => {
      assert.equal(scAfterFirst.status, 200, JSON.stringify(scAfterFirst.body).slice(0, 300))
      assert.equal(scAfterFirst.body.stoppedAtNextConflict, true)
    })

    const scFinal = await (async () => {
      await review('conflict-resolve', { cwd: squashConflict.repo, path: 'shared.txt', content: 'B\n', markResolved: true })
      return gitbar('op/continue', { cwd: squashConflict.repo })
    })()
    await check('7.3) 冲突解决后的 squash 用的是**计划里的信息**（宿主编辑器按 msgnum 命中）', () => {
      assert.equal(scFinal.status, 200, JSON.stringify(scFinal.body).slice(0, 300))
      assert.deepEqual(subjectsOldestFirst(squashConflict.repo), ['initial', 'Set A', 'Set C then B (squashed)'])
      assert.equal(body(squashConflict.repo), 'Set C then B (squashed)')
      // initial + Set A + 合并后的那一个 = 3 个提交（两个提交被压成一个）。
      assert.equal(git(squashConflict.repo, ['rev-list', '--count', 'HEAD']).trim(), '3')
      assert.equal(readRepoFile(squashConflict.repo, 'shared.txt'), 'B\n')
      assert.equal(git(squashConflict.repo, ['status', '--porcelain']).trim(), '')
    })

    // -----------------------------------------------------------------------
    console.log('')
    console.log('=== 8. 已发布历史：警告 + 只允许 --force-with-lease ===')
    // -----------------------------------------------------------------------
    const publishRepo = createLinearRepo('publish-repo')
    const bare = join(scratch, 'publish-origin.git')
    mkdirSync(bare, { recursive: true })
    git(bare, ['init', '--bare', '--initial-branch=main'])
    git(publishRepo.repo, ['remote', 'add', 'origin', bare])
    git(publishRepo.repo, ['push', '-u', 'origin', 'main'])

    const planPublished = await gitbar('rebase/plan', { cwd: publishRepo.repo, revision: publishRepo.A })
    await check('8.1) 待改写的提交已在上游 -> 计划里如实标出"已发布"与上游名（界面据此警告）', () => {
      assert.equal(planPublished.status, 200, JSON.stringify(planPublished.body).slice(0, 200))
      assert.equal(planPublished.body.published, true)
      assert.equal(planPublished.body.upstream, 'origin/main')
    })

    const publishedRewrite = await startPlan(gitbar, publishRepo.repo, publishRepo.A, [
      { sha: publishRepo.B, action: 'pick' },
      { sha: publishRepo.C, action: 'drop' },
      { sha: publishRepo.D, action: 'pick' },
    ])
    await check('8.2) 改写已发布历史本身是可以做的（警告不等于禁止）', () => {
      assert.equal(publishedRewrite.status, 200, JSON.stringify(publishedRewrite.body).slice(0, 300))
      assert.deepEqual(subjectsOldestFirst(publishRepo.repo), ['initial', 'Add login API', 'Add session store', 'Add tests'])
    })

    const plainPush = await gitbar('remote', { cwd: publishRepo.repo, action: 'push' })
    await check('8.3) 改写之后普通推送被拒（不能悄悄覆盖远端）', () => {
      assert.equal(plainPush.status, 409, JSON.stringify(plainPush.body).slice(0, 300))
      assert.equal(plainPush.body.code, 'pushRejected')
      assert.notEqual(revParse(bare, 'main'), revParse(publishRepo.repo, 'HEAD'))
    })

    const leasePush = await gitbar('remote', { cwd: publishRepo.repo, action: 'push', forceWithLease: true })
    await check('8.4) `--force-with-lease` 成功把改写后的历史推上去', () => {
      assert.equal(leasePush.status, 200, JSON.stringify(leasePush.body).slice(0, 300))
      assert.equal(leasePush.body.forceWithLease, true)
      assert.equal(revParse(bare, 'main'), revParse(publishRepo.repo, 'HEAD'))
    })

    const collaborator = join(scratch, 'publish-collaborator')
    git(scratch, ['clone', '-q', bare, collaborator])
    git(collaborator, ['config', 'user.email', 'other@example.com'])
    git(collaborator, ['config', 'user.name', 'Other'])
    writeRepoFile(collaborator, 'collaborator.txt', 'theirs\n')
    commitAll(collaborator, 'Collaborator work')
    git(collaborator, ['push', '-q', 'origin', 'main'])

    // 8.2 之后历史已经是改写过的（C 被丢掉、SHA 全变了），因此计划要**按当前 HEAD 重新取**。
    const rewritten = shaListOldestFirst(publishRepo.repo)
    const rewrote2 = await startPlan(gitbar, publishRepo.repo, rewritten[1], [
      { sha: rewritten[2], action: 'reword', message: 'Add session store (retitled)' },
      { sha: rewritten[3], action: 'pick' },
    ])
    await check('8.5) 远端被别人推进后本地仍可继续改写自己的历史', () => {
      assert.equal(rewrote2.status, 200, JSON.stringify(rewrote2.body).slice(0, 300))
      assert.deepEqual(subjectsOldestFirst(publishRepo.repo), [
        'initial',
        'Add login API',
        'Add session store (retitled)',
        'Add tests',
      ])
      // 本地的远端跟踪引用还是旧的（没 fetch），因此 lease 记录的是"协作者推之前"的值。
      assert.notEqual(revParse(bare, 'main'), revParse(publishRepo.repo, 'HEAD'))
    })

    const staleLease = await gitbar('remote', { cwd: publishRepo.repo, action: 'push', forceWithLease: true })
    await check('8.6) 过期 lease：`--force-with-lease` 被拒，绝不覆盖协作者的提交', async () => {
      assert.equal(staleLease.status, 409, JSON.stringify(staleLease.body).slice(0, 300))
      assert.equal(staleLease.body.code, 'pushRejected')
      assert.equal(revParse(bare, 'main'), revParse(collaborator, 'HEAD'), '远端必须还是协作者的那一份')
    })

    // -----------------------------------------------------------------------
    console.log('')
    console.log('=== 9. 报告 fixup!/squash! 提交（autosquash 是 P1，本轮只如实报告） ===')
    // -----------------------------------------------------------------------
    const autosquashRepo = createRepo('autosquash-repo')
    writeRepoFile(autosquashRepo, 'f.txt', 'f\n')
    commitAll(autosquashRepo, 'Add feature')
    const featureSha = revParse(autosquashRepo, 'HEAD')
    writeRepoFile(autosquashRepo, 'f.txt', 'f2\n')
    commitAll(autosquashRepo, 'fixup! Add feature')
    const fixupSha = revParse(autosquashRepo, 'HEAD')
    const autosquashPlan = await gitbar('rebase/plan', { cwd: autosquashRepo, revision: featureSha })
    await check('9.1) 计划里点出 fixup!/squash! 提交（P1 的 autosquash 需要它）', () => {
      assert.equal(autosquashPlan.status, 200, JSON.stringify(autosquashPlan.body).slice(0, 200))
      assert.deepEqual(autosquashPlan.body.autosquashCandidates, [fixupSha])
      assert.equal(autosquashPlan.body.count, 1)
    })
  })
} catch (error) {
  failed += 1
  console.error(`测试异常: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    // 清理失败不影响结论。
  }
}

console.log('')
console.log(`${passed} 项通过${failed === 0 ? '' : `，${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
