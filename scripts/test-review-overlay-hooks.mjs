// 验证项目级面板（shell.overlay 里的「项目改动」）能拿到**当前会话**的工作区。
//
//   node scripts/test-review-overlay-hooks.mjs
//
// 为什么需要这个测试：这条链上出过一次难查的故障——面板一直报"当前工作区不是 git
// 仓库"，而用户实际在用的项目明明是 git 仓库。根因不在取值逻辑，而在**注入遮蔽**：
// 渲染器合并 props 的顺序是 `{ ...kit, ...injected, ... }`，而标准钩子
// （useSessions / useWorkspaces）是 kit 提供的；本插件此前在 `inject` 里回传
// `useSessions: ctx.sessions?.useSessions`（服务上并没有这个成员），等于用
// `undefined` 把标准钩子盖掉了，`typeof useSessions === 'function'` 永远为假。
//
// 这类错误的特征是"取值代码看着完全正确、运行时却拿不到值"，所以必须把
// 「inject 不得遮蔽标准钩子」和「拿到钩子后确实跟随当前会话」两条都钉成断言。
//
// 不需要 Electron：用桩渲染器（假 React + 假 module loader）直接加载插件模块。
import { pathToFileURL } from 'node:url'

const PLUGIN = pathToFileURL('plugins/dsh-client-ui-review/lib/client.js').href

// ---- 假 React -------------------------------------------------------------------
// 只实现插件用到的那几个 hook，并按"每个组件一份 slot"隔离，避免嵌套组件互相串号。
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
    // 必须捕获**本组件**的 slot 数组：setter 常常在渲染之后才被异步调用，那时
    // 模块级的 hookSlots 早已切回外层组件。
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
    if (prev !== undefined && deps !== undefined && prev.deps !== undefined && deps.every((d, i) => Object.is(d, prev.deps[i]))) {
      return prev.value
    }
    const value = fn()
    hookSlots[slot] = { deps, value }
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
    // **要真的订阅一次挂载**（真实 React 的语义）：共享快照 store 是"第一个订阅者到来时
    // 才开始拉数据"，只调 getSnapshot 不订阅的话 store 永远不会去问宿主——用这个桩写的
    // 断言就会变成"组件没发请求"这种假象。
    //
    // 而且要在 `subscribe` 的**身份变化**时重新订阅：真实 React 把 subscribe 放进 effect
    // 依赖里，工作区一变（useCallback 换了身份）就会退订旧的、订阅新的。少了这一步，
    // "切到另一个项目要重新取快照"这条断言永远看不到请求。
    const prev = hookSlots[slot]
    if (prev === undefined || prev.subscribe !== subscribe) {
      hookSlots[slot] = { subscribe, unsubscribe: subscribe(() => {}) }
    }
    return getSnapshot()
  },
}

/** 渲染一个组件（含嵌套组件），返回元素树，并执行本次产生的副作用。 */
function render(Comp, props, key) {
  const saved = { hookSlots, renderIndex, effectQueue }
  hookSlots = componentHooks.get(key) ?? []
  renderIndex = 0
  effectQueue = []
  const tree = Comp(props)
  componentHooks.set(key, hookSlots)
  const effects = effectQueue
  hookSlots = saved.hookSlots
  renderIndex = saved.renderIndex
  effectQueue = saved.effectQueue
  return { tree, effects }
}

/** 遍历元素树。 */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  visit(node)
  walk(node.props?.children, visit)
}

/**
 * 渲染并执行副作用，然后**再渲染一次**。
 *
 * 为什么需要两遍：`/roots` 是异步 effect，真实 React 会在它 setState 后自动重渲染；
 * 这个桩不会。因此第一遍拿到 roots，第二遍才会用上 `hostCurrent`——断言"没有会话时退
 * 回到外壳工作区"必须走到第二遍。
 */
async function renderSettled(Comp, props, key) {
  let out = render(Comp, props, key)
  for (const effect of out.effects) effect()
  await new Promise((resolve) => setTimeout(resolve, 0))
  out = render(Comp, props, key)
  for (const effect of out.effects) effect()
  await new Promise((resolve) => setTimeout(resolve, 0))
  return out
}

/**
 * 收集元素树里的**宿主**节点，并把函数组件就地展开。
 *
 * 为什么必须展开：桩渲染器不会自动执行嵌套组件（真实 React 会），而 `FileList`、
 * `HistoryList`、`statusBlock` 都是函数组件——不展开就只能看到面板自己那一层，
 * 断言会误判成"文件行没渲染"。
 *
 * 展开时按树中的位置给每个组件分配稳定的 hook key，因此跨多次渲染仍然保持状态
 * （展开文件、切换分组都依赖这一点）。
 * @param node - 元素树（或其中一棵子树）。
 * @param queued - 可选：把展开过程中各组件产生的副作用收进这个数组，交给调用方执行。
 *   不给就丢掉（老行为）；需要"新挂载的组件真的去取数"时必须给。
 * @returns 全部宿主节点。
 */
function collectHostNodes(node, queued) {
  const out = []
  const visit = (current, key) => {
    if (current === null || current === undefined) return
    if (Array.isArray(current)) {
      current.forEach((child, index) => visit(child, `${key}.${index}`))
      return
    }
    if (typeof current !== 'object') return
    if (typeof current.type === 'function') {
      const name = current.type.name === '' ? 'anonymous' : current.type.name
      const childKey = `${key}:${name}`
      const { tree, effects } = render(current.type, current.props, childKey)
      if (queued !== undefined) queued.push(...effects)
      visit(tree, childKey)
      return
    }
    out.push(current)
    visit(current.props?.children, key)
  }
  visit(node, 'root')
  return out
}

// ---- 假会话 / 工作区 store（真实形状：{ ids, byId, current }） -------------------
let sessionSnapshot = {
  current: 's2',
  ids: ['s1', 's2'],
  byId: { s1: { cwd: 'F:\\code\\projA' }, s2: { cwd: 'F:\\code\\projB' } },
}
const workspaceSnapshot = {
  items: [
    { workspaceId: 'w1', path: 'F:\\code\\projA', sessionIds: ['s1'] },
    { workspaceId: 'w2', path: 'F:\\code\\projB', sessionIds: ['s2'] },
  ],
}

/** 按渲染器的做法把 source 绑成 `use<Name>` 选择器钩子。 */
const makeSelectorHook = (read) => (selector) =>
  react.useSyncExternalStore(
    () => () => {},
    () => selector(read()),
  )

// ---- 假 DOM / fetch --------------------------------------------------------------
const fetches = []
/** 改动数据：一份足够真实的最小负载（两个文件 + 一段可展开的差异）。 */
const CHANGES = {
  isRepo: true,
  scope: 'workspace',
  branch: 'main',
  head: 'a'.repeat(40),
  files: [
    // 索引态由宿主随文件一起给出（`indexStates`），界面上的三个分组完全由它推导。
    { path: 'src/app.ts', status: 'M', added: 3, removed: 1, staged: true, unstaged: false, untracked: false },
    { path: 'docs/readme.md', status: 'A', added: 5, removed: 0, staged: false, unstaged: true, untracked: false },
  ],
  diff: [
    'diff --git a/src/app.ts b/src/app.ts',
    'index 1111111..2222222 100644',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,3 +1,5 @@',
    ' const a = 1',
    '-const b = 2',
    '+const b = 3',
    '+const c = 4',
    '',
  ].join('\n'),
  truncated: false,
}
/**
 * 提交图：Log 页签的数据源。
 *
 * 两条提交、一条父链，够画出两行；`refs` 里带上 HEAD 分支，分支树才有一段真实内容。
 */
const GRAPH = {
  isRepo: true,
  commits: [
    {
      hash: 'a'.repeat(40),
      short: 'aaaaaaa',
      parents: ['b'.repeat(40)],
      author: 'tester',
      email: 't@example.com',
      committedAt: '2026-01-02T09:30:00+08:00',
      subject: 'second commit',
      refs: [{ name: 'main', kind: 'branch', isHead: true }],
    },
    {
      hash: 'b'.repeat(40),
      short: 'bbbbbbb',
      parents: [],
      author: 'tester',
      email: 't@example.com',
      committedAt: '2026-01-01T09:30:00+08:00',
      subject: 'first commit',
      refs: [],
    },
  ],
  hasMore: false,
}
const HISTORY = {
  isRepo: true,
  branch: 'main',
  commits: [
    { hash: 'a'.repeat(40), short: 'aaaaaaa', author: 'tester', date: '2026-01-02', subject: 'second commit' },
    { hash: 'b'.repeat(40), short: 'bbbbbbb', author: 'tester', date: '2026-01-01', subject: 'first commit' },
  ],
}

/** 一次提交的详情：抽屉里点开某条提交记录后要看到的内容。 */
const COMMIT_DETAIL = {
  isRepo: true,
  commit: {
    hash: 'a'.repeat(40),
    short: 'aaaaaaa',
    author: 'tester',
    email: 't@example.com',
    committedAt: '2026-01-02T09:30:00+08:00',
    subject: 'second commit',
    body: '',
  },
  files: [
    { path: 'src/app.ts', status: 'M', added: 3, removed: 1 },
    { path: 'docs/readme.md', status: 'A', added: 5, removed: 0 },
  ],
  containingBranches: ['main'],
}
/** 提交里某个文件的差异。 */
const COMMIT_FILE = {
  isRepo: true,
  path: 'src/app.ts',
  diff: ['diff --git a/src/app.ts b/src/app.ts', '--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1 +1 @@', '-old', '+new', ''].join('\n'),
  truncated: false,
  binary: false,
}

/**
 * 把 `commit-detail` 的响应挂起，用来观察**加载中**那一帧。
 * 平时为 `false`（立即返回）；置为 `true` 后返回一个待决 promise，测试自己 resolve。
 */
let holdCommitDetail = false
const heldDetails = []

globalThis.fetch = async (url, init) => {
  fetches.push({ url: String(url), body: init?.body })
  const target = String(url)
  const payload = target.includes('/roots')
    ? {
        roots: ['C:\\Users\\Administrator', 'F:\\code\\projA', 'F:\\code\\projB', 'F:\\code\\projC'],
        // 外壳的工作区：不是仓库，正是当初被误当成"当前工作区"的那个。
        current: 'C:\\Users\\Administrator',
      }
    : target.includes('/commit-detail')
      ? COMMIT_DETAIL
      : target.includes('/commit-file')
        ? COMMIT_FILE
        : target.includes('/graph')
          ? GRAPH
          : target.includes('/history')
            ? HISTORY
            : CHANGES
  if (holdCommitDetail && target.includes('/commit-detail')) {
    return await new Promise((resolve) => {
      heldDetails.push(() => resolve({ ok: true, text: async () => JSON.stringify(payload) }))
    })
  }
  return { ok: true, text: async () => JSON.stringify(payload) }
}

/** 事件登记表：`type -> Set<handler>`。拖动要靠它把 mousemove/mouseup 真的派发出去。 */
const domListeners = new Map()
/** 插件注入的样式块（`ctx.effect` 里 createElement('style') + appendChild）。 */
const styledBlocks = []
globalThis.document = {
  // 样式块容器要留个引用：这一版的可操作性主要靠 :hover / :focus-visible 规则，
  // 而"规则有没有被真的注入"是唯一能在桩里断言的部分。
  head: {
    appendChild(node) {
      if (node?.tagName === 'style' || node?.dataset?.plugin !== undefined) styledBlocks.push(node)
    },
  },
  body: { dataset: {} },
  addEventListener(type, handler) {
    if (!domListeners.has(type)) domListeners.set(type, new Set())
    domListeners.get(type).add(handler)
  },
  removeEventListener(type, handler) {
    domListeners.get(type)?.delete(handler)
  },
  /** 派发一个事件（测试用，替代真实 DOM 的事件系统）。 */
  emit(type, event) {
    for (const handler of domListeners.get(type) ?? []) handler(event)
  },
  querySelector: () => null,
  createElement: (tagName) => ({ tagName, dataset: {}, style: {}, textContent: '', remove() {} }),
}
const storage = { 'dsh.review.panelOpen': '1' }
globalThis.window = {
  innerWidth: 1400,
  innerHeight: 900,
  localStorage: {
    getItem: (k) => storage[k] ?? null,
    setItem: (k, v) => { storage[k] = v },
    removeItem: (k) => { delete storage[k] },
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

let loaded
await import(PLUGIN)

// ---- 挂载插件，取出 shell.overlay 那个入口 --------------------------------------
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
  // 真实环境里这两个服务上**没有** useSessions / useWorkspaces 成员——这正是当初
  // 注入出 undefined 的原因，桩里如实还原。
  sessions: { list: {} },
  workspaces: { list: {} },
}
loaded.apply(ctx)

const HERO_KEY = 'shell.overlay:review-project-changes'
const Hero = entries.get(HERO_KEY)
const injected = injectedFaces.get(HERO_KEY)

let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `（期望 ${expected}）`}`)
}
/** 值比较（不转字符串）：用于布尔与"是否为某个精确值"的断言。 */
const is = (label, actual, expected) => {
  const ok = Object.is(actual, expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}${ok ? '' : `（期望 ${JSON.stringify(expected)}）`}`)
}
/** 元素文本（递归展开 children）。 */
const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node !== 'object') return ''
  return textOf(node.props?.children)
}
/** 行筛选：带某个 `data-*` 标记的宿主节点。 */
const has = (label, actual) => is(label, actual === true, true)
const rowsOf = (nodes, attr) => nodes.filter((n) => n.props?.[attr] !== undefined)

const workspacesAsked = () =>
  fetches.filter((f) => f.url.includes('/review/workspace')).map((f) => JSON.parse(f.body).workspace)

console.log('=== 1. inject 不得遮蔽渲染器的标准钩子 ===')
check('入口已注册', Hero !== undefined, 'true')
check('inject 不含 useSessions', Object.hasOwn(injected, 'useSessions'), 'false')
check('inject 不含 useWorkspaces', Object.hasOwn(injected, 'useWorkspaces'), 'false')
check('inject 仍提供 t', typeof injected.t, 'function')

console.log('')
console.log('=== 2. 复现旧写法的破坏性（注入 undefined 会盖掉 kit）===')
// 渲染器的合并顺序：kit 在前、inject 在后，后者覆盖前者。
const kit = {
  useSessions: makeSelectorHook(() => sessionSnapshot),
  useWorkspaces: makeSelectorHook(() => workspaceSnapshot),
}
const oldInject = { ...injected, useSessions: undefined, useWorkspaces: undefined }
const merged = { ...kit, ...oldInject }
check('旧写法下 kit 的钩子确实被盖成 undefined', merged.useSessions, 'undefined')
// 这正是面板报"不是 git 仓库"的原因：只能退到宿主给的外壳工作区。
fetches.length = 0
await renderSettled(Hero, { ...merged, t: (key) => key }, 'hero-old')
check('旧写法退回到外壳工作区（非仓库）', workspacesAsked().join(','), 'C:\\Users\\Administrator')

console.log('')
console.log('=== 3. 修好之后：工作区跟随当前会话 ===')
// `t` 记录调用参数并做插值：光返回 key 的话，"所在分支"那条断言只能看到模板键，
// 分不清"组件没渲染"与"渲染了但没插值"。插值 + 记录参数能把这两种情况分开。
const tCalls = []
const t = (key, params) => {
  tCalls.push({ key, params, from: 'test' })
  if (params === undefined) return key
  return Object.entries(params).reduce((text, [name, value]) => text.split(`{${name}}`).join(String(value)), key)
}
const props = { ...kit, ...injected, t }

fetches.length = 0
const first = await renderSettled(Hero, props, 'hero')
// 当前会话是 s2（projB），而"最近的会话"是 s1（projA）——必须取后者之外的那个。
check('当前会话是 s2 → 查 projB', workspacesAsked().join(','), 'F:\\code\\projB')

fetches.length = 0
sessionSnapshot = { ...sessionSnapshot, current: 's1' }
await renderSettled(Hero, props, 'hero')
check('切换对话到 s1 → 查 projA', workspacesAsked().join(','), 'F:\\code\\projA')

fetches.length = 0
sessionSnapshot = {
  current: 's3',
  ids: ['s1', 's2', 's3'],
  byId: { ...sessionSnapshot.byId, s3: { cwd: 'F:\\code\\projC' } },
}
const third = await renderSettled(Hero, props, 'hero')
check('新建对话 s3 → 查 projC', workspacesAsked().join(','), 'F:\\code\\projC')

console.log('')
console.log('=== 4. 仍然不展示工作区路径、不可编辑 ===')
const panel = []
walk(third.tree, (node) => panel.push(node))
check('渲染出 select 选择器', panel.some((n) => n.type === 'select'), 'false')
check(
  '正文里出现绝对路径',
  panel.some((n) => typeof n.props?.children === 'string' && /[A-Za-z]:\\/.test(n.props.children)),
  'false',
)

// ---- 5. 抽屉本体：宽度可拖动 + IDEA 式结构 -------------------------------------
//
// 面板是嵌套组件（挂在 shell.overlay 的入口里），要单独渲染才能看到它的 DOM。
console.log('')
console.log('=== 5. 抽屉：宽度可调 ===')
let panelElement
walk(third.tree, (node) => {
  if (typeof node.type === 'function' && node.type.name === 'ReviewPanel') panelElement = node
})
check('找到嵌套的 ReviewPanel', panelElement !== undefined, 'true')

const drawer = render(panelElement.type, panelElement.props, 'panel')
for (const effect of drawer.effects) effect()
await new Promise((resolve) => setTimeout(resolve, 0))

const drawerNodes = []
walk(drawer.tree, (node) => drawerNodes.push(node))

check('抽屉是 aside', drawer.tree.type, 'aside')
check('抽屉是 fixed 定位', drawer.tree.props?.style?.position, 'fixed')

const resizer = drawerNodes.find((node) => node.props?.['data-review-resizer'] !== undefined)
check('存在宽度手柄', resizer !== undefined, 'true')
check('手柄是 button', resizer?.type, 'button')
check('手柄声明为 separator', `${resizer?.props?.role}/${resizer?.props?.['aria-orientation']}`, 'separator/vertical')
check('手柄有本地化说明', typeof resizer?.props?.['aria-label'], 'string')

// 键盘调整：ArrowLeft 变宽、ArrowRight 变窄、Home 复位（不依赖鼠标事件）。
const widthOf = (tree) => Number.parseInt(String(tree.props.style.width), 10)
const startWidth = widthOf(drawer.tree)
// 默认宽度是**视口的 80%**（本桩的 innerWidth 是 1400 → 1120）。
//
// 从 50% 提到 80%（需求第 1 节的第一条）：50% 下"文件列表 + 差异"两栏都太窄，逐行差异几乎
// 每行都要横向滚动。同时**像素上限 1600 已删除**——它与"默认 80%"直接冲突（2560 的屏幕算
// 出来 2048 会被夹回 1600 = 62%）。这两件事必须一起改，否则宽屏上默认值就是错的。
check('宽度默认为视口的 80%', startWidth, Math.round(1400 * 0.8))
// 宽屏也必须真的拿到 80%，而不是被某个固定像素数卡住。
//
// 注意：桩把 localStorage 挂在 `window` 上（不是 `globalThis`），因此必须走
// `globalThis.window.localStorage`——写成 `globalThis.localStorage` 会静默变成空操作
// （可选链把它吞掉），断言随即变成"什么都没测"。
const panelStorage = globalThis.window.localStorage
check('2560 的屏幕默认 2048（不被像素上限夹住）', (() => {
  const saved = globalThis.window.innerWidth
  globalThis.window.innerWidth = 2560
  // 直接重挂面板：默认宽度是"读不到持久化值"时算出来的，因此先把持久化清掉。
  panelStorage.removeItem('dsh.review.panelWidth')
  const tree = render(panelElement.type, panelElement.props, 'panel-width-wide').tree
  globalThis.window.innerWidth = saved
  return widthOf(tree)
})(), Math.round(2560 * 0.8))

// 有持久化宽度时**优先用持久化的值**，而不是每次都回到 80%。
check('持久化宽度优先', (() => {
  const saved = globalThis.window.innerWidth
  globalThis.window.innerWidth = 1920
  panelStorage.setItem('dsh.review.panelWidth', '1100')
  const tree = render(panelElement.type, panelElement.props, 'panel-width-persist').tree
  globalThis.window.innerWidth = saved
  panelStorage.removeItem('dsh.review.panelWidth')
  return widthOf(tree)
})(), 1100)

const press = (key) => {
  let prevented = false
  resizer.props.onKeyDown({ key, preventDefault: () => { prevented = true } })
  return { prevented, tree: render(panelElement.type, panelElement.props, 'panel').tree }
}
// 默认值**贴着上限**（80% 既是默认也是最大），因此"变宽"必须先变窄一步——
// 直接按 ArrowLeft 会被夹住，那是正确行为而不是缺陷。
const narrowed = press('ArrowRight')
check('ArrowRight 之后变窄', widthOf(narrowed.tree) < startWidth, 'true')
const left = press('ArrowLeft')
check('ArrowLeft 被处理', left.prevented, 'true')
check('ArrowLeft 之后变宽（相对刚变窄的那一步）', widthOf(left.tree) > widthOf(narrowed.tree), 'true')
const home = press('Home')
check('Home 复位到默认宽度', widthOf(home.tree), startWidth)

// 鼠标拖动：按下手柄 → 向左移动 120px → 松开，宽度应增加 120。
//
// 起点必须先离上限**超过 120px**，否则往左拖会被夹在上限上（差值是 24 而不是 120），
// 那条断言就变成在测"夹取"而不是"拖动"。6 步 × 24px = 144px。
let beforeDrag = null
for (let i = 0; i < 6; i += 1) beforeDrag = press('ArrowRight')
check('拖前已离上限足够远', startWidth - widthOf(beforeDrag.tree), 144)
const dragStart = { clientX: 1000, button: 0, preventDefault() {} }
resizer.props.onMouseDown(dragStart)
check('拖动期间标记了 body', globalThis.document.body?.dataset?.reviewDragging, '1')
globalThis.document.emit('mousemove', { clientX: 880 })
const dragged = render(panelElement.type, panelElement.props, 'panel').tree
check('向左拖动 120px 后变宽 120', widthOf(dragged) - widthOf(beforeDrag.tree), 120)
globalThis.document.emit('mouseup', {})
check('松手后清掉拖动标记', globalThis.document.body?.dataset?.reviewDragging, undefined)

// 上限：视口的 80%（1400 → 1120）。往左拖一个远超上限的量，宽度必须停在 80% 而不是
// 一路拖到把主界面挤没。这条断言钉住"最大可到 80%"这个明确要求。
{
  resizer.props.onMouseDown({ clientX: 1000, button: 0, preventDefault() {} })
  globalThis.document.emit('mousemove', { clientX: -2000 })
  const widened = render(panelElement.type, panelElement.props, 'panel').tree
  check('向左猛拖后停在视口的 80%', widthOf(widened), Math.round(1400 * 0.8))
  globalThis.document.emit('mouseup', {})
}

console.log('')
console.log('=== 5b. 点击抽屉外部关闭（item 2）===')
{
  // 需求：点抽屉外任何**普通**区域都要关闭，且不能误关（内部 / resize handle / 抽屉里的
  // 弹窗 / 分支菜单 / 右上角入口都不许被当成"外部"）。
  //
  // 这里能离线测的部分：关闭方向（点普通区域、Escape）、以及"分支菜单与入口被豁免"这两条
  // 豁免。抽屉**内部**（`rootRef.contains`）依赖真实 DOM 的 ref，只能在 CDP 里测
  // （见 scripts/test-drawer-dismiss.mjs）。
  const panelStore = loaded.__panelStoreForTest
  const dismissKey = 'panel-dismiss'
  const isOpen = () => render(panelElement.type, panelElement.props, dismissKey).tree !== null
  /** 把开关重新置为打开，并把外部点击监听重新挂上（关掉时 effect 会摘掉它们）。 */
  const reopen = () => {
    panelStore.set(true)
    for (const effect of render(panelElement.type, panelElement.props, dismissKey).effects) effect()
  }

  reopen()
  check('5b) 抽屉初始是打开的', isOpen(), 'true')

  // 分支菜单（gitbar 渲染在 body 级、不在抽屉子树里）里的 mousedown 必须被豁免。
  globalThis.document.emit('mousedown', {
    target: { closest: (selector) => (selector.includes('data-desktop-sc-menu') ? { selector } : null) },
  })
  check('   点分支菜单内部 → 不关闭', isOpen(), 'true')
  // 抽屉里的原生 dialog 同样豁免。
  globalThis.document.emit('mousedown', {
    target: { closest: (selector) => (selector.includes('dialog[open]') ? { selector } : null) },
  })
  check('   点抽屉里的 dialog → 不关闭', isOpen(), 'true')

  // 入口按钮：它不在抽屉里，但必须由它自己 toggle（否则捕获阶段的 mousedown 先关、它的
  // onClick 再开，用户看到的是"闪一下"）。
  const savedQuery = globalThis.document.querySelector
  const trigger = { contains: (node) => node === 'inside-trigger' }
  globalThis.document.querySelector = (selector) => (selector === '[data-review-trigger="1"]' ? trigger : null)
  globalThis.document.emit('mousedown', { target: 'inside-trigger' })
  check('   点右上角入口 → 不关闭（由它自己 toggle，避免先关再开闪一下）', isOpen(), 'true')
  globalThis.document.querySelector = savedQuery

  // 点普通外部区域（没有 closest 的最小对象）→ 关闭。
  globalThis.document.emit('mousedown', { target: {} })
  check('   点普通外部区域 → 关闭', isOpen(), 'false')

  // 没有 target 的事件不许把监听器打崩（`typeof undefined.closest` 会先取属性再 typeof，
  // 直接抛 TypeError —— 那是一次程序化派发的事件就把抽屉带走）。
  let threw = null
  try {
    reopen()
    globalThis.document.emit('mousedown', {})
  } catch (cause) {
    threw = cause
  }
  check('   没有 target 的 mousedown 不抛错', threw === null ? 'ok' : String(threw?.message ?? threw), 'ok')
  check('   没有 target 也算外部 → 关闭', isOpen(), 'false')

  // Escape 仍然关闭（键盘用户的退出方式）。
  reopen()
  check('   Escape 前是打开的', isOpen(), 'true')
  globalThis.document.emit('keydown', { key: 'Escape' })
  check('   Escape → 关闭', isOpen(), 'false')
  // 关掉之后监听要摘掉（否则"关了还在监听"会变成隐藏的状态泄漏）。
  const before = domListeners.get('mousedown')?.size ?? 0
  reopen()
  const after = domListeners.get('mousedown')?.size ?? 0
  check('   重新打开会重新挂上监听', after > before, 'true')
}

console.log('')
console.log('=== 5c. 提交信息输入框：4 行 + 最小高度（item 8）===')
{
  // 输入框在 Changes 页签里，而页签内容要等快照请求回来才渲染——因此必须像 renderPanel
  // 一样跑几轮"渲染 + 执行副作用 + 等一个 tick"。
  // **必须用 `collectHostNodes` 而不是 `walk`**：`walk` 只遍历元素树、不展开函数组件，
  // 而提交卡片所在的 `StagingSection` 正是嵌套函数组件——用 `walk` 只能看到那个
  // `<StagingSection>` 元素本身，断言会误判成"输入框没渲染"。
  const textareaKey = 'panel'
  const drainPanel = async () => {
    let nodes = []
    for (let pass = 0; pass < 4; pass += 1) {
      const queued = []
      const out = render(panelElement.type, panelElement.props, textareaKey)
      queued.push(...out.effects)
      nodes = collectHostNodes(out.tree, queued)
      for (const effect of queued) effect()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    return nodes
  }
  const nodes = await drainPanel()
  const message = nodes.find((node) => node.props?.['data-staging-message'] !== undefined)
  check('5c) 找到提交信息输入框', message !== undefined, 'true')
  check('   rows 从 2 提到 4', message?.props?.rows, 4)
  check('   有最小高度（拖小之后仍然够用）', message?.props?.style?.minHeight, '90px')
  check('   仍然允许纵向拖拽', message?.props?.style?.resize, 'vertical')
  // Ctrl+Enter 仍然提交：这条不能在"把框加大"的改动里被弄丢。
  let prevented = false
  message?.props?.onKeyDown?.({ key: 'Enter', ctrlKey: true, stopPropagation() {}, preventDefault() { prevented = true } })
  check('   Ctrl+Enter 仍被处理', prevented, 'true')

  console.log('')
  console.log('=== 5d. 字号跟随 UI typography token（item 7）===')
  // 抽屉里所有字号都必须从 `--dsh-ui-px-14` 派生（见客户端里 uiPx 的说明）：
  // 那个变量由"设置 → UI 字号"插件维护，基准 14 下 `calc(base * N / 14)` 就是 N px，
  // 因此这次改造不改变默认外观，字号 12 / 18 时整块同步缩放。
  const css = styledBlocks.map((node) => String(node.textContent ?? '')).join('\n')
  check('5d) 注入了样式块', styledBlocks.length > 0, 'true')
  check('   差异头部字号走 uiPx 派生', css.includes('font-size: calc(var(--dsh-ui-px-14, 14px) * 11.5 / 14)'), true)
  check('   分区标题字号走 uiPx 派生', css.includes('font-size: calc(var(--dsh-ui-px-14, 14px) * 11 / 14)'), true)
  // 裸 px 字号一个都不许剩：剩下的那些就是"不跟随设置"的角落。
  const bare = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => m[1])
  check('   样式里没有裸 px 字号（说明全部走 token）', bare.join(','), '')

  // 内联样式同理：右栏摘要、详情、文件行、差异正文都得是 uiPx 表达式。
  const inlineSizes = (await drainPanel())
    .map((node) => node.props?.style?.fontSize)
    .filter((value) => typeof value === 'string')
  check('   抽屉里有内联字号', inlineSizes.length > 0, true)
  const bareInline = inlineSizes.filter((value) => !value.startsWith('calc('))
  check('   内联字号里没有裸 px', bareInline.join(','), '')
}

console.log('')
console.log('=== 6. Changes | Log 两个页签 ===')
/** 抽屉的 hook key。后面几节会换新 key 重新挂载，拿到干净状态。 */
let panelKey = 'panel'
// 面板的数据是异步取的：桩渲染不会自动重渲染，所以"渲染两次 + 执行副作用"才能看到
// 文件列表与提交图（真实 React 会在 setState 后自己重渲染）。
const renderPanel = async () => {
  let out = render(panelElement.type, panelElement.props, panelKey)
  for (const effect of out.effects) effect()
  await new Promise((resolve) => setTimeout(resolve, 0))
  out = render(panelElement.type, panelElement.props, panelKey)
  for (const effect of out.effects) effect()
  await new Promise((resolve) => setTimeout(resolve, 0))
  return out
}

const settled = await renderPanel()
const settledNodes = collectHostNodes(settled.tree)
if (process.env.DSH_TEST_DEBUG === '1') {
  console.log('  [debug] workspace prop =', JSON.stringify(panelElement.props.workspace))
  console.log('  [debug] requests =', fetches.map((f) => f.url.replace(/^.*\/review\//u, '')).join(' | '))
}
const tags = new Set(settledNodes.filter((n) => typeof n.type === 'string').map((n) => n.type))
console.log(`  宿主元素: ${[...tags].sort().join(', ')}`)

// 顶部两个页签：`Changes`（暂存与提交）与 `Log`（提交图）。这一步替换掉了以前那条
// "暂存区 → 更改 → 文件列表 → 最近提交（原位展开）"的单列结构。
const tabNodes = settledNodes.filter((n) => n.props?.['data-review-tab'] !== undefined)
check('6) 有两个页签', tabNodes.map((n) => n.props['data-review-tab']).join(','), 'changes,log')
check(
  '   默认选中 Changes',
  tabNodes.find((n) => n.props['data-review-tab'] === 'changes')?.props?.['aria-selected'],
  true,
)
check(
  '   Log 未选中',
  tabNodes.find((n) => n.props['data-review-tab'] === 'log')?.props?.['aria-selected'],
  false,
)
// Changes 页签的内容：分区标题 + 提交区 + 文件分组。
check('   有分区标题', settledNodes.some((n) => n.props?.['data-review-section-title'] !== undefined), 'true')
check('   有刷新按钮', settledNodes.some((n) => n.type === 'button' && n.props?.title === 'refresh'), 'true')
check('   有收起按钮', settledNodes.some((n) => n.type === 'button' && n.props?.title === 'collapse'), 'true')
check('   Changes 页签里是暂存/提交区块', settledNodes.some((n) => n.props?.['data-staging'] !== undefined), 'true')
check('   提交区在 Changes 页签里', settledNodes.some((n) => n.props?.['data-staging-commit-card'] !== undefined), 'true')
console.log('')
console.log('=== 6b. 提交区固定在底部，不随文件列表滚走 ===')
{
  // 结构上必须是「可滚动的分组区（order 1）+ 提示（order 2）+ 提交区（order 3）」，
  // 且它们同属一个纵向 flex 容器。以前整块内容共用一个滚动区，文件一多提交框就被
  // 滚出视野——那是这次要修的交互之一。
  const staging = settledNodes.find((n) => n.props?.['data-staging'] !== undefined)
  const scroll = settledNodes.find((n) => n.props?.['data-staging-scroll'] !== undefined)
  const card = settledNodes.find((n) => n.props?.['data-staging-commit-card'] !== undefined)
  check('   有独立的分组滚动区', scroll !== undefined, 'true')
  check('   滚动区排在最前（order 1）', String(scroll?.props?.style?.order), '1')
  check('   滚动区自己滚动', scroll?.props?.style?.overflowY, 'auto')
  check('   提交区排在最后（order 3）', String(card?.props?.style?.order), '3')
  check('   提交区不参与收缩', String(card?.props?.style?.flexShrink), '0')
  check('   根是纵向 flex', staging?.props?.style?.flexDirection, 'column')

  // ---- 输入框从 2 行长到 4 行（+90px 最小高度）之后，按钮**仍然不会掉出可视区** ----
  //
  // 结构上必须成立的两件事：
  //   1. 提交区里那个 textarea 用的是 `minHeight` 而**不是** `height`：4 行是默认高度，
  //      用户还能往下拖大，因此"高度只会增"这件事不能靠固定高度假装；
  //   2. 滚动区允许被压缩（`flex: 1 1 auto` + `minHeight: 0`）：输入框变高时被挤掉的必须
  //      是**文件列表**的可视高度，而不是把提交区推出容器（那正是"按钮跑到屏幕外"的形态）。
  // 另外提交区必须**不在**滚动区里——在里就会被一起滚走。
  const message = settledNodes.find((n) => n.props?.['data-staging-message'] !== undefined)
  check('   输入框在提交区里', card !== undefined && message !== undefined, 'true')
  check('   输入框高度是 minHeight 而不是 height', message?.props?.style?.height, undefined)
  check('   最小高度够放 4 行', message?.props?.style?.minHeight, '90px')
  check('   滚动区可被压缩（flex-basis auto）', String(scroll?.props?.style?.flex), '1 1 auto')
  check('   滚动区允许收缩到 0（minHeight 0）', String(scroll?.props?.style?.minHeight), '0')
  check('   提交区不在滚动区里', scroll !== undefined && card !== undefined ? scroll !== card : false, true)
}
console.log('')
console.log('=== 6c. 头栏计数就是快照里的文件数 ===')
{
  // 这一条是"外面显示 0、进去却有文件"的直接回归：头栏计数与页签里列出的文件来自
  // **同一份快照**，因此不可能不一致。
  const counts = settledNodes.filter((n) => n.props?.['data-review-count'] !== undefined).map((n) => textOf(n))
  check('   头栏计数等于 CHANGES.files.length', counts.includes(String(CHANGES.files.length)), 'true')
}

/**
 * 渲染 + 展开整棵树 + 执行**嵌套组件**产生的副作用，反复到不再有新副作用为止。
 *
 * 为什么不能直接用 `renderPanel()`：它只渲染抽屉本身，而抽屉的子树（暂存区、提交图）
 * 都是**嵌套组件**——桩渲染器不给嵌套组件跑 effect，只有 `collectHostNodes` 展开它们时
 * 才会把 effect 收进队列。所以"执行副作用"这件事必须由展开这一步负责，否则那些组件
 * 永远停在"加载中"（实测踩到过：面板一直显示 loading）。
 */
const drain = async () => {
  let out = await renderPanel()
  for (let pass = 0; pass < 8; pass += 1) {
    const queued = [...out.effects]
    collectHostNodes(out.tree, queued)
    if (queued.length === 0) break
    for (const effect of queued) effect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    out = await renderPanel()
  }
  return collectHostNodes(out.tree)
}
const detailCalls = () => fetches.filter((f) => f.url.includes('/review/commit-detail'))
const fileCalls = () => fetches.filter((f) => f.url.includes('/review/commit-file'))
const graphCalls = () => fetches.filter((f) => f.url.includes('/review/graph'))
const snapshotCalls = () => fetches.filter((f) => f.url.includes('/review/workspace'))
/**
 * 用**另一个** hook key 重新挂载抽屉，拿到一份干净的状态。
 * @param label - 新 key 的后缀。
 */
const mount = async (label) => {
  panelKey = `panel-${label}`
  await renderPanel()
  return drain()
}
/** 在**当前**界面上找节点，并立刻触发它的点击。 */
const clickNow = async (attr, value) => {
  const nodes = await drain()
  const node = nodes.find((n) => (value === undefined ? n.props?.[attr] !== undefined : n.props?.[attr] === value))
  if (node === undefined || typeof node.props.onClick !== 'function') return false
  node.props.onClick()
  return true
}

console.log('')
console.log('=== 7. Log 页签：三栏提交图 + 点提交看文件 + 点文件看差异 ===')
// 这三步是用户直接提出的交互（"点击提交记录可以看到提交的文件，点击还能看到文件修改了啥"），
// 并且每一步都要**按需**去宿主取数据：不点不取、点了才取、取回来的东西要真的渲染出来。
check('7) 切到 Log 之前没有取提交图', graphCalls().length, 0)
check('   点得中 Log 页签', await clickNow('data-review-tab', 'log'), 'true')
let stepNodes = await drain()
check('   切到 Log 后渲染提交图', rowsOf(stepNodes, 'data-graph-view').length, 1)
check(
  '   三栏都在（分支树 / 提交列表 / 详情）',
  rowsOf(stepNodes, 'data-graph-pane').map((n) => n.props['data-graph-pane']).join(','),
  'tree,list,detail',
)
check('   拉了提交图', graphCalls().length >= 1, 'true')
check('   提交行渲染出来', rowsOf(stepNodes, 'data-graph-row').length, 2)
// 未选中任何提交时：右栏提示"选一条"，且**没有**取过详情。
check('   未选中时不取提交详情', detailCalls().length, 0)
check('   最上面那条提交可点', await clickNow('data-graph-row', 'a'.repeat(40)), 'true')
stepNodes = await drain()
check('   点提交后只取一次详情', detailCalls().length, 1)
check('   详情请求带上工作区', JSON.parse(detailCalls()[0]?.body).workspace, 'F:\\code\\projC')
check('   详情请求带上该提交的哈希', JSON.parse(detailCalls()[0]?.body).revision, 'a'.repeat(40))
// 右侧详情列出这次提交改动的文件（`data-graph-file-row` 只可能来自详情面板）。
const changedRows = rowsOf(stepNodes, 'data-graph-file-row')
check('   右侧列出这次提交改动的文件', changedRows.length, 2)
has('   含 src/app.ts', changedRows.some((n) => n.props['data-graph-file-row'] === 'src/app.ts'))
has('   含 docs/readme.md', changedRows.some((n) => n.props['data-graph-file-row'] === 'docs/readme.md'))
// 选中行必须被标记（IDEA 里选中行是高亮的）。
check('   选中行被标记', rowsOf(stepNodes, 'data-graph-row').find((n) => n.props['data-graph-row'] === 'a'.repeat(40))?.props?.['aria-selected'], 'true')
// 元信息：标题/哈希/作者/所在分支（`data-graph-containing` 只在分支信息存在时才渲染）。
const summaryText = textOf(rowsOf(stepNodes, 'data-commit-summary')[0] ?? null)
has('   显示提交标题', summaryText.includes('second commit'))
// **不显示哈希**（需求第 3 节）。否定断言必须拿一个真的出现过、且**只**出现在摘要里的短
// 哈希：`data-commit-summary` 这个节点里原本渲染的就是右栏摘要，去掉之后它必须消失。
check('   摘要里不再显示短哈希', summaryText.includes('aaaaaaa'), 'false')
has('   显示作者与邮箱', summaryText.includes('tester') && summaryText.includes('t@example.com'))
// 时间精确到秒（需求第 6 节）：摘要里的这一格必须带 `HH:mm:ss`。
has('   时间精确到秒', /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(summaryText))
const containingNode = rowsOf(stepNodes, 'data-graph-containing')[0]
has('   渲染了所在分支这一行', containingNode !== undefined)
check('   分支行的文案键', containingNode?.props?.children, 'graphInBranches')
const branchCall = tCalls.filter((c) => c.key === 'graphInBranches').pop()
check('   分支文案收到分支名', branchCall?.params?.names, 'main')
// 文件差异仍然是按需的：刚点开提交时一个差异都没取、也没渲染。
//
// 这一版把 diff 从右栏移到了底部横跨"提交图 + 详情"的 Diff Preview，因此这里的断言也从
// "右栏里内联展开"改成"右栏里绝不出现差异、差异只在 Preview 里"。
check('   展开提交后仍不取文件差异', fileCalls().length, 0)
check('   展开提交后没有内联差异容器', rowsOf(stepNodes, 'data-graph-file-diff').length, 0)
check('   展开提交后也没有 Diff Preview', rowsOf(stepNodes, 'data-graph-diff-preview').length, 0)

// 点文件 → 取这个文件在这次提交里的差异，并在**底部 Preview** 里渲染出来。
check('   点得中改动文件', await clickNow('data-graph-file-row', 'src/app.ts'), 'true')
stepNodes = await drain()
const diffCalls = fileCalls()
check('   点了文件才取差异', diffCalls.length, 1)
check('   差异请求带上文件路径', JSON.parse(diffCalls[0]?.body).path, 'src/app.ts')
check('   差异请求带上提交哈希', JSON.parse(diffCalls[0]?.body).revision, 'a'.repeat(40))
check('   出现 Diff Preview', rowsOf(stepNodes, 'data-graph-diff-preview').length, 1)
// 右栏里**仍然**没有差异：这是这一版的核心约束。
check('   右栏里没有差异行', collectHostNodes(rowsOf(stepNodes, 'data-graph-detail')[0] ?? { props: {} }).some((n) => n.props?.['data-review-diff-row'] !== undefined), 'false')
const diffContainer = rowsOf(stepNodes, 'data-graph-diff-preview')[0]
const diffLines = collectHostNodes(diffContainer).filter((n) => n.props?.['data-review-diff-row'] !== undefined)
has('   差异内容已渲染', diffLines.length > 0)
has('   差异里有新增行', diffLines.some((n) => n.props.children?.[1]?.props?.children === '+' && textOf(n).includes('new')))
check('   只有被点开的那个文件在 Preview 里', rowsOf(stepNodes, 'data-graph-diff-preview').length, 1)
check('   选中的文件行被标记', rowsOf(stepNodes, 'data-graph-file-row').find((n) => n.props['data-graph-file-row'] === 'src/app.ts')?.props?.['aria-selected'], 'true')

// 再点一次同一个文件：保持选中，且**不重复取数**（需求第 3 条）。
check('   点得中同一个文件行', await clickNow('data-graph-file-row', 'src/app.ts'), 'true')
stepNodes = await drain()
check('   再次点击仍保持 Preview', rowsOf(stepNodes, 'data-graph-diff-preview').length, 1)
check('   再次点击不重复取差异', fileCalls().length, 1)
// 关闭 Preview：上半部三栏必须不受影响。
check('   点得中关闭按钮', await clickNow('data-graph-diff-close'), 'true')
stepNodes = await drain()
check('   关闭后 Preview 消失', rowsOf(stepNodes, 'data-graph-diff-preview').length, 0)
check('   关闭后三栏仍在', rowsOf(stepNodes, 'data-graph-pane').map((n) => n.props['data-graph-pane']).join(','), 'tree,list,detail')

// 单击另一条提交只改选中项：右侧详情跟着换，**不再原位展开**（这是与旧实现最大的区别）。
check('   点得中第二条提交', await clickNow('data-graph-row', 'b'.repeat(40)), 'true')
stepNodes = await drain()
check('   换选中后右侧仍是同一块详情栏', rowsOf(stepNodes, 'data-graph-pane').filter((n) => n.props['data-graph-pane'] === 'detail').length, 1)
check('   换选中只再取一次详情', detailCalls().length, 2)
check('   第二次取的是第二条提交', JSON.parse(detailCalls()[1]?.body).revision, 'b'.repeat(40))

console.log('')
console.log('=== 8. 只有一个数据源：快照不会因为重渲染而重复轮询 ===')
{
  const before = snapshotCalls().length
  await drain()
  await drain()
  check('8) 多次重渲染不重复取快照', snapshotCalls().length - before, 0)
}

console.log('')
console.log('=== 8b. 详情还没到手时，右栏已经在了 ===')
// "点了没反应"与"正在加载"必须在界面上分得开：加载中就该有外壳（详情栏本身），
// 且**只发一次**请求；放行之后文件列表出现，也不重复请求。
{
  await mount('hold')
  check('   切到 Log', await clickNow('data-review-tab', 'log'), 'true')
  await drain()
  const beforeCount = detailCalls().length
  holdCommitDetail = true
  check('   点得中提交行', await clickNow('data-graph-row', 'a'.repeat(40)), 'true')
  const loadingNodes = await drain()
  has('   加载中已经有详情栏', rowsOf(loadingNodes, 'data-graph-pane').some((n) => n.props['data-graph-pane'] === 'detail'))
  check('   加载中还没有文件行', rowsOf(loadingNodes, 'data-graph-file-row').length, 0)
  check('   加载中发出了详情请求', detailCalls().length - beforeCount, 1)
  check('   详情请求带上该提交', JSON.parse(detailCalls().at(-1)?.body).revision, 'a'.repeat(40))
  // 放行：面板里应当出现文件列表，且不再多发一次请求。
  for (const release of heldDetails.splice(0)) release()
  holdCommitDetail = false
  const loadedNodes = await drain()
  check('   放行后出现文件行', rowsOf(loadedNodes, 'data-graph-file-row').length, 2)
  check('   放行后没有重复请求', detailCalls().length - beforeCount, 1)
}

console.log('')

console.log(failures === 0 ? '项目级入口钩子全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
