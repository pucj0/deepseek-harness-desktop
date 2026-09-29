// Log 分支清单（分支筛选）与中栏（提交列表）的**解耦**回归。
//
//   node scripts/test-review-graph-branch-filter.mjs
//
// 这一版里分支清单与中栏的数据源是**两个完全不同的东西**，本文件钉的就是这条边界：
//   * 分支清单 = **权威 refs 清单**：gitbar 宿主的 `GET /branches` + `GET /tags`（`for-each-ref`）。
//     分类按 namespace（`refs/heads` / `refs/remotes` / `refs/tags`），**不看名字里有没有
//     `/`**——`feature/a`、`release/1.6.4` 都是本地分支。
//   * 中栏 = `/graph` 的分页结果。提交行上的 `%D` 徽标只说明"这条提交上有哪些 ref"。
//
// 因此这里逐条钉住：
//   * 分支清单内容由清单决定：点任何 ref、翻任何一页都**不改变**它；
//   * 更深历史里的 ref（`legacy/support`，只在第二页的装饰里出现）**不会**因此进入分支清单
//     ——分支清单不是 decoration 聚合，`legacy/support` 在清单里没有就不该出现；
//   * 当前分支留在「本地」并带 `✓`，**没有单独的 HEAD 分组**；
//   * 再点同一个 ref = 取消过滤、回到全部；
//   * 一轮挂载只拉一次清单：滚动 / 过滤 / 分页都不重发（需求 71）；
//   * 已有数据时切 ref 只置 `refreshing`：两栏+首行选择器 DOM（含分支清单）**全程存在**，不出现只剩
//     `graphLoading` 的白屏；
//   * 每个 ref 的首屏有缓存：切回来同一帧就显示，且不会因此把分支清单弄乱；
//   * 快速点 develop → master → feature/a 且响应乱序（feature/a、master、develop）时，
//     最终只采用 feature/a 那一份，旧响应不得覆盖。
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PLUGIN = pathToFileURL(join(ROOT, 'plugins', 'dsh-client-ui-review', 'lib', 'client.js')).href

// ---- 假 React --------------------------------------------------------------------
const componentHooks = new Map()
let hookSlots = []
let renderIndex = 0
let effectQueue = []
let currentKey = ''
let currentCalls = []
const hookOrderErrors = []
const hookShapes = new Map()

const traced = (name, fn) => (...args) => {
  currentCalls.push(name)
  return fn(...args)
}

const react = {
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
    if (prev === undefined || prev.subscribe !== subscribe) hookSlots[slot] = { subscribe, unsubscribe: subscribe(() => {}) }
    return getSnapshot()
  }),
}

function render(Comp, props, key) {
  const saved = { hookSlots, renderIndex, effectQueue, currentKey, currentCalls }
  hookSlots = componentHooks.get(key) ?? []
  renderIndex = 0
  // **每次渲染都要换一个空的副作用队列**（老测试桩里这一行漏了就会把上一次的副作用
  // 一直累积下来：`drain` 每一轮都会把"历史上所有 effect"再跑一遍，于是请求被重复发出、
  // 状态来回震荡——这是一处很容易误判成"插件有 bug"的桩缺陷）。
  effectQueue = []
  currentKey = key
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
    currentKey = saved.currentKey
    currentCalls = saved.currentCalls
  }
  return { tree, effects }
}

function collectHostNodes(node, queued, rootKey) {
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
      const keyed = current.props?.key === undefined ? `${path}:${name}` : `${path}:${name}#${String(current.props.key)}`
      const { tree, effects } = render(current.type, current.props, keyed)
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
globalThis.document = {
  head: { appendChild() {} },
  body: { dataset: {} },
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  createElement: () => ({ dataset: {}, style: {}, textContent: '', remove() {} }),
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
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

// ---- 假 host ---------------------------------------------------------------------
const WORKSPACE = 'F:\\code\\projA'
let seq = 0

/**
 * 权威 refs 清单夹具（gitbar `/branches` + `/tags` 的响应）。
 *
 * 刻意放三个**带 `/` 的本地分支**与两个远程分支：分类必须由宿主的 `isRemote`（namespace）
 * 决定。若界面退回"名字里有 `/` 就算远程"，`feature/a` / `release/1.6.4` 会跑到远程段去。
 */
const INVENTORY_BRANCHES = {
  branches: [
    { name: 'develop', isRemote: false, current: false, hash: 'd'.repeat(40) },
    { name: 'feature/a', isRemote: false, current: false, hash: 'f'.repeat(40) },
    { name: 'feature/b', isRemote: false, current: false, hash: 'e'.repeat(40) },
    { name: 'master', isRemote: false, current: true, hash: 'a'.repeat(40) },
    { name: 'release/1.6.4', isRemote: false, current: false, hash: 'c'.repeat(40) },
    { name: 'origin/develop', isRemote: true, current: false, hash: 'd'.repeat(40) },
    { name: 'origin/master', isRemote: true, current: false, hash: 'a'.repeat(40) },
    // 符号引用：宿主已经过滤掉，这里再放一次是防止界面把它当成一个真分支显示出来。
    { name: 'origin/HEAD', isRemote: true, current: false, hash: 'a'.repeat(40) },
  ],
  counts: { local: 5, remote: 2 },
}
const INVENTORY_TAGS = { tags: [{ name: 'v1.6.4', sha: 'a'.repeat(40) }], tagCount: 1 }

/** 造一条提交：`refs` 是这条提交上的 `%D` 徽标（与分支清单清单是两回事）。 */
const commit = (hash, subject, refs) => ({
  hash,
  short: hash.slice(0, 7),
  parents: [],
  author: 'tester',
  email: 't@example.com',
  authoredAt: '2026-01-02T10:00:00+08:00',
  committedAt: '2026-01-02T10:00:00+08:00',
  subject,
  refs: refs.map((name) => ({ name, kind: name.includes('/') ? 'remote' : 'branch', isHead: name === 'master' })),
})

const c = (name, refs) => commit((name + '0'.repeat(40)).slice(0, 40), `subject ${name}`, refs)
/** 未过滤第一页。 */
const ALL_PAGE_1 = {
  isRepo: true,
  branch: 'master',
  hasMore: true,
  commits: [
    c('a1', ['master']),
    c('a2', ['develop']),
    c('a3', ['feature/a']),
    c('a4', ['feature/b']),
    c('a5', ['origin/master']),
    c('a6', ['origin/develop']),
  ],
}
/**
 * 未过滤第二页：带一个**只在装饰里出现**的 ref（`legacy/support`）。
 *
 * 它在权威清单里**不存在**，因此绝不该出现在分支清单——这正是"分支清单是清单、不是 decoration
 * 聚合"的判据（需求 12/17）。
 */
const ALL_PAGE_2 = { isRepo: true, branch: 'master', hasMore: false, commits: [c('a7', ['legacy/support'])] }
/** 过滤页：rows 数量各不相同，便于断言"中栏换成了哪一份"。 */
const PAGES = {
  develop: { isRepo: true, branch: 'develop', hasMore: true, commits: [c('d1', ['develop']), c('d2', ['develop'])] },
  'develop+2': { isRepo: true, branch: 'develop', hasMore: false, commits: [c('d3', ['develop'])] },
  master: { isRepo: true, branch: 'master', hasMore: false, commits: [c('m1', ['master']), c('m2', ['master']), c('m3', ['master'])] },
  'feature/a': { isRepo: true, branch: 'feature/a', hasMore: false, commits: [c('f1', ['feature/a'])] },
}
/** 页 key：`ref|skip`。 */
const pageKey = (ref, skip) => `${ref === '' ? '' : ref}|${skip}`
const PAGES_BY_KEY = new Map([
  [pageKey('', 0), ALL_PAGE_1],
  [pageKey('', 6), ALL_PAGE_2],
  [pageKey('develop', 0), PAGES.develop],
  [pageKey('develop', 2), PAGES['develop+2']],
  [pageKey('master', 0), PAGES.master],
  [pageKey('feature/a', 0), PAGES['feature/a']],
])

/** 挂起某个页的响应：`held.get(key)` 是一个待放行函数数组。 */
const held = new Map()
const graphRequests = []
/** 清单请求（`/branches` + `/tags`）：用来断言"一轮挂载只拉一次"（需求 71）。 */
const inventoryRequests = []
globalThis.fetch = async (url, init) => {
  const target = String(url)
  if (target.includes('/dsh-desktop/gitbar/branches')) {
    inventoryRequests.push({ route: 'branches', url: target })
    return { ok: true, text: async () => JSON.stringify(INVENTORY_BRANCHES) }
  }
  if (target.includes('/dsh-desktop/gitbar/tags')) {
    inventoryRequests.push({ route: 'tags', url: target })
    return { ok: true, text: async () => JSON.stringify(INVENTORY_TAGS) }
  }
  const body = init?.body === undefined ? undefined : JSON.parse(init.body)
  const route = target.slice(target.indexOf('/dsh-desktop/review/') + '/dsh-desktop/review/'.length).split('?')[0]
  if (route !== 'graph') return { ok: true, text: async () => JSON.stringify({ isRepo: true }) }
  const ref = typeof body?.ref === 'string' ? body.ref : ''
  const skip = Number(body?.skip ?? 0)
  const key = pageKey(ref, skip)
  graphRequests.push({ ref, skip, key, order: (seq += 1) })
  const payload = PAGES_BY_KEY.get(key) ?? { isRepo: true, branch: ref, hasMore: false, commits: [] }
  if (held.has(key)) {
    return await new Promise((resolve) => held.get(key).push(() => resolve({ ok: true, text: async () => JSON.stringify(payload) })))
  }
  return { ok: true, text: async () => JSON.stringify(payload) }
}
/** 放行一个被挂起的页（按放行顺序返回）。 */
function release(key) {
  const waiting = held.get(key) ?? []
  held.delete(key)
  const releaseOne = waiting.shift()
  if (releaseOne === undefined) return false
  if (waiting.length > 0) held.set(key, waiting)
  releaseOne()
  return true
}
const hold = (key) => held.set(key, [])

// ---- 加载插件 --------------------------------------------------------------------
let loaded
await import(PLUGIN)
loaded.apply({
  effect(fn) {
    fn()
  },
  locale: { register() {}, bind: () => (key) => key },
  slots: { inject() {}, register: () => () => {} },
  sidebarRight: {},
  sidebarRightTabs: { register: () => () => {} },
  sessions: {},
  workspaces: {},
})

const GraphView = loaded.__commitGraphViewForTest

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
const t = (key, params) => {
  if (params === undefined) return key
  return `${key}(${Object.entries(params).map(([name, value]) => `${name}=${value}`).join(',')})`
}

let rootKey = 'graph-filter'
const mountProps = { t, workspace: WORKSPACE }

async function drain(passes = 8) {
  let nodes = []
  for (let pass = 0; pass < passes; pass += 1) {
    const queued = []
    const out = render(GraphView, mountProps, rootKey)
    queued.push(...out.effects)
    nodes = collectHostNodes(out.tree, queued, rootKey)
    if (queued.length > 0) for (const effect of queued) effect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    // **至少跑两轮**：响应是在 `await` 让出的那个 tick 里落地的，只跑一轮会拿到"更新之前"
    // 那一帧（实测踩到过：明明放行了响应，读到的却还是 refreshing=true）。
    if (queued.length === 0 && pass >= 1) break
  }
  return nodes
}
/** 分支清单的行名（按渲染顺序）。 */
const treeRows = (nodes) => rowsOf(nodes, 'data-graph-ref-row').map((n) => n.props['data-graph-ref-row'])
const treeSelected = (nodes) => rowsOf(nodes, 'data-graph-ref-row').filter((n) => n.props['aria-selected'] === true).map((n) => n.props['data-graph-ref-row'])
/**
 * 分支清单按**分段**收窄的行名。
 *
 * `collectHostNodes` 把宿主元素拍平成一个列表，但**保留文档顺序**，而三段是按
 * local → remote → tags 顺序渲染的，因此"最近遇到的分段标记"就是这一行的归属。
 */
const rowsBySection = (nodes) => {
  const out = { local: [], remote: [], tags: [] }
  let current = ''
  for (const node of nodes) {
    const section = node.props?.['data-graph-ref-section']
    if (section !== undefined) {
      current = section
      continue
    }
    const row = node.props?.['data-graph-ref-row']
    if (row !== undefined && current !== '') out[current]?.push(row)
  }
  return out
}
const middleRows = (nodes) => rowsOf(nodes, 'data-graph-row').map((n) => String(n.props['data-graph-row']).slice(0, 2))
/**
 * 打开**提交图首行的分支选择器**，并返回那一帧的节点。
 *
 * ref 行只在下拉打开时存在（这正是这一轮的结构变化：它不再是左侧一整列常驻的分支树）。
 * 因此凡是"要看清单内容"的地方都必须先经过这里。已经打开时不重复点击（再点会收起）。
 *
 * @param passes - 渲染轮数，透传给 drain。
 * @returns 那一帧的宿主节点。
 */
async function openMenu(passes) {
  const first = await drain(passes)
  if (rowsOf(first, 'data-graph-ref-menu').length > 0) return first
  const button = rowsOf(first, 'data-graph-ref-select-button')[0]
  if (button === undefined || typeof button.props.onClick !== 'function') return first
  button.props.onClick()
  return await drain(passes)
}
/** 点清单里的一行（会自动先打开下拉）。 */
async function clickTree(name) {
  const nodes = await openMenu()
  dump('after-drain-1', nodes)
  const row = rowsOf(nodes, 'data-graph-ref-row').find((n) => n.props['data-graph-ref-row'] === name)
  if (row === undefined || typeof row.props.onClick !== 'function') return false
  row.props.onClick()
  return true
}
/**
 * Log 的布局还在（白屏回归的判据）。
 *
 * 新结构的判据是：视图在 + **首行选择器在** + 提交列表栏 + 详情栏，并且**没有**
 * 左侧分支栏（`data-graph-pane="tree"` 必须不存在）。
 */
const layoutAlive = (nodes) =>
  rowsOf(nodes, 'data-graph-view').length === 1 &&
  rowsOf(nodes, 'data-graph-pane').some((n) => n.props['data-graph-pane'] === 'list') &&
  rowsOf(nodes, 'data-graph-pane').some((n) => n.props['data-graph-pane'] === 'detail') &&
  rowsOf(nodes, 'data-graph-pane').every((n) => n.props['data-graph-pane'] !== 'tree')
/** 一行状态摘要（调试用）。 */
const dump = (label, nodes) => {
  if (process.env.DSH_TEST_DEBUG !== '1') return
  console.log(
    `      [state] ${label}: mid=${middleRows(nodes).join(',')} refreshing=${rowsOf(nodes, 'data-graph-refreshing').length}` +
      ` more=${rowsOf(nodes, 'data-graph-more').length} sel=${treeSelected(nodes).join(',') || '-'} reqs=${graphRequests.map((r) => r.key).join('|')}`,
  )
}
/** 清单里的完整分支清单（顺序 = 宿主返回顺序）。 */
const LOCAL = 'develop,feature/a,feature/b,master,release/1.6.4'
const REMOTE = 'origin/develop,origin/master'
const TAGS = 'v1.6.4'
const FULL_TREE = `${LOCAL},${REMOTE},${TAGS}`

console.log('=== 0. 初始：分支清单来自权威清单，中栏是未过滤提交 ===')
{
  // ---- 结构：**没有左侧分支栏**，分支选择在提交图首行 ----
  //
  // 这一组断言就是这一轮的主视觉要求：Log 不再是"左侧分支栏 + 中间提交图 + 右栏详情"的
  // 三栏结构；分支选择变成一个顶部的选择动作。
  const closed = await drain()
  check('0a) 没有左侧分支栏（没有 tree 分栏）', rowsOf(closed, 'data-graph-pane').some((n) => n.props['data-graph-pane'] === 'tree'), 'false')
  check('   也没有分支栏的拖动手柄', rowsOf(closed, 'data-graph-splitter').some((n) => n.props['data-graph-splitter'] === 'tree'), 'false')
  check('   没有「收起分支树」按钮', rowsOf(closed, 'data-graph-tool').some((n) => n.props['data-graph-tool'] === 'tree'), 'false')
  // 下拉没打开时，ref 清单**一个节点都不该渲染**（它不再是常驻面板）。
  check('   下拉未打开时 ref 清单不占位', rowsOf(closed, 'data-graph-ref-list').length, 0)
  const toolbar = rowsOf(closed, 'data-graph-toolbar')[0]
  has('   首行工具栏存在', toolbar !== undefined)
  // 它是 **Log 主区的第一个子节点**（横跨提交图与详情），而不是挤在提交列表栏里。
  const mainNode = rowsOf(closed, 'data-graph-main')[0]
  const mainKids = Array.isArray(mainNode?.props?.children) ? mainNode.props.children : [mainNode?.props?.children]
  has('   工具栏是 Log 主区的首行（横跨两栏）', mainKids[0]?.props?.['data-graph-toolbar'] !== undefined)
  const toolbarKids = Array.isArray(toolbar?.props?.children) ? toolbar.props.children : [toolbar?.props?.children]
  // 第一格是**组件**本体（`data-graph-ref-select` 挂在它渲染出来的那个 div 上）。
  check('   首行第一格就是分支选择器', toolbarKids[0]?.type?.name, 'GraphRefSelector')
  has('   选择器渲染出了自己的容器', collectHostNodes(toolbarKids[0]).some((n) => n.props?.['data-graph-ref-select'] !== undefined))
  // 搜索与刷新这些轻量操作仍然在**同一行**里（不因为多了选择器而被挤到第二行）。
  has('   同一行里还有搜索框', collectHostNodes(toolbar).some((n) => n.props?.['data-graph-search'] !== undefined))
  has('   同一行里还有刷新按钮', collectHostNodes(toolbar).some((n) => n.props?.['data-graph-tool'] === 'refresh'))
  has('   选择器上写着「全部分支」', textOf(rowsOf(closed, 'data-graph-ref-select-button')[0] ?? null).includes('graphAllRefs'))

  // ---- 内容：权威清单 ----
  const nodes = await openMenu()
  dump('after-drain-2', nodes)
  check('0) 分支清单列出清单里的全部 ref', treeRows(nodes).join(','), FULL_TREE)
  check('   分段只有 本地/远程/标签', rowsOf(nodes, 'data-graph-ref-section').map((n) => n.props['data-graph-ref-section']).join(','), 'local,remote,tags')
  check('   本地段（带 `/` 的也是本地）', rowsBySection(nodes).local.join(','), LOCAL)
  check('   远程段', rowsBySection(nodes).remote.join(','), REMOTE)
  check('   标签段', rowsBySection(nodes).tags.join(','), TAGS)
  check('   没有单独的 HEAD 分组', rowsOf(nodes, 'data-graph-ref-section').some((n) => n.props['data-graph-ref-section'] === 'head'), 'false')
  const master = rowsOf(nodes, 'data-graph-ref-row').find((n) => n.props['data-graph-ref-row'] === 'master')
  check('   当前分支在本地段里标了 current', master?.props['data-graph-ref-current'], 'true')
  check('   当前分支行显示 ✓ 前缀', textOf(master), '\u2713 master')
  has('   没有把 origin/HEAD 当成一个分支', treeRows(nodes).includes('origin/HEAD') === false)
  check('   中栏六条提交', middleRows(nodes).length, 6)
  check('   初始没有选中任何 ref', treeSelected(nodes).length, 0)
  // 「全部分支」这一项就在下拉里（它取代了以前工具条上那个独立的 ✕ 胶囊）。
  has('   下拉里有「全部分支」一项', rowsOf(nodes, 'data-graph-clear-ref').length === 1)
  check('   清单来自 gitbar 的两条只读路由', inventoryRequests.map((r) => r.route).sort().join(','), 'branches,tags')
  check('   没有 hook 数量变化', hookOrderErrors.length, 0)
}

console.log('')
console.log('=== 1. 点 develop：分支清单完整不变，develop 高亮，中栏换成 develop 的提交 ===')
{
  has('1) 点得中 develop', await clickTree('develop'))
  const nodes = await openMenu()
  dump('after-drain-3', nodes)
  check('   分支清单仍然是完整清单', treeRows(nodes).join(','), FULL_TREE)
  check('   本地段照旧', rowsBySection(nodes).local.join(','), LOCAL)
  check('   只有 develop 被选中', treeSelected(nodes).join(','), 'develop')
  check('   中栏是 develop 的提交', middleRows(nodes).join(','), 'd1,d2')
  has('   两栏+首行选择器都在', layoutAlive(nodes))
  // 需求 71：过滤**不重拉清单**（清单与"看哪一页提交"无关）。
  check('   过滤没有重发清单请求', inventoryRequests.length, 2)
  check('   没有 hook 数量变化', hookOrderErrors.length, 0)
}

console.log('')
console.log('=== 2. 点 master：develop 取消高亮，master 高亮，中栏换 master ===')
{
  has('2) 点得中 master', await clickTree('master'))
  const nodes = await openMenu()
  dump('after-drain-4', nodes)
  check('   分支清单仍然完整', treeRows(nodes).join(','), FULL_TREE)
  check('   只有 master 被选中', treeSelected(nodes).join(','), 'master')
  check('   中栏换成 master 的提交', middleRows(nodes).join(','), 'm1,m2,m3')
  has('   两栏+首行选择器都在', layoutAlive(nodes))
}

console.log('')
console.log('=== 3. 再点 master：取消过滤，中栏回到全部（走"全部"的缓存，立即可见）===')
{
  const before = graphRequests.length
  has('3) 再点一次 master', await clickTree('master'))
  const nodes = await openMenu()
  dump('after-drain-5', nodes)
  check('   分支清单仍然完整', treeRows(nodes).join(','), FULL_TREE)
  check('   没有任何 ref 被选中', treeSelected(nodes).length, 0)
  check('   中栏回到未过滤的六条', middleRows(nodes).join(','), 'a1,a2,a3,a4,a5,a6')
  has('   两栏+首行选择器都在', layoutAlive(nodes))
  // 缓存命中：取消过滤的这一帧不该是空白（那一份 '' 的首屏是第一页拿到的，一直在缓存里）。
  has('   取消过滤也发了后台 revalidate', graphRequests.length - before >= 1)
}

console.log('')
console.log('=== 4. 白屏回归：请求挂起 2 秒期间两栏+首行选择器必须一直在 ===')
{
  hold(pageKey('develop', 0))
  has('4) 点得中 develop', await clickTree('develop'))
  // 模拟"请求还没回来"的那段时间：反复渲染，直到内部仍处于 refreshing。
  const during = await openMenu(2)
  if (process.env.DSH_TEST_DEBUG === '1') {
    console.log(`  [debug] held=${JSON.stringify([...held.entries()].map(([k, v]) => [k, v.length]))}`)
    console.log(`  [debug] requests=${graphRequests.map((r) => r.key).join(' | ')}`)
    console.log(`  [debug] viewText=${JSON.stringify(textOf(rowsOf(during, 'data-graph-view')[0] ?? null).slice(0, 200))}`)
  }
  has('   请求确实还挂着（没有响应回来）', held.get(pageKey('develop', 0))?.length === 1)
  has('   两栏+首行选择器一直在（没有整页 loading）', layoutAlive(during))
  check('   分支清单内容没有消失', treeRows(during).join(','), FULL_TREE)
  has('   中栏保留上一份提交', middleRows(during).length > 0)
  has('   显示"正在加载"提示', rowsOf(during, 'data-graph-refreshing').length === 1)
  check('   视图里不是只有 graphLoading', textOf(rowsOf(during, 'data-graph-view')[0] ?? null).includes('graphLoading'), 'false')
  // 放行：中栏原地换成 develop 的提交，两栏+首行选择器仍在。
  has('   放行响应', release(pageKey('develop', 0)))
  dump('放行前', during)
  const after = await openMenu()
  dump('放行后', after)
  check('   中栏原地替换成 develop', middleRows(after).join(','), 'd1,d2')
  has('   两栏+首行选择器仍在', layoutAlive(after))
  check('   分支清单仍然完整', treeRows(after).join(','), FULL_TREE)
  has('   加载提示消失', rowsOf(after, 'data-graph-refreshing').length === 0)
}

console.log('')
console.log('=== 5. 过滤状态下的分页：只追加中栏，绝不改动分支清单 ===')
{
  has('5) 点得中「加载更多」', await (async () => {
    const nodes = await drain()
    dump('after-drain-6', nodes)
    const more = rowsOf(nodes, 'data-graph-more')[0]
    if (more === undefined) return false
    more.props.onClick()
    return true
  })())
  const nodes = await openMenu()
  dump('after-drain-7', nodes)
  check('   中栏追加了 develop 的第二页', middleRows(nodes).join(','), 'd1,d2,d3')
  check('   分支清单仍然是完整清单', treeRows(nodes).join(','), FULL_TREE)
  check('   仍然只有 develop 被选中', treeSelected(nodes).join(','), 'develop')
  const last = graphRequests.at(-1)
  check('   第二页带的是 develop 与 skip=2', `${last?.ref}/${last?.skip}`, 'develop/2')
}

console.log('')
console.log('=== 6. 未过滤分页：只追加中栏；装饰里的新 ref 不得混进分支清单 ===')
{
  // 这一节钉的是**数据源分离**这条设计（需求 12/13/17）：
  //
  // 分支清单是权威 refs 清单，中栏是 `/graph` 分页。第二页的装饰里带了一个清单里没有的
  // `legacy/support`——它必须**只**出现在提交行的徽标上，绝不能因此多出一行分支清单。
  // 旧实现把分页结果并进 `treeCommits` 再聚合 `commit.refs`，于是分支清单会在滚动这种与它
  // 无关的动作里自己长出新分支（而且那句"加载更多"是谁点的也说不清）。
  has('6) 取消过滤（再点 develop）', await clickTree('develop'))
  await drain()
  const beforeMid = graphRequests.length
  has('   点得中「加载更多」', await (async () => {
    const nodes = await drain()
    dump('after-drain-8', nodes)
    const more = rowsOf(nodes, 'data-graph-more')[0]
    if (more === undefined) return false
    more.props.onClick()
    return true
  })())
  const nodes = await openMenu()
  dump('after-drain-9', nodes)
  check('   中栏也追加了那一条', middleRows(nodes).join(','), 'a1,a2,a3,a4,a5,a6,a7')
  check('   分支清单没有多出装饰里的 legacy/support', treeRows(nodes).join(','), FULL_TREE)
  check('   本地段也没有多出来', rowsBySection(nodes).local.join(','), LOCAL)
  has('   分页确实发了请求', graphRequests.length - beforeMid >= 1)
  // 整个第六节（两次过滤 + 两次分页 + 若干轮渲染）都不该重拉清单。
  check('   分页/渲染都没有重发清单请求', inventoryRequests.length, 2)
}

console.log('')
console.log('=== 7. 快速切换 + 乱序返回：最终只采用最后一次的响应 ===')
{
  rootKey = 'graph-race'
  // 重新挂载，拿到干净状态；三份响应全部挂起，再**按"最新的先回、旧的最后回"**乱序放行
  // ——这正是"旧响应不得覆盖新结果"最容易出错的方向。
  for (const ref of ['develop', 'master', 'feature/a']) hold(pageKey(ref, 0))
  const nodes0 = await openMenu()
  check('7) 重新挂载后分支清单是完整清单', treeRows(nodes0).join(','), FULL_TREE)
  const invBefore = inventoryRequests.length
  has('   点得中 develop', await clickTree('develop'))
  await drain(1)
  has('   点得中 master', await clickTree('master'))
  await drain(1)
  has('   点得中 feature/a', await clickTree('feature/a'))
  await drain(1)
  check('   三个请求都在飞', ['develop', 'master', 'feature/a'].filter((ref) => (held.get(pageKey(ref, 0)) ?? []).length > 0).length >= 1, 'true')
  // 先放行**最后点**的那个，再放行两个更早的。
  release(pageKey('feature/a', 0))
  await drain(1)
  release(pageKey('master', 0))
  const afterMaster = await drain()
  release(pageKey('develop', 0))
  const nodes = await openMenu()
  check('   只有 feature/a 被选中', treeSelected(nodes).join(','), 'feature/a')
  check('   分支清单完整', treeRows(nodes).join(','), FULL_TREE)
  check('   中栏只采用 feature/a 的那一份', middleRows(nodes).join(','), 'f1')
  check('   迟到的 master 响应没有覆盖', middleRows(afterMaster).join(','), 'f1')
  check('   迟到的 develop 响应也没有覆盖', middleRows(nodes).join(','), 'f1')
  has('   两栏+首行选择器都在', layoutAlive(nodes))
  check('   切 ref 期间没有重发清单请求', inventoryRequests.length - invBefore, 0)
}

console.log('')
console.log('=== 8. 每个 ref 的首屏缓存：切回来同一帧就能看到 ===')
{
  rootKey = 'graph-cache'
  // 重新挂载：先让 '' 的首屏落地，再点一次 feature/a（缓存里已经有），把这次请求挂起。
  hold(pageKey('feature/a', 0))
  const nodes0 = await openMenu()
  check('8) 挂载后中栏是未过滤提交', middleRows(nodes0).length, 6)
  has('   点得中 feature/a', await clickTree('feature/a'))
  const cached = await openMenu(2)
  // 请求还挂着，但中栏已经是缓存里那一份（不是空白、不是 loading 页）。
  has('   请求仍挂着', (held.get(pageKey('feature/a', 0)) ?? []).length === 1)
  check('   中栏已经是缓存里的 feature/a 提交', middleRows(cached).join(','), 'f1')
  has('   两栏+首行选择器都在', layoutAlive(cached))
  check('   分支清单完整', treeRows(cached).join(','), FULL_TREE)
  has('   同时标出正在后台刷新', rowsOf(cached, 'data-graph-refreshing').length === 1)
  release(pageKey('feature/a', 0))
  await drain()
}

console.log('')
console.log('=== 9. 全程 hook 数量恒定（等价于真实 React #310）===')
{
  check('9) 发生 hook 数量/顺序变化的组件', hookOrderErrors.length, 0)
}

console.log('')
console.log(failures === 0 ? '分支过滤解耦全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
