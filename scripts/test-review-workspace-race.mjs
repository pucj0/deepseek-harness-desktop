// review 的**共享快照**回归：外部数字与抽屉列表必须来自同一份数据，且切项目不串数据。
//
//   node scripts/test-review-workspace-race.mjs
//
// 覆盖三组反馈：
//   1. "外面显示 0，进去却有文件" —— 入口按钮的数字与抽屉里的文件列表以前是**两套轮询**
//      （入口每 10s 打 `/workspace`，抽屉里的"变更"区块走 `/status`），现在必须同源：
//      数字 == `files.length` == 页签里列出的行数；
//   2. A → B → A 的快速切换 —— 陈旧的、乱序的响应都不许落地（工作区级快照 + 提交图各有
//      自己的代际判定）；
//   3. 提交图的 reload / loadMore —— 新一轮加载一旦开始，在途的"加载更多"必须作废，
//      否则会把两批不同筛选条件的提交混在一起。
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
    // 依赖变化时先跑上一次的清理（真实 React 的顺序）：document 级监听的旧闭包不清理会
    // 一直挂着，表现为"关掉的菜单又响应了 Esc"。
    if (typeof prev?.cleanup === 'function') {
      try {
        prev.cleanup()
      } catch {
        // 清理抛错不该影响渲染。
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
    // 真的订阅（共享 store 靠"第一个订阅者"启动加载），并在 subscribe 身份变化时先退订。
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

// ---- 假 DOM ----------------------------------------------------------------------
const domListeners = new Map()
/** localStorage 的记录（分栏宽度/折叠状态要持久化，这里断言真的写进去了）。 */
const stored = new Map()
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
/** 往 document 上派发一个事件（分栏拖动的 mousemove/mouseup 挂在 document 上）。 */
const emitDocument = (type, event) => {
  for (const handler of [...(domListeners.get(type) ?? [])]) handler(event)
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
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#ffffff' })
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

// ---- 假 host ---------------------------------------------------------------------
const A = 'F:\\code\\projA'
const B = 'F:\\code\\projB'
/** 一个文件的形状与 `/workspace` 一致（含索引态）。 */
const file = (path, extra) => ({ path, status: 'M', added: 1, removed: 0, staged: false, unstaged: true, untracked: false, ...extra })
/** 每个工作区的当前响应（测试中途会改它，模拟"新增/删除/未跟踪"）。 */
const workspaceData = new Map([
  [A, { isRepo: true, branch: 'alpha', head: 'a'.repeat(40), files: [file('a.txt'), file('b.txt'), file('c.txt')], diff: '', truncated: false }],
  [B, { isRepo: true, branch: 'beta', head: 'b'.repeat(40), files: [file('z.txt')], diff: '', truncated: false }],
])
/** 提交图：每个工作区一页数据。 */
const graphData = new Map([
  [A, { isRepo: true, commits: [{ hash: 'a1'.repeat(20), short: 'a1', parents: [], author: 't', committedAt: '2026-01-02T00:00:00+08:00', subject: 'A one', refs: [] }], hasMore: true }],
  [B, { isRepo: true, commits: [{ hash: 'b1'.repeat(20), short: 'b1', parents: [], author: 't', committedAt: '2026-01-02T00:00:00+08:00', subject: 'B one', refs: [] }], hasMore: true }],
])
/** `ref` 过滤后的第二页（用于 loadMore 的夹具）。 */
const graphPage2 = {
  [A]: { isRepo: true, commits: [{ hash: 'a2'.repeat(20), short: 'a2', parents: [], author: 't', committedAt: '2026-01-01T00:00:00+08:00', subject: 'A two', refs: [] }], hasMore: false },
}
/** 按 `ref` 过滤后的一页（`ref=other` 时用）。 */
const graphFiltered = { isRepo: true, commits: [{ hash: 'c1'.repeat(20), short: 'c1', parents: [], author: 't', committedAt: '2026-01-03T00:00:00+08:00', subject: 'filtered', refs: [] }], hasMore: false }

const requests = []
const pending = []
/** 挂起判定：返回 true 表示这次请求被挂起，测试自己放行。 */
let hold = () => false
function release(route, workspace) {
  const index = pending.findIndex((item) => item.route === route && (workspace === undefined || item.workspace === workspace))
  if (index < 0) throw new Error(`没有挂起的请求：${route} ${workspace ?? ''}`)
  const [item] = pending.splice(index, 1)
  item.resolve(item.payload)
  return item
}
/** 放行一个挂起请求，但用**另一个**响应体（模拟"迟到的旧数据"）。 */
function releaseWith(route, workspace, payload) {
  const index = pending.findIndex((item) => item.route === route && (workspace === undefined || item.workspace === workspace))
  if (index < 0) throw new Error(`没有挂起的请求：${route} ${workspace ?? ''}`)
  const [item] = pending.splice(index, 1)
  item.resolve(payload)
  return item
}

globalThis.fetch = async (url, init) => {
  const target = String(url)
  const route = target.slice(target.indexOf('/dsh-desktop/review/') + '/dsh-desktop/review/'.length)
  const body = init?.body === undefined ? undefined : JSON.parse(init.body)
  const workspace = body?.workspace ?? ''
  requests.push({ route, workspace })
  let payload
  if (route === 'roots') payload = { roots: [A, B], current: A }
  else if (route === 'workspace') payload = workspaceData.get(workspace) ?? { isRepo: false }
  else if (route === 'graph') {
    if (body?.ref !== undefined && body.ref !== '') payload = graphFiltered
    else if ((body?.skip ?? 0) > 0) payload = graphPage2[workspace] ?? { isRepo: true, commits: [], hasMore: false }
    else payload = graphData.get(workspace) ?? { isRepo: true, commits: [], hasMore: false }
  } else payload = { isRepo: true }
  if (hold(route, workspace, body)) {
    return await new Promise((resolve) => {
      pending.push({
        route,
        workspace,
        payload,
        resolve: (value) => resolve({ ok: true, text: async () => JSON.stringify(value) }),
      })
    })
  }
  return { ok: true, text: async () => JSON.stringify(payload) }
}

// ---- 加载插件 -------------------------------------------------------------------
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
      entries.set(`${options.name}:${options.id ?? options.key}`, { component, options })
      return () => {}
    },
  },
  sidebarRight: {},
  sidebarRightTabs: { register: () => () => {} },
  sessions: {},
  workspaces: {},
  layout: { selectPanel() {} },
}
loaded.apply(ctx)

let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
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

const store = loaded.__gitSnapshotForTest
const Hero = entries.get('shell.overlay:review-project-changes').component

// ---- 渲染 -----------------------------------------------------------------------
let sessionWorkspace = A
const makeSelectorHook = (read) => (selector) =>
  react.useSyncExternalStore(
    () => () => {},
    () => selector(read()),
  )
const t = (key, params) => {
  if (params === undefined) return key
  return `${key}(${Object.entries(params).map(([name, value]) => `${name}=${value}`).join(',')})`
}
const heroProps = {
  t,
  sessionId: 's1',
  useSessions: makeSelectorHook(() => ({ current: 's1', byId: { s1: { cwd: sessionWorkspace } } })),
}
let mountSeq = 0
let rootKey = ''

async function settle(passes = 4) {
  let nodes = []
  for (let pass = 0; pass < passes; pass += 1) {
    const queued = []
    const { tree, effects } = render(Hero, heroProps, rootKey)
    queued.push(...effects)
    nodes = collectHostNodes(tree, rootKey, queued)
    for (const effect of queued) effect()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return nodes
}
async function mount() {
  rootKey = `hero${mountSeq++}`
  return settle()
}
const find = (attr, value, nodes) =>
  (nodes ?? collectHostNodes(render(Hero, heroProps, rootKey).tree, rootKey)).find((node) =>
    value === undefined ? node.props?.[attr] !== undefined : node.props?.[attr] === value,
  ) ?? null
const findAll = (attr, nodes) =>
  (nodes ?? collectHostNodes(render(Hero, heroProps, rootKey).tree, rootKey)).filter((node) => node.props?.[attr] !== undefined)
/**
 * 入口按钮上的文案（含文件数）。
 *
 * 必须**展开整棵子树**再取文本：入口按钮现在是一个独立组件
 * （`ProjectChangesTriggerButton`，与面板做故障隔离），而 `textOf` 只认已经展开的宿主节点
 * ——直接对 `[data-review-trigger]` 那个 div 调 textOf 会得到空串（组件元素的 props.children
 * 是 undefined），断言会全部误红。
 */
const badgeText = (nodes) => {
  const node = find('data-review-trigger', undefined, nodes) ?? find('data-review-trigger')
  if (node === null || node === undefined) return ''
  return collectHostNodes(node, 'badge').map((entry) => textOf(entry)).join(' ')
}
const badge = (nodes) => find('data-review-trigger', undefined, nodes) ?? find('data-review-trigger')

/** 打开抽屉（入口按钮自己就是开关）。 */
async function openDrawer() {
  let nodes = await settle()
  if (!nodes.some((n) => n.props?.['data-desktop-review-surface'] === 'panel')) {
    const node = nodes.find((n) => n.props?.['data-review-trigger'] !== undefined)
    const button = collectHostNodes(node, 'probe').find((n) => n.props?.type === 'button') ?? node
    button.props.onClick()
    nodes = await settle()
  }
  return nodes
}

console.log('=== 1. 外部数字与抽屉列表同源 ===')
{
  let nodes = await mount()
  // 快照对象的形状就是这套设计的对外契约（`useWorkspaceGitSnapshot` 返回它）。
  const snap = store.get(A)
  check('1) 快照带 workspace', snap.workspace, A)
  check('   快照带 phase', snap.phase, 'ready')
  check('   快照带 branch / head', `${snap.branch}/${snap.head.length}`, `alpha/${40}`)
  check('   快照的三组数量与文件列表同源', `${snap.changedFiles}/${snap.staged}/${snap.unstaged}/${snap.untracked}`, '3/0/3/0')
  checkTrue('   快照暴露 refresh()', typeof snap.refresh === 'function')
  checkTrue('   快照暴露 invalidate()', typeof snap.invalidate === 'function')
  checkTrue('   快照带 updatedAt', typeof snap.updatedAt === 'number' && snap.updatedAt > 0)
  check('   入口徽章显示文件数', badgeText(nodes).includes('files(count=3)'), 'true')
  nodes = await openDrawer()
  check('   抽屉已打开', nodes.some((n) => n.props?.['data-desktop-review-surface'] === 'panel'), 'true')
  // 头栏计数、页签里的行数、入口上的数字必须**完全相等**——它们读的是同一份快照。
  const headerCount = textOf(find('data-review-count', undefined, nodes))
  check('   头栏计数', headerCount, '3')
  check('   Changes 页签里列出的文件行数', findAll('data-staging-row', nodes).length, 3)
  check('   入口数字与抽屉一致', badgeText(nodes).includes('files(count=3)'), 'true')
  // 只应有一个 `/workspace` 请求（同一个数据源、一份轮询）。
  check('   只请求了一次快照', requests.filter((r) => r.route === 'workspace').length, 1)
}

console.log('')
console.log('=== 2. 新增 / 删除 / 未跟踪：两处同步变化 ===')
{
  // 新增一个已跟踪文件、删掉一个、再来一个未跟踪文件。
  workspaceData.set(A, {
    isRepo: true,
    branch: 'alpha',
    head: 'c'.repeat(40),
    files: [
      file('b.txt'),
      file('c.txt', { staged: true, unstaged: false }),
      file('new.txt', { status: 'A', staged: false, unstaged: false, untracked: true }),
    ],
    diff: '',
    truncated: false,
  })
  // 写操作成功后的动作就是这一次 invalidate（见 StagingSection.run）。
  await store.invalidate(A)
  let nodes = await settle()
  check('2) 入口徽章变成 3', badgeText(nodes).includes('files(count=3)'), 'true')
  check('   删除的那个文件不在列表里', findAll('data-staging-row', nodes).some((n) => n.props['data-staging-row'] === 'a.txt'), 'false')
  check('   新增的未跟踪文件在未跟踪组里', findAll('data-staging-row', nodes).some((n) => n.props['data-staging-row'] === 'new.txt' && n.props['data-staging-side'] === 'untracked'), 'true')
  check('   头栏计数仍是 3', textOf(find('data-review-count', undefined, nodes)), '3')
  // 再改成 1 个文件：两处都要跟着变（这才是"同步变化"）。
  workspaceData.set(A, { isRepo: true, branch: 'alpha', head: 'd'.repeat(40), files: [file('b.txt')], diff: '', truncated: false })
  await store.invalidate(A)
  nodes = await settle()
  check('   入口徽章跟着变成 1', badgeText(nodes).includes('files(count=1)'), 'true')
  check('   头栏计数跟着变成 1', textOf(find('data-review-count', undefined, nodes)), '1')
  check('   列表只剩一行', findAll('data-staging-row', nodes).length, 1)
  // 回到 3 个文件，后面的小节继续用。
  workspaceData.set(A, { isRepo: true, branch: 'alpha', head: 'a'.repeat(40), files: [file('a.txt'), file('b.txt'), file('c.txt')], diff: '', truncated: false })
  await store.invalidate(A)
  await settle()
}

console.log('')
console.log('=== 3. A 与 B 的迟到响应互不覆盖（各自按工作区落库）===')
{
  rootKey = `hero${mountSeq++}`
  // 丢掉前面小节留下的订阅与缓存：这一节要观察"首次订阅就会去取快照"这条链路。
  store.reset()
  let phase = 'a-hold'
  hold = (route, workspace) => {
    if (route !== 'workspace') return false
    if (workspace === A) return phase === 'a-hold'
    return workspace === B && phase === 'b-hold'
  }
  // A 的首次请求被挂起；切到 B（也挂起）；放行 B；再放行 A。全程两个工作区的数据
  // 都不许串——这是"共享快照按 workspace 分库 > 代际判定"的直接体现。
  sessionWorkspace = A
  await mount()
  check('3) A 的数据未到时徽章是"暂无改动"', badgeText().includes('projectIdle'), 'true')

  phase = 'b-hold'
  sessionWorkspace = B
  let nodes = await settle()
  check('   切到 B 且未就绪时不显示 A 的分支', badgeText(nodes).includes('files(count=3)'), 'false')

  release('workspace', B)
  nodes = await settle()
  check('   B 的数据就位（1 个文件）', badgeText(nodes).includes('files(count=1)'), 'true')
  nodes = await openDrawer()
  check('   抽屉里是 B 的分支数据', findAll('data-staging-row', nodes).map((n) => n.props['data-staging-row']).join(','), 'z.txt')

  // 切回 A：A 的那次请求仍然在飞（single-flight 复用），放行它就应该看到 A 的数据。
  phase = 'final'
  sessionWorkspace = A
  nodes = await settle()
  check('   切回 A 未就绪时不再显示 B 的文件', findAll('data-staging-row', nodes).some((n) => n.props['data-staging-row'] === 'z.txt'), 'false')
  releaseWith('workspace', A, { isRepo: true, branch: 'alpha', head: 'a'.repeat(40), files: [file('a.txt'), file('b.txt'), file('c.txt')], diff: '', truncated: false })
  nodes = await settle()
  check('   放行后 A 的数据就位', badgeText(nodes).includes('files(count=3)'), 'true')
  check('   抽屉里是 A 的文件', findAll('data-staging-row', nodes).map((n) => n.props['data-staging-row']).join(','), 'a.txt,b.txt,c.txt')
  // 迟到的 B 响应（如果有）也不许改写 A 的界面。
  nodes = await settle()
  check('   A 的界面里没有 B 的文件', findAll('data-staging-row', nodes).some((n) => n.props['data-staging-row'] === 'z.txt'), 'false')
}

console.log('')
console.log('=== 3b. 同一个工作区：过期的响应不许覆盖更新的一次 ===')
{
  // 夹具先改成 2 个文件，制造"新旧两份数据"。
  workspaceData.set(A, { isRepo: true, branch: 'old', head: '0'.repeat(40), files: [file('old.txt')], diff: '', truncated: false })
  await store.invalidate(A)
  await settle()
  // 让下一次请求挂起（它就是"旧的那一次"）。
  hold = (route, workspace) => route === 'workspace' && workspace === A
  const stale = store.invalidate(A) // 在途：返回的 promise 一直不 resolve
  await settle(1)
  // 再发一次（换代）：这次立即返回，且响应体是新的那份数据。
  hold = () => false
  workspaceData.set(A, { isRepo: true, branch: 'fresh', head: '1'.repeat(40), files: [file('p.txt'), file('q.txt'), file('r.txt'), file('s.txt')], diff: '', truncated: false })
  await store.invalidate(A)
  let nodes = await settle()
  check('3b) 新数据就位', badgeText(nodes).includes('files(count=4)'), 'true')
  // 放行那个过期的请求：它的代际已经落后，必须被丢弃。
  releaseWith('workspace', A, { isRepo: true, branch: 'stale', head: '2'.repeat(40), files: [file('stale.txt')], diff: '', truncated: false })
  nodes = await settle()
  check('   过期响应没有覆盖新数据', badgeText(nodes).includes('files(count=4)'), 'true')
  check('   分支也还是新的那一个', store.get(A).branch, 'fresh')
  await stale
}

console.log('')
console.log('=== 4. 提交图：reload 抢占 loadMore（迟到的追加不许落地）===')
{
  const Graph = loaded.__commitGraphViewForTest
  const key = 'graph0'
  const props = { t, workspace: A, refreshToken: 0 }
  const renderGraph = async (passes = 4) => {
    let nodes = []
    for (let pass = 0; pass < passes; pass += 1) {
      const queued = []
      const { tree, effects } = render(Graph, props, key)
      queued.push(...effects)
      nodes = collectHostNodes(tree, key, queued)
      for (const effect of queued) effect()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    return nodes
  }
  const rowHashes = (nodes) => nodes.filter((n) => n.props?.['data-graph-row'] !== undefined).map((n) => n.props['data-graph-row'])

  hold = () => false
  let nodes = await renderGraph()
  check('4) 第一页已渲染', rowHashes(nodes).join(','), 'a1'.repeat(20))
  check('   有「加载更多」', nodes.some((n) => n.props?.['data-graph-more'] !== undefined), 'true')
  // 让 loadMore 挂起，然后**在同一次挂载里**触发一次真正的 reload（`refreshToken` 变化，
  // 例如用户刚提交完），它会把 `graph` 这一分片抢占过去。
  hold = (route, workspace, body) => route === 'graph' && (body?.skip ?? 0) > 0
  const moreButton = nodes.find((n) => n.props?.['data-graph-more'] !== undefined)
  moreButton.props.onClick()
  await renderGraph(1)
  check('   加载更多已发出（挂起中）', pending.some((p) => p.route === 'graph'), 'true')
  hold = () => false
  props.refreshToken = 1
  nodes = await renderGraph()
  check('   reload 后重新拉第一页', nodes.some((n) => n.props?.['data-graph-row'] === 'a1'.repeat(20)), 'true')
  // 放行那个迟到的 loadMore：它属于**上一轮**（`graph` 分片已被新的 reload 抢占），
  // 因此不许把第二页追加进来——否则两批不同筛选条件/不同时间点的提交会混在一张图里。
  release('graph')
  nodes = await renderGraph()
  check('   迟到的 loadMore 没有追加', rowHashes(nodes).join(','), 'a1'.repeat(20))
  check('   也没有出现第二页的提交', nodes.some((n) => n.props?.['data-graph-row'] === 'a2'.repeat(20)), 'false')
}

console.log('')
console.log('=== 5. 提交图：切工作区后迟到的响应不许覆盖 ===')
{
  const Graph = loaded.__commitGraphViewForTest
  const key = `graph-switch`
  const props = { t, workspace: A }
  const renderGraph = async (workspace, passes = 4) => {
    props.workspace = workspace
    let nodes = []
    for (let pass = 0; pass < passes; pass += 1) {
      const queued = []
      const { tree, effects } = render(Graph, props, key)
      queued.push(...effects)
      nodes = collectHostNodes(tree, key, queued)
      for (const effect of queued) effect()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    return nodes
  }
  const subjects = (nodes) => nodes.filter((n) => n.props?.['data-graph-row'] !== undefined).length
  // A 的 graph 挂起，切到 B（立即返回），再放行 A。
  hold = (route, workspace) => route === 'graph' && workspace === A
  await renderGraph(A)
  let nodes = await renderGraph(B)
  check('5) 切到 B 后渲染的是 B 的提交', nodes.some((n) => n.props?.['data-graph-row'] === 'b1'.repeat(20)), 'true')
  release('graph', A)
  nodes = await renderGraph(B)
  check('   A 的迟到响应没覆盖 B', nodes.some((n) => n.props?.['data-graph-row'] === 'b1'.repeat(20)), 'true')
  check('   也没有混进 A 的提交', nodes.some((n) => n.props?.['data-graph-row'] === 'a1'.repeat(20)), 'false')
  check('   提交行数仍是 1', subjects(nodes), 1)
}

console.log('')
console.log('=== 6. Log 页签的三栏：拖动分栏（持久化）、搜索、收起 ===')
{
  const Graph = loaded.__commitGraphViewForTest
  const key = 'graph-panes'
  const props = { t, workspace: A, refreshToken: 0 }
  const renderGraph = async (passes = 4) => {
    let nodes = []
    for (let pass = 0; pass < passes; pass += 1) {
      const queued = []
      const { tree, effects } = render(Graph, props, key)
      queued.push(...effects)
      nodes = collectHostNodes(tree, key, queued)
      for (const effect of queued) effect()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    return nodes
  }
  const paneFlex = (nodes, which) =>
    nodes.find((n) => n.props?.['data-graph-pane'] === which)?.props?.style?.flex ?? '(none)'

  hold = () => false
  let nodes = await renderGraph()
  check('6) 左栏默认宽度', paneFlex(nodes, 'tree'), '0 0 200px')
  check('   右栏默认宽度', paneFlex(nodes, 'detail'), '0 0 320px')
  const splitter = nodes.find((n) => n.props?.['data-graph-splitter'] === 'tree')
  splitter.props.onMouseDown({ button: 0, clientX: 500, preventDefault() {} })
  emitDocument('mousemove', { clientX: 560 })
  nodes = await renderGraph(1)
  check('   向右拖 60px 后左栏变宽', paneFlex(nodes, 'tree'), '0 0 260px')
  emitDocument('mouseup', {})
  check('   松手后宽度已持久化', stored.get('dsh.review.graphTreeWidth'), '260')
  // 收起 / 展开：窄窗口下唯一能保住中间那栏可读的办法。
  const collapseTree = nodes.find((n) => n.props?.['data-graph-tool'] === 'tree')
  collapseTree.props.onClick()
  nodes = await renderGraph(1)
  check('   收起后左栏消失', paneFlex(nodes, 'tree'), '(none)')
  check('   中间那栏仍在', nodes.some((n) => n.props?.['data-graph-pane'] === 'list'), 'true')
  check('   折叠状态已持久化', stored.get('dsh.review.graphCollapse'.replace('Collapse', 'Collapsed')), '{"tree":true,"detail":false}')
  nodes.find((n) => n.props?.['data-graph-tool'] === 'tree').props.onClick()
  nodes = await renderGraph(1)
  check('   再点展开', paneFlex(nodes, 'tree'), '0 0 260px')
  // 搜索：过滤**已加载**的提交。
  const search = nodes.find((n) => n.props?.['data-graph-search'] !== undefined)
  check('   顶部有搜索框', search !== undefined, 'true')
  search.props.onChange({ target: { value: 'zzz' } })
  nodes = await renderGraph(1)
  check('   搜不到时没有提交行', nodes.filter((n) => n.props?.['data-graph-row'] !== undefined).length, 0)
  nodes.find((n) => n.props?.['data-graph-search'] !== undefined).props.onChange({ target: { value: 'A one' } })
  nodes = await renderGraph(1)
  check('   搜到一条', nodes.filter((n) => n.props?.['data-graph-row'] !== undefined).length, 1)
}

console.log('')
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
