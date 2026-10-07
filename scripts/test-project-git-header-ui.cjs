const assert = require('node:assert/strict')
const { spawnSync, execFileSync } = require('node:child_process')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve, sep } = require('node:path')

if (!process.versions.electron) {
  const result = spawnSync(require('electron'), [__filename], {
    cwd: resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true, timeout: 180000,
  })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  if (result.error) throw result.error
  if (result.status !== 0) console.error(`Electron test process exited with status ${result.status}`)
  process.exit(result.status === 0 ? 0 : 1)
}

const { app } = require('electron')
const { DshServer } = require('../dist/main/dsh-server')
const { createMainWindow } = require('../dist/main/window')
const { resolveRuntime } = require('../dist/main/paths')
const root = resolve(__dirname, '..')
const scratch = mkdtempSync(join(tmpdir(), 'dsh-git-header-'))
const workspace = join(scratch, 'header-project')
mkdirSync(workspace)
execFileSync('git', ['init', '-q', workspace], { windowsHide: true })
writeFileSync(join(workspace, 'header-fixture.txt'), 'untracked fixture\n')
app.setPath('userData', scratch)
app.disableHardwareAcceleration()
let server
let mainWindow
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(expression) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const value = await mainWindow.appContents.executeJavaScript(expression).catch(() => false)
    if (value) return value
    await wait(200)
  }
  throw new Error(`UI did not reach: ${expression}`)
}

async function run() {
  await app.whenReady()
  mainWindow = createMainWindow({ userDataDir: scratch, splashTitle: 'Git header test', splashHint: 'Starting' })
  mainWindow.window.show()
  const errors = []
  mainWindow.appContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
  server = new DshServer({
    runtime: resolveRuntime(scratch), dshHome: join(scratch, 'home'), workspace,
    registerWorkspace: true, bundledPluginsDir: join(root, 'plugins'),
  })
  await mainWindow.navigate(await server.start())
  await until('Boolean(document.querySelector("[data-project-git-open]"))')
  const bounds = await mainWindow.appContents.executeJavaScript(`(() => {
    const button = document.querySelector('[data-project-git-open]');
    const box = button.getBoundingClientRect();
    return { top: box.top, right: box.right, width: box.width, viewport: innerWidth,
      visible: getComputedStyle(button).visibility, inCorner: !!button.closest('[data-conversation-header-corner]'),
      generic: !!document.querySelector('[data-project-sidebar-toggle]') };
  })()`)
  assert.equal(bounds.inCorner, true)
  assert.equal(bounds.generic, true)
  assert.equal(bounds.visible, 'visible')
  assert.ok(bounds.width > 0 && bounds.viewport - bounds.right < 90 && bounds.top < 100, JSON.stringify(bounds))
  console.log(`PASS Git icon is visible in the actual blank-session header corner: ${JSON.stringify(bounds)}`)

  await mainWindow.appContents.executeJavaScript('document.querySelector("[data-project-git-open]").click()')
  await until('window.__dshDesktopGitOpen?.opened && window.__dshDesktopReview?.isExpanded()')
  await until('Boolean(document.querySelector("[data-review-git-surface=sidebar]"))')
  const current = await mainWindow.appContents.executeJavaScript('window.__dshDesktopReview.active()?.kind')
  assert.equal(current, 'git')
  await until('document.body.innerText.includes("header-fixture.txt")')
  await mainWindow.appContents.executeJavaScript('document.querySelector("[data-project-git-open]").click()')
  assert.equal(await mainWindow.appContents.executeJavaScript('window.__dshDesktopReview.isExpanded()'), true)
  console.log('PASS clicking the header icon opens current-project Git and repeated clicks keep it expanded')
  assert.deepEqual(errors.filter((message) => /already has a registration|Minified React error|not authorized|undeclared/.test(message)), [])
  mkdirSync(join(root, 'probe'), { recursive: true })
  writeFileSync(join(root, 'probe', 'git-header.png'), (await mainWindow.appContents.capturePage()).toPNG())
  console.log('PASS real slot registration and React rendering; screenshot saved to probe/git-header.png')
}

run().then(() => finish(0), (error) => { console.error(error); return finish(1) })
async function finish(code) {
  try {
    await server?.stop(2000)
    mainWindow?.close()
    if (!resolve(scratch).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe cleanup path')
    rmSync(scratch, { recursive: true, force: true })
  } catch (error) { console.warn(String(error)) }
  app.exit(code)
}
