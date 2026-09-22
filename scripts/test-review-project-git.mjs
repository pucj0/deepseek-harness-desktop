// 项目级 Git 客户端的状态机回归：切换项目、Hook 顺序、面板故障隔离、按需差异。
//
//   node scripts/test-review-project-git.mjs
//
// 这个测试的假 React 与其它测试**有一处关键区别**：它会**逐组件记录 hook 调用序列**，
// 并在同一次运行里比较两次渲染的数量与顺序——数量一变就直接判定失败（等价于真实 React 的
// #310 "Rendered more/fewer hooks than during the previous render"）。桩渲染器不会自己
// 报这个错，而它正是"切换项目之后抽屉与右上角入口一起消失"的根因，因此必须在这里补上。
//
// 覆盖：
//   1. A ready → 切 B（B 还在 loading）→ B ready → 切回 A：全程入口与抽屉都在，
//      且**没有任何 hook 数量变化**；
//   2. 有当前会话但 cwd 未到 → 显示"正在切换项目…"，**不回退**到上一个项目、也不发请求；
//   3. 面板内部抛错 → 只降级面板（`data-review-panel-error`），入口按钮照旧；
//   4. 逐行差异按需取：不点文件不发请求，点一次只发一次，折叠再展开走缓存；
//   5. 快照状态机：首次 loading、ready、失败 error（有旧数据时保留数据 + refreshError）。
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PLUGIN = pathToFileURL(join(ROOT, 'plugins', 'dsh-client-ui-review', 'lib', 'client.js')).href

// ---- 假 React（带 hook 序列校验）------------------------------------------------
const componentHooks = new Map()
const classInstances = new Map()
/** 每个组件 key 上一次渲染的 hook 序列（`useState` / `useEffect` …）。 */
const hookShapes = new Map()
let hookSlots = []
let renderIndex = 0
let effectQueue = []
let currentKey = ''
let currentCalls = []
/** hook 数量/顺序发生变化的组件（key → `{ before, after }`）。 */
const hookOrderErrors = []

class FakeComponent {
  constructor(props) {
    this.props = props
  }

  setState(patch) {
    const next = typeof patch === 'function' ? patch(this.state) : patch
    this.state = { ...this.state, ...next }
  }
}
FakeComponent.prototype.isReactComponent = {}

/** 包一个 hook：记录序列，调用真正的实现。 */
const traced = (name, fn) => (...args) => {
  currentCalls.push(name)
  return fn(...args)
}

const react = {
  Component: FakeComponent,
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
    if (prev === undefined || prev.subscribe !== subscribe) {
      hookSlots[slot] = { subscribe, unsubscribe: subscribe(() => {}) }
    }
    return getSnapshot()
  }),
}

/**
 * 渲染一个函数组件；渲染前后比较 hook 序列，变了就记一笔。
 *
 * 比较的是**数量与顺序**（名字序列）：这是 React #310 的判据。
 */
function render(Comp, props, key) {
  const saved = { hookSlots, renderIndex, effectQueue, currentKey, currentCalls }
  hookSlots = componentHooks.get(key) ?? []
  renderIndex = 0
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
    if (before !== undefined && before !== after) {
      hookOrderErrors.push({ key, before, after })
    }
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

const isClassComponent = (type) =>
  typeof type === 'function' && type.prototype !== undefined && Boolean(type.prototype.isReactComponent)

function collectHostNodes(node, queued, rootKey) {
  const out = []
  const visit = (current, path) => {
    if (current === null || current === undefined) return
    if (Array.isArray(current)) {
      current.forEach((child, index) => visit(child, `${path}.${index}`))
      return
    }
    if (typeof current !== 'object') return
    const type = current.type
    if (typeof type === 'function') {
      const name = type.name === '' ? 'anonymous' : type.name
      const keyed = current.props?.key === undefined ? `${path}:${name}` : `${path}:${name}#${String(current.props.key)}`
      if (isClassComponent(type)) {
        let instance = classInstances.get(keyed)
        if (instance === undefined) {
          instance = new type(current.props)
          classInstances.set(keyed, instance)
        }
        instance.props = current.props
        const isBoundary = typeof type.getDerivedStateFromError === 'function' || typeof instance.componentDidCatch === 'function'
        if (!isBoundary) {
          visit(instance.render(), keyed)
          return
        }
        try {
          visit(instance.render(), keyed)
        } catch (error) {
          // 与真实 React 一致：卸载抛错的子树（这里连 hook 槽一起丢，否则重试后 effect 不重跑）。
          for (const existing of [...componentHooks.keys()]) {
            if (existing.startsWith(`${keyed}.`)) componentHooks.delete(existing)
          }
          for (const existing of [...hookShapes.keys()]) {
            if (existing.startsWith(`${keyed}.`)) hookShapes.delete(existing)
          }
          const derived = typeof type.getDerivedStateFromError === 'function' ? type.getDerivedStateFromError(error) : undefined
          if (derived !== undefined && derived !== null) instance.state = { ...instance.state, ...derived }
          if (typeof instance.componentDidCatch === 'function') {
            instance.componentDidCatch(error, { componentStack: `\n    in ${name}` })
          }
          visit(instance.render(), keyed)
        }
        return
      }
      const { tree, effects } = render(type, current.props, keyed)
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
const domListeners = new Map()
const storage = {}
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
  localStorage: {
    getItem: (k) => storage[k] ?? null,
    setItem: (k, v) => {
      storage[k] = v
    },
    removeItem: (k) => {
      delete storage[k]
    },
  },
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
const A = 'F:\\code\\projA'
const B = 'F:\\code\\projB'

const file = (path, extra) => ({
  path,
  status: 'M',
  added: 1,
  removed: 0,
  staged: false,
  unstaged: true,
  untracked: false,
  index: ' ',
  worktree: 'M',
  ...extra,
})

/** 每个工作区一份快照响应（`hold` 为真时挂起，等测试放行）。 */
const workspaceData = new Map([
  [A, { isRepo: true, branch: 'alpha', head: 'a'.repeat(40), empty: false, files: [file('a.txt'), file('b.txt', { staged: true, unstaged: false, index: 'M', worktree: ' ' })], changedFiles: 2 }],
  [B, { isRepo: true, branch: 'beta', head: 'b'.repeat(40), empty: false, files: [file('z.txt')], changedFiles: 1 }],
])
/** 挂起某个工作区的 `/workspace` 响应（键为工作区路径）。 */
const held = new Map()
/** 让某个工作区的 `/workspace` 直接失败（测错误相位）。 */
const failing = new Set()
const requests = []

/**
 * `/project-git-scope`（项目级仓库发现）的回答：**默认"工作区自己就是仓库"**。
 *
 * 这是 1.5.2 的常见形状，也是"单仓库不许回归"的基准：仓库列表只有一项、`relativePath`
 * 为空，于是 active 就是它本身、请求里**不带** `repository`，与 1.5.2 逐字一致。
 * 第 6 节用 `scopeOverrides` 换成"工作区不是仓库、仓库在子目录里"的多仓库形状。
 *
 * 注意"工作区"参数也可能是**某个仓库根**：项目级汇总给每个仓库挂订阅时用的就是这个
 * 身份（见 review 客户端的 syncProjectChildren），那时它必须回答"我自己就是那个仓库"，
 * 否则那一格永远解析不出仓库根。
 */
const baseName = (path) => path.slice(path.lastIndexOf('\\') + 1)
const scopeOverrides = new Map()
const scopeFor = (workspace) =>
  scopeOverrides.get(workspace) ?? [
    { repositoryRoot: workspace, gitDir: `${workspace}\\.git`, relativePath: '', name: baseName(workspace) },
  ]

globalThis.fetch = async (url, init) => {
  const target = String(url)
  const body = init?.body === undefined ? undefined : JSON.parse(init.body)
  const route = target.slice(target.indexOf('/dsh-desktop/review/') + '/dsh-desktop/review/'.length).split('?')[0]
  requests.push({ url: target, route, body })
  const wrap = (payload) => ({ ok: true, text: async () => JSON.stringify(payload) })
  if (route === 'project-git-scope') {
    const workspace = body?.workspace
    const repositories = scopeFor(workspace)
    return wrap({
      workspaceRoot: workspace,
      repositories,
      discovery: {
        complete: true,
        directoriesVisited: 2,
        candidatesFound: repositories.length,
        gitProbes: repositories.length,
        durationMs: 1,
        truncatedByBudget: false,
        cached: false,
      },
    })
  }
  if (route === 'workspace' && failing.has(body?.workspace)) {
    return { ok: false, status: 500, text: async () => JSON.stringify({ error: 'isRepo 检查失败（测试注入）' }) }
  }
  if (held.has(body?.workspace) && route === 'workspace') {
    return await new Promise((resolve) => held.get(body.workspace).push(() => resolve(wrap(workspaceData.get(body.workspace)))))
  }
  if (route === 'roots') return wrap({ roots: [A, B], current: A })
  if (route === 'workspace') {
    // 多仓库时客户端会带上 `repository`（它才是"这一份数据属于哪个仓库"的权威），
    // 单仓库时不带 —— 两种都要能取到夹具。
    const key = typeof body?.repository === 'string' && body.repository !== '' ? body.repository : body?.workspace
    const payload = workspaceData.get(key)
    return wrap(payload ?? { isRepo: true, files: [], changedFiles: 0, branch: '', head: '' })
  }
  if (route === 'workspace-file') {
    return wrap({ isRepo: true, path: body?.path, diff: `diff --git a/${body?.path} b/${body?.path}\n--- a/${body?.path}\n+++ b/${body?.path}\n@@ -1 +1 @@\n-old\n+new ${body?.path}\n`, truncated: false, binary: false })
  }
  if (route === 'graph') return wrap({ isRepo: true, branch: 'alpha', hasMore: false, commits: [] })
  return wrap({ isRepo: true, files: [], diff: '', truncated: false })
}

// ---- 加载并挂载插件 --------------------------------------------------------------
let loaded
await import(PLUGIN)

const entries = new Map()
const injectedFaces = new Map()
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
      entries.set(key, component)
      if (options.inject !== undefined) injectedFaces.set(key, options.inject())
      return () => {}
    },
  },
  sidebarRight: {},
  sidebarRightTabs: { register: () => () => {} },
  sessions: { list: {} },
  workspaces: { list: {} },
}
loaded.apply(ctx)
const Hero = entries.get('shell.overlay:review-project-changes')
const injected = injectedFaces.get('shell.overlay:review-project-changes')
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
const makeSelectorHook = (read) => (selector) =>
  react.useSyncExternalStore(
    () => () => {},
    () => selector(read()),
  )

/** 会话快照：可被测试直接改写（切换当前会话 / 抹掉 cwd）。 */
let sessionSnapshot = { current: 's1', ids: ['s1', 's2'], byId: { s1: { cwd: A }, s2: { cwd: B } } }
const workspaceSnapshot = { items: [{ workspaceId: 'w1', path: A }, { workspaceId: 'w2', path: B }] }
const tCalls = []
/** `t` 抛错的键（用来在指定子树里注入渲染期异常）。 */
let throwOn = ''
const t = (key, params) => {
  tCalls.push({ key, params })
  if (throwOn !== '' && key === throwOn) throw new Error(`注入的渲染期异常：${key}`)
  if (params === undefined) return key
  // 与其它 review 测试同一套约定：把参数渲染进文案，断言才能看到真实数字/名字
  // （例如 `files(count=2)`），而不是只看到字典键。
  return `${key}(${Object.entries(params).map(([name, value]) => `${name}=${value}`).join(',')})`
}
const props = {
  ...injected,
  t,
  useSessions: makeSelectorHook(() => sessionSnapshot),
  useWorkspaces: makeSelectorHook(() => workspaceSnapshot),
}

// ---- 驱动 ------------------------------------------------------------------------
let heroKey = ''
let heroSeq = 0
const slotErrors = []

async function drainView(Comp, compProps, key) {
  let nodes = []
  for (let pass = 0; pass < 8; pass += 1) {
    const queued = []
    try {
      const out = render(Comp, compProps, key)
      queued.push(...out.effects)
      nodes = collectHostNodes(out.tree, queued, key)
    } catch (error) {
      slotErrors.push(error)
      return [{ type: 'div', props: { 'data-slot-error': 'entry', children: undefined } }]
    }
    if (queued.length > 0) for (const effect of queued) effect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (queued.length === 0) break
  }
  return nodes
}
const drain = () => drainView(Hero, props, heroKey)

/** 打开抽屉（入口按钮就是开关）。 */
async function openDrawer(label) {
  heroKey = `hero-${label}-${heroSeq++}`
  let nodes = await drain()
  if (nodes.some((n) => n.props?.['data-desktop-review-surface'] === 'panel')) return nodes
  const trigger = nodes.find((n) => n.props?.['data-review-trigger-button'] !== undefined)
  if (trigger === undefined) return nodes
  trigger.props.onClick()
  return drain()
}
async function clickNow(attr, value) {
  const nodes = await drain()
  const node = nodes.find((n) => (value === undefined ? n.props?.[attr] !== undefined : n.props?.[attr] === value))
  if (node === undefined || typeof node.props.onClick !== 'function') return false
  node.props.onClick()
  return true
}
/**
 * 入口按钮上的文案（含文件数）。
 *
 * 必须**只展开按钮自己**：入口容器（`[data-review-trigger]`）里还有面板，整棵展开会把
 * 抽屉里的文字也算进来（实测过：断言因此拿到一整屏文本，`includes` 永远不成立）。
 */
const badgeText = (nodes) => {
  const button = rowsOf(nodes, 'data-review-trigger-button')[0]
  if (button === undefined) return ''
  return textOf(button)
}
/** 整棵树里所有宿主节点的文本（用于"抽屉里显示的是哪句话"这类断言）。 */
const allText = (nodes) => nodes.map((n) => textOf(n)).join(' ')
/** 放行被挂起的 B 快照请求（放行后 B 立即返回，不再挂起）。 */
function BheldRelease() {
  const list = held.get(B) ?? []
  held.delete(B)
  for (const release of list.splice(0)) release()
}

console.log('=== 1. 切换项目：A ready → B loading → B ready → 回 A ===')
{
  store.reset()
  held.set(B, [])
  has('1) 抽屉打开（A）', (await openDrawer('switch')).some((n) => n.props?.['data-desktop-review-surface'] === 'panel'))
  let nodes = await drain()
  has('   A 的入口显示文件数', badgeText(nodes).includes('files(count=2)'))
  check('   Changes 里列出 A 的文件', rowsOf(nodes, 'data-staging-row').length, 2)
  // 单仓库项目的提交框标题**只有分支**（多仓库才缀仓库名，见第 6 节）。
  check(
    '   提交框标题只有分支',
    nodes.find((n) => n.props?.['data-staging-message'] !== undefined)?.props?.placeholder,
    'commitMessage(branch=alpha)',
  )

  // 切到 B：B 的响应被挂起 → 必须显示加载态，且**不能**继续显示 A 的文件。
  sessionSnapshot = { ...sessionSnapshot, current: 's2' }
  nodes = await drain()
  has('   切到 B 后入口仍在', rowsOf(nodes, 'data-review-trigger').length === 1)
  has('   抽屉仍在', rowsOf(nodes, 'data-desktop-review-surface').length === 1)
  has('   抽屉里是加载态', allText(nodes).includes('loading'))
  check('   不显示 A 的文件行', rowsOf(nodes, 'data-staging-row').length, 0)
  check('   这一帧没有 hook 数量变化', hookOrderErrors.length, 0)
  check('   没有走到槽位级隔离', slotErrors.length, 0)

  // 放行 B。
  BheldRelease()
  nodes = await drain()
  has('   B 就位后入口显示 1 个文件', badgeText(nodes).includes('files(count=1)'))
  check('   Changes 里列出 B 的文件', rowsOf(nodes, 'data-staging-row').length, 1)
  has('   抽屉仍在', rowsOf(nodes, 'data-desktop-review-surface').length === 1)
  check('   全程仍没有 hook 数量变化', hookOrderErrors.length, 0)

  // 切回 A：数据已在 store 里，直接显示，不该再出现加载态。
  sessionSnapshot = { ...sessionSnapshot, current: 's1' }
  nodes = await drain()
  has('   切回 A 立即显示 2 个文件', badgeText(nodes).includes('files(count=2)'))
  check('   仍然是 2 行', rowsOf(nodes, 'data-staging-row').length, 2)
  check('   全程没有 hook 数量变化', hookOrderErrors.length, 0)
  has('   入口没有消失', rowsOf(nodes, 'data-review-trigger').length === 1)
}

console.log('')
console.log('=== 2. 有当前会话但 cwd 还没到：显示"正在切换项目…"，不回退也不发请求 ===')
{
  const before = requests.filter((r) => r.route === 'workspace').length
  sessionSnapshot = { current: 's3', ids: ['s1', 's2', 's3'], byId: { s1: { cwd: A }, s2: { cwd: B }, s3: {} } }
  const nodes = await drain()
  has('2) 入口说"正在切换项目"', badgeText(nodes).includes('switchingProject'))
  has('   抽屉里也这么说', allText(nodes).includes('switchingProject'))
  check('   没有为它发快照请求', requests.filter((r) => r.route === 'workspace').length - before, 0)
  has('   没有回退显示 A 或 B 的文件', rowsOf(nodes, 'data-staging-row').length === 0)
  has('   入口仍在', rowsOf(nodes, 'data-review-trigger').length === 1)
  check('   没有 hook 数量变化', hookOrderErrors.length, 0)
  // cwd 到手 → 回到正常显示。
  sessionSnapshot = { current: 's3', ids: ['s1', 's2', 's3'], byId: { s1: { cwd: A }, s2: { cwd: B }, s3: { cwd: A } } }
  const after = await drain()
  has('   cwd 到手后显示 A 的数据', badgeText(after).includes('files(count=2)'))
}

console.log('')
console.log('=== 3. 面板内部抛错：只降级面板，入口照旧 ===')
{
  store.reset()
  sessionSnapshot = { current: 's1', ids: ['s1', 's2'], byId: { s1: { cwd: A }, s2: { cwd: B } } }
  await openDrawer('boundary')
  await drain()
  // `commitMessage` 只被提交框用到（在 Changes 页签里），因此这一抛发生在**面板内部**。
  throwOn = 'commitMessage'
  const crashed = await drain()
  has('3) 出现面板级降级页', rowsOf(crashed, 'data-review-panel-error').length === 1)
  has('   入口按钮仍然存在', rowsOf(crashed, 'data-review-trigger-button').length === 1)
  has('   入口容器仍然存在', rowsOf(crashed, 'data-review-trigger').length === 1)
  check('   没有走到槽位级隔离', slotErrors.length, 0)
  const detail = textOf(rowsOf(crashed, 'data-review-panel-error-detail')[0] ?? null)
  has('   降级页带异常原文', detail.includes('注入的渲染期异常'))
  has('   降级页带组件栈', detail.includes('ProjectGitPanelErrorBoundary'))
  has('   记录了面板错误', globalThis.window.__dshDesktopReviewPanelError !== undefined)
  check('   记录带作用域', globalThis.window.__dshDesktopReviewPanelError?.scope, 'dsh-client-ui-review:panel')
  // 修好之后点「重新加载」→ 面板回来。
  throwOn = ''
  has('   点得中「重新加载」', await clickNow('data-review-panel-error-action', 'reload'))
  const reloaded = await drain()
  has('   降级页消失', rowsOf(reloaded, 'data-review-panel-error').length === 0)
  has('   面板回来了', rowsOf(reloaded, 'data-desktop-review-surface').length === 1)
  has('   入口仍在', rowsOf(reloaded, 'data-review-trigger-button').length === 1)
  // 「关闭」也必须能收起面板而**不**让入口消失。
  store.reset()
  await openDrawer('close')
  await drain()
  throwOn = 'commitMessage'
  await drain()
  throwOn = ''
  has('   点得中「关闭」', await clickNow('data-review-panel-error-action', 'close'))
  const closed = await drain()
  has('   面板已收起', rowsOf(closed, 'data-desktop-review-surface').length === 0)
  has('   入口仍在（关闭不等于入口消失）', rowsOf(closed, 'data-review-trigger-button').length === 1)
  delete globalThis.window.__dshDesktopReviewPanelError
}

console.log('')
console.log('=== 4. 逐行差异按需取：不点不发、点一次只发一次、折叠再展开走缓存 ===')
//
// 这里只断言**请求层面**的行为（窗口/缓存的渲染断言在 `test-review-lazy-diff.mjs`，
// 那个测试把 StagingSection 直接当根组件渲染，避免"按树中位置分配 hook 槽"的桩渲染器
// 在多级嵌套下把槽串到一起）。
{
  store.reset()
  await openDrawer('lazy')
  const nodes = await drain()
  check('4) 打开 Changes 时一个文件差异都没取', requests.filter((r) => r.route === 'workspace-file').length, 0)
  check('   列出了 2 行', rowsOf(nodes, 'data-staging-row').length, 2)
  has('   点得中第一个文件的路径', await clickNow('data-staging-diff-toggle', 'a.txt'))
  await drain()
  const afterOpen = requests.filter((r) => r.route === 'workspace-file')
  check('   点开后取的是被点的那个文件', afterOpen[0]?.body?.path, 'a.txt')
  check('   带上 HEAD 作为基线', afterOpen[0]?.body?.revision, 'a'.repeat(40))
  // **精确的请求计数**（点一次只取一次、折叠不取、再展开走缓存、换 workspace 重取）由
  // `test-review-lazy-diff.mjs` 断言：那里把 StagingSection 当根组件渲染，槽归属是确定的。
  // 这个抽屉级测试只钉"点开确实会去取、且取的是被点的路径"。
  check('   这一段没有 hook 数量变化', hookOrderErrors.length, 0)
}

console.log('')
console.log('=== 5. 快照状态机：loading / ready / stale-while-revalidate / error ===')
{
  store.reset()
  held.set(B, [])
  sessionSnapshot = { current: 's2', ids: ['s1', 's2'], byId: { s1: { cwd: A }, s2: { cwd: B } } }
  await openDrawer('machine')
  await drain()
  check('5) 首次进入：phase=loading', store.get(B)?.phase, 'loading')
  has('   加载中已订阅（有数据前不显示旧项目）', store.get(B)?.files?.length === 0)
  BheldRelease()
  await drain()
  check('   成功后 phase=ready', store.get(B)?.phase, 'ready')
  check('   requestId 已推进', typeof store.get(B)?.requestId === 'number' && store.get(B)?.requestId > 0, 'true')

  // SWR：刷新期间必须保留旧数据、只置 refreshing，不回到 loading。
  held.set(B, [])
  const inflight = store.get(B).refresh()
  const during = store.get(B)
  check('   刷新期间 phase 仍是 ready', during?.phase, 'ready')
  has('   旧文件仍然在（stale-while-revalidate）', during?.files?.length === 1)
  has('   标出 refreshing', during?.refreshing === true)
  BheldRelease()
  await inflight
  check('   刷新完成后 refreshing 归位', store.get(B)?.refreshing, 'false')

  // 失败：有旧数据时保留数据 + refreshError；清空数据后进 error 相位。
  failing.add(B)
  await store.get(B).refresh().catch(() => undefined)
  const failed = store.get(B)
  check('   有数据时失败不改相位', failed?.phase, 'ready')
  has('   但标出 refreshError', String(failed?.refreshError ?? '').includes('isRepo'))
  store.set(B, null)
  await store.get(B).refresh().catch(() => undefined)
  check('   没有数据时失败进 error 相位', store.get(B)?.phase, 'error')
  has('   错误信息可展示', String(store.get(B)?.error ?? '').includes('isRepo'))
  failing.delete(B)
  await store.get(B).refresh().catch(() => undefined)
  check('   恢复后重新 ready', store.get(B)?.phase, 'ready')
}

console.log('')
console.log('=== 6. 多仓库项目：徽标是所有仓库之和 + 仓库选择器 + 操作不跨仓库 ===')
{
  // 实机反馈的形状：`F:\code_buss\haiweiNew` 自己**不是** git 仓库，仓库在
  // `haiwei-manage-fronted`、`haiwei-manage-backend` 两个子目录里。1.5.3 及以前面板会
  // 说"当前工作区不是 git 仓库"——这一段钉住"有子仓库时绝不是那个结论"。
  const FE = `${A}\\haiwei-manage-fronted`
  const BE = `${A}\\haiwei-manage-backend`
  workspaceData.set(FE, {
    isRepo: true,
    branch: 'master',
    head: 'f'.repeat(40),
    empty: false,
    files: [file('fe1.txt'), file('fe2.txt'), file('fe3.txt')],
    changedFiles: 3,
  })
  workspaceData.set(BE, {
    isRepo: true,
    branch: 'main',
    head: 'e'.repeat(40),
    empty: false,
    files: [file('be1.txt')],
    changedFiles: 1,
  })
  // 工作区自己不在列表里（`relativePath === ''` 的那一项不存在）——active 因此要用户选。
  scopeOverrides.set(A, [
    { repositoryRoot: FE, gitDir: `${FE}\\.git`, relativePath: 'haiwei-manage-fronted', name: 'haiwei-manage-fronted' },
    { repositoryRoot: BE, gitDir: `${BE}\\.git`, relativePath: 'haiwei-manage-backend', name: 'haiwei-manage-backend' },
  ])
  store.reset()
  sessionSnapshot = { current: 's1', ids: ['s1', 's2'], byId: { s1: { cwd: A }, s2: { cwd: B } } }
  let nodes = await openDrawer('multi')
  await drain()
  await drain()
  // 徽标：数字是**所有仓库之和**（3 + 1 = 4），并说清是几个仓库——否则用户会把它当成
  // 某一个仓库的改动数。
  has('6) 徽标是所有仓库之和 + 仓库数', badgeText(nodes).includes('projectFilesMulti(count=4,repositories=2)'))
  check('   页签里有仓库选择器', rowsOf(nodes, 'data-review-repo-select').length, 1)
  check('   不是一个仓库一个选择器', rowsOf(nodes, 'data-review-repo-select').length, 1)
  has('   面板里没有说"不是 git 仓库"', !allText(nodes).includes('notRepo') && !allText(nodes).includes('notGitProject'))
  check('   两个仓库各一格（各一套轮询）', store.cells().filter((cell) => String(cell.key).includes('haiwei-manage') && cell.polling).length, 2)
  has('   全程没有 hook 数量变化', hookOrderErrors.length === 0)

  // 打开选择器：两项、带各自的相对路径与分支。
  await clickNow('data-review-repo-select-button')
  nodes = await drain()
  check('   菜单里列出两个仓库', rowsOf(nodes, 'data-review-repo-pick').length, 2)
  check(
    '   菜单项就是两条仓库根',
    rowsOf(nodes, 'data-review-repo-pick')
      .map((n) => n.props['data-review-repo-pick'])
      .sort()
      .join('|'),
    [FE, BE].sort().join('|'),
  )
  has('   每项标出分支', textOf(rowsOf(nodes, 'data-review-repo-branch')[0] ?? null).length > 0)
  check('   并标出各自的改动数', rowsOf(nodes, 'data-review-repo-branch').length, 2)

  // 默认项是列表里的第一个（FE），因此"选 FE"是一个空操作；要观察切换就点 **BE**。
  // 切过去之后**所有** A 工作区的读请求都必须带 `repository=BE`。
  requests.length = 0
  await clickNow('data-review-repo-pick', BE)
  nodes = await drain()
  // 面板那一帧可能直接用汇总里已经取好的 BE 数据（同一个 store，不会白跑一次请求），
  // 因此强制刷一次来观察请求体——这正是"切仓库之后读到的是新仓库"的那条路径。
  await store.refresh(A)
  nodes = await drain()
  const aRequests = requests.filter((r) => r.body?.workspace === A && r.body?.repository !== undefined)
  has('   选过之后 A 的请求都带 repository', aRequests.length >= 1)
  check(
    '   带的都是选中的那一个',
    [...new Set(aRequests.map((r) => r.body?.repository))].join(','),
    BE,
  )
  // 面板里显示的是 BE 的文件（不是 FE 的，也不是两个混在一起）。
  check('   面板列的是 backend 的 1 个文件', rowsOf(nodes, 'data-staging-row').length, 1)
  has('   选择器上写着当前仓库 + 分支', textOf(rowsOf(nodes, 'data-review-repo-current')[0] ?? null).includes('main'))

  // 写操作（暂存一行）必须落在同一个仓库上：**提交绝不跨仓库**。
  requests.length = 0
  has('   点得中某个「暂存」', await clickNow('data-staging-row-action', 'stage'))
  nodes = await drain()
  const writes = requests.filter((r) => r.route === 'stage')
  has('   暂存发到了 host', writes.length >= 1)
  check('   写操作带的 workspace 是工作区', writes[writes.length - 1]?.body?.workspace, A)
  check('   而且带的是选中的仓库（不跨仓库）', writes[writes.length - 1]?.body?.repository, BE)
  // 提交框在底部、仓库选择器在顶部：多仓库时标题必须自己再说一次仓库名。
  const messageBox = nodes.find((n) => n.props?.['data-staging-message'] !== undefined)
  has('   提交框标题里带仓库名 + 分支', String(messageBox?.props?.placeholder ?? '').includes('backend · main'))
  has('   面板里没有说"不是 git 仓库"', !allText(nodes).includes('notRepo') && !allText(nodes).includes('notGitProject'))
  check('   这一段没有 hook 数量变化', hookOrderErrors.length, 0)
  // 项目级汇总会给**每个**仓库建一格，但请求里的 `workspace` 必须始终是**用户登记过的**
  // 那个路径：仓库根（`…\haiwei-manage-fronted`）通常不在登记表里，拿它当工作区发请求
  // 会被宿主以 400 `workspaceNotAllowed` 拒掉——多仓库支持反而会让面板彻底不可用。
  const strayWorkspaces = requests
    .map((r) => r.body?.workspace)
    .filter((w) => w !== undefined && w !== A && w !== B)
  check('   从不把未登记的仓库根当工作区发请求', [...new Set(strayWorkspaces)].join(','), '')

  // 清掉夹具，别影响后面的检查。
  workspaceData.delete(FE)
  workspaceData.delete(BE)
  scopeOverrides.delete(A)
  store.reset()
}

console.log('')
console.log('=== 7. 全程没有 hook 数量/顺序变化（等价于真实 React #310）===')
{
  if (hookOrderErrors.length > 0) {
    console.log('  发生变化的组件：')
    for (const item of hookOrderErrors.slice(0, 5)) {
      console.log(`    ${item.key}\n      之前: ${item.before}\n      之后: ${item.after}`)
    }
  }
  check('7) hook 序列稳定的组件数', hookShapes.size > 5, 'true')
  check('   发生 hook 数量/顺序变化的组件', hookOrderErrors.length, 0)
  check('   槽位级隔离次数（应为 0：入口从未被替换）', slotErrors.length, 0)
}

console.log('')
console.log(failures === 0 ? '项目级 Git 状态机全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
