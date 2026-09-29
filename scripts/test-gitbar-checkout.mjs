// 端到端验证 gitbar 的 Smart Checkout 流程。
//
//   node scripts/test-gitbar-checkout.mjs
//
// 为什么用一次性临时仓库：这个测试会真的执行 `git stash` 与 `git checkout`。
// 在有未提交改动的真实仓库上跑会移动用户的工作区状态，绝不可以。
//
// 覆盖：可直接携带修改、被 Git 拒绝后自动储藏/恢复、普通 stash 不受影响、安全边界。
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
  writeFileSync(join(repo, 'shared.txt'), 'one\ntwo\nthree\nfour\nfive\n')
  await runner(['add', '.'], repo)
  await runner(['commit', '-q', '-m', 'init'], repo)
  await runner(['checkout', '-q', '-b', 'feature'], repo)
  writeFileSync(join(repo, 'shared.txt'), 'ONE\ntwo\nthree\nfour\nfive\n')
  await runner(['add', '.'], repo)
  await runner(['commit', '-q', '-m', 'feature'], repo)
  await runner(['checkout', '-q', 'main'], repo)
  // 先制造一个 Git 本身允许跨分支携带的改动。
  writeFileSync(join(repo, 'a.txt'), 'dirty but compatible\n')

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
  const autoSaves = () => fetch(`${base}/dsh-desktop/gitbar/auto-saves?cwd=${encodeURIComponent(repo)}`)
  const restoreAutoSave = (id, route = 'restore') =>
    fetch(`${base}/dsh-desktop/gitbar/auto-save/${route}?cwd=${encodeURIComponent(repo)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
    })

  // ---- 1. dirty 不等于 blocked：Git 允许就直接切，不产生 stash ----------
  let response = await post({ branch: 'feature' })
  let body = await response.json()
  check('1) 可携带修改直接切换 -> 200', response.status, 200)
  check('   稳定状态码 directSwitch', body?.code, 'directSwitch')
  check('   不创建 stash', (await runner(['stash', 'list'], repo)).trim(), '')
  check('   修改仍在工作区', (await runner(['status', '--porcelain'], repo)).includes('a.txt'), 'true')

  await runner(['switch', 'main'], repo)
  await runner(['restore', '--', 'a.txt'], repo)
  // 用户原本已有普通 stash；Smart Checkout 只能精确操作自己的那一条。
  writeFileSync(join(repo, 'a.txt'), 'user stash\n')
  await runner(['stash', 'push', '-m', 'user-stash'], repo)
  // staged + unstaged-compatible + untracked。feature 改第一行，本地改第二行，apply 可三方合并。
  writeFileSync(join(repo, 'shared.txt'), 'one\ntwo\nthree\nfour\nFIVE local\n')
  await runner(['add', 'shared.txt'], repo)
  writeFileSync(join(repo, 'new.txt'), 'untracked\n')

  // ---- 2. Git 拒绝覆盖后，一次请求完成 stash/switch/apply/drop ----------
  response = await post({ branch: 'feature' })
  body = await response.json()
  check('2) Smart Checkout -> 200', response.status, 200)
  check('   稳定状态码 smartSwitchRestored', body?.code, 'smartSwitchRestored')
  check('   当前分支已切换', body?.branch, 'feature')
  check('   git 视角也在 feature', (await runner(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).trim(), 'feature')
  const status = await runner(['status', '--porcelain'], repo)
  check('   tracked 修改仍存在', status.includes('shared.txt'), 'true')
  check('   staged 状态保留', /^M\s+shared\.txt$/mu.test(status), 'true')
  check('   untracked 仍存在', status.includes('?? new.txt'), 'true')
  const stashList = await runner(['stash', 'list'], repo)
  check('   自动 stash 已精确删除', stashList.includes('dsh-smart-switch:'), 'false')
  check('   用户普通 stash 保留', stashList.includes('user-stash'), 'true')

  // ---- 3. 自动恢复不能完成时，安全 stash 可重启后扫描并找回 -------------
  await runner(['restore', '--staged', '--', 'shared.txt'], repo)
  await runner(['restore', '--', 'shared.txt'], repo)
  rmSync(join(repo, 'new.txt'), { force: true })
  writeFileSync(join(repo, 'collision.txt'), 'tracked on feature\n')
  await runner(['add', 'collision.txt'], repo)
  await runner(['commit', '-q', '-m', 'collision target'], repo)
  await runner(['switch', 'main'], repo)
  writeFileSync(join(repo, 'collision.txt'), 'untracked from main\n')
  response = await post({ branch: 'feature' })
  body = await response.json()
  check('3) 无法自动恢复时仍完成切分支', body?.branch, 'feature')
  check('   返回可找回的 autoSave', typeof body?.autoSave?.stashOid === 'string', 'true')
  let savesBody = await (await autoSaves()).json()
  check('   扫描 Git stash 可重新发现', savesBody?.autoSaves?.length, 1)
  const saved = savesBody.autoSaves[0]
  check('   以稳定 OID 标识', saved?.stashOid, body?.autoSave?.stashOid)
  response = await restoreAutoSave(saved.id)
  body = await response.json()
  check('   在错误分支直接恢复会被拒绝', response.status, 409)
  check('   返回稳定状态码 wrongBranch', body?.code, 'wrongBranch')
  check('   拒绝后安全副本仍在', (await (await autoSaves()).json())?.autoSaves?.length, 1)
  response = await restoreAutoSave(saved.id, 'switch-and-restore')
  body = await response.json()
  check('   切回来源分支并恢复', body?.code, 'autoSaveRestored')
  check('   未跟踪文件回来', (await runner(['status', '--porcelain'], repo)).includes('?? collision.txt'), 'true')
  savesBody = await (await autoSaves()).json()
  check('   成功恢复后只删除自己的 stash', savesBody?.autoSaves?.length, 0)
  check('   用户普通 stash 仍保留', (await runner(['stash', 'list'], repo)).includes('user-stash'), 'true')

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
