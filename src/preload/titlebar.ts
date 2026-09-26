/**
 * Preload for the shell title-bar page (the window's own document).
 *
 * This page is ours, but it is still a renderer: it gets no Node access and no raw
 * `ipcRenderer`. Everything it can do is this small, explicitly enumerated bridge —
 * the same posture as `preload.ts` for the Harness page (contextIsolation on,
 * nodeIntegration off, sandbox on).
 *
 * Note the window controls are NOT here: minimizing/maximizing/closing stays with the
 * native caption buttons drawn by `titleBarOverlay`, so no renderer can (or needs to)
 * drive the window state. See src/main/titlebar.ts for why.
 */
import { contextBridge, ipcRenderer } from 'electron'

/** Theme tokens forwarded from the Harness page (CSS-ready values). */
export interface ShellTheme {
  bg?: string
  fg?: string
  fgDim?: string
  hover?: string
  active?: string
  border?: string
  dark?: boolean
}

/** Everything the title-bar page is allowed to know. */
export interface ShellState {
  /** `process.platform`, for the few layout differences (macOS traffic lights). */
  platform: string
  /** Title bar height in CSS px. */
  height: number
  /** Whether this platform draws its own title bar at all (Linux keeps the native frame). */
  custom: boolean
  /** Whether this platform draws the menus inside the title bar. */
  menus: boolean
  /** True once the Harness surface is visible; menus stay hidden until then. */
  ready: boolean
  maximized: boolean
  fullScreen: boolean
  canGoBack: boolean
  canGoForward: boolean
  theme: ShellTheme
  /**
   * Active language, as a canonical id (`zh-CN` / `en-US`).
   *
   * The page writes it into `<html lang>` and — when it changes — re-reads the menu buttons,
   * because their labels come from the native menu that the main process rebuilds.
   */
  locale: string
  /** Accessibility text for the navigation buttons (changes with the language). */
  backLabel: string
  forwardLabel: string
}

interface ShellMenuBarEntry {
  index: number
  label: string
}

const api = {
  /** Current shell state (read once at startup). */
  getState: (): Promise<ShellState> => ipcRenderer.invoke('dsh-desktop:shell-state') as Promise<ShellState>,
  /** Menu-bar buttons, in native menu order. */
  getMenu: (): Promise<ShellMenuBarEntry[]> =>
    ipcRenderer.invoke('dsh-desktop:shell-menu') as Promise<ShellMenuBarEntry[]>,
  /**
   * Pop the native submenu of the given top-level entry at a window-relative point.
   * Resolves when the menu closes.
   */
  openMenu: (index: number, x: number, y: number): Promise<void> =>
    ipcRenderer.invoke('dsh-desktop:shell-menu-open', index, x, y) as Promise<void>,
  /** Ask the shell for a real history navigation ('back' | 'forward'). */
  navigate: (direction: string): Promise<void> =>
    ipcRenderer.invoke('dsh-desktop:shell-navigate', direction) as Promise<void>,
  /** Hand keyboard focus back to the Harness page after a menu closes. */
  focusApp: (): Promise<void> => ipcRenderer.invoke('dsh-desktop:shell-focus-app') as Promise<void>,
  /** State pushes (ready / maximized / theme / history availability). */
  onState: (listener: (state: ShellState) => void): void => {
    ipcRenderer.on('dsh-desktop:shell-state', (_event, state: ShellState) => listener(state))
  },
  /** Startup progress text shown under the title bar before the UI is up. */
  onSplash: (listener: (text: string) => void): void => {
    ipcRenderer.on('dsh-desktop:shell-splash', (_event, text: string) => listener(text))
  },
}

contextBridge.exposeInMainWorld('dshTitlebar', api)

export type DshTitlebarApi = typeof api
