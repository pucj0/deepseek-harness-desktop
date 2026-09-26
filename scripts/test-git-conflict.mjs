// Conflict / branch / merge backend regression tests on REAL temporary git repos.
//
//   node scripts/test-git-conflict.mjs
//
// Everything here drives the real HTTP routes of the two desktop plugins against a real
// repository, and asserts against git itself. Nothing is mocked: the point of this suite
// is that conflict detection, three-way content, per-side resolution, continue and abort
// behave the way git actually behaves — including the rebase case, where git's ours/theirs
// are the opposite of what people expect.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { syncBundledPlugins } from './sync-plugins.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const runtime = join(ROOT, 'runtime')
const NODE = join(runtime, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')

// The server loads plugins from `runtime/node_modules`, so the copies must be refreshed
// first — otherwise this suite would test the previous version of the plugins.
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

const scratch = mkdtempSync(join(tmpdir(), 'dsh-git-conflict-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })

/** Run git in a repo (throws with stderr on failure). */
function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.fileMode=false', '-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  })
}
function writeRepoFile(repo, name, text) {
  writeFileSync(join(repo, name), text, 'utf8')
}
/**
 * Read a repo file as text with line endings normalised.
 *
 * The suite runs on machines where `core.autocrlf=true`, so git and the working tree hand
 * back CRLF; every content assertion here is about *which side won*, not about the line
 * ending policy.
 */
function readRepoFile(repo, name) {
  return readFileSync(join(repo, name), 'utf8').replace(/\r\n/gu, '\n')
}
/** Same normalisation for text that came back over HTTP. */
function normalized(value) {
  return String(value).replace(/\r\n/gu, '\n')
}

/** A repo with an initial commit on `main`. */
function createRepo(name, at = scratch) {
  const repo = join(at, name)
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '--initial-branch=main'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  writeRepoFile(repo, 'shared.txt', 'base\n')
  writeRepoFile(repo, 'other.txt', 'other\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'initial'])
  return repo
}

/** Boot the runtime server for one workspace and return HTTP helpers. */
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
      // gitbar 的**只读**路由只接受 GET（客户端就是这么发的），写路由是 POST。
      const readOnly =
        prefix === '/dsh-desktop/gitbar' &&
        ['status', 'branches', 'remotes', 'branch/sync', 'repo-context'].includes(route)
      const query = new URLSearchParams({ cwd: workspace })
      if (typeof payload?.repository === 'string') query.set('repository', payload.repository)
      const response = await fetch(`${base}${prefix}/${route}?${query.toString()}`, {
        method: readOnly ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        ...(readOnly ? {} : { body: JSON.stringify({ workspace, ...(payload ?? {}) }) }),
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

/** Register a workspace the way the app does, so the plugins accept it. */
function registerWorkspace(root) {
  mkdirSync(join(home, 'storages'), { recursive: true })
  const now = new Date().toISOString()
  writeFileSync(
    join(home, 'storages', 'workspace.json'),
    JSON.stringify(
      {
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, workspaceIds: ['w1'], archivedSessionIds: [] },
        tables: {
          workspaces: {
            w1: { path: root, title: 'repo', sessionIds: [], createdAt: now, updatedAt: now },
          },
        },
      },
      null,
      2,
    ) + '\n',
  )
}

// ---------------------------------------------------------------------------
// A repo with a real divergence: feature and main both change the same line.
// ---------------------------------------------------------------------------
const repo = createRepo('conflict-repo')
// 真正的分叉：feature 从 initial 出发，main 上另有一条改动。若先提交 main 再建 feature，
// main 就是 feature 的祖先，合并会**快进**（干净成功），根本不会产生冲突。
git(repo, ['switch', '-c', 'feature'])
writeRepoFile(repo, 'shared.txt', 'feature side\n')
git(repo, ['commit', '-am', 'feature change'])
git(repo, ['switch', 'main'])
writeRepoFile(repo, 'shared.txt', 'main side\n')
git(repo, ['commit', '-am', 'main change'])
registerWorkspace(repo)

try {
  await withServer(repo, async ({ review, gitbar }) => {
    console.log('=== 1. merge conflict -> detection ===')
    const merged = await gitbar('branch/merge', { name: 'feature' })
    await check('合并冲突返回专门的 code（不是笼统失败）', () => {
      assert.equal(merged.status, 409, JSON.stringify(merged.body).slice(0, 200))
      assert.equal(merged.body.code, 'mergeConflict')
    })

    const status = await gitbar('status', {})
    await check('/status 报出进行中的操作与两侧名字', () => {
      assert.equal(status.body.operation?.type, 'merge')
      assert.equal(status.body.operation?.currentLabel, 'main')
      assert.match(String(status.body.operation?.incomingLabel), /feature/u)
      assert.equal(status.body.operation?.labelsSwapped, false)
    })
    await check('/status 列出冲突文件', () => {
      assert.equal(status.body.conflictCount, 1)
      assert.deepEqual(status.body.conflicts.map((entry) => entry.path), ['shared.txt'])
      assert.equal(status.body.conflicts[0].code, 'UU')
    })

    const workspace = await review('workspace', {})
    await check('/workspace 也报冲突，且冲突文件仍在 files 里', () => {
      assert.equal(workspace.body.operationType, 'merge')
      assert.equal(workspace.body.conflictCount, 1)
      const entry = workspace.body.files.find((file) => file.path === 'shared.txt')
      assert.ok(entry !== undefined, 'conflicted file must not be dropped from files')
      assert.equal(entry.conflict, true)
      assert.equal(entry.code, 'UU')
    })

    const conflict = await review('conflict', { path: 'shared.txt' })
    await check('/conflict 给出三个阶段与冲突块', () => {
      assert.equal(conflict.status, 200)
      assert.equal(normalized(conflict.body.ours), 'main side\n', JSON.stringify(conflict.body).slice(0, 400))
      assert.equal(normalized(conflict.body.theirs), 'feature side\n')
      assert.equal(normalized(conflict.body.base), 'base\n')
      assert.equal(conflict.body.blockCount, 1)
      // 冲突块来自**工作区文件**（那份文本是什么样就是什么样，CRLF 原样保留，写回时才不会
      // 改掉用户的换行风格），因此断言前归一化。
      assert.equal(normalized(conflict.body.blocks[0].ours), 'main side')
      assert.equal(normalized(conflict.body.blocks[0].theirs), 'feature side')
      assert.equal(conflict.body.hasMarkers, true)
    })

    console.log('')
    console.log('=== 2. per-block resolution ===')
    /**
     * 重新生成冲突标记。
     *
     * 「接受某一侧」作用在**当前工作区文本**上：第一次接受之后标记就没了，此时再选另一侧
     * 是空操作（这是正确行为，不是缺陷）。要逐项验证三个选择，必须每次都把带标记的文本
     * 恢复出来——`git checkout --merge` 正是 git 用来重新生成冲突标记的方式。
     */
    const restoreConflict = () => git(repo, ['checkout', '--merge', '--', 'shared.txt'])

    const takeTheirs = await review('conflict-resolve', { path: 'shared.txt', resolutions: { 0: 'theirs' } })
    await check('接受对方一侧会写回文件且不再有标记', () => {
      assert.equal(takeTheirs.status, 200, JSON.stringify(takeTheirs.body).slice(0, 200))
      assert.equal(takeTheirs.body.hasMarkers, false)
      assert.equal(readRepoFile(repo, 'shared.txt'), 'feature side\n')
    })
    await check('未标记为已解决时索引里仍是冲突（还没 git add）', () => {
      assert.match(git(repo, ['status', '--porcelain=v2', '--', 'shared.txt']), /^u /mu)
    })

    restoreConflict()
    const takeOurs = await review('conflict-resolve', { path: 'shared.txt', resolutions: { 0: 'ours' } })
    await check('接受当前一侧覆盖回当前内容', () => {
      assert.equal(takeOurs.status, 200, JSON.stringify(takeOurs.body).slice(0, 200))
      assert.equal(readRepoFile(repo, 'shared.txt'), 'main side\n')
    })

    restoreConflict()
    const both = await review('conflict-resolve', { path: 'shared.txt', resolutions: { 0: 'both' } })
    await check('接受双方会按顺序并排写入', () => {
      assert.equal(both.status, 200, JSON.stringify(both.body).slice(0, 200))
      assert.equal(readRepoFile(repo, 'shared.txt'), 'main side\nfeature side\n')
    })
    await check('「接受双方」的顺序可以反过来', async () => {
      restoreConflict()
      const reversed = await review('conflict-resolve', {
        path: 'shared.txt',
        resolutions: { 0: 'both' },
        order: 'theirs-first',
      })
      assert.equal(reversed.status, 200)
      assert.equal(readRepoFile(repo, 'shared.txt'), 'feature side\nmain side\n')
    })
    await check('未决定的冲突块原样保留标记（可以先解决一半再保存）', async () => {
      restoreConflict()
      const partial = await review('conflict-resolve', { path: 'shared.txt', resolutions: {} })
      assert.equal(partial.body.unresolved, 1)
      assert.equal(partial.body.hasMarkers, true)
      assert.match(readRepoFile(repo, 'shared.txt'), /^<{7}/mu)
    })

    console.log('')
    console.log('=== 3. mark resolved refuses leftover markers ===')
    restoreConflict()
    const marked = '<<<<<<< HEAD\nmain side\n=======\nfeature side\n>>>>>>> feature\n'
    const written = await review('conflict-resolve', { path: 'shared.txt', content: marked })
    await check('写回带标记的手工内容会被如实报告', () => {
      assert.equal(written.body.hasMarkers, true)
      assert.equal(written.body.blockCount, 1)
    })
    const blocked = await review('conflict-resolve', { path: 'shared.txt', markResolved: true })
    await check('还有残留标记时拒绝标记为已解决', () => {
      assert.equal(blocked.status, 409)
      assert.equal(blocked.body.code, 'markersRemain')
    })
    const forced = await review('conflict-resolve', { path: 'shared.txt', markResolved: true, allowMarkers: true })
    await check('显式允许时才接受带标记的内容', () => {
      assert.equal(forced.status, 200)
      assert.equal(forced.body.markedResolved, true)
    })

    console.log('')
    console.log('=== 4. continue merge ===')
    const staged = await review('conflict-resolve', { path: 'shared.txt', resolutions: { 0: 'theirs' }, markResolved: true })
    await check('解决并标记后写入的是选中一侧', () => {
      assert.equal(staged.status, 200, JSON.stringify(staged.body).slice(0, 200))
      assert.equal(readRepoFile(repo, 'shared.txt'), 'feature side\n')
    })
    const afterStage = await review('workspace', {})
    await check('标记为已解决后冲突计数归零、文件进入已暂存', () => {
      assert.equal(afterStage.body.conflictCount, 0)
      const entry = afterStage.body.files.find((file) => file.path === 'shared.txt')
      assert.ok(entry !== undefined)
      assert.equal(entry.conflict, undefined)
      assert.equal(entry.staged, true)
    })
    const continued = await gitbar('op/continue', {})
    await check('继续合并会创建合并提交', () => {
      assert.equal(continued.status, 200, JSON.stringify(continued.body).slice(0, 200))
      assert.equal(continued.body.continued, 'merge')
      assert.equal(String(git(repo, ['status', '--porcelain'])).trim(), '')
      assert.match(git(repo, ['log', '-1', '--pretty=%s']), /Merge/u)
    })

    console.log('')
    console.log('=== 5. abort merge keeps the working tree safe ===')
    git(repo, ['reset', '--hard', 'HEAD~1'])
    writeRepoFile(repo, 'shared.txt', 'main side v2\n')
    git(repo, ['commit', '-am', 'main change again'])
    const conflicted = await gitbar('branch/merge', { name: 'feature' })
    await check('再次制造冲突', () => assert.equal(conflicted.status, 409, JSON.stringify(conflicted.body).slice(0, 160)))
    const aborted = await gitbar('op/abort', { kind: 'merge' })
    await check('中止合并把仓库恢复到干净状态', () => {
      assert.equal(aborted.status, 200, JSON.stringify(aborted.body).slice(0, 160))
      assert.equal(String(git(repo, ['status', '--porcelain'])).trim(), '')
      assert.equal(readRepoFile(repo, 'shared.txt'), 'main side v2\n')
    })

    // -----------------------------------------------------------------------
    // 6. Rebase conflict: labels must be swapped (ours = onto), not blindly reused.
    // -----------------------------------------------------------------------
    console.log('')
    console.log('=== 6. rebase conflict: ours/theirs are swapped ===')
    git(repo, ['switch', '-c', 'rebase-source', 'main'])
    writeRepoFile(repo, 'shared.txt', 'feature rebased\n')
    git(repo, ['commit', '-am', 'feature rebase change'])
    git(repo, ['switch', 'main'])
    writeRepoFile(repo, 'shared.txt', 'main for rebase\n')
    git(repo, ['commit', '-am', 'main for rebase'])
    git(repo, ['switch', 'rebase-source'])
    const rebase = await gitbar('branch/rebase', { onto: 'main' })
    await check('变基冲突返回专门的 code', () => {
      assert.equal(rebase.status, 409, JSON.stringify(rebase.body).slice(0, 160))
      assert.equal(rebase.body.code, 'rebaseConflict')
    })
    const rebaseStatus = await gitbar('status', {})
    await check('变基期间两侧名字与 labelsSwapped 正确', () => {
      assert.equal(rebaseStatus.body.operation?.type, 'rebase')
      assert.equal(rebaseStatus.body.operation?.labelsSwapped, true)
      assert.match(String(rebaseStatus.body.operation?.currentLabel), /^onto/u)
      assert.match(String(rebaseStatus.body.operation?.incomingLabel), /rebase-source/u)
    })
    const rebaseConflict = await review('conflict', { path: 'shared.txt' })
    await check('变基冲突也能拿到三路内容与块（ours 是"变基到的那一侧"）', () => {
      assert.equal(rebaseConflict.body.blockCount, 1)
      assert.equal(normalized(rebaseConflict.body.ours), 'main for rebase\n')
      assert.equal(normalized(rebaseConflict.body.theirs), 'feature rebased\n')
      assert.equal(normalized(rebaseConflict.body.base), 'main side v2\n')
    })
    await review('conflict-resolve', { path: 'shared.txt', resolutions: { 0: 'theirs' }, markResolved: true })
    const rebaseContinue = await gitbar('op/continue', {})
    await check('继续变基成功且历史落在 main 之上', () => {
      assert.equal(rebaseContinue.status, 200, JSON.stringify(rebaseContinue.body).slice(0, 200))
      assert.equal(rebaseContinue.body.continued, 'rebase')
      assert.equal(String(git(repo, ['status', '--porcelain'])).trim(), '')
      assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'rebase-source')
      assert.match(git(repo, ['log', '-1', '--pretty=%s']), /feature rebase change/u)
      assert.equal(readRepoFile(repo, 'shared.txt'), 'feature rebased\n')
    })
  })

  // -------------------------------------------------------------------------
  // 7. Branch creation / switching / deletion, all in one call each.
  // -------------------------------------------------------------------------
  console.log('')
  console.log('=== 7. branch operations ===')
  await withServer(repo, async ({ gitbar }) => {
    const created = await gitbar('branch/create', { name: 'topic/test', checkout: true })
    await check('新建分支并签出（一次调用完成，无二次确认）', () => {
      assert.equal(created.status, 200, JSON.stringify(created.body).slice(0, 160))
      assert.equal(created.body.branch, 'topic/test')
    })
    const list = await gitbar('branches', {})
    await check('分支列表里能看到新建的分支', () => {
      const names = [...(list.body.local ?? []), ...(list.body.branches ?? [])].map((entry) => entry.name ?? entry)
      assert.ok(names.includes('topic/test'), JSON.stringify(names).slice(0, 200))
    })
    const back = await gitbar('checkout', { branch: 'main' })
    await check('切回 main', () => {
      assert.equal(back.status, 200, JSON.stringify(back.body).slice(0, 160))
      assert.equal(back.body.branch, 'main')
    })
    const gone = await gitbar('checkout', { branch: 'no/such/branch' })
    await check('不存在的分支给出稳定的 code', () => {
      assert.equal(gone.status, 404)
      assert.equal(gone.body.code, 'noSuchRef')
    })
    const refused = await gitbar('branch/delete', { name: 'topic/test' })
    await check('未合并的分支默认拒绝删除（危险操作要显式确认）', () => {
      assert.equal(refused.status, 409)
      assert.equal(refused.body.code, 'notMerged')
    })
    const removed = await gitbar('branch/delete', { name: 'topic/test', force: true })
    await check('显式 force 才能删除未合并的分支', () => {
      assert.equal(removed.status, 200, JSON.stringify(removed.body).slice(0, 160))
      assert.equal(git(repo, ['branch', '--list', 'topic/test']).trim(), '')
    })
  })

  // -------------------------------------------------------------------------
  // 8. Empty repository must not break any route.
  // -------------------------------------------------------------------------
  console.log('')
  console.log('=== 8. empty repo ===')
  const emptyRepo = join(scratch, 'empty-repo')
  mkdirSync(emptyRepo, { recursive: true })
  git(emptyRepo, ['init', '--initial-branch=main'])
  registerWorkspace(emptyRepo)
  await withServer(emptyRepo, async ({ gitbar, review }) => {
    const status = await gitbar('status', {})
    await check('空仓库不报错，并明确告知尚无提交', () => {
      assert.equal(status.status, 200)
      assert.equal(status.body.noCommits, true)
      assert.equal(status.body.operation, null)
    })
    writeRepoFile(emptyRepo, 'first.txt', 'hello\n')
    const staged = await review('workspace', {})
    await check('空仓库里新建文件仍能出现在改动列表里（可以暂存与提交）', () => {
      assert.equal(staged.body.empty, true)
      assert.ok(staged.body.files.length + staged.body.untracked.count > 0)
    })
  })

  // -------------------------------------------------------------------------
  // 9. Multi repository isolation: operations must hit the selected repository only.
  // -------------------------------------------------------------------------
  console.log('')
  console.log('=== 9. multi-repository isolation ===')
  const mono = join(scratch, 'mono')
  mkdirSync(mono, { recursive: true })
  const repoA = createRepo('mono-frontend')
  const repoB = createRepo('mono-backend')
  // Move both repos INSIDE the workspace so discovery finds two repositories.
  renameSync(repoA, join(mono, 'frontend'))
  renameSync(repoB, join(mono, 'backend'))
  const frontend = join(mono, 'frontend')
  const backend = join(mono, 'backend')
  git(frontend, ['switch', '-c', 'frontend-only'])
  registerWorkspace(mono)
  await withServer(mono, async ({ gitbar, review }) => {
    const scope = await review('project-git-scope', { force: true })
    await check('发现两个仓库', () => {
      assert.equal(scope.body.repositories.length, 2, JSON.stringify(scope.body).slice(0, 200))
    })
    const scoped = await gitbar('status', { repository: frontend })
    await check('按 repository 参数读到的分支属于 frontend', () => {
      assert.equal(scoped.body.branch, 'frontend-only')
    })
    const other = await gitbar('status', { repository: backend })
    await check('切到 backend 读到的分支是 main（互不影响）', () => {
      assert.equal(other.body.branch, 'main')
    })
    // 写操作也必须落在被选中的仓库上：在 frontend 建分支，backend 不该出现它。
    const created = await gitbar('branch/create', { name: 'only-frontend', checkout: true, repository: frontend })
    await check('写操作落在选中的仓库上', () => {
      assert.equal(created.status, 200, JSON.stringify(created.body).slice(0, 160))
      assert.match(git(frontend, ['branch', '--list', 'only-frontend']).trim(), /only-frontend/u)
      assert.equal(git(backend, ['branch', '--list', 'only-frontend']).trim(), '')
    })
    const wrongRepo = await gitbar('status', { repository: join(scratch, 'conflict-repo') })
    await check('不属于本工作区的仓库被拒绝（安全边界）', () => {
      assert.equal(wrongRepo.status, 400)
      assert.equal(wrongRepo.body.code, 'repositoryNotAllowed')
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
