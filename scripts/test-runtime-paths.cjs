// Runtime 选择：内置 vs 应用内更新下载的那份（`<userData>/runtime/current`）。
//
// 这一层是**安全阀**：应用内更新装出来的 Runtime 是用户磁盘上可写的东西，只有当它
// **确实**是一份完整、版本不低于内置的安装时才允许被选中。四条规则各有一个用例：
//
//   1. 下载版本 > 内置 → 用下载的；
//   2. 下载版本 == 内置 → 用下载的（用户刚装的就是这个版本，没必要退回去）；
//   3. 下载版本 < 内置（Desktop 升级后内置变新）→ 必须用内置，**不能被旧的 current 压住**；
//   4. current 损坏/断链/版本读不出来 → 用内置，而不是让应用起不来。
const assert = require('node:assert/strict')
const Module = require('node:module')
const { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')

/**
 * 以"打包形态"加载 dist/main/paths.js。
 *
 * paths.ts 在**模块求值**时就要读 `app.isPackaged` 与 `app.getAppPath()`，所以 mock 必须
 * 在 require 之前装好——这也正是它真实的语义（打包与否是进程级常量）。
 *
 * @param {string} appPath - 模拟的 app.asar 路径（其中的 `runtime/` 就是内置 Runtime）。
 * @param {string} resourcesPath - 模拟的 resources 目录。
 */
function loadPackaged(appPath, resourcesPath) {
  const original = Module._load
  // `process.resourcesPath` 在 Electron 主进程里存在；纯 node 下没有。这份定义是持久的：
  // paths.js 在**每次调用** resolveRuntime 时都会读它（`join(process.resourcesPath, 'runtime')`），
  // 所以不能只在 require 期间存在。
  Object.defineProperty(process, 'resourcesPath', { value: resourcesPath, configurable: true, writable: true })
  Module._load = function patched(request, parent, isMain) {
    if (request === 'electron') return { app: { isPackaged: true, getAppPath: () => appPath } }
    return original.call(this, request, parent, isMain)
  }
  try {
    delete require.cache[require.resolve('../dist/main/paths.js')]
    return require('../dist/main/paths.js')
  } finally {
    Module._load = original
  }
}

/** 造一份"完整"的 Runtime 目录（只要 package.json 能被读到，选择逻辑就认它）。 */
function makeRuntime(dir, version) {
  mkdirSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
  writeFileSync(
    join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version }, null, 2) + '\n',
  )
  writeFileSync(join(dir, 'runtime.json'), JSON.stringify({ version }, null, 2) + '\n')
  return dir
}

/** 把 `<userData>/runtime/current` 指到给定版本目录（与 runtime-updater 同样的链接类型）。 */
function activate(userDataDir, target) {
  const runtimeRoot = join(userDataDir, 'runtime')
  mkdirSync(runtimeRoot, { recursive: true })
  symlinkSync(target, join(runtimeRoot, 'current'), process.platform === 'win32' ? 'junction' : 'dir')
}

function main() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-paths-'))
  const resourcesPath = join(root, 'resources')
  const appPath = join(root, 'app.asar')
  const bundled = makeRuntime(join(appPath, 'runtime'), '0.2.0-rc.1')

  // ------------------------------------------------------------------ 打包形态 ----
  const { resolveRuntime } = loadPackaged(appPath, resourcesPath)

  // 1. 没有下载版本：用内置。
  const plainUserData = join(root, 'plain')
  mkdirSync(plainUserData, { recursive: true })
  let location = resolveRuntime(plainUserData)
  assert.equal(location.source, 'bundled')
  assert.equal(location.version, '0.2.0-rc.1')
  assert.equal(location.dir, bundled)
  assert.equal(location.bundledVersion, '0.2.0-rc.1')
  assert.ok(location.installAnchor.endsWith(join('node_modules', '@deepseek-ai', 'dsh', 'package.json')))

  // 2. 下载版本更新：用下载的。
  const older = join(root, 'older')
  mkdirSync(older, { recursive: true })
  const downloaded = makeRuntime(join(older, 'runtime', '0.3.0'), '0.3.0')
  activate(older, downloaded)
  location = resolveRuntime(older)
  assert.equal(location.source, 'downloaded')
  assert.equal(location.version, '0.3.0')
  assert.equal(location.dir, join(older, 'runtime', 'current'))
  assert.equal(location.bundledVersion, '0.2.0-rc.1')

  // 3. 下载版本与内置相同：仍然用下载的（用户刚装的那份）。
  const same = join(root, 'same')
  mkdirSync(same, { recursive: true })
  activate(same, makeRuntime(join(same, 'runtime', '0.2.0-rc.1'), '0.2.0-rc.1'))
  location = resolveRuntime(same)
  assert.equal(location.source, 'downloaded')
  assert.equal(location.version, '0.2.0-rc.1')

  // 4. **核心回归**：Desktop 升级后内置变新，旧的 current 不能压住它。
  const stale = join(root, 'stale')
  mkdirSync(stale, { recursive: true })
  activate(stale, makeRuntime(join(stale, 'runtime', '0.1.7-rc.2'), '0.1.7-rc.2'))
  location = resolveRuntime(stale)
  assert.equal(location.source, 'bundled', 'an older downloaded runtime must not shadow a newer bundled one')
  assert.equal(location.version, '0.2.0-rc.1')
  assert.equal(location.dir, bundled)

  // 5. 预发布与正式版之间的比较也按 semver 走：0.2.0-rc.1 不超过 0.2.0。
  const releaseAfterRc = join(root, 'release-after-rc')
  mkdirSync(releaseAfterRc, { recursive: true })
  activate(releaseAfterRc, makeRuntime(join(releaseAfterRc, 'runtime', '0.2.0-rc.1'), '0.2.0-rc.1'))
  assert.equal(resolveRuntime(releaseAfterRc).source, 'downloaded')

  // 6. current 断链（指向一个已经被删掉的目录）：退回内置，而不是报"没有 Runtime"。
  const dangling = join(root, 'dangling')
  mkdirSync(join(dangling, 'runtime'), { recursive: true })
  symlinkSync(join(dangling, 'runtime', 'gone'), join(dangling, 'runtime', 'current'), process.platform === 'win32' ? 'junction' : 'dir')
  location = resolveRuntime(dangling)
  assert.equal(location.source, 'bundled', 'a dangling current must fall back to the bundled runtime')

  // 7. current 里没有 dsh 包 / 版本号非法：同样退回内置。
  const corrupt = join(root, 'corrupt')
  mkdirSync(join(corrupt, 'runtime', 'current'), { recursive: true })
  assert.equal(resolveRuntime(corrupt).source, 'bundled')
  const bogus = join(root, 'bogus')
  mkdirSync(bogus, { recursive: true })
  activate(bogus, makeRuntime(join(bogus, 'runtime', '9.9.9'), 'not-a-version'))
  assert.equal(resolveRuntime(bogus).source, 'bundled', 'an unparsable version must not be trusted')

  // ------------------------------------------- 8. 预发布版本的选择（1.7.5 的同类 bug） ----
  //
  // `paths.ts` 以前有一份自己的 `compareVersions()`，只看 major.minor.patch，于是
  // `0.2.0-rc.1`、`0.2.0-rc.2`、甚至 `0.2.0` 全都"相等"——"下载版没比内置新"和"下载版更新"
  // 分不出来。下面四组把预发布的四种关系都钉住（内置固定为 0.2.0-rc.1，见文件开头）。
  //
  //   内置 0.2.0-rc.1 为基准：
  //     下载 0.2.0-rc.2  → 更新      → 用 downloaded
  //     下载 0.2.0-rc.1  → 相同      → 用 downloaded（就是同一版本）
  //     下载 0.2.0-rc.10 → 更新      → 用 downloaded（按数值，不是字符串）
  //     下载 0.2.0       → 更新      → 用 downloaded（正式版 > 预发布）
  //     下载 0.2.0-alpha.1 → 更旧    → 用 bundled
  const prereleaseCases = [
    ['0.2.0-rc.2', 'downloaded', 'rc.2 比内置的 rc.1 新'],
    ['0.2.0-rc.1', 'downloaded', '与内置同版本时继续用下载的那份'],
    ['0.2.0-rc.10', 'downloaded', 'rc.10 比 rc.1 新（数字按数值比）'],
    ['0.2.0', 'downloaded', '正式版比预发布新'],
    ['0.2.0-alpha.1', 'bundled', 'alpha 比 rc 旧，必须回退内置'],
    ['0.1.9', 'bundled', '旧的正式版不能压住新的预发布'],
  ]
  for (const [downloadedVersion, expected, why] of prereleaseCases) {
    const dir = join(root, `pre-${downloadedVersion.replace(/[^\w.-]/gu, '_')}`)
    mkdirSync(dir, { recursive: true })
    activate(dir, makeRuntime(join(dir, 'runtime', downloadedVersion), downloadedVersion))
    const picked = resolveRuntime(dir)
    assert.equal(picked.source, expected, `${why}：期望 ${expected}，实际 ${picked.source}`)
    assert.equal(picked.version, expected === 'downloaded' ? downloadedVersion : '0.2.0-rc.1')
  }

  // -------------------------------------------- 9. 内置更新时不能被旧下载版压住 ----
  // 内置 0.2.0（正式版），下载 0.2.0-rc.99：预发布再"大"也小于同核心的正式版。
  {
    const newerBundledApp = join(root, 'app-020')
    const bundled020 = makeRuntime(join(newerBundledApp, 'runtime'), '0.2.0')
    const fresh = loadPackaged(newerBundledApp, resourcesPath)
    const dir = join(root, 'pre-stable-bundled')
    mkdirSync(dir, { recursive: true })
    activate(dir, makeRuntime(join(dir, 'runtime', '0.2.0-rc.99'), '0.2.0-rc.99'))
    const picked = fresh.resolveRuntime(dir)
    assert.equal(picked.source, 'bundled', '0.2.0-rc.99 不能覆盖内置的 0.2.0')
    assert.equal(picked.version, '0.2.0')
    assert.equal(picked.dir, bundled020)
    // 换回原来的打包形态，后续断言（如果有）仍然按 0.2.0-rc.1 的内置版本走。
    loadPackaged(appPath, resourcesPath)
  }

  // ---------------------------------------------------------- 开发形态（说明） ----
  // 开发形态下内置 Runtime 取自仓库根的 `runtime/`，而 `import { app } from 'electron'`
  // 在纯 node 进程里会去加载 Electron 的原生模块（GUI 进程才能安全求值），因此开发形态
  // 的选择**不在这里**断言：它走的正是同一条 `resolveRuntime`，而"下载版本只在 >= 内置时
  // 优先"和"损坏一律回退内置"这两条规则已经在上面的打包形态用例里逐条覆盖。
  console.log('SKIP development-mode assertions (they need a real Electron app object)')

  rmSync(root, { recursive: true, force: true })
  console.log('PASS downloaded runtime is preferred only when its version is not older than the bundled one')
  console.log('PASS prerelease ordering decides the choice (rc.2 > rc.1, rc.10 > rc.1, 0.2.0 > rc.99)')
  console.log('PASS a broken or dangling current always falls back to the bundled runtime')
}

main()
