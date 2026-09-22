// 分支行的 **IDEA 风格交互**回归：单击选中并开菜单、双击才切换、右键同一套菜单。
//
//   node scripts/test-gitbar-branch-interaction.mjs
//
// 为什么需要它：这三条交互里最容易悄悄坏掉的是"单击延迟"那一环——真实浏览器在双击时**先
// 派发两次 click 再派发 dblclick**，如果单击立刻弹菜单，用户双击时会看到菜单闪一下再切走；
// 如果第二次 click 不取消定时器，还会多弹一次菜单甚至多切一次分支。这些都只有把**完整的
// 事件序列**按真实顺序派发才能测出来，所以这里不点 `onClick` 就完事，而是 click/click/dblclick
// 依次送达，并用真实定时器等过那 200ms。
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PLUGIN = pathToFileURL(join(ROOT, 'plugins', 'dsh-client-ui-gitbar', 'lib', 'client.js')).href

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
    // 依赖变了要先跑上一次的清理，再排队新的——真实 React 就是这个顺序。少了这一步，
    // document 上的旧监听会**一直挂着**：面板的 Esc 处理器依赖 `[open, menu, dialog]`，
    // 于是"菜单已打开"的新处理器和"菜单为 null"的旧处理器会同时收到 Esc，后者直接把面板
    // 关掉（实测踩到过：一次 Esc 之后整块面板消失了）。
    if (typeof prev?.cleanup === 'function') {
      try {
        prev.cleanup()
      } catch {
        // 清理函数里抛错不该影响渲染：真实 React 也只是把它报出来。
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

function collectHostNodes(node, key = 'bar', queued) {
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
/** 往 document 上派发一个事件（面板的 Esc / 点击外部判定都挂在 document 上）。 */
const emitDocument = (type, event) => {
  for (const handler of domListeners.get(type) ?? []) handler(event)
}
/** 按 Esc：收起当前的操作菜单（逐层退出里的第一层）。 */
document.emitKeydown = () => emitDocument('keydown', { key: 'Escape', stopPropagation() {} })

// ---- 假 host ---------------------------------------------------------------------
const WORKSPACE = 'F:\\code\\projA'
const status = { isRepo: true, branch: 'main', detached: false, upstream: 'origin/main', ahead: 0, behind: 1, changedFiles: 0, untrackedFiles: 0, upstreamGone: false, merging: false, rebasing: false, head: 'a'.repeat(40) }
const branches = [
  { name: 'main', isRemote: false, current: true, remote: '', upstream: 'origin/main', upstreamGone: false, ahead: 0, behind: 1, diverged: false, syncExact: false, committedAt: '2026-01-02T00:00:00+08:00', hash: 'a'.repeat(40), subject: 'main work' },
  { name: 'develop', isRemote: false, current: false, remote: '', upstream: 'origin/develop', upstreamGone: false, ahead: 2, behind: 0, diverged: false, syncExact: false, committedAt: '2026-01-01T00:00:00+08:00', hash: 'b'.repeat(40), subject: 'dev work' },
  { name: 'origin/develop', isRemote: true, current: false, remote: 'origin', upstream: '', upstreamGone: false, ahead: 0, behind: 0, diverged: false, syncExact: true, committedAt: '2026-01-01T00:00:00+08:00', hash: 'b'.repeat(40), subject: 'dev work' },
]
const posts = []
/**
 * 每一次请求的 `{ route, repository }`。
 *
 * 多仓库项目的关键不变量是"这次操作的是哪个仓库"，而它**只**体现在 `?repository=` 上
 * （见 review/gitbar 宿主侧的 resolveScopedRepo）。因此这里记录的是 URL 查询参数，
 * 不是请求体——gitbar 的写操作也走 query（body 只放标量名字）。
 */
const queries = []
globalThis.fetch = async (url, init) => {
  const target = new URL(String(url), 'http://localhost')
  const route = target.pathname.slice('/dsh-desktop/gitbar/'.length)
  queries.push({ route, repository: target.searchParams.get('repository') })
  if (init?.method === 'POST') {
    posts.push({ route, body: init.body === undefined ? undefined : JSON.parse(init.body) })
    return { ok: true, text: async () => JSON.stringify({ ...status, branchesStale: true, remotes: [] }) }
  }
  const payload = route === 'status' ? status : route === 'branches' ? { branches, counts: { local: 2, remote: 1 } } : route === 'remotes' ? { remotes: [] } : { sync: {} }
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---- 渲染 -----------------------------------------------------------------------
const Chip = entries.get('conversation.input.dock:desktop-context-bar').component
let rootKey = 'branch'
const mountProps = {
  t: (key, params) => {
    if (params === undefined) return key
    return Object.entries(params).reduce((text, [name, value]) => text.split(`{${name}}`).join(String(value)), key)
  },
  sessionId: 's1',
  useSessions: (selector) => selector({ current: 's1', byId: { s1: { cwd: WORKSPACE } } }),
  renderSlot: () => null,
}
async function settle(passes = 3) {
  let nodes = []
  for (let pass = 0; pass < passes; pass += 1) {
    const queued = []
    const { tree, effects } = render(Chip, mountProps, rootKey)
    queued.push(...effects)
    nodes = collectHostNodes(tree, rootKey, queued)
    for (const effect of queued) effect()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return nodes
}
const current = async () => settle()
const find = (attr, value, nodes) =>
  (nodes ?? collectHostNodes(render(Chip, mountProps, rootKey).tree, rootKey)).find((node) =>
    value === undefined ? node.props?.[attr] !== undefined : node.props?.[attr] === value,
  ) ?? null
const findAll = (attr, nodes) =>
  (nodes ?? collectHostNodes(render(Chip, mountProps, rootKey).tree, rootKey)).filter((node) => node.props?.[attr] !== undefined)
const menuOpen = async () => (await current()).some((n) => n.props?.['data-desktop-sc-menu'] !== undefined)
/**
 * 一次真实浏览器里的 click。
 *
 * `rect` 是可选的**假行矩形**：桩渲染里没有布局，`getBoundingClientRect` 不会自己给出值，
 * 因此二级菜单的几何断言必须由测试把矩形喂进去（真实浏览器里这个矩形来自被点的那一行）。
 * 不传时 `currentTarget` 为 null——这正是"程序化点击"的形状，代码必须能退化处理。
 */
const clickRow = (row, rect) =>
  row.props.onClick({
    stopPropagation() {},
    preventDefault() {},
    currentTarget: rect === undefined ? null : { getBoundingClientRect: () => rect },
  })
const dblClickRow = (row) => row.props.onDoubleClick({ stopPropagation() {}, preventDefault() {} })
const contextMenuRow = (row) =>
  row.props.onContextMenu({ stopPropagation() {}, preventDefault() {}, clientX: 300, clientY: 300 })

/**
 * 往 document 上派发一个 mousedown（面板的"点外部关闭"判定挂在它上面）。
 *
 * 判定用 `containerRef.current.contains(event.target)`，而桩渲染不会给宿主节点挂 ref——
 * 因此测试得自己把容器 ref 填成一个只有 `contains` 的对象（见 setContainerContains）。
 */
const emitPointerDown = (target) => emitDocument('mousedown', { target })
/** 让"这次点击在不在面板里"由测试决定。 */
const setContainerContains = (list, predicate) => {
  const node = find('data-desktop-branch', undefined, list)
  // 假节点必须同时给出 `getBoundingClientRect`：容器 ref 也被"下拉菜单位置"那个 effect
  // 用来量徽章（`measure()`），只给一个 `contains` 会让它当场抛错。
  node.props.ref.current = {
    contains: predicate,
    getBoundingClientRect: () => ({ left: 200, right: 400, top: 300, bottom: 328, width: 200, height: 28 }),
  }
}
/** 给一级面板喂一个假矩形（真实浏览器里这是 `panelRef.current.getBoundingClientRect()`）。 */
const setPanelRect = (list, rect) => {
  const node = find('data-desktop-branch-menu', undefined, list)
  node.props.ref.current = { getBoundingClientRect: () => rect }
}

/** 收起当前菜单（按 Esc，走逐层退出里的第一层）。 */
const closeMenu = async () => {
  document.emitKeydown()
  return current()
}
/** 确保面板处于打开状态，返回当前界面。 */
const ensurePanel = async () => {
  let list = await current()
  if (!list.some((n) => n.props?.['data-desktop-branch-menu'] !== undefined)) {
    find('data-desktop-branch-trigger', undefined, list).props.onClick()
    list = await settle()
  }
  return list
}
const panelOpen = (list) => list.some((n) => n.props?.['data-desktop-branch-menu'] !== undefined)

console.log('=== 0. 前置：面板打开且列出了分支 ===')
let nodes = await ensurePanel()
check('0) 面板已打开', panelOpen(nodes), 'true')
check('   分支行数', findAll('data-desktop-branch-option', nodes).length >= 3, 'true')
const rowOf = (name, list) => (list ?? nodes).find((n) => n.props['data-desktop-branch-name'] === name)

console.log('')
console.log('=== 1. 单击：只选中 + 延迟打开操作菜单，绝不 checkout ===')
{
  posts.length = 0
  const row = rowOf('develop')
  clickRow(row)
  // 还没到 200ms：菜单**不该**已经弹出来（这正是双击不闪菜单的前提）。
  check('1) 单击后立刻没有菜单', await menuOpen(), 'false')
  check('   单击不产生 checkout', posts.length, 0)
  // 过了单击延迟：菜单出现，且挂在被点的那一行上。
  await sleep(260)
  nodes = await current()
  check('   延迟后菜单打开', nodes.some((n) => n.props?.['data-desktop-sc-menu'] !== undefined), 'true')
  check('   菜单挂在被单击的分支上', find('data-desktop-sc-menu', 'develop', nodes) !== null, 'true')
  check('   仍然没有 checkout', posts.length, 0)
  check('   该行被标记为选中', rowOf('develop', nodes)?.props?.['data-desktop-branch-selected'], 'true')
  check('   该行没有被禁用（当前分支才需要，其它分支更不该）', rowOf('develop', nodes)?.props?.disabled, false)
  // 关掉菜单，避免影响后面的小节。
  nodes = await closeMenu()
}

console.log('')
console.log('=== 2. 双击：只切一次，且全程不弹菜单 ===')
{
  posts.length = 0
  // 真实顺序：click → click → dblclick（浏览器就是这样派发的）。
  nodes = await ensurePanel()
  const row = rowOf('develop', nodes)
  clickRow(row)
  clickRow(row)
  dblClickRow(row)
  // 立刻看一眼：菜单没有在同一帧弹出（单击定时器已被第二次 click 取消）。
  check('2) 双击后立刻没有菜单', (await current()).some((n) => n.props?.['data-desktop-sc-menu'] !== undefined), 'false')
  // 等过单击延迟（200ms）：如果定时器没被取消，菜单就会在这段时间里弹出来。
  await sleep(320)
  nodes = await current()
  check('   等过延迟后也没有菜单', nodes.some((n) => n.props?.['data-desktop-sc-menu'] !== undefined), 'false')
  // 写操作是异步的：等它落地之后只应有**一次** checkout。
  check('   双击只产生一次 checkout', posts.length, 1)
  check('   请求体是分支名', JSON.stringify(posts[0]?.body), '{"branch":"develop"}')
}

console.log('')
console.log('=== 3. 当前分支：单击仍可开菜单，双击什么都不做 ===')
{
  nodes = await ensurePanel()
  const row = rowOf('main', nodes)
  check('3) 当前分支行没有被禁用', row?.props?.disabled, false)
  posts.length = 0
  clickRow(row)
  await sleep(260)
  nodes = await current()
  check('   单击当前分支打开了菜单', find('data-desktop-sc-menu', 'main', nodes) !== null, 'true')
  // 菜单里的「签出」存在但被禁用（禁用而不是隐藏：菜单形状要稳定）。
  const menu = find('data-desktop-sc-menu', 'main', nodes)
  const items = (menu?.props?.children ?? []).filter((child) => child?.props?.['data-desktop-sc-menuitem'] !== undefined)
  const checkoutItem = items.find((child) => child.props['data-desktop-sc-menuitem'] === 'checkout')
  checkTrue('   当前分支的「签出」项存在（形状稳定）', checkoutItem !== undefined)
  check('   但被禁用', checkoutItem?.props?.disabled, true)
  check('   「删除自己」也被禁用', items.find((c) => c.props['data-desktop-sc-menuitem'] === 'delete')?.props?.disabled, true)
  // 双击当前分支：不做任何事。
  posts.length = 0
  clickRow(row)
  dblClickRow(row)
  await sleep(60)
  check('   双击当前分支不产生 checkout', posts.length, 0)
}

console.log('')
console.log('=== 4. 右键：与单击**同一套**菜单 ===')
{
  // 单击打开一次，记下条目与禁用状态。
  const readMenu = async (name) => {
    const list = await current()
    const menu = find('data-desktop-sc-menu', name, list)
    return (menu?.props?.children ?? [])
      .filter((child) => child?.props?.['data-desktop-sc-menuitem'] !== undefined)
      .map((child) => `${child.props['data-desktop-sc-menuitem']}:${child.props.disabled === true ? 'off' : 'on'}`)
  }
  nodes = await ensurePanel()
  posts.length = 0
  clickRow(rowOf('develop', nodes))
  await sleep(260)
  const single = await readMenu('develop')
  check('4) 单击菜单有 7 个条目', single.length, 7)
  // 收起后走右键：同一行、同一套条目。
  nodes = await closeMenu()
  contextMenuRow(rowOf('develop', nodes))
  nodes = await settle()
  check('   右键打开了菜单', find('data-desktop-sc-menu', 'develop', nodes) !== null, 'true')
  const right = await readMenu('develop')
  check('   条目与单击完全一致', right.join(','), single.join(','))
  check(
    '   条目顺序稳定（动作位置可记忆）',
    right.join(','),
    'checkout:on,new-from:on,merge:on,rebase:on,push:on,rename:on,delete:on',
  )
  // 右键菜单里的条目真的能点开对话框（不是只有一个壳）。
  const newFrom = find('data-desktop-sc-menu', 'develop', nodes).props.children.find(
    (child) => child?.props?.['data-desktop-sc-menuitem'] === 'new-from',
  )
  newFrom.props.onClick()
  nodes = await settle()
  check('   点「从它新建分支」打开了对话框', find('data-desktop-sc-dialog', 'create', nodes) !== null, 'true')
  check('   起点预填被右键的分支', find('data-desktop-sc-field', 'from', nodes)?.props?.value, 'develop')
  // 点菜单项必须**立即**把菜单收掉（不能等动作跑完）。
  check('   点菜单项后菜单立刻关闭', find('data-desktop-sc-menu', 'develop', nodes), null)
}

console.log('')
console.log('=== 5. 关闭状态机：再点同一行立即关闭、且不许自己重新弹出来 ===')
{
  // 面板此刻可能被上一节的对话框挡住；清掉对话框状态并确保面板打开。
  nodes = await ensurePanel()
  await sleep(260)
  // 5a. 同一行再点一次 = 关闭，且 200ms 之后**不得**重新出现。
  nodes = await closeMenu()
  clickRow(rowOf('develop', nodes))
  await sleep(260)
  nodes = await current()
  check('5a) 第一次单击打开了菜单', find('data-desktop-sc-menu', 'develop', nodes) !== null, 'true')
  clickRow(rowOf('develop', nodes))
  const afterSecondClick = await current()
  check('   再点同一行后菜单立即消失', find('data-desktop-sc-menu', 'develop', afterSecondClick), null)
  await sleep(320)
  nodes = await current()
  check('   超过单击延迟后也没有重新出现', find('data-desktop-sc-menu', 'develop', nodes), null)

  // 5b. 点另一行：上一个菜单必须消失，最终只允许目标那一行的菜单存在。
  clickRow(rowOf('develop', nodes))
  await sleep(260)
  nodes = await current()
  check('5b) develop 的菜单已打开', find('data-desktop-sc-menu', 'develop', nodes) !== null, 'true')
  clickRow(rowOf('origin/develop', nodes))
  const afterSwitch = await current()
  check('   点另一行后旧菜单立即消失', find('data-desktop-sc-menu', 'develop', afterSwitch), null)
  await sleep(300)
  nodes = await current()
  const menus = findAll('data-desktop-sc-menu', nodes)
  check('   最终只有一个菜单', menus.length, 1)
  check('   而且是新点那一行的', menus[0]?.props?.['data-desktop-sc-menu'], 'origin/develop')
  check('   选中项也跟着换了', rowOf('origin/develop', nodes)?.props?.['data-desktop-branch-selected'], 'true')

  // 5c. 滚动列表：关闭菜单，并取消待弹的定时器。
  nodes = await closeMenu()
  const list = findAll('data-desktop-branch-list', nodes)[0]
  checkTrue('5c) 找得到分支列表容器', list !== undefined)
  clickRow(rowOf('develop', nodes))
  list.props.onScroll()
  await sleep(320)
  nodes = await current()
  check('   滚动后没有菜单（待弹定时器也被取消）', menus.length === 0 || find('data-desktop-sc-menu', 'develop', nodes) === null, 'true')
  check('   滚动不关面板', panelOpen(nodes), 'true')

  // 5d. Escape：只收菜单，面板留着。
  clickRow(rowOf('develop', nodes))
  await sleep(260)
  nodes = await current()
  check('5d) 菜单已打开', find('data-desktop-sc-menu', 'develop', nodes) !== null, 'true')
  nodes = await closeMenu()
  check('   Esc 收掉了菜单', find('data-desktop-sc-menu', 'develop', nodes), null)
  check('   但面板还开着', panelOpen(nodes), 'true')

  // 5e. 菜单里的「签出」：请求发出之前菜单就已经收掉了。
  posts.length = 0
  contextMenuRow(rowOf('develop', nodes))
  nodes = await settle()
  const checkout = find('data-desktop-sc-menu', 'develop', nodes).props.children.find(
    (child) => child?.props?.['data-desktop-sc-menuitem'] === 'checkout',
  )
  checkout.props.onClick()
  const sameFrame = await current()
  check('5e) 点「签出」的同一帧菜单就没了', find('data-desktop-sc-menu', 'develop', sameFrame), null)
  await sleep(40)
  check('   而且真的发出了 checkout', posts.length >= 1, 'true')
}

console.log('')
console.log('=== 6. 二级菜单：外侧级联几何 + 孤儿菜单不可能 ===')
{
  // ---- 6a. 纯函数：三条横向规则 + 纵向翻转 -------------------------------------
  //
  // 几何断言分两层做：先直接喂坐标给纯函数（规则本身），再让组件真的渲染一遍、读它落在
  // 宿主节点上的 left/top（规则有没有被接到界面上）。两层缺一不可——只测纯函数会漏掉
  // "组件没用它"，只测组件则三条分支要靠四五个造价不低的场景才能凑齐。
  const cascade = loaded.__cascadeMenuPositionForTest
  checkTrue('6a) 导出了级联几何纯函数', typeof cascade === 'function')
  const GAP = 6
  const WIDTH = 268
  const MARGIN = 8
  const HEIGHT = 360
  const viewport = { width: 1400, height: 900 }
  const panel = { left: 100, right: 520, top: 400, bottom: 700 }
  const row = { top: 430, bottom: 460, left: 110, right: 510 }
  /** 两个矩形有没有相交（级联菜单的核心要求：不许压住一级面板）。 */
  const intersects = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  const boxOf = (position) => ({
    left: position.left,
    right: position.left + WIDTH,
    top: position.top,
    bottom: position.top + HEIGHT,
  })

  const right = cascade({ rowRect: row, panelRect: panel, submenuWidth: WIDTH, submenuHeight: HEIGHT, viewport })
  check('   右侧放得下：贴着面板右缘 + 间隙', right.left, panel.right + GAP)
  check('   方向是 right', right.side, 'right')
  check('   纵向对齐被点的那一行', right.top, row.top)
  check('   与一级面板零重叠', intersects(boxOf(right), panel), false)
  checkTrue('   两矩形不相交的判据本身可靠（同一矩形必然相交）', intersects(boxOf(right), boxOf(right)))

  // 右侧不够（面板贴着视口右边），但左侧够 → 必须翻到左侧。
  const leftPanel = { left: 900, right: 1320, top: 100, bottom: 400 }
  const leftRow = { top: 150, bottom: 180, left: 910, right: 1310 }
  const left = cascade({ rowRect: leftRow, panelRect: leftPanel, submenuWidth: WIDTH, submenuHeight: HEIGHT, viewport })
  check('   右侧放不下：翻到面板左侧', left.left + WIDTH, leftPanel.left - GAP)
  check('   方向是 left', left.side, 'left')
  check('   仍然与面板零重叠', intersects(boxOf(left), leftPanel), false)

  // 两侧都不够（面板几乎占满视口）才允许夹进视口——这是唯一的退化分支。
  const widePanel = { left: 200, right: 1200, top: 100, bottom: 400 }
  const clamped = cascade({ rowRect: row, panelRect: widePanel, submenuWidth: WIDTH, submenuHeight: HEIGHT, viewport })
  check('   两侧都放不下时才是 clamp', clamped.side, 'clamp')
  checkTrue('   夹进视口：左边不越界', clamped.left >= MARGIN)
  checkTrue('   夹进视口：右边不越界', clamped.left + WIDTH <= viewport.width - MARGIN)

  // 纵向：行靠近视口底部时必须整体上移，而不是被裁掉。
  const low = cascade({ rowRect: { top: 800, bottom: 830, left: 110, right: 510 }, panelRect: panel, submenuWidth: WIDTH, submenuHeight: HEIGHT, viewport })
  check('   触底时上移到"底边刚好贴住下边距"', low.top, viewport.height - MARGIN - HEIGHT)
  checkTrue('   上移后整块在视口内', low.top >= MARGIN && low.top + HEIGHT <= viewport.height - MARGIN)
  const above = cascade({ rowRect: { top: 4, bottom: 24, left: 110, right: 510 }, panelRect: panel, submenuWidth: WIDTH, submenuHeight: HEIGHT, viewport })
  check('   行太靠上时不越出上边距', above.top, MARGIN)

  // ---- 6b. 组件真的按这两个矩形落位 -------------------------------------------
  //
  // 桩渲染量不到布局，所以假矩形由测试喂进去（真实浏览器里它们来自行按钮与 panelRef）。
  // 一次右开、一次左开用的是**同一份行矩形、不同的面板矩形**：几何随面板变化，正说明
  // "打开那一刻记录的两个矩形"真的被用上了，而不是某个写死的偏移。
  nodes = await ensurePanel()
  setPanelRect(nodes, panel)
  clickRow(rowOf('develop', nodes), row)
  await sleep(260)
  nodes = await current()
  let menu = find('data-desktop-sc-menu', 'develop', nodes)
  checkTrue('6b) 单击后二级菜单打开', menu !== null)
  check('   组件落位与纯函数一致（left）', menu?.props?.style?.left, `${panel.right + GAP}px`)
  check('   组件落位与纯函数一致（top）', menu?.props?.style?.top, `${row.top}px`)
  check('   方向标记是 right', menu?.props?.['data-desktop-sc-cascade'], 'right')
  check('   没有覆盖一级面板', Number(menu?.props?.style?.left?.replace('px', '')) >= panel.right, 'true')

  nodes = await closeMenu()
  nodes = await ensurePanel()
  setPanelRect(nodes, leftPanel)
  clickRow(rowOf('develop', nodes), leftRow)
  await sleep(260)
  nodes = await current()
  menu = find('data-desktop-sc-menu', 'develop', nodes)
  check('   换成"右侧放不下"的面板后翻到左侧', menu?.props?.style?.left, `${leftPanel.left - GAP - WIDTH}px`)
  check('   方向标记是 left', menu?.props?.['data-desktop-sc-cascade'], 'left')
  nodes = await closeMenu()

  // ---- 6c. 点面板外：两级一起关 ------------------------------------------------
  nodes = await ensurePanel()
  contextMenuRow(rowOf('develop', nodes))
  nodes = await settle()
  checkTrue('6c) 二级菜单已打开', find('data-desktop-sc-menu', 'develop', nodes) !== null)
  setContainerContains(nodes, () => false)
  emitPointerDown({})
  nodes = await current()
  check('   一级面板关闭', panelOpen(nodes), 'false')
  check('   二级菜单也没了', findAll('data-desktop-sc-menu', nodes).length, 0)

  // ---- 6d. 点面板内、二级菜单外：只收二级 --------------------------------------
  nodes = await ensurePanel()
  const insidePanelTarget = {}
  setContainerContains(nodes, (target) => target === insidePanelTarget)
  contextMenuRow(rowOf('develop', nodes))
  nodes = await settle()
  checkTrue('6d) 二级菜单已打开', find('data-desktop-sc-menu', 'develop', nodes) !== null)
  emitPointerDown(insidePanelTarget)
  nodes = await current()
  check('   一级面板留着', panelOpen(nodes), 'true')
  check('   二级菜单收起', findAll('data-desktop-sc-menu', nodes).length, 0)

  // ---- 6e. 点二级菜单内部：两层都留着 ------------------------------------------
  nodes = await ensurePanel()
  const insideMenuTarget = {}
  setContainerContains(nodes, (target) => target === insideMenuTarget)
  contextMenuRow(rowOf('develop', nodes))
  nodes = await settle()
  const menuNode = find('data-desktop-sc-menu', 'develop', nodes)
  checkTrue('6e) 二级菜单已打开', menuNode !== null)
  menuNode.props.ref.current = { contains: (target) => target === insideMenuTarget }
  emitPointerDown(insideMenuTarget)
  nodes = await current()
  check('   一级面板留着', panelOpen(nodes), 'true')
  check('   二级菜单也留着', find('data-desktop-sc-menu', 'develop', nodes) !== null, 'true')

  // ---- 6f. open === false ⇒ 一个二级菜单节点都不许有（孤儿菜单回归）------------
  //
  // 这是本次修复的**根因场景**：单击只排了一个 200ms 后弹菜单的定时器，此时点面板外，
  // 旧代码只 `setOpen(false)`——定时器还挂着，200ms 后 setMenu 让二级菜单在**面板已经
  // 不渲染**的情况下浮出来（再加渲染层只看 `menu === null`，它就真的画在屏幕上了）。
  nodes = await ensurePanel()
  setContainerContains(nodes, () => false)
  clickRow(rowOf('develop', nodes))
  emitPointerDown({})
  nodes = await current()
  check('6f) 点面板外后：面板关闭', panelOpen(nodes), 'false')
  check('   同一帧里就没有二级菜单', findAll('data-desktop-sc-menu', nodes).length, 0)
  await sleep(320)
  nodes = await current()
  check('   等过单击延迟后也没有孤儿菜单', findAll('data-desktop-sc-menu', nodes).length, 0)
  check('   面板没有被定时器带着"诈尸"', panelOpen(nodes), 'false')

  // 二级菜单开着时点面板外：同一帧里 open=false 而旧代码的 menu 还非 null。
  nodes = await ensurePanel()
  setContainerContains(nodes, () => false)
  contextMenuRow(rowOf('develop', nodes))
  nodes = await settle()
  checkTrue('   前置：二级菜单开着', find('data-desktop-sc-menu', 'develop', nodes) !== null)
  emitPointerDown({})
  nodes = await current()
  check('   点外后同帧没有二级菜单', findAll('data-desktop-sc-menu', nodes).length, 0)
  check('   面板也已关闭', panelOpen(nodes), 'false')

  // 触发器再点一次（程序化 click 没有 mousedown 兜底）：旧代码在这里同样会留下孤儿菜单。
  nodes = await ensurePanel()
  contextMenuRow(rowOf('develop', nodes))
  nodes = await settle()
  checkTrue('   前置：二级菜单开着', find('data-desktop-sc-menu', 'develop', nodes) !== null)
  find('data-desktop-branch-trigger', undefined, nodes).props.onClick()
  nodes = await current()
  check('   触发器再点一次：面板关闭', panelOpen(nodes), 'false')
  check('   二级菜单同帧消失', findAll('data-desktop-sc-menu', nodes).length, 0)

  // Esc 逐层退出的最后一层（没有菜单/对话框时）也必须把状态收干净。
  nodes = await ensurePanel()
  document.emitKeydown()
  nodes = await current()
  check('   Esc 关面板后没有残留菜单', findAll('data-desktop-sc-menu', nodes).length, 0)
  check('   面板确实关了', panelOpen(nodes), 'false')

  // 成功的 checkout（双击）同样走 closePanel：面板与二级菜单一起消失。
  nodes = await ensurePanel()
  contextMenuRow(rowOf('develop', nodes))
  nodes = await settle()
  checkTrue('   前置：二级菜单开着', find('data-desktop-sc-menu', 'develop', nodes) !== null)
  posts.length = 0
  const checkoutRow = rowOf('develop', nodes)
  clickRow(checkoutRow)
  clickRow(checkoutRow)
  dblClickRow(checkoutRow)
  await sleep(60)
  nodes = await current()
  check('   成功 checkout 后面板关闭', panelOpen(nodes), 'false')
  check('   而且没有孤儿二级菜单', findAll('data-desktop-sc-menu', nodes).length, 0)
  check('   确实发出了 checkout', posts.length >= 1, 'true')

  // ---- 6g. Escape 的逐层顺序：二级菜单 → 对话框 → 面板 ------------------------
  //
  // "菜单与对话框同时存在"要靠**再右键一次**造出来：从菜单里打开对话框本身就会收掉菜单
  // （那是 1.5.1 的既有行为），而三层的 Esc 顺序只有在两层同时开着时才判得出来。
  nodes = await ensurePanel()
  contextMenuRow(rowOf('develop', nodes))
  nodes = await settle()
  const newFrom = find('data-desktop-sc-menu', 'develop', nodes).props.children.find(
    (child) => child?.props?.['data-desktop-sc-menuitem'] === 'new-from',
  )
  newFrom.props.onClick()
  nodes = await settle()
  checkTrue('6g) 前置：对话框已打开', find('data-desktop-sc-dialog', 'create', nodes) !== null)
  check('   点菜单项后二级菜单已收起', find('data-desktop-sc-menu', 'develop', nodes), null)
  contextMenuRow(rowOf('develop', nodes))
  nodes = await settle()
  checkTrue('   前置：二级菜单也开着（两层同时存在）', find('data-desktop-sc-menu', 'develop', nodes) !== null)
  document.emitKeydown()
  nodes = await current()
  check('   第一次 Esc 只收二级菜单', find('data-desktop-sc-menu', 'develop', nodes), null)
  check('   对话框还在', find('data-desktop-sc-dialog', 'create', nodes) !== null, 'true')
  check('   面板还在', panelOpen(nodes), 'true')
  document.emitKeydown()
  nodes = await current()
  check('   第二次 Esc 收对话框', find('data-desktop-sc-dialog', undefined, nodes), null)
  check('   面板仍在', panelOpen(nodes), 'true')
  check('   这时依然没有二级菜单', findAll('data-desktop-sc-menu', nodes).length, 0)
  document.emitKeydown()
  nodes = await current()
  check('   第三次 Esc 收面板', panelOpen(nodes), 'false')
  check('   收完后没有孤儿二级菜单', findAll('data-desktop-sc-menu', nodes).length, 0)
}

console.log('')
console.log('=== 7. 多仓库项目：徽标前的仓库计数 + 选择器（单仓库时整块不渲染）===')
{
  // 实机形状：工作区自己不是仓库，仓库在子目录里。宿主在 `/status` 里回 `projectScope`，
  // 徽章据此显示"Git · 2 个仓库"并给出选择器——**分支与改动数永远只是当前仓库的**，
  // 因此"这个项目里有几个仓库"必须写在徽章旁边，而不是藏进菜单。
  const FRONTEND = `${WORKSPACE}\\haiwei-manage-fronted`
  const BACKEND = `${WORKSPACE}\\haiwei-manage-backend`
  status.projectScope = {
    workspaceRoot: WORKSPACE,
    repositories: [
      { repositoryRoot: BACKEND, gitDir: `${BACKEND}\\.git`, relativePath: 'haiwei-manage-backend', name: 'haiwei-manage-backend' },
      { repositoryRoot: FRONTEND, gitDir: `${FRONTEND}\\.git`, relativePath: 'haiwei-manage-fronted', name: 'haiwei-manage-fronted' },
    ],
    discovery: { complete: true, directoriesVisited: 4, candidatesFound: 2, gitProbes: 2, durationMs: 1, truncatedByBudget: false, cached: false },
  }
  rootKey = `multi-${String(Date.now())}`
  queries.length = 0
  let nodes = await settle(4)
  // 计数那一格同时挂了属性与文案：属性是稳定的（'2'），文案走 `t`（桩渲染里的 `t`
  // 不一定插值，因此只断言"是那个键"，不假定参数被渲染出来）。
  check('7) 徽标上标出仓库数', find('data-desktop-repo-count', undefined, nodes)?.props?.['data-desktop-repo-count'], '2')
  checkTrue('   文案用的是仓库数量那句', textOf(find('data-desktop-repo-count', undefined, nodes)).includes('repoCount'))
  const select = find('data-desktop-repo-select', undefined, nodes)
  checkTrue('   有仓库选择器', select !== null)
  check('   两个选项', select.props.children.length, 2)
  check('   默认选中列表里的第一个（宿主侧的默认规则相同）', select.props.value, BACKEND)
  // 选择 frontend：必须**立刻**带着它重新请求 status / branches / remotes。
  queries.length = 0
  select.props.onChange({ target: { value: FRONTEND } })
  nodes = await settle(4)
  check('   切换后重新请求了 status', queries.filter((q) => q.route === 'status').length >= 1, 'true')
  check(
    '   每一个新请求都带上了选中的仓库',
    [...new Set(queries.map((q) => q.repository))].join(','),
    FRONTEND,
  )
  check('   选择器显示切换后的仓库', find('data-desktop-repo-select', undefined, nodes).props.value, FRONTEND)

  // 单仓库（1.5.2 的一贯界面）：整块不渲染，且请求里一个字都不多带。
  status.projectScope = {
    workspaceRoot: WORKSPACE,
    repositories: [{ repositoryRoot: WORKSPACE, gitDir: `${WORKSPACE}\\.git`, relativePath: '', name: 'projA' }],
    discovery: { complete: true, directoriesVisited: 1, candidatesFound: 1, gitProbes: 1, durationMs: 1, truncatedByBudget: false, cached: false },
  }
  rootKey = `single-${String(Date.now())}`
  queries.length = 0
  nodes = await settle(4)
  check('7) 单仓库时没有仓库计数', find('data-desktop-repo-count', undefined, nodes), null)
  check('   单仓库时没有选择器', find('data-desktop-repo-select', undefined, nodes), null)
  // 判据是**知道"这个项目只有一个仓库"之后**发出去的请求不再带它：第一次 status 是在
  // 上一段的仓库列表还留在模块级 store 时发出的（真实场景里换工作区用的是不同的键，
  // 根本不会有这一次）。因此这里开一次面板，逼一组新请求出来再断言。
  queries.length = 0
  await ensurePanel()
  checkTrue('   确实发了新请求（否则这条断言是空的）', queries.length >= 1)
  check('   单仓库时请求不带 repository', queries.filter((q) => q.repository !== null).length, 0)
  delete status.projectScope
}

console.log('')
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
