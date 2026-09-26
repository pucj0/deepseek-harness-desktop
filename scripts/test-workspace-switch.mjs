// 工作区切换协议的回归测试（「文件 → 打开文件夹」那条路）。
//
//   npm run build && node scripts/test-workspace-switch.mjs
//
// 覆盖三类曾经真实出过错、或本次修复必须钉住的行为：
//
//   1. 切换的**副作用集合**：写 settings、写 pending-workspace、重启应用。
//      1.2.0–1.5.8 期间这里换成"就地换服务端"，看似更聪明，但它换不掉 Harness 的工作区
//      生命周期（见 workspace-switch.ts 文件头），于是"选了目录但界面没进入新项目"。
//   2. **旧 argv 不能盖掉新工作区**：`app.relaunch()` 沿用原命令行，argv 里的旧工作区
//      优先级若高于切换意图，就会出现"重启了但还是老目录"（c968ab4a 修过一次，这里钉住）。
//   3. 早退分支一个副作用都不许有：关闭选择器、确认框取消、选中当前目录。
//
// 全是纯逻辑断言，不需要 Electron/图形环境：对话框与重启动作都是注入的。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  PENDING_WORKSPACE_FILENAME,
  isSameWorkspace,
  markPendingWorkspace,
  takePendingWorkspace,
} from '../dist/main/workspace.js'
import { readSettings, switchWorkspace } from '../dist/main/settings.js'
import { pickFolderToOpen, resolveWorkspace, restartIntoWorkspace } from '../dist/main/workspace-switch.js'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-workspace-switch-'))
let passed = 0
let failed = 0

/**
 * 一个检查项（可以是异步的）。
 * @param name - 断言名。
 * @param action - 断言体。
 */
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

/** 每个用例一个隔离的数据目录，避免互相看到对方的 settings/pending。 */
let serial = 0
const freshUserData = () => {
  serial += 1
  return join(scratch, `case-${serial}`)
}

/** 建一个真实目录（切换目标必须是存在的目录），返回它的绝对路径。 */
const makeDir = (name) => mkdtempSync(join(scratch, `${name}-`))

/** 收集注入动作的调用记录，用来断言"谁被调了、按什么顺序"。 */
function recorder() {
  const events = []
  return {
    events,
    beginQuit: () => {
      events.push('beginQuit')
    },
    stopServer: async () => {
      events.push('stop')
    },
    relaunch: () => {
      events.push('relaunch')
    },
    exit: (code) => {
      events.push(`exit:${String(code)}`)
    },
  }
}

/** 一次切换的全部可观察副作用，打包成一个断言用的快照。 */
function switchState(userDataDir) {
  const settings = readSettings(userDataDir)
  const pendingPath = join(userDataDir, PENDING_WORKSPACE_FILENAME)
  return {
    workspace: settings.workspace,
    recent: settings.recent ?? [],
    pending: existsSync(pendingPath) ? readFileSync(pendingPath, 'utf8').trim() : undefined,
  }
}

console.log('=== Case 1: 打开文件夹 → 写设置 + 写标记 + 重启应用 ===')
{
  const userDataDir = freshUserData()
  const a = makeDir('case1-a')
  const b = makeDir('case1-b')
  switchWorkspace(userDataDir, a)
  const effects = recorder()
  const outcome = await restartIntoWorkspace({ userDataDir, current: a, target: b, ...effects })
  const state = switchState(userDataDir)

  await check('返回 restart', () => assert.equal(outcome, 'restart'))
  await check('settings.workspace = B', () => assert.equal(state.workspace, b))
  await check('recent[0] = B', () => assert.equal(state.recent[0], b))
  await check('recent 里保留了 A', () => assert.ok(state.recent.includes(a)))
  await check('pending-workspace = B', () => assert.equal(state.pending, b))
  await check('先宣告退出、再停服务端、再重启、最后退出', () =>
    assert.deepEqual(effects.events, ['beginQuit', 'stop', 'relaunch', 'exit:0']))
}

console.log('')
console.log('=== Case 2: 旧 argv 不能盖掉新工作区（c968ab4a 的回归） ===')
{
  const userDataDir = freshUserData()
  const a = makeDir('case2-a')
  const b = makeDir('case2-b')
  switchWorkspace(userDataDir, a)
  markPendingWorkspace(userDataDir, b)

  await check('pending 优先于 argv', () => assert.equal(resolveWorkspace(['electron.exe', a], userDataDir), b))
  await check('pending 标记被消费掉（文件已删除）', () =>
    assert.equal(existsSync(join(userDataDir, PENDING_WORKSPACE_FILENAME)), false))
  const state = switchState(userDataDir)
  await check('settings.workspace 也跟着更新为 B', () => assert.equal(state.workspace, b))
  await check('recent[0] = B', () => assert.equal(state.recent[0], b))

  // 标记只对紧接着的那一次启动生效：同样的 argv 再解析一次，应当回到 argv 的值。
  await check('标记只生效一次，之后 argv 重新说了算', () =>
    assert.equal(resolveWorkspace(['electron.exe', a], userDataDir), a))

  // 坏标记（指向已删除的目录）必须被删掉并回落到 argv，而不是每次启动都被读一遍。
  markPendingWorkspace(userDataDir, join(scratch, 'case2-does-not-exist'))
  await check('坏标记回落到 argv', () => assert.equal(resolveWorkspace(['electron.exe', a], userDataDir), a))
  await check('坏标记同样被删掉', () =>
    assert.equal(existsSync(join(userDataDir, PENDING_WORKSPACE_FILENAME)), false))

  // 开关参数不是路径，必须被跳过。
  await check('跳过 --flag 形式的参数', () =>
    assert.equal(resolveWorkspace(['electron.exe', '--enable-logging', a], userDataDir), a))
  await check('相对路径按 cwd 规范化', () =>
    assert.equal(resolveWorkspace(['electron.exe', '.'], userDataDir), resolve('.')))
}

console.log('')
console.log('=== Case 3: 最近打开 A → B ===')
{
  const userDataDir = freshUserData()
  const a = makeDir('case3-a')
  const b = makeDir('case3-b')
  switchWorkspace(userDataDir, a)

  const effects = recorder()
  await restartIntoWorkspace({ userDataDir, current: a, target: b, ...effects })
  await check('B 在 recent 第一位', () => assert.equal(readSettings(userDataDir).recent?.[0], b))

  // "重启"之后：argv 里是旧工作区 A，pending 指向 B —— 菜单状态必须已经是 B。
  const resolved = resolveWorkspace(['electron.exe', a], userDataDir)
  const after = readSettings(userDataDir)
  await check('重启后当前工作区 = B', () => assert.equal(resolved, b))
  await check('重启后 recent[0] 仍是 B', () => assert.equal(after.recent?.[0], b))
  await check('重启后 recent 里 B 只出现一次', () =>
    assert.equal((after.recent ?? []).filter((entry) => entry === b).length, 1))
  await check('重启后 recent = [B, A]', () => assert.deepEqual(after.recent, [b, a]))
}

console.log('')
console.log('=== Case 4: 关闭目录选择器 → 什么都不做 ===')
{
  const userDataDir = freshUserData()
  const a = makeDir('case4-a')
  switchWorkspace(userDataDir, a)
  const before = switchState(userDataDir)

  let confirmCalls = 0
  const picked = pickFolderToOpen({
    currentWorkspace: a,
    showOpenDialog: () => undefined,
    confirm: () => {
      confirmCalls += 1
      return true
    },
  })

  await check('不切换', () => assert.equal(picked, undefined))
  await check('不弹确认框', () => assert.equal(confirmCalls, 0))
  await check('不修改 workspace / recent', () => assert.deepEqual(switchState(userDataDir), before))
  await check('没有写 pending 标记', () => assert.equal(switchState(userDataDir).pending, undefined))
}

console.log('')
console.log('=== Case 5: 确认框取消 → 什么都不做 ===')
{
  const userDataDir = freshUserData()
  const a = makeDir('case5-a')
  const b = makeDir('case5-b')
  switchWorkspace(userDataDir, a)
  const before = switchState(userDataDir)

  const picked = pickFolderToOpen({ currentWorkspace: a, showOpenDialog: () => b, confirm: () => false })

  await check('不切换', () => assert.equal(picked, undefined))
  await check('不修改 workspace / recent', () => assert.deepEqual(switchState(userDataDir), before))
  await check('没有写 pending 标记', () => assert.equal(switchState(userDataDir).pending, undefined))
}

console.log('')
console.log('=== Case 6: 选中的就是当前工作区 → 不重启 ===')
{
  const userDataDir = freshUserData()
  const a = makeDir('case6-a')
  const other = makeDir('case6-other')
  switchWorkspace(userDataDir, a)

  let confirmCalls = 0
  const picked = pickFolderToOpen({
    currentWorkspace: a,
    // 原生选择器给出的写法未必与记住的那个逐字相同：补一个尾部分隔符。
    showOpenDialog: () => `${a}\\`,
    confirm: () => {
      confirmCalls += 1
      return true
    },
  })
  await check('同一个目录不切换', () => assert.equal(picked, undefined))
  await check('不弹无意义的确认框', () => assert.equal(confirmCalls, 0))

  const effects = recorder()
  const outcome = await restartIntoWorkspace({ userDataDir, current: a, target: `${a}\\`, ...effects })
  await check('restartIntoWorkspace 也返回 unchanged', () => assert.equal(outcome, 'unchanged'))
  await check('没有宣告退出、没有停服务端、没有重启', () => assert.deepEqual(effects.events, []))
  await check('settings 没被动过', () => assert.equal(readSettings(userDataDir).workspace, a))

  // 「最近打开」里点到当前项：同一个不变量（由同一个 primitive 保证）。
  // 这里额外守住"关窗即隐藏到托盘"：beginQuit 没被调用，才说明它没被误置位。
  const recentEffects = recorder()
  const recentOutcome = await restartIntoWorkspace({ userDataDir, current: a, target: a, ...recentEffects })
  await check('最近打开点到当前项也不重启', () => assert.deepEqual(recentEffects.events, []))
  await check('最近打开点到当前项返回 unchanged', () => assert.equal(recentOutcome, 'unchanged'))

  await check('isSameWorkspace 忽略尾部分隔符与冗余路径', () => {
    assert.equal(isSameWorkspace(a, `${a}\\`), true)
    assert.equal(isSameWorkspace(a, join(a, '..', a.split(/[\\/]/u).pop() ?? '')), true)
    assert.equal(isSameWorkspace(a, other), false)
  })
}

console.log('')
console.log('=== Case 7: 路径含特殊字符（空格 / 中文 / 括号 / #） ===')
{
  const userDataDir = freshUserData()
  const tricky = join(scratch, 'case7 中文 (括号) #hash &and')
  const other = makeDir('case7-other')
  mkdirSync(tricky, { recursive: true })

  // 标记文件的往返：整行读取 + trim，路径本身不被截断或转义。
  markPendingWorkspace(userDataDir, tricky)
  await check('pending 原样往返', () => assert.equal(takePendingWorkspace(userDataDir), tricky))
  await check('取过一次之后标记消失', () => assert.equal(takePendingWorkspace(userDataDir), undefined))

  // 作为 argv 传入也一样。
  switchWorkspace(userDataDir, other)
  await check('argv 里的特殊字符路径可用', () => assert.equal(resolveWorkspace(['electron.exe', tricky], userDataDir), tricky))

  // 重启后"旧 argv + 新标记"同时存在：标记必须胜出。
  markPendingWorkspace(userDataDir, tricky)
  switchWorkspace(userDataDir, other)
  await check('标记 + 旧 argv：标记胜出', () => assert.equal(resolveWorkspace(['electron.exe', other], userDataDir), tricky))
  await check('特殊字符路径进了 recent[0]', () => assert.equal(readSettings(userDataDir).recent?.[0], tricky))

  const effects = recorder()
  await restartIntoWorkspace({ userDataDir, current: tricky, target: other, ...effects })
  await check('从特殊字符路径切走也正常', () =>
    assert.deepEqual(effects.events, ['beginQuit', 'stop', 'relaunch', 'exit:0']))

  // 菜单里"最近打开"的空条目（设置文件被手改坏时会出现）：不是一次切换。
  const empty = recorder()
  const outcome = await restartIntoWorkspace({ userDataDir, current: tricky, target: '', ...empty })
  await check('target 为空字符串不算切换', () => assert.equal(outcome, 'unchanged'))
  await check('空 target 不触发任何动作', () => assert.deepEqual(empty.events, []))
}

console.log('')
console.log('=== Case 8: 停服务端失败也要照常重启 ===')
{
  const userDataDir = freshUserData()
  const a = makeDir('case8-a')
  const b = makeDir('case8-b')
  const events = []
  switchWorkspace(userDataDir, a)
  const outcome = await restartIntoWorkspace({
    userDataDir,
    current: a,
    target: b,
    beginQuit: () => events.push('beginQuit'),
    stopServer: async () => {
      events.push('stop')
      throw new Error('模拟停服务端失败')
    },
    relaunch: () => events.push('relaunch'),
    exit: (code) => events.push(`exit:${String(code)}`),
  })
  await check('仍然重启（停在没有服务端的状态更糟）', () =>
    assert.deepEqual(events, ['beginQuit', 'stop', 'relaunch', 'exit:0']))
  await check('目标仍被记录', () => assert.equal(readSettings(userDataDir).workspace, b))
  await check('返回值仍是 restart', () => assert.equal(outcome, 'restart'))
}

try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
  // 清理失败不影响结论。
}

console.log('')
console.log(`${passed} 项通过${failed === 0 ? '' : `，${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
