// Probe: boot the desktop profile directly and report the URL it serves.
//
// This is the headless equivalent of launching the app, and the quickest way to
// tell a runtime problem from a shell problem:
//
//   node scripts/probe-web.mjs <installRoot> [dshHome]
//
// <installRoot> is a directory containing
//   node_modules/@deepseek-ai/dsh/package.json
// e.g. the repo's ./runtime, or a packaged resources/runtime.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const installRoot = resolve(process.argv[2] ?? 'runtime')
const dshHome = resolve(process.argv[3] ?? join(process.cwd(), '.probe-home'))
const installAnchor = join(installRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')

if (!existsSync(installAnchor)) {
  console.error(`[probe-web] no dsh install at ${installAnchor}`)
  console.error('[probe-web] run "npm run stage:runtime" first, or pass a packaged resources/runtime path')
  process.exit(1)
}

// The boot script must run from beside the runtime's node_modules, so run the
// real one from the repo rather than reimplementing it here.
const serverEntry = resolve(import.meta.dirname, '..', 'src', 'server', 'server.mjs')
const stagedEntry = join(installRoot, 'server.mjs')
copyFileSync(serverEntry, stagedEntry)
copyFileSync(join(resolve(import.meta.dirname, '..'), 'src/server/client-module-cache.mjs'), join(installRoot, 'client-module-cache.mjs'))

mkdirSync(dshHome, { recursive: true })
console.log(`[probe-web] installRoot = ${installRoot}`)
console.log(`[probe-web] dshHome     = ${dshHome}`)
console.log(`[probe-web] entry       = ${stagedEntry}`)

// 这一版不再有便携 Node：子进程就是"以 Node 模式重新执行当前可执行文件"。
// 手动跑探针时 process.execPath 就是跑这个脚本的 Node（本仓库要求 >= 22）。
const nodeBinary = process.execPath

const { spawn } = await import('node:child_process')
const child = spawn(
  nodeBinary,
  [
    stagedEntry,
    '--dsh-home',
    dshHome,
    '--install-anchor',
    installAnchor,
    '--workspace',
    process.cwd(),
  ],
  { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
)

let announced = false
const onLine = (stream) => (chunk) => {
  for (const line of chunk.toString('utf8').split(/\r?\n/u)) {
    if (line === '') continue
    console.log(`[probe-web] ${stream}: ${line}`)
    if (line.startsWith('dsh web:')) announced = true
    if (line === '[dsh-desktop] ready') {
      console.log('[probe-web] ===== READY =====')
      child.kill('SIGTERM')
      setTimeout(() => process.exit(announced ? 0 : 2), 1500)
    }
  }
}
child.stdout.on('data', onLine('out'))
child.stderr.on('data', onLine('err'))
child.on('exit', (code) => {
  if (!announced) {
    console.error(`[probe-web] child exited early with code ${String(code)}`)
    process.exit(1)
  }
})

setTimeout(() => {
  console.error('[probe-web] timed out waiting for readiness')
  child.kill('SIGKILL')
  process.exit(1)
}, 180_000)
