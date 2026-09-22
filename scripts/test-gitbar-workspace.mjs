// 验证 gitbar 路由按请求传入的 cwd 查询，而不是外壳启动时的工作区。
//
//   node scripts/test-gitbar-workspace.mjs
//
// 这是修 "切换项目后徽章没变" 那个 bug 的关键断言：
//   1. 不传 cwd            -> 400（不再默默用外壳工作区，避免显示错误的仓库）
//   2. 传外壳工作区        -> 200，分支属于该仓库
//   3. 传另一个真实仓库    -> 200，分支属于**那个**仓库（证明会跟着 cwd 变）
//   4. 传未登记的路径      -> 400（安全边界：不能让页面命令 host 对任意目录跑 git）
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHELL_WS = 'E:\\workspace\\mmsm-amis'
const OTHER_WS = 'E:\\workspace\\emdp'
const runtime = join(process.cwd(), 'runtime')
// 独立的临时 HOME：与开发实例的 .dev-home 隔离。
// 早先共用 .dev-home，而测试会往 storages/workspace.json 写记录，于是跑完测试
// 开发实例就因"存储记录结构不符"起不来（这个坑重复了三次）。
const home = mkdtempSync(join(tmpdir(), 'dsh-test-home-'))

rmSync(home, { recursive: true, force: true })

/**
 * 写入应用侧的工作区登记。
 *
 * 在服务端就绪**之后**才写：dsh 会在启动时读这份文件，预置一个它不认识的结构可能
 * 让启动失败（实测踩到过 "服务端未就绪"）。而 gitbar 每次请求都重读，所以后写完全
 * 来得及，也更接近真实情况（用户在应用里选项目 → 运行中更新）。
 * @param roots - 要登记的工作区。
 */
function writeWorkspaceRegistry(roots) {
  mkdirSync(join(home, 'storages'), { recursive: true })
  const table = {}
  roots.forEach((root, index) => {
    table[`w${index}`] = { root }
  })
  writeFileSync(
    join(home, 'storages', 'workspace.json'),
    JSON.stringify(
      {
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, workspaceIds: [], archivedSessionIds: [] },
        tables: { workspaces: table },
      },
      null,
      2,
    ) + '\n',
  )
}

// **先把插件同步进 runtime**（见 test-gitbar-branches.mjs 的说明）：宿主半边是从
// runtime/node_modules 里那份副本加载的，不同步就会测到旧代码。
{
  const { syncBundledPlugins } = await import('./sync-plugins.mjs')
  syncBundledPlugins()
}

const child = spawn(
  join(runtime, 'node', 'node.exe'),
  [
    join(runtime, 'server.mjs'),
    '--dsh-home',
    home,
    '--install-anchor',
    join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    '--workspace',
    SHELL_WS,
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

let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (期望 ${expected})`}`)
}

try {
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

  // 服务端就绪后再登记两个工作区（模拟用户在应用里选过这两个项目）。
  // 不登记的话另一个仓库会被**正确**拒绝，反而掩盖了真正要验证的行为。
  writeWorkspaceRegistry([SHELL_WS, OTHER_WS])

  /** 查一次 status。 */
  const status = async (cwd) => {
    const query = cwd === undefined ? '' : `?cwd=${encodeURIComponent(cwd)}`
    const response = await fetch(`${base}/dsh-desktop/gitbar/status${query}`)
    return { code: response.status, body: await response.json().catch(() => null) }
  }

  // 1) 不传 cwd
  const none = await status(undefined)
  check('1) 不传 cwd -> 400', none.code, 400)

  // 2) 外壳工作区
  const shell = await status(SHELL_WS)
  check('2) 外壳工作区 -> 200', shell.code, 200)
  console.log(`       分支: ${shell.body?.branch}`)

  // 3) 另一个真实仓库 —— 分支必须不同，证明会跟着 cwd 走
  const other = await status(OTHER_WS)
  check('3) 另一个仓库 -> 200', other.code, 200)
  console.log(`       分支: ${other.body?.branch}`)
  check('   两个仓库的分支不同', shell.body?.branch !== other.body?.branch, 'true')

  // 4) 未登记的路径
  const evil = await status('C:\\Windows')
  check('4) 未登记路径 -> 400', evil.code, 400)
} catch (error) {
  failures += 1
  console.error('测试异常:', String(error.message).slice(0, 300))
} finally {
  child.kill()
  await new Promise((r) => setTimeout(r, 1200))
}

console.log('')
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
