// 真实集成测试：Desktop 启动链必须让 `ctx.settings` 真的挂载（设置页的数据源）。
//
//   npm run build && node scripts/test-settings-composition.mjs
//
// 为什么必须有这个测试：0.1.7 起 `@deepseek-ai/dsh-base` 把 `config-editor` 与 `settings`
// 两行挂在 `disabled: !!js "!ctx.get('profileContext')"` 上，而 Desktop 走的是
// `loadProfileDirectory()` + `boot()` 这条「应用自有 profile」的路径（不是 CLI 的
// `runProfile()`），`profileContext` 必须由外壳自己 provide。忘了 provide 的后果**不是**
// 启动失败，而是两行被静默判成 disabled：
//
//   * Loader 直接跳过 disabled 行；`auditStartupEntries()` 也明确跳过 disabled 行，
//     所以 Host 日志里一条警告都没有（这正是这个 bug 能上线的原因）；
//   * 现象只剩设置页那句靠后的英文错误 "settings service is absent: mount
//     @deepseek-ai/dsh-settings with @deepseek-ai/dsh-config-editor in the profile
//     composition"，以及通用设置里权限显示「不可用」。
//
// 因此本测试断言的是**运行时的实际组合结果**，不是 YAML 里"那一行看起来存在"：
// 真的起一次服务端，读 Host 自己打出来的组合自检，并交叉验证 profile 文件被动过哪些。
//
// 用真的 `DshServer` 而不是自己 spawn，是为了连"把 src/server/server.mjs 同步进 runtime
// 再运行"这一步都走生产代码——否则测试可能跑在过期的 runtime 副本上。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { DshServer } from '../dist/main/dsh-server.js'
import { syncBundledPlugins } from './sync-plugins.mjs'

const root = resolve(import.meta.dirname, '..')
// 默认用仓库里 staged 的 runtime；`DSH_TEST_RUNTIME_DIR` 可以指向另一份（例如应用内置的
// 那份），用来在"仓库 runtime 版本"与"用户实际在跑的版本"之间做对照。
const runtimeDir = resolve(process.env.DSH_TEST_RUNTIME_DIR ?? join(root, 'runtime'))
/** 应用内置的客户端插件：它们必须与设置服务共存，不能被修复顺手清掉。 */
const BUNDLED_PLUGINS = [
  'dsh-client-ui-gitbar',
  'dsh-client-ui-review',
  'dsh-client-ui-typography',
  'dsh-client-ui-shell-bridge',
]

let passed = 0
let failed = 0
async function check(name, action) {
  try {
    await action()
    passed += 1
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// 宿主半边是从 runtime/node_modules 里那份副本加载的，不同步就会测到旧代码
// （见 test-gitbar-branches.mjs 的说明）。换成外部 runtime 时**不动**它：只按其中实际
// 存在的插件来断言，避免测试去改写别人的安装目录。
const repoRuntime = resolve(join(root, 'runtime'))
const plugins =
  runtimeDir === repoRuntime
    ? syncBundledPlugins()
    : BUNDLED_PLUGINS.filter((name) => existsSync(join(runtimeDir, 'node_modules', name, 'package.json')))

const scratch = mkdtempSync(join(tmpdir(), 'dsh-settings-composition-'))
const home = join(scratch, 'home')
const workspace = join(scratch, 'workspace')
mkdirSync(home, { recursive: true })
mkdirSync(workspace, { recursive: true })

/** 生产环境里 DshServer 拿到的运行时位置（与 paths.ts 的开发期分支一致）。 */
const runtime = {
  dir: runtimeDir,
  installAnchor: join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  serverEntry: join(root, 'src', 'server', 'server.mjs'),
  serverRunEntry: join(runtimeDir, 'server.mjs'),
  nodeBinary: process.execPath,
  packaged: false,
}

const profileDir = join(home, 'profiles', 'desktop')
const profileManifest = join(profileDir, 'package.json')
const profilePatch = join(profileDir, 'cordis.patch.yml')

/** 起一次真实服务端，跑断言，然后停掉。 */
async function withServer(body) {
  const server = new DshServer({ runtime, dshHome: home, workspace, registerWorkspace: false })
  const logs = []
  server.on('log', ({ line }) => logs.push(line))
  try {
    await server.start()
    await body(logs, server)
  } finally {
    await server.stop(3000)
  }
}

/**
 * 真的把界面首页取一次。
 *
 * 这一步不能省：`webserver/index-inject` 的 `ctx.emit` 对监听器抛错**没有** try/catch，
 * 任何一个内置插件在那个事件上抛错，`renderIndex()` 就会让整个响应失败——Web 服务器把
 * 处理器抛错统一回成 **400**（`dsh-host-webserver` 的 `handle().catch(...)`）。
 * 也就是说"首页 200"同时验证了"界面能打开"和"没有插件在 index 注入上炸掉"。
 *
 * 认证走官方那套：`GET /?token=…` 换回绑定 authority 的 HttpOnly cookie，再取 `/`。
 *
 * @param server - 已就绪的服务端。
 * @returns `{ exchangeStatus, status, bytes, hasRoot }`。
 */
async function fetchIndex(server) {
  const authenticated = server.ready?.authenticatedUrl
  assert.ok(typeof authenticated === 'string' && authenticated !== '', 'server.ready.authenticatedUrl 应当可用')
  const exchange = await fetch(authenticated, { redirect: 'manual' })
  const cookie = (exchange.headers.getSetCookie?.() ?? []).map((value) => value.split(';')[0]).join('; ')
  assert.notEqual(cookie, '', 'token 交换应当发回会话 cookie')
  const page = await fetch(new URL('/', authenticated), { headers: { cookie } })
  const html = await page.text()
  return { exchangeStatus: exchange.status, status: page.status, bytes: html.length, hasRoot: html.includes('id="root"') }
}

/** 组合自检里那一行（正常路径）。 */
const mountedLine = (logs) => logs.find((line) => line.includes('设置服务: ctx.settings 已挂载'))
/** 组合自检里"设置缺席"的那一行。 */
const missingLine = (logs) => logs.find((line) => line.includes('设置服务缺失'))
/** `profileContext` 有没有被外壳 provide。 */
const contextLine = (logs) => logs.find((line) => line.includes('组合上下文:'))
/** Loader 的未激活告警（`auditStartupEntries` 只对非 disabled 行发这条）。 */
const inactiveLines = (logs) => logs.filter((line) => line.includes('did not activate'))

/** 从 `设置服务: … <- <路径>（v<版本>）` 里取出那份设置包的实际路径。 */
function settingsOrigin(line) {
  const match = /<-\s(.*?)(?:（v|$)/u.exec(line)
  assert.ok(match !== null, `设置服务那一行里应当带上包路径: ${line}`)
  return match[1].trim()
}

try {
  console.log('=== 启动 1：全新的 harness home（首次启动就是好的） ===')
  await withServer(async (logs, server) => {
    await check('Host 自己 declare 了 profileContext（本轮修复的根因）', () => {
      const line = contextLine(logs)
      assert.ok(line !== undefined, `缺少组合自检: ${logs.slice(-8).join(' | ')}`)
      assert.ok(line.includes('已 provide'), line)
    })
    await check('ctx.settings 真的挂载了，并指明了包来源', () => {
      const line = mountedLine(logs)
      assert.ok(line !== undefined, `ctx.settings 未挂载。日志:\n${logs.join('\n')}`)
      console.log(`        ${line.trim()}`)
    })
    await check('没有"设置服务缺失"的诊断', () => assert.equal(missingLine(logs), undefined))
    await check('没有未激活告警（settings/config-editor 都是 ACTIVE）', () => {
      const inactive = inactiveLines(logs)
      assert.deepEqual(inactive, [], inactive.join('\n'))
    })
    await check('设置包解析到内置运行时，没有被 profile 本地副本顶掉', () => {
      const origin = settingsOrigin(mountedLine(logs))
      // 0.1.5 的 link 后端把闭包投影成 `<home>/profiles/node_modules/<pkg>` 的**链接**，
      // 0.1.7 由进程内拦截直接给真实落点。判据因此是"最终指向哪里"而不是"路径长什么样"：
      // 一个 profile 本地的真副本才会 shadow 掉内置运行时，也正是这条断言要拦下的东西。
      const canonical = realpathSync.native(origin)
      const runtimeRoot = realpathSync.native(runtimeDir)
      assert.ok(
        canonical === runtimeRoot || canonical.startsWith(runtimeRoot + sep),
        `设置包应当最终指向内置运行时 ${runtimeRoot}，实际解析到 ${canonical}`,
      )
      assert.equal(origin.includes(join('profiles', 'desktop', 'node_modules')), false, origin)
    })
    await check('profile 的 bundle 列表 = 核心两件 + 全部内置插件', () => {
      const manifest = JSON.parse(readFileSync(profileManifest, 'utf8'))
      const bundles = manifest.dsh.profile.bundles
      assert.deepEqual(bundles.slice(0, 2), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
      // 顺序由 server.mjs 的 BUNDLED_PLUGINS 决定，这里只比较集合：插件缺席时它不该
      // 出现在列表里，出现的每一个都必须是真实存在的内置插件。
      assert.deepEqual([...bundles.slice(2)].sort(), [...plugins].sort())
    })
    await check('第三方插件都被链进了 profile（保留，不清空）', () => {
      for (const plugin of BUNDLED_PLUGINS) {
        if (!plugins.includes(plugin)) continue
        const manifest = JSON.parse(readFileSync(join(profileDir, 'node_modules', plugin, 'package.json'), 'utf8'))
        assert.equal(manifest.name, plugin)
      }
    })
    await check('界面首页真的渲染出来了（200；插件在 index 注入上抛错会变成 400）', async () => {
      const page = await fetchIndex(server)
      assert.equal(page.exchangeStatus, 303)
      assert.equal(page.status, 200, `首页应当 200，实际 ${String(page.status)}`)
      assert.ok(page.bytes > 1000, `首页应当有内容，实际 ${String(page.bytes)} 字节`)
      assert.equal(page.hasRoot, true, '首页里应当有 Web UI 的挂载点')
    })
  })

  const manifestAfterFirst = readFileSync(profileManifest, 'utf8')
  const patchAfterFirst = readFileSync(profilePatch, 'utf8')

  console.log('')
  console.log('=== 启动 2：同一个 home 再启动一次（幂等；用户 patch 不许被清空） ===')
  await withServer(async (logs) => {
    await check('第二次启动同样挂载 ctx.settings', () => assert.ok(mountedLine(logs) !== undefined))
    await check('第二次启动同样 provide 了 profileContext', () =>
      assert.ok(contextLine(logs)?.includes('已 provide')))
    await check('仍然没有未激活告警', () => assert.deepEqual(inactiveLines(logs), []))
    await check('profile 的 package.json 没有被重复改写', () =>
      assert.equal(readFileSync(profileManifest, 'utf8'), manifestAfterFirst))
    await check('用户的 cordis.patch.yml 一个字节都没被动过', () =>
      assert.equal(readFileSync(profilePatch, 'utf8'), patchAfterFirst))
  })

  console.log('')
  console.log('=== 启动 3：负向对照——组合里真的没有 settings 时必须报出来 ===')
  // 只把承载设置的组合行关掉。这既证明自检不是空转（正常时它确实在检查），
  // 也证明"ctx.settings 缺席"这条错误路径本身是可达的。
  writeFileSync(profilePatch, '- id: settings\n  disabled: true\n')
  await withServer(async (logs) => {
    await check('设置服务缺席时 Host 打印"设置服务缺失"', () => {
      assert.ok(missingLine(logs) !== undefined, `日志:\n${logs.join('\n')}`)
    })
    await check('诊断里点名了行 id、包名与"为什么没起来"', () => {
      const detail = logs.find((line) => line.includes('settings (') && line.includes('门控'))
      assert.ok(detail !== undefined, `日志:\n${logs.join('\n')}`)
      console.log(`        ${detail.trim()}`)
    })
    await check('缺席不再表现为静默（Loader 审计之外还有一条明确诊断）', () => {
      assert.equal(mountedLine(logs), undefined)
    })
  })
} catch (error) {
  failed += 1
  console.error(`测试异常: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log('')
console.log(`${passed} 项通过${failed === 0 ? '' : `，${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
