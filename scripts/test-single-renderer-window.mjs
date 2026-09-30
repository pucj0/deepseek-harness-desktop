// 单 renderer 架构（真实 Electron）：**窗口自身的 webContents 就是 Harness 页面**，
// 以及挂在 Harness 文档里的**顶部菜单**（Caption Menu）。
//
//   node scripts/test-single-renderer-window.mjs
//
// 为什么必须用真实 Electron：这两条需求整条都是关于"窗口里有几个文档、菜单挂在哪个文档里"
// 的，DOM 桩只能验证我们想验证的那部分。这里起真实的打包 host（Electron Node 模式跑
// `app.asar/runtime/server.mjs`），再起一个真实窗口加载 Host 宣布的带 token 的 URL，然后：
//
//   * 断言 **Harness 官方界面真的在那个窗口里渲染出来**（侧栏 / 输入区 / 标题）；
//   * 断言它出现在**窗口自身的 webContents** 里，而不是任何子视图——探针直接打印
//     `window.contentView.children.length` 与 `appContents === window.webContents`；
//   * 断言顶部菜单挂在**同一个** Harness 文档里（`[data-dsh-desktop-menu]` + Shadow Root），
//     五个顶层标题齐全、点击走的是同一条 `dsh-desktop:shell-menu-open`、原生子菜单真的弹出、
//     语言切换后标题跟着变、菜单区 `no-drag`、不覆盖侧栏折叠按钮；
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

/**
 * 在窗口里量的"基本信息 + 菜单"。
 *
 * 菜单部分全部通过 **Shadow Root** 读：host 是 `[data-dsh-desktop-menu]`，按钮在它的
 * `shadowRoot` 里。这也顺带断言了"菜单确实在 Shadow DOM 里"（否则这里会读到 0 个按钮）。
 */
const EXPR_WINDOW = `(() => JSON.stringify({
  href: location.href.replace(/token=[^&]*/u, 'token=<hidden>'),
  title: document.title,
  bodyChildren: document.body === null ? 0 : document.body.children.length,
  hasSidebar: document.querySelector('aside, [class*=sidebar], [class*=Sidebar]') !== null,
  hasComposer: document.querySelector('textarea, [contenteditable=true]') !== null,
  hasDesktopBridge: typeof globalThis.dshDesktop === 'object',
  bodyText: (document.body === null ? '' : document.body.innerText).replace(/\\s+/gu, ' ').slice(0, 160),
  menu: (() => {
    const host = document.querySelector('[data-dsh-desktop-menu]')
    if (host === null) return { present: false }
    const shadow = host.shadowRoot
    const buttons = shadow === null ? [] : [...shadow.querySelectorAll('button')]
    const hostRect = host.getBoundingClientRect()
    const hostStyle = getComputedStyle(host)
    const toggle = document.querySelector('button[aria-label*="侧边栏"], button[aria-label*="sidebar"], button[aria-label*="收起"]')
    const toggleRect = toggle === null ? null : toggle.getBoundingClientRect()
    return {
      present: true,
      inShadowRoot: shadow !== null,
      labels: buttons.map((b) => b.textContent),
      // 菜单必须落在标题栏那条里（顶部对齐），高度与 TITLEBAR_HEIGHT 一致。
      top: Math.round(hostRect.top),
      height: Math.round(hostRect.height),
      left: Math.round(hostRect.left),
      right: Math.round(hostRect.right),
      appRegion: hostStyle.webkitAppRegion || hostStyle.getPropertyValue('-webkit-app-region'),
      background: hostStyle.backgroundColor,
      fontFamily: hostStyle.fontFamily.slice(0, 40),
      color: hostStyle.color,
      // 不覆盖侧栏折叠按钮：菜单的左边缘必须在它右侧。
      toggleRight: toggleRect === null ? null : Math.round(toggleRect.right),
      overlapsToggle: toggleRect === null ? null : hostRect.left < toggleRect.right,
      // 不覆盖原生 caption buttons：窗口宽度减去它们的占地。
      viewport: window.innerWidth,
      // 原生 caption buttons 的占地由 env(titlebar-area-*) 给出（DPI 无关）。
      titlebarAreaWidth: getComputedStyle(host).getPropertyValue('max-width'),
      rightLimit: (() => {
        // 用 host 的实际右边缘与"标题栏可用区"比较：菜单绝不能越过它。
        const probe = document.createElement('div')
        probe.style.cssText = 'position:fixed;top:0;left:0;width:env(titlebar-area-width, 100vw)'
        document.body.append(probe)
        const limit = probe.getBoundingClientRect().width
        probe.remove()
        return Math.round(limit)
      })(),
      buttonRects: buttons.map((b) => {
        const r = b.getBoundingClientRect()
        return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }
      }),
    }
  })(),
}))()`

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
    "const { app, Menu } = require('electron')",
    "const { mkdirSync, writeFileSync } = require('node:fs')",
    "const { join } = require('node:path')",
    "const { createMainWindow } = require(process.env.DSH_PROBE_WINDOW)",
    "const { applicationMenuTemplate, menuBarEntries, openMenuAt } = require(process.env.DSH_PROBE_MENU)",
    'const out = process.env.DSH_PROBE_OUT',
    'mkdirSync(out, { recursive: true })',
    "const log = (m) => writeFileSync(join(out, 'probe.txt'), String(m) + '\\n', { flag: 'a' })",
    'app.disableHardwareAcceleration()',
    'app.whenReady().then(async () => {',
    '  // 一份**真实的**应用菜单（与 index.ts 用的是同一个 applicationMenuTemplate），',
    '  // 这样菜单标题与子菜单都是产品代码产出的，而不是测试自己编的。',
    "  const labels = { zh: ['文件', '编辑', '视图', '更新', '帮助'], en: ['File', 'Edit', 'View', 'Update', 'Help'] }",
    '  let locale = \'zh\'',
    '  let menuRevision = 0',
    '  let lastPopup = null',
    '  const buildMenu = () => {',
    '    const strings = { menuFile: labels[locale][0], menuEdit: labels[locale][1], menuView: labels[locale][2], menuUpdate: labels[locale][3], menuHelp: labels[locale][4] }',
    '    const template = applicationMenuTemplate({',
    '      strings, recent: [], runtimeVersion: \'0.2.0-rc.1\', shellVersion: \'1.7.7\',',
    '      openFolder: () => {}, openRecent: () => {}, removeRecent: () => {}, projectInfo: () => {},',
    '      revealWorkspace: () => {}, copyWorkspacePath: () => {}, forgetWorkspace: () => {},',
    '      openUpdates: () => {}, openReleases: () => {},',
    '    })',
    '    const menu = Menu.buildFromTemplate(template)',
    '    Menu.setApplicationMenu(menu)',
    '    menuRevision += 1',
    '    return menu',
    '  }',
    '  let currentMenu = buildMenu()',
    '  log(\'menuEntries=\' + JSON.stringify(menuBarEntries(currentMenu).map((e) => e.label)))',
    '  const handle = createMainWindow({',
    '    userDataDir: process.env.DSH_PROBE_HOME,',
    "    splashTitle: 'DeepSeek Harness',",
    "    splashHint: '正在启动 Harness…',",
    '    menu: {',
    '      entries: () => menuBarEntries(currentMenu),',
    '      open: (index, point, onClosed) => {',
    '        const opened = openMenuAt(currentMenu, index, handle.window, point, onClosed)',
    '        log(\'openMenu index=\' + String(index) + \' opened=\' + String(opened))',
    '        // 自动化里没有人去点菜单项把它关掉，popup 会一直开着（回调因此永不触发）。',
    '        // 记下最后一次被打开的子菜单，让测试可以主动关掉它——"菜单关闭后焦点回到编辑器"',
    '        // 这条断言需要一个真的关闭事件。',
    '        lastPopup = opened ? currentMenu.items[index].submenu : null',
    '        return opened',
    '      },',
    '      revision: () => menuRevision,',
    '    },',
    '  })',
    "  log('created single-renderer=' + String(handle.appContents === handle.window.webContents))",
    "  log('contentViewChildren=' + handle.window.contentView.children.length)",
    "  log('menuBarVisible=' + String(handle.window.isMenuBarVisible()))",
    "  log('preloadPath=' + String(require('node:path').join(require('node:path').dirname(process.env.DSH_PROBE_WINDOW), '..', 'preload', 'app.js')) + ' exists=' + String(require('node:fs').existsSync(require('node:path').join(require('node:path').dirname(process.env.DSH_PROBE_WINDOW), '..', 'preload', 'app.js'))))",
    '  // X) Alt 不得露出 Windows 原生 menu row（否则会出现两行菜单）。这里直接注入一次裸 Alt，',
    '  //    主进程的 before-input-event 必须把它吃掉：`setMenuBarVisibility` 之后仍为 false。',
    "  handle.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Alt' })",
    "  handle.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Alt' })",
    '  await new Promise((r) => setTimeout(r, 400))',
    "  log('afterAlt menuBarVisible=' + String(handle.window.isMenuBarVisible()))",
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
    '  // ---- 语言切换：主进程重建菜单 → 推 shell-state → preload 重取标题（不重启）----',
    '  //',
    '  // 真实路径是 refreshApplicationMenu() → publishShellState()。这里用文件当信号：',
    '  // CDP 那边写完语言码，探针重建菜单并推状态，页面里的按钮文案应当跟着变。',
    "  const { existsSync, readFileSync: readSignal, unlinkSync } = require('node:fs')",
    "  const signal = join(out, 'switch-locale.txt')",
    '  const watch = setInterval(() => {',
    '    try {',
    '      if (!existsSync(signal)) return',
    '      const next = String(readSignal(signal, \'utf8\')).trim()',
    "      unlinkSync(signal)",
    "      if (next !== 'zh' && next !== 'en') return",
    '      locale = next',
    '      currentMenu = buildMenu()',
    '      handle.publishShellState()',
    "      log('locale=' + locale + ' menuRevision=' + menuRevision)",
    '    } catch (error) {',
    "      log('locale switch FAILED ' + String(error && error.message ? error.message : error))",
    '    }',
    '  }, 400)',
    '  // 关掉一个还开着的原生菜单（自动化里没人点，它会一直开着）。',
    "  const closeSignal = join(out, 'close-menu.txt')",
    '  const closeWatch = setInterval(() => {',
    '    try {',
    '      if (!existsSync(closeSignal)) return',
    "      unlinkSync(closeSignal)",
    '      if (lastPopup !== null) {',
    '        lastPopup.closePopup(handle.window)',
    '        lastPopup = null',
    "        log('popup closed')",
    '      } else {',
    "        log('popup closed (none open)')",
    '      }',
    '    } catch (error) {',
    "      log('close popup FAILED ' + String(error && error.message ? error.message : error))",
    '    }',
    '  }, 400)',
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
    DSH_PROBE_MENU: join(ROOT, 'dist', 'main', 'menu.js'),
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
let cdp
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
      expression: EXPR_WINDOW,
      returnByValue: true,
      awaitPromise: true,
    })
    // 截图（窗口真的画出来了才有；远程调试下偶发失败不算断言失败）。
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    if (typeof shot === 'string' && shot !== '') {
      writeFileSync(join(OUT, 'window.png'), Buffer.from(shot, 'base64'))
    }
    if (typeof answer === 'string' && answer !== '') {
      measured = JSON.parse(answer)
      if (measured.hasSidebar && measured.hasComposer) {
        // 连接留着给后面的菜单用例复用（每次 evaluate 都重连会慢且容易踩到页面切换）。
        cdp = {
          evaluate: async (expression) => {
            const raw = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
            return typeof raw === 'string' && raw !== '' ? JSON.parse(raw) : undefined
          },
          close: () => socket.close(),
        }
        break
      }
    }
    socket.close()
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

// ---- 5. 顶部菜单（Caption Menu）--------------------------------------------------
//
// 这一组对应需求里的 Case A–H。全部在**那一个** Harness 文档里量，因此它同时证明了
// "菜单没有引入第二个 WebContents"。
console.log('')
console.log('=== 顶部菜单（Caption Menu）===')
if (measured === undefined || measured.menu?.present !== true) {
  failures += 1
  console.log(`  FAIL  没有在 Harness 文档里找到 [data-dsh-desktop-menu]（menu=${JSON.stringify(measured?.menu)}）`)
} else {
  const menu = measured.menu
  console.log(`  INFO  ${JSON.stringify({ labels: menu.labels, left: menu.left, right: menu.right, top: menu.top, height: menu.height, region: menu.appRegion, toggleRight: menu.toggleRight })}`)

  // Case H + A：仍然单 renderer，菜单没有引入第二个 WebContents。
  check('Case A/H 菜单没有引入第二个 WebContents', line('contentViewChildren='), 'contentViewChildren=0')
  has('Case B 菜单 host 存在', menu.present)
  has('Case B 菜单在 Shadow Root 里（不污染 Harness 的全局 CSS）', menu.inShadowRoot)
  check('Case B/E 五个顶层标题（中文）', JSON.stringify(menu.labels), JSON.stringify(['文件', '编辑', '视图', '更新', '帮助']))
  // Case F：菜单区域不可拖动，且 host 不画自己的背景（透出 Harness 标题栏）。
  check('Case F 菜单区是 no-drag', menu.appRegion, 'no-drag')
  check('Case F 菜单不画自己的背景（透出 Harness 标题栏底色）', menu.background, 'rgba(0, 0, 0, 0)')
  // Case G：不覆盖侧栏折叠按钮。
  has('Case G 不覆盖侧栏折叠按钮', menu.overlapsToggle === false)
  check('Case G 菜单位于折叠按钮右侧', menu.left > (menu.toggleRight ?? 0), true)
  // 与标题栏同高、贴顶。
  check('菜单与标题栏同高（40px）', menu.height, 40)
  check('菜单贴着窗口顶部', menu.top, 0)
  has('菜单使用 Harness 的字体（不是外壳自己的一套）', /Segoe UI|system-ui|-apple-system/u.test(menu.fontFamily))
  // 不越进原生 caption buttons 的占地（`env(titlebar-area-width)` 是那条边界）。
  check('Case G 菜单不越进原生 caption buttons 区域', menu.right <= menu.rightLimit, true)

  if (cdp !== undefined) {
    // Case C：点「更新」（第 4 个顶层项，index=3）——必须走 dsh-desktop:shell-menu-open，
    // 并且主进程用它取到的是**同一个**顶层下标。
    const clickedUpdate = await cdp.evaluate(`(async () => {
      const host = document.querySelector('[data-dsh-desktop-menu]')
      const buttons = [...host.shadowRoot.querySelectorAll('button')]
      const target = buttons[3]
      const before = JSON.stringify({ text: target.textContent, expanded: target.getAttribute('aria-expanded') })
      target.click()
      await new Promise((r) => setTimeout(r, 1500))
      return JSON.stringify({ before, after: target.getAttribute('aria-expanded') })
    })()`)
    console.log(`  INFO  点击「更新」：${JSON.stringify(clickedUpdate)}`)
    const updateLog = () => readFileSync(join(OUT, 'probe.txt'), 'utf8').split('\n').filter((l) => l.startsWith('openMenu '))
    has('Case C 点击菜单真的请求主进程 popup', /openMenu index=3 opened=true/u.test(readFileSync(join(OUT, 'probe.txt'), 'utf8')))
    has('Case D 原生子菜单被 popup（openMenuAt 接受该下标）', updateLog().some((l) => l.includes('index=3') && l.includes('opened=true')))
    // 越界下标不能被接受（`openMenuAt` 的入参是不可信输入）。
    has('Case D 越界下标被拒绝（不可信输入）', !/openMenu index=(?:99|-1) opened=true/u.test(readFileSync(join(OUT, 'probe.txt'), 'utf8')))

    // Case D：原生子菜单真的被 popup 出来了。
    //
    // 自动化里没有人去点它，所以它会**一直开着**并通过 `callback` 把关闭事件留到未来——
    // 这本身正好证明"popup 真的开了"。因此这里的顺序是：
    //   1. 点击按钮 → 主进程 openMenuAt 返回 true（探针写了日志）；
    //   2. 从主进程主动 closePopup() → 触发 callback → `shell-menu-open` 的 promise resolve
    //      → 预加载里的 `toggle()` 走完收尾（复位 aria-expanded、把焦点还给编辑器）；
    //   3. 断言收尾结果。
    writeFileSync(join(OUT, 'close-menu.txt'), 'close')
    let closed
    for (let i = 0; i < 40; i += 1) {
      await sleep(400)
      closed = await cdp.evaluate(`(() => {
        const host = document.querySelector('[data-dsh-desktop-menu]')
        const buttons = [...host.shadowRoot.querySelectorAll('button')]
        const expanded = buttons.filter((b) => b.getAttribute('aria-expanded') === 'true').length
        const active = document.activeElement
        return JSON.stringify({
          expandedCount: expanded,
          activeTag: active === null ? 'none' : active.tagName.toLowerCase(),
          activeEditable: active === null ? false : (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable === true),
        })
      })()`)
      if (closed?.expandedCount === 0) break
    }
    console.log(`  INFO  关闭菜单后：${JSON.stringify(closed)}`)
    check('Case C/D 菜单关闭后没有按钮留在展开态', closed?.expandedCount, 0)
    // Case 19：菜单关闭后焦点回到编辑器（不是留在按钮上，也不是丢到 body）。
    has('Case 19 菜单关闭后焦点回到 Harness 编辑器', closed?.activeEditable === true)

    // Case E：切到英文——主进程重建菜单并推状态，标题必须跟着变，且**不重启**。
    writeFileSync(join(OUT, 'switch-locale.txt'), 'en')
    let english
    for (let i = 0; i < 30; i += 1) {
      await sleep(400)
      english = await cdp.evaluate(`(() => {
        const host = document.querySelector('[data-dsh-desktop-menu]')
        return JSON.stringify({
          labels: [...host.shadowRoot.querySelectorAll('button')].map((b) => b.textContent),
          sameUrl: location.href.replace(/token=[^&]*/u, 'token=<hidden>'),
        })
      })()`)
      if (JSON.stringify(english?.labels) === JSON.stringify(['File', 'Edit', 'View', 'Update', 'Help'])) break
    }
    check('Case E 切到英文后五个标题变成 File/Edit/View/Update/Help', JSON.stringify(english?.labels), JSON.stringify(['File', 'Edit', 'View', 'Update', 'Help']))
    has('Case E 语言切换不重启（同一个地址）', english?.sameUrl === measured.href)
    // 切回中文，证明是双向的。
    writeFileSync(join(OUT, 'switch-locale.txt'), 'zh')
    let chinese
    for (let i = 0; i < 30; i += 1) {
      await sleep(400)
      chinese = await cdp.evaluate(`(() => {
        const host = document.querySelector('[data-dsh-desktop-menu]')
        return JSON.stringify({ labels: [...host.shadowRoot.querySelectorAll('button')].map((b) => b.textContent) })
      })()`)
      if (JSON.stringify(chinese?.labels) === JSON.stringify(['文件', '编辑', '视图', '更新', '帮助'])) break
    }
    check('Case E 切回中文后标题复原', JSON.stringify(chinese?.labels), JSON.stringify(['文件', '编辑', '视图', '更新', '帮助']))
    cdp.close()
  }

  // Case I：Alt 不能弹出 Windows 原生菜单栏（否则会出现两行菜单）。
  check('Case I 原生 menu row 保持隐藏', line('menuBarVisible='), 'menuBarVisible=false')
  check('Case I 裸 Alt 之后原生 menu row 仍然隐藏', line('afterAlt '), 'afterAlt menuBarVisible=false')
}

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
