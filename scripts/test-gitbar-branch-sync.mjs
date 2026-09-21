// 分支同步补算（`/branch/sync`）的**契约**与**有界性**回归。
//
//   node scripts/test-gitbar-branch-sync.mjs
//
// 两件事必须同时成立，而且它们是同一处代码的两面：
//
//   1. **字段名只有一套**：`/branches` 与 `/branch/sync` 都用 `syncExact`。曾经 host 回
//      `exact`、客户端条目上是 `syncExact`，合并之后条目上同时挂着 `exact: true` 与
//      `syncExact: false`——"这个分支已经精确过了"永远判不出来，补算被一轮轮重复触发。
//   2. **补算必须有界**：候选只能来自"真正可见的行 + 用户选中的行"，并且每个名字每份列表
//      只请求一次。否则"第一批 32 个完成 → 候选变成下一批 32 个 → 再发一次"会自动把
//      300/2000 个分支全算一遍，把"首屏 1 个进程"的收益全部吃掉。
//
// 这里用一个 300 分支的仓库夹具把两件事一起钉住：字段名错了第 2 条也会跟着错（锁存失效），
// 因此"补算次数"本身就是最灵敏的那条断言。
import { readFileSync } from 'node:fs'
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

// ---- 假 host：300 个有上游的分支 ---------------------------------------------------
const WORKSPACE = 'F:\\code\\projA'
const BRANCH_COUNT = 300
/** 首屏的 track 值：每个分支都"落后 1"（`syncExact: false` 表示这不是精确值）。 */
const TRACK_BEHIND = 1
/** `/branch/sync` 返回的精确值：落后 7，用来区分"补算之后"。 */
const EXACT_BEHIND = 7

const branchEntry = (name, extra) => ({
  name,
  isRemote: false,
  current: false,
  remote: '',
  upstream: 'origin/main',
  upstreamGone: false,
  ahead: 0,
  behind: TRACK_BEHIND,
  diverged: false,
  syncExact: false,
  committedAt: '2026-01-01T00:00:00+08:00',
  hash: 'a'.repeat(40),
  subject: name,
  ...extra,
})

const BRANCHES = [
  branchEntry('main', { current: true, behind: 0, syncExact: false }),
  ...Array.from({ length: BRANCH_COUNT }, (_, index) => branchEntry(`branch-${String(index).padStart(3, '0')}`)),
]
const STATUS = { isRepo: true, branch: 'main', detached: false, upstream: 'origin/main', ahead: 0, behind: 0, changedFiles: 0, untrackedFiles: 0, upstreamGone: false, merging: false, rebasing: false, head: 'a'.repeat(40) }

/** 每次 `/branch/sync` 请求的名字（按请求分组）。 */
const syncRequests = []
/**
 * 服务端是否把结果标成精确。
 *
 * 正常契约是 `true`（见下面的 stub）。置为 `false` 用来演"服务端没标精确"这种异常：
 * 那时条目的 `syncExact` 永远是 false，如果候选只靠"还没精确过"来筛，就会**每渲染一帧
 * 重发一次同一批**——这是第 7 节要挡住的那种请求风暴。
 */
let syncMarksExact = true
/**
 * 是否把 `/branch/sync` 的响应挂起（第 8 节要造"上一批还在飞、视口又变了"）。
 */
let syncHold = false
/** 被挂起的补算响应：每个元素是"放行这一个"的函数。 */
const heldSync = []
const releaseSync = () => {
  const release = heldSync.shift()
  if (release === undefined) throw new Error('没有挂起的 /branch/sync 响应')
  release()
}

globalThis.fetch = async (url) => {
  const target = new URL(String(url), 'http://localhost')
  const route = target.pathname.slice('/dsh-desktop/gitbar/'.length)
  if (route === 'status') return { ok: true, text: async () => JSON.stringify(STATUS) }
  if (route === 'branches') return { ok: true, text: async () => JSON.stringify({ branches: BRANCHES, counts: { local: BRANCHES.length, remote: 0 } }) }
  if (route === 'remotes') return { ok: true, text: async () => JSON.stringify({ remotes: [] }) }
  if (route === 'branch/sync') {
    const names = (target.searchParams.get('names') ?? '').split(',').filter((name) => name !== '')
    syncRequests.push(names)
    // 契约：字段名与 `/branches` 一致（`syncExact`）。**故意不返回 `exact`**——多一个字段名
    // 就是当初"永远判不出已精确"的根因，测试替身也不该把它演出来。
    const sync = {}
    for (const name of names) sync[name] = { ahead: 0, behind: EXACT_BEHIND, diverged: false, upstreamGone: false, syncExact: syncMarksExact }
    const body = { ok: true, text: async () => JSON.stringify({ sync }) }
    if (syncHold) {
      return await new Promise((resolve) => heldSync.push(() => resolve(body)))
    }
    return body
  }
  return { ok: true, text: async () => JSON.stringify({ isRepo: true, ...STATUS }) }
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

// ---- 挂载 -----------------------------------------------------------------------
const Chip = entries.get('conversation.input.dock:desktop-context-bar').component
const mountProps = {
  t: (key, params) => {
    if (params === undefined) return key
    return Object.entries(params).reduce((text, [name, value]) => text.split(`{${name}}`).join(String(value)), key)
  },
  sessionId: 's1',
  useSessions: (selector) => selector({ current: 's1', byId: { s1: { cwd: WORKSPACE } } }),
  renderSlot: () => null,
}
let rootKey = 'branch-sync'
let nodes = []

async function settle(passes = 4) {
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
const find = (attr, value, list) =>
  (list ?? nodes).find((node) => (value === undefined ? node.props?.[attr] !== undefined : node.props?.[attr] === value)) ?? null
const findAll = (attr, list) => (list ?? nodes).filter((node) => node.props?.[attr] !== undefined)
const rowOf = (name, list) => findAll('data-desktop-branch-option', list).find((node) => node.props['data-desktop-branch-name'] === name) ?? null

console.log('=== 1. 打开面板：只补算一屏，且不碰没有上游/当前分支 ===')
await settle()
check('1) 徽章已渲染（前置）', find('data-desktop-branch-trigger') !== null, 'true')
find('data-desktop-branch-trigger').props.onClick()
await settle()

check('   只发了一次 /branch/sync', syncRequests.length, 1)
const first = syncRequests[0] ?? []
checkTrue('   候选来自一屏大小的窗口（不是 300 个分支）', first.length > 0 && first.length <= 12)
checkTrue('   远小于分支总数', first.length < BRANCH_COUNT / 10)
check('   当前分支不在候选里（它由 /status 给精确值）', first.includes('main'), 'false')
checkTrue('   候选都是前几行', first.every((name) => /^branch-0\d\d$/u.test(name)))
console.log(`  [measure] 300 个分支，首屏只补算 ${first.length} 个`)

console.log('')
console.log('=== 2. 补算之后条目标成 syncExact（契约）===')
{
  const name = first[0]
  const row = rowOf(name)
  checkTrue(`2) ${name} 的行存在`, row !== null)
  check(`   enrichment 后 syncExact === true`, row?.props?.['data-desktop-branch-sync-exact'], 'true')
  // 精确值也真的落到了行上（首屏是 ↓1，补算后是 ↓7）。同步标记是行**内部**的节点，
  // 因此从行本身展开一层来找（`findAll` 是全树平铺，按属性查会命中别的行）。
  const syncSpan = collectHostNodes(row, 'probe').find((node) => node.props?.['data-desktop-branch-sync'] !== undefined)
  check(`   行上显示精确值 ↓${EXACT_BEHIND}`, textOf(syncSpan), `\u2193${EXACT_BEHIND}`)
  // 没有被补算的分支仍然标着"非精确"。
  const other = rowOf(`branch-${String(BRANCH_COUNT - 1).padStart(3, '0')}`)
  check('   未补算的分支仍是 syncExact=false', other?.props?.['data-desktop-branch-sync-exact'], 'false')
  // 当前分支由 `/status` 覆盖成精确值。
  check('   当前分支是精确的（来自 /status）', rowOf('main')?.props?.['data-desktop-branch-sync-exact'], 'true')
}

console.log('')
console.log('=== 3. 不会自动连续补算：算完一批就停 ===')
{
  const before = syncRequests.length
  // 反复渲染 + 跑副作用：旧实现会在这里一批批地继续发（候选集合随着 syncExact 变化而变化）。
  await settle(10)
  await settle(10)
  check('3) 十轮渲染后没有新的补算请求', syncRequests.length, before)
  const total = syncRequests.flat().length
  checkTrue('   补算过的名字总数远小于分支总数', total < BRANCH_COUNT / 10)
  console.log(`  [measure] 渲染 20 轮之后，累计补算 ${total} 个名字（分支总数 ${BRANCH_COUNT + 1}）`)
}

console.log('')
console.log('=== 4. 搜索（用户动作）改变可见集合：至多再来一批，且不会连锁 ===')
{
  const before = syncRequests.length
  const input = find('data-desktop-branch-menu') !== null ? nodes.find((n) => n.props?.type === 'search') : null
  input.props.onChange({ target: { value: 'branch-1' } })
  await settle()
  check('4) 过滤后发了一批', syncRequests.length, before + 1)
  const batch = syncRequests[syncRequests.length - 1] ?? []
  checkTrue('   候选都在过滤结果里', batch.every((name) => name.includes('branch-1')))
  const settledCount = syncRequests.length
  await settle(10)
  check('   过滤后也不会连锁', syncRequests.length, settledCount)
}

console.log('')
console.log('=== 5. 用户选中的行（可能在视口外）会单独补算一次 ===')
{
  // 清掉搜索，回到完整列表。
  nodes.find((n) => n.props?.type === 'search').props.onChange({ target: { value: '' } })
  await settle()
  const before = syncRequests.length
  const target = rowOf(`branch-${String(BRANCH_COUNT - 1).padStart(3, '0')}`)
  checkTrue('5) 找到最后一行', target !== null)
  target.props.onClick({ stopPropagation() {}, preventDefault() {}, currentTarget: null })
  await settle()
  check('   选中后只补算这一个', syncRequests.length, before + 1)
  check('   请求里就是被选中的那个分支', JSON.stringify(syncRequests[syncRequests.length - 1]), JSON.stringify([`branch-${String(BRANCH_COUNT - 1).padStart(3, '0')}`]))
  check('   它现在是精确的', rowOf(`branch-${String(BRANCH_COUNT - 1).padStart(3, '0')}`)?.props?.['data-desktop-branch-sync-exact'], 'true')
  const total = syncRequests.flat().length
  checkTrue('   累计补算仍然远小于分支总数', total < BRANCH_COUNT / 4)
}

console.log('')
console.log('=== 6. 视口判定：只挑与容器相交的行，到视口下方就停 ===')
{
  const visibleNames = loaded.__visibleBranchNamesForTest
  checkTrue('6) 导出了视口判定函数', typeof visibleNames === 'function')
  /** 造一行：`{ top, bottom, name }`。 */
  const row = (name, top, bottom, options) => ({
    getBoundingClientRect: options?.throwOnRect === true ? () => { throw new Error('不该读到它') } : () => ({ top, bottom, height: bottom - top }),
    getAttribute: options?.throwOnAttr === true ? () => { throw new Error('不该读到它') } : () => name,
  })
  const container = (rows, box) => ({
    getBoundingClientRect: () => box,
    querySelectorAll: () => rows,
  })
  const fallback = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n'].map((name) => ({ name }))

  // 容器可视区 100..200：-10..30（上方，跳过）、30..70（上方，跳过）、90..130（相交）、
  // 130..170（相交）、170..210（相交）、210..250（下方 → 停止，后面一行连属性都不该读）。
  const tree = container(
    [
      row('above-far', -10, 30),
      row('above-near', 30, 70),
      row('visible-1', 90, 130),
      row('visible-1', 130, 170), // 「最近」分组里的同一个分支：必须去重
      row('visible-2', 170, 210),
      row('below', 210, 250, { throwOnAttr: true }),
      row('below-2', 250, 290, { throwOnRect: true }),
    ],
    { top: 100, bottom: 200, height: 100 },
  )
  check('   只返回相交且去重后的名字', visibleNames(tree, fallback).join(','), 'visible-1,visible-2')
  // 完全没有 DOM（桩渲染 / SSR）：退化成固定大小的一屏窗口，**不能**退化成整张列表。
  check('   没有 DOM 时退化成一屏窗口', visibleNames(null, fallback).length, 12)
  check('   零高度容器同样退化', visibleNames(container([], { top: 0, bottom: 0, height: 0 }), fallback).length, 12)

  // 结构性断言：候选集合绝不能直接取"过滤后的整张列表"（那正是会退化成全仓库扫描的写法）。
  const source = readFileSync(join(ROOT, 'plugins', 'dsh-client-ui-gitbar', 'lib', 'client.js'), 'utf8')
  check('   源码里补算候选不再直接来自 visible', source.includes('.filter((entry) => entry.upstream !== \'\' && entry.syncExact !== true)\n        .slice(0, SYNC_BATCH)'), 'false')
  checkTrue('   源码里有锁存（每个名字每份列表只请求一次）', source.includes('syncRequested'))
  checkTrue('   源码里有自动补算的总额上限', source.includes('SYNC_AUTO_BUDGET'))
}

console.log('')
console.log('=== 7. 即使服务端没把结果标成精确，也不会每帧重发（锁存的意义）===')
// 这一节演的是第 1 个问题的**后果**：只要"已精确"这件事判不出来，候选集合就会一直非空。
// 锁存（每个名字每份列表只请求一次）是最后一道闸门——没有它，这里会变成"每渲染一帧
// 重发一次同一批"，而补算请求每一条都会真的起 git 进程。
{
  syncMarksExact = false
  rootKey = 'branch-sync-not-exact'
  syncRequests.length = 0
  await settle()
  find('data-desktop-branch-trigger').props.onClick()
  await settle(10)
  check('7) 重复渲染只发一次（不是每帧一次）', syncRequests.length, 1)
  const total = syncRequests.flat().length
  checkTrue('   补算名字数仍然是一屏的量级', total <= 12)
  syncMarksExact = true
}

console.log('')
console.log('=== 8. 上一批还在飞时视口变了：必须另起一批，不能复用它 ===')
// single-flight 的键必须带上**参数**。若两批共用一个 kind，第二次调用会复用到第一批的
// 票据：那一批名字永远不会被补算，而它们已经被锁存记下了——于是这一份列表里再也不会补。
{
  syncHold = true
  rootKey = 'branch-sync-two-batches'
  syncRequests.length = 0
  await settle()
  find('data-desktop-branch-trigger').props.onClick()
  await settle()
  check('8) 第一批已发出且在飞', syncRequests.length, 1)
  const firstBatch = syncRequests[0].slice()

  // 改搜索词 = 可见集合变化（等价于滚动到别处）。第一批还挂着。
  nodes.find((n) => n.props?.type === 'search').props.onChange({ target: { value: 'branch-2' } })
  await settle()
  check('   另起了一批（没有复用第一批的票据）', syncRequests.length, 2)
  const secondBatch = syncRequests[1].slice()
  checkTrue('   第二批的名字属于新的过滤结果', secondBatch.length > 0 && secondBatch.every((name) => name.includes('branch-2')))
  check('   两批不是同一组名字', firstBatch.join(',') === secondBatch.join(','), 'false')

  // 两批都放行：各自的结果都要落到条目上。
  releaseSync()
  releaseSync()
  await settle()
  const exactOf = (name) => rowOf(name)?.props?.['data-desktop-branch-sync-exact'] ?? '(no-row)'
  check('   第二批（当前可见）已标为精确', exactOf(secondBatch[0]), 'true')
  // 清掉搜索后，第一批那些行也应该已经是精确的（它们的响应同样被采用过）。
  syncHold = false
  nodes.find((n) => n.props?.type === 'search').props.onChange({ target: { value: '' } })
  await settle()
  check('   第一批也已标为精确（响应没有丢）', exactOf(firstBatch[0]), 'true')
}

console.log('')
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
