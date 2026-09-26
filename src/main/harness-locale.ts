/**
 * Harness 的语言设置：从哪里读、以及怎么在运行中跟上它。
 *
 * ## 为什么是"读文件"而不是自己存一份
 *
 * Harness 官方的 locale 插件（`@deepseek-ai/dsh-client-locale`）本身就是**宿主托管**的偏好：
 *
 *   * namespace/字段是常量 `LOCALE_SETTINGS_NAMESPACE = 'locale'`、
 *     `LOCALE_PREFERENCE_FIELD = 'preference'`（见该包 `lib/types/locale-settings.d.ts`）；
 *   * 客户端的唯一写入入口 `LocaleRuntime.setLocale()` 做的是
 *     `this.host?.set('preference', id)`，而 `this.host` 是
 *     `ctx.settingsScope.bind({ namespace: 'locale' })`；
 *   * 这个 scope 由 `dsh-settings-file` 落到 **`<harness home>/settings.yaml`**
 *     （也支持 `.json`），写入走 `writeFileAtomic`（临时文件 + rename）；
 *   * 宿主自己用 chokidar 盯着这份文档，**外部编辑会热发布**给 Web UI。
 *
 * 因此"用户的语言选择"唯一可信的落点是这份设置文档。Desktop Shell 只是第二个消费者：
 * 它不新增语言设置、不读 `navigator.language`、也不用 `app.getLocale()` 去"决定"语言，
 * 只把这份文档里的值翻译成自己的菜单文案。
 *
 * 读不到（文件还不存在、用户从未选过语言、内容被改坏）时返回 `undefined`，由调用方回退到
 * "系统/浏览器语言"——那正是 Harness 在没有 preference 时的行为（它的 provisional 值来自
 * `navigator.languages`）。
 *
 * ## 为什么不做成"每次读一遍"
 *
 * 菜单在启动时构建，而运行中切换语言必须**不重启**就生效。监听用 `fs.watch` 同时盯
 * **文件本体与它所在目录**：宿主用 rename 提交写入，只盯文件在某些平台上会因 inode 被替换
 * 而丢掉后续事件；只盯目录则在文件已存在时拿不到内容级变化。两条一起盯才是稳的。
 */
import { existsSync, readFileSync, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { join } from 'node:path'

/** 宿主默认的设置文档名（`dsh-settings-file` 的默认值）。 */
export const SETTINGS_FILENAME = 'settings.yaml'
/** 另一种被支持的设置文档名（配置指定 `.json` 时）。 */
export const SETTINGS_JSON_FILENAME = 'settings.json'
/** 设置文档里 locale 小节的名字（= locale 插件的 settings namespace）。 */
export const LOCALE_SECTION = 'locale'
/** 小节里承载选择的字段（= locale 插件的 preference 字段）。 */
export const LOCALE_FIELD = 'preference'

/** 写入是"临时文件 + rename"，两次事件可能挨得很近，合并一下再读。 */
const RELOAD_DEBOUNCE_MS = 60

/**
 * 把 YAML/JSON 标量还原成字符串。
 *
 * 只处理这个字段实际会出现的形状：纯 id（`zh`）、带引号（`"zh"`）、空值
 * （`~`/`null`/空）。其余一律当作"没有值"，由调用方回退。
 *
 * @param raw - 冒号后面的原文。
 * @returns 去引号后的值，或 undefined。
 */
function scalarValue(raw: string): string | undefined {
  const text = raw.trim().replace(/\s+#.*$/u, '').trim()
  if (text === '' || text === '~' || text === 'null' || text === '{}' || text === '[]') return undefined
  const quoted = /^(['"])(.*)\1$/u.exec(text)
  const value = (quoted === null ? text : quoted[2] ?? '').trim()
  return value === '' ? undefined : value
}

/**
 * 从"流式映射"（`{ preference: zh }`）里取值。
 *
 * 宿主默认写成块状，但手写或未来换序列化器时流式也可能出现，代价只有几行。
 *
 * @param inner - 花括号里面的内容。
 * @returns 字段值，或 undefined。
 */
function fromFlowMapping(inner: string): string | undefined {
  for (const part of inner.split(',')) {
    const field = /^\s*([A-Za-z0-9._-]+)\s*:\s*(.*)$/u.exec(part)
    if (field !== null && field[1] === LOCALE_FIELD) return scalarValue(field[2] ?? '')
  }
  return undefined
}

/**
 * 从设置文档原文里取出 `locale.preference`。
 *
 * 支持 JSON 与宿主实际写出的 YAML 子集（顶层小节 + 缩进一层字段）。任何解析不了的地方都
 * 只是"没有值"，绝不抛错——一个坏掉的设置文件不该让外壳起不来。
 *
 * @param text - 设置文档原文。
 * @returns 语言 id，或 undefined。
 */
export function parseLocalePreference(text: string): string | undefined {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  if (trimmed === '') return undefined

  if (trimmed.startsWith('{')) {
    try {
      const doc = JSON.parse(trimmed) as Record<string, unknown>
      const section = doc?.[LOCALE_SECTION]
      if (section === null || typeof section !== 'object') return undefined
      return scalarValue(String((section as Record<string, unknown>)[LOCALE_FIELD] ?? ''))
    } catch {
      return undefined
    }
  }

  let inLocale = false
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.replace(/#.*$/u, '')
    if (line.trim() === '') continue
    const top = /^([A-Za-z0-9._-]+):\s*(.*)$/u.exec(line)
    if (top !== null) {
      // 顶层小节：只有 locale 后面的缩进字段才属于我们。
      inLocale = top[1] === LOCALE_SECTION
      if (!inLocale) continue
      const flow = /\{([^}]*)\}/u.exec(top[2] ?? '')
      if (flow !== null) {
        const value = fromFlowMapping(flow[1] ?? '')
        if (value !== undefined) return value
      }
      continue
    }
    if (!inLocale) continue
    const field = /^\s+([A-Za-z0-9._-]+):\s*(.*)$/u.exec(line)
    if (field === null || field[1] !== LOCALE_FIELD) continue
    return scalarValue(field[2] ?? '')
  }
  return undefined
}

/**
 * 读出 Harness 当前的语言偏好。
 *
 * @param dshHome - Harness 主目录（本应用是 `<userData>/home`）。
 * @returns 语言 id（宿主存的是 `zh`/`en`，语言包可以是别的 id），或 undefined。
 */
export function readLocalePreference(dshHome: string): string | undefined {
  if (typeof dshHome !== 'string' || dshHome === '') return undefined
  for (const name of [SETTINGS_FILENAME, SETTINGS_JSON_FILENAME]) {
    const file = join(dshHome, name)
    try {
      if (!existsSync(file)) continue
      const value = parseLocalePreference(readFileSync(file, 'utf8'))
      if (value !== undefined) return value
    } catch {
      // 读不到就当作"没有偏好"：回退到系统语言，与用户从未设置过时一致。
    }
  }
  return undefined
}

/**
 * 监听语言偏好的变化。
 *
 * 回调只在**值真的变了**的时候触发（宿主重写整个文档时会带上其它小节，那种写入不会打扰
 * 调用方）。返回的 disposer 幂等，并且关掉 watcher 就不再占用句柄。
 *
 * @param dshHome - Harness 主目录。
 * @param onChange - 偏好变化时的回调（参数是新的原始值，可能是 undefined）。
 * @returns 停止监听的函数。
 */
export function watchLocalePreference(
  dshHome: string,
  onChange: (locale: string | undefined) => void,
): () => void {
  if (typeof dshHome !== 'string' || dshHome === '') return () => {}
  let last = readLocalePreference(dshHome)
  let timer: NodeJS.Timeout | undefined
  let stopped = false

  const read = (): void => {
    if (stopped) return
    const next = readLocalePreference(dshHome)
    if (next === last) return
    last = next
    try {
      onChange(next)
    } catch {
      // 一个坏掉的消费者不该把监听链（进而把进程）带下来。
    }
  }
  const schedule = (): void => {
    if (stopped) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(read, RELOAD_DEBOUNCE_MS)
    // 不因为一个诊断性监听而拖住进程退出。
    timer.unref?.()
  }

  const watchers: FSWatcher[] = []
  const watchPath = (target: string): void => {
    try {
      const watcher = watch(target, { persistent: false }, schedule)
      watcher.on('error', () => {})
      watchers.push(watcher)
    } catch {
      // 目标还不存在（文件）或平台不支持：其余目标仍然生效。
    }
  }
  watchPath(join(dshHome, SETTINGS_FILENAME))
  watchPath(join(dshHome, SETTINGS_JSON_FILENAME))
  watchPath(dshHome)

  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    for (const watcher of watchers) {
      try {
        watcher.close()
      } catch {
        // 已经关掉或进程正在退出。
      }
    }
    watchers.length = 0
  }
}
