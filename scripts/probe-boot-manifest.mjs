// 检查 boot manifest 里是否包含指定模块，用来验证客户端插件真的进了图。
//
//   node scripts/probe-boot-manifest.mjs [匹配关键字]
//
// 为什么需要：客户端插件不是"放个文件就会加载"，它必须出现在 `__DSH_BOOT__` 的
// 模块图里（由 host 侧扫描每个包的 `dsh.client` 声明后组装）。用 HTTP 抓首页 HTML
// 并检索关键字，是判断"进图了没有"最直接的证据——比截图与猜日志都可靠。
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const keyword = process.argv[2] ?? 'dsh-client-ui-gitbar'
const home = join(process.cwd(), '.dev-home', 'home')
const runtime = join(process.cwd(), 'runtime')
const nodeExe = process.execPath

const child = spawn(
  nodeExe,
  [
    join(runtime, 'server.mjs'),
    '--dsh-home',
    home,
    '--install-anchor',
    join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    '--workspace',
    process.cwd(),
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)

/** 等待 stdout 里出现带 token 的 URL。 */
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
        reject(new Error(text.slice(0, 400)))
      }
    })
  })
}

try {
  const url = await waitForUrl()
  console.log('[probe] 服务端就绪:', url.slice(0, 48) + '…')

  // 认证握手：token 只在 `GET /` 上被接受，服务端据此写入 HttpOnly cookie 并 302 到
  // 干净的 `/`。因此必须跟随重定向并带上 cookie，否则拿到的是 68 字节的跳转页而不是
  // 真正的应用外壳。
  let response = await fetch(url, { redirect: 'manual' })
  const location = response.headers.get('location')
  const cookie = (response.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  console.log('[probe] token 握手:', response.status, '->', location ?? '(无跳转)')

  if (location !== null) {
    const target = new URL(location, url).href
    response = await fetch(target, { headers: cookie === '' ? {} : { cookie } })
  }

  const html = await response.text()
  console.log('[probe] 页面状态:', response.status, ' HTML 长度:', html.length)
  console.log(`[probe] 是否包含 "${keyword}":`, html.includes(keyword))

  if (!html.includes(keyword)) {
    const boot = /__DSH_BOOT__[\s\S]{0,200}/u.exec(html)
    console.log('[probe] __DSH_BOOT__ 附近:', boot === null ? '(未找到)' : boot[0].slice(0, 200))
    // 顺带看看图里有哪些客户端模块，便于对比。
    const ids = [...html.matchAll(/"@deepseek-ai\/([a-z0-9-]+)"/gu)].map((m) => m[1])
    console.log('[probe] 图里出现的 @deepseek-ai 包数:', new Set(ids).size)
    console.log('[probe] 样例:', [...new Set(ids)].slice(0, 12).join(', '))
  }
} catch (error) {
  console.error('[probe] 失败:', String(error.message).slice(0, 400))
} finally {
  child.kill()
  setTimeout(() => process.exit(0), 500)
}
