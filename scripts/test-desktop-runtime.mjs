// Desktop Runtime 的契约测试：**策略 + 真实启动**。
//
//   node scripts/test-desktop-runtime.mjs
//
// 这个文件回答的是阶段 D 的那句话："每删一类资源必须由测试证明 Desktop 正常工作。"
// 因此它有两部分，缺一不可：
//
//   1. **策略单元**：不依赖任何构建产物，直接驱动 `runtime-file-policy.mjs`。它把
//      "哪些必须保留、哪些必须剔除"钉成用例——尤其是**必须保留**的那几类，
//      因为按目录名盲删踩过真实的坑（`yaml/dist/doc/` 是运行时代码，
//      删掉后打包应用启动即 `Cannot find module '../doc/directives.js'`）。
//   2. **真实启动 smoke**：真有 `release/<version>/win-unpacked` 时，用 Electron 的
//      **Node 模式**（`ELECTRON_RUN_AS_NODE=1`，与打包后子进程完全同一条路径）跑
//      `app.asar/runtime/server.mjs`，断言它打印出 `dsh web: <url>`，并断言四个内置插件
//      被链接进 profile（链接目标必须是**真实**路径，不能是 asar 内部路径）。
//
// 没有构建产物时第 2 部分会**跳过并说明**，而不是假装通过。
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { desktopRuntimeExclusion, desktopRuntimeTopLevelExclusion } from './runtime-file-policy.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const TARGET = { platform: 'win32', arch: 'x64' }
let failures = 0

const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `（期望 ${expected}）`}`)
}
const has = (label, actual) => check(label, actual === true, true)

console.log('=== 1. 策略：必须保留的运行时代码 ===')
// 这几条是"按名字盲删"的反例，全部来自真实故障。
const MUST_KEEP = [
  ['yaml/dist/doc/directives.js', 'yaml 的运行时代码（曾被 docs? 规则误删）'],
  ['yaml/dist/compose/composer.js', 'yaml 的组合器'],
  ['@mixmark-io/domino/lib/index.js', 'domino 本体'],
  ['@agentclientprotocol/sdk/dist/examples/agent.js', '包内 dist/examples（不是包根 examples）'],
  ['@img/sharp-win32-x64/lib/libvips-42.dll', '目标平台的 native 负载'],
  ['node-pty/build/Release/pty.node', '目标平台的 native addon'],
  ['@vscode/ripgrep-win32-x64/bin/rg.exe', '目标平台的 ripgrep'],
  ['some-pkg/dist/man/reader.js', '包内 dist/man（不是包根 man）'],
]
for (const [path, why] of MUST_KEEP) {
  const reason = desktopRuntimeExclusion(path, TARGET)
  check(`保留 ${path}（${why}）`, reason === undefined ? 'kept' : `dropped: ${reason}`, 'kept')
}

console.log('')
console.log('=== 2. 策略：必须剔除的构建/调试/异平台产物 ===')
const MUST_DROP = [
  ['some-pkg/dist/index.js.map', 'source map'],
  ['some-pkg/lib/types.d.ts', 'TypeScript declaration'],
  ['node-pty/build/Release/pty.pdb', 'debug symbols'],
  ['some-pkg/README.md', 'readme'],
  ['some-pkg/docs/notes.md', 'docs 或 markdown'],
  ['some-pkg/lib/CHANGELOG.md', 'changelog'],
  ['some-pkg/LICENSE', 'license text'],
  ['@mixmark-io/domino/test/domino.js', 'tests'],
  ['some-pkg/docs/api.html', 'docs'],
  ['some-pkg/.yarn/plugins/plugin-version.cjs', 'package-manager metadata'],
  ['@img/sharp-darwin-arm64/lib/libvips.dylib', '非目标平台 native 包'],
  ['node-pty/prebuilds/darwin-arm64/pty.node', 'node-pty 非目标平台预编译'],
  ['node-pty/third_party/conpty/1.25.260303002/win10-arm64/OpenConsole.exe', 'node-pty conpty 非目标架构'],
  ['@deepseek-ai/libreoffice-kit-win32-x64/bin/libreoffice-kit.exe', 'LibreOffice kit'],
  ['sherpa-onnx-win-x64/onnxruntime.dll', 'sherpa-onnx native'],
]
for (const [path, why] of MUST_DROP) {
  const reason = desktopRuntimeExclusion(path, TARGET)
  has(`剔除 ${path}（${why}）`, reason !== undefined)
}

console.log('')
console.log('=== 3. 策略：runtime/ 顶层 ===')
has('剔除便携 Node（node/node.exe）', desktopRuntimeTopLevelExclusion('node/node.exe') !== undefined)
has('剔除便携 Node 目录', desktopRuntimeTopLevelExclusion('node/') !== undefined)
check('保留 server.mjs', desktopRuntimeTopLevelExclusion('server.mjs') ?? 'kept', 'kept')
check('保留 runtime.json', desktopRuntimeTopLevelExclusion('runtime.json') ?? 'kept', 'kept')
check('保留 package.json', desktopRuntimeTopLevelExclusion('package.json') ?? 'kept', 'kept')

// ------------------------------------------------------------------ 真实启动 -----
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const UNPACKED = join(ROOT, 'release', version, 'win-unpacked')
const APP = join(UNPACKED, 'resources', 'app.asar')
const PLUGINS = join(UNPACKED, 'resources', 'plugins')
const EXE = join(UNPACKED, 'dsh-desktop.exe')

console.log('')
console.log('=== 4. 打包产物结构 ===')
if (!existsSync(APP)) {
  console.log(`  SKIP  没有打包产物（${APP}）；先跑 npx electron-builder --win --x64 --dir`)
  console.log('        ——第 4/5 节未验证，不当作通过。')
} else {
  // 树里不能有第二份 Node、也不能有生产 npm CLI：两者都是这一版明确删掉的东西。
  const { getRawHeader } = await import('@electron/asar')
  const header = getRawHeader(APP).header
  const asarPaths = []
  const visit = (node, prefix) => {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const path = prefix === '' ? name : `${prefix}/${name}`
      if (value.files !== undefined) visit(value, path)
      else asarPaths.push(path)
    }
  }
  visit(header, '')
  has('app.asar 里有 runtime/', asarPaths.some((path) => path.startsWith('runtime/')))
  has('app.asar 里有 runtime/server.mjs', asarPaths.includes('runtime/server.mjs'))
  has('没有运行时的 node.exe', asarPaths.some((path) => /(^|\/)node\.exe$/iu.test(path)) === false)
  has('没有生产 npm CLI', asarPaths.some((path) => /node_modules\/npm\/bin\/npm-cli\.js$/u.test(path)) === false)
  // 注意断言的是**平台负载**而不是包名：`@deepseek-ai/libreoffice-kit` 这个 JS 包装层是
  // dsh-web-app / dsh-skill-office 的必需依赖，必须保留；不该携带的是它那 170 MiB 的
  // 平台二进制（`libreoffice-kit-win32-x64` 等）。
  has('没有 LibreOffice 平台负载', asarPaths.some((path) => /libreoffice-kit-(?:win32|darwin|linux|wasm)/u.test(path)) === false)
  has('没有便携 Node 目录', asarPaths.some((path) => path.startsWith('node/')) === false)

  // `electronLanguages` 的效果是可验证的：打包产物里应**只有**中英两套 .pak。
  // 界面文案本身的双语覆盖由 scripts/check-plugin-i18n.mjs 与 test-i18n.cjs 保证。
  const localesDir = join(UNPACKED, 'locales')
  const packs = existsSync(localesDir) ? readdirSync(localesDir).filter((name) => name.endsWith('.pak')).sort() : []
  check('Electron locale 只有中英两套', packs.join(','), 'en-US.pak,zh-CN.pak')

  console.log('')
  console.log('=== 5. 真实启动（Electron Node 模式，与打包后子进程同一条路径）===')
  // `mkdtempSync` 不会创建父目录：某些环境（CI 的自定义 TEMP、被清掉的临时目录）里
  // `tmpdir()` 本身可能不存在，先补上，免得报一个与测试无关的 ENOENT。
  mkdirSync(tmpdir(), { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-runtime-'))
  mkdirSync(join(home, 'ws'), { recursive: true })
  /**
   * 启动打包后的运行时，等到它打印 ready 行。
   *
   * 用 `spawn` 逐块读 stdout 而不是 `execFile`：服务端起来之后**不会退出**，等它结束就只能
   * 等到超时——那样量出来的"耗时"是超时时间，不是启动时间（第一版就是这么错的）。
   *
   * @returns ready 行的出现时刻（毫秒）与完整输出。
   */
  const boot = () =>
    new Promise((settle) => {
      const started = Date.now()
      const child = spawn(
        EXE,
        [
          join(APP, 'runtime', 'server.mjs'),
          '--max-http-header-size=1048576',
          '--dsh-home',
          home,
          '--install-anchor',
          join(APP, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
          '--bundled-plugins-dir',
          PLUGINS,
          '--workspace',
          join(home, 'ws'),
        ],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home } },
      )
      let stdout = ''
      let stderr = ''
      let readyMs
      const deadline = setTimeout(() => finish(undefined), 120_000)
      /** 收尾：关掉子进程并交回结果。 */
      function finish(settledMs) {
        clearTimeout(deadline)
        try {
          child.kill('SIGKILL')
        } catch {
          // 已经退出。
        }
        settle({ readyMs: settledMs, stdout, stderr })
      }
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk)
        if (readyMs === undefined && /^dsh web:\s+\S+/mu.test(stdout)) {
          readyMs = Date.now() - started
          // 子进程起来后不会自己退出：拿到 ready 就收工。
          setTimeout(() => finish(readyMs), 300)
        }
      })
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })
      child.on('error', () => finish(undefined))
      child.on('exit', () => {
        if (readyMs === undefined) finish(undefined)
      })
    })

  const result = await boot()
  has('Runtime 从 app.asar 启动并到达 ready', result.readyMs !== undefined)
  console.log(`  INFO  ready 用时 ${result.readyMs ?? 'n/a'} ms（含 Electron 冷启动与全部插件装载）`)
  if (result.readyMs === undefined) {
    console.log('  --- stdout ---')
    console.log(result.stdout.split('\n').slice(0, 20).join('\n'))
    console.log('  --- stderr ---')
    console.log((result.stderr ?? '').split('\n').slice(0, 25).join('\n'))
  }

  // 插件必须被链进 profile，且链接目标必须是**真实**目录（asar 内部路径无法作为链接目标）。
  const profileModules = join(home, 'profiles', 'desktop', 'node_modules')
  const linked = existsSync(profileModules) ? readdirSync(profileModules).filter((name) => name.startsWith('dsh-client-ui-')) : []
  check('四个内置插件都进了 profile', linked.sort().join(','), 'dsh-client-ui-gitbar,dsh-client-ui-review,dsh-client-ui-shell-bridge,dsh-client-ui-typography')
  has('插件链接指向 resources/plugins（真实目录）', result.stderr.includes('无法链接内置插件') === false)

  // 刚被 SIGKILL 的子进程在 Windows 上可能还握着文件句柄，清理失败不该判定为测试失败。
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    console.log(`  INFO  临时 profile 未能删除（句柄未释放）：${home}`)
  }
}

console.log('')
if (failures > 0) {
  console.error(`Desktop Runtime 契约测试失败：${failures} 项`)
  process.exit(1)
}
console.log('Desktop Runtime 契约测试通过')
