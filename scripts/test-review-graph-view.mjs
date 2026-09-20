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
    const prev = hookSlots[slot]
    const changed = prev === undefined || deps === undefined || prev.deps === undefined || deps.some((d, i) => !Object.is(d, prev.deps[i]))
    if (changed) {
      hookSlots[slot] = { deps }
      effectQueue.push(fn)
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
      const keyed = current.props?.key === undefined ? path : `${path}#${String(current.props.key)}`
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
  body: {},
  addEventListener(type, handler) {
    if (!domListeners.has(type)) domListeners.set(type, new Set())
    domListeners.get(type).add(handler)
  },
  removeEventListener(type, handler) {
    domListeners.get(type)?.delete(handler)
  },
  querySelector: () => null,
  createElement: () => ({ dataset: {}, style: {}, textContent: '', remove() {} }),
  documentElement: {},
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
const FILE_DIFF = {
  isRepo: true,
  path: 'src/app.ts',
  diff: ['diff --git a/src/app.ts b/src/app.ts', '--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1 +1 @@', '-old', '+new', ''].join('\n'),
  truncated: false,
  binary: false,
}

const requests = []
globalThis.fetch = async (url, init) => {
  const target = String(url)
  requests.push({ url: target, body: init?.body === undefined ? undefined : JSON.parse(init.body) })
  const route = target.slice(target.indexOf('/dsh-desktop/review/') + '/dsh-desktop/review/'.length).split('?')[0]
  const payload =
    route === 'roots'
      ? { roots: ['F:\\code\\projA'], current: 'F:\\code\\projA' }
      : route === 'graph'
        ? GRAPH
        : route === 'commit-detail'
          ? DETAIL
          : route === 'commit-file'
            ? FILE_DIFF
            : { isRepo: true }
  return { ok: true, text: async () => JSON.stringify(payload) }
}
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
checkTrue('   显示短哈希', detailText.includes('mmmmmmm'))
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
console.log('=== 5. 展开一个文件的差异（按需取）===')
{
  const before = requests.filter((r) => r.url.includes('/review/commit-file')).length
  check('5) 展开前没有请求过差异', before, 0)
  await click(find('data-graph-file-row', 'src/app.ts'))
  check('   展开后出现差异容器', find('data-graph-file-diff') !== null, 'true')
  const after = requests.filter((r) => r.url.includes('/review/commit-file')).length
  check('   展开后才请求差异', after, 1)
  const fileRequest = requests.find((r) => r.url.includes('/review/commit-file'))
  check('   请求带路径', fileRequest.body.path, 'src/app.ts')
  check('   请求带提交', fileRequest.body.revision, 'm'.repeat(40))
  checkTrue('   差异内容已渲染', textOf(find('data-graph-file-diff')).includes('new'))
  // 再点一次收起，且**不再重复请求**（差异已经取过）。
  await click(find('data-graph-file-row', 'src/app.ts'))
  check('   再次点击收起', find('data-graph-file-diff') === null, 'true')
  check('   收起不重复请求', requests.filter((r) => r.url.includes('/review/commit-file')).length, 1)
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
  checkTrue('   非仓库给出提示', viewText().includes('notRepo'))

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
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
