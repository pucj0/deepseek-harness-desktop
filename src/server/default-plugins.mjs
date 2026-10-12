import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { desktopPackageManager } from './package-manager.mjs'

export const DEFAULT_PLUGIN_NAMES = ['dsh-client-ui-review', 'dsh-client-ui-gitbar']
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
const STATE_FILE = 'default-plugins-state.json'

export function readDefaultPlugins() {
  const { plugins } = JSON.parse(readFileSync(new URL('./default-plugins.json', import.meta.url), 'utf8'))
  if (!Array.isArray(plugins) || plugins.length !== DEFAULT_PLUGIN_NAMES.length) throw new Error('Invalid default plugin manifest')
  for (const name of DEFAULT_PLUGIN_NAMES) {
    const entry = plugins.find(plugin => plugin.name === name)
    if (!entry || !/^[0-9a-f]{64}$/u.test(entry.sha256) || !/^\d+\.\d+\.\d+$/u.test(entry.version)) throw new Error(`Invalid default plugin: ${name}`)
    const url = new URL(entry.url)
    if (url.origin !== 'https://github.com' || url.pathname !== `/pucj0/${name}/releases/download/v${entry.version}/${name}-${entry.version}.tgz`) {
      throw new Error(`Unexpected default plugin download: ${name}`)
    }
  }
  return plugins
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function saveState(file, state) {
  const pending = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(pending, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(pending, file)
  } finally {
    rmSync(pending, { force: true })
  }
}

async function downloadArchive(plugin, cacheDir, fetcher) {
  mkdirSync(cacheDir, { recursive: true })
  const archive = join(cacheDir, `${plugin.name}-${plugin.version}-${plugin.sha256}.tgz`)
  if (existsSync(archive) && sha256(readFileSync(archive)) === plugin.sha256) return archive
  const response = await fetcher(plugin.url, { signal: AbortSignal.timeout(20000), headers: { Accept: 'application/octet-stream' } })
  if (!response.ok) throw new Error(`download returned HTTP ${response.status}`)
  if (Number(response.headers.get('content-length')) > MAX_ARCHIVE_BYTES) throw new Error('plugin archive is too large')
  const chunks = []
  let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > MAX_ARCHIVE_BYTES) throw new Error('plugin archive is too large')
    chunks.push(chunk)
  }
  const content = Buffer.concat(chunks)
  if (sha256(content) !== plugin.sha256) throw new Error('plugin archive SHA-256 verification failed')
  const pending = `${archive}.${randomUUID()}.tmp`
  try {
    writeFileSync(pending, content, { mode: 0o600, flag: 'wx' })
    renameSync(pending, archive)
  } finally {
    rmSync(pending, { force: true })
  }
  return archive
}

/**
 * Defaults are installed into the writable application-owned profile once.
 * A successful record also remembers an intentional uninstall/disable: future
 * launches must not re-add a missing dependency or a removed bundle entry.
 */
export async function ensureDefaultPlugins({ home, profileDir, installAnchor, plugins, fetcher = fetch, runPluginCommand,
  withLock, packageManager, log = console.log, enabled = process.env.DSH_DESKTOP_DEFAULT_PLUGINS !== '0' }) {
  const outcome = { installed: [], kept: [], skipped: [], failures: [] }
  if (!enabled) return outcome
  const wanted = plugins ?? readDefaultPlugins()
  const require = createRequire(installAnchor)
  const load = specifier => import(pathToFileURL(require.resolve(specifier)).href)
  const manager = runPluginCommand ?? (await load('@deepseek-ai/dsh-plugin-manager/operations')).runPluginCommand
  const lock = withLock ?? (await load('@deepseek-ai/dsh-atomic-write')).withFileLock
  const invocation = packageManager ?? desktopPackageManager()
  mkdirSync(profileDir, { recursive: true })
  const stateFile = join(profileDir, STATE_FILE)
  return lock(stateFile, async () => {
    // Corrupt state must not erase a user's prior uninstall decision.
    const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { schemaVersion: 1, plugins: {} }
    if (state.schemaVersion !== 1 || !state.plugins || typeof state.plugins !== 'object') throw new Error('Invalid default plugin installation state')
    for (const plugin of wanted) {
      if (state.plugins[plugin.name]?.status === 'installed' || state.plugins[plugin.name]?.status === 'adopted') {
        outcome.skipped.push(plugin.name)
        continue
      }
      const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
      const packageFile = join(profileDir, 'node_modules', plugin.name, 'package.json')
      if (manifest.dependencies?.[plugin.name] && existsSync(packageFile)) {
        state.plugins[plugin.name] = { status: 'adopted', version: JSON.parse(readFileSync(packageFile, 'utf8')).version }
        saveState(stateFile, state)
        outcome.kept.push(plugin.name)
        continue
      }
      try {
        log(`[dsh-desktop] 正在默认安装 ${plugin.name}@${plugin.version}`)
        const archive = await downloadArchive(plugin, join(profileDir, '.default-plugin-cache'), fetcher)
        const result = await manager({ profile: 'desktop', dir: profileDir, home, installAnchor, cwd: profileDir }, [
          'add', archive, '--ignore-scripts', '--config.auto-install-peers=false', `--store-dir=${join(home, 'plugin-store')}`,
        ], { ...invocation, execution: 'service', outputBytes: 16384, idleTimeoutMs: 30000, lookupTimeoutMs: 3000,
          signal: AbortSignal.timeout(60000) })
        if (result.exitCode !== 0) throw new Error(`package installation failed (${result.exitCode}); diagnostics: ${result.logPath}`)
        const installed = JSON.parse(readFileSync(packageFile, 'utf8'))
        if (installed.name !== plugin.name || installed.version !== plugin.version) throw new Error('installed plugin identity/version differs from the release manifest')
        const current = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
        if (!current.dependencies?.[plugin.name] || !current.dsh?.profile?.bundles?.includes(plugin.name)) throw new Error('official plugin manager did not activate the bundle')
        state.plugins[plugin.name] = { status: 'installed', version: plugin.version, sha256: plugin.sha256 }
        saveState(stateFile, state)
        outcome.installed.push(plugin.name)
        log(`[dsh-desktop] 默认插件已安装 ${plugin.name}@${plugin.version}`)
      } catch (error) {
        const reason = String(error?.message ?? error)
        outcome.failures.push({ name: plugin.name, reason })
        log(`[dsh-desktop] 默认插件 ${plugin.name} 安装失败，本次继续启动，下次重试：${reason}`)
      }
    }
    return outcome
  }, { waitMs: 5000 })
}
