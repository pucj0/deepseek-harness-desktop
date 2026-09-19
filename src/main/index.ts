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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BrowserWindow, Menu, Tray, app, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron'

import { CredentialStore } from './credentials'
import { DshServer } from './dsh-server'
import { formatGitBadge, readGitInfo } from './git'
import { format, initShellStrings, t } from './i18n'
import { healModuleFallback } from './module-heal'
import type { PanelRow } from './panel'
import { resolveRuntime } from './paths'
import type { RuntimeLocation } from './paths'
import { syncPluginsAtStartup } from './plugin-sync'
import { ensureRuntimeUnpacked } from './runtime-unpack'
import { showProjectInfo } from './project-info'
import { readSettings, switchWorkspace } from './settings'
import { ShellUpdater } from './shell-updater'
import { installCloseToTray, createTray } from './tray'
import { openUpdateWindow, type UpdatePanelState } from './update-window'
import { RuntimeUpdater, locateNpmCli } from './updater'
import { createMainWindow } from './window'
import { fallbackWorkspace, normalizeWorkspaceArgument, recentLabels, removeSplashFile } from './workspace'

const SHELL_VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version?: string })
      .version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

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

/**
 * 决定智能体把哪个目录当作工作区。
 *
 * 优先级：**切换意图 > 命令行参数 > 上次记住的选择 > 用户主目录**。
 *
 * 为什么"切换意图"要排在命令行参数之前：`app.relaunch()` 会沿用原来的命令行，
 * 而菜单里的「打开文件夹」正是靠重启来生效的。于是重启后 argv 里带着**旧**工作区，
 * 把用户刚选的新路径盖掉——表现为"重启了但还是老目录"（实测踩到过）。
 * 因此切换时通过环境变量显式传出目标，它在本次启动里优先级最高。
 *
 * @param argv - 本次启动的 `process.argv`。
 * @param userDataDir - Electron 的每用户数据目录。
 * @returns 工作区绝对路径。
 */
function resolveWorkspace(argv: string[], userDataDir: string): string {
  // 1) 菜单切换工作区时留下的"待切换"标记，只对紧接着的那一次启动有效。
  //
  // 用文件而不是环境变量：`app.relaunch()` 是否继承当前环境并不由我们保证，而文件
  // 一定跨得过重启。读到即删，避免它影响后续启动。
  const pendingPath = join(userDataDir, 'pending-workspace')
  if (existsSync(pendingPath)) {
    try {
      const requested = readFileSync(pendingPath, 'utf8').trim()
      rmSync(pendingPath, { force: true })
      const normalized = requested === '' ? undefined : normalizeWorkspaceArgument(requested)
      if (normalized !== undefined) {
        switchWorkspace(userDataDir, normalized)
        return normalized
      }
    } catch (error) {
      // 标记文件坏掉不该阻止启动——回落到常规解析。
      console.warn(`[shell] 无法读取待切换工作区: ${String(error)}`)
    }
  }

  const fromArgv = argv.slice(1).find((token) => !token.startsWith('--') && !token.startsWith('-'))
  if (fromArgv !== undefined) {
    const normalized = normalizeWorkspaceArgument(fromArgv)
    if (normalized !== undefined) {
      // 走 switchWorkspace 而不是只写 workspace：命令行打开一个目录同样应当
      // 进入"最近打开"列表。
      switchWorkspace(userDataDir, normalized)
      return normalized
    }
  }
  const remembered = readSettings(userDataDir).workspace
  if (remembered !== undefined && existsSync(remembered)) return remembered
  return fallbackWorkspace()
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

  // Localization must be resolved after ready: the system locale is not available
  // before it. Every shell-owned string (menus, tray, dialogs) reads from here.
  const strings = initShellStrings()

  const userDataDir = process.env.DSH_DESKTOP_HOME ?? app.getPath('userData')
  // `let` 而不是 `const`：切换工作区时会在原地更新它（不再重启应用）。
  let workspace = resolveWorkspace(process.argv, userDataDir)
  // A dedicated harness home keeps this app's sessions and credentials entirely
  // separate from a command-line `dsh` install, so the two can coexist.
  const dshHome = join(userDataDir, 'home')
  mkdirSync(dshHome, { recursive: true })

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
  })
  const window = mainWindow.window
  // 单独取出导航方法：`window` 是 BrowserWindow，本身没有 navigate。
  const navigate = mainWindow.navigate
  const initialWorkspace = workspace
  void readGitInfo(initialWorkspace).then((info) => {
    if (workspace === initialWorkspace) mainWindow.setGitBadge(formatGitBadge(info, '*'))
  })

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

  // `let` 而不是 `const`：切换工作区时会换掉这个实例。
  let server = new DshServer({
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
  // 抽成具名函数：切换工作区时会新建一个服务端实例，需要把同一个监听器挂上去。
  const forwardServerLog = ({ stream, line }: { stream: 'stdout' | 'stderr'; line: string }): void => {
    if (!app.isPackaged || stream === 'stderr') process[stream].write(`${line}\n`)
  }
  server.on('log', forwardServerLog)

  // 窗口已在前面建好（为了在解包运行时期间就能显示进度），这里不再重建。
  // 下面开始等 dsh 服务端就绪——它要 ~11 秒启动插件树，窗口此时正显示加载页。

  /**
   * 就地切换到新的工作区——换掉服务端并重新导航，**不重启应用**。
   *
   * 定义在这里而不是 `createWorkspaceActions` 里，是因为它需要访问 `main()` 作用域中的
   * 服务端、运行时、凭据与窗口，而这些在菜单动作那个模块级函数里都拿不到（只有解构出的
   * 只读副本）。早先因此只能用"重启应用"这个笨办法。
   * @param dir - 目标工作区绝对路径。
   */
  const onSwitchWorkspace = async (dir: string): Promise<void> => {
    workspace = dir
    // 插件按请求解析工作区时会读这个变量（分支徽章、审查面板都依赖它）。
    process.env.DSH_DESKTOP_WORKSPACE = dir

    // 先停旧服务端，避免两个进程争用同一个 harness home。
    await server.stop(2000)

    server = new DshServer({
      runtime: activeRuntime ?? runtime,
      dshHome,
      workspace: dir,
      env: credentials.read(),
    })
    server.on('log', forwardServerLog)

    try {
      // 关键的顺序：先把"上一个项目"的客户端状态清掉，再导航。
      //
      // dsh 把当前选中的会话与工作区视图存在 localStorage 里。切换项目后它们指向旧项目
      // 的会话，新服务端不认识，界面就卡在「自动重连中」——服务端其实已经就绪（实测）。
      await mainWindow.clearProjectState()
      await navigate(await server.start())
    } catch (error) {
      dialog.showErrorBox(
        strings.startupFailedTitle,
        `切换工作区失败：${error instanceof Error ? error.message : String(error)}\n\n工作区：${dir}`,
      )
    }
  }

  // 纯菜单诊断：菜单不依赖服务端，而启动服务端要 ~11 秒。以
  // DSH_DESKTOP_DUMP_MENU=1 启动时，构建完菜单就直接退出，让菜单可以被脚本
  // 快速断言，而不是每次等十几秒。
  if (process.env.DSH_DESKTOP_DUMP_MENU === '1') {
    buildApplicationMenu(
      window,
      updater,
      runtimeVersion,
      () => {},
      createWorkspaceActions({
        window,
        currentWorkspace: () => workspace,
        userDataDir,
        dshHome,
        runtime,
        runtimeVersion,
        strings,
        onSwitchWorkspace,
      }),
      () => {},
    )
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

  const tray = createTray(iconPath, {
    show: () => {
      window.show()
      window.focus()
    },
    restartServer: () => {
      void restart(server, window)
    },
    checkForUpdates: openUpdates,
    projectInfo: () => {
      showProjectInfoFor(window, workspace, dshHome, userDataDir, runtime, runtimeVersion, strings)
    },
    quit: () => {
      if (session !== undefined) session.quitting = true
      app.quit()
    },
  })

  installCloseToTray(window, () => tray !== undefined && session?.quitting !== true)
  window.on('closed', () => {
    // Closing the last window ends the app only when the tray is absent.
    if (tray === undefined) app.quit()
  })

  buildApplicationMenu(
    window,
    updater,
    runtimeVersion,
    () => {
      showProjectInfoFor(window, workspace, dshHome, userDataDir, runtime, runtimeVersion, strings)
    },
    createWorkspaceActions({
        window,
        currentWorkspace: () => workspace,
        userDataDir,
        dshHome,
        runtime,
        runtimeVersion,
        strings,
        onSwitchWorkspace,
      }),
    openUpdates,
  )
  session = { server, window, ...(tray !== undefined ? { tray } : {}), updater, quitting: false }

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
 * 关键取舍：切换工作区**重启整个应用**，而不是原地换掉子进程的 `--workspace`。
 * 原因：
 *   * 工作区是在服务端启动时传入的，中途更换意味着要重建整棵插件树（约 11 秒），
 *     而重启走的是同一条已验证的启动路径，出问题的面更小；
 *   * 只有一条启动路径，不存在"半个进程还在用旧工作区"的中间态；
 *   * 会话已持久化，重启后可继续。
 *
 * @param deps - 需要的窗口、当前工作区、数据目录、服务端与文案。
 * @returns 菜单动作集合。
 */
function createWorkspaceActions(deps: {
  window: BrowserWindow
  /**
   * 读取**当前**工作区。
   *
   * 用取值函数而不是传入字符串：切换工作区是就地发生的，闭包捕获的字符串会一直是切换前
   * 的值——那会让"最近打开"里的当前项判断失误、也会把旧路径复制到剪贴板。
   */
  currentWorkspace: () => string
  userDataDir: string
  /** 项目信息面板需要的数据目录、harness 主目录与运行时（它们也在 main() 作用域里）。 */
  dshHome: string
  runtime: RuntimeLocation
  runtimeVersion: string
  strings: ReturnType<typeof t>
  /**
   * 就地切换到新工作区。
   *
   * 由 `main()` 提供：切换需要换掉服务端实例并重新导航，而服务端、运行时、凭据、
   * 窗口都在 `main()` 的作用域里。此前这段逻辑写在这里，结果因为它只能拿到解构出的
   * 只读副本（窗口、工作区、服务端都是 const），既改不了服务端、也拿不到运行时，
   * 于是只能用"重启应用"这个笨办法。改成注入回调后，切换不再需要重启。
   */
  onSwitchWorkspace: (dir: string) => Promise<void>
}): WorkspaceActions {
  const { window, userDataDir, currentWorkspace, dshHome, runtime, runtimeVersion, strings, onSwitchWorkspace } = deps
  const s = strings

  /**
   * 切换到新的工作区。
   *
   * 真正的落地（换服务端、重新导航）由注入的 `onSwitchWorkspace` 完成——它运行在
   * `main()` 的作用域里，能拿到服务端、运行时与窗口。这里只负责记录选择并转发。
   *
   * 为什么不再重启应用：换工作区原本走 `app.relaunch()`，用户看到的是"选了文件夹之后
   * 应用自己重启了"——窗口消失、白屏十几秒、会话列表重新加载。而窗口与渲染进程根本
   * 不需要重建，只有服务端需要换。
   * @param dir - 目标工作区绝对路径。
   */
  const applyWorkspace = (dir: string): void => {
    switchWorkspace(userDataDir, dir)
    void onSwitchWorkspace(dir)
  }

  const recent = recentLabels(readSettings(userDataDir).recent ?? [])

  return {
    recent: recent.map((label, index) => ({
      label,
      path: (readSettings(userDataDir).recent ?? [])[index] ?? '',
    })),
    openFolder: (): void => {
      const picked = dialog.showOpenDialogSync(window, {
        title: s.dialogOpenFolderTitle,
        buttonLabel: s.dialogOpenFolderButton,
        properties: ['openDirectory', 'createDirectory'],
      })
      const dir = picked?.[0]
      if (dir === undefined) return

      // 此前这里会提示"应用将重启"，因为切换确实走 app.relaunch()。现在切换是就地的
      // （只换服务端、窗口不动），因此确认框只需要说明要切换工作区。
      const confirmation = dialog.showMessageBoxSync(window, {
        type: 'question',
        title: s.switchWorkspaceTitle,
        message: s.switchWorkspaceMessage,
        detail: `${dir}\n\n${s.switchWorkspaceDetail}`,
        buttons: [s.switchWorkspaceConfirm, s.switchWorkspaceCancel],
        defaultId: 0,
        cancelId: 1,
      })
      if (confirmation !== 0) return
      applyWorkspace(dir)
    },
    openRecent: (dir: string): void => {
      if (dir === '' || dir === currentWorkspace()) return
      applyWorkspace(dir)
    },
    revealWorkspace: (): void => {
      void shell.openPath(currentWorkspace())
    },
    copyWorkspacePath: (): void => {
      clipboard.writeText(currentWorkspace())
      dialog.showMessageBox(window, {
        type: 'info',
        message: s.copiedPathTitle,
        detail: `${currentWorkspace()}\n\n${s.copiedPathMessage}`,
        buttons: [s.buttonOk],
      })
    },
  }
}

/**
 * Restart the agent runtime child process in place, keeping the window.
 * @param server - the running child.
 * @param window - the window to reload afterwards.
 */
async function restart(server: DshServer, window: BrowserWindow): Promise<void> {
  await server.stop()
  try {
    const ready = await server.start()
    await window.loadURL(ready.authenticatedUrl)
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

/** Application menu, reduced to what a desktop shell should own. */
function buildApplicationMenu(
  window: BrowserWindow,
  updater: RuntimeUpdater,
  runtimeVersion: string,
  openProjectInfo: () => void,
  workspaceActions: WorkspaceActions,
  openUpdates: () => void,
): void {
  const s = t()
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: s.menuFile,
      submenu: [
        { label: s.itemOpenFolder, accelerator: 'CmdOrCtrl+O', click: workspaceActions.openFolder },
        {
          label: s.itemOpenRecent,
          submenu:
            workspaceActions.recent.length === 0
              ? [{ label: s.itemNoRecent, enabled: false }]
              : workspaceActions.recent.map((entry) => ({
                  label: entry.label,
                  toolTip: entry.path,
                  click: () => workspaceActions.openRecent(entry.path),
                })),
        },
        { type: 'separator' },
        { label: s.itemProjectInfo, accelerator: 'CmdOrCtrl+I', click: openProjectInfo },
        {
          label: s.itemRevealWorkspace,
          click: workspaceActions.revealWorkspace,
        },
        { label: s.itemCopyWorkspacePath, click: workspaceActions.copyWorkspacePath },
        { type: 'separator' },
        { label: s.itemReload, role: 'reload' },
        { label: s.itemForceReload, role: 'forceReload' },
        { label: s.itemToggleDevTools, role: 'toggleDevTools' },
        { type: 'separator' },
        { label: s.itemQuit, role: 'quit' },
      ],
    },
    {
      label: s.menuEdit,
      submenu: [
        { label: s.itemUndo, role: 'undo' },
        { label: s.itemRedo, role: 'redo' },
        { type: 'separator' },
        { label: s.itemCut, role: 'cut' },
        { label: s.itemCopy, role: 'copy' },
        { label: s.itemPaste, role: 'paste' },
        { label: s.itemSelectAll, role: 'selectAll' },
      ],
    },
    {
      label: s.menuView,
      submenu: [
        { label: s.itemResetZoom, role: 'resetZoom' },
        { label: s.itemZoomIn, role: 'zoomIn' },
        { label: s.itemZoomOut, role: 'zoomOut' },
        { type: 'separator' },
        { label: s.itemToggleFullScreen, role: 'togglefullscreen' },
      ],
    },
    {
      // 更新入口是一等公民：它是用户唯一能主动让应用变新的地方。
      //
      // 这里**不再**列出两行版本号。原先那种「智能体运行时 0.1.5-rc.1 / 外壳 1.0.0」
      // 的写法把元数据混进行动菜单，读起来像选项却点不动，观感很怪。版本信息改到
      // 更新窗口里展示——那里还能同时给出「最新版本」与来源，信息更完整。
      label: s.menuUpdate,
      submenu: [
        {
          label: s.itemCheckUpdates,
          accelerator: 'CmdOrCtrl+Shift+U',
          click: () => void openUpdates(),
        },
      ],
    },
    {
      label: s.menuHelp,
      submenu: [
        { label: s.itemCheckUpdates, click: () => void openUpdates() },
        { type: 'separator' },
        {
          label: s.itemOpenReleases,
          click: () => void shell.openExternal('https://github.com/pucj0/deepseek-harness-desktop/releases'),
        },
        { type: 'separator' },
        // 静态元数据放在帮助菜单里，并明确标为不可点击的信息。
        { label: `${s.itemRuntimeVersion}  ${runtimeVersion}`, enabled: false },
        { label: `${s.itemShellVersion}  ${SHELL_VERSION}`, enabled: false },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))

  // 诊断开关：DSH_DESKTOP_DUMP_MENU=1 时把菜单结构打到 stderr。
  //
  // 存在的理由：菜单在主进程里，渲染进程的 CDP 读不到；而没有可读的输出，
  // "菜单改对了吗"就只能靠人肉截图去猜。有了它，菜单结构可以被脚本断言。
  if (process.env.DSH_DESKTOP_DUMP_MENU === '1') {
    const dump = (items: Electron.MenuItemConstructorOptions[], indent = ''): string =>
      items
        .map((item) => {
          const label = item.label ?? (item.role === undefined ? '(分隔)' : `role=${item.role}`)
          const accel = item.accelerator === undefined ? '' : `  [${item.accelerator}]`
          const disabled = item.enabled === false ? '  (禁用)' : ''
          const head = `${indent}${label}${accel}${disabled}`
          const children = Array.isArray(item.submenu)
            ? '\n' + dump(item.submenu as Electron.MenuItemConstructorOptions[], `${indent}    `)
            : ''
          return head + children
        })
        .join('\n')
    process.stderr.write(`[menu]\n${dump(template)}\n[/menu]\n`)
  }
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
