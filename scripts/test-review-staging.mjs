// 验证「更改」区块的暂存与提交：分组判定、暂存/取消暂存、提交框的禁用与请求、未跟踪组的折叠。
//
//   node scripts/test-review-staging.mjs
//
// 为什么需要它：这是整个插件里**唯一会改写仓库索引与历史**的界面（`git add` 与
// `git commit`）。宿主的 103 项断言已经证明了路由本身，但"界面上点一下到底发了什么"
// 是另一层：分组错一个文件、提交按钮在信息为空时仍可点、批量暂存把未跟踪文件的样本
// 当成全部——这些都不会让路由测试变红。
//
// 桩的三条规则见 test-gitbar-source-panel.mjs / test-review-graph-view.mjs 的说明。
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
    // deps 为 undefined 时必须重算（真实 React 如此）；否则 stub 会拿到旧值。
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

// ---- 假 host ---------------------------------------------------------------------
//
// 数据形状与**共享快照**一致：宿主在 `/workspace` 里一次给出文件列表 + 每个文件的索引态
// （`staged` / `unstaged` / `untracked`），界面上的三个分组与逐行标记全部由这一份数据算出。
// 因此这里的夹具必须覆盖 porcelain 的四种形状（已用真实 git 验证过）：
//   `new-staged.txt`  只有已暂存（A ）
//   `unstaged.txt`    只有未暂存（ M）
//   `both.txt`        **两边都有**（MM）——它会同时出现在 Staged 与 Changes 两组里
//   三个 untracked-*.txt  未跟踪（??）
const FILES = [
  { path: 'new-staged.txt', status: 'A', added: 5, removed: 0, staged: true, unstaged: false, untracked: false },
  { path: 'unstaged.txt', status: 'M', added: 2, removed: 1, staged: false, unstaged: true, untracked: false },
  { path: 'both.txt', status: 'M', added: 3, removed: 3, staged: true, unstaged: true, untracked: false },
  { path: 'untracked-1.txt', status: 'A', added: 1, removed: 0, staged: false, unstaged: false, untracked: true },
  { path: 'untracked-2.txt', status: 'A', added: 1, removed: 0, staged: false, unstaged: false, untracked: true },
  { path: 'untracked-3.txt', status: 'A', added: 1, removed: 0, staged: false, unstaged: false, untracked: true },
]

const SNAPSHOT = {
  isRepo: true,
  branch: 'main',
  head: 'a'.repeat(40),
  files: FILES,
  diff: '',
  truncated: false,
}

const posts = []
/** 当前 `/workspace` 的响应（测试中途会改它，造"干净""非仓库""请求失败"三种状态）。 */
let workspaceResponse = () => SNAPSHOT
let writeError = null
/** 记录每一次请求的 `{ route, body, url }`，供"发到哪条路由、带了什么"的断言使用。 */
const requests = []

/**
 * 未跟踪文件假数据：`file-history` 也要有个响应，否则点开变更记录会拿到 `{ isRepo: true }`
 * 而没有 `commits`，界面显示空列表——那样就分不清"没有历史"与"请求没发出去"。
 */
const FILE_HISTORY = {
  isRepo: true,
  commits: [
    { hash: 'a'.repeat(40), short: 'aaaaaaa', author: 'tester', date: '2026-01-02', subject: 'second touch' },
    { hash: 'b'.repeat(40), short: 'bbbbbbb', author: 'tester', date: '2026-01-01', subject: 'first touch' },
  ],
}

const fetchBase = async (url, init) => {
  const target = String(url)
  const route = target.slice(target.indexOf('/dsh-desktop/review/') + '/dsh-desktop/review/'.length).split('?')[0]
  const body = init?.body === undefined ? undefined : JSON.parse(init.body)
  requests.push({ route, body, url: target })
  // 本插件的 `call` 是**只发 POST** 的辅助函数，读接口也走 POST —— 因此"是不是写操作"
  // 必须按**路由**判断，不能按 method 判断。早先按 method 判断，于是读 status 也被当成
  // 写操作，返回了 `{ isRepo: true }`（没有 tracked/untracked），面板于是显示"工作区干净"，
  // 而真实界面是对的。
  if (route === 'workspace') return { ok: true, text: async () => JSON.stringify(workspaceResponse()) }
  if (route === 'file-history') return { ok: true, text: async () => JSON.stringify(FILE_HISTORY) }
  if (route === 'untracked') return { ok: true, text: async () => JSON.stringify({ isRepo: true, paths: [], total: 0, truncated: false }) }
  posts.push({ route, body })
  if (writeError !== null) {
    const failure = writeError
    writeError = null
    return { ok: false, text: async () => JSON.stringify(failure) }
  }
  return { ok: true, text: async () => JSON.stringify({ isRepo: true }) }
}

globalThis.fetch = fetchBase

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
      entries.set(`${options.name}:${options.key ?? options.id}`, { component, options })
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
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `（期望 ${expected}）`}`)
}
const checkTrue = (label, actual) => check(label, actual === true, true)

// =================================================================================
console.log('=== 1. classifyEntry：porcelain 的 XY 两列 ===')
const classify = loaded.__stagingClassifyForTest
checkTrue('1) 导出了 classifyEntry', typeof classify === 'function')
check('1) `A ` 只有已暂存', JSON.stringify(classify({ index: 'A', worktree: ' ' })), '{"staged":true,"unstaged":false}')
check('   ` M` 只有未暂存', JSON.stringify(classify({ index: ' ', worktree: 'M' })), '{"staged":false,"unstaged":true}')
// 这一条是本区块最容易做错的地方：同一个文件两边都有改动时，它必须在**两组里都出现**。
check('   `MM` 两边都有', JSON.stringify(classify({ index: 'M', worktree: 'M' })), '{"staged":true,"unstaged":true}')
check('   `??` 两组都不算（它是未跟踪）', JSON.stringify(classify({ index: '?', worktree: '?' })), '{"staged":false,"unstaged":false}')
check('   `D ` 已暂存的删除', JSON.stringify(classify({ index: 'D', worktree: ' ' })), '{"staged":true,"unstaged":false}')
check('   ` M`（删除未暂存）', JSON.stringify(classify({ index: ' ', worktree: 'D' })), '{"staged":false,"unstaged":true}')
// 形状不对时不许抛错：面板在中间态下会照样调用它。
check('   空对象不抛错', JSON.stringify(classify({})), '{"staged":false,"unstaged":false}')
check('   undefined 不抛错', JSON.stringify(classify(undefined)), '{"staged":false,"unstaged":false}')

// ---- 渲染 ------------------------------------------------------------------------
const Staging = loaded.__stagingSectionForTest
const snapshotStore = loaded.__gitSnapshotForTest
const WORKSPACE = 'F:\\code\\projA'
const mountProps = {
  t: (key, params) => {
    if (params === undefined) return key
    return Object.entries(params).reduce((text, [name, value]) => text.split(`{${name}}`).join(String(value)), key)
  },
  workspace: WORKSPACE,
  onCommitted: () => undefined,
  /**
   * 快照用 **getter** 传：组件每次渲染都从共享 store 现读一次，因此"写操作之后 store 重取
   * 了新快照"这件事会像真实界面一样反映到下一次渲染里（静态对象做不到这一点）。
   */
  get snapshot() {
    return snapshotStore.get(WORKSPACE)
  },
}

/** 直接往 store 里写一份快照（等价于 host 回了一次 `/workspace`）。 */
function setSnapshot(payload) {
  snapshotStore.set(WORKSPACE, payload)
}

let mountSeq = 0
let rootKey = ''
let settledNodes = []

async function settle() {
  for (let pass = 0; pass < 4; pass += 1) {
    const queued = []
    const { tree, effects } = render(Staging, mountProps, rootKey)
    queued.push(...effects)
    settledNodes = collectHostNodes(tree, rootKey, queued)
    for (const effect of queued) effect()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return settledNodes
}

const find = (attr, value) =>
  collectHostNodes(render(Staging, mountProps, rootKey).tree, rootKey).find((node) =>
    value === undefined ? node.props?.[attr] !== undefined : node.props?.[attr] === value,
  ) ?? null
const findAll = (attr) =>
  collectHostNodes(render(Staging, mountProps, rootKey).tree, rootKey).filter((node) => node.props?.[attr] !== undefined)
const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node !== 'object') return ''
  return textOf(node.props?.children)
}

/**
 * 整棵已渲染界面的文本。
 *
 * 比 `textOf(find(...))` 可靠：后者读的是"没跑过副作用"的那次渲染，异步状态还没落进去。
 */
function viewText() {
  return collectHostNodes(render(Staging, mountProps, rootKey).tree, rootKey)
    .map((node) => textOf(node))
    .join(' ')
}

async function click(node) {
  if (node === null || typeof node.props?.onClick !== 'function') return false
  node.props.onClick({ stopPropagation() {}, preventDefault() {} })
  await settle()
  return true
}

/**
 * 勾选/取消勾选一个 checkbox。
 *
 * 必须走 `onChange`：`click()` 调的是 `onClick`，而 checkbox 的状态变化走的是
 * `onChange`，用 click 勾不动它（实测踩到过——断言"勾了两个"却是 0 个）。
 */
async function toggleCheck(node, next) {
  if (node === null || typeof node.props?.onChange !== 'function') return false
  node.props.onChange({ target: { checked: next === undefined ? node.props.checked !== true : next } })
  await settle()
  return true
}

async function mount(options) {
  rootKey = `staging${mountSeq++}`
  settledNodes = []
  if (options?.reload === true) {
    // 走一次**真实请求**，让 store 自己进入错误态（用于"读接口失败"的场景：那条路径只有
    // 真的发一次请求才会走到，直接写快照是写不出错误态的）。
    await snapshotStore.invalidate(WORKSPACE)
  } else {
    setSnapshot(workspaceResponse())
  }
  await settle()
}

console.log('')
console.log('=== 2. 三个分组：Staged / Changes / Unversioned ===')
await mount()
check('2) 区块已渲染', find('data-staging') !== null, 'true')
{
  const groups = [...new Set(findAll('data-staging-group').map((n) => n.props['data-staging-group']))]
  // 三组，与 IDEA 的 Git 工具窗一致：索引里有什么（Staged）、工作区还剩什么（Changes）、
  // 还没进版本管理的新文件（Unversioned）。分组全部由**同一份快照**过滤得出。
  check('   三组：已暂存 + 更改 + 未跟踪', groups.join(','), 'staged,unstaged,untracked')
  const rows = findAll('data-staging-row')
  const trackedRows = rows.filter((r) => r.props['data-staging-side'] !== 'untracked').map((r) => r.props['data-staging-row'])
  // 已跟踪的每个文件至少一行；`MM` 的 both.txt 在两组里各出现一次（IDEA 也是这样）。
  check('   已跟踪改动覆盖全部文件', [...new Set(trackedRows)].join(','), 'new-staged.txt,both.txt,unstaged.txt')
  check('   `MM` 的文件在两组里各一行', trackedRows.filter((p) => p === 'both.txt').length, 2)
  // 每一行显示的动作必须与它所在的分组一致：Staged 组是"取消暂存"，Changes 组是"暂存"。
  const actionOf = (path, side) => {
    const row = findAll('data-staging-row').find(
      (n) => n.props['data-staging-row'] === path && (side === undefined || n.props['data-staging-side'] === side),
    )
    if (row === undefined) return '(no-row)'
    const btn = collectHostNodes(row, 'probe').find((n) => n.props?.['data-staging-row-action'] !== undefined)
    return btn?.props?.['data-staging-row-action'] ?? '(none)'
  }
  check('   Staged 组的行内动作是取消暂存', actionOf('both.txt', 'staged'), 'unstage')
  check('   Changes 组的行内动作是暂存', actionOf('both.txt', 'unstaged'), 'stage')
  check('   纯工作区改动 -> 行内动作是暂存', actionOf('unstaged.txt', 'unstaged'), 'stage')
}
// 未跟踪组默认**展开**（见下面第 3 节）：这一版把它做成可勾选后"加入 git"，
// 默认折叠会让这个功能看不见。
check('   未跟踪组默认展开', find('data-staging-untracked-list') !== null, 'true')
// 未跟踪组的计数与列出的行数**同源**（都来自快照里的文件），因此必然相等。
{
  const titleText = viewText().replace(/\s+/gu, '')
  check('   未跟踪计数就是快照里的 3 个', titleText.includes('untrackedTitle3'), 'true')
}

console.log('')
console.log('=== 3. 未跟踪列表：勾选 + 加入 git ===')
// 未跟踪组**默认展开**：这一版把它从"折叠 + 只列 20 条"改成可勾选后"加入 git"，
// 默认折叠会让这个功能看不见（用户得先猜到要去哪里展开）。列表上限放宽到 500 条，
// 因此只在真的被截断时才提示。
check('3) 列表默认展开', find('data-staging-untracked-list') !== null, 'true')
check('   列出全部 3 条', findAll('data-staging-row').filter((r) => r.props['data-staging-side'] === 'untracked').length, 3)
// 3 条远低于渲染上限（50），因此**不该**出现"只列出前 N 个"的提示。
check('   未超上限时不提示截断', find('data-staging-untracked-truncated'), null)
// 每条未跟踪文件都要有勾选框：这正是"把未跟踪文件加入 git"的入口（参考 IDEA）。
check('   每条都有勾选框', findAll('data-staging-pick').length, 3)
// 默认**不勾选**（IDEA 里新文件也不会自动进暂存区），因此"加入 git"按钮初始禁用。
check('   默认没有勾选', findAll('data-staging-pick').filter((n) => n.props.checked === true).length, 0)
check('   「加入 git」初始禁用', find('data-staging-add-chosen')?.props?.disabled, true)

// 勾两个 → 按钮可用、计数正确 → 点它只 add 这两个。
await toggleCheck(find('data-staging-pick', 'untracked-1.txt'))
await toggleCheck(find('data-staging-pick', 'untracked-3.txt'))
check('   勾选计数', textOf(find('data-staging-chosen-count')).includes('chosenCount'), 'true')
check('   两个勾选框已选中', findAll('data-staging-pick').filter((n) => n.props.checked === true).length, 2)
check('   「加入 git」已可用', find('data-staging-add-chosen')?.props?.disabled, false)
posts.length = 0
await click(find('data-staging-add-chosen'))
check('   点它发出 stage', posts.map((p) => p.route).join(','), 'stage')
check(
  '   只加入勾选的那两个',
  JSON.stringify(posts[0].body.paths),
  '["untracked-1.txt","untracked-3.txt"]',
)
checkTrue('   给出"已加入 git"提示', textOf(find('data-staging-notice')).includes('addedNotice'))
// 加完之后勾选要清空，否则用户会以为还要再点一次。
check('   加入后清空勾选', findAll('data-staging-pick').filter((n) => n.props.checked === true).length, 0)

console.log('')
console.log('=== 3b. 全选 / 全不选 ===')
{
  await click(find('data-staging-toggle-all', 'untracked'))
  check('3b) 全选后 3 个都选中', findAll('data-staging-pick').filter((n) => n.props.checked === true).length, 3)
  await click(find('data-staging-toggle-all', 'untracked'))
  check('   再点一次全部取消', findAll('data-staging-pick').filter((n) => n.props.checked === true).length, 0)
  // 单行的 `+` 仍然可用（只想加一个时不必先勾选）。
  posts.length = 0
  const oneRow = findAll('data-staging-row').find((r) => r.props['data-staging-row'] === 'untracked-2.txt')
  const plus = collectHostNodes(oneRow, 'probe').find((n) => n.props?.['data-staging-row-action'] !== undefined)
  await click(plus)
  check('   单行 + 加入一个', JSON.stringify(posts[0]?.body?.paths), '["untracked-2.txt"]')
}

console.log('')
console.log('=== 4. 单文件暂存 / 取消暂存 ===')
{
  posts.length = 0
  // 更改组里 unstaged.txt 的"+"按钮。
  const row = findAll('data-staging-row').find((r) => r.props['data-staging-row'] === 'unstaged.txt' && r.props['data-staging-side'] === 'unstaged')
  const button = collectHostNodes(row, 'probe').find((n) => n.props?.['data-staging-row-action'] !== undefined)
  await click(button)
  check('4) 发出 stage', posts.map((p) => p.route).join(','), 'stage')
  check('   只暂存这一个文件', JSON.stringify(posts[0].body), JSON.stringify({ workspace: WORKSPACE, paths: ['unstaged.txt'] }))
  checkTrue('   暂存后给出提示', textOf(find('data-staging-notice')).includes('stagedNotice'))
}
{
  posts.length = 0
  const row = findAll('data-staging-row').find((r) => r.props['data-staging-row'] === 'new-staged.txt' && r.props['data-staging-side'] === 'staged')
  const button = collectHostNodes(row, 'probe').find((n) => n.props?.['data-staging-row-action'] !== undefined)
  await click(button)
  check('   取消暂存走 unstage 路由', posts.map((p) => p.route).join(','), 'unstage')
  check('   请求体', JSON.stringify(posts[0].body), JSON.stringify({ workspace: WORKSPACE, paths: ['new-staged.txt'] }))
  check('   按钮动作标记是 unstage', button?.props?.['data-staging-row-action'], 'unstage')
}

console.log('')
console.log('=== 4b. 行内还原：确认之后才发请求，并统一刷新快照 ===')
{
  await mount()
  posts.length = 0
  const before = requests.filter((r) => r.route === 'workspace').length
  const revertButton = find('data-staging-revert', 'unstaged.txt')
  checkTrue('4b) 有还原入口', revertButton !== null)
  await click(revertButton)
  // 还原会改写工作区，必须先弹确认框；**确认之前一个请求都不该发**。
  check('   弹出了确认框', find('data-review-revert-dialog', 'unstaged.txt') !== null, 'true')
  check('   确认前不发请求', posts.length, 0)
  // 确认框里的「还原」按钮：按文案键找（字典桩原样回显键名）。
  const confirm = collectHostNodes(find('data-review-revert-dialog', 'unstaged.txt'), 'probe').find(
    (n) => n.props?.type === 'button' && textOf(n).includes('revert') && !textOf(n).includes('revertCancel'),
  )
  checkTrue('   确认框里有还原按钮', confirm !== undefined)
  posts.length = 0
  confirm.props.onClick()
  await settle()
  check('   发出 revert', posts.map((p) => p.route).join(','), 'revert')
  check('   只还原这一个文件', JSON.stringify(posts[0]?.body?.paths), '["unstaged.txt"]')
  check('   还原源是 HEAD（scope=workspace）', posts[0]?.body?.scope, 'workspace')
  check('   成功后重新取快照（统一 invalidate）', requests.filter((r) => r.route === 'workspace').length > before, 'true')
  check('   确认框已关闭', find('data-review-revert-dialog'), null)
}

console.log('')
console.log('=== 5. 分组级批量按钮 ===')
// 注意桩里的 `body` 已经 JSON.parse 过了，这里直接读对象，不要再 parse 一次。
{
  posts.length = 0
  // Staged 组的批量动作是"全部取消暂存"。
  await click(find('data-staging-action', 'unstage-all'))
  check('5) 全部取消暂存：自定义组里的全部文件', JSON.stringify(posts[0]?.body?.paths), '["new-staged.txt","both.txt"]')
}
{
  posts.length = 0
  // Changes 组的批量动作是"全部暂存"。
  await click(find('data-staging-action', 'stage-all'))
  check('   全部暂存：更改组里的全部文件', JSON.stringify(posts[0]?.body?.paths), '["unstaged.txt","both.txt"]')
}
{
  posts.length = 0
  // 未跟踪组的批量入口现在是"全选/全不选"勾选框（IDEA 同款），**不再是**一个直接
  // add 的按钮：先勾、再点「加入 git」，这样"加哪些"由用户明确决定。
  await click(find('data-staging-toggle-all', 'untracked'))
  check('   全选后 3 个都勾上', findAll('data-staging-pick').filter((n) => n.props.checked === true).length, 3)
  posts.length = 0
  await click(find('data-staging-add-chosen'))
  check(
    '   加入 git 只提交列出的这批路径',
    JSON.stringify(posts[0]?.body?.paths),
    '["untracked-1.txt","untracked-2.txt","untracked-3.txt"]',
  )
  await click(find('data-staging-toggle-all', 'untracked'))
}

console.log('')
console.log('=== 6. 提交框：禁用条件与请求 ===')
{
  const messageNode = find('data-staging-message')
  checkTrue('6) 有提交信息输入框', messageNode !== null)
  check('   未填信息时提交禁用', find('data-staging-commit')?.props?.disabled, true)
  checkTrue('   并说明为什么禁用', textOf(find('data-staging-hint')).includes('emptyMessage'))
  // 填上信息后应可用（当前有已暂存的文件）。
  messageNode.props.onChange({ target: { value: 'feat: 暂存并提交' } })
  await settle()
  check('   填了信息后可用', find('data-staging-commit')?.props?.disabled, false)
  checkTrue('   提示说明本次会提交几个', textOf(find('data-staging-hint')).includes('willCommitCount'))
}
{
  posts.length = 0
  await click(find('data-staging-commit'))
  check('   发出 commit', posts.map((p) => p.route).join(','), 'commit')
  check('   请求体带提交信息', posts[0]?.body?.message, 'feat: 暂存并提交')
  check('   成功后输入框清空', find('data-staging-message')?.props?.value, '')
  checkTrue('   给出提交成功提示', textOf(find('data-staging-notice')).includes('committedNotice'))
}

console.log('')
console.log('=== 7. 提交被拒：code → 本地化短句 + git 原文 ===')
{
  writeError = { error: 'nothing staged', code: 'nothingStaged', detail: 'nothing to commit, working tree clean' }
  const messageNode = find('data-staging-message')
  messageNode.props.onChange({ target: { value: '再试一次' } })
  await settle()
  await click(find('data-staging-commit'))
  checkTrue('7) 显示本地化短句', textOf(find('data-staging-error')).includes('error_nothingStaged'))
  checkTrue('   原样显示 git 原文', textOf(find('data-staging-error')).includes('nothing to commit'))
  check('   错误区带 code 标记', find('data-staging-error')?.props?.['data-staging-error'], 'nothingStaged')
  // 失败时**不清空**输入框：失败原因往往与提交信息无关，清掉等于让用户重打一遍。
  check('   失败时保留已填信息', find('data-staging-message')?.props?.value, '再试一次')
}

console.log('')
console.log('=== 8. 未知 code 不吞掉原始错误 ===')
{
  writeError = { error: 'weird', code: 'somethingNew', detail: 'raw git words' }
  await click(find('data-staging-commit'))
  checkTrue('8) 落到通用短句', textOf(find('data-staging-error')).includes('error_unknownReview'))
  checkTrue('   仍然显示 git 原文', textOf(find('data-staging-error')).includes('raw git words'))
}

console.log('')
console.log('=== 9. 空仓库与干净工作区 ===')
{
  workspaceResponse = () => ({ isRepo: true, branch: 'main', head: 'a'.repeat(40), files: [], diff: '', truncated: false })
  await mount()
  checkTrue('9) 干净时给出空态', viewText().includes('noStagedOrChanged'))
  check('   没有任何分组', findAll('data-staging-group').length, 0)
  check('   提交按钮禁用', find('data-staging-commit')?.props?.disabled, true)
}
{
  workspaceResponse = () => ({ isRepo: false })
  await mount()
  checkTrue('   非仓库给出提示', viewText().includes('notRepo'))
}
{
  workspaceResponse = () => SNAPSHOT
  globalThis.fetch = (() => {
    const original = globalThis.fetch
    return async (url, init) => {
      // 按**路由**判断而不是按 method：本插件的 `call` 只发 POST，读接口也是 POST，
      // 用 `init.method === undefined` 当"读请求"的判据永远不会命中。
      if (String(url).includes('/review/workspace')) {
        return { ok: false, text: async () => JSON.stringify({ error: 'boom', code: 'workspaceNotAllowed', detail: 'workspace must be one of the workspaces known to this app' }) }
      }
      return original(url, init)
    }
  })()
  await mount({ reload: true })
  {
    // 读接口失败时走的也是与"非仓库"同一个 `statusBlock` 分支（上一条已经断言它能渲染出
    // 文案），这里确认走到的是**错误态**而不是把失败当成"工作区干净"。
    const all = collectHostNodes(render(Staging, mountProps, rootKey).tree, rootKey)
    const text = all.map((n) => textOf(n)).join(' ')
    checkTrue('   失败态渲染出提示块', all.length > 0)
    check('   没有把失败误当成"工作区干净"', text.includes('noStagedOrChanged'), false)
    check('   没有渲染出任何分组', all.filter((n) => n.props?.['data-staging-group'] !== undefined).length, 0)
    checkTrue('   提示里带上了原因', text.includes('workspace must be one of the workspaces known to this app'))
  }
}

console.log('')
console.log('=== 9b. 提交：默认全选、一步到位、可排除 ===')
{
  workspaceResponse = () => SNAPSHOT
  globalThis.fetch = fetchBase
  await mount()
  // 三组都在，且 `MM` 的文件在两组里各出现一次（这是"分组回答不同问题"的直接证据）。
  const groups = [...new Set(findAll('data-staging-group').map((n) => n.props['data-staging-group']))]
  check('9b) 三组都在', groups.join(','), 'staged,unstaged,untracked')
  const bothRows = findAll('data-staging-row').filter((n) => n.props['data-staging-row'] === 'both.txt' && n.props['data-staging-side'] !== 'untracked')
  check('   `MM` 的文件在两组里各一行', bothRows.length, 2)
  // 已跟踪文件按路径去重后共 3 个，每个一个勾选框。
  check('   每个已跟踪文件一个勾选框', findAll('data-staging-file-pick').length, 4)
  // **默认全部勾选** —— 这是"不用先加暂存"的核心：提交直接一步到位。
  check(
    '   默认全部勾选',
    [...new Set(findAll('data-staging-file-pick')
      .filter((n) => n.props.checked === true)
      .map((n) => n.props['data-staging-file-pick']))]
      .sort()
      .join(','),
    'both.txt,new-staged.txt,unstaged.txt',
  )

  // 只填提交信息就能提交（不需要先暂存、也不需要先勾选）。
  check('   未填信息时禁用', find('data-staging-commit')?.props?.disabled, true)
  checkTrue('   提示要求先填信息', textOf(find('data-staging-hint')).includes('emptyMessage'))
  find('data-staging-message').props.onChange({ target: { value: 'feat: 一步提交' } })
  await settle()
  check('   填了信息后提交可用', find('data-staging-commit')?.props?.disabled, false)
  checkTrue('   提示说明本次会提交几个', textOf(find('data-staging-hint')).includes('willCommitCount'))

  // 默认提交 = 全部已跟踪改动（host 先 add 再 commit）。
  posts.length = 0
  await click(find('data-staging-commit'))
  check('   发出 commit', posts[0]?.route, 'commit')
  check(
    '   默认提交全部已跟踪改动',
    JSON.parse(JSON.stringify(posts[0]?.body?.paths)).sort().join(','),
    'both.txt,new-staged.txt,unstaged.txt',
  )
  check('   没有 push 标记', posts[0]?.body?.push, undefined)

  // 取消勾选一个之后，只提交剩下的。
  //
  // 注意上一次提交成功后输入框被清空（有意），因此要重新填。
  check('   提交后输入框已清空', find('data-staging-message')?.props?.value, '')
  await toggleCheck(find('data-staging-file-pick', 'both.txt'), false)
  find('data-staging-message').props.onChange({ target: { value: 'feat: 排除一个' } })
  await settle()
  check('   排除一个后提交仍可用', find('data-staging-commit')?.props?.disabled, false)
  console.log(`  [debug] 勾选=${JSON.stringify(findAll('data-staging-file-pick').filter((n) => n.props.checked === true).map((n) => n.props['data-staging-file-pick']))}`)
  posts.length = 0
  await click(find('data-staging-commit'))
  check('   排除后确实发出了 commit', posts.length, 1)
  check(
    '   排除后只提交剩下的',
    (posts[0]?.body?.paths ?? []).slice().sort().join(','),
    'new-staged.txt,unstaged.txt',
  )

  // 「提交并推送」带 push: true。
  find('data-staging-message').props.onChange({ target: { value: 'feat: 提交并推送' } })
  await settle()
  posts.length = 0
  await click(find('data-staging-commit-push'))
  check('   提交并推送发出 commit', posts[0]?.route, 'commit')
  check('   带 push: true', posts[0]?.body?.push, true)

  // 组级全选 / 取消全选。两个已跟踪分组都要取消，才真的没有任何选中 → 提交按钮禁用
  // （那是明确的意图）。`MM` 的文件在两组里各有一行，但勾选状态按**路径**记录，
  // 因此取消任一组都会把它一起取消——这里两组各点一次，覆盖全部三个路径。
  await toggleCheck(find('data-staging-group-pick', 'unstaged'), false)
  await toggleCheck(find('data-staging-group-pick', 'staged'), false)
  check('   取消全选后没有勾选', findAll('data-staging-file-pick').filter((n) => n.props.checked === true).length, 0)
  find('data-staging-message').props.onChange({ target: { value: 'feat: 全不选' } })
  await settle()
  check('   全不选时提交禁用', find('data-staging-commit')?.props?.disabled, true)
  checkTrue('   提示说明要先勾选', textOf(find('data-staging-hint')).includes('noSelection'))
  await toggleCheck(find('data-staging-group-pick', 'unstaged'), true)
  await toggleCheck(find('data-staging-group-pick', 'staged'), true)
  check(
    '   再全选回来（按路径去重后 3 个）',
    new Set(findAll('data-staging-file-pick').filter((n) => n.props.checked === true).map((n) => n.props['data-staging-file-pick'])).size,
    3,
  )
}

console.log('')
console.log('=== 9c. 每个文件都能看变更记录 ===')
{
  await mount()
  check('9c) 每行都有变更记录按钮', findAll('data-staging-history').length >= 4, 'true')
  check('   默认没有展开记录面板', find('data-staging-history-panel') === null, 'true')
  await click(find('data-staging-history', 'unstaged.txt'))
  check('   点开后出现记录面板', find('data-staging-history-panel') !== null, 'true')
  const historyRequest = requests.filter((r) => r.url.includes('/review/file-history'))
  check('   请求了 file-history', historyRequest.length, 1)
  check('   带上文件路径', historyRequest[0].body.path, 'unstaged.txt')
  // 展开的必须是点的那一个文件。
  check('   面板属于被点的文件', find('data-staging-history-panel')?.props?.['data-staging-history-panel'], 'unstaged.txt')
  await click(find('data-staging-history', 'unstaged.txt'))
  check('   再点收起', find('data-staging-history-panel') === null, 'true')
}

console.log('')
console.log('=== 10. 文件列表：总变动行数 + 暂存标记 ===')
// `FileList` 是"总变动行数"与"暂存标记"的渲染处。用户反馈的两件事——"外部数字显示
// 有问题"与"文件可以选择性提交（但看不出哪个已暂存）"——都落在这里，因此逐条钉住：
//   1. 头部的总数必须**等于各行之和**（同一份数据算出来，不可能不一致）；
//   2. 每个文件都要有暂存标记，且与数据一致。
{
  const FileList = loaded.__fileListForTest
  checkTrue('10) 导出了 FileList', typeof FileList === 'function')

  const files = [
    { path: 'src/a.ts', status: 'M', added: 3, removed: 1, staged: false, unstaged: true, untracked: false },
    { path: 'src/b.ts', status: 'A', added: 10, removed: 0, staged: true, unstaged: false, untracked: false },
    { path: 'new.txt', status: 'A', added: 2, removed: 0, staged: false, unstaged: false, untracked: true },
  ]
  const listProps = {
    t: mountProps.t,
    result: { isRepo: true, scope: 'workspace', files, diff: '', truncated: false },
    phase: 'ready',
    message: '',
    workspace: 'F:\\code\\projA',
    sessionId: 's1',
    onChanged: () => undefined,
  }
  const listKey = 'filelist'
  const listOut = render(FileList, listProps, listKey)
  for (const effect of listOut.effects) effect()
  const hosts = collectHostNodes(render(FileList, listProps, listKey).tree, listKey)

  const totalNode = hosts.find((n) => n.props?.['data-review-total-stats'] !== undefined)
  checkTrue('   头部有总变动行数', totalNode !== undefined)
  const totalText = textOf(totalNode).replace(/\s+/gu, '')
  const expectAdded = files.reduce((sum, f) => sum + (f.added ?? 0), 0)
  const expectRemoved = files.reduce((sum, f) => sum + (f.removed ?? 0), 0)
  check('   总数等于各行之和（新增）', totalText.includes(`+${expectAdded}`), true)
  check('   总数等于各行之和（删除）', totalText.includes(`−${expectRemoved}`), true)

  // 每个文件都要有暂存标记，且与数据一致。
  //
  // 按**值**断言而不是按"行里嵌着标记"的层级：假渲染器把宿主节点平铺展开，
  // 用 `collectHostNodes(row)` 去找行内的子孙并不可靠（实测只命中 1 个）。
  const marks = hosts
    .filter((n) => n.props?.['data-review-staged'] !== undefined)
    .map((n) => n.props['data-review-staged'])
  check('   每个文件一个暂存标记', marks.length, files.length)
  check('   其中 1 个已暂存', marks.filter((m) => m === 'yes').length, 1)
  check('   其中 1 个未暂存', marks.filter((m) => m === 'no').length, 1)
  check('   其中 1 个未跟踪', marks.filter((m) => m === 'untracked').length, 1)
  // 标记必须真的挂在对应的那一行上（靠 `data-review-row` 与 path 的对应关系核对）。
  const rowPaths = hosts
    .filter((n) => n.props?.['data-review-row'] !== undefined)
    .map((n) => n.props['data-review-row'])
  check('   三行都渲染了', rowPaths.join(','), files.map((f) => f.path).join(','))
  check(
    '   每行都有行内增删数字',
    hosts.filter((n) => n.props?.['data-review-stats'] !== undefined).length,
    files.length,
  )
}

console.log('')
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
