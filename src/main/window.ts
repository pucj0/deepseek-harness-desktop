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
import { currentLocale, t } from './i18n'
import { markStartup } from './startup-timeline'
import { shellPageHtml } from './shell-page'
import { splashPageHtml } from './splash-page'
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
  theme: ShellTheme
  /**
   * 当前语言（规范 id，如 `zh-CN`）。
   *
   * 标题栏页面用它做两件事：把文档的 `lang` 写对，以及在**语言变化**时重新取一次菜单按钮
   * （菜单按钮的文案来自原生菜单，语言一变主进程会重建菜单，页面必须再拉一次才看得到）。
   */
  locale: string
  /**
   * 原生菜单的版本号（每次重建 +1）。
   *
   * 标题栏画的菜单按钮文案**来自原生菜单**（见 menu.ts 的说明），而原生菜单会在运行中重建
   * （语言变化、最近打开变化）。页面必须知道"菜单换了一份"，否则它会一直显示第一次
   * `getMenu()` 拿到的那些按钮——正是这里踩过的坑：窗口创建时菜单还没装上，页面先拿到了
   * Electron 的**默认菜单**（`File / Edit / View / Window / Help`，其中那个 `Window` 是
   * Electron 自己加的，本产品没有这一项），随后菜单被换成真正的应用菜单，却没有任何东西
   * 通知页面，于是标题栏上永远挂着那份默认菜单。
   */
  menuRevision: number
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
    /**
     * 当前菜单的版本号（每次重建递增）。
     *
     * 缺省为 0（测试里不关心它时可以不传）。状态推送里带上它，标题栏就知道该不该重新拉一次
     * 菜单按钮——见 {@link ShellState.menuRevision}。
     */
    revision?: () => number
  }
  /**
   * Harness 上报的"当前工作区"（不可信输入，这里只做**形状**校验）。
   *
   * 只有来自 Harness 子视图（`appContents`）的消息会被转发；语义校验（绝对路径、目录是否
   * 存在、是否属于已注册工作区）在 `index.ts` / `ActiveWorkspaceController` 里做——
   * 那里才知道 Harness home 与注册表。
   */
  onActiveWorkspaceReport?: (payload: ActiveWorkspaceReportPayload) => void
  /**
   * Harness 上报的**当前语言**（不可信输入，这里只做形状校验）。
   *
   * 与工作区同一条边界：只有 `appContents` 发来的消息会被转发，其余 renderer（标题栏页面、
   * 更新窗口）一律丢弃。值的解释（哪些写法算中文、不认识的值怎么办）在 `index.ts` 里，
   * 因为那需要 `i18n` 的归一化规则。
   */
  onLocaleReport?: (locale: string) => void
}

/** Harness 上报的 active workspace 载荷（归一化之后）。 */
export interface ActiveWorkspaceReportPayload {
  /** 当前会话的工作区路径；`null` 表示此刻没有当前会话。 */
  path: string | null
  /** 官方工作区 id（可选，供主进程与注册表交叉核对）。 */
  workspaceId?: string
}

/**
 * 是否使用**单 renderer**架构（窗口自身的 `webContents` 就是 Harness 页面）。
 *
 * 默认开启，`DSH_DESKTOP_TWO_LAYER=1` 可以退回旧的"外壳页面 + Harness 子视图"两层结构
 * （保留它是为了能在同一台机器上 A/B 对比，以及万一新架构在某平台出问题时有个开关）。
 *
 * ## 两种结构到底差在哪
 *
 * ```text
 * 两层（旧）                              单 renderer（新）
 * ┌──────────── BrowserWindow ────────┐   ┌──────────── BrowserWindow ────────┐
 * │ [自绘 40px 标题栏]  ← 窗口文档      │   │                                   │
 * │   Logo / 菜单 / 窗口状态            │   │   Harness Renderer 铺满整个客户区   │
 * ├───────────────────────────────────┤   │   （它的侧栏、Logo、折叠按钮、       │
 * │ [Harness 官方界面] ← WebContentsView│   │     顶部间距全是它自己的）          │
 * └───────────────────────────────────┘   └───────────────────────────────────┘
 * ```
 *
 * 两层结构里，窗口文档与 Harness 是**两个 DOM、两个布局上下文、两套设计系统**：外壳画一遍
 * Logo / 顶栏 / 悬停态，Harness 又画一遍，于是"Logo 位置对不齐、顶栏高度差一点、侧栏与
 * 标题栏之间那条分割线断开、折叠图标不一样"全都修不掉——只能靠 margin/padding 逼近，
 * 而那正是"看得出是两层"的根因。单 renderer 之后只剩官方那一套 UI，标题栏区域由
 * Harness 自己铺，原生 caption buttons 由 `titleBarOverlay` 画在最上层。
 */
const TWO_LAYER = process.env.DSH_DESKTOP_TWO_LAYER === '1'

/** 当前是否单 renderer 架构（见 {@link TWO_LAYER}）。 */
export const SINGLE_RENDERER = !TWO_LAYER

/** 当前是否两层结构（`index.ts` 用它决定"Host 就绪前要不要先导航一次"）。 */
export const TWO_LAYER_ARCHITECTURE = TWO_LAYER

/**
 * 创建主窗口并返回控制句柄。
 * @param options - 窗口、标题栏与加载页配置。
 * @returns 窗口、Harness 界面的 webContents，以及导航/加载页/标题控制方法。
 */
export function createMainWindow(options: MainWindowOptions): {
  window: BrowserWindow
  /** Harness 官方界面所在的 webContents（单 renderer 下就是窗口自身的）。 */
  appContents: WebContents
  navigate: (ready: ServerReady) => Promise<void>
  /** 更新加载页的提示文案（例如解包进度）。 */
  setSplashHint: (hint: string) => void
  setGitBadge: (badge: string | undefined) => void
  /**
   * 重新推一次标题栏状态。
   *
   * 语言变化时由 `index.ts` 调用：重建原生菜单之后，标题栏必须再拉一次菜单按钮才会显示
   * 新文案（状态里带着 `locale`，页面据此知道该重取）。
   */
  publishShellState: () => void
  close: () => void
} {
  const { userDataDir, iconPath, splashTitle, splashHint, menu } = options
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
      // 标题栏 / 启动底板也是渲染进程：保持完全沙箱化，只通过最小桥与主进程通信。
      //
      // 单 renderer 下这个 `webContents` **随后会承载 Harness 页面**，因此它必须带上
      // Harness 需要的那几条桥（主题令牌、当前工作区、语言）——那就是 `preload/app.js`
      // 把两份桥合并成一份的原因。两层结构下它只承载标题栏页面，用 `preload/titlebar.js`
      // 即可（`app.js` 也兼容，但保持原样以便 A/B 对比时行为不串）。
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: join(
        __dirname,
        '..',
        'preload',
        SINGLE_RENDERER ? 'app.js' : 'titlebar.js',
      ),
    },
  }

  /**
   * 告诉 preload 现在是哪种结构。
   *
   * 单 renderer 下 preload 必须打上 `data-windows-titlebar` 标记让 Harness 进入 Windows Desktop
   * 布局（见 `src/preload/app.ts` 的 `enableWindowsTitlebar`）。两层结构下**不能**打：那时
   * Harness 上方还有外壳自绘的 40px 标题栏，Harness 再自己留一条 40px 就变成 80px 的空白。
   *
   * 通过环境变量传而不是在页面里猜：渲染进程拿不到"窗口里有几个文档"这件事。
   */
  process.env.DSH_DESKTOP_SINGLE_RENDERER = SINGLE_RENDERER ? '1' : '0'

  const window = new BrowserWindow(constructorOptions)
  /**
   * 原生菜单栏的视觉处理。
   *
   * **要点：藏起来的是"视觉 menu row"，不是 Application Menu 本身。** 后者必须继续用
   * `Menu.setApplicationMenu()` 装着，因为 accelerator、`role`（undo/copy/paste/zoom…）、
   * 以及我们要 popup 的那些原生子菜单全靠它。
   *
   * 为什么要藏（而不是让 Windows 画原生菜单栏）：那样会得到"Windows 系统菜单栏 + Harness
   * 页面"两个视觉层级，正是这一版要消掉的东西。所以两套结构都把原生 menu row 藏起来，
   * 用**文档内**那一行菜单代替：
   *
   *   * 单 renderer：那一行由 `src/preload/caption-menu.ts` 挂在 **Harness 自己的文档**里
   *     （Shadow DOM，用 Harness 的 token 与字体），视觉上就是 Harness 标题栏的一部分；
   *   * 两层结构：那一行由旧的 `shell-page.ts` 画在自绘标题栏里。
   *
   * 两种情况都要**吃掉裸 Alt**：否则 Windows 会把原生 menu row 露出来，与文档内那一行并存。
   * 只影响裸 Alt——`before-input-event` 早于菜单快捷键处理，Ctrl+O / Ctrl+Shift+U 这些
   * accelerator 不受影响（有测试断言）。
   *
   * 只在自绘标题栏的平台上做：macOS 的菜单本来就该待在系统菜单栏（那里的 `menus` 为 false，
   * 文档内不画菜单），而 macOS 的 Option 是输入修饰键，不能像 Windows 的 Alt 那样被拦掉。
   */
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

  /**
   * 标题栏阶段的文档。
   *
   * 单 renderer：写**启动底板**（`splash-page.ts`）——只有底色 + 一行提示 + 顶部留白，
   * 不画任何属于 Harness 的 UI；Harness 就绪后整页被替换，此后窗口里只剩官方那一层。
   *
   * 两层：沿用旧的 `shell-page.ts`（自绘标题栏 + 加载页）。
   */
  const writeShell = (hint: string): void => {
    try {
      writeFileSync(
        shellPath,
        SINGLE_RENDERER
          ? splashPageHtml({
              title: splashTitle,
              hint,
              titlebarHeight,
              locale: currentLocale(),
              background: theme.bg ?? '#1b1b1f',
              foreground: theme.fg ?? '#e8e8ea',
              dark: theme.dark === true,
            })
          : shellPageHtml({
              platform: process.platform,
              height: titlebarHeight,
              custom,
              menus: drawsMenusInTitleBar(),
              splashTitle,
              splashHint: hint,
              locale: currentLocale(),
              dark: theme.dark === true,
            }),
        'utf8',
      )
    } catch {
      // 写不了就退化成空白窗口，不影响后续导航。
    }
  }
  writeShell(splashHint)

  /**
   * Harness 官方界面所在的 webContents。
   *
   * 单 renderer：**窗口自身的** `webContents`。这是整个重构的核心一行——不再有第二个
   * `WebContentsView`，因此"外壳 + 内嵌 Harness"那两层结构从根上消失。
   * 两层：新建一个位于标题栏下方的 `WebContentsView`。
   */
  const appView = SINGLE_RENDERER
    ? undefined
    : new WebContentsView({
        webPreferences: {
          // 官方 UI 不需要 Node 能力，因此渲染进程保持完全沙箱化。
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          preload: join(__dirname, '..', 'preload', 'preload.js'),
        },
      })
  const appContents = appView === undefined ? window.webContents : appView.webContents
  if (appView !== undefined) {
    window.contentView.addChildView(appView)
    appView.setVisible(false)
  }

  /**
   * 把 Harness 子视图铺在标题栏下方（全屏时铺满，交给系统全屏语义）。
   *
   * "避开右上角原生按钮"由网页侧的 `env(titlebar-area-*)` 负责；这里只管高度换算，
   * 因此 resize / 最大化 / 还原 / 全屏切换时都要重算，否则会露白边或错位。
   *
   * 单 renderer 下**没有子视图可排**：Harness 页面就是窗口文档，它自己铺满整个客户区
   * （这正是"顶栏与侧栏自然连续"的来源）。因此这里直接返回。
   */
  const layout = (): void => {
    if (appView === undefined) return
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

  /**
   * 一份完整状态：初值、推送、IPC 拉取都走它，避免三处各写一遍。
   *
   * 这里**没有**前进/后退的可用性：那两个按钮已经从标题栏删除（需求 H），连同
   * `navigateHistory` / `shell-navigate` / `canGoBack` / `canGoForward` 一起清理。
   * Harness 页面自己的路由与浏览器历史不受影响——我们只是不再替它驱动历史导航。
   */
  const currentState = (): ShellState => ({
    platform: process.platform,
    height: titlebarHeight,
    custom,
    menus: drawsMenusInTitleBar(),
    ready: appVisible,
    maximized: window.isMaximized(),
    fullScreen: window.isFullScreen(),
    theme,
    // 语言是**当前值**：它在运行中会变（见 index.ts 的 locale 监听），标题栏据此写对
    // <html lang> 并重新取菜单按钮。
    locale: currentLocale(),
    // 菜单版本：页面拿它判断"菜单按钮要不要重新拉一次"（见 ShellState.menuRevision）。
    menuRevision: menu?.revision?.() ?? 0,
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

  // 吃掉裸 Alt（见上面 `hidesNativeMenuBar` 的说明）：Windows 上不这么做，Alt 会露出原生
  // menu row，与文档内那一行菜单并存。`before-input-event` 早于菜单快捷键处理，因此只影响
  // Alt 本身，Ctrl+O / Ctrl+Shift+U 之类的 accelerator 照常工作。
  if (hidesNativeMenuBar) {
    const swallowAlt = (contents: WebContents): void => {
      contents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown' || input.key !== 'Alt') return
        event.preventDefault()
        if (!window.isDestroyed()) window.setMenuBarVisibility(false)
      })
    }
    swallowAlt(window.webContents)
    if (appView !== undefined) swallowAlt(appContents)
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
  handle('dsh-desktop:shell-focus-app', () => {
    if (!appContents.isDestroyed()) appContents.focus()
  })
  // Harness 页面上报主题令牌：标题栏与原生按钮颜色随之匹配（含应用内切换主题）。
  // 单 renderer 下 `appContents === window.webContents`，这条桥仍然必要——它驱动
  // `setTitleBarOverlay`，也就是原生 caption buttons 的底色与符号色。
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

  /**
   * preload 的致命错误。
   *
   * preload 在顶层求值时抛错时，`contextBridge.exposeInMainWorld` 不会执行，页面里
   * `window.dshDesktop` 与顶部菜单会**一起消失**——从主进程看只是"桥没注入"。这条 IPC 把它
   * 打到 stderr（默认只记录一行；`DSH_DESKTOP_PRELOAD_TRACE=1` 时给出完整堆栈）。
   */
  const onPreloadError = (event: Electron.IpcMainEvent, payload: unknown): void => {
    if (event.sender !== appContents) return
    const stage = payload !== null && typeof payload === 'object' && typeof (payload as { stage?: unknown }).stage === 'string'
      ? String((payload as { stage: string }).stage)
      : 'unknown'
    const message = payload !== null && typeof payload === 'object' && typeof (payload as { message?: unknown }).message === 'string'
      ? String((payload as { message: string }).message)
      : ''
    const detail = process.env.DSH_DESKTOP_PRELOAD_TRACE === '1' ? `\n${message}` : `: ${message.split('\n')[0] ?? ''}`
    process.stderr.write(`[shell] preload 失败（${stage}）${detail}\n`)
  }
  ipcMain.on('dsh-desktop:preload-error', onPreloadError)
  window.on('closed', () => ipcMain.off('dsh-desktop:preload-error', onPreloadError))

  /**
   * Harness 页面上报"当前工作区"（见 preload.ts 的 `reportActiveWorkspace`）。
   *
   * 两条边界，缺一不可：
   *   * **只认这个视图**（`event.sender !== appContents` 一律丢弃）。窗口自身的标题栏页面
   *     也跑在同一组 `ipcMain` 上，没有这条判断，标题栏页面就能替 Harness 决定工作区。
   *   * **只传归一化后的形状**：`path` 必须是字符串或 null，`workspaceId` 必须是字符串；
   *     其余一律丢弃。绝对路径、目录存在性、以及"是不是已注册工作区"的判定在
   *     `index.ts` 里做（那里才知道 Harness home 与注册表），因此即使这里放行了一个
   *     恶意路径，它也不会被外壳拿去打开任何东西。
   *
   * @param event - IPC 事件（用 sender 做来源校验）。
   * @param payload - 渲染进程送来的原始值。
   */
  const onActiveWorkspace = (event: Electron.IpcMainEvent, payload: unknown): void => {
    if (event.sender !== appContents) return
    if (options.onActiveWorkspaceReport === undefined) return
    if (payload === null || typeof payload !== 'object') return
    const raw = payload as { path?: unknown; workspaceId?: unknown }
    const path = raw.path === null || raw.path === undefined ? null : typeof raw.path === 'string' ? raw.path : undefined
    // `undefined` 表示形状不对（例如 path 是数字）——整条丢弃，不做任何猜测。
    if (path === undefined) return
    options.onActiveWorkspaceReport({
      path,
      ...(typeof raw.workspaceId === 'string' && raw.workspaceId !== '' ? { workspaceId: raw.workspaceId } : {}),
    })
  }
  ipcMain.on('dsh-desktop:active-workspace', onActiveWorkspace)
  window.on('closed', () => ipcMain.off('dsh-desktop:active-workspace', onActiveWorkspace))

  /**
   * Harness 页面上报"当前语言"（见 preload.ts 的 `reportLocale` 与
   * dsh-client-ui-shell-bridge 的客户端半边）。
   *
   * 与工作区上报同一套边界：
   *   * **只认这个视图**（`event.sender !== appContents` 一律丢弃）。标题栏页面与其它
   *     renderer 也跑在同一组 `ipcMain` 上，没有这条判断，它们就能替 Harness 决定语言；
   *   * **只传字符串**：形状不对（对象、数字、空串）整条丢弃，绝不做任何猜测。
   *
   * 值的语义（哪些写法算中文、不认识的语言要不要回退）在 `index.ts` 里解释——那里有
   * `i18n` 的归一化规则，而且"不认识就不动"这条策略属于应用级决策。
   *
   * @param event - IPC 事件（用 sender 做来源校验）。
   * @param payload - 渲染进程送来的原始值。
   */
  const onLocaleReport = (event: Electron.IpcMainEvent, payload: unknown): void => {
    if (event.sender !== appContents) return
    if (options.onLocaleReport === undefined) return
    if (typeof payload !== 'string' || payload === '') return
    options.onLocaleReport(payload)
  }
  ipcMain.on('dsh-desktop:shell-locale', onLocaleReport)
  window.on('closed', () => ipcMain.off('dsh-desktop:shell-locale', onLocaleReport))

  return {
    window,
    appContents,
    navigate: async (ready: ServerReady): Promise<void> => {
      appOrigin = new URL(ready.url).origin
      // Stop progress updates before navigation begins, including fast-server races.
      navigated = true
      // 渲染进程的两个生命周期事件是"界面何时真的出现"的唯一可靠信号：
      // `dom-ready` = DOM 建好（还没画完），`did-finish-load` = 子资源都到齐。
      // 用 `once` 是因为切换工作区会重新导航，而时间线只关心**首次**可用。
      appContents.once('dom-ready', () => markStartup('domReady'))
      appContents.once('did-finish-load', () => markStartup('didFinishLoad'))
      // 带 token 的 URL 只加载一次，随后服务端会 302 到凭 Cookie 认证的干净根路径。
      //
      // 单 renderer：这一步同时**替换掉启动底板**——窗口文档从"底板"变成"Harness 自己"，
      // 中间不存在第三个文档，也没有子视图要显示。此后整窗就是官方 UI。
      await appContents.loadURL(ready.authenticatedUrl)
      appView?.setVisible(true)
      appVisible = true
      layout()
      publishState()
      show()
    },
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
    publishShellState: publishState,
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
