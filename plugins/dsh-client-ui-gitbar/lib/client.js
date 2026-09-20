// gitbar 的客户端半边。
//
// 在 `conversation.input.dock` 提供输入框上方的工具条。分支与改动审查共享这一排，
// 不再占用发送按钮前的空间；该 list 槽保留官方输入框和其它 dock 条目。
//
// 这个文件刻意手写、不引入打包链：客户端 bundle 的契约很简单——调用 shell 提供的
// `window.__ModuleLoader__.load({ id, factory })`，在 factory 里 require 共享的基线
// 模块表，导出 `{ name, apply }`。官方包（如 dsh-client-ui-agent-preset/lib/client.js）
// 用的就是这个格式。
//
// **一个插件只能有一个客户端 bundle**（`package.json` 的 `exports["./client"]` 是单值，
// 见 dsh-client-modules 的 clientExportOf），因此分支徽章、源代码管理面板、右键菜单与
// 各个对话框全部住在这一个文件里。分节组织：
//   1. 常量与字典
//   2. 请求层（call / send / describeError）
//   3. 纯展示片段（图标、行、分组）
//   4. 源代码管理面板与分支徽章
//   5. 对话框与右键菜单
//   6. 槽位挂载
//
// 数据来自 host 半边注册的 HTTP 路由（同源，无需 token——服务端已经用 cookie 认证
// 过这个页面）：GET status / GET branches / POST checkout / POST branch/* / POST remote。
window.__ModuleLoader__.load({
  id: 'dsh-client-ui-gitbar',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const UI_FONT = 'var(--dsw-font-family, "Segoe UI", "Microsoft YaHei", sans-serif)'
    const CODE_FONT = 'var(--ds-font-family-code, Consolas, "Microsoft YaHei", monospace)'
    const ACCENT = 'var(--dsw-alias-state-business-primary, #4d6bfe)'
    const SURFACE = 'var(--dsw-alias-bg-base, #fff)'
    const BORDER = 'var(--dsw-alias-border-l1, #eceef2)'
    const SECONDARY = 'var(--dsw-alias-label-secondary, #6b7280)'
    const TERTIARY = 'var(--dsw-alias-label-tertiary, #9aa0a6)'
    const APPROVAL = 'var(--dsw-alias-state-warn-label, #9a6700)'
    const DANGER = 'var(--dsw-alias-state-error-primary, #d44747)'

    /** 稳定插件名，用于诊断。 */
    const name = 'dsh-client-ui-gitbar'

    /** 输入框上方的整行扩展点，以及供审查插件使用的会话级子槽。 */
    const SLOT = 'conversation.input.dock'
    const ACTION_SLOT = 'dsh.desktop.composer.actions'

    /** 注册 id，卸载时按它撤销。 */
    const ID = 'desktop-context-bar'

    /** 放在待办、目标和消息队列之后，紧贴输入框。 */
    const ORDER = 100

    /** 路由前缀，与 host 半边保持一致。 */
    const API = '/dsh-desktop/gitbar'

    /** 本地化命名空间：字典注册到它下面，`ctx.locale.bind(NS)` 得到 `t`。 */
    const NS = 'gitbar'

    /** 分支列表中"最近"分组的条数上限。 */
    const RECENT_LIMIT = 8

    /**
     * 两套字典。
     *
     * 与官方客户端插件同一做法（见 dsh-client-ui-directory-picker-browse）：在 apply
     * 里 `ctx.locale.register(NS, { zh, en })`，再通过槽的 `inject` 把
     * `ctx.locale.bind(NS)` 得到的 `t` 传给组件。
     *
     * 注意 host 侧不返回任何自然语言提示——它不知道界面语言，只回稳定的 code，
     * 由这里的 `error_<code>` 渲染。git 自己的报错原文照常显示，因为它是权威信息，
     * 翻译反而失真。
     */
    const zh = {
      sourceControl: '源代码管理',
      switching: '切换中…',
      working: '处理中…',
      switchBranch: '切换分支',
      searchBranches: '搜索分支和操作',
      loadingBranches: '正在加载分支…',
      noMatchingBranches: '没有匹配的分支或操作',
      currentBranch: '当前分支',
      remoteTag: '远程',
      stashing: '暂存并切换中…',
      stashAndSwitch: '暂存改动并切换到 {branch}',
      hintCommitOrStash: '提交这些改动，或用下方的「暂存并切换」。',
      noBranches: '没有可切换的分支',
      remoteBranch: '远程分支（切换时会自动创建本地跟踪分支）',
      localBranch: '本地分支',
      stashed: '改动已存入 stash {ref}，可用 git stash pop 恢复',
      detachedNotice: '已进入游离 HEAD（签出的是标记或提交，不在任何分支上）',
      // ---- 快捷操作 ----
      actionUpdate: '更新项目…',
      actionCommit: '提交…',
      actionPush: '推送…',
      actionNewBranch: '新建分支…',
      actionCheckoutRef: '签出标记或修订…',
      // ---- 分组标题 ----
      sectionRecent: '最近',
      sectionLocal: '本地',
      sectionRemote: '远程',
      // ---- 分组标题上的按钮 ----
      refresh: '刷新',
      fetchAll: '抓取全部远端',
      // ---- 行的附属信息 ----
      behind: '落后上游 {count} 个提交',
      ahead: '领先上游 {count} 个提交',
      diverged: '与上游已分叉（领先 {ahead}、落后 {behind}）',
      upstreamGone: '上游分支已不存在',
      inSync: '与上游一致',
      trackedBy: '跟踪 {upstream}',
      moreActions: '更多操作',
      // ---- 右键菜单 ----
      menuCheckout: '签出',
      menuNewFrom: '从「{name}」新建分支…',
      menuMergeInto: '将「{name}」合并到当前分支',
      menuRebaseOnto: '将当前分支变基到「{name}」',
      menuPush: '推送…',
      menuRename: '重命名…',
      menuDelete: '删除',
      menuFetch: '抓取',
      // ---- 对话框 ----
      dialogNewTitle: '新建分支',
      dialogRenameTitle: '重命名分支',
      dialogMergeTitle: '合并分支',
      dialogRebaseTitle: '变基',
      dialogCheckoutRefTitle: '签出标记或修订',
      dialogFieldName: '分支名',
      dialogFieldFrom: '起点',
      dialogFieldRef: '标记或提交',
      dialogFromHead: '当前 HEAD',
      dialogCheckoutAfter: '创建后立即切换过去',
      dialogMergeNoFf: '始终产生合并提交（--no-ff）',
      dialogConfirm: '确定',
      dialogCancel: '取消',
      dialogRefHint: '可以填标签（如 v1.0.0）、分支或提交哈希。签出标记会进入游离 HEAD。',
      mergingInto: '把「{name}」合并到「{into}」',
      rebasingOnto: '把「{branch}」变基到「{onto}」',
      confirmDeleteTitle: '删除分支',
      confirmDeleteBody: '即将删除「{name}」。',
      confirmDeleteUnmerged: '该分支有未合并的提交，删除后这些提交将无法从界面上找回。',
      confirmDeleteRemote: '这会同时删除远端「{remote}」上的这个分支，其它人也会受影响。',
      confirmDeleteButton: '删除',
      confirmForceDeleteButton: '仍然删除',
      forceDeleteNote: '需要一个确认：这个分支尚未并入当前分支。',
      // ---- 进行中的操作（冲突等）----
      mergeInProgress: '有未完成的合并。解决冲突后提交，或中止合并。',
      rebaseInProgress: '有未完成的变基。解决冲突后继续，或中止变基。',
      abortMerge: '中止合并',
      abortRebase: '中止变基',
      aborted: '已中止',
      pushRejectedHint: '远端有你本地没有的提交，先「更新项目」再推送。',
      emptyCherryPick: '该提交的改动已经在当前分支里，没有需要摘取的内容。',
      // ---- 错误（按 host 的稳定 code）----
      error_localChanges: '切换被 git 拒绝：有未提交改动会被覆盖。',
      error_stashFailed: '暂存失败。',
      error_nothingToStash: '工作区没有未提交改动，可直接切换。',
      error_invalidBranch: '分支名不合法，已拒绝。',
      error_invalidRevision: '修订不合法，已拒绝（只接受分支名或提交哈希）。',
      error_invalidRemote: '远端名不合法，已拒绝。',
      error_workspaceNotAllowed: '该工作区未在本应用中登记，已拒绝访问。',
      error_branchExists: '同名分支已存在，换个名字。',
      error_noSuchBranch: '找不到这个分支。',
      error_noSuchRef: '找不到这个分支、标记或提交。',
      error_branchCheckedOut: '不能删除当前所在的分支。',
      error_notMerged: '该分支有未合并的提交。',
      error_mergeConflict: '合并有冲突，需要在终端里解决后提交。',
      error_rebaseConflict: '变基有冲突，需要在终端里解决。',
      error_cherryPickConflict: '摘取有冲突，需要在终端里解决。',
      error_pushRejected: '推送被拒绝：远端有更早的提交。',
      error_networkFailed: '与远端通信失败（网络或凭据问题）。',
      error_unknown: '操作失败。',
    }

    const en = {
      sourceControl: 'Source Control',
      switching: 'Switching…',
      working: 'Working…',
      switchBranch: 'Switch branch',
      searchBranches: 'Search branches and actions',
      loadingBranches: 'Loading branches…',
      noMatchingBranches: 'No matching branches or actions',
      currentBranch: 'Current branch',
      remoteTag: 'remote',
      stashing: 'Stashing and switching…',
      stashAndSwitch: 'Stash changes and switch to {branch}',
      hintCommitOrStash: 'Commit these changes, or use "Stash changes and switch" below.',
      noBranches: 'No branches to switch to',
      remoteBranch: 'Remote branch (a local tracking branch is created on switch)',
      localBranch: 'Local branch',
      stashed: 'Changes saved to {ref}; restore them with git stash pop',
      detachedNotice: 'Detached HEAD (you checked out a tag or commit, not a branch)',
      actionUpdate: 'Update project…',
      actionCommit: 'Commit…',
      actionPush: 'Push…',
      actionNewBranch: 'New branch…',
      actionCheckoutRef: 'Checkout tag or revision…',
      sectionRecent: 'Recent',
      sectionLocal: 'Local',
      sectionRemote: 'Remote',
      refresh: 'Refresh',
      fetchAll: 'Fetch all remotes',
      behind: '{count} commits behind upstream',
      ahead: '{count} commits ahead of upstream',
      diverged: 'Diverged from upstream ({ahead} ahead, {behind} behind)',
      upstreamGone: 'Upstream branch no longer exists',
      inSync: 'Up to date with upstream',
      trackedBy: 'Tracks {upstream}',
      moreActions: 'More actions',
      menuCheckout: 'Checkout',
      menuNewFrom: 'Create branch from "{name}"…',
      menuMergeInto: 'Merge "{name}" into the current branch',
      menuRebaseOnto: 'Rebase the current branch onto "{name}"',
      menuPush: 'Push…',
      menuRename: 'Rename…',
      menuDelete: 'Delete',
      menuFetch: 'Fetch',
      dialogNewTitle: 'New branch',
      dialogRenameTitle: 'Rename branch',
      dialogMergeTitle: 'Merge branch',
      dialogRebaseTitle: 'Rebase',
      dialogCheckoutRefTitle: 'Checkout tag or revision',
      dialogFieldName: 'Branch name',
      dialogFieldFrom: 'Start point',
      dialogFieldRef: 'Tag or commit',
      dialogFromHead: 'current HEAD',
      dialogCheckoutAfter: 'Switch to it after creating',
      dialogMergeNoFf: 'Always create a merge commit (--no-ff)',
      dialogConfirm: 'OK',
      dialogCancel: 'Cancel',
      dialogRefHint: 'A tag (such as v1.0.0), a branch, or a commit hash. Checking out a tag gives you a detached HEAD.',
      mergingInto: 'Merge "{name}" into "{into}"',
      rebasingOnto: 'Rebase "{branch}" onto "{onto}"',
      confirmDeleteTitle: 'Delete branch',
      confirmDeleteBody: 'About to delete "{name}".',
      confirmDeleteUnmerged: 'It has unmerged commits; once deleted they cannot be recovered from this UI.',
      confirmDeleteRemote: 'This also deletes the branch on the remote "{remote}", affecting everyone else.',
      confirmDeleteButton: 'Delete',
      confirmForceDeleteButton: 'Delete anyway',
      forceDeleteNote: 'Needs one confirmation: this branch is not merged into the current one.',
      mergeInProgress: 'A merge is in progress. Commit the resolution, or abort.',
      rebaseInProgress: 'A rebase is in progress. Continue after resolving, or abort.',
      abortMerge: 'Abort merge',
      abortRebase: 'Abort rebase',
      aborted: 'Aborted',
      pushRejectedHint: 'The remote has commits you do not have. Run "Update project" first.',
      emptyCherryPick: 'That commit is already in this branch; nothing to cherry-pick.',
      error_localChanges: 'git refused the switch: you have uncommitted changes it would overwrite.',
      error_stashFailed: 'Stashing failed.',
      error_nothingToStash: 'The working tree is clean; switch directly.',
      error_invalidBranch: 'That branch name was rejected.',
      error_invalidRevision: 'That revision was rejected (only a branch name or commit hash).',
      error_invalidRemote: 'That remote name was rejected.',
      error_workspaceNotAllowed: 'That workspace is not registered with this app; access denied.',
      error_branchExists: 'A branch with that name already exists.',
      error_noSuchBranch: 'No such branch.',
      error_noSuchRef: 'No such branch, tag, or commit.',
      error_branchCheckedOut: 'You cannot delete the branch you are on.',
      error_notMerged: 'That branch has unmerged commits.',
      error_mergeConflict: 'The merge has conflicts; resolve them in a terminal.',
      error_rebaseConflict: 'The rebase has conflicts; resolve them in a terminal.',
      error_cherryPickConflict: 'The cherry-pick has conflicts; resolve them in a terminal.',
      error_pushRejected: 'Push rejected: the remote has earlier commits.',
      error_networkFailed: 'Could not reach the remote (network or credentials).',
      error_unknown: 'The operation failed.',
    }

    /** 状态轮询间隔：分支会在外部被切换（终端里 git checkout），所以要定期对齐。 */
    const POLL_MS = 15000

    /**
     * 请求 host 侧的 git 路由。
     * @param path - 相对 API 前缀的路径，如 'status'。
     * @param options - `cwd` 是要查询的工作区；`init` 是额外的 fetch 选项。
     * @returns 解析后的 JSON；失败时抛出。
     */
    async function call(path, options) {
      const { cwd, ...init } = options ?? {}
      // 必须带上工作区：会话可以有自己的项目，与外壳启动时的那个不同。
      // 不传的话 host 会用外壳工作区，于是切换项目后徽章仍显示上一个仓库的分支。
      const query = typeof cwd === 'string' && cwd !== '' ? `?cwd=${encodeURIComponent(cwd)}` : ''
      const response = await fetch(`${API}/${path}${query}`, {
        // 同源请求带上 cookie，服务端据此认证。
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        ...init,
      })
      const text = await response.text()
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        // 服务端理论上总是回 JSON；真出现 HTML 时把原文带出来，便于定位。
        throw new Error(text.slice(0, 200))
      }
      if (!response.ok) {
        // 把 host 的 code 与 detail 都挂到错误对象上，交给 describeError 决定
        // 用哪条本地化短句、以及是否展示 git 原文。
        const error = new Error(payload?.error ?? `HTTP ${response.status}`)
        if (typeof payload?.code === 'string') error.code = payload.code
        if (typeof payload?.detail === 'string') error.detail = payload.detail
        throw error
      }
      return payload
    }

    /**
     * 写操作：POST 一个 JSON 表单。
     *
     * 只做一层薄封装：所有写操作都回同一形状（新的 status + 新的 branches + remotes），
     * 因此调用方拿到它就能**整体替换**本地状态，而不是自己拼"哪些字段该刷新"——
     * 那正是"切分支后分支列表还是旧的"这类只在某一条路径上出现的 bug 的来源。
     *
     * @param route - 相对 API 前缀的路径。
     * @param cwd - 当前会话的工作区。
     * @param body - 表单内容（只放标量：名字、布尔开关）。
     * @returns host 的响应负载。
     */
    function send(route, cwd, body) {
      return call(route, {
        cwd,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
    }

    /** host 的稳定 code 到字典键的映射。 */
    const ERROR_KEYS = {
      localChanges: 'error_localChanges',
      stashFailed: 'error_stashFailed',
      nothingToStash: 'error_nothingToStash',
      invalidBranch: 'error_invalidBranch',
      invalidRevision: 'error_invalidRevision',
      invalidRemote: 'error_invalidRemote',
      workspaceNotAllowed: 'error_workspaceNotAllowed',
      branchExists: 'error_branchExists',
      noSuchBranch: 'error_noSuchBranch',
      noSuchRef: 'error_noSuchRef',
      branchCheckedOut: 'error_branchCheckedOut',
      notMerged: 'error_notMerged',
      mergeConflict: 'error_mergeConflict',
      rebaseConflict: 'error_rebaseConflict',
      cherryPickConflict: 'error_cherryPickConflict',
      pushRejected: 'error_pushRejected',
      networkFailed: 'error_networkFailed',
    }

    /**
     * 把错误整理成"字典键 + 原始细节"。
     *
     * 之所以要分开：git 的报错是英文长文（并含文件名），翻译它没有意义也不可靠；
     * 而"为什么失败、下一步该做什么"必须跟界面语言走。因此 host 返回稳定的 code，
     * 这里映射成字典键，由**组件内部**用 `t` 翻译。
     *
     * 注意本函数不自己翻译：它在组件外面，拿不到那里的 `t`（写成 `t(...)` 会抛
     * "t is not defined"，让整个插件加载失败）。
     *
     * @param cause - 捕获到的异常。
     * @returns `{ key, detail, code }`；`detail` 为空串表示没有可展示的原文。
     */
    function describeError(cause) {
      const code = cause?.code
      const detail = typeof cause?.detail === 'string' ? cause.detail : ''
      const known = typeof code === 'string' && Object.hasOwn(ERROR_KEYS, code)
      return { key: known ? ERROR_KEYS[code] : 'error_unknown', detail, code: known ? code : '' }
    }

    // =========================================================================
    // 3. 纯展示片段
    // =========================================================================

    /**
     * 分支同步状态：本地相对上游的领先/落后。
     *
     * 三种形状要在界面上一眼可分（它们需要用户做的事完全不同）：
     *   `↓N`      落后   —— 该「更新项目」了
     *   `↑N`      领先   —— 该「推送」了
     *   `↕N M`    分叉   —— 两边都有，只推或只拉都不对
     *   `(gone)`  上游已删 —— 需要重新设置上游，或把本地分支一并删掉
     * 一致时**不显示任何标记**：那是最常见的状态，给每个分支都挂一个"OK"只会变成噪声。
     *
     * @param entry - host 返回的分支条目。
     * @param t - 翻译函数。
     * @returns 展示文本，或空串。
     */
    function syncLabel(entry, t) {
      if (entry.upstreamGone) return t('upstreamGone')
      if (entry.diverged) return `\u2195${entry.ahead} ${entry.behind}`
      if (entry.behind > 0) return `\u2193${entry.behind > 99 ? '99+' : entry.behind}`
      if (entry.ahead > 0) return `\u2191${entry.ahead}`
      return ''
    }

    /**
     * 同步标记的悬停说明。
     * @param entry - 分支条目。
     * @param t - 翻译函数。
     * @returns 一句话。
     */
    function syncTitle(entry, t) {
      if (entry.upstreamGone) return t('upstreamGone')
      if (entry.diverged) return t('diverged', { ahead: entry.ahead, behind: entry.behind })
      if (entry.behind > 0) return t('behind', { count: entry.behind })
      if (entry.ahead > 0) return t('ahead', { count: entry.ahead })
      return t('inSync')
    }

    /**
     * 把上游短名切成"远端前缀 + 分支名"，用于两段式显示。
     *
     * 界面上只展示**分支名**部分（`origin/develop` → `develop`），远端前缀靠分组标题
     * 已经说明了；截断时也要保证"尾部保留、开头淡出"，因为分支名的**末尾**才是区分度
     * 所在（`develop-v7.0.0-yuheng` 与 `develop-v7.0.0-kexing` 只差最后一段）。
     *
     * @param upstream - 上游短名。
     * @returns `{ remote, branch }`。
     */
    function splitUpstream(upstream) {
      const value = typeof upstream === 'string' ? upstream : ''
      const cut = value.indexOf('/')
      if (cut < 0) return { remote: '', branch: value }
      return { remote: value.slice(0, cut), branch: value.slice(cut + 1) }
    }

    /**
     * 图标：一个 git 分支的折线。
     * @returns React 元素。
     */
    function BranchGlyph() {
      // 所有端点与描边都留在 viewBox 内，避免顶部节点被 SVG 视口裁掉。
      return react.createElement(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': 'true', style: { display: 'block', flexShrink: 0 } },
        react.createElement('path', { d: 'M6 7.5v9M18 7.5V10a9 9 0 0 1-9 9h-.5', strokeLinecap: 'round' }),
        react.createElement('circle', { cx: 6, cy: 5, r: 2.5 }),
        react.createElement('circle', { cx: 18, cy: 5, r: 2.5 }),
        react.createElement('circle', { cx: 6, cy: 19, r: 2.5 }),
      )
    }

    /**
     * 图标：一个加号（新建分支）。
     * @returns React 元素。
     */
    function PlusGlyph() {
      return react.createElement(
        'svg',
        { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': 'true', style: { display: 'block', flexShrink: 0 } },
        react.createElement('path', { d: 'M8 3v10M3 8h10', strokeLinecap: 'round' }),
      )
    }

    /**
     * 图标：下拉的尖括号，用于"展开子菜单"。
     * @returns React 元素。
     */
    function ChevronGlyph() {
      return react.createElement(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': 'true', style: { display: 'block', flexShrink: 0 } },
        react.createElement('path', { d: 'm6 3.5 4.5 4.5L6 12.5', strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    /** 分区标题的样式。 */
    const sectionStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '10px 4px 4px',
      fontSize: '11px',
      fontWeight: 600,
      letterSpacing: '.02em',
      color: TERTIARY,
      textTransform: 'uppercase',
    }

    /**
     * 一个分区标题，右端可选一个图标按钮（如「抓取」「刷新」）。
     * @param props - `{ label, count, action }`。
     * @returns React 元素。
     */
    function SectionHeader(props) {
      const { label, count, action } = props
      return react.createElement(
        'div',
        { style: sectionStyle },
        react.createElement('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
        typeof count === 'number' ? react.createElement('span', { style: { color: TERTIARY, fontWeight: 400 } }, String(count)) : null,
        action ?? null,
      )
    }

    // =========================================================================
    // 4. 源代码管理面板与分支徽章
    // =========================================================================

    /**
     * 分支徽章 + 源代码管理面板。
     *
     * 用函数组件 + hooks 而不是类：与官方包的写法一致，且 hooks 的生命周期更容易和
     * 插件的 effect 对齐。
     * @param props - 槽注入的属性，其中 `t` 是按当前语言绑定的翻译函数。
     */
    function BranchChip(props) {
      // `t` 由槽的 inject 提供（ctx.locale.bind(NS)）。缺失时退化为原样返回键名，
      // 这样即使 locale 服务没挂上也不会崩。
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      // `sessionId` 与 `useSessions` 由渲染器按会话作用域自动注入（不需要自己写进
      // inject）——会话作用域的槽都会收到它们。
      const { sessionId, useSessions } = props ?? {}

      // 本会话的工作区。这是必须在**每个会话**里读的：用户可以在应用内为会话选择
      // 项目，它与外壳启动时的 `--workspace` 是两回事。用外壳那个会让徽章显示上一个
      // 仓库的分支（实测踩到过：外壳是 mmsm-amis、会话切到 scheduler-service-task，
      // 徽章却一直显示 mmsm-amis 的分支）。
      const workspace =
        typeof useSessions === 'function' && sessionId !== undefined
          ? useSessions((state) => state?.byId?.[sessionId]?.cwd)
          : undefined

      const [status, setStatus] = react.useState(null)
      const [branches, setBranches] = react.useState([])
      const [remotes, setRemotes] = react.useState([])
      const [query, setQuery] = react.useState('')
      const [loading, setLoading] = react.useState(false)
      const [open, setOpen] = react.useState(false)
      const [busy, setBusy] = react.useState(false)
      /** 失败信息：`{ key, detail, code }`，key 是字典键。 */
      const [error, setError] = react.useState(null)
      /** 成功后的提示（例如"改动已存入 stash"）。 */
      const [notice, setNotice] = react.useState('')
      /**
       * 上一次尝试切换的目标分支。
       *
       * 失败时错误面板要给出「暂存并切换到 <分支>」按钮，就必须记住用户点的是哪一个
       * ——错误文本里只有文件名，没有分支名。
       */
      const [pendingBranch, setPendingBranch] = react.useState('')
      /** 右键菜单：`{ x, y, branch }`；null 表示未打开。 */
      const [menu, setMenu] = react.useState(null)
      /** 对话框：`{ kind, branch? }`；null 表示未打开。 */
      const [dialog, setDialog] = react.useState(null)
      /**
       * 对话框的实例序号。
       *
       * 每次打开对话框 +1，并作为 `ActionDialog` 的 `key`。**这一条是必需的**：同一个
       * 位置的组件在 React 里是同一个实例，`useState(初值)` 只在挂载时执行一次，所以
       * 从「新建分支」直接切到「重命名分支」时输入框会**留着上一次填的名字**（实测：
       * 重命名框里预填的是 `feature/new`，而不是被重命名那个分支的 `develop`），
       * "没改名字就不发请求"这类判断因此走错分支。
       *
       * 用递增序号而不是 `Date.now()`：它必须是稳定的可序列化值，且同一份对话框状态
       * 重渲染时要保持不变——否则每次重渲染都会重建对话框、把用户正在输入的内容清掉。
       */
      const [serial, setSerial] = react.useState(0)
      /** 打开对话框：收起右键菜单，并换一个实例序号（见 serial 的说明）。 */
      const openDialog = react.useCallback((next) => {
        setMenu(null)
        setSerial((value) => value + 1)
        setDialog(next)
      }, [])

      const refresh = react.useCallback(async () => {
        try {
          const next = await call('status', { cwd: workspace })
          setStatus(next)
          setError(null)
        } catch (cause) {
          setError(describeError(cause))
        }
        // 依赖 workspace：会话换了项目就要重新查，否则徽章会停在旧仓库的分支上。
      }, [workspace])

      /** 重新拉取分支与远端列表。写操作之后也走它（host 已经回了新列表，但整轮的
       * 一次重取能让"别的窗口/终端刚改过"这件事一并收敛）。 */
      const loadBranches = react.useCallback(async () => {
        setLoading(true)
        try {
          const payload = await call('branches', { cwd: workspace })
          // host 侧返回的是对象数组：`{ name, isRemote, current, upstream, ahead, behind… }`。
          // 兼容旧的纯字符串形式，避免 host/client 版本不一致时列表整片消失。
          const raw = Array.isArray(payload?.branches) ? payload.branches : []
          setBranches(
            raw.map((item) =>
              typeof item === 'string' ? { name: item, isRemote: false, current: false } : item,
            ),
          )
          setRemotes(Array.isArray(payload?.remotes) ? payload.remotes : [])
          return true
        } catch (cause) {
          setError(describeError(cause))
          return false
        } finally {
          setLoading(false)
        }
      }, [workspace])

      // 首次拉取 + 定时对齐。
      react.useEffect(() => {
        let alive = true
        const tick = () => {
          if (alive) void refresh()
        }
        tick()
        const timer = setInterval(tick, POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [refresh])

      // 打开面板时才拉分支列表：分支多的仓库列一次不便宜，而用户可能从不点它。
      react.useEffect(() => {
        if (!open) return undefined
        setQuery('')
        setMenu(null)
        void loadBranches()
        return undefined
        // 依赖 workspace：会话换项目后，菜单里列出的必须是新仓库的分支。
      }, [open, workspace, loadBranches])

      /**
       * 执行一次写操作并整体替换状态。
       *
       * **统一入口**的意义：host 的所有写路由都回同一形状（status + branches + remotes），
       * 因此这里只需要一处"把响应铺回状态"，每个操作自己不再关心该刷新哪些字段。
       * 返回 host 的响应，让调用方能读 `stash` / `detached` / `empty` 这类附加信息。
       */
      const run = react.useCallback(
        async (route, body) => {
          setBusy(true)
          setError(null)
          setNotice('')
          try {
            const result = await send(route, workspace, body)
            if (result?.isRepo === false) return result
            // 写操作回的是最新状态：直接铺回去，界面立刻反映结果。
            if (result !== null && typeof result === 'object' && 'branch' in result) setStatus(result)
            if (Array.isArray(result?.branches)) setBranches(result.branches)
            if (Array.isArray(result?.remotes)) setRemotes(result.remotes)
            // 附加信息的提示文案。放在这里而不是每个操作里，是为了让"操作成功但需要
            // 额外告知"这件事只有一处实现。
            if (result?.stash?.stashed === true) setNotice(t('stashed', { ref: result.stash.ref }))
            else if (result?.detached === true) setNotice(t('detachedNotice'))
            else if (result?.empty === true) setNotice(t('emptyCherryPick'))
            else if (typeof result?.aborted === 'string') setNotice(t('aborted'))
            return result
          } catch (cause) {
            setError(describeError(cause))
            return undefined
          } finally {
            setBusy(false)
          }
        },
        [workspace, t],
      )

      const switchTo = react.useCallback(
        async (branch, options) => {
          // 记下目标分支：失败时错误面板要靠它给出"暂存并切换到 X"的入口。
          setPendingBranch(branch)
          const result = await run('checkout', options?.stash === true ? { branch, stash: true } : { branch })
          // 只有成功才关闭面板。失败时保持打开，否则用户看不到原因、也不知道
          // 该重试哪个分支——实测中最常见的失败是有未提交改动（git 会拒绝覆盖）。
          if (result !== undefined) {
            setOpen(false)
            setMenu(null)
          }
        },
        [run],
      )

      // 重新打开面板时清掉上一次的错误与提示：旧信息留到新一次尝试里只会造成混淆。
      const toggleOpen = react.useCallback(() => {
        setOpen((value) => {
          if (!value) {
            setError(null)
            setNotice('')
            setMenu(null)
          }
          return !value
        })
      }, [])

      // 点击组件之外关闭菜单——这是标准交互，缺了它用户会觉得"弹框关不掉"。
      //
      // 用 mousedown 而不是 click：click 在 mouseup 之后才触发，中间可能已经有别的
      // 事情发生（例如拖选文本）。判定用"点击目标是否在容器内"，因此点菜单内部
      // 不会误关。右键菜单是 fixed 定位、**渲染在容器之外**，所以它单独判一次，
      // 否则打开右键菜单后的第一次点击会先把面板本身关掉。
      //
      // 依赖数组里带 open：只在打开期间挂监听，关闭时立刻摘掉，不给文档留常驻监听。
      const containerRef = react.useRef(null)
      const triggerRef = react.useRef(null)
      const menuRef = react.useRef(null)

      /**
       * 下拉菜单的位置：由容器（徽章）的实时位置算出来。
       *
       * 为什么需要：菜单用 `fixed` 定位是为了跳出输入框容器的裁剪（否则小窗口下只
       * 露出顶部一条），但 `fixed` 不再跟随徽章——若把偏移写成常量，菜单就会钉在
       * 屏幕角落，与徽章脱节（实测就飘到了左下角）。因此这里测量徽章位置，把菜单
       * 贴在它正上方、左对齐。
       */
      const [anchor, setAnchor] = react.useState(undefined)
      react.useEffect(() => {
        if (!open) {
          setAnchor(undefined)
          return undefined
        }
        const measure = () => {
          const node = containerRef.current
          if (node === null) return
          const rect = node.getBoundingClientRect()
          const width = Math.min(420, window.innerWidth - 24)
          const above = rect.top - 20
          const below = window.innerHeight - rect.bottom - 20
          const placeBelow = above < 220 && below > above
          setAnchor({
            width,
            left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
            top: placeBelow ? rect.bottom + 8 : undefined,
            bottom: placeBelow ? undefined : window.innerHeight - rect.top + 8,
            maxHeight: Math.min(440, Math.max(0, placeBelow ? below : above)),
          })
        }
        measure()
        // 窗口尺寸变化或滚动都会让徽章移动，菜单要跟着走。
        window.addEventListener('resize', measure)
        window.addEventListener('scroll', measure, true)
        return () => {
          window.removeEventListener('resize', measure)
          window.removeEventListener('scroll', measure, true)
        }
      }, [open])

      react.useEffect(() => {
        if (!open) return undefined

        const onPointerDown = (event) => {
          const node = containerRef.current
          const insidePanel = node !== null && node.contains(event.target)
          const insideContext = menuRef.current !== null && menuRef.current.contains(event.target)
          if (insideContext) return
          if (!insidePanel) {
            setOpen(false)
            return
          }
          // 点了面板内部的**其它地方**：只收起右键菜单。菜单本身要靠这条"关掉自己"，
          // 否则它会一直浮在列表上，用户点任何一行都会觉得点错了东西。
          setMenu(null)
        }
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          // Esc 逐层退出：先收右键菜单，再收对话框，最后关面板。一次全关会让用户
          // 在只想去掉那层小菜单时丢掉整个面板的状态。
          if (menu !== null) setMenu(null)
          else if (dialog !== null) setDialog(null)
          else {
            setOpen(false)
            triggerRef.current?.focus()
          }
        }

        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open, menu, dialog])

      if (status === null) {
        // 还没有数据时渲染 null 而不是占位骨架：这个位置空间很小，
        // 一个闪烁的骨架比"晚半秒出现"更惹眼。
        return null
      }

      if (!status.isRepo) return null

      const label = status.detached ? '(detached)' : status.branch || '(no branch)'
      const flags = []
      if (status.changedFiles > 0) flags.push(`*${status.changedFiles}`)
      if (status.ahead > 0) flags.push(`\u2191${status.ahead}`)
      if (status.behind > 0) flags.push(`\u2193${status.behind}`)
      const search = query.trim().toLowerCase()
      const visible = branches.filter((branch) => branch.name.toLowerCase().includes(search))

      return react.createElement(
        'div',
        // ref 用于"点击外部关闭"的判定：在这个容器内的点击不关菜单。
        {
          ref: containerRef,
          'data-desktop-branch': '',
          style: { position: 'relative', display: 'inline-flex', flex: '1 1 120px', minWidth: 0, maxWidth: '100%' },
        },
        react.createElement(
          'button',
          {
            type: 'button',
            ref: triggerRef,
            // 稳定的测试/自动化标记。
            //
            // **不能靠 `title` 定位这个按钮**：有错误时 title 会变成错误短句（那是有意的，
            // 用户在悬停时要能看到"为什么这个徽章是红的"），靠 `Git:` 前缀找它就会在
            // 恰好有错误的那一刻找不到——而那正是最需要点开面板看原因的时候。
            'data-desktop-branch-trigger': '',
            title: error === null ? `Git: ${label}${flags.length ? ' ' + flags.join(' ') : ''}` : t(error.key),
            'aria-label': `${t('switchBranch')}: ${label}`,
            'aria-expanded': open,
            'aria-haspopup': 'dialog',
            onClick: toggleOpen,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              minWidth: 0,
              maxWidth: '100%',
              gap: '6px',
              padding: '0 8px',
              height: '28px',
              borderRadius: '6px',
              border: `1px solid ${error === null ? 'transparent' : '#6b3b3b'}`,
              background: 'transparent',
              color: error === null ? 'var(--dsw-alias-label-secondary)' : '#e6b0b0',
              fontSize: '12px',
              fontFamily: UI_FONT,
              whiteSpace: 'nowrap',
              cursor: 'pointer',
            },
          },
          react.createElement(BranchGlyph),
          react.createElement('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, label),
          flags.length > 0 ? react.createElement('span', { style: { opacity: 0.7, flexShrink: 0 } }, flags.join(' ')) : null,
        ),

        open
          ? react.createElement(SourcePanel, {
              t,
              status,
              visible,
              // 总条数单独传：只看 `visible.length === 0` 无法区分"仓库里一个分支都没有"
              // 与"搜索词把它们全过滤掉了"，而这两种情况下空态该说的话不同。
              totalBranches: branches.length,
              pendingBranch,
              search,
              loading,
              busy,
              error,
              notice,
              query,
              setQuery,
              anchor,
              remotes,
              onRefresh: () => void Promise.all([refresh(), loadBranches()]),
              onFetch: () => void run('remote', { action: 'fetch' }),
              onSwitch: (branch) => void switchTo(branch),
              onStashSwitch: () => void switchTo(pendingBranch, { stash: true }),
              onDialog: openDialog,
              onContextMenu: (event, branch) => {
                event.preventDefault()
                event.stopPropagation()
                setMenu({ x: event.clientX, y: event.clientY, branch })
              },
              onAbort: (kind) => void run('op/abort', { kind }),
            })
          : null,

        // 右键菜单与对话框都渲染在容器**内部**（虽然定位是 fixed），这样"点击面板内部
        // 不关面板"的既有判定天然把它们算作内部，不需要再加一层例外。
        //
        // 两者都用**三元的 null 占位**，而不是用 `cond ? x : null` 把它们从 children
        // 里整个去掉：去掉会让后面的兄弟节点前移一位，而 React 按位置协调，于是对话框
        // 每次"右键菜单关掉"都会被当成一个新组件重建、内部状态（比如"已确认强删"那个
        // 开关、输入框里已填的名字）全部丢失。实测现象：点一次「仍然删除」之后按钮文案
        // 又变回「删除」，第二次删除因此永远带不上 force。
        react.createElement(
          'div',
          { key: 'context-menu-slot', style: { display: 'contents' } },
          menu === null
            ? null
            : react.createElement(BranchContextMenu, {
                t,
                menu,
                menuRef,
                status,
                busy,
                onClose: () => setMenu(null),
                onSwitch: (branch) => void switchTo(branch),
                onDialog: openDialog,
              }),
        ),

        react.createElement(
          'div',
          { key: 'dialog-slot', style: { display: 'contents' } },
          dialog === null
            ? null
            : react.createElement(ActionDialog, {
                // **按对话框类型给 key**，强制换一个实例。
                //
                // 这一个 key 是必需的：同一个位置上的组件在 React 里是**同一个实例**，
                // `useState(初值)` 只在挂载时执行一次。于是从「新建分支」直接切到
                // 「重命名分支」时，输入框会留着上一次填的名字（实测：重命名框里预填的
                // 是 `feature/new`，而不是被重命名那个分支的名字），"未改动就不请求"这类
                // 判断也因此走错分支。key 里带上 serial，因此每次打开对话框都是一个新实例。
                // 注意 key 必须给在 **ActionDialog 自己**身上——给外层那个占位 div 是
                // 无效的（实测踩到过：加了 key 但预填名字依旧错，因为协调的是内层元素）。
                key: `${dialog.kind}:${serial}`,
                t,
                dialog,
                busy,
                remotes,
                onCancel: () => setDialog(null),
                onClose: () => setDialog(null),
                run,
                onDone: () => {
                  setDialog(null)
                  setOpen(false)
                },
              }),
        ),
      )
    }

    /**
     * 源代码管理面板本体。
     *
     * 结构参照 VS Code 的源代码管理侧栏：一个搜索框、四个快捷操作、以及
     * `最近 / 本地 / 远程` 三段分支列表（每行带同步标记与上游）。
     *
     * 全部是受控的展示组件：数据与动作都由 BranchChip 通过 props 传进来，因此这里
     * 没有任何 fetch，也没有状态——同一份数据换成别的壳（例如主区域面板）也能复用。
     *
     * @param props - 见 BranchChip 里的构造处。
     * @returns React 元素。
     */
    function SourcePanel(props) {
      const {
        t, status, visible, totalBranches, pendingBranch, search, loading, busy, error, notice, query, setQuery, anchor, remotes,
        onRefresh, onFetch, onSwitch, onStashSwitch, onDialog, onContextMenu, onAbort,
      } = props

      /** 一行快捷操作。 */
      const action = (key, glyph, label, onClick, extra) =>
        react.createElement(
          'button',
          {
            type: 'button',
            key,
            disabled: busy,
            onClick,
            'data-desktop-sc-action': key,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              boxSizing: 'border-box',
              width: '100%',
              minHeight: '30px',
              padding: '5px 8px',
              border: 'none',
              borderRadius: '6px',
              background: 'transparent',
              color: 'inherit',
              fontFamily: UI_FONT,
              fontSize: '12.5px',
              textAlign: 'left',
              cursor: busy ? 'default' : 'pointer',
              opacity: busy ? 0.6 : 1,
            },
          },
          glyph,
          react.createElement('span', { style: { flex: '1 1 auto', minWidth: 0 } }, label),
          extra ?? null,
        )

      /** 一行分支。 */
      const row = (entry) => {
        const sync = syncLabel(entry, t)
        const { branch: upstreamBranch } = splitUpstream(entry.upstream)
        return react.createElement(
          'button',
          {
            key: `${entry.isRemote ? 'r:' : 'l:'}${entry.name}`,
            type: 'button',
            'data-desktop-branch-option': '',
            'data-desktop-branch-name': entry.name,
            'aria-current': entry.current ? 'true' : undefined,
            disabled: busy || entry.current,
            onClick: () => onSwitch(entry.name),
            onContextMenu: (event) => onContextMenu(event, entry),
            title: `${entry.name}\n${t(entry.current ? 'currentBranch' : entry.isRemote ? 'remoteBranch' : 'localBranch')}${entry.upstream === '' ? '' : `\n${syncTitle(entry, t)}`}`,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              boxSizing: 'border-box',
              width: '100%',
              minHeight: '34px',
              textAlign: 'left',
              padding: '6px 8px',
              border: 'none',
              borderRadius: '7px',
              background: entry.current
                ? `color-mix(in srgb, ${ACCENT} 8%, ${SURFACE})`
                : 'var(--dsh-branch-option-bg, transparent)',
              color: entry.current ? ACCENT : 'inherit',
              opacity: 1,
              fontFamily: UI_FONT,
              fontSize: '13px',
              lineHeight: 1.4,
              fontWeight: entry.current ? 500 : 400,
              cursor: busy || entry.current ? 'default' : 'pointer',
            },
          },
          // 当前分支用一个实心标记，其余用一个描边标记：位置固定，扫读时不会因为
          // 图标宽度不同而参差不齐。
          react.createElement(
            'span',
            { 'data-desktop-branch-mark': entry.current ? 'current' : 'other', style: { flexShrink: 0, width: '12px', color: entry.current ? ACCENT : TERTIARY } },
            entry.current
              ? react.createElement(
                  'svg',
                  { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' },
                  react.createElement('path', { d: 'M8 1.6 9.9 6l4.5.4-3.4 3 1 4.5L8 11.6 3.9 13.9l1-4.5-3.4-3L6.1 6z' }),
                )
              : react.createElement(
                  'svg',
                  { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': 'true' },
                  react.createElement('path', { d: 'M5 3v10M11 3v4a4 4 0 0 1-4 4H5', strokeLinecap: 'round' }),
                  react.createElement('circle', { cx: 5, cy: 3, r: 1.5 }),
                  react.createElement('circle', { cx: 11, cy: 3, r: 1.5 }),
                ),
          ),
          // 名字：唯一允许被压缩的元素。
          react.createElement(
            'span',
            { 'data-desktop-branch-label': '', style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            entry.name,
          ),
          // 同步标记：有值时用等宽数字，避免 1 和 99+ 让上游名字左右跳动。
          sync === ''
            ? null
            : react.createElement(
                'span',
                {
                  'data-desktop-branch-sync': entry.upstreamGone ? 'gone' : entry.diverged ? 'diverged' : entry.behind > 0 ? 'behind' : 'ahead',
                  title: syncTitle(entry, t),
                  style: {
                    flexShrink: 0,
                    fontSize: '11.5px',
                    fontVariantNumeric: 'tabular-nums',
                    color: entry.upstreamGone ? DANGER : entry.ahead > 0 && entry.behind === 0 ? APPROVAL : SECONDARY,
                  },
                },
                sync,
              ),
          // 上游只留分支名那一段（远端前缀在分组标题里已经说明），并且**保留尾部**：
          // `develop-v7.0.0-yuheng` 与 `develop-v7.0.0-kexing` 的区别在末尾。
          upstreamBranch === ''
            ? null
            : react.createElement(
                'span',
                {
                  'data-desktop-branch-upstream': '',
                  title: t('trackedBy', { upstream: entry.upstream }),
                  dir: 'rtl',
                  style: {
                    flexShrink: 1,
                    maxWidth: '42%',
                    fontSize: '11.5px',
                    color: TERTIARY,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                },
                // RTL 让省略号出现在**左侧**，也就是被砍掉的是远端前缀那一侧；
                // 用 LRM 包住以免路径里的斜杠在 RTL 下被重排。
                `\u200e${upstreamBranch}`,
              ),
          react.createElement('span', { style: { flexShrink: 0, color: TERTIARY, display: 'flex' } }, react.createElement(ChevronGlyph)),
        )
      }

      /** 一个小图标按钮（分区标题右端）。 */
      const iconButton = (key, label, onClick, children) =>
        react.createElement(
          'button',
          {
            type: 'button',
            key,
            'data-desktop-sc-icon': key,
            disabled: busy,
            onClick: (event) => {
              // 分区标题在面板内部，点击不该触发"点外部关闭"之外的任何东西；
              // 但也不该冒泡到面板的 mousedown 判定里去收右键菜单之外的状态。
              event.stopPropagation()
              onClick()
            },
            title: label,
            'aria-label': label,
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
              color: TERTIARY,
              cursor: busy ? 'default' : 'pointer',
            },
          },
          children,
        )

      const refreshGlyph = react.createElement(
        'svg',
        { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': 'true' },
        react.createElement('path', { d: 'M13 8a5 5 0 1 1-1.5-3.5M13 2v3.2h-3.2', strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
      const cloudGlyph = react.createElement(
        'svg',
        { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': 'true' },
        react.createElement('path', { d: 'M4.6 12.5a3.1 3.1 0 0 1-.3-6.2 4 4 0 0 1 7.6 1 2.6 2.6 0 0 1-.5 5.2z', strokeLinecap: 'round', strokeLinejoin: 'round' }),
        react.createElement('path', { d: 'M8 7.2v3.4M6.6 9.2 8 10.6l1.4-1.4', strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )

      // 分组
      const recent = visible.filter((entry) => !entry.isRemote).slice(0, RECENT_LIMIT)
      const local = visible.filter((entry) => !entry.isRemote)
      const remote = visible.filter((entry) => entry.isRemote)

      return react.createElement(
        'div',
        {
          'data-desktop-branch-menu': '',
          role: 'dialog',
          'aria-label': t('sourceControl'),
          onKeyDown: (event) => {
            // 输入搜索词时不该触发外层聊天框的快捷键。
            //
            // **但 Escape 必须放行**：关闭逻辑挂在 document 上（见上面的 effect），
            // 而 `stopPropagation` 会拦住它往上冒泡，于是 Esc 再也关不掉面板——实测
            // 就是这么坏的（`scripts/test-gitbar-ui.mjs` 第 4 项立刻变红）。只拦
            // 会"漏到 composer"的按键，退出键留给文档级监听。
            if (event.key === 'Escape') return
            event.stopPropagation()
          },
          style: {
            // fixed 而不是 absolute：absolute 相对工具栏里那个小容器定位，会被
            // 输入框卡片的可视区域裁掉（小窗口里只能看到顶部一条）。fixed 相对
            // 视口定位，跳出祖先裁剪。
            //
            // 但 fixed 不再跟随徽章，所以位置必须**测量出来**（见 anchor），
            // 否则菜单会钉在屏幕角落、与徽章脱节——实测就飘到了左下角。
            // anchor 未就绪时先用合理兜底，避免闪到屏幕外。
            position: 'fixed',
            top: anchor?.top,
            bottom: anchor === undefined ? 'clamp(72px, 12vh, 140px)' : anchor.bottom,
            left: anchor === undefined ? 'clamp(12px, 3vw, 40px)' : `${anchor.left}px`,
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            boxSizing: 'border-box',
            width: anchor?.width ?? 'min(420px, calc(100vw - 24px))',
            maxHeight: anchor?.maxHeight ?? 'min(440px, calc(100vh - 24px))',
            overflow: 'hidden',
            borderRadius: '14px',
            border: `1px solid ${BORDER}`,
            background: SURFACE,
            color: 'var(--dsw-alias-label-primary, #202124)',
            fontFamily: UI_FONT,
            boxShadow: '0 12px 36px rgba(0,0,0,.12), 0 2px 8px rgba(0,0,0,.04)',
            padding: '8px',
          },
        },
        react.createElement('input', {
          type: 'search',
          value: query,
          autoFocus: true,
          placeholder: t('searchBranches'),
          'aria-label': t('searchBranches'),
          autoComplete: 'off',
          spellCheck: false,
          onChange: (event) => setQuery(event.target.value),
          style: {
            display: 'block',
            flexShrink: 0,
            boxSizing: 'border-box',
            width: '100%',
            height: '34px',
            marginBottom: '6px',
            padding: '0 10px',
            border: `1px solid ${BORDER}`,
            borderRadius: '8px',
            background: SURFACE,
            color: 'inherit',
            fontFamily: UI_FONT,
            fontSize: '13px',
          },
        }),

        // 快速操作。四个都在 host 侧有对应路由，没有一个是装饰。
        react.createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', flexShrink: 0, paddingBottom: '4px', borderBottom: `1px solid ${BORDER}` } },
          action('update', refreshGlyph, busy ? t('working') : t('actionUpdate'), () => onDialog({ kind: 'update' })),
          action('commit', refreshGlyph, t('actionCommit'), () => onDialog({ kind: 'commit' })),
          action('push', cloudGlyph, t('actionPush'), () => onDialog({ kind: 'push' })),
        ),

        react.createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', flexShrink: 0, paddingTop: '4px', paddingBottom: '4px', borderBottom: `1px solid ${BORDER}` } },
          action('new', react.createElement('span', { style: { display: 'flex', width: '15px', color: TERTIARY } }, react.createElement(PlusGlyph)), t('actionNewBranch'), () => onDialog({ kind: 'create' })),
          action('tag', react.createElement('span', { style: { display: 'flex', width: '15px', color: TERTIARY } }, react.createElement(BranchGlyph)), t('actionCheckoutRef'), () => onDialog({ kind: 'checkout-ref' })),
        ),

        // 进行中的合并/变基：这是**必须**露出来的一条，因为它表示仓库停在一个
        // 用户可能不知道的状态上。给一个中止入口，让人不至于只能去终端里收拾。
        status.merging || status.rebasing
          ? react.createElement(
              'div',
              {
                'data-desktop-sc-progress': status.rebasing ? 'rebase' : 'merge',
                style: {
                  flexShrink: 0,
                  margin: '6px 2px 0',
                  padding: '7px 9px',
                  borderRadius: '8px',
                  background: `color-mix(in srgb, ${APPROVAL} 8%, ${SURFACE})`,
                  border: `1px solid color-mix(in srgb, ${APPROVAL} 22%, transparent)`,
                  color: APPROVAL,
                  fontSize: '12px',
                  lineHeight: 1.5,
                },
              },
              react.createElement('div', null, t(status.rebasing ? 'rebaseInProgress' : 'mergeInProgress')),
              react.createElement(
                'button',
                {
                  type: 'button',
                  disabled: busy,
                  onClick: () => onAbort(status.rebasing ? 'rebase' : 'merge'),
                  style: {
                    marginTop: '6px',
                    padding: '4px 8px',
                    borderRadius: '6px',
                    border: '1px solid color-mix(in srgb, currentColor 30%, transparent)',
                    background: SURFACE,
                    color: 'inherit',
                    fontFamily: UI_FONT,
                    fontSize: '12px',
                    cursor: busy ? 'default' : 'pointer',
                  },
                },
                t(status.rebasing ? 'abortRebase' : 'abortMerge'),
              ),
            )
          : null,

        // 失败原因必须显示在面板里。原先只写进按钮的 hover 提示，而面板照常
        // 关闭——用户看到的就是"点了没反应"。
        error === null
          ? null
          : react.createElement(
              'div',
              {
                'data-desktop-sc-error': error.code === '' ? 'unknown' : error.code,
                style: {
                  flexShrink: 0,
                  margin: '6px 2px 0',
                  padding: '7px 9px',
                  borderRadius: '8px',
                  background: `color-mix(in srgb, ${DANGER} 6%, ${SURFACE})`,
                  border: `1px solid color-mix(in srgb, ${DANGER} 20%, transparent)`,
                  color: DANGER,
                  fontSize: '12px',
                  lineHeight: 1.5,
                  wordBreak: 'break-word',
                  maxHeight: '150px',
                  overflowY: 'auto',
                },
              },
              // 第一行是本地化短句（跟界面语言走）。
              react.createElement('div', null, t(error.key)),
              // 下面是 git 的英文原文：它是权威信息，翻译反而失真，所以原样显示。
              // 用等宽字体 + 保留换行，多行报错才读得清。
              error.detail === ''
                ? null
                : react.createElement(
                    'div',
                    { style: { marginTop: '5px', paddingTop: '5px', borderTop: '1px solid color-mix(in srgb, currentColor 20%, transparent)', fontFamily: CODE_FONT, fontSize: '11.5px', whiteSpace: 'pre-wrap' } },
                    error.detail,
                  ),
              // 只在"因未提交改动而被拒"时给出暂存入口：其它失败（例如目标分支
              // 不存在）暂存也解决不了，给按钮反而误导。
              error.key === 'error_localChanges'
                ? react.createElement(
                    'button',
                    {
                      type: 'button',
                      disabled: busy,
                      onClick: onStashSwitch,
                      style: {
                        marginTop: '7px',
                        width: '100%',
                        padding: '6px 8px',
                        borderRadius: '6px',
                        border: '1px solid color-mix(in srgb, currentColor 25%, transparent)',
                        background: SURFACE,
                        color: 'inherit',
                        fontFamily: UI_FONT,
                        fontSize: '12px',
                        cursor: busy ? 'default' : 'pointer',
                      },
                    },
                    busy ? t('stashing') : t('stashAndSwitch', { branch: pendingBranchLabel(pendingBranch) }),
                  )
                : null,
              // 推送被拒是"先更新再推"这个动作序列的提示，单独给一句该怎么办。
              error.key === 'error_pushRejected'
                ? react.createElement('div', { style: { marginTop: '5px' } }, t('pushRejectedHint'))
                : null,
            ),

        // 成功后的提示（stash 位置、游离 HEAD、空摘取）。放在错误区之外，因为它是结果。
        notice === ''
          ? null
          : react.createElement(
              'div',
              {
                'data-desktop-sc-notice': '',
                style: {
                  flexShrink: 0,
                  margin: '6px 2px 0',
                  padding: '6px 9px',
                  borderRadius: '6px',
                  background: `color-mix(in srgb, var(--dsw-alias-state-success-primary, #16834a) 6%, ${SURFACE})`,
                  border: '1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary, #16834a) 20%, transparent)',
                  color: 'var(--dsw-alias-state-success-primary, #16834a)',
                  fontSize: '12px',
                  lineHeight: 1.5,
                },
              },
              notice,
            ),

        // 只滚动结果列表，搜索框与操作区始终留在顶部。
        react.createElement(
          'div',
          { style: { minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', paddingTop: '2px' }, 'aria-busy': loading || busy },
          loading || visible.length === 0
            ? react.createElement(
                'div',
                { role: 'status', style: { padding: '20px 10px', textAlign: 'center', fontSize: '13px', color: SECONDARY } },
                t(loading ? 'loadingBranches' : totalBranches === 0 ? 'noBranches' : 'noMatchingBranches'),
              )
            : react.createElement(
                'div',
                { style: { display: 'flex', flexDirection: 'column' } },
                // 「最近」刻意是从**本地**分支里按提交时间取的副本，而不是一个独立集合：
                // 同一个分支同时出现在"最近"和"本地"里是有意的（VS Code 也这样），
                // 因为这两段回答的是不同问题——"我最近在哪些分支上"与"仓库里有哪些分支"。
                recent.length > 0 && search === ''
                  ? react.createElement(
                      'div',
                      { 'data-desktop-sc-section': 'recent' },
                      react.createElement(SectionHeader, { label: t('sectionRecent'), count: recent.length }),
                      ...recent.map(row),
                    )
                  : null,
                react.createElement(
                  'div',
                  { 'data-desktop-sc-section': 'local' },
                  react.createElement(SectionHeader, {
                    label: t('sectionLocal'),
                    count: local.length,
                    action: iconButton('refresh', t('refresh'), onRefresh, refreshGlyph),
                  }),
                  ...local.map(row),
                ),
                remote.length > 0
                  ? react.createElement(
                      'div',
                      { 'data-desktop-sc-section': 'remote' },
                      react.createElement(SectionHeader, {
                        label: t('sectionRemote'),
                        count: remote.length,
                        action: remotes.length > 0 ? iconButton('fetch', t('fetchAll'), onFetch, cloudGlyph) : null,
                      }),
                      ...remote.map(row),
                    )
                  : null,
              ),
        ),
      )
    }

    /**
     * 清掉"暂存并切换"按钮上分支名的回退。
     *
     * 这个按钮只会出现在 `error_localChanges` 的错误面板里，而那时 `pendingBranch`
     * 一定已经被赋值（切换是被它触发的）。因此这里只做空值兜底，不做推测——早先
     * 的写法试图从搜索词里回推分支名，那是错的：错误面板可能是在过滤之后渲染的。
     *
     * @param pendingBranch - BranchChip 记下的目标分支。
     * @returns 分支名，或空串。
     */
    function pendingBranchLabel(pendingBranch) {
      return typeof pendingBranch === 'string' ? pendingBranch : ''
    }

    // =========================================================================
    // 5. 对话框与右键菜单
    // =========================================================================

    /**
     * 分支行的右键菜单。
     *
     * 条目与图片里的 VS Code 菜单对齐，但**按上下文启用/禁用**，因为几种操作在错误的
     * 对象上没有意义：
     *   * 当前分支不能"签出"自己；
     *   * 远程分支不能"重命名"（本地重命名它只会改名跟踪引用）；
     *   * 只有远程分支能"删除远端"；只有本地分支能"删除"。
     * 给出禁用项而不是隐藏，是为了让菜单的形状稳定——用户靠位置记忆点操作，
     * 条目时有时无会让第二次点击点错。
     *
     * @param props - `{ t, menu, menuRef, status, busy, onClose, onSwitch, onDialog }`。
     * @returns React 元素。
     */
    function BranchContextMenu(props) {
      const { t, menu, menuRef, status, busy, onClose, onSwitch, onDialog } = props
      const entry = menu.branch
      const current = status?.branch ?? ''

      // 位置：先按点击点放，再按视口收进边界。菜单高度按条目数估一个上界用于翻转，
      // 拿不到真实高度时宁可往上翻——下方被裁掉比上方被裁掉更常见（菜单开在屏幕下半部）。
      const width = 268
      const estimatedHeight = 300
      const flipUp = menu.y + estimatedHeight > window.innerHeight
      const style = {
        position: 'fixed',
        zIndex: 10000,
        left: `${Math.max(8, Math.min(menu.x, window.innerWidth - width - 8))}px`,
        top: flipUp ? undefined : `${menu.y}px`,
        bottom: flipUp ? `${Math.max(8, window.innerHeight - menu.y)}px` : undefined,
        width: `${width}px`,
        maxHeight: 'min(360px, calc(100vh - 16px))',
        overflowY: 'auto',
        padding: '5px',
        borderRadius: '10px',
        border: `1px solid ${BORDER}`,
        background: SURFACE,
        color: 'var(--dsw-alias-label-primary, #202124)',
        fontFamily: UI_FONT,
        boxShadow: '0 10px 30px rgba(0,0,0,.16), 0 2px 6px rgba(0,0,0,.06)',
      }

      const item = (key, label, onClick, options) =>
        react.createElement(
          'button',
          {
            type: 'button',
            key,
            'data-desktop-sc-menuitem': key,
            disabled: busy || options?.disabled === true,
            // 禁用项也要能说明"为什么不能点"。原本给它一个 `title` 只是原地打转——
            // 属性根本没传到 DOM 上，用户看到的就是一条灰掉的、没有解释的条目。
            title: options?.title,
            onClick: () => {
              if (options?.disabled === true) return
              onClick()
            },
            style: {
              display: 'block',
              boxSizing: 'border-box',
              width: '100%',
              padding: '6px 9px',
              border: 'none',
              borderRadius: '6px',
              background: 'transparent',
              color: options?.danger === true ? DANGER : 'inherit',
              fontFamily: UI_FONT,
              fontSize: '12.5px',
              lineHeight: 1.5,
              textAlign: 'left',
              whiteSpace: 'normal',
              cursor: busy || options?.disabled === true ? 'default' : 'pointer',
              opacity: options?.disabled === true ? 0.45 : 1,
            },
          },
          label,
        )

      const separator = (key) => react.createElement('div', { key, style: { height: '1px', margin: '4px 6px', background: BORDER } })

      const items = []
      if (!entry.current) items.push(item('checkout', t('menuCheckout'), () => onSwitch(entry.name)))
      items.push(item('new-from', t('menuNewFrom', { name: entry.name }), () => onDialog({ kind: 'create', branch: entry })))
      items.push(separator('sep1'))
      items.push(
        item('merge', t('menuMergeInto', { name: entry.name }), () => onDialog({ kind: 'merge', branch: entry }), {
          // 合并到自己没有意义，而 git 也会报"Already up to date"——那种"点了没反应"
          // 比禁用更让人困惑。
          disabled: entry.name === current,
        }),
      )
      items.push(
        item('rebase', t('menuRebaseOnto', { name: entry.name }), () => onDialog({ kind: 'rebase', branch: entry }), {
          disabled: entry.name === current,
        }),
      )
      items.push(separator('sep2'))
      items.push(item('push', t('menuPush'), () => onDialog({ kind: 'push', branch: entry })))
      items.push(
        item('rename', t('menuRename'), () => onDialog({ kind: 'rename', branch: entry }), {
          // 远程分支不能重命名：本地改名只会把跟踪引用换个名字，远端那个分支纹丝不动，
          // 结果是一个名字与远端对不上的本地分支——比不做更糟。
          disabled: entry.isRemote,
          title: entry.isRemote ? t('remoteTag') : undefined,
        }),
      )
      items.push(
        item('delete', t('menuDelete'), () => onDialog({ kind: 'delete', branch: entry }), {
          disabled: entry.current,
          danger: true,
        }),
      )

      return react.createElement('div', { ref: menuRef, role: 'menu', 'data-desktop-sc-menu': entry.name, style }, ...items)
    }

    /**
     * 统一的输入对话框。
     *
     * 一个组件覆盖新建/重命名/合并/变基/签出标记/删除确认/推送/更新这几种形态：它们
     * 都是"显示一段说明 + 至多两个输入 + 确定/取消"，差别只在文案与提交时调哪条路由。
     * 为每种操作各写一个组件会让"确定按钮该禁用还是该报错"这类规则散落八处。
     *
     * @param props - `{ t, dialog, busy, remotes, onCancel, run, onDone }`。
     * @returns React 元素或 null。
     */
    function ActionDialog(props) {
      const { t, dialog, busy, remotes, onCancel, run, onDone } = props
      const kind = dialog.kind
      const branch = dialog.branch

      /**
       * 各形态的字段初值。
       *
       * 从 `dialog.branch` 派生，因此同一个组件能"从某个分支新建"（预填起点）也能
       * "凭空白手新建"（起点留空 = 当前 HEAD）。
       */
      const [name, setName] = react.useState(kind === 'rename' ? (branch?.name ?? '') : '')
      const [from, setFrom] = react.useState(kind === 'create' ? (branch?.name ?? '') : '')
      const [ref, setRef] = react.useState('')
      const [checkout, setCheckout] = react.useState(kind === 'create')
      const [noFf, setNoFf] = react.useState(false)
      // 推送需要选定远端；只有一个远端时直接选中它，多远端时让用户挑。
      const [remote, setRemote] = react.useState(remotes?.[0]?.name ?? '')
      // 强制删除的二次确认：未并入的分支第一次会被 git 拒绝，第二次才带上 force。
      const [forceConfirmed, setForceConfirmed] = react.useState(false)


      const field = (key, label, value, onChange, options) =>
        react.createElement(
          'label',
          { key, style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: SECONDARY } },
          label,
          react.createElement('input', {
            type: 'text',
            value,
            autoFocus: options?.autoFocus === true,
            placeholder: options?.placeholder ?? '',
            spellCheck: false,
            autoComplete: 'off',
            'data-desktop-sc-field': key,
            onChange: (event) => onChange(event.target.value),
            onKeyDown: (event) => {
              event.stopPropagation()
              if (event.key === 'Enter') void submit()
            },
            style: {
              boxSizing: 'border-box',
              width: '100%',
              height: '32px',
              padding: '0 9px',
              border: `1px solid ${BORDER}`,
              borderRadius: '7px',
              background: SURFACE,
              color: 'var(--dsw-alias-label-primary, #202124)',
              fontFamily: CODE_FONT,
              fontSize: '12.5px',
            },
          }),
        )

      const checkbox = (key, label, checked, onChange) =>
        react.createElement(
          'label',
          { key, style: { display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12.5px', color: 'inherit', cursor: 'pointer' } },
          react.createElement('input', {
            type: 'checkbox',
            checked,
            'data-desktop-sc-check': key,
            onChange: (event) => onChange(event.target.checked),
          }),
          label,
        )

      const button = (key, label, onClick, options) =>
        react.createElement(
          'button',
          {
            type: 'button',
            key,
            'data-desktop-sc-button': key,
            disabled: busy || options?.disabled === true,
            onClick,
            style: {
              padding: '6px 14px',
              borderRadius: '7px',
              border: `1px solid ${options?.primary === true ? 'transparent' : BORDER}`,
              background: options?.primary === true ? ACCENT : SURFACE,
              color: options?.primary === true ? '#fff' : options?.danger === true ? DANGER : 'inherit',
              fontFamily: UI_FONT,
              fontSize: '12.5px',
              cursor: busy || options?.disabled === true ? 'default' : 'pointer',
              opacity: busy || options?.disabled === true ? 0.55 : 1,
            },
          },
          label,
        )

      /** 各形态的标题、正文与提交动作。 */
      let title = ''
      let body = null
      let submit = () => undefined

      if (kind === 'create') {
        title = t('dialogNewTitle')
        body = [
          field('name', t('dialogFieldName'), name, setName, { autoFocus: true, placeholder: 'feature/my-branch' }),
          field('from', `${t('dialogFieldFrom')}（${t('dialogFromHead')}）`, from, setFrom),
          checkbox('checkout', t('dialogCheckoutAfter'), checkout, setCheckout),
        ]
        submit = async () => {
          // 校验放在提交时而不是输入时：`feature/` 这种"还没打完"的中间状态不该
          // 立刻报红。空名字是唯一在提交前就该拦住的。
          if (name.trim() === '') return
          const result = await run('branch/create', {
            name: name.trim(),
            ...(from.trim() === '' ? {} : { from: from.trim() }),
            checkout,
          })
          if (result !== undefined) onDone()
        }
      } else if (kind === 'rename') {
        title = t('dialogRenameTitle')
        body = [field('name', t('dialogFieldName'), name, setName, { autoFocus: true })]
        submit = async () => {
          if (name.trim() === '' || name.trim() === branch?.name) {
            onCancel()
            return
          }
          const result = await run('branch/rename', { from: branch.name, to: name.trim() })
          if (result !== undefined) onDone()
        }
      } else if (kind === 'merge') {
        title = t('dialogMergeTitle')
        body = [
          react.createElement('div', { key: 'text', style: { fontSize: '12.5px', lineHeight: 1.6 } }, t('mergingInto', { name: branch?.name ?? '', into: branch?.current === true ? branch.name : '' })),
          checkbox('no-ff', t('dialogMergeNoFf'), noFf, setNoFf),
        ]
        submit = async () => {
          const result = await run('branch/merge', { name: branch.name, noFf })
          if (result !== undefined) onDone()
        }
      } else if (kind === 'rebase') {
        title = t('dialogRebaseTitle')
        body = [react.createElement('div', { key: 'text', style: { fontSize: '12.5px', lineHeight: 1.6 } }, t('rebasingOnto', { branch: '', onto: branch?.name ?? '' }))]
        submit = async () => {
          const result = await run('branch/rebase', { onto: branch.name })
          if (result !== undefined) onDone()
        }
      } else if (kind === 'checkout-ref') {
        title = t('dialogCheckoutRefTitle')
        body = [
          field('ref', t('dialogFieldRef'), ref, setRef, { autoFocus: true, placeholder: 'v1.0.0' }),
          react.createElement('div', { key: 'hint', style: { fontSize: '11.5px', color: TERTIARY, lineHeight: 1.6 } }, t('dialogRefHint')),
        ]
        submit = async () => {
          if (ref.trim() === '') return
          const result = await run('checkout', { branch: ref.trim() })
          if (result !== undefined) onDone()
        }
      } else if (kind === 'delete') {
        title = t('confirmDeleteTitle')
        const unmerged = forceConfirmed
        body = [
          react.createElement('div', { key: 'text', style: { fontSize: '12.5px', lineHeight: 1.6, overflowWrap: 'anywhere' } }, t('confirmDeleteBody', { name: branch?.name ?? '' })),
          branch?.isRemote
            ? react.createElement('div', { key: 'remote', style: { fontSize: '12px', color: DANGER, lineHeight: 1.6 } }, t('confirmDeleteRemote', { remote: branch.remote ?? '' }))
            : null,
          unmerged ? react.createElement('div', { key: 'note', style: { fontSize: '12px', color: APPROVAL, lineHeight: 1.6 } }, t('confirmDeleteUnmerged')) : null,
        ]
        submit = async () => {
          // 第一次不带 force：host 会用 `--is-ancestor` 判定，未并入就回 409 notMerged。
          // 那时候才在界面上把"这会把提交丢掉"讲清楚，并要求再点一次。
          const result = await run('branch/delete', branch?.isRemote === true
            ? { name: branch.name, remote: true }
            : { name: branch.name, ...(forceConfirmed ? { force: true } : {}) })
          if (result !== undefined) onDone()
        }
      } else if (kind === 'push') {
        title = t('actionPush')
        body = [
          react.createElement('div', { key: 'text', style: { fontSize: '12.5px', lineHeight: 1.6, overflowWrap: 'anywhere' } }, branch?.isRemote === true ? branch.name : branch?.name ?? ''),
          remotes.length > 1
            ? react.createElement(
                'label',
                { key: 'remote', style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: SECONDARY } },
                t('remoteTag'),
                react.createElement(
                  'select',
                  {
                    value: remote,
                    'data-desktop-sc-field': 'remote',
                    onChange: (event) => setRemote(event.target.value),
                    style: { height: '32px', borderRadius: '7px', border: `1px solid ${BORDER}`, background: SURFACE, color: 'inherit', fontFamily: UI_FONT, fontSize: '12.5px' },
                  },
                  remotes.map((item) => react.createElement('option', { key: item.name, value: item.name }, item.name)),
                ),
              )
            : null,
        ]
        submit = async () => {
          const result = await run('remote', {
            action: 'push',
            ...(remote === '' ? {} : { remote }),
            // 只推**本地分支**：远程分支条目上"推送"等于把远端状态推回它自己，无意义。
            ...(branch !== undefined && branch.isRemote !== true ? { branch: branch.name } : {}),
            // 没有上游的分支第一次推送要建立跟踪，否则下次 push 还得指定远端。
            ...(branch !== undefined && branch.upstream === '' ? { setUpstream: true } : {}),
          })
          if (result !== undefined) onDone()
        }
      } else if (kind === 'update') {
        title = t('actionUpdate')
        body = [react.createElement('div', { key: 'text', style: { fontSize: '12.5px', lineHeight: 1.6 } }, `${t('menuFetch')} → pull`)]
        submit = async () => {
          // 先 fetch 再 pull：fetch 会把远端新提交取回本地对象库，也让领先/落后数字
          // 在拉取之前就是准的；pull 自己虽然也会 fetch，但合并失败时用户至少已经
          // 看到了最新的远端状态。
          const fetched = await run('remote', { action: 'fetch' })
          if (fetched === undefined) return
          const result = await run('remote', { action: 'pull' })
          if (result !== undefined) onDone()
        }
      } else if (kind === 'commit') {
        title = t('actionCommit')
        body = [react.createElement('div', { key: 'text', style: { fontSize: '12.5px', lineHeight: 1.6 } }, t('hintCommitOrStash'))]
        submit = () => {
          // 提交需要写提交信息，而信息输入框属于官方 composer。这里不替用户填内容，
          // 而是把焦点交给 composer —— 一句我们编不出、用户又必须自己写的提交信息，
          // 替他生成只会更慢。
          const composer = document.querySelector('textarea, [contenteditable="true"]')
          if (composer !== null && typeof composer.focus === 'function') composer.focus()
          onDone()
        }
      }

      return react.createElement(
        'div',
        {
          'data-desktop-sc-dialog': kind,
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': title,
          onKeyDown: (event) => {
            event.stopPropagation()
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit()
          },
          style: {
            position: 'fixed',
            zIndex: 10001,
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: 'min(360px, calc(100vw - 32px))',
            boxSizing: 'border-box',
            padding: '14px',
            borderRadius: '12px',
            border: `1px solid ${BORDER}`,
            background: SURFACE,
            color: 'var(--dsw-alias-label-primary, #202124)',
            fontFamily: UI_FONT,
            boxShadow: '0 18px 48px rgba(0,0,0,.22)',
          },
        },
        react.createElement('div', { style: { fontSize: '13.5px', fontWeight: 600, marginBottom: '10px' } }, title),
        react.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, body),
        react.createElement(
          'div',
          { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' } },
          // 删除是唯一不可从界面撤销的操作，因此确定按钮的文案随"是否已确认过"
          // 而变——让用户读到的不是一个笼统的"确定"。
          kind === 'delete'
            ? button('cancel', t('dialogCancel'), onCancel)
            : button('cancel', t('dialogCancel'), onCancel),
          button('confirm', kind === 'delete' ? (forceConfirmed ? t('confirmForceDeleteButton') : t('confirmDeleteButton')) : t('dialogConfirm'), () => void submit(), {
            primary: kind !== 'delete',
            danger: kind === 'delete',
            disabled: (kind === 'create' && name.trim() === '') || (kind === 'checkout-ref' && ref.trim() === ''),
          }),
        ),
        // 删除未并入分支时的第二段确认。用"再点一次同一个按钮"而不是勾选框：
        // 勾选框在有肌肉记忆之后等于不存在，而按钮文案的变化至少需要一次阅读。
        kind === 'delete' && !forceConfirmed
          ? react.createElement(
              'button',
              {
                type: 'button',
                'data-desktop-sc-force': '',
                disabled: busy,
                onClick: () => setForceConfirmed(true),
                style: {
                  marginTop: '8px',
                  width: '100%',
                  padding: '5px 8px',
                  border: 'none',
                  background: 'transparent',
                  color: APPROVAL,
                  fontFamily: UI_FONT,
                  fontSize: '11.5px',
                  textAlign: 'left',
                  cursor: busy ? 'default' : 'pointer',
                },
              },
              t('forceDeleteNote'),
            )
          : null,
      )
    }

    /** 独立工具条只负责布局，子槽继续提供原来的会话作用域与操作。 */
    function ContextBar(props) {
      return react.createElement(
        'div',
        {
          'data-desktop-context-bar': '',
          style: {
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '6px',
            minWidth: 0,
            boxSizing: 'border-box',
            alignSelf: 'center',
            width: 'calc(100% - var(--dsh-composer-side-clearance, 16px) - var(--dsh-composer-side-clearance, 16px))',
            maxWidth: 'var(--dsh-composer-card-max-width, 100%)',
            // 官方输入卡片的圆角为 22px；背景延伸到卡片后面，填满交接处两角。
            margin: '0 0 calc(-22px - var(--dsh-composer-stack-gap, 6px))',
            padding: '8px 12px 30px',
            borderRadius: '22px 22px 0 0',
            background: 'var(--dsw-alias-bg-module-platform, #f3f3f3)',
            fontFamily: UI_FONT,
          },
        },
        react.createElement(BranchChip, props),
        props.renderSlot(ACTION_SLOT, {}),
      )
    }

    // =========================================================================
    // 6. 槽位挂载
    // =========================================================================

    /**
     * 挂载插件。
     * @param ctx - 客户端 cordis 上下文。
     */
    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = name
        style.textContent = `
          [data-desktop-branch-menu] input::placeholder { color: ${SECONDARY}; }
          [data-desktop-branch-menu] input:focus {
            outline: 2px solid color-mix(in srgb, ${ACCENT} 25%, transparent);
            outline-offset: -1px;
          }
          [data-desktop-branch-option]:hover:not(:disabled) {
            --dsh-branch-option-bg: var(--dsw-alias-bg-module-platform, #f5f6f8);
          }
          [data-desktop-branch-option]:focus-visible {
            outline: 2px solid ${ACCENT};
            outline-offset: -2px;
          }
          [data-desktop-sc-action]:hover:not(:disabled),
          [data-desktop-sc-menuitem]:hover:not(:disabled) {
            background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.10));
          }
          [data-desktop-sc-action]:focus-visible,
          [data-desktop-sc-menuitem]:focus-visible,
          [data-desktop-sc-icon]:focus-visible {
            outline: 2px solid ${ACCENT};
            outline-offset: -2px;
          }
          [data-desktop-sc-icon]:hover:not(:disabled) {
            background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.10));
            color: var(--dsw-alias-label-primary);
          }
        `
        document.head.appendChild(style)
        return () => style.remove()
      }, 'gitbar: menu styles')

      // 注册两套字典。与官方客户端插件同一做法：`locale` 是已提供的服务，
      // 字典挂在自定义命名空间下，`ctx.locale.bind(NS)` 得到按当前语言解析的 `t`。
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'gitbar: dictionaries')

      // `slots.inject` 保证目标槽已声明；返回的函数是注销器，交给 `ctx.effect`
      // 绑定到插件生命周期——插件卸载时徽章自动消失。这是官方包一致的写法。
      // 这是 list 槽，注册项必须带 `id`（只有 `key` 会被拒绝：
      // "list slot ... requires options.id"）。`order` 决定它在列表中的位置。
      //
      // `locale: NS` 让槽知道本组件用哪个命名空间的字典；`inject` 里的 `t` 是
      // 按当前语言绑定的翻译函数，会作为 props 传给组件（官方 directory-picker 同此写法）。
      ctx.effect(
        () =>
          ctx.slots.inject(SLOT, () =>
            ctx.slots.register(
              {
                name: SLOT,
                id: ID,
                order: ORDER,
                locale: NS,
                children: { [ACTION_SLOT]: { kind: 'list', scope: 'session' } },
                inject: () => ({ t: ctx.locale.bind(NS) }),
              },
              ContextBar,
            ),
          ),
        'dsh-client-ui-gitbar: branch chip',
      )
    }

    exports.name = name
    exports.apply = apply
    // 必须声明 inject：cordis 的服务是懒解析的，不声明就直接读 `ctx.slots` 会抛
    // "cannot get property \"slots\" without inject"，而且这个错误会让**整个界面**
    // 渲染失败（不只是本插件）——排查时页面是全白的，误导性很强。
    // `locale` 同理：不声明就取不到 `ctx.locale.register`。
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
