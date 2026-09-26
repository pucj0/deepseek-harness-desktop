/**
 * BrowserWindow、自定义标题栏，以及"先显示、后就绪"的启动编排。
 *
 * ## 窗口结构
 *
 * ```text
 * ┌─────────────────────────────────────────────── BrowserWindow ──┐
 * │ [自绘标题栏]  ← 窗口自身的 webContents（shell-page.ts）          │ 40px
 * │               原生最小化/最大化/关闭叠在它右端（titleBarOverlay）│
 * ├───────────────────────────────────────────────────────────────┤
 * │ [Harness 官方界面] ← 一个 WebContentsView，位于标题栏下方        │
 * └───────────────────────────────────────────────────────────────┘
 * ```
 *
 * 为什么 Harness 界面必须放进**子视图**，而不是窗口自身的 webContents：
 * 子视图永远盖在窗口页面之上，所以"窗口页面里画的浮层"只要越过标题栏就会被它挡住；
 * 反过来若把标题栏叠在 Harness 页面上，Harness 自己的 `position: fixed` 全高面板
 * （审查抽屉、设置弹窗）就会被标题栏盖掉。把 Harness 放进下移 40px 的子视图后，它的
 * 视口就是"标题栏以下"，两边都不越界——功能一个没丢。下拉菜单因此改由原生 popup 弹出
 * （见 menu.ts 的说明）。
 *
 * ## 为什么窗口先于服务端创建
 *
 *   DSH 的插件树 boot 实测要 ~10.7 秒（占启动总时长约 95%）。此前窗口是在
 *   `await server.start()` **之后**才创建的，用户要对着空屏幕等十几秒。现在窗口立刻
 *   显示标题栏与加载页，服务端就绪后把 Harness 子视图显示出来。
 *
 * ## 认证握手（来自 dsh 的浏览器信任设计）
 *
 *   dsh-web-app 打印 `http://127.0.0.1:<port>/?token=<launch-token>`。服务端只在
 *   `GET /` 上接受该 token，用它写入绑定 authority 的 HttpOnly Cookie，然后 302 到
 *   干净的 `/`。因此 Harness 视图只加载一次带 token 的 URL。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BrowserWindow,
  WebContentsView,
  ipcMain,
  nativeTheme,
  shell,
  type BrowserWindowConstructorOptions,
  type WebContents,
} from 'electron'
import type { ShellMenuBarEntry } from './menu'
import { shellPageHtml } from './shell-page'
import {
  TITLEBAR_HEIGHT,
  drawsMenusInTitleBar,
  keepsNativeMenuBar,
  overlayColors,
  systemThemeTokens,
  usesCustomTitleBar,
} from './titlebar'
import type { ServerReady } from './dsh-server'

interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}

const DEFAULT_STATE: WindowState = { width: 1440, height: 920 }

/** 加载页最多显示多久——即使 ready-to-show 不触发也要把窗口亮出来。 */
const SPLASH_FALLBACK_SHOW_MS = 2500

/** 主题令牌（标题栏 CSS 直接用，值原样透传）。 */
interface ShellTheme {
  bg?: string
  fg?: string
  fgDim?: string
  hover?: string
  active?: string
  border?: string
  dark?: boolean
}

/** 推给标题栏的完整状态。 */
interface ShellState {
  /** 窗口平台与标题栏几何：页面用它决定布局差异，避免再走一份环境变量。 */
  platform: string
  height: number
  /** 是否自绘标题栏（Linux 保留原生边框时为 false）。 */
  custom: boolean
  /** 是否在标题栏里画菜单（macOS 的菜单在系统菜单栏）。 */
  menus: boolean
  ready: boolean
  maximized: boolean
  fullScreen: boolean
  canGoBack: boolean
  canGoForward: boolean
  theme: ShellTheme
}

/** 读取持久化的窗口几何。 */
function loadState(userDataDir: string): WindowState {
  const path = join(userDataDir, 'window-state.json')
  if (!existsSync(path)) return { ...DEFAULT_STATE }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<WindowState>
    return {
      width: typeof parsed.width === 'number' ? parsed.width : DEFAULT_STATE.width,
      height: typeof parsed.height === 'number' ? parsed.height : DEFAULT_STATE.height,
      ...(typeof parsed.x === 'number' ? { x: parsed.x } : {}),
      ...(typeof parsed.y === 'number' ? { y: parsed.y } : {}),
      ...(parsed.maximized === true ? { maximized: true } : {}),
    }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

/** 创建主窗口所需的配置。 */
export interface MainWindowOptions {
  /** Electron 的每用户数据目录。 */
  userDataDir: string
  /** 应用图标路径（存在时）。 */
  iconPath?: string
  /** 加载页主标题。 */
  splashTitle: string
  /** 加载页提示文案。 */
  splashHint: string
  /** 导航按钮的无障碍文案（缺省时用英文兜底，测试可以省掉）。 */
  backLabel?: string
  forwardLabel?: string
  /**
   * 菜单栏来源。
   *
   * 由 `index.ts` 注入，因为原生 `Menu` 在那边构建（它还承担 accelerator 注册）。
   * 窗口只负责"把菜单标题画出来"和"在按钮位置弹出对应子菜单"，不碰菜单内容本身。
   */
  menu?: {
    /** 菜单栏按钮（顶层菜单标题）。 */
    entries: () => ShellMenuBarEntry[]
    /**
     * 在窗口客户区坐标处弹出某个顶层菜单。
     * @param onClosed - 菜单关闭时回调。
     * @returns 是否真的弹出了菜单。
     */
    open: (index: unknown, point: { x: number; y: number }, onClosed: () => void) => boolean
  }
}

/**
 * 创建主窗口并返回控制句柄。
 * @param options - 窗口、标题栏与加载页配置。
 * @returns 窗口、Harness 视图的 webContents，以及导航/加载页/标题控制方法。
 */
export function createMainWindow(options: MainWindowOptions): {
  window: BrowserWindow
  /** Harness 官方界面所在的 webContents（标题栏下方的子视图）。 */
  appContents: WebContents
  navigate: (ready: ServerReady) => Promise<void>
  /** 往历史里后退/前进。返回是否真的导航了（越界或跨 origin 时拒绝）。 */
  navigateHistory: (direction: 'back' | 'forward') => boolean
  /** 更新加载页的提示文案（例如解包进度）。 */
  setSplashHint: (hint: string) => void
  setGitBadge: (badge: string | undefined) => void
  close: () => void
} {
  const { userDataDir, iconPath, splashTitle, splashHint, menu } = options
  const backLabel = options.backLabel ?? 'Back'
  const forwardLabel = options.forwardLabel ?? 'Forward'
  const state = loadState(userDataDir)
  const custom = usesCustomTitleBar()
  const titlebarHeight = custom ? TITLEBAR_HEIGHT : 0

  const constructorOptions: BrowserWindowConstructorOptions = {
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    minWidth: 900,
    minHeight: 600,
    show: false,
    // 窗口底板跟随系统外观：写死深色会在浅色系统下于页面加载前后露出深色边，
    // 用户看到的就是"顶部没跟着变浅色"。
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1f' : '#f6f6f8',
    // 菜单栏承载着 accelerator 注册，因此**不能**用 setApplicationMenu(null) 去掉它；
    // 这里只是把它的视觉表现藏起来（Alt 也会被拦掉，见 index.ts），标题栏里画的是同一份菜单。
    autoHideMenuBar: true,
    title: 'DeepSeek Harness',
    ...(iconPath !== undefined ? { icon: iconPath } : {}),
    ...(custom
      ? {
          // 标题栏内容自绘，窗口控制按钮仍是原生的（保留 Snap Layout / DPI / 悬停态）。
          titleBarStyle: 'hidden' as const,
          // macOS 的交通灯必须避开我们自己的内容；Windows 交给 titleBarOverlay。
          ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 14, y: 13 } } : {}),
          ...(process.platform === 'win32'
            ? {
                titleBarOverlay: {
                  ...overlayColors(systemThemeTokens(nativeTheme.shouldUseDarkColors)),
                  height: titlebarHeight,
                },
              }
            : {}),
        }
      : {}),
    webPreferences: {
      // 标题栏页面也是渲染进程：保持完全沙箱化，只通过最小桥与主进程通信。
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: join(__dirname, '..', 'preload', 'titlebar.js'),
    },
  }

  const window = new BrowserWindow(constructorOptions)
  // 原生菜单栏隐藏：accelerator 仍由已注册的 application menu 提供。
  // 只在自绘标题栏的平台上做：macOS 的菜单本来就该待在系统菜单栏，而 macOS 的 Option 是
  // 输入修饰键，不能像 Windows 的 Alt 那样被拦掉（见下面的 suppressAlt）。
  const hidesNativeMenuBar = usesCustomTitleBar() && !keepsNativeMenuBar()
  if (hidesNativeMenuBar) window.setMenuBarVisibility(false)

  /** 主题状态：Harness 页面上报的令牌优先，未上报时跟随系统。 */
  let theme: ShellTheme = systemThemeTokens(nativeTheme.shouldUseDarkColors)
  /** Harness 页面是否已经上报过主题（上报后不再被系统外观覆盖）。 */
  let themeFromApp = false
  /** 是否已经导航到真实 UI（导航后不再显示加载进度）。 */
  let navigated = false
  let splashReady = false
  /** Harness 子视图是否已显示（`View` 没有 getVisible()，自己记）。 */
  let appVisible = false
  /** 应用 origin（导航后才有值），供历史与外部链接判断使用。 */
  let appOrigin: string | undefined
  let pendingHint = splashHint

  const shellPath = join(userDataDir, 'shell.html')

  /** 写标题栏页面。加载页文案内联在 HTML 里，因此不存在"进度到达前先闪空"。 */
  const writeShell = (hint: string): void => {
    try {
      writeFileSync(
        shellPath,
        shellPageHtml({
          platform: process.platform,
          height: titlebarHeight,
          custom,
          menus: drawsMenusInTitleBar(),
          splashTitle,
          splashHint: hint,
          backLabel,
          forwardLabel,
          dark: theme.dark === true,
        }),
        'utf8',
      )
    } catch {
      // 写不了就退化成空白窗口，不影响后续导航。
    }
  }
  writeShell(splashHint)

  // Harness 官方界面所在的子视图：位于标题栏下方，视口因此不含标题栏。
  const appView = new WebContentsView({
    webPreferences: {
      // 官方 UI 不需要 Node 能力，因此渲染进程保持完全沙箱化。
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: join(__dirname, '..', 'preload', 'preload.js'),
    },
  })
  const appContents = appView.webContents
  window.contentView.addChildView(appView)
  appView.setVisible(false)

  /**
   * 把子视图铺在标题栏下方（全屏时铺满，交给系统全屏语义）。
   *
   * "避开右上角原生按钮"由网页侧的 `env(titlebar-area-*)` 负责；这里只管高度换算，
   * 因此 resize / 最大化 / 还原 / 全屏切换时都要重算，否则会露白边或错位。
   */
  const layout = (): void => {
    if (window.isDestroyed()) return
    const { width, height } = window.getContentBounds()
    const top = window.isFullScreen() ? 0 : titlebarHeight
    appView.setBounds({ x: 0, y: top, width: Math.max(0, width), height: Math.max(0, height - top) })
  }
  layout()

  /**
   * 窗口状态变化后补几次重排。
   *
   * 为什么不能只靠事件里的那一帧：Windows 最大化时会先发出 `resize`/`maximize`，此时
   * `getContentBounds()` 报的是**中间尺寸**（实测 1030），随后 DWM 去掉边框把内容区变成
   * 1032，而**不再发任何事件**。只在那两个事件里排一次，子视图就会短 2px——底部露出一条
   * 底色缝。这里在状态变化后补两次，落在最终尺寸上（幂等、代价可忽略）。
   */
  const timers: NodeJS.Timeout[] = []
  const settleLayout = (): void => {
    layout()
    timers.push(setTimeout(layout, 60), setTimeout(layout, 220))
  }
  window.on('closed', () => {
    for (const timer of timers) clearTimeout(timer)
    timers.length = 0
  })

  /** 当前可安全导航的历史方向：只认本应用 origin，避免退回加载页或旧端口。 */
  const historyAvailability = (): { canGoBack: boolean; canGoForward: boolean } => {
    const origin = appOrigin
    if (origin === undefined || appContents.isDestroyed()) return { canGoBack: false, canGoForward: false }
    const history = appContents.navigationHistory
    const index = history.getActiveIndex()
    const entries = history.getAllEntries()
    const sameApp = (offset: number): boolean => {
      const entry = entries[index + offset]
      if (entry === undefined) return false
      try {
        return new URL(entry.url).origin === origin
      } catch {
        return false
      }
    }
    return { canGoBack: history.canGoBack() && sameApp(-1), canGoForward: history.canGoForward() && sameApp(1) }
  }

  /** 一份完整状态：初值、推送、IPC 拉取都走它，避免三处各写一遍。 */
  const currentState = (): ShellState => ({
    platform: process.platform,
    height: titlebarHeight,
    custom,
    menus: drawsMenusInTitleBar(),
    ready: appVisible,
    maximized: window.isMaximized(),
    fullScreen: window.isFullScreen(),
    ...historyAvailability(),
    theme,
  })

  /** 推一次完整状态给标题栏页面。 */
  const publishState = (): void => {
    if (window.isDestroyed()) return
    window.webContents.send('dsh-desktop:shell-state', currentState())
  }

  /** 应用一份主题（Harness 页面上报的令牌，或系统深浅色回退）。 */
  const applyTheme = (next: ShellTheme): void => {
    theme = next
    if (process.platform === 'win32') {
      try {
        window.setTitleBarOverlay({ ...overlayColors(next), height: titlebarHeight })
      } catch {
        // 窗口已销毁或平台不支持：忽略，不影响标题栏本体。
      }
    }
    publishState()
  }

  void window.loadFile(shellPath).then(() => {
    splashReady = true
    // 加载完成前到来的进度更新要补上（首次解包进度很早就在推）。
    window.webContents.send('dsh-desktop:shell-splash', pendingHint)
    layout()
    publishState()
  }).catch(() => {})

  let shown = false
  const show = (): void => {
    if (shown || window.isDestroyed()) return
    shown = true
    if (state.maximized === true) window.maximize()
    window.show()
  }
  window.once('ready-to-show', show)
  // 兜底：ready-to-show 在个别情况下不触发，不能让窗口永远藏着。
  setTimeout(show, SPLASH_FALLBACK_SHOW_MS)

  // 整个 UI 都在 loopback 的同一 origin 上，其它地址交给系统浏览器，
  // 而不是让外壳导航离开应用。
  appContents.setWindowOpenHandler(({ url }) => {
    if (appOrigin === undefined || !url.startsWith(appOrigin)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  appContents.on('will-navigate', (event, url) => {
    if (appOrigin !== undefined && !url.startsWith(appOrigin)) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  // 网页 UI 会自己设置 document.title，导航后要把带 git 徽章的标题重新压回去，
  // 否则每次跳转都会把分支信息冲掉。
  const baseTitle = 'DeepSeek Harness'
  let title = baseTitle
  window.setTitle(title)
  window.on('page-title-updated', (event) => {
    event.preventDefault()
    window.setTitle(title)
  })
  appContents.on('page-title-updated', (event) => {
    event.preventDefault()
    window.setTitle(title)
  })
  // 历史可用性会随页面内导航变化；导航结束后刷新标题栏按钮状态。
  appContents.on('did-navigate', () => publishState())
  appContents.on('did-navigate-in-page', () => publishState())

  // 窗口几何变化时子视图必须跟着重排（并在状态变化后补排，见 settleLayout）。
  window.on('resize', settleLayout)
  window.on('maximize', () => {
    settleLayout()
    publishState()
  })
  window.on('unmaximize', () => {
    settleLayout()
    publishState()
  })
  window.on('enter-full-screen', () => {
    settleLayout()
    publishState()
  })
  window.on('leave-full-screen', () => {
    settleLayout()
    publishState()
  })
  window.on('close', () => persist(window, userDataDir))

  // 菜单栏视觉上隐藏后，Windows 仍会响应单击 Alt 把它露出来——那会变成"原生菜单栏 +
  // 自绘菜单"两套同时存在。这里把裸 Alt 吃掉；`before-input-event` 早于菜单快捷键处理，
  // 因此只影响 Alt 本身，不会碰到 Ctrl+O 之类的 accelerator。
  // 只在 Windows 上做：macOS 的 Option 是输入修饰键（且它的菜单在系统菜单栏，本来就该在）。
  if (hidesNativeMenuBar) {
    const suppressAlt = (contents: WebContents): void => {
      contents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown' || input.key !== 'Alt') return
        event.preventDefault()
        if (!window.isDestroyed()) window.setMenuBarVisibility(false)
      })
    }
    suppressAlt(window.webContents)
    suppressAlt(appContents)
  }

  // 系统外观变化：Harness 页面还没上报令牌时也能跟上深浅色。
  const onNativeTheme = (): void => {
    if (window.isDestroyed() || themeFromApp) return
    applyTheme(systemThemeTokens(nativeTheme.shouldUseDarkColors))
  }
  nativeTheme.on('updated', onNativeTheme)
  window.on('closed', () => nativeTheme.off('updated', onNativeTheme))

  // ---- 标题栏 IPC：只暴露标题栏真正需要的几件事 ---------------------------
  //
  // 用 removeHandler 先清一遍：`ipcMain.handle` 对同一 channel 重复注册会抛错，
  // 而测试会在同一个进程里重建窗口。
  const handle = (
    channel: string,
    listener: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, listener)
  }

  /** 真实的 history 导航，带 origin 白名单。 */
  const navigateHistory = (direction: 'back' | 'forward'): boolean => {
    const availability = historyAvailability()
    if (direction === 'back' && !availability.canGoBack) return false
    if (direction === 'forward' && !availability.canGoForward) return false
    if (direction === 'back') appContents.navigationHistory.goBack()
    else appContents.navigationHistory.goForward()
    return true
  }

  handle('dsh-desktop:shell-state', () => currentState())
  handle('dsh-desktop:shell-menu', () => {
    try {
      return menu?.entries() ?? []
    } catch {
      return []
    }
  })
  handle('dsh-desktop:shell-menu-open', (_event, index, x, y) => {
    const point = { x: typeof x === 'number' ? x : 0, y: typeof y === 'number' ? y : titlebarHeight }
    return new Promise<void>((resolve) => {
      // 弹出的是**同一份原生菜单**（index.ts 注入的 opener），因此菜单项点击执行的就是
      // 原来的 handler / role，不存在第二份命令表。
      const opened = menu?.open(index, point, () => resolve()) ?? false
      if (!opened) resolve()
    })
  })
  handle('dsh-desktop:shell-navigate', (_event, direction) => {
    if (direction !== 'back' && direction !== 'forward') return false
    return navigateHistory(direction)
  })
  handle('dsh-desktop:shell-focus-app', () => {
    if (!appContents.isDestroyed()) appContents.focus()
  })
  // Harness 页面上报主题令牌：标题栏与原生按钮颜色随之匹配（含应用内切换主题）。
  const onAppTheme = (event: Electron.IpcMainEvent, payload: unknown): void => {
    if (event.sender !== appContents) return
    if (payload === null || typeof payload !== 'object') return
    const raw = payload as ShellTheme
    themeFromApp = true
    applyTheme({
      ...(typeof raw.bg === 'string' ? { bg: raw.bg } : {}),
      ...(typeof raw.fg === 'string' ? { fg: raw.fg } : {}),
      ...(typeof raw.fgDim === 'string' ? { fgDim: raw.fgDim } : {}),
      ...(typeof raw.hover === 'string' ? { hover: raw.hover } : {}),
      ...(typeof raw.active === 'string' ? { active: raw.active } : {}),
      ...(typeof raw.border === 'string' ? { border: raw.border } : {}),
      dark: raw.dark === true,
    })
  }
  ipcMain.on('dsh-desktop:app-theme', onAppTheme)
  window.on('closed', () => ipcMain.off('dsh-desktop:app-theme', onAppTheme))

  return {
    window,
    appContents,
    navigate: async (ready: ServerReady): Promise<void> => {
      appOrigin = new URL(ready.url).origin
      // Stop progress updates before navigation begins, including fast-server races.
      navigated = true
      // 带 token 的 URL 只加载一次，随后服务端会 302 到凭 Cookie 认证的干净根路径。
      await appContents.loadURL(ready.authenticatedUrl)
      appView.setVisible(true)
      appVisible = true
      layout()
      publishState()
      show()
    },
    navigateHistory,
    setSplashHint: (hint: string): void => {
      if (window.isDestroyed() || navigated) return
      pendingHint = hint
      if (!splashReady) return
      window.webContents.send('dsh-desktop:shell-splash', pendingHint)
    },
    setGitBadge: (badge: string | undefined): void => {
      title = badge === undefined ? baseTitle : `${baseTitle} — ${badge}`
      if (!window.isDestroyed()) window.setTitle(title)
    },
    close: (): void => {
      if (!window.isDestroyed()) window.destroy()
    },
  }
}

/** 持久化窗口几何，下次启动还原。 */
function persist(window: BrowserWindow, userDataDir: string): void {
  try {
    const maximized = window.isMaximized()
    const bounds = maximized ? window.getNormalBounds() : window.getBounds()
    const state: WindowState = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized,
    }
    writeFileSync(join(userDataDir, 'window-state.json'), JSON.stringify(state, null, 2) + '\n')
  } catch {
    // 几何信息是尽力而为，不能因为它阻塞关闭流程。
  }
}
