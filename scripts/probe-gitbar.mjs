// 检查 gitbar 的 host 路由是否已注册并可用。
//
//   node scripts/probe-gitbar.mjs
//
// 分成两个独立的问题，避免把结论混在一起：
//   1. host 半边挂上了吗？—— 路由能响应就说明 bundle 与 patch 都生效了
//   2. client 半边进图了吗？—— 由 probe-boot-manifest.mjs 回答
// 只有 (1) 成立时，(2) 的失败才说明是客户端模块扫描的问题。
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const home = join(process.cwd(), '.dev-home', 'home')
const runtime = join(process.cwd(), 'runtime')
const nodeExe = process.execPath
const workspace = process.cwd()

const child = spawn(
  nodeExe,
  [
    join(runtime, 'server.mjs'),
    '--dsh-home',
    home,
    '--install-anchor',
    join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    '--workspace',
    workspace,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)

function waitForUrl(timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('等待 URL 超时')), timeoutMs)
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const match = /dsh web: (\S+)/u.exec(buffer)
      if (match !== null) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      if (/fatal/u.test(text)) {
        clearTimeout(timer)
        reject(new Error(text.slice(0, 500)))
      }
    })
  })
}

try {
  const url = await waitForUrl()
  const origin = new URL(url).origin
  console.log('[probe] origin:', origin)

  for (const path of ['status', 'branches']) {
    const response = await fetch(`${origin}/dsh-desktop/gitbar/${path}`)
    const text = await response.text()
    console.log(`[probe] GET ${path}: ${response.status}  ${text.slice(0, 220)}`)
  }

  // 顺带问一下服务端自己认得哪些路由：如果它暴露了路由表，就能直接看出插件是否注册。
  for (const probe of ['/dsh-desktop/', '/dsh-desktop/gitbar/', '/']) {
    const response = await fetch(`${origin}${probe}`)
    console.log(`[probe] GET ${probe}: ${response.status}`)
  }
} catch (error) {
  console.error('[probe] 失败:', String(error.message).slice(0, 500))
} finally {
  child.kill()
  setTimeout(() => process.exit(0), 500)
}
