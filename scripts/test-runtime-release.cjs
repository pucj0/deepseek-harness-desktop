// Runtime Release 检查：tag/版本解析、semver 排序、published_at 透传。
//
// publishedAt 是**应用内安装 Runtime** 的一半依据（另一半是版本号本身）：它算 npm 的
// `--before`，也就是"按这个版本发布当时的仓库状态装依赖"。缺了它，上游半波发布时
// `^` 范围会把还没上架的兄弟包解析进来，安装直接 ETARGET 失败。
const assert = require('node:assert/strict')
const {
  RUNTIME_RELEASES_API,
  checkRuntimeRelease,
  compareRuntimeVersions,
  versionFromRuntimeTag,
} = require('../dist/main/runtime-release')
const { closureBefore, SAME_WAVE_WINDOW_MS } = require('../dist/main/runtime-updater')

assert.equal(versionFromRuntimeTag('dsh-v0.2.0-rc.1'), '0.2.0-rc.1')
assert.equal(versionFromRuntimeTag('v0.2.0-rc.1'), undefined)
assert.equal(versionFromRuntimeTag('dsh-v0.2.0'), '0.2.0')
assert.equal(versionFromRuntimeTag('dsh-v1.2'), undefined)
assert.equal(versionFromRuntimeTag('desktop-v1.2.3'), undefined)
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
      {
        tag_name: 'dsh-v0.2.0-rc.1',
        html_url: 'https://example.invalid/new',
        draft: false,
        published_at: '2025-09-20T08:30:00Z',
      },
      { tag_name: 'dsh-v8.0.0', html_url: 'https://example.invalid/draft', draft: true },
    ])
  })
  assert.equal(requested, RUNTIME_RELEASES_API)
  assert.deepEqual(available, {
    available: true,
    current: '0.1.7-rc.2',
    latest: '0.2.0-rc.1',
    releaseUrl: 'https://example.invalid/new',
    publishedAt: '2025-09-20T08:30:00Z',
  })

  // 最新那个 Release 才是权威：publishedAt 必须来自它，而不是列表里的第一条。
  const latest = await checkRuntimeRelease('0.2.0-rc.1', async () => response([
    { tag_name: 'dsh-v0.1.7-rc.2', html_url: 'https://example.invalid/old', draft: false, published_at: '2025-09-01T00:00:00Z' },
    { tag_name: 'dsh-v0.2.0-rc.1', html_url: 'https://example.invalid/new', draft: false, published_at: '2025-09-20T08:30:00Z' },
  ]))
  assert.equal(latest.available, false)
  assert.equal(latest.latest, '0.2.0-rc.1')
  assert.equal(latest.publishedAt, '2025-09-20T08:30:00Z')

  // 缺 published_at 的 Release 仍旧能用（只是算不出 --before），不能让整次检查失败。
  const missing = await checkRuntimeRelease('0.1.0', async () => response([
    { tag_name: 'dsh-v0.2.0-rc.1', html_url: 'https://example.invalid/new', draft: false },
  ]))
  assert.equal(missing.latest, '0.2.0-rc.1')
  assert.equal(missing.publishedAt, undefined)

  const failed = await checkRuntimeRelease('0.2.0-rc.1', async () => response({}, false, 403))
  assert.equal(failed.available, false)
  assert.match(failed.reason, /HTTP 403/)

  // publishedAt -> --before：恰好 +24h，且是 npm 能直接吃的 ISO 字符串。
  assert.equal(closureBefore('2025-09-20T08:30:00Z'), '2025-09-21T08:30:00.000Z')
  assert.equal(
    Date.parse(closureBefore('2025-09-20T08:30:00Z')) - Date.parse('2025-09-20T08:30:00Z'),
    SAME_WAVE_WINDOW_MS,
  )
  assert.equal(closureBefore(undefined), undefined)
  assert.equal(closureBefore('not-a-date'), undefined)
  assert.equal(closureBefore('2025-09-20T08:30:00Z', -1), undefined)

  console.log('PASS official GitHub runtime release checking, publishedAt and the 24h closure window')
}

run().catch((error) => { console.error(error); process.exitCode = 1 })
