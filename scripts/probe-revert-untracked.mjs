// 实测：项目抽屉里对"未跟踪的新文件"点还原，服务端到底返回什么。
//
//   node scripts/probe-revert-untracked.mjs
//
// 用户反馈"AI 新增的文件点还原还原不了"。上一版已修过一处（基线里不存在的路径不能用
// git restore，改为删除），但仍未复现成功，因此这里把客户端的真实调用序列原样重放一遍，
// 看每一步的状态码与响应体，而不是继续猜测。
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = mkdtempSync(join(tmpdir(), 'dsh-revert-'))
const runtime = join(process.cwd(), 'runtime')
const home = mkdtempSync(join(tmpdir(), 'dsh-revert-home-'))
const run = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })

let child
try {
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  run(['config', 'user.email', 't@example.com'])
  run(['config', 'user.name', 't'])
  writeFileSync(join(repo, 'kept.txt'), 'kept\n')
  run(['add', '.'])
  run(['commit', '-q', '-m', 'init'])

  // 模拟 AI 新建文件。
  writeFileSync(join(repo, 'agent-created.txt'), 'made by the agent\n')
  console.log('仓库已就绪，含一个未跟踪的新文件 agent-created.txt')
  console.log('')

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
  if (base === undefined) throw new Error('服务端未就绪')

  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(
    join(home, 'storages', 'workspace.json'),
    JSON.stringify(
      {
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, workspaceIds: ['w1'], archivedSessionIds: [] },
        tables: { workspaces: { w1: { path: repo, title: 'r', sessionIds: [], createdAt: '', updatedAt: '' } } },
      },
      null,
      2,
    ) + '\n',
  )

  const call = async (route, body) => {
    const response = await fetch(`${base}/dsh-desktop/review/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace: repo, ...body }),
    })
    return { status: response.status, body: await response.json() }
  }

  console.log('1) 项目抽屉会先取下改动列表（不带 sessionId，也没有轮次基线）：')
  const changes = await call('workspace', {})
  console.log(`   status=${changes.status} scope=${changes.body.scope} files=${(changes.body.files ?? []).map((f) => `${f.status}:${f.path}`).join(', ')}`)

  // 客户端按 `result.scope === 'workspace' ? 'workspace' : 'turn'` 决定 scope。
  const scope = changes.body.scope === 'workspace' ? 'workspace' : 'turn'
  console.log(`   客户端据此会用 scope=${scope}`)

  console.log('')
  console.log(`2) 用 scope=${scope} 还原该文件（客户端当前的行为）：`)
  const attempt = await call('revert', { scope, paths: ['agent-created.txt'] })
  console.log(`   status=${attempt.status} body=${JSON.stringify(attempt.body)}`)
  console.log(`   文件还在吗: ${(() => { try { readFileSync(join(repo, 'agent-created.txt')); return true } catch { return false } })()}`)

  console.log('')
  console.log('3) 换成 scope=workspace 再试：')
  const fixed = await call('revert', { scope: 'workspace', paths: ['agent-created.txt'] })
  console.log(`   status=${fixed.status} body=${JSON.stringify(fixed.body)}`)
  console.log(`   文件还在吗: ${(() => { try { readFileSync(join(repo, 'agent-created.txt')); return true } catch { return false } })()}`)
} catch (error) {
  console.error('异常:', String(error.message).slice(0, 300))
} finally {
  child?.kill()
  await new Promise((r) => setTimeout(r, 1200))
  try {
    rmSync(repo, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  } catch {
    // 忽略清理失败。
  }
}
