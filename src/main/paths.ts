/**
 * Which dsh runtime this process runs on, in dev and in a packaged app.
 *
 * Packaged: the runtime ships **inside `app.asar`** (`<app>/runtime`), because that is
 *           the only copy the installer needs — the JS/JSON assets are compressed by
 *           NSIS once, instead of being delivered a second time as a brotli archive
 *           that then has to be unpacked into userData on first launch.
 * Dev:      the same `runtime/` directory in the repo root.
 * Updated:  an in-app runtime update installs into `<userData>/runtime/<version>` and
 *           points `<userData>/runtime/current` at it (see runtime-updater.ts). That
 *           copy is used **only** when its real version is at least the bundled one —
 *           a Desktop release that ships a newer runtime must never be shadowed by an
 *           older download.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import { compareRuntimeVersions, parseRuntimeVersion } from './runtime-version'

/** 一次 Runtime 解析的**来源**。 */
export type RuntimeSource = 'bundled' | 'downloaded'

export interface RuntimeLocation {
  /** Directory that contains runtime/package.json (the install anchor root). */
  dir: string
  /** Absolute path of the dsh app package's package.json — the bundle resolution anchor. */
  installAnchor: string
  /** Absolute path of the canonical boot script, read from wherever the app ships it. */
  serverEntry: string
  /**
   * Absolute path the boot script must actually run from: `<runtime>/server.mjs`.
   *
   * The shell ships the script at `resources/server/server.mjs`, but Node resolves
   * bare specifiers from the *script's own directory* upward, so running it there
   * fails on any install path without a reachable ancestor `node_modules` — for
   * example `D:\Program Files\…`, where the lookup reaches the drive root and dies
   * with ERR_MODULE_NOT_FOUND. `DshServer` copies the canonical script here before
   * spawning, which also covers a runtime swapped in by the updater.
   */
  serverRunEntry: string
  /**
   * Node executable for the server child.
   *
   * `undefined` means "re-execute Electron as Node" (`ELECTRON_RUN_AS_NODE=1`), which is
   * the normal case now: Electron ≥ 44 bundles Node 24, which satisfies the runtime's
   * `^22.19.0 || >=24` requirement, so the release no longer ships a second portable
   * Node. A value is only returned when a portable Node happens to be staged next to
   * the runtime (development convenience — see `npm run stage:node`).
   */
  nodeBinary: string | undefined
  /** Version of the bundled Node, when one is present. */
  nodeVersion?: string
  /** Version recorded by scripts/stage-runtime.mjs (or the updater's runtime.json). */
  stagedVersion?: string
  /** 真实读到的 dsh 版本（来自 package.json，不是我们自己记的账）。 */
  version?: string
  /** 这份 Runtime 是随包内置的，还是应用内更新下载下来的。 */
  source: RuntimeSource
  /** 内置 Runtime 的版本（启动失败回退时用它做提示；下载形态下是另一个目录的版本）。 */
  bundledVersion?: string
  /** True when running from a packaged installer rather than the repo. */
  packaged: boolean
}

/** 读 `node_modules/@deepseek-ai/dsh/package.json` 的真实版本号。 */
function readDshVersion(dir: string): string | undefined {
  try {
    const manifest = JSON.parse(
      readFileSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'),
    ) as { version?: unknown }
    // 用版本模块的解析器校验：它同时保证"是个合法 semver"，因此后面的比较不会退回字符串序。
    return parseRuntimeVersion(manifest.version) === undefined ? undefined : (manifest.version as string)
  } catch {
    return undefined
  }
}

/** 组装一个候选目录的 RuntimeLocation。 */
function locationFor(dir: string, packaged: boolean, source: RuntimeSource): RuntimeLocation {
  const anchor = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const nodeBinary = resolveNodeBinary(dir)
  const version = readDshVersion(dir)
  return {
    dir,
    installAnchor: anchor,
    serverEntry: packaged
      ? join(process.resourcesPath, 'server', 'server.mjs')
      : resolve(__dirname, '..', '..', 'src', 'server', 'server.mjs'),
    serverRunEntry: join(dir, 'server.mjs'),
    nodeBinary,
    ...(nodeBinary !== undefined ? { nodeVersion: readNodeVersion(dir) } : {}),
    stagedVersion: readStagedVersion(dir),
    ...(version === undefined ? {} : { version }),
    source,
    packaged,
  }
}

/**
 * Resolve the runtime this process should run on.
 *
 * 选择规则（三条，缺一不可）：
 *   1. **内置优先**——`app.asar` 里的 `runtime/` 是本 Release 携带的那份，只有它一定与
 *      本 Release 的插件、启动脚本配套；
 *   2. **下载的只有在"版本不低于内置"时才优先**——应用内更新装出来的
 *      `<userData>/runtime/current` 只有在比内置版本新（或相同）时才被选中。旧 Desktop
 *      的内置 Runtime 因此永远不会被一个更旧的下载版本压住；
 *   3. **无效/损坏一律忽略**——`current` 是断链、目录里没有 `@deepseek-ai/dsh`、版本号
 *      读不出来，都退回内置，而不是让应用起不来。
 *
 * 用户的 session、workspace、设置与登录数据都在别处（`<userData>/home`、Harness 自己的
 * 存储），这里不动它们任何一个字节。
 *
 * @param userDataDir - 应用数据目录：应用内更新的版本目录与 `current` 都在它下面。
 * @param unpackedDir - 旧版 `runtime.br` 解包出来的目录。只在读取**旧版本遗留**的安装时
 *   才会传入；新版不再解包，因此正常情况下是 undefined。
 * @returns the resolved runtime location.
 */
export function resolveRuntime(userDataDir: string, unpackedDir?: string): RuntimeLocation {
  const packaged = app.isPackaged
  const bundledCandidates: string[] = []

  if (packaged) {
    // 顺序是有意的：先看本版真正携带的那份（app.asar 里的 `runtime/`），再兼容两种历史
    // 形态——旧包的散文件 `resources/runtime`、以及更旧的 `runtime.br` 解包目录。
    if (unpackedDir !== undefined) bundledCandidates.push(unpackedDir)
    bundledCandidates.push(join(app.getAppPath(), 'runtime'))
    bundledCandidates.push(join(process.resourcesPath, 'runtime'))
  } else {
    bundledCandidates.push(resolve(__dirname, '..', '..', 'runtime'))
  }

  const bundledDir = bundledCandidates.find((dir) =>
    existsSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')),
  )
  const bundled = bundledDir === undefined ? undefined : locationFor(bundledDir, packaged, 'bundled')

  // 应用内更新装出来的那份。`current` 是 junction/symlink；不存在的目录直接跳过，
  // 因此"从没更新过"与"更新被回退掉"走的是同一条路（用内置）。
  const currentDir = join(userDataDir, 'runtime', 'current')
  const downloaded =
    existsSync(join(currentDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
      ? locationFor(currentDir, packaged, 'downloaded')
      : undefined

  if (downloaded !== undefined && downloaded.version !== undefined) {
    // 没有内置版本可以比较（旧包形态）：下载的就是唯一可用的一份。
    const bundledVersion = bundled?.version
    /**
     * 选择规则（唯一阈值，语义与 installer 完全一致）：
     *   `downloaded > bundled`  → 用 downloaded（用户装过更新的版本）
     *   `downloaded == bundled` → 用 downloaded（就是同一个版本，不必退回）
     *   `downloaded < bundled`  → 用 bundled（Desktop 升级带来了更新的内置版本）
     *
     * 比较必须走版本模块：以前这里有一份自己的 `compareVersions()`，只看 major.minor.patch，
     * 于是 `0.2.0-rc.1`、`0.2.0-rc.2`、甚至 `0.2.0` 全被当成同一个版本——"下载版没比内置新"
     * 与"下载版更新"这两件事因此分不出来。
     */
    // 比较走版本模块（唯一事实来源，见 runtime-version.ts）：`>=` 而不是 `>`，因为
    // "下载版与内置同版本"时继续用下载的那份（用户刚装的就是它）。
    if (bundledVersion === undefined || compareRuntimeVersions(downloaded.version, bundledVersion) >= 0) {
      return { ...downloaded, ...(bundledVersion === undefined ? {} : { bundledVersion }) }
    }
    process.stderr.write(
      `[shell] 忽略已下载的 Runtime ${downloaded.version}：低于内置版本 ${bundledVersion}\n`,
    )
  }

  if (bundled !== undefined) {
    return { ...bundled, ...(bundled.version === undefined ? {} : { bundledVersion: bundled.version }) }
  }

  throw new Error(
    `dsh-desktop: no bundled dsh runtime found. Looked in:\n  ${bundledCandidates.join('\n  ')}\n` +
      `Run "npm run stage" before packaging.`,
  )
}

/** Locate the pinned Node executable that ships with the runtime. */
function resolveNodeBinary(runtimeDir: string): string | undefined {
  const candidates = [
    join(runtimeDir, 'node', 'node.exe'),
    join(runtimeDir, 'node', 'bin', 'node'),
    join(runtimeDir, 'node', 'node'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** Read the recorded Node version, when the staging script wrote one. */
function readNodeVersion(runtimeDir: string): string | undefined {
  try {
    const meta = JSON.parse(readFileSync(join(runtimeDir, 'node', 'node-runtime.json'), 'utf8')) as {
      version?: string
    }
    return meta.version
  } catch {
    return undefined
  }
}

/**
 * Read the version recorded by the staging script (or the runtime updater), when it exists.
 *
 * 这只是**我们自己记的账**，用于诊断与菜单展示；"这份 Runtime 到底装了什么版本"一律以
 * {@link readDshVersion} 读到的真实 package.json 为准。
 */
function readStagedVersion(dir: string): string | undefined {
  try {
    const meta = JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf8')) as { version?: string }
    return typeof meta.version === 'string' ? meta.version : undefined
  } catch {
    return undefined
  }
}
