/**
 * Where the bundled dsh runtime lives, in dev and in a packaged app.
 *
 * Packaged: electron-builder copies `runtime/` to `<app>/resources/runtime`.
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
   * The bundled runtime requires Node 22.13+/24 APIs (`zlib.createZstdCompress`,
   * `util.getSystemErrorMessage`, `module.stripTypeScriptTypes`) that Electron 33's
   * Node 20 does not provide, so a pinned portable Node ships alongside it.
   * `undefined` means "re-execute Electron as Node", which only works on an
   * Electron whose bundled Node is new enough.
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
 * @param unpackedDir - 内置归档解包出来的运行时目录（打包运行时才有）。
 * @returns the resolved runtime location.
 */
export function resolveRuntime(_userDataDir: string, unpackedDir?: string): RuntimeLocation {
  const packaged = app.isPackaged
  const candidates: string[] = []

  if (packaged) {
    // 解包目录排在"安装包内的散文件运行时"之前：后者只可能来自开发期或旧包，
    // 而解包出来的才是本次安装真正携带的那份。
    if (unpackedDir !== undefined) candidates.push(unpackedDir)
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
