// Rebase / cherry-pick / revert conflict end-to-end tests on REAL repositories, plus the
// ref-label classification that decides how those conflicts are named.
//
//   node scripts/test-git-op-conflicts.mjs
//
// Why a separate file: `test-git-conflict.mjs` drives the **merge** path (detection, three-way
// content, per-block choices, marker re-scan, continue, abort) and `test-git-workflow.mjs`
// drives publish/update/push. The three *other* operation types each have their own git state
// machine **and their own ours/theirs orientation**, which is exactly where labels get swapped
// by accident. This file drives all three end to end:
//
//   1. ref labels (`describeRevision`): local branch with a `/` in its name, remote-tracking
//      refs, both at once, and neither — through a real cherry-pick conflict;
//   2. `git rebase` conflict → resolve → continue (linear history) → and abort;
//   3. `git cherry-pick` conflict → resolve → continue (picked content in HEAD) → and abort;
//   4. `git revert` conflict → resolve → continue (a real revert commit) → and abort.
//
// Nothing is mocked: `origin`-style remote-tracking refs are created with real git, conflicts
// are produced by real git, and every claim about git state is verified by asking git itself
// (`git show :2:…`, `git rev-list`, `git log`, `git for-each-ref`) rather than by trusting the
// plugin's own answer.
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

const scratch = mkdtempSync(join(tmpdir(), 'dsh-git-op-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })

/** Run git in a repo (throws with stderr on failure). */
function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.fileMode=false', '-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  })
}
/** Run git that is expected to fail (a conflict is a non-zero exit); returns stdout+stderr. */
function gitTry(cwd, args) {
  try {
    return { ok: true, out: git(cwd, args) }
  } catch (error) {
    const text = `${String(error.stdout ?? '')}${String(error.stderr ?? '')}`
    return { ok: false, out: text }
  }
}
function writeRepoFile(repo, name, text) {
  writeFileSync(join(repo, name), text, 'utf8')
}
/**
 * Read a repo file as text with line endings normalised.
 *
 * The suite must run on machines with `core.autocrlf=true`, where git checks the file out as
 * CRLF; every content assertion here is about *which side won*, not about line endings.
 */
function readRepoFile(repo, name) {
  return readFileSync(join(repo, name), 'utf8').replace(/\r\n/gu, '\n')
}
function normalized(value) {
  return String(value).replace(/\r\n/gu, '\n')
}
/** Commit everything currently on disk. */
function commitAll(repo, message) {
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', message])
}
/** `git show :N:<path>` — the index stage content, i.e. git's own "ours"/"theirs" answer. */
function stage(repo, n, name) {
  return normalized(git(repo, ['show', `:${n}:${name}`]))
}
/**
 * The same stage content without the trailing newline.
 *
 * A conflict **block** (`blocks[i].ours` / `.theirs`) is the text *between* the markers, so it
 * has no trailing end-of-line — the scanner joins the block's lines and nothing else. Stage
 * content, being a whole file, does. Comparing them therefore drops the final newline.
 */
function stageBlock(repo, n, name) {
  return stage(repo, n, name).replace(/\n$/u, '')
}
/** The marker labels git itself wrote into the conflicted file (`<<<<<<< X` / `>>>>>>> Y`). */
function markerLabels(repo, name) {
  const text = readRepoFile(repo, name)
  const ours = /^<{7}(.*)$/mu.exec(text)
  const theirs = /^>{7}(.*)$/mu.exec(text)
  return { ours: ours === null ? '' : ours[1].trim(), theirs: theirs === null ? '' : theirs[1].trim() }
}
/** Full refnames pointing at a commit — the test's own ground truth for the ref matrix. */
function refsAt(repo, sha) {
  return git(repo, ['for-each-ref', '--format=%(refname)', `--points-at=${sha}`, 'refs/heads', 'refs/remotes'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}
/** Short names as git itself would print them (used to document the old heuristic's mistake). */
function shortNamesAt(repo, sha) {
  return git(repo, ['for-each-ref', '--format=%(refname:short)', `--points-at=${sha}`, 'refs/heads', 'refs/remotes'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}
const revParse = (repo, ref) => git(repo, ['rev-parse', ref]).trim()
const shortSha = (repo, ref) => git(repo, ['rev-parse', '--short', ref]).trim()
const subject = (repo, ref = 'HEAD') => git(repo, ['log', '-1', '--format=%s', ref]).trim()
const porcelain = (repo) => normalized(git(repo, ['status', '--porcelain'])).trim()

/** A repo with an initial commit on `main`. */
function createRepo(name) {
  const repo = join(scratch, name)
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '--initial-branch=main'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  writeRepoFile(repo, 'shared.txt', 'base\n')
  writeRepoFile(repo, 'other.txt', 'other\n')
  commitAll(repo, 'initial')
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

try {
  // =========================================================================
  // 1. describeRevision: ref **type** comes from the ref namespace, never from "/".
  //
  // The scenario is a real conflicted cherry-pick, because that is where the label is
  // user-visible: the operation card and the resolver name the incoming side with it.
  // =========================================================================
  console.log('=== 1. ref labels: local vs remote-tracking (real refs) ===')
  const labelsRepo = createRepo('labels-repo')
  git(labelsRepo, ['switch', '-c', 'feature/foo'])
  writeRepoFile(labelsRepo, 'shared.txt', 'feature side\n')
  commitAll(labelsRepo, 'feature change')
  const c1 = revParse(labelsRepo, 'HEAD')
  writeRepoFile(labelsRepo, 'feature-two.txt', 'feature two\n')
  commitAll(labelsRepo, 'feature second')
  const c2 = revParse(labelsRepo, 'HEAD')
  git(labelsRepo, ['switch', 'main'])
  writeRepoFile(labelsRepo, 'shared.txt', 'main side\n')
  commitAll(labelsRepo, 'main change')
  registerWorkspace(labelsRepo)

  await withServer(labelsRepo, async ({ gitbar }) => {
    /** Run the conflicted cherry-pick of C1 and read the label the app reports for it. */
    const incomingLabelOf = async () => {
      const picked = await gitbar('cherry-pick', { revision: c1 })
      assert.equal(picked.status, 409, `expected a conflict: ${JSON.stringify(picked.body).slice(0, 200)}`)
      const status = await gitbar('status', {})
      const label = status.body.operation?.incomingLabel
      await gitbar('op/abort', { kind: 'cherry-pick' })
      return label
    }

    // ---- A. only a local branch with a "/" points at the commit ------------------
    git(labelsRepo, ['branch', '-f', 'feature/foo', c1])
    await check('A) 只有 refs/heads/feature/foo 指向目标提交', () => {
      assert.deepEqual(refsAt(labelsRepo, c1), ['refs/heads/feature/foo'])
    })
    await check('A) 含 "/" 的本地分支名仍被识别为本地分支（返回 feature/foo）', async () => {
      assert.equal(await incomingLabelOf(), 'feature/foo')
    })

    // ---- B. only a remote-tracking ref points at the commit ----------------------
    git(labelsRepo, ['branch', '-D', 'feature/foo'])
    git(labelsRepo, ['update-ref', 'refs/remotes/origin/feature/foo', c1])
    // `origin/HEAD` is what a real clone has; its short name is `origin` (no slash at all),
    // which is precisely why "find a name without a slash" cannot tell local from remote.
    git(labelsRepo, ['update-ref', 'refs/remotes/origin/HEAD', c1])
    await check('B) 只有远端跟踪引用指向目标提交', () => {
      assert.deepEqual(refsAt(labelsRepo, c1), ['refs/remotes/origin/HEAD', 'refs/remotes/origin/feature/foo'])
    })
    await check('B) （回归依据）origin/HEAD 的短名是 origin、不含 "/"，旧启发式会选错', () => {
      const names = shortNamesAt(labelsRepo, c1)
      assert.ok(names.includes('origin'), `expected the slash-less "origin" in ${JSON.stringify(names)}`)
    })
    await check('B) 只给远端跟踪引用时返回 origin/feature/foo（优先具体分支，不是 origin/HEAD）', async () => {
      assert.equal(await incomingLabelOf(), 'origin/feature/foo')
    })

    // ---- C. both point at the commit -> the local branch wins --------------------
    git(labelsRepo, ['branch', 'feature/foo', c1])
    await check('C) 本地与远端同时指向目标提交', () => {
      assert.deepEqual(refsAt(labelsRepo, c1), [
        'refs/heads/feature/foo',
        'refs/remotes/origin/HEAD',
        'refs/remotes/origin/feature/foo',
      ])
    })
    await check('C) 本地分支优先于远端跟踪分支（返回 feature/foo）', async () => {
      assert.equal(await incomingLabelOf(), 'feature/foo')
    })

    // ---- D. nothing points at the commit -> short SHA + subject ------------------
    git(labelsRepo, ['update-ref', '-d', 'refs/remotes/origin/feature/foo'])
    git(labelsRepo, ['update-ref', '-d', 'refs/remotes/origin/HEAD'])
    // C1 is now an interior commit: `feature/foo` sits on C2, so no ref points at C1.
    git(labelsRepo, ['branch', '-f', 'feature/foo', c2])
    await check('D) 没有任何引用指向目标提交', () => {
      assert.deepEqual(refsAt(labelsRepo, c1), [])
      assert.deepEqual(refsAt(labelsRepo, c2), ['refs/heads/feature/foo'])
    })
    await check('D) 退回 "短 SHA + 提交标题"', async () => {
      const label = await incomingLabelOf()
      const expected = `${shortSha(labelsRepo, c1)} feature change`
      assert.equal(label, expected)
      assert.equal(subject(labelsRepo, c1), 'feature change')
    })
  })

  // =========================================================================
  // 2. Rebase conflict: a real divergence, a real conflict, and the fact that git's
  //    ours/theirs are the opposite way round from a merge.
  // =========================================================================
  console.log('')
  console.log('=== 2. rebase conflict: detect -> resolve -> continue ===')
  const rebaseRepo = createRepo('rebase-repo')
  git(rebaseRepo, ['switch', '-c', 'feature/login'])
  writeRepoFile(rebaseRepo, 'shared.txt', 'feature side\n')
  // A second file so that resolving the conflict to either side still leaves a non-empty
  // commit (an empty one would make `rebase --continue` refuse for a different reason).
  writeRepoFile(rebaseRepo, 'feature-only.txt', 'feature only\n')
  commitAll(rebaseRepo, 'feature change')
  const rebaseSource = revParse(rebaseRepo, 'HEAD')
  git(rebaseRepo, ['switch', 'main'])
  writeRepoFile(rebaseRepo, 'shared.txt', 'main side\n')
  commitAll(rebaseRepo, 'main change')
  const rebaseOnto = revParse(rebaseRepo, 'HEAD')
  git(rebaseRepo, ['switch', 'feature/login'])
  registerWorkspace(rebaseRepo)

  await withServer(rebaseRepo, async ({ gitbar, review }) => {
    /** Re-create the conflict markers from the index (git's documented way). */
    const restoreConflict = () => {
      git(rebaseRepo, ['checkout', '--merge', '--', 'shared.txt'])
      assert.match(readRepoFile(rebaseRepo, 'shared.txt'), /^<{7}/mu, 'conflict markers must be back')
    }

    const rebase = await gitbar('branch/rebase', { onto: 'main' })
    await check('2.1) 变基冲突返回专门的 code（rebaseConflict）', () => {
      assert.equal(rebase.status, 409, JSON.stringify(rebase.body).slice(0, 200))
      assert.equal(rebase.body.code, 'rebaseConflict')
    })

    const status = await gitbar('status', {})
    await check('2.2) 操作类型由宿主判定为 rebase', () => {
      assert.equal(status.body.operation?.type, 'rebase')
      assert.equal(status.body.operation?.labelsSwapped, true)
    })
    await check('2.3) 冲突文件与计数正确', () => {
      assert.equal(status.body.conflictCount, 1)
      assert.deepEqual(status.body.conflicts.map((entry) => entry.path), ['shared.txt'])
      assert.equal(status.body.conflicts[0].code, 'UU')
    })
    await check('2.4) 两侧名字正确：onto <main 短 SHA> → feature/login（分支名含 "/" 也照样对）', () => {
      assert.equal(status.body.operation?.currentLabel, `onto ${shortSha(rebaseRepo, 'main')}`)
      assert.equal(status.body.operation?.incomingLabel, 'feature/login')
      assert.equal(shortSha(rebaseRepo, 'main'), rebaseOnto.slice(0, shortSha(rebaseRepo, 'main').length))
    })

    const conflict = await review('conflict', { path: 'shared.txt' })
    await check('2.5) 语义：git 的 ours(:2) 是"变基到的那一侧"，theirs(:3) 是被重放的提交', () => {
      // 这是本节的要害：rebase 下 stage 2 / stage 3 与用户直觉相反。断言直接对着
      // `git show :N:` 的真实输出，而不是重新实现一遍解析。
      assert.equal(stage(rebaseRepo, 2, 'shared.txt'), 'main side\n')
      assert.equal(stage(rebaseRepo, 3, 'shared.txt'), 'feature side\n')
      assert.equal(normalized(conflict.body.ours), stage(rebaseRepo, 2, 'shared.txt'))
      assert.equal(normalized(conflict.body.theirs), stage(rebaseRepo, 3, 'shared.txt'))
    })
    await check('2.6) 三路内容与冲突块可读（base 是共同祖先）', () => {
      assert.equal(conflict.status, 200, JSON.stringify(conflict.body).slice(0, 300))
      assert.equal(normalized(conflict.body.base), 'base\n')
      assert.equal(conflict.body.blockCount, 1)
      assert.equal(conflict.body.hasMarkers, true)
      assert.equal(conflict.body.operationType, 'rebase')
    })
    await check('2.7) 块的两侧就是工作区文件里 `<<<<<<<` / `>>>>>>>` 两段，标记名取自 git 自己写的标签', () => {
      const labels = markerLabels(rebaseRepo, 'shared.txt')
      assert.equal(labels.ours, 'HEAD')
      assert.equal(labels.theirs, `${shortSha(rebaseRepo, rebaseSource)} (feature change)`)
      assert.equal(normalized(conflict.body.blocks[0].ours), stageBlock(rebaseRepo, 2, 'shared.txt'))
      assert.equal(normalized(conflict.body.blocks[0].theirs), stageBlock(rebaseRepo, 3, 'shared.txt'))
      assert.equal(conflict.body.blocks[0].oursLabel, labels.ours)
      assert.equal(conflict.body.blocks[0].theirsLabel, labels.theirs)
    })
    await check('2.8) review 的 /workspace 也报 rebase 与冲突文件', async () => {
      const workspace = await review('workspace', {})
      assert.equal(workspace.body.operationType, 'rebase')
      assert.equal(workspace.body.conflictCount, 1)
      const entry = workspace.body.files.find((file) => file.path === 'shared.txt')
      assert.ok(entry !== undefined, 'conflicted file must stay in files')
      assert.equal(entry.conflict, true)
    })

    await check('2.9) 逐块选择 "ours"（= 变基到的那一侧）写入 main 的内容', async () => {
      const applied = await review('conflict-resolve', { path: 'shared.txt', resolutions: { 0: 'ours' } })
      assert.equal(applied.status, 200, JSON.stringify(applied.body).slice(0, 200))
      assert.equal(readRepoFile(rebaseRepo, 'shared.txt'), 'main side\n')
      restoreConflict()
    })
    await check('2.10) 逐块选择 "theirs" 写入被重放提交的内容', async () => {
      const applied = await review('conflict-resolve', { path: 'shared.txt', resolutions: { 0: 'theirs' } })
      assert.equal(applied.status, 200, JSON.stringify(applied.body).slice(0, 200))
      assert.equal(readRepoFile(rebaseRepo, 'shared.txt'), 'feature side\n')
      restoreConflict()
    })
    await check('2.11) 逐块选择 "both" 按顺序并排写入', async () => {
      const applied = await review('conflict-resolve', { path: 'shared.txt', resolutions: { 0: 'both' } })
      assert.equal(applied.status, 200, JSON.stringify(applied.body).slice(0, 200))
      assert.equal(readRepoFile(rebaseRepo, 'shared.txt'), 'main side\nfeature side\n')
      restoreConflict()
    })
    await check('2.12) 还有冲突标记时拒绝「标记为已解决」', async () => {
      const blocked = await review('conflict-resolve', { path: 'shared.txt', markResolved: true })
      assert.equal(blocked.status, 409)
      assert.equal(blocked.body.code, 'markersRemain')
    })
    await check('2.13) 正确解决后可以「标记为已解决」，冲突计数归零', async () => {
      const marked = await review('conflict-resolve', { path: 'shared.txt', resolutions: { 0: 'theirs' }, markResolved: true })
      assert.equal(marked.status, 200, JSON.stringify(marked.body).slice(0, 200))
      assert.equal(marked.body.markedResolved, true)
      const workspace = await review('workspace', {})
      assert.equal(workspace.body.conflictCount, 0)
    })

    const continued = await gitbar('op/continue', {})
    await check('2.14) op/continue 执行的是 rebase --continue', () => {
      assert.equal(continued.status, 200, JSON.stringify(continued.body).slice(0, 200))
      assert.equal(continued.body.continued, 'rebase')
    })
    await check('2.15) 结束后没有进行中的操作，工作区干净', async () => {
      const after = await gitbar('status', {})
      assert.equal(after.body.operation, null)
      assert.equal(after.body.conflictCount, 0)
      assert.equal(porcelain(rebaseRepo), '')
    })
    await check('2.16) 历史是线性的：三个提交、无合并提交、HEAD 的父是 main', () => {
      assert.equal(git(rebaseRepo, ['rev-list', '--count', 'HEAD']).trim(), '3')
      assert.equal(git(rebaseRepo, ['rev-list', '--merges', 'HEAD']).trim(), '')
      assert.equal(git(rebaseRepo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'feature/login')
      assert.equal(subject(rebaseRepo), 'feature change')
      assert.equal(git(rebaseRepo, ['rev-parse', 'HEAD^']).trim(), rebaseOnto)
      // main 是被变基到的分支：它必须是 HEAD 的祖先（原来的 feature 提交则不是）。
      git(rebaseRepo, ['merge-base', '--is-ancestor', 'main', 'HEAD'])
      assert.notEqual(revParse(rebaseRepo, 'HEAD'), rebaseSource)
      assert.equal(readRepoFile(rebaseRepo, 'shared.txt'), 'feature side\n')
      assert.equal(readRepoFile(rebaseRepo, 'feature-only.txt'), 'feature only\n')
    })

    // ---- abort ---------------------------------------------------------------
    // A fresh divergence (the successful rebase above consumed the first one).
    git(rebaseRepo, ['switch', '-c', 'feature/abort', 'main'])
    writeRepoFile(rebaseRepo, 'shared.txt', 'abort side\n')
    commitAll(rebaseRepo, 'abort change')
    const abortTip = revParse(rebaseRepo, 'HEAD')
    git(rebaseRepo, ['switch', 'main'])
    writeRepoFile(rebaseRepo, 'shared.txt', 'main again\n')
    commitAll(rebaseRepo, 'main again')
    git(rebaseRepo, ['switch', 'feature/abort'])
    const abortRebase = await gitbar('branch/rebase', { onto: 'main' })
    await check('2.17) 重新制造一次变基冲突', () => {
      assert.equal(abortRebase.status, 409, JSON.stringify(abortRebase.body).slice(0, 200))
      assert.equal(abortRebase.body.code, 'rebaseConflict')
    })
    const aborted = await gitbar('op/abort', { kind: 'rebase' })
    await check('2.18) op/abort 把变基完全撤回（分支指回原提交、工作区干净、状态清空）', async () => {
      assert.equal(aborted.status, 200, JSON.stringify(aborted.body).slice(0, 200))
      assert.equal(revParse(rebaseRepo, 'HEAD'), abortTip)
      assert.equal(git(rebaseRepo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'feature/abort')
      assert.equal(porcelain(rebaseRepo), '')
      assert.equal(readRepoFile(rebaseRepo, 'shared.txt'), 'abort side\n')
      const after = await gitbar('status', {})
      assert.equal(after.body.operation, null)
    })
  })

  // =========================================================================
  // 2b. 多轮变基：解决完一个提交，下一个提交**又**冲突。
  //
  // 这是「继续」最容易做错的地方：`rebase --continue` 成功并不等于变基结束——git 会接着
  // 重放下一个提交，可能再次停下。界面必须据新的冲突状态继续进入下一批，而不是宣布完成。
  // =========================================================================
  console.log('')
  console.log('=== 2b. 多轮变基冲突（继续之后再次冲突） ===')
  const multiRepo = createRepo('rebase-multi-repo')
  // 两个文件改动点：main 各改 L1 / L2 一次；feature 也各改一次 —— 于是 feature 的两个提交
  // 各自都会与 main 冲突（一次一轮）。
  writeRepoFile(multiRepo, 'shared.txt', 'one\ntwo\n')
  commitAll(multiRepo, 'two lines')
  git(multiRepo, ['switch', '-c', 'feature/long'])
  writeRepoFile(multiRepo, 'shared.txt', 'one-feature\ntwo\n')
  commitAll(multiRepo, 'feature L1')
  writeRepoFile(multiRepo, 'shared.txt', 'one-feature\ntwo-feature\n')
  commitAll(multiRepo, 'feature L2')
  const multiSource = revParse(multiRepo, 'HEAD')
  git(multiRepo, ['switch', 'main'])
  writeRepoFile(multiRepo, 'shared.txt', 'one-main\ntwo\n')
  commitAll(multiRepo, 'main L1')
  writeRepoFile(multiRepo, 'shared.txt', 'one-main\ntwo-main\n')
  commitAll(multiRepo, 'main L2')
  const multiOnto = revParse(multiRepo, 'HEAD')
  git(multiRepo, ['switch', 'feature/long'])
  registerWorkspace(multiRepo)

  await withServer(multiRepo, async ({ gitbar, review }) => {
    const start = await gitbar('branch/rebase', { onto: 'main' })
    await check('2b.1) 第一轮冲突：第一个提交与 main 冲突', async () => {
      assert.equal(start.status, 409, JSON.stringify(start.body).slice(0, 200))
      assert.equal(start.body.code, 'rebaseConflict')
      const status = await gitbar('status', {})
      assert.equal(status.body.operation?.type, 'rebase')
      assert.equal(status.body.conflictCount, 1)
    })
    const firstConflict = await review('conflict', { path: 'shared.txt' })
    await check('2b.2) 第一轮冲突块来自第一个提交的改动（ours 是 main 的尖端）', () => {
      assert.equal(firstConflict.body.blockCount, 1)
      assert.equal(stage(multiRepo, 2, 'shared.txt'), 'one-main\ntwo-main\n')
      assert.equal(stage(multiRepo, 3, 'shared.txt'), 'one-feature\ntwo\n')
    })

    // 第一轮手工解决成"取第一个提交的 L1、保留 main 的 L2"——这正是用户会做的事，也保证
    // 第二个提交（改 L2）在下一轮**仍然**冲突。
    await review('conflict-resolve', { path: 'shared.txt', content: 'one-feature\ntwo-main\n', markResolved: true })
    const firstContinue = await gitbar('op/continue', {})
    await check('2b.3) 继续之后**仍然**是变基中，并且再次报出冲突（不是"操作已完成"）', async () => {
      assert.equal(firstContinue.status, 200, JSON.stringify(firstContinue.body).slice(0, 200))
      // 宿主必须把"继续之后又停在下一次冲突"当成**前进**而不是失败：`rebase --continue`
      // 在这里是以非零退出的（第二个提交又冲突），但磁盘上已经完成第一个提交的重放。
      assert.equal(firstContinue.body.stoppedAtNextConflict, true, '宿主要说明这是下一轮冲突而不是失败')
      assert.equal(firstContinue.body.conflicts, 1)
      const status = await gitbar('status', {})
      assert.equal(status.body.operation?.type, 'rebase')
      assert.equal(status.body.conflictCount, 1, '第二个提交应当再次冲突')
      assert.deepEqual(status.body.conflicts.map((entry) => entry.path), ['shared.txt'])
    })
    const secondConflict = await review('conflict', { path: 'shared.txt' })
    await check('2b.4) 第二轮冲突块来自第二个提交的改动，且第一轮的结果已经生效', () => {
      assert.equal(secondConflict.body.blockCount, 1)
      // 第二轮：ours = 刚重放完的第一个提交（含手工解决的结果），theirs = 第二个提交。
      assert.equal(stage(multiRepo, 2, 'shared.txt'), 'one-feature\ntwo-main\n')
      assert.equal(stage(multiRepo, 3, 'shared.txt'), 'one-feature\ntwo-feature\n')
    })

    await review('conflict-resolve', { path: 'shared.txt', resolutions: { 0: 'theirs' }, markResolved: true })
    const secondContinue = await gitbar('op/continue', {})
    await check('2b.5) 第二轮继续之后变基真正结束', async () => {
      assert.equal(secondContinue.status, 200, JSON.stringify(secondContinue.body).slice(0, 200))
      const status = await gitbar('status', {})
      assert.equal(status.body.operation, null)
      assert.equal(status.body.conflictCount, 0)
      assert.equal(porcelain(multiRepo), '')
    })
    await check('2b.6) 两个提交都被重放：历史线性、内容正确、无合并提交', () => {
      // initial + "two lines" + main×2 + feature×2：两个 feature 提交都落在 main 之上，
      // 而且**一个合并提交都没有**（变基不是合并）。
      assert.equal(git(multiRepo, ['rev-list', '--count', 'HEAD']).trim(), '6', 'initial + two lines + main×2 + feature×2')
      assert.equal(git(multiRepo, ['rev-list', '--merges', 'HEAD']).trim(), '')
      assert.equal(git(multiRepo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'feature/long')
      assert.equal(subject(multiRepo), 'feature L2')
      assert.equal(subject(multiRepo, 'HEAD^'), 'feature L1')
      assert.equal(git(multiRepo, ['rev-parse', 'HEAD^^']).trim(), multiOnto, '两个提交都落在 main 之上')
      assert.notEqual(revParse(multiRepo, 'HEAD'), multiSource)
      assert.equal(readRepoFile(multiRepo, 'shared.txt'), 'one-feature\ntwo-feature\n')
    })
  })

  // =========================================================================
  // 3. Cherry-pick conflict.
  // =========================================================================
  console.log('')
  console.log('=== 3. cherry-pick conflict: detect -> resolve -> continue ===')
  const pickRepo = createRepo('pick-repo')
  git(pickRepo, ['switch', '-c', 'side'])
  writeRepoFile(pickRepo, 'shared.txt', 'side change\n')
  writeRepoFile(pickRepo, 'side-only.txt', 'side only\n')
  commitAll(pickRepo, 'side change')
  const pickSource = revParse(pickRepo, 'HEAD')
  git(pickRepo, ['switch', 'main'])
  writeRepoFile(pickRepo, 'shared.txt', 'main change\n')
  commitAll(pickRepo, 'main change')
  const pickBase = revParse(pickRepo, 'HEAD')
  registerWorkspace(pickRepo)

  await withServer(pickRepo, async ({ gitbar, review }) => {
    const restoreConflict = () => {
      git(pickRepo, ['checkout', '--merge', '--', 'shared.txt'])
      assert.match(readRepoFile(pickRepo, 'shared.txt'), /^<{7}/mu, 'conflict markers must be back')
    }

    const picked = await gitbar('cherry-pick', { revision: pickSource })
    await check('3.1) 摘取冲突返回专门的 code，且操作类型是 cherry-pick', async () => {
      assert.equal(picked.status, 409, JSON.stringify(picked.body).slice(0, 200))
      assert.equal(picked.body.code, 'cherryPickConflict')
      const status = await gitbar('status', {})
      assert.equal(status.body.operation?.type, 'cherry-pick')
      assert.equal(status.body.operation?.labelsSwapped, false)
    })
    await check('3.2) 冲突计数与两侧名字正确（当前分支 main → 被摘取的 side）', async () => {
      const status = await gitbar('status', {})
      assert.equal(status.body.conflictCount, 1)
      assert.equal(status.body.operation?.currentLabel, 'main')
      assert.equal(status.body.operation?.incomingLabel, 'side')
    })
    const conflict = await review('conflict', { path: 'shared.txt' })
    await check('3.3) 冲突解决面板能读到内容（ours = 当前分支，theirs = 被摘取的提交）', () => {
      assert.equal(conflict.status, 200, JSON.stringify(conflict.body).slice(0, 300))
      assert.equal(normalized(conflict.body.ours), stage(pickRepo, 2, 'shared.txt'))
      assert.equal(normalized(conflict.body.theirs), stage(pickRepo, 3, 'shared.txt'))
      assert.equal(stage(pickRepo, 2, 'shared.txt'), 'main change\n')
      assert.equal(stage(pickRepo, 3, 'shared.txt'), 'side change\n')
      assert.equal(normalized(conflict.body.base), 'base\n')
      assert.equal(conflict.body.blockCount, 1)
      assert.equal(conflict.body.operationType, 'cherry-pick')
    })
    await check('3.4) 标记名来自 git 自己写的标签', () => {
      const labels = markerLabels(pickRepo, 'shared.txt')
      assert.equal(labels.ours, 'HEAD')
      assert.equal(labels.theirs, `${shortSha(pickRepo, pickSource)} (side change)`)
      assert.equal(conflict.body.blocks[0].oursLabel, labels.ours)
      assert.equal(conflict.body.blocks[0].theirsLabel, labels.theirs)
    })
    await check('3.5) 三个核心选择路径都写对内容', async () => {
      const ours = await review('conflict-resolve', { path: 'shared.txt', resolutions: { 0: 'ours' } })
      assert.equal(ours.status, 200)
      assert.equal(readRepoFile(pickRepo, 'shared.txt'), 'main change\n')
      restoreConflict()
      const theirs = await review('conflict-resolve', { path: 'shared.txt', resolutions: { 0: 'theirs' } })
      assert.equal(theirs.status, 200)
      assert.equal(readRepoFile(pickRepo, 'shared.txt'), 'side change\n')
      restoreConflict()
      const both = await review('conflict-resolve', { path: 'shared.txt', resolutions: { 0: 'both' } })
      assert.equal(both.status, 200)
      assert.equal(readRepoFile(pickRepo, 'shared.txt'), 'main change\nside change\n')
      restoreConflict()
    })
    await check('3.6) 解决后可以「标记为已解决」', async () => {
      const marked = await review('conflict-resolve', { path: 'shared.txt', resolutions: { 0: 'theirs' }, markResolved: true })
      assert.equal(marked.status, 200, JSON.stringify(marked.body).slice(0, 200))
      assert.equal(marked.body.markedResolved, true)
      const workspace = await review('workspace', {})
      assert.equal(workspace.body.conflictCount, 0)
    })

    const continued = await gitbar('op/continue', {})
    await check('3.7) op/continue 执行的是 cherry-pick --continue', () => {
      assert.equal(continued.status, 200, JSON.stringify(continued.body).slice(0, 200))
      assert.equal(continued.body.continued, 'cherry-pick')
    })
    await check('3.8) 完成后没有进行中的操作', async () => {
      const after = await gitbar('status', {})
      assert.equal(after.body.operation, null)
      assert.equal(porcelain(pickRepo), '')
    })
    await check('3.9) HEAD 里确实有被摘取提交的内容（文件与提交都到位）', () => {
      assert.equal(subject(pickRepo), 'side change')
      assert.equal(git(pickRepo, ['rev-parse', 'HEAD^']).trim(), pickBase)
      assert.equal(git(pickRepo, ['rev-list', '--merges', 'HEAD']).trim(), '')
      assert.equal(readRepoFile(pickRepo, 'shared.txt'), 'side change\n')
      assert.equal(readRepoFile(pickRepo, 'side-only.txt'), 'side only\n')
      // 被摘取的提交对象本身不在历史里（内容一致、身份不同），但两个文件的树必须一致。
      assert.notEqual(revParse(pickRepo, 'HEAD'), pickSource)
      assert.equal(git(pickRepo, ['diff', '--name-only', pickSource, 'HEAD', '--', 'shared.txt', 'side-only.txt']).trim(), '')
    })

    // ---- abort ---------------------------------------------------------------
    git(pickRepo, ['switch', '-c', 'side2'])
    writeRepoFile(pickRepo, 'shared.txt', 'side two\n')
    writeRepoFile(pickRepo, 'side-two.txt', 'side two\n')
    commitAll(pickRepo, 'side two')
    const pickTwo = revParse(pickRepo, 'HEAD')
    git(pickRepo, ['switch', 'main'])
    writeRepoFile(pickRepo, 'shared.txt', 'main two\n')
    commitAll(pickRepo, 'main two')
    const mainTwo = revParse(pickRepo, 'HEAD')
    const secondPick = await gitbar('cherry-pick', { revision: pickTwo })
    await check('3.10) 重新制造一次摘取冲突', () => {
      assert.equal(secondPick.status, 409, JSON.stringify(secondPick.body).slice(0, 200))
      assert.equal(secondPick.body.code, 'cherryPickConflict')
    })
    const aborted = await gitbar('op/abort', { kind: 'cherry-pick' })
    await check('3.11) op/abort 把摘取完全撤回（HEAD 回到原提交、工作区干净）', async () => {
      assert.equal(aborted.status, 200, JSON.stringify(aborted.body).slice(0, 200))
      assert.equal(revParse(pickRepo, 'HEAD'), mainTwo)
      assert.equal(porcelain(pickRepo), '')
      assert.equal(readRepoFile(pickRepo, 'shared.txt'), 'main two\n')
      assert.equal(gitTry(pickRepo, ['rev-parse', '--verify', '--quiet', 'HEAD:side-two.txt']).ok, false)
      const after = await gitbar('status', {})
      assert.equal(after.body.operation, null)
    })
  })

  // =========================================================================
  // 4. Revert conflict.
  //
  // There is no route that *starts* `git revert <commit>` (that is a separate feature), so
  // the conflict is produced by real git — exactly the situation of a user who ran the
  // revert in a terminal and then opens the app to resolve it. Everything after that is
  // driven through the app's own routes.
  // =========================================================================
  console.log('')
  console.log('=== 4. revert conflict: detect -> resolve -> continue ===')
  const revertRepo = join(scratch, 'revert-repo')
  mkdirSync(revertRepo, { recursive: true })
  git(revertRepo, ['init', '--initial-branch=main'])
  git(revertRepo, ['config', 'user.email', 'test@example.com'])
  git(revertRepo, ['config', 'user.name', 'Test'])
  git(revertRepo, ['config', 'commit.gpgsign', 'false'])
  writeRepoFile(revertRepo, 'shared.txt', 'base\n')
  commitAll(revertRepo, 'initial')
  writeRepoFile(revertRepo, 'shared.txt', 'first\n')
  commitAll(revertRepo, 'first change')
  const reverted = revParse(revertRepo, 'HEAD')
  writeRepoFile(revertRepo, 'shared.txt', 'second\n')
  commitAll(revertRepo, 'second change')
  const beforeRevert = revParse(revertRepo, 'HEAD')
  registerWorkspace(revertRepo)

  await withServer(revertRepo, async ({ gitbar, review }) => {
    const restoreConflict = () => {
      git(revertRepo, ['checkout', '--merge', '--', 'shared.txt'])
      assert.match(readRepoFile(revertRepo, 'shared.txt'), /^<{7}/mu, 'conflict markers must be back')
    }
    const startRevert = () => {
      const attempt = gitTry(revertRepo, ['revert', '--no-edit', reverted])
      assert.equal(attempt.ok, false, 'reverting a commit whose file changed afterwards must conflict')
    }

    startRevert()
    const status = await gitbar('status', {})
    await check('4.1) 操作类型由宿主判定为 revert', () => {
      assert.equal(status.body.operation?.type, 'revert')
      assert.equal(status.body.operation?.labelsSwapped, false)
    })
    await check('4.2) 冲突计数正确，review 侧也认作 revert', async () => {
      assert.equal(status.body.conflictCount, 1)
      assert.deepEqual(status.body.conflicts.map((entry) => entry.path), ['shared.txt'])
      const workspace = await review('workspace', {})
      assert.equal(workspace.body.operationType, 'revert')
      assert.equal(workspace.body.conflictCount, 1)
    })
    const conflict = await review('conflict', { path: 'shared.txt' })
    await check('4.3) 冲突解决面板能读到内容（theirs 是"还原回去"的那一侧）', () => {
      assert.equal(conflict.status, 200, JSON.stringify(conflict.body).slice(0, 300))
      assert.equal(normalized(conflict.body.ours), stage(revertRepo, 2, 'shared.txt'))
      assert.equal(normalized(conflict.body.theirs), stage(revertRepo, 3, 'shared.txt'))
      assert.equal(stage(revertRepo, 2, 'shared.txt'), 'second\n')
      assert.equal(stage(revertRepo, 3, 'shared.txt'), 'base\n')
      assert.equal(conflict.body.blockCount, 1)
      assert.equal(conflict.body.operationType, 'revert')
    })
    await check('4.4) 标记名是 git 为 revert 写的 "parent of …"', () => {
      const labels = markerLabels(revertRepo, 'shared.txt')
      assert.equal(labels.ours, 'HEAD')
      assert.match(labels.theirs, /^parent of [0-9a-f]{7,}/u)
      assert.match(labels.theirs, /first change/u)
      assert.equal(conflict.body.blocks[0].theirsLabel, labels.theirs)
    })
    await check('4.5) 逐块选择 ours / theirs 都写对内容', async () => {
      const ours = await review('conflict-resolve', { path: 'shared.txt', resolutions: { 0: 'ours' } })
      assert.equal(ours.status, 200)
      assert.equal(readRepoFile(revertRepo, 'shared.txt'), 'second\n')
      restoreConflict()
      const theirs = await review('conflict-resolve', { path: 'shared.txt', resolutions: { 0: 'theirs' } })
      assert.equal(theirs.status, 200)
      assert.equal(readRepoFile(revertRepo, 'shared.txt'), 'base\n')
      restoreConflict()
    })
    await check('4.6) 解决后可以「标记为已解决」', async () => {
      const marked = await review('conflict-resolve', { path: 'shared.txt', resolutions: { 0: 'theirs' }, markResolved: true })
      assert.equal(marked.status, 200, JSON.stringify(marked.body).slice(0, 200))
      assert.equal(marked.body.markedResolved, true)
      const workspace = await review('workspace', {})
      assert.equal(workspace.body.conflictCount, 0)
    })
    const continued = await gitbar('op/continue', {})
    await check('4.7) op/continue 执行的是 revert --continue', () => {
      assert.equal(continued.status, 200, JSON.stringify(continued.body).slice(0, 200))
      assert.equal(continued.body.continued, 'revert')
    })
    await check('4.8) 历史里产生了一个真正的 revert 提交，且没有进行中的操作', async () => {
      const after = await gitbar('status', {})
      assert.equal(after.body.operation, null)
      assert.equal(porcelain(revertRepo), '')
      assert.equal(git(revertRepo, ['rev-list', '--count', 'HEAD']).trim(), '4')
      assert.match(subject(revertRepo), /^Revert "first change"/u)
      assert.equal(git(revertRepo, ['rev-parse', 'HEAD^']).trim(), beforeRevert)
      assert.equal(readRepoFile(revertRepo, 'shared.txt'), 'base\n')
    })

    // ---- abort ---------------------------------------------------------------
    git(revertRepo, ['reset', '--hard', beforeRevert])
    startRevert()
    const abortStatus = await gitbar('status', {})
    await check('4.9) 重新制造一次 revert 冲突', () => {
      assert.equal(abortStatus.body.operation?.type, 'revert')
      assert.equal(abortStatus.body.conflictCount, 1)
    })
    const aborted = await gitbar('op/abort', { kind: 'revert' })
    await check('4.10) op/abort 把 revert 完全撤回（HEAD 未动、工作区干净）', async () => {
      assert.equal(aborted.status, 200, JSON.stringify(aborted.body).slice(0, 200))
      assert.equal(revParse(revertRepo, 'HEAD'), beforeRevert)
      assert.equal(porcelain(revertRepo), '')
      assert.equal(readRepoFile(revertRepo, 'shared.txt'), 'second\n')
      const after = await gitbar('status', {})
      assert.equal(after.body.operation, null)
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
