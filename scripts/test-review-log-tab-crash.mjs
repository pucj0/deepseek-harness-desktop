// 验证"点 Log 页签之后整块抽屉（连右上角入口一起）消失"这个实机故障不再发生。
//
//   node scripts/test-review-log-tab-crash.mjs
//
// 为什么需要它：这个现象的**因果链**很容易被误判。点 Log 只做了一次 `setTab('log')`，
// 所以"抽屉与右上角入口同时消失"看起来像"面板被关掉了"（于是会去翻 panelStore）。实际
// 上它的形状是 **React 渲染期异常**：Log 页签里的提交图在渲染时读 host 数据的一个字段，
// 字段缺了就抛 TypeError；没有错误边界时 React 会把**抛错的那棵子树整个卸载**——入口组件
// `HeroChangesTrigger` 正是那棵子树的根，于是按钮和抽屉一起没了。
//
// 因此这个测试钉住四件事：
//   A. 正常数据下点 Log：图渲染、入口与抽屉都还在；
//   B. host 少给/给错字段（`parents`/`refs`/`short`/`committedAt`/`hash`）：**不崩**，
//      坏数据被规范化挡在渲染层之外，界面照常出图；
//   C. 图子树真的抛错：错误边界捕获，入口与抽屉**存活**，Log 页签显示可诊断的错误页，
//      并且"重新加载 Log"能恢复；
//   D. Log → Changes 切回来仍然工作，项目改动数量不变。
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PLUGIN = pathToFileURL(join(ROOT, 'plugins', 'dsh-client-ui-review', 'lib', 'client.js')).href

// ---- 假 React --------------------------------------------------------------------
//
// 与其它 review 测试的桩有三处**必须**的差别：
//   1. 提供 `Component` 基类 —— 真实插件里的错误边界是 `class extends react.Component`；
//   2. 支持类组件（`collectHostNodes` 里按 `prototype.isReactComponent` 识别）；
//   3. **模拟错误边界的语义**：渲染期异常由最近的类组件捕获、卸载抛错子树、渲染降级页。
//      真实 React 是这么做的，桩里不模拟的话"边界到底有没有接住"就无从断言。
const componentHooks = new Map()
const classInstances = new Map()
let hookSlots = []
let renderIndex = 0
let effectQueue = []

class FakeComponent {
  constructor(props) {
    this.props = props
  }

  setState(patch) {
    const next = typeof patch === 'function' ? patch(this.state) : patch
    this.state = { ...this.state, ...next }
  }
}
// 真实 React 用这个标记区分类组件与函数组件（`isReactComponent` 是空对象，判断取真值）。
FakeComponent.prototype.isReactComponent = {}

const react = {
  Component: FakeComponent,
  createElement(type, props, ...children) {
    const kids = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
    return { type, props: { ...(props ?? {}), children: kids } }
  },
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
    // deps 为 undefined 时一律重算（真实 React 的语义；桩里缓存过会拿到旧结果）。
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
    const prev = hookSlots[slot]
    const changed = prev === undefined || deps === undefined || prev.deps === undefined || deps.some((d, i) => !Object.is(d, prev.deps[i]))
    if (changed) {
      hookSlots[slot] = { deps }
      effectQueue.push(fn)
    }
  },
  useSyncExternalStore(subscribe, getSnapshot) {
    const slot = renderIndex++
    // 必须真的订阅（共享快照 store 是"第一个订阅者到来时才开始拉数据"）。
    const prev = hookSlots[slot]
    if (prev === undefined || prev.subscribe !== subscribe) {
      hookSlots[slot] = { subscribe, unsubscribe: subscribe(() => {}) }
    }
    return getSnapshot()
  },
}

/** 渲染一个函数组件：hook 槽按 key 归属，异常时也要把槽存回去。 */
function render(Comp, props, key) {
  const saved = { hookSlots, renderIndex, effectQueue }
  hookSlots = componentHooks.get(key) ?? []
  renderIndex = 0
  effectQueue = []
  let tree
  let effects
  try {
    tree = Comp(props)
  } finally {
    // 副作用必须在**恢复外层 effectQueue 之前**取出来：先恢复再取的话拿到的是外层那个
    // 空数组，表现为"所有组件都不跑副作用"（图永远停在加载中）。
    effects = effectQueue
    componentHooks.set(key, hookSlots)
    hookSlots = saved.hookSlots
    renderIndex = saved.renderIndex
    effectQueue = saved.effectQueue
  }
  return { tree, effects }
}

const isClassComponent = (type) =>
  typeof type === 'function' && type.prototype !== undefined && Boolean(type.prototype.isReactComponent)

/**
 * 收集宿主节点，展开函数组件与类组件（含错误边界语义）。
 *
 * @param node - 元素树。
 * @param queued - 收集到的副作用（不给就丢掉；需要"新挂载的组件真的去取数"时必须给）。
 * @param rootKey - 树的起点 key。**每次换一棵树都要换它**：组件实例（hook 槽、类实例）
 *   是按"起点 key + 树中位置"归属的，起点不变的话换一棵树也会拿到上一棵的 state——表现
 *   为"没发请求却已经有数据"。
 * @returns 宿主节点。
 */
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
      const name = type.name === '' ? 'anonymous' : type.name
      const keyed = current.props?.key === undefined ? `${path}:${name}` : `${path}:${name}#${String(current.props.key)}`
      if (isClassComponent(type)) {
        let instance = classInstances.get(keyed)
        if (instance === undefined) {
          instance = new type(current.props)
          classInstances.set(keyed, instance)
        }
        instance.props = current.props
        const isBoundary =
          typeof type.getDerivedStateFromError === 'function' || typeof instance.componentDidCatch === 'function'
        if (!isBoundary) {
          visit(instance.render(), keyed)
          return
        }
        try {
          visit(instance.render(), keyed)
        } catch (error) {
          // React 捕获渲染期异常时会**卸载**抛错的那棵子树。桩里必须把它的 hook 槽一起丢掉：
          // 否则"重新加载 Log"之后 useEffect 的依赖没变、副作用不会重跑，测试会误以为
          // 重试没生效（真实 React 是重新挂载，effect 一定会重跑）。
          for (const existing of [...componentHooks.keys()]) {
            if (existing.startsWith(`${keyed}.`) || existing.startsWith(`${keyed}:`)) componentHooks.delete(existing)
          }
          const derived = typeof type.getDerivedStateFromError === 'function' ? type.getDerivedStateFromError(error) : undefined
          if (derived !== undefined && derived !== null) instance.state = { ...instance.state, ...derived }
          if (typeof instance.componentDidCatch === 'function') {
            instance.componentDidCatch(error, { componentStack: `\n    in ${name}` })
          }
          // 再渲染一次：这一次走的是降级分支。
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
const storage = { 'dsh.review.panelOpen': '1' }
globalThis.document = {
  head: { appendChild() {} },
  body: { dataset: {} },
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
    getItem: (k) => storage[k] ?? null,
    setItem: (k, v) => {
      storage[k] = v
    },
    removeItem: (k) => {
      delete storage[k]
    },
  },
  addEventListener() {},
  removeEventListener() {},
  __ModuleLoader__: {
    load({ factory }) {
      loaded = factory((specifier) => (specifier === 'react' ? react : {}))
    },
  },
}
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

// ---- 假 host ---------------------------------------------------------------------
const WORKSPACE = 'F:\\code\\projA'
const CHANGES = {
  isRepo: true,
  scope: 'workspace',
  branch: 'main',
  head: 'a'.repeat(40),
  files: [
    { path: 'src/app.ts', status: 'M', added: 3, removed: 1, staged: true, unstaged: false, untracked: false },
    { path: 'docs/readme.md', status: 'A', added: 5, removed: 0, staged: false, unstaged: true, untracked: false },
  ],
  diff: 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
  truncated: false,
}
/** 一份**完全合法**的提交图：section A 的基线。 */
const GOOD_GRAPH = {
  isRepo: true,
  branch: 'main',
  hasMore: false,
  commits: [
    {
      hash: 'a'.repeat(40),
      short: 'aaaaaaa',
      parents: ['b'.repeat(40)],
      author: 'tester',
      email: 't@example.com',
      committedAt: '2026-01-02T09:30:00+08:00',
      subject: 'second commit',
      refs: [{ name: 'main', kind: 'branch', isHead: true }],
    },
    {
      hash: 'b'.repeat(40),
      short: 'bbbbbbb',
      parents: [],
      author: 'tester',
      email: 't@example.com',
      committedAt: '2026-01-01T09:30:00+08:00',
      subject: 'first commit',
      refs: [],
    },
  ],
}
/**
 * host 少给字段 / 给错类型的一份图（section B）。
 *
 * 每一条都对应一种**曾经会抛异常**的访问：
 *   * 缺 `parents` → `commit.parents.length`（TypeError）
 *   * `refs` 是字符串 → `refs.slice(0,3).map(...)`（map is not a function）
 *   * `committedAt` 是数字 → `.slice(0,10)`（slice is not a function）
 *   * 缺 `hash` → 行没有 key、点不动（规范化后直接丢弃）
 */
const MALFORMED_GRAPH = {
  isRepo: true,
  commits: [
    { hash: 'a'.repeat(40), subject: 'no parents, no refs' },
    {
      hash: 'b'.repeat(40),
      short: undefined,
      parents: 'not-an-array',
      refs: 'HEAD -> main, origin/main',
      author: 'tester',
      committedAt: 1736000000000,
      subject: 'refs is a raw %D string',
    },
    { short: 'nohash', parents: [], refs: [], subject: 'missing hash' },
    { hash: 'c'.repeat(40), short: 'ccccccc', parents: [], refs: [{ name: 'main', kind: 'branch', isHead: true }], committedAt: '2026-01-03T09:30:00+08:00', subject: 'valid row' },
  ],
  hasMore: false,
}

/** 第二页（section E 用它区分"新响应"与"旧响应"）：只有一条提交，哈希是 `e`。 */
const PAGE_TWO = {
  isRepo: true,
  branch: 'main',
  hasMore: false,
  commits: [
    {
      hash: 'e'.repeat(40),
      short: 'eeeeeee',
      parents: [],
      author: 'tester',
      email: 't@example.com',
      committedAt: '2026-01-09T09:30:00+08:00',
      subject: 'brand new commit',
      refs: [{ name: 'main', kind: 'branch', isHead: true }],
    },
  ],
}

let graphPayload = GOOD_GRAPH
/** 一条提交的详情（section B 会把它换成坏数据）。 */
let detailPayload = {
  isRepo: true,
  commit: { hash: 'a'.repeat(40), short: 'aaaaaaa', subject: 'second commit' },
  files: [{ path: 'src/app.ts', status: 'M', added: 3, removed: 1 }],
  containingBranches: ['main'],
}
/**
 * 把 `/graph` 的响应挂起（section E 用它制造"请求还在飞"的窗口）。
 *
 * 每个被挂起的请求都记住**自己发出时**的 `graphPayload`：这样才能区分"旧请求带回旧的一页"
 * 与"新请求带回新的一页"。
 */
let holdGraph = false
const heldGraph = []
const requests = []
globalThis.fetch = async (url, init) => {
  const target = String(url)
  const body = init?.body === undefined ? undefined : JSON.parse(init.body)
  requests.push({ url: target, body })
  const route = target.slice(target.indexOf('/dsh-desktop/review/') + '/dsh-desktop/review/'.length).split('?')[0]
  const payload =
    route === 'roots'
      ? { roots: [WORKSPACE], current: WORKSPACE }
      : route === 'graph'
        ? graphPayload
        : route === 'commit-detail'
          ? detailPayload
          : route === 'commit-file'
            ? { isRepo: true, diff: 'diff --git a/x b/x\n', truncated: false, binary: false }
            : CHANGES
  if (holdGraph && route === 'graph') {
    return await new Promise((resolve) => {
      heldGraph.push(() => resolve({ ok: true, text: async () => JSON.stringify(payload) }))
    })
  }
  return { ok: true, text: async () => JSON.stringify(payload) }
}

// ---- 加载并挂载插件 --------------------------------------------------------------
let loaded
await import(PLUGIN)

const entries = new Map()
const injectedFaces = new Map()
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
  sidebarRight: {},
  sidebarRightTabs: { register: () => () => {} },
  sessions: { list: {} },
  workspaces: { list: {} },
}
loaded.apply(ctx)

const HERO_KEY = 'shell.overlay:review-project-changes'
const Hero = entries.get(HERO_KEY)
const injected = injectedFaces.get(HERO_KEY)

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
const rowsOf = (nodes, attr) => nodes.filter((n) => n.props?.[attr] !== undefined)

const makeSelectorHook = (read) => (selector) =>
  react.useSyncExternalStore(
    () => () => {},
    () => selector(read()),
  )

const sessionSnapshot = { current: 's1', ids: ['s1'], byId: { s1: { cwd: WORKSPACE } } }
const workspaceSnapshot = { items: [{ workspaceId: 'w1', path: WORKSPACE, sessionIds: ['s1'] }] }

/**
 * 页签/文案函数。`tMode === 'throw'` 时在 `graphTitle` 上抛错——这是**注入渲染期异常**
 * 的手段：`graphTitle` 只被提交图的工具栏用到，正好落在错误边界内部。
 */
let tMode = 'normal'
const tCalls = []
const t = (key, params) => {
  tCalls.push({ key, params })
  if (tMode === 'throw' && key === 'graphTitle') throw new Error('注入的渲染期异常：读 graphTitle 失败')
  if (params === undefined) return key
  return Object.entries(params).reduce((text, [name, value]) => text.split(`{${name}}`).join(String(value)), key)
}

const props = { ...injected, t, useSessions: makeSelectorHook(() => sessionSnapshot), useWorkspaces: makeSelectorHook(() => workspaceSnapshot) }

// ---- 驱动抽屉 --------------------------------------------------------------------
let heroKey = ''
let heroSeq = 0
/**
 * 走到**槽位级隔离**的次数。
 *
 * 真实渲染器在槽位外面还有一层 `SlotErrorBoundary`（官方 `dsh-client-ui-renderer` 里
 * 就有）：插件入口渲染时抛错，它会把这个入口整个换成 `<div data-slot-error>`。这正是
 * "点 Log 之后抽屉与右上角入口一起消失"的**真实机制**——不是面板被关掉，而是入口被
 * 错误占位替换了。这里如实模拟它，让"没有错误边界时会怎样"可以被断言，而不是让测试
 * 直接崩掉。
 */
const slotErrors = []

/** 渲染一个组件树 + 展开整棵树 + 执行嵌套组件的副作用（重复到没有新副作用为止）。 */
async function drainView(Comp, compProps, key) {
  let nodes = []
  for (let pass = 0; pass < 8; pass += 1) {
    const queued = []
    try {
      const out = render(Comp, compProps, key)
      queued.push(...out.effects)
      nodes = collectHostNodes(out.tree, queued, key)
    } catch (error) {
      slotErrors.push(error)
      if (process.env.DSH_TEST_DEBUG === '1') console.log('    [drain] 入口渲染抛出：', error?.stack ?? String(error))
      return [{ type: 'div', props: { 'data-slot-error': typeof Comp === 'function' ? Comp.name : 'component', children: undefined } }]
    }
    if (process.env.DSH_TEST_DEBUG === '1') {
      console.log(`    [drain] key=${key} pass=${pass} queued=${queued.length} graph=${requests.filter((r) => r.url.includes('/graph')).length}`)
    }
    if (queued.length > 0) {
      for (const effect of queued) effect()
    }
    // **每一轮都要让出一个 tick**，即使这一轮没有副作用：被放行的请求是在微任务里继续
    // 跑完 then 链、再 setState 的，不让出事件循环就永远看到放行之前那一帧（表现为
    // "明明放行了，界面还是空的"）。
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (queued.length === 0) break
  }
  return nodes
}

/** 渲染项目级入口（右上角按钮 + 抽屉）。 */
async function drain() {
  return drainView(Hero, props, heroKey)
}

/** 打开抽屉：点右上角那个入口按钮（已经开着就不点，否则会把它关掉）。 */
async function openDrawer(label) {
  heroKey = `hero-${label}-${heroSeq++}`
  let nodes = await drain()
  if (nodes.some((n) => n.props?.['data-review-tablist'] !== undefined)) return true
  const trigger = nodes.find((n) => n.type === 'button' && n.props?.title === 'projectTitle')
  if (trigger === undefined) return false
  trigger.props.onClick()
  nodes = await drain()
  return nodes.some((n) => n.props?.['data-review-tablist'] !== undefined)
}

/** 在**当前**界面上找节点并点它。 */
async function clickNow(attr, value) {
  const nodes = await drain()
  const node = nodes.find((n) => (value === undefined ? n.props?.[attr] !== undefined : n.props?.[attr] === value))
  if (node === undefined || typeof node.props.onClick !== 'function') return false
  node.props.onClick()
  return true
}

// =================================================================================
console.log('=== 0. 规范化：host 的坏数据不许进渲染层 ===')
{
  const normalize = loaded.__graphNormalizeForTest
  has('0) 导出了规范化入口', typeof normalize?.commit === 'function')
  // 缺字段：全部补成渲染层假定的形状（数组/字符串）。
  const bare = normalize.commit({ hash: 'h' })
  check('   缺 parents → 数组', Array.isArray(bare.parents) && bare.parents.length, 0)
  check('   缺 refs → 数组', Array.isArray(bare.refs) && bare.refs.length, 0)
  check('   缺 short → 用哈希前缀', bare.short, 'h')
  check('   缺 subject → 空串', bare.subject, '')
  // 类型错：不是数组的一律丢弃，不是字符串的一律转字符串。
  const wrong = normalize.commit({ hash: 'h', short: 123, parents: 'not-an-array', refs: 'HEAD -> main', committedAt: 5, subject: null })
  check('   parents 不是数组 → 空数组', Array.isArray(wrong.parents) && wrong.parents.length, 0)
  check('   refs 是字符串 → 空数组', Array.isArray(wrong.refs) && wrong.refs.length, 0)
  check('   数字 short → 字符串', wrong.short, '123')
  check('   数字 committedAt → 字符串', wrong.committedAt, '5')
  check('   null subject → 空串', wrong.subject, '')
  // 没有 hash 的条目没法当 key、也点不动：直接丢弃。
  check('   没有 hash → 丢弃', normalize.commit({ subject: 'x' }), 'null')
  // 一页里混着坏数据时，坏的那条不影响好的那条。
  const page = normalize.page({ commits: [{ hash: 'a' }, null, { subject: 'no hash' }, 'nope'] })
  check('   整页规范化后只剩合法条目', page.commits.length, 1)
  check('   缺 commits → 空数组', normalize.page({}).commits.length, 0)
  // 详情：files / containingBranches 不是数组时不许直接进渲染层。
  const detail = normalize.detail({ commit: { hash: 'a' }, files: 'nope', containingBranches: null })
  check('   详情 files 不是数组 → 空数组', detail.files.length, 0)
  check('   详情 containingBranches 不是数组 → 空数组', detail.containingBranches.length, 0)
}

console.log('')
console.log('=== A. 正常数据：点 Log 之后图、抽屉、右上角入口都在 ===')
{
  graphPayload = GOOD_GRAPH
  has('A) 抽屉打开', await openDrawer('good'))
  has('   点得中 Log 页签', await clickNow('data-review-tab', 'log'))
  const nodes = await drain()
  has('   图渲染出来', rowsOf(nodes, 'data-graph-view').length === 1)
  check('   两条提交各一行', rowsOf(nodes, 'data-graph-row').length, 2)
  has('   没有错误页', rowsOf(nodes, 'data-graph-error').length === 0)
  has('   右上角入口还在', rowsOf(nodes, 'data-review-trigger').length === 1)
  has('   页签栏还在（抽屉没被带走）', rowsOf(nodes, 'data-review-tablist').length === 1)
  check('   没有走到槽位级隔离', slotErrors.length, 0)
}

console.log('')
console.log('=== B. host 少给/给错字段：不崩，坏数据被挡在渲染层之外 ===')
{
  graphPayload = MALFORMED_GRAPH
  delete globalThis.window.__dshDesktopReviewLogError
  has('B) 抽屉打开', await openDrawer('malformed'))
  has('   点得中 Log 页签', await clickNow('data-review-tab', 'log'))
  const nodes = await drain()
  // **核心断言**：没有崩溃、也没有错误页——规范化之后这些数据是"缺字段但有默认值"的正常数据。
  has('   没有渲染期异常记录', globalThis.window.__dshDesktopReviewLogError === undefined)
  has('   没有错误页', rowsOf(nodes, 'data-graph-error').length === 0)
  has('   图照常渲染', rowsOf(nodes, 'data-graph-view').length === 1)
  // 三条带 hash 的提交留下；没有 hash 的那条被丢弃。
  if (process.env.DSH_TEST_DEBUG === '1') {
    console.log('  [debug] 图行 =', rowsOf(nodes, 'data-graph-row').map((n) => String(n.props['data-graph-row']).slice(0, 6)).join(','))
    console.log('  [debug] 图请求数 =', requests.filter((r) => r.url.includes('/graph')).length)
  }
  check('   坏数据不影响好数据（3 行）', rowsOf(nodes, 'data-graph-row').length, 3)
  has('   右上角入口还在', rowsOf(nodes, 'data-review-trigger').length === 1)
  has('   页签栏还在', rowsOf(nodes, 'data-review-tablist').length === 1)
  // 缺 parents 的那条不该画出"向下的线"：根提交的判断不能因为字段缺失而崩。
  has('   缺 parents 的提交也能画出泳道', rowsOf(nodes, 'data-graph-edge').length > 0)
  check('   图这一段没走到槽位级隔离', slotErrors.length, 0)

  // 详情同样是 host 数据：`files` 不是数组时，渲染层的 `files.length` / `files.map` 会崩。
  // 这一段专门钉住"规范化必须作用在**取数处**"，而不只是存在一个能用的纯函数。
  detailPayload = { isRepo: true, commit: { hash: 'a'.repeat(40) }, files: 'nope', containingBranches: 'main' }
  has('   点得中一条提交', await clickNow('data-graph-row', 'a'.repeat(40)))
  const detailNodes = await drain()
  has('   详情坏数据也不崩', globalThis.window.__dshDesktopReviewLogError === undefined)
  has('   没有错误页', rowsOf(detailNodes, 'data-graph-error').length === 0)
  has('   详情栏渲染出来', rowsOf(detailNodes, 'data-graph-detail').length === 1)
  has('   文件列表为空而不是崩掉', rowsOf(detailNodes, 'data-graph-files').length === 1)
  check('   文件数为 0', textOf(rowsOf(detailNodes, 'data-graph-file-count')[0] ?? null), 'graphFiles')
  has('   右上角入口还在', rowsOf(detailNodes, 'data-review-trigger').length === 1)
  has('   页签栏还在', rowsOf(detailNodes, 'data-review-tablist').length === 1)
  check('   详情这段也没走到槽位级隔离', slotErrors.length, 0)
  detailPayload = { isRepo: true, commit: { hash: 'a'.repeat(40), short: 'aaaaaaa' }, files: [], containingBranches: ['main'] }
}

console.log('')
console.log('=== C. 图子树真的抛错：边界接住，入口与抽屉存活 ===')
// 注意：本节会**故意**在渲染期抛一个异常，因此 stderr 上那条 `[dsh-review:log] 提交图渲染失败`
// 是本节的预期输出（它正是排查时要看的那条记录），不是测试失败。
{
  graphPayload = GOOD_GRAPH
  has('C) 抽屉打开', await openDrawer('crash'))
  has('   点得中 Log 页签', await clickNow('data-review-tab', 'log'))
  // 正常先渲染一次（确认基线），再让 `t` 在图渲染时抛错。
  await drain()
  tMode = 'throw'
  const crashed = await drain()
  has('   出现降级页', rowsOf(crashed, 'data-graph-error').length === 1)
  has('   图本身不再渲染', rowsOf(crashed, 'data-graph-view').length === 0)
  // 这三条是这次修复的**核心**：崩溃只能降级 Log 页签，不许带走抽屉与右上角入口。
  has('   右上角入口存活', rowsOf(crashed, 'data-review-trigger').length === 1)
  has('   页签栏存活', rowsOf(crashed, 'data-review-tablist').length === 1)
  has('   抽屉外壳存活', rowsOf(crashed, 'data-review-resizer').length === 1)
  // 最能说明"这不是面板被关掉"的一条：**整块入口没有被槽位级隔离换掉**。
  check('   没有走到槽位级隔离（入口还在原位）', slotErrors.length, 0)
  // 诊断信息：界面、console（`window` 上的记录）、组件名与字段都要有。
  const detail = textOf(rowsOf(crashed, 'data-graph-error-detail')[0] ?? null)
  has('   错误页带异常原文', detail.includes('注入的渲染期异常'))
  has('   错误页带组件栈', detail.includes('LogErrorBoundary'))
  const recorded = globalThis.window.__dshDesktopReviewLogError
  has('   异常被记录到 window 上', recorded !== undefined && recorded !== null)
  check('   记录带作用域', recorded?.scope, 'dsh-client-ui-review:log')
  check('   记录带工作区', recorded?.workspace, WORKSPACE)
  has('   记录带消息', String(recorded?.message ?? '').includes('注入的渲染期异常'))
  has('   记录带组件栈', String(recorded?.componentStack ?? '').includes('LogErrorBoundary'))
  // 修好之后点"重新加载 Log"：图回来、降级页消失，入口仍然在。
  tMode = 'normal'
  has('   点得中"重新加载 Log"', await clickNow('data-graph-error-retry'))
  const retried = await drain()
  has('   降级页消失', rowsOf(retried, 'data-graph-error').length === 0)
  has('   图回来了', rowsOf(retried, 'data-graph-view').length === 1)
  check('   重试后重新拉了图', rowsOf(retried, 'data-graph-row').length, 2)
  has('   右上角入口仍在', rowsOf(retried, 'data-review-trigger').length === 1)
  has('   重试计数已递增', rowsOf(retried, 'data-log-retry')[0]?.props?.['data-log-retry'] === '1')
}

console.log('')
console.log('=== D. Log → Changes：切回来照常工作，改动数量不变 ===')
{
  graphPayload = GOOD_GRAPH
  has('D) 抽屉打开', await openDrawer('switch'))
  has('   切到 Log', await clickNow('data-review-tab', 'log'))
  await drain()
  has('   入口与抽屉都在', (await drain()).some((n) => n.props?.['data-review-trigger'] !== undefined))
  has('   切回 Changes', await clickNow('data-review-tab', 'changes'))
  const nodes = await drain()
  has('   暂存/提交区块回来了', rowsOf(nodes, 'data-staging').length === 1)
  has('   提交卡片回来了', rowsOf(nodes, 'data-staging-commit-card').length === 1)
  has('   图不再渲染', rowsOf(nodes, 'data-graph-view').length === 0)
  has('   没有错误页', rowsOf(nodes, 'data-graph-error').length === 0)
  has('   右上角入口仍在', rowsOf(nodes, 'data-review-trigger').length === 1)
  // 头栏计数与列表来自同一份快照：切页签不该改变它。
  const counts = rowsOf(nodes, 'data-review-count').map((n) => textOf(n))
  has('   项目改动数量等于文件数', counts.includes(String(CHANGES.files.length)))
  check('   这一段也没走到槽位级隔离', slotErrors.length, 0)
}

console.log('')
console.log('=== E. 提交后刷新：不许被合并到提交之前那个在途请求上 ===')
//
// 这是同一类"异步交错"里的另一条：`refreshToken` 变化代表"外部事件要求重拉一页"
// （提交成功 / 暂存后刷新）。如果它被合并进**提交之前**发出的那个 `/graph`，用户会看到
// "提交成功了，但历史里没有刚才那条提交"——而提交图不轮询，界面会一直停在旧历史上。
{
  graphPayload = GOOD_GRAPH
  holdGraph = true
  heldGraph.length = 0
  const View = loaded.__commitGraphViewForTest
  const before = requests.filter((r) => r.url.includes('/graph')).length
  const viewProps = { t, workspace: WORKSPACE, refreshToken: 0 }
  await drainView(View, viewProps, 'view-E')
  check('E) 第一页请求已发出（挂起中）', requests.filter((r) => r.url.includes('/graph')).length - before, 1)
  // 提交成功：refreshToken 变化。此时把"新的一页"准备好，新请求会带回它。
  graphPayload = PAGE_TWO
  await drainView(View, { ...viewProps, refreshToken: 1 }, 'view-E')
  check('   刷新发出了**第二个**请求（没有被合并）', requests.filter((r) => r.url.includes('/graph')).length - before, 2)
  // 先放行新的、再放行旧的：旧响应属于被抢占的那一次，必须被丢弃。
  heldGraph[1]()
  await drainView(View, { ...viewProps, refreshToken: 1 }, 'view-E')
  heldGraph[0]()
  const nodes = await drainView(View, { ...viewProps, refreshToken: 1 }, 'view-E')
  const rows = rowsOf(nodes, 'data-graph-row').map((n) => String(n.props['data-graph-row']).slice(0, 4))
  check('   界面上是新的那一页', rows.join(','), 'eeee')
  has('   旧响应没有覆盖新的一页', rows.includes('aaaa') === false)
  holdGraph = false
  graphPayload = GOOD_GRAPH
}

console.log('')
console.log(failures === 0 ? 'Log 页签崩溃回归全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
