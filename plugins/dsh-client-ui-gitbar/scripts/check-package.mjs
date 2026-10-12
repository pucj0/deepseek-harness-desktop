import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
assert.equal(pkg.private, undefined)
assert.ok(pkg.dsh.bundle.patch && pkg.exports['./client'])
for (const file of readdirSync(new URL('../lib/', import.meta.url))) {
  if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', new URL('../lib/' + file, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')])
}
const host = await import('../lib/index.js')
assert.equal(typeof host.apply, 'function')
assert.ok(host.inject.includes('webServer'))
readFileSync(new URL('../LICENSE', import.meta.url))
console.log('PASS package metadata, all JavaScript syntax, host entry and license: ' + pkg.name)
