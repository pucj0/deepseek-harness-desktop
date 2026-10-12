// Keep the vendored host helpers identical. Each published package contains its
// own copy, so neither requires Desktop or the other plugin at install time.
import { copyFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
export function prepareStandalonePlugins({ check = false } = {}) {
  for (const [source, target] of [
    ['plugins/dsh-client-ui-gitbar/lib/index.js', 'plugins/dsh-client-ui-review/lib/git-operations.js'],
    ['plugins/dsh-client-ui-gitbar/lib/workspace-roots.js', 'plugins/dsh-client-ui-review/lib/workspace-roots.js'],
    ['LICENSE', 'plugins/dsh-client-ui-review/LICENSE'],
    ['LICENSE', 'plugins/dsh-client-ui-gitbar/LICENSE'],
  ]) {
    if (check) {
      if (!readFileSync(resolve(root, source)).equals(readFileSync(resolve(root, target)))) {
        throw new Error(`${target} differs from ${source}; run npm run prepare:plugins`)
      }
    } else {
      copyFileSync(resolve(root, source), resolve(root, target))
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  prepareStandalonePlugins({ check: process.argv.includes('--check') })
}
