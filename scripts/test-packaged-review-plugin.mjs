// **打包版加载的是哪一份 review 插件**——构建 / 打包契约。
//
//   node scripts/test-packaged-review-plugin.mjs
//
// 为什么需要它：源码改好了、单测全绿，而用户装出来的应用里跑的是 **resources/plugins** 里那一份
// （`plugins/` → electron-builder extraResources → `resources/plugins` → 子进程用
// `--bundled-plugins-dir` 把它链进 profile 的 node_modules）。这条链任何一环接错，症状都是
// "界面还是旧的"，而单测永远发现不了——它只在打包产物里成立。因此这里检查三件事：
//
//   1. **打包后的 client.js 含新版标识**（`REVIEW_KIND` / `REVIEW_SIDEBAR_ID` /
//      `ReviewSidebarTab`），且**不再含旧入口**（`TURN_DRAWER_SLOT` / `turnDrawerStore`）；
//   2. **与开发目录那一份逐字节相同**：防止"源码改了、extraResources 里的副本是旧的"；
//   3. **启动后通过 profile 的链接读到的内容 == 本安装包 resources/plugins 里那一份**。
//      刻意用"读内容"而不是解析链接类型：Node 24 在 Windows 上把 junction 报告成普通目录
//      （`lstat().isSymbolicLink()` 为 false、`readlinkSync` 抛 EINVAL），`realpathSync` 也
//      可能原样返回链接路径。读到哪一份内容，用户就加载哪一份——这才是判据。
//
// 没有打包产物时**跳过并明确说明**，不假装通过。
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, lstatSync, readlinkSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const UNPACKED = join(ROOT, 'release', version, 'win-unpacked')
const RESOURCES = join(UNPACKED, 'resources')
const PACKAGED_PLUGIN = join(RESOURCES, 'plugins', 'dsh-client-ui-review')
const DEV_PLUGIN = join(ROOT, 'plugins', 'dsh-client-ui-review')

let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `（期望 ${expected}）`}`)
}
const has = (label, ok) => check(label, ok === true, true)

console.log('=== 1. 打包产物里的 review 插件 ===')
if (!existsSync(PACKAGED_PLUGIN)) {
  console.log(`  SKIP  没有打包产物（${PACKAGED_PLUGIN}）；先跑 npx electron-builder --win --x64 --dir`)
  console.log('        ——未验证，不当作通过。')
  process.exit(0)
}

const packagedClientPath = join(PACKAGED_PLUGIN, 'lib', 'client.js')
has('resources/plugins 里有 review 插件', existsSync(packagedClientPath))
const packagedClient = readFileSync(packagedClientPath, 'utf8')
/** 去掉注释后的**代码**：历史写法在注释里被故意留着警示后人，断言只针对代码。 */
const packagedCode = packagedClient.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^[ \t]*\/\/.*$/gmu, '')

// 新版标识：三个都必须出现。
for (const needle of [
  "const REVIEW_KIND = 'review'",
  "const REVIEW_SIDEBAR_ID = 'dsh-client-ui-review/review'",
  'function ReviewSidebarTab(props)',
  'function ReviewSidebarTabTitle(props)',
  'useTurnContext',
]) {
  has(`打包版含 ${needle.slice(0, 46)}`, packagedClient.includes(needle))
}
// 旧入口：**代码里**一个都不许出现（`shell.overlay` 那个自制浮层整条链路已经删除；注释里
// 保留一句"以前是这么写的"是刻意的，不属于可执行入口）。
for (const gone of ['TURN_DRAWER_SLOT', 'turnDrawerStore', 'useTurnDrawerOpen', 'TurnReviewDrawer']) {
  check(`打包版代码里不含旧标识 ${gone}`, packagedCode.includes(gone), false)
}
check('打包版代码里不再把 shell.overlay 当作本轮审查的槽位', packagedCode.includes("'shell.overlay'"), false)

console.log('')
console.log('=== 2. 打包副本与开发目录那一份一致 ===')
{
  const devClient = readFileSync(join(DEV_PLUGIN, 'lib', 'client.js'), 'utf8')
  has('lib/client.js 逐字节相同', devClient === packagedClient)
  // 其它文件也一起比：只比 client.js 会漏掉"改了 host 半边却忘了重新打包"。
  for (const name of ['package.json', 'cordis.patch.yml', join('lib', 'index.js'), join('lib', 'repo-context.js'), join('lib', 'commit-message.js')]) {
    const dev = existsSync(join(DEV_PLUGIN, name)) ? readFileSync(join(DEV_PLUGIN, name), 'utf8') : null
    const shipped = existsSync(join(PACKAGED_PLUGIN, name)) ? readFileSync(join(PACKAGED_PLUGIN, name), 'utf8') : null
    has(`${name} 相同（两边都在）`, dev !== null && shipped !== null && dev === shipped)
  }
  // 产物目录必须就是 package.json 里那个版本：否则说明在拿别的版本的产物做验证。
  has(`产物目录是 release/${version}`, existsSync(UNPACKED))
}

console.log('')
console.log('=== 3. 真实启动后 profile 的链接读到的是本安装包那一份 ===')
{
  mkdirSync(tmpdir(), { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'dsh-packaged-review-'))
  mkdirSync(join(home, 'ws'), { recursive: true })
  const appAsar = join(RESOURCES, 'app.asar')
  const exe = join(UNPACKED, 'dsh-desktop.exe')

  /**
   * 启动打包后的 runtime（与 `test-desktop-runtime.mjs` 同一条路径），等它 ready 后杀掉。
   *
   * 用 `spawn` 逐块读 stdout：服务端起来之后不会退出，等它结束就只能等超时。
   * @returns `{ ready, stderr }`。
   */
  const boot = () =>
    new Promise((settle) => {
      const child = spawn(
        exe,
        [
          join(appAsar, 'runtime', 'server.mjs'),
          '--max-http-header-size=1048576',
          '--dsh-home',
          home,
          '--install-anchor',
          join(appAsar, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
          '--bundled-plugins-dir',
          join(RESOURCES, 'plugins'),
          '--workspace',
          join(home, 'ws'),
        ],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let stdout = ''
      let stderr = ''
      let ready = false
      const deadline = setTimeout(() => finish(), 120_000)
      function finish() {
        clearTimeout(deadline)
        try {
          child.kill('SIGKILL')
        } catch {
          // 已经退出。
        }
        settle({ ready, stderr })
      }
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk)
        if (!ready && /^dsh web:\s+\S+/mu.test(stdout)) {
          ready = true
          setTimeout(finish, 400)
        }
      })
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })
      child.on('error', () => finish())
      child.on('exit', () => finish())
    })

  const result = await boot()
  has('打包 runtime 启动到 ready', result.ready)
  if (!result.ready) console.log(String(result.stderr).split('\n').slice(0, 12).join('\n'))

  const link = join(home, 'profiles', 'desktop', 'node_modules', 'dsh-client-ui-review')
  has('profile 里有 review 插件的链接', existsSync(link))
  if (existsSync(link)) {
    // 诊断：把原始事实留在输出里，下次这条用例变红时不必再猜。
    let facts = ''
    try {
      facts = `isSymbolicLink=${String(lstatSync(link).isSymbolicLink())} realpath=${String(realpathSync(link))}`
    } catch (error) {
      facts = `lstat/realpath 失败: ${String(error.code ?? error.message)}`
    }
    try {
      facts += ` readlink=${String(readlinkSync(link))}`
    } catch (error) {
      facts += ` readlink=<${String(error.code ?? error.message)}>`
    }
    console.log(`  INFO  链接事实: ${facts}`)

    let shipped = ''
    try {
      shipped = readFileSync(join(link, 'lib', 'client.js'), 'utf8')
    } catch (error) {
      console.log(`  INFO  通过链接读取失败: ${String(error.code ?? error.message)}`)
    }
    has('通过链接读到的 review 插件是新版', shipped.includes("const REVIEW_KIND = 'review'"))
    has('通过链接读到的插件里没有旧抽屉', shipped.includes('TURN_DRAWER_SLOT') === false)
    // **核心断言**：内容与本安装包的 `resources/plugins` 逐字节相同，因此它一定来自这里，
    // 而不是旧 runtime、旧 userData 或别的 release 目录里的副本。
    has('通过链接读到的内容 == resources/plugins 里那一份', shipped === packagedClient && shipped !== '')
    check('链接路径里没有 userData / 旧 runtime 痕迹', /[\\/]runtime[\\/]|userData/iu.test(link), false)
  }

  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    console.log(`  INFO  临时 profile 未能删除（句柄未释放）：${home}`)
  }
}

console.log('')
if (failures > 0) {
  console.error(`打包 review 插件契约失败：${failures} 项`)
  process.exit(1)
}
console.log('打包版加载的确实是当前 resources/plugins 里的新版 review 插件')
