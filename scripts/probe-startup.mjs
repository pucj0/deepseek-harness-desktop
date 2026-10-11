// 实测应用启动各阶段耗时，定位"启动慢"到底慢在哪。
//
//   node scripts/probe-startup.mjs                   测已安装版本
//   node scripts/probe-startup.mjs <runtime 目录>     直接测一个 runtime/（开发目录用这个）
//
// 开发目录没有 resources/ 层级，所以不能假定安装包的目录结构。
//
// 测三段：
//   1. 内置 Node 冷启动本身
//   2. host 半边（dsh-app-boot）的模块加载
//   3. 服务端完整启动到打印 URL —— 并在 DSH_DESKTOP_TIMING=1 下转发各阶段计时
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

// 参数可以是：
//   * runtime/ 目录本身（含 node/ 与 node_modules/）
//   * 仓库根或安装目录（其下有 runtime/ 或 resources/runtime）
// 逐个探测，避免把"传了根目录"误判成"runtime 就是根目录"。
function looksLikeRuntime(dir) {
  return dir !== undefined && existsSync(process.execPath) && existsSync(join(dir, 'node_modules'))
}

const arg = process.argv[2]
const installDir = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness')

let runtime
if (looksLikeRuntime(arg)) {
  runtime = arg
} else if (arg !== undefined && looksLikeRuntime(join(arg, 'runtime'))) {
  // 仓库根 / 开发目录
  runtime = join(arg, 'runtime')
} else if (looksLikeRuntime(join(arg ?? '', 'resources', 'runtime'))) {
  // 安装目录
  runtime = join(arg, 'resources', 'runtime')
} else {
  runtime = join(installDir, 'resources', 'runtime')
}

// Never put diagnostic profiles inside runtime/: packaging would copy them.
// Always isolate the test from real sessions, settings and installed profiles.
const dshHome = mkdtempSync(join(tmpdir(), 'dsh-startup-probe-'))

const nodeExe = process.execPath
const anchor = join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const entry = join(runtime, 'server.mjs')

console.log('[probe] runtime :', runtime)
console.log('[probe] dshHome :', dshHome)
for (const [label, path] of [
  ['node.exe', nodeExe],
  ['install anchor', anchor],
  ['server.mjs', entry],
]) {
  console.log(`[probe] ${label.padEnd(15)} 存在=${existsSync(path)}`)
}

if (!existsSync(nodeExe) || !existsSync(anchor)) {
  console.error('[probe] 路径不完整，无法测量')
  process.exit(1)
}

// ---- 1. 当前 Node 自身启动 --------------------------------------------------
const t0 = process.hrtime.bigint()
execFileSync(nodeExe, ['-e', 'process.exit(0)'])
console.log(`\n[probe] 1) 当前 Node 启动        ${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(0)} ms`)

// ---- 2. 只加载 host 半边（不启动服务）---------------------------------------
const hostOnly = `
const t = Date.now();
await import('@deepseek-ai/dsh-app-boot');
console.log('import app-boot: ' + (Date.now() - t) + ' ms');
`
const t1 = process.hrtime.bigint()
try {
  const out = execFileSync(nodeExe, ['--input-type=module', '-e', hostOnly], {
    cwd: runtime,
    encoding: 'utf8',
    timeout: 120000,
  })
  console.log(
    `[probe] 2) 加载 host 半边        ${(Number(process.hrtime.bigint() - t1) / 1e6).toFixed(0)} ms  (${out.trim()})`,
  )
} catch (error) {
  console.log('[probe] 2) 加载 host 半边 失败:', String(error.message).slice(0, 120))
}

// ---- 3. 完整启动到打印 URL -------------------------------------------------
console.log('\n[probe] 3) 启动服务端，各阶段计时：')
const start = Date.now()
const child = spawn(
  nodeExe,
  [entry, '--dsh-home', dshHome, '--install-anchor', anchor, '--workspace', process.cwd()],
  {
    // DSH_DESKTOP_TIMING 让 server.mjs 把各启动阶段打到 stderr，
    // 这样"11 秒花在哪"有数据可看，而不是靠猜。
    env: {
      ...process.env, DSH_DESKTOP_TIMING: '1', DSH_DESKTOP: '1',
      DSH_CLIENT_VERSION: JSON.parse(readFileSync(anchor, 'utf8')).version,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  },
)

await new Promise((resolve) => {
  let buffer = ''
  let readyAt
  const timer = setTimeout(() => {
    console.error('[probe] 超时：服务端未就绪')
    process.exitCode = 1
    resolve()
  }, 120000)
  const finish = () => { clearTimeout(timer); resolve() }
  child.once('error', (error) => {
    console.error('[probe] 无法启动服务端:', error.message)
    process.exitCode = 1
    finish()
  })
  child.once('exit', (code) => {
    if (readyAt === undefined) {
      console.error(`[probe] 服务端提前退出：${code}`)
      process.exitCode = 1
    }
    finish()
  })
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let end
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (line.startsWith('dsh web:')) console.log(`[probe]   URL 行           ${Date.now() - start} ms`)
      if (readyAt === undefined && line.includes('[dsh-desktop] ready')) {
        readyAt = Date.now() - start
        console.log(`[probe]   就绪信号          ${readyAt} ms`)
      }
    }
    if (readyAt !== undefined) finish()
  })
  // 计时标记在 stderr 上；原样转发。
  child.stderr.on('data', (chunk) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      const text = line.trim()
      if (text === '') continue
      if (text.includes('[timing]') || text.includes('Error') || text.includes('fatal')) {
        console.log(`[probe] ${text}`)
      }
    }
  })
})

child.kill('SIGTERM')
const killTimer = setTimeout(() => child.kill('SIGKILL'), 3000)
killTimer.unref()
child.once('exit', () => clearTimeout(killTimer))
console.log(`[probe] 总计 ${Date.now() - start} ms`)
if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
  await new Promise((resolve) => child.once('exit', resolve))
}
clearTimeout(killTimer)
// Check the resolved absolute directory before any recursive deletion.
const probePath = realpathSync(dshHome)
const probePrefix = join(realpathSync(tmpdir()), 'dsh-startup-probe-')
if (!probePath.startsWith(probePrefix) || !probePath.startsWith(realpathSync(tmpdir()) + sep)) {
  throw new Error('Refusing to clean a probe directory outside the temporary root')
}
rmSync(dshHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
