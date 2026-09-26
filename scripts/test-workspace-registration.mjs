// 真实集成测试：启动真正的 dsh 服务端，验证「工作区登记」这一层确实发生了。
//
//   npm run build && node scripts/test-workspace-registration.mjs
//
// 为什么必须有这个测试：本次 bug 的根因正是"把两个不同层级的状态当成了一件事"。
//
//   层级一（进程级）：`--workspace <dir>` → 服务端进程 cwd、`DSH_DESKTOP_WORKSPACE`、
//                     git 插件解析出的仓库。**这一层一直是对的**，所以"Git 提交图能看到
//                     新仓库"从来不能证明工作区切换成功。
//   层级二（Harness 项目级）：`ctx.workspaceRegistry` 的持久化记录
//                     （`<home>/storages/workspace.json`）。官方 UI 的工作区/项目列表
//                     就是它的投影，而它只在首次启动按会话历史引导一次，不会自己发现
//                     新目录。1.2.0–1.5.8 从来没写过这一层，于是"选了目录但界面没进入
//                     新项目"。
//
// 因此本测试**同时断言两层**，并额外断言第二层的顺位：新登记的记录会被放到列表最前，
// 而官方 UI 的初始导航策略是"选最近的工作区"，这正是切换后界面能落到新项目的机制。
//
// 用真的 `DshServer`（而不是自己 spawn）是为了连"把 src/server/server.mjs 同步进
// runtime 再运行"这一步都走生产代码——否则测试有可能跑在过期的 runtime 副本上。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DshServer } from '../dist/main/dsh-server.js'
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

// 宿主半边是从 runtime/node_modules 里那份副本加载的，不同步就会测到旧代码
// （见 test-gitbar-branches.mjs 的说明）。
syncBundledPlugins()

const scratch = mkdtempSync(join(tmpdir(), 'dsh-workspace-registration-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
const workspaceA = join(scratch, 'workspace-A')
const workspaceB = join(scratch, 'workspace-B')
for (const [dir, file] of [
  [workspaceA, 'a.txt'],
  [workspaceB, 'b.txt'],
]) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), `content of ${file}\n`)
}

/** 生产环境里 DshServer 拿到的运行时位置（与 paths.ts 的开发期分支一致）。 */
const runtime = {
  dir: runtimeDir,
  installAnchor: join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  serverEntry: join(root, 'src', 'server', 'server.mjs'),
  serverRunEntry: join(runtimeDir, 'server.mjs'),
  nodeBinary: join(runtimeDir, 'node', 'node.exe'),
  packaged: false,
}

const registryFile = join(home, 'storages', 'workspace.json')

/** 读持久化的工作区注册表——即 `ctx.workspaceRegistry.list()` 的落盘形态。 */
function readRegistry() {
  const parsed = JSON.parse(readFileSync(registryFile, 'utf8'))
  const table = parsed?.tables?.workspaces ?? {}
  const order = parsed?.global?.workspaceIds ?? []
  return {
    initialized: parsed?.global?.initialized,
    order,
    // 按注册表自己的顺序（`list()` 就是这个顺序）列出记录。
    records: order.map((id) => ({ id, ...table[id] })),
    count: Object.keys(table).length,
  }
}

/**
 * 启动一个真实服务端，跑断言，然后停掉。
 * @param workspace - 本次启动的工作区。
 * @param body - 拿到服务端与日志后的断言体。
 */
async function withServer(workspace, body) {
  const server = new DshServer({ runtime, dshHome: home, workspace })
  const logs = []
  server.on('log', ({ line }) => logs.push(line))
  try {
    await server.start()
    await body({ server, logs })
  } finally {
    await server.stop(3000)
  }
}

/** 查一次 git 插件那层的 `/roots`（只有壳内插件才提供这条路由）。 */
async function readRoots(server) {
  const url = server.ready?.url
  assert.ok(typeof url === 'string' && url !== '', 'server.ready.url 应当可用')
  const response = await fetch(`${url}/dsh-desktop/review/roots`)
  assert.equal(response.status, 200)
  return await response.json()
}

const realA = realpathSync.native(workspaceA)
const realB = realpathSync.native(workspaceB)

try {
  console.log('=== 启动 1：全新的 harness home + 工作区 A ===')
  await withServer(workspaceA, async ({ server, logs }) => {
    const registry = readRegistry()
    console.log(`  注册表: ${JSON.stringify(registry.records.map((record) => record.path))}`)
    await check('A 被登记为项目（首启引导路径）', () =>
      assert.deepEqual(registry.records.map((record) => record.path), [realA]))
    await check('引导标记已写死（此后不会自己发现新目录）', () => assert.equal(registry.initialized, true))
    await check('登记用的是官方 API 而不是旁路写文件（无告警）', () =>
      assert.equal(logs.some((line) => line.includes('无法登记工作区')), false))
    const roots = await readRoots(server)
    await check('git 层（进程级）也指向 A', () => assert.equal(realpathSync.native(roots.current), realA))
  })

  console.log('')
  console.log('=== 启动 2：同一个 home + 工作区 B（即"切换项目后重启"） ===')
  let createdA
  await withServer(workspaceB, async ({ server, logs }) => {
    const registry = readRegistry()
    console.log(`  注册表顺序: ${JSON.stringify(registry.records.map((record) => record.path))}`)
    createdA = registry.records.find((record) => record.path === realA)?.createdAt

    await check('B 被登记为项目（这就是本次修复）', () =>
      assert.ok(registry.records.some((record) => record.path === realB)))
    await check('A 仍然在列表里', () => assert.ok(registry.records.some((record) => record.path === realA)))
    await check('两条记录，不是重复登记', () => assert.equal(registry.count, 2))
    // 官方 UI 的初始导航选"最近的工作区"，新建记录被前置到列表最前。
    await check('B 排在列表最前（界面因此会落到 B）', () =>
      assert.equal(registry.records[0]?.path, realB))
    await check('引导标记没有被重置', () => assert.equal(registry.initialized, true))
    await check('仍然没有登记告警', () =>
      assert.equal(logs.some((line) => line.includes('无法登记工作区')), false))

    // 两层同时成立，且是**两次独立的观测**：git 层跟着 cwd 走，注册表层跟着登记走。
    const roots = await readRoots(server)
    await check('git 层指向 B', () => assert.equal(realpathSync.native(roots.current), realB))
    await check('git 层允许的根包含 A 与 B', () => {
      const allowed = roots.roots.map((entry) => realpathSync.native(entry))
      assert.ok(allowed.includes(realA) && allowed.includes(realB))
    })
  })

  console.log('')
  console.log('=== 启动 3：同一个工作区 B 再启动一次（create 必须幂等） ===')
  await withServer(workspaceB, async () => {
    const registry = readRegistry()
    await check('记录数没有增长', () => assert.equal(registry.count, 2))
    await check('顺序没有被改动', () =>
      assert.deepEqual(registry.records.map((record) => record.path), [realB, realA]))
    await check('A 的记录没有被重建（createdAt 不变）', () =>
      assert.equal(registry.records.find((record) => record.path === realA)?.createdAt, createdA))
  })
} catch (error) {
  failed += 1
  console.error(`测试异常: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log('')
console.log(`${passed} 项通过${failed === 0 ? '' : `，${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
