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
 */
import { contextBridge, ipcRenderer } from 'electron'

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
