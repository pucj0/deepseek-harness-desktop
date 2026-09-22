// 端到端验证 gitbar 的切换与「暂存并切换」流程。
//
//   node scripts/test-gitbar-checkout.mjs
//
// 为什么用一次性临时仓库：这个测试会真的执行 `git stash` 与 `git checkout`。
// 在有未提交改动的真实仓库上跑会移动用户的工作区状态，绝不可以。
//
// 覆盖的四种情形对应界面上的四种结果：
//   1. 脏工作区直接切换  -> 409，界面显示 git 原文并给出「暂存并切换」入口
//   2. 脏工作区带 stash  -> 200，切换成功且返回 stash 引用（界面要告知用户）
//   3. 干净工作区带 stash -> 400 nothing to stash（界面不该出现这个按钮，但接口要稳）
//   4. 非法分支名        -> 400，安全边界
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const runner = async (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(String(stderr).trim() || error.message))
      else resolve(String(stdout))
    })
  })

const repo = mkdtempSync(join(tmpdir(), 'dsh-gitbar-'))
let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (期望 ${expected})`}`)
}

/** 服务端子进程；提升到 try 之外，便于 finally 里确保它被结束。 */
let child

try {
  // ---- 造一个带两个分支、且有未提交改动的小仓库 --------------------------
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com'])
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'test'])
  writeFileSync(join(repo, 'a.txt'), 'base\n')
  await runner(['add', '.'], repo)
  await runner(['commit', '-q', '-m', 'init'], repo)
  await runner(['checkout', '-q', '-b', 'feature'], repo)
  writeFileSync(join(repo, 'b.txt'), 'feature\n')
  await runner(['add', '.'], repo)
  await runner(['commit', '-q', '-m', 'feature'], repo)
  await runner(['checkout', '-q', 'main'], repo)
  // 制造与 feature 冲突的未提交改动
  writeFileSync(join(repo, 'b.txt'), 'dirty on main\n')

  console.log('临时仓库:', repo)
  console.log(`  当前分支: ${(await runner(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).trim()}`)
  console.log('')

  // ---- 起服务端（工作区指向临时仓库）------------------------------------
  const runtime = join(process.cwd(), 'runtime')
  // 独立的临时 HOME：与开发实例的 .dev-home 隔离。
// 早先共用 .dev-home，而测试会往 storages/workspace.json 写记录，于是跑完测试
// 开发实例就因"存储记录结构不符"起不来（这个坑重复了三次）。
const home = mkdtempSync(join(tmpdir(), 'dsh-test-home-'))
  rmSync(home, { recursive: true, force: true })
  // **先把插件同步进 runtime**（见 test-gitbar-branches.mjs 的说明）：宿主半边是从
  // runtime/node_modules 里那份副本加载的，不同步就会测到旧代码。
  {
    const { syncBundledPlugins } = await import('./sync-plugins.mjs')
    syncBundledPlugins()
  }
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

  // 登记这个临时仓库。
  //
  // 现在 host 只接受**已登记**的工作区（安全边界：不能让页面命令 host 对任意目录跑
  // git），而契约也要求每次请求带 `cwd`。因此测试必须先把临时仓库写进应用侧的工作区
  // 表；否则请求会被正确拒绝，测试就测不到切换本身。
  //
  // 在服务端就绪**之后**写：dsh 启动时会读这份文件，预置它不认识的结构会让启动失败。
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

  const post = (body) =>
    fetch(`${base}/dsh-desktop/gitbar/checkout?cwd=${encodeURIComponent(repo)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  // ---- 1. 脏工作区直接切换 ---------------------------------------------
  let response = await post({ branch: 'feature' })
  let text = await response.text()
  check('1) 脏工作区直接切换 -> 409', response.status, 409)
  check('   错误里含 git 原文', /local changes|would be overwritten/iu.test(text), 'true')

  // ---- 2. 带 stash 切换 -------------------------------------------------
  response = await post({ branch: 'feature', stash: true })
  const body = await response.json()
  check('2) 暂存并切换 -> 200', response.status, 200)
  check('   返回 stash.stashed', body?.stash?.stashed, 'true')
  check('   返回 stash.ref 非空', typeof body?.stash?.ref === 'string' && body.stash.ref !== '', 'true')
  check('   当前分支已切换', body?.branch, 'feature')
  check('   git 视角也在 feature', (await runner(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).trim(), 'feature')
  check('   工作区已干净', (await runner(['status', '--porcelain'], repo)).trim(), '')
  check('   stash 里有记录', (await runner(['stash', 'list'], repo)).includes('dsh-gitbar'), 'true')

  // ---- 3. 干净工作区带 stash -------------------------------------------
  response = await post({ branch: 'main', stash: true })
  check('3) 干净工作区带 stash -> 400', response.status, 400)

  // ---- 4. 非法分支名 ---------------------------------------------------
  response = await post({ branch: '--upload-pack=calc' })
  check('4) 非法分支名 -> 400', response.status, 400)

  child.kill()
} catch (error) {
  failures += 1
  console.error('测试异常:', String(error.message).slice(0, 400))
} finally {
  // 服务端子进程是 cwd 在这个临时仓库里的，必须等它真的退出再删目录，
  // 否则 Windows 上会 EPERM（目录仍被占用）。
  child.kill()
  await new Promise((r) => setTimeout(r, 1500))
  try {
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch (error) {
    console.warn(`临时目录未能删除（不影响结论）: ${String(error.message).slice(0, 120)}`)
  }
}

console.log('')
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
