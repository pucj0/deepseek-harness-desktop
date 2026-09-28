import z from '@deepseek-ai/schemastery'

export const name = 'ui-typography'

/**
 * ≤0.1.6 的设置命名空间。
 *
 * 那一版的设置服务允许插件**自报**命名空间（`settings.register(ns, schema)` 与
 * `settings.get(ns)`），用户值落在 `<home>/settings.yaml` 的 `desktop-ui-typography:` 小节。
 */
export const LEGACY_NAMESPACE = 'desktop-ui-typography'

/**
 * ≥0.1.7 的设置命名空间 = **组合行的 id**。
 *
 * 那一版把用户值改成组合行：命名空间就是行 id（`dsh-settings` 的
 * `write(ns)` 按 `configEditor.entries().find(row => row.options.id === ns)` 解析），
 * 插件不再能注册任意命名空间——`ctx.settings` 上既没有 `register` 也没有 `get`。
 * 本插件这一行的 id 是 `ui-typography`（见同包的 `cordis.patch.yml`）。
 *
 * 它同时是插件的 `Config`：`dsh-settings` 的表单直接取 `entry.fiber.runtime.Config`，
 * 所以导出 `Config` 正是"声明这一行的可设置字段"。
 */
export const NAMESPACE = 'ui-typography'

/**
 * 把字段标成"可热更新"（`Schema#volatile`，schemastery 3.18 起提供）。
 *
 * ≥0.1.7 的 `dsh-settings` 只把**volatile** 字段放进设置表单
 * （`volatileForm()` 逐字段看 `meta.volatile`，不是 volatile 就整行跳过），
 * 所以这个标记是"这一行出现在设置页"的前提。
 *
 * 老运行时的 schemastery 没有这个方法，而那时也不需要它：按能力取，避免在**导入期**
 * 就抛 `TypeError`（那会让插件根本加载不了，而不是少一个设置项）。
 *
 * @param schema - 字段 schema。
 * @returns 标好 volatile 的 schema，或原样返回。
 */
const volatile = (schema) => (typeof schema.volatile === 'function' ? schema.volatile() : schema)

export const SettingsSchema = z.object({
  fontSize: volatile(z.number().step(1).min(12).max(20).default(14)),
})

/** 这一行的设置表单（≥0.1.7）。老版本由 `settings.register` 声明同一份 schema。 */
export const Config = SettingsSchema

/**
 * 解开 volatile 字段的引用。
 *
 * 标了 `.volatile()` 的字段在 `fiber.config` 里是一个**引用盒子**
 * （cosmokit 的 `createVolatile()`：`{ get() }`，值只由拥有它的运行时更新），不是裸值——
 * `dsh-settings` 自己也先过一遍 `plainConfig()` 才投影表单。直接读会拿到一个对象，
 * 于是"用户设了 16、页面注入的却是默认 14"。
 *
 * @param value - config 里的字段值，可能是引用盒子。
 * @returns 裸值；不是盒子就原样返回（≤0.1.6 的 config 不带 volatile 语义）。
 */
const plain = (value) => (typeof value?.get === 'function' ? value.get() : value)

/**
 * 当前生效的字号。
 *
 * 老版本问注册过的命名空间；新版本读这一行自己的 config。
 *
 * **不能**用可选链掩盖 `settings.get` 不存在这件事：`ctx.get('settings')?.get(...)` 只会
 * 保住 `settings` 为 undefined 的情形，0.1.7 上 `settings` 是存在的、缺的是 `get`，
 * 于是照样抛 `TypeError`。而这个处理函数跑在 `webserver/index-inject` 的 `ctx.emit` 里，
 * `emit` 对监听器抛错**没有** try/catch：一次抛错会让 `WebServer.renderIndex()` 整个失败，
 * 界面连 index.html 都拿不到（不是设置页报错，是应用打不开）。
 *
 * @param ctx - 插件的上下文。
 * @param config - cordis 传入的、已校验的插件 config（`Config` 见上）。
 * @returns 字号，拿不到时给 schema 的默认值。
 */
function currentSize(ctx, config) {
  const settings = ctx.get('settings')
  if (typeof settings?.get === 'function') {
    const legacy = settings.get(LEGACY_NAMESPACE)?.fontSize
    if (typeof legacy === 'number') return legacy
  }
  // config 变更会让 cordis 重启这个 fiber（`Fiber.update` → `restart`），所以两者都是现值；
  // 先读 fiber 上的那份，避免将来某个调用路径不再把 config 传进来。
  const live = plain(ctx.fiber?.config?.fontSize ?? config?.fontSize)
  return typeof live === 'number' ? live : 14
}

export function apply(ctx, config) {
  ctx.inject(['settings'], (settingsCtx) => {
    // 0.1.7 起没有 register()：设置已经由这一行的 Config + profile patch 承载，
    // 再注册一次既无意义、在老版本上才是必需的。
    if (typeof settingsCtx.settings.register !== 'function') return
    settingsCtx.settings.register(LEGACY_NAMESPACE, SettingsSchema)
  })
  // The Host settings document survives restarts, port changes and workspace switches.
  ctx.on('webserver/index-inject', (table) => {
    const size = currentSize(ctx, config)
    table.push({
      kind: 'script',
      placement: 'body',
      text: `document.documentElement.dataset.dshUiFontSize = ${JSON.stringify(String(size))}`,
    })
  })
}
