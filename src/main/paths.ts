/**
 * Where the bundled dsh runtime lives, in dev and in a packaged app.
 *
 * Packaged: the runtime ships **inside `app.asar`** (`<app>/runtime`), because that is
 *           the only copy the installer needs — the JS/JSON assets are compressed by
 *           NSIS once, instead of being delivered a second time as a brotli archive
 *           that then has to be unpacked into userData on first launch.
 * Dev:      the same `runtime/` directory in the repo root.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app } from 'electron'

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
  /** Version recorded by scripts/stage-runtime.mjs, when present. */
  stagedVersion?: string
  /** True when running from a packaged installer rather than the repo. */
  packaged: boolean
}

/**
 * Resolve the bundled runtime.
 *
 * Packaged releases always run the runtime shipped by that same release. Older
 * versions could install an npm-updated runtime under
 * `<userData>/runtime/current`; deliberately ignoring that legacy location is
 * what prevents an old hot-updated runtime from overriding a newer full release.
 * User workspaces, sessions and settings live elsewhere and are untouched.
 *
 * @param _userDataDir - Kept for API compatibility; legacy runtime caches here are ignored.
 * @param unpackedDir - 旧版 `runtime.br` 解包出来的目录。只在读取**旧版本遗留**的安装时才
 *   会传入；新版不再解包，因此正常情况下是 undefined。
 * @returns the resolved runtime location.
 */
export function resolveRuntime(_userDataDir: string, unpackedDir?: string): RuntimeLocation {
  const packaged = app.isPackaged
  const candidates: string[] = []

  if (packaged) {
    // 顺序是有意的：先看本版真正携带的那份（app.asar 里的 `runtime/`），再兼容两种历史
    // 形态——旧包的散文件 `resources/runtime`、以及更旧的 `runtime.br` 解包目录。
    if (unpackedDir !== undefined) candidates.push(unpackedDir)
    candidates.push(join(app.getAppPath(), 'runtime'))
    candidates.push(join(process.resourcesPath, 'runtime'))
  } else {
    candidates.push(resolve(__dirname, '..', '..', 'runtime'))
  }

  for (const dir of candidates) {
    const anchor = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    if (!existsSync(anchor)) continue
    const nodeBinary = resolveNodeBinary(dir)
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
      packaged,
    }
  }

  throw new Error(
    `dsh-desktop: no bundled dsh runtime found. Looked in:\n  ${candidates.join('\n  ')}\n` +
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

/** Read the version recorded by the staging script, when it exists. */
function readStagedVersion(dir: string): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const meta = require(join(dir, 'runtime.json')) as { version?: string }
    return meta.version
  } catch {
    return undefined
  }
}
