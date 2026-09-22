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

    /**
     * 多仓库项目里"用户正在看哪一个仓库"的持久化键。
     *
     * 与 review 插件各存各的（两个插件是独立 bundle，拿不到彼此的作用域）：即使两边存的
     * 不一样，也只是"两个面板各自记着上次看的仓库"，不会出现"徽章在 A、提交发到 B"——
     * 每一次请求的 `repository` 都由**发请求的那一方**带上，host 只做校验。
     */
    const ACTIVE_REPO_KEY = 'dsh.gitbar.activeRepository'

    /**
     * `workspaceRoot → 当前 active 仓库根`。
     *
     * 为什么放在模块级而不是组件里：`call()` 在组件外面（它是一个普通 async 函数），
     * 所有请求都从它出去，因此"每个请求都带上当前仓库"只需要在**这一处**实现。组件负责
     * 在渲染期与用户选择时更新它（与文件里 `syncGeneration.current` 那套同一思路）。
     */
    const activeRepos = new Map()
    /**
     * `workspaceRoot → 发现的仓库列表`（>1 个时才记）。
     *
     * 只有它才能回答"要不要带 `repository`"：单仓库（含"工作区自己就是仓库"与"只有一个
     * 子仓库"）时**一个字都不带**，请求形状与 1.5.2 逐字一致——那些请求已经有测试钉着，
     * 而多带一个参数就是行为变化。
     */
    const multiRepositories = new Map()
    /** `localStorage` 里那一份的内存副本（读到/写不到时功能照常）。 */
    let savedActiveRepos = null

    /** 记下这个工作区发现的仓库（列表 ≤1 时反而要清掉，因为项目可能被重新组织过）。 */
    const rememberProjectRepositories = (workspace, repositories) => {
      if (typeof workspace !== 'string' || workspace === '') return
      if (!Array.isArray(repositories) || repositories.length <= 1) {
        multiRepositories.delete(workspace)
        return
      }
      multiRepositories.set(workspace, repositories)
    }

    const readSavedActiveRepos = () => {
      if (savedActiveRepos !== null) return savedActiveRepos
      try {
        const raw = window.localStorage.getItem(ACTIVE_REPO_KEY)
        const parsed = raw === null ? undefined : JSON.parse(raw)
        savedActiveRepos = parsed !== null && typeof parsed === 'object' ? parsed : {}
      } catch {
        savedActiveRepos = {}
      }
      return savedActiveRepos
    }

    /**
     * 当前该用哪个仓库：**只有多仓库项目才返回非空**（见 multiRepositories 的说明）。
     *
     * @param workspace - 工作区路径。
     * @returns repositoryRoot 或空串。
     */
    const activeRepositoryOf = (workspace) => {
      if (typeof workspace !== 'string' || workspace === '') return ''
      const list = multiRepositories.get(workspace)
      if (list === undefined) return ''
      const known = (value) => typeof value === 'string' && list.some((entry) => entry?.repositoryRoot === value)
      const memory = activeRepos.get(workspace)
      if (known(memory)) return memory
      const saved = readSavedActiveRepos()[workspace]
      if (known(saved)) return saved
      // 没选过（或选的那个已经不存在了）：用列表里的第一个。宿主侧的默认规则**逐字相同**
      // （工作区自己的仓库 → 第一个），因此两边一定指向同一个仓库。
      const own = list.find((entry) => entry?.relativePath === '')
      return (own ?? list[0]).repositoryRoot
    }

    /** 记住用户的选择（内存 + 落盘）。值没变时什么都不做——它在渲染期会被调用。 */
    const rememberActiveRepository = (workspace, repositoryRoot) => {
      if (typeof workspace !== 'string' || workspace === '' || typeof repositoryRoot !== 'string') return
      if (activeRepos.get(workspace) === repositoryRoot) return
      activeRepos.set(workspace, repositoryRoot)
      try {
        const map = { ...readSavedActiveRepos(), [workspace]: repositoryRoot }
        savedActiveRepos = map
        window.localStorage.setItem(ACTIVE_REPO_KEY, JSON.stringify(map))
      } catch {
        // 存不了不影响本次会话内的选择。
      }
    }

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
      /**
       * 多仓库项目：徽章前面先说清"这个项目里有几个仓库"。
       *
       * 数字仍然是**当前仓库**的改动数（徽章的主体是分支），因此必须把"有多个仓库"写在
       * 旁边——否则用户会把某个子仓库的状态当成整个项目的。
       */
      repoCount: 'Git · {count} 个仓库',
      repoSelect: '选择仓库',
      repoDiscovering: '正在发现更多 Git 仓库…',
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
      /** Multi-repository project: how many repositories live in this project. */
      repoCount: 'Git · {count} repositories',
      repoSelect: 'Choose repository',
      repoDiscovering: 'Discovering more Git repositories…',
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
     * 单击分支行之后**等多久**才弹出操作菜单（毫秒）。
     *
     * IDEA 的分支行是"单击选中、双击切换"：双击在浏览器里必然先派发两次 click，因此
     * 单击必须等一小会儿才能确认它真的是单击。200ms 是这段延迟的经验值——短于 180ms
     * 会在稍慢的双击上误弹菜单，长于 220ms 用户会觉得"点了没反应"。
     *
     * 第二次 click 一进来就取消这个定时器（见 BranchChip 的 onBranchClick），
     * 因此正常的双击**不会**出现"菜单闪一下再切换"。
     */
    const SINGLE_CLICK_MS = 200

    /**
     * 一次为多少个分支补算精确的领先/落后。
     *
     * 只对**屏幕上真的能看见**的分支发这个请求（视口交叉判定，见 collectVisibleBranchNames），
     * 因此这个数字是"一屏行数"的量级而不是"分支总数"的量级——300 个分支的仓库也只补算这些。
     */
    const SYNC_BATCH = 32

    /**
     * 一次面板会话里**自动**（视口）补算的名字总数上限。
     *
     * 这是与仓库规模无关的常数上限：即使出现"候选集合每轮都变"这种异常循环，自动补算也
     * 扫不完整个仓库（2000 个分支的仓库同样封顶 512 次 `rev-list`）。用户主动选中的分支
     * 不受它限制（那是每次点击一个名字的动作），而且每个名字每份列表只请求一次。
     */
    const SYNC_AUTO_BUDGET = 512

    /**
     * 拿不到 DOM 时，"一屏"按多少行算（见 collectVisibleBranchNames）。
     *
     * 它只是一个固定大小的窗口，**不是**"过滤后的整张列表"——后者正是"打开面板后把整个
     * 仓库算一遍"的入口。
     */
    const VISIBLE_FALLBACK_ROWS = 12

    /**
     * 二级（级联）菜单的宽度、与一级面板的水平间隙、以及离视口边缘的最小距离。
     *
     * 这三个常数与 `BranchContextMenu` 的样式是**同一份契约**：宽度写在样式里、间隙决定
     * 菜单不压住面板、边距决定翻不到屏幕外。放在这里而不是组件内部，是因为纯函数
     * `cascadeMenuPosition` 也要用它们，而它必须能在没有 DOM 的地方被单测。
     */
    const CASCADE_MENU_WIDTH = 268
    const CASCADE_MENU_GAP = 6
    const CASCADE_MENU_MARGIN = 8

    /**
     * 二级菜单的高度上界：样式里的 `maxHeight` 与**首帧的估算高度**是同一个值。
     *
     * 首帧还没有真实节点可量（同步渲染里读不到布局），而"先画在屏幕外再挪回来"会肉眼可见
     * 地闪一下。因此首帧一律用这个**上界**去算纵向位置：估算 ≥ 真实高度，于是首帧就已经
     * 落在视口内；挂载后用真实高度再细化一次，只会让位置往里收一点（见 BranchContextMenu
     * 的 measured）。
     */
    const CASCADE_MENU_ESTIMATED_HEIGHT = 360

    /**
     * 从渲染出来的分支行里挑出**真正与滚动容器相交**的那些名字。
     *
     * 为什么要用 DOM 相交而不是"搜索过滤之后的行"：过滤后的集合在 300/2000 分支的仓库里
     * 几乎是全仓库（没有搜索词时就是全部），拿它当补算候选就等于"后台把所有分支都算一遍"。
     * 真正可见的行数只与**面板高度**有关，与仓库有多少分支无关。
     *
     * 判定方式刻意用 `getBoundingClientRect()` 的区间相交，而不是自己算
     * `scrollTop / 行高`：行高来自样式（`min-height` + 内边距），分区标题也占高度，
     * 自己算必然要维护一份"布局常量"，样式一改就悄悄算错。
     *
     * 两个防御：
     *   * 行按 DOM 顺序遍历（也就是视觉顺序），一旦某行完全落在容器下方就**停止**——
     *     再往下只会更靠下，因此长列表也不会被整段扫一遍；
     *   * 拿不到 DOM（桩渲染 / SSR / 无布局）时退化成固定大小的窗口 `VISIBLE_FALLBACK_ROWS`。
     *
     * @param node - 滚动容器（`null` 表示拿不到 DOM）。
     * @param fallbackNames - 过滤后的分支名字（按渲染顺序），仅用于退化路径。
     * @returns 可见分支名（去重、保持渲染顺序）。
     */
    function collectVisibleBranchNames(node, fallbackNames) {
      const fallback = () => fallbackNames.slice(0, VISIBLE_FALLBACK_ROWS).map((entry) => entry.name)
      if (node === null || typeof node !== 'object' || typeof node.querySelectorAll !== 'function') return fallback()
      const box = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null
      if (box === null || typeof box.height !== 'number' || box.height <= 0) return fallback()

      const names = []
      const seen = new Set()
      for (const row of node.querySelectorAll('[data-desktop-branch-option]')) {
        const rect = typeof row.getBoundingClientRect === 'function' ? row.getBoundingClientRect() : null
        if (rect === null) continue
        // 视口上方：还没到可见区，继续。
        if (rect.bottom <= box.top) continue
        // 视口下方：DOM 顺序就是视觉顺序，后面的只会更靠下。
        if (rect.top >= box.bottom) break
        const name = typeof row.getAttribute === 'function' ? row.getAttribute('data-desktop-branch-name') : null
        if (typeof name !== 'string' || name === '' || seen.has(name)) continue
        seen.add(name)
        names.push(name)
      }
      return names
    }

    /**
     * 二级（级联）菜单的位置：IDEA 分支弹窗那样**贴着一级面板的外侧**展开。
     *
     * 为什么必须是纯函数：位置规则有三条分支（右开、左开、两侧都放不下时夹进视口）和一次
     * 纵向翻转，全都要能逐条断言。假 DOM 量不到真实布局，但"给定两个矩形，菜单该落在哪"
     * 这件事本身与 DOM 无关，因此把规则抽到这里，测试直接喂坐标。
     *
     * 横向（严格按顺序，前两条优先）：
     *   1. 右侧放得下（`viewport.width - panelRect.right >= submenuWidth + margin`）
     *      → `left = panelRect.right + gap`，`side = 'right'`；
     *   2. 否则左侧放得下（`panelRect.left - gap >= submenuWidth + margin`）
     *      → `left = panelRect.left - gap - submenuWidth`，`side = 'left'`；
     *   3. 两侧都放不下（面板几乎占满视口宽度）才允许夹进视口：挑空间更大的一侧，再
     *      `clamp(left, margin, viewport.width - submenuWidth - margin)`，`side = 'clamp'`。
     *
     * **第 3 条只在第 1、2 条都不成立时才会走到**：只要有一侧放得下，菜单就绝不落在面板
     * 自己的横向区间里——那条退化路径正是这次要修的现象（菜单压着一级面板，看起来像"同一层"）。
     *
     * 纵向：
     *   * 默认 `top = rowRect.top`（对齐被点的那一行，而不是菜单中点或面板中点）；
     *   * 若 `top + height > viewport.height - margin`，整体上移到
     *     `viewport.height - margin - height`，再把 `top` 夹到不小于 `margin`。
     *
     * @param options - `{ rowRect, panelRect, submenuWidth, submenuHeight, viewport, gap?, margin? }`；
     *   矩形都是 `{ top, bottom, left, right }`。`panelRect` 缺失（还没量到面板）时退化成
     *   把被点的那一行当成面板：至少保证菜单在行的右侧，而不是跑到屏幕角落。
     * @returns `{ left, top, side }`，`side` 为 `'right' | 'left' | 'clamp'`。
     */
    function cascadeMenuPosition(options) {
      const width = Number.isFinite(options.submenuWidth) ? options.submenuWidth : CASCADE_MENU_WIDTH
      const height = Number.isFinite(options.submenuHeight) ? options.submenuHeight : CASCADE_MENU_ESTIMATED_HEIGHT
      const gap = Number.isFinite(options.gap) ? options.gap : CASCADE_MENU_GAP
      const margin = Number.isFinite(options.margin) ? options.margin : CASCADE_MENU_MARGIN
      const viewportWidth = options.viewport.width
      const viewportHeight = options.viewport.height
      const row = options.rowRect
      const panel = options.panelRect ?? row

      const rightRoom = viewportWidth - panel.right
      const leftRoom = panel.left - gap
      let left
      let side
      if (rightRoom >= width + margin) {
        left = panel.right + gap
        side = 'right'
      } else if (leftRoom >= width + margin) {
        left = panel.left - gap - width
        side = 'left'
      } else {
        left = rightRoom >= leftRoom ? panel.right + gap : panel.left - gap - width
        left = Math.max(margin, Math.min(left, viewportWidth - width - margin))
        side = 'clamp'
      }

      let top = Number.isFinite(row.top) ? row.top : margin
      if (top + height > viewportHeight - margin) top = viewportHeight - margin - height
      if (top < margin) top = margin

      return { left, top, side }
    }

    /**
     * 工作区世代闸门（workspace generation gate）。
     *
     * **这个文件的另一半（`dsh-client-ui-review/lib/client.js`）里有一份孪生实现**，
     * 差异只在注释里提到的调用点。不能抽成共享文件：客户端 bundle 的契约是"一个插件只有
     * 一个脚本"，模块加载器只认它自己的基线表，同目录的其它文件在浏览器里取不到
     * （见本文件头部的说明）。因此两处各留一份，且都保持同一套语义。
     *
     * 它解决的是一整类 bug：异步请求在 workspace 改变之后才返回，把**旧项目**的数据写进
     * 新项目的状态里。界面上的表现是"切了项目，数字/分支/文件还是上一个项目的"，而且
     * 时有时无（取决于两个请求谁先回来）。做法是把"这次请求属于哪个工作区、第几代、第几号"
     * 记在请求上，响应回来时只有仍然属于当前代、且仍是该状态分片最新的一次请求才允许落地。
     *
     * 四条硬约束（每一条都对应一次真实的错误形状）：
     *   1. workspace 改变**立即**换代。换代发生在 render 期（见 useWorkspaceGate），
     *      不是等 effect——effect 在渲染之后才跑，中间那一帧旧数据就已经画出去了。
     *   2. loading 也走同一条判定。否则旧请求的 `finally` 会把"正在加载"关掉，界面于是
     *      显示新工作区的空数据（"进去什么都没有"）。
     *   3. 同一工作区、同一类请求 single-flight。定时轮询在慢仓库上会重叠：上一个请求还没
     *      回来下一个就发出去，多个 git 进程同时跑，而返回顺序与发起顺序无关。
     *   4. 写操作**抢占**它要写的状态分片。写操作回的是最新状态，任何在它之前**发起**的读
     *      都不允许覆盖它——哪怕那个读先返回。
     *
     * @returns 闸门对象；每个使用它的组件一个（见 useWorkspaceGate）。
     */
    function createWorkspaceGate() {
      let workspace
      let generation = 0
      let nextId = 0
      /** single-flight：`generation\u0000kind` → 在途条目。 */
      const inflight = new Map()
      /** 每个状态分片当前"最新一次请求"的 id；只有它允许写。 */
      const latestOfSlice = new Map()

      const isCurrent = (ticket) =>
        ticket.generation === generation && Object.is(ticket.workspace, workspace)

      /** 这是该请求所写分片的最新一次请求吗？（当前代 + 最新号） */
      const isLatest = (ticket) =>
        isCurrent(ticket) && ticket.slices.every((slice) => latestOfSlice.get(slice) === ticket.id)

      return {
        /** 记录当前工作区；变了就换代。返回是否发生了换代。 */
        sync(next) {
          if (Object.is(next, workspace)) return false
          workspace = next
          generation += 1
          // 在途请求从这一刻起一律过期，直接丢掉引用，避免 map 无限增长。
          inflight.clear()
          return true
        },
        get workspace() {
          return workspace
        },
        get generation() {
          return generation
        },
        /** 这次响应还属于当前工作区/当前代吗？ */
        isCurrent,
        /** 这是该请求所写分片的最新一次请求吗？（当前代 + 最新号） */
        accept: isLatest,
        /**
         * 发起一次请求。**永远不 reject**：成功/失败都以 `{ ok, value | cause, ticket }`
         * 的形状返回，调用方只需判一次 `accept`，不必再包一层 try/catch——那层 catch
         * 正是"旧工作区的错误写进新工作区"最容易漏掉的地方。
         *
         * @param kind - 请求种类（single-flight 的键，也是日志/诊断里的名字）。
         * @param task - 真正发请求的函数。
         * @param options - `coalesce`：同类请求合并；`slices`：这次响应要写哪些状态分片
         *   （默认就是 kind 自己）。
         * @returns `{ ticket, promise }`。
         */
        run(kind, task, options) {
          const slices = Array.isArray(options?.slices) ? options.slices : [kind]
          const coalesce = options?.coalesce === true
          const key = `${generation}\u0000${kind}`
          if (coalesce) {
            const hit = inflight.get(key)
            // **只复用仍然有效的在途请求。** 写操作会抢占 `branches` 分片，那时这个在途
            // 请求的票据已经作废：把它交回调用方，调用方 await 完会发现 `accept` 为假，
            // 于是既不发新请求、也不清 loading——界面就永远停在"正在加载分支…"，
            // 而陈旧列表一直挂着（实测复现：写操作完成后分支列表再也不刷新）。
            // 作废的条目直接丢掉，让下面真的发起新请求。
            if (hit !== undefined && isLatest(hit.ticket)) return hit
            if (hit !== undefined) inflight.delete(key)
          }
          const ticket = { workspace, generation, id: (nextId += 1), kind, slices }
          for (const slice of slices) latestOfSlice.set(slice, ticket.id)
          const promise = Promise.resolve()
            .then(task)
            .then(
              (value) => ({ ok: true, value, ticket }),
              (cause) => ({ ok: false, cause, ticket }),
            )
          const entry = { ticket, promise }
          if (coalesce) {
            inflight.set(key, entry)
            void promise.then(() => {
              if (inflight.get(key) === entry) inflight.delete(key)
            })
          }
          return entry
        },
      }
    }

    /**
     * 给一个组件取它的工作区闸门，并在 render 期就完成换代。
     *
     * 为什么在 render 期同步：`workspace` 是从 `useSessions` 上读来的，用户切换项目时
     * 它会在这一个 render 里就是新值。此刻换代之后，本帧读到的 generation 已经是新的，
     * 于是"上一个工作区的数据"从**这一帧**起就不再被渲染（见各处 `state.generation ===
     * generation ? state : 空状态` 的写法）——不需要等任何 effect 跑完。
     *
     * 同一个值重复 sync 是幂等的，因此 React 的严格模式双渲染、或一次切换引起的多次
     * 渲染都不会多换代。
     *
     * @param workspace - 当前工作区路径。
     * @returns 稳定的闸门对象。
     */
    function useWorkspaceGate(workspace) {
      const ref = react.useRef(null)
      // 判 null 也判 undefined：`useRef()` 不带参数（或某些实现）给的是 undefined。
      if (ref.current === null || ref.current === undefined) ref.current = createWorkspaceGate()
      const gate = ref.current
      gate.sync(workspace)
      return gate
    }

    /** 没有会话来源时的空选择器钩子：形状与"没有会话"一致（返回 undefined）。 */
    const absentSessions = (selector) => (typeof selector === 'function' ? selector(undefined) : undefined)

    /**
     * 取一个"**可能缺席**的标准钩子"，并在**首次渲染时锁定**这个选择。
     *
     * 为什么必须锁定：调用点原来写成
     * `typeof props.useSessions === 'function' ? props.useSessions(sel) : undefined`——
     * 那是**条件调用**。`useSessions` 的真身（渲染器的
     * `useSyncExternalStoreWithSelector`）内部要占若干个 hook 槽，一旦它在两次渲染之间
     * 出现或消失，本组件调用的 hook 数量就变了：React 抛 #310
     * "Rendered more/fewer hooks than during the previous render"，并把**整棵子树卸掉**
     * ——现象与"徽章/面板突然消失"完全一样，很难与数据问题区分。
     *
     * 与 review 插件里那份是**同一份实现的孪生拷贝**（两个插件是各自独立的 bundle，
     * 拿不到彼此的作用域）：两边的规则必须一致。
     *
     * @param candidate - `props.useSessions` 之类的候选（可能 undefined）。
     * @param fallback - 缺席时用的空实现。
     * @returns 选定的钩子（同一实例上恒定）。
     */
    function useLatchedHook(candidate, fallback) {
      const ref = react.useRef(null)
      if (ref.current === null) ref.current = typeof candidate === 'function' ? candidate : fallback
      return ref.current
    }

    /**
     * 请求 host 侧的 git 路由。
     * @param path - 相对 API 前缀的路径，如 'status'。
     * @param options - `cwd` 是要查询的工作区；`query` 是附加的查询参数；`init` 是
     *   fetch 的额外选项。
     * @returns 解析后的 JSON；失败时抛出。
     */
    async function call(path, options) {
      const { cwd, query, ...init } = options ?? {}
      // 必须带上工作区：会话可以有自己的项目，与外壳启动时的那个不同。
      // 不传的话 host 会用外壳工作区，于是切换项目后徽章仍显示上一个仓库的分支。
      const params = new URLSearchParams()
      if (typeof cwd === 'string' && cwd !== '') params.set('cwd', cwd)
      // 多仓库项目（工作区自己不是仓库、子目录里有仓库）里再带上"现在在看哪一个"。
      // host 只把它当**不可信输入**校验（必须是这个工作区里发现过的仓库），因此这里
      // 带的永远是它自己告诉我们的那一个。单仓库时**一个字都不带**——与 1.5.2 完全一致。
      const repositoryRoot = activeRepositoryOf(cwd)
      if (repositoryRoot !== '') params.set('repository', repositoryRoot)
      for (const [key, value] of Object.entries(query ?? {})) params.set(key, String(value))
      const search = params.toString()
      const response = await fetch(`${API}/${path}${search === '' ? '' : `?${search}`}`, {
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
      const { sessionId } = props ?? {}

      // 本会话的工作区。这是必须在**每个会话**里读的：用户可以在应用内为会话选择
      // 项目，它与外壳启动时的 `--workspace` 是两回事。用外壳那个会让徽章显示上一个
      // 仓库的分支（实测踩到过：外壳是 mmsm-amis、会话切到 scheduler-service-task，
      // 徽章却一直显示 mmsm-amis 的分支）。
      //
      // **钩子必须无条件调用**：原来写成
      // `typeof useSessions === 'function' && sessionId !== undefined ? useSessions(...) : undefined`，
      // 那是条件调用——`useSessions` 真身内部占多个 hook 槽，一旦它在两次渲染之间出现或
      // 消失，本组件的 hook 数量就变了，React 抛 #310 并把整棵子树卸掉（现象与"徽章/
      // 面板突然消失"一样）。现在把"有没有源 / 有没有 sessionId"全部交给选择器表达，
      // 钩子用 useLatchedHook 在首次渲染锁定（见它的说明）。
      const useSessions = useLatchedHook(props?.useSessions, absentSessions)
      const workspace = useSessions((state) => {
        if (sessionId === undefined) return undefined
        const cwd = state?.byId?.[sessionId]?.cwd
        // 只接受非空字符串：选择器必须返回**原始值**，每次渲染给出同一个引用，
        // 否则 useSyncExternalStore 会警告 "The result of getSnapshot should be cached"。
        return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
      })

      /**
       * **一次工作区一份状态**。
       *
       * 所有异步结果都带 `generation`：渲染时只有当它等于当前代才被采用，否则一律当成
       * "上一个工作区的数据"丢弃。这样"切换项目后仍显示旧项目分支"在结构上就不可能发生
       * ——包括 loading 与 busy 这两个容易被 `finally` 覆盖的开关（它们也住在这一份状态里，
       * 因此旧请求的收尾写不进新的那一份）。
       *
       * 初值 `generation: -1`：第一次渲染必然是"没有当前代的数据"，于是先进入加载态而
       * 不是显示空列表。
       */
      const [state, setState] = react.useState({ generation: -1 })
      const gate = useWorkspaceGate(workspace)
      const generation = gate.generation
      /** 当前代的那一份；不是当前代就退化成空壳（这一帧就看不到旧数据）。 */
      const fresh = state.generation === generation ? state : { generation }
      const status = fresh.status ?? null
      const branches = Array.isArray(fresh.branches) ? fresh.branches : []
      const remotes = Array.isArray(fresh.remotes) ? fresh.remotes : []
      const loading = fresh.branchesLoading === true
      const busy = fresh.busy === true
      const error = fresh.error ?? null
      const notice = fresh.notice ?? ''

      /** 搜索词（面板内的分支过滤）。 */
      const [query, setQuery] = react.useState('')
      const [open, setOpen] = react.useState(false)
      /**
       * 用户在**多仓库项目**里选中的仓库（组件状态，只用于渲染选择器本身）。
       *
       * 真正的"这次请求用哪个仓库"住在模块级的 `activeRepos` 里（`call()` 在组件外，
       * 见它的说明）；这里这一份是为了让"选择器显示的是不是当前那一个"这件事立刻跟着
       * 用户的选择变，而不必等下一次 status 回来。
       */
      const [pickedRepo, setPickedRepo] = react.useState('')
      /**
       * 视口内真正可见的分支名（由 SourcePanel 用 DOM 相交报上来，见
       * collectVisibleBranchNames）。补算只从这里 + 选中项取候选。
       */
      const [viewportNames, setViewportNames] = react.useState([])
      /**
       * 这一份分支列表里**已经请求过补算**的名字。
       *
       * 它就是"不许自动连续补算"的那道闸门：`syncExact` 一变，候选集合就会变；如果只靠
       * "还没精确过的都算候选"，第一批完成会自动带出下一批，直到扫完整个仓库。锁存之后
       * 每个名字每份列表只请求一次，因此"算完一批"不会再触发下一批。
       */
      const syncRequested = react.useRef(new Set())
      /** 自动（视口）补算已经用掉的名字数（见 SYNC_AUTO_BUDGET）。 */
      const syncBudget = react.useRef(0)
      /** 锁存与预算所属的代际；换代即清零。 */
      const syncGeneration = react.useRef(-1)
      if (syncGeneration.current !== generation) {
        // 在 render 期清零，保证本帧算出的候选就已经是新代际的（与 gate.sync 同一思路）。
        syncGeneration.current = generation
        syncRequested.current = new Set()
        syncBudget.current = 0
        if (viewportNames.length !== 0) setViewportNames([])
      }

      /** 面板报上来的可见行：内容不变就保持同一个数组，避免无谓的重渲染。 */
      const onVisible = react.useCallback((names) => {
        setViewportNames((prev) => (prev.length === names.length && prev.every((name, index) => name === names[index]) ? prev : names))
      }, [])

      /**
       * 单击选中的分支（IDEA 风格：单击只选中并开菜单，不 checkout）。
       *
       * 与"当前分支"是两件事：选中是**操作对象**，当前是**仓库状态**。
       */
      const [selectedBranch, setSelectedBranch] = react.useState('')
      /**
       * 上一次尝试切换的目标分支。
       *
       * 失败时错误面板要给出「暂存并切换到 <分支>」按钮，就必须记住用户点的是哪一个
       * ——错误文本里只有文件名，没有分支名。
       */
      const [pendingBranch, setPendingBranch] = react.useState('')
      /**
       * 二级（级联）操作菜单：`{ branch, rowAnchor, panelAnchor }`；null 表示未打开。
       *
       * 存**两个矩形**而不是一个点（早先只有 `{ x, y }`）：级联菜单要开在整个一级面板的
       * 外侧，纵向对齐被点的那一行，因此既需要行矩形也需要面板矩形，且都必须是**打开那一刻**
       * 量的快照（菜单在后面的帧里渲染，那时再读 DOM 可能已经换了位置）。
       */
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

      /**
       * 单击/双击的定时器、菜单归属与"一次双击一次 checkout"的守卫。
       *
       * 这几个 ref 与下面两个关闭回调**必须声明在这里**（所有会用到它们的回调之前），
       * 因为 `const` 在声明前求值会抛 "Cannot access before initialization"。
       */
      const menuTimer = react.useRef(0)
      const clearMenuTimer = react.useCallback(() => {
        if (menuTimer.current !== 0) {
          clearTimeout(menuTimer.current)
          menuTimer.current = 0
        }
      }, [])
      // 卸载时清掉定时器：否则面板已经关了，200ms 后还会 setMenu。
      react.useEffect(() => clearMenuTimer, [clearMenuTimer])
      /**
       * 刚才那次"面板内 mousedown"关掉的是哪个分支的菜单。
       *
       * 存在的理由：document 的 mousedown 是**捕获阶段**、并且发生在 click 之前，所以
       * "菜单 A 正开着，用户再点 A 那一行"这个动作到 click 里时 `menu` 已经是 null 了
       * ——光看 state 分不清"再点一次要关掉"与"第一次点要打开"。这个 ref 把那次关闭的信息
       * 带过 mousedown→click 的边界（同一 tick 内不会被清掉）。
       */
      const justClosedForRef = react.useRef('')
      /** 一次双击只允许发起一次 checkout（双击事件可能被重复派发）。 */
      const checkoutPendingRef = react.useRef(false)

      /**
       * 只收二级菜单，**不动一级面板**（面板内的其它点击、列表滚动、Esc 的第一层都用它）。
       *
       * 定时器也必须一起清：单击是"延迟 200ms 再弹菜单"，只 `setMenu(null)` 不管定时器的话，
       * 200ms 后菜单会自己冒出来——看起来就是"菜单怎么都关不掉"。
       */
      const closeBranchMenu = react.useCallback(() => {
        clearMenuTimer()
        justClosedForRef.current = ''
        setMenu(null)
      }, [clearMenuTimer])

      /**
       * 关闭一级面板：三层状态一起收。
       *
       * 这是"孤儿二级菜单"的结构性修复。不变式：
       *
       *     panel 关 ⇒ submenu 关 ⇒ dialog 关 ⇒ 待弹的单击定时器也清掉
       *
       * 早先每条关闭路径各写各的：点面板外只 `setOpen(false)`（菜单仍非 null、定时器还挂着），
       * 于是面板已经不渲染了、二级菜单却照旧渲染在屏幕上（200ms 后还会自己弹出来）。现在
       * 所有"关面板"的入口都只走这一个函数，漏掉某一项在结构上就不可能。
       *
       * 渲染层还有第二道闸门：`open !== true` 时二级菜单与对话框都不渲染（见下面两个占位
       * slot），因此即使将来有人新增了一条忘记调它的路径，也不会再出现孤儿菜单。
       */
      const closePanel = react.useCallback(() => {
        clearMenuTimer()
        setMenu(null)
        setDialog(null)
        setOpen(false)
      }, [clearMenuTimer])

      /** 打开对话框：收起操作菜单，并换一个实例序号（见 serial 的说明）。 */
      const openDialog = react.useCallback((next) => {
        closeBranchMenu()
        setSerial((value) => value + 1)
        setDialog(next)
      }, [closeBranchMenu])

      /**
       * 把结果写进"某一次请求所属的那一代"状态。
       *
       * 调用方**必须**先过 `gate.accept(ticket)`：这里只负责"写进哪一代"，不负责判断
       * 该不该写。分开的理由是两者回答的问题不同——"该不该写"是竞态判定（有唯一答案），
       * "写进哪一代"是纯数据操作。混在一起时最容易漏掉的就是前者。
       *
       * @param ticket - 请求票据（提供 generation）。
       * @param changes - 要合并进去的字段。
       */
      const patch = react.useCallback((ticket, changes) => {
        setState((prev) => {
          // 基准必须按票据的 generation 重建，不能拿一个别代的对象改：否则一次旧代的
          // 合并会把新代已经写好的字段抹掉。
          const base = prev.generation === ticket.generation ? prev : { generation: ticket.generation }
          return { ...base, ...changes }
        })
      }, [])

      /** 查一次当前分支与工作区状态。single-flight：同时在飞的同类请求只会有一个。 */
      const refresh = react.useCallback(async () => {
        const { ticket, promise } = gate.run('status', () => call('status', { cwd: workspace }), { coalesce: true })
        if (!gate.isCurrent(ticket)) return
        const outcome = await promise
        if (!gate.accept(ticket)) return
        if (outcome.ok) patch(ticket, { status: outcome.value, error: null })
        else patch(ticket, { error: describeError(outcome.cause) })
        // 依赖 generation：会话换了项目就要重新查，否则徽章会停在旧仓库的分支上。
      }, [gate, workspace, generation, patch])

      /**
       * 重新拉取分支列表。
       *
       * 首屏只有一次 `for-each-ref`（见 host 侧 listBranches 的说明）；精确的领先/落后
       * 由下面那个 effect 对**可见**分支补算，因此这个函数不等待任何按分支数的进程。
       */
      const loadBranches = react.useCallback(async () => {
        const { ticket, promise } = gate.run('branches', () => call('branches', { cwd: workspace }), { coalesce: true })
        if (!gate.isCurrent(ticket)) return false
        patch(ticket, { branchesLoading: true })
        const outcome = await promise
        // 旧工作区的响应（或已被更晚的请求取代）一律静默丢弃：连 loading 都不许关。
        if (!gate.accept(ticket)) return false
        if (!outcome.ok) {
          patch(ticket, { branchesLoading: false, error: describeError(outcome.cause) })
          return false
        }
        // host 侧返回的是对象数组：`{ name, isRemote, current, upstream, ahead, behind… }`。
        // 兼容旧的纯字符串形式，避免 host/client 版本不一致时列表整片消失。
        const raw = Array.isArray(outcome.value?.branches) ? outcome.value.branches : []
        // 新的一份列表到手：解锁补算锁存，让**当前可见**的行重新补一次精确值。
        // 这仍然是"每次列表刷新至多一批"（刷新只能由打开面板、手动刷新、写操作触发），
        // 因此不会退化成后台连续扫全仓库。
        syncRequested.current = new Set()
        patch(ticket, {
          branchesLoading: false,
          branches: raw.map((item) =>
            typeof item === 'string' ? { name: item, isRemote: false, current: false } : item,
          ),
        })
        return true
      }, [gate, workspace, generation, patch])

      /** 拉远端列表（面板打开、推送对话框需要时才取）。 */
      const loadRemotes = react.useCallback(async () => {
        const { ticket, promise } = gate.run('remotes', () => call('remotes', { cwd: workspace }), { coalesce: true })
        if (!gate.isCurrent(ticket)) return
        const outcome = await promise
        if (!gate.accept(ticket)) return
        if (outcome.ok) patch(ticket, { remotes: Array.isArray(outcome.value?.remotes) ? outcome.value.remotes : [] })
      }, [gate, workspace, generation, patch])

      // 首次拉取 + 定时对齐。
      //
      // 依赖 refresh（它随 generation 变化），因此**切换工作区会立刻重建这个 effect**：
      // 旧 interval 被 clear，新工作区马上拉一次。再加上 gate 的 single-flight，
      // 慢仓库上不会出现"上一个轮询还没回来下一个又发出去"的重叠。
      react.useEffect(() => {
        void refresh()
        const timer = setInterval(() => void refresh(), POLL_MS)
        return () => clearInterval(timer)
      }, [refresh])

      // 打开面板时才拉分支列表：分支多的仓库列一次不便宜，而用户可能从不点它。
      react.useEffect(() => {
        if (!open) return undefined
        setQuery('')
        // 换工作区/重开面板都要把二级菜单收干净（连同待弹的定时器）。面板本身**不关**：
        // 用户是在同一个面板里换了项目，继续看新项目的分支才是他要的。
        closeBranchMenu()
        void loadBranches()
        void loadRemotes()
        return undefined
        // 依赖 generation：会话换项目后，菜单里列出的必须是新仓库的分支。
      }, [open, generation, loadBranches, loadRemotes, closeBranchMenu])

      /**
       * 执行一次写操作并整体替换状态。
       *
       * **统一入口**的意义：host 的所有写路由都回同一形状（status + remotes），因此这里
       * 只需要一处"把响应铺回状态"。返回 host 的响应，让调用方能读 `stash` / `detached` /
       * `empty` 这类附加信息。
       *
       * 两处刻意的设计：
       *   * `slices: ['status', 'branches']`——写操作**抢占**这两份状态。任何在它之前
       *     发起的读都不再允许落地（哪怕先返回）：写回的是最新状态。
       *   * 分支列表**不在写响应里**（host 回 `branchesStale: true`）。因此这里不 await
       *     任何分支列表的补算，写操作的反馈立刻可见，分支列表由一次异步刷新收敛。
       */
      const run = react.useCallback(
        async (route, body) => {
          const { ticket, promise } = gate.run(`write:${route}`, () => send(route, workspace, body), {
            slices: ['status', 'branches'],
          })
          if (!gate.isCurrent(ticket)) return undefined
          patch(ticket, { busy: true, error: null, notice: '' })
          const outcome = await promise
          // 工作区已经换了：这次写操作的收尾（包括 busy）一律不写进新的那一份。
          if (!gate.isCurrent(ticket)) return undefined
          if (!outcome.ok) {
            // 失败信息也只由**最新**那次写操作负责：两次写叠在一起时，较早那次的失败
            // 不该把更晚那次的 busy 关掉、也不该顶掉它的错误提示（那是用户正在等的结果）。
            if (gate.accept(ticket)) patch(ticket, { busy: false, error: describeError(outcome.cause) })
            return undefined
          }
          const result = outcome.value
          if (gate.accept(ticket)) {
            // 写操作回的是最新状态：直接铺回去，界面立刻反映结果。
            const changes = { busy: false }
            if (result !== null && typeof result === 'object' && 'branch' in result) changes.status = result
            if (Array.isArray(result?.remotes)) changes.remotes = result.remotes
            // 附加信息的提示文案。放在这里而不是每个操作里，是为了让"操作成功但需要
            // 额外告知"这件事只有一处实现。
            if (result?.stash?.stashed === true) changes.notice = t('stashed', { ref: result.stash.ref })
            else if (result?.detached === true) changes.notice = t('detachedNotice')
            else if (result?.empty === true) changes.notice = t('emptyCherryPick')
            else if (typeof result?.aborted === 'string') changes.notice = t('aborted')
            patch(ticket, changes)
          } else {
            // 已有更晚的请求接手这两份状态：只收起自己的 busy。
            patch(ticket, { busy: false })
          }
          // 分支列表过期：**异步**刷新，不阻塞这次写操作的返回。
          if (result?.branchesStale === true) void loadBranches()
          // 跨插件：checkout/merge/rebase 也会改变工作区，因此让 review 那份共享快照失效。
          // 用可选链调用，因为两个插件各自独立加载——review 不在时这里什么也不做。
          // （`window.__dshDesktopGitSnapshot` 由 dsh-client-ui-review 在 apply 时挂上。）
          if (typeof window !== 'undefined') {
            const bridge = window.__dshDesktopGitSnapshot
            if (typeof bridge?.invalidate === 'function') void bridge.invalidate(workspace)
          }
          return result
        },
        [gate, workspace, generation, patch, loadBranches, t],
      )

      const switchTo = react.useCallback(
        async (branch, options) => {
          // 记下目标分支：失败时错误面板要靠它给出"暂存并切换到 X"的入口。
          setPendingBranch(branch)
          const result = await run('checkout', options?.stash === true ? { branch, stash: true } : { branch })
          // 只有成功才关闭面板。失败时保持打开，否则用户看不到原因、也不知道
          // 该重试哪个分支——实测中最常见的失败是有未提交改动（git 会拒绝覆盖）。
          // 关闭走 closePanel：面板、二级菜单、对话框与待弹定时器必须一起收（见它的说明）。
          if (result !== undefined) closePanel()
        },
        [run, closePanel],
      )

      // 重新打开面板时清掉上一次的错误与提示：旧信息留到新一次尝试里只会造成混淆。
      const toggleOpen = react.useCallback(() => {
        if (open) {
          // 关闭分支：**必须**走 closePanel，否则面板一关、二级菜单还挂在屏幕上
          // （程序化 click / 键盘激活没有 mousedown，那个"顺手收菜单"的兜底不会跑）。
          closePanel()
          return
        }
        setQuery('')
        setSelectedBranch('')
        closeBranchMenu()
        setOpen(true)
      }, [open, closeBranchMenu, closePanel])

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
       * 一级面板自己的 ref。
       *
       * 二级菜单要开在面板**外侧**（见 cascadeMenuPosition），因此必须能读到面板矩形。
       * 这个 ref 由 BranchChip 持有、以**普通 prop**（`panelRef`）传给 SourcePanel、
       * 由它挂到自己的根节点上——不能写成 `ref`：函数组件收不到 `ref`（React #290，
       * `scripts/check-react-rules.mjs` 会拦），而面板又必须由自己把 ref 挂到真正的 DOM
       * 节点上。
       */
      const sourcePanelRef = react.useRef(null)

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

      /**
       * 单击/双击的定时器、菜单定时器与几个守卫 ref 都声明在上面（`serial` 之后）：
       * 本文档级监听与好几个回调都要用到 `clearMenuTimer`，而 `const` 在声明前求值会抛
       * "Cannot access before initialization"。
       */

      react.useEffect(() => {
        if (!open) return undefined

        const onPointerDown = (event) => {
          const node = containerRef.current
          const insidePanel = node !== null && node.contains(event.target)
          const insideContext = menuRef.current !== null && menuRef.current.contains(event.target)
          if (insideContext) return
          if (!insidePanel) {
            // 点面板外：三层一起收。早先这里只 `setOpen(false)`，于是菜单 state 还是
            // 非 null、待弹的单击定时器也还挂着——面板已经不渲染了，二级菜单却照旧浮在
            // 屏幕上（200ms 后还会自己再弹一次）。这就是"孤儿二级菜单"的来源。
            closePanel()
            return
          }
          // 点了面板内部的**其它地方**（列表空白、分组标题、搜索框…）：收起右键菜单，
          // 并**取消待弹的单击定时器**。
          //
          // 取消定时器这一条是必须的：单击是"延迟 200ms 再弹菜单"，如果只 setMenu(null)
          // 而不管那个定时器，用户点一下别处之后 200ms 菜单还会自己冒出来——看起来就是
          // "菜单怎么都关不掉"。
          clearMenuTimer()
          if (menu !== null) {
            // 记下"刚才被这次 mousedown 关掉的是哪个分支的菜单"：同一行的 click 紧随其后，
            // 它据此判断这是"再点一次关掉"而不是"重新打开"（详见 onBranchClick）。
            justClosedForRef.current = menu.branch.name
          }
          setMenu(null)
        }
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          // Esc 逐层退出：先收二级菜单，再收对话框，最后关面板。一次全关会让用户
          // 在只想去掉那层小菜单时丢掉整个面板的状态。
          if (menu !== null || menuTimer.current !== 0) {
            closeBranchMenu()
          } else if (dialog !== null) setDialog(null)
          else {
            // 最后一层：走 closePanel（它顺带把已经为空的菜单/对话框再确认一次，
            // 不变式在任何一条路径上都不依赖"上一层已经收过了"这个前提）。
            closePanel()
            triggerRef.current?.focus()
          }
        }

        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open, menu, dialog, clearMenuTimer, closeBranchMenu, closePanel])

      const search = query.trim().toLowerCase()
      const visible = branches.filter((branch) => branch.name.toLowerCase().includes(search))

      /**
       * 单击要延迟（见上面那段说明），实现落在 onBranchClick 里。
       * 定时器与几个守卫 ref 声明在文档级监听之前（那里就要用到 clearMenuTimer）。
       */

      /**
       * 被点那一行的矩形。
       *
       * 优先 `event.currentTarget`（真实浏览器里就是那一行按钮）；拿不到时退回事件坐标，
       * 再拿不到就退到 (12,12)——纯函数 cascadeMenuPosition 会把位置收进视口，因此这里
       * 只需要给出一个"合法但可能不准"的形状，不必自己兜底布局。
       *
       * @param event - click / contextmenu 事件。
       * @returns `{ top, bottom, left, right }`。
       */
      const rowAnchorOf = react.useCallback((event) => {
        const rect = typeof event?.currentTarget?.getBoundingClientRect === 'function' ? event.currentTarget.getBoundingClientRect() : null
        if (rect !== null && rect !== undefined && Number.isFinite(rect.top)) {
          return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
        }
        const x = typeof event?.clientX === 'number' ? event.clientX : 12
        const y = typeof event?.clientY === 'number' ? event.clientY : 12
        return { top: y, bottom: y, left: x, right: x }
      }, [])

      /**
       * 一级面板的矩形（`null` = 还没量到，例如桩渲染或面板刚挂载）。
       *
       * 这里**当场量**而不是渲染菜单时再量：菜单在之后的帧里才渲染，那时面板可能已经
       * 因为窗口尺寸变化挪了位置，用旧坐标算出"级联在外侧"会立刻被推翻（菜单跳到面板上）。
       */
      const panelAnchorOf = react.useCallback(() => {
        const node = sourcePanelRef.current
        const rect = node !== null && node !== undefined && typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null
        if (rect !== null && rect !== undefined && Number.isFinite(rect.left)) {
          return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
        }
        return null
      }, [])

      /** 为某个分支打开二级菜单，记下"贴着哪一行、在哪块面板外侧"。 */
      const openMenuFor = react.useCallback((branch, rowAnchor, panelAnchor) => {
        setMenu({ branch, rowAnchor, panelAnchor })
      }, [])

      /**
       * 单击一行分支。
       *
       * 完整的状态机（与 IDEA 的分支弹窗一致）：
       *   * **这一行没有菜单** → 选中它，并在 `SINGLE_CLICK_MS` 之后弹菜单；
       *   * **这一行的菜单正开着** → **立即关闭**，且不再排新的弹出（否则 200ms 后它又
       *     冒出来，用户会觉得菜单关不掉）。判断依据是 `justClosedForRef`：mousedown
       *     （捕获阶段）已经把菜单关掉了，`menu` 在这个 click 里必然是 null；
       *   * **别的一行** → 上一个菜单立即关闭（同样是 mousedown 做的），这一行照常延迟弹；
       *   * **双击的第二下** → 取消待弹定时器，交给 dblclick 去 checkout（避免菜单闪现）。
       *
       * `event.currentTarget.getBoundingClientRect()` 优先：菜单要贴着**被点的那一行**
       * （IDEA 里菜单就从那一行展开）。拿不到矩形时退回事件坐标，再拿不到就退到左上角
       * ——BranchContextMenu 自己会把位置收进视口。
       */
      const onBranchClick = react.useCallback(
        (event, entry) => {
          setSelectedBranch(entry.name)
          /**
           * 这一次点击是不是"关掉刚才那个菜单"？
           *
           * 两条判据都留着，是刻意的：
           *   * `justClosedForRef` —— 真实浏览器里 document 的 mousedown（捕获阶段）先跑，
           *     它已经把菜单关掉了，所以到 click 里 `menu` 必然是 null。这个 ref 把那次
           *     关闭的信息带过来（见它的说明）；
           *   * `menu` —— 程序化 click（脚本、无障碍工具、某些触摸路径）可能**没有**
           *     mousedown，这时 `menu` 还是上一帧的值。少了这一条，那种情况下再点同一行
           *     会"重新排一次弹出"，表现就是菜单怎么都关不掉。
           */
          const alreadyOpen = menu !== null && menu.branch.name === entry.name
          if (justClosedForRef.current === entry.name || alreadyOpen) {
            closeBranchMenu()
            return
          }
          justClosedForRef.current = ''
          // 点的是**别的一行**：上一个菜单立即关掉（mousedown 通常已经关了，这里是兜底），
          // 只允许目标那一行的菜单存在。
          if (menu !== null) setMenu(null)
          if (menuTimer.current !== 0) {
            // 这是双击的第二下：取消单击菜单，让 dblclick 去执行 checkout。
            clearMenuTimer()
            return
          }
          // 两个矩形都**当场**量：见 rowAnchorOf / panelAnchorOf 的说明。
          const rowAnchor = rowAnchorOf(event)
          const panelAnchor = panelAnchorOf()
          menuTimer.current = setTimeout(() => {
            menuTimer.current = 0
            openMenuFor(entry, rowAnchor, panelAnchor)
          }, SINGLE_CLICK_MS)
        },
        [clearMenuTimer, closeBranchMenu, menu, openMenuFor, rowAnchorOf, panelAnchorOf],
      )

      /**
       * 双击一行分支：切换。
       *
       * 当前分支双击**什么都不做**（IDEA 也是这样：切到自己没有意义，而"点了没反应"
       * 至少不会误触发一个操作）。单击仍然可以打开菜单，因此当前分支并非不可操作。
       *
       * 三件事的顺序是有意的：先取消待弹的定时器（菜单**绝不会**闪现）→ 立即关掉已开的
       * 菜单（用户在等待 checkout，不该还浮着一个菜单）→ 再发切换请求。`checkoutPendingRef`
       * 挡住同一次双击里的重复派发：切换是写操作，重复发一次会真的多跑一次 git。
       */
      const onBranchDoubleClick = react.useCallback(
        (entry) => {
          closeBranchMenu()
          if (entry.current === true || busy) return
          if (checkoutPendingRef.current) return
          checkoutPendingRef.current = true
          void switchTo(entry.name).finally(() => {
            checkoutPendingRef.current = false
          })
        },
        [busy, closeBranchMenu, switchTo],
      )

      const onBranchContextMenu = react.useCallback(
        (event, entry) => {
          event.preventDefault()
          event.stopPropagation()
          clearMenuTimer()
          setSelectedBranch(entry.name)
          openMenuFor(entry, rowAnchorOf(event), panelAnchorOf())
        },
        [clearMenuTimer, openMenuFor, rowAnchorOf, panelAnchorOf],
      )

      /**
       * 为**真正看得见**的分支补算精确的领先/落后。
       *
       * 首屏用的是 for-each-ref 的 `%(upstream:track)`（见 host 侧 listBranches），它通常
       * 正确，但在本地跟踪引用缺失/过期时会安静地给 0/0。因此这里对可见行按需补算。
       *
       * **候选只有三个来源**（这一条是这次修的重点）：
       *   1. 视口内真正可见的行——由 `SourcePanel` 用 DOM 交叉判定后报上来
       *      （`data-desktop-branch` 的滚动容器 ∩ 每一行），**不是**"搜索过滤后的整张列表"；
       *   2. 用户单击/右键选中的那一行（可能在视口外——那是用户的主动意图）；
       *   3. 当前分支不需要：它的领先/落后取自 `/status`（见 withCurrentSync），已经是精确的。
       *
       * 为什么不能拿"过滤后的列表"当候选：那个集合在 300/2000 分支的仓库里几乎是全仓库，
       * 而补算一旦完成会把条目标成 `syncExact`，`syncExact` 又进入候选集合的依赖——于是
       * "第一批 32 个完成 → 候选变成下一批 32 个 → 再发一次"，自动地一轮轮把整个仓库算完。
       * 现在的两道闸门让这件事不可能发生：
       *   * **一次性锁存**：同一份分支列表（generation + 列表内容）里，每个名字只请求一次
       *     （`syncedRef`），因此"算完一批"不会自动带出下一批；换一份列表（刷新/写操作后）
       *     才重新允许——那仍然是用户动作驱动的、每份列表至多一批。
       *   * **总预算**：同一个工作区（跨多次开关面板累计）里，自动（视口）补算的名字数上限
       *     `SYNC_AUTO_BUDGET`。它是与仓库规模无关的常数上限，异常循环也扫不完整个仓库；
       *     用户主动选中的分支不受预算限制（每次点击只多一个名字）。
       *
       * 依赖 `syncKey` 而不是 `viewportNames` 数组本身：数组每次渲染都是新对象，用它当依赖
       * 会变成"每渲染一次发一次请求"。
       */
      const branchByName = react.useMemo(() => {
        const map = new Map()
        for (const entry of branches) map.set(entry.name, entry)
        return map
      }, [branches])

      const candidates = []
      let autoSpent = 0
      for (const [name, isAuto] of [
        // 视口内的行：自动来源，受预算约束。
        ...viewportNames.map((name) => [name, true]),
        // 选中的行：用户动作，不受预算约束（但同样只请求一次）。
        ...(selectedBranch === '' ? [] : [[selectedBranch, false]]),
      ]) {
        if (candidates.length >= SYNC_BATCH) break
        if (isAuto && syncBudget.current >= SYNC_AUTO_BUDGET) break
        const entry = branchByName.get(name)
        // 没有上游、当前分支（/status 已给精确值）、已经精确过的、以及这一份列表里已经
        // 请求过的，都不再补算。
        if (entry === undefined || entry.current === true) continue
        if (entry.upstream === '' || entry.syncExact === true) continue
        if (syncRequested.current.has(name)) continue
        syncRequested.current.add(name)
        if (isAuto) {
          syncBudget.current += 1
          autoSpent += 1
        }
        candidates.push(name)
      }
      const syncKey = candidates.join('\u0000')
      if (autoSpent > 0) {
        // 诊断用：脚本与排查时能直接看到"这一次打开面板一共自动补算了多少"。
        if (typeof window !== 'undefined') window.__dshDesktopGitbarSync = { budget: syncBudget.current, limit: SYNC_AUTO_BUDGET }
      }
      react.useEffect(() => {
        if (!open || syncKey === '') return undefined
        const names = syncKey.split('\u0000')
        // kind 里带上名字集合：single-flight 的键必须包含**参数**。否则"视口换了、上一批
        // 还在飞"时第二次调用会复用到第一批的票据，那一批名字就永远不会被补算（而它们已经
        // 被锁存记下了，于是这一份列表里再也不会补）。
        const { ticket, promise } = gate.run(`branch/sync:${syncKey}`, () => call('branch/sync', { cwd: workspace, query: { names: names.join(',') } }), { coalesce: true })
        if (!gate.isCurrent(ticket)) return undefined
        void promise.then((outcome) => {
          // 换代 / 被更晚的请求取代 → 丢弃；失败也不清锁存（不重试同名字，避免又变成循环）。
          if (!gate.accept(ticket) || !outcome.ok) return
          const sync = outcome.value?.sync ?? {}
          setState((prev) => {
            if (prev.generation !== ticket.generation || !Array.isArray(prev.branches)) return prev
            return {
              ...prev,
              branches: prev.branches.map((entry) =>
                Object.hasOwn(sync, entry.name) ? { ...entry, ...sync[entry.name] } : entry,
              ),
            }
          })
        })
        return undefined
      }, [open, syncKey, gate, workspace, generation])

      if (status === null) {
        // 还没有数据时渲染 null 而不是占位骨架：这个位置空间很小，
        // 一个闪烁的骨架比"晚半秒出现"更惹眼。
        //
        // 切换工作区时这里也会命中（换代后当前代还没有 status）：宁可让徽章消失一瞬，
        // 也不显示上一个项目的分支——那正是这次要根治的现象。
        return null
      }

      if (!status.isRepo) return null

      /**
       * 项目级仓库列表（宿主在 `/status` 里一并给）。
       *
       * 只有 **>1** 个时才渲染选择器：单仓库（"工作区自己就是仓库"或"只有一个子仓库"）
       * 是 1.5.2 的一贯界面，多一个没有选择余地的下拉框只会占地方。
       */
      const scopeRepositories = Array.isArray(status.projectScope?.repositories) ? status.projectScope.repositories : null
      const projectRepositories = scopeRepositories ?? []
      const multiRepository = projectRepositories.length > 1
      if (scopeRepositories !== null) {
        // **每次都要同步**（不只是多仓库时）：项目可能被重新组织成单仓库，那时必须把
        // "多仓库"这件事**忘掉**，否则 `repository` 参数会继续带着一个已经不在列表里的
        // 仓库根——单仓库的请求形状因此悄悄变成了多仓库的。
        // **渲染期**同步给模块级 store：`loadBranches` / `loadRemotes` 这些 effect 在本次
        // 渲染之后立刻发出请求，它们必须已经知道"这次操作哪个仓库"。放在 effect 里就晚
        // 了一拍——那一拍会把上一个仓库的分支列表带进来（正是"徽章在 A、面板在 B"）。
        rememberProjectRepositories(workspace, scopeRepositories)
        if (multiRepository) {
          const effective = activeRepositoryOf(workspace)
          if (effective !== '') rememberActiveRepository(workspace, effective)
        }
      }

      /** 选择器当前显示的仓库：刚点过的那一个优先，其次模块级 store 里的。 */
      const currentRepository =
        (pickedRepo !== '' && projectRepositories.some((entry) => entry.repositoryRoot === pickedRepo) ? pickedRepo : '') ||
        activeRepositoryOf(workspace) ||
        projectRepositories[0]?.repositoryRoot ||
        ''

      /**
       * 用户在选择器里换了仓库：记住 → 更新显示 → **立刻重取**。
       *
       * 三份数据都要重取，因为它们都属于"那一个仓库"：status（分支/改动数）、branches
       * （分支列表）、remotes（远端列表）。只刷 status 会留下"分支列表还是上一个仓库的"
       * ——而分支列表正是这个徽章点开后的主体。
       */
      const pickRepository = (event) => {
        const next = String(event?.target?.value ?? '')
        if (next === '' || next === currentRepository) return
        rememberProjectRepositories(workspace, projectRepositories)
        rememberActiveRepository(workspace, next)
        setPickedRepo(next)
        void Promise.all([refresh(), loadBranches(), loadRemotes()])
      }

      const label = status.detached ? '(detached)' : status.branch || '(no branch)'
      const flags = []
      if (status.changedFiles > 0) flags.push(`*${status.changedFiles}`)
      if (status.ahead > 0) flags.push(`\u2191${status.ahead}`)
      if (status.behind > 0) flags.push(`\u2193${status.behind}`)

      return react.createElement(
        'div',
        // ref 用于"点击外部关闭"的判定：在这个容器内的点击不关菜单。
        {
          ref: containerRef,
          'data-desktop-branch': '',
          style: { position: 'relative', display: 'inline-flex', flex: '1 1 120px', minWidth: 0, maxWidth: '100%' },
        },
        // 多仓库项目：先说"这个项目里有几个仓库"，再让用户选一个。
        //
        // 顺序是有意的——徽章上的分支与改动数**永远只是当前仓库的**，那句"Git · 2 个仓库"
        // 是用户判断"我现在看的是不是全部"的唯一依据，不能藏在菜单里。
        multiRepository
          ? react.createElement(
              'span',
              {
                'data-desktop-repo-count': String(projectRepositories.length),
                title: t('repoDiscovering'),
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  height: '28px',
                  padding: '0 6px',
                  color: 'var(--dsw-alias-label-tertiary, #8a8f99)',
                  fontSize: '11.5px',
                  fontFamily: UI_FONT,
                  whiteSpace: 'nowrap',
                },
              },
              t('repoCount', { count: projectRepositories.length }),
            )
          : null,
        multiRepository
          ? react.createElement(
              'select',
              {
                'data-desktop-repo-select': '',
                'aria-label': t('repoSelect'),
                title: t('repoSelect'),
                value: currentRepository,
                onChange: pickRepository,
                style: {
                  height: '28px',
                  maxWidth: '180px',
                  padding: '0 4px',
                  borderRadius: '6px',
                  border: `1px solid ${BORDER}`,
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-secondary)',
                  fontSize: '12px',
                  fontFamily: UI_FONT,
                },
              },
              projectRepositories.map((entry) =>
                react.createElement(
                  'option',
                  { key: entry.repositoryRoot, value: entry.repositoryRoot, 'data-desktop-repo-option': entry.repositoryRoot },
                  // 同名仓库（两个 `frontend`）只能靠相对路径区分，因此有路径就一并写出来。
                  entry.relativePath === '' || entry.relativePath === undefined
                    ? entry.name
                    : `${entry.name} (${entry.relativePath})`,
                ),
              ),
            )
          : null,
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
              /**
               * 一级面板自己的 DOM 节点（普通 prop，不是 React 的 `ref`——函数组件收不到
               * `ref`，见 check-react-rules 的规则 C）。二级菜单要靠它算级联位置。
               */
              panelRef: sourcePanelRef,
              /** 视口内可见的行（补算精确领先/落后的候选，见 collectVisibleBranchNames）。 */
              onVisible,
              /** 单击选中的分支（与"当前分支"不同，见 selectedBranch 的说明）。 */
              selected: selectedBranch,
              onRefresh: () => void Promise.all([refresh(), loadBranches(), loadRemotes()]),
              onFetch: () => void run('remote', { action: 'fetch' }),
              onSwitch: (branch) => void switchTo(branch),
              onStashSwitch: () => void switchTo(pendingBranch, { stash: true }),
              onDialog: openDialog,
              onPick: onBranchClick,
              onActivate: onBranchDoubleClick,
              onContextMenu: onBranchContextMenu,
              onAbort: (kind) => void run('op/abort', { kind }),
              /**
               * 分支列表被滚动：收起二级菜单并取消待弹的单击定时器（面板本身留着）。
               *
               * 菜单由本组件持有（SourcePanel 是受控的展示组件），所以这件事必须由这里做。
               */
              onListScroll: closeBranchMenu,
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
        //
        // **两道闸门**：除了 menu/dialog 本身，还必须 `open === true`。这是"孤儿二级菜单"
        // 的最后一道结构性防线——面板已经不渲染了，任何残留的 menu state 都不该再画出来。
        react.createElement(
          'div',
          { key: 'context-menu-slot', style: { display: 'contents' } },
          open === true && menu !== null
            ? react.createElement(BranchContextMenu, {
                t,
                menu,
                menuRef,
                status,
                busy,
                onClose: closeBranchMenu,
                onSwitch: (branch) => void switchTo(branch),
                onDialog: openDialog,
              })
            : null,
        ),

        react.createElement(
          'div',
          { key: 'dialog-slot', style: { display: 'contents' } },
          open === true && dialog !== null
            ? react.createElement(ActionDialog, {
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
                  // 对话框成功收尾 = 这次面板会话结束：走 closePanel，
                  // 顺带把二级菜单与待弹定时器一起收掉（不变式，见它的说明）。
                  closePanel()
                },
              })
            : null,
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
        selected, onRefresh, onFetch, onSwitch, onStashSwitch, onDialog, onPick, onActivate, onContextMenu, onAbort, onVisible, onListScroll, panelRef,
      } = props

      /**
       * 滚动容器：用来判定"哪些行真的在视口里"（见 collectVisibleBranchNames）。
       *
       * 报上去的名字只用于补算精确的领先/落后，因此这里宁可少报（视口判定失败就退化成
       * 一屏大小的固定窗口）也不能多报——多报等于后台把整个仓库的分支都算一遍。
       */
      const listRef = react.useRef(null)
      /**
       * 当前渲染出来的行（按名字）。用 ref 保存最新一份、用**名字串**当 effect 依赖：
       * `visible` 每次渲染都是新数组，直接放进依赖会让"报告可见行"这个副作用每渲染一次都跑，
       * 而它内部要对行做 `getBoundingClientRect()`（读布局）。名字没变就说明该报告的集合没变，
       * 没必要再去读一遍 DOM。
       */
      const visibleRef = react.useRef(visible)
      visibleRef.current = visible
      const visibleKey = visible.map((entry) => entry.name).join('\u0000')
      const reportVisible = react.useCallback(() => {
        if (typeof onVisible !== 'function') return
        onVisible(collectVisibleBranchNames(listRef.current, visibleRef.current))
      }, [onVisible, visibleKey])
      react.useEffect(() => {
        reportVisible()
        const node = listRef.current
        if (node === null || typeof node.addEventListener !== 'function') return undefined
        // 滚动/改尺寸都会换出可见集合：用 rAF 合帧，滚动过程中不会每帧都去读一遍布局。
        let frame = 0
        const schedule = () => {
          if (typeof requestAnimationFrame === 'function') {
            if (frame !== 0) return
            frame = requestAnimationFrame(() => {
              frame = 0
              reportVisible()
            })
            return
          }
          reportVisible()
        }
        node.addEventListener('scroll', schedule, { passive: true })
        window.addEventListener('resize', schedule)
        return () => {
          if (frame !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
          node.removeEventListener('scroll', schedule)
          window.removeEventListener('resize', schedule)
        }
      }, [reportVisible])

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

      /**
       * 当前分支的领先/落后用 `/status` 的值覆盖。
       *
       * `/branches` 的 ahead/behind 来自 for-each-ref 的 `%(upstream:track)`（首屏够快），
       * 而 `/status` 的 `# branch.ab` 是 git 自己按上游算出来的，**当前分支**这一行用它
       * 才是准的（要求："当前分支的 ahead/behind 要准确"）。两者的数据源其实是同一批
       * 引用，因此这里的覆盖不会与列表自相矛盾——覆盖完当前分支那一行与徽章上的
       * ↑/↓ 标记也一致了。
       *
       * @param entry - 分支条目。
       * @returns 补好同步字段的条目。
       */
      const withCurrentSync = (entry) => {
        if (entry.current !== true || status === null || status.detached === true) return entry
        if (typeof status.branch !== 'string' || status.branch === '' || status.branch !== entry.name) return entry
        const upstream = entry.upstream !== '' ? entry.upstream : (typeof status.upstream === 'string' ? status.upstream : '')
        if (upstream === '') return entry
        const ahead = Number(status.ahead ?? 0)
        const behind = Number(status.behind ?? 0)
        return {
          ...entry,
          upstream,
          ahead,
          behind,
          diverged: ahead > 0 && behind > 0,
          upstreamGone: status.upstreamGone === true,
          syncExact: true,
        }
      }

      /** 一行分支。 */
      const row = (raw) => {
        const entry = withCurrentSync(raw)
        const sync = syncLabel(entry, t)
        const isSelected = selected === entry.name
        const { branch: upstreamBranch } = splitUpstream(entry.upstream)
        return react.createElement(
          'button',
          {
            key: `${entry.isRemote ? 'r:' : 'l:'}${entry.name}`,
            type: 'button',
            'data-desktop-branch-option': '',
            'data-desktop-branch-name': entry.name,
            'data-desktop-branch-selected': isSelected ? 'true' : undefined,
            // 这一行的领先/落后是不是**精确值**（见 host 的 `/branch/sync`：字段名与
            // `/branches` 一致，都叫 syncExact）。留成 DOM 标记是为了让"补算之后真的被标成
            // 精确"这件事可断言——它同时决定了补算不会再被重复触发。
            'data-desktop-branch-sync-exact': entry.syncExact === true ? 'true' : 'false',
            'aria-current': entry.current ? 'true' : undefined,
            // 当前分支**不禁用整行**：单击仍然要能打开它的操作菜单（新建分支、新建标签…），
            // 只有那些"对自己没有意义"的动作在菜单里被禁用（见 BranchContextMenu）。
            disabled: busy,
            // IDEA 风格：单击选中并打开操作菜单（延迟见 SINGLE_CLICK_MS），双击才切换。
            onClick: (event) => onPick(event, entry),
            onDoubleClick: () => onActivate(entry),
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
              border: `1px solid ${isSelected ? `color-mix(in srgb, ${ACCENT} 35%, transparent)` : 'transparent'}`,
              borderRadius: '7px',
              // 选中（单击、正在操作的对象）与当前分支（仓库状态）是两种高亮：前者用
              // 描边加浅底，后者用强调色文字。两者同时出现时仍然分得清。
              background: isSelected
                ? `color-mix(in srgb, ${ACCENT} 12%, ${SURFACE})`
                : entry.current
                  ? `color-mix(in srgb, ${ACCENT} 8%, ${SURFACE})`
                  : 'var(--dsh-branch-option-bg, transparent)',
              color: entry.current ? ACCENT : 'inherit',
              opacity: busy ? 0.6 : 1,
              fontFamily: UI_FONT,
              fontSize: '13px',
              lineHeight: 1.4,
              fontWeight: entry.current ? 500 : 400,
              cursor: busy ? 'default' : 'pointer',
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
          // 一级面板自己的节点：BranchChip 用它算二级菜单的级联位置（普通 prop 传进来的
          // ref 对象，见 BranchChip 里 sourcePanelRef 的说明）。
          ref: panelRef,
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
        // 这个 div 就是"视口"的基准：补算精确领先/落后时，只有与它相交的行才算可见。
        react.createElement(
          'div',
          {
            ref: listRef,
            'data-desktop-branch-list': '',
            style: { minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', paddingTop: '2px' },
            'aria-busy': loading || busy,
            // 滚动列表时收起菜单并取消待弹的定时器：菜单是贴着某一行的，滚走之后它就
            // 悬在一个已经不在那儿的分支上。**只收菜单，不关面板**（用户是在列表里找分支）。
            // 顺带把"视口里现在是哪些行"重新报一次（补算候选跟着滚动走）。
            onScroll: () => {
              reportVisible()
              if (typeof onListScroll === 'function') onListScroll()
            },
          },
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
     * 分支行的操作菜单（右键，以及单击分支行时打开的那一个）。
     *
     * **单击与右键打开的是同一个组件、同一份条目**：两种入口表达的是同一个意图
     * （"我要对这个分支做点什么"），各写一套菜单必然漂移（实测过：右键有「重命名」而
     * 单击菜单没有，用户完全无法预期）。
     *
     * 条目按上下文启用/禁用，因为几种操作在错误的对象上没有意义：
     *   * 当前分支不能"签出"自己（显示但禁用，见下面 items 处的说明）；
     *   * 合并/变基到自己是空操作（git 会回 "Already up to date"，那种"点了没反应"
     *     比禁用更让人困惑）；
     *   * 远程分支不能"重命名"（本地重命名它只会改名跟踪引用）；
     *   * 只有远程分支能"删除远端"；只有本地分支能"删除"。
     * 给出禁用项而不是隐藏，是为了让菜单的形状稳定——用户靠位置记忆点操作，
     * 条目时有时无会让第二次点击点错。
     *
     * @param props - `{ t, menu, menuRef, status, busy, onClose, onSwitch, onDialog }`；
     *   `menu` 的形状是 `{ branch, rowAnchor, panelAnchor }`（见 cascadeMenuPosition）。
     * @returns React 元素。
     */
    function BranchContextMenu(props) {
      const { t, menu, menuRef, status, busy, onClose, onSwitch, onDialog } = props
      const entry = menu.branch
      const current = status?.branch ?? ''

      /**
       * 挂载后量到的真实高度：`{ menu, height }`（null = 还没量到）。
       *
       * `menu` 一起存是有意的：这个组件实例会被**下一个**菜单复用（同一个位置、同一个
       * 组件类型），如果不认菜单身份，换一个分支时首帧会拿上一个菜单的高度去算位置；
       * 而长分支名的条目会换行、菜单更高，那一帧就可能被裁掉。因此"量到的高度只对量它的
       * 那个菜单有效"，其余情况一律回到估算上界 `CASCADE_MENU_ESTIMATED_HEIGHT`。
       */
      const [measured, setMeasured] = react.useState(null)
      react.useEffect(() => {
        const node = menuRef?.current
        if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') return undefined
        const rect = node.getBoundingClientRect()
        const height = typeof rect?.height === 'number' ? rect.height : rect?.bottom - rect?.top
        if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return undefined
        // 只在真的变了的时候更新：否则"量到同一个高度"也会触发一轮重渲染。
        setMeasured((previous) => (previous !== null && previous.menu === menu && Math.abs(previous.height - height) < 1 ? previous : { menu, height }))
        return undefined
      }, [menuRef, menu])

      /**
       * 级联位置：**整个一级面板的外侧**（右优先，放不下翻到左侧，两侧都放不下才夹进视口），
       * 纵向对齐被点的那一行并在触底时整体上移。规则本身在纯函数里，这里只负责喂坐标。
       */
      const submenuHeight = measured !== null && measured.menu === menu && measured.height > 0 ? measured.height : CASCADE_MENU_ESTIMATED_HEIGHT
      const position = cascadeMenuPosition({
        rowRect: menu.rowAnchor,
        panelRect: menu.panelAnchor,
        submenuWidth: CASCADE_MENU_WIDTH,
        submenuHeight,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      })
      const style = {
        position: 'fixed',
        zIndex: 10000,
        left: `${position.left}px`,
        top: `${position.top}px`,
        width: `${CASCADE_MENU_WIDTH}px`,
        maxHeight: `min(${CASCADE_MENU_ESTIMATED_HEIGHT}px, calc(100vh - 16px))`,
        overflowY: 'auto',
        padding: '5px',
        borderRadius: '10px',
        border: `1px solid ${BORDER}`,
        background: SURFACE,
        color: 'var(--dsw-alias-label-primary, #202124)',
        fontFamily: UI_FONT,
        boxShadow: '0 10px 30px rgba(0,0,0,.16), 0 2px 6px rgba(0,0,0,.06)',
      }

      /**
       * 包一层"先关菜单、再执行动作"。
       *
       * 每一条菜单项都要走它：点菜单项时菜单必须**立即消失**，而不是等动作跑完（
       * `checkout` / `merge` 这些可能几秒）。尤其是 checkout——请求发出去之前菜单就该没了，
       * 否则用户会以为自己点的是别的分支。以前菜单项直接调 `onSwitch` / `onDialog`，
       * 而"点面板内部"那条 mousedown 判定对菜单内部是**豁免**的（否则点菜单项会先被关掉），
       * 于是菜单会一直浮在正在执行的写操作上面。
       *
       * @param action - 真正要执行的动作。
       * @returns 供 onClick 使用的处理器。
       */
      const act = (action) => () => {
        onClose()
        action()
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
      // 「签出」对当前分支**显示但禁用**，而不是隐藏。
      //
      // 这一条与"单击打开菜单"的交互是配套的：单击任何一行（包括当前分支）都会打开这个
      // 菜单，如果当前分支那一份菜单少一项，同一个位置上的条目就会随分支变化而上下移动，
      // 用户靠位置记忆点操作时很容易点错。禁用项保留了菜单的形状，也解释了"为什么不能点"。
      items.push(
        item('checkout', t('menuCheckout'), act(() => onSwitch(entry.name)), {
          disabled: entry.current,
          title: entry.current ? t('currentBranch') : undefined,
        }),
      )
      items.push(item('new-from', t('menuNewFrom', { name: entry.name }), act(() => onDialog({ kind: 'create', branch: entry }))))
      items.push(separator('sep1'))
      items.push(
        item('merge', t('menuMergeInto', { name: entry.name }), act(() => onDialog({ kind: 'merge', branch: entry })), {
          // 合并到自己没有意义，而 git 也会报"Already up to date"——那种"点了没反应"
          // 比禁用更让人困惑。
          disabled: entry.name === current,
        }),
      )
      items.push(
        item('rebase', t('menuRebaseOnto', { name: entry.name }), act(() => onDialog({ kind: 'rebase', branch: entry })), {
          disabled: entry.name === current,
        }),
      )
      items.push(separator('sep2'))
      items.push(item('push', t('menuPush'), act(() => onDialog({ kind: 'push', branch: entry }))))
      items.push(
        item('rename', t('menuRename'), act(() => onDialog({ kind: 'rename', branch: entry })), {
          // 远程分支不能重命名：本地改名只会把跟踪引用换个名字，远端那个分支纹丝不动，
          // 结果是一个名字与远端对不上的本地分支——比不做更糟。
          disabled: entry.isRemote,
          title: entry.isRemote ? t('remoteTag') : undefined,
        }),
      )
      items.push(
        item('delete', t('menuDelete'), act(() => onDialog({ kind: 'delete', branch: entry })), {
          disabled: entry.current,
          danger: true,
        }),
      )

      return react.createElement(
        'div',
        {
          ref: menuRef,
          role: 'menu',
          'data-desktop-sc-menu': entry.name,
          // 级联方向（right/left/clamp）：几何断言直接读它，比反解 style.left 稳
          // （真实 DOM 的几何回归由 CDP 脚本量矩形，桩渲染里则由测试喂坐标）。
          'data-desktop-sc-cascade': position.side,
          style,
        },
        ...items,
      )
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
    // ---- 只给测试用的钩子 ------------------------------------------------------
    //
    // "哪些行真的在视口里"是这次修复的核心判定（它决定补算候选，进而决定会不会退化成
    // 后台扫全仓库），而它需要真实 DOM 才能整体跑到。把这个纯函数导出来，测试就能用一棵
    // 带矩形坐标的**假 DOM 树**直接断言"只挑相交的行、到视口下方就停"。
    exports.__visibleBranchNamesForTest = collectVisibleBranchNames
    // 二级菜单的级联几何同样只有真实布局才能整体跑到，但规则本身是纯函数。导出它，
    // 测试就能直接喂两个矩形，逐条断言"右开/左开/夹进视口"与纵向翻转。
    exports.__cascadeMenuPositionForTest = cascadeMenuPosition
    // 必须声明 inject：cordis 的服务是懒解析的，不声明就直接读 `ctx.slots` 会抛
    // "cannot get property \"slots\" without inject"，而且这个错误会让**整个界面**
    // 渲染失败（不只是本插件）——排查时页面是全白的，误导性很强。
    // `locale` 同理：不声明就取不到 `ctx.locale.register`。
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
