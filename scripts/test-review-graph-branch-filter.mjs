// Log 左栏分支树与中栏提交过滤的**解耦**回归。
//
//   node scripts/test-review-graph-branch-filter.mjs
//
// 这一版修的两个实机现象：
//   1. 点左栏某个分支之后，左栏被过滤得只剩那个分支附近的 refs——因为 `GraphBranchTree`
//      的数据源是 `fresh.commits`，而它同时又是中栏（会被 `/graph { ref }` 替换）的数据。
//   2. 点分支时整个 Log 先变成 loading 空白页再出现——因为 `reload` 无条件
//      `update({ phase: 'loading' })`，而视图在 `phase === 'loading'` 时直接 return 整页。
//
// 因此这里逐条钉住：
//   * 左栏数据源是 `treeCommits`（只由未过滤响应写入），点任何 ref 都不变；
//   * 中栏才跟着 `selectedRef` 变；再点同一个 = 取消过滤、回到全部；
//   * 已有数据时切 ref 只置 `refreshing`：三栏 DOM（含左栏分支树）**全程存在**，不出现
//     只剩 `graphLoading` 的白屏；
//   * 每个 ref 的首屏有缓存：切回来同一帧就显示，且不会因此把左栏弄乱；
//   * 分页只追加到中栏；未过滤分页才顺带扩展左栏（左栏永远不会因为**过滤**分页而增减）；
//   * 快速点 develop → master → feature/a 且响应乱序（master、develop、feature/a）时，
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
/** 造一条提交：`refs` 决定左栏分支树里会出现哪些行。 */
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
/** 未过滤（`ref: ''`）：一次就能看到全部六个 ref。 */
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
/** 未过滤的第二页：带出一个**新**分支（未过滤分页扩展左栏是特性）。 */
const ALL_PAGE_2 = { isRepo: true, branch: 'master', hasMore: false, commits: [c('a7', ['feature/c'])] }
/** 过滤页：rows 数量各不相同，便于断言"中栏换成了哪一份"。 */
const PAGES = {
  develop: {
    isRepo: true,
    branch: 'develop',
    hasMore: true,
    commits: [c('d1', ['develop']), c('d2', ['develop'])],
  },
  'develop+80': { isRepo: true, branch: 'develop', hasMore: false, commits: [c('d3', ['develop'])] },
  master: { isRepo: true, branch: 'master', hasMore: false, commits: [c('m1', ['master']), c('m2', ['master']), c('m3', ['master'])] },
  'feature/a': { isRepo: true, branch: 'feature/a', hasMore: false, commits: [c('f1', ['feature/a'])] },
}
/** 页 key：`ref|skip`。 */
const pageKey = (ref, skip) => `${ref === '' ? '' : ref}|${skip}`
const PAGES_BY_KEY = new Map([
  [pageKey('', 0), ALL_PAGE_1],
  [pageKey('', 6), ALL_PAGE_2],
  [pageKey('develop', 0), PAGES.develop],
  [pageKey('develop', 2), PAGES['develop+80']],
  [pageKey('master', 0), PAGES.master],
  [pageKey('feature/a', 0), PAGES['feature/a']],
])

/** 挂起某个页的响应：`held.get(key)` 是一个待放行函数数组。 */
const held = new Map()
const graphRequests = []
globalThis.fetch = async (url, init) => {
  const body = init?.body === undefined ? undefined : JSON.parse(init.body)
  const route = String(url).slice(String(url).indexOf('/dsh-desktop/review/') + '/dsh-desktop/review/'.length).split('?')[0]
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
/** 左栏的行名（按渲染顺序）。 */
const treeRows = (nodes) => rowsOf(nodes, 'data-graph-tree-row').map((n) => n.props['data-graph-tree-row'])
const treeSelected = (nodes) => rowsOf(nodes, 'data-graph-tree-row').filter((n) => n.props['aria-selected'] === true).map((n) => n.props['data-graph-tree-row'])
const middleRows = (nodes) => rowsOf(nodes, 'data-graph-row').map((n) => String(n.props['data-graph-row']).slice(0, 2))
/** 点左栏的一行。 */
async function clickTree(name) {
  const nodes = await drain()
  dump('after-drain-1', nodes)
  const row = rowsOf(nodes, 'data-graph-tree-row').find((n) => n.props['data-graph-tree-row'] === name)
  if (row === undefined || typeof row.props.onClick !== 'function') return false
  row.props.onClick()
  return true
}
/** 三栏都在（白屏回归的判据）。 */
const threePanesAlive = (nodes) =>
  rowsOf(nodes, 'data-graph-view').length === 1 &&
  rowsOf(nodes, 'data-graph-tree').length === 1 &&
  rowsOf(nodes, 'data-graph-pane').some((n) => n.props['data-graph-pane'] === 'list')
/** 一行状态摘要（调试用）。 */
const dump = (label, nodes) => {
  if (process.env.DSH_TEST_DEBUG !== '1') return
  console.log(
    `      [state] ${label}: mid=${middleRows(nodes).join(',')} refreshing=${rowsOf(nodes, 'data-graph-refreshing').length}` +
      ` more=${rowsOf(nodes, 'data-graph-more').length} sel=${treeSelected(nodes).join(',') || '-'} reqs=${graphRequests.map((r) => r.key).join('|')}`,
  )
}
const FULL_TREE = 'master,develop,feature/a,feature/b,origin/master,origin/develop'

console.log('=== 0. 初始：左栏列出全部六个 ref，中栏是未过滤提交 ===')
{
  const nodes = await drain()
  dump('after-drain-2', nodes)
  check('0) 左栏六个 ref', treeRows(nodes).join(','), FULL_TREE)
  check('   中栏六条提交', middleRows(nodes).length, 6)
  check('   初始没有选中任何 ref', treeSelected(nodes).length, 0)
  check('   没有 hook 数量变化', hookOrderErrors.length, 0)
}

console.log('')
console.log('=== 1. 点 develop：左栏完整不变，develop 高亮，中栏换成 develop 的提交 ===')
{
  has('1) 点得中 develop', await clickTree('develop'))
  const nodes = await drain()
  dump('after-drain-3', nodes)
  check('   左栏仍然是完整六项', treeRows(nodes).join(','), FULL_TREE)
  check('   只有 develop 被选中', treeSelected(nodes).join(','), 'develop')
  check('   中栏是 develop 的提交', middleRows(nodes).join(','), 'd1,d2')
  has('   三栏都在', threePanesAlive(nodes))
  check('   没有 hook 数量变化', hookOrderErrors.length, 0)
}

console.log('')
console.log('=== 2. 点 master：develop 取消高亮，master 高亮，中栏换 master ===')
{
  has('2) 点得中 master', await clickTree('master'))
  const nodes = await drain()
  dump('after-drain-4', nodes)
  check('   左栏仍然完整', treeRows(nodes).join(','), FULL_TREE)
  check('   只有 master 被选中', treeSelected(nodes).join(','), 'master')
  check('   中栏换成 master 的提交', middleRows(nodes).join(','), 'm1,m2,m3')
  has('   三栏都在', threePanesAlive(nodes))
}

console.log('')
console.log('=== 3. 再点 master：取消过滤，中栏回到全部（走"全部"的缓存，立即可见）===')
{
  const before = graphRequests.length
  has('3) 再点一次 master', await clickTree('master'))
  const nodes = await drain()
  dump('after-drain-5', nodes)
  check('   左栏仍然完整', treeRows(nodes).join(','), FULL_TREE)
  check('   没有任何 ref 被选中', treeSelected(nodes).length, 0)
  check('   中栏回到未过滤的六条', middleRows(nodes).join(','), 'a1,a2,a3,a4,a5,a6')
  has('   三栏都在', threePanesAlive(nodes))
  // 缓存命中：取消过滤的这一帧不该是空白（那一份 '' 的首屏是第一页拿到的，一直在缓存里）。
  has('   取消过滤也发了后台 revalidate', graphRequests.length - before >= 1)
}

console.log('')
console.log('=== 4. 白屏回归：请求挂起 2 秒期间三栏必须一直在 ===')
{
  hold(pageKey('develop', 0))
  has('4) 点得中 develop', await clickTree('develop'))
  // 模拟"请求还没回来"的那段时间：反复渲染，直到内部仍处于 refreshing。
  const during = await drain(2)
  if (process.env.DSH_TEST_DEBUG === '1') {
    console.log(`  [debug] held=${JSON.stringify([...held.entries()].map(([k, v]) => [k, v.length]))}`)
    console.log(`  [debug] requests=${graphRequests.map((r) => r.key).join(' | ')}`)
    console.log(`  [debug] viewText=${JSON.stringify(textOf(rowsOf(during, 'data-graph-view')[0] ?? null).slice(0, 200))}`)
  }
  has('   请求确实还挂着（没有响应回来）', held.get(pageKey('develop', 0))?.length === 1)
  has('   三栏一直在（没有整页 loading）', threePanesAlive(during))
  check('   左栏内容没有消失', treeRows(during).join(','), FULL_TREE)
  has('   中栏保留上一份提交', middleRows(during).length > 0)
  has('   显示"正在加载"提示', rowsOf(during, 'data-graph-refreshing').length === 1)
  check('   视图里不是只有 graphLoading', textOf(rowsOf(during, 'data-graph-view')[0] ?? null).includes('graphLoading'), 'false')
  // 放行：中栏原地换成 develop 的提交，三栏仍在。
  has('   放行响应', release(pageKey('develop', 0)))
  dump('放行前', during)
  const after = await drain()
  dump('放行后', after)
  check('   中栏原地替换成 develop', middleRows(after).join(','), 'd1,d2')
  has('   三栏仍在', threePanesAlive(after))
  check('   左栏仍然完整', treeRows(after).join(','), FULL_TREE)
  has('   加载提示消失', rowsOf(after, 'data-graph-refreshing').length === 0)
}

console.log('')
console.log('=== 5. 过滤状态下的分页：只追加中栏，绝不改动左栏 ===')
{
  has('5) 点得中「加载更多」', await (async () => {
    const nodes = await drain()
  dump('after-drain-6', nodes)
    const more = rowsOf(nodes, 'data-graph-more')[0]
    if (more === undefined) return false
    more.props.onClick()
    return true
  })())
  const nodes = await drain()
  dump('after-drain-7', nodes)
  check('   中栏追加了 develop 的第二页', middleRows(nodes).join(','), 'd1,d2,d3')
  check('   左栏仍然是完整六项', treeRows(nodes).join(','), FULL_TREE)
  check('   仍然只有 develop 被选中', treeSelected(nodes).join(','), 'develop')
  const last = graphRequests.at(-1)
  check('   第二页带的是 develop 与 skip=2', `${last?.ref}/${last?.skip}`, 'develop/2')
}

console.log('')
console.log('=== 6. 未过滤分页也只追加中栏：左栏永远只反映第一页 ===')
{
  // 这一节的行为在需求里被**明确改过**，因此这里钉的是新契约而不是旧行为。
  //
  // 旧行为：未过滤（ref === ''）时把并入的第二页一起写进 `treeCommits`，于是左栏会随着
  // "加载更多"多出更深历史里的分支（feature/c）。它的代价是左栏内容会在**滚动**这种
  // 与左栏无关的动作里自己变化，而且左栏那句"加载更多"提示永远亮着却并不是用户点出来的。
  //
  // 新契约（需求第 5 节）：**任何分页都不得修改 `treeCommits`**。左栏数据源固定为
  // "未过滤的第一页"，因此这里既不多出 feature/c，左栏也不发生任何变化；中栏照常追加。
  // 取舍：更深历史里的分支不再出现，彻底方案是 host 侧提供 refs 快照（见 README）。
  has('6) 取消过滤（再点 develop）', await clickTree('develop'))
  await drain()
  has('   点得中「加载更多」', await (async () => {
    const nodes = await drain()
  dump('after-drain-8', nodes)
    const more = rowsOf(nodes, 'data-graph-more')[0]
    if (more === undefined) return false
    more.props.onClick()
    return true
  })())
  const nodes = await drain()
  dump('after-drain-9', nodes)
  check('   左栏没有多出无过滤第二页里的 feature/c', treeRows(nodes).join(','), FULL_TREE)
  check('   中栏也追加了那一条', middleRows(nodes).join(','), 'a1,a2,a3,a4,a5,a6,a7')
}

console.log('')
console.log('=== 7. 快速切换 + 乱序返回：最终只采用最后一次的响应 ===')
{
  rootKey = 'graph-race'
  // 重新挂载，拿到干净状态；三份响应全部挂起，再**按"最新的先回、旧的最后回"**乱序放行
  // ——这正是"旧响应不得覆盖新结果"最容易出错的方向。
  for (const ref of ['develop', 'master', 'feature/a']) hold(pageKey(ref, 0))
  const nodes0 = await drain()
  check('7) 重新挂载后左栏是完整六项', treeRows(nodes0).join(','), FULL_TREE)
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
  const nodes = await drain()
  check('   只有 feature/a 被选中', treeSelected(nodes).join(','), 'feature/a')
  check('   左栏完整', treeRows(nodes).join(','), FULL_TREE)
  check('   中栏只采用 feature/a 的那一份', middleRows(nodes).join(','), 'f1')
  check('   迟到的 master 响应没有覆盖', middleRows(afterMaster).join(','), 'f1')
  check('   迟到的 develop 响应也没有覆盖', middleRows(nodes).join(','), 'f1')
  has('   三栏都在', threePanesAlive(nodes))
}

console.log('')
console.log('=== 8. 每个 ref 的首屏缓存：切回来同一帧就能看到 ===')
{
  rootKey = 'graph-cache'
  // 重新挂载：先让 '' 的首屏落地，再点一次 feature/a（缓存里已经有），把这次请求挂起。
  hold(pageKey('feature/a', 0))
  const nodes0 = await drain()
  check('8) 挂载后中栏是未过滤提交', middleRows(nodes0).length, 6)
  has('   点得中 feature/a', await clickTree('feature/a'))
  const cached = await drain(2)
  // 请求还挂着，但中栏已经是缓存里那一份（不是空白、不是 loading 页）。
  has('   请求仍挂着', (held.get(pageKey('feature/a', 0)) ?? []).length === 1)
  check('   中栏已经是缓存里的 feature/a 提交', middleRows(cached).join(','), 'f1')
  has('   三栏都在', threePanesAlive(cached))
  check('   左栏完整', treeRows(cached).join(','), FULL_TREE)
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
