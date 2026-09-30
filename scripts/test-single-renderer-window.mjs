// 单 renderer 架构（真实 Electron）：**窗口自身的 webContents 就是 Harness 页面**。
//
//   node scripts/test-single-renderer-window.mjs
//
// 为什么必须用真实 Electron：这条需求整条都是关于"窗口里有几个文档、几个布局上下文"的，
// DOM 桩只能验证我们想验证的那部分。这里起真实的打包 host（Electron Node 模式跑
// `app.asar/runtime/server.mjs`），再起一个真实窗口加载 Host 宣布的带 token 的 URL，
// 然后：
//
//   * 断言 **Harness 官方界面真的在那个窗口里渲染出来**（侧栏 / 输入区 / 标题）；
//   * 断言它出现在**窗口自身的 webContents** 里，而不是任何子视图——探针直接打印
//     `window.contentView.children.length` 与 `appContents === window.webContents`；
//   * 截图存档，供最终报告里给出"打包版看起来是什么样"的证据。
//
// 这个测试跑在打包产物上，因此需要先 `npx electron-builder --win --x64 --dir`。找不到
// 产物时它会打印 SKIP 并以 0 退出（CI 上没有打包步骤时不该假装失败）。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const ROOT = resolve(import.meta.dirname, '..')
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const UNPACKED = join(ROOT, 'release', version, 'win-unpacked')
const RESOURCES = join(UNPACKED, 'resources')
const EXE = join(UNPACKED, 'dsh-desktop.exe')
const ASAR = join(RESOURCES, 'app.asar')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const TMP = join(ROOT, '.tmp')
const WORK = join(TMP, 'single-renderer')
const HOME = join(WORK, 'home')
const OUT = join(WORK, 'out')
const EUD = join(WORK, 'eud')
const PORT = 9788

if (process.env.DSH_SKIP_PACKAGED === '1' || !existsSync(EXE) || !existsSync(ASAR)) {
  console.log(`SKIP 单 renderer 架构测试：需要打包产物（${EXE}）。`)
  console.log('     先跑：npx electron-builder --win --x64 --dir --config.win.signAndEditExecutable=false')
  process.exit(0)
}

let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `（期望 ${expected}）`}`)
}
const has = (label, ok) => check(label, ok === true, true)

console.log('=== 单 renderer 架构（真实 Electron + 真实 Host）===')
rmSync(WORK, { recursive: true, force: true })
mkdirSync(join(HOME, 'ws'), { recursive: true })
mkdirSync(OUT, { recursive: true })

const baseEnv = { ...process.env, DSH_DESKTOP_HOME: HOME, TMP, TEMP: TMP }
delete baseEnv.ELECTRON_RUN_AS_NODE

// ---- 1. 起 host -------------------------------------------------------------------
console.log('  起 host（app.asar/runtime/server.mjs）…')
const host = spawn(
  EXE,
  [
    join(ASAR, 'runtime', 'server.mjs'),
    '--max-http-header-size=1048576',
    '--dsh-home',
    HOME,
    '--install-anchor',
    join(ASAR, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    '--bundled-plugins-dir',
    join(RESOURCES, 'plugins'),
    '--workspace',
    join(HOME, 'ws'),
  ],
  { env: { ...baseEnv, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
)
let hostOutput = ''
host.stdout.on('data', (c) => { hostOutput += String(c) })
host.stderr.on('data', (c) => { hostOutput += String(c) })

let authenticatedUrl
for (let i = 0; i < 300; i += 1) {
  await sleep(500)
  const match = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-zA-Z._-]+)/u.exec(hostOutput)
  if (match !== null) {
    authenticatedUrl = match[1]
    break
  }
}
if (authenticatedUrl === undefined) {
  failures += 1
  console.log('  FAIL  host 没有宣布 URL')
  console.log(hostOutput.split('\n').filter((l) => l.trim() !== '').slice(-10).join('\n'))
  host.kill('SIGKILL')
  process.exit(1)
}
console.log(`  host ready: ${authenticatedUrl.replace(/token=[^&]*/u, 'token=<hidden>')}`)

// ---- 2. 真实窗口：走 createMainWindow（= 产品代码路径）----------------------------
//
// 探针**不自己 new BrowserWindow**：它 `require('../dist/main/window.js')` 调
// `createMainWindow()`，因此被测的就是真正在用的那条路径——包括"单 renderer 下
// appContents 就是 window.webContents"这个决定。
const probeDir = join(TMP, 'single-renderer-probe')
mkdirSync(probeDir, { recursive: true })
const probePath = join(probeDir, 'main.cjs')
// 探针脚本用**它自己的源文件**生成，字符串里绝不出现反引号：这个文件本身是 ESM，外层
// 用模板字符串包一段含模板字符串的 CJS 会直接语法错误（踩过）。
writeFileSync(
  probePath,
  [
    "const { app } = require('electron')",
    "const { mkdirSync, writeFileSync } = require('node:fs')",
    "const { join } = require('node:path')",
    "const { createMainWindow } = require(process.env.DSH_PROBE_WINDOW)",
    'const out = process.env.DSH_PROBE_OUT',
    'mkdirSync(out, { recursive: true })',
    "const log = (m) => writeFileSync(join(out, 'probe.txt'), String(m) + '\\n', { flag: 'a' })",
    'app.disableHardwareAcceleration()',
    'app.whenReady().then(async () => {',
    '  const handle = createMainWindow({',
    '    userDataDir: process.env.DSH_PROBE_HOME,',
    "    splashTitle: 'DeepSeek Harness',",
    "    splashHint: '正在启动 Harness…',",
    '    menu: { entries: () => [], open: () => false, revision: () => 0 },',
    '  })',
    "  log('created single-renderer=' + String(handle.appContents === handle.window.webContents))",
    "  log('contentViewChildren=' + handle.window.contentView.children.length)",
    "  log('title=' + JSON.stringify(handle.window.getTitle()))",
    '  try {',
    '    await handle.navigate({ url: process.env.DSH_PROBE_URL, authenticatedUrl: process.env.DSH_PROBE_URL, port: 0 })',
    "    log('navigated ok')",
    '  } catch (error) {',
    "    log('navigate FAILED ' + String(error && error.message ? error.message : error))",
    '    app.exit(1)',
    '    return',
    '  }',
    "  log('done')",
    '  // ---- 关闭 → 隐藏（而不是销毁），再 show 回来：这个 document 必须原样还在 ----',
    '  //',
    '  // 这是"关闭窗口 = 藏起来"这条需求的实测：托盘/二次启动把窗口 show 回来时**不能**是',
    '  // 重新加载的页面（那会丢掉正在跑的会话与滚动位置），也不能是重启过的 Host。',
    '  const { installCloseToTray } = require(process.env.DSH_PROBE_TRAY)',
    '  installCloseToTray(handle.window, () => true)',
    "  await handle.window.webContents.executeJavaScript(\"globalThis.__DSH_WARM_MARK = 'kept'\", true)",
    '  const beforeUrl = handle.window.webContents.getURL().replace(/token=[^&]*/u, \'token=<hidden>\')',
    '  handle.window.close()',
    '  await new Promise((r) => setTimeout(r, 800))',
    "  log('afterClose destroyed=' + handle.window.isDestroyed() + ' visible=' + handle.window.isVisible())",
    '  handle.window.show()',
    '  await new Promise((r) => setTimeout(r, 800))',
    "  const mark = await handle.window.webContents.executeJavaScript('String(globalThis.__DSH_WARM_MARK)', true)",
    "  const afterUrl = handle.window.webContents.getURL().replace(/token=[^&]*/u, 'token=<hidden>')",
    "  log('warm mark=' + mark + ' urlSame=' + String(beforeUrl === afterUrl) + ' visible=' + handle.window.isVisible())",
    '  // 留一段时间给外部（CDP）量 DOM 与截图：**别在 navigate 一结束就退出**，否则窗口',
    '  // 已经销毁，量到的是空的。Page.captureScreenshot 在无 GPU 的远程调试下会报',
    '  // UnknownVizError，所以截图改由主进程的 capturePage() 做。',
    '  setTimeout(async () => {',
    '    try {',
    '      const image = await handle.window.capturePage()',
    '      if (!image.isEmpty()) {',
    "        writeFileSync(join(out, 'window.png'), image.toPNG())",
    "        log('shot ' + image.getSize().width + 'x' + image.getSize().height)",
    '      } else {',
    "        log('shot empty')",
    '      }',
    '    } catch (error) {',
    "      log('shot FAILED ' + String(error && error.message ? error.message : error))",
    '    }',
    '  }, 12000)',
    '  setTimeout(() => app.exit(0), 30000)',
    '})',
    '',
  ].join('\n'),
)

console.log('  起真实窗口（createMainWindow）…')
const win = spawn(ELECTRON, [
  '--no-sandbox',
  '--disable-gpu',
  `--user-data-dir=${EUD}`,
  `--remote-debugging-port=${PORT}`,
  probePath,
], {
  env: {
    ...baseEnv,
    DSH_PROBE_WINDOW: join(ROOT, 'dist', 'main', 'window.js'),
    DSH_PROBE_TRAY: join(ROOT, 'dist', 'main', 'tray.js'),
    DSH_PROBE_OUT: OUT,
    DSH_PROBE_HOME: HOME,
    DSH_PROBE_URL: authenticatedUrl,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let winErr = ''
win.stderr.on('data', (c) => { winErr += String(c) })

for (let i = 0; i < 90; i += 1) {
  await sleep(500)
  if (existsSync(join(OUT, 'probe.txt')) && readFileSync(join(OUT, 'probe.txt'), 'utf8').includes('shot ')) break
}
const probeLog = existsSync(join(OUT, 'probe.txt')) ? readFileSync(join(OUT, 'probe.txt'), 'utf8') : ''
console.log(`  探针：${probeLog.trim().split('\n').join(' | ')}`)
if (!probeLog.includes('done')) {
  failures += 1
  console.log(`  FAIL  窗口没有走到 done。stderr: ${winErr.split('\n').filter((l) => l.trim() !== '').slice(-4).join(' / ')}`)
}

// ---- 3. 在**那个窗口**里量 DOM ---------------------------------------------------
console.log('')
console.log('=== 窗口内容（CDP 直连同一个渲染进程）===')
let measured
for (let attempt = 0; attempt < 40; attempt += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const page = list.find((t) => t.type === 'page' && /127\.0\.0\.1:\d+/u.test(String(t.url)))
    if (page === undefined) throw new Error('还没有页面')
    const socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((r, j) => {
      socket.addEventListener('open', r)
      socket.addEventListener('error', () => j(new Error('ws error')))
    })
    let nextId = 1
    const pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const entry = pending.get(message.id)
      if (entry !== undefined) {
        pending.delete(message.id)
        entry(message.result?.result?.value)
      }
    })
    const send = (method, params) =>
      new Promise((done) => {
        const id = nextId++
        pending.set(id, done)
        socket.send(JSON.stringify({ id, method, params }))
        setTimeout(() => done(undefined), 15000)
      })
    const answer = await send('Runtime.evaluate', {
      expression: `(() => JSON.stringify({
        href: location.href.replace(/token=[^&]*/u, 'token=<hidden>'),
        title: document.title,
        bodyChildren: document.body === null ? 0 : document.body.children.length,
        hasSidebar: document.querySelector('aside, [class*=sidebar], [class*=Sidebar]') !== null,
        hasComposer: document.querySelector('textarea, [contenteditable=true]') !== null,
        hasDesktopBridge: typeof globalThis.dshDesktop === 'object',
        bodyText: (document.body === null ? '' : document.body.innerText).replace(/\\s+/gu, ' ').slice(0, 160)
      }))()`,
      returnByValue: true,
      awaitPromise: true,
    })
    // 截图（窗口真的画出来了才有；远程调试下偶发失败不算断言失败）。
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    if (typeof shot === 'string' && shot !== '') {
      writeFileSync(join(OUT, 'window.png'), Buffer.from(shot, 'base64'))
    }
    socket.close()
    if (typeof answer === 'string' && answer !== '') {
      measured = JSON.parse(answer)
      if (measured.hasSidebar && measured.hasComposer) break
    }
  } catch (error) {
    if (attempt === 39) console.log(`  量取失败：${String(error.message ?? error)}`)
  }
  await sleep(1000)
}

if (measured === undefined) {
  failures += 1
  console.log('  FAIL  没有量到窗口内容')
} else {
  console.log(`  INFO  ${JSON.stringify(measured)}`)
  check('窗口加载的是 Host 的 loopback 地址', /^http:\/\/127\.0\.0\.1:\d+\/$/u.test(measured.href), true)
  check('页面标题是 Harness 自己的', measured.title, 'DeepSeek Harness')
  has('Harness 侧栏渲染在这个窗口里', measured.hasSidebar)
  has('Harness 输入区渲染在这个窗口里', measured.hasComposer)
  has('theme/workspace/locale 桥注入在同一个渲染进程里', measured.hasDesktopBridge)
  has('页面有实际内容（不是启动底板）', measured.bodyText.length > 20)
}

// ---- 4. 结构断言：单 renderer、没有子视图、没有外壳文档 --------------------------
console.log('')
console.log('=== 结构（探针从主进程读的真实值）===')
const line = (name) => probeLog.split('\n').find((l) => l.startsWith(name)) ?? ''
check('appContents === window.webContents（单 renderer）', line('created '), 'created single-renderer=true')
check('窗口没有任何子 WebContentsView', line('contentViewChildren='), 'contentViewChildren=0')
has('探针确认 navigate 成功', probeLog.includes('navigated ok'))

// ---- 5. 关闭 → 隐藏 → show 回来（同一个 document）--------------------------------
console.log('')
console.log('=== 关闭/重开（warm reopen）===')
check('关闭窗口不会销毁它', line('afterClose '), 'afterClose destroyed=false visible=false')
has('关闭后窗口已隐藏', line('afterClose ').includes('visible=false'))
check('show 回来仍是同一个 document（标记还在、URL 未变）', line('warm '), 'warm mark=kept urlSame=true visible=true')

for (const child of [win, host]) {
  try {
    child.kill('SIGKILL')
  } catch {
    // 已退出
  }
}
await sleep(1000)
rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })

console.log('')
if (failures > 0) {
  console.error(`单 renderer 架构测试失败：${failures} 项`)
  process.exit(1)
}
console.log(`单 renderer 架构通过：Harness 官方界面渲染在窗口自身的 webContents 里，没有子视图`)
console.log(`关闭 = 隐藏，show 回来仍是同一个 document（Host 与页面都没重启）`)
if (existsSync(join(OUT, 'window.png'))) console.log(`截图：${join(OUT, 'window.png')}`)
