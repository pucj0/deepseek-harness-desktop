// Stash workflow end-to-end tests on REAL repositories:
// push (quick / message / include-untracked), list, inspect, apply, pop, drop,
// stash & checkout, stash conflicts (which git records WITHOUT any operation marker),
// and multi-repository isolation.
//
//   node scripts/test-git-stash.mjs
//
// Why a separate file: `test-git-op-conflicts.mjs` drives merge/rebase/cherry-pick/revert
// (all of which leave a marker in `.git` that says what is going on) and
// `test-git-conflict.mjs` drives the merge path. Stash is the one operation whose conflict
// leaves **no marker at all** — `git stash apply` writes neither MERGE_HEAD nor MERGE_MSG,
// only unmerged index entries and `.git/AUTO_MERGE` — so "what state are we in" has to be
// answered from git's own conflict labels. That claim, the apply/pop asymmetry, and the
// fact that a stash belongs to exactly one repository are what this file pins down.
//
// Nothing is mocked: every stash is created by real git and every claim is verified by
// asking git itself (`git stash list`, `git status --porcelain=v2`, `git show :2:…`,
// `git ls-files -u`, `git rev-parse`) rather than by trusting the plugin's answer.
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

const scratch = mkdtempSync(join(tmpdir(), 'dsh-git-stash-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })

/** Run git in a repo (throws with stderr on failure). */
function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.fileMode=false', '-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  })
}
/** Run git that is expected to fail; returns the combined output instead of throwing. */
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
/** Read a repo file as text with line endings normalised (the suite may run with autocrlf). */
function readRepoFile(repo, name) {
  return readFileSync(join(repo, name), 'utf8').replace(/\r\n/gu, '\n')
}
function normalized(value) {
  return String(value).replace(/\r\n/gu, '\n')
}
function commitAll(repo, message) {
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', message])
}
/** `git show :N:<path>` — the index stage content, i.e. git's own "ours"/"theirs" answer. */
function stage(repo, n, name) {
  return normalized(git(repo, ['show', `:${n}:${name}`]))
}
const porcelain = (repo) => normalized(git(repo, ['status', '--porcelain'])).trim()
const revParse = (repo, ref) => git(repo, ['rev-parse', ref]).trim()
/** Stash refs as git itself lists them (used as ground truth for the API's list). */
const stashRefs = (repo) =>
  git(repo, ['stash', 'list', '--format=%gd'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')

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
        ['status', 'branches', 'remotes', 'branch/sync', 'repo-context', 'stash/list'].includes(route)
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
  // 1. push: quick (no message), with a message, and with untracked files.
  // =========================================================================
  console.log('=== 1. stash push：快速 / 带消息 / 含未跟踪 ===')
  const pushRepo = createRepo('push-repo')
  registerWorkspace(pushRepo)

  await withServer(pushRepo, async ({ gitbar, review }) => {
    await check('1.1) 干净的工作区：明确回 nothingToStash，而不是"成功但什么都没发生"', async () => {
      const result = await gitbar('stash/push', {})
      assert.equal(result.status, 400, JSON.stringify(result.body).slice(0, 200))
      assert.equal(result.body.code, 'nothingToStash')
      assert.deepEqual(stashRefs(pushRepo), [])
    })

    await check('1.2) 只有未跟踪文件、且没勾选包含未跟踪：同样回 nothingToStash', async () => {
      writeRepoFile(pushRepo, 'untracked-only.txt', 'untracked\n')
      const result = await gitbar('stash/push', {})
      assert.equal(result.body.code, 'nothingToStash', JSON.stringify(result.body).slice(0, 200))
      assert.deepEqual(stashRefs(pushRepo), [])
      assert.equal(porcelain(pushRepo), '?? untracked-only.txt')
    })

    await check('1.3) 快速储藏：不带消息也能存进去，git 自己写 WIP 主题，工作区与索引都干净', async () => {
      writeRepoFile(pushRepo, 'shared.txt', 'changed\n')
      const result = await gitbar('stash/push', {})
      assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 200))
      assert.equal(result.body.stash.stashed, true)
      assert.equal(result.body.stash.ref, 'stash@{0}')
      // 消息为空 = 用户没写；原分支由 git 的 reflog 主题给出。
      assert.equal(result.body.stash.message, '')
      assert.equal(result.body.stash.branch, 'main')
      assert.equal(result.body.stash.hasUntracked, false)
      assert.equal(porcelain(pushRepo), '?? untracked-only.txt')
      // 改动确实进了储藏：那条内容与工作区无关了。
      assert.equal(readRepoFile(pushRepo, 'shared.txt'), 'base\n')
    })

    await check('1.4) 带消息的储藏：消息与"原分支"都能从稳定字段里读出来', async () => {
      writeRepoFile(pushRepo, 'shared.txt', 'wip login\n')
      const result = await gitbar('stash/push', { message: 'WIP: feature login' })
      assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 200))
      assert.equal(result.body.stash.message, 'WIP: feature login')
      assert.equal(result.body.stash.branch, 'main')
      assert.equal(result.body.stash.ref, 'stash@{0}')
      // 消息里带冒号也不能把"原分支"的解析带偏（分支名不可能含冒号，按第一个 `: ` 切）。
      writeRepoFile(pushRepo, 'shared.txt', 'wip two\n')
      const second = await gitbar('stash/push', { message: 'fix: a: b' })
      assert.equal(second.body.stash.message, 'fix: a: b')
      assert.equal(second.body.stash.branch, 'main')
    })

    await check('1.5) 包含未跟踪文件：未跟踪文件离开工作区，hasUntracked 为真', async () => {
      writeRepoFile(pushRepo, 'shared.txt', 'with untracked\n')
      const result = await gitbar('stash/push', { message: 'with untracked', includeUntracked: true })
      assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 200))
      assert.equal(result.body.stash.hasUntracked, true)
      assert.equal(porcelain(pushRepo), '')
      assert.equal(gitTry(pushRepo, ['rev-parse', '--verify', 'stash@{0}^3']).ok, true, '未跟踪文件应当在第三个父提交里')
    })

    await check('1.6) 列表：ref / 消息 / 原分支 / 时间 / 未跟踪标记，且顺序与 git 一致', async () => {
      const listed = await gitbar('stash/list', {})
      assert.equal(listed.status, 200, JSON.stringify(listed.body).slice(0, 200))
      assert.deepEqual(
        listed.body.stashes.map((entry) => entry.ref),
        stashRefs(pushRepo),
      )
      assert.equal(listed.body.stashCount, listed.body.stashes.length)
      const [newest] = listed.body.stashes
      assert.equal(newest.message, 'with untracked')
      assert.equal(newest.branch, 'main')
      assert.equal(newest.hasUntracked, true)
      // 时间必须是**严格 ISO-8601**（带时区），客户端才不会因为解释时间而猜时区。
      assert.match(newest.date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/u)
      assert.match(newest.sha, /^[0-9a-f]{40}$/u)
      // 默认文本是 `stash@{0}: On main: msg`——列表**不该**把那段前缀塞进消息里。
      assert.doesNotMatch(newest.message, /^On main:/u)
    })

    await check('1.7) 非法的 stash 消息形状被拒绝（NUL/控制字符不该进 git）', async () => {
      const result = await gitbar('stash/push', { message: 42 })
      assert.equal(result.status, 400)
      assert.equal(result.body.code, 'invalidStashMessage')
    })
  })

  // =========================================================================
  // 2. inspect: the changed files of a stash, and the diff of one file in it.
  // =========================================================================
  console.log('')
  console.log('=== 2. 查看储藏：改动清单与逐文件差异 ===')
  const inspectRepo = createRepo('inspect-repo')
  registerWorkspace(inspectRepo)

  await withServer(inspectRepo, async ({ gitbar, review }) => {
    // 一次储藏里同时有：修改、新增（已暂存）、未跟踪（-u 才进来）。
    writeRepoFile(inspectRepo, 'shared.txt', 'modified in stash\n')
    writeRepoFile(inspectRepo, 'added.txt', 'added in stash\n')
    git(inspectRepo, ['add', 'added.txt'])
    writeRepoFile(inspectRepo, 'untracked.txt', 'untracked in stash\n')
    const pushed = await gitbar('stash/push', { message: 'inspect me', includeUntracked: true })
    assert.equal(pushed.body.stash.stashed, true, JSON.stringify(pushed.body).slice(0, 200))

    await check('2.1) /stash/show 列出改动文件（含未跟踪），状态字母来自 git', async () => {
      const shown = await review('stash/show', { ref: 'stash@{0}' })
      assert.equal(shown.status, 200, JSON.stringify(shown.body).slice(0, 300))
      const byPath = Object.fromEntries(shown.body.files.map((file) => [file.path, file]))
      assert.deepEqual(Object.keys(byPath).sort(), ['added.txt', 'shared.txt', 'untracked.txt'])
      assert.equal(byPath['shared.txt'].status, 'M')
      assert.equal(byPath['added.txt'].status, 'A')
      assert.equal(byPath['untracked.txt'].status, 'A')
      assert.equal(byPath['untracked.txt'].untracked, true)
      assert.equal(byPath['shared.txt'].untracked, undefined)
      assert.equal(shown.body.hasUntracked, true)
    })

    await check('2.2) 已跟踪文件的差异：基线是储藏的第一个父提交（不是工作区）', async () => {
      const diff = await review('stash-file', { ref: 'stash@{0}', path: 'shared.txt' })
      assert.equal(diff.status, 200, JSON.stringify(diff.body).slice(0, 300))
      assert.match(normalized(diff.body.diff), /^\+modified in stash$/mu)
      assert.match(normalized(diff.body.diff), /^-base$/mu)
      assert.equal(diff.body.binary, false)
    })

    await check('2.3) 未跟踪文件的差异：整份文件作为新增（不需要伪造空树）', async () => {
      const diff = await review('stash-file', { ref: 'stash@{0}', path: 'untracked.txt' })
      assert.equal(diff.status, 200, JSON.stringify(diff.body).slice(0, 300))
      assert.match(normalized(diff.body.diff), /new file mode/u)
      assert.match(normalized(diff.body.diff), /^\+untracked in stash$/mu)
    })

    await check('2.4) 储藏里没有这个文件时明确回 noSuchPath（而不是"差异为空"）', async () => {
      const missing = await review('stash-file', { ref: 'stash@{0}', path: 'other.txt' })
      assert.equal(missing.status, 404)
      assert.equal(missing.body.code, 'noSuchPath')
    })

    await check('2.5) 不存在的储藏 / 任意修订都回 noSuchStash（stash 引用是白名单）', async () => {
      for (const ref of ['stash@{7}', 'HEAD', 'main', 'stash@{0}^1']) {
        const result = await review('stash/show', { ref })
        assert.equal(result.status, 404, `${ref} → ${JSON.stringify(result.body).slice(0, 120)}`)
        assert.equal(result.body.code, 'noSuchStash')
      }
    })
  })

  // =========================================================================
  // 3. apply vs pop: 保留 vs 删除，都由 git 的真实状态判定。
  // =========================================================================
  console.log('')
  console.log('=== 3. 应用 / 弹出 ===')
  const applyRepo = createRepo('apply-repo')
  registerWorkspace(applyRepo)

  await withServer(applyRepo, async ({ gitbar }) => {
    writeRepoFile(applyRepo, 'shared.txt', 'apply me\n')
    writeRepoFile(applyRepo, 'new-file.txt', 'new\n')
    await gitbar('stash/push', { message: 'apply me', includeUntracked: true })
    assert.equal(porcelain(applyRepo), '')

    await check('3.1) apply 之后改动回到工作区，而储藏**保留**', async () => {
      const applied = await gitbar('stash/apply', { ref: 'stash@{0}' })
      assert.equal(applied.status, 200, JSON.stringify(applied.body).slice(0, 300))
      assert.equal(applied.body.applied, true)
      assert.equal(applied.body.conflicted, false)
      assert.equal(applied.body.stash.kept, true)
      assert.equal(porcelain(applyRepo).split('\n').length, 2)
      assert.deepEqual(stashRefs(applyRepo), ['stash@{0}'])
      // 未跟踪的那个文件也回来了。
      assert.equal(readRepoFile(applyRepo, 'new-file.txt'), 'new\n')
    })

    await check('3.2) pop 之后改动回到工作区，储藏**被删除**（由重读列表确认）', async () => {
      // 先把工作区清干净，否则 pop 会与当前改动冲突。
      git(applyRepo, ['checkout', '--', '.'])
      git(applyRepo, ['clean', '-fd'])
      const popped = await gitbar('stash/pop', { ref: 'stash@{0}' })
      assert.equal(popped.status, 200, JSON.stringify(popped.body).slice(0, 300))
      assert.equal(popped.body.applied, true)
      assert.equal(popped.body.stash.kept, false)
      assert.equal(popped.body.stash.popped, true)
      assert.deepEqual(stashRefs(applyRepo), [])
      assert.equal(readRepoFile(applyRepo, 'shared.txt'), 'apply me\n')
    })

    await check('3.3) drop 删除储藏但不碰工作区；不存在的引用回 noSuchStash', async () => {
      git(applyRepo, ['checkout', '--', '.'])
      git(applyRepo, ['clean', '-fd'])
      writeRepoFile(applyRepo, 'shared.txt', 'drop me\n')
      await gitbar('stash/push', { message: 'drop me' })
      const dropped = await gitbar('stash/drop', { ref: 'stash@{0}' })
      assert.equal(dropped.status, 200, JSON.stringify(dropped.body).slice(0, 200))
      assert.equal(dropped.body.dropped, 'stash@{0}')
      assert.deepEqual(stashRefs(applyRepo), [])
      assert.equal(readRepoFile(applyRepo, 'shared.txt'), 'base\n', 'drop 不该动工作区')
      const again = await gitbar('stash/drop', { ref: 'stash@{0}' })
      assert.equal(again.status, 404)
      assert.equal(again.body.code, 'noSuchStash')
    })

    await check('3.4) 冲突未解决时不允许 apply / push（提前判定，不把 git 的 needs merge 端给用户）', async () => {
      // 造一个 stash 冲突：先存改动，再让当前分支改成别的内容，然后 apply。
      writeRepoFile(applyRepo, 'shared.txt', 'stashed side\n')
      await gitbar('stash/push', { message: 'conflicting' })
      writeRepoFile(applyRepo, 'shared.txt', 'branch side\n')
      commitAll(applyRepo, 'branch side')
      const applied = await gitbar('stash/apply', { ref: 'stash@{0}' })
      assert.equal(applied.status, 200, JSON.stringify(applied.body).slice(0, 300))
      assert.equal(applied.body.conflicted, true)
      // 现在索引里有未合并条目：再 apply / push 都必须被明确拒绝。
      // （清单一律先校验引用是否存在，因此这里仍然用那个**存在**的引用。）
      const again = await gitbar('stash/apply', { ref: 'stash@{0}' })
      assert.equal(again.status, 409, JSON.stringify(again.body).slice(0, 200))
      assert.equal(again.body.code, 'unmerged')
      const pushed = await gitbar('stash/push', { message: 'x' })
      assert.equal(pushed.status, 409)
      assert.equal(pushed.body.code, 'unmerged')
    })
  })

  // =========================================================================
  // 4. stash conflict: git writes NO operation marker — the API must still say
  //    what is going on, and resolution must work in the existing resolver.
  // =========================================================================
  console.log('')
  console.log('=== 4. 储藏冲突：无操作标记时的状态模型与解决 ===')
  const conflictRepo = createRepo('stash-conflict-repo')
  registerWorkspace(conflictRepo)

  await withServer(conflictRepo, async ({ gitbar, review }) => {
    writeRepoFile(conflictRepo, 'shared.txt', 'stashed content\n')
    await gitbar('stash/push', { message: 'conflicting change' })
    writeRepoFile(conflictRepo, 'shared.txt', 'current content\n')
    commitAll(conflictRepo, 'current content')

    const applied = await gitbar('stash/apply', { ref: 'stash@{0}' })

    await check('4.1) apply 冲突：git 里没有任何操作标记，但 API 把它如实报成 stash 冲突', async () => {
      assert.equal(applied.status, 200, JSON.stringify(applied.body).slice(0, 300))
      assert.equal(applied.body.conflicted, true)
      assert.equal(applied.body.conflicts.length, 1)
      assert.equal(applied.body.conflicts[0].path, 'shared.txt')
      // 这一条是**事实核查**：git 确实没写 MERGE_HEAD（否则下面的判定就是多余的）。
      assert.equal(gitTry(conflictRepo, ['rev-parse', '--verify', 'MERGE_HEAD']).ok, false)
      assert.equal(gitTry(conflictRepo, ['rev-parse', '--verify', 'CHERRY_PICK_HEAD']).ok, false)
      const status = await gitbar('status', {})
      assert.equal(status.body.operation?.type, 'stash', JSON.stringify(status.body.operation))
      assert.equal(status.body.operation?.markerless, true)
      assert.equal(status.body.conflictCount, 1)
      // 不伪造 merge：真实的 git 命令里没有"继续合并"这回事。
      assert.equal(status.body.merging, false)
      assert.equal(status.body.rebasing, false)
    })

    await check('4.2) 两侧语义：stage 2 = 当前分支（Updated upstream），stage 3 = 储藏', async () => {
      assert.equal(stage(conflictRepo, 2, 'shared.txt'), 'current content\n')
      assert.equal(stage(conflictRepo, 3, 'shared.txt'), 'stashed content\n')
      assert.match(readRepoFile(conflictRepo, 'shared.txt'), /^<{7} Updated upstream$/mu)
      assert.match(readRepoFile(conflictRepo, 'shared.txt'), /^>{7} Stashed changes$/mu)
    })

    await check('4.3) 冲突面板可用：块、两侧文本、真实标记名，且 operationType 是 stash', async () => {
      const conflict = await review('conflict', { path: 'shared.txt' })
      assert.equal(conflict.status, 200, JSON.stringify(conflict.body).slice(0, 300))
      assert.equal(conflict.body.blockCount, 1)
      assert.equal(conflict.body.operationType, 'stash')
      assert.equal(conflict.body.ours, 'current content\n')
      assert.equal(conflict.body.theirs, 'stashed content\n')
      const [block] = conflict.body.blocks
      assert.equal(block.oursLabel, 'Updated upstream')
      assert.equal(block.theirsLabel, 'Stashed changes')
    })

    await check('4.4) review 的 /workspace 也认得出 stash（不是"不在任何操作中"）', async () => {
      const workspaceView = await review('workspace', {})
      assert.equal(workspaceView.status, 200, JSON.stringify(workspaceView.body).slice(0, 200))
      assert.equal(workspaceView.body.operationType, 'stash')
      assert.equal(workspaceView.body.conflictCount, 1)
    })

    await check('4.5) 逐块取"对方"并标记为已解决：冲突清空，而储藏仍然保留', async () => {
      const resolved = await review('conflict-resolve', { path: 'shared.txt', resolutions: { 0: 'theirs' }, markResolved: true })
      assert.equal(resolved.status, 200, JSON.stringify(resolved.body).slice(0, 300))
      assert.equal(resolved.body.hasMarkers, false)
      assert.equal(readRepoFile(conflictRepo, 'shared.txt'), 'stashed content\n')
      // 索引里不再有未合并条目（"标记为已解决"就是给它 `git add`）。
      // 注意状态**不是**干净的：解决后的内容与 HEAD 不同，仍然是一份待提交的改动。
      assert.equal(git(conflictRepo, ['ls-files', '-u']).trim(), '')
      assert.equal(porcelain(conflictRepo), 'M  shared.txt')
      const status = await gitbar('status', {})
      assert.equal(status.body.conflictCount, 0)
      // 冲突解决完之后没有任何"操作"残留：stash apply 不是可"继续"的操作。
      assert.equal(status.body.operation, null, JSON.stringify(status.body.operation))
      // 储藏没有被自动删掉（apply 本来就不删）。
      assert.deepEqual(stashRefs(conflictRepo), ['stash@{0}'])
    })

    await check('4.6) pop 冲突：git 保留储藏，API 照实回报 kept（不谎称已弹出）', async () => {
      // 制造第二次冲突：储藏内容 vs 当前内容。
      writeRepoFile(conflictRepo, 'shared.txt', 'pop stashed\n')
      await gitbar('stash/push', { message: 'pop conflict' })
      writeRepoFile(conflictRepo, 'shared.txt', 'pop current\n')
      commitAll(conflictRepo, 'pop current')
      const popped = await gitbar('stash/pop', { ref: 'stash@{0}' })
      assert.equal(popped.status, 200, JSON.stringify(popped.body).slice(0, 300))
      assert.equal(popped.body.conflicted, true)
      assert.equal(popped.body.stash.kept, true)
      assert.equal(popped.body.stash.popped, false)
      // 冲突时 `pop` **不会**删掉储藏：被弹的那一条（stash@{0}）仍在列表里。
      assert.ok(stashRefs(conflictRepo).includes('stash@{0}'), `stash@{0} 应当仍在：${stashRefs(conflictRepo).join(', ')}`)
      // 收拾干净（`checkout -- .` 在未合并状态下会被 git 拒绝，必须用 reset）。
      // 这个仓库后面不再使用，保留冲突状态也不影响结论。
      git(conflictRepo, ['reset', '--hard'])
    })
  })

  // =========================================================================
  // 5. stash & checkout: the whole point — switching branches without a terminal.
  // =========================================================================
  console.log('')
  console.log('=== 5. 储藏并切换 ===')
  const switchRepo = createRepo('stash-switch-repo')
  registerWorkspace(switchRepo)

  await withServer(switchRepo, async ({ gitbar }) => {
    git(switchRepo, ['switch', '-c', 'develop'])
    writeRepoFile(switchRepo, 'shared.txt', 'develop content\n')
    commitAll(switchRepo, 'develop content')
    git(switchRepo, ['switch', 'main'])

    await check('5.1) 有未提交改动时 checkout 被 git 拒绝（界面据此给出「储藏并切换」）', async () => {
      writeRepoFile(switchRepo, 'shared.txt', 'local edit\n')
      const blocked = await gitbar('checkout', { branch: 'develop' })
      assert.equal(blocked.status, 409, JSON.stringify(blocked.body).slice(0, 200))
      assert.equal(blocked.body.code, 'localChanges')
      assert.equal(git(switchRepo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'main')
      assert.deepEqual(stashRefs(switchRepo), [])
    })

    await check('5.2) 储藏并切换：改动进储藏、切到目标分支、工作区干净', async () => {
      const switched = await gitbar('checkout', {
        branch: 'develop',
        stash: true,
        message: '切换分支前自动储藏',
        includeUntracked: true,
      })
      assert.equal(switched.status, 200, JSON.stringify(switched.body).slice(0, 300))
      assert.equal(switched.body.stash.stashed, true)
      assert.equal(switched.body.stash.ref, 'stash@{0}')
      assert.equal(switched.body.stash.message, '切换分支前自动储藏')
      assert.equal(switched.body.stash.branch, 'main', '原分支是切换**之前**那个')
      assert.equal(git(switchRepo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'develop')
      assert.equal(porcelain(switchRepo), '')
      assert.equal(readRepoFile(switchRepo, 'shared.txt'), 'develop content\n')
    })

    await check('5.3) 切换失败时储藏**已经建好**，错误响应必须把这个事实带回来', async () => {
      // 回到 main 并造出改动，然后切到一个不存在的分支：储藏会发生，checkout 会失败。
      git(switchRepo, ['switch', 'main'])
      writeRepoFile(switchRepo, 'shared.txt', 'another edit\n')
      const failed = await gitbar('checkout', { branch: 'no-such-branch', stash: true, message: '失败前也要说清楚' })
      assert.equal(failed.status, 404, JSON.stringify(failed.body).slice(0, 300))
      assert.equal(failed.body.code, 'noSuchRef')
      // **关键**：用户必须能从响应里知道改动进了 stash，否则会以为改动丢了。
      assert.equal(failed.body.stash?.stashed, true, JSON.stringify(failed.body).slice(0, 300))
      assert.equal(failed.body.stash?.ref, 'stash@{0}')
      assert.equal(failed.body.stash?.message, '失败前也要说清楚')
      // 5.2 那次储藏还在（我们没删它），因此这里应当有两条，新的一条在最前面。
      assert.equal(stashRefs(switchRepo).length, 2, stashRefs(switchRepo).join(', '))
      assert.equal(stashRefs(switchRepo)[0], 'stash@{0}')
      assert.equal(porcelain(switchRepo), '', '储藏之后工作区是干净的')
      assert.equal(readRepoFile(switchRepo, 'shared.txt'), 'base\n')
    })

    await check('5.4) 干净的工作区里直接切换（不需要储藏）', async () => {
      const switched = await gitbar('checkout', { branch: 'develop' })
      assert.equal(switched.status, 200, JSON.stringify(switched.body).slice(0, 200))
      assert.equal(switched.body.stash.stashed, false)
      assert.equal(git(switchRepo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'develop')
    })
  })

  // =========================================================================
  // 6. Multi-repository isolation: a stash belongs to exactly one repository.
  // =========================================================================
  console.log('')
  console.log('=== 6. 多仓库隔离 ===')
  const multiRoot = join(scratch, 'multi')
  const frontend = join(multiRoot, 'frontend')
  const backend = join(multiRoot, 'backend')
  mkdirSync(frontend, { recursive: true })
  mkdirSync(backend, { recursive: true })
  for (const [repo, label] of [
    [frontend, 'frontend'],
    [backend, 'backend'],
  ]) {
    git(repo, ['init', '--initial-branch=main'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    git(repo, ['config', 'user.name', 'Test'])
    writeRepoFile(repo, 'shared.txt', `${label} base\n`)
    commitAll(repo, 'initial')
  }
  registerWorkspace(multiRoot, frontend, backend)

  await withServer(multiRoot, async ({ gitbar, review }) => {
    await check('6.1) frontend 的储藏不出现在 backend 的列表里（两端都不出现）', async () => {
      writeRepoFile(frontend, 'shared.txt', 'frontend wip\n')
      const pushed = await gitbar('stash/push', { message: 'frontend stash', repository: frontend })
      assert.equal(pushed.status, 200, JSON.stringify(pushed.body).slice(0, 300))
      assert.equal(pushed.body.stash.branch, 'main')
      assert.deepEqual(pushed.body.stash.ref, 'stash@{0}')

      const frontendList = await gitbar('stash/list', { repository: frontend })
      const backendList = await gitbar('stash/list', { repository: backend })
      assert.equal(frontendList.body.stashCount, 1)
      assert.equal(backendList.body.stashCount, 0)
      assert.deepEqual(backendList.body.stashes, [])
      assert.equal(frontendList.body.stashes[0].message, 'frontend stash')
      // git 自己也这么说（不只是插件的回答）。
      assert.deepEqual(stashRefs(frontend), ['stash@{0}'])
      assert.deepEqual(stashRefs(backend), [])
    })

    await check('6.2) 在 backend 上应用 frontend 的引用会被拒绝（引用是**按仓库**校验的）', async () => {
      const result = await gitbar('stash/apply', { ref: 'stash@{0}', repository: backend })
      assert.equal(result.status, 404, JSON.stringify(result.body).slice(0, 200))
      assert.equal(result.body.code, 'noSuchStash')
      // frontend 的储藏毫发无损。
      assert.deepEqual(stashRefs(frontend), ['stash@{0}'])
    })

    await check('6.3) 查看储藏（review 侧）同样按仓库解析', async () => {
      const ok = await review('stash/show', { ref: 'stash@{0}', repository: frontend })
      assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 200))
      assert.equal(ok.body.files[0].path, 'shared.txt')
      const wrong = await review('stash/show', { ref: 'stash@{0}', repository: backend })
      assert.equal(wrong.status, 404)
      assert.equal(wrong.body.code, 'noSuchStash')
    })

    await check('6.4) stashCount 快信号按仓库计算，且与真实储藏数一致', async () => {
      const frontendView = await review('workspace', { repository: frontend })
      const backendView = await review('workspace', { repository: backend })
      assert.equal(frontendView.body.stashCount, 1)
      assert.equal(backendView.body.stashCount, 0)
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
