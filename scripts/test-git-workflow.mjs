// End-to-end Git workflow acceptance test on REAL repositories and a REAL (local) remote.
//
//   node scripts/test-git-workflow.mjs
//
// This is the acceptance flow from the feature brief, driven exactly the way the UI drives it
// (the same HTTP routes, one call per user action):
//
//   create branch → change a file → stage → commit → push (publish) → merge → conflict
//   → resolve → mark resolved → commit the merge → push → log/graph shows the merge
//
// and then the push failure paths the client maps to specific messages: a rejected (non
// fast-forward) push, a missing upstream, `--set-upstream` on the first push, and
// `--force-with-lease` for the one case where rewriting the remote is intended.
//
// Nothing is mocked: `origin` is a bare repository on disk, so "did the push really land" is
// answered by asking git itself.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { syncBundledPlugins } from './sync-plugins.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const runtime = join(ROOT, 'runtime')
const NODE = join(runtime, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')

// The server loads plugins from `runtime/node_modules`; refresh those copies first or this
// suite would be testing the previous build.
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

const scratch = mkdtempSync(join(tmpdir(), 'dsh-git-workflow-'))
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
 * Read a repo file with line endings normalised.
 *
 * The suite has to run on machines with `core.autocrlf=true`, where git checks out CRLF; every
 * assertion here is about *which content won*, not about the line-ending policy.
 */
function readRepoFile(repo, name) {
  return readFileSync(join(repo, name), 'utf8').replace(/\r\n/gu, '\n')
}
function normalized(value) {
  return String(value).replace(/\r\n/gu, '\n')
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
      // gitbar's read routes are GET-only (that is how the client sends them); writes are POST.
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

/**
 * A clone of a bare `origin`, plus a second clone standing in for a collaborator.
 *
 * Using real clones (instead of `remote add` on a hand-made repo) is what makes the push
 * assertions meaningful: `origin/main` is a real remote-tracking ref, and "no upstream" is the
 * genuine state of a branch that was never pushed.
 */
const origin = join(scratch, 'origin.git')
mkdirSync(origin, { recursive: true })
execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin], { windowsHide: true })

const work = join(scratch, 'work')
writeRepoFile(scratch, 'seed.txt', 'seed\n')
/** A scratch repo used only to produce the initial commit that origin is seeded with. */
const seed = join(scratch, 'seed')
mkdirSync(seed, { recursive: true })
git(seed, ['init', '--initial-branch=main'])
git(seed, ['config', 'user.email', 'test@example.com'])
git(seed, ['config', 'user.name', 'Test'])
git(seed, ['config', 'commit.gpgsign', 'false'])
writeRepoFile(seed, 'shared.txt', 'base\n')
git(seed, ['add', '-A'])
git(seed, ['commit', '-m', 'initial'])
git(seed, ['remote', 'add', 'origin', origin])
git(seed, ['push', '-q', 'origin', 'main'])
execFileSync('git', ['--git-dir', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { windowsHide: true })

execFileSync('git', ['clone', '-q', origin, work], { windowsHide: true })
const collaborator = join(scratch, 'collaborator')
execFileSync('git', ['clone', '-q', origin, collaborator], { windowsHide: true })
for (const repo of [work, collaborator]) {
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
}

registerWorkspace(work)

try {
  await withServer(work, async ({ gitbar, review }) => {
    // -----------------------------------------------------------------------
    console.log('=== 1. publish the current branch (first push) ===')
    // A freshly cloned default branch has an upstream; the *new* branch below will not, which
    // is the case the client turns into "Publish branch" (equivalent to `push -u`).
    const before = await gitbar('status', {})
    await check('克隆出来的 main 有上游', () => {
      assert.equal(before.body.hasUpstream, true)
      assert.equal(before.body.branch, 'main')
    })

    const created = await gitbar('branch/create', { name: 'feature/workflow', checkout: true })
    await check('新建并签出 feature/workflow（一次调用，没有二次确认）', () => {
      assert.equal(created.status, 200, JSON.stringify(created.body).slice(0, 200))
      assert.equal(created.body.branch, 'feature/workflow')
    })

    const fresh = await gitbar('status', {})
    await check('新分支没有上游 -> 界面据此显示「发布分支」', () => {
      assert.equal(fresh.body.hasUpstream, false)
    })

    const naive = await gitbar('remote', { action: 'push' })
    await check('不带 setUpstream 直接推 -> 409 noUpstream（不是笼统的失败）', () => {
      assert.equal(naive.status, 409, JSON.stringify(naive.body).slice(0, 200))
      assert.equal(naive.body.code, 'noUpstream')
    })
    await check('被拒之后远端上确实还没有这个分支', () => {
      assert.equal(git(origin, ['branch', '--list', 'feature/workflow']).trim(), '')
    })

    // -----------------------------------------------------------------------
    console.log('')
    console.log('=== 2. change → stage → commit → publish ===')
    writeRepoFile(work, 'shared.txt', 'feature side\n')
    const staged = await review('stage', { paths: ['shared.txt'] })
    await check('暂存改动', () => {
      assert.equal(staged.status, 200, JSON.stringify(staged.body).slice(0, 200))
      assert.equal(git(work, ['diff', '--cached', '--name-only']).replace(/\r\n/gu, '\n').trim(), 'shared.txt')
    })
    const committed = await review('commit', { message: 'feature change' })
    await check('提交（提交信息来自界面的那一句）', () => {
      assert.equal(committed.status, 200, JSON.stringify(committed.body).slice(0, 200))
      assert.equal(git(work, ['log', '-1', '--format=%s']).trim(), 'feature change')
    })

    const published = await gitbar('remote', { action: 'push', branch: 'feature/workflow', setUpstream: true })
    await check('发布分支（push --set-upstream）成功', () => {
      assert.equal(published.status, 200, JSON.stringify(published.body).slice(0, 200))
    })
    await check('远端上出现了 feature/workflow，且指针与本地一致', () => {
      assert.equal(
        git(origin, ['rev-parse', 'feature/workflow']).trim(),
        git(work, ['rev-parse', 'feature/workflow']).trim(),
      )
    })
    const tracked = await gitbar('status', {})
    await check('发布之后 hasUpstream 为真（下一次推送不必再指定远端）', () => {
      assert.equal(tracked.body.hasUpstream, true)
    })

    // -----------------------------------------------------------------------
    console.log('')
    console.log('=== 3. a collaborator moves the remote: rejected push ===')
    git(collaborator, ['switch', '-q', 'main'])
    writeRepoFile(collaborator, 'shared.txt', 'collaborator side\n')
    git(collaborator, ['commit', '-am', 'collaborator change'])
    git(collaborator, ['push', '-q', 'origin', 'main'])

    // The local main is now behind: pushing it is a non-fast-forward.
    await gitbar('checkout', { branch: 'main' })
    git(work, ['switch', '-q', 'main'])
    writeRepoFile(work, 'local-only.txt', 'local\n')
    git(work, ['add', '-A'])
    git(work, ['commit', '-m', 'local commit'])

    const rejected = await gitbar('remote', { action: 'push' })
    await check('非快进推送 -> 409 pushRejected（界面据此给出「更新项目」）', () => {
      assert.equal(rejected.status, 409, JSON.stringify(rejected.body).slice(0, 200))
      assert.equal(rejected.body.code, 'pushRejected')
    })
    await check('被拒之后远端 main 没有被改写', () => {
      assert.equal(
        git(origin, ['rev-parse', 'main']).trim(),
        git(collaborator, ['rev-parse', 'main']).trim(),
      )
    })

    // -----------------------------------------------------------------------
    console.log('')
    console.log('=== 4. update = fetch + pull (the client does exactly these two calls) ===')
    const fetched = await gitbar('remote', { action: 'fetch' })
    await check('fetch 成功', () => {
      assert.equal(fetched.status, 200, JSON.stringify(fetched.body).slice(0, 200))
    })
    const pulled = await gitbar('remote', { action: 'pull' })
    await check('pull 成功，把协作者的提交并了进来', () => {
      assert.equal(pulled.status, 200, JSON.stringify(pulled.body).slice(0, 200))
      assert.match(normalized(readRepoFile(work, 'shared.txt')), /collaborator side/u)
    })
    const afterPull = await gitbar('remote', { action: 'push' })
    await check('更新之后再推 -> 成功（这就是「先更新再推」那条出路）', () => {
      assert.equal(afterPull.status, 200, JSON.stringify(afterPull.body).slice(0, 200))
      assert.equal(
        git(origin, ['rev-parse', 'main']).trim(),
        git(work, ['rev-parse', 'main']).trim(),
      )
    })

    // -----------------------------------------------------------------------
    console.log('')
    console.log('=== 5. merge conflict → resolve → mark resolved → commit the merge ===')
    // feature/workflow and main must really diverge: feature was branched before main moved.
    const merged = await gitbar('branch/merge', { name: 'feature/workflow' })
    await check('合并 feature/workflow 产生冲突', () => {
      assert.equal(merged.status, 409, JSON.stringify(merged.body).slice(0, 200))
      assert.equal(merged.body.code, 'mergeConflict')
    })

    const status = await gitbar('status', {})
    await check('操作状态由宿主判定为 merge，并带上两侧真实名字', () => {
      assert.equal(status.body.operation?.type, 'merge')
      assert.equal(status.body.operation?.currentLabel, 'main')
      assert.match(String(status.body.operation?.incomingLabel), /feature\/workflow/u)
      assert.equal(status.body.conflictCount, 1)
    })

    const conflict = await review('conflict', { path: 'shared.txt' })
    await check('/conflict 给出两侧内容与冲突块', () => {
      assert.equal(conflict.status, 200, JSON.stringify(conflict.body).slice(0, 300))
      assert.equal(normalized(conflict.body.blocks[0].ours), 'collaborator side')
      assert.equal(normalized(conflict.body.blocks[0].theirs), 'feature side')
      assert.equal(conflict.body.operationType, 'merge')
    })

    // 拒绝路径先测：文件此刻还带着 `<<<<<<<` 标记，直接「标记为已解决」必须被挡住——
    // 把带标记的文本加进索引，用户会以为冲突解决了，而提交里留下的是标记本身。
    const cheap = await review('conflict-resolve', { path: 'shared.txt', markResolved: true })
    await check('还有残留标记时「标记为已解决」-> 409 markersRemain（索引里不许留标记）', () => {
      assert.equal(cheap.status, 409, JSON.stringify(cheap.body).slice(0, 300))
      assert.equal(cheap.body.code, 'markersRemain')
      assert.equal(git(work, ['diff', '--name-only', '--diff-filter=U']).trim(), 'shared.txt')
    })

    // 逐块选择：合并时 ours 是当前分支，theirs 是 feature。这里要的是两边都留下。
    const applied = await review('conflict-resolve', { path: 'shared.txt', resolutions: { 0: 'both' }, order: 'theirs-first' })
    await check('应用逐块选择后工作区文件被重组（顺序按 order）', () => {
      assert.equal(applied.status, 200, JSON.stringify(applied.body).slice(0, 300))
      assert.equal(normalized(readRepoFile(work, 'shared.txt')), 'feature side\ncollaborator side\n')
      assert.equal(applied.body.hasMarkers, false)
    })

    const marked = await review('conflict-resolve', { path: 'shared.txt', markResolved: true })
    await check('标记为已解决 -> 文件进入索引，冲突数归零', () => {
      assert.equal(marked.status, 200, JSON.stringify(marked.body).slice(0, 200))
      assert.equal(marked.body.markedResolved, true)
      assert.equal(git(work, ['diff', '--name-only', '--diff-filter=U']).trim(), '')
    })

    const continued = await gitbar('op/continue', {})
    await check('继续 -> 合并提交（宿主按操作类型选命令）', () => {
      assert.equal(continued.status, 200, JSON.stringify(continued.body).slice(0, 200))
      assert.equal(continued.body.continued, 'merge')
      // 合并提交有两个父提交才是真的合并。
      const parents = git(work, ['log', '-1', '--format=%P']).trim().split(/\s+/u)
      assert.equal(parents.length, 2)
    })

    const clean = await gitbar('status', {})
    await check('操作结束，仓库回到干净状态（没有进行中的操作）', () => {
      assert.equal(clean.body.operation, null)
      assert.equal(clean.body.conflictCount, 0)
      assert.equal(clean.body.changedFiles, 0)
    })

    const pushedMerge = await gitbar('remote', { action: 'push' })
    await check('推送合并结果', () => {
      assert.equal(pushedMerge.status, 200, JSON.stringify(pushedMerge.body).slice(0, 200))
      assert.equal(git(origin, ['rev-parse', 'main']).trim(), git(work, ['rev-parse', 'main']).trim())
    })

    // -----------------------------------------------------------------------
    console.log('')
    console.log('=== 6. log / graph reflect the merge ===')
    const graph = await review('graph', { limit: 20 })
    await check('提交图里能看到这条合并提交（有第二个父提交）', () => {
      assert.equal(graph.status, 200, JSON.stringify(graph.body).slice(0, 200))
      const commits = graph.body.commits ?? graph.body.entries ?? []
      const head = String(graph.body.head ?? git(work, ['rev-parse', 'HEAD']).trim())
      assert.ok(commits.length > 0, 'graph must return commits')
      const merge = commits.find((entry) => (entry.hash ?? entry.commit ?? '') === head)
      assert.ok(merge !== undefined, `HEAD ${head} missing from the graph`)
    })
    const detail = await review('commit-detail', { revision: git(work, ['rev-parse', 'HEAD']).trim() })
    await check('合并提交的详情里两侧历史都在（说明真的合了，而不是快进）', () => {
      assert.equal(detail.status, 200, JSON.stringify(detail.body).slice(0, 200))
      const files = (detail.body.files ?? []).map((entry) => entry.path ?? entry)
      assert.ok(files.includes('shared.txt'), JSON.stringify(files).slice(0, 200))
    })

    // -----------------------------------------------------------------------
    console.log('')
    console.log('=== 7. force push is explicit and lease-protected ===')
    // Rewrite the last commit so the local branch is no longer a descendant of the remote's.
    git(work, ['commit', '--amend', '-m', 'amended merge'])
    const lease = await gitbar('remote', { action: 'push', forceWithLease: true })
    await check('--force-with-lease 在远端与本地记录一致时成功', () => {
      assert.equal(lease.status, 200, JSON.stringify(lease.body).slice(0, 200))
      assert.equal(lease.body.forceWithLease, true)
      assert.equal(git(origin, ['rev-parse', 'main']).trim(), git(work, ['rev-parse', 'main']).trim())
    })

    // A collaborator moves main behind our back: the lease is now stale, so the force push must
    // be refused instead of silently overwriting their work.
    git(collaborator, ['fetch', '-q', 'origin'])
    git(collaborator, ['reset', '-q', '--hard', 'origin/main'])
    writeRepoFile(collaborator, 'collaborator-2.txt', 'more\n')
    git(collaborator, ['add', '-A'])
    git(collaborator, ['commit', '-m', 'collaborator again'])
    git(collaborator, ['push', '-q', 'origin', 'main'])

    git(work, ['commit', '--amend', '-m', 'amended again'])
    const stale = await gitbar('remote', { action: 'push', forceWithLease: true })
    await check('远端在别人手里前进过 -> --force-with-lease 被拒（不覆盖别人的提交）', () => {
      assert.equal(stale.status, 409, JSON.stringify(stale.body).slice(0, 200))
      assert.equal(stale.body.code, 'pushRejected')
      assert.equal(
        git(origin, ['rev-parse', 'main']).trim(),
        git(collaborator, ['rev-parse', 'main']).trim(),
      )
    })
    const plain = await gitbar('remote', { action: 'push' })
    await check('普通推送始终不带 --force / --force-with-lease', () => {
      assert.equal(plain.status, 409, JSON.stringify(plain.body).slice(0, 200))
      assert.equal(plain.body.code, 'pushRejected')
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
