// Tags, revision comparison and file-history end-to-end tests on REAL repositories.
//
//   node scripts/test-git-tags-compare.mjs
//
// Why a separate file: `test-git-amend-reset.mjs` covers amending the tip and moving the branch,
// `test-git-stash.mjs` covers stashes and `test-git-workflow.mjs` covers publish/update/push.
// This file pins down the three read-mostly features that answer "what is in this repository":
//
//   * **tags** — lightweight vs annotated (what git actually stores for each), checkout into a
//     detached HEAD, branching off a tag, deleting a local tag, and pushing exactly ONE tag
//     (never `--tags`);
//   * **comparison** — two revisions' commit counts and changed files, from a commit to HEAD,
//     from A to B, and from a branch to HEAD; renamed files must show up as renames;
//   * **file history** — `git log --follow` across a rename, which is the only way "where did
//     this file come from" survives a rename.
//
// Nothing is mocked: every claim is verified by asking git itself.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, renameSync, writeFileSync } from 'node:fs'
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

const scratch = mkdtempSync(join(tmpdir(), 'dsh-git-tags-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.fileMode=false', '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
}
/**
 * 带额外环境变量的 git。
 *
 * 用来**明确控制时间**：附注标签的 `creatordate` 是打标签的时间，轻量标签的时间是它指向
 * 的**提交**的时间。不控制它的话，同一秒里创建的两个标签在 `--sort=-creatordate` 下的
 * 相对顺序是任意的——那种断言会随机变红（第一次跑就踩到了）。
 */
function gitEnv(cwd, args, env) {
  return execFileSync('git', ['-c', 'core.fileMode=false', '-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...env },
  })
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
const headBranch = (repo) => git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
/** 标签的类型按 git 自己的判定（不是我们解析出来的）。 */
const tagType = (repo, name) => git(repo, ['cat-file', '-t', `refs/tags/${name}`]).trim()

function createRepo(name) {
  const repo = join(scratch, name)
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '--initial-branch=main'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  git(repo, ['config', 'tag.gpgsign', 'false'])
  writeRepoFile(repo, 'shared.txt', 'base\n')
  commitAll(repo, 'initial')
  return repo
}

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
        ['status', 'branches', 'remotes', 'branch/sync', 'repo-context', 'stash/list', 'head-commit', 'reset/preview', 'tags'].includes(route)
      const query = new URLSearchParams({ cwd: workspace })
      if (typeof payload?.repository === 'string') query.set('repository', payload.repository)
      if (readOnly) {
        for (const [key, value] of Object.entries(payload ?? {})) {
          if (key === 'repository') continue
          query.set(key, String(value))
        }
      }
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
  // 1. tags: annotated vs lightweight, list fields, HEAD marker.
  // =========================================================================
  console.log('=== 1. 标签：轻量 / 附注 / 列表字段 ===')
  const tagRepo = createRepo('tag-repo')
  // 三个标签、时间明确错开：轻量标签 v1.0.0 指向 2019 年的提交（creatordate = 提交时间），
  // 两个附注标签的 tagger 时间分别是 2021 / 2022。因此"新的在前"是可以断言的。
  const old = { GIT_AUTHOR_DATE: '2019-01-01T00:00:00+00:00', GIT_COMMITTER_DATE: '2019-01-01T00:00:00+00:00' }
  writeRepoFile(tagRepo, 'shared.txt', 'v1 content\n')
  gitEnv(tagRepo, ['add', '-A'], old)
  gitEnv(tagRepo, ['commit', '-m', 'release 1.0 work'], old)
  const firstSha = revParse(tagRepo, 'HEAD')
  git(tagRepo, ['tag', 'v1.0.0'])
  const newer = { GIT_AUTHOR_DATE: '2020-01-01T00:00:00+00:00', GIT_COMMITTER_DATE: '2020-01-01T00:00:00+00:00' }
  writeRepoFile(tagRepo, 'shared.txt', 'v2 content\n')
  gitEnv(tagRepo, ['add', '-A'], newer)
  gitEnv(tagRepo, ['commit', '-m', 'release 2.0 work'], newer)
  const secondSha = revParse(tagRepo, 'HEAD')
  gitEnv(tagRepo, ['tag', '-a', 'v2.0.0', '-m', 'Release 2.0.0\n\nwith notes'], { GIT_COMMITTER_DATE: '2022-01-01T00:00:00+00:00' })
  gitEnv(tagRepo, ['tag', '-a', 'v1.5.0', '-m', 'Release 1.5.0 (backport)', firstSha], { GIT_COMMITTER_DATE: '2021-01-01T00:00:00+00:00' })
  registerWorkspace(tagRepo)

  await withServer(tagRepo, async ({ gitbar }) => {
    await check('1.1) 轻量与附注标签都能列出来，类型来自 git 自己的对象类型', async () => {
      const listed = await gitbar('tags', {})
      assert.equal(listed.status, 200, JSON.stringify(listed.body).slice(0, 300))
      const byName = Object.fromEntries(listed.body.tags.map((entry) => [entry.name, entry]))
      assert.deepEqual(Object.keys(byName).sort(), ['v1.0.0', 'v1.5.0', 'v2.0.0'])
      assert.equal(byName['v1.0.0'].annotated, false)
      assert.equal(byName['v2.0.0'].annotated, true)
      assert.equal(byName['v1.5.0'].annotated, true)
      assert.equal(listed.body.annotatedCount, 2)
      // 这是**事实核查**：git 对两者存的对象类型确实不同。
      assert.equal(tagType(tagRepo, 'v1.0.0'), 'commit')
      assert.equal(tagType(tagRepo, 'v2.0.0'), 'tag')
    })

    await check('1.2) 指向的提交、时间与说明都取得到（附注标签解引用到提交）', async () => {
      const listed = await gitbar('tags', {})
      const byName = Object.fromEntries(listed.body.tags.map((entry) => [entry.name, entry]))
      // 两个标签指向不同的提交：各自解引用正确（附注标签的 `objectname` 是 tag 对象，真正的
      // 提交在 `*objectname` 里；v1.5.0 特意打在旧提交上）。
      assert.equal(byName['v1.0.0'].sha, firstSha)
      assert.equal(byName['v1.5.0'].sha, firstSha)
      assert.equal(byName['v2.0.0'].sha, secondSha)
      assert.equal(byName['v1.0.0'].subject, 'release 1.0 work', '轻量标签的说明是提交标题')
      assert.match(byName['v2.0.0'].subject, /Release 2\.0\.0/u, '附注标签的说明是标签信息')
      assert.match(byName['v2.0.0'].date, /^\d{4}-\d{2}-\d{2}T/u, '时间是严格 ISO-8601')
      assert.match(byName['v2.0.0'].date, /^2022-01-01/u, '附注标签用的是 tagger 时间')
      // 新的在前：2022（v2.0.0）、2021（v1.5.0）、2019 的提交（v1.0.0）。
      assert.deepEqual(
        listed.body.tags.map((entry) => entry.name),
        ['v2.0.0', 'v1.5.0', 'v1.0.0'],
      )
    })

    await check('1.3) 指向 HEAD 的标签被标出来（列表里能看出"当前版本"）', async () => {
      const listed = await gitbar('tags', {})
      const byName = Object.fromEntries(listed.body.tags.map((entry) => [entry.name, entry]))
      assert.equal(byName['v2.0.0'].pointsAtHead, true)
      assert.equal(byName['v1.0.0'].pointsAtHead, false)
      assert.equal(byName['v1.5.0'].pointsAtHead, false)
    })
  })

  // =========================================================================
  // 2. create tag: lightweight, annotated, at a commit; and the validation.
  // =========================================================================
  console.log('')
  console.log('=== 2. 创建标签 ===')
  await withServer(tagRepo, async ({ gitbar }) => {
    await check('2.1) 没有消息 = 轻量标签；有消息 = 附注标签', async () => {
      const light = await gitbar('tag/create', { name: 'v3.0.0-lw' })
      assert.equal(light.status, 200, JSON.stringify(light.body).slice(0, 300))
      assert.equal(tagType(tagRepo, 'v3.0.0-lw'), 'commit')
      assert.equal(light.body.tag.annotated, false)
      const annotated = await gitbar('tag/create', { name: 'v3.0.0', message: 'Release 3.0.0' })
      assert.equal(annotated.status, 200, JSON.stringify(annotated.body).slice(0, 300))
      assert.equal(tagType(tagRepo, 'v3.0.0'), 'tag')
      assert.equal(annotated.body.tag.annotated, true)
      // 附注标签的信息真的写进去了。
      assert.match(git(tagRepo, ['tag', '-n99', '-l', 'v3.0.0']), /Release 3\.0\.0/u)
      git(tagRepo, ['tag', '-d', 'v3.0.0-lw'])
      git(tagRepo, ['tag', '-d', 'v3.0.0'])
    })

    await check('2.2) 可以在指定提交上打标签（提交图的「在此创建标签」）', async () => {
      const created = await gitbar('tag/create', { name: 'v1.0.0-late', revision: firstSha, message: 'Late tag for 1.0.0' })
      assert.equal(created.status, 200, JSON.stringify(created.body).slice(0, 300))
      assert.equal(revParse(tagRepo, 'refs/tags/v1.0.0-late^{commit}'), firstSha)
      assert.equal(created.body.tag.sha, firstSha)
      git(tagRepo, ['tag', '-d', 'v1.0.0-late'])
    })

    await check('2.3) 重名 / 非法名 / 不存在的提交都被挡在前面', async () => {
      const dup = await gitbar('tag/create', { name: 'v1.0.0' })
      assert.equal(dup.status, 409, JSON.stringify(dup.body).slice(0, 200))
      assert.equal(dup.body.code, 'tagExists')
      for (const bad of ['-bad', 'a..b', 'x.lock', 'has space', 'refs/tags/x']) {
        const result = await gitbar('tag/create', { name: bad })
        assert.equal(result.status, 400, `${bad} → ${JSON.stringify(result.body).slice(0, 120)}`)
        assert.equal(result.body.code, 'invalidTagName')
      }
      const missing = await gitbar('tag/create', { name: 'v9.9.9', revision: 'f'.repeat(40) })
      assert.equal(missing.status, 404)
      assert.equal(missing.body.code, 'noSuchRevision')
      // 一个标签都没多出来（非法请求不该留下半成品）。
      assert.deepEqual(
        git(tagRepo, ['tag', '-l']).split('\n').map((line) => line.trim()).filter((line) => line !== '').sort(),
        ['v1.0.0', 'v1.5.0', 'v2.0.0'],
      )
    })
  })

  // =========================================================================
  // 3. checkout a tag → detached HEAD; create a branch from the tag; delete tag.
  // =========================================================================
  console.log('')
  console.log('=== 3. 签出标签 / 从标签建分支 / 删除标签 ===')
  await withServer(tagRepo, async ({ gitbar }) => {
    await check('3.1) 签出标签进入游离 HEAD，并且明确回报 detached', async () => {
      const checked = await gitbar('checkout', { branch: 'v1.0.0' })
      assert.equal(checked.status, 200, JSON.stringify(checked.body).slice(0, 300))
      assert.equal(checked.body.detached, true)
      assert.equal(headBranch(tagRepo), 'HEAD', 'git 自己说 HEAD 不在分支上')
      assert.equal(revParse(tagRepo, 'HEAD'), firstSha)
      assert.equal(readRepoFile(tagRepo, 'shared.txt'), 'v1 content\n')
      // 状态接口也要如实反映游离 HEAD（界面据此显示提示，而不是显示一个分支名）。
      const status = await gitbar('status', {})
      assert.equal(status.body.detached, true)
      assert.equal(status.body.branch, '')
    })

    await check('3.2) 从游离 HEAD 建分支：切回分支上，且指向同一个提交', async () => {
      const created = await gitbar('branch/create', { name: 'hotfix/1.0', from: 'v1.0.0', checkout: true })
      assert.equal(created.status, 200, JSON.stringify(created.body).slice(0, 300))
      assert.equal(headBranch(tagRepo), 'hotfix/1.0')
      assert.equal(revParse(tagRepo, 'HEAD'), firstSha)
      git(tagRepo, ['checkout', 'main'])
      git(tagRepo, ['branch', '-D', 'hotfix/1.0'])
    })

    await check('3.3) 删除本地标签需要先确认（这里是后端语义：删掉之后再删回 404）', async () => {
      const deleted = await gitbar('tag/delete', { name: 'v2.0.0' })
      assert.equal(deleted.status, 200, JSON.stringify(deleted.body).slice(0, 300))
      assert.equal(deleted.body.deleted, 'v2.0.0')
      assert.equal(gitTry(tagRepo, ['rev-parse', '--verify', 'refs/tags/v2.0.0']).ok, false)
      const again = await gitbar('tag/delete', { name: 'v2.0.0' })
      assert.equal(again.status, 404)
      assert.equal(again.body.code, 'noSuchTag')
      // 重新建回来供后面的推送用例使用。
      git(tagRepo, ['tag', '-a', 'v2.0.0', '-m', 'Release 2.0.0'])
    })
  })

  // =========================================================================
  // 4. push exactly one tag (never --tags).
  // =========================================================================
  console.log('')
  console.log('=== 4. 推送单个标签（绝不 --tags）===')
  const pushRepo = createRepo('tag-push-repo')
  const pushOrigin = createOrigin(pushRepo, 'tag-origin')
  git(pushRepo, ['tag', 'v0.1.0'])
  git(pushRepo, ['tag', '-a', 'v0.2.0', '-m', 'Release 0.2.0'])
  git(pushRepo, ['tag', 'do-not-push'])
  registerWorkspace(pushRepo)
  const remoteTags = () =>
    git(pushOrigin, ['tag', '-l']).split('\n').map((line) => line.trim()).filter((line) => line !== '').sort()

  await withServer(pushRepo, async ({ gitbar }) => {
    await check('4.1) 只推指定的那一个标签，其它标签留在本地', async () => {
      const pushed = await gitbar('tag/push', { name: 'v0.1.0' })
      assert.equal(pushed.status, 200, JSON.stringify(pushed.body).slice(0, 300))
      assert.equal(pushed.body.pushedTag, 'v0.1.0')
      assert.equal(pushed.body.remote, 'origin')
      assert.deepEqual(remoteTags(), ['v0.1.0'], '远端只该有这一个标签')
      // 本地三个标签都还在（推送不删本地）。
      assert.deepEqual(
        git(pushRepo, ['tag', '-l']).split('\n').map((line) => line.trim()).filter((line) => line !== '').sort(),
        ['do-not-push', 'v0.1.0', 'v0.2.0'],
      )
    })

    await check('4.2) 附注标签推上去仍然是附注标签（对象类型一起过去）', async () => {
      const pushed = await gitbar('tag/push', { name: 'v0.2.0' })
      assert.equal(pushed.status, 200, JSON.stringify(pushed.body).slice(0, 300))
      assert.deepEqual(remoteTags(), ['v0.1.0', 'v0.2.0'])
      assert.equal(git(pushOrigin, ['cat-file', '-t', 'refs/tags/v0.2.0']).trim(), 'tag')
      assert.equal(git(pushOrigin, ['cat-file', '-t', 'refs/tags/v0.1.0']).trim(), 'commit')
    })

    await check('4.3) 不存在的标签 / 非法名 / 没有远端时各有明确结论', async () => {
      const missing = await gitbar('tag/push', { name: 'nope' })
      assert.equal(missing.status, 404)
      assert.equal(missing.body.code, 'noSuchTag')
      const bad = await gitbar('tag/push', { name: 'bad name' })
      assert.equal(bad.status, 400)
      assert.equal(bad.body.code, 'invalidTagName')
      const badRemote = await gitbar('tag/push', { name: 'v0.1.0', remote: 'bad/name' })
      assert.equal(badRemote.status, 400)
      assert.equal(badRemote.body.code, 'invalidRemote')
    })
  })

  // =========================================================================
  // 5. comparison: commit ↔ HEAD, A ↔ B, branch ↔ HEAD; renamed files.
  // =========================================================================
  console.log('')
  console.log('=== 5. 比较两个修订 ===')
  const compareRepo = createRepo('compare-repo')
  writeRepoFile(compareRepo, 'src/app.ts', 'one\n')
  writeRepoFile(compareRepo, 'src/keep.ts', 'keep\n')
  commitAll(compareRepo, 'first commit')
  const c1 = revParse(compareRepo, 'HEAD')
  writeRepoFile(compareRepo, 'src/app.ts', 'one\ntwo\n')
  writeRepoFile(compareRepo, 'src/new.ts', 'brand new\n')
  commitAll(compareRepo, 'second commit')
  const c2 = revParse(compareRepo, 'HEAD')
  // 改名**单独一次提交**且内容不动：这样 git 的改名检测（默认阈值 50%）能认出它。
  // 顺手改内容再提交（`git mv` 之后又编辑是常态），两个阶段各自可断言。
  git(compareRepo, ['mv', 'src/keep.ts', 'src/kept.ts'])
  commitAll(compareRepo, 'rename keep to kept')
  const c3 = revParse(compareRepo, 'HEAD')
  git(compareRepo, ['rm', '--quiet', 'src/new.ts'])
  commitAll(compareRepo, 'delete new')
  const c4 = revParse(compareRepo, 'HEAD')
  writeRepoFile(compareRepo, 'src/kept.ts', 'keep\nchanged\n')
  commitAll(compareRepo, 'change kept')
  const c5 = revParse(compareRepo, 'HEAD')
  git(compareRepo, ['switch', '-c', 'feature/login'])
  writeRepoFile(compareRepo, 'src/login.ts', 'login\n')
  commitAll(compareRepo, 'login work')
  git(compareRepo, ['switch', 'main'])
  registerWorkspace(compareRepo)

  await withServer(compareRepo, async ({ review }) => {
    await check('5.1) 提交 ↔ HEAD：只比出之后的提交与改动文件', async () => {
      const result = await review('compare', { a: c1, b: 'HEAD' })
      assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 300))
      assert.equal(result.body.a.sha, c1)
      assert.equal(result.body.b.sha, c5)
      assert.equal(result.body.onlyA, 0, 'c1 是 HEAD 的祖先')
      assert.equal(result.body.onlyB, 4, 'HEAD 上比 c1 多四个提交')
      const byPath = Object.fromEntries(result.body.files.map((file) => [file.path, file.status]))
      assert.equal(byPath['src/app.ts'], 'M')
      // 改名 + 之后再改内容，**跨越这一整段**时 git 的改名检测可能掉到默认阈值（50%）以下，
      // 于是同一件事既可能显示成一次改名、也可能显示成"删一个 + 加一个"——这是 git 的既定
      // 行为（命令行也是这样），界面不替它做决定。因此这里只断言"这个文件的净变化出现了"，
      // 严格的 `R` 由下一条（纯改名的那一步）钉住。
      assert.equal(['R', 'A'].includes(byPath['src/kept.ts']), true, `kept.ts 应当出现：${JSON.stringify(byPath)}`)
      assert.equal(byPath['src/keep.ts'] === undefined || byPath['src/keep.ts'] === 'D', true)
      // `src/new.ts` 在中途新增又删除：c1↔HEAD 之间**净效果为零**，因此不该出现在差异里
      // ——这一条正好钉住"比较的是两个快照，不是提交列表"。
      assert.equal(byPath['src/new.ts'], undefined)
    })

    await check('5.1b) 改名那一步单独比：状态是 R（两端都是引用/提交都可）', async () => {
      const renameOnly = await review('compare', { a: c2, b: c3 })
      const byPath = Object.fromEntries(renameOnly.body.files.map((file) => [file.path, file.status]))
      assert.equal(byPath['src/kept.ts'], 'R')
      assert.equal(byPath['src/keep.ts'], undefined)
      assert.equal(renameOnly.body.onlyB, 1)
      // 删除单独一步也看得到。
      const deleted = await review('compare', { a: c3, b: c4 })
      const deletedByPath = Object.fromEntries(deleted.body.files.map((file) => [file.path, file.status]))
      assert.equal(deletedByPath['src/new.ts'], 'D')
    })

    await check('5.2) A ↔ B：两个提交各自独有的数量（与 git 自己算的一致）', async () => {
      const result = await review('compare', { a: c2, b: c3 })
      assert.equal(result.body.onlyA, 0)
      assert.equal(result.body.onlyB, 1)
      const reverse = await review('compare', { a: c3, b: c2 })
      assert.equal(reverse.body.onlyA, 1, '反过来问，独有的一侧也反过来')
      assert.equal(reverse.body.onlyB, 0)
      // 与 `git rev-list --left-right --count` 的结果逐字一致。
      const counts = git(compareRepo, ['rev-list', '--left-right', '--count', `${c2}...${c3}`]).trim().split(/\s+/u)
      const same = await review('compare', { a: c2, b: c3 })
      assert.equal(`${same.body.onlyA} ${same.body.onlyB}`, `${counts[0]} ${counts[1]}`)
      assert.equal(same.body.same, false)
    })

    await check('5.3) 分支 ↔ 当前：另一端也可以用引用名', async () => {
      const result = await review('compare', { a: 'feature/login', b: 'HEAD' })
      assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 300))
      assert.equal(result.body.onlyA, 1, 'feature/login 上有一个 HEAD 没有的提交')
      assert.equal(result.body.onlyB, 0)
      assert.equal(result.body.a.subject, 'login work')
      assert.deepEqual(
        result.body.files.map((file) => file.path),
        ['src/login.ts'],
      )
    })

    await check('5.4) 标签也能作为一端；两端相同则明确说"没有差异"', async () => {
      git(compareRepo, ['tag', 'v-first', c1])
      const result = await review('compare', { a: 'v-first', b: c1 })
      assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 300))
      assert.equal(result.body.same, true)
      assert.deepEqual(result.body.files, [])
      assert.equal(result.body.onlyA, 0)
      assert.equal(result.body.onlyB, 0)
      git(compareRepo, ['tag', '-d', 'v-first'])
    })

    await check('5.5) 比较里的单文件差异：两端由调用方给出（复用同一个渲染器）', async () => {
      const diff = await review('compare-file', { a: c1, b: c5, path: 'src/kept.ts' })
      assert.equal(diff.status, 200, JSON.stringify(diff.body).slice(0, 300))
      const text = String(diff.body.diff).replace(/\r\n/gu, '\n')
      assert.match(text, /^\+changed$/mu)
      assert.match(text, /^\+keep$/mu, '改名后的文件内容整份出现')
      assert.equal(diff.body.binary, false)
    })

    await check('5.6) 非法 / 不存在的修订被挡在前面（rev 表达式进不来）', async () => {
      for (const bad of ['HEAD~3', 'nope', 'f'.repeat(40), 'main@{2}', '']) {
        const result = await review('compare', { a: bad, b: 'HEAD' })
        assert.equal(result.status, 404, `${bad} → ${JSON.stringify(result.body).slice(0, 120)}`)
        assert.equal(result.body.code, 'noSuchRevision')
      }
    })
  })

  // =========================================================================
  // 6. file history, including a rename (the whole point of --follow).
  // =========================================================================
  console.log('')
  console.log('=== 6. 文件历史（含改名跟踪）===')
  const historyRepo = createRepo('history-repo')
  writeRepoFile(historyRepo, 'foo.ts', 'export const a = 1\n')
  commitAll(historyRepo, 'add foo')
  const fooCommit = revParse(historyRepo, 'HEAD')
  writeRepoFile(historyRepo, 'foo.ts', 'export const a = 2\n')
  commitAll(historyRepo, 'change foo')
  git(historyRepo, ['mv', 'foo.ts', 'bar.ts'])
  commitAll(historyRepo, 'rename foo to bar')
  writeRepoFile(historyRepo, 'bar.ts', 'export const a = 3\n')
  commitAll(historyRepo, 'change bar')
  writeRepoFile(historyRepo, 'other.txt', 'unrelated\n')
  commitAll(historyRepo, 'unrelated change')
  registerWorkspace(historyRepo)

  await withServer(historyRepo, async ({ review }) => {
    await check('6.1) 历史给出日期 / 作者 / 提交信息 / SHA，且只含这个文件的提交', async () => {
      const result = await review('file-history', { path: 'bar.ts' })
      assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 300))
      const subjects = result.body.commits.map((commit) => commit.subject)
      assert.deepEqual(subjects, ['change bar', 'rename foo to bar', 'change foo', 'add foo'])
      assert.equal(subjects.includes('unrelated change'), false, '别的文件不该出现在这个文件的历史里')
      const [newest] = result.body.commits
      assert.match(newest.hash, /^[0-9a-f]{40}$/u)
      assert.equal(newest.author, 'Test')
      assert.match(newest.date, /^\d{4}-\d{2}-\d{2}$/u)
    })

    await check('6.2) 改名之后仍然追得到改名**之前**的历史（--follow）', async () => {
      const result = await review('file-history', { path: 'bar.ts' })
      const hashes = result.body.commits.map((commit) => commit.hash)
      assert.equal(hashes.includes(fooCommit), true, '改名前的提交必须出现在 bar.ts 的历史里')
      // 反过来：老名字的历史里也应当包含改名这一步（git 的 --follow 只在"向新名字追"时才
      // 跨越改名，因此老名字这一侧只到改名那一刻）。
      const old = await review('file-history', { path: 'foo.ts' })
      assert.equal(old.body.commits.length >= 1, true)
    })

    await check('6.3) 每个历史提交里这个文件的差异（点击历史提交要看到的东西）', async () => {
      const result = await review('file-history', { path: 'bar.ts' })
      const renameCommit = result.body.commits.find((commit) => commit.subject === 'rename foo to bar')
      const diff = await review('commit-file', { revision: renameCommit.hash, path: 'bar.ts' })
      assert.equal(diff.status, 200, JSON.stringify(diff.body).slice(0, 300))
      assert.match(String(diff.body.diff), /similarity index|rename from|rename to/u, '改名提交的差异是一次改名')
    })
  })

  // =========================================================================
  // 7. revert a commit through the existing operation backend.
  // =========================================================================
  console.log('')
  console.log('=== 7. 还原一次提交（复用已有的 continue/abort）===')
  const revertRepo = createRepo('revert-commit-repo')
  writeRepoFile(revertRepo, 'shared.txt', 'first change\n')
  commitAll(revertRepo, 'change to revert')
  const toRevert = revParse(revertRepo, 'HEAD')
  writeRepoFile(revertRepo, 'other.txt', 'later\n')
  commitAll(revertRepo, 'later work')
  registerWorkspace(revertRepo)

  await withServer(revertRepo, async ({ gitbar }) => {
    await check('7.1) 还原一个提交会生成一个反向提交，且历史里两条都在', async () => {
      const result = await gitbar('revert', { revision: toRevert })
      assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 300))
      assert.equal(result.body.reverted, toRevert)
      assert.equal(result.body.conflicted, false)
      assert.match(subject(revertRepo), /^Revert "change to revert"/u)
      assert.equal(readRepoFile(revertRepo, 'shared.txt'), 'base\n', '那个提交的改动被反向应用')
      // 原来那条提交仍在历史里（revert 不是删除）。
      assert.equal(gitTry(revertRepo, ['rev-parse', '--verify', '--quiet', toRevert]).ok, true)
      const status = await gitbar('status', {})
      assert.equal(status.body.operation, null)
    })

    await check('7.2) 还原不存在的提交回 noSuchRevision（不做任何事）', async () => {
      const before = revParse(revertRepo, 'HEAD')
      const result = await gitbar('revert', { revision: 'f'.repeat(40) })
      assert.equal(result.status, 404)
      assert.equal(result.body.code, 'noSuchRevision')
      assert.equal(revParse(revertRepo, 'HEAD'), before)
    })
  })

  // =========================================================================
  // 8. Multi-repository isolation for tags and comparison.
  // =========================================================================
  console.log('')
  console.log('=== 8. 多仓库隔离 ===')
  const multiRoot = join(scratch, 'multi')
  const alpha = join(multiRoot, 'alpha')
  const beta = join(multiRoot, 'beta')
  mkdirSync(alpha, { recursive: true })
  mkdirSync(beta, { recursive: true })
  for (const [repo, label] of [
    [alpha, 'alpha'],
    [beta, 'beta'],
  ]) {
    git(repo, ['init', '--initial-branch=main'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    git(repo, ['config', 'user.name', 'Test'])
    writeRepoFile(repo, 'shared.txt', `${label} one\n`)
    commitAll(repo, `${label} first`)
    git(repo, ['tag', `${label}-v1`])
  }
  registerWorkspace(multiRoot, alpha, beta)
  const alphaSha = revParse(alpha, 'HEAD')

  await withServer(multiRoot, async ({ gitbar, review }) => {
    await check('8.1) 标签列表严格属于当前仓库', async () => {
      const listedAlpha = await gitbar('tags', { repository: alpha })
      const listedBeta = await gitbar('tags', { repository: beta })
      assert.deepEqual(listedAlpha.body.tags.map((entry) => entry.name), ['alpha-v1'])
      assert.deepEqual(listedBeta.body.tags.map((entry) => entry.name), ['beta-v1'])
      assert.equal(listedAlpha.body.tagCount, 1)
    })

    await check('8.2) 在 beta 上删/推 alpha 的标签会被拒绝（标签不存在）', async () => {
      const deleted = await gitbar('tag/delete', { name: 'alpha-v1', repository: beta })
      assert.equal(deleted.status, 404, JSON.stringify(deleted.body).slice(0, 200))
      assert.equal(deleted.body.code, 'noSuchTag')
      assert.equal(gitTry(alpha, ['rev-parse', '--verify', 'refs/tags/alpha-v1']).ok, true, 'alpha 的标签毫发无损')
    })

    await check('8.3) 比较也不允许跨仓库（另一仓库的 SHA 解析不出来）', async () => {
      const result = await review('compare', { a: alphaSha, b: 'HEAD', repository: beta })
      assert.equal(result.status, 404, JSON.stringify(result.body).slice(0, 200))
      assert.equal(result.body.code, 'noSuchRevision')
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
