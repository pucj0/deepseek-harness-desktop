// 更新策略的契约测试：**谁有权授权一个版本**、以及哪些东西绝不允许出现。
//
//   node scripts/test-update-policy.mjs
//
// 它读的是源码与打包配置本身（而不是运行起来的行为），因为要钉住的正是"架构决定"：
//
//   1. Runtime 的授权只有一个来源——官方 `deepseek-ai/deepseek-harness` 的已发布
//      `dsh-v*` GitHub Release。**绝不允许**把 GitHub source archive 当成可运行的
//      Runtime（那些 tag 没有构建好的依赖树，README 里也从来不承诺预构建资产）。
//   2. 应用内安装用的是**随包携带的** npm（`ELECTRON_RUN_AS_NODE=1`），用户机器上不需要
//      node/npm；因此产物里必须有解包后的 npm CLI，而 portable Node 仍然禁止。
//   3. 两条轨道互斥：Runtime 安装与 Desktop 安装包下载不能同时跑。
//   4. 安装失败/启动失败的两条回退路径必须存在（不切换 current；失败自动摘掉 current）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const main = read('src/main/index.ts')
const paths = read('src/main/paths.ts')
const runtimeRelease = read('src/main/runtime-release.ts')
const runtimeUpdater = read('src/main/runtime-updater.ts')
const updateWindow = read('src/main/update-window.ts')
const builder = read('electron-builder.yml')
const workflow = read('.github/workflows/release.yml')
const manifest = JSON.parse(read('package.json'))

// ------------------------------------------------------- 1. 版本授权来源 ----
assert.match(runtimeRelease, /api\.github\.com\/repos\/deepseek-ai\/deepseek-harness\/releases/u)
assert.match(runtimeRelease, /published_at/u, 'the release check must expose published_at')
assert.match(runtimeRelease, /publishedAt/u)
// source archive 绝不能被当作 Runtime：不下载 zip/tarball，也不解压它们。
// 断言的是**代码里的字面量**（真实下载/解压一定会出现其中之一），而不是注释——源码注释
// 里正当地写着"source archive 从来不是可行路径"，那正是这条策略本身的说明。
assert.doesNotMatch(runtimeUpdater, /['"`](?:zipball|tarball|codeload)|extract-zip|unzipSync|tar\.extract/u)
assert.doesNotMatch(runtimeRelease, /['"`](?:zipball|tarball|codeload)|assets_url|browser_download_url/u)
// 安装的目标版本必须由 Release 检查结果授权（而不是调用方随便给一个字符串）。
assert.match(runtimeUpdater, /未获官方 GitHub Release 授权/u)
assert.match(runtimeUpdater, /release\.latest !== version/u)
// 依赖闭包截止时间 = Release 的 published_at + 24h。
assert.match(runtimeUpdater, /SAME_WAVE_WINDOW_MS = 24 \* 60 \* 60 \* 1000/u)
assert.match(runtimeUpdater, /closureBefore/u)
assert.match(main, /publishedAt/u, 'the window must pass the release publishedAt into the installer')

// --------------------------------------------------- 2. 内置 npm，不装 Node ----
assert.equal(manifest.dependencies?.npm, '11.20.0', 'npm must be a pinned (exact) production dependency')
// npm 必须是**精确**版本：它决定了应用内安装 Runtime 时用的 npm 行为，范围版本会让
// 不同时间装出来的应用行为不一致。（其余生产依赖不在本测试的管辖范围。）
assert.match(manifest.dependencies.npm, /^\d+\.\d+\.\d+$/u)
assert.match(runtimeUpdater, /ELECTRON_RUN_AS_NODE/u, 'npm must run through Electron-as-Node')
assert.match(runtimeUpdater, /locateBundledNpm/u)
assert.match(runtimeUpdater, /app\.asar\.unpacked/u, 'the packaged npm CLI lives in the unpacked tree')
assert.match(builder, /asarUnpack:[\s\S]*node_modules\/npm\/\*\*/u, 'asarUnpack must unpack npm')
// npm 必须留在 files 里：`!node_modules/npm/**` 会让 electron-builder 在**过滤阶段**就把
// 它整个删掉（asarUnpack 也救不回来），产物里因此没有 npm CLI——这正是实测踩到的坑。
assert.doesNotMatch(builder, /^\s*- '!node_modules\/npm\/\*\*'/mu, 'a files-level exclusion would delete npm from the package entirely')
// 第二份 portable Node 仍然禁止：Electron 自带 Node 24。
assert.doesNotMatch(builder, /stage-node/u)
assert.match(builder, /runtime\/\*\*\/\*\.node/u)

// --------------------------------------------- 3. 不相邻的两条轨道必须互斥 ----
assert.match(main, /if \(runtimeUpdater\.installing\) return/u, 'Desktop download must be blocked while the runtime installs')
assert.match(updateWindow, /runtimeInstalling/u)
assert.match(updateWindow, /canInstallRuntime/u)
assert.match(updateWindow, /runtimeProgress/u)
assert.match(updateWindow, /data-action="\$\{action\}"/u)
assert.match(updateWindow, /id="btn-\$\{action\}"/u)
assert.match(updateWindow, /id="\$\{action\}-progress"/u)
assert.match(updateWindow, /runtime-install-progress/u)
// 有直装能力时隐藏 Release 后备入口。
assert.match(updateWindow, /releaseButton\.hidden = !payload\.runtime\.releaseUrl \|\| canInstallRuntime \|\| runtimeInstalling/u)
// 直装按钮在同一轨道内，不能只放在页脚（否则用户看不出它属于哪条轨道）。
assert.match(updateWindow, /track\('runtime', strings\.sectionRuntime, 'runtime-install'\)/u)

// ---------------------------------------------- 4. 两条回退路径必须存在 ----
// 启动失败 → 回退（摘掉 current）→ 重启并回到内置 Runtime。
assert.match(main, /runtimeUpdater\.rollback\(\)/u)
assert.match(main, /updateRuntimeRollbackTitle/u)
assert.match(main, /restartIntoBundledRuntime/u)
assert.match(main, /app\.relaunch\(\)/u)
// 立即重启前先停掉当前的 Harness server。
assert.match(main, /await running\.stop\(2000\)/u)
// `current` 只有"下载版本不低于内置版本"时才被选中。
assert.match(paths, /join\(userDataDir, 'runtime', 'current'\)/u)
assert.match(paths, /compareVersions\(downloaded\.version, bundledVersion\) >= 0/u)
assert.doesNotMatch(paths, /Legacy npm-updated runtimes|legacy location/iu)

// ------------------------------------------------ 5. 其余更新轨道仍然成立 ----
assert.match(main, /new ShellUpdater\(app\.getVersion\(\)/u)
assert.match(main, /checkRuntimeRelease\(runtimeVersion\)/u)
assert.match(runtimeUpdater, /registry\.npmmirror\.com/u, 'the first registry is the mirror')
assert.match(runtimeUpdater, /registry\.npmjs\.org/u, 'the fallback registry is the official one')
assert.match(builder, /publish:\s*[\s\S]*provider: github[\s\S]*owner: pucj0[\s\S]*repo: deepseek-harness-desktop/u)
for (const name of ['latest.yml', 'latest-mac.yml', 'latest-linux.yml']) assert.ok(workflow.includes(name), `${name} must be published`)
// Size Gate 不再把"生产 npm"当禁止项，但仍必须有这个门禁步骤。
assert.match(workflow, /report-package-size\.mjs --limit-mib 136/u)
assert.doesNotMatch(workflow, /生产 npm CLI、/u)

console.log('PASS the official GitHub Release is the only authority for an installable runtime')
console.log('PASS the app ships a pinned npm and never falls back to a system npm or a source archive')
console.log('PASS runtime install and Desktop download are mutually exclusive, with both fallback paths wired')
console.log('PASS a downloaded runtime is used only when it is not older than the bundled one')
console.log('PASS builder provider and release metadata are present')
