// 需求 44/45 的真实回归：删除当前工作区 → **完全重启** → A 不会回来 → 显式重开可以再登记。
//
//   npm run build && node scripts/test-workspace-restart-ui.cjs
//
// ## 为什么单独一个文件
//
// 需求 44 被点名是"最关键的回归测试"，它要一次性断言八件事：
//
//   1. Harness registry 不包含 A
//   2. Desktop 没有调用 create(A)
//   3. Desktop settings.workspace != A
//   4. Shell active workspace != A
//   5. Harness active != A
//   6. Project Info != A
//   7. Copy Workspace Path != A
//   8. Reveal Workspace != A
//
// 这八条横跨三层（注册表 / Desktop settings / 官方界面 + 外壳菜单），此前的覆盖是**拆开**的：
//   * `test-workspace-lifecycle.mjs` §11/§12 用真实 dsh 服务端断言 1/2/3（没有界面）；
//   * `test-active-workspace-ui.cjs` §7 在**运行中**删除，断言 4/5/6/7/8（没有"完全重启"）。
//
// 把这个 Bug 修好一次并不等于它不会回来：它的本质是"**启动链**把 remembered 当成了
// registration intent"，而启动链只有真的走一遍"退出 → 重进"才被执行到。因此这里在一个
// 进程里如实模拟一次完整重启：关掉窗口与服务端 → 按生产代码重新解析工作区（
// `resolveWorkspaceIntent` + `reconcileWorkspaceState`）→ 用**新的** ActiveWorkspaceController
// 与**新的**服务端重新导航。这样 Desktop 侧的一切（控制器、菜单动作、启动对账）都是新的，
// 只有 Electron 进程本身复用（真实应用里它本来也会换一个）。
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } = require('node:fs')
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

const { app } = require('electron')
const { createMainWindow } = require('../dist/main/window')
const { DshServer } = require('../dist/main/dsh-server')
const { ActiveWorkspaceController } = require('../dist/main/active-workspace')
const { catalogFor } = require('../dist/main/i18n')
const { readSettings, readSettingsRaw, switchWorkspace } = require('../dist/main/settings')
const { createWorkspaceActions } = require('../dist/main/workspace-actions')
const { pickRegisteredFallback, reconcileWorkspaceState } = require('../dist/main/workspace-reconcile')
const { readWorkspaceRegistry } = require('../dist/main/workspace-registry')
const { markPendingWorkspace, workspaceIdentity } = require('../dist/main/workspace')
const { resolveWorkspaceIntent } = require('../dist/main/workspace-switch')

const root = resolve(__dirname, '..')
const runtimeDir = join(root, 'runtime')
const scratch = mkdtempSync(join(tmpdir(), 'dsh-ws-restart-'))
const dshHome = join(scratch, 'home')
const workspaceA = join(scratch, 'project-alpha')
const workspaceB = join(scratch, 'project-beta')
for (const [dir, file] of [
  [workspaceA, 'a.txt'],
  [workspaceB, 'b.txt'],
]) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), `content of ${file}\n`)
}

app.setPath('userData', scratch)
app.disableHardwareAcceleration()
// 真实应用装了托盘，关掉窗口**不会**退出进程（见 index.ts 的 installCloseToTray）。
// 这里的测试要在中途关掉窗口来模拟"完全退出"，而 Electron 的默认行为是"最后一个窗口关闭
// 就退出应用"——不压掉它，测试会在第 5 步被自己带走（实测：只跑完前 4 条断言就 exit 0）。
app.on('window-all-closed', () => {})

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
const registryPaths = () => readWorkspaceRegistry(dshHome).entries.map((entry) => entry.path)

/** 启动一次服务端并拿到它的日志（登记 / 移除意图都在这里传）。 */
async function runServer(workspace, options = {}) {
  const server = new DshServer({
    runtime,
    dshHome,
    workspace,
    ...(options.registerWorkspace === undefined ? {} : { registerWorkspace: options.registerWorkspace }),
    ...(options.forgetWorkspaces === undefined ? {} : { forgetWorkspaces: options.forgetWorkspaces }),
  })
  const logs = []
  server.on('log', ({ line }) => logs.push(line))
  await server.start()
  await server.stop(3000)
  return logs
}

/** 生产启动链里的"决定本次用哪个工作区"这一步（与 index.ts 同一对函数）。 */
const startupChain = () =>
  reconcileWorkspaceState({
    userDataDir: scratch,
    dshHome,
    resolution: resolveWorkspaceIntent(['electron.exe'], scratch),
    home: join(scratch, 'home-fallback'),
  })

/**
 * 用一次对账结果造出"新进程"的外壳状态：新的控制器 + 新的窗口。
 *
 * @param startup - `reconcileWorkspaceState()` 的结果。
 * @returns `{ controller, window }`。
 */
function bootShell(startup) {
  const registryView = () => readWorkspaceRegistry(dshHome)
  const controller = new ActiveWorkspaceController({
    startup: { path: startup.active, source: startup.source },
    isRegistered: (path) => registryView().entries.some((entry) => real(entry.path) === real(path)),
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
      return pickRegisteredFallback(usable, isDirectory) ?? join(scratch, 'home-fallback')
    },
    persist: (path) => switchWorkspace(scratch, path),
  })
  const api = require('../dist/main/active-workspace')
  const mainWindow = createMainWindow({
    userDataDir: scratch,
    splashTitle: 'Workspace restart test',
    splashHint: 'Starting',
    onActiveWorkspaceReport: (payload) => {
      api.applyHarnessReport(controller, payload, registryView)
    },
  })
  mainWindow.window.show()
  return { controller, mainWindow, registryView }
}

const SIDEBAR_QUERY = `(() => {
  const rows = [...document.querySelectorAll('[class*="projectRow"]')].map((row) => ({
    text: (row.innerText || '').trim(),
    active: !!row.querySelector('[class*="folderActive"]'),
  }));
  const current = rows.find((row) => row.active);
  return JSON.stringify({ active: current ? current.text : null, rows: rows.map((row) => row.text) });
})()`

async function waitForSidebar(contents, accept, label) {
  const deadline = Date.now() + 90000
  let last
  while (Date.now() < deadline) {
    last = await contents.executeJavaScript(SIDEBAR_QUERY).catch((error) => `ERROR ${String(error)}`)
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
  throw new Error(`${label}（最后一次：${String(last).slice(0, 300)}）`)
}

/** 三个菜单入口各自会操作哪个路径（用生产动作层驱动）。 */
function menuTargets(controller) {
  const calls = { projectInfo: [], revealed: [], copied: [] }
  const actions = createWorkspaceActions({
    active: controller,
    userDataDir: scratch,
    strings: catalogFor('zh-CN'),
    effects: {
      pickDirectory: () => undefined,
      confirmSwitch: () => true,
      confirmForget: () => true,
      revealPath: (path) => calls.revealed.push(path),
      copyText: (text) => calls.copied.push(text),
      alert: () => {},
      refreshRecent: () => {},
    },
    onSwitchWorkspace: () => {},
    onForgetWorkspace: () => {},
    onProjectInfo: (workspace) => calls.projectInfo.push(workspace),
  })
  actions.projectInfo()
  actions.revealWorkspace()
  actions.copyWorkspacePath()
  return {
    projectInfo: calls.projectInfo.at(-1),
    revealed: calls.revealed.at(-1),
    copied: calls.copied.at(-1),
  }
}

async function run() {
  await app.whenReady()

  // ---- 前置：A、B 都登记；Desktop 上次用的是 A ----------------------------
  await runServer(workspaceB, { registerWorkspace: true })
  await runServer(workspaceA, { registerWorkspace: true })
  switchWorkspace(scratch, workspaceA)
  check('前置：注册表 = [A, B]', () => assert.deepEqual(registryPaths().map(real), [real(workspaceA), real(workspaceB)]))

  // ---- 3) 第一次启动：Desktop 用 A，Harness active 也是 A -------------------
  const firstStartup = startupChain()
  check('首次启动：来源是 remembered、不需要重新登记', () => {
    assert.equal(firstStartup.source, 'remembered')
    assert.equal(firstStartup.register, false)
    assert.equal(real(firstStartup.active), real(workspaceA))
  })
  const first = bootShell(firstStartup)
  const firstServer = new DshServer({ runtime, dshHome, workspace: workspaceA, registerWorkspace: firstStartup.register })
  await firstServer.start()
  await first.mainWindow.navigate(firstServer.ready)
  const sidebarFirst = await waitForSidebar(
    first.mainWindow.appContents,
    (value) => value.active !== null && String(value.active).includes('project-alpha'),
    '以 A 启动后侧栏当前项目应当是 A',
  )
  check('4/5) 第一次启动：Harness active = A', () => assert.ok(String(sidebarFirst.active).includes('project-alpha')))
  check('4) 第一次启动：Shell active = A', () => assert.equal(real(first.controller.get()), real(workspaceA)))

  // ---- 5/7) 模拟"完全退出"：停服务端、关窗口 ---------------------------------
  await firstServer.stop(3000)
  first.mainWindow.close()
  await wait(500)

  // ---- 5) 在 Harness 里删除 A（官方 API） -----------------------------------
  // 删除发生在应用退出之后、重启之前 —— 与需求 44 的步骤 5→7 完全一致。
  // 用 `forgetWorkspaces` 而不是手改 workspace.json：这正是官方 UI 的删除按钮最终调用的
  // `workspaceRegistry.delete(id)`。
  const forgetLogs = await runServer(workspaceB, { registerWorkspace: false, forgetWorkspaces: [workspaceA] })
  check('删除确实走了官方 API（日志点名 A）', () =>
    assert.ok(forgetLogs.some((line) => line.includes('removed workspace')), forgetLogs.slice(-5).join(' | ')))
  check('1) 删除后：Harness registry 不包含 A', () =>
    assert.ok(!registryPaths().map(real).includes(real(workspaceA)), JSON.stringify(registryPaths())))
  check('删除工作区不删磁盘目录', () => assert.ok(isDirectory(workspaceA)))

  // ---- 7/8) 重新启动 Desktop：走的是生产的启动链 ----------------------------
  const secondStartup = startupChain()
  check('2) 重启时不带登记意图（reason=harness-registry → register=false）', () => {
    assert.equal(secondStartup.register, false)
    assert.equal(secondStartup.reason, 'harness-registry')
  })
  check('3) 重启后 settings.workspace != A，且已落盘', () => {
    assert.notEqual(real(secondStartup.active), real(workspaceA))
    assert.equal(real(readSettingsRaw(scratch).workspace), real(secondStartup.active))
  })

  const second = bootShell(secondStartup)
  const secondServer = new DshServer({
    runtime,
    dshHome,
    workspace: secondStartup.active,
    registerWorkspace: secondStartup.register,
  })
  const secondLogs = []
  secondServer.on('log', ({ line }) => secondLogs.push(line))
  await secondServer.start()
  await second.mainWindow.navigate(secondServer.ready)

  check('2) 重启后的服务端明确"没有请求登记"', () =>
    assert.ok(secondLogs.some((line) => line.includes('registration not requested')), secondLogs.slice(-6).join(' | ')))
  check('2) 重启后 A 没有被 create 回来（注册表仍然只有 B）', () =>
    assert.deepEqual(registryPaths().map(real), [real(workspaceB)]))

  const sidebarSecond = await waitForSidebar(
    second.mainWindow.appContents,
    // 必须同时要求"当前项目已经是 B"：只要求"列表里有 B、没有 A"会被**还没选中任何会话**
    // 的中间态满足（那时 active 还是 null），断言就会在那个瞬间通过（实测踩到）。
    (value) =>
      value.active !== null &&
      String(value.active).includes('project-beta') &&
      !value.rows.some((text) => text.includes('project-alpha')),
    '重启后侧栏当前项目应当是 project-beta',
  )
  console.log(`  重启后侧栏: ${JSON.stringify(sidebarSecond)}`)
  check('5) Harness active != A（界面落在 B 上）', () => {
    assert.ok(!String(sidebarSecond.active).includes('project-alpha'))
    assert.ok(String(sidebarSecond.active).includes('project-beta'))
  })
  check('4) Shell active workspace != A', () => assert.notEqual(real(second.controller.get()), real(workspaceA)))
  check('4) Shell active workspace = B', () => assert.equal(real(second.controller.get()), real(workspaceB)))
  check('3) settings.workspace != A（磁盘上也不是 A）', () => {
    assert.notEqual(real(readSettingsRaw(scratch).workspace), real(workspaceA))
    assert.equal(real(readSettings(scratch).workspace), real(workspaceB))
  })
  check('4) A 仍然不在注册表里（界面与外壳都不能再把它当项目）', () =>
    assert.ok(!registryPaths().map(real).includes(real(workspaceA))))

  const targets = menuTargets(second.controller)
  check('6/7/8) Project Info / Copy / Reveal 都不是 A', () => {
    for (const [name, value] of Object.entries(targets)) {
      assert.notEqual(real(value), real(workspaceA), `${name} 指向了 A`)
      assert.equal(real(value), real(workspaceB), `${name} 应当指向 B`)
    }
  })
  check('§40) 「最近打开」里仍然保留 A（移除工作区 ≠ 移出最近打开）', () =>
    assert.ok((readSettingsRaw(scratch).recent ?? []).some((entry) => real(entry) === real(workspaceA))))

  // ---- §45) 用户显式重新打开 A：允许重新登记，并重新成为 active ------------
  await secondServer.stop(3000)
  second.mainWindow.close()
  await wait(500)

  markPendingWorkspace(scratch, workspaceA)
  const reopenStartup = startupChain()
  check('§45) 显式重开：来源是 pending、允许登记', () => {
    assert.equal(reopenStartup.source, 'pending')
    assert.equal(reopenStartup.register, true)
    assert.equal(real(reopenStartup.active), real(workspaceA))
  })
  await runServer(reopenStartup.active, { registerWorkspace: reopenStartup.register })
  check('§45) 显式重开后 A 重新出现在注册表最前（删除 ≠ 永久禁止打开）', () =>
    assert.deepEqual(registryPaths().map(real), [real(workspaceA), real(workspaceB)]))
  check('§45) 目录与文件都还在', () => assert.ok(existsSync(join(workspaceA, 'a.txt'))))

  // 重新登记之后，新一次启动又能正常把 A 当成项目使用。
  const thirdStartup = startupChain()
  check('§45) 再启动一次：A 已经在注册表里，正常使用且不需要重新登记', () => {
    assert.equal(real(thirdStartup.active), real(workspaceA))
    assert.equal(thirdStartup.register, false)
    assert.equal(thirdStartup.reason, 'registered')
  })

  const third = bootShell(thirdStartup)
  const thirdServer = new DshServer({ runtime, dshHome, workspace: workspaceA, registerWorkspace: false })
  await thirdServer.start()
  await third.mainWindow.navigate(thirdServer.ready)
  const sidebarThird = await waitForSidebar(
    third.mainWindow.appContents,
    (value) => value.active !== null && String(value.active).includes('project-alpha'),
    'A 重新登记之后，界面应当又能落到 A',
  )
  check('§45) A 再次成为 Harness active', () => assert.ok(String(sidebarThird.active).includes('project-alpha')))
  check('§45) A 再次成为 Shell active', () => assert.equal(real(third.controller.get()), real(workspaceA)))
  const thirdTargets = menuTargets(third.controller)
  check('§45) 三个菜单入口又指向 A', () => {
    for (const value of Object.values(thirdTargets)) assert.equal(real(value), real(workspaceA))
  })

  await thirdServer.stop(3000)
  third.mainWindow.close()
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
