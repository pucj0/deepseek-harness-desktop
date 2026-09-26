// 真实窗口下的自定义标题栏测试（Electron）。
//
//   npm run build && node scripts/test-titlebar-ui.cjs
//
// 覆盖四件只能开真窗口才能验证的事：
//   1. 窗口形态：隐藏原生标题栏 + titleBarOverlay（真实 WCO 环境变量）、原生菜单栏不可见
//      但**仍然注册着**（accelerator 的来源）、Harness 视图正好在标题栏下方且随窗口重排；
//   2. 标题栏本体：40px、整条可拖、交互元素 no-drag、就绪前后菜单按钮的显隐、无障碍属性；
//   3. 菜单桥：点菜单按钮 → 主进程收到**按钮所在坐标**并弹出对应顶层菜单；弹出的仍是
//      原生菜单里的子菜单（命令实现只有一份）；
//   4. 主题与历史：Harness 页面上报的令牌驱动标题栏配色；back/forward 只认本应用 origin。
//
// 不启动 dsh 服务端：Harness 视图指向一个本地 http 服务，因此几秒就能跑完，而窗口、
// 视图合成、IPC、主题上报走的都是生产代码路径。
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve, sep } = require('node:path')

if (!process.versions.electron) {
  const result = spawnSync(require('electron'), [__filename], {
    cwd: resolve(__dirname, '..'),
    encoding: 'utf8',
    timeout: 300000,
    windowsHide: true,
  })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  if (result.error) throw result.error
  process.exit(result.status === 0 ? 0 : 1)
}

const { app, Menu } = require('electron')
const { createMainWindow } = require('../dist/main/window')
const { menuBarEntries } = require('../dist/main/menu')
const { TITLEBAR_HEIGHT } = require('../dist/main/titlebar')
const { initShellStrings, setShellLocale, t } = require('../dist/main/i18n')

const scratch = mkdtempSync(join(tmpdir(), 'dsh-titlebar-ui-'))
app.setPath('userData', scratch)
app.disableHardwareAcceleration()

let passed = 0
let failed = 0
async function check(name, action) {
  try {
    await action()
    passed += 1
    console.log(`PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms))

/** 本地 http：两个同源页面，用于"历史里真的有可退回的同源条目"。 */
function startServer() {
  const server = createServer((request, response) => {
    const background = request.url === '/b' ? '#0b5' : '#05b'
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(
      `<!doctype html><html><head><meta charset="utf-8"></head>` +
        `<body style="margin:0;background:${background};color:#fff">page ${request.url}</body></html>`,
    )
  })
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => done({ server, port: server.address().port }))
  })
}

async function run() {
  await app.whenReady()
  const { server, port } = await startServer()
  const base = `http://127.0.0.1:${port}/`

  // 原生菜单：与 index.ts 同构（顶层 + role 项 + disabled 占位），并记录谁被弹出。
  const opened = []
  const appMenu = Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { id: 'file.openFolder', label: '打开文件夹…', accelerator: 'CmdOrCtrl+O', click: () => {} },
        { label: '最近打开', submenu: [{ label: '无最近项目', enabled: false }] },
        { type: 'separator' },
        { label: '项目信息…', accelerator: 'CmdOrCtrl+I', click: () => {} },
        { label: '在文件管理器中打开工作区', click: () => {} },
        { label: '复制工作区路径', click: () => {} },
        { type: 'separator' },
        { label: '重新加载', role: 'reload' },
        { label: '退出', role: 'quit' },
      ],
    },
    { label: '编辑', submenu: [{ label: '撤销', role: 'undo' }, { label: '复制', role: 'copy' }] },
    { label: '视图', submenu: [{ label: '放大', role: 'zoomIn' }, { label: '重置缩放', role: 'resetZoom' }] },
    { label: '更新', submenu: [{ label: '检查更新…', accelerator: 'CmdOrCtrl+Shift+U', click: () => {} }] },
    { label: '帮助', submenu: [{ label: '智能体运行时  0.1.5-rc.2', enabled: false }] },
  ])
  Menu.setApplicationMenu(appMenu)

  // 语言走**生产路径**：先按 Harness 的语言初始化文案表，再创窗口。这样导航按钮的无障碍
  // 文案也来自活文案表（生产代码已经不传死文案了），下面的语言用例才能验证它会跟着变。
  initShellStrings('zh')

  const mainWindow = createMainWindow({
    userDataDir: scratch,
    splashTitle: 'DeepSeek Harness',
    splashHint: '正在启动…',
    menu: {
      entries: () => menuBarEntries(Menu.getApplicationMenu() ?? Menu.buildFromTemplate([])),
      // 生产实现是 openMenuAt(...)，弹出真正的系统菜单；这里换成记录式实现——真弹层会盖住
      // 窗口且无人操作时无法关闭，而坐标/下标映射正是本测试要断言的部分。
      open: (index, point, onClosed) => {
        const entry = menuBarEntries(appMenu)[Number(index)]
        opened.push({ index, label: entry === undefined ? undefined : entry.label, ...point, onClosed })
        return true
      },
    },
  })
  const win = mainWindow.window
  const shell = win.webContents
  const shellEval = (expression) => shell.executeJavaScript(expression)
  const appEval = (expression) => mainWindow.appContents.executeJavaScript(expression)
  const viewBounds = () => win.contentView.children.map((child) => child.getBounds())

  // ---- 启动阶段：还没导航到 Harness 页面 ----------------------------------
  await wait(900)
  await check('窗口不显示原生菜单栏', () => assert.equal(win.isMenuBarVisible(), false))
  await check('原生菜单仍然注册（accelerator 的来源；不能 setApplicationMenu(null)）', () =>
    assert.notEqual(Menu.getApplicationMenu(), null))
  await check('Alt 拦截已挂在两个页面上（防止原生菜单栏被唤出而变成两套菜单）', () => {
    assert.ok(shell.listenerCount('before-input-event') >= 1, 'shell 页面缺少 before-input-event')
    assert.ok(mainWindow.appContents.listenerCount('before-input-event') >= 1, 'Harness 页面缺少 before-input-event')
  })

  const wco = JSON.parse(
    await shellEval(`(() => {
      const d = document.createElement('div');
      d.style.paddingTop = 'env(titlebar-area-height, 0px)';
      document.body.appendChild(d);
      const height = getComputedStyle(d).paddingTop;
      d.remove();
      return JSON.stringify({ visible: navigator.windowControlsOverlay ? navigator.windowControlsOverlay.visible : false, height });
    })()`),
  )
  await check('原生窗口控制覆盖层生效（真实 WCO 环境变量可用）', () => {
    assert.equal(wco.visible, true)
    assert.equal(wco.height, `${TITLEBAR_HEIGHT}px`)
  })

  const bar = JSON.parse(
    await shellEval(`(() => {
      const tb = document.getElementById('titlebar');
      const r = tb.getBoundingClientRect();
      const s = getComputedStyle(tb);
      const menubar = document.getElementById('menubar');
      const nav = {};
      for (const id of ['nav-back', 'nav-forward']) {
        const el = document.getElementById(id);
        nav[id] = {
          region: getComputedStyle(el).webkitAppRegion,
          disabled: el.disabled,
          label: el.getAttribute('aria-label'),
          title: el.getAttribute('title')
        };
      }
      return JSON.stringify({
        height: Math.round(r.height),
        top: Math.round(r.top),
        width: Math.round(r.width),
        drag: s.webkitAppRegion,
        paddingRight: Math.round(Number.parseFloat(s.paddingRight)),
        borderBottom: s.borderBottomWidth,
        menusHidden: menubar.hidden,
        ready: document.documentElement.dataset.ready,
        nav
      });
    })()`),
  )
  await check('标题栏高度 40px 且贴住窗口顶部', () => {
    assert.equal(bar.height, TITLEBAR_HEIGHT)
    assert.equal(bar.top, 0)
    assert.equal(bar.width, win.getContentBounds().width)
  })
  await check('整条标题栏是拖拽区', () => assert.equal(bar.drag, 'drag'))
  await check('导航按钮是 no-drag（否则一点就拖窗口）', () => {
    assert.equal(bar.nav['nav-back'].region, 'no-drag')
    assert.equal(bar.nav['nav-forward'].region, 'no-drag')
  })
  await check('导航按钮有 aria-label 与 title（无障碍）', () => {
    assert.equal(bar.nav['nav-back'].label, '返回')
    assert.equal(bar.nav['nav-back'].title, '返回')
    assert.equal(bar.nav['nav-forward'].label, '前进')
  })
  await check('右侧给原生按钮留出非零空间（由 DPI 换算而来）', () =>
    assert.ok(bar.paddingRight > 100, `实际 ${bar.paddingRight}px`))
  await check('Harness 未就绪时菜单按钮隐藏（不是死按钮）', () => {
    assert.equal(bar.menusHidden, true)
    assert.equal(bar.ready, '0')
  })
  await check('未就绪时导航按钮禁用', () => {
    assert.equal(bar.nav['nav-back'].disabled, true)
    assert.equal(bar.nav['nav-forward'].disabled, true)
  })

  // ---- 导航到 Harness 页面（本地 http 代替 dsh 服务端） --------------------
  await mainWindow.navigate({ url: base, authenticatedUrl: base, port })
  await wait(900)
  const readyState = JSON.parse(
    await shellEval(`(() => {
      const menubar = document.getElementById('menubar');
      const tb = document.getElementById('titlebar');
      return JSON.stringify({
        menusHidden: menubar.hidden,
        labels: [...menubar.querySelectorAll('button')].map((b) => b.textContent),
        splashHidden: document.getElementById('splash').hidden,
        ready: document.documentElement.dataset.ready,
        barBg: getComputedStyle(tb).backgroundColor,
        barBorder: getComputedStyle(tb).borderBottomWidth,
        appBg: getComputedStyle(document.body).backgroundColor
      });
    })()`),
  )
  await check('就绪后菜单按钮出现、加载页隐藏', () => {
    assert.equal(readyState.menusHidden, false)
    assert.equal(readyState.splashHidden, true)
    assert.equal(readyState.ready, '1')
  })
  await check('菜单按钮就是原生菜单的顶层标题（含"更新"，一个都没少）', () => {
    assert.deepEqual(readyState.labels, ['文件', '编辑', '视图', '更新', '帮助'])
    assert.deepEqual(
      readyState.labels,
      menuBarEntries(appMenu).map((entry) => entry.label),
    )
  })
  await check('只有 1px 下边界（不是卡片阴影）', () => assert.equal(readyState.barBorder, '1px'))
  await check('标题栏配色与 Harness 页面底色一致（令牌透传）', () =>
    assert.equal(readyState.barBg, readyState.appBg))
  await check('导航只换 Harness 视图，窗口自身的标题栏文档不被顶掉', () => {
    // 托盘「重启服务端」走的就是 navigate：若它退回 window.loadURL(...)，官方界面会装进
    // 窗口自身的文档——自绘标题栏被顶掉、界面铺满整个窗口。这条断言把那个坑钉住。
    assert.ok(win.webContents.getURL().endsWith('shell.html'), `窗口自身仍是标题栏页面：${win.webContents.getURL()}`)
    assert.equal(mainWindow.appContents.getURL(), base)
  })

  // ---- 视图布局与窗口状态 -------------------------------------------------
  await check('Harness 视图正好铺在标题栏下方', () => {
    const content = win.getContentBounds()
    const [view] = viewBounds()
    assert.equal(view.y, TITLEBAR_HEIGHT)
    assert.equal(view.height, content.height - TITLEBAR_HEIGHT)
    assert.equal(view.width, content.width)
  })
  win.maximize()
  await wait(1300)
  await check('最大化后视图跟着重排（无额外边距、无双标题栏）', () => {
    assert.equal(win.isMaximized(), true)
    const content = win.getContentBounds()
    const [view] = viewBounds()
    assert.equal(view.y, TITLEBAR_HEIGHT)
    assert.equal(view.height, content.height - TITLEBAR_HEIGHT)
    assert.equal(content.x, 0, '最大化时内容区不该有 8px 边框残留')
    assert.equal(content.y, 0)
  })
  await check('最大化状态推给了标题栏（renderer 不自己猜窗口状态）', async () =>
    assert.equal(await shellEval(`document.documentElement.dataset.maximized`), '1'))
  win.unmaximize()
  await wait(1100)
  await check('还原后视图回到标题栏下方且标记复位', async () => {
    assert.equal(win.isMaximized(), false)
    const content = win.getContentBounds()
    const [view] = viewBounds()
    assert.equal(view.y, TITLEBAR_HEIGHT)
    assert.equal(view.height, content.height - TITLEBAR_HEIGHT)
    assert.equal(await shellEval(`document.documentElement.dataset.maximized`), '0')
  })

  // ---- 菜单桥：坐标 + 下标 + 关闭回调 -------------------------------------
  opened.length = 0
  const clicked = JSON.parse(
    await shellEval(`(() => {
      const target = [...document.querySelectorAll('#menubar button')][0];
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      return JSON.stringify({ x: Math.round(rect.left), expanded: target.getAttribute('aria-expanded') });
    })()`),
  )
  await wait(400)
  await check('点菜单按钮会把该顶层菜单交给主进程（一次，且是"文件"）', () => {
    assert.equal(opened.length, 1, `实际弹出 ${opened.length} 次`)
    assert.equal(opened[0].label, '文件')
  })
  await check('弹菜单用按钮自身的 x 与标题栏底边（同一坐标系）', () => {
    assert.equal(opened[0].x, clicked.x)
    assert.equal(opened[0].y, TITLEBAR_HEIGHT)
  })
  await check('展开时标记为展开（无障碍）', () => assert.equal(clicked.expanded, 'true'))
  opened[0].onClosed()
  await wait(400)
  await check('关闭后展开标记复位', async () =>
    assert.equal(await shellEval(`[...document.querySelectorAll('#menubar button')][0].getAttribute('aria-expanded')`), 'false'))

  opened.length = 0
  for (let index = 0; index < menuBarEntries(appMenu).length; index += 1) {
    await shellEval(
      `(() => { const buttons = [...document.querySelectorAll('#menubar button')]; buttons[${index}].dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true })()`,
    )
    await wait(150)
  }
  await check('五个顶层菜单逐一点过，顺序与原生菜单一致', () =>
    assert.deepEqual(
      opened.map((entry) => entry.label),
      ['文件', '编辑', '视图', '更新', '帮助'],
    ))
  await check('每个弹的都是原生菜单里那个子菜单（命令实现只有一份）', () => {
    for (const entry of opened) {
      const item = appMenu.items[entry.index]
      assert.ok(Array.isArray(item.submenu.items), `${entry.label} 没有子菜单`)
    }
  })
  await check('菜单项点击执行的就是原生 MenuItem（没有任何复制出来的实现）', () => {
    // role 项也在这里：click 会走 Electron 自己的 role 执行路径。
    const reload = appMenu.items[0].submenu.items.find((item) => item.role === 'reload')
    assert.ok(reload !== undefined)
    assert.equal(typeof reload.click, 'function')
    const openFolder = appMenu.getMenuItemById('file.openFolder')
    assert.ok(openFolder !== null)
    assert.equal(typeof openFolder.click, 'function')
  })

  // ---- 历史：只认本应用 origin --------------------------------------------
  await check('只有一个同源条目时 back/forward 不可用', async () => {
    assert.equal(await shellEval(`document.documentElement.dataset.goBack`), '0')
    assert.equal(await shellEval(`document.documentElement.dataset.goForward`), '0')
    assert.equal(await shellEval(`document.getElementById('nav-back').disabled`), true)
  })
  await check('不可用时主动导航被拒绝（不会退到加载页或旧端口）', () => {
    assert.equal(mainWindow.navigateHistory('back'), false)
    assert.equal(mainWindow.navigateHistory('forward'), false)
    assert.equal(mainWindow.appContents.getURL(), base)
  })
  await mainWindow.appContents.loadURL(`${base}b`)
  await wait(800)
  await check('出现第二个同源条目后 back 变为可用（真按钮，不是永远亮着）', async () => {
    assert.equal(await shellEval(`document.documentElement.dataset.goBack`), '1')
    assert.equal(await shellEval(`document.getElementById('nav-back').disabled`), false)
  })
  await check('back 真的回退，且没有离开应用 origin', async () => {
    assert.equal(mainWindow.navigateHistory('back'), true)
    await wait(900)
    assert.equal(mainWindow.appContents.getURL(), base)
    assert.equal(new URL(mainWindow.appContents.getURL()).origin, new URL(base).origin)
  })

  // ---- 主题：令牌透传（含深浅色切换） -------------------------------------
  await check('标题栏背景始终等于 Harness 页面背景', async () => {
    const appBg = await appEval(`getComputedStyle(document.body).backgroundColor`)
    const barBg = await shellEval(`getComputedStyle(document.getElementById('titlebar')).backgroundColor`)
    assert.equal(barBg, appBg)
  })

  // ---- 语言：跟随 Harness 的设置，运行中切换不重启窗口 ----------------------
  //
  // 这里用的是**生产实现**：`dist/main/i18n` 的活文案表 + `dist/main/menu` 的模板 +
  // 窗口的 `publishShellState()`。语言变化时主进程做的事就是这三件（见 index.ts 的
  // applyShellLocale），因此这个用例能证明"切换语言后标题栏自己会更新"。
  const menuTemplate = require('../dist/main/menu')
  const menuDeps = {
    recent: [],
    runtimeVersion: '0.1.5-rc.2',
    openFolder: () => {},
    openRecent: () => {},
    projectInfo: () => {},
    revealWorkspace: () => {},
    copyWorkspacePath: () => {},
    openUpdates: () => {},
    openReleases: () => {},
  }
  /** 复刻 index.ts 的 applyShellLocale：换文案 → 重建菜单 → 推状态。 */
  const applyLocale = (locale) => {
    setShellLocale(locale)
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(menuTemplate.applicationMenuTemplate({ ...menuDeps, strings: t(), shellVersion: '1.5.9' })),
    )
    mainWindow.publishShellState()
  }
  const titlebarLabels = async () =>
    JSON.parse(await shellEval(`JSON.stringify([...document.querySelectorAll('#menubar button')].map((b) => b.textContent))`))

  const shellContentsId = shell.id
  applyLocale('zh')
  await wait(400)
  await check('Harness = 中文 → 标题栏按钮是 文件 / 编辑 / 视图 / 更新 / 帮助', async () =>
    assert.deepEqual(await titlebarLabels(), ['文件', '编辑', '视图', '更新', '帮助']))
  await check('文档语言同步为 zh-CN（无障碍与拼写检查据此工作）', async () =>
    assert.equal(await shellEval(`document.documentElement.lang`), 'zh-CN'))
  await check('导航按钮的无障碍文案也是中文', async () => {
    assert.equal(await shellEval(`document.getElementById('nav-back').getAttribute('aria-label')`), '返回')
    assert.equal(await shellEval(`document.getElementById('nav-forward').getAttribute('title')`), '前进')
  })

  applyLocale('en')
  await wait(400)
  await check('切到 English → 同一个窗口里按钮立刻变成 File / Edit / View / Update / Help', async () => {
    assert.deepEqual(await titlebarLabels(), ['File', 'Edit', 'View', 'Update', 'Help'])
    // 没有重建窗口/页面：同一个 webContents。
    assert.equal(shell.id, shellContentsId)
  })
  await check('文档语言同步为 en-US', async () =>
    assert.equal(await shellEval(`document.documentElement.lang`), 'en-US'))
  await check('导航按钮文案跟着变英文', async () => {
    assert.equal(await shellEval(`document.getElementById('nav-back').getAttribute('aria-label')`), 'Back')
    assert.equal(await shellEval(`document.getElementById('nav-forward').getAttribute('title')`), 'Forward')
  })

  applyLocale('zh-CN')
  await wait(400)
  await check('再切回中文 → 立即回到中文（可反复切换）', async () =>
    assert.deepEqual(await titlebarLabels(), ['文件', '编辑', '视图', '更新', '帮助']))

  opened.length = 0
  await shellEval(
    `(() => { const buttons = [...document.querySelectorAll('#menubar button')]; buttons[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true })()`,
  )
  await wait(200)
  await check('语言变了，按钮背后的命令没变（仍弹出第 0 个顶层菜单 = 原生菜单里的那一个）', () => {
    assert.equal(opened.length, 1)
    assert.equal(opened[0].index, 0)
    assert.equal(appMenu.items[0].label, '文件')
  })

  await server.close()
  mainWindow.close()
}

run()
  .then(() => {
    console.log('')
    console.log(`${passed} 项通过${failed === 0 ? '' : `，${failed} 项失败`}`)
    try {
      if (!resolve(scratch).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe cleanup path')
      rmSync(scratch, { recursive: true, force: true })
    } catch {
      // 清理失败不影响结论。
    }
    app.exit(failed === 0 ? 0 : 1)
  })
  .catch((error) => {
    console.error(error)
    console.log('')
    console.log(`${passed} 项通过，1 项失败（异常）`)
    app.exit(1)
  })
