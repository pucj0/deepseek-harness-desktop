/**
 * 单 renderer 架构下**唯一**的 preload。
 *
 * ## 为什么需要合并
 *
 * 旧架构有两个文档、因此也有两个 preload：
 *   * `titlebar.ts` → 窗口自身的页面（自绘标题栏 + 启动页）；
 *   * `preload.ts` → Harness 页面所在的子视图（上报主题令牌、当前工作区、语言）。
 *
 * 单 renderer 架构下窗口自身的 `webContents` 先显示启动底板、随后被 Harness 页面替换，
 * 两个阶段跑在**同一个渲染进程**里。因此这里把两者的桥合并成一份，按阶段各取所需：
 *
 *   * Harness 阶段（`preload.ts` 的那部分）是**长期有效**的：主题令牌、当前工作区、语言；
 *   * 标题栏阶段（`titlebar.ts` 的那部分）在单 renderer 架构里**只用于启动底板**：
 *     底板要能收进度文案。菜单/窗口状态那几条 IPC 在单 renderer 下不再有消费者，但保留
 *     它们没有代价（都是 `invoke`，没人调就不会发生），而且能让旧的窗口实现继续复用同一份
 *     preload。
 *
 * ## 安全姿态不变
 *
 * 仍然是 `contextIsolation: true` + `nodeIntegration: false` + `sandbox: true`，只通过
 * `contextBridge` 暴露**显式枚举**的少量能力，绝不暴露 `ipcRenderer` 本身。
 *
 * ## 为什么这个文件里所有东西都内联（没有相对 import）
 *
 * **沙箱化的 preload 不能 `require` 相对路径的文件。** Electron 的沙箱 preload 只提供少数几个
 * 模块（`electron`、`node:events` 等），`require('./caption-menu')` 会直接失败，报
 * `Unable to load preload script … Error: module not found: ./caption-menu`，然后**整个
 * preload 都不执行**——`window.dshDesktop` 与顶部菜单会一起消失，而主进程收不到任何错误。
 * 本仓库里其它 preload（`titlebar.ts` / `panel.ts` / `preload.ts`）同样是自包含的，这里
 * 保持一致：顶部菜单的代码就写在本文件里（用一段醒目的分段注释标出边界）。
 */
import { contextBridge, ipcRenderer } from 'electron'

/**
 * preload 里的致命错误必须**能被看见**。
 *
 * 踩过一次：preload 在 `import` / 顶层求值阶段抛错时，Electron 只在渲染进程的 console 里留
 * 一行，`contextBridge.exposeInMainWorld` 根本没执行，于是页面里 `window.dshDesktop` 与顶部
 * 菜单**一起消失**——从主进程看只是"桥没注入"，很难定位。这里把它转成一条 IPC，主进程可以
 * 直接打到 stderr（诊断开关 `DSH_DESKTOP_PRELOAD_TRACE=1`）。
 * @param stage - 出错阶段。
 * @param error - 原始错误。
 */
function reportPreloadFailure(stage: string, error: unknown): void {
  try {
    ipcRenderer.send('dsh-desktop:preload-error', {
      stage,
      message: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
    })
  } catch {
    // 连 IPC 都不可用：无能为力，但至少不要因为报告失败再抛一次。
  }
}

process.on('uncaughtException', (error) => reportPreloadFailure('uncaughtException', error))
process.on('unhandledRejection', (reason) => reportPreloadFailure('unhandledRejection', reason))

/**
 * 记录**页面自己**的未捕获错误与未处理的 promise 拒绝。
 *
 * 为什么 preload 的 `process.on('uncaughtException')` 不够：Harness 的 Web 代码跑在页面世界
 * （main world），它抛出的异常**不会**进 preload 的进程级 handler；而白屏最常见的原因就是
 * "React 在 mount 时抛了一个没人接的异常"。这里补上那一半。
 *
 * 只记录、不改行为：不 `preventDefault()`、不返回 `true`、不动 `event.error`，因此不会改变
 * 页面的错误传播语义。1.7.9 白屏时主进程一无所知，就是缺这一段。
 */
function watchPageErrors(): void {
  window.addEventListener(
    'error',
    (event) => {
      try {
        const target = event.target
        // 资源加载失败（<script>/<link>）走的是同一条事件，但 detail 不同。
        if (target !== null && target !== window && target instanceof HTMLElement) {
          const source = target.getAttribute('src') ?? target.getAttribute('href') ?? ''
          reportPreloadFailure('resource-error', `${target.tagName} ${source.slice(0, 200)}`)
          return
        }
        reportPreloadFailure(
          'page-error',
          `${event.message} @ ${event.filename}:${String(event.lineno)}:${String(event.colno)}` +
            (event.error instanceof Error ? `\n${event.error.stack ?? ''}` : ''),
        )
      } catch {
        // 记录失败不能引发新的异常。
      }
    },
    true,
  )
  window.addEventListener('unhandledrejection', (event) => {
    try {
      const reason = event.reason
      reportPreloadFailure(
        'unhandledrejection',
        reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason).slice(0, 500),
      )
    } catch {
      // 同上。
    }
  })
}

/**
 * 安全模式：**只用于诊断**，不是产品逻辑。
 *
 * `DSH_DESKTOP_SAFE_RENDERER=1` 时关掉外壳加在渲染进程上的一切附加行为（主题同步、顶部菜单
 * 挂载），只保留 Harness 自己。目的在于把"白屏到底来自 Harness 还是来自桌面扩展"一次性分开：
 *
 * ```text
 * 安全模式能显示  → 问题在桌面扩展（菜单挂载 / 主题同步）
 * 安全模式仍白屏  → 问题在 Harness / Host / Runtime
 * ```
 *
 * 它不影响关键路径、Host 与 single renderer 结构，因此不会掩盖真正的问题。
 * @returns 是否处于安全模式。
 */
function safeMode(): boolean {
  return process.env.DSH_DESKTOP_SAFE_RENDERER === '1'
}

// 页面错误记录在安全模式下也保留：它只读不写，而且正是白屏时最需要的信息。
watchPageErrors()

// 顶层冒烟标记：preload 到底有没有被求值。
//
// 存在的理由很具体：曾出现过"页面里 `window.dshDesktop` 与顶部菜单一起消失、而主进程什么
// 错误都收不到"的情形——只靠错误上报无法区分"preload 没被加载"与"preload 跑到一半抛错"。
// `DSH_DESKTOP_PRELOAD_TRACE=1` 时**同步写文件**（那一刻 IPC 桥本身可能都还没建立）。
try {
  if (process.env.DSH_DESKTOP_PRELOAD_TRACE === '1') {
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    fs.appendFileSync(
      path.join(process.env.DSH_DESKTOP_HOME ?? process.cwd(), 'preload-trace.log'),
      `[preload] loaded electron=${process.versions.electron ?? '?'}\n`,
    )
  }
} catch {
  // 诊断写不进去不影响任何功能。
}

/** Theme tokens forwarded to the main process (CSS-ready values). */
interface ThemePayload {
  bg?: string
  fg?: string
  fgDim?: string
  hover?: string
  active?: string
  border?: string
  dark?: boolean
}

/** Title-bar / window state pushed by the main process (used by the splash stage). */
export interface ShellState {
  platform: string
  height: number
  custom: boolean
  menus: boolean
  ready: boolean
  maximized: boolean
  fullScreen: boolean
  theme: ThemePayload
  locale: string
  menuRevision: number
}

interface ShellMenuBarEntry {
  index: number
  label: string
}

// ---------------------------------------------------------------- 阶段一：启动底板 ----
const shell = {
  getState: (): Promise<ShellState> => ipcRenderer.invoke('dsh-desktop:shell-state') as Promise<ShellState>,
  getMenu: (): Promise<ShellMenuBarEntry[]> =>
    ipcRenderer.invoke('dsh-desktop:shell-menu') as Promise<ShellMenuBarEntry[]>,
  openMenu: (index: number, x: number, y: number): Promise<void> =>
    ipcRenderer.invoke('dsh-desktop:shell-menu-open', index, x, y) as Promise<void>,
  focusApp: (): Promise<void> => ipcRenderer.invoke('dsh-desktop:shell-focus-app') as Promise<void>,
  onState: (listener: (state: ShellState) => void): void => {
    ipcRenderer.on('dsh-desktop:shell-state', (_event, state: ShellState) => listener(state))
  },
  onSplash: (listener: (text: string) => void): void => {
    ipcRenderer.on('dsh-desktop:shell-splash', (_event, text: string) => listener(text))
  },
}

// ------------------------------------------------------------ 阶段二：Harness 页面 ----

/** 顶部 strip 的填充色 token。Harness 的 `AppFrame::before` 与侧栏都用它。 */
const SIDEBAR_FILL_TOKEN = '--dsw-specific-sidebar-fill'

/** caption 按钮符号色 token。 */
const LABEL_PRIMARY_TOKEN = '--dsw-alias-label-primary'

/**
 * 把任意 CSS 颜色转成原生 `rgba(r, g, b, a)` 字符串。
 *
 * 为什么要过一遍 canvas：`setTitleBarOverlay` 只接受**不透明**的 `#rrggbb` 或 `#aarrggbb`，
 * 而 token 解析出来可能是 `oklch(...)`、`color-mix(...)`、带 alpha 的写法或 `rgb()`。浏览器
 * 自己最清楚这些怎么算成 sRGB，让它画一个 1×1 像素再读回来，比在外壳里重写一套颜色解析可靠。
 *
 * 与官方 `preload-windows.ts` 的 `nativeColor()` 同一做法。
 * @param color - 任意 CSS 颜色文本。
 * @returns `rgba(...)` 字符串；无法解析时 undefined。
 */
/**
 * 把任意 CSS 颜色转成原生 `rgba(r, g, b, a)` 字符串。
 *
 * 为什么要过一遍 canvas：`setTitleBarOverlay` 只接受**不透明**的 `#rrggbb`（或 `#aarrggbb`），
 * 而主题里的颜色可能是 `oklch(...)`、`color-mix(...)`、`color(srgb …)`、`rgb()` 或带 alpha 的
 * 写法。浏览器自己最清楚这些怎么算成 sRGB：让它画一个 1×1 像素再读回来，比在外壳里重写一套
 * 颜色解析可靠。与官方 `preload-windows.ts` 的 `nativeColor()` 同一做法。
 *
 * **注意它在当前实现里的调用频率**：只有 {@link readTheme} 在上报主题时调用，而主题上报是
 * 事件驱动 + 有限补发的（见 {@link publishTheme}），不是循环探测。因此这里每帧最多创建一个
 * 1×1 的临时 canvas，用完即弃，不会在 Harness 启动期间反复做重活。
 *
 * @param color - 任意 CSS 颜色文本。
 * @returns `rgba(...)` 字符串；无法解析时 undefined。
 */
function nativeColor(color: string): string | undefined {
  if (color === '') return undefined
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (context === null) return undefined
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data
    return `rgba(${red}, ${green}, ${blue}, ${Number(alpha) / 255})`
  } catch {
    return undefined
  }
}

/**
 * 读取官方 UI 已解析的主题令牌。
 *
 * ## 关键：顶部 strip 的底色必须来自**同一个 token**
 *
 * 顶部那一条 40px 有两个来源，必须同色：
 *   1. **渲染进程**画的 strip —— Harness 的 `[data-windows-titlebar] .frame::before` 用的是
 *      `background: var(--dsw-specific-sidebar-fill)`；
 *   2. **原生** caption buttons 那一块 —— 由 `titleBarOverlay.color` 画。
 *
 * 以前这里报的是 `body` 的 `background-color`（也就是 `--dsw-alias-bg-base`），而 strip 用的是
 * `--dsw-specific-sidebar-fill`。这两个 token 在浅色主题下**不是同一个值**，于是右上角原生按钮
 * 区域比左边更白——正是被反馈的那块矩形。
 *
 * 现在与官方一致：用一个不可见的 probe 元素让浏览器把 token 解析成真实颜色，两侧同源。
 *
 * @returns 主题载荷（解析不出的项省略）。
 */
/**
 * 读取官方 UI 已解析的主题令牌。
 *
 * ## 关键：顶部 strip 的底色必须来自**同一个 token**
 *
 * 顶部那一条 40px 有两个来源，必须同色：
 *   1. **渲染进程**画的 strip —— Harness 的 `[data-windows-titlebar] .frame::before` 用的是
 *      `background: var(--dsw-specific-sidebar-fill)`；
 *   2. **原生** caption buttons 那一块 —— 由 `titleBarOverlay.color` 画。
 *
 * 以前这里报的是 `body` 的 `background-color`（`--dsw-alias-bg-base`），而 strip 用的是
 * `--dsw-specific-sidebar-fill`。浅色下两者是 `rgb(249,250,251)` 与 `rgb(255,255,255)`，于是
 * 右上角偏白。现在读的就是 strip 用的那一个 token。
 *
 * ## 为什么不再挂 DOM probe
 *
 * 1.7.9 的实现会在每次上报时 `append` 一个 `<span>`、读 computed style、再 `remove`，并用
 * retry 循环反复做。它**读到的颜色是对的**，但形态太重，而且当时无法排除它对启动的干扰——
 * 白屏是 P0，而标题栏颜色晚 100–300ms 没有任何影响。
 *
 * 现在分两路，都是**只读、轻量、同步**：
 *   * 优先读 **AppFrame 实际画出来的** `::before` 背景色——那正是浏览器已经绘制的顶部 strip，
 *     不需要猜 token 声明在哪一层；
 *   * AppFrame 还没出现时退回读 token 值本身（实测声明在 `body` 上）。
 *
 * @returns 主题载荷（读不到实色时省略 `bg`，由 {@link publishTheme} 决定要不要补发）。
 */
function readTheme(): ThemePayload {
  const body = document.body
  if (body === null) return {}
  const bodyStyle = getComputedStyle(body)
  const token = (name: string): string | undefined => {
    const value = bodyStyle.getPropertyValue(name).trim()
    return value === '' ? undefined : value
  }
  const darkened =
    body.hasAttribute('data-ds-dark-theme') || window.matchMedia('(prefers-color-scheme: dark)').matches

  /**
   * 顶部 strip 的真实底色。
   *
   * `getComputedStyle(frame, '::before')` 给出的是**已经画出来的**那一条的颜色，因此不需要关心
   * `--dsw-specific-sidebar-fill` 究竟声明在 `:root` / `body` / 组件里。
   */
  const paintedStrip = (): string | undefined => {
    try {
      const frame = document.querySelector('[class*=frame]')
      if (frame === null) return undefined
      const pseudo = getComputedStyle(frame, '::before')
      return opaqueNative(nativeColor(pseudo.backgroundColor))
    } catch {
      return undefined
    }
  }
  const fill = paintedStrip() ?? opaqueNative(nativeColor(token(SIDEBAR_FILL_TOKEN) ?? ''))
  const label = nativeColor(token(LABEL_PRIMARY_TOKEN) ?? '')

  return {
    // `bg` 就是顶部 strip 的底色：原生 overlay 与它同源，因此右上角不会再偏白。
    //
    // **读不到时省略**（而不是退回 `body` 背景）：退回就等于又回到"右上角偏白"的老 bug。
    ...(fill === undefined ? {} : { bg: fill }),
    ...(label === undefined ? {} : { fg: label }),
    fgDim: token('--dsw-alias-label-tertiary') ?? token('--dsw-alias-label-secondary'),
    hover: token('--dsw-alias-interactive-bg-hover'),
    active: token('--dsw-alias-interactive-bg-active') ?? token('--dsw-alias-interactive-bg-hover'),
    border: token('--dsw-alias-border-l1') ?? token('--dsw-alias-border-l2'),
    dark: darkened,
  }
}

/**
 * 判断一个原生颜色是不是**不透明**（因此可以拿去画标题栏）。
 *
 * `setTitleBarOverlay` 要的是实色；透明结果（`rgba(0, 0, 0, 0)`，也就是"probe 没取到色"）
 * 必须被识别出来，否则会被当成黑色报上去，右上角又是错的。
 *
 * Chromium 对**不透明**颜色会算成 `rgb(r, g, b)`（没有 alpha 段），对半透明才算
 * `rgba(r, g, b, a)`——两种形状都要认，否则会把实色误判为"没取到"。
 *
 * @param color - {@link nativeColor} 的返回值。
 * @returns 不透明时返回原值，否则 undefined。
 */
function opaqueNative(color: string | undefined): string | undefined {
  if (color === undefined) return undefined
  const match = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/u.exec(color)
  if (match === null) return undefined
  const alpha = match[4]
  return alpha === undefined || Number(alpha) > 0 ? color : undefined
}

/** 主题上报的补发间隔（毫秒）。 */
const THEME_RETRY_INTERVAL_MS = 500

/**
 * 补发次数上限。
 *
 * **刻意很小**：补发只用来覆盖"窗口刚起来、Harness 还没画第一帧"这一小段。它不再是一个能跑
 * 几十秒的循环——那是 1.7.9 的形态，而白屏是 P0、标题栏颜色晚几百毫秒无所谓。AppFrame 一出现，
 * `readTheme()` 就优先读它**已经画出来的** `::before`，因此正常情况下第一次或第二次就成功。
 */
const THEME_RETRY_LIMIT = 12

/** 是否已经上报过一次"真正读到实色"的主题。 */
let themeSettled = false
/** 补发计时器。 */
let themeRetry: ReturnType<typeof setTimeout> | undefined
/** 已经尝试过多少次上报。 */
let themeAttempts = 0

/**
 * 上报主题；绝不向宿主页面抛错。
 *
 * ## 关键路径原则
 *
 * 颜色同步**只能 fire-and-forget**：它不出现在 Harness boot、窗口显示、Host ready 这些关键路径
 * 上，也没有任何 `await theme…`。整个函数同步执行、全部 try/catch，最坏情况就是这一帧的颜色没
 * 上报成功，等下一次触发。
 *
 * ## 读不到实色时怎么办
 *
 * 直接 `return`，保留窗口创建时的系统深浅色兜底（见 `src/main/titlebar.ts`）。**绝不**为了"凑出
 * 一个颜色"去做重活，也绝不把透明色当成黑色报上去。AppFrame mount 之后（或主题变化时）自然会
 * 再补一次。
 */
function publishTheme(): void {
  let theme: ThemePayload
  try {
    theme = readTheme()
  } catch {
    theme = {}
  }
  themeAttempts += 1

  if (theme.bg === undefined) {
    // 还没读到实色：不覆盖当前 overlay，有限次数补发后放弃（等下一次事件触发）。
    if (!themeSettled && themeRetry === undefined && themeAttempts < THEME_RETRY_LIMIT) {
      themeRetry = setTimeout(() => {
        themeRetry = undefined
        publishTheme()
      }, THEME_RETRY_INTERVAL_MS)
    }
    return
  }

  themeSettled = true
  if (themeRetry !== undefined) {
    clearTimeout(themeRetry)
    themeRetry = undefined
  }
  try {
    tracePreload(`publishTheme bg=${String(theme.bg)} fg=${String(theme.fg)} attempts=${String(themeAttempts)}`)
    ipcRenderer.send('dsh-desktop:app-theme', theme)
  } catch {
    // 主题上报是尽力而为。
  }
}

/**
 * 把当前主题再上报一次。
 *
 * 存在的理由：这条链路跨两个进程、四段（probe 取色 → canvas 转 native → IPC →
 * `setTitleBarOverlay`），把它暴露成一个显式方法，排查时就能在页面里直接驱动它，而不必去猜
 * "是这一侧没发，还是主进程没收到"。
 *
 * 它不做任何额外的事——只是 `publishTheme()` 的别名，因此不存在"测试专用路径"。
 */
function flushTheme(): void {
  publishTheme()
}

/**
 * 开始跟踪主题变化。
 *
 * 两个触发源都必要：应用可以在系统外观不变的情况下切换主题（设置里），系统外观也可以在
 * 页面的属性不变的情况下变化（跟随系统）。
 *
 * ## 关键路径原则（1.7.9 白屏回归的教训）
 *
 * 颜色同步**只能 fire-and-forget**：它不得出现在 Harness boot、窗口显示、Host ready 这些
 * 关键路径上，也不得为了"还没拿到正确 caption 色"而反复做重活。标题栏颜色晚 100–300ms 对用户
 * 没有影响，而 Harness 白屏是 P0。
 *
 * 因此这里的策略是：
 *   * 每个触发点都调 `publishTheme()`，但它**从不抛错、从不阻塞**（内部全 try/catch）；
 *   * 补发只在"还没读到实色"时进行，且用的是 `setTimeout` 而不是忙等；
 *   * 拖拽/主题变化等高频触发由 observ**er 合并**（同一个 tick 内多次变化只发一次）。
 */
function watchTheme(): void {
  publishTheme()
  const send = (): void => publishTheme()
  document.addEventListener('DOMContentLoaded', send, { once: true })
  window.addEventListener('load', send, { once: true })
  try {
    // 观察器只报告"属性变了"，不做重活；`publishTheme` 自己会判断该不该继续补发。
    const observer = new MutationObserver(() => send())
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-ds-dark-theme', 'class', 'style'],
    })
    observer.observe(document.body ?? document.documentElement, {
      attributes: true,
      attributeFilter: ['data-ds-dark-theme', 'class', 'style'],
    })
  } catch {
    // 观察器只是优化：上面那几次一次性上报已经覆盖启动期。
  }
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', send)
}

// 主题同步是**附加行为**：安全模式下完全不启动它（见 safeMode 的说明）。
if (!safeMode()) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watchTheme, { once: true })
  } else {
    watchTheme()
  }
}

// =====================================================================================
// 顶部菜单（Caption Menu）
//
// 单 renderer 架构下窗口里只有 Harness 一个文档，窗口自身的页面（旧的 shell-page.ts）不再
// 存在，而 Windows 原生菜单栏又被刻意隐藏（否则会出现两行菜单）。因此"文件/编辑/视图/更新/
// 帮助"这一行必须画在 **Harness 自己的文档** 里：下面这段代码挂一个 Shadow DOM host，只提供
// 五个触发器，子菜单仍然是主进程里那份唯一的原生 Application Menu。
//
// ```text
// document.body
//   ├─ Harness React Root
//   └─ <div data-dsh-desktop-menu>      ← 本段代码挂的 host
//        └─ #shadow-root (open)
//             └─ .bar > button × 5
// ```
//
// 三条硬约束都由这个结构保证：不新增 WebContents（只是一个 host 元素）；不引入第二套设计
// 系统（颜色/字体/hover 全用 Harness 的 `--dsw-*` token，host 自己不画背景）；不复制菜单
// 业务（点击只报"哪个顶层下标 + 什么坐标"，见 src/main/menu.ts 的 openMenuAt()）。
//
// **这一段必须留在本文件里，不能拆成相对 import**：沙箱化的 preload 无法 `require` 相对路径
// 的文件，`require('./caption-menu')` 会让整个 preload 加载失败（`window.dshDesktop` 与顶部
// 菜单会一起消失，而主进程收不到任何错误）。本仓库其它 preload 同样自包含。
// =====================================================================================

/** `menuBarEntries()` 的一项。 */
interface MenuBarEntry {
  index: number
  label: string
}

/** 主进程推来的状态里，菜单关心的字段。 */
interface MenuShellState {
  /** 标题栏高度（CSS px），与原生 caption buttons 的 `titleBarOverlay.height` 一致。 */
  height?: number
  /** 是否在窗口内显示菜单（macOS 的菜单在系统菜单栏，这里为 false）。 */
  menus?: boolean
  /** 当前语言（变化时要重新取标题）。 */
  locale?: string
  /** 原生菜单的版本号（每次重建递增）。 */
  menuRevision?: number
}

/** host 上的标记属性；测试与诊断脚本靠它找菜单。 */
const MENU_HOST_ATTRIBUTE = 'data-dsh-desktop-menu'

/** 标题栏高度（CSS px）。必须与 `titleBarOverlay.height`（`src/main/titlebar.ts`）一致。 */
const WINDOWS_TITLEBAR_HEIGHT = 40

/** 官方标记属性：Harness 前端据此切换到 Windows Desktop 布局。 */
const WINDOWS_TITLEBAR_ATTRIBUTE = 'data-windows-titlebar'

/** 标题栏高度交给 Harness 的 CSS 变量名（与官方 `preload-windows.ts` 同名）。 */
const WINDOWS_TITLEBAR_HEIGHT_VARIABLE = '--dsh-windows-titlebar-height'

/**
 * 打开 Windows Desktop 的标题栏模式。
 *
 * ## 为什么只有几行代码，却决定了整个左上角布局
 *
 * Harness 前端的 `ui-layout` / `ui-sidebar` / `ui-sidebar-right` **已经完整实现**了 Windows
 * Desktop 布局（已核对本仓库 Runtime 里打包的那份），但它们是靠这个标记切换的：
 *
 * ```text
 * [data-windows-titlebar] .frame                 padding-top 40px，背景换 --dsw-specific-sidebar-fill
 * [data-windows-titlebar] .frame::before         顶部那一条统一背景 + -webkit-app-region:drag
 * [data-windows-titlebar] .logoRow               height:40px —— Logo 因此落在标题栏**下方**
 * [data-windows-titlebar] .toggle                position:fixed; left:12px; 垂直居中于标题栏
 * [data-windows-titlebar] .collapsed .newSession fixed; left:48px
 * html[data-windows-titlebar]:has([data-sidebar-collapsed=true])  --dsh-windows-menu-start:84px
 * ```
 *
 * 也就是说：**Logo 该下移多少、折叠按钮钉在哪、菜单从哪个 x 开始**，Harness 自己都写好了，
 * 并且通过 `--dsh-windows-menu-start`（展开时不存在、回退 48px；收起时 84px）对外发布这个
 * 契约。外壳只需要在 preload 阶段把标记打上——**不要**去量侧栏宽度再摆菜单位置，那正是
 * "看起来还是浏览器版 Sidebar"的原因。
 *
 * ## 必须尽早打
 *
 * 官方 `preload-windows.ts` 在文档还是 `loading` 时先 mark 一次，`DOMContentLoaded` 再补一次
 * （解析器建出 `documentElement` 之前它可能不存在）。这里照做，Harness 首帧就是 Desktop 布局，
 * 不会先闪一下浏览器版布局。
 */
function enableWindowsTitlebar(): void {
  if (process.platform !== 'win32') return
  // 两层结构下不打这个标记：那时 Harness 上方还有外壳自绘的 40px 标题栏，Harness 再自己留一条
  // 40px 就变成 80px 空白。标记由主进程通过环境变量告知（渲染进程无从判断窗口里有几个文档）。
  if (process.env.DSH_DESKTOP_SINGLE_RENDERER !== '1') return
  const mark = (): void => {
    const root = document.documentElement
    if (root === null) return
    root.setAttribute(WINDOWS_TITLEBAR_ATTRIBUTE, '')
    root.style.setProperty(WINDOWS_TITLEBAR_HEIGHT_VARIABLE, `${WINDOWS_TITLEBAR_HEIGHT}px`)
  }
  if (document.documentElement !== null) mark()
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mark, { once: true })
  }
}

enableWindowsTitlebar()

/**
 * 诊断写盘：`DSH_DESKTOP_PRELOAD_TRACE=1` 时把一行记录追加到 harness home 下的
 * `preload-trace.log`。
 *
 * 用**同步写文件**而不是 stderr / console：preload 里那两种输出要么被沙箱吞掉、要么只在渲染
 * 进程的 DevTools 里可见，而排障时最需要知道的是"它到底跑到哪一步了"。
 * @param message - 记录内容。
 */
function tracePreload(message: string): void {
  if (process.env.DSH_DESKTOP_PRELOAD_TRACE !== '1') return
  try {
    require('node:fs').appendFileSync(
      require('node:path').join(process.env.DSH_DESKTOP_HOME ?? process.cwd(), 'preload-trace.log'),
      `[preload] ${message}\n`,
    )
  } catch {
    // 诊断写不进去不影响任何功能。
  }
}

tracePreload(`evaluated singleRenderer=${String(process.env.DSH_DESKTOP_SINGLE_RENDERER)} readyState=${document.readyState}`)

/** 字体栈的最后兜底（Harness 一定会提供 `--dsw-font-family`，这里只防它还没生效）。 */
const FALLBACK_FONT = 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif'

/**
 * 菜单 host 的样式。
 *
 * **与官方 `preload-menu.ts` 逐条对齐**（高度 28 / 内边距 0 10px / 圆角 6px / 字号 14px /
 * hover 与 aria-expanded 用同一组 token / `:focus-visible` 的 2px + offset -2px），这样顶部这
 * 一行看起来就是 Harness 自己的控件，而不是又一层外壳。
 *
 * 位置**只消费** `--dsh-windows-menu-start`：展开时它不存在（回退 48px），侧栏收起时 Harness
 * 会把它设成 84px。外壳不做任何"量侧栏宽度"的计算（需求第 21 条）。
 */
const CAPTION_MENU_STYLE = `
:host {
  position: fixed;
  top: 0;
  left: var(--dsh-windows-menu-start, 48px);
  z-index: 1100;
  height: var(--dsh-windows-titlebar-height, ${WINDOWS_TITLEBAR_HEIGHT}px);
  display: flex;
  align-items: center;
  font-family: var(--dsw-font-family, ${FALLBACK_FONT});
  -webkit-app-region: no-drag;
}
[role=menubar] { display: flex; gap: 2px; }
button {
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary));
  font: inherit;
  font-size: 14px;
  cursor: default;
  white-space: nowrap;
}
button:hover,
button[aria-expanded=true] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
button:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-label-primary));
  outline-offset: -2px;
}
:host-context(html[data-input-modality='pointer']) button:focus-visible { outline-color: transparent; }
`

/**
 * 记住"刚刚失去焦点的那个编辑器"及其选区，供菜单关闭后恢复。
 *
 * ## 为什么用 `focusout` 委托，而不是在点击菜单时读 `document.activeElement`
 *
 * 原生菜单弹出时会**抢走焦点**，而 `focusout` 正好在那一刻触发（焦点还在原来的编辑器上）。
 * 在点击处理里读 `document.activeElement` 则要依赖"按钮不抢焦点"这一条成立——两处条件叠加
 * 才偶然正确。官方 `preload-menu.ts` 用的就是这个委托方式，这里对齐它。
 *
 * `contenteditable`（Harness 的 Composer）没有 `selectionStart`，选区只能走 `document.getSelection()`
 * 的 Range，因此这里把 Range 也一起克隆保存。
 */
let restoreEditor: () => void = () => {}

function rememberEditor(event: FocusEvent): void {
  const target = event.composedPath()[0]
  if (!(target instanceof HTMLElement)) return
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement) && !target.matches('[contenteditable="true"]')) {
    return
  }
  const selection = document.getSelection()
  const ranges =
    selection === null ? [] : Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
  const input = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : undefined
  const start = input?.selectionStart
  const end = input?.selectionEnd
  const direction = input?.selectionDirection
  restoreEditor = (): void => {
    if (!target.isConnected) return
    try {
      target.focus({ preventScroll: true })
      if (input !== undefined && start !== null && start !== undefined && end !== null && end !== undefined) {
        input.setSelectionRange(start, end, direction ?? undefined)
      } else if (selection !== null && ranges.length > 0) {
        selection.removeAllRanges()
        for (const range of ranges) selection.addRange(range)
      }
    } catch {
      // 元素在菜单打开期间被卸载（例如会话切换）：忽略。
    }
  }
}

document.addEventListener('focusout', rememberEditor, true)

/**
 * 把 Caption Menu 挂到当前文档。
 *
 * 幂等：同一个文档里只挂一个 host。返回卸载函数（本应用不主动卸载，但让它可以被测试调用）。
 *
 * **位置完全交给 CSS**：`left: var(--dsh-windows-menu-start, 48px)`，这个变量由 Harness 的
 * `ui-sidebar` 在侧栏收起时设成 84px。这里不做任何"量侧栏宽度"的计算。
 *
 * @returns 卸载函数。
 */
function mountCaptionMenu(): () => void {
  if (document.querySelector(`[${MENU_HOST_ATTRIBUTE}]`) !== null) return () => {}

  const host = document.createElement('div')
  host.setAttribute(MENU_HOST_ATTRIBUTE, '')
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = CAPTION_MENU_STYLE
  const bar = document.createElement('div')
  bar.setAttribute('role', 'menubar')
  shadow.append(style, bar)
  // 挂在 body 末尾：Harness 的 React root 在它自己的容器里，菜单作为兄弟节点存在，不会被它的
  // 重渲染带走。
  document.body.append(host)

  let buttons: HTMLButtonElement[] = []
  let openIndex: number | undefined
  let disposed = false

  /**
   * 应用状态里的可见性。
   *
   * 高度与位置**不在这里设**：它们由 `--dsh-windows-titlebar-height`（预加载阶段就打上的官方
   * 标记）与 `--dsh-windows-menu-start`（Harness 自己发布）两个 CSS 变量决定，也就是需求第 21
   * 条那条"完全解耦"的契约。外壳越少参与布局，越不会退回"浏览器版 Sidebar"。
   */
  const applyState = (state: MenuShellState): void => {
    if (disposed) return
    // `menus === false`（macOS）时不画：那里的菜单应该在系统菜单栏。
    //
    // **不看 `ready`**：菜单是标题栏的一部分，应当与侧栏同一帧出现。
    if (state.menus !== false) host.setAttribute('data-visible', '')
    else host.removeAttribute('data-visible')
  }

  /** 重新取一次标题并重建按钮（语言变化 / 菜单重建后调用）。 */
  const refresh = async (): Promise<void> => {
    if (disposed) return
    let entries: MenuBarEntry[] = []
    try {
      entries = (await ipcRenderer.invoke('dsh-desktop:shell-menu')) as MenuBarEntry[]
    } catch {
      entries = []
    }
    if (disposed) return
    bar.textContent = ''
    if (process.env.DSH_DESKTOP_PRELOAD_TRACE === '1') {
      // 诊断：菜单标题到底有没有被重新取到（语言切换 / 菜单重建时用）。
      try {
        require('node:fs').appendFileSync(
          require('node:path').join(process.env.DSH_DESKTOP_HOME ?? process.cwd(), 'preload-trace.log'),
          `[preload] menu labels = ${JSON.stringify(entries.map((entry) => entry.label))}\n`,
        )
      } catch {
        // 诊断写不进去无所谓。
      }
    }
    buttons = entries.map((entry) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = entry.label
      button.setAttribute('role', 'menuitem')
      button.setAttribute('aria-haspopup', 'menu')
      button.setAttribute('aria-expanded', 'false')
      // **不抢焦点**：`pointerdown` / `mousedown` 上 preventDefault，点击后 Harness 的 Composer
      // 仍然是 `document.activeElement`。否则"点编辑 → 粘贴"会因为焦点跑到按钮上而失败。
      button.addEventListener('pointerdown', (event) => event.preventDefault())
      button.addEventListener('mousedown', (event) => event.preventDefault())
      button.addEventListener('click', () => {
        void toggle(entry.index, button)
      })
      bar.append(button)
      return button
    })
  }

  /**
   * 打开某个顶层菜单，关闭后把焦点还给编辑器。
   * @param index - 原生菜单顶层下标。
   * @param button - 对应按钮（取弹出坐标与 `aria-expanded`）。
   */
  const toggle = async (index: number, button: HTMLButtonElement): Promise<void> => {
    if (openIndex === index) return
    const rect = button.getBoundingClientRect()
    for (const other of buttons) other.setAttribute('aria-expanded', 'false')
    button.setAttribute('aria-expanded', 'true')
    openIndex = index
    try {
      // 与旧的 shell-page 走**同一条** IPC：顶层下标 + 窗口客户区坐标。子菜单仍然是那份
      // 唯一的原生 Application Menu（主进程侧 openMenuAt()）。
      await ipcRenderer.invoke('dsh-desktop:shell-menu-open', index, Math.round(rect.left), Math.round(rect.bottom))
    } catch {
      // 主进程没弹出（例如菜单被重建过）：下面统一复位。
    }
    openIndex = undefined
    for (const other of buttons) other.setAttribute('aria-expanded', 'false')
    try {
      await ipcRenderer.invoke('dsh-desktop:shell-focus-app')
    } catch {
      // 焦点交回失败不影响功能：下面的 restoreEditor 还会再试一次。
    }
    restoreEditor()
  }

  // 注意：**没有 resize 监听**。菜单位置不依赖窗口尺寸，也不依赖侧栏几何——侧栏收起时
  // Harness 会把 `--dsh-windows-menu-start` 改成 84px，CSS 自己就会重排。

  // 初次立即拉一次状态（推送可能还没到，否则菜单要等一次推送才出现）。
  void ipcRenderer
    .invoke('dsh-desktop:shell-state')
    .then((state: MenuShellState) => applyState(state))
    .catch(() => {})
  ipcRenderer.on('dsh-desktop:shell-state', (_event, state: MenuShellState) => {
    applyState(state)
    void refresh()
  })
  void refresh()

  return () => {
    disposed = true
    host.remove()
  }
}

/** 挂菜单；失败只记录，绝不影响 Harness（快捷键在主进程侧，仍然可用）。 */
function startCaptionMenu(): void {
  if (safeMode()) return
  try {
    mountCaptionMenu()
  } catch (error) {
    reportPreloadFailure('caption-menu', error)
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startCaptionMenu, { once: true })
} else {
  startCaptionMenu()
}

const api = {
  /** 启动底板阶段的那组能力（`window.dshTitlebar`）。 */
  shell,
  /**
   * 把当前主题再上报一次（诊断 / 测试用）。
   *
   * 见 {@link flushTheme}：它是 `publishTheme()` 的别名，不改变任何行为——只是让"读 token →
   * 转原生颜色 → 发 IPC → setTitleBarOverlay"这条跨进程链路可以被逐步断言。
   */
  flushTheme,
  /** Version of the Electron shell. */
  shellVersion: process.env.DSH_DESKTOP_SHELL_VERSION ?? '0.0.0',
  /** Version of the bundled dsh runtime serving this window. */
  runtimeVersion: process.env.DSH_DESKTOP_RUNTIME_VERSION ?? 'unknown',
  /** 在系统浏览器里打开外部 URL。 */
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke('dsh-desktop:open-external', url) as Promise<void>,
  /**
   * 上报 Harness 当前所在的**工作区**（当前会话的 cwd）。
   *
   * 这里只做**形状归一化**，不做信任：真正的校验在主进程（类型、绝对路径、目录是否存在、
   * 是否属于 Harness 已注册的工作区）。
   *
   * @param payload - `{ path, workspaceId? }`；`path: null` 表示此刻没有当前会话。
   */
  reportActiveWorkspace: (payload: { path: string | null; workspaceId?: string }): void => {
    const path = payload?.path
    ipcRenderer.send('dsh-desktop:active-workspace', {
      path: typeof path === 'string' && path !== '' ? path : null,
      ...(typeof payload?.workspaceId === 'string' && payload.workspaceId !== ''
        ? { workspaceId: payload.workspaceId }
        : {}),
    })
  },
  /**
   * 上报 Harness **当前生效的语言**（官方 locale runtime 的 `active`）。
   *
   * 冷启动时外壳只能读 `<harness home>/settings.yaml`，那份文件在"用户从没选过语言"与
   * "语言由语言包注册"两种情况下都给不出答案，因此必须由 Harness 自己在运行期告诉外壳。
   *
   * @param locale - Harness 官方 locale runtime 的当前 locale id。
   */
  reportLocale: (locale: string): void => {
    if (typeof locale !== 'string' || locale === '') return
    ipcRenderer.send('dsh-desktop:shell-locale', locale)
  },
}

// 旧名保留：窗口实现（`window.ts`）与既有窗口级测试都在用它。
contextBridge.exposeInMainWorld('dshTitlebar', shell)
// 单 renderer 架构下的正式名字：同一个桥在 Harness 阶段继续可用。
contextBridge.exposeInMainWorld('dshDesktop', api)

export type DshDesktopApi = typeof api
