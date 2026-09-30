// 更新窗口布局（真实 Electron）：**普通状态下一屏显示完，不出现滚动条**。
//
//   node scripts/test-update-window-layout.mjs
//
// 为什么必须用真实 Electron：这个要求是"像素级装得下"，桩渲染器量不出来，而用 DOM 桩
// 只能量到自己算出来的高度（那就是把假设当结论）。这个脚本启动一个隐藏的探针窗口，
// 在里面真正调用 `openUpdateWindow()`，打开页面，再用 CDP 读取真实的
// `scrollHeight` / `clientHeight`。
//
// 判据（这一条是本版修正过的）：**不是** `documentElement.scrollHeight` —— `panelCss()`
// 把 `body` 固定成 100% 高，所以文档本身永远不滚动；真正会滚的是内部那个 `main`
// （`overflow-y:auto`），右侧那条滚动条就来自它。因此断言：
//
//   main.scrollHeight <= main.clientHeight
//
// 三种状态都必须成立（中文那一份是最长文本，因此用中文口径量）：
//   1. 已是最新（只有说明，没有安装按钮）
//   2. 有可用更新（说明 + 「安装 Runtime 并重启」）
//   3. 安装中（说明 + 按钮 + 进度文本；npm 的 http 日志行很长，必须被省略号截住）
//
// 探针窗口用 `show()`（Electron 对隐藏窗口不做布局），但父窗口是隐藏的、窗口本身不抢焦点，
// 因此不会打断使用；跑完即退出。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const ROOT = resolve(import.meta.dirname, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PANEL_MODULE = join(ROOT, 'dist', 'main', 'update-window.js')

if (!existsSync(PANEL_MODULE)) {
  console.error('找不到 dist/main/update-window.js —— 先跑 npm run build')
  process.exit(1)
}
if (!existsSync(ELECTRON)) {
  console.error(`找不到 Electron 可执行文件：${ELECTRON}`)
  process.exit(1)
}

/** 探针主进程：打开真实的更新窗口并保持存活。**只在 .tmp 里生成**，跑完删掉。 */
const PROBE = `
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const { mkdirSync } = require('node:fs')
const { openUpdateWindow } = require(process.env.DSH_PROBE_PANEL)

const userDataDir = process.env.DSH_PROBE_HOME
mkdirSync(userDataDir, { recursive: true })
const strings = {
  title: 'Updates', checking: 'Checking GitHub Releases…', stateLatest: 'Up to date',
  stateAvailable: 'Available', stateUnknown: 'Unavailable', installedLabel: 'Current version',
  latestLabel: 'Latest version', buttonClose: 'Close', buttonDownload: 'Download update',
  progress: 'Downloading… {percent}%', buttonDownloading: 'Downloading {percent}%…',
  sectionDesktop: 'Desktop App · project GitHub', sectionRuntime: 'Harness Runtime · official GitHub',
  runtimeBundledNote: process.env.DSH_PROBE_NOTE,
  runtimeAvailableNote: 'Official runtime {version} is published.',
  buttonRuntimeRelease: 'Open Runtime Release', buttonRuntimeInstall: '安装 Runtime 并重启',
  runtimeInstalling: '正在安装 Runtime…', runtimeProgress: 'npm：{line}',
}
const state = process.env.DSH_PROBE_STATE
app.disableHardwareAcceleration()
app.whenReady().then(() => {
  const parent = new BrowserWindow({ show: false, width: 900, height: 700 })
  const panel = openUpdateWindow(parent, userDataDir, strings, () => {})
  // 让面板自己决定尺寸（不覆盖），这正是被测对象。
  panel.window.show()
  panel.update({
    desktop: { installed: '1.7.5', latest: '1.7.5', state: 'latest' },
    runtime: state === 'latest'
      ? { installed: '0.2.0-rc.2', latest: '0.2.0-rc.2', state: 'latest' }
      : { installed: '0.2.0-rc.1', latest: '0.2.0-rc.2', state: 'available', releaseUrl: 'https://example.invalid/x' },
    canInstall: false,
    canInstallRuntime: state !== 'latest',
    runtimeInstalling: state === 'installing',
    ...(state === 'installing'
      ? { runtimeProgress: 'npm http fetch GET 200 https://registry.npmmirror.com/@deepseek-ai%2fdsh 1234ms (cache miss)' }
      : {}),
  })
  process.stdout.write('PROBE_READY\\n')
})
`

/** 页面里要量的一组数。 */
const EXPR = `(() => {
  const de = document.documentElement
  const body = document.body
  const main = document.querySelector('main')
  const footer = document.querySelector('footer')
  const progress = document.getElementById('runtime-install-progress')
  const installButton = document.getElementById('btn-runtime-install')
  return JSON.stringify({
    pushedState: window.__lastState === undefined ? null : {
      runtime: window.__lastState.runtime === undefined ? null : window.__lastState.runtime.state,
      canInstallRuntime: window.__lastState.canInstallRuntime === true,
      runtimeInstalling: window.__lastState.runtimeInstalling === true,
    },
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    docScrollH: de.scrollHeight,
    docClientH: de.clientHeight,
    bodyScrollH: body.scrollHeight,
    bodyClientH: body.clientHeight,
    mainScrollH: main === null ? null : main.scrollHeight,
    mainClientH: main === null ? null : main.clientHeight,
    footerH: footer === null ? null : Math.round(footer.getBoundingClientRect().height),
    progressH: progress === null ? null : Math.round(progress.getBoundingClientRect().height),
    progressLines: progress === null ? null : Math.round(progress.getBoundingClientRect().height / parseFloat(getComputedStyle(progress).lineHeight || '18')),
    installVisible: installButton !== null && installButton.hidden === false,
    installHidden: installButton === null ? null : installButton.hidden,
    installDisabled: installButton === null ? null : installButton.disabled,
    releaseVisible: (() => { const n = document.getElementById('btn-runtime-release'); return n !== null && n.hidden === false })(),
    closeVisible: (() => { const n = document.getElementById('btn-close'); return n !== null && n.hidden === false })(),
    downloadVisible: (() => { const n = document.getElementById('btn-download'); return n !== null && n.hidden === false })(),
    installBottom: installButton === null || installButton.hidden ? null : Math.round(installButton.getBoundingClientRect().bottom),
    footerTop: footer === null ? null : Math.round(footer.getBoundingClientRect().top),
    clientW: de.clientWidth,
    scrollW: de.scrollWidth,
    bodyScrollW: body.scrollWidth,
  })
})()`

let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `（期望 ${expected}）`}`)
}
const has = (label, ok) => check(label, ok === true, true)

/**
 * 启动一次探针、量一次、退出。
 *
 * @param options - `{ state, note }`；`note` 是要放进"内置 Runtime 说明"的文本（用中文那一份，
 *   它是最长可变量）。
 * @returns 量到的数字，或 `{ error }`。
 */
async function measure({ state, note }) {
  // **home 必须落在工作区内**：`openPanel` 会把面板 HTML 写进 userData，而受限沙箱下
  // `os.tmpdir()`（`%LOCALAPPDATA%\Temp`）可能不可写，探针就会以 EPERM 卡在
  // "写不出 update.html"。工作区内的 `.tmp` 一定可写。
  const probeDir = join(ROOT, '.tmp', 'layout-probe')
  mkdirSync(probeDir, { recursive: true })
  const home = join(probeDir, 'home')
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  mkdirSync(home, { recursive: true })
  const probePath = join(probeDir, 'main.cjs')
  writeFileSync(probePath, PROBE)
  const port = 9600 + Math.floor(Math.random() * 300)
  const env = {
    ...process.env,
    DSH_PROBE_PANEL: PANEL_MODULE,
    DSH_PROBE_HOME: home,
    DSH_PROBE_NOTE: note,
    DSH_PROBE_STATE: state,
    TMP: join(ROOT, '.tmp'),
    TEMP: join(ROOT, '.tmp'),
  }
  delete env.ELECTRON_RUN_AS_NODE

  const child = spawn(ELECTRON, [
    '--no-sandbox',
    '--disable-gpu',
    `--user-data-dir=${join(ROOT, '.tmp', 'layout-eud')}`,
    `--remote-debugging-port=${port}`,
    probePath,
  ], { env, stdio: ['ignore', 'pipe', 'pipe'] })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })

  try {
    for (let i = 0; i < 80 && !stdout.includes('PROBE_READY'); i += 1) await sleep(250)
    if (!stdout.includes('PROBE_READY')) {
      return { error: `探针未就绪：${stderr.split('\n').filter((l) => l.trim() !== '').slice(0, 3).join(' / ')}` }
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        const page = list.find((target) => target.type === 'page' && String(target.url).includes('update.html'))
        if (page === undefined) throw new Error('还没有 update.html 页面')
        const socket = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((resolveOpen, rejectOpen) => {
          socket.addEventListener('open', resolveOpen)
          socket.addEventListener('error', () => rejectOpen(new Error('WebSocket 错误')))
        })
        const raw = await new Promise((resolveEval, rejectEval) => {
          socket.addEventListener('message', (event) => {
            const message = JSON.parse(event.data)
            if (message.id !== 1) return
            if (message.result?.exceptionDetails) rejectEval(new Error(message.result.exceptionDetails.text))
            else resolveEval(message.result?.result?.value)
          })
          socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: EXPR, returnByValue: true } }))
          setTimeout(() => rejectEval(new Error('求值超时')), 10_000)
        })
        socket.close()
        if (typeof raw !== 'string' || raw === '') throw new Error('求值结果不是字符串')
        const parsed = JSON.parse(raw)
        /**
         * 等页面真的收到我们推的那一份状态再量。
         *
         * `update()` 在页面 `did-finish-load` 之前调用时只会记在 `latestState` 里，页面加载完
         * 才 push——首帧量到的可能是"正在检查"，那时按钮还没出现，量出来的高度也就不是要断言
         * 的那个状态。条件不满足就重试，而不是把时序问题当布局问题。
         */
        if (parsed.pushedState?.runtime !== state && attempt < 19) {
          await sleep(400)
          continue
        }
        return parsed
      } catch (error) {
        if (attempt === 19) return { error: String(error.message ?? error) }
        await sleep(500)
      }
    }
    return { error: '未取到布局数据' }
  } finally {
    child.kill('SIGKILL')
    await sleep(400)
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // 句柄未释放不影响结论。
    }
  }
}

/** 与 i18n.ts 的中文 `updateRuntimeBundledNote` 对齐（最长的那一份文本）。 */
const NOTE_ZH = '内置的 Runtime 会随 Desktop Release 一起更新；官方有新版本时，也可以用自带的 npm 就地在应用内安装，你的电脑不需要 Node.js 或 npm。'

console.log('=== 更新窗口布局（真实 Electron + CDP） ===')
for (const state of ['latest', 'available', 'installing']) {
  const m = await measure({ state, note: NOTE_ZH })
  if (m.error !== undefined) {
    failures += 1
    console.log(`  FAIL  ${state}: ${m.error}`)
    continue
  }
  console.log(`  INFO  ${state}: inner=${m.innerW}x${m.innerH} main=${m.mainScrollH}/${m.mainClientH} footer=${m.footerH} progressH=${m.progressH} 安装按钮可见=${m.installVisible} Release按钮可见=${m.releaseVisible}`)

  // **核心断言**：内部滚动容器不滚动。
  check(`${state}) main.scrollHeight <= main.clientHeight`, m.mainScrollH <= m.mainClientH, true)
  // 文档本身也不滚（双保险）。
  check(`${state}) 文档不滚动`, m.docScrollH <= m.docClientH, true)
  check(`${state}) body 不滚动`, m.bodyScrollH <= m.bodyClientH, true)
  // 不出现横向滚动。
  check(`${state}) 没有横向溢出`, m.scrollW <= m.clientW && m.bodyScrollW <= m.clientW, true)
  // 底部动作永远在视口内（否则就是"按钮被推进滚动区"）。
  has(`${state}) 关闭按钮在视口内`, m.closeVisible)
  if (state === 'available' || state === 'installing') {
    has(`${state}) 安装按钮可见`, m.installVisible)
    check(`${state}) 安装按钮没有被推到页脚之下`, m.installBottom <= m.footerTop, true)
  }
  if (state === 'latest') {
    check(`${state}) 没有安装按钮（已是最新）`, m.installVisible, false)
    has(`${state}) 关闭按钮可见`, m.closeVisible)
  }
  if (state === 'installing') {
    // 进度文本必须是**一行**：npm 的 http 日志很长，撑成多行就会把面板顶出滚动条。
    check(`${state}) 进度文本只占一行`, m.progressLines <= 1, true)
  }
}

console.log('')
if (failures > 0) {
  console.error(`更新窗口布局回归失败：${failures} 项`)
  process.exit(1)
}
console.log('更新窗口在三种状态下都一屏显示完，没有滚动条')
