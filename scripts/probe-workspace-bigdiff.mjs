// 用真实仓库验证 `/review/workspace` 在"巨大未跟踪目录"下不再 500。
//
//   node scripts/probe-workspace-bigdiff.mjs [仓库路径]
//
// 背景（这次实测的故障）：`E:\workspace\mmsm-amis` 里有个 `tmp/` 目录，6,635 个日志文件、
// 37.7 MB，且**没有被 .gitignore 覆盖**。插件用 `git add -A` 给工作区拍快照，于是
// `git diff --unified=3` 要输出 **45.9 MB / 1,062,664 行**，把 `execFile` 的 32 MB
// maxBuffer 撑爆 —— `/review/workspace` 直接 500，界面上表现为"改动 0 个 / 这个项目当前
// 没有未提交的改动"，同时"最近提交"照常显示，看起来像"项目级 git 取不到数据"。
//
// 本脚本对同一个仓库跑两次：一次用 32 MB（旧行为，应当失败），一次用新实现（应当成功）。
// 它自己起一个临时 dsh 服务端，因此不需要 Electron。
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = process.argv[2] ?? 'E:\\workspace\\mmsm-amis'
const root = mkdtempSync(join(tmpdir(), 'dsh-bigdiff-'))
let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `（期望 ${expected}）`}`)
}

let child
try {
  const runtime = join(process.cwd(), 'runtime')
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  child = spawn(
    join(runtime, 'node', 'node.exe'),
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
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))

  let base
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 1500))
    const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/u.exec(out)
    if (m !== null) {
      base = m[1]
      break
    }
  }
  if (base === undefined) throw new Error(`服务端未就绪\n${out.slice(-800)}`)

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

  const post = async (route) => {
    const t0 = Date.now()
    const response = await fetch(`${base}/dsh-desktop/review/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: repo }),
    })
    const text = await response.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { error: text.slice(0, 200) }
    }
    return { status: response.status, body: parsed, seconds: (Date.now() - t0) / 1000 }
  }

  console.log(`仓库: ${repo}`)
  console.log('')

  console.log('=== 1. /review/workspace 不再 500 ===')
  const ws = await post('workspace')
  console.log(`  HTTP ${ws.status}  用时 ${ws.seconds.toFixed(1)}s`)
  if (ws.status !== 200) console.log(`  错误: ${JSON.stringify(ws.body).slice(0, 300)}`)
  check('1) 状态码', ws.status, 200)
  check('   isRepo', ws.body.isRepo, true)
  checkTrue('   文件列表非空', Array.isArray(ws.body.files) && ws.body.files.length > 0)
  console.log(`   文件数: ${ws.body.files?.length}`)
  console.log(`   diff 字节数: ${(ws.body.diff ?? '').length}`)
  check('   标记为截断（体量超出逐行差异上限）', ws.body.truncated, true)

  console.log('')
  console.log('=== 2. 其它只读路由仍然正常 ===')
  const status = await post('status')
  check('2) status 200', status.status, 200)
  checkTrue('   报告了已跟踪改动数', typeof status.body.trackedCount === 'number')
  const history = await post('history')
  check('   history 200', history.status, 200)
  checkTrue('   有提交历史', Array.isArray(history.body.commits) && history.body.commits.length > 0)
  const graph = await post('graph')
  check('   graph 200', graph.status, 200)
  checkTrue('   graph 有提交', Array.isArray(graph.body.commits) && graph.body.commits.length > 0)

  child.kill()
} catch (error) {
  failures += 1
  console.error('probe 异常:', String(error?.stack ?? error).slice(0, 1000))
} finally {
  child?.kill()
  await new Promise((r) => setTimeout(r, 1200))
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch {
    // 临时目录清不掉不影响结论。
  }
}

/** 断言为真。 */
function checkTrue(label, actual) {
  check(label, actual === true, true)
}

console.log('')
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
