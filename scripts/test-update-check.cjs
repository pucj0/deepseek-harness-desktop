const assert = require('node:assert/strict')
const { createUpdateChecker, checkStartupUpdates } = require('../dist/main/update-check')
const { ShellUpdater } = require('../dist/main/shell-updater')

const desktop = (available = false) => ({ current: '1.8.1', latest: available ? '1.8.2' : '1.8.1', available })
const runtime = (available = false) => ({ current: '0.2.0-rc.1', latest: available ? '0.2.0-rc.2' : '0.2.0-rc.1', available, publishedAt: '2026-10-07T00:00:00Z' })
const create = (checkDesktop, checkRuntime, timeoutMs = 50) => createUpdateChecker({
  desktopVersion: '1.8.1', runtimeVersion: '0.2.0-rc.1', checkDesktop, checkRuntime, timeoutMs,
})

async function run() {
  const updater = new ShellUpdater('1.8.1')
  for (const [version, available] of [['1.8.1', false], ['1.8.0', false], ['1.8.2', true], ['1.8.2-rc.1', true]]) {
    updater.updater = { checkForUpdates: async () => ({ updateInfo: { version } }) }
    assert.equal((await updater.check(true)).available, available)
  }
  assert.equal((await updater.check(false)).available, false)
  updater.updater = { checkForUpdates: async () => { throw new Error('offline') } }
  assert.match((await updater.check(true)).reason, /offline/)
  console.log('PASS Desktop prompts only for newer versions and handles development mode and network failures')
  for (const [appUpdate, runtimeUpdate] of [[false, false], [true, false], [false, true], [true, true]]) {
    const checker = create(async () => desktop(appUpdate), async () => runtime(runtimeUpdate))
    const prompts = []
    await checkStartupUpdates({ check: checker.check, canNotify: () => true, notify: (result) => prompts.push(result) })
    assert.equal(prompts.length, appUpdate || runtimeUpdate ? 1 : 0)
    if (runtimeUpdate) assert.equal(prompts[0].runtime.publishedAt, runtime(true).publishedAt)
  }
  console.log('PASS startup prompts only for a confirmed update on either track, retaining release metadata')

  const offline = create(async () => { throw new Error('ENOTFOUND github.com') }, async () => { throw new Error('HTTP 403') })
  let prompts = 0
  await checkStartupUpdates({ check: offline.check, canNotify: () => true, notify: () => { prompts++ } })
  assert.equal(prompts, 0)
  const errors = await offline.check()
  assert.equal(errors.desktop.available, false)
  assert.match(errors.desktop.reason, /ENOTFOUND/)
  assert.match(errors.runtime.reason, /403/)
  const partial = create(async () => { throw new Error('offline') }, async () => runtime(true))
  await checkStartupUpdates({ check: partial.check, canNotify: () => true, notify: () => { prompts++ } })
  assert.equal(prompts, 1)
  console.log('PASS offline/API failures stay quiet and do not hide updates from a working track')

  let finish
  let calls = 0
  const checker = create(() => { calls++; return new Promise((resolve) => { finish = resolve }) }, async () => runtime(), 1000)
  const auto = checker.check()
  const manual = checker.check()
  assert.equal(auto, manual)
  await Promise.resolve()
  finish(desktop(true))
  assert.equal((await auto).desktop.available, true)
  const retry = checker.check()
  await Promise.resolve()
  finish(desktop())
  assert.equal((await retry).desktop.available, false)
  assert.equal(calls, 2)
  console.log('PASS overlapping checks share requests and subsequent manual checks retry')

  let late
  const timed = create(() => new Promise((resolve) => { late = resolve }), async () => runtime(), 10)
  const timedResult = await timed.check()
  assert.match(timedResult.desktop.reason, /timed out/)
  late(desktop(true))
  await Promise.resolve()
  assert.equal(timedResult.desktop.available, false)
  console.log('PASS hung checks finish within the deadline and late updates cannot trigger prompts')

  let settle
  let canNotify = true
  const pending = checkStartupUpdates({
    check: () => new Promise((resolve) => { settle = resolve }),
    canNotify: () => canNotify,
    notify: () => { throw new Error('duplicate or shutdown prompt') },
  })
  canNotify = false // manual panel opened or the main window closed while checking
  settle({ desktop: desktop(true), runtime: runtime(true) })
  await pending
  console.log('PASS manual update interaction and window shutdown suppress a pending startup prompt')
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
