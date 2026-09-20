// review 的客户端半边：本轮的改动概览，以及展示具体差异的侧边栏标签。
//
// 数据来自 host 半边（同源 HTTP 路由）：
//   POST /dsh-desktop/review/baseline   记录本轮基线（本轮开始时调用一次）
//   POST /dsh-desktop/review/changes    基线 vs 当前工作区
//
// 呈现方式刻意复用官方自带的右侧栏，而不是自制浮层：
//   * `sidebar.right.pane.tab`        —— 差异正文（keyed 槽位，key 即标签类型）
//   * `sidebar.right.pane.tab.title`  —— 标签标题
//   打开方式：inject 官方服务 `sidebarRight`，调用 `openTab(kind, { sessionId })`。
// 这样标签的外观、拖拽、关闭、全屏都由官方侧边栏管理，与文档预览等既有标签一致；
// 自制浮层做不到这些，还会在小窗口里被裁剪（此前正是如此）。
//
// 轮次边界怎么定：**dsh 没有轮次生命周期事件**，因此用会话的运行状态推断——agent 从
// "未运行"转为"运行"即一轮开始。这是本次实现里最依赖推断的一处，所以刻意保守：
// 发现没有基线且当前空闲时也会补记，避免因错过跃迁而永久失效。
window.__ModuleLoader__.load({
  id: 'dsh-client-ui-review',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const UI_FONT = 'var(--dsw-font-family, "Segoe UI", "Microsoft YaHei", sans-serif)'
    const CODE_FONT = 'var(--ds-font-family-code, Consolas, "Microsoft YaHei", monospace)'
    const ACCENT = 'var(--dsw-alias-state-business-primary, #4d6bfe)'
    const ADDED = 'var(--dsw-alias-state-success-primary, #16834a)'
    const REMOVED = 'var(--dsw-alias-state-error-primary, #d44747)'
    // 提交流水图那一块的三栏需要描边色（原有的组件各自内联写死了颜色，迁移到常量上
    // 只为新增部分服务，不去动已有渲染，以免顺手改坏已经在跑的界面）。
    const BORDER = 'var(--dsw-alias-border-l1, #eceef2)'
    const styles = `
      [data-desktop-review-surface] button:focus-visible, [data-desktop-review]:focus-visible,
      [data-review-trigger] > button:focus-visible {
        outline: 2px solid ${ACCENT}; outline-offset: 2px;
      }
      [data-desktop-review], [data-review-trigger] > button {
        transition: background-color .15s ease, border-color .15s ease;
      }
      [data-desktop-review]:hover, [data-review-trigger] > button:hover {
        --dsh-review-chip-bg: color-mix(in srgb, ${ACCENT} 5%, var(--dsw-alias-bg-base, #fff));
      }
      [data-desktop-review]:active, [data-review-trigger] > button:active {
        --dsh-review-chip-bg: color-mix(in srgb, ${ACCENT} 9%, var(--dsw-alias-bg-base, #fff));
      }
      .dsh-review-file:hover, .dsh-review-revert:hover:not(:disabled) {
        --dsh-review-row-bg: var(--dsw-alias-interactive-bg-hover);
        --dsh-review-row-border: var(--dsw-alias-border-l2);
      }
      .dsh-review-history + .dsh-review-history {
        border-top: 1px solid var(--dsw-alias-border-l1, #eceef2);
      }

      /* ---- 面板外观：参照 IDEA 的 Git 工具窗口 ---- */

      /* 抽屉左边缘的拖拽手柄。8px 宽（比视觉上的 1px 分割线宽得多）是为了好抓；
       * 真正画出来的只有中间那条线。 */
      [data-review-resizer] {
        position: absolute; left: 0; top: 0; bottom: 0; width: 8px;
        cursor: col-resize; z-index: 3; background: transparent; border: none; padding: 0;
      }
      [data-review-resizer]::after {
        content: ''; position: absolute; left: 3px; top: 0; bottom: 0; width: 2px;
        background: transparent; transition: background-color .15s ease;
      }
      [data-review-resizer]:hover::after, [data-review-resizer]:focus-visible::after,
      [data-review-resizer][data-dragging='1']::after {
        background: color-mix(in srgb, ${ACCENT} 55%, transparent);
      }
      [data-review-resizer]:focus-visible { outline: none; }

      /* 拖动时不要选中文字、也不要让 iframe/文本抢走指针事件。 */
      body[data-review-dragging='1'] { cursor: col-resize; user-select: none; }

      /* 图标按钮：IDEA 的工具窗按钮是"平时无边框、悬停才出底色"。 */
      [data-review-icon-button] {
        display: inline-flex; align-items: center; justify-content: center;
        width: 26px; height: 26px; padding: 0; border-radius: 6px;
        border: 1px solid transparent; background: transparent;
        color: var(--dsw-alias-label-secondary); cursor: pointer;
        transition: background-color .12s ease, color .12s ease;
      }
      [data-review-icon-button]:hover:not(:disabled) {
        background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12));
        color: var(--dsw-alias-label-primary);
      }
      [data-review-icon-button]:disabled { opacity: .5; cursor: default; }

      /* 文件行：整行可点、悬停整行高亮，选中态沿用官方强调色。 */
      .dsh-review-file {
        transition: background-color .12s ease, border-color .12s ease;
      }
      /* 行底（含行尾的「还原」按钮）一起高亮：只让路径那一块变色的话，
       * 鼠标移到行尾的动作按钮上时整行反而"灭"了，看起来像换了一行。 */
      .dsh-review-file-row:hover {
        background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.10));
      }
      .dsh-review-file[aria-expanded='true'] {
        border-color: color-mix(in srgb, ${ACCENT} 38%, transparent) !important;
      }
      /* 状态徽标：一个字母 + 语义色，扫描列表时最省力。 */
      [data-review-status] {
        flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
        min-width: 18px; height: 18px; padding: 0 4px; border-radius: 4px;
        font-family: ${UI_FONT}; font-size: 11px; font-weight: 600; line-height: 1;
      }
      /* 路径里的目录部分压暗，文件名留亮——IDEA 的改动列表就是这个层次。 */
      [data-review-path-dir] { color: var(--dsw-alias-label-tertiary); }
      [data-review-path-name] { color: var(--dsw-alias-label-primary); font-weight: 500; }
      [data-review-row]:hover [data-review-path-name] { color: ${ACCENT}; }

      /* 差异区：贴近编辑器的观感——连续行底色、行号栏、上下各留一点白。 */
      [data-review-diff] {
        border: 1px solid var(--dsw-alias-border-l1, #eceef2);
        border-radius: 6px; overflow: hidden;
        background: var(--dsw-alias-bg-layer-1, #fbfbfd);
      }
      [data-review-diff-header] {
        display: flex; align-items: center; gap: 8px;
        padding: 5px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eceef2);
        background: var(--dsw-alias-bg-module-platform, #f3f3f5);
        color: var(--dsw-alias-label-secondary);
        font-family: ${UI_FONT}; font-size: 11.5px;
      }
      [data-review-diff-row] { min-height: 18px; }
      [data-review-diff-row]:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); }

      /* 分区标题：吸顶，滚动时仍知道自己在看哪一段。
       *
       * 具体外观见文件末尾的"现代观感层"里的同名选择器——那里是这一版统一后的
       * 唯一定义，这里只保留"吸顶"这个行为特性。 */
      [data-review-section-title] {
        position: sticky; top: 0; z-index: 2;
        background: var(--dsw-alias-bg-base, #fff);
      }
      /* 计数：等宽数字，免得数字位数变化时抖动。 */
      [data-review-stats] { font-variant-numeric: tabular-nums; }

      /* =====================================================================
       * 抽屉的现代观感层
       * =====================================================================
       *
       * 为什么把样式集中到类上、而不是继续写内联对象：
       *   1. 内联样式里没法写 :hover / :focus-visible 规则，于是"这行能不能点、
       *      这个按钮是什么"只能靠猜——这是这一版主要想解决的可操作性来源；
       *   2. 同一类控件（行、图标按钮、徽标、分区）此前各写一份内联样式，
       *      行高 26/20/18 混杂、圆角 4/6/7 混杂，一屏里能看出七八种不同的节奏；
       *   3. 内联样式无法复用官方主题变量做统一降级。
       *
       * 契约：这些类只负责**外观**。所有 data-* 标记、title、role、aria-* 属性
       * 一律保持不变——脚本与无障碍读的都是它们（改它们等于改接口）。
       *
       * 尺寸节奏：控件一律 24px 高，行内图标按钮 22px，行最小高度 28px，
       * 圆角 6/8/10 三档，间距走 4 的倍数。 */

      /* 设计令牌挂在面板根上，子树统一取用；同时给浏览器声明这是浅色底，
       * 避免原生 checkbox / scrollbar 在深色系统主题下被画成深色。 */
      [data-desktop-review-surface='panel'] {
        color-scheme: light;
        --dsh-review-row-h: 28px;
        --dsh-review-line: var(--dsw-alias-border-l1, #e9ebf0);
        --dsh-review-card: var(--dsw-alias-bg-layer-1, #fbfbfd);
        --dsh-review-soft: var(--dsw-alias-bg-module-platform, #f4f5f8);
        --dsh-review-hover: var(--dsw-alias-interactive-bg-hover, rgba(77,107,254,.07));
      }

      /* ---- 头部 ---- */
      [data-review-header] {
        display: flex; align-items: center; gap: 8px;
        flex: 0 0 auto;
        height: 44px; padding: 0 10px 0 16px; box-sizing: border-box;
        background: var(--dsw-alias-bg-module-platform, #f5f6f7);
        border-bottom: 1px solid var(--dsh-review-line);
      }
      [data-review-title] {
        display: flex; align-items: baseline; gap: 7px; min-width: 0;
        font-size: 13px; font-weight: 600; letter-spacing: .01em;
        color: var(--dsw-alias-label-primary);
      }
      /* 分支徽标：整个抽屉里"我现在在哪个分支"是第一个要回答的问题。 */
      [data-review-branch] {
        display: inline-flex; align-items: center; gap: 4px;
        max-width: 190px; padding: 1px 7px; border-radius: 999px;
        background: color-mix(in srgb, ${ACCENT} 9%, transparent);
        color: ${ACCENT};
        font-family: ${CODE_FONT}; font-size: 11.5px; font-weight: 500; line-height: 17px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }

        // 分区标题：小号、加粗、次级色，用**字重与颜色**表达层级，不用大写转换
        // （CSS 的 text-transform: uppercase 对中文没有可见效果，却会让混排的英文单词
        // 显得像另一种字体，反而不像同一个界面）。
        [data-review-section-title] {
          display: flex; align-items: center; gap: 7px;
          margin: 0; padding: 10px 2px 5px;
          font-family: ${UI_FONT}; font-size: 11.5px; font-weight: 600;
          letter-spacing: .02em;
          color: var(--dsw-alias-label-secondary);
        }

      /* ---- 行与卡片 ---- */
      /* 行容器本身不吃事件，行内控件各自吃：这样点空白处不会误触展开。 */
      [data-staging-row] { pointer-events: none; }
      [data-staging-row] > * { pointer-events: auto; }
      [data-staging-row]:hover { background: var(--dsh-review-hover); }

      /* 行内动作默认收敛（透明），悬停或键盘聚焦时才浮现。
       * 但**当前生效**的那一个始终可见：aria-expanded 为 true（变更记录已展开）
       * 与 data-review-level 为 on（已暂存）都要看得见状态。 */
      [data-staging-row] [data-staging-row-action],
      [data-staging-row] [data-staging-history] { opacity: 0; transition: opacity .12s ease; }
      [data-staging-row]:hover [data-staging-row-action],
      [data-staging-row]:hover [data-staging-history],
      [data-staging-row] [data-staging-row-action]:focus-visible,
      [data-staging-row] [data-staging-history]:focus-visible,
      [data-staging-row] [data-staging-history][aria-expanded='true'],
      [data-staging-row] [data-review-level='on'] { opacity: 1; }
      /* 触摸屏没有 hover：直接全显，否则那些动作永远看不到。 */
      @media (hover: none) {
        [data-staging-row] [data-staging-row-action],
        [data-staging-row] [data-staging-history] { opacity: 1; }
      }

      /* ---- 分区头部（可折叠的分组）---- */
      [data-staging-group-head] {
        display: flex; align-items: center; gap: 6px;
        height: 30px; padding: 0 8px;
        border-radius: 6px;
      }
      [data-staging-group-head]:hover { background: var(--dsh-review-hover); }
      [data-staging-group-head] button { border-radius: 4px; }
      [data-staging-group-head] button:focus-visible { outline: 2px solid ${ACCENT}; outline-offset: 1px; }

      /* ---- 控件 ---- */
      [data-review-input]:focus {
        outline: none;
        border-color: color-mix(in srgb, ${ACCENT} 55%, transparent) !important;
        box-shadow: 0 0 0 3px color-mix(in srgb, ${ACCENT} 14%, transparent);
      }
      [data-review-input]::placeholder { color: var(--dsw-alias-label-tertiary); }

      /* 主按钮：唯一一个实心强调色，整屏只有它和另一处"加入 git"用实心。 */
      [data-review-primary] {
        display: inline-flex; align-items: center; justify-content: center;
        height: 26px; padding: 0 14px; box-sizing: border-box;
        border-radius: 7px;
        font-family: ${UI_FONT}; font-size: 12.5px; font-weight: 500;
        transition: background-color .13s ease, border-color .13s ease, color .13s ease;
      }
      [data-review-primary]:disabled { cursor: default; }
      [data-review-primary]:not(:disabled):hover { background: color-mix(in srgb, ${ACCENT} 88%, #000); color: #fff; }
      [data-review-primary]:not(:disabled):active { background: color-mix(in srgb, ${ACCENT} 78%, #000); }

      /* 次按钮：描边、透明底，悬停才浮出强调色。 */
      [data-review-secondary] {
        display: inline-flex; align-items: center; justify-content: center;
        height: 26px; padding: 0 12px; box-sizing: border-box;
        border-radius: 7px; border: 1px solid var(--dsh-review-line);
        background: transparent;
        font-family: ${UI_FONT}; font-size: 12.5px;
        transition: background-color .13s ease, border-color .13s ease, color .13s ease;
      }
      [data-review-secondary]:disabled { cursor: default; }
      [data-review-secondary]:not(:disabled):hover {
        border-color: color-mix(in srgb, ${ACCENT} 45%, transparent);
        background: color-mix(in srgb, ${ACCENT} 7%, transparent);
      }

      /* 计数徽标：分区标题右侧那个数字。 */
      [data-review-count] {
        display: inline-flex; align-items: center; justify-content: center;
        min-width: 18px; height: 18px; padding: 0 5px; box-sizing: border-box;
        border-radius: 999px;
        background: var(--dsw-review-count-bg, color-mix(in srgb, var(--dsw-alias-label-tertiary, #8a8f9c) 14%, transparent));
        color: var(--dsw-alias-label-secondary);
        font-family: ${UI_FONT}; font-size: 11px; font-weight: 500; line-height: 1;
        font-variant-numeric: tabular-nums;
      }

      /* 未跟踪文件的汇总条：把"有多少、选了几个、要做什么"压成一行。 */
      [data-review-untracked-bar] {
        display: flex; align-items: center; gap: 8px;
        margin: 6px 6px 2px; padding: 5px 8px;
        border-radius: 8px;
        background: var(--dsh-review-soft);
        color: var(--dsw-alias-label-secondary);
        font-family: ${UI_FONT}; font-size: 11.5px;
      }

      /* 提交历史：每行之间一条淡线，最后一条不留。 */
      [data-review-commit] + [data-review-commit] { border-top: 1px solid var(--dsh-review-line); }

      /* 移动/窄视口：抽屉本身是 fixed 全高，窄屏下靠缩进换空间。 */
      @media (max-width: 560px) {
        [data-review-header] { padding: 0 6px 0 12px; }
        [data-review-section-title] { font-size: 11px; }
      }
    `

    /** 稳定插件名，用于诊断。 */
    const name = 'dsh-client-ui-review'

    /** gitbar 在 conversation.input.dock 提供的工具条子槽（list / session）。
     * conversation.composer.bar 是官方输入框本体，不能用它放置上方工具条。
     */
    const CHIP_SLOT = 'dsh.desktop.composer.actions'

    /** 项目级入口所在的槽位。
     *
     * 用 `shell.overlay`——**全局覆盖层，list 槽**，在项目页与会话内都会渲染，而且
     * 由我自己决定位置（fixed），不依赖任何槽位的布局。
     *
     * 为什么不挂在别处（都是实测踩过的）：
     *   * `conversation.hero.workspace`（项目页工作区选择器那一行）是 **single** 槽，
     *     官方自己也在注册它；官方在前，我的被静默顶掉，入口从未出现。
     *   * `sidebar.footer.action` 虽然渲染了，但注册后内容为空——项目页那个状态下
     *     数据钩子拿不到，组件直接返回空。
     *   * `conversation.composer.bar` 就是**输入框本体**，遮蔽它会顶掉输入框。
     *
     * 结论：要"无论有没有会话都能点开"，只有全局覆盖层可靠。
     */
    const HERO_SLOT = 'shell.overlay'

    /** 常驻面板开关的持久化键（按应用而非按会话记忆）。 */
    const PANEL_KEY = 'dsh.review.panelOpen'

    /** 抽屉宽度的持久化键。 */
    const PANEL_WIDTH_KEY = 'dsh.review.panelWidth'

    /** 抽屉宽度：下限，以及超宽屏上的像素上限（比例上限见 panelWidthMax）。 */
    const PANEL_WIDTH_MIN = 320
    const PANEL_WIDTH_MAX = 1600

    /** 键盘调整宽度时的步长（方向键）。 */
    const PANEL_WIDTH_STEP = 24

    /** 侧边栏标签正文与标题的槽位。 */
    const TAB_SLOT = 'sidebar.right.pane.tab'
    const TAB_TITLE_SLOT = 'sidebar.right.pane.tab.title'

    /** 提交图的侧栏图标槽（list / root）与主区域内容槽（keyed / root）。 */
    const PANEL_SLOT = 'sidebar.panellist'
    const MAIN_SLOT = 'main'

    /** 标签类型标识：同时作为两个槽位的 key。 */
    const KIND = 'review-changes'

    /** 概览入口的注册 id 与顺序。 */
    const ID = 'review-changes'
    const ORDER = 20

    /** 本地化命名空间。 */
    const NS = 'review'

    /** 路由前缀，与 host 半边一致。 */
    const API = '/dsh-desktop/review'

    /** 概览轮询间隔。
     *
     * 取 10 秒：每次轮询都要让宿主核对工作区状态，而"本轮改了几个文件"晚几秒更新无感。 */
    const POLL_MS = 10000

    // =========================================================================
    // 提交图：泳道布局（与 `lib/graph-layout.js` 是同一份算法）
    // =========================================================================
    //
    // **这段代码是从 `lib/graph-layout.js` 逐字内联进来的**，原因是客户端 bundle 的
    // 契约只允许一个文件：`dsh-client-modules` 只把插件包的 `exports["./client"]` 指向
    // 的那一个脚本送到浏览器（`/plugins/<id>/client.js`），**同目录下的其它文件取不到**，
    // 而运行时的模块加载器只认它自己的基线表（react 等），不接受自定义子路径。
    // 因此"把算法放一个共享文件里、两边 import"这条路在这里走不通。
    //
    // 代价是同一份逻辑有两个副本，所以加了 `scripts/test-graph-layout-parity.mjs`：
    // 它对同一批输入同时跑这里的内联版本与 `lib/graph-layout.js`，逐字段比较结果。
    // **改这里就必须改那边**，否则那条测试会红——这是防止两份实现悄悄漂移的唯一手段。
    //
    // 输入前提（三条，任何一条错了图就会画歪）：
    //   1. 提交按**显示顺序**给出：下标 0 最新、画在最上面一行；父提交一定在它后面的行。
    //   2. 窗口一定是**被截断**的：父提交可能根本不在这个数组里，因此"等不到的线"是常态。
    //   3. 输出里的 `lane` 是**本行的数组下标**，不是整张图的固定列号：每行的线都会向左
    //      紧凑，同一列在不同行可能属于不同分支。渲染器必须按 `rows[i]` 加
    //      `edges[].fromLane/toLane` 来画。

    /** 调色板大小：`color` 的取值恒在 `0..9` 之间。 */
    const GRAPH_COLOR_COUNT = 10

    /** 默认泳道上限：画布宽度必须有界（见 graph-layout.js 的说明）。 */
    const GRAPH_LANE_MAX = 32

    /** 泳道颜色：浅色/深色两套，各自 10 色。 */
    const LANE_COLORS_LIGHT = [
      '#4d6bfe', '#e8590c', '#2f9e44', '#c2255c', '#9c36b5',
      '#0b7285', '#a67c00', '#5f3dc4', '#087f5b', '#c92a2a',
    ]
    const LANE_COLORS_DARK = [
      '#7c93ff', '#ff9f43', '#51cf66', '#f783ac', '#cc5de8',
      '#3bc9db', '#ffe066', '#9775fa', '#38d9a9', '#ff8787',
    ]

    /**
     * 判断当前是否深色主题。
     *
     * 与 `isDarkTheme` 同一套做法（读主题变量的实际颜色算亮度），但**不共用**它：
     * 那个函数在下面的差异渲染里被调用，而这里是图表着色，两者要能各自独立地演进。
     *
     * @returns 深色则 true。
     */
    function graphIsDark() {
      try {
        const raw = getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-bg-base').trim()
        const match = /#([0-9a-f]{6})/iu.exec(raw)
        if (match === null) return false
        const value = Number.parseInt(match[1], 16)
        const r = (value >> 16) & 255
        const g = (value >> 8) & 255
        const b = value & 255
        return (r * 299 + g * 587 + b * 114) / 1000 < 128
      } catch {
        return false
      }
    }

    /** 取一套泳道颜色。 */
    function lanePalette() {
      return graphIsDark() ? LANE_COLORS_DARK : LANE_COLORS_LIGHT
    }

    /** 规范化泳道上限：只接受 ≥1 的整数，其余当没传（见 graph-layout.js 的说明）。 */
    function normalizeLaneLimit(value) {
      return Number.isInteger(value) && value >= 1 ? value : GRAPH_LANE_MAX
    }

    /** 取提交的哈希，形状不对时给空串。 */
    function hashOf(commit) {
      const hash = commit?.hash
      return typeof hash === 'string' ? hash : String(hash ?? '')
    }

    /** 取父提交哈希列表，形状不对时给空数组。 */
    function parentListOf(commit) {
      const parents = commit?.parents
      if (!Array.isArray(parents)) return []
      return parents.map((parent) => (typeof parent === 'string' ? parent : String(parent ?? '')))
    }

    /** 某个哈希在 `from` 这一行（含）之后还会不会出现。 */
    function appearsAtOrAfter(lastIndex, hash, from) {
      const last = lastIndex.get(hash)
      return last !== undefined && last >= from
    }

    /**
     * 计算一个提交窗口的泳道布局。
     *
     * @param commits - 显示顺序的提交：下标 0 最新、画在最上面一行。
     * @param options - `maxLanes` 给出这一屏最多画几列。
     * @returns `{ lanes, rows, truncated }`；`rows[i]` 是 `{ hash, lane, laneCount, edges }`。
     */
    function layoutGraph(commits, options) {
      const list = Array.isArray(commits) ? commits : []
      const limit = normalizeLaneLimit(options?.maxLanes)

      const lastIndex = new Map()
      for (let i = 0; i < list.length; i += 1) lastIndex.set(hashOf(list[i]), i)

      const rows = []
      let pending = []
      let lanes = 0

      for (let i = 0; i < list.length; i += 1) {
        const hash = hashOf(list[i])
        const parents = parentListOf(list[i])

        const slots = pending.slice()
        let lane = -1
        for (let j = 0; j < slots.length; j += 1) {
          if (slots[j].hash === hash) {
            lane = j
            break
          }
        }

        // 颜色取「当前任何活着的线都没占用」的最小非负整数：否则两条同时可见的线会撞色，
        // 而用户正是靠颜色把一条分支从上读到下的。
        const usedColors = new Set(slots.map((line) => line.color))
        const takeColor = () => {
          for (let n = 0; n < GRAPH_COLOR_COUNT; n += 1) {
            if (!usedColors.has(n)) {
              usedColors.add(n)
              return n
            }
          }
          const recycled = usedColors.size % GRAPH_COLOR_COUNT
          usedColors.add(recycled)
          return recycled
        }

        let color
        if (lane < 0) {
          // 没有任何线在等它：这是并行的另一条分支的尖端，在右侧新开一列。
          lane = slots.length
          color = takeColor()
          slots.push({ hash, color })
        } else {
          color = slots[lane].color
        }

        const next = []
        const dest = new Array(slots.length).fill(0)
        const first = parents[0]

        // **必须一趟按列从左到右处理**：早先把第一父提交在整趟走完之后才追加，它会被排到
        // 所有存活线的最后面，于是合并提交上面那条主线会从自己的列跳到最右列，而右边那条线
        // 同时左移，两线在图上凭空交叉一次。
        for (let j = 0; j < slots.length; j += 1) {
          if (j === lane) {
            if (first === undefined) {
              dest[j] = j
            } else {
              dest[j] = next.length
              next.push({ hash: first, color })
            }
            continue
          }
          const line = slots[j]
          if (line.hash === hash) {
            dest[j] = -1
            continue
          }
          if (appearsAtOrAfter(lastIndex, line.hash, i + 1)) {
            dest[j] = next.length
            next.push(line)
          } else {
            // 这条线等的提交再也不会出现了（分页截断或嫁接边界）。**必须**丢掉它：
            // 留着这一列就永久空着，10 个这样的父提交就能把一屏挤成 10 列。
            dest[j] = j
          }
        }

        // 汇入本提交的其它线：在本行结束，去向就是提交那条线的去向，图上画出一个「V」。
        for (let j = 0; j < slots.length; j += 1) {
          if (j !== lane && slots[j].hash === hash) dest[j] = dest[lane]
        }

        const edges = []
        for (let j = 0; j < slots.length; j += 1) {
          edges.push(
            j === lane
              ? { fromLane: j, toLane: dest[j], color, kind: 'commit' }
              : { fromLane: j, toLane: dest[j], color: slots[j].color, kind: 'through' },
          )
        }

        // 额外的父提交（第二、三……个）：已有线在等同一个父提交时**复用**那一列。
        for (let p = 1; p < parents.length; p += 1) {
          const target = parents[p]
          let column = -1
          for (let k = 0; k < next.length; k += 1) {
            if (next[k].hash === target) {
              column = k
              break
            }
          }
          let mergeColor
          if (column < 0) {
            column = next.length
            mergeColor = takeColor()
            next.push({ hash: target, color: mergeColor })
          } else {
            mergeColor = next[column].color
          }
          edges.push({ fromLane: lane, toLane: column, color: mergeColor, kind: 'merge' })
        }

        edges.sort((a, b) => a.fromLane - b.fromLane)

        let laneCount = lane + 1
        for (const edge of edges) {
          laneCount = Math.max(laneCount, edge.fromLane + 1, edge.toLane + 1)
        }
        if (laneCount > lanes) lanes = laneCount

        rows.push({ hash, lane, laneCount, edges })
        pending = next
      }

      // 超出上限时**事后夹取**：遍历中拒绝新列会让"哪些提交落在哪一列"依赖上限值，
      // 同一个仓库换个宽度就整张图重排。
      let truncated = false
      if (lanes > limit) {
        truncated = true
        const cap = limit - 1
        for (const row of rows) {
          row.lane = Math.min(row.lane, cap)
          row.laneCount = Math.min(row.laneCount, limit)
          for (const edge of row.edges) {
            edge.fromLane = Math.min(edge.fromLane, cap)
            edge.toLane = Math.min(edge.toLane, cap)
          }
        }
        lanes = limit
      }

      return { lanes, rows, truncated }
    }


    const zh = {
      idle: '本轮暂无改动',
      turnFiles: '本轮修改 {count}',
      files: '{count} 个文件',
      title: '本轮修改审查',
      noBaseline: '本轮尚未记录基线。开始一轮对话后会自动记录。',
      notRepo: '当前工作区（{name}）不是 git 仓库。',
      clean: '本轮没有改动任何文件。',
      projectTitle: '项目改动',
      noWorkspace: '当前没有可用的工作区。',
      projectIdle: '项目暂无改动',
      workspaceClean: '这个项目当前没有未提交的改动。',
      workspaceEmpty: '这个仓库还没有任何提交。',
      collapse: '收起面板',
      resize: '拖动调整面板宽度（双击复位）',
      refresh: '刷新',
      changesTitle: '改动',
      revert: '还原',
      revertConfirm: '确认还原',
      revertConfirmTitle: '确认还原这个文件？',
      revertConfirmBody: '文件内容将恢复为基线状态；本轮新建的文件会被删除。',
      reverting: '还原中…',
      revertFailed: '还原失败：{message}',
      historyTitle: '最近提交',
      noHistory: '这个仓库还没有任何提交。',
      loading: '正在读取差异…',
      truncated: '差异过大，仅显示前一部分。',
      openInSidebar: '在侧边栏查看',
      statusAdded: '新增',
      statusModified: '修改',
      statusDeleted: '删除',
      statusRenamed: '重命名',
      statusOther: '变更',
      binaryDiff: '该文件是二进制内容，不展示逐行差异。',
      diffOversized: '改动过多，逐行差异超出可读取上限，只列出文件。常见原因是仓库里有未被 .gitignore 覆盖的大目录（例如日志目录）。',
      sidebarUnavailable: '当前界面未能提供侧边栏，无法展示详情。',
      // ---- 提交图（主区域的独立面板）----
      graphPanelLabel: '提交图',
      graphTitle: '提交图',
      graphHead: 'HEAD（当前分支）',
      graphLocal: '本地',
      graphRemote: '远程',
      graphTags: '标签',
      graphNoCommits: '这个仓库还没有任何提交。',
      graphLoadMore: '加载更多',
      graphLoading: '正在读取提交历史…',
      graphTruncatedLanes: '打开的线太多，右侧已折叠显示。',
      graphAllBranches: '全部分支',
      graphFilterRef: '按分支筛选',
      graphDetailTitle: '提交详情',
      graphSelectCommit: '从左侧选一条提交查看改动。',
      graphFiles: '{count} 个文件',
      graphInBranches: '在 {count} 个分支中：{names}',
      graphNoFiles: '这条提交没有改动任何文件（空提交）。',
      graphHideGraph: '收起提交图',
      // ---- 暂存与提交（更改区块）----
      stagedTitle: '已暂存',
      unstagedTitle: '更改',
      untrackedTitle: '未进行版本管理的文件',
      stage: '暂存',
      unstage: '取消暂存',
      stageAll: '全部暂存',
      unstageAll: '全部取消暂存',
      commitMessage: '提交信息（{branch}）',
      commit: '提交',
      committing: '提交中…',
      commitHintCtrlEnter: 'Ctrl+Enter 提交',
      stagedCount: '已暂存 {count}',
      untrackedCount: '{count} 个文件',
      untrackedTruncated: '只列出前 {count} 个，另有 {rest} 个未显示。',
      browseUntracked: '浏览',
      noStagedOrChanged: '工作区干净，没有待提交的改动。',
      // ---- 选择与提交（参考 IDEA：勾选要提交的文件，再提交/提交并推送）----
      selectAll: '全选',
      clearSelection: '取消全选',
      selectedCount: '已选 {count}',
      willCommitCount: '本次将提交 {count} 个文件',
      commitSelected: '提交选中 {count} 个',
      commitAndPush: '提交并推送',
      commitAndPushHint: '提交后推送当前分支到它的上游',
      pushing: '推送中…',
      pushedNotice: '已提交并推送：{subject}',
      pushFailedNotice: '已提交，但推送失败：{detail}',
      error_pushFailed: '推送失败。',
      fileHistory: '变更记录',
      fileHistoryTitle: '变更记录',
      fileHistoryEmpty: '这个文件还没有提交记录。',
      fileHistoryMore: '只显示最近 {count} 条。',
      hideHistory: '收起变更记录',
      // ---- 选择与提交 ----
      noSelection: '先勾选要提交的文件。',
      addToGit: '加入 git',
      addedNotice: '已把 {count} 个文件加入 git（已暂存）',
      stagedNotice: '已暂存 {count} 个文件',
      unstagedNotice: '已取消暂存 {count} 个文件',
      chosenCount: '已选 {count} 个',
      untrackedSelectAll: '全选',
      untrackedClearAll: '全不选',
      untrackedHint: '勾选要纳入版本控制的文件，再点「加入 git」',
      committedNotice: '已提交：{subject}',
      emptyMessage: '请先填写提交信息。',
      error_emptyMessage: '请先填写提交信息。',
      error_nothingStaged: '有改动，但都还没暂存。先「全部暂存」再提交。',
      error_nothingToCommit: '工作区没有改动，没有可提交的内容。',
      error_stageFailed: '暂存失败。',
      error_unstageFailed: '取消暂存失败。',
      error_commitFailed: '提交失败。',
      error_noPaths: '没有选中任何文件。',
      error_unsafePath: '文件路径不合法，已拒绝。',
      error_workspaceNotAllowed: '该工作区未在本应用中登记，已拒绝访问。',
      error_unknownReview: '操作失败。',
    }

    const en = {
      idle: 'No changes this turn',
      turnFiles: 'Changes {count}',
      files: '{count} files',
      title: 'Turn changes',
      noBaseline: 'No baseline recorded for this turn yet. It is captured when a turn starts.',
      notRepo: 'The current workspace ({name}) is not a git repository.',
      clean: 'This turn did not change any file.',
      projectTitle: 'Project changes',
      noWorkspace: 'No workspace is available.',
      projectIdle: 'No project changes',
      workspaceClean: 'This project has no uncommitted changes.',
      workspaceEmpty: 'This repository has no commits yet.',
      collapse: 'Collapse panel',
      resize: 'Drag to resize (double-click to reset)',
      refresh: 'Refresh',
      changesTitle: 'Changes',
      revert: 'Revert',
      revertConfirm: 'Confirm revert',
      revertConfirmTitle: 'Revert this file?',
      revertConfirmBody: 'Its content goes back to the baseline; a file created this turn is deleted.',
      reverting: 'Reverting…',
      revertFailed: 'Revert failed: {message}',
      historyTitle: 'Recent commits',
      noHistory: 'This repository has no commits yet.',
      loading: 'Loading diff…',
      truncated: 'The diff is large; only the beginning is shown.',
      openInSidebar: 'Open in sidebar',
      statusAdded: 'added',
      statusModified: 'modified',
      statusDeleted: 'deleted',
      statusRenamed: 'renamed',
      statusOther: 'changed',
      binaryDiff: 'This file is binary; no line diff is shown.',
      diffOversized: 'Too many changes to read a line-by-line diff; only the file list is shown. A common cause is a large directory not covered by .gitignore (a log directory, for example).',
      sidebarUnavailable: 'The sidebar is unavailable, so details cannot be shown.',
      // ---- Commit graph (its own main-area panel) ----
      graphPanelLabel: 'Commit graph',
      graphTitle: 'Commit graph',
      graphHead: 'HEAD (current branch)',
      graphLocal: 'Local',
      graphRemote: 'Remote',
      graphTags: 'Tags',
      graphNoCommits: 'This repository has no commits yet.',
      graphLoadMore: 'Load more',
      graphLoading: 'Reading commit history…',
      graphTruncatedLanes: 'Too many open lines; the right side is collapsed.',
      graphAllBranches: 'All branches',
      graphFilterRef: 'Filter by branch',
      graphDetailTitle: 'Commit details',
      graphSelectCommit: 'Select a commit on the left to see its changes.',
      graphFiles: '{count} files',
      graphInBranches: 'In {count} branches: {names}',
      graphNoFiles: 'This commit changed no files (empty commit).',
      graphHideGraph: 'Hide commit graph',
      // ---- Staging and committing (the Changes section) ----
      stagedTitle: 'Staged',
      unstagedTitle: 'Changes',
      untrackedTitle: 'Untracked files',
      stage: 'Stage',
      unstage: 'Unstage',
      stageAll: 'Stage all',
      unstageAll: 'Unstage all',
      commitMessage: 'Commit message ({branch})',
      commit: 'Commit',
      committing: 'Committing…',
      commitHintCtrlEnter: 'Ctrl+Enter to commit',
      stagedCount: '{count} staged',
      untrackedCount: '{count} files',
      untrackedTruncated: 'Showing the first {count}; {rest} more not shown.',
      browseUntracked: 'Browse',
      noStagedOrChanged: 'The working tree is clean; nothing to commit.',
      stagedNotice: 'Staged {count} file(s)',
      unstagedNotice: 'Unstaged {count} file(s)',
      addToGit: 'Add to Git',
      addedNotice: 'Added {count} file(s) to Git (now staged)',
      // ---- Selection and commit (IDEA style) ----
      selectAll: 'Select all',
      clearSelection: 'Clear selection',
      selectedCount: '{count} selected',
      willCommitCount: 'Will commit {count} file(s)',
      commitSelected: 'Commit {count} selected',
      commitAndPush: 'Commit and push',
      commitAndPushHint: 'Commit, then push the current branch to its upstream',
      pushing: 'Pushing…',
      pushedNotice: 'Committed and pushed: {subject}',
      pushFailedNotice: 'Committed, but the push failed: {detail}',
      error_pushFailed: 'The push failed.',
      fileHistory: 'History',
      fileHistoryTitle: 'History',
      fileHistoryEmpty: 'No commits touch this file yet.',
      fileHistoryMore: 'Showing the most recent {count}.',
      hideHistory: 'Hide history',
      noSelection: 'Tick the files to commit first.',
      chosenCount: '{count} selected',
      untrackedSelectAll: 'Select all',
      untrackedClearAll: 'Clear selection',
      untrackedHint: 'Tick the files to put under version control, then click "Add to Git"',
      committedNotice: 'Committed: {subject}',
      emptyMessage: 'Write a commit message first.',
      error_emptyMessage: 'Write a commit message first.',
      error_nothingStaged: 'There are changes, but nothing is staged. Use "Stage all" first.',
      error_nothingToCommit: 'The working tree has no changes to commit.',
      error_stageFailed: 'Staging failed.',
      error_unstageFailed: 'Unstaging failed.',
      error_commitFailed: 'Commit failed.',
      error_noPaths: 'No files selected.',
      error_unsafePath: 'That file path was rejected.',
      error_workspaceNotAllowed: 'That workspace is not registered with this app; access denied.',
      error_unknownReview: 'The operation failed.',
    }

    /** git 的 name-status 首字母到字典键。 */
    const STATUS_KEYS = { A: 'statusAdded', M: 'statusModified', D: 'statusDeleted', R: 'statusRenamed' }

    /**
     * 暂存/提交路由的稳定 code 到字典键。
     *
     * host 不知道界面语言，只回 code；短句在这里按 code 渲染，git 的英文原文放在
     * `detail` 里原样展示（它是权威信息，翻译反而失真）。与 gitbar 那边同一套约定。
     */
    const STAGING_ERROR_KEYS = {
      noPaths: 'error_noPaths',
      unsafePath: 'error_unsafePath',
      stageFailed: 'error_stageFailed',
      unstageFailed: 'error_unstageFailed',
      emptyMessage: 'error_emptyMessage',
      nothingStaged: 'error_nothingStaged',
      nothingToCommit: 'error_nothingToCommit',
      commitFailed: 'error_commitFailed',
      workspaceNotAllowed: 'error_workspaceNotAllowed',
    }

    /** 状态字母对应的颜色，让列表一眼能分辨增删改。 */
    const STATUS_COLORS = { A: ADDED, M: 'var(--dsw-alias-state-warn-label, #9a6700)', D: REMOVED, R: ACCENT }

    /**
     * 常驻面板开关的持久化状态。
     *
     * 刻意放在模块级而不是组件 state 里：面板需要在**不同槽位之间共享同一个开关**——
     * 项目页的入口挂在 `conversation.hero.workspace`，会话内的入口挂在输入框工具栏，
     * 两者是两个组件实例，但它们控制的是同一块面板。用 localStorage 加一个订阅列表，
     * 既共享状态又跨重启记住用户的选择。
     */
    const panelStore = (() => {
      const listeners = new Set()
      let open = false
      try {
        open = window.localStorage.getItem(PANEL_KEY) === '1'
      } catch {
        // 读不到就用默认值（隐私模式等）。
      }
      return {
        get: () => open,
        set: (value) => {
          open = value
          try {
            window.localStorage.setItem(PANEL_KEY, value ? '1' : '0')
          } catch {
            // 存不了也不影响本次会话内的行为。
          }
          for (const listener of listeners) listener()
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    })()

    /**
     * 订阅常驻面板的开关状态。
     * @returns 当前是否展开。
     */
    function usePanelOpen() {
      return react.useSyncExternalStore(panelStore.subscribe, panelStore.get, () => false)
    }

    /**
     * 抽屉宽度。
     *
     * 与开关一样存在模块级 + localStorage：面板在两个槽位下是两个组件实例，而宽度是
     * **用户对这块面板的偏好**，关掉再打开、甚至重启应用都该保持。
     *
     * 上限随视口走：抽屉太宽会把主界面挤没，而"多宽算合适"取决于屏幕，因此不写死。
     */
    const panelWidthStore = (() => {
      const read = () => {
        try {
          const stored = Number(window.localStorage.getItem(PANEL_WIDTH_KEY))
          return Number.isFinite(stored) && stored > 0 ? stored : panelWidthDefault()
        } catch {
          return panelWidthDefault()
        }
      }
      return {
        get: read,
        set: (value) => {
          try {
            window.localStorage.setItem(PANEL_WIDTH_KEY, String(value))
          } catch {
            // 存不了就只在本实例内生效。
          }
        },
        reset: () => {
          try {
            window.localStorage.removeItem(PANEL_WIDTH_KEY)
          } catch {
            // 同上。
          }
        },
      }
    })()

    /** 把任意宽度夹到允许区间。 */
    function clampPanelWidth(value) {
      const max = panelWidthMax()
      return Math.round(Math.min(Math.max(value, PANEL_WIDTH_MIN), max))
    }

    /**
     * 默认宽度：视口的 **50%**。
     *
     * 用比例而不是像素：这块抽屉要装下"文件列表 + 逐行差异"，像素宽度在 1366 的笔记本
     * 和 2560 的显示器上是完全不同的两件事。50% 与 IDEA 的 Git 工具窗默认占半屏一致。
     */
    function panelWidthDefault() {
      const viewport = typeof window === 'undefined' ? 1440 : window.innerWidth
      return clampPanelWidth(Math.round(viewport * 0.5))
    }

    /**
     * 当前允许的最大宽度：视口的 **80%**。
     *
     * 也保留一个像素上限，避免在超宽屏上抽屉宽到失去"侧栏"的意义（80% 的 5120 是 4096px，
     * 那时用户真正想要的是把窗口摆成两栏，而不是一个占满的抽屉）。
     */
    function panelWidthMax() {
      const viewport = typeof window === 'undefined' ? 1440 : window.innerWidth
      return Math.max(PANEL_WIDTH_MIN, Math.min(PANEL_WIDTH_MAX, Math.round(viewport * 0.8)))
    }

    /**
     * 请求宿主侧路由。
     * @param path - 相对 API 前缀的路径。
     * @param body - 请求体（会被 JSON 序列化）。
     * @returns 解析后的 JSON；失败时抛出带 code/detail 的错误。
     */
    async function call(path, body) {
      const response = await fetch(`${API}/${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
      const text = await response.text()
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        throw new Error(text.slice(0, 200))
      }
      if (!response.ok) {
        const error = new Error(payload?.error ?? `HTTP ${response.status}`)
        if (typeof payload?.code === 'string') error.code = payload.code
        if (typeof payload?.detail === 'string') error.detail = payload.detail
        throw error
      }
      return payload
    }

    /**
     * 判断一段差异是否是"二进制内容"而非行级差异。
     *
     * git 对二进制文件只输出 `Binary files … differ`，没有可直接渲染的行。若不识别它，
     * 界面就会把这句话当成一行普通文本显示，看起来像是乱码或坏数据。
     * @param diff - 单个文件的差异片段。
     * @returns 是二进制则 true。
     */
    function isBinaryDiff(diff) {
      return /^Binary files .* differ$/mu.test(diff) || /^GIT binary patch$/mu.test(diff)
    }

    /**
     * 按文件切分统一差异文本。
     *
     * 差异里最长的行可能是极长的单行文件（例如被压缩成一行的 JSON、或内嵌 data URI），
     * 直接整段渲染会让布局横向撑爆。因此这里不截断内容，但在渲染时用 `pre-wrap` +
     * 自动换行，让长行折行显示而不是撑开容器。
     * @param diff - 完整差异文本。
     * @returns 路径到该文件差异片段的映射。
     */
    function splitByFile(diff) {
      const map = new Map()
      // 以 `diff --git a/x b/y` 为界切分；首段（若有）不带前缀，忽略。
      const parts = diff.split(/^diff --git /mu).slice(1)
      for (const part of parts) {
        const head = part.split('\n', 1)[0]
        // 头部形如 `a/<old> b/<new>`，取 b/ 侧作为路径。
        const match = / b\/(.+)$/u.exec(head)
        const path = match === null ? undefined : match[1]
        if (path !== undefined) map.set(path, `diff --git ${part}`)
      }
      return map
    }

    /**
     * 渲染差异文本。
    /**
     * 差异视图的配色。
     *
     * **必须分浅色与深色两套**：此前只有一套为深色底设计的配色（浅绿/浅红的文字），
     * 一旦界面是浅色主题，浅色文字叠在浅色底上就完全糊成一片——这正是"变动记录看不清"
     * 的根因。深浅两套都保证文字与底色的对比度足够。
     * @param dark - 当前是否为深色主题。
     * @returns 各类行的配色。
     */
    function diffPalette(dark) {
      return dark
        ? {
            context: 'var(--dsw-alias-label-secondary)',
            // 增删行用"低饱和底色 + 高对比文字"，而不是把文字本身染成浅绿/浅红。
            addBg: 'rgba(63,185,110,.15)',
            addFg: '#a8e6c0',
            delBg: 'rgba(220,90,90,.15)',
            delFg: '#f0b9b9',
            hunk: '#8fb8ff',
            meta: 'var(--dsw-alias-label-tertiary)',
            gutter: 'rgba(255,255,255,.04)',
            gutterFg: 'var(--dsw-alias-label-tertiary)',
          }
        : {
            context: 'var(--dsw-alias-label-primary)',
            addBg: 'rgba(46,160,67,.14)',
            addFg: '#0b6b2a',
            delBg: 'rgba(207,60,60,.13)',
            delFg: '#a02525',
            hunk: '#2f5aa8',
            meta: 'var(--dsw-alias-label-tertiary)',
            gutter: 'rgba(0,0,0,.04)',
            gutterFg: 'var(--dsw-alias-label-tertiary)',
          }
    }

    /**
     * 判断当前是否为深色主题。
     *
     * 读页面根元素的实际计算值，而不是猜：应用的浅色/深色由官方主题服务写在 CSS 变量上，
     * 直接读背景色的亮度最可靠。
     * @returns 深色则 true。
     */
    function isDarkTheme() {
      try {
        const raw = getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-bg-base').trim()
        const match = /#([0-9a-f]{6})/iu.exec(raw)
        if (match !== null) {
          const value = Number.parseInt(match[1], 16)
          const r = (value >> 16) & 255
          const g = (value >> 8) & 255
          const b = value & 255
          return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5
        }
      } catch {
        // 读不到就按浅色处理：浅色下对比度不足比深色下更明显，宁可偏向它。
      }
      return false
    }

    /**
     * 把统一差异解析成带行号的行。
     *
     * 行号是"看清改动"的关键：只有增删标记而没有位置，很难判断改在文件的哪一处。
     * 解析 `@@ -a,b +c,d @@` 得到两侧的起始行号，然后逐行推进。
     * @param diff - 单个文件的统一差异文本。
     * @returns `{ kind, oldLine, newLine, text }` 数组；kind 为 meta/context/add/del。
     */
    function parseDiffRows(diff) {
      const rows = []
      let oldLine = 0
      let newLine = 0
      for (const raw of diff.split('\n')) {
        // 文件头与索引行：不作为代码行显示，避免与空行混淆。
        if (/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename )/u.test(raw)) {
          rows.push({ kind: 'meta', text: raw })
          continue
        }
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(raw)
        if (hunk !== null) {
          oldLine = Number(hunk[1])
          newLine = Number(hunk[2])
          rows.push({ kind: 'hunk', text: raw })
          continue
        }
        if (raw.startsWith('+')) {
          rows.push({ kind: 'add', newLine, text: raw.slice(1) })
          newLine += 1
          continue
        }
        if (raw.startsWith('-')) {
          rows.push({ kind: 'del', oldLine, text: raw.slice(1) })
          oldLine += 1
          continue
        }
        if (raw.startsWith('\\')) {
          // `\ No newline at end of file`：原样显示，不占行号。
          rows.push({ kind: 'meta', text: raw })
          continue
        }
        rows.push({ kind: 'context', oldLine, newLine, text: raw.startsWith(' ') ? raw.slice(1) : raw })
        oldLine += 1
        newLine += 1
      }
      return rows
    }

    /**
     * 渲染差异：行号 + 增删着色，参照 IDE/Codex 的差异视图。
     *
     * 设计取舍：
     *   * 行号固定宽度、右对齐，便于纵向扫读；
     *   * 增删只用底色区分，文字保持高对比——把文字染成浅绿/浅红在浅色主题下会糊掉；
     *   * 长行用 `pre-wrap` + `overflowWrap` 折行，不把容器撑宽。
     * @param diff - 单个文件的统一差异文本。
     * @returns React 元素数组。
     */
    function renderDiff(diff) {
      const palette = diffPalette(isDarkTheme())
      const rows = parseDiffRows(diff)
      return rows.map((row, index) => {
        const background =
          row.kind === 'add' ? palette.addBg : row.kind === 'del' ? palette.delBg : 'transparent'
        const fg =
          row.kind === 'add'
            ? palette.addFg
            : row.kind === 'del'
              ? palette.delFg
              : row.kind === 'hunk'
                ? palette.hunk
                : row.kind === 'meta'
                  ? palette.meta
                  : palette.context
        const marker = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '
        return react.createElement(
          'div',
          {
            key: index,
            // 差异行是"可读性"测试的取样对象（见 scripts/test-diff-readability.mjs）：
            // 它按 `children[0]` 是行号、`children[1]` 是增删标记来断言，所以下面的
            // 子元素顺序不能改。
            'data-review-diff-row': '',
            style: {
              display: 'flex',
              gap: '10px',
              background,
              color: fg,
              lineHeight: '1.55',
            },
          },
          // 行号栏：删除行只显示旧行号，新增行只显示新行号，上下文行两侧都有。
          react.createElement(
            'span',
            {
              style: {
                flex: '0 0 auto',
                display: 'flex',
                gap: '6px',
                padding: '0 6px',
                background: palette.gutter,
                color: palette.gutterFg,
                textAlign: 'right',
                userSelect: 'none',
              },
            },
            react.createElement('span', { style: { minWidth: '32px' } }, row.oldLine === undefined ? '' : String(row.oldLine)),
            react.createElement('span', { style: { minWidth: '32px' } }, row.newLine === undefined ? '' : String(row.newLine)),
          ),
          react.createElement(
            'span',
            { style: { flex: '0 0 auto', width: '8px', textAlign: 'center', opacity: 0.7 } },
            row.kind === 'hunk' || row.kind === 'meta' ? '' : marker,
          ),
          react.createElement(
            'span',
            { style: { flex: '1 1 auto', minWidth: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
            row.text === '' ? ' ' : row.text,
          ),
        )
      })
    }

    /**
     * 读取本轮改动数据的共用钩子。
     * @param workspace - 会话的工作区。
     * @param sessionId - 会话标识。
     * @returns `{ state, reload }`。
     */
    function useChanges(workspace, sessionId) {
      const [state, setState] = react.useState({ phase: 'loading' })

      const reload = react.useCallback(async () => {
        // **没有工作区时必须进入明确的错误态，不能直接 return。**
        //
        // 此前这里只是 `return`，`state` 就永远停在初值 `phase: 'loading'` —— 界面表现是
        // 永久"正在读取差异…"，而真实原因是"不知道该看哪个项目"（刚切换对话、工作区还没
        // 解析出来）。这与 `useWorkspaceChanges` 里已经修过的那处是同一个坑，只是漏改了这个。
        if (workspace === undefined || sessionId === undefined) {
          setState({ phase: 'error', message: 'noWorkspace' })
          return
        }
        try {
          const result = await call('changes', { workspace, sessionId })
          setState({ phase: 'ready', result })
        } catch (cause) {
          setState({ phase: 'error', message: String(cause.message ?? cause) })
        }
      }, [workspace, sessionId])

      react.useEffect(() => {
        void reload()
      }, [reload])

      return { state, reload }
    }

    /**
     * 由改动数据汇总出统计。
     * @param result - 路由响应。
     * @returns `{ files, added, removed }`。
     */
    function summarize(result) {
      const files = result?.files ?? []
      let added = 0
      let removed = 0
      for (const file of files) {
        added += file.added ?? 0
        removed += file.removed ?? 0
      }
      return { files, added, removed }
    }

    /**
     * 读取工作区级改动（相对 HEAD，不需要会话）。
     *
     * 项目页还没有任何一轮对话，因此"本轮改动"在那里无意义；这里读的是这个项目当前
     * 有哪些未提交改动。
     * @param workspace - 工作区路径。
     * @returns `{ state, reload }`。
     */
    function useWorkspaceChanges(workspace) {
      const [state, setState] = react.useState({ phase: 'loading' })

      const reload = react.useCallback(async () => {
        if (workspace === undefined) {
          // 没有工作区就明确说出来。此前这里直接返回，界面停在"正在读取差异…"，
          // 看起来像卡住，而实际原因是"不知道该看哪个项目"。
          setState({ phase: 'error', message: 'noWorkspace' })
          return
        }
        try {
          const result = await call('workspace', { workspace })
          setState({ phase: 'ready', result })
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error(String(cause))
          // 把失败原因带上：这类错误此前只让界面停在"加载中"，看不出是权限、路径还是
          // 网络问题（实际排查中就因此多绕了几圈）。
          setState({ phase: 'error', message: error.detail ?? error.message })
        }
      }, [workspace])

      react.useEffect(() => {
        void reload()
      }, [reload])

      return { state, reload }
    }

    /**
     * 读取工作区的提交历史（最近若干条）。
     *
     * 项目面板只显示"当前有什么改动"不够——用户还需要"最近发生过什么"。
     * @param workspace - 工作区路径。
     * @returns `{ state, reload }`。
     */
    function useHistory(workspace) {
      const [state, setState] = react.useState({ phase: 'loading' })

      const reload = react.useCallback(async () => {
        if (workspace === undefined) {
          setState({ phase: 'error', message: 'noWorkspace' })
          return
        }
        try {
          const result = await call('history', { workspace, limit: 20 })
          setState({ phase: 'ready', result })
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error(String(cause))
          setState({ phase: 'error', message: error.detail ?? error.message })
        }
      }, [workspace])

      react.useEffect(() => {
        void reload()
      }, [reload])

      return { state, reload }
    }

    /**
     * 提交历史列表：一次显示固定条数，不翻页。
     *
     * 刻意不做分页/无限滚动：面板的用途是"快速回顾最近发生了什么"，而不是替代 git 客户端。
     * 需要更早的历史时，用户会在终端里用 git log。
     * @param props - `{ t, result, phase, message, workspace }`。
     */
    function HistoryList(props) {
      const { t, result, phase, message } = props
      if (phase === 'loading') {
        return statusBlock(t('loading'))
      }
      if (phase === 'error') {
        // `noWorkspace` 是内部代号，翻成给用户看的话。
        return statusBlock(message === 'noWorkspace' ? t('noWorkspace') : message, 'error')
      }
      if (result?.isRepo === false) {
        return statusBlock(t('notRepo', { name: projectName(props.workspace) }))
      }
      const commits = result?.commits ?? []
      if (commits.length === 0) {
        return statusBlock(t('noHistory'))
      }
      // 提交行参照 IDEA 的 Log：左边一条竖线 + 节点圆点，右边是标题 + 哈希/作者/日期。
      // **每一行都可以点开**，展开后显示这次提交改了哪些文件、点文件看具体差异
      // （见 HistoryCommitRow / CommitChangesPanel）。
      return react.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column' } },
        commits.map((commit, index) =>
          react.createElement(HistoryCommitRow, {
            key: commit.hash,
            t,
            workspace: props.workspace,
            commit,
            index,
            last: index === commits.length - 1,
          }),
        ),
      )
    }

    /**
     * 「最近提交」里的一条提交：**点击展开**这次提交改了哪些文件。
     *
     * 与主区域的提交图共用 `CommitSummary` / `CommitFileList`，因此两处显示的
     * 信息与交互完全一致（包括"在 N 个分支中"和点文件才取差异）。
     *
     * @param props - `{ t, workspace, commit, index, last }`。
     * @returns React 元素。
     */
    function HistoryCommitRow(props) {
      const { t, workspace, commit, index, last } = props
      const [open, setOpen] = react.useState(false)

      return react.createElement(
        'div',
        { 'data-review-commit': commit.hash, style: { display: 'flex', flexDirection: 'column' } },
        react.createElement(
          'button',
          {
            type: 'button',
            className: 'dsh-review-history',
            'data-review-commit-toggle': commit.hash,
            'aria-expanded': open,
            // 保留完整哈希与作者：脚本与用户都靠 title 辨认（既有断言依赖它）。
            title: `${commit.hash}\n${commit.author} · ${commit.date}`,
            onClick: () => setOpen((value) => !value),
            style: {
              display: 'flex',
              gap: '10px',
              width: '100%',
              boxSizing: 'border-box',
              padding: '8px 2px',
              border: 'none',
              background: open ? `color-mix(in srgb, ${ACCENT} 6%, transparent)` : 'transparent',
              borderRadius: '6px',
              color: 'inherit',
              fontFamily: UI_FONT,
              fontSize: '12.5px',
              lineHeight: 1.5,
              textAlign: 'left',
              cursor: 'pointer',
            },
          },
          // 轴线与节点。最后一条不画下半段，避免悬空一截。
          react.createElement(
            'div',
            { style: { position: 'relative', flex: '0 0 auto', width: '10px' } },
            react.createElement('div', {
              style: {
                position: 'absolute',
                left: '4px',
                top: index === 0 ? '7px' : 0,
                bottom: last ? 'auto' : 0,
                height: last ? '1px' : 'auto',
                width: '1.5px',
                background: 'var(--dsw-alias-border-l2, #d8d8e0)',
              },
            }),
            react.createElement('div', {
              style: {
                position: 'absolute',
                left: 0,
                top: '2px',
                width: '9px',
                height: '9px',
                borderRadius: '50%',
                border: `2px solid ${ACCENT}`,
                background: 'var(--dsw-alias-bg-base, #fff)',
                boxSizing: 'border-box',
              },
            }),
          ),
          react.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0, flex: '1 1 auto' } },
            react.createElement(
              'span',
              { style: { color: 'var(--dsw-alias-label-primary)', minWidth: 0, overflowWrap: 'anywhere' } },
              commit.subject,
            ),
            react.createElement(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', fontSize: '11.5px', color: 'var(--dsw-alias-label-tertiary)' } },
              react.createElement(
                'span',
                {
                  style: {
                    padding: '0 5px',
                    borderRadius: '4px',
                    background: `color-mix(in srgb, ${ACCENT} 10%, transparent)`,
                    color: ACCENT,
                    fontFamily: CODE_FONT,
                    lineHeight: '16px',
                  },
                },
                commit.short,
              ),
              react.createElement('span', { style: { fontVariantNumeric: 'tabular-nums' } }, `${commit.author} · ${commit.date}`),
            ),
          ),
          // 展开指示：一个会转的小箭头，让"这一行可以点"这件事看得出来。
          react.createElement(
            'span',
            { style: { flexShrink: 0, alignSelf: 'flex-start', color: 'var(--dsw-alias-label-tertiary)', display: 'flex' } },
            react.createElement(
              'svg',
              { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': 'true', style: { transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .12s ease' } },
              react.createElement('path', { d: 'M6 4l4 4-4 4', strokeLinecap: 'round', strokeLinejoin: 'round' }),
            ),
          ),
        ),
        open
          ? react.createElement(CommitChangesPanel, { t, workspace, revision: commit.hash })
          : null,
      )
    }

    /**
     * 一次提交的改动面板：元信息 + 文件列表（点文件展开它的差异）。
     *
     * 抽屉里的"最近提交"用它；主区域的提交图用同一对 `CommitSummary` / `CommitFileList`，
     * 因此两处的行为不会漂移。
     *
     * @param props - `{ t, workspace, revision }`。
     * @returns React 元素。
     */
    function CommitChangesPanel(props) {
      const { t, workspace, revision } = props
      const [state, setState] = react.useState({ phase: 'loading' })

      react.useEffect(() => {
        let alive = true
        setState({ phase: 'loading' })
        void (async () => {
          try {
            const result = await call('commit-detail', { workspace, revision })
            if (alive) setState({ phase: 'ready', result })
          } catch (cause) {
            const error = cause instanceof Error ? cause : new Error(String(cause))
            if (alive) setState({ phase: 'error', message: error.detail ?? error.message })
          }
        })()
        return () => {
          alive = false
        }
      }, [workspace, revision])

      const commit = state.result?.commit
      const files = state.result?.files ?? []
      // 外壳始终渲染：`data-review-commit-changes` 是"这条提交被展开了"的锚点，
      // 加载中/出错时也必须带着它，否则脚本与用户都只能靠"文件行出现了没有"来猜。
      return react.createElement(
        'div',
        {
          'data-review-commit-changes': revision,
          style: {
            margin: '0 0 6px 20px',
            padding: '8px 10px',
            borderRadius: '6px',
            border: `1px solid ${BORDER}`,
            background: 'var(--dsw-alias-bg-module-platform, #f7f8fa)',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
          },
        },
        state.phase === 'loading'
          ? statusBlock(t('loading'))
          : state.phase === 'error'
            ? statusBlock(state.message, 'error')
            : [
                react.createElement(CommitSummary, {
                  key: 'summary',
                  t,
                  commit,
                  containingBranches: state.result?.containingBranches ?? [],
                }),
                react.createElement(
                  'div',
                  { key: 'title', style: { display: 'flex', alignItems: 'center', gap: '6px' } },
                  react.createElement('span', { style: { fontSize: '11px', fontWeight: 600, color: 'var(--dsw-alias-label-tertiary)', textTransform: 'uppercase' } }, t('changesTitle')),
                  react.createElement('span', { 'data-review-commit-file-count': '', style: { fontSize: '11.5px', color: 'var(--dsw-alias-label-tertiary)' } }, t('graphFiles', { count: files.length })),
                ),
                react.createElement(CommitFileList, { key: 'files', t, files, workspace, revision }),
              ],
      )
    }

    /**
     * 常驻的右侧面板。
     *
     * 自绘而不是用官方右侧栏：官方那套内容槽带 `scope: "session"`，在项目页（没有会话）
     * 时不渲染，且 `sidebarRightTabs` 没有任何被采纳的会话——实测 `openTabIn` 会静默
     * 返回而不报错。因此项目级面板只能自己管理。
     *
     * 位置用 fixed 相对视口，避免被祖先裁剪（此前自制浮层就因此在小窗口里只露出顶部）。
     *
     * 面板**不提供工作区选择器**，也不显示工作区路径：工作区由当前对话决定（见
     * `useCurrentWorkspace`），跟随对话自动切换；把它做成可编辑并列出绝对路径，既
     * 与"这个面板属于当前对话"的语义冲突，也把用户的目录结构暴露在界面上。
     * @param props - `{ t, workspace, sessionId, scope, anchor }`。
     */
    function ReviewPanel(props) {
      const { t, workspace, sessionId, scope, anchor } = props
      const open = usePanelOpen()
      const rootRef = react.useRef(null)

      /** 抽屉宽度（像素）。初值直接读持久化值，因此重新打开不会先闪一下默认宽度。 */
      const [width, setWidth] = react.useState(() => clampPanelWidth(panelWidthStore.get()))
      /** 拖动中的宽度：拖动过程中每帧都 setState 会连带重渲染整个文件列表，先记在 ref 里。 */
      const dragWidthRef = react.useRef(width)

      /**
       * 视口变窄时把宽度收进允许区间。
       *
       * 不做这一步的话，窗口缩小后抽屉会占满整个视口（甚至超过），而用户没法把窗口
       * 缩回去——那时手柄已经贴着屏幕左边缘了。
       */
      react.useEffect(() => {
        if (!open) return undefined
        const onResize = () => {
          const clamped = clampPanelWidth(dragWidthRef.current)
          dragWidthRef.current = clamped
          setWidth(clamped)
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [open])

      /**
       * 拖动左边缘调整宽度。
       *
       * 用 `mousemove`/`mouseup` 挂在 document 上而不是手柄自身：指针一旦移出手柄，
       * 元素上的监听就收不到事件了，表现为"拖到一半断掉"。
       *
       * 拖动期间给 `body` 打标记：禁掉文本选择与指针光标（否则鼠标划过正文会变成
       * 文本光标，还会顺手选中文字）。
       */
      const startResize = react.useCallback((event) => {
        if (event.button !== undefined && event.button !== 0) return
        event.preventDefault()
        const startX = event.clientX
        const startWidth = dragWidthRef.current
        document.body.dataset.reviewDragging = '1'
        const onMove = (moveEvent) => {
          // 抽屉贴右边：向左拖是变宽。
          const next = clampPanelWidth(startWidth + (startX - moveEvent.clientX))
          dragWidthRef.current = next
          setWidth(next)
        }
        const onUp = () => {
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseup', onUp)
          delete document.body.dataset.reviewDragging
          panelWidthStore.set(dragWidthRef.current)
        }
        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
      }, [])

      /** 键盘调整：方向键左右各一步，Home 复位（手柄是可聚焦的 separator）。 */
      const onResizeKeyDown = react.useCallback((event) => {
        const step = event.key === 'ArrowLeft' ? PANEL_WIDTH_STEP : event.key === 'ArrowRight' ? -PANEL_WIDTH_STEP : 0
        if (step !== 0) {
          event.preventDefault()
          const next = clampPanelWidth(dragWidthRef.current + step)
          dragWidthRef.current = next
          setWidth(next)
          panelWidthStore.set(next)
          return
        }
        if (event.key === 'Home') {
          event.preventDefault()
          dragWidthRef.current = panelWidthDefault()
          setWidth(panelWidthDefault())
          panelWidthStore.reset()
        }
      }, [])

      /**
       * 点击外部或按 Escape 关闭抽屉。
       *
       * 与分支菜单同一套做法：用 `mousedown`（而不是 click）在**捕获阶段**判定，
       * 这样拖选文本之类的操作不会误判；关闭条件写进 `open` 的依赖里，关闭后立刻摘掉
       * 监听，不给文档留常驻监听。
       *
       * 触发按钮本身不算"外部"：它有自己的开关逻辑，若把它的点击也当成外部点击，
       * 会出现"点一下先关再开"的一闪。
       */
      react.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          const node = rootRef.current
          if (node !== null && node.contains(event.target)) return
          const trigger = document.querySelector('[data-review-trigger="1"]')
          if (trigger !== null && trigger.contains(event.target)) return
          panelStore.set(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') panelStore.set(false)
        }
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      // 两种语义分别取数据：本轮改动需要会话，工作区改动不需要。
      const turn = useChanges(scope === 'workspace' ? undefined : workspace, sessionId)
      const workspaceChanges = useWorkspaceChanges(scope === 'workspace' ? workspace : undefined)
      // 历史只在项目级取：会话内的标签与提交历史无关，没必要多打一次 git。
      const history = useHistory(scope === 'workspace' ? workspace : undefined)
      const active = scope === 'workspace' ? workspaceChanges.state : turn.state

      if (!open) return null

      const { files, added, removed } = summarize(active.result)
      const title = scope === 'workspace' ? t('projectTitle') : t('title')
      const reload = scope === 'workspace' ? workspaceChanges.reload : turn.reload
      // 当前分支：从**已有的**历史响应里取，不额外打一次 git。
      const historyResult = history.state.result
      const branch = typeof historyResult?.branch === 'string' ? historyResult.branch.trim() : ''

      return react.createElement(
        'aside',
        {
          ref: rootRef,
          'data-desktop-review-surface': 'panel',
          'aria-label': title,
          style: {
            // 右侧全高抽屉，而不是浮在入口下方的小面板。
            //
            // 这样与 IDE 的提交面板一致：内容区更高（提交记录能一屏看更多），且因为
            // 贴着窗口右边、占满高度，不会与窗口控件或页面头部图标抢位置——浮动面板
            // 会挡住它们（实际反馈）。
            position: 'fixed',
            top: 0,
            right: 0,
            bottom: 0,
            height: '100vh',
            zIndex: 9998,
            // 宽度可拖动（见下面的 resizer）；上限随视口收窄，避免把主界面挤没。
            width: `${width}px`,
            maxWidth: 'calc(100vw - 64px)',
            display: 'flex',
            flexDirection: 'column',
            borderLeft: '1px solid var(--dsw-alias-border-l2, #d3d3dc)',
            background: 'var(--dsw-alias-bg-base, #fff)',
            color: 'var(--dsw-alias-label-primary)',
            fontFamily: UI_FONT,
            boxShadow: '-12px 0 36px rgba(0,0,0,.10)',
            overflow: 'hidden',
          },
        },
        // 左边缘的宽度手柄。用 button 而不是 div：它能被 Tab 聚焦，从而用方向键调整
        // （`role="separator"` 表达"这是两个区域之间的可调分隔"）。
        react.createElement('button', {
          type: 'button',
          'data-review-resizer': '',
          role: 'separator',
          'aria-orientation': 'vertical',
          'aria-label': t('resize'),
          title: t('resize'),
          onMouseDown: startResize,
          onDoubleClick: () => {
            dragWidthRef.current = panelWidthDefault()
            setWidth(panelWidthDefault())
            panelWidthStore.reset()
          },
          onKeyDown: onResizeKeyDown,
        }),
        react.createElement(
          'div',
          { 'data-review-header': '' },
          // 标题与分支徽标：抽屉里第一个要回答的问题是"我在哪个分支上提交"。
          react.createElement(
            'div',
            { 'data-review-title': '' },
            react.createElement('strong', { style: { fontWeight: 600 } }, title),
            branch === ''
              ? null
              : react.createElement(
                  'span',
                  { 'data-review-branch': branch, title: branch },
                  react.createElement(
                    'svg',
                    { width: 11, height: 11, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
                    react.createElement('path', {
                      d: 'M5 3.5a1.6 1.6 0 1 0 0 .01M5 12.5a1.6 1.6 0 1 0 0 .01M11 6.5a1.6 1.6 0 1 0 0 .01M5 5.1v5.8M6.6 4.2h2.9a1.5 1.5 0 0 1 1.5 1.5v.8',
                      stroke: 'currentColor',
                      strokeWidth: 1.3,
                      strokeLinecap: 'round',
                    }),
                  ),
                  branch,
                ),
          ),
          react.createElement('span', { 'data-review-count': '' }, String(files.length)),
          react.createElement('span', { style: { flex: 1 } }),
          // 刷新：IDEA 的工具窗左上角也有这个动作；这里放在右侧，靠近"关闭"。
          react.createElement(
            'button',
            {
              type: 'button',
              'data-review-icon-button': '',
              onClick: () => reload(),
              title: t('refresh'),
              'aria-label': t('refresh'),
            },
            react.createElement(
              'svg',
              { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
              react.createElement('path', {
                d: 'M13 8a5 5 0 1 1-1.6-3.7M13 2.5V5.5H10',
                stroke: 'currentColor',
                strokeWidth: 1.5,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
              }),
            ),
          ),
          react.createElement(
            'button',
            {
              type: 'button',
              'data-review-icon-button': '',
              onClick: () => panelStore.set(false),
              title: t('collapse'),
              'aria-label': t('collapse'),
            },
            react.createElement(
              'svg',
              { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
              react.createElement('path', {
                d: 'M4 4l8 8M12 4l-8 8',
                stroke: 'currentColor',
                strokeWidth: 1.5,
                strokeLinecap: 'round',
              }),
            ),
          ),
        ),
        // 工作区选择器已移除：工作区跟随当前对话，不可编辑、也不展示路径。
        react.createElement(
          'div',
          { style: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '12px 14px 20px 18px' } },
          // 暂存与提交只在**项目级**面板出现。
          //
          // 会话内那个标签讲的是"本轮改了什么"（基线与本轮开始时的快照比较），而暂存与
          // 提交是**仓库**级动作：它动的是索引与历史，与"本轮"没有关系。把提交框放进
          // 会话标签里会让人以为提交只针对本轮，那是错的。
          scope === 'workspace'
            ? react.createElement(StagingSection, {
                t,
                workspace,
                // 提交之后两边都要重取：暂存区变了（状态区块自己会重读），而改动差异与
                // 提交历史也随之变化（由外层 reload 负责）。
                onCommitted: () => {
                  reload()
                  history.reload()
                },
              })
            : null,
          scope === 'workspace'
            ? react.createElement('div', { 'data-review-section-title': '' }, t('changesTitle'))
            : null,
          react.createElement(FileList, {
            t,
            result: active.result,
            phase: active.phase,
            message: active.message,
            workspace,
            sessionId,
            onChanged: reload,
          }),
          // 提交历史只在项目级面板出现：会话内的标签讲的是"本轮"，与历史无关。
          scope === 'workspace'
            ? react.createElement(
                'div',
                { style: { marginTop: '18px' } },
                react.createElement(
                  'div',
                  { 'data-review-section-title': '' },
                  t('historyTitle'),
                  react.createElement(
                    'span',
                    { 'data-review-count': '' },
                    String(history.state.result?.commits?.length ?? 0),
                  ),
                ),
                react.createElement(HistoryList, {
                  t,
                  result: history.state.result,
                  phase: history.state.phase,
                  message: history.state.message,
                  workspace,
                }),
              )
            : null,
        ),
      )
    }

    /**
     * 判断一个值像不像工作区路径。
     * @param value - 候选值。
     * @returns 是字符串且非空则返回它。
     */
    function asPath(value) {
      return typeof value === 'string' && value !== '' ? value : undefined
    }

    /**
     * 取路径的最后一段作为项目名。
     *
     * 只用于**诊断文案**（"当前工作区（X）不是 git 仓库"）：面板刻意不显示工作区路径，
     * 但"不是 git 仓库"这种死胡同提示如果不说是哪个目录，用户只会得出"功能坏了"的结论
     * ——实际反馈中正是如此（他的项目是 git 仓库，面板看的却是另一个目录）。
     * @param path - 工作区路径。
     * @returns 最后一段路径；取不到时返回空串。
     */
    function projectName(path) {
      if (typeof path !== 'string' || path === '') return ''
      const parts = path.split(/[\\/]/u).filter((part) => part !== '')
      return parts.length === 0 ? path : (parts[parts.length - 1] ?? path)
    }

    /**
     * 把仓库内相对路径拆成"目录"与"文件名"。
     *
     * 为了分层次显示（目录压暗、文件名留亮，与 IDEA 的改动列表一致）。反斜杠也当分隔符：
     * git 总是用 `/`，但用户看到的路径可能来自别处。
     * @param path - 相对路径。
     * @returns `{ dir, base }`；没有目录时 `dir` 为空串。
     */
    function splitPath(path) {
      const value = typeof path === 'string' ? path : ''
      const cut = value.lastIndexOf('/') >= 0 ? value.lastIndexOf('/') : value.lastIndexOf('\\')
      if (cut < 0) return { dir: '', base: value }
      return { dir: value.slice(0, cut), base: value.slice(cut + 1) }
    }

    /**
     * 读取**当前会话**的工作区。
     *
     * 这是项目级面板唯一正确的取值来源。面板挂在全局覆盖层上，拿不到会话作用域的
     * `sessionId`，但 `sessions` 服务本身是 `inject` 进来的：`state.current` 就是用户
     * 此刻打开的那个会话（**新建对话在创建时也会被选中**），而 `byId[current].cwd`
     * 正是它所属的项目。
     *
     * 此前这里用的是"最近一个会话的 cwd"（倒序扫 `state.ids`），于是：
     *   * 切回一个更早的、属于别的项目的对话时，面板仍停在上一个新会话的项目上；
     *   * 新建对话时面板不会跟着走。
     * 两者都会表现为"右上角这块没有切到当前项目的空间"（实际反馈）。改成读
     * `state.current` 后，切换对话与新建对话都会自动跟随。
     *
     * @param props - 槽注入的属性。
     * @returns 工作区路径；没有当前会话或该会话还没有 cwd 时 undefined。
     */
    function useCurrentWorkspace(props) {
      // 会话存储：`inject` 里声明了 sessions，钩子会随之注入。
      return typeof props?.useSessions === 'function'
        ? props.useSessions((state) => {
            const current = state?.current
            if (current === undefined) return undefined
            return asPath(state?.byId?.[current]?.cwd)
          })
        : undefined
    }

    /**
     * 读取**全部**已登记的工作区。
     *
     * 只作为兜底：还没有任何当前会话（全新状态）时，面板得有个地方拿一个可用路径，
     * 否则只能空着。**不用于让用户挑选**——工作区由当前会话决定，面板不再提供选择器。
     * @param props - 槽注入的属性。
     * @returns 工作区路径数组。
     */
    function useWorkspaceList(props) {
      return typeof props?.useWorkspaces === 'function'
        ? props.useWorkspaces((state) => {
            const items = state?.items
            if (!Array.isArray(items)) return []
            return items.map((item) => asPath(item?.path ?? item?.root)).filter((value) => value !== undefined)
          })
        : []
    }

    /**
     * 测量入口按钮的位置，供面板贴着它显示。
     *
     * 面板用 `fixed` 定位是为了跳出祖先裁剪（此前被输入框容器裁成一条），但 `fixed`
     * 不跟随入口——偏移写成常量就会钉在角落。因此打开时测量一次，并在窗口尺寸变化或
     * 滚动时重测。
     * @param open - 面板是否展开。
     * @returns `{ ref, anchor }`，`anchor` 为 `{ bottom, rightInset }`（视口坐标）。
     */
    function useAnchor(open) {
      const ref = react.useRef(null)
      const [anchor, setAnchor] = react.useState(undefined)

      react.useEffect(() => {
        if (!open) {
          setAnchor(undefined)
          return undefined
        }
        const measure = () => {
          const node = ref.current
          if (node === null) return
          const rect = node.getBoundingClientRect()
          setAnchor({
            // 面板放在按钮下方。
            bottom: rect.bottom,
            // 用"距右边缘的距离"而不是 left：面板是右对齐的，这样窗口变窄时也不会溢出。
            rightInset: Math.max(8, window.innerWidth - rect.right),
          })
        }
        measure()
        window.addEventListener('resize', measure)
        window.addEventListener('scroll', measure, true)
        return () => {
          window.removeEventListener('resize', measure)
          window.removeEventListener('scroll', measure, true)
        }
      }, [open])

      return { ref, anchor }
    }

    /**
     * 项目页（尚未进入会话）的常驻面板入口。
     * @param props - 槽注入的属性。
     */
    function HeroChangesTrigger(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      const open = usePanelOpen()
      const { ref, anchor } = useAnchor(open)

      // 宿主侧的 `/roots`：给出**允许访问**的工作区名单，以及外壳启动时的工作区
      // （`process.cwd()`）。名单用于兜底与合法性判断，外壳工作区则只在"还没有当前
      // 会话"时使用——真正决定面板看哪个项目的是当前会话（见下面的 `useCurrentWorkspace`）。
      const [roots, setRoots] = react.useState([])
      const [hostCurrent, setHostCurrent] = react.useState(undefined)
      react.useEffect(() => {
        let alive = true
        void (async () => {
          try {
            const result = await call('roots', {})
            if (!alive) return
            setRoots(Array.isArray(result?.roots) ? result.roots : [])
            setHostCurrent(asPath(result?.current))
          } catch {
            if (!alive) return
            setRoots([])
            setHostCurrent(undefined)
          }
        })()
        return () => {
          alive = false
        }
      }, [])

      const fromHooks = useWorkspaceList(props)
      const candidates = roots.length > 0 ? roots : fromHooks
      // **当前会话的工作区**排在第一位：切换对话或新建对话后，面板必须立刻跟到那个
      // 对话所属的项目上。后面几项只在"还没有当前会话"（全新状态）时兜底。
      const session = useCurrentWorkspace(props)

      // 诊断快照：这块面板的状态分布在"当前会话 / 宿主的当前值 / 宿主给的名单 /
      // 注入的钩子"四处，出问题时从界面上只能看到"对不上项目"，无法判断是哪一环出错。
      // 挂到 window 上后，脚本可以一眼看清每一环的实际值。
      if (typeof window !== 'undefined') {
        window.__dshDesktopReviewPanel = { roots, hostCurrent, fromHooks, session }
      }

      // 优先级：当前会话的 cwd > 宿主给的当前工作区 > 候选第一项。
      //
      // 为什么当前会话优先：工作区是**会话的属性**，不是外壳的属性。用户在界面里可以
      // 让每个对话属于不同项目，而外壳启动时的 `--workspace` 只是其中一个，所以
      // `process.cwd()` 只能在没有当前会话时用（例如刚打开、还没进对话）。
      //
      // 不再保留任何"用户手动选定"的状态：工作区不可编辑，面板始终跟随当前对话。
      const workspace = session ?? hostCurrent ?? candidates[0]
      const [count, setCount] = react.useState(null)

      react.useEffect(() => {
        if (workspace === undefined) return undefined
        let alive = true
        const tick = async () => {
          try {
            const result = await call('workspace', { workspace })
            if (alive) setCount(result?.isRepo === false ? null : (result?.files?.length ?? 0))
          } catch {
            if (alive) setCount(null)
          }
        }
        void tick()
        const timer = setInterval(() => void tick(), POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [workspace])

      // 拿不到工作区时**也要渲染按钮**：面板会说明当前没有可用的工作区。
      // 此前这里直接 return null，结果在"还没有任何会话与登记工作区"的状态下入口彻底
      // 消失，用户看到的是"这个功能不存在"。
      const hasChanges = typeof count === 'number' && count > 0

      return react.createElement(
        'div',
        {
          ref,
          // 标记这个按钮是"审查抽屉的入口"，供抽屉的外部点击判定排除它——
          // 否则点按钮会先被当成外部点击关闭、再被按钮自己的开关打开，出现一闪。
          'data-review-trigger': '1',
          // 自绘的固定定位：覆盖层槽位不提供布局，位置由我们自己定。
          //
          // 纵向位置在窗口顶边下方约 44px：顶边那一带是窗口的最小化/最大化/关闭按钮
          // （Windows 的 caption 区域），紧贴顶边会挡住它们，也会压住对话页头部的
          // 功能图标（实际反馈）。
          style: {
            position: 'fixed',
            top: '44px',
            right: '14px',
            zIndex: 9997,
            display: 'inline-flex',
          },
        },
        react.createElement(
          'button',
          {
            type: 'button',
            title: t('projectTitle'),
            'aria-expanded': open,
            onClick: () => panelStore.set(!open),
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '7px',
              padding: '0 11px',
              height: '30px',
              borderRadius: '8px',
              border: '1px solid var(--dsw-alias-border-l1, #eceef2)',
              background: 'var(--dsh-review-chip-bg, var(--dsw-alias-bg-base, #fff))',
              color: hasChanges || open ? ACCENT : 'var(--dsw-alias-label-secondary)',
              fontSize: '12px',
              fontFamily: UI_FONT,
              fontWeight: 500,
              whiteSpace: 'nowrap',
              cursor: 'pointer',
            },
          },
          react.createElement(
            'svg',
            { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
            react.createElement('path', {
              d: 'M3 4.5h10M3 8h10M3 11.5h6',
              stroke: 'currentColor',
              strokeWidth: 1.3,
              strokeLinecap: 'round',
            }),
          ),
          react.createElement(
            'span',
            null,
            workspace === undefined ? t('projectTitle') : count === null ? t('projectIdle') : t('files', { count }),
          ),
        ),
        react.createElement(ReviewPanel, {
          t,
          workspace,
          scope: 'workspace',
          anchor,
        }),
      )
    }

    /**
     * 还原确认弹窗。
     *
     * 用弹窗而不是"再点一次按钮"的二次确认：后者有两个问题——按钮本身很小、第二次点击
     * 容易落空（用户会感觉"点了没反应"）；而且按钮的 `onBlur` 会在点到别处时把确认态
     * 清掉，操作显得不可靠。弹窗把"要还原哪个文件"讲清楚，再让用户明确决定。
     * @param props - `{ t, path, onCancel, onConfirm, busy }`。
     */
    function ConfirmRevertDialog(props) {
      const { t, path, onCancel, onConfirm, busy } = props
      // Esc 取消：与其它面板一致，也让键盘用户能退出。
      react.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') onCancel()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [onCancel])

      return react.createElement(
        'div',
        {
          // 遮罩：点击遮罩即取消。放在抽屉之上。
          onClick: onCancel,
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 10000,
            background: 'rgba(0,0,0,.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          },
        },
        react.createElement(
          'div',
          {
            // 阻止冒泡：点弹窗内部不该被遮罩的 onClick 当成"取消"。
            onClick: (event) => event.stopPropagation(),
            role: 'dialog',
            'aria-modal': 'true',
            style: {
              width: 'min(420px, calc(100vw - 48px))',
              borderRadius: '10px',
              border: '1px solid var(--dsw-alias-border-l2, #3d3d45)',
              background: 'var(--dsw-alias-bg-overlay, #1f1f24)',
              color: 'var(--dsw-alias-label-primary)',
              boxShadow: '0 16px 48px rgba(0,0,0,.45)',
              padding: '16px 18px',
              fontSize: '13px',
              lineHeight: '1.6',
            },
          },
          react.createElement('div', { style: { fontWeight: 600, marginBottom: '8px' } }, t('revertConfirmTitle')),
          react.createElement(
            'div',
            { style: { color: 'var(--dsw-alias-label-secondary)', marginBottom: '6px' } },
            t('revertConfirmBody'),
          ),
          react.createElement(
            'div',
            {
              style: {
                fontSize: '12px',
                fontFamily: CODE_FONT,
                padding: '6px 8px',
                borderRadius: '6px',
                background: 'var(--dsw-alias-bg-layer-2, #26262c)',
                wordBreak: 'break-all',
                marginBottom: '14px',
              },
            },
            path,
          ),
          react.createElement(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } },
            react.createElement(
              'button',
              {
                type: 'button',
                onClick: onCancel,
                disabled: busy,
                style: {
                  padding: '5px 14px',
                  borderRadius: '6px',
                  border: '1px solid var(--dsw-alias-border-l2, #3d3d45)',
                  background: 'var(--dsw-alias-bg-layer-2, #26262c)',
                  color: 'var(--dsw-alias-label-primary)',
                  font: 'inherit',
                  cursor: busy ? 'default' : 'pointer',
                },
              },
              t('revertCancel'),
            ),
            react.createElement(
              'button',
              {
                type: 'button',
                onClick: onConfirm,
                disabled: busy,
                style: {
                  padding: '5px 14px',
                  borderRadius: '6px',
                  border: '1px solid #8b5a5a',
                  background: '#6b3b3b',
                  color: '#ffdede',
                  font: 'inherit',
                  cursor: busy ? 'default' : 'pointer',
                },
              },
              busy ? t('reverting') : t('revert'),
            ),
          ),
        ),
      )
    }

    /**
     * 空态 / 状态提示块。
     *
     * 面板里"加载中""没有改动""不是仓库"这些状态此前都是一行小字，视觉上像渲染坏了。
     * 统一成一个居中的块：图标位（一个中性圆点）+ 文案，分量与"确实没有内容"相符。
     * @param text - 已本地化的文案。
     * @param tone - `normal` 或 `error`。
     * @returns React 元素。
     */
    function statusBlock(text, tone = 'normal') {
      const error = tone === 'error'
      return react.createElement(
        'div',
        {
          role: 'status',
          style: {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '8px',
            padding: '28px 16px',
            textAlign: 'center',
            color: error ? REMOVED : 'var(--dsw-alias-label-tertiary)',
            fontSize: '12px',
            lineHeight: 1.6,
            fontFamily: UI_FONT,
          },
        },
        react.createElement(
          'svg',
          { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', style: { opacity: 0.55 } },
          react.createElement('circle', { cx: 12, cy: 12, r: 9, stroke: 'currentColor', strokeWidth: 1.4 }),
          error
            ? react.createElement('path', { d: 'M12 7.5v5.5M12 16.2v.3', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' })
            : react.createElement('path', { d: 'M8.5 12.2l2.4 2.4 4.6-5', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        ),
        react.createElement('span', { style: { maxWidth: '34em', overflowWrap: 'anywhere' } }, text),
      )
    }

    /**
     * 一个文件的变更记录（IDEA 的"显示历史"）。
     *
     * 用 `git log --follow` 取：重命名之后仍然能追到改名前的提交，否则历史会在改名那一处
     * 断掉——而那正是用户最想看的"这个文件原来是什么"。未跟踪的文件没有历史，返回空列表
     * 并显示"还没有提交记录"，不是错误。
     *
     * @param props - `{ t, workspace, path, onClose }`。
     * @returns React 元素。
     */
    function FileHistory(props) {
      const { t, workspace, path } = props
      const [state, setState] = react.useState({ phase: 'loading' })

      react.useEffect(() => {
        if (typeof path !== 'string' || path === '' || typeof workspace !== 'string' || workspace === '') return undefined
        let alive = true
        setState({ phase: 'loading' })
        void (async () => {
          try {
            const result = await call('file-history', { workspace, path, limit: 20 })
            if (alive) setState({ phase: 'ready', commits: result?.commits ?? [] })
          } catch (cause) {
            const error = cause instanceof Error ? cause : new Error(String(cause))
            if (alive) setState({ phase: 'error', message: error.detail ?? error.message })
          }
        })()
        return () => {
          alive = false
        }
      }, [workspace, path])

      if (state.phase === 'loading') {
        return react.createElement(
          'div',
          { 'data-staging-history-panel': path, style: { padding: '5px 8px 5px 44px', fontSize: '11.5px', color: 'var(--dsw-alias-label-tertiary)', fontFamily: UI_FONT } },
          t('loading'),
        )
      }
      if (state.phase === 'error') {
        return react.createElement(
          'div',
          { 'data-staging-history-panel': path, style: { padding: '5px 8px 5px 44px', fontSize: '11.5px', color: REMOVED, fontFamily: UI_FONT } },
          state.message,
        )
      }
      const commits = state.commits ?? []
      return react.createElement(
        'div',
        {
          'data-staging-history-panel': path,
          style: {
            margin: '2px 6px 8px 44px',
            padding: '6px 8px',
            borderRadius: '6px',
            border: `1px solid ${BORDER}`,
            background: 'var(--dsw-alias-bg-module-platform, #f7f8fa)',
            fontFamily: UI_FONT,
          },
        },
        react.createElement(
          'div',
          { style: { fontSize: '11px', fontWeight: 600, color: 'var(--dsw-alias-label-tertiary)', marginBottom: '4px' } },
          t('fileHistoryTitle'),
        ),
        commits.length === 0
          ? react.createElement('div', { style: { fontSize: '11.5px', color: 'var(--dsw-alias-label-tertiary)' } }, t('fileHistoryEmpty'))
          : commits.map((commit) =>
              react.createElement(
                'div',
                {
                  key: commit.hash,
                  'data-staging-history-row': commit.hash,
                  title: `${commit.hash}\n${commit.author} · ${commit.date}`,
                  style: { display: 'flex', gap: '8px', alignItems: 'baseline', padding: '2px 0', fontSize: '11.5px', lineHeight: 1.5 },
                },
                // 短哈希用等宽 + 色块，扫读时能与提交标题分开。
                react.createElement(
                  'span',
                  { style: { flexShrink: 0, padding: '0 4px', borderRadius: '4px', background: `color-mix(in srgb, ${ACCENT} 10%, transparent)`, color: ACCENT, fontFamily: CODE_FONT } },
                  commit.short,
                ),
                react.createElement('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, commit.subject),
                react.createElement('span', { style: { flexShrink: 0, color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums' } }, commit.date),
              ),
            ),
        commits.length >= 20
          ? react.createElement('div', { style: { marginTop: '3px', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' } }, t('fileHistoryMore', { count: 20 }))
          : null,
      )
    }

    /**
     * 一条文件行在界面上属于哪一组。
     *
     * `git status --porcelain` 的 XY 两列是**两个独立的维度**（实测确认）：
     *   `X` = 索引相对 HEAD 的状态，`Y` = 工作区相对索引的状态，`??` 是未跟踪。
     *   例：` M tracked.txt` 只有未暂存的修改；`A  new.txt` 只有已暂存的改动；
     *   `MM both.txt` **两边都有**——同一个文件会同时出现在「已暂存」与「更改」两组里。
     *   `M ` 反过来是"暂存了修改、工作区与索引一致"。
     *
     * 这个判定必须用 porcelain 的状态列，**不能从差异内容反推**：`/workspace` 那条路由
     * 给的是"HEAD vs 工作区"的内容差异，它根本不含索引态，`MM` 与 ` M` 在它眼里都是
     * 一个被修改的文件——用它来分组会把"已暂存"和"未暂存"混在一起。
     *
     * @param entry - `{ index, worktree }`。
     * @returns `{ staged, unstaged }`。
     */
    function classifyEntry(entry) {
      const index = typeof entry?.index === 'string' ? entry.index : ' '
      const worktree = typeof entry?.worktree === 'string' ? entry.worktree : ' '
      const untracked = index === '?' || worktree === '?'
      return {
        staged: !untracked && index !== ' ',
        unstaged: !untracked && worktree !== ' ',
      }
    }

    /** 状态字母对应的界面文案键与颜色（porcelain 的 X/Y 单字符）。 */
    const PORCELAIN_STATUS = {
      M: { key: 'statusModified', color: STATUS_COLORS.M },
      A: { key: 'statusAdded', color: STATUS_COLORS.A },
      D: { key: 'statusDeleted', color: STATUS_COLORS.D },
      R: { key: 'statusRenamed', color: STATUS_COLORS.R },
      C: { key: 'statusAdded', color: STATUS_COLORS.A },
      '?': { key: 'statusAdded', color: STATUS_COLORS.A },
      U: { key: 'statusModified', color: STATUS_COLORS.M },
    }

    /**
     * 一个状态徽标。
     * @param props - `{ letter }`。
     * @returns React 元素。
     */
    function StatusBadge(props) {
      const letter = typeof props?.letter === 'string' && props.letter !== '' ? props.letter : '?'
      const meta = PORCELAIN_STATUS[letter] ?? { key: 'statusOther', color: 'var(--dsw-alias-label-secondary)' }
      return react.createElement(
        'span',
        {
          'data-staging-status': letter,
          title: meta.key,
          style: {
            flexShrink: 0,
            width: '14px',
            textAlign: 'center',
            padding: '0 3px',
            borderRadius: '4px',
            fontSize: '11px',
            lineHeight: '16px',
            color: meta.color,
            background: `color-mix(in srgb, ${meta.color} 14%, transparent)`,
          },
        },
        letter,
      )
    }

    /**
     * 一个分组标题（可折叠 + 右侧批量按钮）。
     *
     * @param props - `{ t, id, label, count, collapsed, onToggle, action }`。
     * @returns React 元素。
     */
    function StagingGroupHeader(props) {
      const { label, count, collapsed, onToggle, action } = props
      return react.createElement(
        'div',
        {
          // 注意：这里**不带** `data-staging-group`。分组标记只挂在分组容器上
          // （`{ 'data-staging-group': 'unstaged' }` 那两处），测试按它的取值集合统计
          // 分组数，多挂一处会让"只有两组"那条断言变成另一种含义。
          'data-staging-group-head': '',
          style: { display: 'flex', alignItems: 'center', gap: '6px' },
        },
        react.createElement(
          'button',
          {
            type: 'button',
            'data-staging-toggle': props.id,
            'aria-expanded': collapsed !== true,
            onClick: onToggle,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              flex: '1 1 auto',
              minWidth: 0,
              height: '24px',
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: 'inherit',
              fontFamily: UI_FONT,
              fontSize: '12px',
              fontWeight: 600,
              textAlign: 'left',
              cursor: 'pointer',
            },
          },
          react.createElement(
            'svg',
            { width: 10, height: 10, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': 'true', style: { flexShrink: 0, color: 'var(--dsw-alias-label-tertiary)', transition: 'transform .14s ease', transform: collapsed === true ? 'rotate(-90deg)' : 'none' } },
            react.createElement('path', { d: 'M3 6l5 5 5-5', strokeLinecap: 'round', strokeLinejoin: 'round' }),
          ),
          react.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
          // 计数用统一的胶囊徽标（[data-review-count]），与分区标题右侧那个是同一套观感。
          react.createElement('span', { 'data-review-count': '' }, String(count)),
        ),
        action ?? null,
      )
    }

    /** 分组标题右侧的小图标按钮。 */
    function StagingIconButton(props) {
      const { t, id, label, onClick, disabled, children } = props
      return react.createElement(
        'button',
        {
          type: 'button',
          'data-staging-action': id,
          title: label,
          'aria-label': label,
          disabled: disabled === true,
          onClick: (event) => {
            event.stopPropagation()
            onClick()
          },
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            width: '20px',
            height: '20px',
            padding: 0,
            border: 'none',
            borderRadius: '4px',
            background: 'transparent',
            color: 'var(--dsw-alias-label-tertiary)',
            cursor: disabled === true ? 'default' : 'pointer',
            opacity: disabled === true ? 0.5 : 1,
          },
        },
        children,
      )
    }

    /**
     * 暂存与提交区块。
     *
     * 三组文件（已暂存 / 更改 / 未进行版本管理的文件）+ 一个提交框。分组依据是
     * `git status --porcelain` 的索引态与工作区态两列（见 classifyEntry），**不是**
     * 差异内容——差异里没有索引态。
     *
     * 未跟踪文件默认**折叠且只取前若干条**：实测一个真实仓库有 6,636 个未跟踪文件，
     * 一次列全会让这块面板变成一堵墙，而用户日常只是想知道"有多少、有没有我要找的那个"。
     *
     * @param props - `{ t, workspace, phase, onCommitted }`。
     * @returns React 元素。
     */
    function StagingSection(props) {
      const { t, workspace } = props
      const [state, setState] = react.useState({ phase: 'loading' })
      const [collapsed, setCollapsed] = react.useState({ staged: false, unstaged: false, untracked: false })
      /**
       * 已勾选、准备"加入 git"的未跟踪文件。
       *
       * 这是参考 IDEA 的 Git 工具窗加的：未跟踪文件默认**不勾选**（IDEA 里新文件也不会
       * 自动进暂存区），用户勾哪些就只 add 哪些，另一个按钮负责全选/全不选。
       */
      const [chosenUntracked, setChosenUntracked] = react.useState([])
      /**
       * 用户**主动取消勾选**的已跟踪文件。
       *
       * 用"记录取消"而不是"记录勾选"，因为默认是**全部已跟踪改动都算待提交**（IDEA 的
       * 习惯：变更即待提交，不必先暂存）。如果记录勾选集合，那么每次状态刷新（轮询、
       * 暂存之后重读）都会把用户刚取消掉的那个文件又加回来——实测就踩到了这个：取消
       * 勾选后按钮仍显示"会提交 3 个"，而且提交的还是 3 个。
       * 记录取消集合则天然稳定：新出现的文件默认勾选（IDEA 也是这样），用户取消过的
       * 一直保持取消，直到他重新勾上。
       */
      const [deselectedFiles, setDeselectedFiles] = react.useState([])
      /** 正在查看变更记录的文件路径（空串表示没有）。 */
      const [history, setHistory] = react.useState('')
      const [message, setMessage] = react.useState('')
      const [busy, setBusy] = react.useState(false)
      const [trouble, setTrouble] = react.useState(null)
      const [notice, setNotice] = react.useState('')
      const onCommitted = typeof props?.onCommitted === 'function' ? props.onCommitted : () => undefined
      /**
       * 当前正在读取的工作区。
       *
       * 用来丢弃**过期响应**：切换对话/工作区后，上一个工作区那次仍在飞的请求回来时会把
       * 新工作区的数据覆盖掉，界面于是短暂（有时是长期）显示另一个项目的文件——这正是
       * "切换了对话/切换了工作空间就直接获取不出来、对不上"的来源。异步结果落地前先
       * 核对它属于哪一次请求。
       */
      const wanted = react.useRef(workspace)

      /** 重新读一次状态。 */
      const reload = react.useCallback(async () => {
        if (typeof workspace !== 'string' || workspace === '') {
          setState({ phase: 'noworkspace' })
          return
        }
        const mine = workspace
        try {
          const result = await call('status', { workspace })
          if (wanted.current !== mine) return
          if (result?.isRepo === false) {
            setState({ phase: 'notrepo' })
            return
          }
          setState({ phase: 'ready', result })
        } catch (cause) {
          if (wanted.current !== mine) return
          const error = cause instanceof Error ? cause : new Error(String(cause))
          setTrouble(error.detail ?? error.message)
          setState({ phase: 'error' })
        }
      }, [workspace])

      react.useEffect(() => {
        // 工作区变了：记下新的期望值，并让界面立刻回到"加载中"而不是继续显示旧项目的
        // 文件——否则切换项目时会看到上一个项目的列表停留一会儿。
        wanted.current = workspace
        setState({ phase: 'loading' })
        setTrouble(null)
        setNotice('')
        void reload()
      }, [workspace, reload])

      /**
       * 跑一次写操作，然后把状态重新读一遍。
       *
       * 与 gitbar 那边同一套约定：host 只回稳定的 code，短句由这里按 code 渲染，
       * git 原文放在 `detail` 里原样展示。
       */
      const run = react.useCallback(
        async (route, body, onSuccess) => {
          setBusy(true)
          setTrouble(null)
          setNotice('')
          try {
            // 注意本插件的 `call` 是**只发 POST** 的辅助函数（第二个参数是请求体，不是
            // fetch 的 init）。写成 `call(route, { method, headers, body })` 会把那一整包
            // 当成请求体发出去，服务端收到的 `paths` 就是 undefined —— 表现是"点了暂存
            // 没反应"，而路由本身完全正常（实测踩到过）。
            const result = await call(route, { workspace, ...body })
            await reload()
            if (typeof onSuccess === 'string') setNotice(onSuccess)
            // **返回响应体而不是布尔**：提交那条路由要在成功里区分"已提交并推送"与
            // "已提交但推送失败"（`pushed` / `pushError`），布尔会把这条信息丢掉。
            // 调用方按 `!== undefined` 判断成功。
            return result ?? true
          } catch (cause) {
            const error = cause instanceof Error ? cause : new Error(String(cause))
            const code = typeof error.code === 'string' ? error.code : ''
            const key = code !== '' && Object.hasOwn(STAGING_ERROR_KEYS, code) ? STAGING_ERROR_KEYS[code] : ''
            setTrouble({ key, detail: typeof error.detail === 'string' ? error.detail : '', code })
            return undefined
          } finally {
            setBusy(false)
          }
        },
        [workspace, reload],
      )

      /**
       * 提交。
       *
       * 提交信息来自受控 textarea，且**成功后才清空**：失败时保留用户刚敲的字，
       * 否则他要重新打一遍（而失败原因往往与提交信息无关，比如"没有暂存内容"）。
       *
       * `paths` 非空时只提交那些文件（host 先 add 再 commit）；为空时提交索引里现有的
       * 全部内容。`push` 为真则提交成功后继续推送到上游（IDEA 的 Commit and Push）。
       */
      const submitCommit = react.useCallback(
        async (paths, push) => {
          const text = message.trim()
          if (text === '') return
          const selected = Array.isArray(paths) ? paths : []
          const ok = await run('commit', {
            message: text,
            ...(selected.length > 0 ? { paths: selected } : {}),
            ...(push === true ? { push: true } : {}),
          })
          if (ok === undefined) return
          setMessage('')
          // 提交成功后清掉"排除"记录：被排除的文件已经提交过了（或已不在列表里），
          // 留着会让下一次提交莫名其妙地漏掉同名的新改动。
          setDeselectedFiles([])
          setChosenUntracked([])
          // 提交成功、推送失败**不算失败**：提交已经落到本地历史里了。把两种结果分开说，
          // 否则用户会以为什么都没发生、于是再提交一次。
          if (ok.pushed === true) {
            setNotice(t('pushedNotice', { subject: text }))
          } else if (ok.pushed === false) {
            setNotice(t('pushFailedNotice', { detail: String(ok.pushError ?? '').slice(0, 200) }))
          } else {
            setNotice(t('committedNotice', { subject: text }))
          }
          onCommitted()
        },
        [message, run, t, onCommitted],
      )

      // 已跟踪改动默认全部算作已勾选，"提交"因此一步到位、不需要先暂存（详见下面
      // commitPaths 处的说明）。这里把"不再存在的路径"从取消集合里清掉，避免它无限增长。
      const knownPathsKey = (state.result?.tracked ?? [])
        .map((entry) => entry.path)
        .join('\u0000')
      react.useEffect(() => {
        const paths = new Set(knownPathsKey === '' ? [] : knownPathsKey.split('\u0000'))
        setDeselectedFiles((current) => current.filter((path) => paths.has(path)))
      }, [knownPathsKey])

      // 阶段守卫必须在最前：加载中/无工作区/非仓库/出错这四种情况都不该继续往下算分组。
      if (state.phase === 'loading') return statusBlock(t('loading'))
      if (state.phase === 'noworkspace') return statusBlock(t('noWorkspace'))
      if (state.phase === 'notrepo') return statusBlock(t('notRepo', { name: projectName(workspace ?? '') }))
      if (state.phase === 'error') return statusBlock(trouble?.detail ?? '', 'error')

      /**
       * 分组标题右侧的"全选/取消全选"勾选框。
       *
       * 用户明确要求「更改」和「未进行版本管理的文件」两组都能全选与取消全选。做成勾选框
       * 而不是一个按钮，是因为它同时要**显示当前状态**（部分选中时无法用按钮表达）。
       */
      const groupPick = (groupId, paths) => {
        // 已跟踪那一组用"取消集合"推导；未跟踪组用单独的选择集合（它默认不勾）。
        const isChosen = groupId === 'untracked' ? (p) => chosenUntracked.includes(p) : (p) => !deselectedFiles.includes(p)
        const picked = paths.filter(isChosen)
        const all = paths.length > 0 && picked.length === paths.length
        const some = picked.length > 0 && !all
        return react.createElement('input', {
          type: 'checkbox',
          'data-staging-group-pick': groupId,
          checked: all,
          disabled: busy || paths.length === 0,
          // 部分选中用 indeterminate 表达（原生 DOM 属性，React 需要直接设）。
          ref: (node) => {
            if (node !== null) node.indeterminate = some
          },
          'aria-label': all ? t('clearSelection') : t('selectAll'),
          title: all ? t('clearSelection') : t('selectAll'),
          onChange: (event) => {
            if (groupId === 'untracked') {
              setChosenUntracked((current) =>
                event.target.checked ? [...new Set([...current, ...paths])] : current.filter((item) => !paths.includes(item)),
              )
              return
            }
            // 已跟踪那一组：勾上 = 从"取消集合"里移除；取消 = 加进去。
            setDeselectedFiles((current) =>
              event.target.checked
                ? current.filter((item) => !paths.includes(item))
                : [...new Set([...current, ...paths])],
            )
          },
          style: { flexShrink: 0, margin: 0, cursor: busy ? 'default' : 'pointer' },
        })
      }

      /** 渲染一组行，并在需要时在其下方插入变更记录面板。 */
      /**
       * 渲染一组行，并在需要时在其下方插入变更记录面板。
       *
       * @param entries - 文件条目数组。
       * @param sideOf - 由条目算出该行显示哪种暂存动作的函数（`'staged'` → 取消暂存）。
       */
      const renderRows = (entries, sideOf) => {
        const nodes = []
        for (const entry of entries) {
          const side = typeof sideOf === 'function' ? sideOf(entry) : sideOf
          nodes.push(fileRow(entry, side))
          if (history === entry.path) {
            nodes.push(react.createElement(FileHistory, {
              key: `history:${side}:${entry.path}`,
              t,
              workspace,
              path: entry.path,
            }))
          }
        }
        return nodes
      }

      // ---- 暂存与提交（更改区块）----

      const result = state.result ?? {}
      const tracked = Array.isArray(result.tracked) ? result.tracked : []
      const staged = tracked.filter((entry) => classifyEntry(entry).staged)
      const unstaged = tracked.filter((entry) => classifyEntry(entry).unstaged)
      const untrackedCount = Number(result.untrackedCount ?? 0)
      const untrackedPaths = Array.isArray(result.untrackedPaths) ? result.untrackedPaths : []
      const clean = staged.length === 0 && unstaged.length === 0 && untrackedCount === 0
      // 已勾选（准备"加入 git"）的未跟踪文件。用 Set 而不是数组：勾选/取消是逐个发生的，
      // 列表可能几百行，`includes` 会让每次点击都变成一次线性扫描。
      const chosen = chosenUntracked.filter((path) => untrackedPaths.includes(path))
      const allChosen = untrackedPaths.length > 0 && chosen.length === untrackedPaths.length
      // 提交按钮为什么禁用，要在界面上说清楚：灰着而不给理由，用户只会反复点它。
      //
      // **已跟踪改动默认全部算作已勾选**，"提交"因此一步到位，不需要先暂存——IDEA 里
      // "变更"本来就等同于待提交，git 的索引是它内部处理的细节，不该变成用户必须先做的
      // 一步（实际反馈："还要先加暂存，交互太麻烦"）。勾选框只用来**排除**个别文件。
      // host 收到这批路径会先 `git add` 再 `commit`，所以未暂存的文件一样能被提交。
      //
      // 未跟踪的文件不默认算在内：把 `git add .` 的语义强加给一次普通提交，会把构建产物
      // 之类的东西一起提交进去。要带上它们就勾一下（那是明确的意图）。
      const allTrackedPaths = [...new Set([...staged, ...unstaged].map((entry) => entry.path))]
      /** 完整的已跟踪文件列表（按路径去重），界面只显示这一组。 */
      const byPath = new Map()
      for (const entry of [...staged, ...unstaged]) {
        if (!byPath.has(entry.path)) byPath.set(entry.path, entry)
      }
      const allTracked = [...byPath.values()]
      /** 一行该显示哪种暂存动作：索引里已有改动 → 取消暂存，否则 → 暂存。 */
      const sideOf = (entry) => (classifyEntry(entry).staged ? 'staged' : 'unstaged')
      /**
       * 一个已跟踪文件当前是否算作"要提交"。
       * 默认是（IDEA 的习惯：变更即待提交），除非用户主动取消过它。
       */
      const isPicked = (path) => !deselectedFiles.includes(path)
      /** 本次会提交的已跟踪文件。 */
      const checkedTracked = allTrackedPaths.filter(isPicked)
      // `chosenUntracked` 是"加入 git / 一并提交"勾选的未跟踪文件（默认不勾）。
      const checkedUntracked = chosenUntracked.filter((path) => untrackedPaths.includes(path))
      /** 本次提交的完整文件清单：全部勾中的已跟踪改动 + 勾中的未跟踪文件。 */
      const commitPaths = [...checkedTracked, ...checkedUntracked]
      const commitDisabled = busy || message.trim() === '' || commitPaths.length === 0

      /**
       * 一行已跟踪的文件（已暂存组或更改组）。
       *
       * 三个交互都是 IDEA 里有的：
       *   * 勾选框 —— 决定"提交哪些"（提交时 host 会先 add 再 commit，所以未暂存的也能直接提交）；
       *   * 点路径 —— 展开它的逐行差异；
       *   * 「变更记录」 —— 看这个文件历次提交（`git log --follow`）。
       *
       * @param entry - `{ path, index, worktree }`。
       * @param side - `'staged'` 或 `'unstaged'`。
       */
      const fileRow = (entry, side) => {
        const picked = !deselectedFiles.includes(entry.path)
        return react.createElement(
          'div',
          {
            key: `${side}:${entry.path}`,
            'data-staging-row': entry.path,
            'data-staging-side': side,
            style: { display: 'flex', alignItems: 'center', gap: '7px', minHeight: 'var(--dsh-review-row-h, 28px)', boxSizing: 'border-box', padding: '2px 6px 2px 18px', borderRadius: '6px', fontSize: '12.5px', fontFamily: UI_FONT },
          },
          react.createElement('input', {
            type: 'checkbox',
            'data-staging-file-pick': entry.path,
            checked: picked,
            disabled: busy,
            'aria-label': entry.path,
            onChange: (event) =>
              setDeselectedFiles((current) =>
                event.target.checked
                  ? current.filter((item) => item !== entry.path)
                  : [...new Set([...current, entry.path])],
              ),
            style: { flexShrink: 0, margin: 0, cursor: busy ? 'default' : 'pointer' },
          }),
          react.createElement(StatusBadge, { letter: side === 'staged' ? entry.index : entry.worktree }),
          react.createElement(
            'span',
            { title: entry.path, style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' } },
            `\u200e${entry.path}`,
          ),
          react.createElement(
            'button',
            {
              type: 'button',
              'data-staging-history': entry.path,
              'data-review-icon-button': '',
              disabled: busy,
              onClick: () => setHistory((current) => (current === entry.path ? '' : entry.path)),
              title: history === entry.path ? t('hideHistory') : t('fileHistory'),
              'aria-label': t('fileHistory'),
              'aria-expanded': history === entry.path,
              style: {
                flexShrink: 0,
                width: '22px',
                height: '22px',
                padding: 0,
                border: 'none',
                borderRadius: '4px',
                background: history === entry.path ? `color-mix(in srgb, ${ACCENT} 12%, transparent)` : 'transparent',
                color: history === entry.path ? ACCENT : 'var(--dsw-alias-label-tertiary)',
              },
            },
            // 图标而不是「变更记录」四个字：文件名往往要占满一行，四个字会把路径挤到
            // 省略号里去。完整含义留在 title / aria-label 上（脚本也读它们）。
            react.createElement(
              'svg',
              { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
              react.createElement('path', {
                d: 'M8 3.2v9.6M8 3.2a1.6 1.6 0 1 0 0-.01M8 12.8a1.6 1.6 0 1 0 0-.01M8 6.4h3.1M8 9.6H4.9',
                stroke: 'currentColor',
                strokeWidth: 1.4,
                strokeLinecap: 'round',
              }),
            ),
          ),
          react.createElement(
            'button',
            {
              type: 'button',
              'data-staging-row-action': side === 'staged' ? 'unstage' : 'stage',
              'data-review-level': side === 'staged' ? 'on' : 'off',
              // 参与"悬停才浮现"那条规则（见样式层里的 [data-staging-row]:hover 规则）。
              'data-review-icon-button': '',
              disabled: busy,
              onClick: () =>
                void run(side === 'staged' ? 'unstage' : 'stage', { paths: [entry.path] }, side === 'staged' ? t('unstagedNotice', { count: 1 }) : t('stagedNotice', { count: 1 })),
              title: side === 'staged' ? t('unstage') : t('stage'),
              'aria-label': side === 'staged' ? t('unstage') : t('stage'),
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                width: '22px',
                height: '22px',
                padding: 0,
                border: 'none',
                borderRadius: '4px',
                background: 'transparent',
                color: side === 'staged' ? ACCENT : 'var(--dsw-alias-label-tertiary)',
                fontFamily: UI_FONT,
                fontSize: '13px',
                lineHeight: 1,
              },
            },
            side === 'staged' ? '−' : '+',
          ),
        )
      }

      /** 一条未跟踪文件。 */
      /**
       * 一条未跟踪文件：勾选框 + 路径 + 单个「加入」。
       *
       * 勾选框是参考 IDEA 的 Git 工具窗加的——新文件在 IDEA 里默认**不**进暂存区，用户
       * 勾哪些、再点「加入 git」，才 `git add` 哪些。单行那个 `+` 保留，方便只加一个。
       *
       * @param path - 仓库内相对路径。
       * @param checked - 是否已勾选。
       */
      const untrackedRow = (path, checked) =>
        react.createElement(
          'div',
          {
            key: `untracked:${path}`,
            'data-staging-row': path,
            'data-staging-side': 'untracked',
            style: { display: 'flex', alignItems: 'center', gap: '7px', minHeight: 'var(--dsh-review-row-h, 28px)', boxSizing: 'border-box', padding: '2px 6px 2px 22px', borderRadius: '6px', fontSize: '12.5px', fontFamily: UI_FONT },
          },
          react.createElement('input', {
            type: 'checkbox',
            'data-staging-pick': path,
            checked: checked === true,
            disabled: busy,
            'aria-label': path,
            onChange: (event) =>
              setChosenUntracked((current) =>
                event.target.checked ? [...current, path] : current.filter((item) => item !== path),
              ),
            style: { flexShrink: 0, margin: 0, cursor: busy ? 'default' : 'pointer' },
          }),
          react.createElement(StatusBadge, { letter: '?' }),
          react.createElement(
            'span',
            { title: path, style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' } },
            `\u200e${path}`,
          ),
          // 未跟踪的文件同样能看变更记录：通常是空的（还没提交过），但"以后有没有"这件事
          // 只有点开才知道。IDEA 也是每个文件都能看历史。
          react.createElement(
            'button',
            {
              type: 'button',
              'data-staging-history': path,
              'data-review-icon-button': '',
              disabled: busy,
              onClick: () => setHistory((current) => (current === path ? '' : path)),
              title: history === path ? t('hideHistory') : t('fileHistory'),
              'aria-label': t('fileHistory'),
              'aria-expanded': history === path,
              style: {
                flexShrink: 0,
                width: '22px',
                height: '22px',
                padding: 0,
                border: 'none',
                borderRadius: '4px',
                background: history === path ? `color-mix(in srgb, ${ACCENT} 12%, transparent)` : 'transparent',
                color: history === path ? ACCENT : 'var(--dsw-alias-label-tertiary)',
              },
            },
            react.createElement(
              'svg',
              { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
              react.createElement('path', {
                d: 'M8 3.2v9.6M8 3.2a1.6 1.6 0 1 0 0-.01M8 12.8a1.6 1.6 0 1 0 0-.01M8 6.4h3.1M8 9.6H4.9',
                stroke: 'currentColor',
                strokeWidth: 1.4,
                strokeLinecap: 'round',
              }),
            ),
          ),
          react.createElement(
            'button',
            {
              type: 'button',
              'data-staging-row-action': 'stage',
              'data-review-icon-button': '',
              disabled: busy,
              onClick: () => void run('stage', { paths: [path] }, t('addedNotice', { count: 1 })),
              title: t('addToGit'),
              'aria-label': t('addToGit'),
              style: { flexShrink: 0, width: '22px', height: '22px', padding: 0, border: 'none', borderRadius: '4px', background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', fontSize: '14px', lineHeight: 1 },
            },
            '+',
          ),
        )

      const bulkIcon = react.createElement(
        'svg',
        { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': 'true' },
        react.createElement('path', { d: 'M8 3.5v9M3.5 8h9', strokeLinecap: 'round' }),
      )

      return react.createElement(
        'div',
        { 'data-staging': '', style: { display: 'flex', flexDirection: 'column', fontFamily: UI_FONT } },
        // ---- 提交卡片 ----
        //
        // 做成一张"卡片"而不是一条普通表单：提交是这块面板的主动作，读屏顺序上它必须
        // 第一个被看到，视觉上也要与下面的文件清单分开（此前三者都是同样的白底 + 细线，
        // 分不出主次）。
        react.createElement(
          'div',
          {
            'data-staging-commit-card': '',
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              margin: '2px 2px 10px',
              padding: '10px',
              border: `1px solid ${BORDER}`,
              borderRadius: '10px',
              background: 'var(--dsw-alias-bg-base, #fff)',
              boxShadow: '0 1px 2px rgba(16,24,40,.04)',
            },
          },
          react.createElement('textarea', {
            'data-staging-message': '',
            'data-review-input': '',
            value: message,
            rows: 2,
            placeholder: t('commitMessage', { branch: result.branch ?? '' }),
            'aria-label': t('commitMessage', { branch: result.branch ?? '' }),
            spellCheck: false,
            disabled: busy,
            onChange: (event) => setMessage(event.target.value),
            onKeyDown: (event) => {
              // Ctrl+Enter 提交（与 IDEA 的提交框一致）。**必须 stopPropagation**：
              // 否则这个按键会冒泡到聊天输入框的全局快捷键上。
              event.stopPropagation()
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                if (commitDisabled !== true) void submitCommit(commitPaths)
              }
            },
            style: {
              boxSizing: 'border-box',
              width: '100%',
              padding: '7px 9px',
              border: `1px solid ${BORDER}`,
              borderRadius: '8px',
              background: 'var(--dsw-alias-bg-base, #fff)',
              color: 'inherit',
              fontFamily: UI_FONT,
              fontSize: '12.5px',
              lineHeight: 1.55,
              resize: 'vertical',
              transition: 'border-color .13s ease, box-shadow .13s ease',
            },
          }),
          react.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            react.createElement(
              'button',
              {
                type: 'button',
                'data-staging-commit': '',
                'data-review-primary': '',
                disabled: commitDisabled,
                onClick: () => void submitCommit(commitPaths),
                style: {
                  border: 'none',
                  background: commitDisabled ? 'var(--dsw-alias-bg-module-platform, #eceef2)' : ACCENT,
                  color: commitDisabled ? 'var(--dsw-alias-label-tertiary)' : '#fff',
                },
              },
              busy
                ? t('committing')
                : commitPaths.length > 0
                  ? t('commitSelected', { count: commitPaths.length })
                  : t('commit'),
            ),
            // 「提交并推送」——对应 IDEA 的 Commit and Push。
            react.createElement(
              'button',
              {
                type: 'button',
                'data-staging-commit-push': '',
                'data-review-secondary': '',
                disabled: commitDisabled,
                title: t('commitAndPushHint'),
                onClick: () => void submitCommit(commitPaths, true),
                style: {
                  borderColor: commitDisabled ? BORDER : `color-mix(in srgb, ${ACCENT} 45%, transparent)`,
                  color: commitDisabled ? 'var(--dsw-alias-label-tertiary)' : ACCENT,
                },
              },
              t('commitAndPush'),
            ),
            // 为什么禁用／会提交什么，都要说清楚：按钮灰着而不给理由，用户只会反复点它。
            // 顺带给出快捷键提示：Ctrl+Enter 提交是提交框的惯用键（也已实现），
            // 但不在界面上写出来就没人会去试。
            react.createElement(
              'span',
              {
                'data-staging-hint': '',
                style: { flex: '1 1 140px', minWidth: 0, fontSize: '11.5px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
              },
              message.trim() === ''
                ? t('emptyMessage')
                : commitPaths.length > 0
                  ? t('willCommitCount', { count: commitPaths.length })
                  : allTrackedPaths.length === 0
                    ? t('error_nothingToCommit')
                    : t('noSelection'),
              react.createElement(
                'span',
                { title: t('commit'), style: { marginLeft: '6px', padding: '1px 5px', border: '1px solid var(--dsh-review-line)', borderRadius: '4px', fontFamily: CODE_FONT, fontSize: '10.5px', whiteSpace: 'nowrap' } },
                'Ctrl+↵',
              ),
            ),
          ),
        ),

        trouble === null
          ? null
          : react.createElement(
              'div',
              {
                'data-staging-error': trouble.code === '' ? 'unknown' : trouble.code,
                style: {
                  margin: '8px 2px 0',
                  padding: '7px 9px',
                  borderRadius: '8px',
                  background: `color-mix(in srgb, ${REMOVED} 6%, transparent)`,
                  border: `1px solid color-mix(in srgb, ${REMOVED} 20%, transparent)`,
                  color: REMOVED,
                  fontSize: '12px',
                  lineHeight: 1.5,
                },
              },
              react.createElement('div', null, trouble.key === '' ? t('error_unknownReview') : t(trouble.key)),
              trouble.detail === ''
                ? null
                : react.createElement('div', { style: { marginTop: '4px', paddingTop: '4px', borderTop: '1px solid color-mix(in srgb, currentColor 20%, transparent)', fontFamily: CODE_FONT, fontSize: '11.5px', whiteSpace: 'pre-wrap' } }, trouble.detail),
            ),

        notice === ''
          ? null
          : react.createElement(
              'div',
              { 'data-staging-notice': '', style: { margin: '8px 2px 0', padding: '6px 9px', borderRadius: '6px', background: `color-mix(in srgb, ${ADDED} 7%, transparent)`, border: `1px solid color-mix(in srgb, ${ADDED} 20%, transparent)`, color: ADDED, fontSize: '12px' } },
              notice,
            ),

        clean
          ? react.createElement(
              'div',
              {
                'data-review-clean': '',
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '26px 12px',
                  color: 'var(--dsw-alias-label-tertiary)',
                  fontSize: '12.5px',
                  textAlign: 'center',
                },
              },
              react.createElement(
                'svg',
                { width: 26, height: 26, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', style: { opacity: 0.45 } },
                react.createElement('path', {
                  d: 'M4.5 12.5l4.5 4.5 10.5-10.5',
                  stroke: 'currentColor',
                  strokeWidth: 1.7,
                  strokeLinecap: 'round',
                  strokeLinejoin: 'round',
                }),
              ),
              t('noStagedOrChanged'),
            )
          : react.createElement(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
              // ---- 更改（已跟踪的改动，**一组**）----
              //
              // 刻意不再拆成"已暂存 / 未暂存"两组：同一个文件两处都有改动（`MM`）时会
              // 出现在两个列表里，既有重复行，也让"到底该提交哪个"变成用户的负担。
              // 现在索引是内部细节——提交时会自动 add，所以列表只回答"改了什么"。
              // 索引里已有的改动用状态徽标（A/M/D）与行首的已暂存标记区分。
              allTracked.length === 0
                ? null
                : react.createElement(
                    'div',
                    { 'data-staging-group': 'unstaged' },
                    react.createElement(StagingGroupHeader, {
                      t,
                      id: 'unstaged',
                      label: t('unstagedTitle'),
                      count: allTracked.length,
                      collapsed: collapsed.unstaged,
                      onToggle: () => setCollapsed((value) => ({ ...value, unstaged: !value.unstaged })),
                      action: react.createElement(
                        'div',
                        { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
                        groupPick('unstaged', allTrackedPaths),
                        react.createElement(
                          StagingIconButton,
                          {
                            t,
                            id: 'stage-all',
                            label: t('stageAll'),
                            disabled: busy,
                            // 仍然保留"只暂存不提交"这条路：有人习惯先把改动摆进索引再逐次提交。
                            onClick: () => void run('stage', { paths: allTrackedPaths }),
                          },
                          bulkIcon,
                        ),
                      ),
                    }),
                    collapsed.unstaged ? null : renderRows(allTracked, sideOf),
                  ),
              // ---- 未跟踪（可以勾选后"加入 git"）----
              untrackedCount === 0
                ? null
                : react.createElement(
                    'div',
                    { 'data-staging-group': 'untracked' },
                    react.createElement(StagingGroupHeader, {
                      t,
                      id: 'untracked',
                      // 数量用 host 给的**总数**，不是列出的条数：界面上"6,636 个文件"这个
                      // 数字本身就是用户想知道的第一件事，用它列出的条数会把它说小。
                      label: t('untrackedTitle'),
                      count: untrackedCount,
                      collapsed: collapsed.untracked,
                      onToggle: () => setCollapsed((value) => ({ ...value, untracked: !value.untracked })),
                      // 全选/全不选。IDEA 的分组标题上也有这个勾选框，它决定"下面那批要不要
                      // 一起加入"。
                      action: react.createElement(
                        'button',
                        {
                          type: 'button',
                          'data-staging-toggle-all': 'untracked',
                          title: allChosen ? t('untrackedClearAll') : t('untrackedSelectAll'),
                          'aria-label': allChosen ? t('untrackedClearAll') : t('untrackedSelectAll'),
                          'aria-pressed': allChosen,
                          disabled: busy || untrackedPaths.length === 0,
                          onClick: (event) => {
                            event.stopPropagation()
                            setChosenUntracked(allChosen ? [] : untrackedPaths)
                          },
                          style: {
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0,
                            width: '22px',
                            height: '22px',
                            padding: 0,
                            border: 'none',
                            borderRadius: '4px',
                            background: 'transparent',
                            color: allChosen ? ACCENT : 'var(--dsw-alias-label-tertiary)',
                            fontFamily: UI_FONT,
                            fontSize: '13px',
                            lineHeight: 1,
                            cursor: busy ? 'default' : 'pointer',
                          },
                        },
                        allChosen ? '☑' : '☐',
                      ),
                    }),
                    collapsed.untracked
                      ? null
                      : [
                          react.createElement(
                            'div',
                            { key: 'list', 'data-staging-untracked-list': '' },
                            untrackedPaths.flatMap((path) => {
                              const row = untrackedRow(path, chosenUntracked.includes(path))
                              if (history !== path) return [row]
                              return [
                                row,
                                react.createElement(FileHistory, {
                                  key: `history:untracked:${path}`,
                                  t,
                                  workspace,
                                  path,
                                }),
                              ]
                            }),
                            result.untrackedTruncated === true
                              ? react.createElement(
                                  'div',
                                  { 'data-staging-untracked-truncated': '', style: { padding: '4px 8px 4px 26px', fontSize: '11.5px', color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.6 } },
                                  t('untrackedTruncated', {
                                    count: untrackedPaths.length,
                                    rest: Math.max(0, untrackedCount - untrackedPaths.length),
                                  }),
                                )
                              : null,
                          ),
                          // 「加入 git」= `git add`。这就是 IDEA 里未跟踪文件那一组的核心动作：
                          // 选中若干新文件 → Add to VCS → 它们进入"已暂存"。
                          //
                          // 做成贴底的一条汇总栏（而不是挤在列表末尾）：文件多的时候"选了
                          // 几个、点哪个按钮"必须一眼可见，否则要滚到底才知道能干什么。
                          react.createElement(
                            'div',
                            { key: 'bar', 'data-review-untracked-bar': '' },
                            react.createElement(
                              'button',
                              {
                                type: 'button',
                                'data-staging-add-chosen': '',
                                'data-review-primary': '',
                                disabled: busy || chosen.length === 0,
                                onClick: () =>
                                  void run('stage', { paths: chosen }, t('addedNotice', { count: chosen.length })).then(
                                    (ok) => {
                                      // `run` 现在返回响应体（成功）或 undefined（失败）。
                                      if (ok !== undefined) setChosenUntracked([])
                                    },
                                  ),
                                style: {
                                  height: '24px',
                                  padding: '0 12px',
                                  border: 'none',
                                  background: chosen.length === 0 ? 'var(--dsw-alias-bg-module-platform, #eceef2)' : ACCENT,
                                  color: chosen.length === 0 ? 'var(--dsw-alias-label-tertiary)' : '#fff',
                                },
                              },
                              t('addToGit'),
                            ),
                            react.createElement(
                              'span',
                              {
                                'data-staging-chosen-count': '',
                                style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                              },
                              chosen.length === 0 ? t('untrackedHint') : t('chosenCount', { count: chosen.length }),
                            ),
                          ),
                        ],
                  ),
            ),
      )
    }

    /**
     * 文件列表：每行一个文件，点击展开该文件的差异。
     * @param props - `{ t, result, phase, message, workspace, sessionId }`。
     */
    function FileList(props) {
      const { t, result, phase, message } = props
      const [expanded, setExpanded] = react.useState('')
      // 待确认还原的路径：还原是写操作，必须确认——但用**弹窗**确认，而不是"再点一次
      // 这个按钮"。后者的问题：按钮很小、第二次点击容易落空（用户会感觉"点了没反应"），
      // 而且 onBlur 会在点到别处时把确认态清掉。
      const [confirming, setConfirming] = react.useState('')
      const [busy, setBusy] = react.useState('')
      const [trouble, setTrouble] = react.useState('')
      const onChanged = typeof props?.onChanged === 'function' ? props.onChanged : () => undefined
      const { files, added, removed } = summarize(result)
      const byFile = react.useMemo(() => splitByFile(result?.diff ?? ''), [result?.diff])

      /**
       * 还原单个文件到基线（本轮）或 HEAD（工作区）。
       * @param path - 相对仓库根的路径。
       */
      const revert = async (path) => {
        setBusy(path)
        setTrouble('')
        try {
          await call('revert', {
            workspace: props.workspace,
            sessionId: props.sessionId,
            scope: result?.scope === 'workspace' ? 'workspace' : 'turn',
            paths: [path],
          })
          setConfirming('')
          onChanged()
        } catch (cause) {
          setTrouble(String(cause.message ?? cause))
        } finally {
          setBusy('')
        }
      }

      if (phase === 'loading') {
        return statusBlock(t('loading'))
      }
      if (phase === 'error') {
        // `noWorkspace` 是一个内部代号，翻成给用户看的话。
        return statusBlock(message === 'noWorkspace' ? t('noWorkspace') : message, 'error')
      }
      if (result?.isRepo === false) {
        return statusBlock(t('notRepo', { name: projectName(props.workspace) }))
      }
      if (result?.empty === true) {
        return statusBlock(t('workspaceEmpty'))
      }
      if (result?.noBaseline === true) {
        return statusBlock(t('noBaseline'))
      }
      if (files.length === 0) {
        // 项目级与轮次级用不同措辞：前者是"没有未提交改动"，后者是"本轮没改文件"。
        const key = result?.scope === 'workspace' ? 'workspaceClean' : 'clean'
        return statusBlock(t(key))
      }

      return react.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontFamily: UI_FONT } },
        // 逐行差异读不出来时（改动体量超出上限）必须说明原因。
        //
        // 不说的话，用户看到的是一列点不开的文件——而真正的原因是仓库里有个没被
        // `.gitignore` 覆盖的大目录（实测：`tmp/` 下 6,635 个日志文件、45.9 MB 差异）。
        // 这条提示同时也是给用户的修复建议：把那个目录加进 .gitignore。
        result?.diffOversized === true
          ? react.createElement(
              'div',
              {
                'data-review-diff-oversized': '',
                style: {
                  margin: '0 2px 8px',
                  padding: '7px 9px',
                  borderRadius: '8px',
                  background: `color-mix(in srgb, ${REMOVED} 6%, transparent)`,
                  border: `1px solid color-mix(in srgb, ${REMOVED} 22%, transparent)`,
                  color: REMOVED,
                  fontSize: '12px',
                  lineHeight: 1.6,
                },
              },
              t('diffOversized'),
            )
          : null,
        // 分区头：左侧是"改了什么"标题，右侧是**总量**（文件数 + 增删行数）。
        //
        // 这是 IDEA 提交面板的头部结构：先给总量，再给清单；总量与逐行数字出自同一份
        // 数据（见下面各行的 `data-review-stats`），因此不可能对不上。
        react.createElement(
          'div',
          { 'data-review-section-title': '' },
          t('changesTitle'),
          react.createElement('span', { style: { flex: 1 } }),
          react.createElement('span', { 'data-review-count': '' }, String(files.length)),
          // 总变动行数：`+N −M` 是这一屏所有文件的和。
          //
          // 与下面每行的行内数字是同一套来源（`/workspace` 或 `/changes` 的 numstat），
          // 因此总数恒等于各行之和——这正是"外部数字显示对不上"要根治的那类问题：
          // 任何"用另一条路由单独算总数"的写法都会在两次请求之间不一致。
          react.createElement(
            'span',
            {
              'data-review-total-stats': '',
              style: { fontWeight: 400, fontSize: '11.5px', fontFamily: CODE_FONT, whiteSpace: 'nowrap', textTransform: 'none', letterSpacing: 0 },
            },
            react.createElement('span', { style: { color: ADDED } }, `+${added}`),
            ' ',
            react.createElement('span', { style: { color: REMOVED } }, `−${removed}`),
          ),
        ),
        files.map((file) => {
          const diff = byFile.get(file.path) ?? ''
          const open = expanded === file.path
          const working = busy === file.path
          const status = file.status?.[0] ?? '?'
          const color = STATUS_COLORS[status] ?? 'var(--dsw-alias-label-secondary)'
          const { dir, base } = splitPath(file.path)
          return react.createElement(
            'div',
            // `data-review-row` 带**路径**而不只是空标记：下面那个暂存标记要靠它才能
            // 对应到具体文件，否则"哪个文件已暂存"在 DOM 上无法核验（脚本与人工都一样）。
            { key: file.path, 'data-review-row': file.path, 'data-review-file-row': '' },
            react.createElement(
              'div',
              {
                className: 'dsh-review-file-row',
                style: {
                  display: 'flex',
                  alignItems: 'stretch',
                  gap: '2px',
                  borderRadius: '6px',
                  background: open ? `color-mix(in srgb, ${ACCENT} 6%, transparent)` : 'transparent',
                },
              },
              react.createElement(
                'button',
                {
                  type: 'button',
                  className: 'dsh-review-file',
                  'aria-expanded': open,
                  onClick: () => setExpanded(open ? '' : file.path),
                  // title 必须保留完整路径：脚本与用户都靠它辨认（见 test-diff-readability）。
                  title: file.path,
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    flex: '1 1 auto',
                    minWidth: 0,
                    minHeight: 'var(--dsh-review-row-h, 28px)',
                    textAlign: 'left',
                    padding: '4px 8px',
                    border: '1px solid transparent',
                    borderRadius: '5px',
                    background: open
                      ? 'var(--dsw-alias-interactive-bg-hover-accent, color-mix(in srgb, ' + ACCENT + ' 8%, transparent))'
                      : 'transparent',
                    color: 'var(--dsw-alias-label-primary)',
                    fontSize: '12.5px',
                    fontFamily: UI_FONT,
                    lineHeight: 1.45,
                    cursor: 'pointer',
                  },
                },
                // 状态徽标：字母 + 语义色底。IDEA 用图标，这里用字母是为了不引入图标库，
                // 而且 A/M/D/R 本身就是 git 的通用缩写。
                react.createElement(
                  'span',
                  {
                    'data-review-status': '',
                    // 本地化的状态词放在 title 上：徽标只放得下一个字母，而"新增/修改/删除"
                    // 是完整的说法（也让它对读屏工具是有意义的）。
                    title: t(STATUS_KEYS[status] ?? 'statusOther'),
                    style: {
                      color,
                      background: `color-mix(in srgb, ${color} 14%, transparent)`,
                    },
                  },
                  status,
                ),
                // 目录压暗、文件名留亮：一屏几十行时，视线只需扫文件名。
                //
                // 用 flex + 让**目录**可收缩来保证文件名永远完整可见。不要用
                // `direction: rtl` 那套"从左侧省略"的技巧：它会让两个 span 的排列顺序也跟着
                // 反过来，路径会显示成 `app.tssrc/`。
                react.createElement(
                  'span',
                  {
                    style: {
                      display: 'flex',
                      alignItems: 'baseline',
                      flex: 1,
                      minWidth: 0,
                      fontFamily: CODE_FONT,
                    },
                  },
                  dir === ''
                    ? null
                    : react.createElement(
                        'span',
                        {
                          'data-review-path-dir': '',
                          style: { flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                        },
                        `${dir}/`,
                      ),
                  react.createElement(
                    'span',
                    {
                      'data-review-path-name': '',
                      style: { flex: '0 0 auto', whiteSpace: 'nowrap' },
                    },
                    base,
                  ),
                ),
                react.createElement(
                  'span',
                  {
                    'data-review-stats': '',
                    style: { whiteSpace: 'nowrap', fontSize: '11.5px', flexShrink: 0, fontFamily: CODE_FONT },
                  },
                  react.createElement('span', { style: { color: ADDED } }, `+${file.added ?? 0}`),
                  ' ',
                  react.createElement('span', { style: { color: REMOVED } }, `−${file.removed ?? 0}`),
                ),
                // 暂存状态：哪个文件已经进了索引。
                //
                // 这一列是"选择性提交"能不能用的前提——没有它，用户在下面勾了暂存、
                // 上面那份列表却看不出任何区别，于是只能靠记忆（实际反馈："文件可以选择性
                // 提交"）。`staged`/`unstaged` 由 host 在同一次请求里随文件一起给出
                // （见 indexStates），因此这里的标记与下面分组的判定不可能不一致。
                file.untracked === true
                  ? react.createElement(
                      'span',
                      {
                        'data-review-staged': 'untracked',
                        title: t('untrackedTitle'),
                        style: { flexShrink: 0, fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' },
                      },
                      '?',
                    )
                  : react.createElement(
                      'span',
                      {
                        'data-review-staged': file.staged === true ? 'yes' : 'no',
                        title: file.staged === true ? t('stagedTitle') : t('unstagedTitle'),
                        style: {
                          flexShrink: 0,
                          padding: '0 4px',
                          borderRadius: '4px',
                          fontSize: '11px',
                          lineHeight: '15px',
                          color: file.staged === true ? ADDED : 'var(--dsw-alias-label-tertiary)',
                          background:
                            file.staged === true
                              ? `color-mix(in srgb, ${ADDED} 14%, transparent)`
                              : 'transparent',
                        },
                      },
                      // 只用一个字形，不写文字：列表一屏几十行，文字会把文件名挤窄。
                      file.staged === true ? '●' : '○',
                    ),
                react.createElement(
                  'svg',
                  {
                    width: 12,
                    height: 12,
                    viewBox: '0 0 16 16',
                    fill: 'none',
                    'aria-hidden': 'true',
                    style: {
                      flexShrink: 0,
                      color: 'var(--dsw-alias-label-tertiary)',
                      transform: open ? 'rotate(90deg)' : 'none',
                      transition: 'transform .12s ease',
                    },
                  },
                  react.createElement('path', {
                    d: 'M6 4l4 4-4 4',
                    stroke: 'currentColor',
                    strokeWidth: 1.6,
                    strokeLinecap: 'round',
                    strokeLinejoin: 'round',
                  }),
                ),
              ),
              // 还原按钮：点击后弹出确认框（见 ConfirmRevertDialog）。
              // 平时只显示图标、悬停才染成危险色——IDEA 的行内动作也是这样收着的。
              react.createElement(
                'button',
                {
                  type: 'button',
                  className: 'dsh-review-revert',
                  'data-review-icon-button': '',
                  disabled: working,
                  title: t('revert'),
                  'aria-label': working ? t('reverting') : t('revert'),
                  onClick: () => setConfirming(file.path),
                  style: { flex: '0 0 auto', alignSelf: 'center' },
                },
                working
                  ? react.createElement('span', { style: { fontSize: '11px' } }, '…')
                  : react.createElement(
                      'svg',
                      { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
                      react.createElement('path', {
                        d: 'M3.5 5.5h6.2A3.3 3.3 0 0 1 13 8.8v0A3.3 3.3 0 0 1 9.7 12H6.5M3.5 5.5l2.2-2.2M3.5 5.5l2.2 2.2',
                        stroke: 'currentColor',
                        strokeWidth: 1.5,
                        strokeLinecap: 'round',
                        strokeLinejoin: 'round',
                      }),
                    ),
              ),
            ),
            open
              ? react.createElement(
                  'div',
                  { style: { margin: '2px 0 8px' } },
                  // 差异区顶部固定一条信息（路径 + 增删），长差异滚动时不会迷失在行里。
                  react.createElement(
                    'div',
                    { 'data-review-diff': '' },
                    react.createElement(
                      'div',
                      { 'data-review-diff-header': '' },
                      react.createElement('span', { 'data-review-status': '', title: t(STATUS_KEYS[status] ?? 'statusOther'), style: { color, background: `color-mix(in srgb, ${color} 14%, transparent)` } }, status),
                      react.createElement(
                        'span',
                        { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: CODE_FONT } },
                        file.path,
                      ),
                      react.createElement('span', { style: { flex: 1 } }),
                      react.createElement(
                        'span',
                        { 'data-review-stats': '', style: { flexShrink: 0, fontFamily: CODE_FONT } },
                        react.createElement('span', { style: { color: ADDED } }, `+${file.added ?? 0}`),
                        ' ',
                        react.createElement('span', { style: { color: REMOVED } }, `−${file.removed ?? 0}`),
                      ),
                    ),
                    isBinaryDiff(diff)
                      ? react.createElement(
                          'div',
                          { style: { color: 'var(--dsw-alias-label-secondary)', padding: '10px', fontFamily: UI_FONT, fontSize: '12px' } },
                          t('binaryDiff'),
                        )
                      : react.createElement(
                          'div',
                          {
                            style: {
                              // 等宽字体是差异视图可读的基础：比例字体下增删对齐会全乱。
                              fontSize: '12px',
                              lineHeight: 1.55,
                              fontFamily: CODE_FONT,
                              fontVariantLigatures: 'none',
                              // 横向溢出才滚动；纵向交给抽屉整体，避免嵌套滚动条。
                              overflowX: 'auto',
                            },
                          },
                          renderDiff(diff),
                        ),
                  ),
                )
              : null,
          )
        }),
        result?.truncated === true
          ? react.createElement('div', { style: { marginTop: '6px', color: '#c9a0a0', fontSize: '11.5px' } }, t('truncated'))
          : null,
        // 确认弹窗：还原是写操作，必须让用户明确决定。
        confirming === ''
          ? null
          : react.createElement(ConfirmRevertDialog, {
              t,
              path: confirming,
              busy: busy === confirming,
              onCancel: () => setConfirming(''),
              onConfirm: () => void revert(confirming),
            }),
      )
    }

    /**
     * 侧边栏里的审查标签正文。
     * @param props - 槽注入的属性（含会话标识与本地化函数）。
     */
    function ReviewTab(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      // 标签正文的注入按会话作用域做，因此 sessionId 可直接使用。
      const sessionId = props?.sessionId
      const workspace =
        typeof props?.useSessions === 'function' && sessionId !== undefined
          ? props.useSessions((state) => state?.byId?.[sessionId]?.cwd)
          : undefined

      const { state, reload } = useChanges(workspace, sessionId)

      return react.createElement(
        'div',
        { 'data-desktop-review-surface': 'tab', style: { padding: '16px', overflowY: 'auto', height: '100%', boxSizing: 'border-box', fontFamily: UI_FONT } },
        react.createElement(FileList, {
          t,
          result: state.result,
          phase: state.phase,
          message: state.message,
          workspace,
          sessionId,
          onChanged: reload,
        }),
      )
    }

    /** 侧边栏标签的标题。 */
    function ReviewTabTitle(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      return react.createElement('span', { style: { fontSize: '12px', fontFamily: UI_FONT } }, t('title'))
    }

    // =========================================================================
    // 提交图（主区域的三栏视图）
    // =========================================================================

    /** 提交图面板在 `sidebar.panellist` 与 `main` 两个槽位共用的 id。 */
    const GRAPH_ID = 'git-graph'

    /** 泳道列宽与行高。两者都是常量，因为虚拟滚动要靠它们算偏移。 */
    const GRAPH_LANE_WIDTH = 14
    const GRAPH_ROW_HEIGHT = 24

    /** 每页拉多少条提交。 */
    const GRAPH_PAGE_SIZE = 80

    /** 一屏最多渲染多少行（超出靠滚动占位撑开）。 */
    const GRAPH_WINDOW = 40

    /** 提交图上的取色：与泳道无关的常规色。 */
    const GRAPH_DIM = 'var(--dsw-alias-label-tertiary, #9aa0a6)'

    /**
     * 拉一页提交历史。
     *
     * @param workspace - 工作区路径。
     * @param options - `{ skip, ref }`。
     * @returns host 的响应。
     */
    async function fetchGraph(workspace, options) {
      return call('graph', {
        workspace,
        limit: GRAPH_PAGE_SIZE,
        skip: options?.skip ?? 0,
        ...(options?.ref === undefined || options.ref === '' ? {} : { ref: options.ref }),
      })
    }

    /**
     * 分支树：HEAD / 本地 / 远程 / 标签 四段。
     *
     * 数据直接从**当前已加载的提交**里聚合出来，而不是再问一次 host：`%D` 已经带了每个
     * ref 落在哪条提交上，聚合是纯本地计算。代价是"只加载了一页时，更早的分支看不见"，
     * 因此每段末尾在还有下一页时给一个提示——比让用户以为"分支就这么多"要好。
     *
     * @param props - `{ t, commits, loading, hasMore, ref, onPickRef }`。
     * @returns React 元素。
     */
    function GraphBranchTree(props) {
      const { t, commits, hasMore, ref, onPickRef } = props
      const head = []
      const local = []
      const remote = []
      const tags = []
      const seen = new Set()
      for (const commit of commits) {
        for (const entry of commit.refs ?? []) {
          const key = `${entry.kind}:${entry.name}`
          if (seen.has(key)) continue
          seen.add(key)
          const row = { name: entry.name, hash: commit.hash, subject: commit.subject }
          if (entry.isHead === true && entry.kind === 'branch') head.push(row)
          else if (entry.kind === 'tag') tags.push(row)
          else if (entry.kind === 'remote') remote.push(row)
          else if (entry.kind === 'branch') local.push(row)
        }
      }

      const section = (key, label, rows) =>
        react.createElement(
          'div',
          { key, 'data-graph-tree-section': key },
          react.createElement(
            'div',
            { style: { padding: '10px 10px 4px', fontSize: '11px', fontWeight: 600, color: GRAPH_DIM, textTransform: 'uppercase' } },
            label,
          ),
          rows.length === 0
            ? react.createElement('div', { style: { padding: '2px 10px 6px', fontSize: '12px', color: GRAPH_DIM } }, '—')
            : rows.map((row) =>
                react.createElement(
                  'button',
                  {
                    type: 'button',
                    key: `${key}:${row.name}`,
                    'data-graph-tree-row': row.name,
                    onClick: () => onPickRef(row.name),
                    title: `${row.name}\n${row.hash.slice(0, 8)} ${row.subject}`,
                    style: {
                      display: 'block',
                      boxSizing: 'border-box',
                      width: '100%',
                      padding: '4px 10px',
                      border: 'none',
                      borderRadius: '5px',
                      background: ref === row.name ? `color-mix(in srgb, ${ACCENT} 10%, transparent)` : 'transparent',
                      color: ref === row.name ? ACCENT : 'inherit',
                      fontFamily: UI_FONT,
                      fontSize: '12.5px',
                      textAlign: 'left',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      cursor: 'pointer',
                    },
                  },
                  row.name,
                ),
              ),
        )

      return react.createElement(
        'div',
        { 'data-graph-tree': '', style: { display: 'flex', flexDirection: 'column', minHeight: 0, overflowY: 'auto', fontFamily: UI_FONT } },
        section('head', t('graphHead'), head),
        section('local', t('graphLocal'), local),
        section('remote', t('graphRemote'), remote),
        section('tags', t('graphTags'), tags),
        hasMore
          ? react.createElement(
              'div',
              { style: { padding: '8px 10px', fontSize: '11.5px', color: GRAPH_DIM } },
              t('graphLoadMore'),
            )
          : null,
      )
    }

    /**
     * 提交列表：左边一列泳道 SVG + 右边提交信息。
     *
     * 行高与列宽都是常量，因此这里做**简单的窗口化**：只渲染可见范围内的行，其余用一个
     * 等高的占位 div 撑开。仓库动辄几万条提交，一次渲染几千行会让滚动卡住——而这正是
     * "打开提交图要等很久"的直接原因。
     *
     * @param props - `{ t, rows, layout, commits, selected, onSelect, scrollTop, viewportHeight }`。
     * @returns React 元素。
     */
    function GraphCommitList(props) {
      const { t, commits, layout, selected, onSelect, scrollTop, viewportHeight } = props
      const palette = lanePalette()
      const first = Math.max(0, Math.floor(scrollTop / GRAPH_ROW_HEIGHT) - 5)
      const count = Math.ceil(viewportHeight / GRAPH_ROW_HEIGHT) + 10
      const last = Math.min(commits.length, first + count)
      const lanes = Math.min(layout.lanes, 12)

      const visible = []
      for (let i = first; i < last; i += 1) {
        const commit = commits[i]
        const row = layout.rows[i]
        if (commit === undefined || row === undefined) continue
        const isSelected = selected === commit.hash

        // 泳道：每条边一条路径。同一列上下直连画直线，跨列画贝塞尔——跨列只在合并/分叉
        // 处出现，用曲线能让"这两条线是同一支"一眼看出来。
        const edges = row.edges.map((edge, index) => {
          const x1 = edge.fromLane * GRAPH_LANE_WIDTH + GRAPH_LANE_WIDTH / 2
          const x2 = edge.toLane * GRAPH_LANE_WIDTH + GRAPH_LANE_WIDTH / 2
          const top = 0
          const bottom = GRAPH_ROW_HEIGHT
          const mid = GRAPH_ROW_HEIGHT / 2
          // 根提交（或第一父提交落在窗口外）只有点、没有向下的线：`parents` 为空时不画。
          const hasDown = commit.parents.length > 0
          const d =
            x1 === x2
              ? `M ${x1} ${top} L ${x2} ${hasDown ? bottom : mid}`
              : `M ${x1} ${top} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${bottom}`
          return react.createElement('path', {
            key: `e${index}`,
            d,
            fill: 'none',
            stroke: palette[edge.color % palette.length],
            strokeWidth: 1.6,
            strokeLinecap: 'round',
            'data-graph-edge': edge.kind,
          })
        })

        visible.push(
          react.createElement(
            'div',
            {
              key: commit.hash,
              'data-graph-row': commit.hash,
              'aria-selected': isSelected ? 'true' : undefined,
              onClick: () => onSelect(commit.hash),
              style: {
                position: 'absolute',
                top: `${i * GRAPH_ROW_HEIGHT}px`,
                left: 0,
                right: 0,
                height: `${GRAPH_ROW_HEIGHT}px`,
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                paddingRight: '8px',
                boxSizing: 'border-box',
                background: isSelected ? `color-mix(in srgb, ${ACCENT} 12%, transparent)` : 'transparent',
                cursor: 'pointer',
                fontFamily: UI_FONT,
                fontSize: '12.5px',
              },
            },
            react.createElement(
              'svg',
              {
                width: lanes * GRAPH_LANE_WIDTH,
                height: GRAPH_ROW_HEIGHT,
                viewBox: `0 0 ${Math.max(lanes, 1) * GRAPH_LANE_WIDTH} ${GRAPH_ROW_HEIGHT}`,
                'aria-hidden': 'true',
                style: { flexShrink: 0, overflow: 'visible' },
              },
              edges,
              // 点画在**这一行**的列上，颜色取 `commit` 那条边（它恒存在，哪怕根提交）。
              react.createElement('circle', {
                cx: row.lane * GRAPH_LANE_WIDTH + GRAPH_LANE_WIDTH / 2,
                cy: GRAPH_ROW_HEIGHT / 2,
                r: isSelected ? 4.5 : 3.5,
                fill: palette[(row.edges.find((edge) => edge.kind === 'commit')?.color ?? 0) % palette.length],
                'data-graph-dot': '',
              }),
            ),
            // 分支/标签徽标。只显示前三个，多的收成一个计数——一排标签会把消息挤没。
            ...(commit.refs ?? []).slice(0, 3).map((entry, index) =>
              react.createElement(
                'span',
                {
                  key: `r${index}`,
                  'data-graph-ref': entry.kind,
                  style: {
                    flexShrink: 0,
                    padding: '0 5px',
                    borderRadius: '4px',
                    fontSize: '11px',
                    lineHeight: '16px',
                    background: entry.isHead === true
                      ? `color-mix(in srgb, ${ACCENT} 18%, transparent)`
                      : 'var(--dsw-alias-bg-module-platform, #f0f1f3)',
                    color: entry.isHead === true ? ACCENT : GRAPH_DIM,
                    maxWidth: '160px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                },
                entry.name,
              ),
            ),
            react.createElement(
              'span',
              { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              commit.subject,
            ),
            react.createElement(
              'span',
              { style: { flexShrink: 0, color: GRAPH_DIM, fontFamily: CODE_FONT, fontSize: '11.5px' } },
              commit.short,
            ),
            react.createElement(
              'span',
              { style: { flexShrink: 0, color: GRAPH_DIM, fontSize: '11.5px', maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              commit.author,
            ),
            react.createElement(
              'span',
              { style: { flexShrink: 0, color: GRAPH_DIM, fontSize: '11.5px', fontVariantNumeric: 'tabular-nums' } },
              (commit.committedAt ?? '').slice(0, 10),
            ),
          ),
        )
      }

      return react.createElement(
        'div',
        {
          'data-graph-list': '',
          style: { position: 'relative', height: `${commits.length * GRAPH_ROW_HEIGHT}px` },
        },
        visible,
      )
    }

    /**
     * 一条提交的元信息摘要（标题、哈希、作者、时间、所在分支、正文）。
     *
     * `commit` 与 `revision` 二选一：
     *   * 调用方**已经**有 commit 对象时传 `commit`（提交图那条链路的数据就是它自己取的）；
     *   * 只有一个哈希时传 `revision`，这里自己去取详情。
     * 若调用方已经拿到了详情里的 `containingBranches`，一并传进来，省掉重复取详情。
     *
     * 做成组件而不是两处各写一遍：抽屉的"最近提交"与主区域提交图要显示同一份信息
     * （其中"在 N 个分支中"要跑 N 次 git），各写一遍必然漂移。
     *
     * @param props - `{ t, workspace, commit?, revision?, containingBranches? }`。
     * @returns React 元素或 null（摘要还没到手）。
     */
    function CommitSummary(props) {
      const { t, workspace, revision } = props
      const [fetched, setFetched] = react.useState(undefined)
      // 调用方已经给了 commit 对象（提交图那条链路自己取过详情）就不必再取一次。
      // 也不能把 `containingBranches` 写进依赖数组：它是每次渲染新建的数组字面量，
      // 写进去会让 effect 每次都重跑（实测表现为收起再展开会重复请求一次详情）。
      const needFetch = props.commit === undefined && typeof revision === 'string' && revision !== ''

      react.useEffect(() => {
        if (!needFetch) return undefined
        let alive = true
        void (async () => {
          try {
            const result = await call('commit-detail', { workspace, revision })
            if (alive) setFetched(result)
          } catch {
            // 取不到摘要不算失败：下面的文件列表会自己显示它的错误。
          }
        })()
        return () => {
          alive = false
        }
      }, [needFetch, workspace, revision])

      const commit = props.commit ?? fetched?.commit
      // "在 N 个分支中"来自详情接口（要跑 N 次 git）。调用方**顺手把已经拿到的详情传进来**
      // （`containingBranches`）就不要再多取一次；只给了哈希的自取路径则从取回的详情里读。
      // 早先这里读的是 `props.commit?.containingBranches`——而详情接口把分支集合放在
      // 结果对象的顶层而不是 `commit` 里，于是提交图那条链路永远渲染不出这一行。
      const containing = props.containingBranches ?? fetched?.containingBranches ?? []
      if (commit === undefined) return null

      return react.createElement(
        'div',
        {
          'data-commit-summary': commit.hash ?? '',
          style: { display: 'flex', flexDirection: 'column', gap: '4px', fontFamily: UI_FONT },
        },
        react.createElement('div', { style: { fontSize: '12.5px', fontWeight: 600, overflowWrap: 'anywhere' } }, commit.subject ?? ''),
        react.createElement(
          'div',
          { style: { fontSize: '11.5px', color: GRAPH_DIM, display: 'flex', flexWrap: 'wrap', gap: '8px' } },
          react.createElement('span', { style: { fontFamily: CODE_FONT } }, commit.short ?? ''),
          react.createElement('span', null, `${commit.author ?? ''} <${commit.email ?? ''}>`),
          react.createElement('span', { style: { fontVariantNumeric: 'tabular-nums' } }, (commit.committedAt ?? '').replace('T', ' ').slice(0, 16)),
        ),
        containing.length > 0
          ? react.createElement(
              'div',
              { 'data-graph-containing': '', style: { fontSize: '11.5px', color: ACCENT } },
              t('graphInBranches', { count: containing.length, names: containing.join(', ') }),
            )
          : null,
        (commit.body ?? '') === ''
          ? null
          : react.createElement(
              'div',
              { style: { fontSize: '12px', color: 'inherit', whiteSpace: 'pre-wrap', maxHeight: '120px', overflowY: 'auto' } },
              commit.body,
            ),
      )
    }

    /**
     * 一次提交改动的文件列表：容器 + 每条文件一行（点开才取差异）。
     *
     * @param props - `{ t, files, workspace, revision }`。
     * @returns React 元素。
     */
    function CommitFileList(props) {
      const { t, files, workspace, revision } = props
      return react.createElement(
        'div',
        { 'data-graph-files': '', style: { display: 'flex', flexDirection: 'column' } },
        files.length === 0
          ? react.createElement('div', { style: { padding: '8px 6px', fontSize: '12px', color: GRAPH_DIM } }, t('graphNoFiles'))
          : files.map((file) =>
              react.createElement(CommitFileRow, {
                key: file.path,
                t,
                file,
                workspace,
                revision,
              }),
            ),
      )
    }

    /**
     * 提交详情：元信息 + 改动文件 + 单文件差异。
     *
     * @param props - `{ t, workspace, revision, onOpenCommitFile }`。
     * @returns React 元素。
     */
    function GraphCommitDetail(props) {
      const { t, workspace, revision } = props
      const [state, setState] = react.useState({ phase: 'idle' })

      react.useEffect(() => {
        if (revision === '') {
          setState({ phase: 'idle' })
          return undefined
        }
        let alive = true
        setState({ phase: 'loading' })
        void (async () => {
          try {
            const result = await call('commit-detail', { workspace, revision })
            if (alive) setState({ phase: 'ready', result })
          } catch (cause) {
            const error = cause instanceof Error ? cause : new Error(String(cause))
            if (alive) setState({ phase: 'error', message: error.detail ?? error.message })
          }
        })()
        return () => {
          alive = false
        }
      }, [workspace, revision])

      if (revision === '') {
        return react.createElement(
          'div',
          { style: { padding: '16px', fontSize: '12.5px', color: GRAPH_DIM, fontFamily: UI_FONT } },
          t('graphSelectCommit'),
        )
      }
      if (state.phase === 'loading') return statusBlock(t('loading'))
      if (state.phase === 'error') return statusBlock(state.message, 'error')

      const commit = state.result?.commit
      const files = state.result?.files ?? []
      const containingBranches = state.result?.containingBranches ?? []

      return react.createElement(
        'div',
        { 'data-graph-detail': '', style: { display: 'flex', flexDirection: 'column', minHeight: 0, fontFamily: UI_FONT } },
        react.createElement(
          'div',
          { style: { padding: '10px 12px', borderBottom: `1px solid ${BORDER}`, flexShrink: 0 } },
          react.createElement(CommitSummary, { t, commit, containingBranches }),
        ),
        react.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 12px 4px', flexShrink: 0 } },
          react.createElement('span', { style: { fontSize: '11px', fontWeight: 600, color: GRAPH_DIM, textTransform: 'uppercase' } }, t('changesTitle')),
          react.createElement('span', { 'data-graph-file-count': '', style: { fontSize: '11.5px', color: GRAPH_DIM } }, t('graphFiles', { count: files.length })),
        ),
        react.createElement(
          'div',
          { style: { minHeight: 0, overflowY: 'auto', padding: '0 6px 10px' } },
          react.createElement(CommitFileList, { t, files, workspace, revision }),
        ),
      )
    }

    /**
     * 提交详情里的一条文件，点开才去取它的差异。
     *
     * 按需取而不是随详情一起取：一次提交可能改几百个文件，把全部 diff 一次拉回来会让
     * 打开详情变慢，而用户通常只看其中一两个。
     *
     * @param props - `{ t, file, workspace, revision }`。
     * @returns React 元素。
     */
    function CommitFileRow(props) {
      const { t, file, workspace, revision } = props
      const [open, setOpen] = react.useState(false)
      const [state, setState] = react.useState({ phase: 'idle' })
      const status = file.status?.[0] ?? '?'
      const color = STATUS_COLORS[status] ?? GRAPH_DIM
      const { dir, base } = splitPath(file.path)

      const toggle = () => {
        const next = !open
        setOpen(next)
        if (!next || state.phase === 'ready') return
        setState({ phase: 'loading' })
        void (async () => {
          try {
            const result = await call('commit-file', { workspace, revision, path: file.path })
            setState({ phase: 'ready', result })
          } catch (cause) {
            const error = cause instanceof Error ? cause : new Error(String(cause))
            setState({ phase: 'error', message: error.detail ?? error.message })
          }
        })()
      }

      return react.createElement(
        'div',
        { 'data-graph-file': file.path },
        react.createElement(
          'button',
          {
            type: 'button',
            'data-graph-file-row': file.path,
            'aria-expanded': open,
            onClick: toggle,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '7px',
              boxSizing: 'border-box',
              width: '100%',
              minHeight: '26px',
              padding: '3px 6px',
              border: 'none',
              borderRadius: '5px',
              background: 'transparent',
              color: 'inherit',
              fontFamily: UI_FONT,
              fontSize: '12.5px',
              textAlign: 'left',
              cursor: 'pointer',
            },
          },
          react.createElement(
            'span',
            { style: { flexShrink: 0, padding: '0 4px', borderRadius: '4px', fontSize: '11px', color, background: `color-mix(in srgb, ${color} 14%, transparent)` } },
            status,
          ),
          dir === ''
            ? null
            : react.createElement('span', { style: { flexShrink: 1, minWidth: 0, color: GRAPH_DIM, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl' } }, `\u200e${dir}/`),
          react.createElement('span', { style: { flex: '0 0 auto', fontWeight: 500 } }, base),
          react.createElement(
            'span',
            { style: { flex: '1 1 auto', textAlign: 'right', fontFamily: CODE_FONT, fontSize: '11.5px', color: GRAPH_DIM, fontVariantNumeric: 'tabular-nums' } },
            `${file.added ?? '·'} +  ${file.removed ?? '·'} −`,
          ),
        ),
        open
          ? react.createElement(
              'div',
              { 'data-graph-file-diff': '' },
              state.phase === 'loading'
                ? statusBlock(t('loading'))
                : state.phase === 'error'
                  ? statusBlock(state.message, 'error')
                  : state.result?.binary === true
                    ? statusBlock(t('binaryDiff'))
                    : renderDiff(state.result?.diff ?? ''),
            )
          : null,
      )
    }

    /**
     * 提交图：主区域里的三栏视图（分支树 / 提交列表 / 提交详情）。
     *
     * 挂在 `main` 槽上，由 `sidebar.panellist` 里那个图标打开。这与右侧抽屉（`shell.overlay`
     * 上的自绘浮层）是两条独立的路径：抽屉宽度有限，画不下三栏；而这个视图需要整块主区域。
     *
     * @param props - 槽注入的属性，含渲染器提供的标准钩子。
     * @returns React 元素。
     */
    function CommitGraphView(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      const { sessionId, useSessions, usePanelInfo } = props ?? {}
      // 工作区跟当前会话走；没有会话时退回宿主工作区（与项目改动面板同一套优先级）。
      const sessionWorkspace =
        typeof useSessions === 'function' && sessionId !== undefined
          ? useSessions((state) => state?.byId?.[sessionId]?.cwd)
          : undefined
      const [fallbackWorkspace, setFallbackWorkspace] = react.useState(undefined)
      react.useEffect(() => {
        let alive = true
        void (async () => {
          try {
            const result = await call('roots', {})
            if (alive && typeof result?.current === 'string') setFallbackWorkspace(result.current)
          } catch {
            // 没有可用的兜底工作区：下面会显示空态。
          }
        })()
        return () => {
          alive = false
        }
      }, [])
      const workspace = sessionWorkspace ?? fallbackWorkspace

      const [commits, setCommits] = react.useState([])
      const [hasMore, setHasMore] = react.useState(false)
      const [phase, setPhase] = react.useState('loading')
      const [errorMessage, setErrorMessage] = react.useState('')
      const [selected, setSelected] = react.useState('')
      const [ref, setRef] = react.useState('')
      const [scrollTop, setScrollTop] = react.useState(0)
      const [viewport, setViewport] = react.useState(600)
      const scrollRef = react.useRef(null)

      /** 拉第一页（或换筛选后重拉）。 */
      const reload = react.useCallback(async () => {
        if (workspace === undefined) return
        setPhase('loading')
        setErrorMessage('')
        try {
          const result = await fetchGraph(workspace, { ref })
          if (result?.isRepo === false) {
            setPhase('notRepo')
            setCommits([])
            return
          }
          setCommits(result.commits ?? [])
          setHasMore(result.hasMore === true)
          setPhase('ready')
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error(String(cause))
          setErrorMessage(error.detail ?? error.message)
          setPhase('error')
        }
      }, [workspace, ref])

      react.useEffect(() => {
        void reload()
      }, [reload])

      /** 追加下一页。 */
      const loadMore = react.useCallback(async () => {
        if (workspace === undefined || !hasMore) return
        try {
          const result = await fetchGraph(workspace, { skip: commits.length, ref })
          setCommits((current) => [...current, ...(result.commits ?? [])])
          setHasMore(result.hasMore === true)
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error(String(cause))
          setErrorMessage(error.detail ?? error.message)
          setPhase('error')
        }
      }, [workspace, commits.length, hasMore, ref])

      // 布局用 useMemo：它是这份视图里最贵的一步（O(提交数 × 列数)），而滚动会让组件
      // 重渲染。不 memo 的话每一帧都要重算一遍泳道，滚动会明显掉帧。
      const layout = react.useMemo(() => layoutGraph(commits), [commits])

      const onScroll = react.useCallback((event) => {
        setScrollTop(event.target.scrollTop)
        setViewport(event.target.clientHeight)
      }, [])

      if (phase === 'loading') {
        return react.createElement('div', { 'data-graph-view': '', style: { padding: '24px', fontFamily: UI_FONT } }, statusBlock(t('graphLoading')))
      }
      if (phase === 'notRepo') {
        return react.createElement('div', { 'data-graph-view': '', style: { padding: '24px', fontFamily: UI_FONT } }, statusBlock(t('notRepo', { name: projectName(workspace ?? '') })))
      }
      if (phase === 'error') {
        return react.createElement('div', { 'data-graph-view': '', style: { padding: '24px', fontFamily: UI_FONT } }, statusBlock(errorMessage, 'error'))
      }

      return react.createElement(
        'div',
        {
          'data-graph-view': '',
          style: {
            display: 'grid',
            // 三栏：分支树固定 200px、提交列表自适应、详情固定 320px。
            gridTemplateColumns: '200px minmax(0, 1fr) 320px',
            height: '100%',
            minHeight: 0,
            background: 'var(--dsw-alias-bg-base, #fff)',
            color: 'var(--dsw-alias-label-primary, #202124)',
            fontFamily: UI_FONT,
          },
        },
        // ---- 左：分支树 ----
        react.createElement(
          'div',
          { style: { borderRight: `1px solid ${BORDER}`, minHeight: 0, display: 'flex', flexDirection: 'column' } },
          react.createElement(GraphBranchTree, {
            t,
            commits,
            hasMore,
            ref,
            onPickRef: (name) => setRef((current) => (current === name ? '' : name)),
          }),
        ),
        // ---- 中：提交列表 ----
        react.createElement(
          'div',
          { style: { minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' } },
          react.createElement(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 12px',
                borderBottom: `1px solid ${BORDER}`,
                flexShrink: 0,
                fontSize: '12px',
              },
            },
            react.createElement('span', { style: { fontWeight: 600 } }, t('graphTitle')),
            react.createElement('span', { 'data-graph-count': '', style: { color: GRAPH_DIM } }, t('graphFiles', { count: commits.length })),
            ref === ''
              ? null
              : react.createElement(
                  'button',
                  {
                    type: 'button',
                    'data-graph-clear-ref': '',
                    onClick: () => setRef(''),
                    style: {
                      padding: '1px 6px',
                      borderRadius: '4px',
                      border: `1px solid ${BORDER}`,
                      background: 'transparent',
                      color: ACCENT,
                      fontFamily: UI_FONT,
                      fontSize: '11.5px',
                      cursor: 'pointer',
                    },
                  },
                  `${t('graphFilterRef')}: ${ref} ✕`,
                ),
            layout.truncated
              ? react.createElement('span', { 'data-graph-truncated': '', style: { marginLeft: 'auto', color: GRAPH_DIM, fontSize: '11.5px' } }, t('graphTruncatedLanes'))
              : null,
          ),
          react.createElement(
            'div',
            {
              ref: scrollRef,
              'data-graph-scroll': '',
              onScroll,
              style: { minHeight: 0, flex: '1 1 auto', overflowY: 'auto', overflowX: 'hidden' },
            },
            commits.length === 0
              ? statusBlock(t('graphNoCommits'))
              : react.createElement(GraphCommitList, {
                  t,
                  commits,
                  layout,
                  selected,
                  onSelect: (hash) => setSelected(hash),
                  scrollTop,
                  viewportHeight: viewport,
                }),
            hasMore
              ? react.createElement(
                  'div',
                  { style: { padding: '8px 12px' } },
                  react.createElement(
                    'button',
                    {
                      type: 'button',
                      'data-graph-more': '',
                      onClick: () => void loadMore(),
                      style: {
                        width: '100%',
                        padding: '6px',
                        borderRadius: '6px',
                        border: `1px solid ${BORDER}`,
                        background: 'transparent',
                        color: 'inherit',
                        fontFamily: UI_FONT,
                        fontSize: '12.5px',
                        cursor: 'pointer',
                      },
                    },
                    t('graphLoadMore'),
                  ),
                )
              : null,
          ),
        ),
        // ---- 右：提交详情 ----
        react.createElement(
          'div',
          { style: { borderLeft: `1px solid ${BORDER}`, minHeight: 0, display: 'flex', flexDirection: 'column' } },
          react.createElement(GraphCommitDetail, { t, workspace, revision: selected }),
        ),
      )
    }

    /**
     * 侧栏里的提交图图标。
     *
     * `sidebar.panellist` 的每个 list id 对应 `main` 槽的**同名 key**：侧栏负责画按钮，
     * 主区域负责在有这个 key 时渲染内容。因此这里只需要一个图标。
     *
     * @param props - `{ size, active }`。
     * @returns React 元素。
     */
    function GraphPanelIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16
      const stroke = props?.active === true ? ACCENT : 'currentColor'
      // 一个"分叉的线 + 三个点"的图形：与提交图的语义一致，且在小尺寸下仍然分得清。
      return react.createElement(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke, strokeWidth: 1.5, 'aria-hidden': 'true', 'data-graph-icon': '' },
        react.createElement('path', { d: 'M4 3.5v9M4 7h4.5a3 3 0 0 0 3-3', strokeLinecap: 'round' }),
        react.createElement('circle', { cx: 4, cy: 2.5, r: 1.6 }),
        react.createElement('circle', { cx: 4, cy: 13.5, r: 1.6 }),
        react.createElement('circle', { cx: 12, cy: 4, r: 1.6 }),
      )
    }

    /**
     * 输入框上方的改动概览入口：显示本轮改动文件数，点击在侧边栏查看详情。
     *
     * 同时负责**记录基线**：观察到会话由"未运行"转为"运行"时记一次，那一轮结束后的
     * 改动就都能对上；若发现没有基线而当前空闲，也补记一次（见下方注释）。
     * @param props - 槽注入的属性。
     */
    function ReviewChip(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      const { sessionId, useSessions } = props ?? {}

      const workspace =
        typeof useSessions === 'function' && sessionId !== undefined
          ? useSessions((state) => state?.byId?.[sessionId]?.cwd)
          : undefined

      const running =
        typeof useSessions === 'function' && sessionId !== undefined
          ? useSessions((state) => Boolean(state?.byId?.[sessionId]?.isRunning))
          : false

      const [count, setCount] = react.useState(null)
      const [trouble, setTrouble] = react.useState('')

      // 记录基线：只在"未运行 -> 运行"的跃迁上做一次。
      const wasRunning = react.useRef(false)
      react.useEffect(() => {
        if (workspace === undefined || sessionId === undefined) return
        const justStarted = running && !wasRunning.current
        wasRunning.current = running
        if (!justStarted) return
        void call('baseline', { workspace, sessionId }).catch(() => undefined)
      }, [running, workspace, sessionId])

      // 刷新改动文件数；顺带做基线自愈。
      react.useEffect(() => {
        if (workspace === undefined || sessionId === undefined) return undefined
        let alive = true
        const tick = async () => {
          try {
            const result = await call('changes', { workspace, sessionId })
            if (!alive) return
            if (result?.noBaseline === true && !running) {
              // 空闲时补记：agent 不在运行就不可能产生改动，因此这一刻正是"下一轮开始前"。
              // 需要自愈是因为基线原本只在跃迁时记录，而"挂载时该轮已在跑"与"记录失败后
              // 不再重试"这两种情况都会让它永久缺失。
              await call('baseline', { workspace, sessionId }).catch(() => undefined)
              return
            }
            setCount(result?.isRepo === false || result?.noBaseline === true ? null : (result?.files?.length ?? 0))
            setTrouble('')
          } catch (cause) {
            if (alive) setTrouble(String(cause.message ?? cause))
          }
        }
        void tick()
        const timer = setInterval(() => void tick(), POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [workspace, sessionId, running])

      if (workspace === undefined) return null

      const hasChanges = typeof count === 'number' && count > 0
      const label = count === null ? t('idle') : t('turnFiles', { count })

      return react.createElement(
        'button',
        {
          type: 'button',
          'data-desktop-review': '',
          'aria-label': t('title'),
          title: trouble === '' ? t('openInSidebar') : trouble,
          onClick: () => {
            const sidebar = props?.sidebarRight
            if (sidebar === undefined) {
              setTrouble(t('sidebarUnavailable'))
              return
            }
            try {
              // 每次读取侧栏的真实状态，兼容手动收起、关闭标签和切换其它标签。
              // 收起保留标签及已展开的差异，下一次点击可以继续查看。
              if (sidebar.isExpanded?.() && sidebar.active?.()?.kind === KIND &&
                  typeof sidebar.toggleExpanded === 'function') {
                sidebar.toggleExpanded()
              } else if (sessionId !== undefined && typeof sidebar.openTabIn === 'function') {
                sidebar.openTabIn(sessionId, KIND, {})
              } else if (typeof sidebar.openTab === 'function') {
                sidebar.openTab(KIND, {})
              } else {
                // 诊断信息，面向开发者，列出服务实际提供的键名以便定位契约变化。
                // 标记必须与代码同一行——检查器是逐行判定的。
                setTrouble(`sidebarRight 没有 openTab/openTabIn（实际键：${Object.keys(sidebar).join(',')}）`) // i18n-allow
                return
              }
              setTrouble('')
            } catch (cause) {
              // 不静默吞掉：打不开侧边栏时把原因显示在悬停提示里，否则表现只是"点了没反应"，
              // 从界面完全看不出是服务缺失、方法名不符，还是标签类型没登记。
              setTrouble(String(cause?.message ?? cause))
            }
          },
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            flex: '0 1 auto',
            minWidth: 0,
            maxWidth: '100%',
            gap: '6px',
            padding: '0 8px',
            height: '28px',
            borderRadius: '8px',
            border: `1px solid ${trouble === '' ? 'var(--dsw-alias-border-l1, #eceef2)' : '#6b3b3b'}`,
            background: 'var(--dsh-review-chip-bg, var(--dsw-alias-bg-base, #fff))',
            color: trouble === '' ? (hasChanges ? ACCENT : 'var(--dsw-alias-label-secondary)') : 'var(--dsw-alias-state-error-primary, #d44747)',
            fontSize: '12px',
            fontFamily: UI_FONT,
            fontWeight: 500,
            whiteSpace: 'nowrap',
            cursor: 'pointer',
          },
        },
        // 一个"清单"小图标，避免依赖图标库。
        react.createElement(
          'svg',
          { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', style: { flexShrink: 0 } },
          react.createElement('path', {
            d: 'M3 4.5h10M3 8h10M3 11.5h6',
            stroke: 'currentColor',
            strokeWidth: 1.3,
            strokeLinecap: 'round',
          }),
        ),
        react.createElement('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, label),
      )
    }

    /**
     * 挂载插件。
     * @param ctx - 客户端 cordis 上下文。
     */
    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = name
        style.textContent = styles
        document.head.appendChild(style)
        return () => style.remove()
      })
      // 诊断挂钩：侧边栏的"打开标签"在会话未被采纳时**静默返回**，失败只表现为
      // "点了没反应"，从界面无法判断是服务缺失、会话不匹配还是标签类型没登记。
      // 把服务挂到 window 上，使这条链路可以被脚本断言。
      // 键名带插件前缀，避免与官方或其它插件的全局冲突。
      // 稳定的诊断路径：把侧边栏服务挂到 window 上。
      //
      // 侧边栏的"打开标签"在会话未被采纳时**静默返回**，失败只表现为"点了没反应"，
      // 从界面无法判断是服务缺失、标签类型没登记，还是会话不匹配。留着这个引用，
      // 就可以在渲染进程里直接调用并看到抛出的原因——定位这个问题时正是靠它。
      if (typeof window !== 'undefined') window.__dshDesktopReview = ctx.sidebarRight

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'review: dictionaries')

      ctx.effect(
        () =>
          ctx.slots.inject(CHIP_SLOT, () =>
            ctx.slots.register(
              {
                name: CHIP_SLOT,
                id: ID,
                order: ORDER,
                locale: NS,
                // 把官方侧边栏服务交给概览入口，供它打开差异标签。
                inject: () => ({ t: ctx.locale.bind(NS), sidebarRight: ctx.sidebarRight }),
              },
              ReviewChip,
            ),
          ),
        'dsh-client-ui-review: review chip',
      )

      // 项目页的常驻面板入口。挂在这个槽位是因为它**在没有会话时也渲染**——
      // 官方右侧栏的内容槽带 scope: "session"，项目页根本没有它（实测）。
      ctx.effect(
        () =>
          ctx.slots.inject(HERO_SLOT, () =>
            ctx.slots.register(
              {
                name: HERO_SLOT,
                id: 'review-project-changes',
                order: 30,
                locale: NS,
                // 只注入文案函数。**绝不能注入 useSessions / useWorkspaces。**
                //
                // 这两个是渲染器提供给每个 root 槽位的**标准钩子**：官方
                // `dsh-client-ui-session` 用 `slots.provideRoot({ hooks: { sessions } })`、
                // `dsh-client-ui-workspace` 同理提供了 `workspaces`，渲染器按
                // `use<Name>` 约定把它们绑成 props（`use${Capitalize<N>}`）。
                //
                // 而渲染器合并 props 的顺序是 `{ ...kit, ...injected, ... }`——
                // **inject 会盖掉 kit**，且 `bindInjectSources` 不会剔除 undefined 值。
                // 这里此前写的是 `ctx.sessions?.useSessions ?? ctx.sessions?.use`，而
                // sessions 服务上并没有这两个成员（它只有 list / open / create / fork …），
                // 于是注入进去的其实是一个 `undefined`，恰好把标准钩子覆盖掉，组件里
                // `typeof useSessions === 'function'` 永远为假。
                //
                // 这正是"项目级面板拿不到当前会话的工作区"的真正原因。1.3.1 把它误判为
                // "全局覆盖层不注入 useSessions"，于是改成问宿主要 `process.cwd()`——那
                // 只是绕过了本插件自己造成的遮蔽。什么都不注入，标准钩子就会原样送到。
                inject: () => ({ t: ctx.locale.bind(NS) }),
              },
              HeroChangesTrigger,
            ),
          ),
        'dsh-client-ui-review: project changes trigger',
      )

      // 把标签**类型**注册进侧边栏的类型表。
      //
      // 这一步与下面的槽位注册是两件事，缺一不可：
      //   * 类型表（这里）决定 `openTab(kind)` 能否找到该类型——缺了会抛
      //     `no tab type is registered as "…"`；
      //   * 槽位（下面）决定找到类型后由哪个组件渲染正文。
      // 早先只注册了槽位，于是点击后表现为"没反应"：openTab 拿不到类型。
      ctx.effect(() => {
        const registry = ctx.sidebarRightTabs
        if (registry === undefined) return () => undefined
        return registry.register({
          id: KIND,
          kind: KIND,
          // 本标签没有对应的资源地址；`title` 只在标签栏显示固定文案。
          title: () => ctx.locale.bind(NS)('title'),
        })
      }, 'dsh-client-ui-review: tab type')

      // 差异正文：keyed 槽位，key 即上面注册的标签类型。
      ctx.effect(
        () =>
          ctx.slots.inject(TAB_SLOT, () =>
            ctx.slots.register(
              {
                name: TAB_SLOT,
                key: KIND,
                locale: NS,
                inject: () => ({ t: ctx.locale.bind(NS) }),
              },
              ReviewTab,
            ),
          ),
        'dsh-client-ui-review: review tab body',
      )

      ctx.effect(
        () =>
          ctx.slots.inject(TAB_TITLE_SLOT, () =>
            ctx.slots.register(
              {
                name: TAB_TITLE_SLOT,
                key: KIND,
                locale: NS,
                inject: () => ({ t: ctx.locale.bind(NS) }),
              },
              ReviewTabTitle,
            ),
          ),
        'dsh-client-ui-review: review tab title',
      )

      // 提交图：**两处注册缺一不可**。
      //
      //   `sidebar.panellist`（list / root）——侧栏那一列图标，`id` 就是主区域的 key；
      //   `main`（keyed / root）——按同一个 key 渲染内容，由布局侧 `ctx.layout.selectPanel(id)` 切换。
      //
      // 与项目改动抽屉（shell.overlay 上的自绘浮层）是两条独立路径：抽屉最多 980px 宽，
      // 画不下"分支树 + 提交列表 + 详情"三栏；这个视图要整块主区域。
      ctx.effect(
        () =>
          ctx.slots.inject(PANEL_SLOT, () =>
            ctx.slots.register(
              {
                name: PANEL_SLOT,
                id: GRAPH_ID,
                // 排在官方那些图标之后。
                order: 80,
                // label 支持 thunk：语言切换时由 owner 重新读取，不需要重新注册。
                label: () => ctx.locale.bind(NS)('graphPanelLabel'),
              },
              GraphPanelIcon,
            ),
          ),
        'dsh-client-ui-review: graph panel icon',
      )

      ctx.effect(
        () =>
          ctx.slots.inject(MAIN_SLOT, () =>
            ctx.slots.register(
              {
                name: MAIN_SLOT,
                key: GRAPH_ID,
                locale: NS,
                // 只注入文案函数。**绝不能注入 useSessions / usePanelInfo。**
                // 这两个是渲染器提供给 root 槽位的标准钩子，而渲染器合并 props 的顺序是
                // `{ ...kit, ...injected, ... }`——inject 会盖掉 kit，且 `bindInjectSources`
                // 不剔除 undefined。1.3.5 修过一次同样的坑（那时是项目级面板拿不到当前会话），
                // 这里不能再犯。
                inject: () => ({ t: ctx.locale.bind(NS) }),
              },
              CommitGraphView,
            ),
          ),
        'dsh-client-ui-review: commit graph view',
      )
    }

    exports.name = name
    exports.apply = apply
    // ---- 只给测试用的钩子 ------------------------------------------------------
    //
    // 泳道算法在本文件里有一份**内联副本**（原因见上面那段注释）。`scripts/test-graph-layout-parity.mjs`
    // 需要对同一批输入跑"这里的内联版本"与 `lib/graph-layout.js`，逐字段比较结果，才能
    // 保证两个副本不漂移——否则唯一的验证手段是起一个 Electron 去看图，没人会为改一行
    // 算法去跑那个。
    //
    // 因此把这两个引用挂到导出上。它们不是公开 API，也不被 `apply` 使用；命名带
    // `ForTest` 后缀，避免被误当成插件契约的一部分。
    exports.__graphLayoutForTest = layoutGraph
    exports.__graphColorCountForTest = GRAPH_COLOR_COUNT
    exports.__graphLaneMaxForTest = GRAPH_LANE_MAX
    // 暂存区块的两个内部件同样只给测试用：`classifyEntry` 是"一个文件属于哪一组"的
    // 唯一判定（porcelain 的 XY 两列），错一处就会把文件分错组，而那是纯函数，
    // 直接断言比隔着界面点更可靠。
    exports.__stagingClassifyForTest = classifyEntry
    exports.__stagingSectionForTest = StagingSection
    // 文件列表也导出给测试：它是"总变动行数"与"暂存标记"的渲染处，而这两个正是
    // "外部数字对不上""看不出哪些已暂存"两个反馈的落点，必须能被断言钉住。
    exports.__fileListForTest = FileList
    // 抽屉本体也导出给测试：外观层（头栏、提交卡片、分组头、行内动作的悬停规则）都在它
    // 的 DOM 结构上，隔着两层入口组件（`HeroChangesTrigger` → `ReviewPanel`）断言会让
    // 测试被无关的状态耦合住（实测踩到过：换一个 hook key 也拿不到干净状态，因为嵌套
    // 组件的 hook 槽按树中位置归属）。
    exports.__reviewPanelForTest = ReviewPanel
    // 四个必需服务：slots 与 locale 是插件机制要求（缺 slots 会导致整个界面白屏）；
    // sidebarRight 用于打开标签，sidebarRightTabs 用于把标签类型注册进它的类型表。
    //
    // `sessions` 与 `workspaces` 已不再被本插件直接读取（当前工作区改用渲染器注入的
    // 标准钩子 `useSessions`），但仍然声明：官方 `dsh-client-ui-session` /
    // `dsh-client-ui-workspace` 正是用 `slots.provideRoot({ hooks: { sessions/workspaces } })`
    // 把 root source 提供出来的，声明它们可以保证这两个服务先于本项目级入口就位。
    exports.inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'sessions', 'workspaces', 'layout']
    return module.exports
  },
})
