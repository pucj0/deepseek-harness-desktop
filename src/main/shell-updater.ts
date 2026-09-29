/**
 * 外壳（Electron 应用自身）的自动更新。
 *
 * 依赖 `electron-builder` 生成的 `app-update.yml`（已随包发布）与 Release 上的
 * `latest*.yml` 元数据。两条前提，缺一更新就会失败，而且失败信息往往很含糊：
 *
 *   1. **文件名必须逐字一致**。实测过一轮：electron-builder 生成的 metadata 里是
 *      `DeepSeek-Harness-x64.exe`（空格→连字符），而 GitHub 上传后的附件名是
 *      `DeepSeek.Harness-x64.exe`（空格→点），于是下载 404。因此 productName 现在
 *      不含空格，两处都是 `dsh-desktop-x64.exe`。
 *   2. Release 必须带 `latest.yml` / `latest-mac.yml` / `latest-linux.yml`。
 *      构建阶段会上传它们，但若上传路径写错就会缺（这个也踩过）。
 *
 * 未签名构建：Windows NSIS 与 macOS 的更新都不校验签名（publisherName 未配置），
 * 因此本应用可以直接自更新。若将来配置了证书，两者仍兼容。
 */
import type { BrowserWindow } from 'electron'

/** 完整应用更新检查的结果。 */
export interface ShellCheck {
  /** 是否可用（未打包运行、缺元数据、网络失败时为 false）。 */
  available: boolean
  /** 当前应用版本。 */
  current: string
  /** 可用的新版本，检查失败时为空。 */
  latest?: string
  /** 检查失败或不可用的原因。 */
  reason?: string
}

/**
 * 完整应用更新器（GitHub Releases）。
 *
 * `electron-updater` 只在打包后的应用里工作（它要读 `app-update.yml` 并写
 * 更新缓存），因此在开发运行时会以 `available: false` 明确返回原因，而不是
 * 抛一个难懂的异常。
 */
export class ShellUpdater {
  private updater: import('electron-updater').AppUpdater | undefined

  constructor(
    private readonly currentVersion: string,
    private readonly developmentReason = 'App self-update is unavailable in development mode',
  ) {}

  /** 惰性加载 electron-updater，避免未打包运行时立刻报错。 */
  private async load(): Promise<import('electron-updater').AppUpdater | undefined> {
    if (this.updater !== undefined) return this.updater
    try {
      const mod = await import('electron-updater')
      const updater = mod.autoUpdater
      // 由我们的按钮驱动，不后台自动下载：下载 200MB 的安装包是有感的动作，
      // 应当由用户明确触发。
      updater.autoDownload = false
      updater.autoInstallOnAppQuit = true
      // 不把 electron-updater 的日志混进应用输出，但保留告警。
      updater.logger = {
        info: (): void => {},
        warn: (message?: unknown): void => console.warn(`[updater] ${String(message)}`),
        error: (message?: unknown): void => console.error(`[updater] ${String(message)}`),
        debug: (): void => {},
      }
      this.updater = updater
      return updater
    } catch (error) {
      console.warn(`[updater] 无法加载 electron-updater: ${String(error)}`)
      return undefined
    }
  }

  /**
   * 检查是否有新的外壳版本。
   * @param packaged - 是否运行在打包后的应用里（开发运行无法自更新）。
   * @returns 检查结果；失败时 `available: false` 并带 `reason`。
   */
  async check(packaged: boolean): Promise<ShellCheck> {
    if (!packaged) {
      return {
        available: false,
        current: this.currentVersion,
        reason: this.developmentReason,
      }
    }
    const updater = await this.load()
    if (updater === undefined) {
      return { available: false, current: this.currentVersion, reason: 'electron-updater 不可用' }
    }
    try {
      const result = await updater.checkForUpdates()
      const info = result?.updateInfo
      if (info === undefined) {
        return { available: false, current: this.currentVersion, reason: '没有返回更新信息' }
      }
      return info.version === this.currentVersion
        ? { available: false, current: this.currentVersion, latest: info.version }
        : { available: true, current: this.currentVersion, latest: info.version }
    } catch (error) {
      return {
        available: false,
        current: this.currentVersion,
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * 下载更新并在完成后回调。
   * @param onProgress - 进度百分比（0-100）。
   * @returns 下载完成时的 Promise；失败时 reject。
   */
  async download(onProgress: (percent: number) => void): Promise<void> {
    const updater = await this.load()
    if (updater === undefined) throw new Error('electron-updater 不可用')

    const onProgressEvent = (info: { percent: number }): void => onProgress(Math.round(info.percent))
    updater.on('download-progress', onProgressEvent)
    try {
      await updater.downloadUpdate()
    } finally {
      updater.off('download-progress', onProgressEvent)
    }
  }

  /**
   * 退出并安装已下载的更新。
   * @param window - 主窗口（安装器需要它先关闭）。
   */
  install(window?: BrowserWindow): void {
    const updater = this.updater
    if (updater === undefined) return
    // isSilent=false 让用户看到安装进度；isForceRunAfter=true 装完自动拉起新版本。
    // 必须先关窗口：NSIS 安装器要覆盖正在运行的可执行文件。
    if (window !== undefined && !window.isDestroyed()) window.destroy()
    updater.quitAndInstall(false, true)
  }
}
