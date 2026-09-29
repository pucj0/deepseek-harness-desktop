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
 * This file is copied into the bundled runtime directory (see
 * `resolveServerEntry()` in src/main/dsh-server.ts). Desktop GitHub Releases can
 * carry a newer official runtime, so every dsh-app-boot symbol it names must
 * exist in every supported bundled version. A named export that a newer runtime
 * dropped is not a recoverable error: the module fails to instantiate before a
 * single line runs, and the shell only sees "server exited before ready".
 * Version-sensitive API use therefore goes through a dynamic import with a
 * capability check, never a static named import (see prepareModuleResolution).
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
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

import {
  boot,
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
const BUNDLED_PLUGINS = [
  'dsh-client-ui-gitbar',
  'dsh-client-ui-review',
  'dsh-client-ui-typography',
  'dsh-client-ui-shell-bridge',
]

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

/** Match the launcher readiness contract used by newer dsh packages. */
function createAppReady() {
  let ready = false
  const listeners = new Set()
  return {
    service: {
      onReady(listener) {
        if (ready) {
          listener()
          return () => {}
        }
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    commit() {
      if (ready) return
      ready = true
      for (const listener of [...listeners]) listener()
      listeners.clear()
    },
  }
}

/**
 * Parse this server's own arguments.
 *
 * `--workspace` describes **process context** only (the child's cwd and the directory handed
 * to the plugins). Whether that directory should also be *registered* in Harness is a
 * separate, explicitly transmitted intent (`--register-workspace`), because the shell cannot
 * tell "the user asked to open this folder" from "this is what the shell remembered last time"
 * by looking at a path. Treating the two as one is what made a workspace the user had deleted
 * in Harness reappear on the next launch.
 * @param argv - arguments after the script path.
 * @returns the resolved options.
 */
function parseArgs(argv) {
  const options = {
    dshHome: process.env.DSH_HOME,
    installAnchor: undefined,
    workspace: process.cwd(),
    registerWorkspace: false,
    forgetWorkspaces: [],
    /**
     * 内置插件的**真实**目录（外壳用 `resources/plugins` 传入）。
     *
     * 为什么需要它：插件要被链进 profile 的 node_modules，而 `symlinkSync` 的目标必须是
     * 文件系统上真实存在的路径。Runtime 打在 `app.asar` 里时，`<runtime>/node_modules/…`
     * 只存在于归档内部，OS 的 symlink 看不到它（ENOENT），四个内置插件会全部消失。
     * 外壳因此显式告诉这里"插件在哪儿"；未传时退回旧行为（从运行时依赖树里找）。
     */
    bundledPluginsDir: process.env.DSH_BUNDLED_PLUGINS_DIR,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    // 布尔开关不消费下一个参数，因此必须在"取 value"之前判掉——`--register-workspace`
    // 若排在末尾，旧写法会因为 `value === undefined` 直接 break，静默丢掉后面的所有参数。
    if (flag === '--register-workspace') {
      options.registerWorkspace = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined) break
    if (flag === '--dsh-home') options.dshHome = value
    else if (flag === '--install-anchor') options.installAnchor = value
    else if (flag === '--workspace') options.workspace = value
    else if (flag === '--bundled-plugins-dir') options.bundledPluginsDir = value
    else if (flag === '--forget-workspace') options.forgetWorkspaces.push(value)
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
 * 删掉 profile 里的一个链接条目，**包括已经断开的那种**。
 *
 * 为什么不能用 `existsSync` 判断"要不要删"：它跟随重解析点，所以一个指向已消失目标的
 * junction 会返回 **false**，看起来"这个位置是空的"，于是调用方跳过删除直接去建链接，
 * 而 `symlinkSync` 覆盖不了那个残留的重解析点，抛 `EEXIST`。
 *
 * 这正是"运行时更新失败回退之后插件全部失效"的成因：回退会删掉
 * `<userData>/runtime/current`，而 profile 里四个内置插件的链接都指向
 * `runtime/current/node_modules/...`，于是全部变成悬空链接；修复逻辑随后因为
 * `existsSync === false` 而失败，且只留下一行被吞掉的警告——自愈看起来存在，实际不生效。
 *
 * 用 `lstatSync`（**不跟随**链接）判断条目是否真实存在，再用 `unlinkSync` 删链接本身：
 * 对重解析点不能递归删除，那会跟进目标目录、删掉别人的内容。
 *
 * @param link - 链接条目的绝对路径。
 */
function removeLinkEntry(link) {
  let entry
  try {
    entry = lstatSync(link)
  } catch {
    // 连 lstat 都失败（真不存在）——没什么可删的。
    return
  }
  // Node 24 on Windows can report a junction as a directory instead of a
  // symbolic link. rmdir removes an empty directory or the junction itself but
  // refuses a non-empty physical directory, so it never traverses plugin data.
  if (process.platform === 'win32' && !entry.isSymbolicLink()) {
    try {
      rmdirSync(link)
    } catch {
      // A real, non-empty directory is not owned as a link; leave it untouched.
    }
    return
  }
  // 不是链接（真目录，例如 pnpm 装出来的）就不动它。
  if (!entry.isSymbolicLink()) return
  try {
    // Windows 上删目录联接要显式 unlink；unlinkSync 对 junction 是按链接删除。
    unlinkSync(link)
  } catch {
    rmSync(link, { recursive: true, force: true })
  }
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
 * 代价是**每次启动都必须能自愈断链**——这里对"已存在"的判断一律走 `lstatSync`，
 * 不跟随链接，否则悬空链接会被误判为不存在（见 {@link removeLinkEntry}）。
 *
 * @param dir - profile 目录。
 * @param installAnchor - dsh 包的 package.json 绝对路径。
 * @param bundledPluginsDir - 内置插件的**真实**目录；undefined 时退回运行时依赖树。
 * @returns 实际就位的插件名（用于写进 profile 的 bundle 列表）。
 */
function linkBundledPlugins(dir, installAnchor, bundledPluginsDir) {
  // runtime/node_modules —— 从 <runtime>/node_modules/@deepseek-ai/dsh/package.json 上溯三级。
  const runtimeModules = dirname(dirname(dirname(installAnchor)))
  // 优先用外壳显式给出的真实目录：Runtime 打在 app.asar 里时，runtimeModules 只在归档内部
  // 存在，symlink 的目标解析不到（ENOENT）。
  const searchRoots = bundledPluginsDir === undefined || bundledPluginsDir === ''
    ? [runtimeModules]
    : [resolve(bundledPluginsDir), runtimeModules]
  const profileModules = join(dir, 'node_modules')
  mkdirSync(profileModules, { recursive: true })

  const ready = []
  for (const plugin of BUNDLED_PLUGINS) {
    const source = searchRoots.map((root) => join(root, plugin)).find((candidate) => existsSync(join(candidate, 'package.json')))
    if (source === undefined) continue

    const link = join(profileModules, plugin)
    try {
      // realpath 会在悬空链接上抛 ENOENT：那本身就是"必须重建"的信号。
      if (existsSync(link) && realpathSync(link) === realpathSync(source)) {
        ready.push(plugin)
        continue
      }
      removeLinkEntry(link)
      symlinkSync(source, link, 'junction')
      ready.push(plugin)
    } catch (error) {
      // 链接失败不该让整个应用起不来：报一条可诊断的警告后继续。
      // 带上 code（EPERM/EEXIST 的处置完全不同），并说清后果——插件会从界面上消失。
      const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      console.error(
        `[dsh-desktop] 警告: 无法链接内置插件 ${plugin}${code === '' ? '' : ` (${code})`}: ${error.message}；` +
          '该插件的界面功能将不可用',
      )
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
function ensureProfile(home, installAnchor, bundledPluginsDir) {
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
  const plugins = linkBundledPlugins(dir, installAnchor, bundledPluginsDir)
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
 * ## 什么时候**才**登记（本轮的修复）
 *
 * 只在 `--register-workspace` 出现时调用。`--workspace A` 本身表达的是"本次进程的
 * workspace context"，**不是**"请把这个目录登记进注册表"——这两件事必须分开，否则用户
 * 在 Harness UI 里删掉的工作区会在下一次 Desktop 启动时被无声地创建回来（`create()` 对
 * 不存在的登记就是新增）。决定由外壳的 `reconcileWorkspaceState()` 做出，规则是：
 * 显式意图（打开文件夹 / 最近打开 / 命令行参数）才登记。
 *
 * `create()` 本身是幂等的：同一个规范路径重复调用会原样返回已有记录，且**不动**列表顺序。
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

/** 一个工作区记录是不是"文件系统工作区"（有可用的绝对路径）。 */
function isFilesystemWorkspace(workspace) {
  return typeof workspace?.path === 'string' && workspace.path !== ''
}

/**
 * 对账 Harness 工作区注册表：清掉失效登记 + 执行外壳要求的移除。
 *
 * ## 为什么用官方 API，而不是直接改 `workspace.json`
 *
 * `ctx.workspaceRegistry` 是唯一有资格写这份文件的东西：它自己维护
 * `global.workspaceIds` 的持久顺序、`initialized` 引导标记、以及"表已写、序未写"
 * 这类中间态的恢复逻辑（`recoverPendingMutation` / `validateStoredState`）。外壳直接
 * `JSON.parse` → `splice` → `writeFile` 会绕过全部这些不变量，也会与正在运行的服务端
 * 抢同一份文件。删除的公开入口是 `registry.delete(id)`——保留目录、保留会话日志，
 * 只去掉登记，正是我们需要的语义。
 *
 * ## 两类清理
 *
 *  1. **失效目录**：`status()` 是官方提供的"这个目录现在还在吗"实时检查（不缓存，
 *     且**不会**因为目录暂时不在就改写记录）。返回 `'missing-dir'` 说明用户把目录删了，
 *     这条记录留在注册表里只会让一个不存在的工作区一直出现在项目列表里。
 *  2. **显式移除**：外壳的「移除工作区…」写下的意图。它走的是同一个 API、同一条启动
 *     路径，因此不存在"外壳以为删了、服务端还留着"的中间态。
 *
 * ## 只碰文件系统工作区
 *
 * 没有可用 `path` 的记录（将来的远端 / 虚拟工作区，或结构变化后的新形态）**不参与**
 * 任何自动清理——"字段不像本地目录就删掉"是最危险的猜法。
 *
 * 顺序很重要：清理**必须早于**本次的登记。否则「移除 A 并切换到 B」会先 create(B)
 * 再删掉 A 的记录，中间那一瞬表里同时有两条；更要紧的是，删除失败时我们宁愿什么都没登记，
 * 也不愿留下一条用户明确要求移除的记录。
 *
 * @param ctx - boot 之后的主机上下文。
 * @param forgetPaths - 外壳要求的移除清单（任意写法）。
 * @returns 实际被移除的路径数组（诊断与测试断言用）。
 */
async function reconcileWorkspaceRegistry(ctx, forgetPaths) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) {
    console.error('[dsh-desktop] 警告: 工作区注册表不可用（dsh-workspace 未挂载），本次不会清理或登记工作区')
    return []
  }
  const removed = []
  let listed
  try {
    listed = registry.list()
  } catch (error) {
    console.error(`[dsh-desktop] 警告: 无法列出工作区注册表: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
  // 用 realpath 比较：命令行/设置里的写法未必与注册表里那份规范路径逐字相同。
  const normalize = (value) => {
    try {
      return realpathSync.native(value)
    } catch {
      return resolve(value)
    }
  }
  const wanted = new Set(forgetPaths.filter((entry) => typeof entry === 'string' && entry !== '').map(normalize))

  for (const workspace of listed) {
    if (!isFilesystemWorkspace(workspace)) continue
    const explicit = wanted.has(normalize(workspace.path))
    let missing = false
    if (!explicit && typeof workspace.status === 'function') {
      try {
        missing = (await workspace.status()) === 'missing-dir'
      } catch (error) {
        // 状态查询失败（权限等）不等于"目录不存在"，因此什么都不做。
        console.error(
          `[dsh-desktop] 警告: 无法检查工作区 ${workspace.path} 是否仍然存在: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    if (!explicit && !missing) continue
    try {
      const deleted = await registry.delete(workspace.id)
      if (deleted === true) {
        removed.push(workspace.path)
        console.log(
          `[dsh-desktop] ${explicit ? 'removed' : 'pruned'} workspace ${workspace.path}`,
        )
      }
    } catch (error) {
      console.error(
        `[dsh-desktop] 警告: 无法移除工作区 ${workspace.path}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return removed
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
 * 让 profile 的 `@deepseek-ai/*`（以及 bundle 自带的插件依赖）可解析。
 *
 * dsh-app-boot 在 0.1.7 换了实现，**旧名字被删掉**了，而本文件会被外壳复制进
 * **任意版本**的运行时目录里运行（`resolveServerEntry()` 每次启动都同步覆盖），
 * 所以这里不能静态 import 任一版本的符号：一个解析不到的具名导出会让整个模块
 * 加载失败，进程连一行日志都来不及打就退出（父进程只看到
 * "server exited before ready"）。
 *
 * 因此按能力选择，而不是按版本号：
 *
 *   1. `createRuntimeResolution` + `PluginPackages`（0.1.7 起）
 *      解析结果不再落盘，而是由 `PluginPackages` 服务在进程内接管 ESM/CJS 解析
 *      （并覆盖此后的 Worker）。必须在 `boot()` 的 `prepare` 里、**配置树挂载之前**
 *      注册，否则 Loader 解析第一个 bundle 时拦截层还没装好。
 *   2. `healProfilesModuleFallback`（0.1.5 及更早）
 *      老实现靠写链接：`$DSH_HOME/profiles/node_modules` 镜像安装闭包，profile 自带
 *      的插件再链进 profile 的 `node_modules`。
 *   3. 两个都没有：不猜、不动文件系统，让 dsh 自己的解析错误报出来——那比这里静默
 *      改错目录清楚得多。
 *
 * @param profile - 已装载的 desktop profile。
 * @param installAnchor - 运行中的 dsh 安装的 package.json 绝对路径。
 * @param home - Harness 主目录。
 * @returns boot() 的 prepare 回调；没有可用的解析 API 时返回 undefined。
 */
async function prepareModuleResolution(profile, installAnchor, home) {
  // 动态 import：只有真正支持的版本才会真的加载这份实现，且解析失败在这里被降级，
  // 不会升级成模块级语法错误。
  let appBoot
  try {
    appBoot = await import('@deepseek-ai/dsh-app-boot')
  } catch (error) {
    console.error(
      `[dsh-desktop] 警告: 无法加载 @deepseek-ai/dsh-app-boot，将不做模块解析准备: ${error instanceof Error ? error.message : String(error)}`,
    )
    return undefined
  }

  if (typeof appBoot.createRuntimeResolution === 'function' && appBoot.PluginPackages !== undefined) {
    const { PluginPackages, createRuntimeResolution } = appBoot
    const resolution = await createRuntimeResolution({ installAnchor, profile, home })
    console.log(
      `[dsh-desktop] 模块解析: 进程内拦截（${resolution.entries.length} 个包，` +
        `${resolution.linkedRoots.length} 个外部链接根）`,
    )
    return async (hostCtx) => {
      await hostCtx.plugin(PluginPackages, { resolution })
    }
  }

  if (typeof appBoot.healProfilesModuleFallback === 'function') {
    await appBoot.healProfilesModuleFallback({ installAnchor, profile, home })
    console.log('[dsh-desktop] 模块解析: profile 回退链接')
    return undefined
  }

  console.error(
    '[dsh-desktop] 警告: 这个 dsh 运行时既不提供 createRuntimeResolution 也不提供 ' +
      'healProfilesModuleFallback，跳过模块解析准备',
  )
  return undefined
}

/**
 * 交给组合层的「启动器自有 profile 事实」——即 `@deepseek-ai/dsh` 的 `runProfile()`
 * 在挂载配置树之前 provide 的那个 `profileContext`。
 *
 * ## 为什么 Desktop 必须自己 provide 它（本轮修复的根因）
 *
 * 0.1.7 起 `@deepseek-ai/dsh-base` 用这个服务给整组行做门控：
 *
 *     - id: config-editor
 *       name: '@deepseek-ai/dsh-config-editor'
 *       disabled: !!js "!ctx.get('profileContext')"
 *     - id: settings
 *       name: '@deepseek-ai/dsh-settings'
 *       disabled: !!js "!ctx.get('profileContext')"
 *
 * 而 `config-editor`（inject `loader` + `profileContext`）与 `dsh-settings` 的
 * `settings` 服务（inject `configEditor` + `profileContext`）本来也把
 * `profileContext` 声明成依赖。少 provide 这一个服务，两行都进不了 ACTIVE：
 * `ctx.settings` 根本不存在，`settings-controller` 的每个方法都返回
 * "settings service is absent: mount @deepseek-ai/dsh-settings with
 * @deepseek-ai/dsh-config-editor in the profile composition"——界面表现为
 * 设置→模型整页报错、通用设置→权限「不可用」。同一条门控还静默关掉了
 * `plugin-manager`、`hmr`，以及 web-app 里 `profileContext?.name === 'desktop'`
 * 的桌面专属行（右侧栏的 Browser 标签）。
 *
 * 最阴的地方是它**不报错**：`disabled` 行会被 Loader 直接跳过，
 * `auditStartupEntries` 也明确跳过 disabled 行，所以日志里一条警告都没有。
 *
 * 这些事实只有启动方知道，harness 不会替外壳补：`runProfile()` 会 provide（所以
 * CLI 与官方 profile 启动正常），而本文件走的是
 * `loadProfileDirectory()` + `boot()` 这条「应用自有 profile」的路径
 * （`dsh` 的 CLI 按设计拒绝 `desktop` 这个 profile 名），必须自己补上。
 *
 * ## 时序要求
 *
 * 必须在**配置树挂载之前**（也就是 `boot()` 的 `prepare` 回调里）provide：
 * `!!js` 门控是在行挂载时求值的，晚一步那两行就已经被判成 disabled 了。
 *
 * ## 字段
 *
 * 与 `runProfile()` 保持一致，因为消费者直接读它们：
 * `dir` / `installAnchor` / `patchPath` 是 `config-editor` 装载并回写 profile
 * patch 的落点（`readProfilePatches` 与 `loadProfileDirectory` 都按它们解析），
 * `home` 是 `dsh-settings` 做旧文档迁移（`<home>/settings.yaml`）与 `hmr` 盯
 * home 级 patch 的落点，`name === 'desktop'` 是桌面专属行（如右侧栏 Browser）的开关。
 *
 * 多 provide 一个服务对老运行时（0.1.5/0.1.6）是无害的：那时没有任何行读它，
 * 设置由未门控的 `@deepseek-ai/dsh-settings-file` 提供。因此这里不需要按版本做能力判断。
 *
 * @param profile - 已装载的 desktop profile。
 * @param installAnchor - 运行中的 dsh 安装的 package.json 绝对路径。
 * @param home - Harness 主目录（DSH_HOME）。
 * @returns 组合层读取的 profile 事实。
 */
function createProfileContext(profile, installAnchor, home) {
  return {
    name: PROFILE_NAME,
    dir: profile.dir,
    patchPath: profile.patchPath,
    installAnchor,
    startedBundles: profile.layers.map((layer) => layer.packageName),
    cwd: process.cwd(),
    home,
    overlays: [],
    telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
  }
}

/** cordis 的 FiberState，仅用于诊断文案。 */
const FIBER_STATE_LABELS = { 0: '等待服务', 1: '加载中', 2: '已激活', 3: '激活失败', 4: '已卸载' }

/** 组合里承载「设置」能力的行；任何一行没起来，设置页就没有数据源。 */
const SETTINGS_ROWS = [
  { id: 'config-editor', package: '@deepseek-ai/dsh-config-editor' },
  { id: 'settings', package: '@deepseek-ai/dsh-settings' },
  { id: 'settings-controller', package: '@deepseek-ai/dsh-api-settings-controller' },
]

/**
 * 一个包实际从哪里加载：`<包目录>（v<版本>）`，解析不出来就返回空串。
 *
 * 这是「当前实际加载的 dsh-settings 到底来自哪里」的答案——内置运行时，还是
 * `$DSH_HOME/profiles/desktop/node_modules`（最近路径优先会覆盖运行时的那份）。
 *
 * 优先问 0.1.7 的 `pluginPackages` 服务（它知道进程内拦截后的真实落点）；老运行时
 * 没有这个服务，就退回 Node 自己的查找顺序探测同一件事。
 *
 * @param ctx - boot 之后的主机上下文。
 * @param name - 行里声明的包名（可能带子路径）。
 * @returns 供日志拼接的后缀。
 */
function packageOrigin(ctx, name) {
  const located = locatePackage(ctx, name)
  if (located === undefined) return ''
  return ` <- ${located.dir}${located.version === undefined ? '' : `（v${located.version}）`}`
}

/**
 * 定位一个包名对应的目录与版本。
 *
 * @param ctx - boot 之后的主机上下文。
 * @param name - 包名，可能带子路径（只取包名部分）。
 * @returns `{ dir, version }`，定位不到时 undefined。
 */
function locatePackage(ctx, name) {
  try {
    const pkg = ctx.get('pluginPackages')?.packageOf?.(name, ctx.baseUrl)
    const dir = pkg?.dir ?? (typeof pkg?.manifestPath === 'string' ? dirname(pkg.manifestPath) : undefined)
    if (dir !== undefined) return { dir, version: pkg.version }
  } catch {
    // 落回下面的 Node 查找（拦截层不在也不该让诊断消失）。
  }
  try {
    const parts = String(name).split('/')
    const bare = String(name).startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
    const fromProfile = createRequire(new URL('package.json', ctx.baseUrl))
    for (const searchPath of fromProfile.resolve.paths(bare) ?? []) {
      const dir = join(searchPath, bare)
      const manifestPath = join(dir, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      return { dir, version: typeof manifest.version === 'string' ? manifest.version : undefined }
    }
  } catch {
    // 定位失败只是少一段诊断，不该影响启动。
  }
  return undefined
}

/**
 * 一行在 Loader 里的实际状态，用中文写清「为什么没起来」。
 *
 * 与 `dsh-app-boot` 的 `inactiveEntries()` 同一套判据：`disabled` 由表达式求值、
 * 失败的行要 `await fiber.await()` 才能拿到原始 rejection（cordis 的 `_error` 是私有的）。
 *
 * @param entry - Loader 里的一行。
 * @returns 状态文案。
 */
async function rowState(entry) {
  let disabled = false
  try {
    disabled = entry.disabled === true
  } catch (error) {
    return `disabled 表达式抛错: ${error instanceof Error ? error.message : String(error)}`
  }
  if (disabled) return '被 disabled 门控跳过（组合里没有它的依赖服务）'
  const fiber = entry.fiber
  if (fiber === undefined) return '未挂载（模块导入失败，或行根本不在组合里）'
  if (fiber.state === 3) {
    try {
      await fiber.await()
    } catch (error) {
      return `激活失败: ${error instanceof Error ? error.stack ?? error.message : String(error)}`
    }
    return '激活失败（原因未记录）'
  }
  if (fiber.state === 0) {
    const missing = Object.keys(fiber.inject ?? {}).filter((service) => fiber.ctx.get(service) === undefined)
    return `等待服务: ${missing.join(', ') || '(未记录)'}`
  }
  return FIBER_STATE_LABELS[fiber.state] ?? `未知状态 ${String(fiber.state)}`
}

/**
 * 把「设置能力有没有起来、起来的是谁、包在哪」提前打到 Host 日志里。
 *
 * 加它的原因见 {@link createProfileContext}：门控缺失在界面上只剩一句靠后的英文
 * 错误（`settings service is absent: ...`），而 Host 侧一声不吭。这里正常路径只有
 * 两行（`profileContext` 与 `ctx.settings` 的状态与来源），**只有 `ctx.settings`
 * 真的缺席时**才展开逐行明细——不引入 debug spam。
 *
 * @param ctx - boot 之后的主机上下文。
 */
async function reportSettingsSurface(ctx) {
  const profile = ctx.get('profileContext')
  console.log(
    profile === undefined
      ? `${BIN_NAME}: 组合上下文: profileContext 未 provide —— 依赖它的行（config-editor/settings/hmr/桌面专属行）会被静默禁用`
      : `${BIN_NAME}: 组合上下文: profileContext 已 provide（name=${String(profile.name)}）`,
  )

  const rows = new Map()
  for (const entry of ctx.get('loader')?.entries() ?? []) {
    const id = entry.options?.id
    if (!SETTINGS_ROWS.some((row) => row.id === id)) continue
    rows.set(id, {
      name: entry.options?.name ?? '(未命名)',
      state: await rowState(entry),
      origin: packageOrigin(ctx, entry.options?.name),
    })
  }

  const settings = rows.get('settings')
  if (ctx.get('settings') !== undefined) {
    console.log(`${BIN_NAME}: 设置服务: ctx.settings 已挂载${settings?.origin ?? ''}`)
    return
  }

  console.log(
    `${BIN_NAME}: 设置服务缺失: ctx.settings 未挂载，设置页无法读取或写入配置。承载它的组合行：`,
  )
  for (const row of SETTINGS_ROWS) {
    const found = rows.get(row.id)
    console.log(
      found === undefined
        ? `${BIN_NAME}:   ${row.id}: 不在本次组合里${packageOrigin(ctx, row.package)}`
        : `${BIN_NAME}:   ${row.id} (${found.name}): ${found.state}${found.origin}`,
    )
  }
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

  const profileDir = ensureProfile(home, installAnchor, options.bundledPluginsDir)
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

  // Make the installation's dependency closure resolvable for this profile. Which
  // mechanism applies depends on the dsh version being booted (see
  // prepareModuleResolution); both replace the "a newly swapped runtime needs no
  // reinstall" behavior the old unconditional `healProfilesModuleFallback` call gave.
  const prepare = await prepareModuleResolution(profile, installAnchor, home)
  mark('模块解析准备')

  const patches = [
    ...profile.layers.flatMap((layer) => layer.patches),
    ...profile.patches,
    ...(loadOptionalPatches(BIN_NAME, join(home, PROFILE_PATCH_FILENAME)) ?? []),
  ]
  mark(`patch 合成（${patches.length} 条）`)

  const environment = loadLayeredEnv(BIN_NAME)
  installFailLoud(BIN_NAME, process, () => {})
  mark('环境快照')

  const appReady = createAppReady()
  // 组合层读取的启动器自有事实：必须在 `boot()` 的 prepare 里、**配置树挂载之前**
  // provide，否则 dsh-base 里 `disabled: !!js "!ctx.get('profileContext')"` 的
  // config-editor / settings 两行会被判成 disabled，ctx.settings 就不存在。
  // 详见 {@link createProfileContext}。
  const profileContext = createProfileContext(profile, installAnchor, home)
  const ctx = await boot(BIN_NAME, join(profile.dir, PROFILE_ROOT_FILENAME), patches, async (hostCtx) => {
    // 必须早于配置树里的任何 bundle：0.1.7 的包解析由这个服务在进程内接管，
    // 它没装好时 Loader 解析第一个 bundle 就会失败。
    await prepare?.(hostCtx)
    hostCtx.provide('profileContext', profileContext)
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
    provideCmdline(hostCtx, {
      // The desktop shell owns its own window and port: never open a browser,
      // and let the OS assign a free port so several instances cannot collide.
      args: ['--no-open', '--port', '0'],
      exit: (code) => process.exit(code),
      ready: appReady.service,
    })
  })
  appReady.commit()
  mark('boot 插件树')

  // 设置能力的状态与来源（正常路径两行；缺席时才展开明细）。放在 ready 之前：
  // 它要能解释"设置页为什么报错"，就必须和那句错误同时到达日志。
  await reportSettingsSurface(ctx)
  mark('设置能力自检')

  // 顺序：**先清理，后登记**。清理用官方 API（见 reconcileWorkspaceRegistry 的说明），
  // 而且必须早于下面那句 `[dsh-desktop] ready`：父进程一收到它就导航窗口，界面首次拉取
  // 工作区列表若早于记录落盘，就又会出现"没有这个工作区"（或反过来，看到一个已经删掉的）。
  await reconcileWorkspaceRegistry(ctx, options.forgetWorkspaces)

  // 登记**只在明确意图下**发生。`--workspace A` 本身只说明本次进程的 cwd 是 A：
  //   * 「打开文件夹 / 最近打开 / 命令行参数」→ 外壳带上 --register-workspace；
  //   * 「上次记住的值」或兜底值 → 不带。
  // 旧代码无条件 `create(A)`，于是用户在 Harness 里删掉的 A 会在下次启动时被创建回来。
  if (options.registerWorkspace) {
    await registerWorkspace(ctx, workspace)
  } else {
    console.log('[dsh-desktop] workspace registration not requested; using the existing registry')
  }

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
