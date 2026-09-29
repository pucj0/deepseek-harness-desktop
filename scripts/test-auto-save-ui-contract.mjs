import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const review = read('plugins/dsh-client-ui-review/lib/client.js')
const host = read('plugins/dsh-client-ui-gitbar/lib/index.js')

for (const phrase of [
  '自动保存的改动',
  '恢复切换前改动',
  '恢复最近一次自动保存',
  '切回并恢复',
  '查看保存的改动',
  '查找保存的改动',
  '复制恢复命令',
  'Auto-saved Changes',
  'Restore Latest Auto-save',
  'Switch Back and Restore',
]) assert.ok(review.includes(phrase), `missing UI copy: ${phrase}`)

assert.match(review, /callGitbarGet\('auto-saves'/u)
assert.match(review, /data-auto-save-reminder/u)
assert.match(review, /data-auto-save-latest/u)
assert.match(review, /data-auto-save-find/u)
assert.match(review, /git stash apply --index \$\{oid\}/u)
assert.match(host, /SMART_STASH_PREFIX = 'dsh-smart-switch:'/u)
assert.match(host, /candidate\.sha === smart\.stashOid/u)
assert.match(host, /parsed\?\.id !== smart\.id/u)
assert.match(host, /stash', 'apply', '--index', smart\.stashOid/u)
assert.match(host, /stash', 'push', '--include-untracked'/u)

console.log('PASS Auto-saved Changes is rediscovered from Git and exposes all recovery actions')
console.log('PASS Smart stash restore/drop is tied to marker id plus immutable OID')
