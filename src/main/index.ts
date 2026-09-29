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
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BrowserWindow, Menu, Tray, app, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron'

import { ActiveWorkspaceController, applyHarnessReport } from './active-workspace'
import { CredentialStore } from './credentials'
import { DshServer } from './dsh-server'
import type { ServerReady } from './dsh-server'
import { formatGitBadge, readGitInfo } from './git'
import { readLocalePreference, watchLocalePreference } from './harness-locale'
import { coerceReportedLocale, currentLocale, format, initShellStrings, resolveShellLocale, setShellLocale, t } from './i18n'
import { healModuleFallback } from './module-heal'
import { applicationMenuTemplate, dumpMenuTemplate, menuBarEntries, openMenuAt } from './menu'
import type { ApplicationMenuDeps } from './menu'
import type { PanelRow } from './panel'
import { resolveRuntime } from './paths'
import type { RuntimeLocation } from './paths'
import { syncPluginsAtStartup } from './plugin-sync'
import { ensureRuntimeUnpacked } from './runtime-unpack'
import { showProjectInfo } from './project-info'
import { readSettings, switchWorkspace } from './settings'
import { checkRuntimeRelease, RUNTIME_RELEASES_URL } from './runtime-release'
import { ShellUpdater } from './shell-updater'
import { installCloseToTray, createTray, refreshTray } from './tray'
import type { TrayActions } from './tray'
import { openUpdateWindow, type UpdatePanelState } from './update-window'
import { createMainWindow } from './window'
import type { ActiveWorkspaceReportPayload } from './window'
import { createWorkspaceActions } from './workspace-actions'
import type { WorkspaceActionEffects, WorkspaceActions } from './workspace-actions'
import { pickRegisteredFallback, reconcileWorkspaceState } from './workspace-reconcile'
import { readWorkspaceRegistry } from './workspace-registry'
import { forgetWorkspaceAndRestart, resolveWorkspaceIntent, restartIntoWorkspace } from './workspace-switch'
import {
  fallbackWorkspace,
  isSameWorkspace,
  readPendingForgets,
  removeSplashFile,
  takePendingForgets,
  workspaceIdentity,
} from './workspace'

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
  // A dedicated harness home keeps this app's sessions and credentials entirely
  // separate from a command-line `dsh` install, so the two can coexist.
  const dshHome = join(userDataDir, 'home')
  mkdirSync(dshHome, { recursive: true })

  /**
   * 启动期工作区对账。
   *
   * 三件事，缺一不可（工作区生命周期的全部入口都在这里对齐）：
   *   1. **prune + persist**——把 `settings.recent` 里已经不存在的目录真正从磁盘删掉，
   *      而不是只过滤返回值（BUG A）；
   *   2. **provenance**——`resolveWorkspaceIntent()` 说明这个路径是"用户明确要打开的"
   *      还是"上次记住的"，后者**不允许**登记进 Harness 注册表（BUG C：用户在 Harness
   *      里删掉的工作区会在下次启动时被无声创建回来）；
   *   3. **冲突时 Harness 胜出**——Desktop 记着的目录不在注册表里时，采用注册表里最近的
   *      有效工作区，并把 `settings.workspace` 同步过去。
   *
   * 这个 `workspace` 是**启动期**（引导）工作区，本次进程内不再改变；运行期的"当前工作区"
   * 由 `active` 持有（见 ActiveWorkspaceController）。
   */
  const startupWorkspace = reconcileWorkspaceState({
    userDataDir,
    dshHome,
    resolution: resolveWorkspaceIntent(process.argv, userDataDir),
    home: fallbackWorkspace(),
  })
  const workspace = startupWorkspace.active
  for (const removed of startupWorkspace.recentRemoved) {
    process.stderr.write(`[shell] 已从「最近打开」里清理不存在的目录: ${removed}\n`)
  }
  if (startupWorkspace.abandoned !== undefined) {
    process.stderr.write(
      `[shell] 工作区对账（${startupWorkspace.reason}）: 放弃 ${startupWorkspace.abandoned}，改用 ${workspace}\n`,
    )
  }
  process.stderr.write(
    `[shell] 启动工作区: ${workspace}（source=${startupWorkspace.source}，reason=${startupWorkspace.reason}，register=${String(startupWorkspace.register)}）\n`,
  )

  /** 读一次 Harness 注册表（每次现读：它的写入方是服务端子进程）。 */
  const registryView = () => readWorkspaceRegistry(dshHome)

  /** 目录存在性判断（active workspace 的回退与校验用）。 */
  const isUsableDirectory = (dir: string): boolean => {
    try {
      return existsSync(dir) && statSync(dir).isDirectory()
    } catch {
      return false
    }
  }

  /**
   * 运行期 active workspace：菜单、托盘、项目信息都读它。
   *
   * `startup` 只是初值；Harness ready 之后由 `dsh-client-ui-shell-bridge` 上报的
   * "当前会话所属工作区"接管（见 window.ts 的 IPC 与 active-workspace.ts 的校验）。
   */
  const active = new ActiveWorkspaceController({
    startup: { path: workspace, source: startupWorkspace.source },
    // 安全边界（**严格**）：只接受 Harness 注册表里已有的工作区。渲染进程无法凭一条 IPC
    // 让外壳去打开任意路径（例如 C:\Windows）。
    isRegistered: (path) => {
      const view = registryView()
      return view.entries.some((entry) => workspaceIdentity(entry.path) === workspaceIdentity(path))
    },
    // 点击时的有效性检查（**宽松**，方向相反：宁可认为它还有效）。
    //   * 读不到注册表 → 不能证明它被删了；
    //   * 注册表里一个文件系统工作区都没有 → 那不是"你删了它"（例如注册失败/引导期）；
    // 只有"确实读到注册表、且里面没有这条记录"才算失效。这正是 Harness 里删除工作区之后
    // 外壳必须立刻停止使用它的那条判定（需求 42）。
    isStillRegistered: (path) => {
      const view = registryView()
      if (!view.readable || view.entries.length === 0) return true
      return view.entries.some((entry) => workspaceIdentity(entry.path) === workspaceIdentity(path))
    },
    isDirectory: isUsableDirectory,
    // 回退优先级：注册表里最近的有效工作区（注册表自己的顺序就是"最近的在前"，
    // 官方 UI 用的也是它）→ 用户主目录。
    fallback: (exclude) => {
      const view = registryView()
      const usable = exclude === undefined
        ? view
        : { ...view, entries: view.entries.filter((entry) => workspaceIdentity(entry.path) !== workspaceIdentity(exclude)) }
      return pickRegisteredFallback(usable, isUsableDirectory) ?? fallbackWorkspace()
    },
    // 「切换到哪个工作区」的唯一落盘口：settings.workspace + recent 一起更新。
    persist: (path) => {
      switchWorkspace(userDataDir, path)
    },
  })

  // Localization: the source of truth is **Harness's own language setting**, persisted in the
  // host settings document under `locale.preference` (see harness-locale.ts). Read it before the
  // window exists so the very first frame is already in the right language — no English flash
  // that later flips to Chinese. With no stored preference the system language is used, which is
  // exactly Harness's own browser-derived fallback. Every shell-owned string (menus, tray,
  // dialogs) reads from this same table; `applyShellLocale` refreshes what is built rather than
  // read per use.
  //
  // 这份值还决定了诊断行里 `pref=` 那一项：它把"读到文件"与"回退系统语言"区分开——两者
  // 在中文机器上都会显示 `locale=zh-CN`，只看语言是分不出来的（排查时真的被它绕过一次）。
  const localePreference = readLocalePreference(dshHome)
  const strings = initShellStrings(localePreference)

  /**
   * 启动期就要能装好的菜单：**必须在建窗口之前**。
   *
   * 顺序为什么重要：标题栏页面（窗口自身的文档）在加载时就会 `getMenu()`，而那个 IPC 读的
   * 是 `Menu.getApplicationMenu()`。菜单此时若还没装，Electron 会给出它自己的**默认菜单**
   * ——`File / Edit / View / Window / Help`，其中那个 `Window` 是 Electron 加的、本产品根本
   * 没有这一项。这正是"源码里顶层是『更新』，界面上却出现『Window』"的来源：菜单是在服务端
   * 就绪之后（十几秒）才装的，而窗口早就可见了，标题栏在这段时间里已经把默认菜单画了出来，
   * 之后又没有任何东西通知它"菜单换了"（见 ShellState.menuRevision）。
   *
   * 这些回调**延迟绑定**：`actions`（工作区动作）与 `openUpdatesEntry`（检查更新）都要等
   * 启动流程更靠后才会赋值，而菜单现在就得构建出来。回调在点击那一刻才解析，因此"命令"
   * 永远是当时那一份实现——这与"重建菜单只换文案、不换命令"是同一条约束。
   */
  /** 工作区动作（启动流程更靠后赋值；菜单回调在点击时读它）。 */
  let actions!: WorkspaceActions
  /** 构造一份新的工作区动作；在 `workspaceActions` 定义之前是 undefined。 */
  let makeWorkspaceActions: (() => WorkspaceActions) | undefined
  /** 「检查更新」入口（服务端就绪之后才有）。 */
  let openUpdatesEntry: (() => void) | undefined
  /** 智能体运行时版本（帮助菜单里的信息行；解包/解析之后才有真值）。 */
  let runtimeVersion = 'unknown'
  /** 菜单版本号：每次重建 +1，标题栏据此重新拉取菜单按钮。 */
  let menuRevision = 0
  /** 主窗口（创建之后才有）：菜单重建时要靠它把状态推给标题栏。 */
  let shellWindow: ReturnType<typeof createMainWindow> | undefined
  /** 托盘（创建之后才有）：语言变化时要重建它的菜单。 */
  let tray: Tray | undefined
  /** 托盘动作（与托盘一起创建）。 */
  let trayActions: TrayActions | undefined
  /** 停止监听 Harness 语言设置（退出时收尾）。 */
  let stopLocaleWatch: (() => void) | undefined

  /**
   * 组装菜单输入（文案与外壳版本由 `buildApplicationMenu` 补上）。
   *
   * 只在**构建那一刻**读 `runtimeVersion` 与「最近打开」快照，其余全是延迟绑定的回调，
   * 因此这个函数从启动早期（窗口还不存在）到运行期都可以安全调用。
   *
   * @returns 交给 `applicationMenuTemplate` 的命令与动态数据。
   */
  const applicationMenuDeps = (): Omit<ApplicationMenuDeps, 'strings' | 'shellVersion'> => {
    // 「最近打开」是构建时的快照（`createWorkspaceActions` 读一次 settings），所以每次重建
    // 菜单都换一份新的动作对象，列表不会停在旧快照上。早期还没有构造器 → 列表为空。
    if (makeWorkspaceActions !== undefined) actions = makeWorkspaceActions()
    return {
      recent: actions?.recent ?? [],
      runtimeVersion,
      openFolder: () => actions.openFolder(),
      openRecent: (path) => actions.openRecent(path),
      removeRecent: (path) => actions.removeRecent(path),
      projectInfo: () => actions.projectInfo(),
      revealWorkspace: () => actions.revealWorkspace(),
      copyWorkspacePath: () => actions.copyWorkspacePath(),
      forgetWorkspace: () => actions.forgetWorkspace(),
      openUpdates: () => openUpdatesEntry?.(),
      openReleases: () => void shell.openExternal(RELEASES_URL),
    }
  }

  /**
   * 重建应用菜单，并把"菜单换了一份"告诉标题栏。
   *
   * 三件事必须一起做，缺一不可：
   *   1. `menuRevision += 1`——页面据此知道菜单按钮要重拉；
   *   2. `Menu.setApplicationMenu(...)`——原生菜单与标题栏按钮的文案都来自它；
   *   3. `publishShellState()`——推一次状态，页面才会真的去重拉。
   *
   * 第 3 步早先是漏掉的：菜单被换成真正的应用菜单之后没有任何通知，标题栏于是永远停在
   * 窗口创建那一刻拿到的 Electron 默认菜单上（`… / Window / …`）。
   *
   * 两处调用：语言变化（换文案，命令必须不变）与「最近打开」变化（换数据）。
   */
  const refreshApplicationMenu = (): void => {
    menuRevision += 1
    const template = buildApplicationMenu(applicationMenuDeps())
    // 开发诊断：外壳版本 / 当前语言 / 顶层菜单文案。
    //
    // 存在的理由：菜单在主进程里，渲染进程的 CDP 读不到，"跑的这一份 build 到底装了哪些
    // 顶层菜单"就只能靠人肉截图猜。打包后的生产运行不打印（这里没有敏感路径，但也没必要
    // 往用户机器上写日志）；`DSH_DESKTOP_DUMP_MENU=1` 时无论如何都打印，供测试断言。
    if (!app.isPackaged || process.env.DSH_DESKTOP_DUMP_MENU === '1') {
      process.stderr.write(
        `[shell] version=${SHELL_VERSION} electron=${process.versions.electron ?? '—'} locale=${currentLocale()} pref=${localePreference ?? '(none)'} menuRevision=${menuRevision} menu=${template
          .map((item) => item.label ?? '(分隔)')
          .join('|')}\n`,
      )
    }
    shellWindow?.publishShellState()
  }

  // 先把菜单装上，再建窗口：标题栏的第一次 getMenu() 因此就是真实菜单（不是 Electron 默认菜单）。
  refreshApplicationMenu()

  /**
   * 把"Harness 的语言变了"应用到已经构建出来的界面上。
   *
   * 三件事，缺一不可：
   *   * 应用菜单——重建它（标题栏的菜单按钮与原生下拉的文案都来自它），并把这次重建推给
   *     标题栏（`refreshApplicationMenu` 自己会 `publishShellState`）；
   *   * 托盘菜单——它是启动时构建的，不重建就会留在旧语言；
   *   * 标题栏状态——推一次状态，页面据此改写 `<html lang>`、导航按钮文案并重新取菜单按钮。
   *
   * 对话框、项目信息窗口、更新窗口不在这里：它们拿的是同一份**活**文案表（`strings`），
   * 读的时候已经是新语言。
   *
   * 重建**不会**把工作区带回启动值：菜单项都在点击时读 `active.get()`，重建只换文案与
   * 「最近打开」的数据，不换"当前项目"的判定来源（见 workspace-actions.ts 的说明）。
   *
   * 它刻意在**启动最早期**就能安全调用（窗口、托盘、工作区动作都还可能是 undefined）：
   * 语言设置的监听从这一刻起就生效，用户不需要等到服务端起来才能切语言。
   *
   * @param locale - 新的语言偏好（原始值；undefined 表示偏好被清空 → 回退系统语言）。
   */
  const applyShellLocale = (locale: string | undefined): void => {
    // 没有偏好（第一次使用，或用户把设置清空）时回退系统语言——与启动路径同一个判定。
    if (!setShellLocale(resolveShellLocale(locale))) return
    refreshApplicationMenu()
    if (tray !== undefined && trayActions !== undefined) refreshTray(tray, trayActions)
  }

  /**
   * 处理 Harness **运行期上报**的生效语言（见 shell-bridge 的客户端半边）。
   *
   * 与语言设置的**文件监听**（`watchLocalePreference` → `applyShellLocale`）是互补的两条路：
   *   * 文件里是"用户显式选过的偏好"，冷启动只有它可读；
   *   * 这条上报是"Harness 此刻真正在用的语言"，覆盖"从没选过"（provisional 值来自浏览器语言）
   *     与"语言包注册的自定义 id"两种情况——那两种情况下文件里什么都没有。
   *
   * 规则：`coerceReportedLocale` 只认这个外壳真的带字典的语言（`zh*` / `en*` 的各种写法）。
   * **不认识的值保持现状**，不回退到系统语言——这条上报是**纠正**，不是"用户清空了偏好"。
   *
   * @param raw - preload 送来的原始语言值（已确认来自 Harness 视图且是字符串）。
   */
  const applyHarnessLocaleReport = (raw: string): void => {
    const next = coerceReportedLocale(raw)
    if (next === undefined) return
    if (next === currentLocale()) return
    process.stderr.write(`[shell] 语言跟随 Harness 运行期上报: ${raw} → ${next}\n`)
    applyShellLocale(next)
  }

  // 跟随 Harness 的语言设置：宿主把用户选择写进 `<dshHome>/settings.yaml` 的
  // `locale.preference`，这里盯着同一个文件，改了就重建菜单/托盘并刷标题栏——**不重启应用**。
  //
  // 注册得**越早越好**（就在冷启动读完之后），并把冷启动读到的那个值作为基准：
  //   * "读到偏好"与"起服务端"之间隔着十几秒（首次启动还要解包运行时），用户完全可能在
  //     这段时间里改语言；只在服务端就绪之后才注册监听，那次修改就永远等不到事件；
  //   * 基准显式传进去，因此这几秒里的修改会在注册后的第一次对账里被认出来。
  stopLocaleWatch = watchLocalePreference(dshHome, applyShellLocale, localePreference)

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
    // 导航按钮的无障碍文案**刻意不在这里传**：它是动态 i18n，而 `createMainWindow` 只在创建
    // 时读一次参数，传进来等于把它冻在启动时的语言上（语言一变，「返回 / 前进」还停在旧语言）。
    // 默认实现每次 `currentState()` 都从活文案表 `t()` 取当前值（见 window.ts）。
    // Harness 上报的"当前工作区"。这里是**第一道**门槛：只做形状校验，且只认来自
    // Harness 子视图的消息（见 window.ts）。语义校验（绝对路径、目录存在、是否已注册）
    // 在下面 applyActiveWorkspaceReport 里做——那里才知道注册表。
    onActiveWorkspaceReport: (payload) => {
      applyActiveWorkspaceReport(payload)
    },
    /**
     * Harness **运行期上报**的生效语言（见 preload.ts 的 reportLocale 与
     * dsh-client-ui-shell-bridge 的客户端半边）。
     *
     * 它是冷启动"读配置文件"那条路之外的**第三条**来源：用户从没选过语言（Harness 用的是
     * 从浏览器语言推导的 provisional 值）或语言由语言包注册时，settings.yaml 给不出答案，
     * 而 Harness 界面自己知道。没有这一条，就会出现"Harness 已经是中文、外壳菜单还是英文"。
     */
    onLocaleReport: (locale) => {
      applyHarnessLocaleReport(locale)
    },
    // 标题栏里的菜单按钮与"点哪个弹哪个"都来自**同一份原生菜单**（上面构建的那个）。
    // 菜单因此只有一份定义：accelerator 仍由它注册，标题栏只是换个地方画标题。
    menu: {
      entries: () => menuBarEntries(Menu.getApplicationMenu() ?? Menu.buildFromTemplate([])),
      open: (index, point, onClosed) => {
        const applicationMenu = Menu.getApplicationMenu()
        if (applicationMenu === null) return false
        return openMenuAt(applicationMenu, index, window, point, onClosed)
      },
      // 菜单每次重建都会 +1；标题栏看到它变了就重新取一次按钮（见 window.ts 的说明）。
      revision: () => menuRevision,
    },
  })
  const window = mainWindow.window
  shellWindow = mainWindow

  /**
   * 处理一次 Harness 上报（在窗口创建之后定义，因为它要读 `window` 之外的注册表状态）。
   *
   * 校验链（渲染进程的输入一律不可信）：
   *   1. `null` 是合法的：语义是"Harness 此刻没有当前会话"，保持上一个已知值；
   *   2. 带 `workspaceId` 时，先按 id 在注册表里找，找不到、或**它指向的路径与上报的
   *      路径不一致**，整条丢弃——这比只看路径更强；
   *   3. 剩下的交给 `ActiveWorkspaceController`：绝对路径 + 目录存在 + 已注册。
   * 被拒绝的路径如果正好是当前 active，控制器会立刻回退到一个仍然有效的工作区，
   * 因此不会出现"active 指着已被移除的工作区"的半失效状态。
   *
   * @param payload - 已经过形状校验的上报载荷。
   */
  const applyActiveWorkspaceReport = (payload: ActiveWorkspaceReportPayload): void => {
    // 策略本身在 active-workspace.ts 里（可被回归测试直接驱动），这里只负责日志与
    // "接受之后顺手重建菜单"。
    const outcome = applyHarnessReport(active, payload, registryView)
    if (outcome === 'idMismatch') {
      process.stderr.write(
        `[shell] 忽略一次 active workspace 上报：workspaceId 与路径对不上（${String(payload.workspaceId)} vs ${String(payload.path)}）\n`,
      )
      return
    }
    if (outcome === 'accepted') {
      process.stderr.write(`[shell] active workspace 跟随 Harness: ${active.get()}\n`)
      // 菜单不需要重建就能跟随项目（项目信息 / 在文件管理器中打开 / 复制路径都在点击时读
      // active.get()，见 workspace-actions.ts）。但切换工作区会把它写进「最近打开」，
      // 而那个列表是构建时快照——重建一次让它立刻反映出来。
      refreshApplicationMenu()
    }
  }

  void readGitInfo(workspace).then((info) => mainWindow.setGitBadge(formatGitBadge(info, '*')))

  // 解包内置运行时（已解过则瞬间返回）。
  let unpackedDir: string | undefined
  // Every packaged release boots the runtime bundled with that same release.
  // Legacy npm-updated runtimes under userData/runtime are intentionally ignored.
  if (app.isPackaged) {
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

  // 把本 Release 携带的客户端插件同步进同一 Release 的 bundled Runtime。
  // 必须在服务端进程启动前、每次启动都做：插件不在官方 dsh 依赖闭包中，只随桌面包
  // 发布；同步也能修复被用户误删的插件文件。旧 userData/runtime/current 不参与解析。
  const pluginSync = syncPluginsAtStartup({
    runtimeDir: runtime.dir,
    resourcesPath: process.resourcesPath,
    repoRoot: resolve(__dirname, '..', '..'),
    userDataDir,
    packaged: app.isPackaged,
    ...(unpackedDir === undefined ? {} : { unpackedDir }),
  })
  for (const line of pluginSync.messages) process.stderr.write(`${line}\n`)

  try {
    runtimeVersion = (JSON.parse(readFileSync(runtime.installAnchor, 'utf8')) as { version?: string }).version ?? runtime.stagedVersion ?? 'unknown'
  } catch {
    runtimeVersion = runtime.stagedVersion ?? 'unknown'
  }
  activeRuntime = runtime
  process.env.DSH_DESKTOP_SHELL_VERSION = SHELL_VERSION
  process.env.DSH_DESKTOP_RUNTIME_VERSION = runtimeVersion

  // 服务端实例在本次进程里只有一个：切换工作区走的是重启应用（见 workspace-switch.ts），
  // 不再就地替换它。
  const server = new DshServer({
    runtime,
    dshHome,
    workspace,
    // 登记意图来自启动期对账：只有"用户明确要打开这个目录"或"注册表里一个可用的
    // 文件系统工作区都没有（引导）"才会带上它。`--workspace` 本身**不**蕴含登记。
    registerWorkspace: startupWorkspace.register,
    // 「移除工作区」的意图（上一次会话写下的标记）：由服务端进程用官方
    // `workspaceRegistry.delete()` 执行，外壳只传路径。这里是**不消费**的读——
    // 标记要等服务端真的起来（下面 `start()` 成功）之后才算被用掉，否则一次启动失败
    // 就会把用户的移除意图悄悄丢掉。
    forgetWorkspaces: readPendingForgets(userDataDir),
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
      // **点击时**读 active，而不是启动时的常量：Harness 里切过项目之后，"选中的就是当前
      // 目录"必须按新值判断，否则会为一个已经是当前的目录白重启一次。
      current: active.get(),
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
   * 「文件 → 移除工作区…」：只从 Harness 注册表里去掉登记（文件、会话一律保留）。
   *
   * 目标是当前工作区时，**先**把下一次启动的工作区换成另一个仍然有效的目录，再移除——
   * 否则会留下"active 指着一个已被移除的工作区"的半失效状态。接管者的优先级：
   * 注册表里最近的**其它**有效工作区 → 用户主目录。
   */
  const onForgetWorkspace = (dir: string): void => {
    void forgetWorkspaceAndRestart({
      userDataDir,
      target: dir,
      current: active.get(),
      nextActive: activeNextAfterForget(dir),
      beginQuit: () => {
        if (session !== undefined) session.quitting = true
      },
      stopServer: () => server.stop(2000),
      relaunch: () => app.relaunch(),
      exit: (code) => app.exit(code),
    })
  }

  /** 移除 `target` 之后接管的工作区：注册表里最近的其它有效工作区，否则主目录。 */
  const activeNextAfterForget = (target: string): string => {
    const view = registryView()
    const others = {
      ...view,
      entries: view.entries.filter((entry) => !isSameWorkspace(entry.path, target)),
    }
    return pickRegisteredFallback(others, isUsableDirectory) ?? fallbackWorkspace()
  }

  /**
   * 「文件」菜单的工作区动作。
   *
   * 每次重建都拿一份**新**的动作对象：`recent` 是构建时的快照（`createWorkspaceActions`
   * 读一次 settings），而菜单是静态模板，所以"最近打开"变了就必须重建。其余命令是纯闭包，
   * 重建后行为完全相同。
   *
   * 关键不变量：**没有任何一处把 `workspace`（启动值）捕获进来**。所有"当前工作区"都在
   * 点击那一刻读 `active.get()`，因此 Harness 切项目、语言重建菜单、乃至工作区被删掉，
   * 三个菜单项都跟着走（BUG B）。
   */
  const workspaceActions = (): WorkspaceActions =>
    createWorkspaceActions({
      active,
      userDataDir,
      strings,
      effects: workspaceActionEffects,
      onSwitchWorkspace,
      onForgetWorkspace,
      onProjectInfo: (current) => {
        showProjectInfoFor(window, current, dshHome, userDataDir, runtime, runtimeVersion, strings)
      },
    })

  /** 菜单与托盘共用的工作区动作（托盘只用到 `projectInfo`）。 */
  // 变量本身在启动早期就声明了（菜单必须在窗口之前装好，见上面 applicationMenuDeps 的说明）。
  makeWorkspaceActions = workspaceActions

  /** Electron 侧的四件事（注入，因此 workspace-actions 可以被离线测试直接驱动）。 */
  const workspaceActionEffects: WorkspaceActionEffects = {
    pickDirectory: () =>
      dialog.showOpenDialogSync(window, {
        title: strings.dialogOpenFolderTitle,
        buttonLabel: strings.dialogOpenFolderButton,
        properties: ['openDirectory', 'createDirectory'],
      })?.[0],
    confirmSwitch: (candidate) =>
      dialog.showMessageBoxSync(window, {
        type: 'question',
        title: strings.switchWorkspaceTitle,
        message: strings.switchWorkspaceMessage,
        detail: `${candidate}\n\n${strings.switchWorkspaceDetail}`,
        buttons: [strings.switchWorkspaceConfirm, strings.switchWorkspaceCancel],
        defaultId: 0,
        cancelId: 1,
      }) === 0,
    confirmForget: (candidate) =>
      dialog.showMessageBoxSync(window, {
        type: 'warning',
        title: strings.forgetWorkspaceTitle,
        message: strings.forgetWorkspaceMessage,
        detail: `${candidate}\n\n${strings.forgetWorkspaceDetail}`,
        buttons: [strings.forgetWorkspaceConfirm, strings.forgetWorkspaceCancel],
        defaultId: 1,
        cancelId: 1,
      }) === 0,
    revealPath: (path) => {
      void shell.openPath(path)
    },
    copyText: (text) => {
      clipboard.writeText(text)
    },
    alert: ({ type, title, detail }) => {
      void dialog.showMessageBox(window, { type, title, message: title, detail, buttons: [strings.buttonOk] })
    },
    // 「最近打开」变了（移除一项、或删掉了不存在的目录）：重建菜单，否则列表停在旧快照上。
    refreshRecent: () => {
      refreshApplicationMenu()
    },
  }

  // 先备一份：托盘（早于菜单构建）也要用同一个 `projectInfo`。
  actions = workspaceActions()

  // 退出时关掉设置文档的监听（两条启动路径都经过这里注册的这一处）。
  app.on('will-quit', () => {
    stopLocaleWatch?.()
  })

  // 纯菜单诊断：菜单不依赖服务端，而启动服务端要 ~11 秒。以
  // DSH_DESKTOP_DUMP_MENU=1 启动时，构建完菜单就直接退出，让菜单可以被脚本
  // 快速断言，而不是每次等十几秒。
  if (process.env.DSH_DESKTOP_DUMP_MENU === '1') {
    openUpdatesEntry = () => {}
    refreshApplicationMenu()
    // 诊断实例默认打完就退；`DSH_DESKTOP_MENU_WATCH=1` 时让它活着并跟着语言重建菜单，
    // 于是"运行中切换语言"可以只靠 stderr 就被断言（见 test-shell-locale.mjs）。
    // 语言设置的监听**不在这里注册**：它从冷启动那一刻就已经生效了（见上面
    // watchLocalePreference 的调用），这里再注册一次会得到两条监听链。
    if (process.env.DSH_DESKTOP_MENU_WATCH === '1') return
    app.exit(0)
    return
  }

  let ready
  try {
    ready = await server.start()
    // 服务端已经启动 = 「移除工作区」的意图已经由它用官方 API 执行完毕，标记是耗材。
    // 放在成功之后而不是构造时：启动失败时标记要留着，让下一次启动再试。
    takePendingForgets(userDataDir)
  } catch (error) {
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
  registerIpc()
  // 外壳版本必须用 app.getVersion()，不能复用运行时版本。
  // 踩过一次：这里原本传的是 runtimeVersion，于是更新窗口的
  // 「应用外壳 / 已安装版本」显示成了 dsh 的版本号（0.1.5-rc.1），而应用自己是 1.0.0。
  const shellUpdater = new ShellUpdater(app.getVersion(), strings.updateShellUnavailable)
  const openUpdates = (): void => {
    openUpdatesFor({
      window,
      shellUpdater,
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
      // 与菜单同一个入口：点击时读 active.get()，并且"工作区已不存在"时给提示而不是
      // 静默打开一个不存在的目录。
      actions.projectInfo()
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

  openUpdatesEntry = openUpdates
  refreshApplicationMenu()
  session = { server, window, ...(tray !== undefined ? { tray } : {}), quitting: false }

  // 语言设置的监听**不在这里**：它在冷启动读到偏好之后立刻就装好了（见上面
  // `watchLocalePreference` 的调用），并且以那个值为基准。放到这里再装一次的话，
  // "读偏好"与"起服务端"之间那十几秒里的修改就永远等不到事件了。

  // 启动时**不再**静默检查完整应用更新。
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
 * 打开「更新」窗口。用户侧只有 GitHub Releases 这一条完整产品更新轨道。
 *
 * 窗口立刻打开并显示"正在检查"，GitHub 结果随后推送。这样网络慢时用户看得到
 * 进展，而不是等十几秒后突然弹出一个窗口。
 *
 * 完整应用更新的两个守卫：
 *   * 未打包运行时不可用（没有 `app-update.yml`），此时明确说明而不是给个
 *     永远转圈的按钮；
 *   * 外壳版本比较用 `app.getVersion()`。开发运行时 Electron 从 package.json
 *     取名，打包后来自 productName —— 两者可能不同，所以只在打包后启用安装。
 *
 * @param deps - 窗口、更新器与版本信息。
 */
function openUpdatesFor(deps: {
  window: BrowserWindow
  shellUpdater: ShellUpdater
  userDataDir: string
  strings: ReturnType<typeof t>
}): void {
  const { window, shellUpdater, userDataDir, strings: s } = deps

  const shellVersion = app.getVersion()
  const runtimeVersion = activeRuntime?.stagedVersion ?? (() => {
    try {
      return (JSON.parse(readFileSync(activeRuntime?.installAnchor ?? '', 'utf8')) as { version?: string }).version ?? 'unknown'
    } catch {
      return 'unknown'
    }
  })()
  let currentState: UpdatePanelState = {
    desktop: { installed: shellVersion, state: 'checking' },
    runtime: { installed: runtimeVersion, state: 'checking' },
    canInstall: false,
  }

  const panel = openUpdateWindow(
    window,
    userDataDir,
    {
      title: s.updateWindowTitle,
      checking: s.updateChecking,
      stateLatest: s.updateStateLatest,
      stateAvailable: s.updateStateAvailable,
      stateUnknown: s.updateStateUnknown,
      installedLabel: s.updateInstalledLabel,
      latestLabel: s.updateNewestLabel,
      buttonClose: s.updateButtonClose,
      buttonDownload: s.updateButtonShell,
      progress: s.updateShellProgress,
      buttonDownloading: s.updateButtonDownloading,
      sectionDesktop: s.updateSectionShell,
      sectionRuntime: s.updateSectionRuntime,
      runtimeBundledNote: s.updateRuntimeBundledNote,
      runtimeAvailableNote: s.updateRuntimeAvailableNote,
      buttonRuntimeRelease: s.updateButtonRuntimeRelease,
    },
    (action) => {
      if (action === 'close') {
        panel.window.close()
        return
      }
      if (action === 'download') {
        void (async () => {
          try {
            await shellUpdater.download((percent) => {
              panel.update({ ...currentState, progress: percent })
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
      if (action === 'runtime-release') {
        const url = currentState.runtime.releaseUrl ?? RUNTIME_RELEASES_URL
        void shell.openExternal(url)
      }
    },
  )

  panel.update(currentState)

  void (async () => {
    const [shellResult, runtimeResult] = await Promise.allSettled([
      shellUpdater.check(app.isPackaged),
      checkRuntimeRelease(runtimeVersion),
    ])
    const desktop = shellResult.status === 'fulfilled'
      ? {
          installed: shellResult.value.current,
          ...(shellResult.value.latest === undefined ? {} : { latest: shellResult.value.latest }),
          state: shellResult.value.available ? 'available' as const : shellResult.value.reason === undefined ? 'latest' as const : 'unknown' as const,
          ...(shellResult.value.reason === undefined ? {} : { reason: shellResult.value.reason }),
        }
      : {
          installed: shellVersion,
          state: 'unknown' as const,
          reason: shellResult.reason instanceof Error ? shellResult.reason.message : String(shellResult.reason),
        }
    const runtime = runtimeResult.status === 'fulfilled'
      ? {
          installed: runtimeResult.value.current,
          ...(runtimeResult.value.latest === undefined ? {} : { latest: runtimeResult.value.latest }),
          state: runtimeResult.value.available ? 'available' as const : runtimeResult.value.reason === undefined ? 'latest' as const : 'unknown' as const,
          ...(runtimeResult.value.reason === undefined ? {} : { reason: runtimeResult.value.reason }),
          ...(runtimeResult.value.releaseUrl === undefined ? {} : { releaseUrl: runtimeResult.value.releaseUrl }),
        }
      : {
          installed: runtimeVersion,
          state: 'unknown' as const,
          reason: runtimeResult.reason instanceof Error ? runtimeResult.reason.message : String(runtimeResult.reason),
        }
    currentState = {
      desktop,
      runtime,
      canInstall: desktop.state === 'available' && app.isPackaged,
    }
    panel.update(currentState)
  })()
}

/** Register the preload bridge's IPC handlers. */
function registerIpc(): void {
  ipcMain.handle('dsh-desktop:open-external', async (_event, url: unknown) => {
    if (typeof url === 'string' && /^https?:/u.test(url)) await shell.openExternal(url)
  })
}

/** 文件菜单里与工作区（项目）相关的动作。 */
export type { WorkspaceActions }

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
