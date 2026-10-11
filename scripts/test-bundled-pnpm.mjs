import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { delimiter, join, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const release = join(root, 'release', manifest.version)
const output = process.platform === 'win32' ? join(release, 'win-unpacked')
  : process.platform === 'darwin' ? join(release, process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'dsh-desktop.app', 'Contents')
  : join(release, 'linux-unpacked')
const resources = join(output, process.platform === 'darwin' ? 'Resources' : 'resources')
const electron = join(output, process.platform === 'win32' ? 'dsh-desktop.exe' : process.platform === 'darwin' ? 'MacOS/dsh-desktop' : 'dsh-desktop')
assert.ok(existsSync(electron), `Missing packaged executable: ${electron}; build the package first`)
const tempRoot = join(root, '.tmp')
mkdirSync(tempRoot, { recursive: true })
const scratch = mkdtempSync(join(tempRoot, 'bundled pnpm 空格-'))
// Retain the POSIX shell required by lifecycle scripts, without system node/pnpm.
if (process.platform !== 'win32') symlinkSync('/bin/sh', join(scratch, 'sh'))
try {
  const nodeBin = join(resources, 'tooling')
  const pmRoot = join(resources, 'app.asar.unpacked', 'node_modules', 'pnpm')
  const pmManifest = JSON.parse(readFileSync(join(pmRoot, 'package.json'), 'utf8'))
  assert.equal(pmManifest.version, manifest.dependencies.pnpm)
  const cli = resolve(pmRoot, pmManifest.bin.pnpm)
  const launcher = join(resources, 'app.asar', 'dist', 'main', 'package-manager.js')
  const configured = spawnSync(electron, ['-e', `
    const { bundledPackageManagerEnvironment } = require(${JSON.stringify(launcher)});
    console.log(JSON.stringify(bundledPackageManagerEnvironment(${JSON.stringify(join(resources, 'server', 'server.mjs'))}, true)));
  `], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 10000 })
  if (configured.error) throw configured.error
  assert.equal(configured.status, 0, configured.stderr)
  assert.deepEqual(JSON.parse(configured.stdout), { DSH_DESKTOP_PNPM_CLI: cli, DSH_DESKTOP_NODE_BIN: nodeBin })
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'))
  Object.assign(env, {
    ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_NODE_EXECUTABLE: electron,
    PATH: `${nodeBin}${delimiter}${scratch}`, TMP: scratch, TEMP: scratch, TMPDIR: scratch,
  })
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({
    name: 'packaged-pnpm-probe', private: true, scripts: { probe: 'node -e "console.log(process.versions.node)"' },
  }))
  const run = args => {
    const result = spawnSync(electron, ['--expose-internals', cli, ...args], {
      env, cwd: scratch, encoding: 'utf8', windowsHide: true, timeout: 20000,
    })
    if (result.error) throw result.error
    assert.equal(result.status, 0, result.stderr + result.stdout)
    return result.stdout.trim()
  }
  assert.equal(run(['--version']), manifest.dependencies.pnpm)
  assert.ok(['http:', 'https:'].includes(new URL(run(['config', 'get', 'registry'])).protocol))
  assert.match(run(['run', 'probe']), /\d+\.\d+\.\d+/)
  assert.ok(existsSync(join(resources, 'server', 'package-manager.mjs')))
  console.log(`PASS packaged pnpm ${pmManifest.version}: version, registry and node scripts without system tools (${process.platform}/${process.arch})`)
} finally {
  if (!resolve(scratch).startsWith(resolve(tempRoot) + sep)) throw new Error('Unsafe cleanup path')
  rmSync(scratch, { recursive: true, force: true })
}
