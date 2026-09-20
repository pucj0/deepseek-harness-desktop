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
    hookSlots[slot] = { value: getSnapshot() }
    return hookSlots[slot].value
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
  files: [
    { path: 'src/app.ts', status: 'M', added: 3, removed: 1 },
    { path: 'docs/readme.md', status: 'A', added: 5, removed: 0 },
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
        : target.includes('/history')
          ? HISTORY
          : CHANGES
  return { ok: true, text: async () => JSON.stringify(payload) }
}

/** 事件登记表：`type -> Set<handler>`。拖动要靠它把 mousemove/mouseup 真的派发出去。 */
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
  /** 派发一个事件（测试用，替代真实 DOM 的事件系统）。 */
  emit(type, event) {
    for (const handler of domListeners.get(type) ?? []) handler(event)
  },
  querySelector: () => null,
  createElement: () => ({ dataset: {}, style: {}, textContent: '', remove() {} }),
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
// 默认宽度是**视口的 50%**（本桩的 innerWidth 是 1400 → 700），与 IDEA 的 Git 工具窗
// 默认占半屏一致。此前是写死的 480px —— 那个值在 1366 的笔记本上占 35%、在 2560 的
// 显示器上只占 19%，同一块面板在两种屏上是完全不同的东西。
check('宽度默认为视口的 50%', startWidth, Math.round(1400 * 0.5))

const press = (key) => {
  let prevented = false
  resizer.props.onKeyDown({ key, preventDefault: () => { prevented = true } })
  return { prevented, tree: render(panelElement.type, panelElement.props, 'panel').tree }
}
const left = press('ArrowLeft')
check('ArrowLeft 被处理', left.prevented, 'true')
check('ArrowLeft 之后变宽', widthOf(left.tree) > startWidth, 'true')
const right = press('ArrowRight')
check('ArrowRight 之后变窄', widthOf(right.tree) < widthOf(left.tree), 'true')
const home = press('Home')
check('Home 复位到默认宽度', widthOf(home.tree), startWidth)

// 鼠标拖动：按下手柄 → 向左移动 120px → 松开，宽度应增加 120。
const dragStart = { clientX: 1000, button: 0, preventDefault() {} }
resizer.props.onMouseDown(dragStart)
check('拖动期间标记了 body', globalThis.document.body?.dataset?.reviewDragging, '1')
globalThis.document.emit('mousemove', { clientX: 880 })
const dragged = render(panelElement.type, panelElement.props, 'panel').tree
check('向左拖动 120px 后变宽 120', widthOf(dragged) - startWidth, 120)
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
console.log('=== 6. IDEA 式结构 ===')
// 面板的数据是异步取的：桩渲染不会自动重渲染，所以"渲染两次 + 执行副作用"才能看到
// 文件列表与提交历史（真实 React 会在 setState 后自己重渲染）。
const renderPanel = async () => {
  let out = render(panelElement.type, panelElement.props, 'panel')
  for (const effect of out.effects) effect()
  await new Promise((resolve) => setTimeout(resolve, 0))
  out = render(panelElement.type, panelElement.props, 'panel')
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
check('渲染出两个文件行', settledNodes.filter((n) => typeof n.props?.title === 'string' && n.props.title.includes('/')).length, 2)
check('有分区标题', settledNodes.some((n) => n.props?.['data-review-section-title'] !== undefined), 'true')
check('有刷新按钮', settledNodes.some((n) => n.type === 'button' && n.props?.title === 'refresh'), 'true')
check('有收起按钮', settledNodes.some((n) => n.type === 'button' && n.props?.title === 'collapse'), 'true')
check('行内「还原」也收成图标按钮', settledNodes.filter((n) => n.props?.className === 'dsh-review-revert' && n.props?.['data-review-icon-button'] !== undefined).length, 2)
check('还原按钮的 title 仍是「还原」（脚本依赖）', settledNodes.filter((n) => n.props?.title === 'revert').length, 2)
check('文件行 title 是完整路径（脚本依赖）', settledNodes.some((n) => n.props?.title === 'src/app.ts'), 'true')
check('文件行带状态徽标', settledNodes.some((n) => n.props?.['data-review-status'] !== undefined), 'true')
check('提交历史渲染了 2 条', settledNodes.filter((n) => n.props?.className === 'dsh-review-history').length, 2)

console.log('')
console.log('=== 7. 点提交记录 → 看改动文件 → 点文件 → 看差异 ===')
// 这三步是用户直接提出的交互（"点击提交记录可以看到提交的文件，点击还能看到文件修改了啥"），
// 并且每一步都要**按需**去宿主取数据：不点不取、点了才取、取回来的东西要真的渲染出来。
const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node !== 'object') return ''
  return textOf(node.props?.children)
}
const settlePanel = async () => {
  const out = await renderPanel()
  return collectHostNodes(out.tree)
}
// `collectHostNodes` 只展开组件、**丢掉它们产生的副作用**，所以刚点开后新挂载的
// `CommitChangesPanel` / `CommitFileRow` 的取数 effect 不会被执行（表现为"点了提交
// 什么都不发生"）。这里照 test-review-graph-view.mjs 的做法，边展开边把副作用收进队列，
// 再逐个执行、等异步落定，然后重新渲染——等价于真实 React 的挂载 + 自动重渲染。
const drain = async () => {
  const out = await renderPanel()
  const queued = []
  collectHostNodes(out.tree, queued)
  for (const effect of queued) effect()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const next = await renderPanel()
  return collectHostNodes(next.tree)
}
const rowsOf = (nodes, attr) => nodes.filter((n) => n.props?.[attr] !== undefined)
const has = (label, actual) => check(label, actual === true, true)
const detailCalls = () => fetches.filter((f) => f.url.includes('/review/commit-detail'))
const fileCalls = () => fetches.filter((f) => f.url.includes('/review/commit-file'))
/** 在**当前**界面上找节点，并立刻触发它的点击。 */
const clickNow = async (attr, value) => {
  const nodes = await drain()
  const node = nodes.find((n) => (value === undefined ? n.props?.[attr] !== undefined : n.props?.[attr] === value))
  if (node === undefined || typeof node.props.onClick !== 'function') return false
  node.props.onClick()
  return true
}

// 未点击时是收起的：只有可点的行，没有改动面板，也**没有**取过详情。
check('未展开时没有改动面板', rowsOf(settledNodes, 'data-review-commit-changes').length, 0)
check('未展开时不取提交详情', detailCalls().length, 0)
const firstHistory = settledNodes.find((n) => n.props?.className === 'dsh-review-history')
check('第一条提交记录可点', typeof firstHistory?.props?.onClick, 'function')
check('提交记录带展开标记', firstHistory?.props?.['data-review-commit-toggle'], 'a'.repeat(40))

// 第一步：点提交记录。
check('点得中第一条提交记录', await clickNow('data-review-commit-toggle', 'a'.repeat(40)), 'true')
fetches.length = 0
let stepNodes = await drain()
const changePanels = rowsOf(stepNodes, 'data-review-commit-changes')
check('点开后出现改动面板', changePanels.length, 1)
check('面板对应被点的那次提交', changePanels[0]?.props?.['data-review-commit-changes'], 'a'.repeat(40))
check('展开标记已置位', stepNodes.find((n) => n.props?.className === 'dsh-review-history')?.props?.['aria-expanded'], 'true')
// 详情只取一次：元信息（CommitSummary）与文件列表（CommitFileList）共用同一个结果。
check('只取一次提交详情', detailCalls().length, 1)
check('详情请求带上工作区', JSON.parse(detailCalls()[0]?.body).workspace, 'F:\\code\\projC')
check('详情请求带上该提交的哈希', JSON.parse(detailCalls()[0]?.body).revision, 'a'.repeat(40))
// 这次提交改动的两个文件都列出来了。主区域的文件列表用的是 `data-review-row`，
// 所以 `data-graph-file-row` 只可能来自改动面板（下面那条断言把这个前提也钉住）。
const changedRows = rowsOf(stepNodes, 'data-graph-file-row')
check('列出这次提交改动的文件', changedRows.length, 2)
has('含 src/app.ts', changedRows.some((n) => n.props['data-graph-file-row'] === 'src/app.ts'))
has('含 docs/readme.md', changedRows.some((n) => n.props['data-graph-file-row'] === 'docs/readme.md'))
// 元信息：标题/哈希/作者/所在分支（`data-graph-containing` 只在分支信息存在时才渲染）。
const summaryText = textOf(rowsOf(stepNodes, 'data-commit-summary')[0] ?? null)
has('显示提交标题', summaryText.includes('second commit'))
has('显示短哈希', summaryText.includes('aaaaaaa'))
has('显示作者与邮箱', summaryText.includes('tester') && summaryText.includes('t@example.com'))
// 所在分支：`data-graph-containing` 只在**确有**分支信息时才渲染，节点存在即说明这一行
// 渲染了；插值本身归宿主侧的 `locale` 管（这个桩的 `bind` 按约定回显 key，见 ctx.locale），
// 所以这里断言"节点存在 + 文案函数收到正确实参"，不去比对拼接后的整句。
const containingNode = rowsOf(stepNodes, 'data-graph-containing')[0]
has('渲染了所在分支这一行', containingNode !== undefined)
check('分支行的文案键', containingNode?.props?.children, 'graphInBranches')
const branchCall = tCalls.filter((c) => c.key === 'graphInBranches').pop()
check('分支文案收到分支名', branchCall?.params?.names, 'main')
check('分支文案收到分支数', branchCall?.params?.count, 1)
// 文件差异仍然是按需的：刚点开提交时一个差异都没取、也没渲染。
check('展开提交后仍不取文件差异', fileCalls().length, 0)
check('展开提交后没有差异容器', rowsOf(stepNodes, 'data-graph-file-diff').length, 0)

// 点文件 → 取这个文件在这次提交里的差异并渲染出来。
check('点得中改动文件', await clickNow('data-graph-file-row', 'src/app.ts'), 'true')
stepNodes = await drain()
const diffCalls = fileCalls()
check('点了文件才取差异', diffCalls.length, 1)
check('差异请求带上文件路径', JSON.parse(diffCalls[0]?.body).path, 'src/app.ts')
check('差异请求带上提交哈希', JSON.parse(diffCalls[0]?.body).revision, 'a'.repeat(40))
check('出现差异容器', rowsOf(stepNodes, 'data-graph-file-diff').length, 1)
// 差异行在容器**内部**（`renderDiff` 返回的是数组），所以要从那个子树里递归找，
// 不能在整棵树的一层里筛。
const diffContainer = rowsOf(stepNodes, 'data-graph-file-diff')[0]
const diffLines = collectHostNodes(diffContainer).filter((n) => n.props?.['data-review-diff-row'] !== undefined)
has('差异内容已渲染', diffLines.length > 0)
// 行的子元素第 2 个是增删标记、第 3 个是代码本身（顺序被 test-diff-readability 钉住）。
has('差异里有新增行', diffLines.some((n) => n.props.children?.[1]?.props?.children === '+' && textOf(n).includes('new')))
check('只有被点开的那个文件展开', rowsOf(stepNodes, 'data-graph-file-diff').length, 1)

// 再点一次收起：面板消失，但不必重新取数据。
check('点得中同一个文件行', await clickNow('data-graph-file-row', 'src/app.ts'), 'true')
stepNodes = await drain()
check('再次点击收起差异', rowsOf(stepNodes, 'data-graph-file-diff').length, 0)
check('收起不重复取差异', fileCalls().length, 1)

// 再点提交记录收起：改动面板消失。
check('点得中同一条提交记录', await clickNow('data-review-commit-toggle', 'a'.repeat(40)), 'true')
stepNodes = await drain()
check('再次点击提交记录收起改动面板', rowsOf(stepNodes, 'data-review-commit-changes').length, 0)
check('收起改动面板不重复取详情', detailCalls().length, 1)

// 展开第一个文件：差异容器与差异行必须出现，且行的子元素顺序保持
// 「行号 → 增删标记 → 代码」（test-diff-readability.mjs 按这个顺序取样）。
check('点得中改动文件行', await clickNow('title', 'src/app.ts'), 'true')
const expandedNodes = await drain()
check('展开后出现差异容器', expandedNodes.some((n) => n.props?.['data-review-diff'] !== undefined), 'true')
const diffRows = expandedNodes.filter((n) => n.props?.['data-review-diff-row'] !== undefined)
check('差异行已渲染', diffRows.length > 0, 'true')
const addRow = diffRows.find((row) => row.props.children?.[1]?.props?.children === '+')
check('增行标记在第二个子元素', addRow !== undefined, 'true')
check('行号在第一个子元素', /\d/.test(JSON.stringify(addRow?.props.children?.[0] ?? null)), 'true')

console.log('')
console.log(failures === 0 ? '项目级入口钩子全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
