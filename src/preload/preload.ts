/**
 * Preload bridge for the Harness page.
 *
 * The official Web UI needs nothing from us — it talks to the host over the
 * loopback HTTP/WebSocket surface. This bridge only exposes a tiny, explicitly
 * enumerable set of shell capabilities, and it is loaded with `contextIsolation`
 * on and Node integration off.
 *
 * One additional job since the custom title bar landed: report the **resolved theme
 * tokens** of the official page to the main process. The title bar is a separate
 * document and therefore does not inherit `--dsw-alias-*` from this page; forwarding
 * the values is what keeps the bar, the native caption buttons and the UI in the same
 * theme — including when the user switches the app theme (not just the OS one).
 */
import { contextBridge, ipcRenderer } from 'electron'

/** Tokens forwarded to the title bar; values are used verbatim as CSS. */
interface ThemePayload {
  bg?: string
  fg?: string
  fgDim?: string
  hover?: string
  active?: string
  border?: string
  dark?: boolean
}

/**
 * Read the official UI's resolved theme tokens.
 *
 * `--dsw-alias-*` are declared on `body` (light) and `body[data-ds-dark-theme]`
 * (dark), and Chromium substitutes `var()` at computed-value time, so what comes back
 * is a usable color. The page background is read as a real color rather than through a
 * token so the bar matches whatever is actually painted.
 * @returns Theme payload, with unresolved entries omitted.
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

/** Send the current theme to the shell; never throws into the host page. */
function publishTheme(): void {
  try {
    ipcRenderer.send('dsh-desktop:app-theme', readTheme())
  } catch {
    // A theme report is best-effort: the title bar falls back to the system theme.
  }
}

/**
 * Start reporting theme changes.
 *
 * Both triggers matter: the app can switch theme without the OS changing (settings),
 * and the OS can change without the app's attribute changing (follow-system).
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
    // Observer is an optimisation; the one-shot reports above still cover startup.
  }
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', send)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', watchTheme, { once: true })
} else {
  watchTheme()
}

const api = {
  /** Version of the Electron shell. */
  shellVersion: process.env.DSH_DESKTOP_SHELL_VERSION ?? '0.0.0',
  /** Version of the bundled dsh runtime serving this window. */
  runtimeVersion: process.env.DSH_DESKTOP_RUNTIME_VERSION ?? 'unknown',
  /** Open an external URL in the system browser. */
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('dsh-desktop:open-external', url) as Promise<void>,
  /**
   * 上报 Harness 当前所在的**工作区**（当前会话的 cwd）。
   *
   * 为什么需要它：'当前项目'只存在于 Harness 的客户端状态里（`ctx.sessions.list` 的
   * `current`），既不在 URL 里也不在服务端，而外壳的「项目信息 / 在文件管理器中打开 /
   * 复制路径」必须跟随它，不能一直指向启动时那个目录。
   *
   * 这里做的是**形状归一化**，不是信任：真正的校验在主进程（类型、绝对路径、目录是否
   * 存在、是否属于 Harness 已注册的工作区，见 src/main/window.ts 与 active-workspace.ts）。
   * 这个桥只暴露这一个方法，绝不暴露 `ipcRenderer` 本身。
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
   * 为什么需要它：外壳的冷启动只能读 `<harness home>/settings.yaml` 里的 `locale.preference`。
   * 那份文件在两种情况下给不出答案——用户从没选过语言（Harness 用的是从浏览器语言推导出来的
   * provisional 值），以及语言由**语言包**注册（文件里是个自定义 id）。此时"外壳显示什么语言"
   * 只能由 Harness 自己在运行期告诉外壳，而不是由外壳去读界面文字猜。
   *
   * 这里只做**形状**归一化：只接受非空字符串。归一化（`zh-Hans` → `zh-CN`）、以及"不认识的值
   * 保持现状"都在主进程里（见 src/main/i18n.ts 的 coerceReportedLocale 与 index.ts）。
   * 这个桥只暴露这一个方法，绝不暴露 `ipcRenderer` 本身。
   *
   * @param locale - Harness 官方 locale runtime 的当前 locale id。
   */
  reportLocale: (locale: string): void => {
    if (typeof locale !== 'string' || locale === '') return
    ipcRenderer.send('dsh-desktop:shell-locale', locale)
  },
}

contextBridge.exposeInMainWorld('dshDesktop', api)

export type DshDesktopApi = typeof api
