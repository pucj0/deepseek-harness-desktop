const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [__filename], { cwd: resolve(__dirname, '..'), env, stdio: 'inherit', timeout: 30_000, windowsHide: true })
  process.exit(result.status ?? 1)
}
const { app, BrowserWindow } = require('electron')
const { openUpdateWindow } = require('../dist/main/update-window')
const directory = mkdtempSync(join(tmpdir(), 'dsh-update-window-test-'))
app.setPath('userData', directory); app.disableHardwareAcceleration()
const strings = {
  title: 'Updates', checking: 'Checking GitHub Releases…', stateLatest: 'The application is up to date',
  stateAvailable: 'Available', stateUnknown: 'Unavailable', installedLabel: 'Current version', latestLabel: 'Latest version',
  buttonClose: 'Close', buttonDownload: 'Download update', progress: 'Downloading update… {percent}%',
  buttonDownloading: 'Downloading {percent}%…',
}
async function run() {
  await app.whenReady()
  const parent = new BrowserWindow({ show: false }); const actions = []
  const panel = openUpdateWindow(parent, directory, strings, (action) => actions.push(action)); panel.window.hide()
  await new Promise((resolve) => panel.window.webContents.once('did-finish-load', resolve))
  panel.update({ installed: '1.7.0', latest: '1.8.0', state: 'available', canInstall: true })
  await new Promise((resolve) => setTimeout(resolve, 100))
  let state = await panel.window.webContents.executeJavaScript(`({
    installed: document.getElementById('installed').textContent,
    latest: document.getElementById('latest').textContent,
    button: document.getElementById('btn-download').textContent,
    hidden: document.getElementById('btn-download').hidden
  })`)
  assert.deepEqual(state, { installed: '1.7.0', latest: '1.8.0', button: 'Download update', hidden: false })
  await panel.window.webContents.executeJavaScript(`document.getElementById('btn-download').click()`)
  await new Promise((resolve) => setTimeout(resolve, 50)); assert.deepEqual(actions, ['download'])
  panel.update({ installed: '1.7.0', latest: '1.8.0', state: 'available', canInstall: true, progress: 42 })
  await new Promise((resolve) => setTimeout(resolve, 50))
  state = await panel.window.webContents.executeJavaScript(`({ button: document.getElementById('btn-download').textContent, width: document.getElementById('progress-bar').style.width })`)
  assert.deepEqual(state, { button: 'Downloading 42%…', width: '42%' })
  console.log('PASS GitHub-only update window and download progress')
}
run().then(() => finish(0), (error) => { console.error(error); finish(1) })
function finish(code) {
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  try { rmSync(directory, { recursive: true, force: true }) } catch {}
  app.exit(code)
}
