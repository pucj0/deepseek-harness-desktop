/**
 * 自绘标题栏所在的页面（窗口自身的文档）。
 *
 * ## 为什么是"窗口页面 + 视图"而不是往 Harness 页面里注入
 *
 * 窗口自身的 webContents 渲染本文件（标题栏 + 启动加载页），Harness 官方界面则运行在
 * 一个位于标题栏下方的 `WebContentsView` 里（见 `window.ts`）。这样：
 *   * 顶部区域属于**外壳**，不需要往官方页面里插 DOM，也就不必猜它的布局类名、不会随它
 *     改版而失效（此前只有"注入 <style>"这一种先例，那是给字号用的，与窗口边界无关）；
 *   * Harness 页面的视口就是"标题栏以下"那块，因此它自己的 `position: fixed` 全高面板
 *     （审查抽屉、设置弹窗）不会被标题栏盖住——这一点是"把标题栏叠在页面上"做不到的。
 *
 * ## 主题
 *
 * 颜色**不写死**：`window.ts` 从 Harness 页面读到官方令牌（`--dsw-alias-*`）后推给本页，
 * 本页只把它们写成 CSS 变量使用。读不到时（启动早期）退回跟随系统深浅色的中性值。
 *
 * ## 页面内的 id 与既有测试
 *
 * `#startup-hint` 沿用原来的加载页 id：外壳在服务端就绪前显示的进度提示仍由它承载，
 * 既有测试（`test-startup-window.cjs`）因此继续有意义。
 */

/** 页面渲染所需的初始值。 */
export interface ShellPageOptions {
  /** `process.platform`，用于平台差异（macOS 需要给交通灯留位）。 */
  platform: string
  /** 标题栏高度（CSS px）。 */
  height: number
  /** 是否自绘标题栏（Linux 保留原生边框，此时整条标题栏都不画）。 */
  custom: boolean
  /** 是否在标题栏里画菜单按钮（macOS 的菜单在系统菜单栏，不重复画）。 */
  menus: boolean
  /** 加载页主标题。 */
  splashTitle: string
  /** 加载页提示文案。 */
  splashHint: string
  /** 导航按钮的无障碍文案（窗口控制按钮是原生的，由系统提供文案）。 */
  backLabel: string
  forwardLabel: string
  /**
   * 当前语言（规范 id，如 `zh-CN`）。
   *
   * 写进文档的 `lang`：屏幕阅读器与拼写检查据此工作，而它必须与 Harness 的语言一致
   * （页面里画的就是中文菜单，`lang="en"` 是错的）。
   */
  locale: string
  /** 深色主题下的初始配色（跟随系统）。 */
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
 * 标题栏样式。
 *
 * 硬性约束都写在这里，改样式时不必回头翻需求：高度由 `--tb-height` 单点控制；
 * 右侧原生按钮的占地由 `env(titlebar-area-*)` 算出（因此 100/125/150% 缩放下都不会重叠，
 * 也不需要任何硬编码像素）；可交互元素一律 `no-drag`，其余整条都是拖拽区。
 */
const STYLE = `
:root {
  --tb-height: 40px;
  --tb-bg: #1b1b1f;
  --tb-fg: #e8e8ea;
  --tb-fg-dim: #9a9aa5;
  --tb-hover: rgba(255, 255, 255, .08);
  --tb-active: rgba(255, 255, 255, .14);
  --tb-border: rgba(255, 255, 255, .09);
  color-scheme: dark;
}
html[data-theme="light"] {
  --tb-bg: #f6f6f8;
  --tb-fg: #1f1f24;
  --tb-fg-dim: #6b6b75;
  --tb-hover: rgba(15, 17, 21, .07);
  --tb-active: rgba(15, 17, 21, .12);
  --tb-border: rgba(15, 17, 21, .10);
  color-scheme: light;
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  background: var(--tb-bg);
  color: var(--tb-fg);
  font: 12.5px/1.5 -apple-system, "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
}
/* 标题栏：整条是拖拽区，交互元素逐个让开。 */
#titlebar {
  position: fixed; inset: 0 0 auto 0;
  height: var(--tb-height);
  display: flex; align-items: center;
  background: var(--tb-bg);
  border-bottom: 1px solid var(--tb-border);
  z-index: 10;
  -webkit-app-region: drag;
  /* 右侧给原生窗口控制按钮留位：env(titlebar-area-*) 由 Electron 按当前 DPI 给出。 */
  padding-left: 6px;
  padding-right: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw));
}
html[data-platform="darwin"] #titlebar { padding-left: 78px; }
#titlebar.no-border { border-bottom-color: transparent; }
.tb-group { display: flex; align-items: center; gap: 2px; -webkit-app-region: no-drag; }
.tb-icon {
  display: flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; margin-right: 4px;
  color: var(--tb-fg);
  -webkit-app-region: no-drag;
}
.tb-icon svg { display: block; }
.tb-btn {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 28px; height: 26px; padding: 0 6px;
  border: 0; border-radius: 4px;
  background: transparent; color: var(--tb-fg);
  font: inherit; cursor: default;
  -webkit-app-region: no-drag;
}
.tb-btn:hover:not(:disabled) { background: var(--tb-hover); }
.tb-btn:active:not(:disabled) { background: var(--tb-active); }
.tb-btn:disabled { color: var(--tb-fg-dim); opacity: .55; }
.tb-btn:focus-visible { outline: 1px solid var(--tb-fg-dim); outline-offset: -1px; }
#menubar { display: flex; align-items: center; gap: 1px; margin-left: 6px; -webkit-app-region: no-drag; }
#menubar[hidden] { display: none; }
.tb-menu {
  height: 26px; padding: 0 9px;
  border: 0; border-radius: 4px; background: transparent; color: var(--tb-fg);
  font: inherit; cursor: default;
}
.tb-menu:hover { background: var(--tb-hover); }
.tb-menu[aria-expanded="true"] { background: var(--tb-active); }
.tb-menu:focus-visible { outline: 1px solid var(--tb-fg-dim); outline-offset: -1px; }
/* 中段：撑满剩余空间，纯拖拽区（双击标题栏最大化/还原由系统在 drag 区域处理）。 */
.tb-drag { flex: 1; height: 100%; min-width: 24px; }
/* 加载页：标题栏以下直到窗口底部，Harness 页面就绪后被它盖住。 */
#splash {
  position: fixed; inset: var(--tb-height) 0 0 0;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 18px;
  background: var(--tb-bg); color: var(--tb-fg);
}
#splash[hidden] { display: none; }
.splash-mark { display: flex; align-items: center; gap: 10px; opacity: .95; }
.splash-dot {
  width: 10px; height: 10px; border-radius: 50%;
  background: #4d8dff; animation: tb-pulse 1.1s ease-in-out infinite;
}
@keyframes tb-pulse { 0%, 100% { opacity: .35; transform: scale(.85) } 50% { opacity: 1; transform: scale(1) } }
.splash-title { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: .2px; }
.splash-hint { color: var(--tb-fg-dim); font-size: 12.5px; }
`

/** 页面脚本：只做"画标题栏 + 转发交互"，业务动作全部在主进程。 */
const SCRIPT = `
(function () {
  var api = window.dshTitlebar
  var root = document.documentElement
  var titlebar = document.getElementById('titlebar')
  var menubar = document.getElementById('menubar')
  var back = document.getElementById('nav-back')
  var forward = document.getElementById('nav-forward')
  var splash = document.getElementById('splash')
  var hint = document.getElementById('startup-hint')
  var state = { ready: false, maximized: false, fullScreen: false, canGoBack: false, canGoForward: false }
  var layout = { custom: true, menus: true }
  // 已经画出来的语言。语言一变，菜单按钮的文案（来自原生菜单）必须重新拉一次。
  var locale = null

  if (!api) { return }

  /** 把语言落到文档与导航按钮上。 */
  function applyLocale(next) {
    if (!next || typeof next.locale !== 'string' || next.locale === '') { return false }
    var changed = next.locale !== locale
    locale = next.locale
    root.lang = next.locale
    if (back && typeof next.backLabel === 'string') {
      back.setAttribute('aria-label', next.backLabel)
      back.title = next.backLabel
    }
    if (forward && typeof next.forwardLabel === 'string') {
      forward.setAttribute('aria-label', next.forwardLabel)
      forward.title = next.forwardLabel
    }
    return changed
  }

  /** 把主题令牌落到 CSS 变量（缺项保持初始值）。 */
  function applyTheme(theme) {
    if (!theme) { return }
    root.dataset.theme = theme.dark ? 'dark' : 'light'
    var map = {
      '--tb-bg': theme.bg,
      '--tb-fg': theme.fg,
      '--tb-fg-dim': theme.fgDim,
      '--tb-hover': theme.hover,
      '--tb-active': theme.active,
      '--tb-border': theme.border
    }
    for (var name in map) {
      if (typeof map[name] === 'string' && map[name] !== '') { root.style.setProperty(name, map[name]) }
    }
  }

  /** 平台与几何只在首帧同步一次（它们不随运行变化）。 */
  function applyLayout(next) {
    root.dataset.platform = next.platform
    if (next.custom) { root.style.setProperty('--tb-height', next.height + 'px') }
    layout = { custom: next.custom, menus: next.menus }
  }

  /** 菜单按钮：点击时把按钮左边缘与标题栏底边的坐标交给主进程弹原生菜单。 */
  function buildMenubar(entries) {
    menubar.replaceChildren()
    entries.forEach(function (entry) {
      var button = document.createElement('button')
      button.type = 'button'
      button.className = 'tb-menu'
      button.textContent = entry.label
      button.setAttribute('aria-haspopup', 'true')
      button.setAttribute('aria-expanded', 'false')
      button.dataset.index = String(entry.index)
      button.title = entry.label
      button.addEventListener('mousedown', function (event) {
        // mousedown 而不是 click：桌面菜单在按下时就打开，并立即把焦点交回 Harness。
        event.preventDefault()
        openMenu(button)
      })
      button.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
          event.preventDefault()
          openMenu(button)
        }
      })
      menubar.appendChild(button)
    })
  }

  /** 打开某个菜单按钮对应的原生菜单，并在关闭后复位状态。 */
  function openMenu(button) {
    if (!state.ready) { return }
    var rect = button.getBoundingClientRect()
    // 纵坐标用标题栏底边而不是按钮底边：原生菜单条的子菜单是与菜单条下沿齐平的，
    // 用按钮底边会让弹层压住标题栏最后几像素。
    var y = layout.custom ? state.height : Math.round(rect.bottom)
    button.setAttribute('aria-expanded', 'true')
    api.openMenu(Number(button.dataset.index), Math.round(rect.left), Math.round(y)).then(function () {
      button.setAttribute('aria-expanded', 'false')
      api.focusApp()
    }).catch(function () {
      button.setAttribute('aria-expanded', 'false')
    })
  }

  function renderState() {
    back.disabled = !state.ready || !state.canGoBack
    forward.disabled = !state.ready || !state.canGoForward
    // 服务端就绪前没有项目可开，菜单按钮此时点不出内容——隐藏而不是给个死按钮。
    menubar.hidden = !layout.menus || !state.ready
    titlebar.classList.toggle('no-border', !state.ready)
    // 反映到 data-* 上：既是样式钩子，也让"窗口状态有没有推过来"可被脚本断言。
    root.dataset.ready = state.ready ? '1' : '0'
    root.dataset.maximized = state.maximized ? '1' : '0'
    root.dataset.fullscreen = state.fullScreen ? '1' : '0'
    root.dataset.goBack = state.canGoBack ? '1' : '0'
    root.dataset.goForward = state.canGoForward ? '1' : '0'
    if (state.ready) { splash.hidden = true }
  }

  /** 菜单展开标记复位（原生菜单关闭的兜底，见下）。 */
  function resetMenus() {
    var buttons = menubar.querySelectorAll('button')
    for (var i = 0; i < buttons.length; i += 1) { buttons[i].setAttribute('aria-expanded', 'false') }
  }

  back.addEventListener('click', function () { api.navigate('back') })
  forward.addEventListener('click', function () { api.navigate('forward') })
  // 原生菜单关闭时主进程会回调（见 window.ts），但那条链路依赖 Electron 的 popup 回调；
  // 这里再加两道本地兜底，保证标记不会因为回调没回来而永久停在"展开"。
  window.addEventListener('blur', resetMenus)
  titlebar.addEventListener('pointerdown', function (event) {
    var target = event.target
    if (!target || !target.closest || target.closest('#menubar') === null) { resetMenus() }
  })

  api.onState(function (next) {
    state = next
    applyLayout(next)
    applyTheme(next.theme)
    // 语言变化：菜单按钮的文案在主进程重建菜单之后才更新，因此这里必须再拉一次。
    if (applyLocale(next)) {
      api.getMenu().then(function (entries) { buildMenubar(entries || []) }).catch(function () {})
    }
    renderState()
  })
  api.onSplash(function (text) {
    if (hint && typeof text === 'string') { hint.textContent = text }
  })
  // 启动瞬间先按系统深浅色画一次，避免等服务端就绪才不再闪色。
  api.getState().then(function (initial) {
    state = initial
    applyLayout(initial)
    applyTheme(initial.theme)
    applyLocale(initial)
    renderState()
    return api.getMenu()
  }).then(function (entries) {
    buildMenubar(entries || [])
    renderState()
  }).catch(function () {})
})()
`

/**
 * 生成标题栏页面。
 * @param options - 平台、高度与加载页文案。
 * @returns 完整 HTML 文档。
 */
export function shellPageHtml(options: ShellPageOptions): string {
  const theme = options.dark ? 'dark' : 'light'
  // 缺省时用英文的规范 id：`lang` 必须是合法标签，不能让一个缺字段的调用把页面写坏。
  const lang = escapeHtml(typeof options.locale === 'string' && options.locale !== '' ? options.locale : 'en-US')
  const menus = options.menus ? '' : ' hidden'
  // 不自绘标题栏（Linux 保留原生边框）时整条都不画，加载页铺满整个窗口。
  const bar = options.custom ? '' : ' hidden'
  const splashInset = options.custom ? 'var(--tb-height)' : '0px'
  return `<!doctype html>
<html lang="${lang}" data-platform="${escapeHtml(options.platform)}" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<title>DeepSeek Harness</title>
<style>${STYLE}</style>
</head>
<body>
<div id="titlebar"${bar}>
  <span class="tb-group">
    <span class="tb-icon" aria-hidden="true">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" stroke="currentColor" stroke-width="1.6"/>
        <circle cx="12" cy="12" r="3.4" fill="currentColor"/>
      </svg>
    </span>
  </span>
  <span class="tb-group">
    <button id="nav-back" class="tb-btn" type="button" disabled aria-label="${escapeHtml(options.backLabel)}" title="${escapeHtml(options.backLabel)}">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M9.8 3.3 5.1 8l4.7 4.7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <button id="nav-forward" class="tb-btn" type="button" disabled aria-label="${escapeHtml(options.forwardLabel)}" title="${escapeHtml(options.forwardLabel)}">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M6.2 3.3 10.9 8l-4.7 4.7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
  </span>
  <span id="menubar" role="menubar"${menus}></span>
  <span class="tb-drag"></span>
</div>
<div id="splash" style="inset: ${splashInset} 0 0 0">
  <div class="splash-mark"><span class="splash-dot"></span><h1 class="splash-title">${escapeHtml(options.splashTitle)}</h1></div>
  <div class="splash-hint" id="startup-hint">${escapeHtml(options.splashHint)}</div>
</div>
<script>${SCRIPT}</script>
</body>
</html>`
}
