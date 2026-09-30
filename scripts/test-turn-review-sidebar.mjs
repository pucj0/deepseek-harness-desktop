// **本轮审查标签的上下文不变式**：入口显示的数字与侧栏里列出的文件必须来自同一个会话。
//
//   node scripts/test-turn-review-sidebar.mjs
//
// 这个文件钉住的是这次真实故障：输入框上方显示「本轮修改 4」，点进去的面板却说
// 「当前没有可用的工作区 / 0 个文件」。
//
// 根因（必须保持修好的形状）：
//   * 入口 `TurnReviewChip` 挂在 `dsh.desktop.composer.actions`（**session** 作用域），
//     能拿到 `sessionId` 与 `useSessions`，所以它算得出 4 个文件；
//   * 旧实现点开的是一个挂在 `shell.overlay`（**root** 作用域）上的自制浮层
//     `TurnReviewDrawer`，它的注册只注入了 `t` —— 那个槽位的 props 里**没有** `useSessions`，
//     于是 `useCurrentTurn` 退回空实现，`state.current` 是 undefined，
//     workspace 永远是 undefined，`useChanges` 于是进入 `noWorkspace`。
//
// 现在两边走**同一条**路：`useTurnContext(props)` 解析出 `{ sessionId, workspace }`，
// 侧栏标签由官方 `sidebar.right.pane.tab`（同样是 session 作用域、标准注入面里带
// `sessionId` 与 `useSessions`）渲染。这个文件因此断言：
//
//   Case A  点「本轮修改」→ `openTab(REVIEW_KIND)`，**绝不**是 `GIT_KIND`；侧栏收起时展开。
//   Case B  side​bar 标签在真实 session 下拿到同一个 workspace，文件数与入口一致（4 == 4）。
//   Case C  真的没有会话时才允许 `noWorkspace`（诊断里是 `noContext`）。
//   Case D  切到另一个会话 → 侧栏跟着换 workspace，并显示**新**会话的文件数。
//   Case E  竞态：A 的 `/changes` 慢、切到 B 之后 A 才回来 —— 最终必须仍然是 B。
//   Case F  静态契约：不再有 drawer / shell.overlay / turnDrawerStore，两个 kind 不同名。
//
// 运行方式与其它 review 测试一致：加载**真实的客户端 bundle**，用桩 React / 桩 DOM / 桩 host
// 驱动它，不需要 Electron。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SOURCE_PATH = join(ROOT, 'plugins', 'dsh-client-ui-review', 'lib', 'client.js')
const PLUGIN = pathToFileURL(SOURCE_PATH).href

/** 需求里那个真实场景的工作区名，以及第二个项目。 */
const A = 'F:\\code\\mmsm-amis_helixingjian'
const B = 'F:\\code\\projB'
const SA = 'session-a'
const SB = 'session-b'

// ---- 假 React -------------------------------------------------------------------
const componentHooks = new Map()
let hookSlots = []
let renderIndex = 0
let effectQueue = []

const react = {
  // 错误边界要 `extends react.Component`（本文件的边界与 Git 面板那两层是同一套写法），
  // 因此桩里必须真的有这个基类——否则插件会退化成"透传函数组件"，而 `data-review-turn-surface`
  // 那个标记就永远不会出现在树上（这一条正是踩过的坑）。
  Component: class FakeComponent {
    constructor(props) {
      this.props = props
    }
  },
  createElement(type, props, ...children) {
    const kids = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
    return { type, props: { ...(props ?? {}), children: kids } }
  },
  Fragment: Symbol.for('react.fragment'),
  useState(init) {
    const slot = renderIndex++
    const slots = hookSlots
    if (!(slot in slots)) slots[slot] = typeof init === 'function' ? init() : init
    slots[slot + 1000] = (value) => {
      slots[slot] = typeof value === 'function' ? value(slots[slot]) : value
    }
    return [slots[slot], slots[slot + 1000]]
  },
  useRef(init) {
    const slot = renderIndex++
    if (!(slot in hookSlots)) hookSlots[slot] = { current: init }
    return hookSlots[slot]
  },
  useMemo(fn, deps) {
    const slot = renderIndex++
    const prev = hookSlots[slot]
    const cacheable = Array.isArray(deps)
    if (cacheable && prev !== undefined && Array.isArray(prev.deps) && deps.every((d, i) => Object.is(d, prev.deps[i]))) {
      return prev.value
    }
    const value = fn()
    if (cacheable) hookSlots[slot] = { deps, value }
    return value
  },
  useCallback(fn, deps) {
    return react.useMemo(() => fn, deps)
  },
  useEffect(fn, deps) {
    const slot = renderIndex++
    const slots = hookSlots
    const prev = slots[slot]
    const changed = prev === undefined || deps === undefined || prev.deps === undefined || deps.some((d, i) => !Object.is(d, prev.deps[i]))
    if (!changed) return
    if (typeof prev?.cleanup === 'function') {
      try {
        prev.cleanup()
      } catch {
        // 清理抛错不影响渲染。
      }
    }
    slots[slot] = { deps }
    effectQueue.push(() => {
      const cleanup = fn()
      slots[slot] = { deps, cleanup }
    })
  },
  useSyncExternalStore(subscribe, getSnapshot) {
    const slot = renderIndex++
    const prev = hookSlots[slot]
    if (prev === undefined || prev.subscribe !== subscribe) {
      if (typeof prev?.unsubscribe === 'function') prev.unsubscribe()
      hookSlots[slot] = { subscribe, unsubscribe: subscribe(() => {}) }
    }
    return getSnapshot()
  },
}

function render(Comp, props, key) {
  const saved = { hookSlots, renderIndex, effectQueue }
  hookSlots = componentHooks.get(key) ?? []
  renderIndex = 0
  effectQueue = []
  let tree
  try {
    tree = Comp(props)
  } finally {
    componentHooks.set(key, hookSlots)
    hookSlots = saved.hookSlots
    renderIndex = saved.renderIndex
  }
  const effects = effectQueue
  effectQueue = saved.effectQueue
  return { tree, effects }
}

const classInstances = new Map()
const isClassComponent = (type) =>
  typeof type === 'function' && type.prototype !== undefined && Boolean(type.prototype.isReactComponent)
// 真实的 React 在 `Component.prototype` 上放 `isReactComponent`；插件正是靠它（以及
// `extends react.Component`）把错误边界写成类组件的，因此桩里也要有。
react.Component.prototype.isReactComponent = {}

function collectHostNodes(node, key = 'root', queued) {
  const out = []
  const visit = (current, path) => {
    if (current === null || current === undefined) return
    if (Array.isArray(current)) {
      current.forEach((child, index) => visit(child, `${path}.${index}`))
      return
    }
    if (typeof current !== 'object') return
    if (typeof current.type === 'function') {
      const name = current.type.name === '' ? 'anonymous' : current.type.name
      const keyed = `${path}${current.props?.key === undefined ? '' : `#${String(current.props.key)}`}:${name}`
      // 类组件（错误边界）要用 `new` 实例化，并且**不能再往上抛**：边界的降级分支就是它的
      // `render()`。这里没有实例状态（`this.state` 由类自己维护），失败时按降级渲染重试一次。
      if (isClassComponent(current.type)) {
        let instance = classInstances.get(keyed)
        if (instance === undefined) {
          instance = new current.type(current.props)
          classInstances.set(keyed, instance)
        }
        instance.props = current.props
        const isBoundary = typeof current.type.getDerivedStateFromError === 'function' || typeof instance.componentDidCatch === 'function'
        if (!isBoundary) {
          visit(instance.render(), keyed)
          return
        }
        try {
          visit(instance.render(), keyed)
        } catch (error) {
          for (const existing of [...componentHooks.keys()]) if (existing.startsWith(`${keyed}.`)) componentHooks.delete(existing)
          const derived = typeof current.type.getDerivedStateFromError === 'function' ? current.type.getDerivedStateFromError(error) : undefined
          if (derived !== undefined && derived !== null) instance.state = { ...instance.state, ...derived }
          visit(instance.render(), keyed)
        }
        return
      }
      const { tree, effects } = render(current.type, current.props, keyed)
      if (queued !== undefined) queued.push(...effects)
      visit(tree, keyed)
      return
    }
    out.push(current)
    visit(current.props?.children, `${path}.c`)
  }
  visit(node, key)
  return out
}

// ---- 假 DOM ----------------------------------------------------------------------
const domListeners = new Map()
const stored = new Map()
globalThis.document = {
  head: { appendChild() {} },
  body: { dataset: {} },
  documentElement: {},
  addEventListener(type, handler) {
    if (!domListeners.has(type)) domListeners.set(type, new Set())
    domListeners.get(type).add(handler)
  },
  removeEventListener(type, handler) {
    domListeners.get(type)?.delete(handler)
  },
  querySelector: () => null,
  createElement: () => ({ dataset: {}, style: {}, textContent: '', remove() {} }),
}
globalThis.window = {
  innerWidth: 1400,
  innerHeight: 900,
  localStorage: {
    getItem: (key) => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => stored.set(key, String(value)),
    removeItem: (key) => stored.delete(key),
  },
  addEventListener() {},
  removeEventListener() {},
  __ModuleLoader__: {
    load({ factory }) {
      loaded = factory((specifier) => (specifier === 'react' ? react : {}))
    },
  },
}
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '14px' })
// 定时器：本测试只关心"首帧 + 状态变化"，轮询不参与（登记成空实现即可）。
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

// ---- 假 host ---------------------------------------------------------------------
const file = (path, extra) => ({
  path, status: 'M', added: 1, removed: 1, staged: false, unstaged: true, untracked: false, index: ' ', worktree: 'M', ...extra,
})
/** 每个会话的**本轮**改动（`/changes`）。A 恰好是需求里的 4 个文件。 */
const turnData = new Map([
  [SA, {
    isRepo: true,
    scope: 'turn',
    revision: 'a'.repeat(40),
    truncated: false,
    diff: '',
    files: [file('src/a.ts', { added: 10, removed: 1 }), file('src/b.ts', { added: 2, removed: 3 }), file('src/new.ts', { status: 'A', untracked: true }), file('old.ts', { status: 'D' })],
  }],
  [SB, {
    isRepo: true,
    scope: 'turn',
    revision: 'b'.repeat(40),
    truncated: false,
    diff: '',
    files: [file('p/1.ts'), file('p/2.ts'), file('p/3.ts'), file('p/4.ts'), file('p/5.ts')],
  }],
])
/** 故意让 `/workspace`（项目级）在 A 上给出**更多**文件：两个 surface 的数据不能混。 */
const workspaceData = new Map([
  [A, { isRepo: true, branch: 'main', head: 'a'.repeat(40), files: [file('user-before.txt'), file('src/a.ts'), file('src/b.ts'), file('other.ts')], diff: '', truncated: false }],
  [B, { isRepo: true, branch: 'main', head: 'b'.repeat(40), files: [file('p/1.ts')], diff: '', truncated: false }],
])
/** 每个会话的 cwd（= workspace）。 */
const sessionSnapshot = {
  current: SA,
  ids: [SA, SB],
  byId: { [SA]: { cwd: A, isRunning: false }, [SB]: { cwd: B, isRunning: false } },
}
/** 可注入的延迟：按"路由 + 第几次调用"决定什么时候 resolve（竞态用例用）。 */
let delayFor = null
const requests = []
globalThis.fetch = async (url, init) => {
  const target = String(url)
  const body = init?.body === undefined ? undefined : JSON.parse(init.body)
  const route = target.slice(target.indexOf('/dsh-desktop/review/') + '/dsh-desktop/review/'.length).split('?')[0]
  const record = { route, body }
  requests.push(record)
  const wait = typeof delayFor === 'function' ? delayFor(record, requests) : 0
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  const wrap = (payload) => ({ ok: true, text: async () => JSON.stringify(payload) })
  if (route === 'changes') return wrap(turnData.get(body?.sessionId) ?? { isRepo: true, scope: 'turn', files: [], diff: '', truncated: false })
  if (route === 'workspace') return wrap(workspaceData.get(body?.workspace) ?? { isRepo: true, files: [], diff: '', truncated: false })
  if (route === 'baseline') return wrap({ revision: 'c'.repeat(40) })
  if (route === 'project-git-scope') {
    return wrap({
      workspaceRoot: body?.workspace,
      repositories: [{ repositoryRoot: body?.workspace, gitDir: `${body?.workspace}\\.git`, relativePath: '', name: 'proj' }],
      discovery: { complete: true, directoriesVisited: 1, candidatesFound: 1, gitProbes: 1, durationMs: 1, truncatedByBudget: false, cached: false },
    })
  }
  if (route === 'graph') return wrap({ isRepo: true, branch: 'main', hasMore: false, commits: [] })
  return wrap({ isRepo: true, files: [], changedFiles: 0, branch: '', head: '' })
}

// ---- 加载并挂载插件 --------------------------------------------------------------
let loaded
await import(PLUGIN)

const entries = new Map()
const injectedFaces = new Map()
const registeredTypes = []
/** 官方侧边栏服务的记录桩：断言"点入口之后发生了什么"。 */
const sidebarCalls = { openTab: [], openTabIn: [], toggleExpanded: 0, expanded: false, activeKind: undefined }
const sidebarRight = {
  openTab: (kind, options) => {
    sidebarCalls.openTab.push({ kind, options })
    sidebarCalls.activeKind = kind
  },
  openTabIn: (sessionId, kind, options) => {
    sidebarCalls.openTabIn.push({ sessionId, kind, options })
    sidebarCalls.activeKind = kind
  },
  isExpanded: () => sidebarCalls.expanded,
  toggleExpanded: () => {
    sidebarCalls.toggleExpanded += 1
    sidebarCalls.expanded = !sidebarCalls.expanded
  },
  active: () => (sidebarCalls.activeKind === undefined ? undefined : { kind: sidebarCalls.activeKind }),
}
const sidebarRightTabs = {
  register(definition) {
    registeredTypes.push(definition)
    return () => {}
  },
}
const ctx = {
  effect(fn) {
    fn()
  },
  locale: { register() {}, bind: () => (key) => key },
  slots: {
    inject(_name, callback) {
      callback()
    },
    register(options, component) {
      const key = `${options.name}:${options.key ?? options.id}`
      entries.set(key, component)
      if (options.inject !== undefined) injectedFaces.set(key, options.inject())
      return () => {}
    },
  },
  sidebarRight,
  sidebarRightTabs,
  sessions: { list: {} },
  workspaces: { list: {} },
}
loaded.apply(ctx)

const CHIP_KEY = 'dsh.desktop.composer.actions:review-changes'
const REVIEW_BODY_KEY = 'sidebar.right.pane.tab:dsh-client-ui-review/review'
const REVIEW_TITLE_KEY = 'sidebar.right.pane.tab.title:dsh-client-ui-review/review'
const GIT_BODY_KEY = 'sidebar.right.pane.tab:dsh-client-ui-review/git'
const Chip = entries.get(CHIP_KEY)
const ReviewBody = entries.get(REVIEW_BODY_KEY)
const ReviewTitle = entries.get(REVIEW_TITLE_KEY)
const GitBody = entries.get(GIT_BODY_KEY)
const injected = (key) => injectedFaces.get(key) ?? {}

let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `（期望 ${expected}）`}`)
}
const has = (label, actual) => check(label, actual === true, true)
const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node !== 'object') return ''
  return textOf(node.props?.children)
}
const allText = (nodes) => nodes.map((n) => textOf(n)).join(' ')
const rowsOf = (nodes, attr) => nodes.filter((n) => n.props?.[attr] !== undefined)
const makeSelectorHook = (read) => (selector) =>
  react.useSyncExternalStore(
    () => () => {},
    () => selector(read()),
  )
const t = (key, params) =>
  params === undefined ? key : `${key}(${Object.entries(params).map(([name, value]) => `${name}=${value}`).join(',')})`
const sessionsHook = makeSelectorHook(() => sessionSnapshot)

let seq = 0
/**
 * 渲染到"稳定"：反复展开子组件并执行副作用，直到没有新的 effect。
 *
 * 每个用例先用一个新的 `key`（= 一次全新的挂载），否则上一节的 hook 槽会串到下一节。
 */
async function drain(Comp, props, prefix) {
  const key = `${prefix}-${(seq += 1)}`
  let nodes = []
  for (let pass = 0; pass < 12; pass += 1) {
    const queued = []
    const out = render(Comp, props, key)
    queued.push(...out.effects)
    nodes = collectHostNodes(out.tree, key, queued)
    if (queued.length === 0) break
    for (const effect of queued) effect()
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return nodes
}

/** 挂载审查标签正文（带官方标准注入面）。 */
const openReviewTab = (props = {}) =>
  drain(ReviewBody, { ...injected(REVIEW_BODY_KEY), t, useSessions: sessionsHook, sessionId: SA, ...props }, 'review-tab')
/** 挂载输入框上方那个入口。 */
const openChip = (props = {}) =>
  drain(Chip, { ...injected(CHIP_KEY), t, useSessions: sessionsHook, ...props }, 'chip')
const resetSidebarCalls = () => {
  sidebarCalls.openTab.length = 0
  sidebarCalls.openTabIn.length = 0
  sidebarCalls.toggleExpanded = 0
  sidebarCalls.expanded = false
  sidebarCalls.activeKind = undefined
  delete globalThis.window.__dshDesktopReviewOpen
}

console.log('=== 0. 结构：两个标签、两组注册、两个 kind ===')
{
  has('0) 「本轮修改」入口注册在输入框槽位', Chip !== undefined)
  has('   审查标签正文注册在 sidebar.right.pane.tab', ReviewBody !== undefined)
  has('   审查标签标题注册在 sidebar.right.pane.tab.title', ReviewTitle !== undefined)
  has('   Git 标签正文仍然在（不回归）', GitBody !== undefined)
  has('   两个标签的 key 不同', REVIEW_BODY_KEY !== GIT_BODY_KEY)

  const ids = loaded.__sidebarIdsForTest
  check('   REVIEW_KIND', ids.REVIEW_KIND, 'review')
  check('   REVIEW_SIDEBAR_ID', ids.REVIEW_SIDEBAR_ID, 'dsh-client-ui-review/review')
  check('   GIT_KIND', ids.GIT_KIND, 'git')
  check('   GIT_SIDEBAR_ID', ids.GIT_SIDEBAR_ID, 'dsh-client-ui-review/git')
  has('   REVIEW_KIND !== GIT_KIND', ids.REVIEW_KIND !== ids.GIT_KIND)
  has('   REVIEW_SIDEBAR_ID !== GIT_SIDEBAR_ID', ids.REVIEW_SIDEBAR_ID !== ids.GIT_SIDEBAR_ID)

  // 类型表里必须**两个**都注册了：缺一个都会让 openTab 抛 "no tab type is registered"。
  const kinds = registeredTypes.map((d) => d.kind).sort().join(',')
  check('   侧栏类型表里注册了 review 与 git', kinds, 'git,review')
  check('   每个注册都有独立的 id', new Set(registeredTypes.map((d) => d.id)).size, 2)
  for (const definition of registeredTypes) {
    has(`   ${definition.kind} 的标题是函数（跟随语言）`, typeof definition.title === 'function')
  }
}

console.log('')
console.log('=== Case A：点「本轮修改」→ 打开审查标签（不是 Git） ===')
{
  resetSidebarCalls()
  // 侧栏收起：点入口必须先开标签、再展开。
  sidebarCalls.expanded = false
  const nodes = await openChip()
  const chip = nodes.find((n) => n.props?.['data-review-turn-chip'] !== undefined)
  has('A) 找到入口按钮', chip !== undefined)
  check('   入口显示本轮数量', textOf(chip), 'turnFiles(count=4)')
  has('   入口的 aria-controls 指向审查标签', String(chip.props['aria-controls']).includes('review'))
  check('   点击前侧栏调用次数', sidebarCalls.openTab.length, 0)

  chip.props.onClick()
  check('   openTab 的 kind 是 review', sidebarCalls.openTab[0]?.kind, 'review')
  check('   只调用了 openTab 一次', sidebarCalls.openTab.length, 1)
  check('   **没有**打开 Git', sidebarCalls.openTab.filter((c) => c.kind === 'git').length, 0)
  check('   没有走 openTabIn 兜底', sidebarCalls.openTabIn.length, 0)
  check('   侧栏被展开了', sidebarCalls.toggleExpanded, 1)
  check('   侧栏当前展开', sidebarCalls.expanded, true)
  const diagnostic = globalThis.window.__dshDesktopReviewOpen
  check('   诊断：打开成功', diagnostic?.opened, true)
  check('   诊断：kind', diagnostic?.kind, 'review')
  check('   诊断：sessionId', diagnostic?.sessionId, SA)

  // 已经展开时不再 toggle（否则用户每点一次都会把侧栏收起来）。
  resetSidebarCalls()
  sidebarCalls.expanded = true
  const again = await openChip()
  again.find((n) => n.props?.['data-review-turn-chip'] !== undefined).props.onClick()
  check('   已展开时不再 toggleExpanded', sidebarCalls.toggleExpanded, 0)
  check('   仍然把侧栏切到 review', sidebarCalls.openTab[0]?.kind, 'review')
}

console.log('')
console.log('=== Case A2：openTab 失败时退回 openTabIn，绝不静默无反应 ===')
{
  resetSidebarCalls()
  const openReviewSidebar = loaded.__openReviewSidebarForTest
  const failing = {
    openTab() {
      throw new Error('sidebarRight: no session surface is mounted')
    },
    openTabIn: (sessionId, kind) => sidebarCalls.openTabIn.push({ sessionId, kind }),
    isExpanded: () => true,
    toggleExpanded: () => {
      sidebarCalls.toggleExpanded += 1
    },
  }
  const outcome = openReviewSidebar(failing, SA, t)
  check('A2) 退回 openTabIn', sidebarCalls.openTabIn.length, 1)
  check('   用的是当前 sessionId', sidebarCalls.openTabIn[0]?.sessionId, SA)
  check('   kind 仍然是 review', sidebarCalls.openTabIn[0]?.kind, 'review')
  check('   结果标记为已打开', outcome.opened, true)

  // 两个都不可用时必须把原因说出来（诊断 + 返回值），而不是"点了没反应"。
  resetSidebarCalls()
  const broken = {
    openTab() {
      throw new Error('boom')
    },
  }
  const failed = openReviewSidebar(broken, SA, t)
  check('   失败时 opened=false', failed.opened, false)
  has('   失败原因被记录下来', String(failed.error).includes('boom'))
  check('   诊断里也带上了失败信息', globalThis.window.__dshDesktopReviewOpen?.opened, false)
}

console.log('')
console.log('=== Case B：审查标签拿到与入口**同一个** workspace，文件数一致 ===')
{
  const nodes = await openReviewTab({ sessionId: SA })
  const diagnostic = globalThis.window.__dshDesktopReviewTab
  check('B) 诊断：sessionId', diagnostic?.sessionId, SA)
  check('   诊断：workspace 是当前会话的 cwd', diagnostic?.workspace, A)
  check('   诊断：fileCount', diagnostic?.fileCount, 4)
  check('   诊断：phase', diagnostic?.phase, 'ready')
  check('   面板列出的文件数', textOf(rowsOf(nodes, 'data-review-turn-count')[0] ?? null), 'files(count=4)')
  check('   面板计数与入口数字一致（4 == 4）', diagnostic?.fileCount, 4)
  // **这条是这次故障的核心断言**：能显示数字的会话，绝不能报"没有工作区"。
  check('   绝不显示 noWorkspace', allText(nodes).includes('noWorkspace'), false)
  has('   面板有本轮审查的内容区', rowsOf(nodes, 'data-review-turn-body').length === 1)
  // surface 标记必须是 sidebar（官方侧栏里的标签），不再是 drawer（自制浮层）。
  const surface = rowsOf(nodes, 'data-review-turn-surface')[0]
  check('   surface 标记是 sidebar（不再是 drawer）', surface?.props?.['data-review-turn-surface'], 'sidebar')
  check('   面板里**没有**自己的关闭按钮（交给官方标签）', rowsOf(nodes, 'data-review-turn-close').length, 0)

  // 数据 scope：审查只读 `/changes`，绝不读 `/workspace`。
  const mine = requests.filter((r) => r.route === 'changes').length
  has('   读了 /changes', mine > 0)
  check('   没有读 /workspace（那是 Git 标签的数据）', requests.filter((r) => r.route === 'workspace').length, 0)
  check('   本轮只列 4 个文件（不含用户自己早先改的）', diagnostic?.fileCount, 4)
}

console.log('')
console.log('=== Case C：真没有会话时才是 noWorkspace ===')
{
  const noSession = await openReviewTab({ sessionId: undefined, useSessions: makeSelectorHook(() => ({ current: undefined, byId: {} })) })
  check('C) 没有当前会话 → phase', globalThis.window.__dshDesktopReviewTab?.phase, 'noContext')
  check('   workspace 为 null', globalThis.window.__dshDesktopReviewTab?.workspace, null)
  // 侧栏给了 sessionId、但快照里查不到它的 cwd（会话正在拆装）→ 明确区分成 noSession。
  const orphan = await openReviewTab({ sessionId: 'ghost', useSessions: makeSelectorHook(() => ({ current: 'ghost', byId: {} })) })
  check('   会话没有 cwd → phase', globalThis.window.__dshDesktopReviewTab?.phase, 'noSession')
  void orphan
  // 面板本体自己读一次数据（纯渲染壳之外的 Connected 变体），此时才允许显示 noWorkspace。
  const connected = loaded.__turnReviewPanelConnectedForTest
  const nodes = await drain(connected, { t, workspace: undefined, sessionId: undefined }, 'review-panel-nocontext')
  has('   面板显示"没有可用的工作区"', allText(nodes).includes('noWorkspace'))
  void noSession
}

console.log('')
console.log('=== Case D：切到另一个会话 → 侧栏跟着换 workspace 与文件数 ===')
{
  sessionSnapshot.current = SB
  const nodes = await openReviewTab({ sessionId: SB })
  const diagnostic = globalThis.window.__dshDesktopReviewTab
  check('D) 诊断：sessionId', diagnostic?.sessionId, SB)
  check('   诊断：workspace', diagnostic?.workspace, B)
  check('   诊断：fileCount', diagnostic?.fileCount, 5)
  check('   面板计数', textOf(rowsOf(nodes, 'data-review-turn-count')[0] ?? null), 'files(count=5)')
  check('   **没有**停留在 A 的文件数', diagnostic?.fileCount === 4, false)
  sessionSnapshot.current = SA
}

console.log('')
console.log('=== Case D2：侧栏已打开时在会话之间切换（标准注入面跟着变） ===')
{
  // 官方侧栏的标签在切换会话时可能复用同一个组件实例：sessionId 变了就必须重新解析。
  const first = await openReviewTab({ sessionId: SA })
  check('D2) 先是 A 的 workspace', globalThis.window.__dshDesktopReviewTab?.workspace, A)
  void first
  const second = await openReviewTab({ sessionId: SB })
  check('   换成 B 之后 workspace 变了', globalThis.window.__dshDesktopReviewTab?.workspace, B)
  check('   文件数也换了', globalThis.window.__dshDesktopReviewTab?.fileCount, 5)
  const third = await openReviewTab({ sessionId: SA })
  check('   切回 A 又是 A 的文件数', globalThis.window.__dshDesktopReviewTab?.fileCount, 4)
  void second
  void third
}

console.log('')
console.log('=== Case E：竞态 —— A 的响应晚于 B 到达时必须被丢弃 ===')
{
  // 让 A 的 `/changes` 慢 120ms、B 的快：先渲染 A，再切到 B，最后 A 才回来。
  delayFor = (record) => (record.route === 'changes' && record.body?.sessionId === SA ? 120 : 0)
  sessionSnapshot.current = SA
  const slow = openReviewTab({ sessionId: SA })
  await new Promise((resolve) => setTimeout(resolve, 10))
  sessionSnapshot.current = SB
  const fast = openReviewTab({ sessionId: SB })
  const nodes = await fast
  check('E) 切到 B 后 workspace 是 B', globalThis.window.__dshDesktopReviewTab?.workspace, B)
  check('   B 的文件数', globalThis.window.__dshDesktopReviewTab?.fileCount, 5)
  // 等 A 的慢响应落地：它**不能**覆盖 B。
  await slow
  await new Promise((resolve) => setTimeout(resolve, 200))
  check('   A 晚到之后仍然是 B 的 workspace', globalThis.window.__dshDesktopReviewTab?.workspace, B)
  check('   A 晚到之后仍然是 B 的文件数', globalThis.window.__dshDesktopReviewTab?.fileCount, 5)
  check('   面板仍然列 5 个文件', textOf(rowsOf(nodes, 'data-review-turn-count')[0] ?? null), 'files(count=5)')
  delayFor = null
}

console.log('')
console.log('=== Case F：静态契约 —— 自制抽屉已经彻底消失 ===')
{
  const source = readFileSync(SOURCE_PATH, 'utf8')
  /** 去掉注释：历史写法在注释里被**故意**留着警示后人，断言只针对代码。 */
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^[ \t]*\/\/.*$/gmu, '')
  const code = stripComments(source)

  has('F) 常量 REVIEW_KIND = review', /const REVIEW_KIND = 'review'/u.test(source))
  has('   常量 REVIEW_SIDEBAR_ID', /const REVIEW_SIDEBAR_ID = 'dsh-client-ui-review\/review'/u.test(source))
  for (const gone of ['TURN_DRAWER_SLOT', 'TURN_DRAWER_ID', 'turnDrawerStore', 'useTurnDrawerOpen', 'TurnReviewDrawer']) {
    check(`   代码里不再有 ${gone}`, code.includes(gone), false)
  }
  check('   代码里不再注册 shell.overlay', code.includes("'shell.overlay'"), false)
  check('   没有 zIndex: 9999', code.includes('9999'), false)
  // 自制浮层的判据**不是** "position: fixed"（同一个文件里的对话框确实用它），而是
  // 旧抽屉那套"fixed + 760px 宽 + top/right 定位 + Escape 关闭"的组合。
  /** 取一段函数源码（去注释）。 */
  const bodyOf = (signature) => {
    const start = source.indexOf(signature)
    if (start < 0) return ''
    const end = source.indexOf('\n    }\n', start)
    return stripComments(end < 0 ? source.slice(start) : source.slice(start, end))
  }
  const chipBody = bodyOf('function TurnReviewChip(props)')
  has('   取到了入口源码', chipBody.length > 500)
  check('   入口源码里没有 fixed 定位', chipBody.includes('fixed'), false)
  check('   入口源码里没有 760px 抽屉宽度', chipBody.includes('760px'), false)
  check('   入口源码里没有 Escape 关闭', chipBody.includes('Escape'), false)
  check('   入口源码里没有 openTab 之外的侧栏调用', /toggleExpanded/u.test(chipBody), false)
  has('   入口点击走 openReviewSidebar', /onClick: \(\) => \{\s*\n\s*const outcome = openReviewSidebar\(/u.test(source))
  has('   openReviewSidebar 用的是 REVIEW_KIND', /openTab\(REVIEW_KIND/u.test(source))
  has('   入口与侧栏共用 useTurnContext', /const \{ sessionId, workspace \} = useTurnContext\(props\)/u.test(source))
  // **恰好两处调用**：入口（TurnReviewChip）与侧栏正文（ReviewSidebarTab）。多出一处就是
  // 第三份上下文解析——那正是这次故障的形状（两套解析，必然对不上）。
  check('   useTurnContext 只被这两个组件调用', (code.match(/= useTurnContext\(props\)/gu) ?? []).length, 2)
  // 图标必须真的来自官方 primitives（`IconBranchOutline16` 那个名字并不存在）。
  has('   审查标签图标取自 primitives', /primitives\.IconChecklistOutlineRegular/u.test(source))
  has('   Git 标签图标取自 primitives 里真实存在的名字', /primitives\.IconBranchOutlineRegular/u.test(source))
  check('   代码里不再引用不存在的 IconBranchOutline16', code.includes('IconBranchOutline16'), false)
}

console.log('')
console.log(failures === 0 ? '本轮审查走官方右侧栏，且入口与标签共用同一份会话上下文' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
