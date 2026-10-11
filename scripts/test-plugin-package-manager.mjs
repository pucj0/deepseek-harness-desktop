// Exercise the production launcher and actual Runtime manager, without system node/pnpm.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { DshServer } from '../dist/main/dsh-server.js'

const require = createRequire(import.meta.url)
if (!process.versions.electron) {
  const child = spawnSync(require('electron'), [import.meta.filename], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8', windowsHide: true, timeout: 120000,
  })
  process.stdout.write(child.stdout ?? '')
  process.stderr.write(child.stderr ?? '')
  if (child.error) throw child.error
  process.exit(child.status ?? 1)
}
const root = resolve(import.meta.dirname, '..')
const runtimeDir = resolve(process.env.DSH_TEST_RUNTIME_DIR ?? join(root, 'runtime'))
const tempRoot = join(root, '.tmp')
mkdirSync(tempRoot, { recursive: true })
const scratch = mkdtempSync(join(tempRoot, 'plugin manager 空格-'))
const runtime = join(scratch, 'runtime')
const source = join(scratch, 'source')
const home = join(scratch, 'home')
const emptyBin = join(scratch, 'empty-bin')
for (const dir of [runtime, source, home, emptyBin]) mkdirSync(dir, { recursive: true })
const resultFile = join(scratch, 'results.json')
const fixture = join(scratch, 'fixture package')
mkdirSync(fixture)
writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'desktop-package-fixture', version: '1.0.0', main: 'index.js' }))
writeFileSync(join(fixture, 'index.js'), 'module.exports = 42\n')
for (const name of ['client-module-cache.mjs', 'package-manager.mjs']) {
  writeFileSync(join(source, name), readFileSync(join(root, 'src', 'server', name)))
}
// The hook runs only in this temporary entry, after the unmodified production boot.
const script = readFileSync(join(root, 'src', 'server', 'server.mjs'), 'utf8')
assert.equal(script.split('await reportSettingsSurface(ctx)').length, 2)
writeFileSync(join(source, 'server.mjs'), script.replace('await reportSettingsSurface(ctx)', `
  await reportSettingsSurface(ctx)
  {
    const assert = (await import('node:assert/strict')).default
    const { runProfilePnpm } = await import('@deepseek-ai/dsh-plugin-manager/operations')
    const { spawnSync } = await import('node:child_process')
    const manager = ctx.get('pluginManager')
    assert.ok(manager, 'Runtime plugin manager must mount')
    assert.equal(process.env.PATH, ${JSON.stringify(emptyBin)}, 'Host PATH must stay unchanged')
    const packageManager = ctx.get('profileContext').packageManager
    const version = spawnSync(packageManager.command, [...packageManager.args, '--version'], {
      env: { ...process.env, ...packageManager.env }, encoding: 'utf8', windowsHide: true,
    })
    assert.equal(version.status, 0, version.stderr)
    assert.equal(version.stdout.trim(), ${JSON.stringify(require('pnpm').version)})
    const registries = await manager.registries()
    assert.ok(['http:', 'https:'].includes(new URL(registries.resolved).protocol))
    assert.equal((await manager.listBundles()).filter(x => x.name.startsWith('dsh-client-ui-')).length, 4)
    assert.ok((await manager.listPlugins()).length > 0)
    const operationDir = ${JSON.stringify(join(scratch, 'operation profile'))}
    mkdirSync(operationDir, { recursive: true })
    writeFileSync(join(operationDir, 'package.json'), JSON.stringify({
      name: 'isolated-plugin-profile', private: true,
      dsh: { profile: { bundles: [] } },
      scripts: { probe: ${JSON.stringify('node -e "console.log(process.versions.node)"')} },
    }))
    const context = { profile: 'desktop', dir: operationDir, cwd: operationDir, installAnchor: ${JSON.stringify(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))}, home }
    const policy = { ...packageManager, execution: 'service', outputBytes: 16384, idleTimeoutMs: 15000, lookupTimeoutMs: 2000, activateNewBundles: false }
    policy.args = [...policy.args, ${JSON.stringify('--config.store-dir=' + join(scratch, 'store'))}]
    const installed = await runProfilePnpm(context, ['add', ${JSON.stringify('file:' + fixture)}, '--offline'], policy)
    assert.equal(installed.exitCode, 0, installed.output)
    assert.equal(JSON.parse(readFileSync(join(operationDir, 'node_modules', 'desktop-package-fixture', 'package.json'))).version, '1.0.0')
    const probe = await runProfilePnpm(context, ['run', 'probe'], policy)
    assert.equal(probe.exitCode, 0, probe.output)
    assert.ok(probe.output.includes(process.versions.node), probe.output)
    const removed = await runProfilePnpm(context, ['remove', 'desktop-package-fixture', '--config.offline=true'], policy)
    assert.equal(removed.exitCode, 0, removed.output)
    assert.equal(JSON.parse(readFileSync(join(operationDir, 'package.json'))).dependencies?.['desktop-package-fixture'], undefined)
    writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ version: version.stdout.trim(), registry: registries.resolved, installed: true, nodeScript: true, removed: true, hostPathUnchanged: true }))
  }
`))

let server
// Windows Electron's recursive rm can follow junctions. Walk with lstat and
// remove each link itself; never recurse into Runtime or bundled plugin targets.
function removeScratchTree(path) {
  let stat
  try { stat = lstatSync(path) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    // Electron may return ENOENT for a dangling directory junction.
    try { rmdirSync(path) } catch (removeError) {
      if (removeError.code === 'ENOTDIR') unlinkSync(path)
      else if (removeError.code !== 'ENOENT') throw removeError
    }
    return
  }
  const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
  // Some Windows filesystems report junctions as ordinary directories to lstat.
  // A different native real path still identifies a link, before any traversal.
  let linked = stat.isSymbolicLink()
  if (!linked) linked = !samePath(realpathSync.native(path), resolve(path))
  if (linked) {
    if (process.platform === 'win32') {
      try { rmdirSync(path) } catch (error) {
        if (!['ENOTDIR', 'ENOENT'].includes(error.code)) throw error
        unlinkSync(path)
      }
    } else unlinkSync(path)
  } else if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) removeScratchTree(join(path, entry))
    rmdirSync(path)
  } else unlinkSync(path)
}
try {
  symlinkSync(join(runtimeDir, 'node_modules'), join(runtime, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'))
  env.PATH = emptyBin
  env.TMP = scratch
  env.TEMP = scratch
  env.TMPDIR = scratch
  env.ELECTRON_RUN_AS_NODE = '1'
  server = new DshServer({
    runtime: {
      dir: runtime, installAnchor: join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      serverEntry: join(source, 'server.mjs'), serverRunEntry: join(runtime, 'server.mjs'),
      nodeBinary: undefined, packaged: false,
    },
    env, dshHome: home, workspace: scratch, bundledPluginsDir: join(root, 'plugins'),
  })
  const logs = []
  server.on('log', ({ line }) => logs.push(line))
  try { await server.start() } catch (error) { throw new Error(logs.slice(-35).join('\n'), { cause: error }) }
  assert.ok(existsSync(resultFile), 'Actual manager checks must finish')
  console.log('PASS real Runtime plugin manager:', readFileSync(resultFile, 'utf8'))
  const exchange = await fetch(server.ready.authenticatedUrl, { redirect: 'manual' })
  const cookie = exchange.headers.getSetCookie().map(x => x.split(';')[0]).join('; ')
  const page = await fetch(server.ready.url, { headers: { cookie } })
  assert.equal(page.status, 200)
  assert.ok((await page.text()).includes('id="root"'))
  console.log('PASS authenticated application page')
} finally {
  await server?.stop(1000)
  if (!resolve(scratch).startsWith(resolve(tempRoot) + sep)) throw new Error('Unsafe cleanup path')
  removeScratchTree(scratch)
  assert.ok(existsSync(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')), 'Cleanup must retain the Runtime')
  assert.ok(existsSync(join(root, 'plugins', 'dsh-client-ui-review', 'package.json')), 'Cleanup must retain bundled plugins')
}
