// Exercise the actual sandboxed Electron window and the staged server.
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve, sep } = require('node:path')

if (!process.versions.electron) {
  const reports = []
  for (const disabled of ['1', '0']) {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-startup-test-'))
    try {
      const env = { ...process.env, DSH_STARTUP_TEST_HOME: directory, DSH_DESKTOP_DISABLE_STARTUP_CACHE: disabled }
      delete env.ELECTRON_RUN_AS_NODE
      const result = spawnSync(require('electron'), [__filename], {
        cwd: resolve(__dirname, '..'), env, encoding: 'utf8', timeout: 90000, windowsHide: true,
      })
      process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '')
      if (result.error) throw result.error
      assert.equal(result.status, 0)
      const report = result.stdout.split(/\r?\n/u).find(line => line.startsWith('STARTUP_ERRORS '))
      assert(report, 'renderer error report is missing')
      reports.push(JSON.parse(report.slice('STARTUP_ERRORS '.length)))
    } finally {
      if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe cleanup path')
      rmSync(directory, { recursive: true, force: true })
    }
  }
  assert.deepEqual(reports[1], reports[0], 'startup cache introduced renderer errors')
  console.log(`PASS no new renderer errors compared with the official implementation (${reports[0].length} existing errors)`)
  process.exit(0)
}

const { app } = require('electron')
const { createMainWindow } = require('../dist/main/window')
const { DshServer } = require('../dist/main/dsh-server')
const scratch = process.env.DSH_STARTUP_TEST_HOME
assert(scratch)
const workspace = join(scratch, 'workspace'); mkdirSync(workspace)
app.setPath('userData', scratch)
app.disableHardwareAcceleration()
let mainWindow, server
async function expect(label, predicate) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (await predicate()) { console.log(`PASS ${label}`); return }
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
  }
  assert.fail(label)
}
async function run() {
  await app.whenReady()
  mainWindow = createMainWindow({ userDataDir: scratch, splashTitle: 'Startup test', splashHint: 'Starting' })
  const { window } = mainWindow
  // The window's own document is the custom title bar (+ splash); the Harness UI lives in a
  // child view below it. Splash progress belongs to the shell page, app assertions to the view.
  const shell = window.webContents
  const contents = mainWindow.appContents
  // Keep automated checks from stealing focus; the renderer still paints normally.
  window.show = () => {}
  const shellErrors = []
  const errors = []
  shell.on('console-message', (_event, level, message) => { if (level >= 3) shellErrors.push(message) })
  contents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
  let loads = 0
  shell.on('did-finish-load', () => { loads++ })
  const text = () => shell.executeJavaScript("document.getElementById('startup-hint')?.textContent")
  mainWindow.setSplashHint('Progress before first load')
  await expect('progress arriving before load is retained', async () => await text() === 'Progress before first load')
  for (let percent = 0; percent <= 100; percent++) mainWindow.setSplashHint(`Unpacking ${percent}%`)
  await expect('progress reaches 100 without reloading the document', async () => await text() === 'Unpacking 100%')
  assert.equal(loads, 1)
  mainWindow.setGitBadge('test-branch')
  assert.equal(window.getTitle(), 'DeepSeek Harness — test-branch')
  console.log('PASS late Git badge updates the native title')

  const runtime = resolve(__dirname, '../runtime')
  const nodeBinary = join(runtime, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
  server = new DshServer({
    runtime: { dir: runtime, installAnchor: join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), serverEntry: resolve(__dirname, '../src/server/server.mjs'), serverRunEntry: join(runtime, 'server.mjs'), nodeBinary, packaged: false },
    dshHome: join(scratch, 'home'), workspace,
  })
  const ready = await server.start()
  const navigation = mainWindow.navigate(ready)
  mainWindow.setSplashHint('Late progress must not replace the app')
  await navigation
  await expect('real Web UI mounts after authenticated navigation', () => contents.executeJavaScript(
    "document.getElementById('startup-hint') === null && !!window.__DSH_BOOT__ && document.body.innerText.trim().length > 50",
  ))
  await expect('add workspace control is available on a fresh profile', () => contents.executeJavaScript(
    `[...document.querySelectorAll('button')].some(button => /^(添加工作区|Add workspace)$/i.test(button.getAttribute('aria-label') || button.getAttribute('title') || ''))`,
  ))
  assert.equal(errors.some(message => /single slot .*already has a registration/.test(message)), false,
    'duplicate single-slot registration breaks the workspace directory picker')
  assert.equal(new URL(contents.getURL()).origin, ready.url)
  assert.equal(window.getTitle(), 'DeepSeek Harness — test-branch')
  assert.deepEqual(shellErrors, [], 'the custom title bar page must not log renderer errors')
  console.log('STARTUP_ERRORS ' + JSON.stringify(errors.sort()))
  console.log('PASS authenticated UI and late-progress navigation guard')
}
run().then(async () => {
  await server?.stop(1000); mainWindow?.close(); app.exit(0)
}).catch(async error => {
  console.error(error); await server?.stop(1000); mainWindow?.close(); app.exit(1)
})
