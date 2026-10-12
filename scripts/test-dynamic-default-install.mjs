// End-to-end: actual public GitHub assets, actual bundled pnpm and Desktop boot.
// Each profile is disposable; no installed application data is read or changed.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readDefaultPlugins } from '../src/server/default-plugins.mjs'

const root = resolve(import.meta.dirname, '..')
const scratch = mkdtempSync(join(root, '.tmp', 'dynamic-defaults-'))
const home = join(scratch, 'home')
const workspace = join(scratch, 'project')
mkdirSync(workspace)
const profileDir = join(home, 'profiles', 'desktop')
const runtime = join(root, 'runtime')
const anchor = join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const plugins = readDefaultPlugins()
const require = createRequire(anchor)
const { runPluginCommand } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-plugin-manager/operations')).href)
let child

async function stop() {
  if (!child) return
  const current = child
  child = undefined
  if (current.exitCode === null && current.signalCode === null) {
    const exited = once(current, 'exit')
    current.kill()
    await exited
  }
}

async function boot(label) {
  let output = ''
  child = spawn(process.execPath, [join(runtime, 'server.mjs'), '--dsh-home', home, '--install-anchor', anchor,
    '--workspace', workspace, '--register-workspace', '--bundled-plugins-dir', join(root, 'plugins')], {
    cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_DESKTOP_DEFAULT_PLUGINS: '1',
      DSH_DESKTOP_PNPM_CLI: join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
      DSH_DESKTOP_NODE_BIN: join(root, 'src', 'tooling'), TEMP: join(scratch, 'temp'), TMP: join(scratch, 'temp') },
  })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    const text = String(chunk)
    output += text
    for (const line of text.split('\n')) if (/正在默认安装|默认插件已安装|安装失败|fatal:/u.test(line)) console.log(line.trim())
  })
  const deadline = Date.now() + 190000
  while (Date.now() < deadline && !output.includes('[dsh-desktop] ready')) {
    assert.equal(child.exitCode, null, output.slice(-4000))
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(output.includes('[dsh-desktop] ready'), output.slice(-4000))
  const url = /dsh web: (http:\/\/127\.0\.0\.1:\d+\S*)/u.exec(output)?.[1]
  assert.ok(url)
  const login = await fetch(url, { redirect: 'manual' })
  const cookie = login.headers.getSetCookie().map(header => header.split(';')[0]).join('; ')
  const base = new URL(url).origin
  const html = await (await fetch(`${base}/`, { headers: { cookie } })).text()
  console.log(`PASS Desktop ready: ${label}`)
  return { html, output, base, cookie }
}

try {
  mkdirSync(join(scratch, 'temp'))
  // Simulate upgrading an existing Desktop profile whose Git packages are old
  // bundled links. pnpm must move the links, without changing their targets.
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...plugins.map(plugin => plugin.name)] } } }))
  const original = new Map()
  for (const plugin of plugins) {
    const source = join(root, 'plugins', plugin.name)
    symlinkSync(source, join(profileDir, 'node_modules', plugin.name), 'junction')
    original.set(plugin.name, createHash('sha256').update(readFileSync(join(source, 'lib', 'client.js'))).digest('hex'))
  }
  const first = await boot('first default download and legacy-link migration')
  assert.ok(!first.output.includes('安装失败'), first.output.slice(-4000))
  for (const plugin of plugins) {
    const pkg = JSON.parse(readFileSync(join(profileDir, 'node_modules', plugin.name, 'package.json'), 'utf8'))
    assert.equal(pkg.version, plugin.version)
    assert.ok(first.html.includes(plugin.name))
    const unchanged = createHash('sha256').update(readFileSync(join(root, 'plugins', plugin.name, 'lib', 'client.js'))).digest('hex')
    assert.equal(unchanged, original.get(plugin.name), 'old bundled source was not modified')
  }
  const state = JSON.parse(readFileSync(join(profileDir, 'default-plugins-state.json'), 'utf8'))
  assert.equal(Object.keys(state.plugins).length, 2)
  assert.ok(Object.values(state.plugins).every(plugin => plugin.status === 'installed'))
  await stop()

  const second = await boot('subsequent startup reuses installed plugins')
  assert.ok(!second.output.includes('正在默认安装'))
  await stop()
  // A real package-manager uninstall and a separate bundle-disable choice.
  const removed = await runPluginCommand({ profile: 'desktop', dir: profileDir, home, installAnchor: anchor, cwd: root },
    ['remove', 'dsh-client-ui-gitbar', '--config.auto-install-peers=false', `--store-dir=${join(home, 'plugin-store')}`], { command: process.execPath,
      args: [join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')], execution: 'service', outputBytes: 16384, idleTimeoutMs: 30000,
      env: { DSH_HOME: home } })
  assert.equal(removed.exitCode, 0, removed.output)
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== 'dsh-client-ui-review')
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest))
  const third = await boot('user uninstall / disable remain effective')
  assert.ok(!third.output.includes('正在默认安装'))
  for (const plugin of plugins) assert.ok(!third.html.includes(plugin.name))
  const after = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  assert.ok(!after.dependencies['dsh-client-ui-gitbar'])
  assert.ok(!after.dsh.profile.bundles.includes('dsh-client-ui-review'))
  console.log('PASS published GitHub tarballs and SHA-256, default activation, migration, repeat startup and user choices')
} finally {
  await stop()
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
