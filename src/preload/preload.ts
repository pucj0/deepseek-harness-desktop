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
  /** Ask the shell to check the runtime channel for a newer dsh. */
  checkForRuntimeUpdate: (): Promise<{ current: string; latest: string; newer: boolean }> =>
    ipcRenderer.invoke('dsh-desktop:check-runtime-update') as Promise<{
      current: string
      latest: string
      newer: boolean
    }>,
  /** Open an external URL in the system browser. */
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('dsh-desktop:open-external', url) as Promise<void>,
}

contextBridge.exposeInMainWorld('dshDesktop', api)

export type DshDesktopApi = typeof api
