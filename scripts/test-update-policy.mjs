import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const main = read('src/main/index.ts')
const paths = read('src/main/paths.ts')
const runtimeRelease = read('src/main/runtime-release.ts')
const builder = read('electron-builder.yml')
const workflow = read('.github/workflows/release.yml')

assert.doesNotMatch(main, /locateNpmCli|npm install|npm view|registry\.npmjs/u)
assert.doesNotMatch(paths, /join\(userDataDir, 'runtime', 'current'\)/u)
assert.match(paths, /Legacy npm-updated runtimes|legacy location/iu)
assert.match(main, /new ShellUpdater\(app\.getVersion\(\)/u)
assert.match(main, /checkRuntimeRelease\(runtimeVersion\)/u)
assert.match(runtimeRelease, /api\.github\.com\/repos\/deepseek-ai\/deepseek-harness\/releases/u)
assert.doesNotMatch(runtimeRelease, /npm|registry\.npmjs/u)
assert.match(builder, /publish:\s*[\s\S]*provider: github[\s\S]*owner: pucj0[\s\S]*repo: deepseek-harness-desktop/u)
for (const name of ['latest.yml', 'latest-mac.yml', 'latest-linux.yml']) assert.ok(workflow.includes(name), `${name} must be published`)
console.log('PASS Desktop and Runtime checks both use their GitHub Releases')
console.log('PASS no user-side npm command or npm registry access exists')
console.log('PASS legacy userData/runtime no longer overrides the bundled release runtime')
console.log('PASS builder provider and release metadata are present')
