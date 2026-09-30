// 打包产物里的 npm CLI：**必须存在，且必须是可执行的那一份**。
//
//   node scripts/test-bundled-npm.mjs
//
// 这是"用户不需要安装 Node.js 或 npm"这句话唯一可验证的形态。它检查三件事，缺一不可：
//
//   1. **真实路径存在**：`resources/app.asar.unpacked/node_modules/npm/bin/npm-cli.js`。
//      npm 是被 `spawn` 出来的进程，Electron 的 Node 模式读不了 asar 内部路径，所以
//      asarUnpack 必须把它解出来（asarUnpack 的负向/正向模式写错时，是"打包成功但功能
//      不存在"，只有这里能发现）。
//   2. **能用打包的 Electron 以 Node 模式跑起来**：真正执行一次 `npm --version`，并断言
//      输出是 package.json 里锁定的那个版本。这一条同时证明了"内置 npm 与 Electron 自带
//      的 Node 24 兼容"。
//   3. **不带第二份 portable Node**：`node.exe` 在产物里只能出现一次（Electron 自己那份）。
//
// 没有打包产物时**跳过并说明**，不假装通过。
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = manifest.version
const UNPACKED = join(ROOT, 'release', version, 'win-unpacked')
const RESOURCES = join(UNPACKED, 'resources')
const NPM_CLI = join(RESOURCES, 'app.asar.unpacked', 'node_modules', 'npm', 'bin', 'npm-cli.js')
const ELECTRON = join(UNPACKED, 'dsh-desktop.exe')

let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `（期望 ${expected}）`}`)
}
const has = (label, ok) => check(label, ok === true, true)

console.log('=== 打包 npm CLI ===')
if (!existsSync(UNPACKED)) {
  console.log(`  SKIP  没有打包产物（${UNPACKED}）；先跑 npx electron-builder --win --x64 --dir`)
  console.log('        ——未验证，不当作通过。')
  process.exit(0)
}

// 1. 真实路径。这一条就是验收清单里的那行路径。
has(`解包后的 npm CLI 存在（${NPM_CLI.slice(UNPACKED.length + 1)}）`, existsSync(NPM_CLI))
has('npm 的 package.json 也在解包目录里', existsSync(join(RESOURCES, 'app.asar.unpacked', 'node_modules', 'npm', 'package.json')))

// 3. 第二份 portable Node 不允许出现。`dsh-desktop.exe` 是 Electron 本体，不算。
const strayNode = []
const collect = (dir) => {
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) collect(path)
    else if (/^node\.exe$/iu.test(entry.name)) strayNode.push(path.slice(UNPACKED.length + 1))
  }
}
collect(UNPACKED)
check('产物里的 node.exe 数量', strayNode.length, 0)

// 2. 真的跑一次。用打包的 Electron 以 Node 模式执行，与 runtime-updater 完全同一条路径。
if (existsSync(NPM_CLI) && existsSync(ELECTRON)) {
  const result = spawnSync(ELECTRON, [NPM_CLI, '--version'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    cwd: ROOT,
  })
  const printed = String(result.stdout ?? '').trim()
  check('打包 npm 自报版本', printed, manifest.dependencies.npm)
  if (result.status !== 0) {
    failures += 1
    console.log(`  FAIL  打包 npm 退出码 ${String(result.status)}`)
    console.log(String(result.stderr ?? '').split('\n').slice(0, 10).join('\n'))
  }
} else {
  failures += 1
  console.log('  FAIL  缺少打包的 Electron 或 npm CLI，无法实际执行一次')
}

console.log('')
if (failures > 0) {
  console.error(`打包 npm 契约测试失败：${failures} 项`)
  process.exit(1)
}
console.log('打包 npm 契约测试通过')
