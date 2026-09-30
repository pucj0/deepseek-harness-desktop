/**
 * 启动态页面：**整个窗口**都是 Harness 的那一层，只是还没拿到 Host 的 URL。
 *
 * ## 为什么需要它，而不是第二个"外壳页面"
 *
 * 单 renderer 架构下窗口自身的 `webContents` 最终要交给 Harness 页面（见 `window.ts` 的
 * `SINGLE_RENDERER`），所以在 Host 就绪之前窗口里必须先有**一点东西**，否则用户看到的是
 * 一块空白或纯色板。这里刻意做到最小：
 *
 *   * **不画标题栏、不画 Logo、不画菜单、不画窗口按钮**——那些在单 renderer 架构里都属于
 *     Harness 自己（它的侧栏与顶部区域），外壳再画一遍就是"两层"的来源；
 *   * **只铺一块跟随主题的底色 + 一行提示**，并且**在上面留出标题栏那条**：原生 caption
 *     buttons 由 `titleBarOverlay` 画在右上角，留白让它们不与文字重叠；
 *   * 它是 `file://` 加载的静态 HTML，**不依赖 Host**，因此窗口可以立刻显示。
 *
 * 也就是说：这个页面与最终 Harness 页面在**同一个 `webContents`、同一份布局上下文**里先后
 * 出现（`loadFile` → 就绪后 `loadURL`），不存在"上面一层外壳、下面一层 Harness"。
 *
 * ## 与旧 `shell-page.ts` 的关系
 *
 * 旧架构里 `shell-page.ts` 画的是 40px 自绘标题栏（Logo + 菜单 + 窗口状态），并长期作为
 * 窗口自身文档存在，Harness 只在它下面的子视图里——那才是"两层"。本文件不是它的替代品：
 * 它只是一张**一次性的启动底板**，Harness 就绪后即被替换掉。
 */

/** 启动底板需要的文案与配色。 */
export interface SplashPageOptions {
  /** 主标题（产品名）。 */
  title: string
  /** 一行提示（i18n）。 */
  hint: string
  /** 标题栏高度（CSS px）：顶部留白，避开原生 caption buttons。 */
  titlebarHeight: number
  /** 当前语言，写进 `<html lang>`。 */
  locale: string
  /** 底色（来自系统深浅色或 Harness 已上报的令牌）。 */
  background: string
  /** 前景色。 */
  foreground: string
  /** 是否深色。 */
  dark: boolean
}

/**
 * HTML 转义：标题与提示来自 i18n，是数据而不是标记。
 * @param value - 原始文本。
 * @returns 可安全嵌入 HTML 的文本。
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
}

/**
 * 生成启动底板页面。
 *
 * 页面自带 `-webkit-app-region: drag` 的顶部条：Host 启动期间用户仍然可以拖动窗口，而
 * Harness 就绪后它整页被替换，拖动区交回 Harness 自己。
 *
 * @param options - 文案与配色。
 * @returns 完整 HTML。
 */
export function splashPageHtml(options: SplashPageOptions): string {
  const top = Math.max(0, Math.round(options.titlebarHeight))
  return `<!doctype html>
<html lang="${escapeHtml(options.locale)}" data-theme="${options.dark ? 'dark' : 'light'}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(options.title)}</title>
<style>
  :root { color-scheme: ${options.dark ? 'dark' : 'light'}; }
  html, body { height: 100%; margin: 0; }
  body {
    background: ${options.background};
    color: ${options.foreground};
    font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    display: flex; flex-direction: column;
    overflow: hidden;
  }
  /* 顶部这条是原生 caption buttons 的地盘，同时充当拖动区。 */
  .drag {
    flex: 0 0 auto;
    height: ${top}px;
    -webkit-app-region: drag;
  }
  .center {
    flex: 1 1 auto;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    gap: 10px;
  }
  .name { font-size: 15px; font-weight: 600; opacity: .9; }
  .hint { font-size: 12px; opacity: .55; }
  .bar {
    width: 160px; height: 3px; border-radius: 2px;
    background: currentColor; opacity: .12; overflow: hidden;
  }
  .bar::after {
    content: ""; display: block; width: 40%; height: 100%;
    background: currentColor; opacity: .55;
    animation: slide 1.1s ease-in-out infinite;
  }
  @keyframes slide {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(250%); }
  }
</style>
</head>
<body>
  <div class="drag"></div>
  <div class="center">
    <div class="name">${escapeHtml(options.title)}</div>
    <div class="bar"></div>
    <div class="hint" id="startup-hint">${escapeHtml(options.hint)}</div>
  </div>
  <script>
    // 让主进程能推进度文案（解包等），且不需要第二个渲染进程。
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (data === null || typeof data !== 'object' || data.type !== 'dsh-splash-hint') return;
      const node = document.getElementById('startup-hint');
      if (node !== null && typeof data.hint === 'string') node.textContent = data.hint;
    });
  </script>
</body>
</html>
`
}
