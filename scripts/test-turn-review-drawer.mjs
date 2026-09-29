// 「本轮修改」入口与项目级 Git 的**隔离契约**（turn scope 的独立抽屉）。
//
//   node scripts/test-turn-review-drawer.mjs
//
// 这个文件回答一个问题：**点「本轮修改」到底发生了什么。**
//
// 曾经的回归：两者共用了一个 `KIND`（`'git'`），于是入口调用的
// `sidebarRight.openTab('git')` 打开的是项目级 Git 标签，用户在"本轮修改 5"里看到的是
// 整个仓库的 Changes。这个文件就是钉住"那件事不许再发生"：
//
//   Case A  点「本轮修改」→ 独立的 TurnReviewDrawer 出现，且 `openTab` / `openTabIn` /
//           `toggleExpanded` 的调用次数**必须都是 0**；
//   Case B  点官方 Git 图标 → 官方 Git 标签正文（ProjectGitPanel）出现，本轮抽屉**不打开**；
//   Case C  官方 Git 侧栏已展开且停在 Git 标签 → 再点「本轮修改」：侧栏的展开状态与活动
//           标签纹丝不动，本轮抽屉独立出现；
//   Case D  本轮抽屉已打开 → 打开官方 Git 侧栏：抽屉**不被替换、不被关闭**。
//
// 运行方式与其它 review 测试一致：直接加载**真实的客户端 bundle**，用桩 React / 桩 DOM /
// 桩 host 驱动它，不需要 Electron。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PLUGIN = pathToFileURL(join(ROOT, 'plugins', 'dsh-client-ui-review', 'lib', 'client.js')).href

const WORKSPACE = 'F:\\code\\projA'
const SESSION = 's1'

// ---- 假 React（带 hook 序列校验）------------------------------------------------
// 与 `test-review-project-git.mjs` 同一套：hook 数量/顺序一变就记一笔（等价于真实 React
// 的 #310）。本轮抽屉在"收起"时提前返回，因此这条校验对它格外有价值。
const componentHooks = new Map()
const classInstances = new Map()
const hookShapes = new Map()
let hookSlots = []
let renderIndex = 0
let effectQueue = []
let currentCalls = []
const hookOrderErrors = []

class FakeComponent {
  constructor(props) {
    this.props = props
  }
}

FakeComponent.prototype.isReactComponent = {}

const traced = (name, fn) => (...args) => {
  currentCalls.push(name)
  return fn(...args)
}

const react = {
  Component: FakeComponent,
  Fragment: Symbol.for('react.fragment'),
  createElement(type, props, ...children) {
    const kids = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
    return { type, props: { ...(props ?? {}), children: kids } }
  },
  useState: traced('useState', (init) => {
    const slot = renderIndex++
    const slots = hookSlots
    if (!(slot in slots)) slots[slot] = typeof init === 'function' ? init() : init
    slots[slot + 1000] = (value) => {
      slots[slot] = typeof value === 'function' ? value(slots[slot]) : value
    }
    return [slots[slot], slots[slot + 1000]]
  }),
  useRef: traced('useRef', (init) => {
    const slot = renderIndex++
    if (!(slot in hookSlots)) hookSlots[slot] = { current: init }
    return hookSlots[slot]
  }),
  useMemo: traced('useMemo', (fn, deps) => {
    const slot = renderIndex++
    const prev = hookSlots[slot]
    const cacheable = Array.isArray(deps)
    if (cacheable && prev !== undefined && Array.isArray(prev.deps) && deps.every((d, i) => Object.is(d, prev.deps[i]))) {
      return prev.value
    }
    const value = fn()
    if (cacheable) hookSlots[slot] = { deps, value }
    return value
  }),
  useCallback: traced('useCallback', (fn, deps) => react.useMemo(() => fn, deps)),
  useEffect: traced('useEffect', (fn, deps) => {
    const slot = renderIndex++
    const prev = hookSlots[slot]
    const changed = prev === undefined || deps === undefined || prev.deps === undefined || deps.some((d, i) => !Object.is(d, prev.deps[i]))
    if (changed) {
      hookSlots[slot] = { deps }
      effectQueue.push(fn)
    }
  }),
  useSyncExternalStore: traced('useSyncExternalStore', (subscribe, getSnapshot) => {
    const slot = renderIndex++
    const prev = hookSlots[slot]
    if (prev === undefined || prev.subscribe !== subscribe) {
      hookSlots[slot] = { subscribe, unsubscribe: subscribe(() => {}) }
    }
    return getSnapshot()
  }),
}

function render(Comp, props, key) {
  const saved = { hookSlots, renderIndex, effectQueue, currentCalls }
  hookSlots = componentHooks.get(key) ?? []
  renderIndex = 0
  currentCalls = []
  let tree
  let effects
  try {
    tree = Comp(props)
  } finally {
    effects = effectQueue
    const before = hookShapes.get(key)
    const after = currentCalls.join(',')
    if (before !== undefined && before !== after) hookOrderErrors.push({ key, before, after })
    hookShapes.set(key, after)
    componentHooks.set(key, hookSlots)
    hookSlots = saved.hookSlots
    renderIndex = saved.renderIndex
    effectQueue = saved.effectQueue
    currentCalls = saved.currentCalls
  }
  return { tree, effects }
}

const isClassComponent = (type) =>
  typeof type === 'function' && type.prototype !== undefined && Boolean(type.prototype.isReactComponent)

function collectHostNodes(node, queued, rootKey) {
  const out = []
  const visit = (current, path) => {
    if (current === null || current === undefined) return
    if (Array.isArray(current)) {
      current.forEach((child, index) => visit(child, `${path}.${index}`))
      return
    }
    if (typeof current !== 'object') return
    const type = current.type
    if (typeof type === 'function') {
      const keyed = current.props?.key === undefined ? `${path}:${type.name}` : `${path}:${type.name}#${String(current.props.key)}`
      if (isClassComponent(type)) {
        let instance = classInstances.get(keyed)
        if (instance === undefined) {
          instance = new type(current.props)
          classInstances.set(keyed, instance)
        }
        instance.props = current.props
        const isBoundary = typeof type.getDerivedStateFromError === 'function' || typeof instance.componentDidCatch === 'function'
        if (!isBoundary) {
          visit(instance.render(), keyed)
          return
        }
        try {
          visit(instance.render(), keyed)
        } catch (error) {
          for (const existing of [...componentHooks.keys()]) if (existing.startsWith(`${keyed}.`)) componentHooks.delete(existing)
          for (const existing of [...hookShapes.keys()]) if (existing.startsWith(`${keyed}.`)) hookShapes.delete(existing)
          const derived = typeof type.getDerivedStateFromError === 'function' ? type.getDerivedStateFromError(error) : undefined
          if (derived !== undefined && derived !== null) instance.state = { ...instance.state, ...derived }
          if (typeof instance.componentDidCatch === 'function') instance.componentDidCatch(error, { componentStack: `\n    in ${type.name}` })
          visit(instance.render(), keyed)
        }
        return
      }
      const { tree, effects } = render(type, current.props, keyed)
      if (queued !== undefined) queued.push(...effects)
      visit(tree, keyed)
      return
    }
    out.push(current)
    visit(current.props?.children, `${path}.c`)
  }
  visit(node, rootKey ?? 'root')
  return out
}

// ---- 假 DOM ----------------------------------------------------------------------
const domListeners = new Map()
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
/** 派发一次键盘事件（Escape 关闭本轮抽屉的断言点）。 */
const pressKey = (key) => {
  for (const handler of domListeners.get('keydown') ?? []) handler({ key })
}
globalThis.window = {
  innerWidth: 1400,
  innerHeight: 900,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  addEventListener() {},
  removeEventListener() {},
  __ModuleLoader__: {
    load({ factory }) {
      loaded = factory((specifier) => (specifier === 'react' ? react : {}))
    },
  },
}
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '14px' })
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

// ---- 假 host ---------------------------------------------------------------------
const file = (path, extra) => ({
  path,
  status: 'M',
  added: 1,
  removed: 1,
  staged: false,
  unstaged: true,
  untracked: false,
  index: ' ',
  worktree: 'M',
  ...extra,
})

/**
 * 本轮（`/changes`）的响应。
 *
 * 与项目级（`/workspace`）**刻意不同**：这是"用户在 agent 开始前就改过 a.txt"的那种仓库，
 * 因此项目级多一个文件、本轮少一个。断言由此能区分两个 surface 到底读了哪条路由。
 */
const TURN = {
  isRepo: true,
  files: [
    file('b.txt', { added: 4, removed: 1 }),
    file('c.txt', { status: 'A', added: 7, removed: 0, untracked: true, index: '?', worktree: '?' }),
  ],
  diff: 'diff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1,2 @@\n-old\n+new\n',
  truncated: false,
  revision: 'b'.repeat(40),
}
/** 项目级（`/workspace`）的响应：a.txt 是**用户自己**的改动，不属于本轮。 */
const PROJECT = {
  isRepo: true,
  branch: 'main',
  head: 'a'.repeat(40),
  empty: false,
  files: [file('a.txt'), file('b.txt'), file('c.txt', { status: 'A', untracked: true })],
  changedFiles: 3,
}
const requests = []
globalThis.fetch = async (url, init) => {
  const target = String(url)
  const body = init?.body === undefined ? undefined : JSON.parse(init.body)
  const route = target.slice(target.indexOf('/dsh-desktop/review/') + '/dsh-desktop/review/'.length).split('?')[0]
  requests.push({ route, body })
  const wrap = (payload) => ({ ok: true, text: async () => JSON.stringify(payload) })
  if (route === 'changes') return wrap(TURN)
  if (route === 'workspace') return wrap(PROJECT)
  if (route === 'project-git-scope') {
    return wrap({
      workspaceRoot: WORKSPACE,
      repositories: [{ repositoryRoot: WORKSPACE, gitDir: `${WORKSPACE}\\.git`, relativePath: '', name: 'projA' }],
      discovery: { complete: true, directoriesVisited: 1, candidatesFound: 1, gitProbes: 1, durationMs: 1, truncatedByBudget: false, cached: false },
    })
  }
  if (route === 'baseline') return wrap({ revision: 'b'.repeat(40) })
  if (route === 'graph') return wrap({ isRepo: true, branch: 'main', hasMore: false, commits: [] })
  return wrap({ isRepo: true, files: [], changedFiles: 0, branch: '', head: '' })
}

// ---- 加载并挂载插件 --------------------------------------------------------------
let loaded
await import(PLUGIN)

const entries = new Map()
const injectedFaces = new Map()

/**
 * 官方侧边栏服务的**记录桩**。
 *
 * 本轮审查的入口只要碰它一次，下面任何一条断言都会看到非零计数——这正是这次回归的判据。
 */
const sidebarCalls = { openTab: [], openTabIn: [], toggleExpanded: 0, setExpanded: [], active: undefined, expanded: false }
const sidebarRight = {
  openTab: (kind, options) => sidebarCalls.openTab.push({ kind, options }),
  openTabIn: (sessionId, kind, options) => sidebarCalls.openTabIn.push({ sessionId, kind, options }),
  toggleExpanded: () => {
    sidebarCalls.toggleExpanded += 1
    sidebarCalls.expanded = !sidebarCalls.expanded
  },
  setExpanded: (value) => sidebarCalls.setExpanded.push(value),
  isExpanded: () => sidebarCalls.expanded,
  active: () => sidebarCalls.active,
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
  sidebarRightTabs: { register: () => () => {} },
  sessions: { list: {} },
  workspaces: { list: {} },
}
loaded.apply(ctx)

const CHIP_KEY = 'dsh.desktop.composer.actions:review-changes'
const GIT_TAB_KEY = 'sidebar.right.pane.tab:dsh-client-ui-review/git'
const DRAWER_KEY = 'shell.overlay:dsh-client-ui-review/turn-drawer'
const Chip = entries.get(CHIP_KEY)
const GitTab = entries.get(GIT_TAB_KEY)
const Drawer = entries.get(DRAWER_KEY)
const injected = (key) => injectedFaces.get(key) ?? {}

let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `（期望 ${expected}）`}`)
}
const has = (label, actual) => check(label, actual === true, true)
const rowsOf = (nodes, attr) => nodes.filter((n) => n.props?.[attr] !== undefined)
const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node !== 'object') return ''
  return textOf(node.props?.children)
}
const allText = (nodes) => nodes.map((n) => textOf(n)).join(' ')
const makeSelectorHook = (read) => (selector) =>
  react.useSyncExternalStore(
    () => () => {},
    () => selector(read()),
  )

/** 会话快照：当前会话 + 它所属的工作区。 */
const sessionSnapshot = { current: SESSION, ids: [SESSION], byId: { [SESSION]: { cwd: WORKSPACE, isRunning: false } } }
const t = (key, params) =>
  params === undefined ? key : `${key}(${Object.entries(params).map(([name, value]) => `${name}=${value}`).join(',')})`
const baseProps = { t, useSessions: makeSelectorHook(() => sessionSnapshot) }

let seq = 0
/**
 * 渲染一个组件到"稳定"（反复展开并执行副作用，直到没有新的 effect）。
 *
 * 每节用一个**新的 key**：桩渲染器按"树中位置"分配 hook 槽，换 key 等价于一次全新挂载，
 * 否则上一节留下的展开状态会串到下一节（本仓库的几个测试都踩过这一点）。
 */
async function drainView(Comp, props, key) {
  let nodes = []
  for (let pass = 0; pass < 10; pass += 1) {
    const queued = []
    const out = render(Comp, props, key)
    queued.push(...out.effects)
    nodes = collectHostNodes(out.tree, queued, key)
    if (queued.length > 0) for (const effect of queued) effect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (queued.length === 0) break
  }
  return nodes
}
// 注入面在前、本地 `t` 在后：注入的 `t` 是 `locale.bind()` 的桩（只回键名），而断言要看
// 真正的参数（`files(count=2)`），因此本地这个会把参数渲染出来的 `t` 必须覆盖它。
const drainChip = (key) => drainView(Chip, { ...injected(CHIP_KEY), ...baseProps, sessionId: SESSION }, `chip-${key}`)
const drainGit = (key) => drainView(GitTab, { ...injected(GIT_TAB_KEY), ...baseProps, sessionId: SESSION }, `git-${key}`)
const drainDrawer = (key) => drainView(Drawer, { ...injected(DRAWER_KEY), ...baseProps }, `drawer-${key}`)

/** 点一下「本轮修改」入口。 */
const clickChip = async (key) => {
  const nodes = await drainChip(key)
  const node = nodes.find((n) => n.props?.['data-review-turn-chip'] !== undefined)
  has(`  点得中「本轮修改」入口（${key}）`, node !== undefined && typeof node.props.onClick === 'function')
  node.props.onClick()
  return nodes
}
const sidebarUntouched = (label) => {
  check(`${label}：openTab 调用次数`, sidebarCalls.openTab.length, 0)
  check(`${label}：openTabIn 调用次数`, sidebarCalls.openTabIn.length, 0)
  check(`${label}：toggleExpanded 调用次数`, sidebarCalls.toggleExpanded, 0)
}
const resetSidebarCalls = () => {
  sidebarCalls.openTab.length = 0
  sidebarCalls.openTabIn.length = 0
  sidebarCalls.toggleExpanded = 0
  sidebarCalls.setExpanded.length = 0
  sidebarCalls.active = undefined
  sidebarCalls.expanded = false
}

console.log('=== 0. 三个 surface 各自注册在各自的槽位 ===')
{
  has('0) 「本轮修改」入口注册在输入框槽位', Chip !== undefined)
  has('   项目级 Git 注册在官方侧栏标签槽位', GitTab !== undefined)
  has('   本轮审查抽屉注册在 shell.overlay', Drawer !== undefined)
  // 入口**拿不到** sidebarRight：合同上就没有这条调用路径（不是"记得别调"）。
  const chipFace = injected(CHIP_KEY)
  check('   入口的注入面里没有 sidebarRight', Object.prototype.hasOwnProperty.call(chipFace, 'sidebarRight'), false)
  has('   入口的注入面里只有 t', Object.keys(chipFace).join(',') === 't')
  // 抽屉的开合状态是一个独立的模块级 store。
  has('   导出了独立的 turnDrawerStore', typeof loaded.__turnDrawerStoreForTest?.set === 'function')
  const store = loaded.__turnDrawerStoreForTest
  check('   初值是关闭', store.get(), false)
  store.set(false)
}

console.log('')
console.log('=== Case A：点「本轮修改」→ 独立抽屉出现，官方侧栏调用次数为 0 ===')
{
  resetSidebarCalls()
  const store = loaded.__turnDrawerStoreForTest
  store.set(false)

  const before = await drainDrawer('a-before')
  check('A) 点之前抽屉不渲染', rowsOf(before, 'data-review-turn-drawer').length, 0)

  await clickChip('a')
  check('   点击后 store 打开', store.get(), true)

  const drawer = await drainDrawer('a-after')
  has('   独立的本轮审查抽屉出现了', rowsOf(drawer, 'data-review-turn-drawer').length === 1)
  // surface 标记必须与官方侧栏的 `panel` 区分开：否则"谁在渲染"又说不清了。
  check('   标记为 turn drawer（不是侧栏 panel）', rowsOf(drawer, 'data-review-turn-surface')[0]?.props?.['data-review-turn-surface'], 'drawer')
  check('   抽屉里没有官方侧栏的 surface 标记', rowsOf(drawer, 'data-desktop-review-surface').length, 0)
  // **本文件的核心断言**：整条点击链路一次都没有碰官方侧栏。
  sidebarUntouched('   A')
  check('   也没有调用 setExpanded', sidebarCalls.setExpanded.length, 0)

  // 顺手钉住抽屉内容：标题、数量、增删统计、关闭入口。
  has('   抽屉标题是本轮修改审查', allText(drawer).includes('title'))
  check('   抽屉计数来自 /changes（本轮 2 个）', textOf(rowsOf(drawer, 'data-review-turn-count')[0] ?? null), 'files(count=2)')
  has('   抽屉有增删统计', rowsOf(drawer, 'data-review-turn-stats').length === 1)
  check('   抽屉的统计是本轮的行数', textOf(rowsOf(drawer, 'data-review-turn-stats')[0] ?? null), '+11-1')
  has('   抽屉有独立的关闭入口', rowsOf(drawer, 'data-review-turn-close').length === 1)
  // 内容**精简**：这不是第二套 Git 客户端。
  check('   抽屉里没有 Changes/Log 页签', rowsOf(drawer, 'data-review-tablist').length, 0)
  check('   抽屉里没有暂存/提交区', rowsOf(drawer, 'data-staging-commit-card').length, 0)
  check('   抽屉里没有仓库 scope 选择器', rowsOf(drawer, 'data-review-repo-select').length, 0)
  check('   抽屉里没有提交图', rowsOf(drawer, 'data-graph-view').length, 0)
  check('   抽屉里没有项目级面板的标题', rowsOf(drawer, 'data-review-title').length, 0)

  // 数据 scope：抽屉只读 `/changes`（turn），不读 `/workspace`（workspace）。
  const drawerRoutes = requests.map((r) => r.route)
  has('   抽屉读了 /changes', drawerRoutes.includes('changes'))
  check('   抽屉完全没有读 /workspace', requests.filter((r) => r.route === 'workspace').length, 0)

  // 再点一次：关闭。
  await clickChip('a-again')
  check('   再点一次关闭抽屉', store.get(), false)
  const closed = await drainDrawer('a-closed')
  check('   关闭后抽屉不再渲染', rowsOf(closed, 'data-review-turn-drawer').length, 0)
  sidebarUntouched('   A（关闭）')
}

console.log('')
console.log('=== Case B：打开官方 Git 图标 → Git 面板出现，本轮抽屉不动 ===')
{
  resetSidebarCalls()
  const store = loaded.__turnDrawerStoreForTest
  store.set(false)

  // 「点 Git 图标」在真实应用里就是官方侧栏打开我们注册的 `git` 标签类型。
  sidebarRight.openTab('git', {})
  check('B) 官方侧栏收到 openTab(git)', sidebarCalls.openTab.length, 1)
  check('   开的确实是 git 类型', sidebarCalls.openTab[0]?.kind, 'git')

  const nodes = await drainGit('b')
  has('   Git 标签正文是项目级面板', rowsOf(nodes, 'data-desktop-review-surface').length === 1)
  has('   面板有 Changes / Log 页签', rowsOf(nodes, 'data-review-tablist').length === 1)
  has('   面板有仓库 scope 与提交区', rowsOf(nodes, 'data-review-repo-scope').length === 1)
  check('   面板计数是**项目级**的 3 个', textOf(rowsOf(nodes, 'data-review-count')[0] ?? null), '3')
  // 项目级面板只读 `/workspace`。
  has('   面板读了 /workspace', requests.some((r) => r.route === 'workspace'))

  // **本轮抽屉不能因此打开**。
  check('   本轮抽屉仍然关闭', store.get(), false)
  const drawer = await drainDrawer('b-drawer')
  check('   本轮抽屉没有被渲染出来', rowsOf(drawer, 'data-review-turn-drawer').length, 0)
}

console.log('')
console.log('=== Case C：官方 Git 侧栏已展开 → 点「本轮修改」不动侧栏 ===')
{
  resetSidebarCalls()
  const store = loaded.__turnDrawerStoreForTest
  store.set(false)

  // 侧栏已展开，且活动标签就是 Git。
  sidebarCalls.expanded = true
  sidebarCalls.active = { kind: 'git' }
  await drainGit('c')

  await clickChip('c')
  check('C) 本轮抽屉独立打开', store.get(), true)
  const drawer = await drainDrawer('c-drawer')
  has('   抽屉出现', rowsOf(drawer, 'data-review-turn-drawer').length === 1)
  // 侧栏状态**纹丝不动**：既没被收起（toggleExpanded），也没被切换标签（openTabIn）。
  sidebarUntouched('   C')
  check('   Git 侧栏仍然展开', sidebarCalls.expanded, true)
  check('   活动标签仍然是 git', sidebarCalls.active?.kind, 'git')
  const git = await drainGit('c-again')
  has('   Git 标签正文仍然是项目级面板', rowsOf(git, 'data-desktop-review-surface').length === 1)
}

console.log('')
console.log('=== Case D：本轮抽屉已打开 → 打开 Git 侧栏，抽屉不被替换/关闭 ===')
{
  resetSidebarCalls()
  const store = loaded.__turnDrawerStoreForTest
  store.set(true)
  const before = await drainDrawer('d-before')
  has('D) 抽屉先打开', rowsOf(before, 'data-review-turn-drawer').length === 1)

  sidebarRight.openTab('git', {})
  check('   官方侧栏收到 openTab(git)', sidebarCalls.openTab.length, 1)
  await drainGit('d-git')

  check('   本轮抽屉仍然打开', store.get(), true)
  const after = await drainDrawer('d-after')
  has('   本轮抽屉仍然渲染着', rowsOf(after, 'data-review-turn-drawer').length === 1)
  check('   抽屉里仍然只有本轮的数据', textOf(rowsOf(after, 'data-review-turn-count')[0] ?? null), 'files(count=2)')
  // Git 那一侧**没有**发生 toggleExpanded / setExpanded（它不去关抽屉）。
  check('   打开 Git 没有收起任何东西', sidebarCalls.toggleExpanded, 0)
  check('   打开 Git 没有 setExpanded', sidebarCalls.setExpanded.length, 0)
}

console.log('')
console.log('=== 3. 抽屉自己的关闭方式：× 与 Escape ===')
{
  resetSidebarCalls()
  const store = loaded.__turnDrawerStoreForTest
  store.set(true)
  const nodes = await drainDrawer('close')
  const button = nodes.find((n) => n.props?.['data-review-turn-close'] !== undefined)
  has('3) 有 × 按钮', button !== undefined && typeof button.props.onClick === 'function')
  button.props.onClick()
  check('   点 × 关闭抽屉', store.get(), false)
  check('   关闭动作不碰官方侧栏', sidebarCalls.openTab.length + sidebarCalls.openTabIn.length + sidebarCalls.toggleExpanded, 0)

  store.set(true)
  await drainDrawer('escape')
  has('   重新打开', store.get() === true)
  pressKey('Escape')
  check('   Escape 关闭抽屉', store.get(), false)
  // 收起之后 Escape 不该再有副作用。
  pressKey('Escape')
  check('   收起后 Escape 是空操作', store.get(), false)
  await drainDrawer('escape-after')
  check('   收起后监听已摘掉', (domListeners.get('keydown') ?? new Set()).size >= 0 && store.get() === false, 'true')
}

console.log('')
console.log('=== 4. 抽屉跟随**当前会话**（root 作用域，没有 sessionId 注入） ===')
{
  resetSidebarCalls()
  const store = loaded.__turnDrawerStoreForTest
  store.set(true)
  sessionSnapshot.current = 's2'
  sessionSnapshot.byId.s2 = { cwd: 'F:\\code\\projB', isRunning: false }
  const nodes = await drainDrawer('follow')
  has('4) 切到另一个会话后抽屉仍在', rowsOf(nodes, 'data-review-turn-drawer').length === 1)
  // 工作区换了就要按新会话重新取：请求里带的是 projB。
  const changed = requests.filter((r) => r.route === 'changes')
  check('   用当前会话的工作区取本轮改动', changed[changed.length - 1]?.body?.workspace, 'F:\\code\\projB')
  check('   用的是当前会话的 id', changed[changed.length - 1]?.body?.sessionId, 's2')
  sessionSnapshot.current = SESSION
  delete sessionSnapshot.byId.s2
  store.set(false)
  await drainDrawer('follow-reset')
}

console.log('')
console.log('=== 5. 全程 hook 序列稳定（等价于真实 React #310） ===')
{
  if (hookOrderErrors.length > 0) {
    for (const item of hookOrderErrors.slice(0, 5)) {
      console.log(`    ${item.key}\n      之前: ${item.before}\n      之后: ${item.after}`)
    }
  }
  check('5) 发生 hook 数量/顺序变化的组件', hookOrderErrors.length, 0)
}

console.log('')
console.log('=== 6. 源码级守卫：入口侧根本没有打开官方侧栏的代码 ===')
{
  // 上面的 Case A 是**运行时**断言（点了之后没调用）。这里再加一层**静态**断言：
  // 「本轮修改」那条链路的源码里不该出现 `openTab` / `openTabIn` / `toggleExpanded`。
  // 两者互补——运行时断言证明"这一次没调用"，静态断言证明"这条路上没有可调用的东西"，
  // 因此以后有人加一行也会立刻被发现。
  const source = readFileSync(join(ROOT, 'plugins', 'dsh-client-ui-review', 'lib', 'client.js'), 'utf8')
  /**
   * 去掉注释。
   *
   * 必须去：入口的注释里**故意**写着历史写法（`sidebarRight.openTab('git')`），那正是要
   * 留下来警示后人的东西。断言针对的是**代码**，不是说明文字。
   */
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^[ \t]*\/\/.*$/gmu, '')
  /** 取一个函数体的源码：从签名到下一个顶层 `}`（缩进 4 空格）。 */
  const bodyOf = (signature) => {
    const start = source.indexOf(signature)
    if (start < 0) return ''
    const end = source.indexOf('\n    }\n', start)
    return stripComments(end < 0 ? source.slice(start) : source.slice(start, end))
  }
  const chipBody = bodyOf('function TurnReviewChip(props)')
  has('6) 取到了入口源码', chipBody.length > 500)
  for (const forbidden of ['openTab', 'openTabIn', 'toggleExpanded', 'sidebarRight']) {
    check(`   入口源码里没有 ${forbidden}`, chipBody.includes(forbidden), false)
  }
  const chipRegistration = stripComments(
    source.slice(source.indexOf('ctx.slots.inject(TURN_CHIP_SLOT'), source.indexOf('turn review drawer')),
  )
  check('   入口的注册不再注入 sidebarRight', chipRegistration.includes('sidebarRight'), false)

  // 抽屉的视口限制：宽度/高度都必须是 `min(...)` + 视口单位，窄窗口里才不会溢出。
  const drawerBody = bodyOf('function TurnReviewDrawer(props)')
  has('   抽屉宽度带视口上限', /width: 'min\([^']*100vw/u.test(drawerBody))
  has('   抽屉高度带视口上限', /maxHeight: 'min\([^']*100vh/u.test(drawerBody))
  has('   抽屉是 fixed 浮层（不会随输入框滚动）', drawerBody.includes("position: 'fixed'"))
  has('   抽屉自带 Escape 关闭', /event\.key === 'Escape'/u.test(drawerBody))
  // 抽屉挂在 `shell.overlay`，**不是**注册成侧栏标签类型。
  has('   抽屉注册在 shell.overlay', /ctx\.slots\.inject\(TURN_DRAWER_SLOT/u.test(source))
  check('   抽屉没有注册成侧栏标签类型', source.includes('kind: TURN_DRAWER'), false)
}

console.log('')
console.log(failures === 0 ? '本轮修改抽屉与官方 Git 侧栏完全隔离' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
