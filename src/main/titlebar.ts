/**
 * 自定义标题栏的平台策略与主题换算。
 *
 * ## 为什么是「隐藏标题栏 + titleBarOverlay」而不是 `frame: false`
 *
 * `frame: false` 会把窗口控制按钮一起交给网页自己画，随之失去的是 Excel 意义上的
 * **Windows Snap Layout**：Win11 里鼠标悬停在最大化按钮上弹出的贴靠布局菜单是系统为
 * *原生 caption button* 提供的，自绘按钮拿不到（Electron 也没有 API 触发它）。同时
 * `frame: false` 还要自己处理窗口阴影、DPI、最大化时的越界与 resize 命中区。
 *
 * `titleBarStyle: 'hidden'` + `titleBarOverlay` 则相反：标题栏的**绘制**交给网页，
 * **窗口控制按钮仍是原生的**（由 Electron/DWM 画在右上角，含悬停态、贴靠布局、DPI 缩放）。
 * 实测（Electron 33.4.11，Win11）：
 *   * `navigator.windowControlsOverlay.visible === true`
 *   * `env(titlebar-area-height)` / `env(titlebar-area-width)` 可用 —— 因此布局可以
 *     精确避开原生按钮，而**不需要**任何硬编码像素（DPI 100/125/150% 都成立）
 *   * `getContentBounds() === getBounds()`：网页铺满窗口，最大化时也没有额外 8px 边距
 *   * `win.setTitleBarOverlay()` 运行时可改 —— 主题切换时原生按钮的颜色跟着走
 *
 * 结论：Windows 上用 titleBarOverlay，标题栏内容自绘、窗口控制保持原生。
 *
 * ## 各平台策略
 *
 * * **win32**：完整自定义标题栏（图标 + 前进/后退 + 菜单）+ 原生 caption buttons。
 * * **darwin**：`titleBarStyle: 'hiddenInset'`，交通灯是原生的，因此左侧留出空间、
 *   并且**不画**自己的窗口控制；菜单仍留在系统菜单栏（macOS 惯例），窗口内不重复画。
 * * **其他（Linux）**：保留原生边框与原生菜单栏——那里没有 titleBarOverlay 的可靠实现，
 *   换掉边框要自己承担 resize/阴影/贴靠，得不偿失。行为完全不变。
 */

/** 标题栏高度（CSS px）。取 40：在 38–44 的约束内，且与原生按钮高度一致。 */
export const TITLEBAR_HEIGHT = 40

/** 窗口控制按钮覆盖层需要的颜色。 */
export interface OverlayColors {
  /** 覆盖层底色（不透明），必须与标题栏背景一致。 */
  color: string
  /** 按钮符号颜色。 */
  symbolColor: string
}

/** 官方 UI 主题令牌的回退值（Harness 页面还没加载、或读不到令牌时用）。 */
const FALLBACK = {
  dark: { bg: '#1b1b1f', fg: '#e8e8ea' },
  light: { bg: '#f6f6f8', fg: '#1f1f24' },
} as const

/**
 * 本平台是否自绘标题栏。
 * @param platform - `process.platform`。
 * @returns true 表示自绘标题栏内容（原生 caption buttons 仍保留）。
 */
export function usesCustomTitleBar(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin'
}

/**
 * 本平台是否使用原生菜单栏（即不自绘菜单，也不把它藏起来）。
 * @param platform - `process.platform`。
 * @returns true 表示保留原生菜单栏的视觉表现。
 */
export function keepsNativeMenuBar(platform: NodeJS.Platform = process.platform): boolean {
  return !usesCustomTitleBar(platform)
}

/**
 * 本平台是否自绘菜单（Windows 自绘；macOS 菜单在系统菜单栏，窗口内不重复画）。
 * @param platform - `process.platform`。
 * @returns true 表示标题栏里要画菜单按钮。
 */
export function drawsMenusInTitleBar(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
}

/**
 * 把主题令牌换算成覆盖层颜色。
 *
 * 令牌来自 Harness 页面本身（`--dsw-alias-*`），因此原生按钮的底色与自绘标题栏、
 * 与官方界面三者必然一致；读不到时按系统深浅色回退。
 *
 * `setTitleBarOverlay` 只接受不透明颜色，所以这里把任何非 `#rrggbb` 的写法（rgb()、
 * 带 alpha 的 hex）都归一化；透明度或解析失败一律回退。
 *
 * @param theme - Harness 页面上报的令牌（可能不完整）。
 * @returns 覆盖层颜色。
 */
export function overlayColors(theme: { bg?: string; fg?: string; dark?: boolean }): OverlayColors {
  const fallback = theme.dark === true ? FALLBACK.dark : theme.dark === false ? FALLBACK.light : undefined
  const bg = normalizeHex(theme.bg) ?? fallback?.bg ?? FALLBACK.dark.bg
  const fg = normalizeHex(theme.fg) ?? fallback?.fg ?? FALLBACK.dark.fg
  return { color: bg, symbolColor: fg }
}

/**
 * 系统深浅色对应的回退令牌（Harness 页面尚未就绪时用）。
 * @param dark - 是否深色。
 * @returns 背景与前景色。
 */
export function systemThemeTokens(dark: boolean): { bg: string; fg: string; dark: boolean } {
  return dark ? { ...FALLBACK.dark, dark: true } : { ...FALLBACK.light, dark: false }
}

/**
 * 把任意 CSS 颜色归一化成 `#rrggbb`（覆盖层接口只接受这种写法）。
 * @param value - 原始颜色文本。
 * @returns 归一化后的颜色，或 undefined（透明 / 无法解析）。
 */
export function normalizeHex(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/u.exec(text)
  if (hex !== null) {
    const digits = hex[1]!
    if (digits.length === 3) {
      return `#${digits[0]!}${digits[0]!}${digits[1]!}${digits[1]!}${digits[2]!}${digits[2]!}`
    }
    if (digits.length === 8) {
      // 带 alpha：完全透明不可用，否则丢掉 alpha（覆盖层要求不透明）。
      if (digits.slice(6) === '00') return undefined
      return `#${digits.slice(0, 6)}`
    }
    return `#${digits}`
  }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+%?))?\s*\)$/u.exec(text)
  if (rgb !== null) {
    const alpha = rgb[4]
    if (alpha !== undefined) {
      const value = alpha.endsWith('%') ? Number.parseFloat(alpha) / 100 : Number.parseFloat(alpha)
      if (Number.isFinite(value) && value <= 0) return undefined
    }
    const channel = (raw: string): string =>
      Math.max(0, Math.min(255, Math.round(Number.parseFloat(raw)))).toString(16).padStart(2, '0')
    return `#${channel(rgb[1]!)}${channel(rgb[2]!)}${channel(rgb[3]!)}`
  }
  return undefined
}
