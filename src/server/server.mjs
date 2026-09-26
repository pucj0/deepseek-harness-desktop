/**
 * dsh-desktop server entry point.
 *
 * Runs as a plain Node process (spawned by the Electron main process with
 * ELECTRON_RUN_AS_NODE=1). Responsibilities, in order:
 *
 *   1. own the Harness home (DSH_HOME) and workspace root
 *   2. materialize the reserved "desktop" profile (dsh-base + dsh-web-app)
 *   3. run the dsh boot chain using ONLY public @deepseek-ai/dsh-app-boot APIs
 *   4. announce the Web UI URL (with launch token) to the parent over stdout
 *
 * Deliberately does NOT go through the `dsh` CLI: `lib/bin.js` refuses the
 * "desktop" profile name by design, because this application is the owner of
 * that profile. `loadProfileDirectory()` is the public entry point meant for
 * exactly this ("application-owned profiles whose package project and lifecycle
 * belong to that application").
 *
 * Contract with the parent process (src/main/dsh-server.ts):
 *   - `dsh web: <url>?token=<token>` is printed by dsh-web-app itself
 *   - `[dsh-desktop] ready` is printed by us immediately afterwards
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import {
  boot,
  healProfilesModuleFallback,
  installFailLoud,
  loadLayeredEnv,
  loadOptionalPatches,
  loadProfileDirectory,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { installClientModuleCache } from './client-module-cache.mjs'

installClientModuleCache()

const BIN_NAME = 'dsh-desktop'
const PROFILE_NAME = 'desktop'
const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'
const PROFILE_ROOT_FILENAME = 'cordis.yml'

/** The bundles the desktop profile composes. Same pair as the shipped `web` profile. */
const DESKTOP_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/**
 * 随本应用内置的客户端插件（profile bundle）。
 *
 * 放在 runtime/node_modules 下由 `scripts/stage-runtime.mjs` 就位；每个插件导出
 * `./client` 与 `dsh.bundle.patch`，因此既提供 host 半边也提供客户端半边。
 *
 * 它们必须被声明为 profile 的 bundle 才会被挂载——bundle 的 patch 层用 `insert`
 * 挂载插件。而 dsh 的模块解析要求 bundle 能从安装位置或 profile 目录解析到，所以
 * `linkBundledPlugins` 会把它们链进 profile 的 node_modules。
 */
const BUNDLED_PLUGINS = ['dsh-client-ui-gitbar', 'dsh-client-ui-review', 'dsh-client-ui-typography']

const PROFILE_ROOT_CONFIG = `# dsh-desktop profile root — an empty entry list.
#
# The tree composes as patch layers: each bundle in package.json's
# dsh.profile.bundles, then cordis.patch.yml, then the home-level patch.
# Edit cordis.patch.yml, not this file.
[]
`

const PROFILE_PATCH_TEMPLATE = `# dsh-desktop patch layer, applied after every bundle layer.
#
# A top-level YAML array of loader patch entries (id-targeted config overrides,
# disables, and insert lists; \`!!js\` expressions allowed). This file is watched
# and hot-reloaded while the app runs.
[]
`

/**
 * Parse this server's own arguments.
 * @param argv - arguments after the script path.
 * @returns the resolved options.
 */
function parseArgs(argv) {
  const options = {
    dshHome: process.env.DSH_HOME,
    installAnchor: undefined,
    workspace: process.cwd(),
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (value === undefined) break
    if (flag === '--dsh-home') options.dshHome = value
    else if (flag === '--install-anchor') options.installAnchor = value
    else if (flag === '--workspace') options.workspace = value
    else continue
    index += 1
  }
  if (options.dshHome === undefined || options.dshHome === '') {
    throw new Error(`${BIN_NAME}: --dsh-home (or DSH_HOME) is required`)
  }
  if (options.installAnchor === undefined) {
    throw new Error(`${BIN_NAME}: --install-anchor is required`)
  }
  return options
}

/**
 * 让 profile 只使用「核心 bundle + 当前实际存在的内置插件」。
 *
 * 不硬编码插件的存在：插件缺席时不会因为解析失败而整个 boot 失败，而插件一旦随包
 * 发布就自动生效，用户无需任何手工步骤。
 *
 * @param dir - profile 目录。
 * @param available - 当前可用的内置插件名。
 */
function reconcileBundles(dir, available) {
  const manifestPath = join(dir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const wanted = [...DESKTOP_BUNDLES, ...available]
  const current = manifest.dsh?.profile?.bundles

  // 只在真的不同时才写文件：profile 目录被 dsh 监听，无谓的写入会触发重载。
  if (
    Array.isArray(current) &&
    current.length === wanted.length &&
    current.every((value, index) => value === wanted[index])
  ) {
    return
  }
  manifest.dsh = {
    ...manifest.dsh,
    profile: { ...manifest.dsh?.profile, bundles: wanted, patchReload: 'live' },
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
}

/**
 * 把 runtime 里内置的插件链进 profile 的 node_modules。
 *
 * 为什么需要这一步：客户端插件要被 dsh 的模块系统发现，前提是 host 侧能从安装位置
 * 或 profile 目录 resolve 到它的 `package.json`（`resolveBundleDir` 按这两个锚点
 * 解析）。`profiles/node_modules` 只由安装闭包填充，而内置插件不在 dsh 的依赖里，
 * 因此必须由外壳自己把它链进 profile。
 *
 * 用链接而不是复制：运行时更新会替换整个 runtime/，复制出的副本会与新版本脱节。
 *
 * @param dir - profile 目录。
 * @param installAnchor - dsh 包的 package.json 绝对路径。
 * @returns 实际就位的插件名（用于写进 profile 的 bundle 列表）。
 */
function linkBundledPlugins(dir, installAnchor) {
  // runtime/node_modules —— 从 <runtime>/node_modules/@deepseek-ai/dsh/package.json 上溯三级。
  const runtimeModules = dirname(dirname(dirname(installAnchor)))
  const profileModules = join(dir, 'node_modules')
  mkdirSync(profileModules, { recursive: true })

  const ready = []
  for (const plugin of BUNDLED_PLUGINS) {
    const source = join(runtimeModules, plugin)
    if (!existsSync(join(source, 'package.json'))) continue

    const link = join(profileModules, plugin)
    try {
      if (existsSync(link)) {
        // 已指向同一目标就跳过；否则先删再建，避免旧链接指向已失效的路径。
        if (realpathSync(link) === realpathSync(source)) {
          ready.push(plugin)
          continue
        }
        rmSync(link, { recursive: true, force: true })
      }
      symlinkSync(source, link, 'junction')
      ready.push(plugin)
    } catch (error) {
      // 链接失败不该让整个应用起不来：报一条可诊断的警告后继续。
      console.error(`[dsh-desktop] 警告: 无法链接内置插件 ${plugin}: ${error.message}`)
    }
  }
  return ready
}

/**
 * Create the desktop profile on first run.
 *
 * The profile is application-owned: its package project and lifecycle belong to
 * this app, so it is never resolved through the shipped profile templates and
 * never collides with a `dsh --profile desktop` invocation (which the CLI refuses).
 * @param home - the Harness home.
 * @param installAnchor - dsh 包的 package.json 绝对路径（用于定位内置插件）。
 * @returns the absolute profile directory.
 */
function ensureProfile(home, installAnchor) {
  const dir = join(home, 'profiles', PROFILE_NAME)
  mkdirSync(dir, { recursive: true })

  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          name: 'dsh-profile-desktop',
          private: true,
          dependencies: {},
          dsh: { profile: { bundles: DESKTOP_BUNDLES, patchReload: 'live' } },
        },
        null,
        2,
      ) + '\n',
    )
  }
  const patchPath = join(dir, PROFILE_PATCH_FILENAME)
  if (!existsSync(patchPath)) writeFileSync(patchPath, PROFILE_PATCH_TEMPLATE)

  // 内置插件就位后才登记 bundle：先链接、再写列表，顺序反了会让 dsh 在启动时
  // 遇到一个解析不到的 bundle 而直接失败。
  const plugins = linkBundledPlugins(dir, installAnchor)
  reconcileBundles(dir, plugins)

  // The Loader needs a real include root to anchor `baseUrl` at the profile
  // directory; it is always rewritten because tree write-back can bake composed
  // rows into it, which would duplicate every bundle insert on the next boot.
  writeFileSync(join(dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
  return dir
}

/**
 * 把工作区登记进 Harness 的工作区注册表。
 *
 * 为什么**必须**做，而且必须用 `ctx.workspaceRegistry`：
 *
 * `--workspace` 只改变这个服务端进程的 cwd（以及交给插件的 `DSH_DESKTOP_WORKSPACE`）。
 * 那属于**进程级**状态，不是 Harness 的项目状态。官方 UI 的工作区/项目列表来自
 * `ctx.workspaceRegistry`——一份持久化记录（`<home>/storages/workspace.json`），而它只在
 * 首次启动时按会话历史引导一次（`initialized` 标记写死之后就不再引导），也不会自己发现
 * 新目录。唯一会新增记录的公开入口就是 `workspaceRegistry.create()`，官方 UI 的
 * 「添加工作区…」走的正是它。
 *
 * 不登记的后果是一个错位状态：git 插件（自己按 cwd 解析仓库）已经把新目录画出来了，
 * 官方 UI 里却没有这个工作区、也进不去——"server cwd 已变化"被误当成"Harness 已经打开
 * 了这个工作区"，这正是 1.2.0–1.5.8 的 bug。回归测试
 * `scripts/test-workspace-registration.mjs` 同时断言这两层。
 *
 * `create()` 是幂等的：同一个规范路径重复调用会原样返回已有记录，且**不动**列表顺序。
 *
 * @param ctx - boot 之后的主机上下文。
 * @param workspace - 本次启动的工作区绝对路径。
 */
async function registerWorkspace(ctx, workspace) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) {
    console.error('[dsh-desktop] 警告: 工作区注册表不可用（dsh-workspace 未挂载），本次不会登记工作区')
    return
  }
  try {
    await registry.create(workspace)
  } catch (error) {
    // 登记失败不该让应用起不来：它只是让官方 UI 少一个项目条目，agent 依然能在 cwd 里工作。
    console.error(
      `[dsh-desktop] 警告: 无法登记工作区 ${workspace}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/** How long to wait for the web server to become addressable. */
const READY_POLL_TIMEOUT_MS = 30_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Print the desktop readiness signal once the web surface is actually addressable.
 *
 * dsh-web-app prints its `dsh web: <url>` line only after the loader settles and
 * both the `webServer` and `connection` services exist, so that line is the real
 * readiness boundary. Waiting for it here means the parent never navigates a
 * BrowserWindow at a port that is not listening yet.
 * @param ctx - the settled boot context.
 * @param port - the observed listen port.
 */
async function announceWhenAddressable(ctx, port) {
  const deadline = Date.now() + READY_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (ctx.get('connection') !== undefined && ctx.get('webServer')?.port === port) {
      console.log('[dsh-desktop] ready')
      return
    }
    await sleep(50)
  }
  console.error(`[dsh-desktop] warning: web surface did not become addressable within ${READY_POLL_TIMEOUT_MS}ms`)
  console.log('[dsh-desktop] ready')
}

/**
 * 启动阶段计时。
 *
 * 加它的原因：实测从进程启动到出现 URL 行要 11 秒以上，而内置 Node 冷启动只有
 * 88ms、加载 host 半边只有 131ms——时间全在服务端启动里，但"服务端启动"是个
 * 黑盒。把各阶段打出来，优化才有依据，而不是靠猜。
 *
 * 只在 DSH_DESKTOP_TIMING=1 时输出，避免污染正常日志。
 */
const TIMING = process.env.DSH_DESKTOP_TIMING === '1'
const t0 = Date.now()
let lastMark = t0
function mark(label) {
  if (!TIMING) return
  const now = Date.now()
  console.error(`[timing] ${String(now - lastMark).padStart(6)} ms  (+${String(now - t0).padStart(6)})  ${label}`)
  lastMark = now
}

/**
 * Boot the desktop profile and never resolve while the app is alive.
 * @returns a promise that settles only if boot fails.
 */
async function main() {
  const options = parseArgs(process.argv.slice(2))
  const home = resolve(options.dshHome)
  const workspace = resolve(options.workspace)
  const installAnchor = resolve(options.installAnchor)
  mark('参数解析')

  mkdirSync(workspace, { recursive: true })
  process.chdir(workspace)

  const profileDir = ensureProfile(home, installAnchor)
  const profile = loadProfileDirectory(BIN_NAME, profileDir, installAnchor)
  mark(`profile 装载（${profile.layers.length} 个 bundle 层）`)

  // 把工作区路径交给插件，供 gitbar 的 host 半边调用 git。
  //
  // 用环境变量而不是让插件读 process.cwd()：当前目录在启动过程中会被 chdir 改变，
  // 而工作区是启动参数、应当是唯一权威。与既有的 DSH_DESKTOP_RUNTIME_VERSION 同一做法。
  process.env.DSH_DESKTOP_WORKSPACE = workspace

  // 把 home 也写回环境变量。
  //
  // `DSH_HOME` 只在命令行（`--dsh-home`）里给出时，插件读 `process.env.DSH_HOME`
  // 会拿到 undefined。而 gitbar 需要它去读 `<home>/storages/workspace.json`——那是
  // 应用侧登记的工作区列表，用来判断会话请求的目录是否合法。读不到的话，用户在应用里
  // 选过的其它项目都会被判为"未登记"而拒绝，徽章就仍显示外壳那个仓库的分支。
  process.env.DSH_HOME = home

  // Link the installation's dependency closure into $DSH_HOME/profiles/node_modules
  // and reconcile the profile-local links. This is what makes the bundled runtime
  // self-sufficient; it also means a newly swapped runtime needs no reinstall.
  await healProfilesModuleFallback({ installAnchor, profile, home })
  mark('模块回退链接')

  const patches = [
    ...profile.layers.flatMap((layer) => layer.patches),
    ...profile.patches,
    ...(loadOptionalPatches(BIN_NAME, join(home, PROFILE_PATCH_FILENAME)) ?? []),
  ]
  mark(`patch 合成（${patches.length} 条）`)

  const environment = loadLayeredEnv(BIN_NAME)
  installFailLoud(BIN_NAME, process, () => {})
  mark('环境快照')

  const ctx = await boot(BIN_NAME, join(profile.dir, PROFILE_ROOT_FILENAME), patches, (hostCtx) => {
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
    provideCmdline(hostCtx, {
      // The desktop shell owns its own window and port: never open a browser,
      // and let the OS assign a free port so several instances cannot collide.
      args: ['--no-open', '--port', '0'],
      exit: (code) => process.exit(code),
      ready: { onReady: () => () => {} },
    })
  })
  mark('boot 插件树')

  // 登记工作区**必须早于**下面那句 `[dsh-desktop] ready`：父进程一收到它就导航窗口，
  // 而界面首次拉取工作区列表若早于记录落盘，就又会看到"没有这个工作区"。
  await registerWorkspace(ctx, workspace)

  const port = ctx.get('webServer')?.port
  if (port === undefined) throw new Error(`${BIN_NAME}: web server did not start`)

  await announceWhenAddressable(ctx, port)
  mark('等待 web 可访问')

  // Keep the process alive; the mounted plugins own process lifetime.
  await new Promise(() => {})
}

main().catch((error) => {
  console.error(`[dsh-desktop] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(1)
})
