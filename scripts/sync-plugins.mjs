// Refresh desktop-owned plugins without reinstalling the official runtime.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepareStandalonePlugins } from './prepare-standalone-plugins.mjs'
import { DEFAULT_PLUGIN_NAMES } from '../src/server/default-plugins.mjs'

const ROOT = resolve(import.meta.dirname, '..')

export function syncBundledPlugins({ runtimeDir = join(ROOT, 'runtime'), pluginsDir = join(ROOT, 'plugins') } = {}) {
  if (resolve(pluginsDir) === join(ROOT, 'plugins')) prepareStandalonePlugins()
  const runtime = resolve(runtimeDir)
  const modules = join(runtime, 'node_modules')
  if (!existsSync(join(modules, '@deepseek-ai', 'dsh', 'package.json'))) {
    throw new Error('sync-plugins: runtime is missing; run npm run stage:runtime first')
  }

  // Only replace direct children of this runtime's node_modules, never upstream packages.
  const runtimePath = realpathSync(runtime)
  const modulesPath = realpathSync(modules)
  if (!modulesPath.startsWith(runtimePath + sep)) throw new Error('sync-plugins: node_modules is outside the runtime')
  const plugins = readdirSync(pluginsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(pluginsDir, entry.name, 'package.json')))
    .map(entry => entry.name)
    .filter(name => !DEFAULT_PLUGIN_NAMES.includes(name))
    .sort()

  // Clean the old Desktop-owned copies, so the runtime installation anchor
  // cannot shadow the independently installed profile packages in development.
  for (const name of DEFAULT_PLUGIN_NAMES) {
    const destination = resolve(modulesPath, name)
    if (dirname(destination) !== modulesPath) throw new Error('sync-plugins: unsafe legacy destination')
    rmSync(destination, { recursive: true, force: true })
  }

  for (const plugin of plugins) {
    const source = resolve(pluginsDir, plugin)
    const destination = resolve(modulesPath, plugin)
    if (dirname(destination) !== modulesPath || source === destination) throw new Error('sync-plugins: unsafe destination')
    // Remove obsolete plugin files too. An existing junction is removed as a link.
    rmSync(destination, { recursive: true, force: true })
    mkdirSync(destination, { recursive: true })
    cpSync(source, destination, { recursive: true })
    console.log(`[sync-plugins] ${plugin} -> runtime/node_modules/`)
  }

  const metadataPath = join(runtime, 'runtime.json')
  if (existsSync(metadataPath)) {
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
    if (JSON.stringify(metadata.plugins) !== JSON.stringify(plugins)) {
      writeFileSync(metadataPath, JSON.stringify({ ...metadata, plugins }, null, 2) + '\n')
    }
  }
  return plugins
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  syncBundledPlugins()
}
