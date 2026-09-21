// gitbar 的**项目切换竞态**回归：延迟的旧请求不许覆盖新工作区的状态。
//
//   node scripts/test-gitbar-workspace-race.mjs
//
// 为什么需要它：这一批 bug 的共同形状是"切了项目之后，界面又变回上一个项目的数据"——
// 而它时有时无（取决于两个请求谁先回来），靠手点几乎复现不出来。因此这里用桩渲染器 + 可控
// 的 fetch（每个请求都能挂起 / 单独放行）把顺序钉死：
//   * A 的请求故意延迟，切到 B，B 先回来，A 最后回来 → 界面必须仍然是 B；
//   * A → B → A 快速切换，陈旧的 A、乱序的 B 都在 A 的第二次响应之后回来 → 必须是 A；
//   * 切换工作区的那一帧就必须进入"没有当前数据"的状态，绝不显示上一个项目的分支；
//   * 轮询不重叠（同一个工作区同一类请求 single-flight）；
//   * 写操作（checkout）的收尾也不许写进新工作区的状态（busy 同样不许漏过来）。
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
    const prev = hookSlots[slot]
    const changed = prev === undefined || deps === undefined || prev.deps === undefined || deps.some((d, i) => !Object.is(d, prev.deps[i]))
    if (changed) {
      hookSlots[slot] = { deps }
      effectQueue.push(fn)
    }
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

// ---- 假 host：每个请求都能单独挂起 -------------------------------------------------
const A = 'F:\\code\\projA'
const B = 'F:\\code\\projB'
const branch = (name, extra) => ({
  name,
  isRemote: false,
  current: false,
  remote: '',
  upstream: '',
  upstreamGone: false,
  ahead: 0,
  behind: 0,
  diverged: false,
  syncExact: true,
  committedAt: '2026-01-01T00:00:00+08:00',
  hash: 'a'.repeat(40),
  subject: name,
  ...extra,
})
const STATUS_A = { isRepo: true, branch: 'alpha', detached: false, upstream: '', ahead: 0, behind: 0, changedFiles: 1, untrackedFiles: 0, upstreamGone: false, merging: false, rebasing: false, head: 'a'.repeat(40) }
const STATUS_B = { ...STATUS_A, branch: 'beta', changedFiles: 7 }
// A 里带一个远程分支：面板的"抓取全部远端"图标要 `remotes.length > 0` 才渲染，而第 6 节
// 需要一个**不关闭面板**的写操作来作废 branches 请求（checkout 成功会关面板）。
const BRANCHES_A = {
  branches: [branch('alpha', { current: true }), branch('a-feature'), branch('origin/alpha', { isRemote: true, remote: 'origin' })],
  counts: { local: 2, remote: 1 },
}
const BRANCHES_B = { branches: [branch('beta', { current: true }), branch('b-feature')], counts: { local: 2, remote: 0 } }
const REMOTES = [{ name: 'origin', url: 'https://example.invalid/repo.git' }]

/** 挂起的请求：`{ route, cwd, resolve }`。 */
const pending = []
const requests = []
/** 附加到 `/status` 上的字段（第 6 节用它造出"合并进行中"从而露出中止入口）。 */
let statusExtra = {}
/** 让某条路由的响应先挂起（返回 true 表示"这次请求被挂起了"）。 */
let hold = () => false

/** 放行一个挂起请求。 */
function release(route, cwd, payload) {
  const index = pending.findIndex((item) => item.route === route && (cwd === undefined || item.cwd === cwd))
  if (index < 0) throw new Error(`没有挂起的请求：${route} ${cwd ?? ''}`)
  const [item] = pending.splice(index, 1)
  item.resolve(payload)
  return item
}

globalThis.fetch = async (url) => {
  const target = new URL(String(url), 'http://localhost')
  const route = target.pathname.slice('/dsh-desktop/gitbar/'.length)
  const cwd = target.searchParams.get('cwd') ?? ''
  const payload =
    route === 'status'
      ? { ...(cwd === B ? STATUS_B : STATUS_A), ...statusExtra }
      : route === 'branches'
        ? cwd === B
          ? BRANCHES_B
          : BRANCHES_A
        : route === 'remotes'
          ? { remotes: REMOTES }
          : route === 'branch/sync'
            ? { sync: {} }
            // 走到这里的都是写操作：host 回的是最新状态 + `branchesStale`（分支列表由客户端
            // 异步重取，见 runWrite 的说明）。第 6 节就靠这个标记触发"真的重发一次 branches"。
            : { isRepo: true, ...(cwd === B ? STATUS_B : STATUS_A), branchesStale: true }
  requests.push({ route, cwd })
  if (hold(route, cwd)) {
    return await new Promise((resolve) => {
      pending.push({
        route,
        cwd,
        resolve: (value) => resolve({ ok: true, text: async () => JSON.stringify(value ?? payload) }),
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

// ---- 渲染 -----------------------------------------------------------------------
const BranchChip = entries.get('conversation.input.dock:desktop-context-bar').component
/** 当前会话的工作区（可被测试改写：这就是"切换项目"）。 */
let sessionWorkspace = A
const makeSelectorHook = (read) => (selector) =>
  react.useSyncExternalStore(
    () => () => {},
    () => selector(read()),
  )
const mountProps = {
  t: (key, params) => {
    if (params === undefined) return key
    return Object.entries(params).reduce((text, [name, value]) => text.split(`{${name}}`).join(String(value)), key)
  },
  sessionId: 's1',
  useSessions: makeSelectorHook(() => ({ current: 's1', byId: { s1: { cwd: sessionWorkspace } } })),
  // 工具条里的子槽（官方 composer.actions）与本次要测的东西无关，给一个空实现。
  renderSlot: () => null,
}
let rootKey = ''
let mountSeq = 0

/** 渲染 + 展开整棵树 + 跑掉所有排队副作用（含嵌套组件）。 */
async function settle(passes = 4) {
  let nodes = []
  for (let pass = 0; pass < passes; pass += 1) {
    const queued = []
    const { tree, effects } = render(BranchChip, mountProps, rootKey)
    queued.push(...effects)
    nodes = collectHostNodes(tree, rootKey, queued)
    for (const effect of queued) effect()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return nodes
}

const find = (attr, value, nodes) =>
  (nodes ?? collectHostNodes(render(BranchChip, mountProps, rootKey).tree, rootKey)).find((node) =>
    value === undefined ? node.props?.[attr] !== undefined : node.props?.[attr] === value,
  ) ?? null
const findAll = (attr, nodes) =>
  (nodes ?? collectHostNodes(render(BranchChip, mountProps, rootKey).tree, rootKey)).filter((node) => node.props?.[attr] !== undefined)
/** 徽章文案（没有徽章时是空串——"还没有当前工作区的数据"就是这个形状）。 */
const chipLabel = (nodes) => {
  const chip = find('data-desktop-branch-trigger', undefined, nodes)
  return chip === null ? '(no-chip)' : textOf(chip)
}
/** 徽章上的分支名。文案里还会拼上 `*N` / `↑N` 这类标记，因此只比前缀。 */
const chipBranch = (nodes) => {
  const label = chipLabel(nodes)
  return label === '(no-chip)' ? label : label.replace(/[*↑↓].*$/u, '')
}
/** 断言徽章显示的是某个分支。 */
const checkChip = (label, expected, nodes) => check(label, chipBranch(nodes), expected)
/** 切到一个工作区并让它渲染一帧。 */
async function switchTo(workspace) {
  sessionWorkspace = workspace
  return settle()
}

console.log('=== 1. A 的请求延迟、切到 B、B 先回、A 后回 → 界面仍是 B ===')
{
  console.log('  -- 1a. status 的迟到响应 --')
  rootKey = `race${mountSeq++}`
  // A 的 status 挂起；B 的立即返回。
  hold = (route, cwd) => route === 'status' && cwd === A
  sessionWorkspace = A
  await settle()
  check('1) 先按 A 发起请求', requests.filter((r) => r.cwd === A && r.route === 'status').length >= 1, 'true')
  // 还没拿到 A 的数据：徽章整体不渲染（而不是渲染一个空壳或别的项目）。
  check('   数据未到时不显示分支', chipLabel(), '(no-chip)')
  // 切到 B：B 的 status 立刻返回。
  let nodes = await switchTo(B)
  checkChip('   切到 B 后徽章是 beta', 'beta', nodes)
  // 放行 A 的迟到响应：它属于上一个工作区，必须被静默丢弃。
  release('status', A)
  nodes = await settle()
  checkChip('   A 的迟到 status 没覆盖 B', 'beta', nodes)

  console.log('  -- 1b. branches 的迟到响应 --')
  // 回到 A（status 立即返回、branches 挂起），打开面板让分支列表进入加载态。
  hold = (route, cwd) => route === 'branches' && cwd === A
  nodes = await switchTo(A)
  checkChip('   回到 A 后徽章是 alpha', 'alpha', nodes)
  const badge = find('data-desktop-branch-trigger', undefined, nodes)
  badge.props.onClick()
  nodes = await settle()
  check('   A 的面板处于加载中', textOf(find('data-desktop-branch-menu', undefined, nodes)).includes('loadingBranches'), 'true')
  // 切到 B：B 的分支立刻回来，面板里必须是 B 的分支。
  nodes = await switchTo(B)
  // 注意「最近」组是本地分支的副本（有意如此），因此按名字去重后再比较。
  const bNames = [...new Set(findAll('data-desktop-branch-option', nodes).map((n) => n.props['data-desktop-branch-name']))]
  check('   B 的面板列出 B 的分支', bNames.join(','), 'beta,b-feature')
  checkChip('   徽章是 beta', 'beta', nodes)
  // 放行 A 的迟到 branches。
  release('branches', A)
  nodes = await settle()
  const afterLate = [...new Set(findAll('data-desktop-branch-option', nodes).map((n) => n.props['data-desktop-branch-name']))]
  check('   A 的迟到 branches 没覆盖 B', afterLate.join(','), 'beta,b-feature')
  check('   面板没有卡在加载中', textOf(find('data-desktop-branch-menu', undefined, nodes)).includes('loadingBranches'), 'false')
}

console.log('')
console.log('=== 2. A → B → A 快速切换：陈旧与乱序的响应都不许赢 ===')
{
  rootKey = `race${mountSeq++}`
  /**
   * 三个阶段：
   *   `initial`  A 的 status 挂起（陈旧的那一个）
   *   `b-hold`   B 的 status 挂起（乱序的那一个）
   *   `final`    谁也不挂起——切回 A 时它的新数据立刻到手
   */
  let phase = 'initial'
  hold = (route, cwd) => {
    if (route !== 'status') return false
    if (cwd === A) return phase === 'initial'
    return phase === 'b-hold'
  }
  sessionWorkspace = A
  await settle()
  phase = 'b-hold'
  await switchTo(B)
  // 立刻切回 A：这次 A 的请求不挂起。
  phase = 'final'
  const final = await switchTo(A)
  checkChip('2) 回到 A 后徽章是 alpha', 'alpha', final)
  // 放行 B（乱序）与 A 的旧响应。
  release('status', B)
  let nodes = await settle()
  checkChip('   乱序返回的 B 没被采用', 'alpha', nodes)
  release('status', A)
  nodes = await settle()
  checkChip('   陈旧的 A（第一次）也没覆盖 A 的新数据', 'alpha', nodes)
}

console.log('')
console.log('=== 3. 切换工作区的当帧就进入加载态 ===')
{
  rootKey = `race${mountSeq++}`
  hold = () => false
  await switchTo(A)
  checkChip('3) A 就绪', 'alpha')
  // 让 B 的 status 挂起：切过去之后**这一帧**就不能再显示 alpha。
  hold = (route, cwd) => cwd === B && route === 'status'
  sessionWorkspace = B
  const nodes = await settle(1)
  checkChip('   切换后仍显示旧项目的数据', '(no-chip)', nodes)
  release('status', B)
}

console.log('')
console.log('=== 4. 轮询不重叠：同一工作区同一类请求 single-flight ===')
{
  rootKey = `race${mountSeq++}`
  hold = () => false
  await switchTo(A)
  // 让 status 挂起，然后连点两次刷新：只应产生一次新的 status 请求。
  hold = (route, cwd) => cwd === A && route === 'status'
  const before = requests.filter((r) => r.route === 'status' && r.cwd === A).length
  const refreshIcon = find('data-desktop-sc-icon', 'refresh')
  // 打开面板才有刷新图标。
  if (refreshIcon === null) {
    find('data-desktop-branch-trigger').props.onClick()
    await settle()
  }
  const icon = find('data-desktop-sc-icon', 'refresh')
  icon.props.onClick({ stopPropagation() {}, preventDefault() {} })
  icon.props.onClick({ stopPropagation() {}, preventDefault() {} })
  await settle(2)
  const after = requests.filter((r) => r.route === 'status' && r.cwd === A).length
  check('4) 两次刷新只发一个 status 请求', after - before, 1)
  release('status', A)
}

console.log('')
console.log('=== 5. 写操作（checkout）的收尾不许写进新工作区 ===')
{
  rootKey = `race${mountSeq++}`
  hold = () => false
  await switchTo(A)
  find('data-desktop-branch-trigger').props.onClick()
  await settle()
  // A 的 checkout 挂起。
  hold = (route, cwd) => route === 'checkout' && cwd === A
  const rowA = findAll('data-desktop-branch-option').find((n) => n.props['data-desktop-branch-name'] === 'a-feature')
  rowA.props.onDoubleClick()
  await settle(2)
  checkTrue('5) 发起了 A 的 checkout', pending.some((p) => p.route === 'checkout' && p.cwd === A))
  // 切到 B（B 的请求立即返回）。
  await switchTo(B)
  const beforeLabel = chipBranch()
  // 放行 A 的 checkout：它回的是 A 的状态（alpha）。
  release('checkout', A, { ...STATUS_A, branchesStale: true })
  const nodes = await settle()
  // 只比分支名：徽章上还会拼 `*7` 这类标记，那与"是不是同一个项目"无关。
  const strip = (text) => text.replace(/[*↑↓].*$/u, '')
  check('   写操作回填没覆盖 B', `${strip(beforeLabel)}->${strip(chipLabel(nodes))}`, 'beta->beta')
  // busy 是"这次写操作"的开关：旧工作区的请求收尾时不许把它（以及别的状态）写进新工作区。
  check(
    '   旧工作区的 busy 没漏过来（行仍可用）',
    findAll('data-desktop-branch-option', nodes).every((n) => n.props.disabled !== true),
    'true',
  )
}

console.log('')
console.log('=== 6. 写操作作废旧 branches 请求后，必须真的重发一次 ===')
// 这一节是"single-flight 与写抢占打架"的回归：
//   旧的 branches 请求还在飞 → 写操作抢占 branches 分片 → host 回 branchesStale →
//   客户端调 loadBranches()。此时如果 single-flight 复用了**那条已经作废的**在途请求，
//   调用方 await 完会发现 `accept` 为假：既没有发新请求，也没有关 loading——
//   界面永远停在"正在加载分支…"，列表永远是旧的。
{
  rootKey = `race${mountSeq++}`
  hold = () => false
  // 造出"合并进行中"：面板会露出「中止合并」入口，它是**不关闭面板**的写操作
  // （推送/新建等对话框在成功后会关面板，那样后面的断言就没得看了）。
  statusExtra = { merging: true }
  sessionWorkspace = A
  await settle()
  find('data-desktop-branch-trigger').props.onClick()
  await settle()
  const branchesOf = () => requests.filter((r) => r.route === 'branches' && r.cwd === A).length
  const baseline = branchesOf()

  // 手动刷新一次并把它**挂起**：这就是"旧的、还在飞的"那一次。
  hold = (route, cwd) => route === 'branches' && cwd === A
  find('data-desktop-sc-icon', 'refresh').props.onClick({ stopPropagation() {}, preventDefault() {} })
  await settle(2)
  const inFlight = branchesOf()
  check('6) 前置：刷新请求在飞', inFlight, baseline + 1)
  check('   面板处于加载中', textOf(find('data-desktop-branch-menu')).includes('loadingBranches'), 'true')

  // 写操作：点「中止合并」。进度区块与快捷操作都在列表**之外**，因此 loading 时也点得到
  // （列表里的行与"抓取全部远端"图标此时都被加载态替代了）。
  const progress = find('data-desktop-sc-progress')
  checkTrue('   有中止入口', progress !== null)
  collectHostNodes(progress, 'probe').find((node) => node.props?.type === 'button').props.onClick({ stopPropagation() {}, preventDefault() {} })
  await settle(2)
  checkTrue('   写操作确实发出了', requests.some((r) => r.route === 'op/abort' && r.cwd === A))
  check('   写操作之后真的又发了一次 branches', branchesOf(), inFlight + 1)
  check('   确实有两条 branches 请求叠在一起', pending.filter((p) => p.route === 'branches' && p.cwd === A).length, 2)

  // 放行**旧**的那一条（先入队的那个），给它一份"陈旧列表"：不许被采用，也不许关 loading。
  release('branches', A, { branches: [branch('stale-one', { current: true })], counts: { local: 1, remote: 0 } })
  await settle()
  check(
    '   旧列表没有被采用',
    findAll('data-desktop-branch-option').some((n) => n.props['data-desktop-branch-name'] === 'stale-one'),
    'false',
  )
  check('   旧请求没有关掉新请求的 loading', textOf(find('data-desktop-branch-menu')).includes('loadingBranches'), 'true')

  // 放行**新**的那一条：loading 关闭，列表换成新数据。
  release('branches', A, { branches: [branch('fresh-one'), branch('fresh-two')], counts: { local: 2, remote: 0 } })
  await settle()
  const names = [...new Set(findAll('data-desktop-branch-option').map((n) => n.props['data-desktop-branch-name']))]
  check('   新列表已生效', names.join(','), 'fresh-one,fresh-two')
  check('   loading 已关闭', textOf(find('data-desktop-branch-menu')).includes('loadingBranches'), 'false')
  // 复原状态，避免影响后续（这一节是最后一个，但保持测试之间不互相污染的习惯）。
  statusExtra = {}
  hold = () => false
}

console.log('')
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
