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
import type { BaseWindow, Menu } from 'electron'

/** 标题栏上的一个菜单按钮。 */
export interface ShellMenuBarEntry {
  /** 在原生菜单里的顶层下标——弹菜单时用它取回同一个 MenuItem。 */
  index: number
  /** 显示文案（沿用原生菜单的 label，也就是 i18n 里的那一份）。 */
  label: string
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
