// Install the real tarballs with the official plugin manager, then boot the
// official CLI's web profile. No Desktop server, preload, or shell plugin.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { packUiPlugins } from './pack-ui-plugins.mjs'

const root = resolve(import.meta.dirname, '..')
const anchor = join(root, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const require = createRequire(anchor)
const { runPluginCommand } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-plugin-manager/operations')).href)
const cli = join(anchor, '..', 'lib', 'bin.js')
const pnpm = join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
const temp = mkdtempSync(join(tmpdir(), 'dsh-standalone-plugins-'))
const repo = join(temp, 'project')
const secondRepo = join(temp, 'registered')
const deniedRepo = join(temp, 'not-registered')
const cleanEnv = { ...process.env, DSH_TELEMETRY_DISABLED: '1' }
for (const key of Object.keys(cleanEnv)) if (key.startsWith('DSH_DESKTOP_')) delete cleanEnv[key]
const git = (args, cwd = repo) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
let child

async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function stop() {
  if (!child) return
  const running = child
  child = undefined
  if (running.exitCode === null && running.signalCode === null) {
    const exited = once(running, 'exit')
    running.kill()
    await exited
  }
}

try {
  for (const directory of [repo, secondRepo, deniedRepo]) {
    mkdirSync(directory)
    git(['init', '-q', '-b', 'main'], directory)
    git(['config', 'user.name', 'Plugin Test'], directory)
    git(['config', 'user.email', 'plugin-test@example.com'], directory)
    git(['config', 'commit.gpgsign', 'false'], directory)
    writeFileSync(join(directory, 'file.txt'), 'original\n')
    git(['add', '.'], directory)
    git(['commit', '-q', '-m', 'initial'], directory)
  }
  const packages = packUiPlugins(join(temp, 'packages'))
  for (const pkg of packages) {
    assert.ok(pkg.files.includes('LICENSE') && pkg.files.includes('README.md'))
    assert.ok(pkg.files.includes('lib/workspace-roots.js'))
    assert.ok(pkg.files.every(file => !file.includes('node_modules/') && !file.startsWith('src/')))
  }

  // Exercise the official launch facts even with no DSH_HOME or Desktop env.
  const { collectWorkspaceRoots } = await import('../plugins/dsh-client-ui-review/lib/workspace-roots.js')
  let registered = [{ path: secondRepo }]
  const rootsCtx = { get: key => key === 'profileContext' ? { cwd: repo, home: temp }
    : key === 'workspaceRegistry' ? { list: () => registered } : undefined }
  const desktopWorkspace = process.env.DSH_DESKTOP_WORKSPACE
  delete process.env.DSH_DESKTOP_WORKSPACE
  try {
    assert.ok(collectWorkspaceRoots(rootsCtx).includes(secondRepo))
    registered = []
    assert.ok(!collectWorkspaceRoots(rootsCtx).includes(secondRepo))
    assert.ok(collectWorkspaceRoots(rootsCtx).includes(repo))
  } finally {
    if (desktopWorkspace !== undefined) process.env.DSH_DESKTOP_WORKSPACE = desktopWorkspace
  }

  for (const names of [['review'], ['gitbar'], ['review', 'gitbar']]) {
    const home = join(temp, names.join('-'))
    mkdirSync(home)
    const wanted = packages.filter(pkg => names.some(name => pkg.name === `dsh-client-ui-${name}`))
    const result = await runPluginCommand({ profile: 'web', home, installAnchor: anchor, cwd: root }, [
      'add', ...wanted.map(pkg => pkg.path), '--offline', '--ignore-scripts',
      '--config.auto-install-peers=false', `--store-dir=${join(temp, 'pnpm-store')}`,
    ], { command: process.execPath, args: [pnpm], execution: 'service', outputBytes: 16384,
      idleTimeoutMs: 30000, lookupTimeoutMs: 3000, env: { DSH_HOME: home, PNPM_HOME: join(temp, 'pnpm-home') } })
    assert.equal(result.exitCode, 0, result.output)
    console.log(`Installed with official plugin manager: ${names.join(' + ')}`)
    const profileDir = join(home, 'profiles', 'web')
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    for (const pkg of wanted) assert.ok(manifest.dsh.profile.bundles.includes(pkg.name), `${pkg.name} auto-activated`)
    for (const pkg of packages.filter(pkg => !wanted.includes(pkg))) {
      assert.ok(!manifest.dependencies?.[pkg.name], `${pkg.name} was not pulled in`)
      assert.ok(!manifest.dsh.profile.bundles.includes(pkg.name))
    }
    for (const pkg of wanted) {
      const installed = join(profileDir, 'node_modules', pkg.name)
      assert.equal(readFileSync(join(installed, 'lib', 'client.js'), 'utf8'),
        readFileSync(join(root, 'plugins', pkg.name, 'lib', 'client.js'), 'utf8'))
    }

    const port = await freePort()
    child = spawn(process.execPath, [cli, 'web', '--no-open', '--port', String(port)], {
      cwd: repo, env: { ...cleanEnv, DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    let url
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\S*)/u.exec(output)
      if (match) { url = match[1]; break }
      assert.equal(child.exitCode, null, output.slice(-6000))
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(url, `official CLI failed to start: ${output.slice(-6000)}`)
    const login = await fetch(url, { redirect: 'manual' })
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const base = new URL(url).origin
    const page = await fetch(`${base}/`, { headers: { cookie } })
    assert.equal(page.status, 200)
    const html = await page.text()
    for (const pkg of wanted) assert.ok(html.includes(pkg.name), `${pkg.name} is in the official boot graph`)
    for (const pkg of packages.filter(pkg => !wanted.includes(pkg))) assert.ok(!html.includes(pkg.name))
    assert.ok(!html.includes('dsh-client-ui-shell-bridge'))

    async function call(path, body) {
      const response = await fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const text = await response.text()
      let data
      try { data = JSON.parse(text) } catch { data = { text } }
      return { status: response.status, data }
    }

    if (names.includes('review')) {
      const prefix = '/dsh-desktop/review'
      const body = { workspace: repo, sessionId: `standalone-${names.join('-')}` }
      // An existing user change must be excluded from the turn baseline.
      writeFileSync(join(repo, 'file.txt'), 'user change\n')
      assert.equal((await call(`${prefix}/baseline`, body)).status, 200)
      writeFileSync(join(repo, 'agent.txt'), 'agent change\n')
      const before = git(['status', '--porcelain'])
      const changes = await call(`${prefix}/changes`, body)
      assert.equal(changes.status, 200, JSON.stringify(changes.data))
      assert.deepEqual(changes.data.files.map(file => file.path).sort(), ['agent.txt'])
      assert.equal(git(['status', '--porcelain']), before)
      assert.equal(git(['stash', 'list']), '')
      const workspace = await call(`${prefix}/workspace`, body)
      assert.equal(workspace.status, 200)
      assert.deepEqual([
        ...workspace.data.files,
        ...(workspace.data.untracked?.inlineFiles ?? []),
      ].map(file => file.path).sort(), ['agent.txt', 'file.txt'])
      const gitQuery = `?cwd=${encodeURIComponent(repo)}`
      for (const endpoint of ['status', 'branches', 'tags', 'stash/list', 'auto-saves']) {
        assert.equal((await call(`${prefix}/git/${endpoint}${gitQuery}`)).status, 200, endpoint)
      }
      const graph = await call(`${prefix}/graph`, { workspace: repo })
      assert.equal(graph.status, 200)
      assert.ok(graph.data.commits.length > 0)
      assert.equal((await call(`${prefix}/workspace`, { workspace: deniedRepo })).status, 400)
      const stash = await call(`${prefix}/git/stash/push${gitQuery}`, { message: 'standalone', includeUntracked: true })
      assert.equal(stash.status, 200, JSON.stringify(stash.data))
      assert.equal(git(['status', '--porcelain']), '')
      const pop = await call(`${prefix}/git/stash/pop${gitQuery}`, { ref: 'stash@{0}' })
      assert.equal(pop.status, 200, JSON.stringify(pop.data))
      assert.equal(git(['status', '--porcelain']), before)
      if (!names.includes('gitbar')) assert.equal((await call(`/dsh-desktop/gitbar/status${gitQuery}`)).status, 404)
    }
    if (names.includes('gitbar')) {
      const prefix = '/dsh-desktop/gitbar'
      const query = `?cwd=${encodeURIComponent(repo)}`
      const status = await call(`${prefix}/status${query}`)
      assert.equal(status.status, 200, JSON.stringify(status.data))
      assert.equal(status.data.branch, 'main')
      assert.equal((await call(`${prefix}/status?cwd=${encodeURIComponent(deniedRepo)}`)).status, 400)
      const create = await call(`${prefix}/branch/create${query}`, { name: 'standalone-test', checkout: true })
      assert.equal(create.status, 200, JSON.stringify(create.data))
      assert.equal(git(['branch', '--show-current']), 'standalone-test')
      assert.equal((await call(`${prefix}/checkout${query}`, { branch: 'main' })).status, 200)
      assert.equal(git(['branch', '--show-current']), 'main')
      git(['branch', '-D', 'standalone-test'])
      // The official static fallback rejects POST with 405 for unknown routes.
      if (!names.includes('review')) assert.ok([404, 405].includes((await call('/dsh-desktop/review/workspace', { workspace: repo })).status))
    }
    await stop()
    git(['reset', '--hard', '-q', 'HEAD'])
    rmSync(join(repo, 'agent.txt'), { force: true })
    console.log(`PASS official dsh web: ${names.join(' + ')} tarball installation, auto-activation, boot graph, routes and Git operations`)
  }
  console.log('PASS standalone package contents and official workspace context / live removal')
} finally {
  await stop()
  rmSync(temp, { recursive: true, force: true })
}
