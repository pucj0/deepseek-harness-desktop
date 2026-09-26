/**
 * DeepSeek Harness desktop shell — main process.
 *
 * Owns the application lifecycle around one dsh server child process:
 * single-instance gate, workspace resolution, credential injection, window
 * creation, tray, and runtime updates.
 *
 * The heavy lifting (sandboxing, tools, sessions, jobs, subagents) all happens in
 * the child; this process is a shell and never runs agent code.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BrowserWindow, Menu, Tray, app, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron'

import { CredentialStore } from './credentials'
import { DshServer } from './dsh-server'
import type { ServerReady } from './dsh-server'
import { formatGitBadge, readGitInfo } from './git'
import { readLocalePreference, watchLocalePreference } from './harness-locale'
import { format, initShellStrings, resolveShellLocale, setShellLocale, t } from './i18n'
import { healModuleFallback } from './module-heal'
import { applicationMenuTemplate, dumpMenuTemplate, menuBarEntries, openMenuAt } from './menu'
import type { ApplicationMenuDeps } from './menu'
import type { PanelRow } from './panel'
import { resolveRuntime } from './paths'
import type { RuntimeLocation } from './paths'
import { syncPluginsAtStartup } from './plugin-sync'
import { ensureRuntimeUnpacked } from './runtime-unpack'
import { showProjectInfo } from './project-info'
import { readSettings } from './settings'
import { ShellUpdater } from './shell-updater'
import { installCloseToTray, createTray, refreshTray } from './tray'
import type { TrayActions } from './tray'
import { openUpdateWindow, type UpdatePanelState } from './update-window'
import { RuntimeUpdater, locateNpmCli } from './updater'
import { createMainWindow } from './window'
import { pickFolderToOpen, resolveWorkspace, restartIntoWorkspace } from './workspace-switch'
import { recentLabels, removeSplashFile } from './workspace'

const SHELL_VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version?: string })
      .version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** 发布页面地址（帮助菜单里的外部链接）。 */
const RELEASES_URL = 'https://github.com/pucj0/deepseek-harness-desktop/releases'

/** Populated during startup, read by the shutdown path. */
interface Session {
  server: DshServer
  window: BrowserWindow
  tray?: Tray
  updater: RuntimeUpdater
  quitting: boolean
}

let session: Session | undefined

/**
 * The runtime this process is running on.
 *
 * Held module-level because two independent UI surfaces (the tray menu and the
 * application menu) both need to report it, and both are only ever reachable
 * after `main()` has assigned it.
 */
let activeRuntime: RuntimeLocation | undefined

// A second launch focuses the existing window instead of starting a second
// server (which would bind another port and duplicate the harness home).
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const window = session?.window
    if (window === undefined) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })

  void main()
}

/** Launch, wire, and supervise the whole application. */
async function main(): Promise<void> {
  // Deliberately do NOT call app.setName(): it changes the userData directory, so
  // setting it here would split state between a development run (which Electron
  // names from package.json) and a packaged run (which it names from
  // productName). The window title and installer name carry the display name.
  //
  // 跟随系统外观，而不是写死深色。
  //
  // 此前写成 'dark'，理由是"菜单栏在深色下更协调"。但它的影响远不止菜单栏：
  // Electron 的 themeSource 会让 Chromium 上报 prefers-color-scheme，而官方界面正是用
  // `matchMedia('(prefers-color-scheme: dark)')` 决定配色的（见 dsh-client-ui-theme）。
  // 于是写死深色等于**替用户忽略了他们自己选的浅色**——用户把系统设成浅色，界面依旧发黑。
  //
  // 'system' 让原生外观（菜单栏、原生对话框）与网页外观都跟随系统，两侧因此一致。
  nativeTheme.themeSource = 'system'
  await app.whenReady()

  const userDataDir = process.env.DSH_DESKTOP_HOME ?? app.getPath('userData')
  // 本进程生命周期内不变：切换工作区靠重启应用，而不是就地替换（见 workspace-switch.ts）。
  const workspace = resolveWorkspace(process.argv, userDataDir)
  // A dedicated harness home keeps this app's sessions and credentials entirely
  // separate from a command-line `dsh` install, so the two can coexist.
  const dshHome = join(userDataDir, 'home')
  mkdirSync(dshHome, { recursive: true })

  // Localization: the source of truth is **Harness's own language setting**, persisted in the
  // host settings document under `locale.preference` (see harness-locale.ts). Read it before the
  // window exists so the very first frame is already in the right language — no English flash
  // that later flips to Chinese. With no stored preference the system language is used, which is
  // exactly Harness's own browser-derived fallback. Every shell-owned string (menus, tray,
  // dialogs) reads from this same table; `applyShellLocale` refreshes what is built rather than
  // read per use.
  const strings = initShellStrings(readLocalePreference(dshHome))

  const credentials = new CredentialStore(userDataDir)

  // 先建窗口（显示加载页），再解包内置运行时。
  //
  // 顺序很重要的原因：内置运行时是压缩携带的（安装包 42.9 MB 而不是散开 197 MB），
  // 首次启动要把它解到用户目录，实测 9.2 秒。若把解包放在建窗口之前，用户会先对着
  // 空屏幕等这段时间；现在窗口立刻可见，并在加载页上显示解包进度。
  const iconPath = resolveIconPath(app.isPackaged)
  const mainWindow = createMainWindow({
    userDataDir,
    ...(iconPath !== undefined ? { iconPath } : {}),
    splashTitle: strings.splashTitle,
    splashHint: strings.splashHint,
    backLabel: strings.titlebarBack,
    forwardLabel: strings.titlebarForward,
    // 标题栏里的菜单按钮与"点哪个弹哪个"都来自**同一份原生菜单**（下面构建的那个）。
    // 菜单因此只有一份定义：accelerator 仍由它注册，标题栏只是换个地方画标题。
    menu: {
      entries: () => menuBarEntries(Menu.getApplicationMenu() ?? Menu.buildFromTemplate([])),
      open: (index, point, onClosed) => {
        const applicationMenu = Menu.getApplicationMenu()
        if (applicationMenu === null) return false
        return openMenuAt(applicationMenu, index, window, point, onClosed)
      },
    },
  })
  const window = mainWindow.window
  void readGitInfo(workspace).then((info) => mainWindow.setGitBadge(formatGitBadge(info, '*')))

  // 解包内置运行时（已解过则瞬间返回）。
  let unpackedDir: string | undefined
  // Updated runtimes have their own Node. Prepare the bundled fallback only when
  // it is actually selected (rollback removes current and relaunches this path).
  const hasUpdatedRuntime = existsSync(join(userDataDir, 'runtime', 'current', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  if (app.isPackaged && !hasUpdatedRuntime) {
    const archivePath = join(process.resourcesPath, 'runtime.br')
    if (existsSync(archivePath)) {
      try {
        let lastPercent = -1
        const result = await ensureRuntimeUnpacked(archivePath, userDataDir, (readBytes, archiveBytes) => {
          // 钳制到 0-100：即使将来某一侧传参的量纲又不一致，也只是进度条不精确，
          // 不会再显示出 "444%" 这种明显错误的数字（真发生过）。
          const percent = Math.min(100, Math.max(0, Math.floor((readBytes / Math.max(archiveBytes, 1)) * 100)))
          // 只在百分比变化时更新加载页文字。
          if (percent === lastPercent) return
          lastPercent = percent
          mainWindow.setSplashHint(format(strings.splashUnpacking, { percent: String(percent) }))
        })
        unpackedDir = join(result.dir, 'runtime')
        mainWindow.setSplashHint(strings.splashHint)
      } catch (error) {
        dialog.showErrorBox(
          strings.startupFailedTitle,
          `解包内置运行时失败：${error instanceof Error ? error.message : String(error)}`,
        )
        app.exit(1)
        return
      }
    }
  }

  let runtime
  try {
    runtime = resolveRuntime(userDataDir, unpackedDir)
  } catch (error) {
    dialog.showErrorBox(
      strings.startupFailedTitle,
      `${error instanceof Error ? error.message : String(error)}\n\n${strings.startupMissingRuntimeDetail}`,
    )
    app.exit(1)
    return
  }

  // 把随本应用发布的客户端插件同步进**当前实际使用的**运行时。
  //
  // 必须在服务端进程启动之前做，而且每次启动都要做：运行时自动更新会整体换掉
  // `<userData>/runtime/current` 指向的那份运行时，而那份里没有内置插件（它们不在
  // dsh 的依赖闭包里，只随安装包携带）。缺失时 `server.mjs` 是静默跳过的，表现为
  // **三个插件一起从界面上消失**且没有任何报错。详见 plugin-sync.ts。
  //
  // 放在这里而不放进更新器：更新器只覆盖"更新"这一条路径，而这里同时覆盖"更新后自动
  // 补齐"、"已经装坏的运行时就地修好"和"外壳升级后刷新旧副本"三种情形。
  const pluginSync = syncPluginsAtStartup({
    runtimeDir: runtime.dir,
    resourcesPath: process.resourcesPath,
    repoRoot: resolve(__dirname, '..', '..'),
    userDataDir,
    packaged: app.isPackaged,
    ...(unpackedDir === undefined ? {} : { unpackedDir }),
  })
  for (const line of pluginSync.messages) process.stderr.write(`${line}\n`)

  const runtimeVersion = RuntimeUpdater.readVersion(runtime.dir) ?? runtime.stagedVersion ?? 'unknown'
  activeRuntime = runtime
  process.env.DSH_DESKTOP_SHELL_VERSION = SHELL_VERSION
  process.env.DSH_DESKTOP_RUNTIME_VERSION = runtimeVersion

  const updater = new RuntimeUpdater({
    baseDir: join(userDataDir, 'runtime'),
    bundledDir: runtime.dir,
    currentVersion: runtimeVersion,
    ...(readSettings(userDataDir).channel !== undefined ? { channel: readSettings(userDataDir).channel } : {}),
  })

  // 服务端实例在本次进程里只有一个：切换工作区走的是重启应用（见 workspace-switch.ts），
  // 不再就地替换它。
  const server = new DshServer({
    runtime,
    dshHome,
    workspace,
    // Decrypted secrets ride the launching environment, which outranks every
    // stored layer in dsh's credential precedence.
    env: credentials.read(),
  })

  // Repair module-fallback links before boot. If the install directory ever moved,
  // dsh's own staleness check compares link *target strings*, so a dangling link can
  // still look current — which surfaces as "Cannot find package '@deepseek-ai/…'"
  // for every profile package. Checked on every start; a healthy home is a read-only
  // scan, and the directory holds no user data (dsh rebuilds it).
  const healed = healModuleFallback(dshHome)
  if (healed.cleaned) {
    process.stderr.write(
      `[dsh-desktop] 修复了 ${healed.brokenLinks}/${healed.checkedLinks} 个失效的模块链接，` +
        'dsh 将在本次启动时重建。\n',
    )
  } else if (healed.brokenLinks > 0) {
    process.stderr.write(
      `[dsh-desktop] 警告: 发现 ${healed.brokenLinks} 个失效模块链接但无法清理，启动可能失败。\n`,
    )
  }

  // Server output is valuable when diagnosing a failed boot, so keep it visible
  // during development and in the log file rather than swallowing it.
  server.on('log', ({ stream, line }: { stream: 'stdout' | 'stderr'; line: string }) => {
    if (!app.isPackaged || stream === 'stderr') process[stream].write(`${line}\n`)
  })

  // 窗口已在前面建好（为了在解包运行时期间就能显示进度），这里不再重建。
  // 下面开始等 dsh 服务端就绪——它要 ~11 秒启动插件树，窗口此时正显示加载页。

  /**
   * 切换工作区：记录选择、留下"待切换"标记，然后重启应用。
   *
   * 定义在 `main()` 里而不是 `createWorkspaceActions` 里，因为重启动作要拿到服务端
   * （先停子进程再重启，避免两个服务端争用同一个 harness home）与 `session` 状态。
   * 真正的协议本身在 `workspace-switch.ts`，那里不依赖 Electron，因此可被回归测试直接跑。
   *
   * 为什么重启而不是就地换服务端：Harness 的项目/工作区状态是启动时登记的持久记录，
   * 不只取决于服务端 cwd。完整理由见 `workspace-switch.ts` 的文件头。
   * @param dir - 目标工作区绝对路径。
   */
  const onSwitchWorkspace = (dir: string): void => {
    void restartIntoWorkspace({
      userDataDir,
      current: workspace,
      target: dir,
      // 关窗即隐藏到托盘；切换要真的退出进程，先把它关掉。`beginQuit` 只在真的会重启时
      // 被调用，因此"最近打开"里点到当前项目不会把这项行为永久改掉。
      beginQuit: () => {
        if (session !== undefined) session.quitting = true
      },
      stopServer: () => server.stop(2000),
      relaunch: () => app.relaunch(),
      exit: (code) => app.exit(code),
    })
  }

  /**
   * 语言之外的应用菜单输入：命令回调与动态数据。
   *
   * 抽成一份可复用的对象，是因为菜单在**语言变化时会被重建**：重建必须换文案、绝不能换命令，
   * 而复用同一份 deps 正好把这件事变成结构上的保证（测试也直接比对中英两份模板）。
   *
   * @param projectInfo - 「项目信息」入口。
   * @param openUpdates - 「检查更新」入口。
   * @returns 交给 `applicationMenuTemplate` 的输入（文案与外壳版本由调用方补上）。
   */
  const menuDepsFor = (
    projectInfo: () => void,
    openUpdates: () => void,
  ): Omit<ApplicationMenuDeps, 'strings' | 'shellVersion'> => {
    const actions = createWorkspaceActions({ window, workspace, userDataDir, strings, onSwitchWorkspace })
    return {
      recent: actions.recent,
      runtimeVersion,
      openFolder: actions.openFolder,
      openRecent: actions.openRecent,
      projectInfo,
      revealWorkspace: actions.revealWorkspace,
      copyWorkspacePath: actions.copyWorkspacePath,
      openUpdates,
      openReleases: () => void shell.openExternal(RELEASES_URL),
    }
  }

  /** 菜单输入（语言变化时用它重建菜单；在诊断模式与正常模式下各装配一次）。 */
  let menuDeps: Omit<ApplicationMenuDeps, 'strings' | 'shellVersion'> | undefined
  /** 停止监听 Harness 语言设置（退出时收尾）。 */
  let stopLocaleWatch: (() => void) | undefined
  let tray: Tray | undefined
  let trayActions: TrayActions | undefined

  /**
   * 把"Harness 的语言变了"应用到已经构建出来的界面上。
   *
   * 三件事，缺一不可：
   *   * 应用菜单——重建它（标题栏的菜单按钮与原生下拉的文案都来自它）；
   *   * 托盘菜单——它是启动时构建的，不重建就会留在旧语言；
   *   * 标题栏状态——推一次状态，页面据此改写 `<html lang>`、导航按钮文案并重新取菜单按钮。
   *
   * 对话框、项目信息窗口、更新窗口不在这里：它们拿的是同一份**活**文案表（`strings`），
   * 读的时候已经是新语言。
   *
   * @param locale - 新的语言偏好（原始值；undefined 表示偏好被清空 → 回退系统语言）。
   */
  const applyShellLocale = (locale: string | undefined): void => {
    // 没有偏好（第一次使用，或用户把设置清空）时回退系统语言——与启动路径同一个判定。
    if (!setShellLocale(resolveShellLocale(locale))) return
    if (menuDeps !== undefined) buildApplicationMenu(menuDeps)
    if (tray !== undefined && trayActions !== undefined) refreshTray(tray, trayActions)
    mainWindow.publishShellState()
  }

  // 退出时关掉设置文档的监听（两条启动路径都经过这里注册的这一处）。
  app.on('will-quit', () => {
    stopLocaleWatch?.()
  })

  // 纯菜单诊断：菜单不依赖服务端，而启动服务端要 ~11 秒。以
  // DSH_DESKTOP_DUMP_MENU=1 启动时，构建完菜单就直接退出，让菜单可以被脚本
  // 快速断言，而不是每次等十几秒。
  if (process.env.DSH_DESKTOP_DUMP_MENU === '1') {
    menuDeps = menuDepsFor(() => {}, () => {})
    buildApplicationMenu(menuDeps)
    // 诊断实例默认打完就退；`DSH_DESKTOP_MENU_WATCH=1` 时让它活着并跟着语言重建菜单，
    // 于是"运行中切换语言"可以只靠 stderr 就被断言（见 test-shell-locale.mjs）。
    if (process.env.DSH_DESKTOP_MENU_WATCH === '1') {
      stopLocaleWatch = watchLocalePreference(dshHome, applyShellLocale)
      return
    }
    app.exit(0)
    return
  }

  let ready
  try {
    ready = await server.start()
  } catch (error) {
    if (runtime.dir.startsWith(join(userDataDir, 'runtime'))) {
      // An updated runtime failed to boot: drop back to the bundled one rather
      // than leaving the user with an app that never opens.
      updater.rollback()
      dialog.showMessageBoxSync({
        type: 'warning',
        title: strings.rollbackTitle,
        message: strings.rollbackMessage,
        detail: error instanceof Error ? error.message : String(error),
        buttons: [strings.buttonOk],
      })
      app.relaunch()
      app.exit(0)
      return
    }
    mainWindow.close()
    dialog.showErrorBox(
      strings.startupFailedTitle,
      error instanceof Error ? error.message : String(error),
    )
    app.exit(1)
    return
  }

  // Hand the already-visible window over to the real UI.
  await mainWindow.navigate(ready)

  // 更新相关的装配放在托盘之前：托盘与菜单都要用到同一个"打开更新窗口"入口，
  // 而它们的回调是在创建时捕获的，所以动作必须先定义好。
  registerIpc(updater)
  // 外壳版本必须用 app.getVersion()，不能复用运行时版本。
  // 踩过一次：这里原本传的是 runtimeVersion，于是更新窗口的
  // 「应用外壳 / 已安装版本」显示成了 dsh 的版本号（0.1.5-rc.1），而应用自己是 1.0.0。
  const shellUpdater = new ShellUpdater(app.getVersion())
  const openUpdates = (): void => {
    openUpdatesFor({
      window,
      runtimeUpdater: updater,
      shellUpdater,
      runtimeVersion,
      runtime,
      userDataDir,
      strings,
    })
  }

  trayActions = {
    show: () => {
      window.show()
      window.focus()
    },
    restartServer: () => {
      void restart(server, mainWindow.navigate)
    },
    checkForUpdates: openUpdates,
    projectInfo: () => {
      showProjectInfoFor(window, workspace, dshHome, userDataDir, runtime, runtimeVersion, strings)
    },
    quit: () => {
      if (session !== undefined) session.quitting = true
      app.quit()
    },
  }
  tray = createTray(iconPath, trayActions)

  installCloseToTray(window, () => tray !== undefined && session?.quitting !== true)
  window.on('closed', () => {
    // Closing the last window ends the app only when the tray is absent.
    if (tray === undefined) app.quit()
  })

  menuDeps = menuDepsFor(
    () => {
      showProjectInfoFor(window, workspace, dshHome, userDataDir, runtime, runtimeVersion, strings)
    },
    openUpdates,
  )
  buildApplicationMenu(menuDeps)
  session = { server, window, ...(tray !== undefined ? { tray } : {}), updater, quitting: false }

  // 跟随 Harness 的语言设置：宿主把用户选择写进 `<dshHome>/settings.yaml` 的
  // `locale.preference`，这里盯着同一个文件，改了就重建菜单/托盘并刷标题栏——**不重启应用**。
  stopLocaleWatch = watchLocalePreference(dshHome, applyShellLocale)

  // 启动时**不再**静默检查外壳更新。
  //
  // 此前 `if (app.isPackaged) void checkShellUpdate()` 会在启动后偷偷检查并弹一个
  // 对话框，用户既没触发也不知道它是谁在什么时候检查的，观感很怪（这正是要改掉的
  // 一点）。现在两条轨道都只在用户主动打开「更新」时检查。
  //
  // 保留的自动化只有 `autoInstallOnAppQuit`：已经下载完成的更新在退出时安装，
  // 避免用户点了下载却因为忘记重启而一直用旧版本。

  app.on('before-quit', () => {
    if (session !== undefined) session.quitting = true
  })
  app.on('will-quit', () => {
    removeSplashFile(userDataDir)
    void server.stop()
  })
  // With a tray the app outlives its windows on purpose.
  app.on('window-all-closed', () => {
    if (session?.tray === undefined) app.quit()
  })
}

/**
 * 构造文件菜单里工作区相关动作的实现。
 *
 * 两条切换入口（「打开文件夹」与「最近打开」）都只用下面这**一个**注入的
 * `onSwitchWorkspace`，不存在"一个走方案 A、一个走方案 B"。1.2.0–1.5.8 期间它是
 * "就地换服务端"，那样换不掉 Harness 的工作区生命周期；现在的实现是"写意图 + 重启应用"，
 * 理由见 `workspace-switch.ts` 的文件头。
 *
 * @param deps - 需要的窗口、当前工作区、数据目录、切换回调与文案。
 * @returns 菜单动作集合。
 */
function createWorkspaceActions(deps: {
  window: BrowserWindow
  /** 本次进程的工作区。切换靠重启，因此它在进程生命周期内不变。 */
  workspace: string
  userDataDir: string
  strings: ReturnType<typeof t>
  /**
   * 切换到新工作区：记录选择 + 重启应用。
   *
   * 由 `main()` 注入，因为重启前要先停掉服务端子进程、并让"关窗即隐藏到托盘"
   * 让开——那些都在 `main()` 的作用域里。
   */
  onSwitchWorkspace: (dir: string) => void
}): WorkspaceActions {
  const { window, workspace, userDataDir, strings, onSwitchWorkspace } = deps
  const s = strings

  const recent = readSettings(userDataDir).recent ?? []
  const recentLabelsForMenu = recentLabels(recent)

  return {
    recent: recentLabelsForMenu.map((label, index) => ({ label, path: recent[index] ?? '' })),
    openFolder: (): void => {
      // 关闭选择器、确认框里取消、以及"选中的就是当前目录"都在这里被挡掉：三种情况
      // 都不该改设置、不该写标记、更不该重启。判定本身在 workspace-switch.ts，
      // 因此可以被回归测试直接跑（那里的对话框是注入的）。
      const dir = pickFolderToOpen({
        currentWorkspace: workspace,
        showOpenDialog: () =>
          dialog.showOpenDialogSync(window, {
            title: s.dialogOpenFolderTitle,
            buttonLabel: s.dialogOpenFolderButton,
            properties: ['openDirectory', 'createDirectory'],
          })?.[0],
        confirm: (candidate) =>
          dialog.showMessageBoxSync(window, {
            type: 'question',
            title: s.switchWorkspaceTitle,
            message: s.switchWorkspaceMessage,
            detail: `${candidate}\n\n${s.switchWorkspaceDetail}`,
            buttons: [s.switchWorkspaceConfirm, s.switchWorkspaceCancel],
            defaultId: 0,
            cancelId: 1,
          }) === 0,
      })
      if (dir === undefined) return
      onSwitchWorkspace(dir)
    },
    openRecent: (dir: string): void => {
      // 空条目与"已经是当前工作区"都由 restartIntoWorkspace 挡掉（同一个判定，
      // 因此这里不需要再写一遍）。
      onSwitchWorkspace(dir)
    },
    revealWorkspace: (): void => {
      void shell.openPath(workspace)
    },
    copyWorkspacePath: (): void => {
      clipboard.writeText(workspace)
      dialog.showMessageBox(window, {
        type: 'info',
        message: s.copiedPathTitle,
        detail: `${workspace}\n\n${s.copiedPathMessage}`,
        buttons: [s.buttonOk],
      })
    },
  }
}

/**
 * Restart the agent runtime child process in place, keeping the window.
 *
 * 重新加载必须走窗口的 `navigate`（它把带 token 的 URL 装进**Harness 子视图**）：
 * 直接 `window.loadURL(...)` 会把官方界面装进窗口自身的文档，也就是**顶掉自绘标题栏**、
 * 并让官方界面铺满整个窗口（越过标题栏区域）。这是托盘「重启服务端」唯一的坑。
 *
 * @param server - the running child.
 * @param navigate - the window's navigate method (loads into the Harness view).
 */
async function restart(server: DshServer, navigate: (ready: ServerReady) => Promise<void>): Promise<void> {
  await server.stop()
  try {
    await navigate(await server.start())
  } catch (error) {
    dialog.showErrorBox(t().restartFailedTitle, error instanceof Error ? error.message : String(error))
  }
}

/**
 * 打开「项目信息」面板，并在 git 探测返回后把数据推给面板。
 *
 * 面板先渲染、数据后到：git 探测要走子进程，阻塞在菜单点击上会让界面发顿。
 * @param parent - 父窗口。
 * @param workspace - 工作区路径。
 * @param dshHome - Harness 主目录。
 * @param userDataDir - 应用数据目录。
 * @param runtime - 当前运行时位置。
 * @param runtimeVersion - 当前运行时版本。
 * @param strings - 已解析的本地化文案。
 */
function showProjectInfoFor(
  parent: BrowserWindow,
  workspace: string,
  dshHome: string,
  userDataDir: string,
  runtime: RuntimeLocation,
  runtimeVersion: string,
  strings: ReturnType<typeof t>,
): void {
  const rows: PanelRow[] = [
    { label: strings.projectWorkspace, value: workspace, hint: strings.projectWorkspaceHint },
    { label: strings.projectRuntimeVersion, value: runtimeVersion },
    {
      label: strings.projectRuntimeSource,
      value: runtime.dir.startsWith(join(userDataDir, 'runtime'))
        ? strings.projectRuntimeDownloaded
        : strings.projectRuntimeBundled,
    },
    { label: strings.projectNode, value: runtime.nodeVersion ?? process.version },
    { label: strings.projectElectron, value: process.versions.electron ?? '—' },
    { label: strings.projectHarnessHome, value: dshHome, hint: strings.projectHarnessHomeHint },
    { label: strings.projectUserData, value: userDataDir },
  ]

  const info = showProjectInfo(parent, userDataDir, rows, {
    title: strings.projectInfoTitle,
    close: strings.projectClose,
    notARepo: strings.projectGitNotARepo,
    dirty: strings.projectGitDirty,
    clean: strings.projectGitClean,
  })

  void readGitInfo(workspace).then(
    (git) => info.publishGit(git),
    () => info.publishGit({ isRepo: false }),
  )
}

/**
 * Check the configured npm channel for a newer dsh and offer to install it.
 *
 * Reports the channel and the current runtime's on-disk location, because "up to
 * date" is only meaningful when the user can tell which channel was consulted and
 * which runtime is actually running.
 *
 * @param updater - the runtime updater.
 * @param window - the window used as the dialog parent.
 * @param runtime - the active runtime, for reporting where this build runs from.
 */
async function installRuntimeUpdate(
  updater: RuntimeUpdater,
  window: BrowserWindow,
  version: string,
  registry: string,
): Promise<{ installed: boolean }> {
  const s = t()
  const npmCli = locateNpmCli(process.resourcesPath)
  if (npmCli === undefined) {
    await dialog.showMessageBox(window, {
      type: 'error',
      message: s.updateNoNpmTitle,
      detail: s.updateNoNpmDetail,
      buttons: [s.buttonOk],
    })
    return { installed: false }
  }

  const progress = new BrowserWindow({
    width: 460,
    height: 180,
    parent: window,
    modal: true,
    resizable: false,
    minimizable: false,
    title: s.updateProgressTitle,
    autoHideMenuBar: true,
  })
  await progress.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        '<body style="font:13px system-ui;padding:20px;background:#1b1b1f;color:#e8e8ea">' +
          `<h3 style="margin:0 0 8px">${s.updateProgressTitle}…</h3>` +
          `<div id="s" style="opacity:.75">${s.updateProgressStarting}</div></body>`,
      ),
  )

  try {
    const result = await updater.install(version, registry, npmCli, (line) => {
      void progress.webContents.executeJavaScript(
        `document.getElementById('s').textContent=${JSON.stringify(line)}`,
      )
    })
    if (!progress.isDestroyed()) progress.destroy()
    if (!result.updated) {
      await dialog.showMessageBox(window, {
        type: 'error',
        message: s.updateFailedTitle,
        detail: result.reason ?? s.updateFailedUnknown,
        buttons: [s.buttonOk],
      })
      return { installed: false }
    }
    app.relaunch()
    app.exit(0)
    return { installed: true }
  } catch (error) {
    if (!progress.isDestroyed()) progress.destroy()
    await dialog.showMessageBox(window, {
      type: 'error',
      message: s.updateFailedTitle,
      detail: error instanceof Error ? error.message : String(error),
      buttons: [s.buttonOk],
    })
    return { installed: false }
  }
}

/**
 * 打开「更新」窗口：两条轨道统一展示与操作。
 *
 * 窗口立刻打开并显示"正在检查"，两条检查并行进行、结果各自推送。这样网络慢时
 * 用户看得到进展，而不是等十几秒后突然弹出一个窗口。
 *
 * 外壳更新的两个守卫：
 *   * 未打包运行时不可用（没有 `app-update.yml`），此时明确说明而不是给个
 *     永远转圈的按钮；
 *   * 外壳版本比较用 `app.getVersion()`。开发运行时 Electron 从 package.json
 *     取名，打包后来自 productName —— 两者可能不同，所以只在打包后启用安装。
 *
 * @param deps - 窗口、更新器与版本信息。
 */
function openUpdatesFor(deps: {
  window: BrowserWindow
  runtimeUpdater: RuntimeUpdater
  shellUpdater: ShellUpdater
  runtimeVersion: string
  runtime: RuntimeLocation | undefined
  userDataDir: string
  strings: ReturnType<typeof t>
}): void {
  const { window, runtimeUpdater, shellUpdater, runtimeVersion, runtime, userDataDir, strings: s } = deps

  const shellVersion = app.getVersion()
  const canInstallShell = app.isPackaged
  let shellCanInstall = false
  let currentShellState: UpdatePanelState['shell'] = {
    installed: shellVersion,
    state: 'checking',
    latestLabel: s.updateShellLatestLabel,
  }

  const panel = openUpdateWindow(
    window,
    userDataDir,
    {
      title: s.updateWindowTitle,
      checking: s.updateChecking,
      sectionRuntime: s.updateSectionRuntime,
      sectionShell: s.updateSectionShell,
      stateLatest: s.updateStateLatest,
      stateAvailable: s.updateStateAvailable,
      stateUnknown: s.updateStateUnknown,
      installedLabel: s.updateInstalledLabel,
      latestLabel: s.updateNewestLabel,
      detailLabel: s.updateDetailLabel,
      buttonClose: s.updateButtonClose,
      buttonRuntime: s.updateButtonRuntime,
      buttonShell: s.updateButtonShell,
      shellUnavailable: s.updateShellUnavailable,
      shellProgress: s.updateShellProgress,
      buttonDownloading: s.updateButtonDownloading,
      shellFailedTitle: s.updateShellFailedTitle,
      runtimeLatestLabel: s.updateRuntimeLatestLabel,
      shellLatestLabel: s.updateShellLatestLabel,
    },
    (action) => {
      if (action === 'close') {
        panel.window.close()
        return
      }
      if (action === 'update-runtime') {
        void (async () => {
          try {
            const check = await runtimeUpdater.check()
            await installRuntimeUpdate(
              runtimeUpdater,
              window,
              check.latest.version,
              check.latest.registry,
            )
          } catch (error) {
            await dialog.showMessageBox(window, {
              type: 'error',
              message: s.updateCheckFailedTitle,
              detail: error instanceof Error ? error.message : String(error),
              buttons: [s.buttonOk],
            })
          }
        })()
        return
      }
      if (action === 'update-shell') {
        void (async () => {
          try {
            await shellUpdater.download((percent) => {
              panel.update({ runtime: currentRuntimeState, shell: currentShellState, shellCanInstall, shellProgress: percent })
            })
            const choice = await dialog.showMessageBox(window, {
              type: 'info',
              message: s.updateShellReadyTitle,
              detail: s.updateShellReadyDetail,
              buttons: [s.updateShellRestartNow, s.updateShellRestartLater],
              defaultId: 0,
              cancelId: 1,
            })
            if (choice.response === 0) shellUpdater.install(window)
          } catch (error) {
            await dialog.showMessageBox(window, {
              type: 'error',
              message: s.updateShellFailedTitle,
              detail: error instanceof Error ? error.message : String(error),
              buttons: [s.buttonOk],
            })
          }
        })()
      }
    },
  )

  const origin =
    runtime !== undefined && runtime.dir.startsWith(join(userDataDir, 'runtime'))
      ? s.updateSourceDownloaded
      : s.updateSourceBundled

  // 两条检查并行：它们各自要访问 npm registry 与 GitHub，串行会让等待翻倍。
  let currentRuntimeState: UpdatePanelState['runtime'] = {
    installed: runtimeVersion,
    state: 'checking',
    latestLabel: s.updateRuntimeLatestLabel,
    details: [
      { label: s.updateRuntimeSourceLabel, value: origin },
      ...(runtime === undefined ? [] : [{ label: s.updateLocationLabel, value: runtime.dir }]),
    ],
  }
  const push = (): void =>
    panel.update({
      runtime: currentRuntimeState,
      shell: currentShellState,
      shellCanInstall,
    })
  push()

  void (async () => {
    try {
      const check = await runtimeUpdater.check()
      currentRuntimeState = {
        installed: check.current,
        latest: check.latest.version,
        state: check.newer ? 'available' : 'latest',
        latestLabel: s.updateRuntimeLatestLabel,
        details: [
          { label: s.updateRuntimeSourceLabel, value: origin },
          { label: s.updateRegistryLabel, value: check.latest.registry },
          { label: s.updateChannelLabel, value: runtimeUpdater.channel },
          ...(runtime === undefined ? [] : [{ label: s.updateLocationLabel, value: runtime.dir }]),
        ],
      }
    } catch (error) {
      currentRuntimeState = {
        installed: runtimeVersion,
        state: 'unknown',
        reason: error instanceof Error ? error.message : String(error),
      }
    }
    push()
  })()

  void (async () => {
    try {
      const check = await shellUpdater.check(app.isPackaged)
      shellCanInstall = check.available && canInstallShell
      currentShellState = {
        installed: check.current,
        ...(check.latest === undefined ? {} : { latest: check.latest }),
        state: check.available ? 'available' : check.reason === undefined ? 'latest' : 'unknown',
        latestLabel: s.updateShellLatestLabel,
        ...(check.reason === undefined ? {} : { reason: check.reason }),
      }
    } catch (error) {
      currentShellState = {
        installed: shellVersion,
        state: 'unknown',
        reason: error instanceof Error ? error.message : String(error),
      }
    }
    push()
  })()
}

/** Register the preload bridge's IPC handlers. */
function registerIpc(updater: RuntimeUpdater): void {
  ipcMain.handle('dsh-desktop:check-runtime-update', async () => {
    const check = await updater.check()
    return { current: check.current, latest: check.latest.version, newer: check.newer }
  })
  ipcMain.handle('dsh-desktop:open-external', async (_event, url: unknown) => {
    if (typeof url === 'string' && /^https?:/u.test(url)) await shell.openExternal(url)
  })
}

/** 文件菜单里与工作区（项目）相关的动作。 */
export interface WorkspaceActions {  /** 弹出目录选择器，切换工作区。 */
  openFolder: () => void
  /** 切到某个最近打开过的目录。 */
  openRecent: (dir: string) => void
  /** 在系统文件管理器中打开当前工作区。 */
  revealWorkspace: () => void
  /** 复制当前工作区路径到剪贴板。 */
  copyWorkspacePath: () => void
  /** 菜单里"最近打开"的条目（已解析为可显示文案）。 */
  recent: Array<{ label: string; path: string }>
}

/**
 * Application menu, reduced to what a desktop shell should own.
 *
 * The content lives in `menu.ts` as a pure template (labels from `t()`), so this function only
 * has to install it and emit the diagnostic dump. Rebuilding is cheap and idempotent — that is
 * what makes a runtime language switch possible without restarting the app.
 *
 * @param deps - commands and dynamic data for the template.
 * @returns the installed template (for diagnostics/tests).
 */
function buildApplicationMenu(
  deps: Omit<ApplicationMenuDeps, 'strings' | 'shellVersion'>,
): Electron.MenuItemConstructorOptions[] {
  // 文案每次都从当前语言取：菜单会在语言变化时被重建（见 applyShellLocale）。
  const template = applicationMenuTemplate({ ...deps, strings: t(), shellVersion: SHELL_VERSION })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  // 诊断开关：DSH_DESKTOP_DUMP_MENU=1 时把菜单结构打到 stderr。
  //
  // 存在的理由：菜单在主进程里，渲染进程的 CDP 读不到；而没有可读的输出，
  // "菜单改对了吗"就只能靠人肉截图去猜。有了它，菜单结构可以被脚本断言——语言切换会
  // 再打一次，因此"运行中切换语言"同样可断言。
  if (process.env.DSH_DESKTOP_DUMP_MENU === '1') {
    process.stderr.write(`[menu]\n${dumpMenuTemplate(template)}\n[/menu]\n`)
  }
  return template
}

/** Best-effort shell self-update; never blocks startup. */
function resolveIconPath(packaged: boolean): string | undefined {
  const candidates = packaged
    ? [join(process.resourcesPath, 'icon.png'), join(process.resourcesPath, 'build', 'icon.png')]
    : [resolve(__dirname, '..', '..', 'build', 'icon.png')]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}
