const assert = require('node:assert/strict')
const {
  RUNTIME_RELEASES_API,
  checkRuntimeRelease,
  compareRuntimeVersions,
  versionFromRuntimeTag,
} = require('../dist/main/runtime-release')

assert.equal(versionFromRuntimeTag('dsh-v0.2.0-rc.1'), '0.2.0-rc.1')
assert.equal(versionFromRuntimeTag('v0.2.0-rc.1'), undefined)
assert.ok(compareRuntimeVersions('0.2.0-rc.1', '0.1.7-rc.2') > 0)
assert.ok(compareRuntimeVersions('0.2.0', '0.2.0-rc.9') > 0)
assert.ok(compareRuntimeVersions('0.2.0-rc.10', '0.2.0-rc.2') > 0)

const response = (body, ok = true, status = 200) => ({ ok, status, json: async () => body })

async function run() {
  let requested
  const available = await checkRuntimeRelease('0.1.7-rc.2', async (url) => {
    requested = url
    return response([
      { tag_name: 'desktop-v9.9.9', html_url: 'https://example.invalid/desktop', draft: false },
      { tag_name: 'dsh-v0.1.7-rc.2', html_url: 'https://example.invalid/old', draft: false },
      { tag_name: 'dsh-v0.2.0-rc.1', html_url: 'https://example.invalid/new', draft: false },
      { tag_name: 'dsh-v8.0.0', html_url: 'https://example.invalid/draft', draft: true },
    ])
  })
  assert.equal(requested, RUNTIME_RELEASES_API)
  assert.deepEqual(available, {
    available: true,
    current: '0.1.7-rc.2',
    latest: '0.2.0-rc.1',
    releaseUrl: 'https://example.invalid/new',
  })

  const latest = await checkRuntimeRelease('0.2.0-rc.1', async () => response([
    { tag_name: 'dsh-v0.2.0-rc.1', html_url: 'https://example.invalid/new', draft: false },
  ]))
  assert.equal(latest.available, false)
  assert.equal(latest.latest, '0.2.0-rc.1')

  const failed = await checkRuntimeRelease('0.2.0-rc.1', async () => response({}, false, 403))
  assert.equal(failed.available, false)
  assert.match(failed.reason, /HTTP 403/)
  console.log('PASS official GitHub runtime release checking and semver ordering')
}

run().catch((error) => { console.error(error); process.exitCode = 1 })
