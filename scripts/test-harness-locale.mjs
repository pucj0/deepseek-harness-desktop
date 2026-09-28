// 语言偏好落点的单元测试：`settings.yaml`（≤0.1.6）与 profile patch（≥0.1.7）。
//
//   npm run build && node scripts/test-harness-locale.mjs
//
// 为什么必须有这个测试：0.1.7 把设置文档从 `<home>/settings.yaml` 搬成了组合行
// （`<home>/profiles/desktop/cordis.patch.yml` 里的 `- id: locale`），原文件改名成
// `settings.yaml.imported`。外壳的菜单语言读的就是这份偏好，只认老文件的实现在迁移之后会
// **安静地**退回系统语言——Harness 自己的界面语言还是对的，所以没有任何报错能提示这件事。
//
// 这里只测"读得到 / 读得对 / 变了能跟上"，不启动 Electron：菜单那边由
// `scripts/test-shell-locale.mjs` 覆盖。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  PROFILE_NAME,
  PROFILE_PATCH_FILENAME,
  parseLocaleFromProfilePatch,
  profilePatchPath,
  readLocalePreference,
  watchLocalePreference,
} from '../dist/main/harness-locale.js'

const root = resolve(import.meta.dirname, '..')
let passed = 0
let failed = 0
async function check(name, action) {
  try {
    await action()
    passed += 1
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** 0.1.7 迁移实际写出来的形状（实测，见 dsh-config-editor 的落盘）。 */
const MIGRATED = `- id: locale
  name: "@deepseek-ai/dsh-client-locale"
  config:
    preference: zh
`

const scratch = mkdtempSync(join(tmpdir(), 'dsh-harness-locale-'))
const home = join(scratch, 'home')
mkdirSync(join(home, 'profiles', PROFILE_NAME), { recursive: true })

try {
  console.log('=== parseLocaleFromProfilePatch：只认 locale 那一行的 config.preference ===')
  await check('迁移写出来的块状行', () => assert.equal(parseLocaleFromProfilePatch(MIGRATED), 'zh'))
  await check('引号包围的行 id', () =>
    assert.equal(parseLocaleFromProfilePatch('- id: "locale"\n  config:\n    preference: en\n'), 'en'))
  await check('嵌套在 insert: 之下的行', () =>
    assert.equal(
      parseLocaleFromProfilePatch('- insert:\n    - id: locale\n      name: "@deepseek-ai/dsh-client-locale"\n      config:\n        preference: zh\n'),
      'zh',
    ))
  await check('流式 config: { preference: xx }', () =>
    assert.equal(parseLocaleFromProfilePatch('- id: locale\n  config: { preference: en }\n'), 'en'))
  await check('同一个 id 出现两次时后写者胜（patch 语义）', () =>
    assert.equal(parseLocaleFromProfilePatch(`${MIGRATED}- id: locale\n  config:\n    preference: en\n`), 'en'))
  await check('别的小节里的 preference 不会被误读成语言', () =>
    assert.equal(parseLocaleFromProfilePatch('- id: ui-theme\n  config:\n    preference: system\n'), undefined))
  await check('locale 行里没有 preference / 没有 config', () => {
    assert.equal(parseLocaleFromProfilePatch('- id: locale\n  name: "@deepseek-ai/dsh-client-locale"\n'), undefined)
    assert.equal(parseLocaleFromProfilePatch('- id: locale\n  config:\n    other: 1\n'), undefined)
  })
  await check('注释与空文件', () => {
    assert.equal(parseLocaleFromProfilePatch('# - id: locale\n'), undefined)
    assert.equal(parseLocaleFromProfilePatch(''), undefined)
    assert.equal(parseLocaleFromProfilePatch(undefined), undefined)
  })
  await check('坏内容不抛错（返回 undefined，回退系统语言）', () => {
    assert.equal(parseLocaleFromProfilePatch('- id: locale\n\tconfig: ['), undefined)
  })

  console.log('')
  console.log('=== readLocalePreference：老文件优先，0.1.7 的 profile patch 兜底 ===')
  await check('只有 profile patch 时能读到（迁移之后的情形）', () => {
    writeFileSync(profilePatchPath(home), MIGRATED)
    assert.equal(readLocalePreference(home), 'zh')
  })
  await check('profile patch 被清空 → 回退 undefined', () => {
    writeFileSync(profilePatchPath(home), '[]\n')
    assert.equal(readLocalePreference(home), undefined)
  })
  await check('老文档与 profile patch 同时存在时老文档优先（0.1.6 的唯一权威）', () => {
    writeFileSync(join(home, 'settings.yaml'), 'locale:\n  preference: en\n')
    writeFileSync(profilePatchPath(home), MIGRATED)
    assert.equal(readLocalePreference(home), 'en')
  })
  await check('删掉老文档后自动落到 profile patch（迁移那一刻的行为）', () => {
    unlinkSync(join(home, 'settings.yaml'))
    assert.equal(readLocalePreference(home), 'zh')
  })
  await check('两份都没有 → undefined；空 home → undefined', () => {
    unlinkSync(profilePatchPath(home))
    assert.equal(readLocalePreference(home), undefined)
    assert.equal(readLocalePreference(''), undefined)
  })

  console.log('')
  console.log('=== watchLocalePreference：profile patch 的新建/修改/删除都要跟上 ===')
  await check('patch 文件**第一次出现**也能被监听到（只盯文件会漏掉）', async () => {
    const seen = []
    const stop = watchLocalePreference(home, (next) => seen.push(next))
    try {
      // 注册时两份都不存在 → 基准是 undefined，于是"第一次写入"必须产生一次回调。
      await sleep(150)
      writeFileSync(profilePatchPath(home), MIGRATED)
      await sleep(400)
      assert.deepEqual(seen, ['zh'], `实际回调: ${JSON.stringify(seen)}`)
    } finally {
      stop()
    }
  })
  await check('运行中改 profile patch → 回调拿到新值', async () => {
    const seen = []
    const stop = watchLocalePreference(home, (next) => seen.push(next))
    try {
      await sleep(150)
      writeFileSync(profilePatchPath(home), MIGRATED.replace('zh', 'en'))
      await sleep(400)
      assert.deepEqual(seen, ['en'], `实际回调: ${JSON.stringify(seen)}`)
    } finally {
      stop()
    }
  })
  await check('写回同一个值不打扰调用方', async () => {
    const seen = []
    const stop = watchLocalePreference(home, (next) => seen.push(next))
    try {
      await sleep(150)
      writeFileSync(profilePatchPath(home), MIGRATED.replace('zh', 'en'))
      await sleep(400)
      assert.deepEqual(seen, [])
    } finally {
      stop()
    }
  })
  await check('patch 被删掉 → 回退（拿到 undefined）', async () => {
    const seen = []
    const stop = watchLocalePreference(home, (next) => seen.push(next))
    try {
      await sleep(150)
      unlinkSync(profilePatchPath(home))
      await sleep(400)
      assert.deepEqual(seen, [undefined], `实际回调: ${JSON.stringify(seen)}`)
    } finally {
      stop()
    }
  })
  await check('dispose 之后不再回调', async () => {
    const seen = []
    const stop = watchLocalePreference(home, (next) => seen.push(next))
    stop()
    writeFileSync(profilePatchPath(home), MIGRATED)
    await sleep(300)
    assert.deepEqual(seen, [])
  })

  console.log('')
  console.log('=== 常量交叉校验：与 src/server/server.mjs 不许漂移 ===')
  await check('PROFILE_NAME / PROFILE_PATCH_FILENAME 与启动脚本一致', () => {
    const source = readFileSync(join(root, 'src', 'server', 'server.mjs'), 'utf8')
    const name = /const PROFILE_NAME = '([^']+)'/u.exec(source)
    const patch = /const PROFILE_PATCH_FILENAME = '([^']+)'/u.exec(source)
    assert.ok(name !== null, '启动脚本里找不到 PROFILE_NAME')
    assert.ok(patch !== null, '启动脚本里找不到 PROFILE_PATCH_FILENAME')
    assert.equal(PROFILE_NAME, name[1])
    assert.equal(PROFILE_PATCH_FILENAME, patch[1])
  })
  await check('profilePatchPath 指到 profile 目录下的 patch 文件', () => {
    assert.equal(profilePatchPath('/tmp/home'), join('/tmp/home', 'profiles', PROFILE_NAME, PROFILE_PATCH_FILENAME))
  })
} catch (error) {
  failed += 1
  console.error(`测试异常: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log('')
console.log(`${passed} 项通过${failed === 0 ? '' : `，${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
