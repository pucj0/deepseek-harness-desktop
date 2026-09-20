// 对真实仓库验证新增的 `file-history` 与"只提交选中"两条路径的接线是否正常。
//
//   node scripts/probe-file-history.mjs [仓库路径]
//
// 只读：不提交任何东西，只问历史与状态。存在的理由是宿主路由的接线（路径名、参数名、
// 形状校验）只有在真实 git 上跑一次才敢说通——例如 `git log --follow -- <path>` 在
// 仓库根目录不是 git 根时会报 "not a git repository"，而那种错在临时仓库里测不出来。
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = process.argv[2] ?? process.cwd()
const root = mkdtempSync(join(tmpdir(), 'dsh-hist-'))
let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `（期望 ${expected}）`}`)
}
const checkTrue = (label, actual) => check(label, actual === true, true)

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
  if (base === undefined) throw new Error(`服务端未就绪\n${out.slice(-600)}`)

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

  const post = async (route, body) => {
    const response = await fetch(`${base}/dsh-desktop/review/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: repo, ...body }),
    })
    const text = await response.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { error: text.slice(0, 200) }
    }
    return { status: response.status, body: parsed }
  }

  console.log(`仓库: ${repo}`)
  console.log('')

  // 先拿一份状态，从里面挑一个**已跟踪**的文件去问历史。
  const status = await post('status')
  check('status 200', status.status, 200)
  const tracked = status.body.tracked ?? []
  checkTrue('   有已跟踪的改动可供取样', tracked.length > 0)
  const sample = tracked[0]?.path

  console.log('')
  console.log('=== file-history：已跟踪文件 ===')
  if (sample !== undefined) {
    const hist = await post('file-history', { path: sample, limit: 5 })
    console.log(`  取样文件: ${sample}`)
    check('   200', hist.status, 200)
    checkTrue('   返回 commits 数组', Array.isArray(hist.body.commits))
    console.log(`   记录数: ${hist.body.commits.length}`)
    if (hist.body.commits.length > 0) {
      const c = hist.body.commits[0]
      checkTrue('   每条带 40 位哈希', /^[0-9a-f]{40}$/u.test(c.hash))
      checkTrue('   带作者与日期', c.author !== '' && c.date !== '')
      console.log(`   最新: ${c.short} ${c.date} ${c.subject.slice(0, 40)}`)
    }
  }

  console.log('')
  console.log('=== file-history：边界 ===')
  const untracked = (status.body.untrackedPaths ?? [])[0]
  if (untracked !== undefined) {
    const hist = await post('file-history', { path: untracked })
    check('   未跟踪文件 -> 200', hist.status, 200)
    check('   历史为空（不是错误）', hist.body.commits.length, 0)
    console.log(`  取样未跟踪文件: ${untracked}`)
  } else {
    console.log('  （该仓库当前没有未跟踪文件，跳过这一项）')
  }
  const bad = await post('file-history', { path: '../outside.txt' })
  check('   路径穿越 -> 400', bad.status, 400)
  check('   code 是 unsafePath', bad.body.code, 'unsafePath')

  console.log('')
  console.log('=== 只提交选中：越界路径必须挡在 add 之前 ===')
  const badCommit = await post('commit', { message: 'probe', paths: ['../outside.txt'] })
  check('   400', badCommit.status, 400)
  check('   code 是 unsafePath', badCommit.body.code, 'unsafePath')
  // 空信息同样要被挡掉，且不能因为带了 paths 就先去 add。
  const noMessage = await post('commit', { message: '   ', paths: [sample ?? 'x'] })
  check('   空提交信息 -> 400', noMessage.status, 400)
  check('   code 是 emptyMessage', noMessage.body.code, 'emptyMessage')

  child.kill()
} catch (error) {
  failures += 1
  console.error('probe 异常:', String(error?.stack ?? error).slice(0, 900))
} finally {
  child?.kill()
  await new Promise((r) => setTimeout(r, 1200))
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch {
    // 临时目录清不掉不影响结论。
  }
}

console.log('')
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
