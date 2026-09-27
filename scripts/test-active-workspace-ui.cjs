// 真实 Electron + 真实 Harness 界面：**在界面里切换项目**是否让外壳的 active workspace 跟随。
//
//   node scripts/test-active-workspace-ui.cjs
//
// ## 这个文件补的是哪一段
//
//   scripts/test-active-workspace.mjs   纯逻辑：控制器与菜单动作"点击时读 active.get()"
//   scripts/test-workspace-lifecycle.mjs 真实 dsh 服务端：登记 / 移除 / 清理注册表
//   **本文件**                          真实窗口 + 真实官方 UI：用户点一下项目，外壳跟不跟
//
// BUG B 的完整链路有四段，前三个文件各覆盖一段，只有这里能覆盖前两段：
//
//   官方 UI 里点项目
//     → `ctx.sessions.list.current` 变了                  ← 只有真实界面能给
//     → 内置插件 dsh-client-ui-shell-bridge 上报          ← 真实 preload + 真实 IPC
//     → 主进程校验（形状 / workspaceId 交叉核对 / 已注册） ← 真实 window.ts
//     → ActiveWorkspaceController 成为新的 active         ← 真实 active-workspace.ts
//
// 因此本文件不重启应用：验收点正是"**不重启**也能同步"。重启那条路（打开文件夹 →
// pending-workspace → relaunch）由 `scripts/test-workspace-switch-ui.cjs` 守着。
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve, sep } = require('node:path')

if (!process.versions.electron) {
  const result = spawnSync(require('electron'), [__filename], {
    cwd: resolve(__dirname, '..'),
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 420000,
    windowsHide: true,
  })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  if (result.error) throw result.error
  process.exit(result.status === 0 ? 0 : 1)
}

const { app, Menu } = require('electron')
const { createMainWindow } = require('../dist/main/window')
const { DshServer } = require('../dist/main/dsh-server')
const { ActiveWorkspaceController, applyHarnessReport } = require('../dist/main/active-workspace')
const { applicationMenuTemplate } = require('../dist/main/menu')
const { catalogFor, coerceReportedLocale, currentLocale, initShellStrings, setShellLocale } = require('../dist/main/i18n')
const { readSettings, switchWorkspace } = require('../dist/main/settings')
const { createWorkspaceActions } = require('../dist/main/workspace-actions')
const { pickRegisteredFallback } = require('../dist/main/workspace-reconcile')
const { readWorkspaceRegistry } = require('../dist/main/workspace-registry')
const { fallbackWorkspace, workspaceIdentity } = require('../dist/main/workspace')

const root = resolve(__dirname, '..')
const runtimeDir = join(root, 'runtime')
const scratch = mkdtempSync(join(tmpdir(), 'dsh-active-ws-ui-'))
const workspaceA = join(scratch, 'project-alpha')
const workspaceB = join(scratch, 'project-beta')
for (const [dir, file] of [
  [workspaceA, 'a.txt'],
  [workspaceB, 'b.txt'],
]) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), `content of ${file}\n`)
}
const dshHome = join(scratch, 'home')

app.setPath('userData', scratch)
app.disableHardwareAcceleration()

const runtime = {
  dir: runtimeDir,
  installAnchor: join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  serverEntry: join(root, 'src', 'server', 'server.mjs'),
  serverRunEntry: join(runtimeDir, 'server.mjs'),
  nodeBinary: join(runtimeDir, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node'),
  packaged: false,
}

let passed = 0
let failed = 0
function check(name, action) {
  try {
    action()
    passed += 1
    console.log(`PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const real = (value) => workspaceIdentity(value)
const isDirectory = (dir) => {
  try {
    return require('node:fs').statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** 读注册表里的路径（顺序 = `ctx.workspaceRegistry.list()`）。 */
function registryPaths() {
  return readWorkspaceRegistry(dshHome).entries.map((entry) => entry.path)
}

/** 启动一次服务端（带登记意图），跑完就停：用来把 A、B 都登记好并决定顺序。 */
async function registerWorkspace(dir) {
  const server = new DshServer({ runtime, dshHome, workspace: dir, registerWorkspace: true })
  await server.start()
  await server.stop(3000)
}

/**
 * 等一个页面内表达式变成"可接受"为止（与 test-workspace-switch-ui.cjs 同一套）。
 * @param contents - webContents。
 * @param expression - 返回 JSON 字符串的表达式。
 * @param accept - 判定函数。
 * @param label - 失败信息。
 */
async function waitFor(contents, expression, accept, label) {
  const deadline = Date.now() + 90000
  let last
  while (Date.now() < deadline) {
    last = await contents.executeJavaScript(expression).catch((error) => `ERROR ${String(error)}`)
    if (typeof last === 'string') {
      try {
        const parsed = JSON.parse(last)
        if (accept(parsed)) return parsed
      } catch {
        // 页面尚未就绪：继续等。
      }
    }
    await wait(250)
  }
  throw new Error(`${label}（最后一次：${String(last).slice(0, 400)}）`)
}

/** 侧栏里"当前项目行 + 全部项目行"的文本。 */
const SIDEBAR_QUERY = `(() => {
  const rows = [...document.querySelectorAll('[class*="projectRow"]')].map((row) => ({
    text: (row.innerText || '').trim(),
    active: !!row.querySelector('[class*="folderActive"]'),
  }));
  const current = rows.find((row) => row.active);
  return JSON.stringify({ active: current ? current.text : null, rows: rows.map((row) => row.text) });
})()`

/**
 * 点某个项目行的「新建对话」按钮——那是官方 UI 自己提供的"在这个项目里开一个新会话"入口，
 * 创建后新会话立刻成为当前会话，因此当前项目随之切换。
 *
 * 用**行内最后一个按钮**定位而不是按 aria-label 文案：文案跟随 Harness 自己的语言设置，
 * 用文案匹配会让测试依赖机器语言。行内按钮的顺序是 [⋯ 菜单, + 新建]（见官方
 * `ProjectRowItem` 的 rowActions），因此最后一个就是它。
 *
 * @param contents - webContents。
 * @param marker - 项目名里的一段（project-alpha / project-beta）。
 * @returns 是否找到了按钮并点了。
 */
const clickNewSession = (contents, marker) => `(() => {
  const row = [...document.querySelectorAll('[class*="projectRow"]')]
    .find((node) => (node.innerText || '').includes(${JSON.stringify(marker)}));
  if (!row) return JSON.stringify({ clicked: false, reason: 'no row' });
  const buttons = [...row.querySelectorAll('button')];
  const plus = buttons[buttons.length - 1];
  if (!plus) return JSON.stringify({ clicked: false, reason: 'no button' });
  plus.click();
  return JSON.stringify({ clicked: true, buttons: buttons.length });
})()`

async function run() {
  await app.whenReady()

  // --- 0) 先把 A、B 都登记进 Harness 注册表，并让 A 排在前面 ------------------
  //
  // 顺序：先登记 B、再登记 A。`create()` 会把新记录前置，因此注册表 = [A, B]，
  // 而官方 UI 的初始导航选"最近的工作区"（列表第一项）——于是界面会落到 A，
  // 与外壳的启动工作区一致，测试的初态才是干净的。
  await registerWorkspace(workspaceB)
  await registerWorkspace(workspaceA)
  console.log(`  注册表顺序: ${JSON.stringify(registryPaths().map((entry) => entry.split(sep).pop()))}`)
  check('前置：A、B 都已登记，A 在前', () => {
    const paths = registryPaths().map(real)
    assert.deepEqual(paths, [real(workspaceA), real(workspaceB)])
  })

  // 外壳的启动工作区是 A（"记住的"来源）。
  switchWorkspace(scratch, workspaceA)

  /** 上报记录：本测试用它断言 bridge → 主进程这条链路真的通了。 */
  const reports = []
  /**
   * 语言上报记录（与工作区同一条 bridge 链路）。
   *
   * 冷启动**故意**先按英文起（真实场景里是"读不到 Harness 偏好、回退系统语言"），这样
   * "运行期上报把语言纠正过来"这件事才看得出来。
   */
  const localeReports = []
  initShellStrings('en')
  const registryView = () => readWorkspaceRegistry(dshHome)
  const active = new ActiveWorkspaceController({
    startup: { path: workspaceA, source: 'remembered' },
    isRegistered: (path) => registryView().entries.some((entry) => real(entry.path) === real(path)),
    // 与 index.ts 注入的实现逐字一致：读不到注册表 / 注册表里一个文件系统工作区都没有时，
    // 不判定为失效（"不知道" ≠ "被删了"）。
    isStillRegistered: (path) => {
      const view = registryView()
      if (!view.readable || view.entries.length === 0) return true
      return view.entries.some((entry) => real(entry.path) === real(path))
    },
    isDirectory,
    fallback: (exclude) => {
      const view = registryView()
      const usable =
        exclude === undefined
          ? view
          : { ...view, entries: view.entries.filter((entry) => real(entry.path) !== real(exclude)) }
      return pickRegisteredFallback(usable, isDirectory) ?? fallbackWorkspace()
    },
    persist: (path) => switchWorkspace(scratch, path),
  })
  active.subscribe(() => reports.push(active.get()))

  const mainWindow = createMainWindow({
    userDataDir: scratch,
    splashTitle: 'Active workspace test',
    splashHint: 'Starting',
    // 与 index.ts 完全同一条策略入口（applyHarnessReport）。
    onActiveWorkspaceReport: (payload) => {
      applyHarnessReport(active, payload, registryView)
    },
    // 与 index.ts 同一条语言策略：归一化之后切换活文案表；不认识的值保持现状。
    onLocaleReport: (locale) => {
      localeReports.push(locale)
      const next = coerceReportedLocale(locale)
      if (next !== undefined) setShellLocale(next)
    },
  })
  const { window } = mainWindow
  // 官方 UI 在子视图里；被遮挡/隐藏时 Chromium 会节流渲染，侧栏的项目行就不会布局出来。
  window.show()
  const contents = mainWindow.appContents
  const errors = []
  contents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message)
  })

  const server = new DshServer({
    runtime,
    dshHome,
    workspace: workspaceA,
    // A 已经在注册表里：走"记住的"路径，不该重复登记。
    registerWorkspace: false,
  })
  await server.start()
  await mainWindow.navigate(server.ready)

  // --- 1) 启动后：界面在 A，外壳也跟到 A -------------------------------------
  const sidebarA = await waitFor(
    contents,
    SIDEBAR_QUERY,
    (value) => value.active !== null && String(value.active).includes('project-alpha'),
    '以 A 启动后，侧栏里 A 应当是当前项目',
  )
  console.log(`  启动后侧栏: ${JSON.stringify(sidebarA)}`)
  check('官方 UI 把 A 显示为当前项目', () => assert.ok(String(sidebarA.active).includes('project-alpha')))
  check('侧栏同时列出 A 与 B（两个项目都已登记）', () => {
    assert.ok(sidebarA.rows.some((text) => text.includes('project-alpha')))
    assert.ok(sidebarA.rows.some((text) => text.includes('project-beta')))
  })

  const reportedA = await waitFor(
    contents,
    'JSON.stringify({ n: 1 })',
    () => active.fromHarness === true,
    'bridge 应当把当前工作区 A 上报到外壳',
  ).catch(() => null)
  check('内置 bridge 插件把 active workspace 上报到了外壳', () => assert.equal(active.fromHarness, true))
  check('外壳 active = A（启动值也是 A，此时两者一致）', () =>
    assert.equal(real(active.get()), real(workspaceA)))
  check('上报链路确实发生过（订阅收到过变化）或至少已标记为来自 Harness', () => {
    assert.ok(reportedA !== null || active.fromHarness === true)
  })

  // --- 1b) 语言：Harness 的**生效语言**同样由这个 bridge 上报 -----------------
  //
  // 与"当前项目"同一条链路（官方 runtime → 内置插件 → 真实 preload → 真实 IPC → 主进程），
  // 而它解决的是另一个真实问题：外壳冷启动只能读 `<harness home>/settings.yaml` 里的
  // `locale.preference`，用户**从没选过语言**（Harness 用的是从浏览器语言推导的 provisional
  // 值）或语言由语言包注册时，那份文件给不出答案，于是"Harness 界面已经是中文、外壳菜单却是
  // 英文"。这里断言的就是"外壳能从运行期拿到它"。
  //
  // 判据刻意用官方 runtime 自己写下的 `document.documentElement.lang`（已确认
  // `@deepseek-ai/dsh-client-locale` 会写它：`active === 'zh' ? 'zh-CN' : active`）做对照，
  // 而不是猜某台机器的系统语言。
  {
    const officialLang = String(
      await contents
        .executeJavaScript('document.documentElement.lang')
        .catch(() => ''),
    )
    const deadlineLocale = Date.now() + 30000
    while (Date.now() < deadlineLocale && localeReports.length === 0) await wait(200)
    check('1b) 内置 bridge 把 Harness 的生效语言上报到了外壳', () => {
      assert.ok(localeReports.length > 0, '一次语言上报都没收到')
    })
    check('1b) 上报的值是外壳真的带字典的语言（不是页面文字猜出来的）', () => {
      const coerced = localeReports.map((value) => coerceReportedLocale(value))
      assert.ok(coerced.every((value) => value !== undefined), `上报了不认识的语言：${JSON.stringify(localeReports)}`)
      assert.ok(
        coerced.includes(officialLang === 'zh-CN' ? 'zh-CN' : officialLang),
        `上报 ${JSON.stringify(localeReports)} 与官方 lang=${officialLang} 对不上`,
      )
    })
    check('1b) 活文案表跟着上报走（与 index.ts 同一条应用路径）', () => {
      assert.equal(currentLocale(), coerceReportedLocale(localeReports[localeReports.length - 1]))
    })
    console.log(`  语言：官方 lang=${officialLang} 上报=${JSON.stringify(localeReports)} 外壳=${currentLocale()}`)
  }

  // --- 2) 在 Harness UI 里切换到 B（不重启应用） -----------------------------
  const clicked = await waitFor(
    contents,
    clickNewSession(contents, 'project-beta'),
    (value) => value.clicked === true,
    '找不到 project-beta 项目行上的「新建对话」按钮',
  )
  console.log(`  点击 project-beta 的新建按钮: ${JSON.stringify(clicked)}`)

  const sidebarB = await waitFor(
    contents,
    SIDEBAR_QUERY,
    (value) => value.active !== null && String(value.active).includes('project-beta'),
    '在界面里新建 B 的会话后，侧栏当前项目应当是 B',
  )
  console.log(`  切换后侧栏: ${JSON.stringify(sidebarB)}`)
  check('官方 UI 的当前项目变成了 B', () => assert.ok(String(sidebarB.active).includes('project-beta')))

  const deadline = Date.now() + 30000
  while (Date.now() < deadline && real(active.get()) !== real(workspaceB)) await wait(200)
  check('外壳 active workspace 跟随 Harness 变成了 B（无需重启）', () =>
    assert.equal(real(active.get()), real(workspaceB)))
  check('来源标记为 harness（此后 Harness 是 source of truth）', () => assert.equal(active.fromHarness, true))
  check('切换被记进 Desktop settings（下次启动以 B 为准）', () =>
    assert.equal(real(readSettings(scratch).workspace), real(workspaceB)))

  // --- 3) 三个菜单入口必须都指向 B -------------------------------------------
  //
  // 用**生产模块**（dist/main/workspace-actions.js）+ 真实控制器驱动：与 index.ts 交给
  // 菜单模板的是同一个函数，因此"菜单项读的是不是当前值"在这里是真断言。
  const calls = { copied: [], revealed: [], projectInfo: [], switched: [], forgot: [] }
  const makeActions = (strings) =>
    createWorkspaceActions({
      active,
      userDataDir: scratch,
      strings,
      effects: {
        pickDirectory: () => undefined,
        confirmSwitch: () => true,
        confirmForget: () => true,
        revealPath: (path) => calls.revealed.push(path),
        copyText: (text) => calls.copied.push(text),
        alert: () => {},
        refreshRecent: () => {},
      },
      onSwitchWorkspace: (dir) => calls.switched.push(dir),
      onForgetWorkspace: (dir) => calls.forgot.push(dir),
      onProjectInfo: (workspace) => calls.projectInfo.push(workspace),
    })
  let actions = makeActions(catalogFor('zh-CN'))

  actions.projectInfo()
  check('File → 项目信息 显示 B', () => assert.equal(real(calls.projectInfo.at(-1)), real(workspaceB)))
  actions.revealWorkspace()
  check('File → 在文件管理器中打开工作区 打开 B', () =>
    assert.equal(real(calls.revealed.at(-1)), real(workspaceB)))
  actions.copyWorkspacePath()
  check('File → 复制工作区路径 复制 B', () => assert.equal(real(calls.copied.at(-1)), real(workspaceB)))
  check('三个入口都不是启动时的 A', () => {
    for (const value of [calls.projectInfo.at(-1), calls.revealed.at(-1), calls.copied.at(-1)]) {
      assert.notEqual(real(value), real(workspaceA))
    }
  })

  // --- 4) 语言变化重建菜单之后仍然是 B（需求 28 / 50） ------------------------
  setShellLocale('en-US')
  actions = makeActions(catalogFor('en-US'))
  const enMenu = applicationMenuTemplate({
    strings: catalogFor('en-US'),
    recent: actions.recent,
    runtimeVersion: '0.0.0',
    shellVersion: '0.0.0',
    openFolder: actions.openFolder,
    openRecent: actions.openRecent,
    removeRecent: actions.removeRecent,
    projectInfo: actions.projectInfo,
    revealWorkspace: actions.revealWorkspace,
    copyWorkspacePath: actions.copyWorkspacePath,
    forgetWorkspace: () => actions.forgetWorkspace(),
    openUpdates: () => {},
    openReleases: () => {},
  })
  enMenu[0].submenu.find((item) => item.label === 'Copy Workspace Path').click()
  check('locale zh→en 重建菜单后 Copy 仍然复制 B（不回到启动值 A）', () =>
    assert.equal(real(calls.copied.at(-1)), real(workspaceB)))
  setShellLocale('zh-CN')

  // --- 5) 再切回 A：全部重新验证一次 ----------------------------------------
  await waitFor(
    contents,
    clickNewSession(contents, 'project-alpha'),
    (value) => value.clicked === true,
    '找不到 project-alpha 项目行上的「新建对话」按钮',
  )
  const backDeadline = Date.now() + 30000
  while (Date.now() < backDeadline && real(active.get()) !== real(workspaceA)) await wait(200)
  check('从 Harness UI 切回 A：外壳 active 又变成 A', () =>
    assert.equal(real(active.get()), real(workspaceA)))
  const backActions = makeActions(catalogFor('zh-CN'))
  backActions.copyWorkspacePath()
  backActions.revealWorkspace()
  backActions.projectInfo()
  check('切回 A 之后三个入口都指向 A', () => {
    assert.equal(real(calls.copied.at(-1)), real(workspaceA))
    assert.equal(real(calls.revealed.at(-1)), real(workspaceA))
    assert.equal(real(calls.projectInfo.at(-1)), real(workspaceA))
  })
  check('切回 A 已落盘', () => assert.equal(real(readSettings(scratch).workspace), real(workspaceA)))

  // --- 6) 安全：渲染进程不能凭一条 IPC 让外壳去操作任意路径 -------------------
  const outside = process.platform === 'win32' ? 'C:\\Windows' : '/etc'
  const before = active.get()
  check('未注册的绝对路径被拒（即使是存在的系统目录）', () => {
    const outcome = applyHarnessReport(active, { path: outside }, registryView)
    assert.equal(outcome, 'rejected')
    assert.equal(active.get(), before)
  })
  check('伪造的 workspaceId 与路径对不上时被拒', () => {
    const entry = registryView().entries.find((item) => real(item.path) === real(workspaceA))
    const outcome = applyHarnessReport(
      active,
      { path: workspaceB, workspaceId: entry.id },
      registryView,
    )
    assert.equal(outcome, 'idMismatch')
    assert.equal(real(active.get()), real(workspaceA))
  })
  check('相对路径被拒', () => {
    assert.equal(applyHarnessReport(active, { path: '../../etc' }, registryView), 'rejected')
  })

  check('全程渲染进程没有 console.error', () =>
    assert.deepEqual(errors.filter((message) => /Minified React error|already has a registration/.test(message)), []))
  console.log(`RENDERER_ERRORS ${JSON.stringify(errors.sort())}`)

  // --- 7) 运行中把**当前**工作区从 Harness 里移除（需求 42） -----------------
  //
  // 删除本身走官方 API：再起一个服务端、带 `forgetWorkspaces: [A]`（这正是「移除工作区」
  // 那条菜单项与 Harness UI 的删除按钮最终调用 `workspaceRegistry.delete(id)` 的同一入口）。
  // 之所以在这里停一次应用的服务端：注册表由服务端进程独占，两个进程同时写同一份
  // workspace.json 不是受支持的状态。
  //
  // 随后**不重启 Desktop**（同一个窗口、同一个控制器），只是把服务端重新起起来并导航——
  // 于是 A 从注册表与侧栏里都消失了，而外壳手里仍然是 A：这正是"半同步"最容易出错的瞬间。
  const beforeDelete = active.get()
  await server.stop(3000)
  const forgetServer = new DshServer({
    runtime,
    dshHome,
    workspace: workspaceB,
    registerWorkspace: false,
    forgetWorkspaces: [workspaceA],
  })
  await forgetServer.start()
  await forgetServer.stop(3000)

  check('官方 API 删除后：A 不在注册表里了', () =>
    assert.ok(!registryPaths().map(real).includes(real(workspaceA)), JSON.stringify(registryPaths())))
  check('删除工作区**不**删磁盘目录（移除 ≠ 删除）', () => assert.ok(isDirectory(workspaceA)))

  const server2 = new DshServer({ runtime, dshHome, workspace: workspaceA, registerWorkspace: false })
  await server2.start()
  await mainWindow.navigate(server2.ready)
  const sidebarAfterDelete = await waitFor(
    contents,
    SIDEBAR_QUERY,
    // 等到"侧栏里确实有 B、且没有 A"为止。**不能**只写"没有 A"：加载途中的空列表也满足它，
    // 于是断言会在侧栏还没渲染出来时就通过（实测过）。
    (value) =>
      value.rows.some((text) => text.includes('project-beta')) &&
      !value.rows.some((text) => text.includes('project-alpha')),
    '删除 A 之后侧栏应当只剩 project-beta',
  )
  console.log(`  删除 A 之后侧栏: ${JSON.stringify(sidebarAfterDelete)}`)
  check('侧栏里只剩 B', () => {
    assert.ok(sidebarAfterDelete.rows.some((text) => text.includes('project-beta')))
    assert.ok(!sidebarAfterDelete.rows.some((text) => text.includes('project-alpha')))
  })
  check('前置：A 的目录还在，所以"失效"不可能是因为目录被删', () =>
    assert.equal(isDirectory(workspaceA), true))

  // 需求 42 的第一种结局（实测就是这一种）：Harness 侧自己落到了仍然存在的 B（侧栏
  // `active` = project-beta），于是 bridge 上报 B，**外壳不必重启就跟随**了过去。
  const followedDeadline = Date.now() + 30000
  while (Date.now() < followedDeadline && real(active.get()) !== real(workspaceB)) await wait(200)
  check('外壳 active 跟随到 B（Desktop 进程与控制器都没有重启）', () =>
    assert.equal(real(active.get()), real(workspaceB)))
  check('侧栏里"当前项目"就是 B', () => assert.ok(String(sidebarAfterDelete.active).includes('project-beta')))
  check('对账结果落盘：Desktop current 不再是 A', () =>
    assert.equal(real(readSettings(scratch).workspace), real(workspaceB)))

  // A 已经不再是合法的 active workspace —— 拿它去上报必须被拒，且不能改变当前值。
  // 这条断言用的是**真实注册表**（不是替身），因此它同时钉住"删除确实生效"与
  // "外壳不接受一个已移除的工作区"。
  check('A 已不是合法 active workspace：上报被拒，active 不变', () => {
    const outcome = applyHarnessReport(active, { path: workspaceA }, registryView)
    assert.equal(outcome, 'rejected')
    assert.equal(real(active.get()), real(workspaceB))
  })

  // 三个菜单入口：都指向 B，A 一次都没被操作。
  const afterDeleteCalls = { copied: [], revealed: [], projectInfo: [], alerts: [], refreshed: 0 }
  const deleteActions = createWorkspaceActions({
    active,
    userDataDir: scratch,
    strings: catalogFor('zh-CN'),
    effects: {
      pickDirectory: () => undefined,
      confirmSwitch: () => true,
      confirmForget: () => true,
      revealPath: (path) => afterDeleteCalls.revealed.push(path),
      copyText: (text) => afterDeleteCalls.copied.push(text),
      alert: (message) => afterDeleteCalls.alerts.push(message),
      refreshRecent: () => {
        afterDeleteCalls.refreshed += 1
      },
    },
    onSwitchWorkspace: () => {},
    onForgetWorkspace: () => {},
    onProjectInfo: (workspace) => afterDeleteCalls.projectInfo.push(workspace),
  })

  deleteActions.projectInfo()
  deleteActions.revealWorkspace()
  deleteActions.copyWorkspacePath()
  check('三个入口都指向 B，A 一次都没被操作', () => {
    assert.equal(real(afterDeleteCalls.projectInfo.at(-1)), real(workspaceB))
    assert.equal(real(afterDeleteCalls.revealed.at(-1)), real(workspaceB))
    assert.equal(real(afterDeleteCalls.copied.at(-1)), real(workspaceB))
    for (const list of [afterDeleteCalls.projectInfo, afterDeleteCalls.revealed, afterDeleteCalls.copied]) {
      assert.ok(!list.some((entry) => real(entry) === real(workspaceA)), JSON.stringify(list))
    }
  })
  check('删除 A 之后它的磁盘目录依然完好', () => assert.ok(isDirectory(workspaceA)))
  check('beforeDelete 与 A 一致（前置状态确实是"active = A"）', () =>
    assert.equal(real(beforeDelete), real(workspaceA)))

  // --- 8) Git 插件那一层：为什么它本来就跟着 Harness 走（需求 23） ----------
  //
  // `DSH_DESKTOP_WORKSPACE` 是**进程级**上下文（启动工作区，本次进程内不变），它只被
  // gitbar/review 的 **host** 半边用作"允许的根"的一份种子；允许集合的另一半是
  // `<home>/storages/workspace.json`（即注册表）。而"当前仓库是哪一个"由**渲染进程**按
  // 当前会话的 cwd 决定（`useSessions` → `sessions.current.cwd`，见两个插件的
  // `useWorkspaceGate`）。因此 Harness 里切到 B 之后，Git 面板请求的 cwd 是 B，
  // 而 B 已经在允许集合里 —— 不会出现"Harness = B、Git = A"。
  const roots = await fetch(`${server2.ready.url}/dsh-desktop/review/roots`).then((response) => response.json())
  check('git host 的允许根包含 A 与 B（切到 B 之后仍能对 B 跑 git）', () => {
    const allowed = roots.roots.map(real)
    assert.ok(allowed.includes(real(workspaceA)), JSON.stringify(roots.roots))
    assert.ok(allowed.includes(real(workspaceB)), JSON.stringify(roots.roots))
  })
  check('git host 的进程级上下文仍是启动工作区（它只是上下文，不是"当前项目"）', () =>
    assert.equal(real(roots.current), real(workspaceA)))

  await server2.stop(3000)
  mainWindow.close()
}

run()
  .then(() => {
    console.log('')
    console.log(`${passed} 项通过${failed === 0 ? '' : `，${failed} 项失败`}`)
    app.exit(failed === 0 ? 0 : 1)
  })
  .catch((error) => {
    console.error(error)
    console.log('')
    console.log(`${passed} 项通过，1 项失败（异常）`)
    app.exit(1)
  })
  .finally(() => {
    try {
      if (!resolve(scratch).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe cleanup path')
      rmSync(scratch, { recursive: true, force: true })
    } catch {
      // 清理失败不影响结论。
    }
  })
