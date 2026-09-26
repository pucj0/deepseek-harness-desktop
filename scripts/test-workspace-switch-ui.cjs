// 真实工作区切换测试（Electron + 官方 UI）。
//
//   node scripts/test-workspace-switch-ui.cjs
//
// 与 test-workspace-switch.mjs / test-workspace-registration.mjs 的分工：
//   * 前者断言切换协议的副作用集合（纯逻辑，不需要图形环境）；
//   * 中者断言"新目录确实登记进 Harness 工作区注册表"（真服务端，无界面）；
//   * 本测试把整条路径连起来：真实窗口 + 真实服务端 + 真实切换协议 + **官方 UI**，
//     验收标准是"界面里当前项目真的变成了 B"，而不是只看 settings.json。
//
// 场景与用户操作一一对应：
//   1. 以工作区 A 启动（首启 → A 被登记为项目，会话侧栏出现 A）；
//   2. 「文件 → 打开文件夹」选 B —— 直接跑生产用的 `restartIntoWorkspace`（对话框与
//      菜单点击是 Electron 原生部分，无法在这里合成；协议本身是真的）；
//   3. 模拟重启：用生产用的 `resolveWorkspace` 解析（argv 里故意留着**旧**工作区 A，
//      模拟 app.relaunch() 沿用旧命令行）→ 必须解析到 B；
//   4. 用 B 重新起服务端并导航同一个窗口；
//   5. 断言：注册表里有 A 与 B、git 层指向 B、外壳工作区是 B（项目信息面板取的就是它），
//      并且**官方 UI 的会话侧栏里当前项目行是 B**。
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

const { app } = require('electron')
const { createMainWindow } = require('../dist/main/window')
const { DshServer } = require('../dist/main/dsh-server')
const { resolveWorkspace, restartIntoWorkspace } = require('../dist/main/workspace-switch')
const { readSettings } = require('../dist/main/settings')

const root = resolve(__dirname, '..')
const runtimeDir = join(root, 'runtime')
const scratch = mkdtempSync(join(tmpdir(), 'dsh-switch-ui-'))
const workspaceA = join(scratch, 'project-alpha')
const workspaceB = join(scratch, 'project-beta')
for (const [dir, file] of [
  [workspaceA, 'a.txt'],
  [workspaceB, 'b.txt'],
]) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), `content of ${file}\n`)
}
const baseA = 'project-alpha'
const baseB = 'project-beta'

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

/** 读注册表（`ctx.workspaceRegistry.list()` 的落盘形态）。 */
function registryPaths() {
  const parsed = JSON.parse(readFileSync(join(scratch, 'home', 'storages', 'workspace.json'), 'utf8'))
  const table = parsed.tables.workspaces
  return parsed.global.workspaceIds.map((id) => table[id].path)
}

/**
 * 等一个页面内的表达式变成"可接受"为止。
 * @param contents - webContents。
 * @param expression - 返回 JSON 字符串的表达式。
 * @param accept - 判定函数。
 * @param label - 失败信息。
 */
async function waitFor(contents, expression, accept, label) {
  const deadline = Date.now() + 60000
  let last
  while (Date.now() < deadline) {
    last = await contents.executeJavaScript(expression).catch((error) => `ERROR ${String(error)}`)
    if (typeof last === 'string') {
      try {
        if (accept(JSON.parse(last))) return JSON.parse(last)
      } catch {
        // 页面尚未就绪：继续等。
      }
    }
    await wait(250)
  }
  throw new Error(`${label}（最后一次：${String(last).slice(0, 300)}）`)
}

/**
 * 侧栏里"当前项目行 + 全部项目行"的文本。
 *
 * 用 CSS 模块类名的子串匹配：ProjectRowItem 会给"展开且包含当前会话"的那个项目
 * 加上 `folderActive`，因此无需依赖文案就能判断"界面认为当前项目是哪一个"。
 * @param contents - webContents。
 * @returns `{active, rows}`。
 */
const SIDEBAR_QUERY = `(() => {
  const rows = [...document.querySelectorAll('[class*="projectRow"]')].map((row) => ({
    text: (row.innerText || '').trim(),
    active: !!row.querySelector('[class*="folderActive"]'),
  }));
  const current = rows.find((row) => row.active);
  return JSON.stringify({ active: current ? current.text : null, rows: rows.map((row) => row.text) });
})()`

async function run() {
  await app.whenReady()
  const mainWindow = createMainWindow({
    userDataDir: scratch,
    splashTitle: 'Workspace switch test',
    splashHint: 'Starting',
  })
  const { window } = mainWindow
  // The window must actually be shown: the Harness UI runs in a child view, and Chromium
  // throttles rendering for an occluded/hidden view (the session sidebar then never lays
  // out its project rows). test-startup-window.cjs can stub show() because it only asserts
  // splash text and boot flags.
  window.show()
  // The Harness UI lives in the child view below the custom title bar; the window's own
  // document is the title bar page.
  const contents = mainWindow.appContents
  const errors = []
  contents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message)
  })

  // --- 1) 以工作区 A 启动 -------------------------------------------------
  let server = new DshServer({ runtime, dshHome: join(scratch, 'home'), workspace: workspaceA })
  await server.start()
  await mainWindow.navigate(server.ready)

  const sidebarA = await waitFor(
    contents,
    SIDEBAR_QUERY,
    (value) => value.active !== null && String(value.active).includes(baseA),
    '以 A 启动后，侧栏里 A 应当是当前项目',
  )
  console.log(`  启动 A 后侧栏: ${JSON.stringify(sidebarA)}`)
  check('以 A 启动后官方 UI 把 A 显示为当前项目', () =>
    assert.ok(String(sidebarA.active).includes(baseA)))
  check('启动时 A 已登记进注册表', () =>
    assert.deepEqual(registryPaths().map((entry) => realpathSync.native(entry)), [realpathSync.native(workspaceA)]))

  // --- 2) 切换协议：选 B --------------------------------------------------
  const events = []
  const outcome = await restartIntoWorkspace({
    userDataDir: scratch,
    current: workspaceA,
    target: workspaceB,
    beginQuit: () => events.push('beginQuit'),
    stopServer: async () => {
      events.push('stop')
      await server.stop(2000)
    },
    relaunch: () => events.push('relaunch'),
    exit: (code) => events.push(`exit:${String(code)}`),
  })
  check('切换返回 restart，且先宣告退出、再停服务端、再重启', () =>
    assert.deepEqual([outcome, ...events], ['restart', 'beginQuit', 'stop', 'relaunch', 'exit:0']))
  check('settings 里当前工作区已是 B', () => assert.equal(readSettings(scratch).workspace, workspaceB))
  check('B 进了「最近打开」第一位', () => assert.equal(readSettings(scratch).recent[0], workspaceB))

  // --- 3) 模拟重启：argv 故意带着旧工作区 A --------------------------------
  const relaunchArgv = ['electron.exe', workspaceA]
  const resolved = resolveWorkspace(relaunchArgv, scratch)
  check('重启后解析到的是 B（旧 argv 没有把它盖掉）', () => assert.equal(resolved, workspaceB))

  // --- 4) 用 B 重新起服务端并导航同一个窗口 --------------------------------
  server = new DshServer({ runtime, dshHome: join(scratch, 'home'), workspace: resolved })
  await server.start()
  await mainWindow.navigate(server.ready)

  const sidebarB = await waitFor(
    contents,
    SIDEBAR_QUERY,
    (value) => value.active !== null && String(value.active).includes(baseB),
    '切换到 B 后，侧栏里 B 应当是当前项目',
  )
  console.log(`  切换到 B 后侧栏: ${JSON.stringify(sidebarB)}`)
  check('官方 UI 的当前项目变成了 B', () => assert.ok(String(sidebarB.active).includes(baseB)))
  check('A 仍在侧栏项目列表里（没有丢项目）', () =>
    assert.ok(sidebarB.rows.some((text) => text.includes(baseA))))
  check('侧栏里同时有 A 与 B', () =>
    assert.ok(sidebarB.rows.some((text) => text.includes(baseB))))

  // --- 5) 其余几层也要指向 B ----------------------------------------------
  check('注册表里 A 与 B 都在，且 B 在前（界面因此会落到 B）', () => {
    const paths = registryPaths().map((entry) => realpathSync.native(entry))
    assert.deepEqual(paths, [realpathSync.native(workspaceB), realpathSync.native(workspaceA)])
  })
  const roots = await fetch(`${server.ready.url}/dsh-desktop/review/roots`).then((response) => response.json())
  check('git 插件层（cwd）指向 B', () => assert.equal(realpathSync.native(roots.current), realpathSync.native(workspaceB)))
  check('外壳当前工作区是 B（项目信息面板取的就是它）', () => assert.equal(resolved, workspaceB))

  // 官方 UI 自己不再报错（与 test-startup-window.cjs 同一套断言）。
  check('切换全程渲染进程没有 console.error', () =>
    assert.deepEqual(errors.filter((message) => /already has a registration|Minified React error/.test(message)), []))
  console.log(`RENDERER_ERRORS ${JSON.stringify(errors.sort())}`)

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
