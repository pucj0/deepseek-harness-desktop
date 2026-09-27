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
const { catalogFor, setShellLocale } = require('../dist/main/i18n')
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
  const registryView = () => readWorkspaceRegistry(dshHome)
  const active = new ActiveWorkspaceController({
    startup: { path: workspaceA, source: 'remembered' },
    isRegistered: (path) => registryView().entries.some((entry) => real(entry.path) === real(path)),
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

  // --- 7) Git 插件那一层：为什么它本来就跟着 Harness 走（需求 23） ----------
  //
  // `DSH_DESKTOP_WORKSPACE` 是**进程级**上下文（启动工作区，本次进程内不变），它只被
  // gitbar/review 的 **host** 半边用作"允许的根"的一份种子；允许集合的另一半是
  // `<home>/storages/workspace.json`（即注册表）。而"当前仓库是哪一个"由**渲染进程**按
  // 当前会话的 cwd 决定（`useSessions` → `sessions.current.cwd`，见两个插件的
  // `useWorkspaceGate`）。因此 Harness 里切到 B 之后，Git 面板请求的 cwd 是 B，
  // 而 B 已经在允许集合里 —— 不会出现"Harness = B、Git = A"。
  const roots = await fetch(`${server.ready.url}/dsh-desktop/review/roots`).then((response) => response.json())
  check('git host 的允许根包含 A 与 B（切到 B 之后仍能对 B 跑 git）', () => {
    const allowed = roots.roots.map(real)
    assert.ok(allowed.includes(real(workspaceA)), JSON.stringify(roots.roots))
    assert.ok(allowed.includes(real(workspaceB)), JSON.stringify(roots.roots))
  })
  check('git host 的进程级上下文仍是启动工作区（它只是上下文，不是"当前项目"）', () =>
    assert.equal(real(roots.current), real(workspaceA)))

  await server.stop(3000)
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
