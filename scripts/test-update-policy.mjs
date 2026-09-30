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
const runtimeVersion = read('src/main/runtime-version.ts')
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

// -------------------------------------- 1b. 版本比较只有一份实现（1.7.5 的回归） ----
// 三套比较器各自为政时，"有更新"与"能安装"会得出相反结论：release 那套认出 0.2.0-rc.2，
// installer 那套只看 major.minor.patch、把 rc.1 与 rc.2 当成相等，于是拒绝安装。
assert.match(runtimeVersion, /export function parseRuntimeVersion/u, 'runtime-version.ts is the only parser')
assert.match(runtimeVersion, /export function compareRuntimeVersions/u, 'runtime-version.ts is the only comparator')
assert.match(runtimeVersion, /export function isRuntimeVersionNewer/u)
assert.match(runtimeVersion, /export function isRuntimeVersionAtLeast/u)
for (const [name, source] of [['runtime-release.ts', runtimeRelease], ['runtime-updater.ts', runtimeUpdater], ['paths.ts', paths]]) {
  assert.match(source, /from '\.\/runtime-version'/u, `${name} must import the single version module`)
}
// 旧的两套必须彻底消失。
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^[ \t]*\/\/.*$/gmu, '')
assert.doesNotMatch(stripComments(runtimeUpdater), /compareCore/u)
assert.doesNotMatch(stripComments(paths), /compareVersions/u)
assert.doesNotMatch(stripComments(runtimeRelease), /function parseVersion\b/u)
// 升级 / 相同 / 降级三态必须分开表达："相同"不是失败。
assert.match(runtimeUpdater, /compareRuntimeVersions\(version, bundled\)/u)
assert.match(runtimeUpdater, /relation < 0/u, 'a downgrade must be rejected explicitly')
assert.match(runtimeUpdater, /'already-current'/u, 'target === current is a normal status, not a failure')
assert.match(runtimeUpdater, /RuntimeInstallStatus/u)
// 报错文案里不再把内部前缀当第一句给用户看。
assert.doesNotMatch(stripComments(runtimeUpdater), /dsh-desktop:/u)
assert.match(main, /updateRuntimeFailedDetail/u, 'the failure text must lead with a user-facing sentence')

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
// ---- 布局：窗口必须一屏显示完（真实数值见 scripts/test-update-window-layout.mjs）----
// 判据不是"文档有没有滚动条"——panelCss 把 body 固定成 100% 高，溢出的其实是内部那个
// `main`（`overflow-y:auto`），右侧那条滚动条来自它。这里只做源码级守卫：
// 尺寸不能退回 520x460 那一组（实测 520x460 时 main 内容 381 > 358，必然出滚动条）。
assert.match(updateWindow, /width: 560, height: 560/u, 'the update window must keep the measured size')
assert.doesNotMatch(updateWindow, /width: 520, height: 460/u)
// 进度文本必须被截成一行：npm 的 http 日志一行可以很长，换行就会把面板顶出滚动条。
assert.match(updateWindow, /#runtime-install-progress \{[\s\S]*white-space:nowrap/u)
assert.match(updateWindow, /#runtime-install-progress \{[\s\S]*text-overflow:ellipsis/u)
assert.match(updateWindow, /#runtime-install-progress \{[\s\S]*max-height:1\.4em/u)

// ================================ 3b. 单 renderer 的顶部菜单（架构级守卫） ======
//
// 1.7.7 的回归是"顶部菜单整体消失"，根因有两层，都要在这里钉住：
//   a. 单 renderer 之后没有任何人画那一行菜单 → 必须由 preload 挂在 Harness 文档里；
//   b. **沙箱化的 preload 不能 `require` 相对路径的文件**——一旦有人把菜单实现拆成
//      `require('./caption-menu')`，整个 preload 都会加载失败，`window.dshDesktop` 与菜单
//      一起消失，而主进程收不到任何错误（Electron 只在渲染进程 console 里留一行）。
//      因此这里直接扫**编译产物**：任何 `require('./…')` 都会让这条断言变红。
const appPreload = read('src/preload/app.ts')
const appPreloadBuilt = read('dist/preload/app.js')
assert.match(appPreload, /data-dsh-desktop-menu/u, 'the caption menu host must be created by the preload')
assert.match(appPreload, /attachShadow\(\{ mode: 'open' \}\)/u, 'the menu must live in a Shadow Root')
assert.match(appPreload, /dsh-desktop:shell-menu-open/u, 'menu clicks must go through the existing IPC')
assert.match(appPreload, /dsh-desktop:shell-state/u, 'the menu must re-read labels on state pushes (locale / menu revision)')
assert.match(appPreload, /data-windows-titlebar/u, 'the preload must publish the official Windows titlebar marker')
assert.match(appPreload, /--dsh-windows-titlebar-height/u, 'the preload must publish the official titlebar height variable')
// 菜单位置**只消费**官方 CSS 契约，不允许任何"量 sidebar 宽度"的写法（这正是上一版的错误）。
assert.match(appPreload, /left: var\(--dsh-windows-menu-start, 48px\)/u, 'the menu must take its left from the official variable')
for (const forbidden of ['sidebarCol', '--dsh-caption-menu-start', '--dsh-caption-menu-height', 'getBoundingClientRect().right']) {
  assert.ok(
    !appPreload.includes(forbidden),
    `菜单位置不得依赖 sidebar 几何：源码里不应出现 ${forbidden}`,
  )
}
assert.match(appPreload, /-webkit-app-region: no-drag/u, 'the menu area must not be a drag region')
// 扫**代码**而不是注释：说明文字里正当地写着 `require('./caption-menu')` 这个反例。
const codeOnly = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^[ \t]*\/\/.*$/gmu, '')
const preloadCode = codeOnly(appPreloadBuilt)
for (const match of preloadCode.matchAll(/require\(['"](\.[^'"]*)['"]\)/gu)) {
  assert.fail(`沙箱化 preload 不能 require 相对路径：${match[0]}（会让整个 preload 加载失败）`)
}
// 菜单必须复用那份唯一的 Application Menu，而不是复制命令表。
// 接线在 index.ts：`openMenuAt(applicationMenu, index, window, point, onClosed)`——顶层下标来自
// 渲染进程（不可信输入），`openMenuAt` 自己会校验范围并取回**同一个** MenuItem 的子菜单。
assert.match(read('src/main/index.ts'), /openMenuAt\(applicationMenu, index, window, point, onClosed\)/u, 'the main process must pop the existing native submenu')
assert.match(read('src/main/window.ts'), /setMenuBarVisibility\(false\)/u, 'the native menu row stays hidden (one menu row only)')
assert.match(read('src/main/window.ts'), /before-input-event[\s\S]{0,400}input\.key !== 'Alt'/u, 'bare Alt must be swallowed so no second menu row appears')

// ---------------------------------------------- 4. 两条回退路径必须存在 ----// 启动失败 → 回退（摘掉 current）→ 重启并回到内置 Runtime。
assert.match(main, /runtimeUpdater\.rollback\(\)/u)
assert.match(main, /updateRuntimeRollbackTitle/u)
assert.match(main, /restartIntoBundledRuntime/u)
assert.match(main, /app\.relaunch\(\)/u)
// 立即重启前先停掉当前的 Harness server。
assert.match(main, /await running\.stop\(2000\)/u)
// `current` 只有"下载版本不低于内置版本"时才被选中，且比较走同一个版本模块。
assert.match(paths, /join\(userDataDir, 'runtime', 'current'\)/u)
assert.match(paths, /compareRuntimeVersions\(downloaded\.version, bundledVersion\) >= 0/u)
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
