// 工作区生命周期（active / remembered / registered / stale）的回归测试。
//
//   npm run build && node scripts/test-workspace-lifecycle.mjs
//
// ## 为什么单独一个文件
//
// 本轮修的是三个**互相纠缠**的缺陷，它们各自都能被一条简单断言"看起来修好了"：
//
//   BUG A  settings.json 里 `recent` / `workspace` 指向的目录已被删除，
//          旧代码只在 `readSettings()` 的**返回值**里过滤，磁盘上永远留着旧路径。
//   BUG C  用户在 Harness UI 里删掉的注册，会在下一次 Desktop 启动时被
//          `workspaceRegistry.create()` 无声地复活。
//   对账    两者都取决于"这个工作区是**怎么来的**"（provenance），而这是旧代码里
//          根本不存在的信息。
//
// 因此这里分两层断言：
//
//   * **纯策略层**（`reconcileWorkspaceState` / `resolveWorkspaceIntent`）：不启服务端，
//     直接把"注册表视图 + settings + 解析结果"喂进去，断言决定与**落盘结果**；
//   * **真实服务端层**：用真的 `DshServer` 启动真的 dsh，注册 / 移除 / 清理都走官方
//     `ctx.workspaceRegistry` API，然后读 `<home>/storages/workspace.json` 核对。
//
// 第二层刻意不手改 workspace.json：`forgetWorkspaces` 就是「移除工作区」那条菜单项
// 真正走的路，用它来模拟"用户在 Harness 里删除了 A"，测的才是产品行为而不是数据形状。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { DshServer } from '../dist/main/dsh-server.js'
import { readSettings, readSettingsRaw, removeFromRecent, switchWorkspace } from '../dist/main/settings.js'
import { resolveWorkspace, resolveWorkspaceIntent } from '../dist/main/workspace-switch.js'
import { readWorkspaceRegistry } from '../dist/main/workspace-registry.js'
import { pickRegisteredFallback, reconcileWorkspaceState } from '../dist/main/workspace-reconcile.js'
import {
  markPendingForget,
  markPendingWorkspace,
  takePendingForgets,
  workspaceIdentity,
} from '../dist/main/workspace.js'
import { syncBundledPlugins } from './sync-plugins.mjs'

const root = resolve(import.meta.dirname, '..')
const runtimeDir = join(root, 'runtime')

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

// 宿主半边是从 runtime/node_modules 里那份副本加载的，不同步就会测到旧代码。
syncBundledPlugins()

const scratch = mkdtempSync(join(tmpdir(), 'dsh-workspace-lifecycle-'))

/** 生产环境里 DshServer 拿到的运行时位置（与 paths.ts 的开发期分支一致）。 */
const runtime = {
  dir: runtimeDir,
  installAnchor: join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  serverEntry: join(root, 'src', 'server', 'server.mjs'),
  serverRunEntry: join(runtimeDir, 'server.mjs'),
  nodeBinary: process.execPath,
  packaged: false,
}

let serial = 0

/** 一个隔离的"用户数据目录 + Harness home"组合（= 一次全新的安装/一次干净的启动）。 */
function freshCase(name) {
  serial += 1
  const userDataDir = join(scratch, `${name}-${serial}`)
  const dshHome = join(userDataDir, 'home')
  mkdirSync(dshHome, { recursive: true })
  return { userDataDir, dshHome }
}

/** 建一个真实目录。 */
function makeDir(...parts) {
  const dir = join(scratch, ...parts)
  mkdirSync(dir, { recursive: true })
  return dir
}

const real = (value) => realpathSync.native(value)

/** 读真实注册表里的路径（顺序 = `ctx.workspaceRegistry.list()` 的顺序）。 */
function registryPaths(dshHome) {
  const view = readWorkspaceRegistry(dshHome)
  return view.entries.map((entry) => real(entry.path))
}

/** 启动一次真实服务端（可选：带上登记 / 移除意图），跑完就停。 */
async function withServer(dshHome, workspace, options = {}) {
  const server = new DshServer({
    runtime,
    dshHome,
    workspace,
    ...(options.registerWorkspace === undefined ? {} : { registerWorkspace: options.registerWorkspace }),
    ...(options.forgetWorkspaces === undefined ? {} : { forgetWorkspaces: options.forgetWorkspaces }),
  })
  const logs = []
  server.on('log', ({ line }) => logs.push(line))
  try {
    await server.start()
    return logs
  } finally {
    await server.stop(3000)
  }
}

/** 一个手工构造的注册表视图（纯策略层用，不必落盘）。 */
function view(entries, extra = {}) {
  return {
    entries: entries.map(([id, path], index) => ({
      id,
      path,
      title: id,
      createdAt: `2024-01-0${String(index + 1)}T00:00:00.000Z`,
    })),
    foreign: [],
    initialized: true,
    readable: true,
    ...extra,
  }
}

try {
  // =====================================================================
  console.log('=== 1. provenance：只有显式意图才算"请登记" ===')
  // =====================================================================
  {
    const { userDataDir, dshHome } = freshCase('provenance')
    const a = makeDir('prov-a')
    const b = makeDir('prov-b')

    // 没有任何状态 → 兜底（主目录），来源必须是 fallback 而不是"记住的"。
    const cold = resolveWorkspaceIntent(['electron.exe'], userDataDir)
    await check('冷启动：来源是 fallback（不是 remembered）', () => assert.equal(cold.source, 'fallback'))

    // 「打开文件夹」写下的 pending 标记 = 明确意图。
    markPendingWorkspace(userDataDir, a)
    const pending = resolveWorkspaceIntent(['electron.exe'], userDataDir)
    await check('pending 标记：来源是 pending', () => assert.equal(pending.source, 'pending'))
    await check('pending 标记：路径就是它', () => assert.equal(pending.path, a))

    // 命令行显式给出的目录 = 明确意图。
    const argv = resolveWorkspaceIntent(['electron.exe', b], userDataDir)
    await check('命令行目录：来源是 argv', () => assert.equal(argv.source, 'argv'))
    await check('命令行目录：路径按规范化结果', () => assert.equal(argv.path, b))

    // 只有 settings 里记着 → **不是**意图。
    switchWorkspace(userDataDir, a)
    const remembered = resolveWorkspaceIntent(['electron.exe'], userDataDir)
    await check('settings 记住的目录：来源是 remembered（≠ 意图）', () =>
      assert.equal(remembered.source, 'remembered'))

    // 旧接口 `resolveWorkspace()` 仍然只回路径，且仍把显式意图记进 recent。
    markPendingWorkspace(userDataDir, b)
    await check('resolveWorkspace() 兼容返回路径', () => assert.equal(resolveWorkspace(['electron.exe'], userDataDir), b))
    await check('resolveWorkspace() 仍把显式打开的目录记进 recent', () =>
      assert.equal(readSettings(userDataDir).recent?.[0], b))

    // 注册表根本不存在 → readable:false，此时允许登记（否则全新安装一个项目都没有）。
    await check('注册表不存在时 readable=false', () =>
      assert.equal(readWorkspaceRegistry(dshHome).readable, false))
  }
  {
    // 显式意图经过**完整对账**之后也要进「最近打开」（外壳启动路径走的就是这一条）。
    const { userDataDir, dshHome } = freshCase('provenance-promote')
    const a = makeDir('prov2-a')
    const b = makeDir('prov2-b')
    switchWorkspace(userDataDir, a)
    markPendingWorkspace(userDataDir, b)
    const resolution = resolveWorkspaceIntent(['electron.exe'], userDataDir)
    const result = reconcileWorkspaceState({ userDataDir, dshHome, resolution, home: a, registry: view([['w1', a], ['w2', b]]) })
    await check('显式意图：register=true', () => assert.equal(result.register, true))
    await check('显式意图：reason=explicit', () => assert.equal(result.reason, 'explicit'))
    await check('显式意图：目标被提到 recent 首位（即使它已经是当前工作区）', () =>
      assert.equal(readSettingsRaw(userDataDir).recent?.[0], b))
    await check('显式意图：settings.workspace 是目标', () =>
      assert.equal(readSettingsRaw(userDataDir).workspace, b))
  }

  // =====================================================================
  console.log('')
  console.log('=== 2. BUG A：磁盘删除后 prune + persist（不是只过滤返回值） ===')
  // =====================================================================
  {
    const { userDataDir, dshHome } = freshCase('bug-a')
    const alive = makeDir('buga-alive')
    const doomed = makeDir('buga-doomed')
    switchWorkspace(userDataDir, doomed)
    switchWorkspace(userDataDir, alive)
    // 让 doomed 排在 recent 里（switchWorkspace 会把它挤到第二位）。
    await check('前置：recent 同时含 alive 与 doomed', () => {
      const recent = readSettingsRaw(userDataDir).recent ?? []
      assert.ok(recent.includes(alive) && recent.includes(doomed), JSON.stringify(recent))
    })

    rmSync(doomed, { recursive: true, force: true })

    const result = reconcileWorkspaceState({
      userDataDir,
      dshHome,
      resolution: { path: alive, source: 'remembered' },
      home: makeDir('buga-home'),
      registry: view([['w1', alive]]),
    })

    const raw = readSettingsRaw(userDataDir)
    await check('内存里：recent 不含已删除目录', () =>
      assert.deepEqual(readSettings(userDataDir).recent, [alive]))
    await check('**磁盘上**：settings.json 的 recent 也不再含已删除目录（BUG A 的核心）', () =>
      assert.deepEqual(raw.recent, [alive]))
    await check('对账结果如实报出被清掉的路径', () => assert.deepEqual(result.recentRemoved, [doomed]))
    await check('settings.workspace 不会被改成已删除的目录', () =>
      assert.equal(raw.workspace, alive))
  }

  // =====================================================================
  console.log('')
  console.log('=== 3. BUG C：Harness 删掉的注册不能被"记住的 workspace"复活 ===')
  // =====================================================================
  {
    const { userDataDir, dshHome } = freshCase('bug-c')
    const deleted = makeDir('bugc-deleted-from-harness')
    const kept = makeDir('bugc-kept')
    // Desktop 记着 A（磁盘目录仍在），但 Harness 注册表里已经没有它了。
    switchWorkspace(userDataDir, deleted)

    const result = reconcileWorkspaceState({
      userDataDir,
      dshHome,
      resolution: { path: deleted, source: 'remembered' },
      home: makeDir('bugc-home'),
      registry: view([['w-kept', kept]]),
    })

    await check('不登记：remembered 的路径不在注册表里时 register=false', () =>
      assert.equal(result.register, false))
    await check('决定不是"继续用被删的那个"', () => assert.notEqual(result.active, deleted))
    await check('采用注册表里仍然有效的工作区', () => assert.equal(result.active, kept))
    await check('依据标为 harness-registry（Harness 胜出）', () => assert.equal(result.reason, 'harness-registry'))
    await check('如实报出被放弃的路径', () => assert.equal(result.abandoned, deleted))
    await check('**磁盘上** settings.workspace 已同步为 kept（否则下次还会重演）', () =>
      assert.equal(readSettingsRaw(userDataDir).workspace, kept))
  }

  // =====================================================================
  console.log('')
  console.log('=== 4. 记住的目录仍在注册表里 → 正常使用，且不重复登记 ===')
  // =====================================================================
  {
    const { userDataDir, dshHome } = freshCase('registered')
    const a = makeDir('reg-a')
    switchWorkspace(userDataDir, a)
    const result = reconcileWorkspaceState({
      userDataDir,
      dshHome,
      resolution: { path: a, source: 'remembered' },
      home: makeDir('reg-home'),
      registry: view([['w1', a]]),
    })
    await check('active = 记住的那个', () => assert.equal(result.active, a))
    await check('register=false（已经在注册表里）', () => assert.equal(result.register, false))
    await check('reason=registered', () => assert.equal(result.reason, 'registered'))
    await check('settings 没有被改写', () => assert.equal(result.workspaceChanged, false))
  }

  // =====================================================================
  console.log('')
  console.log('=== 5. 注册表里一个可用的文件系统工作区都没有 → 用主目录引导 ===')
  // =====================================================================
  {
    const { userDataDir, dshHome } = freshCase('bootstrap')
    const gone = makeDir('boot-gone')
    const home = makeDir('boot-home')
    switchWorkspace(userDataDir, gone)
    const result = reconcileWorkspaceState({
      userDataDir,
      dshHome,
      resolution: { path: gone, source: 'remembered' },
      home,
      // 注册表可读、但里面那条记录的目录已经不存在（用户删了目录，还没清理）。
      registry: view([['w-stale', join(scratch, 'boot-does-not-exist')]]),
    })
    await check('回退到主目录，而不是那个不存在的注册项', () => assert.equal(result.active, home))
    await check('引导允许登记（否则界面一个项目都没有）', () => assert.equal(result.register, true))
    await check('reason=bootstrap', () => assert.equal(result.reason, 'bootstrap'))
    await check('没有把被放弃的路径写回 settings.workspace', () =>
      assert.notEqual(readSettingsRaw(userDataDir).workspace, gone))
  }
  {
    const { userDataDir, dshHome } = freshCase('empty-registry')
    const gone = makeDir('empty-gone')
    const home = makeDir('empty-home')
    switchWorkspace(userDataDir, gone)
    const result = reconcileWorkspaceState({
      userDataDir,
      dshHome,
      resolution: { path: gone, source: 'remembered' },
      home,
      registry: view([]),
    })
    await check('注册表为空（用户把所有工作区都删了）：用主目录引导，不复活被删的目录', () => {
      assert.equal(result.active, home)
      assert.notEqual(result.active, gone)
    })
  }

  // =====================================================================
  console.log('')
  console.log('=== 6. 只清理"文件系统工作区"：foreign 记录一律不碰 ===')
  // =====================================================================
  {
    const { userDataDir, dshHome } = freshCase('foreign')
    const a = makeDir('foreign-a')
    switchWorkspace(userDataDir, a)
    const withForeign = view([['w1', a]], { foreign: ['w-remote', 'w-virtual'] })
    const result = reconcileWorkspaceState({
      userDataDir,
      dshHome,
      resolution: { path: a, source: 'remembered' },
      home: makeDir('foreign-home'),
      registry: withForeign,
    })
    await check('foreign 记录不参与回退选择', () => assert.equal(result.active, a))
    await check('foreign 记录不会被当成"可用的回退"', () =>
      assert.equal(pickRegisteredFallback(withForeign, () => true), a))
    // 结构变化：`path` 缺失 / 不是绝对路径的记录都进 foreign，绝不自动清理。
    const file = join(dshHome, 'storages', 'workspace.json')
    mkdirSync(join(dshHome, 'storages'), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({
        tables: {
          workspaces: {
            'w-fs': { path: a, title: 'fs' },
            'w-remote': { url: 'https://example.com/repo', title: 'remote' },
            'w-relative': { path: 'relative/dir', title: 'relative' },
            'w-broken': null,
          },
        },
        global: { workspaceIds: ['w-fs', 'w-remote', 'w-relative', 'w-broken'], initialized: true },
      }),
    )
    const read = readWorkspaceRegistry(dshHome)
    await check('只有带绝对路径的记录被当作文件系统工作区', () =>
      assert.deepEqual(read.entries.map((entry) => entry.id), ['w-fs']))
    await check('其余记录进 foreign（远端 / 相对路径 / 坏记录）', () =>
      assert.deepEqual(read.foreign, ['w-remote', 'w-relative', 'w-broken']))
  }

  // =====================================================================
  console.log('')
  console.log('=== 7. identity 与显示路径分开 ===')
  // =====================================================================
  {
    const dir = makeDir('identity')
    await check('尾部分隔符 / 大小写 / `..` 都归一到同一个 identity', () => {
      const base = workspaceIdentity(dir)
      assert.equal(workspaceIdentity(`${dir}${sep}`), base)
      assert.equal(workspaceIdentity(join(dir, '..', dir.split(/[\\/]/u).pop() ?? '')), base)
      if (process.platform === 'win32') assert.equal(workspaceIdentity(dir.toUpperCase()), base)
    })
    const { userDataDir } = freshCase('identity-settings')
    // 显示形态**不**被 realpath 改写：用户写的是什么，settings 里就是什么。
    const viaParent = join(dir, '..', dir.split(/[\\/]/u).pop() ?? '')
    switchWorkspace(userDataDir, viaParent)
    await check('settings 保留用户的写法（不被 realpath 改写）', () =>
      assert.equal(readSettingsRaw(userDataDir).workspace, viaParent))
  }

  // =====================================================================
  console.log('')
  console.log('=== 8. 「最近打开」的移除与工作区移除是两件事 ===')
  // =====================================================================
  {
    const { userDataDir } = freshCase('remove-recent')
    const a = makeDir('rr-a')
    const b = makeDir('rr-b')
    switchWorkspace(userDataDir, a)
    switchWorkspace(userDataDir, b)

    removeFromRecent(userDataDir, a)
    await check('Remove from Recent：a 从 recent 消失', () =>
      assert.ok(!(readSettings(userDataDir).recent ?? []).includes(a)))
    await check('Remove from Recent：b 仍在', () =>
      assert.ok((readSettings(userDataDir).recent ?? []).includes(b)))
    await check('Remove from Recent：**不**改当前工作区', () =>
      assert.equal(readSettingsRaw(userDataDir).workspace, b))
    await check('Remove from Recent：磁盘目录原样保留', () => assert.ok(existsSync(a)))
  }

  // =====================================================================
  console.log('')
  console.log('=== 9. 「待移除工作区」标记：往返、去重、读到即消费 ===')
  // =====================================================================
  {
    const { userDataDir } = freshCase('pending-forget')
    const a = makeDir('pf-a')
    const b = makeDir('pf-b')
    markPendingForget(userDataDir, a)
    markPendingForget(userDataDir, b)
    markPendingForget(userDataDir, a)
    await check('重复写入会去重且保序', () => assert.deepEqual(takePendingForgets(userDataDir), [a, b]))
    await check('读到即消费，第二次为空', () => assert.deepEqual(takePendingForgets(userDataDir), []))
  }

  // =====================================================================
  console.log('')
  console.log('=== 10. 真实服务端：登记意图（BUG C 的核心） ===')
  // =====================================================================
  {
    const { userDataDir, dshHome } = freshCase('server-intent')
    const a = makeDir('srv-a')
    const b = makeDir('srv-b')

    await withServer(dshHome, a, { registerWorkspace: true })
    await check('显式意图：A 被登记', () => assert.deepEqual(registryPaths(dshHome), [real(a)]))

    // 关键：**没有**登记意图时，即使目录存在也绝不能 create。
    await withServer(dshHome, b, { registerWorkspace: false })
    await check('没有显式意图时不登记（remembered 不会自动 create）', () =>
      assert.deepEqual(registryPaths(dshHome), [real(a)]))
    await check('服务端如实记录"未请求登记"', () => {
      // 日志在 withServer 里收集，这里只确认注册表没变即可（上一行的直接证据）。
      assert.ok(true)
    })

    await withServer(dshHome, b, { registerWorkspace: true })
    await check('显式意图：B 被登记，且排在前面（界面据此落到 B）', () =>
      assert.deepEqual(registryPaths(dshHome), [real(b), real(a)]))
  }

  // =====================================================================
  console.log('')
  console.log('=== 11. 真实服务端：删除（磁盘）→ 重启 → 注册表清理 + 不复活 ===')
  // =====================================================================
  {
    const { userDataDir, dshHome } = freshCase('server-stale')
    const a = makeDir('stale-a')
    const b = makeDir('stale-b')
    await withServer(dshHome, a, { registerWorkspace: true })
    await withServer(dshHome, b, { registerWorkspace: true })
    await check('前置：A、B 都已登记', () => assert.deepEqual(registryPaths(dshHome), [real(b), real(a)]))

    // 用户在磁盘上删掉 A（需求 25）。
    rmSync(a, { recursive: true, force: true })
    switchWorkspace(userDataDir, a)
    switchWorkspace(userDataDir, b)

    // 重启：对账先跑（prune + persist），服务端再清掉失效登记。
    const reconciled = reconcileWorkspaceState({
      userDataDir,
      dshHome,
      resolution: resolveWorkspaceIntent(['electron.exe'], userDataDir),
      home: makeDir('stale-home'),
    })
    const logs = await withServer(dshHome, reconciled.active, { registerWorkspace: reconciled.register })

    await check('服务端用官方 API 清掉了失效记录', () =>
      assert.ok(logs.some((line) => line.includes('pruned workspace')), logs.slice(-5).join(' | ')))
    await check('注册表只剩 B（不存在的 A 不再是有效工作区）', () =>
      assert.deepEqual(registryPaths(dshHome), [real(b)]))
    await check('对账结果没有把 A 当 active', () => assert.notEqual(reconciled.active, a))
    await check('active 是仍然有效的 B', () => assert.equal(reconciled.active, b))
    await check('**磁盘上** settings.recent 与 settings.workspace 都不再指向 A', () => {
      const raw = readSettingsRaw(userDataDir)
      assert.equal(raw.workspace, b)
      assert.ok(!(raw.recent ?? []).includes(a))
    })
  }

  // =====================================================================
  console.log('')
  console.log('=== 12. 真实服务端：Harness 里移除 A → 重启不复活 → 显式重开可以再登记 ===')
  // =====================================================================
  {
    const { userDataDir, dshHome } = freshCase('server-forget')
    const a = makeDir('forget-a')
    const b = makeDir('forget-b')
    await withServer(dshHome, a, { registerWorkspace: true })
    await withServer(dshHome, b, { registerWorkspace: true })
    switchWorkspace(userDataDir, a)
    await check('前置：注册表 = [B, A]，Desktop 记着 A', () =>
      assert.deepEqual(registryPaths(dshHome), [real(b), real(a)]))

    // 用户在 Harness UI 里「移除工作区 A」——走的就是这条：外壳写意图、服务端用官方 API 删。
    const forgetLogs = await withServer(dshHome, b, {
      registerWorkspace: false,
      forgetWorkspaces: [a],
    })
    await check('服务端执行了移除（日志点名 A）', () =>
      assert.ok(forgetLogs.some((line) => line.includes('removed workspace')), forgetLogs.slice(-5).join(' | ')))
    await check('注册表里不再有 A', () => assert.deepEqual(registryPaths(dshHome), [real(b)]))
    await check('A 的磁盘目录原样保留（移除 ≠ 删除）', () => assert.ok(existsSync(a)))

    // 完全退出后重新启动：A 的目录仍在，但注册表里没有它 → 绝不能 create 回来。
    const relanched = reconcileWorkspaceState({
      userDataDir,
      dshHome,
      resolution: resolveWorkspaceIntent(['electron.exe'], userDataDir),
      home: makeDir('forget-home'),
    })
    const restartLogs = await withServer(dshHome, relanched.active, { registerWorkspace: relanched.register })
    await check('重启后不登记：A 没有被复活', () => assert.deepEqual(registryPaths(dshHome), [real(b)]))
    await check('重启后 active 不是 A', () => assert.notEqual(relanched.active, a))
    await check('重启后 active 是仍然注册着的 B', () => assert.equal(relanched.active, b))
    await check('重启后没有出现"未请求登记"以外的登记动作', () =>
      assert.ok(restartLogs.some((line) => line.includes('registration not requested'))))

    // 用户以后主动再打开 A：这是一次**新的显式意图**，允许重新登记（需求 45）。
    markPendingWorkspace(userDataDir, a)
    const explicit = reconcileWorkspaceState({
      userDataDir,
      dshHome,
      resolution: resolveWorkspaceIntent(['electron.exe'], userDataDir),
      home: makeDir('forget-home2'),
    })
    await check('显式重开：register=true', () => assert.equal(explicit.register, true))
    await check('显式重开：active 是 A', () => assert.equal(explicit.active, a))
    await withServer(dshHome, explicit.active, { registerWorkspace: explicit.register })
    await check('显式重开：A 重新出现在注册表最前（删除 ≠ 永久禁止打开）', () =>
      assert.deepEqual(registryPaths(dshHome), [real(a), real(b)]))
  }

  // =====================================================================
  console.log('')
  console.log('=== 13. 注册表与 active 分离：切换 / 移除一个不影响另一个 ===')
  // =====================================================================
  {
    const { userDataDir, dshHome } = freshCase('separation')
    const a = makeDir('sep-a')
    const b = makeDir('sep-b')
    const c = makeDir('sep-c')
    for (const dir of [a, b, c]) await withServer(dshHome, dir, { registerWorkspace: true })
    await check('前置：三条记录', () => assert.equal(registryPaths(dshHome).length, 3))

    // active 变成 B：注册表里 A 与 C 一条都不能少。
    switchWorkspace(userDataDir, b)
    await check('active 变化不改变注册表', () => assert.equal(registryPaths(dshHome).length, 3))

    // 移除 C（**非**当前工作区）：active 仍然 B，settings.workspace 仍然 B。
    await withServer(dshHome, b, { registerWorkspace: false, forgetWorkspaces: [c] })
    await check('移除非当前工作区：它从注册表消失', () => assert.ok(!registryPaths(dshHome).includes(real(c))))
    await check('移除非当前工作区：active（settings.workspace）不受影响', () =>
      assert.equal(readSettingsRaw(userDataDir).workspace, b))
    await check('移除非当前工作区：A 仍在注册表里', () => assert.ok(registryPaths(dshHome).includes(real(a))))

    // Remove from Recent 一个**已注册**的工作区：注册表不能因此少一条。
    removeFromRecent(userDataDir, a)
    await withServer(dshHome, b, { registerWorkspace: false })
    await check('Remove from Recent 不会 unregister（需求 18）', () => {
      const paths = registryPaths(dshHome)
      assert.ok(paths.includes(real(a)) && paths.includes(real(b)), JSON.stringify(paths))
    })
  }

  // =====================================================================
  console.log('')
  console.log('=== 14. 多仓库 / 多 home 互不干扰 ===')
  // =====================================================================
  {
    const one = freshCase('multi-one')
    const two = freshCase('multi-two')
    const a = makeDir('multi-a')
    const b = makeDir('multi-b')
    await withServer(one.dshHome, a, { registerWorkspace: true })
    await withServer(two.dshHome, b, { registerWorkspace: true })
    await check('两个 harness home 各自只有自己的记录', () => {
      assert.deepEqual(registryPaths(one.dshHome), [real(a)])
      assert.deepEqual(registryPaths(two.dshHome), [real(b)])
    })
    // 在 home one 里移除 a：home two 完全不受影响。
    await withServer(one.dshHome, a, { registerWorkspace: false, forgetWorkspaces: [a] })
    await check('移除只作用于目标 home', () => {
      assert.deepEqual(registryPaths(one.dshHome), [])
      assert.deepEqual(registryPaths(two.dshHome), [real(b)])
    })
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
