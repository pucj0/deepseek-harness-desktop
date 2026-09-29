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
import { existsSync } from 'node:fs'
import { join } from 'node:path'

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

const dshHome = join(arg ?? installDir, 'probe-home')

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

// ---- 1. 内置 Node 自身冷启动 ------------------------------------------------
const t0 = process.hrtime.bigint()
execFileSync(nodeExe, ['-e', 'process.exit(0)'])
console.log(`\n[probe] 1) 内置 Node 冷启动      ${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(0)} ms`)

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
    env: { ...process.env, DSH_DESKTOP_TIMING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  },
)

await new Promise((resolve) => {
  let buffer = ''
  let readyAt
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    for (const line of buffer.split('\n')) {
      if (line.startsWith('dsh web:')) console.log(`[probe]   URL 行           ${Date.now() - start} ms`)
      if (readyAt === undefined && line.includes('[dsh-desktop] ready')) {
        readyAt = Date.now() - start
        console.log(`[probe]   就绪信号          ${readyAt} ms`)
      }
    }
    if (readyAt !== undefined) resolve()
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
  setTimeout(() => resolve(), 180000)
})

child.kill('SIGTERM')
setTimeout(() => child.kill('SIGKILL'), 3000)
console.log(`[probe] 总计 ${Date.now() - start} ms`)
