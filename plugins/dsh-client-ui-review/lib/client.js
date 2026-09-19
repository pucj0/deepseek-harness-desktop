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

    /** 侧边栏标签正文与标题的槽位。 */
    const TAB_SLOT = 'sidebar.right.pane.tab'
    const TAB_TITLE_SLOT = 'sidebar.right.pane.tab.title'

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

    const zh = {
      idle: '本轮暂无改动',
      turnFiles: '本轮修改 {count}',
      files: '{count} 个文件',
      title: '本轮修改审查',
      summary: '{files} 个文件，+{added} −{removed}',
      noBaseline: '本轮尚未记录基线。开始一轮对话后会自动记录。',
      notRepo: '当前工作区（{name}）不是 git 仓库。',
      clean: '本轮没有改动任何文件。',
      projectTitle: '项目改动',
      noWorkspace: '当前没有可用的工作区。',
      projectIdle: '项目暂无改动',
      workspaceClean: '这个项目当前没有未提交的改动。',
      workspaceEmpty: '这个仓库还没有任何提交。',
      collapse: '收起面板',
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
      sidebarUnavailable: '当前界面未能提供侧边栏，无法展示详情。',
    }

    const en = {
      idle: 'No changes this turn',
      turnFiles: 'Changes {count}',
      files: '{count} files',
      title: 'Turn changes',
      summary: '{files} files, +{added} −{removed}',
      noBaseline: 'No baseline recorded for this turn yet. It is captured when a turn starts.',
      notRepo: 'The current workspace ({name}) is not a git repository.',
      clean: 'This turn did not change any file.',
      projectTitle: 'Project changes',
      noWorkspace: 'No workspace is available.',
      projectIdle: 'No project changes',
      workspaceClean: 'This project has no uncommitted changes.',
      workspaceEmpty: 'This repository has no commits yet.',
      collapse: 'Collapse panel',
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
      sidebarUnavailable: 'The sidebar is unavailable, so details cannot be shown.',
    }

    /** git 的 name-status 首字母到字典键。 */
    const STATUS_KEYS = { A: 'statusAdded', M: 'statusModified', D: 'statusDeleted', R: 'statusRenamed' }

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
            style: {
              display: 'flex',
              gap: '10px',
              background,
              color: fg,
              lineHeight: '1.5',
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
        if (workspace === undefined || sessionId === undefined) return
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
        return react.createElement('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' } }, t('loading'))
      }
      if (phase === 'error') {
        // `noWorkspace` 是内部代号，翻成给用户看的话。
        return react.createElement(
          'div',
          { style: { color: '#f0c8c8', fontSize: '12px' } },
          message === 'noWorkspace' ? t('noWorkspace') : message,
        )
      }
      if (result?.isRepo === false) {
        return react.createElement(
          'div',
          { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' } },
          t('notRepo', { name: projectName(props.workspace) }),
        )
      }
      const commits = result?.commits ?? []
      if (commits.length === 0) {
        return react.createElement('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' } }, t('noHistory'))
      }
      return react.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column' } },
        commits.map((commit) =>
          react.createElement(
            'div',
            {
              key: commit.hash,
              className: 'dsh-review-history',
              title: `${commit.hash}\n${commit.author} · ${commit.date}`,
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: '5px',
                padding: '10px 2px',
                fontSize: '13px',
                fontFamily: UI_FONT,
                lineHeight: '1.6',
              },
            },
            react.createElement(
              'span',
              { style: { color: 'var(--dsw-alias-label-primary)', minWidth: 0, overflowWrap: 'anywhere' } },
              commit.subject,
            ),
            react.createElement(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: '10px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } },
              react.createElement('span', { style: { color: ACCENT, fontFamily: CODE_FONT } }, commit.short),
              react.createElement('span', { style: { fontVariantNumeric: 'tabular-nums' } }, commit.date),
            ),
          ),
        ),
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
            width: 'min(560px, calc(100vw - 120px))',
            display: 'flex',
            flexDirection: 'column',
            borderLeft: '1px solid var(--dsw-alias-border-l2, #3d3d45)',
            background: 'var(--dsw-alias-bg-base, #fff)',
            color: 'var(--dsw-alias-label-primary)',
            fontFamily: UI_FONT,
            boxShadow: '-12px 0 36px rgba(0,0,0,.10)',
            overflow: 'hidden',
          },
        },
        react.createElement(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '16px 18px',
              background: 'var(--dsw-alias-bg-module-platform, #f5f6f7)',
              borderBottom: '1px solid var(--dsw-alias-border-l1, #2f2f36)',
              fontSize: '14px',
              color: 'var(--dsw-alias-label-primary)',
            },
          },
          react.createElement('strong', { style: { fontWeight: 600 } }, title),
          react.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' } }, t('files', { count: files.length })),
          react.createElement('span', { style: { flex: 1 } }),
          react.createElement(
            'button',
            {
              type: 'button',
              onClick: () => panelStore.set(false),
              title: t('collapse'),
              'aria-label': t('collapse'),
              style: {
                border: '1px solid var(--dsw-alias-border-l2, #3d3d45)',
                background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-2, #2a2a31))',
                color: 'var(--dsw-alias-label-primary)',
                borderRadius: '6px',
                width: '28px',
                height: '28px',
                fontFamily: UI_FONT,
                cursor: 'pointer',
                lineHeight: 1,
              },
            },
            '×',
          ),
        ),
        // 工作区选择器已移除：工作区跟随当前对话，不可编辑、也不展示路径。
        react.createElement(
          'div',
          { style: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '16px 18px 20px' } },
          react.createElement(FileList, {
            t,
            result: active.result,
            phase: active.phase,
            message: active.message,
            workspace,
            sessionId,
            onChanged: scope === 'workspace' ? workspaceChanges.reload : turn.reload,
          }),
          // 提交历史只在项目级面板出现：会话内的标签讲的是"本轮"，与历史无关。
          scope === 'workspace'
            ? react.createElement(
                'div',
                { style: { marginTop: '20px', paddingTop: '16px', borderTop: '1px solid var(--dsw-alias-border-l1, #2f2f36)' } },
                react.createElement(
                  'div',
                  { style: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginBottom: '4px' } },
                  t('historyTitle'),
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
        return react.createElement('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', padding: '10px 2px' } }, t('loading'))
      }
      if (phase === 'error') {
        // `noWorkspace` 是一个内部代号，翻成给用户看的话。
        const text = message === 'noWorkspace' ? t('noWorkspace') : message
        return react.createElement('div', { style: { color: '#f0c8c8', fontSize: '12px', padding: '10px 2px' } }, text)
      }
      if (result?.isRepo === false) {
        return react.createElement(
          'div',
          { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', padding: '10px 2px' } },
          t('notRepo', { name: projectName(props.workspace) }),
        )
      }
      if (result?.empty === true) {
        return react.createElement(
          'div',
          { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', padding: '10px 2px' } },
          t('workspaceEmpty'),
        )
      }
      if (result?.noBaseline === true) {
        return react.createElement('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', padding: '10px 2px' } }, t('noBaseline'))
      }
      if (files.length === 0) {
        // 项目级与轮次级用不同措辞：前者是"没有未提交改动"，后者是"本轮没改文件"。
        const key = result?.scope === 'workspace' ? 'workspaceClean' : 'clean'
        return react.createElement('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', padding: '10px 2px' } }, t(key))
      }

      return react.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px', fontFamily: UI_FONT } },
        react.createElement(
          'div',
          { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', padding: '0 2px 4px', fontVariantNumeric: 'tabular-nums' } },
          t('summary', { files: files.length, added, removed }),
        ),
        files.map((file) => {
          const diff = byFile.get(file.path) ?? ''
          const open = expanded === file.path
          const working = busy === file.path
          return react.createElement(
            'div',
            { key: file.path },
            react.createElement(
              'div',
              { style: { display: 'flex', alignItems: 'stretch', gap: '4px' } },
              react.createElement(
                'button',
                {
                  type: 'button',
                  className: 'dsh-review-file',
                  'aria-expanded': open,
                  onClick: () => setExpanded(open ? '' : file.path),
                  title: file.path,
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    flex: '1 1 auto',
                    minWidth: 0,
                    textAlign: 'left',
                    padding: '10px',
                    border: `1px solid ${open ? 'color-mix(in srgb, ' + ACCENT + ' 30%, transparent)' : 'var(--dsh-review-row-border, var(--dsw-alias-border-l1, #eceef2))'}`,
                    borderRadius: '9px',
                    background: open ? 'var(--dsw-alias-interactive-bg-hover-accent, #eef2ff)' : 'var(--dsh-review-row-bg, var(--dsw-alias-bg-layer-2, #26262c))',
                    color: 'var(--dsw-alias-label-primary)',
                    fontSize: '12px',
                    fontFamily: UI_FONT,
                    lineHeight: 1.5,
                    cursor: 'pointer',
                  },
                },
                react.createElement(
                  'span',
                  { style: { color: STATUS_COLORS[file.status?.[0]] ?? 'var(--dsw-alias-label-secondary)', flexShrink: 0, fontSize: '12px', fontWeight: 500 } },
                  t(STATUS_KEYS[file.status?.[0]] ?? 'statusOther'),
                ),
                react.createElement(
                  'span',
                  { style: { flex: 1, minWidth: 0, overflowWrap: 'anywhere', lineHeight: 1.5, fontFamily: CODE_FONT } },
                  file.path,
                ),
                react.createElement(
                  'span',
                  { style: { whiteSpace: 'nowrap', fontSize: '12px', fontVariantNumeric: 'tabular-nums', flexShrink: 0 } },
                  react.createElement('span', { style: { color: ADDED } }, `+${file.added ?? 0}`),
                  ' ',
                  react.createElement('span', { style: { color: REMOVED } }, `−${file.removed ?? 0}`),
                ),
              ),
              // 还原按钮：点击后弹出确认框（见 ConfirmRevertDialog）。
              react.createElement(
                'button',
                {
                  type: 'button',
                  className: 'dsh-review-revert',
                  disabled: working,
                  title: t('revert'),
                  onClick: () => setConfirming(file.path),
                  style: {
                    flex: '0 0 auto',
                    padding: '0 10px',
                    borderRadius: '9px',
                    border: '1px solid var(--dsh-review-row-border, var(--dsw-alias-border-l1, #eceef2))',
                    background: 'var(--dsh-review-row-bg, var(--dsw-alias-bg-layer-2, #26262c))',
                    color: 'var(--dsw-alias-label-secondary)',
                    fontSize: '12px',
                    fontFamily: UI_FONT,
                    cursor: working ? 'default' : 'pointer',
                    whiteSpace: 'nowrap',
                  },
                },
                working ? t('reverting') : t('revert'),
              ),
            ),
            open
              ? react.createElement(
                  'div',
                  {
                    style: {
                      marginTop: '4px',
                      padding: '0',
                      border: '1px solid var(--dsw-alias-border-l1, #2f2f36)',
                      borderRadius: '9px',
                      background: 'var(--dsw-alias-bg-layer-1, #17171b)',
                      // 等宽字体是差异视图可读的基础：比例字体下增删对齐会全乱。
                      fontSize: '12px',
                      lineHeight: 1.6,
                      fontFamily: CODE_FONT,
                      fontVariantLigatures: 'none',
                      // 横向溢出才滚动；纵向交给抽屉整体，避免嵌套滚动条。
                      overflowX: 'auto',
                    },
                  },
                  isBinaryDiff(diff)
                    ? react.createElement(
                        'div',
                        { style: { color: 'var(--dsw-alias-label-secondary)', padding: '8px', fontFamily: UI_FONT } },
                        t('binaryDiff'),
                      )
                    : react.createElement('div', { style: { padding: '6px 0' } }, renderDiff(diff)),
                )
              : null,
          )
        }),
        result?.truncated === true
          ? react.createElement('div', { style: { marginTop: '4px', color: '#c9a0a0', fontSize: '11.5px' } }, t('truncated'))
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
    }

    exports.name = name
    exports.apply = apply
    // 四个必需服务：slots 与 locale 是插件机制要求（缺 slots 会导致整个界面白屏）；
    // sidebarRight 用于打开标签，sidebarRightTabs 用于把标签类型注册进它的类型表。
    //
    // `sessions` 与 `workspaces` 已不再被本插件直接读取（当前工作区改用渲染器注入的
    // 标准钩子 `useSessions`），但仍然声明：官方 `dsh-client-ui-session` /
    // `dsh-client-ui-workspace` 正是用 `slots.provideRoot({ hooks: { sessions/workspaces } })`
    // 把 root source 提供出来的，声明它们可以保证这两个服务先于本项目级入口就位。
    exports.inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'sessions', 'workspaces']
    return module.exports
  },
})
