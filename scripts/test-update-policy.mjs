import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const main = read('src/main/index.ts')
const paths = read('src/main/paths.ts')
const builder = read('electron-builder.yml')
const workflow = read('.github/workflows/release.yml')

assert.doesNotMatch(main, /RuntimeUpdater|locateNpmCli|runtimeUpdater\.check|npm registry/u)
assert.doesNotMatch(paths, /join\(userDataDir, 'runtime', 'current'\)/u)
assert.match(paths, /Legacy npm-updated runtimes|legacy location/iu)
assert.match(main, /new ShellUpdater\(app\.getVersion\(\)/u)
assert.match(builder, /publish:\s*[\s\S]*provider: github[\s\S]*owner: pucj0[\s\S]*repo: deepseek-harness-desktop/u)
for (const name of ['latest.yml', 'latest-mac.yml', 'latest-linux.yml']) assert.ok(workflow.includes(name), `${name} must be published`)
console.log('PASS GitHub Releases is the only end-user update source')
console.log('PASS legacy userData/runtime no longer overrides the bundled release runtime')
console.log('PASS builder provider and release metadata are present')
