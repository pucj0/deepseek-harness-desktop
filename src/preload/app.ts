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

/**
 * 读取官方 UI 已解析的主题令牌。
 *
 * `--dsw-alias-*` 声明在 `body`（浅色）与 `body[data-ds-dark-theme]`（深色）上，Chromium 在
 * computed-value 时替换 `var()`，因此拿回来的就是可用颜色。页面底色读真实颜色而不是令牌，
 * 这样原生 caption buttons 与**实际被绘制出来的**底色一致。
 * @returns 主题载荷（解析不出的项省略）。
 */
function readTheme(): ThemePayload {
  const body = document.body
  if (body === null) return {}
  const style = getComputedStyle(body)
  const token = (name: string): string | undefined => {
    const value = style.getPropertyValue(name).trim()
    return value === '' ? undefined : value
  }
  const darkened =
    body.hasAttribute('data-ds-dark-theme') || window.matchMedia('(prefers-color-scheme: dark)').matches
  return {
    bg: style.backgroundColor,
    fg: token('--dsw-alias-label-primary'),
    fgDim: token('--dsw-alias-label-tertiary') ?? token('--dsw-alias-label-secondary'),
    hover: token('--dsw-alias-interactive-bg-hover'),
    active: token('--dsw-alias-interactive-bg-active') ?? token('--dsw-alias-interactive-bg-hover'),
    border: token('--dsw-alias-border-l1') ?? token('--dsw-alias-border-l2'),
    dark: darkened,
  }
}

/** 上报主题；绝不向宿主页面抛错。 */
function publishTheme(): void {
  try {
    ipcRenderer.send('dsh-desktop:app-theme', readTheme())
  } catch {
    // 主题上报是尽力而为：读不到时主进程退回系统深浅色。
  }
}

/**
 * 开始跟踪主题变化。
 *
 * 两个触发源都必要：应用可以在系统外观不变的情况下切换主题（设置里），系统外观也可以在
 * 页面的属性不变的情况下变化（跟随系统）。
 */
function watchTheme(): void {
  publishTheme()
  const send = (): void => publishTheme()
  document.addEventListener('DOMContentLoaded', send, { once: true })
  window.addEventListener('load', send, { once: true })
  try {
    new MutationObserver(send).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-ds-dark-theme', 'class', 'style'],
    })
    new MutationObserver(send).observe(document.body ?? document.documentElement, {
      attributes: true,
      attributeFilter: ['data-ds-dark-theme', 'class', 'style'],
    })
  } catch {
    // 观察器只是优化：上面那几次一次性上报已经覆盖启动期。
  }
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', send)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', watchTheme, { once: true })
} else {
  watchTheme()
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

/** 记住的编辑器焦点。 */
interface RememberedEditor {
  element: HTMLElement
  start: number | null
  end: number | null
}

/** host 上的标记属性；测试与诊断脚本靠它找菜单。 */
const MENU_HOST_ATTRIBUTE = 'data-dsh-desktop-menu'

/** 字体栈的最后兜底（Harness 一定会提供 `--dsw-font-family`，这里只防它还没生效）。 */
const FALLBACK_FONT = 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif'

/** 菜单 host 的样式（全部在 Shadow Root 内，因此不会与 Harness 的全局 CSS 互相污染）。 */
const CAPTION_MENU_STYLE = `
:host {
  position: fixed;
  top: 0;
  left: var(--dsh-caption-menu-start, 296px);
  // 右侧留出原生 caption buttons 的占地：env(titlebar-area-width) 就是"标题栏里不被系统
  // 按钮占用"的那段宽度（DPI 缩放与 100/125/150% 下都成立），因此不需要硬编码 138px。
  // 读不到时（非 Windows）退回视口宽度，菜单自然铺到右边缘。
  max-width: calc(env(titlebar-area-width, 100vw) - var(--dsh-caption-menu-start, 296px));
  height: var(--dsh-caption-menu-height, 40px);
  z-index: 1100;
  display: none;
  align-items: center;
  gap: 2px;
  /* 不画背景：透出 Harness 当前标题栏的底色。自己涂一条就等于又出现一层外壳。 */
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family, ${FALLBACK_FONT});
  font-size: 12px;
  line-height: 1;
  /* 菜单本身永远不能当拖拽区，否则点不动。 */
  -webkit-app-region: no-drag;
}
:host([data-visible]) { display: flex; }
.bar {
  display: flex;
  align-items: center;
  gap: 2px;
  /* 窗口太窄时宁可把最后几项裁掉，也不能压到最小化/最大化/关闭按钮上。 */
  min-width: 0;
  overflow: hidden;
}
button {
  height: 28px;
  padding: 0 9px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary));
  font: inherit;
  cursor: default;
  white-space: nowrap;
  -webkit-app-region: no-drag;
}
button:hover,
button[aria-expanded="true"] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
button:active,
button[aria-expanded="true"] {
  background: var(--dsw-alias-interactive-bg-active, var(--dsw-alias-interactive-bg-hover));
}
button:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-label-primary));
  outline-offset: -1px;
}
`

/**
 * 判断一个元素是不是可编辑控件。
 * @param node - 候选元素。
 * @returns 是否是输入框 / 文本域 / contenteditable。
 */
function isEditable(node: Element | null): node is HTMLElement {
  if (node === null || !(node instanceof HTMLElement)) return false
  const tag = node.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true
  return node.isContentEditable
}

/**
 * 记录当前编辑器焦点与选区。
 *
 * 返回 `undefined` 表示"焦点不在编辑器上"——那时恢复焦点是错的（用户可能正在看别处）。
 * @returns 记住的编辑器，或 undefined。
 */
function rememberEditor(): RememberedEditor | undefined {
  const active = document.activeElement
  if (!isEditable(active)) return undefined
  if (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') {
    const field = active as HTMLInputElement | HTMLTextAreaElement
    return { element: active, start: field.selectionStart, end: field.selectionEnd }
  }
  // contenteditable（Harness 的 Composer 用的就是它）：选区不在 selectionStart 上，
  // 恢复焦点本身会让浏览器把光标放回原处。
  return { element: active, start: null, end: null }
}

/**
 * 恢复编辑器焦点与选区。
 * @param remembered - {@link rememberEditor} 的返回值。
 */
function restoreEditor(remembered: RememberedEditor | undefined): void {
  if (remembered === undefined) return
  const { element, start, end } = remembered
  if (!element.isConnected) return
  try {
    element.focus({ preventScroll: true })
    if (start !== null && end !== null && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA')) {
      ;(element as HTMLInputElement | HTMLTextAreaElement).setSelectionRange(start, end)
    }
  } catch {
    // 元素在菜单打开期间被卸载（例如会话切换）：忽略。
  }
}

/**
 * 算出菜单应该从哪个 x 开始。
 *
 * 实测（Harness 0.2.0-rc.1 / 本仓库 1.7.7，1440×920）：
 *   * 侧栏列 `[class*=sidebarCol]` 占 `0..280`；
 *   * 侧栏底部的折叠按钮在 `240..268`（垂直居中于 `22..50`）；
 *   * 侧栏与内容区之间的拖拽把手 `[class*=handle][data-side=sidebar]` 在 `276..284`。
 *
 * 因此"侧栏右边缘 + 一点空隙"就是安全起点——而不是硬编码官方那个 48px。这里优先读真实 DOM
 * （侧栏宽度可由用户拖拽改变，也会随折叠状态改变），读不到时退回上面那个实测值。
 * @returns 起始 x（CSS px，窗口客户区坐标）。
 */
function captionMenuStart(): number {
  const fallback = 296
  try {
    const column = document.querySelector('[class*=sidebarCol]')
    if (column === null) return fallback
    const right = column.getBoundingClientRect().right
    if (!Number.isFinite(right) || right <= 0) return fallback
    return Math.round(right + 16)
  } catch {
    return fallback
  }
}

/**
 * 把 Caption Menu 挂到当前文档。
 *
 * 幂等：同一个文档里只挂一个 host。返回卸载函数（本应用不主动卸载，但让它可以被测试调用）。
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
  bar.className = 'bar'
  bar.setAttribute('role', 'menubar')
  shadow.append(style, bar)
  // 挂在 body 末尾：Harness 的 React root 通常在它自己的容器里，菜单作为兄弟节点存在，
  // 不会被它的重渲染带走。
  document.body.append(host)

  let buttons: HTMLButtonElement[] = []
  let remembered: RememberedEditor | undefined
  let openIndex: number | undefined
  let disposed = false

  /** 应用状态里的高度与可见性。 */
  const applyState = (state: MenuShellState): void => {
    if (disposed) return
    const height = typeof state.height === 'number' && state.height > 0 ? state.height : 40
    host.style.setProperty('--dsh-caption-menu-height', `${height}px`)
    host.style.setProperty('--dsh-caption-menu-start', `${captionMenuStart()}px`)
    // `menus === false`（macOS）时不画：那里的菜单应该在系统菜单栏。
    //
    // **不看 `ready`**：菜单是标题栏的一部分，应当与侧栏同一帧出现，等"界面就绪"只会让它
    // 姗姗来迟。
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
    buttons = entries.map((entry) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = entry.label
      // **不抢焦点**：`mousedown` 上 preventDefault，点击后 Harness 的 Composer 仍然是
      // `document.activeElement`。否则"点 Edit → Paste"会因为焦点已经跑到按钮上而失败。
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
    remembered = rememberEditor()
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
    restoreEditor(remembered)
  }

  // 窗口尺寸变化会改变侧栏宽度（用户拖拽 / 折叠），重新算一次落点。
  const onResize = (): void => {
    host.style.setProperty('--dsh-caption-menu-start', `${captionMenuStart()}px`)
  }
  window.addEventListener('resize', onResize)

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
    window.removeEventListener('resize', onResize)
    host.remove()
  }
}

/** 挂菜单；失败只记录，绝不影响 Harness（快捷键在主进程侧，仍然可用）。 */
function startCaptionMenu(): void {
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
