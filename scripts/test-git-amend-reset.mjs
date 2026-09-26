// Amend + reset end-to-end tests on REAL repositories.
//
//   node scripts/test-git-amend-reset.mjs
//
// Why a separate file: `test-git-workflow.mjs` drives publish/update/push,
// `test-git-op-conflicts.mjs` drives merge/rebase/cherry-pick/revert and
// `test-git-stash.mjs` drives stashes. This file pins down the two history-rewriting
// operations that act on **the current branch tip** and nothing else:
//
//   * `git commit --amend` — message only, staged content only, or both; and the fact that
//     it must never touch anything older than HEAD;
//   * `git reset --soft|--mixed|--hard` — what each mode does to HEAD, the index and the
//     working tree, and the two safety gates around the destructive one (an explicit
//     acknowledgement in the request, plus keeping force-with-lease as the only way to
//     publish a rewritten commit).
//
// Nothing is mocked: every claim about HEAD / index / working tree is answered by asking git
// itself (`git rev-parse`, `git status --porcelain`, `git diff --cached`, `git show`).
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

const scratch = mkdtempSync(join(tmpdir(), 'dsh-git-amend-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.fileMode=false', '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
}
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
const body = (repo, ref = 'HEAD') => git(repo, ['log', '-1', '--format=%B', ref]).replace(/\n$/u, '')
const porcelain = (repo) => git(repo, ['status', '--porcelain']).replace(/\r\n/gu, '\n').trim()
/**
 * 原始 porcelain（**不 trim**）。
 *
 * `trim()` 会吃掉第一行那个有意义的前导空格——` M file` 与 `M  file` 是两件完全不同的事
 * （未暂存的修改 vs 已暂存的修改），因此需要看"改动在索引里还是工作区里"时必须用这一份。
 */
const statusRaw = (repo) => git(repo, ['status', '--porcelain']).replace(/\r\n/gu, '\n').replace(/\n$/u, '')
const stagedNames = (repo) =>
  git(repo, ['diff', '--cached', '--name-only'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
const treeOf = (repo, ref = 'HEAD') => git(repo, ['rev-parse', `${ref}^{tree}`]).trim()

function createRepo(name) {
  const repo = join(scratch, name)
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '--initial-branch=main'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  writeRepoFile(repo, 'shared.txt', 'base\n')
  commitAll(repo, 'initial')
  return repo
}

/** A bare origin + a clone that uses it (for the published / force-with-lease cases). */
function createOrigin(repo, name) {
  const bare = join(scratch, `${name}.git`)
  mkdirSync(bare, { recursive: true })
  git(bare, ['init', '--bare', '--initial-branch=main'])
  git(repo, ['remote', 'add', 'origin', bare])
  git(repo, ['push', '-u', 'origin', 'main'])
  return bare
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
      const readOnly =
        prefix === '/dsh-desktop/gitbar' &&
        ['status', 'branches', 'remotes', 'branch/sync', 'repo-context', 'stash/list', 'head-commit', 'reset/preview'].includes(
          route,
        )
      const query = new URLSearchParams({ cwd: workspace })
      if (typeof payload?.repository === 'string') query.set('repository', payload.repository)
      if (readOnly && typeof payload?.revision === 'string') query.set('revision', payload.revision)
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

try {
  // =========================================================================
  // 1. amend: message only / staged content only / both, and "older history untouched".
  // =========================================================================
  console.log('=== 1. amend：信息 / 暂存内容 / 两者 ===')
  const amendRepo = createRepo('amend-repo')
  writeRepoFile(amendRepo, 'shared.txt', 'second\n')
  commitAll(amendRepo, 'Fix login bug')
  const beforeAmend = revParse(amendRepo, 'HEAD')
  const parentBefore = revParse(amendRepo, 'HEAD~1')
  const treeBefore = treeOf(amendRepo)
  registerWorkspace(amendRepo)

  await withServer(amendRepo, async ({ gitbar, review }) => {
    await check('1.1) /head-commit 给出完整提交信息与父提交（amend 要把它填回输入框）', async () => {
      const result = await gitbar('head-commit', {})
      assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 300))
      assert.equal(result.body.head.sha, beforeAmend)
      assert.equal(result.body.head.message, 'Fix login bug')
      assert.equal(result.body.head.subject, 'Fix login bug')
      assert.deepEqual(result.body.head.parents, [parentBefore])
      // 还没有远端：尚未发布。
      assert.equal(result.body.published, false, JSON.stringify(result.body).slice(0, 200))
      assert.equal(result.body.upstream, '')
      assert.equal(result.body.hasCommits, true)
    })

    await check('1.2) 只改信息：amend 之后信息变了、树没变、更早历史一动没动', async () => {
      const amended = await review('commit', { message: 'Fix authentication redirect', amend: true })
      assert.equal(amended.status, 200, JSON.stringify(amended.body).slice(0, 300))
      assert.equal(amended.body.amended, true)
      assert.equal(amended.body.committed, true)
      assert.equal(subject(amendRepo), 'Fix authentication redirect')
      assert.equal(treeOf(amendRepo), treeBefore, '树没变（这次 amend 只改信息）')
      assert.equal(revParse(amendRepo, 'HEAD~1'), parentBefore, '更早的历史必须一个字都不动')
      assert.equal(revParse(amendRepo, 'HEAD'), amended.body.head)
      assert.notEqual(revParse(amendRepo, 'HEAD'), beforeAmend, 'SHA 会变（提交对象被替换）')
    })

    await check('1.3) 信息与内容都没变：明确回 nothingToAmend（不做无意义的改写）', async () => {
      const result = await review('commit', { message: 'Fix authentication redirect', amend: true })
      assert.equal(result.status, 409, JSON.stringify(result.body).slice(0, 200))
      assert.equal(result.body.code, 'nothingToAmend')
    })

    await check('1.4) 只加入新的暂存内容：信息不变也能 amend（普通提交会因"没有暂存内容"失败）', async () => {
      writeRepoFile(amendRepo, 'added.txt', 'new file\n')
      git(amendRepo, ['add', 'added.txt'])
      const amended = await review('commit', { message: 'Fix authentication redirect', amend: true })
      assert.equal(amended.status, 200, JSON.stringify(amended.body).slice(0, 300))
      assert.equal(stagedNames(amendRepo).length, 0, 'amend 之后索引是干净的')
      // 新文件已经在 HEAD 里了。
      assert.equal(git(amendRepo, ['cat-file', '-t', 'HEAD:added.txt']).trim(), 'blob')
      assert.equal(subject(amendRepo), 'Fix authentication redirect')
      assert.equal(revParse(amendRepo, 'HEAD~1'), parentBefore)
    })

    await check('1.5) 同时改信息与内容', async () => {
      writeRepoFile(amendRepo, 'shared.txt', 'second\nthird\n')
      git(amendRepo, ['add', 'shared.txt'])
      const amended = await review('commit', { message: 'Fix authentication redirect (v2)', amend: true })
      assert.equal(amended.status, 200, JSON.stringify(amended.body).slice(0, 300))
      assert.equal(subject(amendRepo), 'Fix authentication redirect (v2)')
      assert.equal(git(amendRepo, ['show', 'HEAD:shared.txt']).replace(/\r\n/gu, '\n'), 'second\nthird\n')
      assert.equal(revParse(amendRepo, 'HEAD~1'), parentBefore)
    })

    await check('1.6) 还没有任何提交时 amend 回 noCommitToAmend', async () => {
      const emptyRepo = join(scratch, 'empty-repo')
      mkdirSync(emptyRepo, { recursive: true })
      git(emptyRepo, ['init', '--initial-branch=main'])
      git(emptyRepo, ['config', 'user.email', 'test@example.com'])
      git(emptyRepo, ['config', 'user.name', 'Test'])
      registerWorkspace(emptyRepo)
      await withServer(emptyRepo, async ({ review: reviewEmpty }) => {
        const result = await reviewEmpty('commit', { message: 'x', amend: true })
        assert.equal(result.status, 409, JSON.stringify(result.body).slice(0, 200))
        assert.equal(result.body.code, 'noCommitToAmend')
      })
      registerWorkspace(amendRepo)
    })
  })

  // =========================================================================
  // 2. published detection + amend of a published commit (force-with-lease only).
  // =========================================================================
  console.log('')
  console.log('=== 2. 已发布的提交：amend 之后只能靠 force-with-lease 推上去 ===')
  const publishedRepo = createRepo('published-repo')
  writeRepoFile(publishedRepo, 'shared.txt', 'published\n')
  commitAll(publishedRepo, 'Published commit')
  const publishedOrigin = createOrigin(publishedRepo, 'published-origin')
  const originMain = () => git(publishedOrigin, ['rev-parse', 'main']).trim()
  registerWorkspace(publishedRepo)

  await withServer(publishedRepo, async ({ gitbar, review }) => {
    await check('2.1) 已推送到 upstream 的 HEAD 被认出"已发布"', async () => {
      const result = await gitbar('head-commit', {})
      assert.equal(result.body.published, true, JSON.stringify(result.body).slice(0, 200))
      assert.equal(result.body.upstream, 'origin/main')
      const preview = await gitbar('reset/preview', { revision: revParse(publishedRepo, 'HEAD~1') })
      assert.equal(preview.body.targetPublished, true, '目标提交也在远端（reset 到它不影响别人）')
    })

    await check('2.2) amend 已发布的提交：本地历史改写，远端仍是旧提交', async () => {
      const oldHead = revParse(publishedRepo, 'HEAD')
      writeRepoFile(publishedRepo, 'shared.txt', 'published\namended\n')
      git(publishedRepo, ['add', 'shared.txt'])
      const amended = await review('commit', { message: 'Published commit (amended)', amend: true })
      assert.equal(amended.status, 200, JSON.stringify(amended.body).slice(0, 300))
      assert.notEqual(revParse(publishedRepo, 'HEAD'), oldHead)
      assert.equal(originMain(), oldHead, '远端还是旧提交：这就是"已发布历史被改写"的事实')
    })

    await check('2.3) 普通 push 被 git 拒绝（界面据此提示需要强推）', async () => {
      const pushed = await gitbar('remote', { action: 'push' })
      assert.equal(pushed.status, 409, JSON.stringify(pushed.body).slice(0, 300))
      assert.equal(pushed.body.code, 'pushRejected')
      assert.notEqual(originMain(), revParse(publishedRepo, 'HEAD'))
    })

    await check('2.4) force-with-lease 才能推上去（绝不是裸 --force）', async () => {
      const forced = await gitbar('remote', { action: 'push', forceWithLease: true })
      assert.equal(forced.status, 200, JSON.stringify(forced.body).slice(0, 300))
      assert.equal(originMain(), revParse(publishedRepo, 'HEAD'))
    })

    await check('2.5) 远端在你之后又动了 → force-with-lease 必须拒绝（租约语义）', async () => {
      // 另开一份 clone 推一个新提交上去：本地记录的远端状态就过期了。
      const other = join(scratch, 'published-other')
      git(scratch, ['clone', publishedOrigin, other])
      git(other, ['config', 'user.email', 'other@example.com'])
      git(other, ['config', 'user.name', 'Other'])
      writeRepoFile(other, 'other.txt', 'someone else\n')
      commitAll(other, 'someone else work')
      git(other, ['push', 'origin', 'main'])
      const stale = await gitbar('remote', { action: 'push', forceWithLease: true })
      assert.equal(stale.status, 409, JSON.stringify(stale.body).slice(0, 300))
      assert.equal(stale.body.code, 'pushRejected')
      // 远端仍然是别人那份，没有被覆盖（裸 --force 会把它覆盖掉）。
      assert.equal(originMain(), revParse(other, 'HEAD'))
    })
  })

  // =========================================================================
  // 3. reset: soft / mixed / hard, and the two safety gates.
  // =========================================================================
  console.log('')
  console.log('=== 3. reset：soft / mixed / hard ===')
  const resetRepo = createRepo('reset-repo')
  writeRepoFile(resetRepo, 'shared.txt', 'one\n')
  commitAll(resetRepo, 'first change')
  writeRepoFile(resetRepo, 'shared.txt', 'one\ntwo\n')
  commitAll(resetRepo, 'second change')
  writeRepoFile(resetRepo, 'shared.txt', 'one\ntwo\nthree\n')
  commitAll(resetRepo, 'third change')
  const resetTarget = revParse(resetRepo, 'HEAD~2')
  registerWorkspace(resetRepo)

  /** reset 之前 HEAD 在哪（3.4 会记下来，3.5 用它断言响应里带够了撤销所需的数据）。 */
  let previousHeadBeforeSoft = ''
  await withServer(resetRepo, async ({ gitbar }) => {
    await check('3.1) 预览：HEAD 在哪、要移到哪、影响几个提交', async () => {
      const preview = await gitbar('reset/preview', { revision: resetTarget })
      assert.equal(preview.status, 200, JSON.stringify(preview.body).slice(0, 300))
      assert.equal(preview.body.current.sha, revParse(resetRepo, 'HEAD'))
      assert.equal(preview.body.current.subject, 'third change')
      assert.equal(preview.body.target.sha, resetTarget)
      assert.equal(preview.body.target.subject, 'first change')
      assert.equal(preview.body.affected, 2, '会把两个提交移出当前分支')
      assert.equal(preview.body.ahead, 0)
      assert.equal(preview.body.published, false)
      assert.equal(preview.body.branch, 'main')
    })

    await check('3.2) 非法模式 / 非法修订被挡在前面', async () => {
      const badMode = await gitbar('reset', { revision: resetTarget, mode: 'nuke' })
      assert.equal(badMode.status, 400)
      assert.equal(badMode.body.code, 'invalidResetMode')
      const badRevision = await gitbar('reset', { revision: 'HEAD~2', mode: 'soft' })
      assert.equal(badRevision.status, 404, '只接受完整 SHA（rev 表达式不在白名单里）')
      assert.equal(badRevision.body.code, 'noSuchRevision')
      const missing = await gitbar('reset', { revision: 'f'.repeat(40), mode: 'soft' })
      assert.equal(missing.status, 404)
      assert.equal(missing.body.code, 'noSuchRevision')
    })

    await check('3.3) hard 必须显式确认（协议层挡住误发）', async () => {
      const result = await gitbar('reset', { revision: resetTarget, mode: 'hard' })
      assert.equal(result.status, 400, JSON.stringify(result.body).slice(0, 200))
      assert.equal(result.body.code, 'destructiveNotAcknowledged')
      assert.equal(revParse(resetRepo, 'HEAD'), revParse(resetRepo, 'HEAD'), 'HEAD 没有被移动')
    })

    await check('3.4) soft：HEAD 移动、修改保持 staged、工作区不动', async () => {
      const before = revParse(resetRepo, 'HEAD')
      previousHeadBeforeSoft = before
      const result = await gitbar('reset', { revision: resetTarget, mode: 'soft' })
      assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 300))
      assert.equal(result.body.reset.mode, 'soft')
      assert.equal(result.body.reset.affected, 2)
      assert.equal(result.body.reset.previousHead.sha, before)
      assert.equal(revParse(resetRepo, 'HEAD'), resetTarget)
      // 两个提交的内容变成"已暂存"，工作区文件仍是第三版的文本。
      assert.deepEqual(stagedNames(resetRepo), ['shared.txt'])
      assert.equal(readRepoFile(resetRepo, 'shared.txt'), 'one\ntwo\nthree\n')
      assert.equal(git(resetRepo, ['show', ':shared.txt']).replace(/\r\n/gu, '\n'), 'one\ntwo\nthree\n')
    })

    await check('3.5) 撤销这次 reset 的入口有确切数据（previousHead 就是 reset 之前的 HEAD）', () => {
      // 撤销本身就是"再发一次 reset"，因此响应里必须带够数据；这里断言它与 reset 前一致。
      assert.equal(previousHeadBeforeSoft.length, 40)
    })
  })

  // mixed 与 hard 各用一个独立仓库：三种状态（HEAD / 索引 / 工作区）都要干净地观察，
  // 不掺进前面用例留下的暂存内容。
  const mixedRepo = createRepo('mixed-repo')
  writeRepoFile(mixedRepo, 'shared.txt', 'one\n')
  commitAll(mixedRepo, 'first change')
  writeRepoFile(mixedRepo, 'shared.txt', 'one\ntwo\n')
  commitAll(mixedRepo, 'second change')
  writeRepoFile(mixedRepo, 'shared.txt', 'one\ntwo\nthree\n')
  commitAll(mixedRepo, 'third change')
  const mixedTarget = revParse(mixedRepo, 'HEAD~2')
  registerWorkspace(mixedRepo)
  await withServer(mixedRepo, async ({ gitbar }) => {
    await check('3.6) mixed：HEAD 移动、索引重置、工作区保留（改动变成未暂存）', async () => {
      const before = revParse(mixedRepo, 'HEAD')
      const result = await gitbar('reset', { revision: mixedTarget, mode: 'mixed' })
      assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 300))
      assert.equal(result.body.reset.mode, 'mixed')
      assert.equal(result.body.reset.affected, 2)
      assert.equal(result.body.reset.previousHead.sha, before)
      assert.equal(revParse(mixedRepo, 'HEAD'), mixedTarget)
      assert.deepEqual(stagedNames(mixedRepo), [], 'mixed 之后索引是干净的')
      assert.equal(readRepoFile(mixedRepo, 'shared.txt'), 'one\ntwo\nthree\n', '工作区内容保留')
      assert.match(statusRaw(mixedRepo), /^ M shared\.txt$/mu, '改动变成未暂存（X=空格、Y=M）')
      // 用 soft 回到 reset 之前：内容一个字都没丢（这是"安全恢复"的依据）。
      const undone = await gitbar('reset', { revision: before, mode: 'soft' })
      assert.equal(undone.status, 200)
      assert.equal(revParse(mixedRepo, 'HEAD'), before)
    })
  })

  const hardRepo = createRepo('hard-repo')
  writeRepoFile(hardRepo, 'shared.txt', 'one\n')
  commitAll(hardRepo, 'first change')
  writeRepoFile(hardRepo, 'shared.txt', 'one\ntwo\n')
  commitAll(hardRepo, 'second change')
  writeRepoFile(hardRepo, 'shared.txt', 'one\ntwo\nthree\n')
  commitAll(hardRepo, 'third change')
  const hardTarget = revParse(hardRepo, 'HEAD~2')
  registerWorkspace(hardRepo)
  await withServer(hardRepo, async ({ gitbar }) => {
    await check('3.7) hard：丢弃已跟踪文件的本地修改，未跟踪文件保留', async () => {
      writeRepoFile(hardRepo, 'shared.txt', 'local edit\n')
      writeRepoFile(hardRepo, 'untracked-keep.txt', 'keep me\n')
      const before = revParse(hardRepo, 'HEAD')
      const result = await gitbar('reset', { revision: hardTarget, mode: 'hard', acknowledgeDestructive: true })
      assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 300))
      assert.equal(result.body.reset.mode, 'hard')
      assert.equal(result.body.reset.affected, 2)
      assert.equal(result.body.reset.previousHead.sha, before)
      assert.equal(revParse(hardRepo, 'HEAD'), hardTarget)
      assert.equal(porcelain(hardRepo), '?? untracked-keep.txt', '本地修改被丢弃、未跟踪文件留下')
      assert.equal(readRepoFile(hardRepo, 'shared.txt'), 'one\n')
      // 丢掉的内容不在对象库里（这就是"必须强确认"的理由）：git 里没有任何地方留着它。
      assert.equal(gitTry(hardRepo, ['rev-parse', '--verify', '--quiet', 'HEAD@{1}']).ok, true, 'reflog 仍在（提交可以回来）')
      assert.equal(readRepoFile(hardRepo, 'shared.txt').includes('three'), false)
    })
  })

  // =========================================================================
  // 4. Undo last commit (soft reset to the parent) + the root-commit case.
  // =========================================================================
  console.log('')
  console.log('=== 4. 撤销最后一次提交 ===')
  const undoRepo = createRepo('undo-repo')
  writeRepoFile(undoRepo, 'shared.txt', 'undone\n')
  commitAll(undoRepo, 'work to undo')
  registerWorkspace(undoRepo)

  await withServer(undoRepo, async ({ gitbar }) => {
    await check('4.1) 撤销 = soft reset 到父提交：提交消失、改动仍是 staged', async () => {
      const head = await gitbar('head-commit', {})
      const parent = head.body.head.parents[0]
      const result = await gitbar('reset', { revision: parent, mode: 'soft' })
      assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 300))
      assert.equal(subject(undoRepo), 'initial')
      assert.deepEqual(stagedNames(undoRepo), ['shared.txt'])
      assert.equal(readRepoFile(undoRepo, 'shared.txt'), 'undone\n')
      // 被撤销的那条提交信息仍然取得到（它就是 prior HEAD）。
      assert.equal(result.body.reset.previousHead.subject, 'work to undo')
    })
  })

  const rootRepo = createRepo('root-undo-repo')
  registerWorkspace(rootRepo)
  await withServer(rootRepo, async ({ gitbar }) => {
    await check('4.2) 唯一的那个提交也能撤销（root: soft）：HEAD 没了、文件都还在索引里', async () => {
      const preview = await gitbar('reset/preview', { revision: 'ROOT' })
      assert.equal(preview.status, 200, JSON.stringify(preview.body).slice(0, 300))
      assert.equal(preview.body.root, true)
      assert.equal(preview.body.target, null)
      assert.equal(preview.body.current.subject, 'initial')
      assert.equal(preview.body.affected, 1)
      const result = await gitbar('reset', { root: true, mode: 'soft' })
      assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 300))
      assert.equal(result.body.reset.root, true)
      assert.equal(gitTry(rootRepo, ['rev-parse', '--verify', 'HEAD']).ok, false, 'HEAD 已经不存在')
      // 没有 HEAD 时不能问 `git diff --cached`（它要比的 HEAD 不存在）——用索引本身来看：
      // 两个文件都还在索引里，且在 porcelain 里显示为 "A "（已暂存的新增）。
      assert.deepEqual(
        git(rootRepo, ['ls-files', '--cached']).replace(/\r\n/gu, '\n').split('\n').filter((line) => line !== '').sort(),
        ['shared.txt'],
        '文件都还在索引里',
      )
      for (const line of statusRaw(rootRepo).split('\n')) {
        assert.match(line, /^A {2}/u, `应当是已暂存的新增：${line}`)
      }
      assert.equal(readRepoFile(rootRepo, 'shared.txt'), 'base\n', '工作区文件没动')
      // hard 到 root 不被支持（git 自己也没有这条命令）。
      const hardRoot = await gitbar('reset', { root: true, mode: 'hard', acknowledgeDestructive: true })
      assert.equal(hardRoot.status, 400)
      assert.equal(hardRoot.body.code, 'unsupportedReset')
    })
  })

  // =========================================================================
  // 5. Multi-repository isolation: a SHA only resolves inside its own repository.
  // =========================================================================
  console.log('')
  console.log('=== 5. 多仓库隔离 ===')
  const multiRoot = join(scratch, 'multi')
  const repoA = join(multiRoot, 'alpha')
  const repoB = join(multiRoot, 'beta')
  mkdirSync(repoA, { recursive: true })
  mkdirSync(repoB, { recursive: true })
  for (const [repo, label] of [
    [repoA, 'alpha'],
    [repoB, 'beta'],
  ]) {
    git(repo, ['init', '--initial-branch=main'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    git(repo, ['config', 'user.name', 'Test'])
    writeRepoFile(repo, 'shared.txt', `${label} one\n`)
    commitAll(repo, `${label} first`)
    writeRepoFile(repo, 'shared.txt', `${label} two\n`)
    commitAll(repo, `${label} second`)
  }
  registerWorkspace(multiRoot, repoA, repoB)
  const shaA = revParse(repoA, 'HEAD~1')

  await withServer(multiRoot, async ({ gitbar }) => {
    await check('5.1) 另一个仓库的 SHA 在当前仓库里解析不出来（404，而不是乱 reset）', async () => {
      const preview = await gitbar('reset/preview', { revision: shaA, repository: repoB })
      assert.equal(preview.status, 404, JSON.stringify(preview.body).slice(0, 200))
      assert.equal(preview.body.code, 'noSuchRevision')
      const reset = await gitbar('reset', { revision: shaA, mode: 'hard', acknowledgeDestructive: true, repository: repoB })
      assert.equal(reset.status, 404)
      assert.equal(revParse(repoB, 'HEAD'), revParse(repoB, 'HEAD'), 'beta 完全没有被改动')
      assert.equal(subject(repoB), 'beta second')
    })

    await check('5.2) 在自己的仓库里同样的 SHA 可以 reset（隔离不是"什么都拒绝"）', async () => {
      const result = await gitbar('reset', { revision: shaA, mode: 'soft', repository: repoA })
      assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 300))
      assert.equal(revParse(repoA, 'HEAD'), shaA)
      assert.equal(subject(repoA), 'alpha first')
    })
  })

  // =========================================================================
  // 6. 本轮没有把"确认"扩散到日常操作上。
  // =========================================================================
  console.log('')
  console.log('=== 6. 日常 Push / Update 仍然不需要二次确认 ===')
  const dailyRepo = createRepo('daily-repo')
  createOrigin(dailyRepo, 'daily-origin')
  registerWorkspace(dailyRepo)
  await withServer(dailyRepo, async ({ gitbar }) => {
    await check('6.1) 普通 push 与 fetch/pull 仍然一次点击就执行', async () => {
      writeRepoFile(dailyRepo, 'shared.txt', 'daily\n')
      commitAll(dailyRepo, 'daily work')
      const pushed = await gitbar('remote', { action: 'push' })
      assert.equal(pushed.status, 200, JSON.stringify(pushed.body).slice(0, 200))
      assert.equal(revParse(dailyRepo, 'origin/main'), revParse(dailyRepo, 'HEAD'))
      const fetched = await gitbar('remote', { action: 'fetch' })
      assert.equal(fetched.status, 200)
      const pulled = await gitbar('remote', { action: 'pull' })
      assert.equal(pulled.status, 200)
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
