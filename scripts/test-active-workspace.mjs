// 运行期 active workspace 与「文件」菜单动作的回归测试（**不需要图形环境**）。
//
//   npm run build && node scripts/test-active-workspace.mjs
//
// ## 这个文件钉住的是 BUG B
//
// 旧代码里只有一个进程级常量：
//
//     const workspace = resolveWorkspace(process.argv, userDataDir)
//
// 菜单与托盘把它闭包捕获下来，于是「项目信息 / 在文件管理器中打开工作区 / 复制工作区路径」
// 永远指向**启动时**那个目录。可用户能在 Harness UI 里随时切换当前项目，两者立刻不一致。
//
// 因此这里分两半断言，两半都用**生产代码**（`dist/main/active-workspace.js`、
// `dist/main/workspace-actions.js`、`dist/main/menu.js`）：
//
//   1. `ActiveWorkspaceController`——什么时候接受 Harness 的上报、什么时候拒绝、
//      被拒绝的正好是当前值时怎么对账；
//   2. `createWorkspaceActions`——每个菜单项**在点击那一刻**读到的是不是当前值，
//      以及"语言变化重建菜单"之后是否仍然如此（需求 28）。
//
// Electron 只需四个动作（目录选择器、确认框、打开、复制）就够，全部注入，因此这一整套
// 逻辑可以在纯 Node 里跑完；真实 Electron + 真实 Harness 界面的那一段在
// `scripts/test-active-workspace-ui.cjs`。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { ActiveWorkspaceController, isAbsolutePath } from '../dist/main/active-workspace.js'
import { applicationMenuTemplate } from '../dist/main/menu.js'
import { catalogFor, setShellLocale } from '../dist/main/i18n.js'
import { readSettings, switchWorkspace } from '../dist/main/settings.js'
import { createWorkspaceActions } from '../dist/main/workspace-actions.js'
import { workspaceIdentity } from '../dist/main/workspace.js'

let passed = 0
let failed = 0
async function check(name, action) {
  try {
    await action()
    passed += 1
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-active-workspace-'))
let serial = 0
const freshUserData = () => {
  serial += 1
  const dir = join(scratch, `case-${serial}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
const makeDir = (name) => {
  const dir = join(scratch, name)
  mkdirSync(dir, { recursive: true })
  return dir
}
/**
 * 测试替身里"同一个目录"的判定。
 *
 * **必须**与生产代码用同一套 identity（`workspaceIdentity`）：它把尾部分隔符、`..`、
 * 大小写与链接都归一。用一个自定义的 `toLowerCase()` 会让替身比生产代码更严格或更宽松，
 * 于是测出来的是替身的行为，而不是产品的行为。
 */
const real = (value) => workspaceIdentity(value)

/**
 * 一个受控的控制器环境：注册表与目录存在性是显式给出的集合。
 * @param options - `{ startup, registered, directories, home, userDataDir }`。
 * @returns `{ active, persisted, fallbacks }`。
 */
function environment(options) {
  const registered = new Set((options.registered ?? []).map(real))
  const directories = new Set((options.directories ?? []).map(real))
  const persisted = []
  const fallbacks = []
  const active = new ActiveWorkspaceController({
    startup: { path: options.startup, source: options.source ?? 'remembered' },
    isRegistered: (path) => registered.has(real(path)),
    isDirectory: (path) => directories.has(real(path)),
    fallback: (exclude) => {
      fallbacks.push(exclude)
      return options.home
    },
    persist: (path) => {
      persisted.push(path)
      if (options.userDataDir !== undefined) switchWorkspace(options.userDataDir, path)
    },
  })
  return { active, persisted, fallbacks, registered, directories }
}

try {
  // =====================================================================
  console.log('=== 1. 控制器：启动值与"没有当前会话" ===')
  // =====================================================================
  {
    const a = makeDir('ctrl-a')
    const { active, persisted } = environment({ startup: a, registered: [a], directories: [a], home: a })
    await check('初值就是启动工作区', () => assert.equal(active.get(), a))
    await check('初值来源是启动期解析出来的', () => assert.equal(active.currentOrigin, 'remembered'))
    await check('尚未跟随 Harness', () => assert.equal(active.fromHarness, false))
    await check('startupWorkspace 单独保留（服务端参数用）', () => assert.equal(active.startupWorkspace, a))

    await check('上报 null（没有当前会话）是合法输入，不报错、不改值', () => {
      assert.equal(active.reportFromHarness(null), 'unchanged')
      assert.equal(active.get(), a)
    })
    await check('上报 undefined 同样保持', () => assert.equal(active.reportFromHarness(undefined), 'unchanged'))
    await check('没有为"没有会话"落盘', () => assert.deepEqual(persisted, []))
  }

  // =====================================================================
  console.log('')
  console.log('=== 2. 控制器：只接受"存在的 + 已注册的绝对路径" ===')
  // =====================================================================
  {
    const a = makeDir('reject-a')
    const b = makeDir('reject-b')
    const outside = makeDir('reject-outside')
    const { active } = environment({
      startup: a,
      registered: [a, b],
      directories: [a, b, outside],
      home: a,
    })

    await check('非字符串被拒', () => assert.equal(active.reportFromHarness(123), 'rejected'))
    await check('空字符串被拒', () => assert.equal(active.reportFromHarness('   '), 'rejected'))
    await check('相对路径被拒（外壳不接受 CWD 相关的写法）', () =>
      assert.equal(active.reportFromHarness('some/relative/dir'), 'rejected'))
    await check('`C:\\Windows` 这类绝对路径：目录存在但没注册 → 被拒', () =>
      assert.equal(active.reportFromHarness(outside), 'rejected'))
    await check('被拒的上报没有改变 active', () => assert.equal(active.get(), a))
    await check('目录不存在 → 被拒', () => {
      const missing = join(scratch, 'reject-missing')
      assert.equal(active.reportFromHarness(missing), 'rejected')
      assert.equal(active.get(), a)
    })

    await check('合法上报被接受', () => assert.equal(active.reportFromHarness(b), 'accepted'))
    await check('active 变成 B', () => assert.equal(active.get(), b))
    await check('来源变成 harness', () => assert.equal(active.currentOrigin, 'harness'))
    await check('fromHarness 为真', () => assert.equal(active.fromHarness, true))

    await check('重复上报同一个值不再触发变更', () => assert.equal(active.reportFromHarness(b), 'unchanged'))
    await check('尾部分隔符不同的同一路径也算"没变"', () => {
      assert.equal(active.reportFromHarness(`${b}${sep}`), 'unchanged')
      assert.equal(active.get(), b)
    })
    await check('大小写不同的同一路径在 Windows 上也只算"没变"', () => {
      if (process.platform !== 'win32') return
      assert.equal(active.reportFromHarness(b.toUpperCase()), 'unchanged')
      assert.equal(active.get(), b)
    })
    await check('isAbsolutePath 认 Windows 与 POSIX 两种绝对路径', () => {
      assert.equal(isAbsolutePath('C:\\Windows'), true)
      assert.equal(isAbsolutePath('/etc'), true)
      assert.equal(isAbsolutePath('\\\\server\\share'), true)
      assert.equal(isAbsolutePath('relative'), false)
      assert.equal(isAbsolutePath(''), false)
    })
  }

  // =====================================================================
  console.log('')
  console.log('=== 3. 控制器：当前工作区被 Harness 移除 → 立刻回退，不留半失效状态 ===')
  // =====================================================================
  {
    const a = makeDir('drop-a')
    const b = makeDir('drop-b')
    const home = makeDir('drop-home')
    const userDataDir = freshUserData()
    const env = environment({
      startup: a,
      registered: [a, b],
      directories: [a, b, home],
      home,
      userDataDir,
    })

    env.active.reportFromHarness(b)
    await check('先切到 B', () => assert.equal(env.active.get(), b))

    // 用户在 Harness 里把 B 移除：注册表里不再有 B，下一次上报会被拒。
    env.registered.delete(real(b))
    await check('B 不再注册 → 上报被拒', () => assert.equal(env.active.reportFromHarness(b), 'rejected'))
    await check('被拒的正好是当前值 → 立刻回退（不能继续操作已移除的工作区）', () =>
      assert.equal(env.active.get(), home))
    await check('回退时排除了失效的那个路径', () => assert.deepEqual(env.fallbacks, [b]))
    await check('回退结果已落盘到 settings.workspace', () =>
      assert.equal(readSettings(userDataDir).workspace, home))

    // 非当前值被拒：什么都不该发生。
    const c = makeDir('drop-c')
    env.directories.add(real(c))
    const before = env.active.get()
    await check('被拒的路径不是当前值 → active 不动', () => {
      assert.equal(env.active.reportFromHarness(c), 'rejected')
      assert.equal(env.active.get(), before)
    })
  }

  // =====================================================================
  console.log('')
  console.log('=== 4. 控制器：目录被删（点击时才发现）→ reportMissing 对账 ===')
  // =====================================================================
  {
    const a = makeDir('miss-a')
    const home = makeDir('miss-home')
    const userDataDir = freshUserData()
    const env = environment({
      startup: a,
      registered: [a],
      directories: [a, home],
      home,
      userDataDir,
    })
    await check('目录还在时 isUsable() 为真', () => assert.equal(env.active.isUsable(), true))
    env.directories.delete(real(a))
    await check('目录消失后 isUsable() 为假', () => assert.equal(env.active.isUsable(), false))
    await check('reportMissing 触发对账并返回 true', () => assert.equal(env.active.reportMissing(a), true))
    await check('对账后 active 是一个仍然存在的目录', () => assert.equal(env.active.get(), home))
    await check('对账结果落盘', () => assert.equal(readSettings(userDataDir).workspace, home))
    await check('对一个不是当前值的路径调用 reportMissing 什么都不做', () =>
      assert.equal(env.active.reportMissing(join(scratch, 'never-was')), false))
  }

  // =====================================================================
  console.log('')
  console.log('=== 5. 控制器：订阅 ===')
  // =====================================================================
  {
    const a = makeDir('sub-a')
    const b = makeDir('sub-b')
    const env = environment({ startup: a, registered: [a, b], directories: [a, b], home: a })
    const seen = []
    const unsubscribe = env.active.subscribe(() => seen.push(env.active.get()))
    env.active.reportFromHarness(b)
    await check('订阅者在 change 时被通知一次', () => assert.deepEqual(seen, [b]))
    env.active.reportFromHarness(b)
    await check('值没变就不通知', () => assert.deepEqual(seen, [b]))
    unsubscribe()
    env.active.reportFromHarness(a)
    await check('退订之后不再收到', () => assert.deepEqual(seen, [b]))
  }

  // =====================================================================
  console.log('')
  console.log('=== 6. 菜单动作：Project Info / Reveal / Copy 都在点击时读 active ===')
  // =====================================================================
  {
    const a = makeDir('act-a')
    const b = makeDir('act-b')
    const home = makeDir('act-home')
    const userDataDir = freshUserData()
    const env = environment({
      startup: a,
      registered: [a, b],
      directories: [a, b, home],
      home,
      userDataDir,
    })
    const calls = { revealed: [], copied: [], alerts: [], projectInfo: [], switched: [], forgot: [] }
    const actions = createWorkspaceActions({
      active: env.active,
      userDataDir,
      strings: catalogFor('zh-CN'),
      effects: {
        pickDirectory: () => undefined,
        confirmSwitch: () => true,
        confirmForget: () => true,
        revealPath: (path) => calls.revealed.push(path),
        copyText: (text) => calls.copied.push(text),
        alert: (message) => calls.alerts.push(message),
        refreshRecent: () => calls.refreshed = (calls.refreshed ?? 0) + 1,
      },
      onSwitchWorkspace: (dir) => calls.switched.push(dir),
      onForgetWorkspace: (dir) => calls.forgot.push(dir),
      onProjectInfo: (workspace) => calls.projectInfo.push(workspace),
    })

    await check('启动时（active = A）三个入口都指向 A', () => {
      actions.projectInfo()
      actions.revealWorkspace()
      actions.copyWorkspacePath()
      assert.deepEqual(calls.projectInfo, [a])
      assert.deepEqual(calls.revealed, [a])
      assert.deepEqual(calls.copied, [a])
    })

    // Harness UI 里切到 B —— 外壳没有重启。
    env.active.reportFromHarness(b)
    await check('切到 B 之后：Project Info 显示 B', () => {
      actions.projectInfo()
      assert.equal(calls.projectInfo.at(-1), b)
    })
    await check('切到 B 之后：Reveal 打开 B', () => {
      actions.revealWorkspace()
      assert.equal(calls.revealed.at(-1), b)
    })
    await check('切到 B 之后：Copy 复制 B（BUG B 的直接验收点）', () => {
      actions.copyWorkspacePath()
      assert.equal(calls.copied.at(-1), b)
    })
    await check('默认不把路径换成启动值', () => {
      assert.notEqual(calls.copied.at(-1), a)
    })

    await check('openFolder 用当前值判断"是不是同一个目录"', () => {
      // 选择器返回 B（就是当前值）→ 不该重启。
      const pickB = createWorkspaceActions({
        active: env.active,
        userDataDir,
        strings: catalogFor('zh-CN'),
        effects: {
          pickDirectory: () => b,
          confirmSwitch: () => true,
          confirmForget: () => true,
          revealPath: () => {},
          copyText: () => {},
          alert: () => {},
          refreshRecent: () => {},
        },
        onSwitchWorkspace: (dir) => calls.switched.push(dir),
        onForgetWorkspace: () => {},
        onProjectInfo: () => {},
      })
      pickB.openFolder()
      assert.deepEqual(calls.switched, [], '选中当前工作区不该触发切换')
    })
  }

  // =====================================================================
  console.log('')
  console.log('=== 7. 菜单动作：工作区已删除时绝不静默操作旧路径 ===')
  // =====================================================================
  {
    const a = makeDir('gone-a')
    const home = makeDir('gone-home')
    const userDataDir = freshUserData()
    const env = environment({
      startup: a,
      registered: [a],
      directories: [a, home],
      home,
      userDataDir,
    })
    const calls = { revealed: [], copied: [], alerts: [], refreshed: 0 }
    const actions = createWorkspaceActions({
      active: env.active,
      userDataDir,
      strings: catalogFor('zh-CN'),
      effects: {
        pickDirectory: () => undefined,
        confirmSwitch: () => true,
        confirmForget: () => true,
        revealPath: (path) => calls.revealed.push(path),
        copyText: (text) => calls.copied.push(text),
        alert: (message) => calls.alerts.push(message),
        refreshRecent: () => {
          calls.refreshed += 1
        },
      },
      onSwitchWorkspace: () => {},
      onForgetWorkspace: () => {},
      onProjectInfo: () => {},
    })

    // 用户在文件管理器里把当前工作区删了（真的删磁盘目录：`guardCurrent` 走的是
    // `pruneRecent` 那套真实文件系统判定，因此测试也必须真的删）。
    rmSync(a, { recursive: true, force: true })
    env.directories.delete(real(a))

    await check('Reveal：不打开已删除的路径', () => {
      actions.revealWorkspace()
      assert.deepEqual(calls.revealed, [])
    })
    await check('Reveal：给出"工作区已不存在"的提示（不静默失败）', () => {
      assert.equal(calls.alerts.length, 1)
      assert.equal(calls.alerts[0].type, 'warning')
      assert.ok(calls.alerts[0].title.includes('工作区已不存在'), calls.alerts[0].title)
      assert.ok(calls.alerts[0].detail.includes(a), '提示里应点名那个路径')
    })
    await check('Reveal：触发了工作区对账（菜单随之重建）', () => assert.equal(calls.refreshed, 1))
    await check('对账后 active 已换成一个仍然存在的目录', () => assert.equal(env.active.get(), home))
    await check('对账已落盘', () => assert.equal(readSettings(userDataDir).workspace, home))

    await check('Copy：不复制 stale 路径', () => {
      actions.copyWorkspacePath()
      // 对账之后 active 已经是 home，所以复制的是 home —— 关键是绝不复制那个不存在的目录。
      assert.ok(!calls.copied.includes(a), JSON.stringify(calls.copied))
      assert.equal(calls.copied.at(-1), home)
    })
  }

  // =====================================================================
  console.log('')
  console.log('=== 8. 菜单动作：Open Recent 点击时再验一次 + 真的落盘清理 ===')
  // =====================================================================
  {
    const alive = makeDir('recent-alive')
    const doomed = makeDir('recent-doomed')
    const userDataDir = freshUserData()
    switchWorkspace(userDataDir, doomed)
    switchWorkspace(userDataDir, alive)

    const env = environment({
      startup: alive,
      registered: [alive],
      directories: [alive],
      home: alive,
      userDataDir,
    })
    const calls = { switched: [], alerts: [], refreshed: 0 }
    const actions = createWorkspaceActions({
      active: env.active,
      userDataDir,
      strings: catalogFor('zh-CN'),
      effects: {
        pickDirectory: () => undefined,
        confirmSwitch: () => true,
        confirmForget: () => true,
        revealPath: () => {},
        copyText: () => {},
        alert: (message) => calls.alerts.push(message),
        refreshRecent: () => {
          calls.refreshed += 1
        },
      },
      onSwitchWorkspace: (dir) => calls.switched.push(dir),
      onForgetWorkspace: () => {},
      onProjectInfo: () => {},
    })

    await check('菜单构建时 doomed 还在（构建发生在删除之前）', () =>
      assert.ok(actions.recent.some((entry) => entry.path === doomed)))

    // 关键场景：菜单构建时目录还在，用户在这之后删掉它，然后才点击（需求 17）。
    rmSync(doomed, { recursive: true, force: true })
    actions.openRecent(doomed)
    await check('点击已删除的条目：不重启到不存在的路径', () => assert.deepEqual(calls.switched, []))
    await check('点击已删除的条目：给出提示', () => {
      assert.equal(calls.alerts.length, 1)
      assert.ok(calls.alerts[0].title.includes('工作区已不存在'))
    })
    await check('点击已删除的条目：把过滤结果**写回磁盘**（prune + persist）', () => {
      const raw = readSettings(userDataDir)
      assert.deepEqual(raw.recent, [alive])
    })
    await check('点击已删除的条目：重建菜单', () => assert.equal(calls.refreshed, 1))

    actions.openRecent(alive)
    await check('点击仍然存在的条目：走切换（是否为当前值由 restartIntoWorkspace 挡）', () =>
      assert.deepEqual(calls.switched, [alive]))

    actions.openRecent('')
    await check('空条目什么都不做（也不提示）', () => {
      assert.deepEqual(calls.switched, [alive])
      assert.equal(calls.alerts.length, 1)
    })
  }

  // =====================================================================
  console.log('')
  console.log('=== 9. 「从最近项目中移除」≠「移除工作区」 ===')
  // =====================================================================
  {
    const a = makeDir('semantics-a')
    const b = makeDir('semantics-b')
    const userDataDir = freshUserData()
    switchWorkspace(userDataDir, a)
    switchWorkspace(userDataDir, b)

    const env = environment({
      startup: b,
      registered: [a, b],
      directories: [a, b],
      home: b,
      userDataDir,
    })
    const calls = { forgot: [], switched: [], refreshed: 0, confirmed: [] }
    const actions = createWorkspaceActions({
      active: env.active,
      userDataDir,
      strings: catalogFor('zh-CN'),
      effects: {
        pickDirectory: () => undefined,
        confirmSwitch: () => true,
        confirmForget: (dir) => {
          calls.confirmed.push(dir)
          return true
        },
        revealPath: () => {},
        copyText: () => {},
        alert: () => {},
        refreshRecent: () => {
          calls.refreshed += 1
        },
      },
      onSwitchWorkspace: (dir) => calls.switched.push(dir),
      onForgetWorkspace: (dir) => calls.forgot.push(dir),
      onProjectInfo: () => {},
    })

    actions.removeRecent(a)
    await check('Remove from Recent：只删 recent', () => {
      assert.ok(!(readSettings(userDataDir).recent ?? []).includes(a))
    })
    await check('Remove from Recent：**不**触发 unregister', () => assert.deepEqual(calls.forgot, []))
    await check('Remove from Recent：**不**触发切换', () => assert.deepEqual(calls.switched, []))
    await check('Remove from Recent：重建菜单', () => assert.equal(calls.refreshed, 1))
    await check('Remove from Recent：磁盘目录仍在', () => assert.ok(existsSync(a)))

    actions.forgetWorkspace(a)
    await check('Forget Workspace：先确认再执行', () => {
      assert.deepEqual(calls.confirmed, [a])
      assert.deepEqual(calls.forgot, [a])
    })
    await check('Forget Workspace：**不**动 recent 记录（两件事不互相触发）', () => {
      // a 已经在上一段被移除了；这里确认 forget 没有额外写 recent。
      assert.deepEqual(readSettings(userDataDir).recent, [b])
    })

    const cancelActions = createWorkspaceActions({
      active: env.active,
      userDataDir,
      strings: catalogFor('zh-CN'),
      effects: {
        pickDirectory: () => undefined,
        confirmSwitch: () => true,
        confirmForget: () => false,
        revealPath: () => {},
        copyText: () => {},
        alert: () => {},
        refreshRecent: () => {},
      },
      onSwitchWorkspace: () => {},
      onForgetWorkspace: (dir) => calls.forgot.push(dir),
      onProjectInfo: () => {},
    })
    cancelActions.forgetWorkspace(b)
    await check('确认框取消 → 什么都不做', () => assert.deepEqual(calls.forgot, [a]))

    actions.forgetWorkspace()
    await check('不带参数时默认对**当前**工作区执行', () => assert.equal(calls.forgot.at(-1), b))
  }

  // =====================================================================
  console.log('')
  console.log('=== 10. 菜单模板：新条目 + 语言重建后命令不变、工作区仍跟随 ===')
  // =====================================================================
  {
    const a = makeDir('menu-a')
    const b = makeDir('menu-b')
    const userDataDir = freshUserData()
    switchWorkspace(userDataDir, a)

    const env = environment({
      startup: a,
      registered: [a, b],
      directories: [a, b],
      home: a,
      userDataDir,
    })
    const calls = { copied: [] }
    const actions = createWorkspaceActions({
      active: env.active,
      userDataDir,
      strings: catalogFor('zh-CN'),
      effects: {
        pickDirectory: () => undefined,
        confirmSwitch: () => true,
        confirmForget: () => true,
        revealPath: () => {},
        copyText: (text) => calls.copied.push(text),
        alert: () => {},
        refreshRecent: () => {},
      },
      onSwitchWorkspace: () => {},
      onForgetWorkspace: () => {},
      onProjectInfo: () => {},
    })
    const depsFor = (strings) => ({
      strings,
      recent: actions.recent,
      runtimeVersion: '0.1.5-rc.2',
      // 占位即可：这里断言的是菜单结构与命令，不涉及版本号本身。写死真实版本会让
      // 这个文件每发一版就过期一次。
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

    const zh = applicationMenuTemplate(depsFor(catalogFor('zh-CN')))
    const fileMenu = zh[0].submenu
    const labels = fileMenu.map((item) => item.label ?? `(separator:${String(item.type)})`)
    await check('「文件」菜单里有「移除工作区…」', () => assert.ok(labels.includes('移除工作区…')))
    await check('「最近打开」是两层：打开项 + 「从最近项目中移除」子菜单', () => {
      const openRecent = fileMenu.find((item) => item.label === '最近打开')
      assert.ok(Array.isArray(openRecent.submenu), '最近打开应当有子菜单')
      const remove = openRecent.submenu.find((item) => item.label === '从最近项目中移除')
      assert.ok(remove !== undefined, `子菜单里没有「从最近项目中移除」：${JSON.stringify(openRecent.submenu.map((i) => i.label))}`)
      assert.ok(Array.isArray(remove.submenu) && remove.submenu.length > 0)
      // 打开项本身仍然直接可点（移到子菜单里会让"打开"变成两次点击）。
      const openEntry = openRecent.submenu.find((item) => item.label === actions.recent[0].label)
      assert.equal(typeof openEntry.click, 'function')
    })

    // 语言变化 → 重建：文案变了，命令必须完全不变（同一个函数引用）。
    const en = applicationMenuTemplate(depsFor(catalogFor('en-US')))
    const enFile = en[0].submenu
    await check('英文菜单有对应条目', () => {
      const enLabels = enFile.map((item) => item.label)
      assert.ok(enLabels.includes('Forget Workspace…'))
      const openRecent = enFile.find((item) => item.label === 'Open Recent')
      assert.ok(openRecent.submenu.some((item) => item.label === 'Remove from Recent'))
    })
    await check('重建只换文案：命令逐一相同', () => {
      assert.equal(zh.length, en.length)
      zh.forEach((item, index) => {
        assert.equal(item.click, en[index].click, `第 ${String(index)} 项的 click 变了`)
        assert.equal(item.role, en[index].role)
        assert.equal(item.accelerator, en[index].accelerator)
      })
    })

    // 需求 28 的验收点：A → Harness 切 B → 语言 zh→en → 点「复制工作区路径」必须复制 B。
    env.active.reportFromHarness(b)
    setShellLocale('en-US')
    const enActions = createWorkspaceActions({
      active: env.active,
      userDataDir,
      strings: catalogFor('en-US'),
      effects: {
        pickDirectory: () => undefined,
        confirmSwitch: () => true,
        confirmForget: () => true,
        revealPath: () => {},
        copyText: (text) => calls.copied.push(text),
        alert: () => {},
        refreshRecent: () => {},
      },
      onSwitchWorkspace: () => {},
      onForgetWorkspace: () => {},
      onProjectInfo: () => {},
    })
    const rebuilt = applicationMenuTemplate({
      ...depsFor(catalogFor('en-US')),
      copyWorkspacePath: enActions.copyWorkspacePath,
      projectInfo: enActions.projectInfo,
      revealWorkspace: enActions.revealWorkspace,
    })
    rebuilt[0].submenu.find((item) => item.label === 'Copy Workspace Path').click()
    await check('A → Harness 切 B → locale zh→en → Copy 复制的仍是 B', () =>
      assert.equal(calls.copied.at(-1), b))
    await check('不是启动时的 A', () => assert.notEqual(calls.copied.at(-1), a))
    setShellLocale('zh-CN')
  }
} catch (error) {
  failed += 1
  console.error(`测试异常: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  try {
    if (!resolve(scratch).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe cleanup path')
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    // 清理失败不影响结论。
  }
}

console.log('')
console.log(`${passed} 项通过${failed === 0 ? '' : `，${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
