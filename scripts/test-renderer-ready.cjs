const assert = require('node:assert/strict')
const vm = require('node:vm')
const { HARNESS_PAINTED_SCRIPT } = require('../dist/main/renderer-ready')
const { markStartup, startupTimeline, resetStartupForTest } = require('../dist/main/startup-timeline')

async function run() {
  for (const initiallyMounted of [false, true]) {
    let mounted = initiallyMounted, changed, disconnected = 0, settled = false
    const frames = [], idle = []
    const promise = vm.runInNewContext(HARNESS_PAINTED_SCRIPT, {
      document: { documentElement: {}, querySelector: selector => {
        assert.equal(selector, '[data-shell-overlay]')
        return mounted ? {} : null
      } },
      MutationObserver: class {
        constructor(callback) { changed = callback }
        observe() {}
        disconnect() { disconnected++ }
      },
      requestAnimationFrame: callback => frames.push(callback),
      requestIdleCallback: callback => idle.push(callback),
    })
    promise.then(() => { settled = true })
    if (!initiallyMounted) {
      assert.equal(frames.length, 0, 'loading page does not trigger updates')
      await Promise.resolve()
      assert.equal(settled, false)
      mounted = true
      changed()
    }
    changed() // a queued observer notification cannot schedule a duplicate
    assert.equal(disconnected, 1)
    assert.equal(frames.length, 1)
    frames.shift()()
    await Promise.resolve()
    assert.equal(settled, false, 'first animation callback precedes paint')
    frames.shift()()
    await Promise.resolve()
    assert.equal(settled, false, 'updater must wait for idle after paint')
    assert.equal(idle.length, 1)
    idle.shift()()
    await promise
    assert.equal(settled, true)
  }
  console.log('PASS loading page, application mount, paint and idle are distinct readiness stages')

  resetStartupForTest()
  markStartup('appReady')
  markStartup('windowCreated')
  markStartup('runtimeReady')
  markStartup('navigationStarted')
  markStartup('hostReady')
  const timeline = startupTimeline()
  assert.deepEqual(timeline.map(entry => entry.name), ['appReady', 'windowCreated', 'runtimeReady', 'navigationStarted', 'hostReady'])
  assert(timeline.every((entry, index) => index === 0 || entry.ms >= timeline[index - 1].ms))
  console.log('PASS concurrent startup stages are reported in actual order without negative spans')
}
run().catch(error => { console.error(error); process.exitCode = 1 })
