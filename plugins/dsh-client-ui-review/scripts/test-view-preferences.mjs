import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { apply, dispose } from '../lib/index.js'

const tempRoot = resolve('.tmp')
mkdirSync(tempRoot, { recursive: true })
const directory = mkdtempSync(join(tempRoot, 'review-preferences-'))
let server
let exported
const cached = new Map()
globalThis.window = {
  localStorage: { getItem: key => cached.get(key) ?? null, setItem: (key, value) => cached.set(key, value) },
  __ModuleLoader__: { load: definition => { exported = definition.factory(() => ({ Component: class {} })) } },
}
await import('../lib/client.js')
const createStore = exported.__diffModelForTest.createModeStore

async function start() {
  const routes = new Map()
  apply({ get: name => name === 'profileContext' ? { dir: directory } : undefined,
    effect: fn => fn(), webServer: { register: entry => { routes.set(entry.path, entry.handler); return () => {} } } })
  server = createServer(routes.get('/dsh-desktop/review/view-preferences'))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${server.address().port}/dsh-desktop/review/view-preferences`
}
async function stop() { await new Promise(resolve => server.close(resolve)) }
function connect(store, url) {
  return store.connect({
    load: async () => (await (await fetch(url)).json()).diffMode,
    save: async diffMode => {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ diffMode }) })
      assert.equal(response.status, 200)
    },
  })
}
try {
  const firstUrl = await start()
  const first = createStore()
  const connection = connect(first, firstUrl)
  await connection.ready
  let notifications = 0
  first.subscribe(() => notifications++)
  first.set('unified')
  await first.flush()
  assert.equal(notifications, 1)
  assert.equal(JSON.parse(readFileSync(join(directory, 'ui-review', 'view-preferences.json'))).diffMode, 'unified')
  connection.dispose()
  await stop()

  // New browser origin has no localStorage, but the profile still has the choice.
  cached.clear()
  const secondUrl = await start()
  assert.notEqual(secondUrl, firstUrl)
  const second = createStore()
  const restored = connect(second, secondUrl)
  await restored.ready
  assert.equal(second.get(), 'unified')
  second.set('side-by-side')
  second.set('unified')
  second.set('side-by-side')
  await second.flush()
  assert.equal((await (await fetch(secondUrl)).json()).diffMode, 'side-by-side')
  const invalid = await fetch(secondUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ diffMode: '../anything', path: 'elsewhere' }) })
  assert.equal(invalid.status, 400)
  assert.equal((await (await fetch(secondUrl)).json()).diffMode, 'side-by-side')
  restored.dispose()
  await stop()
  console.log('PASS profile file survives host restart and changed port; rapid toggles save the last choice; invalid values rejected')

  let resolveLoad
  const race = createStore()
  const saved = []
  const pending = race.connect({ load: () => new Promise(resolve => { resolveLoad = resolve }), save: async mode => saved.push(mode) })
  await Promise.resolve()
  race.set('unified')
  resolveLoad('side-by-side')
  await pending.ready
  await race.flush()
  assert.equal(race.get(), 'unified')
  assert.deepEqual(saved, ['unified'])
  pending.dispose()
  cached.set('dsh.review.diffMode', 'unified')
  const legacy = createStore()
  const migrated = []
  const migration = legacy.connect({ load: async () => null, save: async mode => migrated.push(mode) })
  await migration.ready
  await legacy.flush()
  assert.deepEqual(migrated, ['unified'])
  migration.dispose()
  console.log('PASS delayed restore cannot overwrite a new click; existing localStorage choice migrates to the profile')
} finally {
  if (server?.listening) await stop()
  dispose()
  rmSync(directory, { recursive: true, force: true })
}
