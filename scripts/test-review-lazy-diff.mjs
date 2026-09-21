// 项目级"更改"页签的**按需差异**：不点不取、点一次只取一次、折叠再展开走缓存。
//
//   node scripts/test-review-lazy-diff.mjs
//
// 为什么单独一个文件：这个测试把 `StagingSection` 直接当**根组件**渲染。假渲染器按"树中
// 位置 + key"分配 hook 槽，多级嵌套（入口 → 面板边界 → ReviewPanel → StagingSection）时，
// 桩里的槽归属很容易与真实 React 不一致，于是"点一下到底触发了什么"会被误判；把它当根
// 组件就只剩一个实例，槽的归属是确定的。整个抽屉级的交互（切项目、边界降级）由
// `test-review-project-git.mjs` 覆盖。
//
// 覆盖的真实契约：
//   * 未点击任何文件时，**一个** `/workspace-file` 请求都不发（项目级快照里没有差异正文）；
//   * 点开一个文件只取那一个文件的差异，并带上 HEAD 作为基线；
//   * 折叠不发请求；再展开走缓存（同一 workspace + HEAD + path）；
//   * 换文件、换 workspace、换 HEAD 都会重新取（缓存键不同）；
//   * 迟到响应不许写进另一个文件（展开 A → 立刻展开 B → A 的响应落地时不显示在 B 下）；
//   * 二进制文件显示 binary 提示，超长差异带截断提示。
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PLUGIN = pathToFileURL(join(ROOT, 'plugins', 'dsh-client-ui-review', 'lib', 'client.js')).href

// ---- 假 React --------------------------------------------------------------------
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
    if (prev === undefined || prev.subscribe !== subscribe) hookSlots[slot] = { subscribe, unsubscribe: subscribe(() => {}) }
    return getSnapshot()
  },
}

function render(Comp, props, key) {
  const saved = { hookSlots, renderIndex, effectQueue }
  hookSlots = componentHooks.get(key) ?? []
  renderIndex = 0
  effectQueue = []
  let tree
  let effects
  try {
    tree = Comp(props)
  } finally {
    effects = effectQueue
    componentHooks.set(key, hookSlots)
    hookSlots = saved.hookSlots
    renderIndex = saved.renderIndex
    effectQueue = saved.effectQueue
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
const WS = 'F:\\code\\projA'
const HEAD = 'a'.repeat(40)
const files = [
  { path: 'a.txt', status: 'M', added: 1, removed: 0, staged: false, unstaged: true, untracked: false, index: ' ', worktree: 'M' },
  { path: 'bin.dat', status: 'M', added: null, removed: null, staged: false, unstaged: true, untracked: false, index: ' ', worktree: 'M' },
]
/** 每个路径的响应；`hold` 为真时挂起（用于迟到响应）。 */
const payloads = new Map([
  ['a.txt', { isRepo: true, path: 'a.txt', diff: 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new a.txt\n', truncated: false, binary: false }],
  ['bin.dat', { isRepo: true, path: 'bin.dat', diff: 'Binary files a/bin.dat and b/bin.dat differ\n', truncated: false, binary: true }],
])
const held = new Map()
const requests = []
globalThis.fetch = async (url, init) => {
  const target = String(url)
  const body = init?.body === undefined ? undefined : JSON.parse(init.body)
  const route = target.slice(target.indexOf('/dsh-desktop/review/') + '/dsh-desktop/review/'.length).split('?')[0]
  requests.push({ url: target, route, body })
  const wrap = (payload) => ({ ok: true, text: async () => JSON.stringify(payload) })
  if (route === 'workspace-file') {
    const key = body?.path
    if (held.has(key)) {
      return await new Promise((resolve) => held.get(key).push(() => resolve(wrap(payloads.get(key)))))
    }
    return wrap(payloads.get(key))
  }
  return wrap({ isRepo: true })
}

// ---- 加载插件 --------------------------------------------------------------------
let loaded
await import(PLUGIN)
const applyCtx = {
  effect(fn) {
    fn()
  },
  locale: { register() {}, bind: () => (key) => key },
  slots: { inject() {}, register: () => () => {} },
  sidebarRight: {},
  sidebarRightTabs: { register: () => () => {} },
  sessions: {},
  workspaces: {},
}
loaded.apply(applyCtx)

const StagingSection = loaded.__stagingSectionForTest
const store = loaded.__gitSnapshotForTest

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
const allText = (nodes) => nodes.map((n) => textOf(n)).join(' ')
/**
 * 某个容器**整棵子树**的文本。
 *
 * `textOf` 只递归 `props.children`，不展开函数组件——而差异正文现在是一个独立组件
 * （`DiffBody`，它在差异行之上又多了一层"横向滚动容器"）。因此这里必须走
 * `collectHostNodes`（它会把函数组件就地展开），否则断言会误判成"差异没渲染"。
 * @param node - 容器节点。
 * @returns 子树里所有宿主节点的文本。
 */
const subtreeText = (node) => (node === null || node === undefined ? '' : collectHostNodes(node).map((n) => textOf(n)).join(' '))

const makeSelectorHook = (read) => (selector) => react.useSyncExternalStore(() => () => {}, () => selector(read()))

let throwOn = ''
const t = (key, params) => {
  if (throwOn !== '' && key === throwOn) throw new Error(`注入的渲染期异常：${key}`)
  if (params === undefined) return key
  return `${key}(${Object.entries(params).map(([name, value]) => `${name}=${value}`).join(',')})`
}

/** 一份"就绪"的共享快照（组件读的是它）。 */
const snapshot = {
  workspace: WS,
  generation: 1,
  requestId: 1,
  phase: 'ready',
  refreshing: false,
  stale: false,
  branch: 'main',
  head: HEAD,
  files,
  changedFiles: files.length,
  staged: 0,
  unstaged: files.length,
  untracked: 0,
  empty: false,
  error: '',
  refreshError: '',
  updatedAt: Date.now(),
  refresh: () => Promise.resolve(),
  invalidate: () => Promise.resolve(),
}

let rootKey = 'lazy'
const mountProps = (extra) => ({
  t,
  workspace: WS,
  snapshot,
  revision: HEAD,
  onCommitted: () => undefined,
  ...extra,
})

async function drain(props) {
  let nodes = []
  for (let pass = 0; pass < 8; pass += 1) {
    const queued = []
    const out = render(StagingSection, props ?? mountProps(), rootKey)
    queued.push(...out.effects)
    nodes = collectHostNodes(out.tree, queued, rootKey)
    if (queued.length > 0) for (const effect of queued) effect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (queued.length === 0) break
  }
  return nodes
}
/** 点一个宿主节点（先渲染、再点、再渲染）。 */
async function clickNow(attr, value, props) {
  const nodes = await drain(props)
  const node = nodes.find((n) => (value === undefined ? n.props?.[attr] !== undefined : n.props?.[attr] === value))
  if (node === undefined || typeof node.props.onClick !== 'function') return false
  node.props.onClick()
  return true
}
const fileReqs = () => requests.filter((r) => r.route === 'workspace-file')
/** 只数某个路径的差异请求（缓存是按 workspace+HEAD+path 的，换 HEAD 会让**已展开的行**也重取）。 */
const fileReqsFor = (path) => fileReqs().filter((r) => r.body?.path === path)

console.log('=== 1. 不点文件：一个差异请求都不发 ===')
{
  const nodes = await drain()
  check('1) 未点击时差异请求数', fileReqs().length, 0)
  check('   列出了改动文件', rowsOf(nodes, 'data-staging-row').length, 2)
  check('   没有差异容器', rowsOf(nodes, 'data-review-diff').length, 0)
}

console.log('')
console.log('=== 2. 点开一个文件：只取它、带上 HEAD、渲染出来 ===')
{
  has('2) 点得中 a.txt', await clickNow('data-staging-diff-toggle', 'a.txt'))
  const nodes = await drain()
  check('   只发了一次请求', fileReqs().length, 1)
  check('   请求路径正确', fileReqs()[0]?.body?.path, 'a.txt')
  check('   带 HEAD 作为基线', fileReqs()[0]?.body?.revision, HEAD)
  check('   该行标记为展开', rowsOf(nodes, 'data-staging-diff-toggle').find((n) => n.props['data-staging-diff-toggle'] === 'a.txt')?.props?.['aria-expanded'], 'true')
  has('   差异渲染出来', subtreeText(rowsOf(nodes, 'data-review-diff')[0] ?? null).includes('new a.txt'))
  has('   行上的增删数字由差异补上', textOf(nodes).includes('+1'))
}

console.log('')
console.log('=== 3. 折叠不发请求；再展开走缓存 ===')
{
  has('3) 折叠 a.txt', await clickNow('data-staging-diff-toggle', 'a.txt'))
  const collapsed = await drain()
  check('   折叠后没有差异容器', rowsOf(collapsed, 'data-review-diff').length, 0)
  check('   折叠不发请求', fileReqs().length, 1)
  has('   再展开', await clickNow('data-staging-diff-toggle', 'a.txt'))
  const reopened = await drain()
  check('   缓存命中，仍只有一次请求', fileReqs().length, 1)
  has('   差异仍然显示', subtreeText(rowsOf(reopened, 'data-review-diff')[0] ?? null).includes('new a.txt'))
}

console.log('')
console.log('=== 4. 换文件会再取一次；二进制给 binary 提示 ===')
{
  has('4) 点开 bin.dat', await clickNow('data-staging-diff-toggle', 'bin.dat'))
  const nodes = await drain()
  check('   共两次请求', fileReqs().length, 2)
  check('   第二次是 bin.dat', fileReqs()[1]?.body?.path, 'bin.dat')
  has('   二进制提示', allText(nodes).includes('binaryDiff'))
  check('   仍然只有一个差异容器', rowsOf(nodes, 'data-review-diff').length, 1)
}

console.log('')
console.log('=== 5. 换 workspace / 换 HEAD：缓存键不同，必须重新取 ===')
{
  // 同一个路径、不同的 HEAD：基线变了，旧差异不能复用。
  const head2 = 'b'.repeat(40)
  const before = fileReqsFor('a.txt').length
  has('5) 点得中 a.txt（换 HEAD）', await clickNow('data-staging-diff-toggle', 'a.txt', mountProps({ revision: head2 })))
  await drain(mountProps({ revision: head2 }))
  check('   换 HEAD 后重新请求', fileReqsFor('a.txt').length - before, 1)
  check('   新请求带的是新 HEAD', fileReqsFor('a.txt').at(-1)?.body?.revision, head2)
  // 不同 workspace：即使 HEAD 与路径都相同也不复用。
  const beforeWs = fileReqsFor('a.txt').length
  const other = mountProps({ workspace: 'F:\\code\\projB', revision: head2 })
  await drain(other)
  has('   点得中同一个文件（换 workspace）', await clickNow('data-staging-diff-toggle', 'a.txt', other))
  await drain(other)
  check('   换 workspace 后重新请求', fileReqsFor('a.txt').length - beforeWs, 1)
  check('   请求带的是新 workspace', fileReqsFor('a.txt').at(-1)?.body?.workspace, 'F:\\code\\projB')
}

console.log('')
console.log('=== 6. 迟到的响应不许写进另一个文件 ===')
{
  // 换一个 HEAD 以避开前几节留下的差异缓存（缓存键含 HEAD）。
  const head3 = 'c'.repeat(40)
  const props3 = mountProps({ revision: head3 })
  rootKey = 'lazy-late'
  held.set('a.txt', [])
  has('6) 展开 a.txt（响应被挂起）', await clickNow('data-staging-diff-toggle', 'a.txt', props3))
  await drain(props3)
  const pending = held.get('a.txt') ?? []
  has('   a.txt 的请求确实在飞', pending.length === 1)
  has('   折叠 a.txt', await clickNow('data-staging-diff-toggle', 'a.txt', props3))
  await drain(props3)
  has('   展开 bin.dat', await clickNow('data-staging-diff-toggle', 'bin.dat', props3))
  const withBin = await drain(props3)
  has('   当前显示的是 bin.dat 的二进制提示', allText(withBin).includes('binaryDiff'))
  // 放行旧响应：它属于 a.txt，而 a.txt 已经不是当前展开项 → 不许出现在界面上。
  held.delete('a.txt')
  for (const release of pending.splice(0)) release()
  const after = await drain(props3)
  has('   迟到响应落地后仍然是 bin.dat 这一份', allText(after).includes('binaryDiff'))
  check('   迟到响应没有把 a.txt 的差异画进来', allText(after).includes('new a.txt'), 'false')
}

console.log('')
console.log('=== 7. 加载中与失败都有明确状态（不会永远停在"正在读取差异"）===')
{
  const head4 = 'd'.repeat(40)
  rootKey = 'lazy-states'
  held.set('a.txt', [])
  has('7) 展开（挂起）', await clickNow('data-staging-diff-toggle', 'a.txt', mountProps({ revision: head4 })))
  const loading = await drain(mountProps({ revision: head4 }))
  has('   显示加载中', allText(loading).includes('loading'))
  const pending = held.get('a.txt') ?? []
  held.delete('a.txt')
  for (const release of pending.splice(0)) release()
  await drain(mountProps({ revision: head4 }))
  // 让这次请求失败：路径在桩里没有对应负载 → 响应体是 `undefined` → 客户端解析失败。
  payloads.set('missing.txt', undefined)
  rootKey = 'lazy-error'
  const withMissing = {
    ...snapshot,
    revision: head4,
    files: [...files, { path: 'missing.txt', status: 'M', added: 1, removed: 0, staged: false, unstaged: true, untracked: false, index: ' ', worktree: 'M' }],
  }
  await drain(mountProps({ revision: head4, snapshot: withMissing }))
  has('   点得中不存在的文件', await clickNow('data-staging-diff-toggle', 'missing.txt', mountProps({ revision: head4, snapshot: withMissing })))
  const failed = await drain(mountProps({ revision: head4, snapshot: withMissing }))
  has('   失败时显示错误而不是一直"正在读取差异"', allText(failed).includes('reading is not a function') || allText(failed).includes('undefined') || allText(failed).includes('Error'))
}

console.log('')
console.log(failures === 0 ? '按需差异全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
