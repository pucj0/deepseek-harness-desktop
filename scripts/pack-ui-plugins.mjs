import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepareStandalonePlugins } from './prepare-standalone-plugins.mjs'

const root = resolve(import.meta.dirname, '..')
export function packUiPlugins(outputDir = join(root, 'release', 'plugins')) {
  prepareStandalonePlugins()
  const output = resolve(outputDir)
  mkdirSync(output, { recursive: true })
  const require = createRequire(join(root, 'package.json'))
  const npm = join(require.resolve('npm/package.json'), '..', 'bin', 'npm-cli.js')
  const packages = ['review', 'gitbar'].map(name => {
    const directory = join(root, 'plugins', `dsh-client-ui-${name}`)
    const [result] = JSON.parse(execFileSync(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', output], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: join(root, '.tmp', 'npm-plugin-cache') },
    }))
    const path = join(output, result.filename)
    return { name: result.name, version: result.version, path, filename: result.filename,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), files: result.files.map(file => file.path) }
  })
  writeFileSync(join(output, 'SHA256SUMS.txt'), packages.map(pkg => `${pkg.sha256}  ${pkg.filename}`).join('\n') + '\n')
  return packages
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  for (const pkg of packUiPlugins()) console.log(`${pkg.name}@${pkg.version} -> ${pkg.path}`)
}
