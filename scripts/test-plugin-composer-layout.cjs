// Real Electron + official Harness renderer. Uses disposable profiles and a
// disposable Git repository; no model requests or user sessions are touched.
const assert = require('node:assert/strict')
const { execFileSync, spawn } = require('node:child_process')
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const root = resolve(__dirname, '..')

if (!process.versions.electron) {
  execFileSync(process.execPath, [join(root, 'scripts', 'pack-ui-plugins.mjs')], { stdio: 'inherit' })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), ['--no-sandbox', __filename], { env, stdio: 'inherit', windowsHide: true })
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1 }, 180000)
  child.on('error', error => { console.error(error); clearTimeout(timer); process.exitCode = 1 })
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code === 0 ? 0 : 1 })
  return
}

const { app, BrowserWindow } = require('electron')
app.on('window-all-closed', () => {})
const { DshServer } = require('../dist/main/dsh-server')
mkdirSync(join(root, '.tmp'), { recursive: true })
const scratch = mkdtempSync(join(root, '.tmp', 'composer-layout-'))
const repo = join(scratch, 'composer-fixture')
mkdirSync(repo)
const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
git(['init', '-q', '-b', 'main'])
git(['config', 'user.name', 'Composer Test'])
git(['config', 'user.email', 'composer-test@example.com'])
git(['config', 'commit.gpgsign', 'false'])
writeFileSync(join(repo, 'file.txt'), 'fixture\n')
git(['add', '.'])
git(['commit', '-q', '-m', 'fixture'])
mkdirSync(join(scratch, 'electron'))
mkdirSync(join(scratch, 'temp'))
process.env.TEMP = join(scratch, 'temp')
process.env.TMP = join(scratch, 'temp')
app.setPath('userData', join(scratch, 'electron'))
app.disableHardwareAcceleration()
const runtimeDir = join(root, 'runtime')
const anchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
let server
let window
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function until(expression, accept, label, timeout = 45000) {
  let value
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    value = await window.webContents.executeJavaScript(expression).catch(error => ({ error: String(error) }))
    if (accept(value)) return value
    await wait(200)
  }
  throw new Error(`${label}: ${JSON.stringify(value)}`)
}

async function run() {
  await app.whenReady()
  const requireRuntime = createRequire(anchor)
  const { runPluginCommand } = await import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/dsh-plugin-manager/operations')).href)
  for (const names of [['review'], ['review', 'gitbar']]) {
    const home = join(scratch, names.join('-'))
    const profile = join(home, 'profiles', 'desktop')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', private: true, dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' } } }))
    writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')
    const archives = names.map(name => {
      const pkg = JSON.parse(readFileSync(join(root, 'plugins', `dsh-client-ui-${name}`, 'package.json'), 'utf8'))
      return join(root, 'release', 'plugins', `${pkg.name}-${pkg.version}.tgz`)
    })
    const installed = await runPluginCommand({ profile: 'desktop', dir: profile, home, installAnchor: anchor, cwd: root }, [
      'add', ...archives, '--offline', '--ignore-scripts', '--config.auto-install-peers=false', `--store-dir=${join(scratch, 'store')}`,
    ], { command: process.execPath, args: [join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')],
      env: { ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home }, execution: 'service', outputBytes: 16384, idleTimeoutMs: 30000, lookupTimeoutMs: 3000 })
    assert.equal(installed.exitCode, 0, installed.output)
    server = new DshServer({ runtime: { dir: runtimeDir, installAnchor: anchor,
      serverEntry: join(root, 'src', 'server', 'server.mjs'), serverRunEntry: join(runtimeDir, 'server.mjs'), packaged: false },
      dshHome: home, workspace: repo, registerWorkspace: true, bundledPluginsDir: join(root, 'plugins'),
      env: { DSH_DESKTOP_DEFAULT_PLUGINS: '0', DSH_TELEMETRY_DISABLED: '1' }, readyTimeoutMs: 60000 })
    server.on('log', ({ line }) => { if (line.includes('fatal:')) console.error(line) })
    await server.start()
    window = new BrowserWindow({ width: 1536, height: 960, show: false, webPreferences: { contextIsolation: true, sandbox: true } })
    const errors = []
    window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
    await window.loadURL(server.ready.authenticatedUrl)
    await until(`(() => {
      const row = [...document.querySelectorAll('[class*="projectRow"]')].find(n => n.innerText.includes('composer-fixture'));
      if (!row) return false;
      const buttons = row.querySelectorAll('button');
      buttons[buttons.length - 1]?.click();
      return true;
    })()`, Boolean, 'create fixture session')
    await until(`document.querySelectorAll('[data-review-turn-chip]').length`, n => n === 1, 'one review chip')
    const screenshotDir = join(root, 'release', 'plugins')
    for (const [width, height] of [[1536, 960], [800, 700], [420, 780]]) {
      window.setSize(width, height)
      await wait(400)
      const geometry = await window.webContents.executeJavaScript(`(() => {
        const chip = document.querySelector('[data-review-turn-chip]');
        const row = document.querySelector('[data-desktop-context-bar]') || document.querySelector('[data-review-composer-dock]');
        const branch = document.querySelector('[data-desktop-branch-trigger]');
        const rect = n => { const r = n?.getBoundingClientRect(); return r && {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; };
        return {chip:rect(chip),row:rect(row),branch:rect(branch),parent:chip?.closest('[data-desktop-context-bar]') !== null,
          count:document.querySelectorAll('[data-review-turn-chip]').length,standalone:document.querySelectorAll('[data-review-composer-dock]').length,viewport:innerWidth};
      })()`)
      assert.equal(geometry.count, 1)
      assert.ok(geometry.chip.width < 300, JSON.stringify(geometry))
      assert.ok(geometry.row.width <= geometry.viewport, JSON.stringify(geometry))
      assert.ok(geometry.chip.x >= geometry.row.x && geometry.chip.right <= geometry.row.right + 1, JSON.stringify(geometry))
      if (names.includes('gitbar')) {
        assert.ok(geometry.parent)
        assert.equal(geometry.standalone, 0)
        if (width >= 800) assert.ok(Math.abs(geometry.chip.y - geometry.branch.y) <= 3, JSON.stringify(geometry))
      } else assert.equal(geometry.standalone, 1)
      const image = await window.webContents.capturePage()
      writeFileSync(join(screenshotDir, `composer-${names.join('-')}-${width}.png`), image.toPNG())
      console.log(`PASS real Harness composer ${names.join(' + ')} ${width}px: chip ${Math.round(geometry.chip.width)}px, row ${Math.round(geometry.row.width)}px`)
    }
    assert.ok(!errors.some(error => /slots|INACTIVE_EFFECT|TypeError|ReferenceError/u.test(error)), errors.join('\n'))
    window.destroy()
    window = undefined
    await server.stop(2000)
    server = undefined
  }
}

run().then(() => app.exit(0)).catch(async error => {
  console.error(error)
  window?.destroy()
  await server?.stop(2000)
  app.exit(1)
}).finally(() => {
  try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch {}
})
