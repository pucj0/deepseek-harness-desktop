/**
 * Tray icon and menu.
 *
 * The tray is not decoration: it is what lets long-running work survive a closed
 * window. Goals, ralph loops, background jobs, and spawned subagents all live in
 * the server child process, so hiding to tray keeps them running where closing a
 * browser tab would not.
 */
import { Menu, Tray, nativeImage, type BrowserWindow } from 'electron'
import { t } from './i18n'

/** Actions the tray needs from the application shell. */
export interface TrayActions {
  show: () => void
  restartServer: () => void
  checkForUpdates: () => void
  projectInfo: () => void
  quit: () => void
}

/**
 * Create the tray icon.
 * @param iconPath - absolute path of a PNG/ICO icon, when one exists.
 * @param actions - callbacks wired into the menu.
 * @returns the tray, or undefined when no icon is available.
 */
export function createTray(iconPath: string | undefined, actions: TrayActions): Tray | undefined {
  if (iconPath === undefined) return undefined
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) return undefined

  const tray = new Tray(image.resize({ width: 16, height: 16 }))
  refreshTray(tray, actions)
  tray.on('click', actions.show)
  tray.on('double-click', actions.show)
  return tray
}

/**
 * Re-apply the current language to an existing tray.
 *
 * The tray menu is built once at startup, so a language change (which the shell follows from
 * Harness's locale) would otherwise leave the tray in the previous language — the exact
 * half-translated state this feature exists to avoid.
 *
 * @param tray - the tray to update.
 * @param actions - the same callbacks it was created with.
 */
export function refreshTray(tray: Tray, actions: TrayActions): void {
  const strings = t()
  tray.setToolTip(strings.trayTooltip)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: strings.trayShow, click: actions.show },
      { type: 'separator' },
      { label: strings.itemProjectInfo, click: actions.projectInfo },
      { label: strings.trayRestart, click: actions.restartServer },
      { label: strings.trayCheckUpdates, click: actions.checkForUpdates },
      { type: 'separator' },
      { label: strings.trayQuit, click: actions.quit },
    ]),
  )
}

/**
 * Wire "close hides to tray" behaviour.
 * @param window - the main window.
 * @param shouldHide - returns whether closing should hide instead of quit.
 */
export function installCloseToTray(window: BrowserWindow, shouldHide: () => boolean): void {
  window.on('close', (event) => {
    if (!shouldHide()) return
    event.preventDefault()
    window.hide()
  })
}
