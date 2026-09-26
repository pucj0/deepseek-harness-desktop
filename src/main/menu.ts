/**
 * 菜单栏与自定义标题栏之间的桥。
 *
 * ## 为什么下拉菜单用原生 popup，而不是在网页里画
 *
 * 标题栏本体是网页（`shell-page.ts`），但下拉菜单交给 `menu.popup()`。原因是**合成顺序**：
 * Harness 页面运行在一个 `WebContentsView` 里，它盖在窗口自身那个页面之上。因此窗口页面
 * 里画的任何东西只要超出自绘标题栏的 40px，就会被 Harness 页面挡住——自绘下拉要么被裁掉，
 * 要么得靠"菜单一开就把视图长高"这类把戏，而那样又会把菜单外的点击吞掉。
 *
 * 用原生 popup 一次解决三件事：
 *   * 弹出的是**同一份 Menu 对象**，所以点击菜单项执行的就是原来那个 handler / role，
 *     不存在第二份命令表，也没有"复制出来的 openFolderV2"；
 *   * 键盘导航、子菜单、disabled、分隔符、Esc、点外部关闭、DPI 缩放全部由系统菜单提供；
 *   * 弹层是系统级窗口，不受视图合成顺序影响。
 *
 * 于是本模块只做两件小事：把顶层菜单标题交给标题栏画按钮，以及在按钮位置把对应子菜单
 * 弹出来。
 */
import type { BaseWindow, Menu, MenuItemConstructorOptions } from 'electron'

import type { ShellStrings } from './i18n'

/** 标题栏上的一个菜单按钮。 */
export interface ShellMenuBarEntry {
  /** 在原生菜单里的顶层下标——弹菜单时用它取回同一个 MenuItem。 */
  index: number
  /** 显示文案（沿用原生菜单的 label，也就是 i18n 里的那一份）。 */
  label: string
}

/** 「最近打开」的一项：显示名与实际路径（路径用于 toolTip 与点击）。 */
export interface RecentEntry {
  label: string
  path: string
}

/**
 * 构建应用菜单需要的一切。
 *
 * 拆成纯数据 + 回调、与 Electron 无关（`role`/`accelerator`/`click` 就是模板本身），有两个
 * 直接好处：
 *   * **文案与命令彻底分开**——标签来自 {@link ShellStrings}，命令是这里的回调，任何地方都
 *     没有"按显示文字找功能"的余地（回归测试直接比对中英两份模板：只有 label 变）；
 *   * 语言可以在运行中换（重建模板即可），不需要重启应用。
 */
export interface ApplicationMenuDeps {
  /** 当前语言的文案。 */
  strings: ShellStrings
  /** 「最近打开」子菜单的数据（已过滤掉不存在的目录）。 */
  recent: RecentEntry[]
  /** 智能体运行时版本（帮助菜单里的信息行）。 */
  runtimeVersion: string
  /** 外壳版本。 */
  shellVersion: string
  openFolder: () => void
  openRecent: (path: string) => void
  projectInfo: () => void
  revealWorkspace: () => void
  copyWorkspacePath: () => void
  openUpdates: () => void
  openReleases: () => void
}

/**
 * 组装应用菜单模板。
 *
 * @param deps - 文案、动态数据与命令回调。
 * @returns 可直接交给 `Menu.buildFromTemplate()` 的模板。
 */
export function applicationMenuTemplate(deps: ApplicationMenuDeps): MenuItemConstructorOptions[] {
  const s = deps.strings
  return [
    {
      label: s.menuFile,
      submenu: [
        { label: s.itemOpenFolder, accelerator: 'CmdOrCtrl+O', click: deps.openFolder },
        {
          label: s.itemOpenRecent,
          submenu:
            deps.recent.length === 0
              ? [{ label: s.itemNoRecent, enabled: false }]
              : deps.recent.map((entry) => ({
                  label: entry.label,
                  toolTip: entry.path,
                  click: () => deps.openRecent(entry.path),
                })),
        },
        { type: 'separator' },
        { label: s.itemProjectInfo, accelerator: 'CmdOrCtrl+I', click: deps.projectInfo },
        { label: s.itemRevealWorkspace, click: deps.revealWorkspace },
        { label: s.itemCopyWorkspacePath, click: deps.copyWorkspacePath },
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
          click: deps.openUpdates,
        },
      ],
    },
    {
      label: s.menuHelp,
      submenu: [
        { label: s.itemCheckUpdates, click: deps.openUpdates },
        { type: 'separator' },
        { label: s.itemOpenReleases, click: deps.openReleases },
        { type: 'separator' },
        // 静态元数据放在帮助菜单里，并明确标为不可点击的信息。
        { label: `${s.itemRuntimeVersion}  ${deps.runtimeVersion}`, enabled: false },
        { label: `${s.itemShellVersion}  ${deps.shellVersion}`, enabled: false },
      ],
    },
  ]
}

/**
 * 把菜单模板打成可断言的文本（诊断开关 `DSH_DESKTOP_DUMP_MENU=1`）。
 *
 * 存在的理由：菜单在主进程里，渲染进程的 CDP 读不到；而没有可读的输出，"菜单改对了吗"
 * 就只能靠人肉截图去猜。语言切换会重建菜单，因此这份输出也会**再打一次**——运行中的
 * 语言同步因此可以被脚本直接断言。
 *
 * @param template - 刚构建出来的模板。
 * @returns 多行文本。
 */
export function dumpMenuTemplate(template: MenuItemConstructorOptions[], indent = ''): string {
  return template
    .map((item) => {
      const label = item.label ?? (item.role === undefined ? '(分隔)' : `role=${item.role}`)
      const accel = item.accelerator === undefined ? '' : `  [${item.accelerator}]`
      const disabled = item.enabled === false ? '  (禁用)' : ''
      const head = `${indent}${label}${accel}${disabled}`
      const children = Array.isArray(item.submenu)
        ? '\n' + dumpMenuTemplate(item.submenu as MenuItemConstructorOptions[], `${indent}    `)
        : ''
      return head + children
    })
    .join('\n')
}

/**
 * 列出菜单栏按钮。
 *
 * 只取带子菜单的顶层项：没有子菜单的顶层项点下去无事可做，画出来就是个坏按钮。
 * @param menu - 已注册的原生菜单。
 * @returns 菜单栏条目（顺序与原生菜单一致）。
 */
export function menuBarEntries(menu: Menu): ShellMenuBarEntry[] {
  const entries: ShellMenuBarEntry[] = []
  menu.items.forEach((item, index) => {
    if (item.type === 'separator') return
    if (!Array.isArray(item.submenu?.items)) return
    entries.push({ index, label: item.label })
  })
  return entries
}

/**
 * 在指定位置弹出某个顶层菜单的子菜单。
 *
 * 坐标按 Electron 的 `menu.popup({ window, x, y })` 语义传**窗口客户区**坐标（窗口没有
 * 原生标题栏，因此客户区坐标就是窗口坐标）。渲染进程给的是按钮的 `getBoundingClientRect`，
 * 两者同一坐标系。
 *
 * @param menu - 已注册的原生菜单。
 * @param index - 顶层下标（来自渲染进程，属不可信输入）。
 * @param window - 弹菜单的窗口。
 * @param point - 窗口客户区坐标。
 * @param onClosed - 菜单关闭时回调（标题栏用它复位 `aria-expanded` 并把焦点还给 Harness）。
 * @returns 是否弹出了一个菜单。
 */
export function openMenuAt(
  menu: Menu,
  index: unknown,
  window: BaseWindow,
  point: { x: number; y: number },
  onClosed?: () => void,
): boolean {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= menu.items.length) return false
  const item = menu.items[index]
  if (item === undefined) return false
  const target = Array.isArray(item.submenu?.items) ? item.submenu : undefined
  if (target === undefined) return false
  const x = Number.isFinite(point.x) ? Math.max(0, Math.round(point.x)) : 0
  const y = Number.isFinite(point.y) ? Math.max(0, Math.round(point.y)) : 0
  target.popup({ window, x, y, ...(onClosed === undefined ? {} : { callback: onClosed }) })
  return true
}
