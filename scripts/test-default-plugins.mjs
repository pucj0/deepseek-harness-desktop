import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_PLUGIN_NAMES, ensureDefaultPlugins, readDefaultPlugins } from '../src/server/default-plugins.mjs'
import { desktopRuntimeExclusion } from './runtime-file-policy.mjs'

const root = resolve(import.meta.dirname, '..')
mkdirSync(join(root, '.tmp'), { recursive: true })
const scratch = mkdtempSync(join(root, '.tmp', 'default-plugins-'))
const anchor = join(root, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const packages = DEFAULT_PLUGIN_NAMES.map(name => {
  const pkg = JSON.parse(readFileSync(join(root, 'plugins', name, 'package.json'), 'utf8'))
  const content = readFileSync(join(root, 'release', 'plugins', `${name}-${pkg.version}.tgz`))
  return { name, version: pkg.version, content, url: `https://github.com/pucj0/${name}/releases/download/v${pkg.version}/${name}-${pkg.version}.tgz`,
    sha256: createHash('sha256').update(content).digest('hex') }
})

function fixture(label) {
  const home = join(scratch, label)
  const profileDir = join(home, 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'user-custom-plugin'] } } }))
  let downloads = 0
  let installs = 0
  const calls = []
  const options = { home, profileDir, installAnchor: anchor, plugins: packages, log: () => {},
    packageManager: { command: process.execPath, args: [] },
    withLock: async (_path, action) => action(),
    fetcher: async url => { downloads++; return new Response(packages.find(pkg => pkg.url === url).content) },
    runPluginCommand: async (context, args, policy) => {
      installs++
      calls.push({ context, args, policy })
      const pkg = packages.find(pkg => args[1].includes(pkg.name))
      const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
      manifest.dependencies[pkg.name] = `file:${args[1]}`
      manifest.dsh.profile.bundles.push(pkg.name)
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest))
      mkdirSync(join(profileDir, 'node_modules', pkg.name), { recursive: true })
      writeFileSync(join(profileDir, 'node_modules', pkg.name, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version }))
      return { exitCode: 0 }
    } }
  return { options, calls, counts: () => ({ downloads, installs }), manifest: () => JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) }
}

try {
  assert.deepEqual(readDefaultPlugins().map(pkg => pkg.name).sort(), [...DEFAULT_PLUGIN_NAMES].sort())
  const first = fixture('first-install')
  const result = await ensureDefaultPlugins(first.options)
  assert.deepEqual(result.installed.sort(), [...DEFAULT_PLUGIN_NAMES].sort(), JSON.stringify(result))
  assert.deepEqual(first.counts(), { downloads: 2, installs: 2 })
  assert.ok(first.manifest().dsh.profile.bundles.includes('user-custom-plugin'))
  for (const call of first.calls) {
    assert.equal(call.context.dir, first.options.profileDir)
    assert.ok(call.args.includes('--ignore-scripts'))
    assert.ok(call.args.includes('--config.auto-install-peers=false'))
    assert.equal(call.policy.execution, 'service')
  }
  await ensureDefaultPlugins({ ...first.options, fetcher: () => { throw new Error('offline') } })
  assert.deepEqual(first.counts(), { downloads: 2, installs: 2 })
  console.log('PASS defaults install into the writable profile once; later offline starts do no network or package operations')

  // Simulate the user's uninstall and disable choices after the first install.
  const manifest = first.manifest()
  delete manifest.dependencies[DEFAULT_PLUGIN_NAMES[0]]
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => !DEFAULT_PLUGIN_NAMES.includes(name))
  writeFileSync(join(first.options.profileDir, 'package.json'), JSON.stringify(manifest))
  rmSync(join(first.options.profileDir, 'node_modules', DEFAULT_PLUGIN_NAMES[0]), { recursive: true })
  await ensureDefaultPlugins(first.options)
  assert.deepEqual(first.counts(), { downloads: 2, installs: 2 })
  assert.ok(!first.manifest().dependencies[DEFAULT_PLUGIN_NAMES[0]])
  assert.ok(!first.manifest().dsh.profile.bundles.includes(DEFAULT_PLUGIN_NAMES[1]))
  console.log('PASS intentional uninstall and disable are preserved')

  const failed = fixture('retry')
  const failure = await ensureDefaultPlugins({ ...failed.options, fetcher: async () => { throw new Error('offline') } })
  assert.equal(failure.failures.length, 2)
  assert.equal(failed.counts().installs, 0)
  assert.equal((await ensureDefaultPlugins(failed.options)).installed.length, 2)
  const corrupt = fixture('checksum')
  const rejected = await ensureDefaultPlugins({ ...corrupt.options, fetcher: async () => new Response('tampered archive') })
  assert.equal(rejected.failures.length, 2)
  assert.equal(corrupt.counts().installs, 0)
  assert.ok(rejected.failures.every(failure => failure.reason.includes('SHA-256')))
  console.log('PASS failed downloads retry on next start; checksum mismatch never reaches the package manager')

  const cached = fixture('cache')
  const attempted = await ensureDefaultPlugins({ ...cached.options, runPluginCommand: async () => ({ exitCode: 1, logPath: 'fixture.log' }) })
  assert.equal(attempted.failures.length, 2)
  assert.equal(cached.counts().downloads, 2)
  assert.equal((await ensureDefaultPlugins({ ...cached.options, fetcher: () => { throw new Error('offline') } })).installed.length, 2)
  assert.equal(cached.counts().downloads, 2)
  const adopted = fixture('adopt')
  await adopted.options.runPluginCommand({ dir: adopted.options.profileDir }, ['add', DEFAULT_PLUGIN_NAMES[0]], {})
  const afterAdopt = await ensureDefaultPlugins(adopted.options)
  assert.deepEqual(afterAdopt.kept, [DEFAULT_PLUGIN_NAMES[0]])
  assert.equal(adopted.counts().downloads, 1)
  console.log('PASS verified cache supports retry without another download; existing user-installed packages are adopted')

  const disabled = fixture('disabled')
  await ensureDefaultPlugins({ ...disabled.options, enabled: false })
  assert.deepEqual(disabled.counts(), { downloads: 0, installs: 0 })
  assert.ok(!existsSync(join(disabled.options.profileDir, 'default-plugins-state.json')))
  const badState = fixture('bad-state')
  writeFileSync(join(badState.options.profileDir, 'default-plugins-state.json'), '{invalid')
  await assert.rejects(ensureDefaultPlugins(badState.options))
  assert.equal(badState.counts().downloads, 0)
  console.log('PASS opt-out and corrupt-state handling never silently reinstall a plugin')

  for (const name of DEFAULT_PLUGIN_NAMES) assert.equal(desktopRuntimeExclusion(`${name}/lib/client.js`), '独立动态安装的 Git 插件')
  assert.equal(desktopRuntimeExclusion('dsh-client-ui-shell-bridge/lib/client.js'), undefined)
  const config = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
  assert.match(config, /filter:\s*\n\s*- 'dsh-client-ui-typography\/\*\*\/\*'\s*\n\s*- 'dsh-client-ui-shell-bridge\/\*\*\/\*'/u)
  for (const file of ['default-plugins.mjs', 'default-plugins.json']) assert.ok(config.includes(`'${file}'`))
  console.log('PASS installation resources and production runtime exclude both Git plugins')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
