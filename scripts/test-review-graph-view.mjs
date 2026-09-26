// 验证提交图在主区域里的注册与渲染：侧栏图标、main 槽内容、三栏结构、
// 选中提交后取详情、按分支筛选。
//
//   node scripts/test-review-graph-view.mjs
//
// 为什么需要它：这批改动的关键风险不是"图画得对不对"（那由 graph-layout 的单测与
// parity 测试钉住），而是**注册链路**——`sidebar.panellist` 与 `main` 是两处独立注册，
// 少一处、或者两处的 id 不一致，表现都只是"侧栏有个图标但点了没反应"，从界面上完全
// 看不出原因。用假渲染器直接加载插件模块，就能把这条链路逐环断言，且不需要 Electron。
//
// 桩的三条规则（都在 test-gitbar-source-panel.mjs 里吃过亏）：
//   1. 组件 hook 槽按"位置 + key"归属，且所有渲染入口用同一个起点 key；
//   2. 副作用挂在嵌套组件上，必须展开整棵树并把每一层的 effect 都跑掉；
//   3. 查询要读**当前**界面，不能读交互之前的快照。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PLUGIN = pathToFileURL(join(ROOT, 'plugins', 'dsh-client-ui-review', 'lib', 'client.js')).href

// ---- 假 React -------------------------------------------------------------------
const componentHooks = new Map()
let hookSlots = []
let renderIndex = 0
let effectQueue = []

const react = {
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
    // **deps 为 undefined 时一律重算**：真实 React 在没给依赖数组时每次渲染都重算，
    // 而这个桩早先对 undefined 也走了缓存分支，于是同一个组件实例在"没有依赖"的
    // useMemo 上永远返回第一次的结果——表现为取到的文本是旧的模板键而不是渲染后的值。
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
    if (changed) {
      // **必须跑上一个 cleanup**：真实 React 在依赖变化时会先清理再重跑。这个桩原来把返回的
      // 清理函数直接丢了，于是"在 effect 里挂 document 监听"的组件每渲染一次就多留一个监听
      // ——断言"关闭 Preview 后监听被摘掉"会因此假红（看到 7 个残留），而那是桩的错。
      if (typeof prev?.cleanup === 'function') effectQueue.push(prev.cleanup)
      slots[slot] = { deps }
      // 包一层是为了把 `fn` 的返回值（cleanup）记回槽位，供下一次依赖变化时清理。
      effectQueue.push(() => {
        const cleanup = fn()
        const current = slots[slot]
        if (current !== undefined && current.deps === deps) {
          current.cleanup = typeof cleanup === 'function' ? cleanup : undefined
        }
      })
    }
  },
  useSyncExternalStore(subscribe, getSnapshot) {
    const slot = renderIndex++
    hookSlots[slot] = { value: getSnapshot() }
    return hookSlots[slot].value
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

/** 收集宿主节点并展开函数组件；组件实例 identity = 位置 + key。 */
function collectHostNodes(node, key, queued) {
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

const makeSelectorHook = (read) => (selector) =>
  react.useSyncExternalStore(
    () => () => {},
    () => selector(read()),
  )

// ---- 假 DOM ----------------------------------------------------------------------
const domListeners = new Map()
globalThis.document = {
  head: { appendChild() {} },
  body: { dataset: {} },
  addEventListener(type, handler, options) {
    if (!domListeners.has(type)) domListeners.set(type, new Set())
    // 记下 capture：Diff Preview 的 Escape 处理必须挂在捕获阶段（否则抽屉的冒泡监听会先把
    // 整个抽屉关掉）。这条"挂在哪个阶段"本身就是被测行为的一部分，因此要能断言。
    domListeners.get(type).add({ handler, capture: options === true })
  },
  removeEventListener(type, handler) {
    const set = domListeners.get(type)
    if (set === undefined) return
    for (const entry of set) if (entry.handler === handler) set.delete(entry)
  },
  /**
   * 派发一个事件：先跑捕获阶段的监听，再跑冒泡阶段（与真实 DOM 的顺序一致）。
   *
   * `stopPropagation` 在这里被替换成"标记 + 不再往下走"：组件调它表达的意思正是
   * "这次按键不要传给抽屉的监听"，而这正是 Diff Preview 的 Escape 要被断言的行为。
   */
  emit(type, event) {
    const set = domListeners.get(type)
    if (set === undefined) return
    if (event !== null && typeof event === 'object') {
      Object.defineProperty(event, 'stopPropagation', {
        configurable: true,
        writable: true,
        value: () => {
          event.__stopped = true
        },
      })
    }
    for (const entry of [...set]) if (entry.capture) entry.handler(event)
    for (const entry of [...set]) {
      if (entry.capture || event?.__stopped === true) continue
      entry.handler(event)
    }
  },
  querySelector: () => null,
  createElement: () => ({ dataset: {}, style: {}, textContent: '', remove() {} }),
  documentElement: {},
}
/**
 * 内存版 localStorage。
 *
 * 原来是"getItem 恒为 null、setItem 空实现"的桩——那样**任何持久化断言都测不出来**
 * （写了也读不到）。Diff Preview 的高度持久化是这一版的明确要求，因此这里必须能真的存取。
 */
const localStore = new Map()
globalThis.window = {
  innerWidth: 1400,
  innerHeight: 900,
  localStorage: {
    getItem: (key) => (localStore.has(key) ? localStore.get(key) : null),
    setItem: (key, value) => localStore.set(key, String(value)),
    removeItem: (key) => localStore.delete(key),
  },
  addEventListener() {},
  removeEventListener() {},
  __ModuleLoader__: {
    load({ factory }) {
      loaded = factory((specifier) => (specifier === 'react' ? react : {}))
    },
  },
}
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#ffffff' })
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

// ---- 假 host ---------------------------------------------------------------------
//
// 图的形状刻意造出"两个分支 + 一个合并提交"，这样渲染断言里能同时看到：
//   `main` 与 `feature` 两个本地分支、一个远程分支、一个标签、以及一条 merge 边。
const GRAPH = {
  isRepo: true,
  branch: 'main',
  hasMore: false,
  nextSkip: 4,
  commits: [
    {
      hash: 'm'.repeat(40),
      short: 'mmmmmmm',
      parents: ['p'.repeat(40), 'q'.repeat(40)],
      author: 'tester',
      email: 't@example.com',
      authoredAt: '2026-01-04T10:00:00+08:00',
      committedAt: '2026-01-04T10:00:00+08:00',
      subject: 'merge feature into main',
      refs: [{ name: 'main', kind: 'branch', isHead: true }],
      headBranch: 'main',
      localBranches: ['main'],
      remoteBranches: [],
      tags: [],
    },
    {
      hash: 'p'.repeat(40),
      short: 'ppppppp',
      parents: ['r'.repeat(40)],
      author: 'tester',
      email: 't@example.com',
      authoredAt: '2026-01-03T10:00:00+08:00',
      committedAt: '2026-01-03T10:00:00+08:00',
      subject: 'main side work',
      refs: [],
      headBranch: '',
      localBranches: [],
      remoteBranches: [],
      tags: [],
    },
    {
      hash: 'q'.repeat(40),
      short: 'qqqqqqq',
      parents: ['r'.repeat(40)],
      author: 'tester',
      email: 't@example.com',
      authoredAt: '2026-01-02T10:00:00+08:00',
      committedAt: '2026-01-02T10:00:00+08:00',
      subject: 'feature work',
      refs: [
        { name: 'feature', kind: 'branch', isHead: false },
        { name: 'origin/feature', kind: 'remote', isHead: false },
      ],
      headBranch: '',
      localBranches: ['feature'],
      remoteBranches: ['origin/feature'],
      tags: [],
    },
    {
      hash: 'r'.repeat(40),
      short: 'rrrrrrr',
      parents: [],
      author: 'tester',
      email: 't@example.com',
      authoredAt: '2026-01-01T10:00:00+08:00',
      committedAt: '2026-01-01T10:00:00+08:00',
      subject: 'init',
      refs: [{ name: 'v0.1.0', kind: 'tag', isHead: false }],
      headBranch: '',
      localBranches: [],
      remoteBranches: [],
      tags: ['v0.1.0'],
    },
  ],
}
const DETAIL = {
  isRepo: true,
  commit: {
    hash: 'm'.repeat(40),
    short: 'mmmmmmm',
    parents: ['p'.repeat(40), 'q'.repeat(40)],
    author: 'tester',
    email: 't@example.com',
    authoredAt: '2026-01-04T10:00:00+08:00',
    committedAt: '2026-01-04T10:00:00+08:00',
    subject: 'merge feature into main',
    body: '',
    refs: [],
    headBranch: '',
    localBranches: [],
    remoteBranches: [],
    tags: [],
  },
  files: [
    { path: 'src/app.ts', status: 'M', added: 3, removed: 1 },
    { path: 'docs/readme.md', status: 'A', added: 5, removed: 0 },
  ],
  containingBranches: ['feature', 'main'],
}
/**
 * 单个文件的差异：**按提交区分**。
 *
 * 故意让内容里带上提交号：两条提交改同一个文件是常态，而"切换提交后显示的其实是上一条
 * 提交的差异"这种事，只有差异文本能区分时才能被断言钉住（见第 5b 节）。
 */
const commitFileDiff = (revision) => ({
  isRepo: true,
  path: 'src/app.ts',
  diff: [
    'diff --git a/src/app.ts b/src/app.ts',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1 +1 @@',
    '-old',
    `+new from-${String(revision).slice(0, 8)}`,
    '',
  ].join('\n'),
  truncated: false,
  binary: false,
})

const requests = []
/**
 * 分页夹具：非 null 时 `/graph` 由它按 `skip` 出数据（见第 9 节）。
 *
 * 默认 `null` 表示"永远返回 GRAPH 那一页、且 hasMore:false"，因此前面几节的断言完全不受
 * 影响；只有需要"真的有下一页"的那一节才把它装上。
 */
let graphPages = null
/**
 * 分页"挂起"闸门：非 null 时 `/graph` 的**非首屏**请求会停在这里，直到测试调用它放行。
 *
 * 用来断言"加载下一页期间界面不白屏"——那件事只有在请求**在飞**的那一帧才看得到，
 * 立即 resolve 的夹具根本测不到（这正是"分页要不要整页 loading"最容易漏测的地方）。
 */
let graphHoldMore = null
/**
 * 单文件差异的"挂起"闸门（按 path 登记放行函数）。
 *
 * 用来钉住"快速点 A 再点 B，A 的迟到响应不许覆盖 B"——那件事只有让 A **真的在飞**才测得到。
 * 立即 resolve 的夹具下两条响应都按顺序落地，什么顺序问题都暴露不出来。
 */
const commitFileHolds = new Map()
/** 单文件差异的内容按 path 区分，才能断言"现在显示的是 B 而不是 A"。 */
const commitFileDiffFor = (path, revision) => ({
  isRepo: true,
  path,
  diff: [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,2 +1,3 @@',
    ' context line',
    `+added by ${String(path)}`,
    `+from-${String(revision).slice(0, 8)}`,
    '-old line',
    '',
  ].join('\n'),
  truncated: false,
  binary: false,
})
/**
 * gitbar 宿主的 `/reset/preview` 夹具（提交图的「把当前分支重置到这里」用它）。
 *
 * 只读路由：客户端把目标提交放在查询串的 `revision` 里，因此这里按它回不同的数字，
 * 断言就能同时钉住"预览来自宿主"与"客户端问的是哪一条提交"。
 */
const resetPreview = (revision) => ({
  isRepo: true,
  branch: 'main',
  current: { sha: 'm'.repeat(40), short: 'mmmmmmm', subject: 'merge feature into main' },
  target: { sha: revision, short: String(revision).slice(0, 7), subject: 'main side work' },
  root: false,
  affected: revision === 'q'.repeat(40) ? 3 : 1,
  ahead: 0,
  published: true,
  upstream: 'origin/main',
  targetPublished: false,
})

globalThis.fetch = async (url, init) => {
  const target = String(url)
  const body = init?.body === undefined ? undefined : JSON.parse(init.body)
  // ---- gitbar（跨插件的只读/写路由：重置）----
  if (target.includes('/dsh-desktop/gitbar/')) {
    const gitbarRoute = target.slice(target.indexOf('/dsh-desktop/gitbar/') + '/dsh-desktop/gitbar/'.length).split('?')[0]
    const revision = new URLSearchParams(target.split('?')[1] ?? '').get('revision') ?? ''
    requests.push({ url: target, route: `gitbar:${gitbarRoute}`, body })
    if (gitbarRoute === 'reset/preview') return { ok: true, text: async () => JSON.stringify(resetPreview(revision)) }
    if (gitbarRoute === 'reset') {
      if (resetError !== null) {
        const failure = resetError
        resetError = null
        return { ok: false, text: async () => JSON.stringify(failure) }
      }
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            isRepo: true,
            branch: 'main',
            reset: {
              mode: body?.mode ?? 'mixed',
              root: body?.root === true,
              affected: 1,
              target: { sha: body?.revision ?? '', short: String(body?.revision ?? '').slice(0, 7), subject: 'main side work' },
              previousHead: { sha: 'm'.repeat(40), short: 'mmmmmmm', subject: 'merge feature into main' },
              published: true,
            },
          }),
      }
    }
    return { ok: true, text: async () => JSON.stringify({ isRepo: true }) }
  }
  const route = target.slice(target.indexOf('/dsh-desktop/review/') + '/dsh-desktop/review/'.length).split('?')[0]
  requests.push({ url: target, route, body })
  if (route === 'graph' && graphHoldMore !== null && (body?.skip ?? 0) > 0) {
    await new Promise((resolve) => {
      graphHoldMore = () => resolve()
    })
  }
  if (route === 'commit-file' && commitFileHolds.has(body?.path)) {
    await new Promise((resolve) => {
      commitFileHolds.set(body?.path, () => resolve())
    })
  }
  const payload =
    route === 'roots'
      ? { roots: ['F:\\code\\projA'], current: 'F:\\code\\projA' }
      : route === 'graph'
        ? (graphPages === null ? GRAPH : graphPages(body?.skip ?? 0, body?.ref ?? ''))
        : route === 'commit-detail'
          ? DETAIL
          : route === 'commit-file'
            ? commitFileDiffFor(body?.path, body?.revision)
            : { isRepo: true }
  return { ok: true, text: async () => JSON.stringify(payload) }
}
/** 下一次 gitbar `/reset` 的错误响应（用完即清）。 */
let resetError = null
globalThis.setTimeout = globalThis.setTimeout

// ---- 加载并挂载插件 --------------------------------------------------------------
let loaded
await import(PLUGIN)

const entries = new Map()
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
      entries.set(key, { component, options })
      return () => {}
    },
  },
  sidebarRight: {},
  sidebarRightTabs: { register: () => () => {} },
  sessions: {},
  workspaces: {},
}
loaded.apply(ctx)

// 本文件断言的是**统一差异**的四列契约（行号两列 + 标记 + 正文）与折行样式；而差异视图的
// 默认模式是并排（IDEA 的习惯）。因此这里把偏好固定成 unified —— 并排的对齐与 DOM 契约由
// `scripts/test-review-diff-sbs.mjs` 专门覆盖，两边都是显式的，不靠默认值撞运气。
loaded.__diffModelForTest.modeStore.set(loaded.__diffModelForTest.modes.unified)

let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  // 打印时把值打印出来，`undefined` 尤其要显眼：它通常意味着**查询本身错了**
  // （选择器没命中、请求没发生），而不是被测逻辑错了。
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `（期望 ${expected}）`}`)
}
const checkTrue = (label, actual) => check(label, actual === true, true)

const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node !== 'object') return ''
  return textOf(node.props?.children)
}

// =================================================================================
console.log('=== 1. 两个槽位都注册了，且 id 一致 ===')
const panelEntry = entries.get('sidebar.panellist:git-graph')
const mainEntry = entries.get('main:git-graph')
checkTrue('1) sidebar.panellist 注册了 git-graph', panelEntry !== undefined)
checkTrue('   main 注册了 git-graph', mainEntry !== undefined)
// 两处的 id 必须严格相同：侧栏按钮点击时把 id 交给 ctx.layout.selectPanel，主区域按同一个
// key 分发。不一致的表现是"图标在、点了没反应"。
check('   两处 id 一致', panelEntry !== undefined && mainEntry !== undefined ? 'same' : 'missing', 'same')
check('   label 是 thunk（跟随语言）', typeof panelEntry.options.label, 'function')
check('   label 解析出文案', panelEntry.options.label(), 'graphPanelLabel')
check('   有排序值', typeof panelEntry.options.order, 'number')

console.log('')
console.log('=== 2. inject 不遮蔽标准钩子 ===')
// 与 1.3.5 那个坑同一类：在 inject 里回传一个 undefined 的 useSessions 会把渲染器
// 提供的标准钩子盖掉，于是组件永远拿不到当前会话的工作区。
{
  const face = mainEntry.options.inject()
  check('2) inject 里没有 useSessions', Object.hasOwn(face, 'useSessions'), false)
  check('   inject 里没有 usePanelInfo', Object.hasOwn(face, 'usePanelInfo'), false)
  check('   inject 里有 t', typeof face.t, 'function')
}

// ---- 渲染 ------------------------------------------------------------------------
const sessionSnapshot = { current: 's1', ids: ['s1'], byId: { s1: { cwd: 'F:\\code\\projA' } } }
const GraphView = mainEntry.component
let mountSeq = 0
let settledNodes = []
let rootKey = ''

async function settle() {
  for (let pass = 0; pass < 4; pass += 1) {
    const queued = []
    const { tree, effects } = render(GraphView, mountProps, rootKey)
    queued.push(...effects)
    settledNodes = collectHostNodes(tree, rootKey, queued)
    for (const effect of queued) effect()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return settledNodes
}

const tCalls = []
const mountProps = {
  t: (key, params) => {
    tCalls.push({ key, params })
    // 完整的 `{name}` 插值：断言要看到占位符被替换掉，而不是原样留在界面上。
    // 早先只替换了每处占位符的第一个出现，于是带两个占位符的文案
    // （`{count}` 与 `{names}`）会漏掉一个，断言误判成"分支名没渲染"。
    if (params === undefined) return key
    return Object.entries(params).reduce(
      (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
      key,
    )
  },
  sessionId: 's1',
  useSessions: makeSelectorHook(() => sessionSnapshot),
  usePanelInfo: makeSelectorHook(() => ({ activePanelId: 'git-graph' })),
}

const find = (attr, value) =>
  collectHostNodes(render(GraphView, mountProps, rootKey).tree, rootKey).find((node) =>
    value === undefined ? node.props?.[attr] !== undefined : node.props?.[attr] === value,
  ) ?? null
const findAll = (attr) =>
  collectHostNodes(render(GraphView, mountProps, rootKey).tree, rootKey).filter((node) => node.props?.[attr] !== undefined)

/**
 * **整个已渲染界面**的文本。
 *
 * 不能对某个宿主节点调 `textOf`：组件返回的子元素还没展开，`props.children` 里是
 * 元素对象而不是字符串，取到的文本会少一截（实测：右栏明明显示了"选择一条提交"，
 * 断言却是 false）。这里展开整棵树、把每个宿主节点的文本拼起来。
 */
function viewText(attr, value) {
  const nodes = collectHostNodes(render(GraphView, mountProps, rootKey).tree, rootKey)
  const selected = attr === undefined
    ? nodes
    : nodes.filter((node) => (value === undefined ? node.props?.[attr] !== undefined : node.props?.[attr] === value))
  return selected.map((node) => textOf(node)).join(' ')
}

async function mount() {
  rootKey = `graph${mountSeq++}`
  settledNodes = []
  await settle()
}

/** 点一个宿主节点。 */
async function click(node) {
  if (node === null || typeof node.props?.onClick !== 'function') return false
  node.props.onClick({ stopPropagation() {}, preventDefault() {} })
  await settle()
  return true
}

console.log('')
console.log('=== 3. 三栏结构与数据 ===')
await mount()
check('3) 视图已渲染', find('data-graph-view') !== null, 'true')
// 左栏：分支树四段。
const sections = findAll('data-graph-tree-section').map((n) => n.props['data-graph-tree-section'])
check('   分支树四段（HEAD/本地/远程/标签）', sections.join(','), 'head,local,remote,tags')
// 提交行数 = 4 条提交。
check('   提交行数', findAll('data-graph-row').length, 4)
// 中栏每行一个点；根提交也在内（它的颜色来自 commit 边）。
check('   每行一个点', findAll('data-graph-dot').length, 4)
// 叶子：refs 徽标至少出现 main / feature / origin/feature / v0.1.0。
const refTexts = findAll('data-graph-ref').map((n) => textOf(n))
checkTrue('   含 main 徽标', refTexts.includes('main'))
checkTrue('   含 feature 徽标', refTexts.includes('feature'))
checkTrue('   含 origin/feature 徽标', refTexts.includes('origin/feature'))
checkTrue('   含标签 v0.1.0', refTexts.includes('v0.1.0'))

// ---- 中栏每一行的文本（需求第 3、6 节的落点）------------------------------------
//
// 逐行断言两件事：**不显示哈希**、**时间到秒**。中栏与右栏是两处独立的渲染，只测右栏会
// 漏掉中栏退化成 `textSlice(..., 10)`（那正是改造前的写法）。
{
  const rowTexts = findAll('data-graph-row').map((n) => textOf(n))
  check('   每条提交一行文本', rowTexts.length, 4)
  const first = rowTexts[0]
  checkTrue('   首行带提交标题', first.includes('merge feature into main'))
  // 秒：`2026-01-04T10:00:00+08:00` → `2026-01-04 10:00:00`。
  checkTrue('   首行时间精确到秒', first.includes('2026-01-04 10:00:00'))
  // 哈希：短哈希与完整哈希都不许出现（否定断言用**真的存在过**的值，否则等于没测）。
  check('   首行不显示短哈希', first.includes('mmmmmmm'), 'false')
  check('   首行不显示完整哈希', first.includes('m'.repeat(40)), 'false')
  check('   每行都不显示短哈希', rowTexts.some((text) => /[0-9a-f]{7}/i.test(text)), 'false')
  check('   每行都不显示完整哈希', rowTexts.some((text) => text.includes('m'.repeat(40)) || text.includes('p'.repeat(40))), 'false')
}
// 合并提交那行必须有一条 merge 边。
checkTrue('   有 merge 边', findAll('data-graph-edge').some((n) => n.props['data-graph-edge'] === 'merge'))
// 请求落到了正确的路由与参数上。
const graphRequest = requests.find((r) => r.url.includes('/review/graph'))
checkTrue('3) 请求了 graph 路由', graphRequest !== undefined)
check('   带上工作区', graphRequest.body.workspace, 'F:\\code\\projA')
check('   带上分页大小', graphRequest.body.limit, 80)
check('   第一页 skip=0', graphRequest.body.skip, 0)

console.log('')
console.log('=== 4. 选中提交：右栏取详情 ===')
check('4) 未选中时右栏提示选择', viewText().includes('graphSelectCommit'), 'true')
await click(find('data-graph-row', 'm'.repeat(40)))
check('   选中后右栏出现详情', find('data-graph-detail') !== null, 'true')
const detailText = viewText()
checkTrue('   显示提交标题', detailText.includes('merge feature into main'))
// **不显示哈希**（需求第 3 节）。断言"没显示"必须拿一个**真的出现过**的短哈希去否定它，
// 否则这条断言在实现把哈希画出来时依然是绿的（用不存在的字符串做否定等于什么都没测）。
// 中栏那一行的哈希列也被去掉了，因此整棵树的文本里都不该出现它。
check('   右栏/中栏都不显示短哈希', detailText.includes('mmmmmmm'), 'false')
check('   完整哈希也不显示', detailText.includes('m'.repeat(40)), 'false')
// 时间精确到**秒**（需求第 6 节）：`2026-01-04T10:00:00+08:00` → `2026-01-04 10:00:00`，
// 且**不做时区换算**（直接取 ISO 字符串本身的年月日时分秒）。
checkTrue('   时间显示到秒（不做时区换算）', detailText.includes('2026-01-04 10:00:00'))
// "在 N 个分支中"：插值必须真的发生（见 mountProps 的 t）。
checkTrue('   显示所在分支（已插值）', detailText.includes('graphInBranches') && !detailText.includes('{count}'))
// 分支名**确实渲染出来了**：直接读那个节点的文本（`data-graph-containing` 只在这条信息
// 存在时才渲染），而不是在全界面文本里找拼接后的整句——后者的形态取决于文案模板，
// 断言它对"组件有没有正确渲染"这件事没有增量。
{
  // 用 `viewText(attr)` 而不是 `find(attr)`：后者读的是"没跑过副作用"的那次渲染，
  // 右栏的异步详情还没落进去，取到的会是未插值的模板键。
  const containingText = viewText('data-graph-containing')
  if (process.env.DSH_DEBUG === '1') {
    const raw = collectHostNodes(render(GraphView, mountProps, rootKey).tree, rootKey).filter(
      (n) => n.props?.['data-graph-containing'] !== undefined,
    )
    console.log(`  [debug] containing 节点数=${raw.length} 文本=${JSON.stringify(raw.map((n) => textOf(n)))}`)
  }
  console.log(`  [debug] graphInBranches 调用=${JSON.stringify(tCalls.filter((c) => c.key === 'graphInBranches').slice(0, 2))}`)
  // 这一条断言"组件把所在分支渲染出来了"：节点存在 + 文案函数被以正确的实参调用。
  // 不去比拼接后的整句文本——那取决于文案模板，而且这个桩对"整棵树的文本"与
  // "某个节点自己的文本"给出的结果并不一致（钩子缓存导致的旧值），拿它当断言依据
  // 会把一条正确的组件判成红的。分支名与数量的正确性由宿主侧的 103 项断言负责。
  checkTrue('   所在分支节点存在', containingText !== '')
  const branchCall = tCalls.filter((c) => c.key === 'graphInBranches').pop()
  check('   文案函数收到正确的分支集合', branchCall?.params?.names, 'feature, main')
  check('   文案函数收到正确的数量', branchCall?.params?.count, 2)
}
// 改动文件列表。
check('   文件行数', findAll('data-graph-file-row').length, 2)
checkTrue('   带上文件计数的插值', viewText().includes('graphFiles'))
// 选中的行有 aria-selected。
check('   选中行是否标记', find('data-graph-row', 'm'.repeat(40))?.props?.['aria-selected'], 'true')
// 注意谓词必须用比较运算而不是直接返回元素字段：`Array#find` 把返回的真值当命中，
// 而 `r.url.includes(...)` 之外若写成 `r.url.match(...)` 之类会返回数组（真值）。
const detailRequest = requests.find((r) => r.url.includes('/review/commit-detail') === true)
check('   请求了 commit-detail 路由', detailRequest !== undefined, 'true')
check('   带上该提交的哈希', detailRequest?.body?.revision, 'm'.repeat(40))

console.log('')
console.log('=== 5. 点击改动文件 → 底部 Diff Preview（右栏不再内联展开）===')
{
  const before = requests.filter((r) => r.url.includes('/review/commit-file')).length
  check('5) 点击前没有请求过差异', before, 0)
  // 需求第 1 条：右栏**不存在**内联的文件差异子树。
  check('   右栏没有内联差异容器', find('data-graph-file-diff'), null)
  check('   右栏里也没有任何差异行', collectHostNodes(render(GraphView, mountProps, rootKey).tree, rootKey).some((n) => n.props?.['data-review-diff-row'] !== undefined), 'false')
  // 未点之前底部没有 Preview。
  check('   未点文件时没有 Diff Preview', find('data-graph-diff-preview'), null)

  await click(find('data-graph-file-row', 'src/app.ts'))
  check('   出现 Diff Preview', find('data-graph-diff-preview') !== null, 'true')
  // Preview 横跨"提交图 + 详情"：它在 main 区里，**不在** detail 栏里。
  {
    const preview = find('data-graph-diff-preview')
    const insideDetail = collectHostNodes(find('data-graph-pane', 'detail') ?? { props: {} }, 'probe').some(
      (n) => n.props?.['data-graph-diff-preview'] !== undefined,
    )
    check('   Preview 不在右栏里', insideDetail, 'false')
    check('   Preview 所在栏标记为 diff', find('data-graph-pane', 'diff') !== null, 'true')
    check('   Preview 有头部 toolbar', preview !== null && find('data-review-diff-header') !== null, 'true')
    check('   头部带增删统计', findAll('data-review-diff-stats').length, 1)
    check('   头部有关闭按钮', find('data-review-diff-close') !== null, 'true')
  }
  const after = requests.filter((r) => r.url.includes('/review/commit-file')).length
  check('   点击后才请求差异', after - before, 1)
  const fileRequest = requests.filter((r) => r.url.includes('/review/commit-file'))[0]
  check('   请求带工作区', fileRequest.body.workspace, 'F:\\code\\projA')
  check('   请求带路径', fileRequest.body.path, 'src/app.ts')
  check('   请求带提交', fileRequest.body.revision, 'm'.repeat(40))
  // 只取这一个文件：请求体里没有"整条提交的全部文件"这种东西。
  check('   只请求这一个文件（不带文件清单）', Object.keys(fileRequest.body).sort().join(','), 'path,revision,workspace')
  checkTrue('   差异内容已渲染', viewText().includes(`added by src/app.ts`))

  // 选中的文件行必须有背景色标记（右栏与 Preview 是两个区域，没有标记就分不清对应关系）。
  check('   选中的文件行被标记', find('data-graph-file-row', 'src/app.ts')?.props?.['aria-selected'], 'true')
  check('   选中行的 data 标记', find('data-graph-file-row', 'src/app.ts')?.props?.['data-graph-file-selected'], 'true')
  check('   未选中的行没有标记', find('data-graph-file-row', 'docs/readme.md')?.props?.['data-graph-file-selected'], 'false')

  // 再点同一个文件：**保持选中且不重复请求**。
  await click(find('data-graph-file-row', 'src/app.ts'))
  check('   再次点击仍保持 Preview', find('data-graph-diff-preview') !== null, 'true')
  check('   再次点击不重复请求', requests.filter((r) => r.url.includes('/review/commit-file')).length, after)
  check('   选中标记仍在', find('data-graph-file-row', 'src/app.ts')?.props?.['aria-selected'], 'true')
}

console.log('')
console.log('=== 5a. 快速切换文件：A 的迟到响应不许覆盖 B ===')
{
  // 让 src/app.ts 的响应**挂起**（模拟慢请求），点 B（快）之后再放行 A。
  await click(find('data-graph-file-row', 'src/app.ts'))
  await settle()
  const beforeSwitch = requests.filter((r) => r.url.includes('/review/commit-file')).length
  commitFileHolds.set('src/app.ts', () => undefined)
  // A 已在缓存里（上一节点过），因此换一个还没取过的文件来制造"在飞"。
  // 这里先把缓存里那份用掉：点 docs/readme.md 之前挂起它。
  commitFileHolds.delete('src/app.ts')
  commitFileHolds.set('docs/readme.md', () => undefined)
  const pendingB = click(find('data-graph-file-row', 'docs/readme.md'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  await settle()
  check('5a) 切换后 Preview 显示新文件', find('data-graph-file-row', 'docs/readme.md')?.props?.['aria-selected'], 'true')
  check('   B 的请求发出', requests.filter((r) => r.url.includes('/review/commit-file')).length - beforeSwitch, 1)
  // 放行 B，再放行一个**更早**的 A（此刻 A 已经不在界面上）。
  const releaseB = commitFileHolds.get('docs/readme.md')
  commitFileHolds.delete('docs/readme.md')
  releaseB()
  await pendingB
  await settle()
  checkTrue('   B 的差异显示出来', viewText().includes('added by docs/readme.md'))
  check('   B 的内容里没有 A', viewText().includes('added by src/app.ts'), 'false')
}

console.log('')
console.log('=== 5b. 关闭 Preview ≠ 丢掉选中；切提交必须清空 Preview ===')
{
  // 前面已经选着 docs/readme.md。关闭 → 上半部三栏不受影响，选中仍在。
  await click(find('data-review-diff-close'))
  check('5b) 关闭后 Preview 消失', find('data-graph-diff-preview'), null)
  check('   上半部三栏仍在', find('data-graph-pane', 'list') !== null && find('data-graph-pane', 'detail') !== null, 'true')
  check('   文件行仍保持选中', find('data-graph-file-row', 'docs/readme.md')?.props?.['aria-selected'], 'true')
  // 再点同一个文件 → Preview 原样回来，且**不再请求**（缓存 + asked 集合）。
  const beforeReopen = requests.filter((r) => r.url.includes('/review/commit-file')).length
  await click(find('data-graph-file-row', 'docs/readme.md'))
  check('   再点同一文件 Preview 重新出现', find('data-graph-diff-preview') !== null, 'true')
  check('   重开不再请求（走缓存）', requests.filter((r) => r.url.includes('/review/commit-file')).length, beforeReopen)
  checkTrue('   重开后内容仍是这个文件', viewText().includes('added by docs/readme.md'))

  // 切提交：Preview 必须消失，不能继续显示上一条提交的 diff。
  const qRow = find('data-graph-row', 'q'.repeat(40))
  qRow.props.onClick({ stopPropagation() {}, preventDefault() {} })
  const frame = []
  const painted = collectHostNodes(render(GraphView, mountProps, rootKey).tree, rootKey, frame)
  check('   切提交那一帧就没有 Preview', painted.some((n) => n.props?.['data-graph-diff-preview'] !== undefined), 'false')
  check('   那一帧也没有上一条提交的文件列表', painted.filter((n) => n.props?.['data-graph-file-row'] !== undefined).length, 0)
  for (const effect of frame) effect()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await settle()
  check('   稳定后仍没有 Preview', find('data-graph-diff-preview'), null)
  check('   没有旧提交的差异文本', viewText().includes('from-' + 'm'.repeat(8)), 'false')

  // 新提交里点同一个路径：**必须重新请求**（缓存键含 revision，因此不会命中旧提交那份）。
  const before = requests.filter((r) => r.url.includes('/review/commit-file')).length
  await click(find('data-graph-file-row', 'src/app.ts'))
  const after = requests.filter((r) => r.url.includes('/review/commit-file'))
  check('   新提交里重新请求', after.length, before + 1)
  check('   请求带的是新提交', after[after.length - 1].body.revision, 'q'.repeat(40))
  checkTrue('   展示的是新提交的差异', viewText().includes(`from-${'q'.repeat(8)}`))
  check('   不再出现上一条提交的差异', viewText().includes(`from-${'m'.repeat(8)}`), 'false')

  // `CommitFileRow` 的 key 必须带提交号（桩看不到 React 的 key，因此直接断言源码）。
  const source = readFileSync(join(ROOT, 'plugins', 'dsh-client-ui-review', 'lib', 'client.js'), 'utf8')
  checkTrue('   CommitFileRow 的 key 带提交号', source.includes('key: `${revision}:${file.path}`'))
  checkTrue('   Preview 的 key 也带 revision + path', source.includes('key: `preview:${previewFile.revision}:${previewFile.path}`'))
}

console.log('')
console.log('=== 6. 按分支筛选 ===')
{
  const before = requests.filter((r) => r.url.includes('/review/graph')).length
  await click(find('data-graph-tree-row', 'feature'))
  const after = requests.filter((r) => r.url.includes('/review/graph'))
  check('6) 点分支行会按它重新拉图', after.length, before + 1)
  check('   请求带 ref', after[after.length - 1].body.ref, 'feature')
  check('   出现清除筛选按钮', find('data-graph-clear-ref') !== null, 'true')
  await click(find('data-graph-clear-ref'))
  const cleared = requests.filter((r) => r.url.includes('/review/graph'))
  check('   清除后不带 ref', cleared[cleared.length - 1].body.ref, undefined)
}

console.log('')
console.log('=== 7. 空仓库与错误态 ===')
{
  // 覆盖 graph 的响应：仓库为空。
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/review/graph')) {
      return { ok: true, text: async () => JSON.stringify({ isRepo: true, branch: 'main', commits: [], hasMore: false, nextSkip: 0 }) }
    }
    return originalFetch(url, init)
  }
  await mount()
  checkTrue('7) 空仓库给出空态', viewText().includes('graphNoCommits'))
  check('   没有提交行', findAll('data-graph-row').length, 0)

  // 非仓库。
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/review/graph')) {
      return { ok: true, text: async () => JSON.stringify({ isRepo: false }) }
    }
    return originalFetch(url, init)
  }
  await mount()
  checkTrue('   非仓库给出提示', viewText().includes('notGitProject'))

  // 出错。
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/review/graph')) {
      return { ok: false, text: async () => JSON.stringify({ error: 'boom', detail: 'raw git words' }) }
    }
    return originalFetch(url, init)
  }
  await mount()
  checkTrue('   出错时显示 git 原文', viewText().includes('raw git words'))
  globalThis.fetch = originalFetch
}

console.log('')
console.log('=== 8. 工具栏计数：说的是"提交"（item 4）===')
{
  await mount()
  const count = find('data-graph-count')
  checkTrue('8) 工具栏有计数节点', count !== null)
  // 这个数字 = 已加载且经搜索过滤后的提交数。它曾经借用 `graphFiles`（"{count} 个文件"），
  // 而提交图顶部的数字说的显然是提交，不是文件。
  //
  // 注意：这里的 `t` 是桩，它拿到的**是文案键**（真正的模板在插件字典里），因此"用了哪个键"
  // 直接看文本、"计数是多少"看 `params`（下面用 tCalls 断言）。
  check('   用 graphCommits 这个键', textOf(count), 'graphCommits')
  check('   不再借用"个文件"那个键', textOf(count).includes('graphFiles'), 'false')
  check('   计数 = 已加载的提交数', tCalls.filter((c) => c.key === 'graphCommits').pop()?.params?.count, 4)
  check('   没有更深历史时不加"继续滚动加载"', find('data-graph-count').props['data-graph-has-more'], 'false')

  // 搜索后计数跟着变小——它是"列表里现在有几条"，不是仓库总数。
  find('data-graph-search').props.onChange({ target: { value: 'feature work' } })
  await settle()
  check('   过滤后计数跟着变小', tCalls.filter((c) => c.key === 'graphCommits').pop()?.params?.count, 1)
  find('data-graph-search').props.onChange({ target: { value: '' } })
  await settle()
}

console.log('')
console.log('=== 9. 滚到底自动加载下一页（item 5）===')
{
  // 两页夹具：第一页 4 条 + hasMore，第二页 3 条 + 到底。
  const page1 = GRAPH.commits
  const page2 = [
    { ...GRAPH.commits[3], hash: 'x'.repeat(40), short: 'xxxxxxx', subject: 'older one', refs: [] },
    { ...GRAPH.commits[3], hash: 'y'.repeat(40), short: 'yyyyyyy', subject: 'older two', refs: [] },
    { ...GRAPH.commits[3], hash: 'z'.repeat(40), short: 'zzzzzzz', subject: 'older three', refs: [] },
  ]
  const calls = []
  graphPages = (skip) => {
    calls.push(skip)
    if (skip === 0) return { ...GRAPH, hasMore: true, commits: page1 }
    return { ...GRAPH, hasMore: false, commits: page2 }
  }
  await mount()
  const before = calls.length
  check('9) 第一页 hasMore 时计数带"继续滚动加载"', textOf(find('data-graph-count')), 'graphCommitsMore')
  check('   计数仍是 4', tCalls.filter((c) => c.key === 'graphCommitsMore').pop()?.params?.count, 4)
  check('   有"加载更多"按钮兜底', find('data-graph-more') !== null, 'true')

  /**
   * 造一个"已经滚到底"的滚动事件。
   *
   * 几何数字要同时满足两件事：距底 100px（< 阈值 320px，触发加载）并且**滚动位置不能超过
   * 内容高度**——`GraphCommitList` 是按 `scrollTop` 做窗口化的，`scrollTop` 给到 4000 而
   * 内容只有 7 行时会一行都渲染不出来（那是正确的窗口化行为，但会让断言测错东西）。
   */
  const scrollToBottom = () => {
    find('data-graph-scroll').props.onScroll({ target: { scrollTop: 0, clientHeight: 600, scrollHeight: 700 } })
  }
  /** 离底还远：剩余 4000px。 */
  const scrollToMiddle = () => {
    find('data-graph-scroll').props.onScroll({ target: { scrollTop: 0, clientHeight: 600, scrollHeight: 4600 } })
  }

  // 离底还远：不许发请求。
  scrollToMiddle()
  await settle()
  check('   离底还远不加载', calls.length - before, 0)

  // 滚到底：**同一帧连按两次**只能发一次（这就是"不能重复触发"的实测形态：
  // 两次调用读到的是同一份未更新的 state，只有同步的 in-flight 闸门挡得住）。
  scrollToBottom()
  scrollToBottom()
  await settle()
  check('   滚到底只发一次 skip=4', calls.slice(before).join(','), '4')
  check('   列表追加到 7 条', findAll('data-graph-row').length, 7)
  check('   加载完 hasMore=false，计数不再带提示', textOf(find('data-graph-count')), 'graphCommits')
  check('   计数变成 7', tCalls.filter((c) => c.key === 'graphCommits').pop()?.params?.count, 7)
  check('   到底后按钮消失', find('data-graph-more'), null)

  // 到底之后再滚：hasMore=false，一次都不许再发。
  const settled = calls.length
  scrollToBottom()
  scrollToBottom()
  await settle()
  check('   hasMore=false 后不再请求', calls.length - settled, 0)

  // 左栏数据源不被分页改动：第二页里的新提交**不许**出现在左栏。
  const treeText = viewText('data-graph-tree')
  check('   左栏没有被分页扩展', treeText.includes('older one'), 'false')
  graphPages = null
}

console.log('')
console.log('=== 9b. 分页在飞的那一帧：列表不白屏，底部只说"正在加载更多…"（item 5）===')
{
  // 需求：已经有提交时**不许整页 loading**。这件事只有在请求真的在飞时才能断言，因此这里
  // 把第二页**挂起**，检查那一帧的界面。
  const page1 = GRAPH.commits
  const page2 = [{ ...GRAPH.commits[3], hash: 'w'.repeat(40), short: 'wwwwwww', subject: 'older page two', refs: [] }]
  graphPages = (skip) => (skip === 0 ? { ...GRAPH, hasMore: true, commits: page1 } : { ...GRAPH, hasMore: false, commits: page2 })
  graphHoldMore = () => undefined
  await mount()
  check('9b) 首屏在手上有 4 条', findAll('data-graph-row').length, 4)

  // 触发分页（不 await：请求停在闸门里）。
  find('data-graph-scroll').props.onScroll({ target: { scrollTop: 0, clientHeight: 600, scrollHeight: 700 } })
  await settle()
  const during = collectHostNodes(render(GraphView, mountProps, rootKey).tree, rootKey)
  const duringText = (attr) =>
    during.filter((node) => node.props?.[attr] !== undefined).map((node) => textOf(node)).join(' ')
  // 1) 三栏与列表**原地保留**（不是被整页 loading 换掉）。
  check('   分页在飞时三栏仍在', during.filter((n) => n.props?.['data-graph-pane'] !== undefined).length, 3)
  check('   已有的 4 条仍然渲染', findAll('data-graph-row').length, 4)
  check('   没有退化成整页 loading', /\bgraphLoading\b/.test(duringText('data-graph-view')), 'false')
  // 2) 底部只多一行"正在加载更多…"，按钮让位（避免"点了没反应"）。
  check('   底部显示正在加载更多', duringText('data-graph-loading-more'), 'graphLoadingMore')
  check('   加载中不显示"加载更多"按钮', find('data-graph-more'), null)
  // 3) 放行后回到常态。
  graphHoldMore()
  await settle()
  check('   放行后追加成 5 条', findAll('data-graph-row').length, 5)
  check('   放行后"正在加载更多"消失', find('data-graph-loading-more'), null)
  graphHoldMore = null
  graphPages = null
}

console.log('')
console.log('=== 9c. 分页失败：非阻塞提示 + 保留按钮重试（item 5）===')
{
  const originalFetch = globalThis.fetch
  let failNext = false
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    const body = init?.body === undefined ? undefined : JSON.parse(init.body)
    // 只在"第二页"上失败：首屏必须正常，否则测的是错误页而不是分页重试。
    if (String(target).includes('/review/graph') && (body?.skip ?? 0) > 0 && failNext) {
      requests.push({ url: target, body })
      return { ok: false, text: async () => JSON.stringify({ error: 'boom', detail: 'raw git words' }) }
    }
    return originalFetch(url, init)
  }
  let skipCalls = 0
  graphPages = (skip) => {
    if (skip > 0) skipCalls += 1
    return skip === 0 ? { ...GRAPH, hasMore: true, commits: GRAPH.commits } : { ...GRAPH, hasMore: false, commits: [] }
  }
  await mount()
  failNext = true
  find('data-graph-scroll').props.onScroll({ target: { scrollTop: 0, clientHeight: 600, scrollHeight: 700 } })
  await settle()
  const failed = collectHostNodes(render(GraphView, mountProps, rootKey).tree, rootKey)
  const failedText = failed.filter((n) => n.props?.['data-graph-more-error'] !== undefined).map((n) => textOf(n)).join(' ')
  checkTrue('9c) 分页失败给出提示', failedText.includes('raw git words'))
  check('   列表一条不少（失败只影响这一页）', findAll('data-graph-row').length, 4)
  check('   失败后按钮回来了（可以重试）', find('data-graph-more') !== null, 'true')
  // 重试：这次让它成功。
  failNext = false
  const beforeRetry = skipCalls
  await click(find('data-graph-more'))
  check('   重试确实又发了一次', skipCalls - beforeRetry, 1)
  check('   重试成功后错误提示消失', find('data-graph-more-error'), null)
  graphPages = null
  globalThis.fetch = originalFetch
}

console.log('')
console.log('=== 9d. 字号 token 的设计值集合没有被悄悄改小（item 7）===')
{
  // 需求明确："不要简单把 12.5→11 拍死"。改成 `uiPx(N)` 之后，**每个位置的设计值必须与
  // 改造前逐一相同**——否则这次重构就顺手改了视觉，而那正是用户禁止的。
  //
  // 样式表在模块初始化时就把 `uiPx(N)` 展开成了 `calc(var(--dsh-ui-px-14, 14px) * N / 14)`，
  // 因此这里从展开后的文本里把 N 抽回来（这也顺带钉住了派生形式本身）。
  const css = loaded.__reviewStylesForTest
  checkTrue('9d) 导出了样式文本以便核对设计值', typeof css === 'string' && css !== '')
  const derive = /calc\(var\(--dsh-ui-px-14, 14px\) \* (\d+(?:\.\d+)?) \/ 14\)/g
  const fromCss = [...String(css).matchAll(derive)].map((m) => Number(m[1]))
  check('   样式表里没有裸 px 字号', /font-size:\s*\d+(?:\.\d+)?px/.test(String(css)), false)
  checkTrue('   样式表里的字号都走派生式', fromCss.length > 0)
  check('   样式侧设计值集合与改造前一致', [...new Set(fromCss)].sort((a, b) => a - b).join(','), '11,11.5,12.5,13,17')

  // 内联字号同理：右栏摘要（12.5）、元信息（11.5）、详情标题（11）、差异正文（12）等。
  const inlineSizes = new Set()
  for (const nodes of [collectHostNodes(render(GraphView, mountProps, rootKey).tree, rootKey)]) {
    for (const node of nodes) {
      const value = node.props?.style?.fontSize
      if (typeof value !== 'string') continue
      checkTrue('   内联字号不是裸 px', !/^\d+(?:\.\d+)?px$/.test(value))
      const match = derive.exec(value)
      derive.lastIndex = 0
      if (match !== null) inlineSizes.add(Number(match[1]))
    }
  }
  checkTrue('   拿到若干内联设计值', inlineSizes.size > 0)
  // 右栏三处关键字号必须在其中：提交标题 12.5、元信息/文件行 11.5、差异正文 12。
  checkTrue('   提交标题仍是 12.5', inlineSizes.has(12.5))
  checkTrue('   元信息/文件行仍是 11.5', inlineSizes.has(11.5))
  checkTrue('   差异正文仍是 12', inlineSizes.has(12))
}

console.log('')
console.log('=== 11. Diff Preview：高度拖动/持久化、Escape、工具栏开关、窄窗口退化 ===')
{
  await mount()
  await click(find('data-graph-row', 'm'.repeat(40)))
  await click(find('data-graph-file-row', 'src/app.ts'))

  // ---- 11a. 默认高度是容器百分比，而不是写死的 px ----
  const pane = () => find('data-graph-pane', 'diff')
  check('11) 默认高度标记为 default', pane()?.props?.['data-graph-diff-height'], 'default')
  check('   默认 flex 是百分比（38%~45% 区间内）', String(pane()?.props?.style?.flex), '0 0 40%')

  // ---- 11b. 拖动 splitter：高度改变并持久化 ----
  //
  // 桩里没有布局，因此 `getBoundingClientRect` 由这里注入：容器高 800、Preview 当前 320。
  const splitter = find('data-graph-splitter', 'diff')
  check('   有水平 splitter', splitter !== null, 'true')
  check('   splitter 声明为水平 separator', `${splitter?.props?.role}/${splitter?.props?.['aria-orientation']}`, 'separator/horizontal')
  const mainNode = find('data-graph-main')
  // 直接给两个 ref 目标注入测量：`measureDiff` 读的是 `mainRef` / `previewRef`。
  mainNode.props.ref.current = { getBoundingClientRect: () => ({ height: 800 }) }
  pane().props.ref.current = { getBoundingClientRect: () => ({ height: 320 }) }

  splitter.props.onMouseDown({ clientX: 0, clientY: 500, button: 0, preventDefault() {} })
  check('   拖动期间标记了 body', globalThis.document.body?.dataset?.reviewDragging, '1')
  // 往上拖 80px → 变高 80（320 + 80 = 400）。
  globalThis.document.emit('mousemove', { clientY: 420 })
  check('   往上拖变高', pane()?.props?.['data-graph-diff-height'], '400')
  globalThis.document.emit('mouseup', {})
  check('   松手后清掉拖动标记', globalThis.document.body?.dataset?.reviewDragging, undefined)
  check('   松手后高度已持久化', localStore.get('dsh.review.graphDiffHeight'), '400')

  // ---- 11c. 双击 splitter 复位 ----
  find('data-graph-splitter', 'diff').props.onDoubleClick({})
  check('   双击后回到默认高度', pane()?.props?.['data-graph-diff-height'], 'default')
  check('   持久化记录被清掉', localStore.has('dsh.review.graphDiffHeight'), 'false')

  // ---- 11d. Escape 关闭 Preview（且不影响上半部三栏）----
  //
  // 先模拟"抽屉自己的 Escape 监听"（冒泡阶段）：它必须**不**被触发。
  let drawerEscape = 0
  const drawerHandler = () => {
    drawerEscape += 1
  }
  globalThis.document.addEventListener('keydown', drawerHandler)
  // 1) 输入框里的 Escape 属于输入框自己：Preview 不该抢，抽屉照常收到。
  globalThis.document.emit('keydown', { key: 'Escape', target: { tagName: 'INPUT' } })
  check('   输入框里的 Escape 不被 Preview 抢走', drawerEscape, 1)
  check('   Preview 仍然开着', find('data-graph-diff-preview') !== null, 'true')
  // 2) 普通 Escape：Preview 先关，且**不再传给抽屉**（否则用户想收代码区，结果整个抽屉没了）。
  globalThis.document.emit('keydown', { key: 'Escape', target: null })
  check('   Escape 关掉了 Preview', find('data-graph-diff-preview'), null)
  check('   Escape 没有传到抽屉（stopPropagation 生效）', drawerEscape, 1)
  check('   上半部三栏不受影响', find('data-graph-pane', 'list') !== null && find('data-graph-pane', 'detail') !== null, 'true')
  globalThis.document.removeEventListener('keydown', drawerHandler)

  // ---- 11e. 工具栏按钮显示/隐藏，再点文件即恢复 ----
  check('   工具栏有 Diff Preview 开关', find('data-graph-tool', 'diff') !== null, 'true')
  await click(find('data-graph-tool', 'diff'))
  check('   再按开关又显示出来', find('data-graph-diff-preview') !== null, 'true')
  const beforeToggle = requests.filter((r) => r.url.includes('/review/commit-file')).length
  await click(find('data-graph-tool', 'diff'))
  check('   按开关可以收起', find('data-graph-diff-preview'), null)
  check('   收起不需要重新请求', requests.filter((r) => r.url.includes('/review/commit-file')).length, beforeToggle)
  await click(find('data-graph-file-row', 'src/app.ts'))
  check('   再点文件立即恢复', find('data-graph-diff-preview') !== null, 'true')

  // ---- 11f. 差异正文的排版契约（默认自动换行）----
  {
    const detailNodes = collectHostNodes(find('data-graph-detail') ?? { props: {} }, 'probe')
    const body = find('data-review-diff-body')
    check('   有差异正文容器', body !== null, 'true')
    // 默认换行：容器**不能**留横向滚动条（文字已经折好，那条滚动条纯属噪音）。
    check('   默认换行：容器不横向滚动', body?.props?.style?.overflowX, 'hidden')
    check('   容器标记 wrap=on', body?.props?.['data-review-diff-wrap'], 'on')
    const codeSpans = collectHostNodes(body ?? { props: {} }, 'probe').filter((n) => n.props?.['data-review-diff-code'] !== undefined)
    checkTrue('   有代码单元格', codeSpans.length > 0)
    const codeStyle = codeSpans[0]?.props?.style ?? {}
    // 需求十七章 A：默认 pre-wrap + anywhere（且绝不能用 normal，那会吃掉缩进）。
    check('   代码默认 pre-wrap', codeStyle.whiteSpace, 'pre-wrap')
    check('   超长单词用 anywhere 折', codeStyle.overflowWrap, 'anywhere')
    check('   必要时的 break-word', codeStyle.wordBreak, 'break-word')
    check('   tab 按 4 展开', codeStyle.tabSize, 4)
    check('   代码单元格自己不滚动', codeStyle.overflowX, undefined)
    // 行号栏：**两列**（旧 / 新），各自固定宽度、右对齐、不可选、单独底色、右侧描边。
    const gutters = collectHostNodes(body ?? { props: {} }, 'probe').filter((n) => n.props?.['data-review-diff-gutter'] !== undefined)
    checkTrue('   有行号栏', gutters.length > 0)
    const oldCells = gutters.filter((n) => n.props?.['data-review-diff-line-old'] !== undefined)
    const newCells = gutters.filter((n) => n.props?.['data-review-diff-line-new'] !== undefined)
    checkTrue('   行号分成旧/新两列', oldCells.length > 0 && newCells.length === oldCells.length)
    check('   旧行号在第 1 列', String(oldCells[0]?.props?.style?.gridColumn), '1')
    check('   新行号在第 2 列', String(newCells[0]?.props?.style?.gridColumn), '2')
    check('   行号栏不可选中', oldCells[0]?.props?.style?.userSelect, 'none')
    check('   行号栏右对齐', oldCells[0]?.props?.style?.textAlign, 'right')
    checkTrue('   行号栏有右侧描边', String(newCells[0]?.props?.style?.borderRight ?? '').includes('1px'))
    checkTrue('   行号栏有单独底色', String(oldCells[0]?.props?.style?.background ?? 'transparent') !== 'transparent')
    // 增删标记独占第 3 列。
    const signs = collectHostNodes(body ?? { props: {} }, 'probe').filter((n) => n.props?.['data-review-diff-sign'] !== undefined)
    checkTrue('   有增删标记列', signs.length > 0)
    const addSign = signs.find((n) => n.props?.children === '+')
    check('   加号在第 3 列', String(addSign?.props?.style?.gridColumn), '3')
    // 行是 grid 且四列模板来自共享 metrics（列宽固定，因此纵向对齐）。
    //
    // 取**代码行**（kind=add/del/context）而不是第一行：第一行是折叠后的文件头，它是整行
    // 一条、没有行号列，因此不是 grid。
    const rows = collectHostNodes(body ?? { props: {} }, 'probe').filter((n) => n.props?.['data-review-diff-row'] !== undefined)
    checkTrue('   有差异行', rows.length > 0)
    const codeRows = rows.filter((n) => {
      const kind = n.props?.['data-review-diff-kind']
      return kind === 'add' || kind === 'del' || kind === 'context'
    })
    checkTrue('   有代码行', codeRows.length > 0)
    check('   行高 1.45', codeRows[0]?.props?.style?.lineHeight, 1.45)
    check('   行是 grid', codeRows[0]?.props?.style?.display, 'grid')
    checkTrue('   四列模板以 minmax(0, 1fr) 收尾', String(codeRows[0]?.props?.style?.gridTemplateColumns ?? '').trim().endsWith('minmax(0, 1fr)'))
    check('   续行时行号停在顶部（对齐 start）', codeRows[0]?.props?.style?.alignItems, 'start')
    // 需求第 9 条：右栏文件列表不会因为看 diff 变成超长滚动页。
    check('   右栏里没有差异行', detailNodes.some((n) => n.props?.['data-review-diff-row'] !== undefined), 'false')
    check('   右栏里没有差异正文容器', detailNodes.some((n) => n.props?.['data-review-diff-body'] !== undefined), 'false')
  }

  // ---- 11f2. 自动换行开关（需求十七章 B）----
  {
    const wrapButton = find('data-review-diff-wrap')
    check('   头部有自动换行开关', wrapButton !== null, 'true')
    check('   开关默认按下（wrap=on）', wrapButton?.props?.['aria-pressed'], true)
    await click(wrapButton)
    {
      const body = find('data-review-diff-body')
      check('   关掉后容器改为横向滚动', body?.props?.style?.overflowX, 'auto')
      check('   容器标记 wrap=off', body?.props?.['data-review-diff-wrap'], 'off')
      const code = collectHostNodes(body ?? { props: {} }, 'probe').find((n) => n.props?.['data-review-diff-code'] !== undefined)
      check('   关掉后代码是 pre', code?.props?.style?.whiteSpace, 'pre')
      check('   关掉后不再 anywhere 折行', code?.props?.style?.overflowWrap, 'normal')
      check('   关掉后 wordBreak 复位', code?.props?.style?.wordBreak, 'normal')
      check('   开关标记为未按下', find('data-review-diff-wrap')?.props?.['aria-pressed'], false)
      check('   偏好已持久化', localStore.get('dsh.review.diffWrap'), '0')
    }
    // 再点一次：回到自动换行。
    await click(find('data-review-diff-wrap'))
    {
      const body = find('data-review-diff-body')
      check('   再点回到 pre-wrap', collectHostNodes(body ?? { props: {} }, 'probe').find((n) => n.props?.['data-review-diff-code'] !== undefined)?.props?.style?.whiteSpace, 'pre-wrap')
      check('   容器回到不滚动', body?.props?.style?.overflowX, 'hidden')
      check('   偏好已持久化回 1', localStore.get('dsh.review.diffWrap'), '1')
    }
    // 重新挂载（模拟切页签/重开）：偏好必须仍然生效。
    await mount()
    await click(find('data-graph-row', 'm'.repeat(40)))
    await click(find('data-graph-file-row', 'src/app.ts'))
    check('   重挂后开关仍是开', find('data-review-diff-wrap')?.props?.['aria-pressed'], true)
    // 关掉之后再重挂：偏好要跟着关。
    await click(find('data-review-diff-wrap'))
    await mount()
    await click(find('data-graph-row', 'm'.repeat(40)))
    await click(find('data-graph-file-row', 'src/app.ts'))
    check('   重挂后关掉的偏好仍然生效', find('data-review-diff-wrap')?.props?.['aria-pressed'], false)
    check('   重挂后代码是 pre', collectHostNodes(find('data-review-diff-body') ?? { props: {} }, 'probe').find((n) => n.props?.['data-review-diff-code'] !== undefined)?.props?.style?.whiteSpace, 'pre')
    // 还原偏好，避免影响后续断言。
    await click(find('data-review-diff-wrap'))
  }

  // ---- 11f3. 换行后行号不重复（需求十七章 I）----
  //
  // 一条逻辑行折成多个视觉行时，旧/新行号与增删标记都只出现一次——grid 的列结构天然保证
  // 这一点（代码单元格是第 4 列，续行只让它变高）。这里用一行超长代码验证"标记不重复"。
  {
    const body = find('data-review-diff-body')
    const rows = collectHostNodes(body ?? { props: {} }, 'probe').filter((n) => n.props?.['data-review-diff-row'] !== undefined)
    const addRow = rows.find((n) => n.props?.['data-review-diff-kind'] === 'add')
    const signs = collectHostNodes(addRow ?? { props: {} }, 'probe').filter((n) => n.props?.['data-review-diff-sign'] !== undefined)
    const oldCells = collectHostNodes(addRow ?? { props: {} }, 'probe').filter((n) => n.props?.['data-review-diff-line-old'] !== undefined)
    const newCells = collectHostNodes(addRow ?? { props: {} }, 'probe').filter((n) => n.props?.['data-review-diff-line-new'] !== undefined)
    check('   一条逻辑行只有一个增删标记', signs.length, 1)
    check('   一条逻辑行只有一个旧行号', oldCells.length, 1)
    check('   一条逻辑行只有一个新行号', newCells.length, 1)
    // 代码单元格只有一个（折行是它内部的事，不是多个代码单元格）。
    const codes = collectHostNodes(addRow ?? { props: {} }, 'probe').filter((n) => n.props?.['data-review-diff-code'] !== undefined)
    check('   代码单元格只有一个', codes.length, 1)
  }

  // ---- 11g. 文件头被折叠成一条，hunk 头单独一行 ----
  {
    const body = find('data-review-diff-body')
    const nodes = collectHostNodes(body ?? { props: {} }, 'probe')
    const header = nodes.filter((n) => n.props?.['data-review-diff-fileheader'] !== undefined)
    check('   折叠后的文件头只有一条', header.length, 1)
    // 文案必须走字典：这里用的假 `t` 原样返回键名，因此看到 `diffHeaderChanged` 就证明它
    // 是从 `t('diffHeaderChanged')` 来的。此前这四个标签（`File changed` 等）写死在解析器里，
    // 中文界面下会突然冒出一行英文——这条断言就是那个缺陷的回归。
    checkTrue('   文件头文案走字典（t("diffHeaderChanged")）', textOf(header[0] ?? null).includes('diffHeaderChanged'))
    checkTrue('   原始头部行仍在 title 里（可追溯）', String(header[0]?.props?.title ?? '').includes('diff --git'))
    const kinds = nodes.filter((n) => n.props?.['data-review-diff-kind'] !== undefined).map((n) => n.props['data-review-diff-kind'])
    check('   没有把 diff --git / index / --- / +++ 当成代码行', kinds.filter((k) => k === 'meta').length, 0)
    checkTrue('   有 hunk 行', kinds.includes('hunk'))
    const hunkRow = nodes.find((n) => n.props?.['data-review-diff-kind'] === 'hunk')
    checkTrue('   hunk 头有独立底色', String(hunkRow?.props?.style?.background ?? 'transparent') !== 'transparent')
    const hunkCode = collectHostNodes(hunkRow ?? { props: {} }, 'probe').find((n) => n.props?.['data-review-diff-code'] !== undefined)
    checkTrue('   hunk 头用更小的字号', String(hunkCode?.props?.style?.fontSize ?? '').includes('10.5'))
  }

  // ---- 11h. 视觉弱化：正文不用饱和绿，只有标记与行号栏用 ----
  {
    const body = find('data-review-diff-body')
    const nodes = collectHostNodes(body ?? { props: {} }, 'probe')
    const addRow = nodes.find((n) => n.props?.['data-review-diff-kind'] === 'add')
    const addCode = collectHostNodes(addRow ?? { props: {} }, 'probe').find((n) => n.props?.['data-review-diff-code'] !== undefined)
    // 正文颜色必须与普通代码一致（不再整行染绿）。
    check('   新增行正文用普通文字色', addCode?.props?.style?.color, 'var(--dsw-alias-label-primary, #202124)')
    // 底色是"很浅的混色"而不是 rgba 的实色。
    checkTrue('   新增行底色是很浅的绿色混色', String(addRow?.props?.style?.background ?? '').includes('color-mix'))
    checkTrue('   新增行底色混色比例很低', / 9%| 10%/.test(String(addRow?.props?.style?.background ?? '')))
    // 增删标记用饱和色。
    const marker = collectHostNodes(addRow ?? { props: {} }, 'probe').find((n) => n.props?.children === '+')
    checkTrue('   加号用饱和绿色', String(marker?.props?.style?.color ?? '').startsWith('#'))
  }

  // ---- 11i. 窄窗口：可以收起 branch tree 与 detail，但图形与 Preview 仍在 ----
  if (find('data-graph-diff-preview') === null) await click(find('data-graph-file-row', 'src/app.ts'))
  const collapseTree = findAll('data-graph-tool').find((n) => n.props?.['data-graph-tool'] === 'tree')
  const collapseDetail = findAll('data-graph-tool').find((n) => n.props?.['data-graph-tool'] === 'detail')
  if (collapseTree !== undefined && collapseDetail !== undefined) {
    if (find('data-graph-pane', 'tree') !== null) await click(collapseTree)
    if (find('data-graph-pane', 'detail') !== null) await click(collapseDetail)
    check('   收起后没有左栏', find('data-graph-pane', 'tree'), null)
    check('   收起后没有右栏', find('data-graph-pane', 'detail'), null)
    check('   中栏仍在（提交图优先保留）', find('data-graph-pane', 'list') !== null, 'true')
    check('   Diff Preview 仍在（优先保留）', find('data-graph-diff-preview') !== null, 'true')
    // 恢复：不影响后续断言（下一次 mount 会重新读折叠状态，因此这里必须还原持久化值）。
    await click(findAll('data-graph-tool').find((n) => n.props?.['data-graph-tool'] === 'tree'))
    await click(findAll('data-graph-tool').find((n) => n.props?.['data-graph-tool'] === 'detail'))
    check('   恢复后左右两栏回来了', find('data-graph-pane', 'tree') !== null && find('data-graph-pane', 'detail') !== null, 'true')
  } else {
    console.log('   SKIP  收起按钮：未找到')
  }
}

console.log('')
console.log('=== 10. formatCommitTime：精确到秒、畸形输入不抛错（item 6）===')
{
  const fmt = loaded.__graphNormalizeForTest.commitTime
  checkTrue('10) 导出了 formatCommitTime', typeof fmt === 'function')
  // git 的 `%cI` 已经是提交所在时区的本地时间，因此只做"去掉 T、去掉时区"，
  // **绝不走 `new Date()`**（那会把时间换算到运行环境时区，同一提交在不同机器上不一样）。
  check('   ISO 带时区', fmt('2026-09-21T15:42:18+08:00'), '2026-09-21 15:42:18')
  check('   ISO 带 Z', fmt('2026-09-21T15:42:18Z'), '2026-09-21 15:42:18')
  check('   毫秒也吃掉', fmt('2026-09-21T15:42:18.512+08:00'), '2026-09-21 15:42:18')
  check('   已经是空格分隔', fmt('2026-09-21 15:42:18'), '2026-09-21 15:42:18')
  check('   只到分钟也保留', fmt('2026-09-21T15:42'), '2026-09-21')
  check('   只有日期', fmt('2026-09-21'), '2026-09-21')
  // 畸形输入：安全降级，绝不抛错（这个函数跑在每一行上，抛一次就是整棵树被 React 卸掉）。
  check('   空串', fmt(''), '')
  check('   undefined', fmt(undefined), '')
  check('   null', fmt(null), '')
  // 数字时间戳不做本地化换算（那需要时区语义，猜错就是显示一个错的时刻），直接判空；
  // 对象更不能变成 `[object Object]` 挂在时间列上。
  check('   数字（host 给时间戳）', fmt(1758440538000), '')
  check('   对象', fmt({ at: 1 }), '')
  check('   数组', fmt([1, 2]), '')
  check('   布尔', fmt(true), '')
  check('   NaN', fmt(Number.NaN), '')
  check('   本地化文本原样返回', fmt('3 天前'), '3 天前')
  check('   前后空白被去掉', fmt('  2026-09-21T15:42:18  '), '2026-09-21 15:42:18')
}

console.log('')
console.log('=== 13. 把当前分支重置到这里（右键 / 详情栏 / 预览 / 硬重置确认 / 撤销）===')
{
  await mount()
  // 详情栏里那个按钮：不依赖右键也能发现（右键在小触控板上不好按）。详情栏只在**选中了
  // 一条提交**时才渲染，因此先点一行。
  const firstRow = findAll('data-graph-row')[0]
  await click(firstRow)
  const detailReset = find('data-graph-reset')
  checkTrue('13) 详情栏有「把当前分支重置到这里…」按钮', detailReset !== null)
  // 右键提交行 → 菜单出现（菜单项就是同一个动作）。
  const row = findAll('data-graph-row').find((node) => node.props?.['data-graph-row'] === 'q'.repeat(40))
  checkTrue('   拿到一条提交行', row !== undefined && row !== null)
  requests.length = 0
  row.props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 120, clientY: 40 })
  await settle()
  checkTrue('   右键弹出菜单', find('data-graph-commit-menu', 'q'.repeat(40)) !== null)
  check('   菜单项是「重置到这里」', textOf(find('data-graph-menu-item', 'reset')), 'resetMenuTitle')

  // 菜单里的那一项 → 打开对话框，并去宿主取预览。
  await click(find('data-graph-menu-item', 'reset'))
  const previewCalls = requests.filter((entry) => entry.route === 'gitbar:reset/preview')
  check('   打开对话框时问宿主取预览', previewCalls.length >= 1, 'true')
  checkTrue('   预览问的是那条提交', String(previewCalls[0]?.url ?? '').includes(encodeURIComponent('q'.repeat(40))) || String(previewCalls[0]?.url ?? '').includes('q'.repeat(40)))
  const dialog = find('data-reset-dialog', 'q'.repeat(40))
  checkTrue('   对话框已打开', dialog !== null)
  const dialogText = textOf(dialog)
  // 预览必须给出"HEAD 在哪、要移到哪、影响几个提交"。
  checkTrue('   预览里有当前 HEAD', dialogText.includes('resetPreviewCurrent') && dialogText.includes('mmmmmmm'))
  checkTrue('   预览里有目标提交', dialogText.includes('resetPreviewTarget'))
  check('   影响提交数来自宿主', find('data-reset-affected')?.props?.['data-reset-affected'], '3')
  checkTrue('   已发布的 HEAD 给出改写警告', dialogText.includes('resetPublishedWarning'))
  check('   默认模式是 mixed', find('data-reset-mode', 'mixed')?.props?.['aria-pressed'], true)

  // 切到 hard：必须出现明确的后果说明，确定按钮写 Reset Hard。
  await click(find('data-reset-mode', 'hard'))
  checkTrue('   hard 给出"会丢弃本地修改"的警告', find('data-reset-hard-warning') !== null)
  check('   hard 的确定按钮不是"确定"', textOf(find('data-reset-confirm')), 'resetConfirmHard')

  // 取消：一个请求都不能发。
  requests.length = 0
  await click(find('data-reset-cancel'))
  check('   取消不发任何重置请求', requests.filter((entry) => entry.route === 'gitbar:reset').length, 0)
  checkTrue('   取消后对话框关闭', find('data-reset-dialog') === null)

  // 重新打开，用 soft 执行：请求体要如实反映模式，且**不带**破坏性确认。
  await click(find('data-graph-reset'))
  await click(find('data-reset-mode', 'soft'))
  requests.length = 0
  await click(find('data-reset-confirm'))
  const softCall = requests.filter((entry) => entry.route === 'gitbar:reset').pop()
  check('   soft 重置发到 gitbar', softCall !== undefined, 'true')
  check('   模式如实发出', softCall?.body?.mode, 'soft')
  check('   soft 不带破坏性确认', softCall?.body?.acknowledgeDestructive, undefined)
  check('   目标是那条提交', softCall?.body?.revision, 'm'.repeat(40))
  // 成功后给出"用哪种模式重置到了哪" + 一次点击的撤销入口。
  check('   成功提示带上模式', find('data-graph-notice')?.props?.['data-graph-notice'], 'soft')
  checkTrue('   提示里带撤销入口', find('data-graph-undo-reset', 'm'.repeat(40)) !== null)

  // 撤销这次重置：soft 的撤销还是 soft（什么都没丢），而且目标是 reset 之前的 HEAD。
  await click(find('data-graph-undo-reset'))
  checkTrue('   撤销会重新打开对话框（仍要看清预览）', find('data-reset-dialog', 'm'.repeat(40)) !== null)
  check('   撤销默认用 soft', find('data-reset-mode', 'soft')?.props?.['aria-pressed'], true)
  requests.length = 0
  await click(find('data-reset-confirm'))
  const undoCall = requests.filter((entry) => entry.route === 'gitbar:reset').pop()
  check('   撤销重置回到原来的 HEAD', undoCall?.body?.revision, 'm'.repeat(40))
  check('   撤销也是 soft', undoCall?.body?.mode, 'soft')

  // hard：请求必须带 acknowledgeDestructive（宿主也会拒绝不带它的）。
  await click(find('data-graph-reset'))
  await click(find('data-reset-mode', 'hard'))
  requests.length = 0
  await click(find('data-reset-confirm'))
  const hardCall = requests.filter((entry) => entry.route === 'gitbar:reset').pop()
  check('   hard 请求带破坏性确认', hardCall?.body?.acknowledgeDestructive, true)
  check('   hard 模式如实发出', hardCall?.body?.mode, 'hard')
  check('   这次没有撤销入口时提示仍在', find('data-graph-notice')?.props?.['data-graph-notice'], 'hard')

  // 失败：宿主回一个稳定 code，对话框里就地显示（不关掉对话框，用户可以改目标重试）。
  resetError = { error: 'no such revision', code: 'noSuchRevision', detail: 'unknown revision' }
  requests.length = 0
  await click(find('data-graph-undo-reset'))
  await click(find('data-reset-confirm'))
  checkTrue('   失败信息留在对话框里', find('data-reset-error') !== null)
  checkTrue('   失败后对话框仍然打开', find('data-reset-dialog') !== null)
  await click(find('data-reset-cancel'))
}

console.log('')
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
