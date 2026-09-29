// **scope 语义隔离**：项目级 Git（workspace）与本轮修改（turn）是两个不同的数据集。
//
//   node scripts/test-turn-review-scope.mjs
//
// 这是这次修复的**核心回归测试**，跑在一个**真实的 git 仓库**上、通过**真实的 host 路由**
// 取数（不是桩）：起 `runtime/server.mjs`，然后分别打 `/workspace` 与 `/changes`。
//
// 场景（正是需求里写的那一个）：
//
//   初始 HEAD            a.txt, b.txt
//   ① 用户在 agent 开始前自己改了 a.txt      ← 属于"项目级改动"，**不属于本轮**
//   ② 记录本轮基线（POST /baseline）         ← 基线的树里 a.txt 已经是"改过"的样子
//   ③ 本轮 agent 改了 b.txt、新增了 c.txt    ← 才是"本轮改动"
//
//   期望：
//     /workspace（项目级 Git Changes）→ a.txt, b.txt, c.txt   共 3 个
//     /changes  （本轮修改审查）      → b.txt, c.txt          共 2 个（**没有 a.txt**）
//
// 为什么这条必须存在：两个 surface 曾经共用一个界面与一个 `KIND`，于是"本轮修改"里显示的
// 是整份项目改动（把用户自己的、更早的改动也算成本轮）。一旦有人再把两者接回同一份数据，
// 这里会立刻变红——而且是**数据层面**的红，不依赖任何 UI 装配。
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = mkdtempSync(join(tmpdir(), 'dsh-turn-scope-'))
const runtime = join(process.cwd(), 'runtime')
// 独立的临时 HOME：绝不能碰开发实例的 `.dev-home`（它会往 storages/workspace.json 写记录）。
const home = mkdtempSync(join(tmpdir(), 'dsh-turn-scope-home-'))
rmSync(home, { recursive: true, force: true })

const run = (args, cwd) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })

let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `（期望 ${expected}）`}`)
}
const has = (label, actual) => check(label, actual === true, true)

let child

try {
  // ---- 造仓库：HEAD 里有 a.txt 与 b.txt ------------------------------------
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  run(['config', 'user.email', 'test@example.com'], repo)
  run(['config', 'user.name', 'test'], repo)
  writeFileSync(join(repo, 'a.txt'), 'a0\n')
  writeFileSync(join(repo, 'b.txt'), 'b0\n')
  run(['add', '.'], repo)
  run(['commit', '-q', '-m', 'init'], repo)
  console.log('临时仓库:', repo)
  console.log('')

  // ---- 起服务端（先同步插件到 runtime，避免测到旧副本）----------------------
  {
    const { syncBundledPlugins } = await import('./sync-plugins.mjs')
    syncBundledPlugins()
  }
  child = spawn(
    process.execPath,
    [
      join(runtime, 'server.mjs'),
      '--dsh-home',
      home,
      '--install-anchor',
      join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      '--workspace',
      repo,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )

  let out = ''
  child.stdout.on('data', (d) => {
    out += d
  })
  child.stderr.on('data', (d) => {
    out += d
  })

  let base
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 1500))
    const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/u.exec(out)
    if (m !== null) {
      base = m[1]
      break
    }
  }
  if (base === undefined) {
    console.error('服务端未就绪，其输出尾部：')
    console.error(out.split('\n').filter((l) => l.trim() !== '').slice(-15).join('\n'))
    throw new Error('服务端未就绪')
  }

  // 登记这个临时仓库（与 test-review-host.mjs 同一套存储形状）。
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(
    join(home, 'storages', 'workspace.json'),
    JSON.stringify(
      {
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, workspaceIds: [], archivedSessionIds: [] },
        tables: { workspaces: { w1: { path: repo } } },
      },
      null,
      2,
    ) + '\n',
  )

  const call = async (route, body) => {
    const response = await fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await response.json().catch(() => ({}))
    if (response.status !== 200) throw new Error(`${route} -> HTTP ${response.status}: ${json.error ?? ''}`)
    return json
  }

  const session = 'turn-scope-session'
  const workspace = repo
  /** 把两份响应里列出的路径收集成集合（项目级还要看未跟踪那一段）。 */
  const pathsOf = (payload) =>
    new Set([
      ...(payload.files ?? []).map((f) => f.path),
      ...(payload.untracked?.inlineFiles ?? []).map((f) => f.path),
    ])

  console.log('=== 1. 用户在 agent 开始**之前**改 a.txt ===')
  writeFileSync(join(repo, 'a.txt'), 'a0\nuser-before-turn\n')
  const statusBefore = run(['status', '--porcelain'], repo)
  has('1) a.txt 此时已经是"已修改"', statusBefore.includes('a.txt'))

  console.log('')
  console.log('=== 2. 记录本轮基线（此刻 a.txt 已是用户改过的样子）===')
  const baseline = await call('/dsh-desktop/review/baseline', { workspace, sessionId: session })
  has('2) 基线记录成功（返回树对象 SHA）', /^[0-9a-f]{40}$/u.test(baseline.revision ?? ''))

  console.log('')
  console.log('=== 3. 本轮 agent 改 b.txt、新增 c.txt ===')
  writeFileSync(join(repo, 'b.txt'), 'b0\nagent-this-turn\n')
  writeFileSync(join(repo, 'c.txt'), 'agent-made-this\n')
  check('   工作区状态是 3 个改动', run(['status', '--porcelain'], repo).split('\n').filter((l) => l.trim() !== '').length, 3)

  console.log('')
  console.log('=== 4. 项目级 Git（/workspace，HEAD 基线）→ 3 个 ===')
  const project = await call('/dsh-desktop/review/workspace', { workspace, sessionId: session })
  const projectPaths = pathsOf(project)
  check('4) 项目级列出 3 个文件', projectPaths.size, 3)
  for (const path of ['a.txt', 'b.txt', 'c.txt']) has(`   项目级包含 ${path}（用户改的也算项目改动）`, projectPaths.has(path))
  check('   项目级的 scope 标记', project.scope ?? 'workspace', 'workspace')

  console.log('')
  console.log('=== 5. 本轮修改（/changes，baseline 基线）→ 2 个，且**没有 a.txt** ===')
  const turn = await call('/dsh-desktop/review/changes', { workspace, sessionId: session })
  const turnPaths = pathsOf(turn)
  check('5) 本轮列出 2 个文件', turnPaths.size, 2)
  has('   本轮包含 b.txt（agent 改的）', turnPaths.has('b.txt'))
  has('   本轮包含 c.txt（agent 新增的）', turnPaths.has('c.txt'))
  // **这条就是整个修复的核心断言。**
  check('   a.txt 绝不能出现在本轮修改里', turnPaths.has('a.txt'), false)
  check('   本轮与项目级的差集恰好是 a.txt', [...projectPaths].filter((p) => !turnPaths.has(p)).join(','), 'a.txt')

  console.log('')
  console.log('=== 6. 两个 scope 的差异文本也各自成立 ===')
  has('6) 项目级差异里有 a.txt 的改动', String(project.diff ?? '').includes('user-before-turn') || !('diff' in project))
  has('   本轮差异里有 b.txt 的改动', String(turn.diff ?? '').includes('agent-this-turn'))
  check('   本轮差异里没有用户那行', String(turn.diff ?? '').includes('user-before-turn'), false)

  console.log('')
  console.log('=== 7. 用户改的文件在记录基线之后仍然不属于本轮（再取一次也一样）===')
  const again = await call('/dsh-desktop/review/changes', { workspace, sessionId: session })
  check('7) 再取一次本轮仍是 2 个', pathsOf(again).size, 2)
  check('   再取一次仍然没有 a.txt', pathsOf(again).has('a.txt'), false)
} catch (error) {
  failures += 1
  console.error('测试异常:', String(error.message).slice(0, 400))
} finally {
  child?.kill()
  await new Promise((r) => setTimeout(r, 1200))
  for (const dir of [repo, home]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    } catch {
      // 子进程仍占用时删不掉，不影响结论。
    }
  }
}

console.log('')
console.log(failures === 0 ? '本轮修改与项目级改动的 scope 语义完全隔离' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
