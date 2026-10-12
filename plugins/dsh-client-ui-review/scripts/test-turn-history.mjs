import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { apply, dispose } from '../lib/index.js'

const tempRoot = resolve('.tmp')
mkdirSync(tempRoot, { recursive: true })
const temporary = mkdtempSync(join(tempRoot, 'review-rounds-'))
const project = join(temporary, 'project')
const profile = join(temporary, 'profile')
mkdirSync(project)
const git = args => execFileSync('git', args, { cwd: project, encoding: 'utf8', windowsHide: true }).trim()
let server
function mount() {
  const hooks = new Map()
  const routes = new Map()
  apply({
    get: name => name === 'profileContext' ? { dir: profile, cwd: project } : undefined,
    on: (name, fn) => { hooks.set(name, fn); return () => {} },
    logger: { warn: message => { throw new Error(message) } },
    effect: fn => fn(), webServer: { register: entry => { routes.set(entry.path, entry.handler); return () => {} } },
  })
  return { hooks, routes }
}
try {
  git(['init', '-q'])
  git(['config', 'user.name', 'Review Test'])
  git(['config', 'user.email', 'review@example.com'])
  git(['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(project, 'existing.txt'), 'original\n')
  git(['add', '.'])
  git(['commit', '-qm', 'initial'])
  writeFileSync(join(project, 'existing.txt'), 'user change before task\n')
  const session = { id: 'conversation/one', header: { cwd: project } }
  const agent = { id: session.id, session }
  let { hooks, routes } = mount()
  server = createServer((req, res) => routes.get(new URL(req.url, 'http://localhost').pathname)(req, res))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const api = async (route, data) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/dsh-desktop/review/${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: project, sessionId: session.id, ...data }),
    })
    return { status: response.status, data: await response.json() }
  }
  const begin = turn => hooks.get('agent/pre-step')({ agent, turn }, async () => ({ kind: 'enter' }))
  const end = turn => hooks.get('session/event')(session, { type: 'turn/end', data: { turn } })

  await begin(1)
  writeFileSync(join(project, 'first.txt'), 'first round only\n')
  await begin(1) // A later model step must not reset this turn's baseline.
  end(1)
  const first = await api('changes', {})
  assert.equal(first.status, 200)
  assert.ok(Array.isArray(first.data.files), JSON.stringify(first.data))
  assert.deepEqual(first.data.files.map(x => x.path), ['first.txt'])
  assert.equal(first.data.historical, true)

  await begin(2)
  writeFileSync(join(project, 'second.txt'), 'second round only\n')
  end(2)
  const latest = await api('changes', {})
  assert.deepEqual(latest.data.files.map(x => x.path), ['second.txt'])
  assert.deepEqual(latest.data.rounds.map(x => x.turn), [2, 1])
  const old = await api('changes', { roundId: '1' })
  assert.equal(old.data.diff, first.data.diff)
  writeFileSync(join(project, 'first.txt'), 'later unrelated edit\n')
  assert.equal((await api('changes', { roundId: '1' })).data.diff, first.data.diff)
  assert.equal((await api('revert', { scope: 'turn', paths: ['first.txt'] })).status, 409)

  // Recreate the plugin as a restarted host: history comes from the local profile.
  ;({ hooks, routes } = mount())
  assert.deepEqual((await api('changes', {})).data.files.map(x => x.path), ['second.txt'])
  assert.equal((await api('changes', { roundId: '1' })).data.diff, first.data.diff)
  // Trees are retained by private refs, without changing the user's index/HEAD.
  const beforeGc = git(['status', '--porcelain'])
  git(['gc', '--prune=now'])
  assert.equal((await api('changes', { roundId: '1' })).data.diff, first.data.diff)
  assert.equal(git(['status', '--porcelain']), beforeGc)
  assert.equal((await api('graph', {})).status, 200)
  assert.equal(readFileSync(join(project, 'existing.txt'), 'utf8'), 'user change before task\n')
  console.log('PASS each actual turn has its own before/after snapshots; latest and previous rounds stay isolated across restart and Git GC; historical review is read-only')
} finally {
  if (server?.listening) await new Promise(resolve => server.close(resolve))
  dispose()
  rmSync(temporary, { recursive: true, force: true })
}
