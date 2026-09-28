// 桌面排版插件的 **host 半边** 的设置契约测试（纯 Node，不需要运行时）。
//
//   npm run build && node scripts/test-typography-settings.mjs
//
// 为什么必须有这个测试：这个插件在 `webserver/index-inject` 上挂了一个处理函数，而那个事件的
// `ctx.emit` 对监听器抛错**没有** try/catch（`WebServer.collectIndexInjections()` → `ctx.emit`）。
// 处理函数一抛错，`renderIndex()` 就整个失败——后果不是"设置页报错"，而是**界面连 index.html
// 都拿不到**（应用打不开）。而它恰好很容易抛：
//
//   * 0.1.7 的 `ctx.settings` 上**没有** `get`（用户值改由组合行承载），旧写法
//     `ctx.get('settings')?.get(NS)` 里可选链只保住了 `settings` 为 undefined 的情形，
//     `settings` 存在而 `get` 不存在时照样 TypeError；
//   * 0.1.7 的 `ctx.settings` 上同样**没有** `register`，旧写法会在 inject 回调里抛 TypeError。
//
// 所以这里用假的 ctx 把运行时形态走一遍，断言"绝不抛错"以及"读到的字号是对的"。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const pluginDir = join(root, 'plugins', 'dsh-client-ui-typography')
const plugin = await import(pathToFileURL(join(pluginDir, 'lib', 'index.js')).href)

let passed = 0
let failed = 0
function check(name, action) {
  try {
    action()
    passed += 1
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** volatile 字段在 config 里是一个引用盒子（cosmokit 的 `{ get() }`），不是裸值。 */
const box = (value) => ({ get: () => value })
const config = { fontSize: box(16) }

/**
 * 造一个刚好够用的假 ctx。
 *
 * `get('settings')` 与 inject 回调收到的 `settingsCtx.settings` 是同一个服务——真实 cordis 里
 * 也是这样：服务既按名字解析，也作为属性挂在消费者 ctx 上（`inject` 保证了它存在）。
 *
 * @param settings - 该运行时的 `ctx.settings`。
 * @param fiberConfig - 这一行在 `fiber.config` 上的现值。
 * @returns 带 `table()`/`injectError` 的假 ctx。
 */
function makeCtx(settings, fiberConfig = config) {
  const ctx = {
    injectError: undefined,
    handler: undefined,
    fiber: { config: fiberConfig },
    get: (name) => (name === 'settings' ? settings : undefined),
    inject: (_services, callback) => {
      const settingsCtx = { get: ctx.get, settings }
      try {
        callback(settingsCtx)
      } catch (error) {
        ctx.injectError = error
      }
    },
    on: (_name, handler) => { ctx.handler = handler },
    emit: (name, table) => { if (name === 'webserver/index-inject') ctx.handler(table) },
  }
  return ctx
}

/** 跑一次注入并返回表；抛错原样冒出来（那正是要拦下的行为）。 */
function inject(ctx, runtimeConfig) {
  plugin.apply(ctx, runtimeConfig)
  const table = []
  ctx.emit('webserver/index-inject', table)
  if (ctx.injectError !== undefined) throw ctx.injectError
  return table
}

/** 从注入行里取出写进 dataset 的字号。 */
function sizeOf(table) {
  assert.equal(table.length, 1, `应当恰好注入一行，实际 ${String(table.length)} 行`)
  const match = /dshUiFontSize = "?(\d+)"?/u.exec(table[0].text ?? '')
  assert.ok(match !== null, `注入行里应当写 dataset.dshUiFontSize: ${table[0].text}`)
  return Number(match[1])
}

/** 0.1.7 的 settings：有 describe/update…，**没有** register / get。 */
const modernSettings = { describe: () => [], update: async () => {}, write: async () => {} }

/** ≤0.1.6 的 settings：插件自报命名空间，register + get。 */
function legacySettings(values = {}) {
  const registered = new Map()
  return {
    registered,
    register: (namespace, schema) => registered.set(namespace, schema),
    get: (namespace) => values[namespace] ?? {},
  }
}

console.log('=== ≥0.1.7：settings 存在但没有 get / register（本轮修复的触发点） ===')
check('index-inject 处理函数不抛错，且读的是这一行的 config', () => {
  const ctx = makeCtx(modernSettings)
  assert.equal(sizeOf(inject(ctx, config)), 16)
  assert.equal(ctx.injectError, undefined, String(ctx.injectError))
})
check('settings 上 register 为 undefined 时不抛错（0.1.7 的真实形态）', () => {
  assert.equal(Object.hasOwn(modernSettings, 'register'), false, '这个假服务必须真的没有 register')
  const ctx = makeCtx(modernSettings)
  plugin.apply(ctx, config)
  assert.equal(ctx.injectError, undefined, String(ctx.injectError))
})
check('config 缺失时给 schema 默认 14（不会写成 undefined / [object Object]）', () => {
  assert.equal(sizeOf(inject(makeCtx(modernSettings, {}), undefined)), 14)
})
check('volatile 引用盒子被解开（读成对象会注入 "[object Object]"）', () => {
  const size = box(18)
  assert.equal(sizeOf(inject(makeCtx(modernSettings, { fontSize: size }), { fontSize: size })), 18)
})

console.log('')
console.log('=== ≤0.1.6：settings 提供 register + get ===')
check('老版本仍然注册命名空间，并优先从它读值', () => {
  const settings = legacySettings({ 'desktop-ui-typography': { fontSize: 19 } })
  const ctx = makeCtx(settings)
  assert.equal(sizeOf(inject(ctx, {})), 19)
  assert.deepEqual([...settings.registered.keys()], ['desktop-ui-typography'], '注册的名字必须是 settings.yaml 的小节名')
})

console.log('')
console.log('=== 组合契约：命名空间 / 行 id / volatile 不许漂移 ===')
check('NAMESPACE 等于组合行 id（cordis.patch.yml）', () => {
  const patch = readFileSync(join(pluginDir, 'cordis.patch.yml'), 'utf8')
  const id = /-\s*id:\s*(\S+)/u.exec(patch)?.[1]
  assert.ok(id !== undefined, 'patch 里应当有 id')
  assert.equal(plugin.NAMESPACE, id)
})
check('NAMESPACE / LEGACY_NAMESPACE 与 client.js 里的常量一致', () => {
  const client = readFileSync(join(pluginDir, 'lib', 'client.js'), 'utf8')
  assert.equal(/const ENTRY_NAMESPACE = '([^']+)'/u.exec(client)?.[1], plugin.NAMESPACE)
  assert.equal(/const LEGACY_NAMESPACE = '([^']+)'/u.exec(client)?.[1], plugin.LEGACY_NAMESPACE)
})
check('Config 就是这一行的设置表单', () => {
  assert.equal(plugin.Config, plugin.SettingsSchema)
  assert.ok(plugin.SettingsSchema.dict?.fontSize !== undefined, 'SettingsSchema 应当声明 fontSize')
})
check('fontSize 带 volatile 标记，且在注入期就尝试标记', () => {
  const field = plugin.SettingsSchema.dict.fontSize
  // 0.1.7 的 `dsh-settings` 只把 volatile 字段放进设置表单（`volatileForm()` 逐字段看
  // `meta.volatile`，不是 volatile 就整行跳过），所以这个标记是"行出现在设置页"的前提。
  const supportsVolatile = typeof field.volatile === 'function'
  assert.match(
    readFileSync(join(pluginDir, 'lib', 'index.js'), 'utf8'),
    /fontSize:\s*volatile\(/u,
    '设置字段必须走 volatile() 包装（老运行时的 schemastery 没有它，包装函数会原样放行）',
  )
  if (supportsVolatile) assert.equal(field.meta?.volatile, true)
  else console.log('  SKIP  当前测试环境解析到的 schemastery 不支持 volatile（老运行时），只校验了调用点')
})

console.log('')
console.log(`${passed} 项通过${failed === 0 ? '' : `，${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
