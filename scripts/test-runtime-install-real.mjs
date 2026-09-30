// **真实 npm 安装**：用打包应用实际携带的那份 npm CLI，真的装一次 `@deepseek-ai/dsh@0.2.0-rc.2`。
//
//   node scripts/test-runtime-install-real.mjs
//
// 这是 1.7.5 那个故障的端到端复现与验证：Desktop 1.7.5 内置 `0.2.0-rc.1`，官方最新
// `0.2.0-rc.2`——修复前 `RuntimeUpdater` 会在"低于内置版本"的判断上直接抛错、根本不跑 npm。
//
// 它**需要网络**（registry + 可选 GitHub），因此不在默认测试链里：默认命令会打印一条 SKIP 并
// 以 0 退出；要真的跑就设置 `DSH_REAL_INSTALL=1`（想顺带校验 GitHub 授权再加 `DSH_REAL_RELEASE=1`）。
//
//   $env:DSH_REAL_INSTALL='1'; node scripts/test-runtime-install-real.mjs
//
// 它刻意使用**用户机器上并不存在**的东西：没有系统 npm 的路径假设——跑的就是
// `node_modules/npm/bin/npm-cli.js`（打包形态下它在 `app.asar.unpacked` 里），
// 与 `locateBundledNpm` 找到的是同一个文件。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const TARGET = '0.2.0-rc.2'
const BUNDLED = '0.2.0-rc.1'
const REGISTRY = 'https://registry.npmmirror.com'
const PACKAGE = '@deepseek-ai/dsh'

if (process.env.DSH_REAL_INSTALL !== '1') {
  console.log('SKIP 真实安装测试（需要网络）。要跑请设置 DSH_REAL_INSTALL=1')
  console.log(`     它会真的把 ${PACKAGE}@${TARGET} 装进一个临时目录，并断言 current 指向它。`)
  process.exit(0)
}

const npmCli = join(ROOT, 'node_modules', 'npm', 'bin', 'npm-cli.js')
if (!existsSync(npmCli)) {
  console.error(`找不到随包的 npm CLI：${npmCli}（先 npm ci）`)
  process.exit(1)
}

const { RuntimeUpdater, readRuntimeVersion } = await import('../dist/main/runtime-updater.js')
const { checkRuntimeRelease } = await import('../dist/main/runtime-release.js')

let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `（期望 ${expected}）`}`)
}
const has = (label, ok) => check(label, ok === true, true)

const root = mkdtempSync(join(tmpdir(), 'dsh-real-install-'))
const userDataDir = join(root, 'userData')
mkdirSync(userDataDir, { recursive: true })

/**
 * 目标版本的发布时间 → `--before`。
 *
 * 直接问 registry：`--before` 必须落在"该版本发布之后、下一波发布之前"，否则同一次发布里
 * 稍后才上架的兄弟包解析不到（那正是 `stage-runtime.mjs` 里 ETARGET 的成因）。这里取
 * `published + 1h`，既留出兄弟包的时间，又不会跨进下一波。
 *
 * @returns ISO 时间字符串；问不到时 undefined（退回"不加 --before"）。
 */
async function publishedAtFor(version) {
  try {
    const response = await fetch(`${REGISTRY}/${PACKAGE.replace('/', '%2F')}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) return undefined
    const body = await response.json()
    const at = body?.time?.[version]
    if (typeof at !== 'string') return undefined
    const parsed = Date.parse(at)
    if (!Number.isFinite(parsed)) return undefined
    return new Date(parsed + 60 * 60 * 1000).toISOString()
  } catch {
    return undefined
  }
}

const publishedAt = await publishedAtFor(TARGET)
console.log(`${PACKAGE}@${TARGET} 发布于 → --before=${publishedAt ?? '(未知，不设)'}`)

// 授权：默认只按"NPM 上确实有这个版本"放行；想连 GitHub Release 一起校验就用 DSH_REAL_RELEASE=1。
const checkRelease = process.env.DSH_REAL_RELEASE === '1'
  ? (current) => checkRuntimeRelease(current)
  : async () => ({ available: true, current: BUNDLED, latest: TARGET, releaseUrl: `https://example.invalid/dsh-v${TARGET}` })

const updater = new RuntimeUpdater({
  userDataDir,
  resourcesPath: join(ROOT, 'node_modules', 'electron', 'dist', 'resources'),
  appPath: ROOT,
  // `app.getAppPath()` 在开发形态下就是仓库根：npm 在 `node_modules/npm` 里，所以这里显式
  // 不用打包形态也能找到它。
  packaged: true,
  bundledVersion: BUNDLED,
  checkRelease,
})

console.log('')
console.log(`=== 1. 安装 ${PACKAGE}@${TARGET}（内置 ${BUNDLED}）===`)
const progress = []
let result
try {
  result = await updater.install({ version: TARGET, publishedAt, onProgress: (entry) => progress.push(entry.message) })
} catch (error) {
  failures += 1
  console.log(`  FAIL  安装抛出异常：${String(error.message ?? error).split('\n')[0]}`)
  console.log('        ——这正是 1.7.5 的故障形态（"不低于目标版本，无需安装"）。')
  rmSync(root, { recursive: true, force: true })
  process.exit(1)
}

check('1) status 是 installed（不是 already-current）', result.status, 'installed')
check('   relation 是升级', result.relation, 1)
check('   registry 用了 npmmirror 或 npmjs', [REGISTRY, 'https://registry.npmjs.org'].includes(result.registry), true)
console.log(`  INFO  走了 ${progress.length} 条进度，registry=${result.registry}`)

// 真实安装的目录与版本。
const versionDir = join(userDataDir, 'runtime', TARGET)
has('2) 版本目录存在', existsSync(versionDir))
check('   目录里真实 package.json 的版本', readRuntimeVersion(versionDir), TARGET)
const metadata = JSON.parse(readFileSync(join(versionDir, 'runtime.json'), 'utf8'))
check('   runtime.json 的版本', metadata.version, TARGET)
check('   runtime.json 的 sourceRelease', metadata.sourceRelease, `dsh-v${TARGET}`)
has('   runtime.json 记了 closureBefore', typeof metadata.closureBefore === 'string')

// 安装树是完整的（不是只有一个 package.json）。
const dshPkg = join(versionDir, 'node_modules', '@deepseek-ai', 'dsh')
has('3) dsh 包目录存在', existsSync(dshPkg))
const deps = readdirSync(join(versionDir, 'node_modules')).length
has(`   node_modules 里有依赖（${deps} 项）`, deps > 10)

// current 指向它。
check('4) current 读到的版本', readRuntimeVersion(join(userDataDir, 'runtime', 'current')), TARGET)
// staging 已经清干净。
check(
  '5) 没有残留 staging 目录',
  readdirSync(join(userDataDir, 'runtime')).filter((name) => name.startsWith('.staging-')).length,
  0,
)

// ---- 启动时的选择：resolveRuntime 必须挑 downloaded 的 rc.2 ----
console.log('')
console.log('=== 6. 启动选择（resolveRuntime 对着真实装出来的目录）===')
//
// `paths.ts` 在调用 `resolveRuntime()` 时读 `app.isPackaged` / `app.getAppPath()`，而纯 node 下
// `require('electron')` 只给出可执行文件的**路径字符串**、没有 `app`。因此这里用模块加载钩子
// 注入一个最小的 `app`（与 `scripts/test-runtime-paths.cjs` 同一套做法），这样跑的仍是
// `paths.ts` 的**真实逻辑**，只是明确告诉它"这是打包形态、内置 Runtime 在 <appPath>/runtime"。
{
  const Module = await import('node:module')
  const { mkdirSync: mkdirStep, writeFileSync: writeStep } = await import('node:fs')

  // 造一份"内置 Runtime"：直接用刚装出来的那份复制一份，版本稍旧（rc.1）——这样比较器必须
  // 挑出 downloaded（rc.2）而不是 bundled。
  const appPath = join(root, 'app.asar')
  const bundledDir = join(appPath, 'runtime')
  mkdirStep(bundledDir, { recursive: true })
  const bundledDsh = join(bundledDir, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirStep(bundledDsh, { recursive: true })
  writeStep(
    join(bundledDsh, 'package.json'),
    JSON.stringify({ name: PACKAGE, version: BUNDLED }, null, 2) + '\n',
  )

  const previousResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  Object.defineProperty(process, 'resourcesPath', { value: join(root, 'resources'), configurable: true, writable: true })
  const originalLoad = Module.default._load
  Module.default._load = function patched(request, parent, isMain) {
    if (request === 'electron') return { app: { isPackaged: true, getAppPath: () => appPath } }
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    const require2 = Module.createRequire(import.meta.url)
    const pathsPath = require2.resolve('../dist/main/paths.js')
    delete require2.cache[pathsPath]
    const { resolveRuntime } = require2('../dist/main/paths.js')
    const picked = resolveRuntime(userDataDir)
    check('6) 选中的来源', picked.source, 'downloaded')
    check('   选中的版本', picked.version, TARGET)
    check('   选中的目录', picked.dir, join(userDataDir, 'runtime', 'current'))

    // 反例：内置换成更新的一份（0.2.0 正式版）时，必须回退内置。
    writeStep(
      join(bundledDsh, 'package.json'),
      JSON.stringify({ name: PACKAGE, version: '0.2.0' }, null, 2) + '\n',
    )
    delete require2.cache[pathsPath]
    const { resolveRuntime: fresh } = require2('../dist/main/paths.js')
    const fallback = fresh(userDataDir)
    check('   内置更新时回退内置（source）', fallback.source, 'bundled')
    check('   内置更新时回退内置（version）', fallback.version, '0.2.0')
  } finally {
    Module.default._load = originalLoad
    if (previousResources === undefined) delete process.resourcesPath
    else Object.defineProperty(process, 'resourcesPath', previousResources)
  }
}

// ---- 再装一次同一个版本：必须是 already-current，而不是失败 ----
console.log('')
console.log('=== 7. 目标版本 == 当前版本 → already-current（不是失败）===')
// 场景是"下一个 Desktop 版本内置了 rc.2，用户又点了一次安装"：bundledVersion 因此是 rc.2，
// 目标也是 rc.2。它必须安静地返回 already-current，而不是弹红色失败框。
const currentUpdater = new RuntimeUpdater({
  userDataDir,
  resourcesPath: join(ROOT, 'node_modules', 'electron', 'dist', 'resources'),
  appPath: ROOT,
  packaged: true,
  bundledVersion: TARGET,
  checkRelease: async () => ({ available: false, current: TARGET, latest: TARGET, releaseUrl: `https://example.invalid/dsh-v${TARGET}` }),
})
const again = await currentUpdater.install({ version: TARGET, publishedAt })
check('7) status', again.status, 'already-current')
check('   relation', again.relation, 0)
check('   仍然指向同一个版本', readRuntimeVersion(join(userDataDir, 'runtime', 'current')), TARGET)

// ---- 清理 ----
try {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
} catch {
  console.log(`  INFO  临时目录未能删除：${root}`)
}

console.log('')
if (failures > 0) {
  console.error(`真实安装失败：${failures} 项`)
  process.exit(1)
}
console.log(`真实安装通过：${PACKAGE}@${TARGET} 装好、current 指向它、启动选择也用它`)
