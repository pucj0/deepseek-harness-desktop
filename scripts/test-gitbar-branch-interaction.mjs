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
globalThis.fetch = async (url, init) => {
  const target = new URL(String(url), 'http://localhost')
  const route = target.pathname.slice('/dsh-desktop/gitbar/'.length)
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
/** 一次真实浏览器里的 click。 */
const clickRow = (row) => row.props.onClick({ stopPropagation() {}, preventDefault() {}, currentTarget: null })
const dblClickRow = (row) => row.props.onDoubleClick({ stopPropagation() {}, preventDefault() {} })
const contextMenuRow = (row) =>
  row.props.onContextMenu({ stopPropagation() {}, preventDefault() {}, clientX: 300, clientY: 300 })

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
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
