// **真实 Electron 冷启动**：Harness 设置里是中文时，窗口第一帧的菜单就必须是中文。
//
//   npm run build && node scripts/test-shell-cold-start.cjs
//
// 为什么必须是真窗口 + 真进程：
//   * 这一条 bug 只出现在"原生菜单 + 自绘标题栏"这条真实链路上。窗口创建的那一刻菜单如果
//     还没装，`Menu.getApplicationMenu()` 给出的是 **Electron 自己的默认菜单**——
//     `File / Edit / View / Window / Help`，其中那个 `Window` 是 Electron 加的、本产品**没有**
//     这一项。标题栏把这份默认菜单画了出来，而菜单随后被换成真正的应用菜单时又没有任何东西
//     通知页面，于是标题栏上永远挂着 `Window`。桩渲染器与纯 Node 都测不到这一条。
//   * 冷启动还必须走"先读 Harness 设置里的语言、再装菜单、最后建窗口"这个顺序：只跑单测
//     证明不了第一帧就是中文（"先英文、几秒后自己变中文"同样会让这个测试失败）。
//
// 覆盖：
//   空. Electron 默认菜单里确实有 `Window`（这就是截图里那个 Window 的来源，也说明本测试
//       用的真窗口真的会踩到它）；
//   一. **修复前的顺序**（先建窗口、后装菜单）：标题栏第一帧确实是那份默认菜单；
//   二. 菜单重建 + `publishShellState()` → 同一个窗口里标题栏自己换成中文（需求 26）；
//   三. **生产顺序**（先装菜单、后建窗口）：第一帧就是 文件/编辑/视图/更新/帮助，且
//       任何时候都不出现 `Window`（需求 18 / 30 / 36）；
//   四. 运行中 zh → en → zh：同一个进程、同一个窗口，菜单立刻跟着换（需求 32）。
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve, sep } = require('node:path')
const { writeFileSync } = require('node:fs')

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
const { applicationMenuTemplate, menuBarEntries } = require('../dist/main/menu')
const { SETTINGS_FILENAME, readLocalePreference } = require('../dist/main/harness-locale')
const { currentLocale, initShellStrings, setShellLocale, t } = require('../dist/main/i18n')

const scratch = mkdtempSync(join(tmpdir(), 'dsh-cold-start-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
/** 用户上一次在 Harness 里选的是中文——本次冷启动必须直接读出来。 */
writeFileSync(join(home, SETTINGS_FILENAME), 'locale:\n  preference: zh\n', 'utf8')
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

/** 顶层菜单文案（原生那一份）。 */
const nativeLabels = () => (Menu.getApplicationMenu()?.items ?? []).map((item) => item.label)

/** 标题栏页面里画出来的菜单按钮文案。为空时说明页面还没把菜单拉回来。 */
const titlebarLabels = async (contents) => {
  try {
    return JSON.parse(
      await contents.executeJavaScript(
        `JSON.stringify([...document.querySelectorAll('#menubar button')].map((button) => button.textContent))`,
      ),
    )
  } catch {
    return []
  }
}

/** 轮询直到标题栏真的画出了菜单按钮（页面加载 + getMenu 是异步的）。 */
async function titlebarLabelsWhenReady(contents, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const labels = await titlebarLabels(contents)
    if (labels.length > 0) return labels
    if (Date.now() > deadline) return labels
    await wait(100)
  }
}

/**
 * 菜单输入。
 *
 * 与 `index.ts` 的 `applicationMenuDeps()` 同构（这里没有工作区与更新入口，因此都是空实现）：
 * 被测的是"菜单什么时候装、装了之后谁被通知"，不是这些命令本身——那由
 * test-menu-inventory.mjs 与 test-shell-locale.mjs 覆盖。
 */
const menuDeps = () => ({
  recent: [],
  runtimeVersion: '0.1.5-rc.2',
  openFolder: () => {},
  openRecent: () => {},
  removeRecent: () => {},
  projectInfo: () => {},
  revealWorkspace: () => {},
  copyWorkspacePath: () => {},
  forgetWorkspace: () => {},
  openUpdates: () => {},
  openReleases: () => {},
})

/** 已经建出来的窗口（菜单重建后要推状态给它）。 */
let shellWindow
/** 菜单版本号：每次重建 +1，与 index.ts 里那个同构。 */
let menuRevision = 0

/** 复刻 index.ts 的 `refreshApplicationMenu()`：重建菜单 + 版本号 +1 + 推状态。 */
const refreshApplicationMenu = () => {
  menuRevision += 1
  const template = applicationMenuTemplate({ ...menuDeps(), strings: t(), shellVersion: '1.6.3' })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  if (shellWindow !== undefined) shellWindow.publishShellState()
}

/** 建一个窗口，菜单桥与生产实现同构（entries 读的是**当前**的应用菜单）。 */
const openWindow = () => {
  const mainWindow = createMainWindow({
    userDataDir: scratch,
    splashTitle: 'DeepSeek Harness',
    splashHint: '正在启动…',
    menu: {
      entries: () => menuBarEntries(Menu.getApplicationMenu() ?? Menu.buildFromTemplate([])),
      open: () => true,
      revision: () => menuRevision,
    },
  })
  shellWindow = mainWindow
  return mainWindow
}

async function run() {
  await app.whenReady()

  // 这一份测试会在同一个进程里先后开关两个窗口（反证用 + 生产顺序用）。Electron 的默认
  // 行为是"最后一个窗口关闭就退出应用"，这里必须挡住它，否则第一次 close() 就把进程带走了。
  app.on('window-all-closed', () => {})

  // ---- 空. 这份默认菜单就是"Window"的来源 ------------------------------------
  //
  // Electron 在 app ready 时**自己**装了一份默认菜单，与我们有没有调用 setApplicationMenu
  // 无关。本产品没有 Window 这一项，所以界面上出现它只有一个解释：标题栏拿到的是这份默认菜单。
  const defaults = nativeLabels()
  console.log(`DEFAULT_MENU ${JSON.stringify(defaults)}`)
  await check('空. Electron 默认菜单里确实有 Window（本产品没有这一项）', () => {
    assert.ok(defaults.includes('Window'), `默认菜单里没有 Window：${JSON.stringify(defaults)}`)
    assert.ok(defaults.includes('File') && defaults.includes('Help'), `默认菜单形状变了：${JSON.stringify(defaults)}`)
  })

  // ---- 一. 修复前的顺序：先建窗口、再装菜单 ----------------------------------
  //
  // 这一段是**反证**：它证明"菜单装得比窗口晚"会真的让标题栏画出那份默认菜单。因此下面
  // 第三节（生产顺序）里"不许出现 Window"这条断言是有意义的——把顺序改回去，它就会红。
  const first = openWindow()
  const firstLabels = await titlebarLabelsWhenReady(first.window.webContents)
  console.log(`FIRST_FRAME_WITHOUT_MENU ${JSON.stringify(firstLabels)}`)
  await check('一. 先建窗口后装菜单 → 标题栏第一帧是 Electron 默认菜单（含 Window）', () => {
    assert.deepEqual(firstLabels, defaults, `标题栏画的不是默认菜单：${JSON.stringify(firstLabels)}`)
    assert.ok(firstLabels.includes('Window'), '这一节的目的是复现"Window"，标题栏却没有它')
  })

  // ---- 二. 菜单重建后标题栏必须自己刷新（需求 26） ---------------------------
  //
  // 冷启动路径：读 Harness 设置 → 初始化文案表 → 装菜单。
  const preference = readLocalePreference(home)
  await check('二. 冷启动读到了 Harness 设置里的中文', () => assert.equal(preference, 'zh'))
  initShellStrings(preference)
  await check('二. 文案表已经是中文（没有"先英文再切中文"的中间态）', () => {
    assert.equal(currentLocale(), 'zh-CN')
    assert.equal(t().menuFile, '文件')
  })

  refreshApplicationMenu()
  await wait(700)
  const afterInstall = await titlebarLabelsWhenReady(first.window.webContents)
  await check('二. 菜单重建 + publishShellState → 同一个窗口里标题栏换成中文', () => {
    assert.deepEqual(afterInstall, ['文件', '编辑', '视图', '更新', '帮助'], `实际 ${JSON.stringify(afterInstall)}`)
  })
  await check('二. 换成中文之后 "Window" 彻底消失', () => {
    assert.equal(afterInstall.includes('Window'), false)
    assert.equal(afterInstall.includes('窗口'), false)
  })
  first.close()
  await wait(400)

  // ---- 三. 生产顺序：先装菜单、再建窗口 → 第一帧就是中文 ---------------------
  //
  // 与 `index.ts` 完全相同的顺序。第一帧的判据刻意取"导航到 Harness 之前"：那时菜单按钮
  // 已经画好（就绪前是隐藏的，但 DOM 已经在），所以只要它是中文，用户看到的第一帧就是中文。
  shellWindow = undefined
  refreshApplicationMenu()
  const second = openWindow()
  const coldLabels = await titlebarLabelsWhenReady(second.window.webContents)
  console.log(`COLD_START_FIRST_FRAME ${JSON.stringify(coldLabels)}`)
  await check('三. 冷启动第一帧：文件 / 编辑 / 视图 / 更新 / 帮助', () => {
    assert.deepEqual(coldLabels, ['文件', '编辑', '视图', '更新', '帮助'], `实际 ${JSON.stringify(coldLabels)}`)
  })
  await check('三. 第一帧里没有 Window（需求 30：出现就必须失败）', () => {
    assert.equal(coldLabels.includes('Window'), false)
    assert.equal(coldLabels.includes('窗口'), false)
    assert.equal(coldLabels.includes('File'), false, '第一帧不该是英文')
  })
  await check('三. 原生菜单也来自当前 applicationMenuTemplate 的中文那份', () => {
    assert.deepEqual(nativeLabels(), ['文件', '编辑', '视图', '更新', '帮助'])
  })
  await check('三. 文档语言写成了 zh-CN（无障碍/拼写检查据此工作）', async () =>
    assert.equal(await second.window.webContents.executeJavaScript('document.documentElement.lang'), 'zh-CN'))

  // ---- 四. 运行中切换语言（不重启、不重建窗口） ------------------------------
  const shellContentsId = second.window.webContents.id
  setShellLocale('en')
  refreshApplicationMenu()
  await wait(700)
  await check('四. zh → en：同一个窗口里立刻变成 File / Edit / View / Update / Help', async () => {
    assert.deepEqual(await titlebarLabels(second.window.webContents), ['File', 'Edit', 'View', 'Update', 'Help'])
    assert.equal(second.window.webContents.id, shellContentsId, '窗口被重建了')
    assert.equal(second.window.webContents.isDestroyed(), false)
  })
  setShellLocale('zh')
  refreshApplicationMenu()
  await wait(700)
  await check('四. en → zh：立刻变回中文（可反复切换）', async () =>
    assert.deepEqual(await titlebarLabels(second.window.webContents), ['文件', '编辑', '视图', '更新', '帮助']))

  // ---- 五. 菜单重建不会换命令（标题栏按钮仍是同一份原生菜单的下标） ----------
  await check('五. 每个按钮仍指向原生菜单里那个顶层项（命令只有一份）', async () => {
    const entries = await second.window.webContents.executeJavaScript(
      `JSON.stringify([...document.querySelectorAll('#menubar button')].map((button) => Number(button.dataset.index)))`,
    )
    assert.deepEqual(JSON.parse(entries), [0, 1, 2, 3, 4])
    assert.deepEqual(menuBarEntries(Menu.getApplicationMenu()).map((entry) => entry.index), [0, 1, 2, 3, 4])
  })

  second.close()
  await wait(300)
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
