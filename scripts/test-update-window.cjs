// 更新窗口的 UI 契约：两条轨道、Desktop 下载进度、Runtime 的**应用内直装**按钮。
//
// 首次运行时它会用 Electron 重新拉起自己（`ELECTRON_RUN_AS_NODE` 去掉，走真正的
// 渲染进程），这样才能真的点按钮、真的读 DOM。
//
// 这一版新增的三件事都在这里被钉住：
//   1. Runtime 有新版且有直装能力时，轨道里出现「安装 Runtime 并重启」；
//   2. 点它回传 `runtime-install`；
//   3. 安装中按钮变成"正在安装…"、状态徽章同文案、进度文本显示 npm 的日志行，且此时
//      **不再显示** Release 备用按钮（同一件事不留两个入口）。
//
// 另外用几何断言挡住"按钮溢出 520px 窗口"这类只会在中文长文案下出现的问题。
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  // `--no-sandbox --disable-gpu` **不是可选的美化**：在某些宿主（例如受限沙箱里的 Windows）
  // 加上它们才能起来，否则进程以 Windows 状态 `0x80000003` 直接结束、没有任何 stdout/stderr，
  // 看起来像"测试被跳过"。本文件另一处（`test-update-window-layout.mjs`）也用同一组参数，
  // 那里已经实测量出过真实布局。
  const result = spawnSync(require('electron'), ['--no-sandbox', '--disable-gpu', __filename], { cwd: resolve(__dirname, '..'), env, stdio: 'inherit', timeout: 60_000, windowsHide: true })
  if (result.error !== undefined && result.error !== null && result.stdout === null) {
    console.error(`无法启动 Electron：${String(result.error)}`)
  }
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
  sectionDesktop: 'Desktop App · project GitHub', sectionRuntime: 'Harness Runtime · official GitHub',
  runtimeBundledNote: 'Bundled with Desktop', runtimeAvailableNote: 'Runtime {version} is available',
  buttonRuntimeRelease: 'Open Runtime Release',
  buttonRuntimeInstall: 'Install Runtime and Restart',
  runtimeInstalling: 'Installing runtime…',
  runtimeProgress: 'npm: {line}',
}
const runtimeAvailable = {
  installed: '0.1.7-rc.2', latest: '0.2.0-rc.1', state: 'available',
  releaseUrl: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.1',
}
const desktopAvailable = { installed: '1.7.0', latest: '1.8.0', state: 'available' }
const read = (panel, expression) => panel.window.webContents.executeJavaScript(expression)

async function run() {
  await app.whenReady()
  const parent = new BrowserWindow({ show: false }); const actions = []
  const panel = openUpdateWindow(parent, directory, strings, (action) => actions.push(action)); panel.window.hide()
  await new Promise((resolve) => panel.window.webContents.once('did-finish-load', resolve))

  // ---------------------------------------------------- 1. Runtime 可直装 ----
  panel.update({ desktop: desktopAvailable, runtime: runtimeAvailable, canInstall: true, canInstallRuntime: true, runtimeInstalling: false })
  await new Promise((resolve) => setTimeout(resolve, 120))
  let state = await read(panel, `({
    installed: document.getElementById('desktop-installed').textContent,
    latest: document.getElementById('desktop-latest').textContent,
    runtimeInstalled: document.getElementById('runtime-installed').textContent,
    runtimeLatest: document.getElementById('runtime-latest').textContent,
    runtimeNote: document.getElementById('runtime-note').textContent,
    button: document.getElementById('btn-download').textContent,
    hidden: document.getElementById('btn-download').hidden,
    runtimeButton: document.getElementById('btn-runtime-install').textContent,
    runtimeHidden: document.getElementById('btn-runtime-install').hidden,
    runtimeDisabled: document.getElementById('btn-runtime-install').disabled,
    releaseHidden: document.getElementById('btn-runtime-release').hidden,
    progressHidden: document.getElementById('runtime-install-progress').hidden,
  })`)
  assert.deepEqual(state, {
    installed: '1.7.0', latest: '1.8.0', runtimeInstalled: '0.1.7-rc.2', runtimeLatest: '0.2.0-rc.1',
    runtimeNote: 'Runtime 0.2.0-rc.1 is available', button: 'Download update', hidden: false,
    runtimeButton: 'Install Runtime and Restart', runtimeHidden: false, runtimeDisabled: false,
    // 能直装时 Release 只是备用入口，不再显示。
    releaseHidden: true, progressHidden: true,
  })

  await read(panel, `document.getElementById('btn-runtime-install').click()`)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.deepEqual(actions, ['runtime-install'])

  // ---------------------------------------------------- 2. 安装中状态 ----
  panel.update({ desktop: desktopAvailable, runtime: runtimeAvailable, canInstall: true, canInstallRuntime: true, runtimeInstalling: true, runtimeProgress: 'npm http fetch GET 200 https://registry.npmmirror.com/@deepseek-ai%2fdsh' })
  await new Promise((resolve) => setTimeout(resolve, 120))
  state = await read(panel, `({
    runtimeButton: document.getElementById('btn-runtime-install').textContent,
    runtimeDisabled: document.getElementById('btn-runtime-install').disabled,
    status: document.getElementById('runtime-status').textContent,
    progress: document.getElementById('runtime-install-progress').textContent,
    progressHidden: document.getElementById('runtime-install-progress').hidden,
    releaseHidden: document.getElementById('btn-runtime-release').hidden,
    downloadHidden: document.getElementById('btn-download').hidden,
  })`)
  assert.deepEqual(state, {
    runtimeButton: 'Installing runtime…', runtimeDisabled: true, status: 'Installing runtime…',
    progress: 'npm: npm http fetch GET 200 https://registry.npmmirror.com/@deepseek-ai%2fdsh', progressHidden: false,
    releaseHidden: true,
    // 互斥：Runtime 安装期间不能同时下载 Desktop 安装包。
    downloadHidden: true,
  })

  // ------------------------------------- 3. 中文长文案下按钮不得溢出 520px ----
  // 用真实的中文文案渲染一遍并量几何：`track` 行与页脚按钮都必须落在窗口宽度之内。
  const zhStrings = {
    ...strings,
    buttonRuntimeInstall: '安装 Runtime 并重启',
    runtimeInstalling: '正在安装 Runtime…',
    buttonDownload: '下载更新',
    buttonClose: '关闭',
    buttonRuntimeRelease: '打开 Runtime Release',
  }
  const zhPanel = openUpdateWindow(parent, directory, zhStrings, () => {}); zhPanel.window.hide()
  await new Promise((resolve) => zhPanel.window.webContents.once('did-finish-load', resolve))
  zhPanel.update({ desktop: desktopAvailable, runtime: runtimeAvailable, canInstall: true, canInstallRuntime: true, runtimeInstalling: false })
  await new Promise((resolve) => setTimeout(resolve, 120))
  const geometry = await read(zhPanel, `(() => {
    const width = document.documentElement.clientWidth;
    const boxes = [...document.querySelectorAll('footer button'), document.getElementById('btn-runtime-install')]
      .map((node) => ({ id: node.id, right: Math.round(node.getBoundingClientRect().right), left: Math.round(node.getBoundingClientRect().left) }));
    return { width, boxes, scrollWidth: document.documentElement.scrollWidth };
  })()`)
  // 窗口宽度是 560（见 update-window.ts 的注释：这个尺寸是按"三种状态都不出滚动条"量出来的），
  // 减去两边的滚动条/边框就是客户端宽度。
  assert.equal(geometry.width, 544)
  for (const box of geometry.boxes) {
    assert.ok(box.left >= 0 && box.right <= geometry.width, `${box.id} must stay inside the window (${JSON.stringify(geometry)})`)
  }
  // 页面本身也不能出现横向滚动条（那同样意味着有东西溢出）。
  assert.equal(geometry.scrollWidth, 544, `no horizontal overflow expected (${JSON.stringify(geometry)})`)

  // ------------------------------- 4. 不能直装时显示 Release 备用入口 ----
  const releaseOnly = openUpdateWindow(parent, directory, strings, () => {}); releaseOnly.window.hide()
  await new Promise((resolve) => releaseOnly.window.webContents.once('did-finish-load', resolve))
  releaseOnly.update({ desktop: desktopAvailable, runtime: runtimeAvailable, canInstall: true, canInstallRuntime: false, runtimeInstalling: false })
  await new Promise((resolve) => setTimeout(resolve, 120))
  state = await read(releaseOnly, `({
    runtimeHidden: document.getElementById('btn-runtime-install').hidden,
    releaseHidden: document.getElementById('btn-runtime-release').hidden,
  })`)
  assert.deepEqual(state, { runtimeHidden: true, releaseHidden: false })

  // ---------------------------------------------------- 5. Desktop 进度 ----
  panel.update({ desktop: desktopAvailable, runtime: runtimeAvailable, canInstall: true, canInstallRuntime: true, runtimeInstalling: false, progress: 42 })
  await new Promise((resolve) => setTimeout(resolve, 80))
  state = await read(panel, `({ button: document.getElementById('btn-download').textContent, width: document.getElementById('progress-bar').style.width })`)
  assert.deepEqual(state, { button: 'Downloading 42%…', width: '42%' })

  console.log('PASS dual GitHub update window, Runtime install button/state/progress and 544px layout')
}
run().then(() => finish(0), (error) => { console.error(error); finish(1) })
function finish(code) {
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  try { rmSync(directory, { recursive: true, force: true }) } catch {}
  app.exit(code)
}
