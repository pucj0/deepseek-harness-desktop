// 验证 gitbar 客户端的**源代码管理面板**：分组、同步标记、右键菜单、对话框，
// 以及"host 的稳定 code → 当前语言短句"这条错误链。
//
//   node scripts/test-gitbar-source-panel.mjs
//
// 为什么不用 CDP：`scripts/test-gitbar-ui.mjs` 那种方式需要先起一个带
// `--remote-debugging-port` 的应用，而且只能断言"元素在不在"。而这一批改动里最容易
// 悄悄坏掉的是**数据映射**：分组该不该有、同步标记取哪个字段、右键菜单里哪一项该禁、
// 对话框最终发了哪个请求体。用桩渲染器（假 React + 假 fetch + 假 DOM）直接加载插件
// 模块，就能把这些逐条钉死，而且不需要 Electron。
//
// 这个桩有三条**必须**遵守的规则，都是踩过之后才总结出来的（每一条都对应一次
// "组件完全正确、断言全红"）：
//
//   1. 组件的 hook 槽按"元素在树里的位置"归属（如 `bar.c.0`），且**所有渲染入口必须
//      用同一个起点 key**。早先 settle 用 `'bar'` 渲染、收集却从 `'root'` 开始展开，
//      于是 status 存在一份槽里、读的是另一份——现象是"请求发出去了但界面永远不更新"。
//   2. 副作用挂在**嵌套组件**上（`/status`、`/branches` 都是 BranchChip 的 effect），
//      所以必须展开整棵树、把每一层排队的 effect 都跑掉，光跑根组件没用。
//   3. 徽章触发器是容器里的**按钮**，容器自己不带 onClick（它的 ref 只用于"点击外部
//      关闭"的判定）。按容器点会静默地什么都不发生。
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// **必须相对脚本自身定位，不能用 `process.cwd()`。** 这一个字之差让整套断言红了两轮：
// 从仓库根跑时解析到的是一份模块实例，从别处跑（或 `workdir` 不同）解析到另一份，
// 而假 React 的 hook 状态、假 fetch 的记录都挂在模块实例上——于是"组件明明对了，
// 断言却全红"，而且换个目录跑结论还会变。
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PLUGIN = pathToFileURL(join(ROOT, 'plugins', 'dsh-client-ui-gitbar', 'lib', 'client.js')).href

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

/** 渲染一个组件（不是嵌套组件），返回元素树与本次产生的副作用。 */
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

/**
 * 收集元素树里的宿主节点，并把函数组件就地展开。
 *
 * @param node - 元素树。
 * @param key - 根元素所属的组件实例 key。**必须与 render 时用的 key 一致**。
 * @param queued - 传入数组时会顺便把各组件排队的副作用收集进去（调用方负责跑掉）。
 * @returns 宿主节点数组。
 */
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
      // 组件实例的 identity = 它在树里的位置 + 它的 `key`。
      //
      // **必须把 key 算进去**：真实 React 用 key 判断"这个位置上的还是不是同一个组件"，
      // key 变了就卸载重建（`useState` 初值重新执行）。桩如果不认 key，就没法验证
      // "换一个对话框就换一个实例"这类修复——实测踩到过：组件加了 key、预填值却依然错，
      // 因为桩把它当成了同一个实例。
      const name = current.type.name === '' ? 'anonymous' : current.type.name
      const keyed = `${path}${current.props?.key === undefined ? '' : `#${String(current.props.key)}`}:${name}`
      const { tree, effects } = render(current.type, current.props, keyed)
      if (queued !== undefined) queued.push(...effects)
      // **展开后不能 return**：函数组件返回的元素树要交给同一次遍历继续走，才能把它的
      // 子孙宿主节点收进结果。早先这里 return 之后，那个"包了一层的组件"下面整棵子树的
      // 宿主节点（含徽章按钮）全都收不到——实测表现为 `panelOpen()` 永远 false、
      // `clickBadge()` 找不到按钮，而界面其实是好的。
      visit(tree, keyed)
      return
    }
    out.push(current)
    visit(current.props?.children, `${path}.c`)
  }
  visit(node, key)
  return out
}

/** 按渲染器的做法把 source 绑成 `use<Name>` 选择器钩子。 */
const makeSelectorHook = (read) => (selector) =>
  react.useSyncExternalStore(
    () => () => {},
    () => selector(read()),
  )

// ---- 假会话：会话 s1 的工作区是 F:\code\projA ------------------------------------
const sessionSnapshot = {
  current: 's1',
  ids: ['s1'],
  byId: { s1: { cwd: 'F:\\code\\projA' } },
}

// ---- 假 DOM ----------------------------------------------------------------------
const domListeners = new Map()
/**
 * 派发一个文档级事件（面板的关闭逻辑挂在 document 上）。
 *
 * **必须尊重 `stopPropagation()`。** 真实 DOM 里，子元素的处理器调了它，document 上的
 * 监听就收不到该事件；而这个桩早先只是无脑把事件喂给每个监听，于是"按 Esc 关对话框"
 * 会连带把整个面板也关掉——断言于是从第二节开始全线错位，而组件本身完全正确。
 * 这里用真实的"冒泡链"语义：谁调了 stopPropagation，后面的监听就不再执行。
 */
function emitDocumentEvent(type, event) {
  let stopped = false
  const bubbleSafe = {
    ...event,
    get defaultPrevented() {
      return false
    },
    stopPropagation() {
      stopped = true
    },
  }
  for (const handler of domListeners.get(type) ?? []) {
    if (stopped) return
    handler(bubbleSafe)
  }
}
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
      loaded = factory(() => react)
    },
  },
}
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

// ---- 假 host ---------------------------------------------------------------------
//
// 三个分支覆盖界面上要区分的同步形状：
//   main            当前分支，落后上游 1     -> `↓1`
//   develop         非当前，落后上游 150     -> `↓99+`（截断过）
//   origin/develop  远程分支，无上游         -> 不显示同步标记
const BRANCHES = [
  {
    name: 'main',
    isRemote: false,
    current: true,
    remote: '',
    upstream: 'origin/main',
    upstreamGone: false,
    ahead: 0,
    behind: 1,
    diverged: false,
    committedAt: '2026-09-19T21:55:34+08:00',
    hash: 'a'.repeat(40),
    subject: 'release: 1.3.6',
  },
  {
    name: 'develop',
    isRemote: false,
    current: false,
    remote: '',
    upstream: 'origin/develop',
    upstreamGone: false,
    ahead: 0,
    behind: 150,
    diverged: false,
    committedAt: '2026-09-18T10:00:00+08:00',
    hash: 'b'.repeat(40),
    subject: 'feat: develop work',
  },
  {
    name: 'origin/develop',
    isRemote: true,
    current: false,
    remote: 'origin',
    upstream: '',
    upstreamGone: false,
    ahead: 0,
    behind: 0,
    diverged: false,
    committedAt: '2026-09-18T10:00:00+08:00',
    hash: 'b'.repeat(40),
    subject: 'feat: develop work',
  },
]
const STATUS = {
  isRepo: true,
  branch: 'main',
  detached: false,
  upstream: 'origin/main',
  ahead: 0,
  behind: 1,
  changedFiles: 0,
  untrackedFiles: 0,
  upstreamGone: false,
  merging: false,
  rebasing: false,
  head: 'a'.repeat(40),
}
const REMOTES = [{ name: 'origin', url: 'https://example.invalid/repo.git' }]
/**
 * 标签列表（`/tags` 是独立的只读路由）。
 *
 * 两个标签覆盖两种类型：`v1.6.0` 是附注标签（指向 HEAD，因此会标「当前版本」），
 * `v1.5.8` 是轻量标签。列表按 `-creatordate` 排（宿主侧的顺序）。
 */
let TAGS = [
  { name: 'v1.6.0', sha: 'a'.repeat(40), short: 'aaaaaaa', annotated: true, date: '2026-01-02T10:00:00+08:00', subject: 'Release 1.6.0', tagger: 'T', pointsAtHead: true },
  { name: 'v1.5.8', sha: 'b'.repeat(40), short: 'bbbbbbb', annotated: false, date: '2026-01-01T10:00:00+08:00', subject: 'release 1.5.8', tagger: '', pointsAtHead: false },
]

/** 每次 POST 的记录：`{ route, body }`。 */
const posts = []
/** 请求过的 URL。 */
const requests = []
/** 下一次写操作的错误响应覆盖；用完即清。 */
let nextWriteError = null
/** 持续生效的写操作错误响应。 */
let writeErrorAlways = null
/** 覆盖 status 响应的字段（用于造"合并进行中"这类状态）。 */
let statusOverride = {}

/** 写操作的统一响应体：新的 status + 新的分支列表 + remotes。 */
function writeOk() {
  return {
    ok: true,
    text: async () => JSON.stringify({ ...STATUS, ...statusOverride, branches: BRANCHES, remotes: REMOTES, ...writeExtra }),
  }
}
/** 下一次写操作响应里的附加字段（例如 `{ detached: true }`、`{ stash: {...} }`）。 */
let writeExtra = {}

globalThis.fetch = async (url, init) => {
  const target = String(url)
  requests.push(target)
  const route = target.slice(target.indexOf('/dsh-desktop/gitbar/') + '/dsh-desktop/gitbar/'.length).split('?')[0]

  if (init?.method === 'POST') {
    posts.push({ route, body: JSON.parse(init.body) })
    if (nextWriteError !== null) {
      const failure = nextWriteError
      nextWriteError = null
      return { ok: false, text: async () => JSON.stringify(failure) }
    }
    if (writeErrorAlways !== null) {
      return { ok: false, text: async () => JSON.stringify(writeErrorAlways) }
    }
    return writeOk()
  }
  if (route === 'status') {
    return { ok: true, text: async () => JSON.stringify({ ...STATUS, ...statusOverride }) }
  }
  if (route === 'tags') {
    return { ok: true, text: async () => JSON.stringify({ tags: TAGS, tagCount: TAGS.length, annotatedCount: TAGS.filter((entry) => entry.annotated).length }) }
  }
  if (route === 'branches') {
    return {
      ok: true,
      text: async () => JSON.stringify({ branches: BRANCHES, counts: { local: 2, remote: 1 }, remotes: REMOTES }),
    }
  }
  return { ok: false, text: async () => JSON.stringify({ error: 'not found', code: 'unknown' }) }
}

// ---- 加载插件 -------------------------------------------------------------------
let loaded
await import(PLUGIN)

// ---- 挂载插件，取出 conversation.input.dock 那个入口 ----------------------------
const entries = new Map()
const injectedFaces = new Map()
const ctx = {
  effect(fn) {
    fn()
  },
  // 文案层不在这里测：`t` 返回键名，因此断言直接对着字典键，比对着中文句子稳定
  // （中文句子会被反复润色，而键名是被代码引用的契约）。
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
}
loaded.apply(ctx)

const CHIP_KEY = 'conversation.input.dock:desktop-context-bar'
const ContextBar = entries.get(CHIP_KEY)

/**
 * 渲染这个槽位时渲染器会给的 props。
 *
 * `t` 来自槽自己的 `inject`（真实环境里是 `ctx.locale.bind(NS)`）；`sessionId` 与
 * `useSessions` 由渲染器按会话作用域自动注入——**不需要**写进 inject，会话作用域的槽
 * 都会收到它们。
 */
const mountProps = {
  t: injectedFaces.get(CHIP_KEY).t,
  sessionId: 's1',
  useSessions: makeSelectorHook(() => sessionSnapshot),
  renderSlot: () => null,
}

let failures = 0
/** 每次 mount 递增，用来给组件实例换 key。 */
let mountSeq = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `（期望 ${expected}）`}`)
}

/** 元素树里的纯文本。 */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node !== 'object') return ''
  return textOf(node.props?.children)
}

/** 渲染并跑完副作用，返回一个查询对象。 */
async function mount() {
  const props = mountProps
  /**
   * 本次挂载的组件实例 key。
   *
   * **每次 mount 必须换一个**：hook 槽按 key 存在模块级的 `componentHooks` 里，若两次
   * `mount()` 用同一个 key（早先固定写 `'bar'`），第二次拿到的是第一次留下的状态——
   * 实测现象是"重新挂载一份合并中的状态"后 `open` 还是上一份的 `true`，于是点徽章反而
   * 把面板关掉了，断言全红而组件完全正确。
   */
  const rootKey = `bar${mountSeq++}`
  /** 最近一次 settle 收集到的宿主节点。查询函数都读它，因此查询本身没有副作用。 */
  let settledNodes = []

  /**
   * 让状态落地：渲染整棵树、把每一层组件排队的副作用都跑掉、等一个 tick，再来一遍。
   *
   * 循环 4 遍而不是 2 遍：一次交互会连锁出多层（点开面板 → 触发加载 → 数据回来 →
   * 渲染列表），每一遍都要把上一遍的连锁反应跑完。
   */
  async function settle() {
    for (let pass = 0; pass < 4; pass += 1) {
      const queued = []
      const { tree, effects } = render(ContextBar, props, rootKey)
      queued.push(...effects)
      // 收集时顺便把各组件排队的副作用收进来（见 collectHostNodes 的 queued 参数）。
      const collected = collectHostNodes(tree, rootKey, queued)
      for (const effect of queued) effect()
      await new Promise((resolve) => setTimeout(resolve, 0))
      // **无条件覆盖**，不要"只在非空时更新"：收起面板那一遍本来就会收集到更少的
      // 节点，保留上一遍的旧节点会让断言读到一个已经不存在的界面。
      settledNodes = collected
    }
    return settledNodes
  }

  const nodes = () => settledNodes

  /**
   * 重新渲染一遍并返回**当前**的宿主节点。
   *
   * 只渲染、**绝不跑副作用**：跑副作用会把 hook 索引搅乱（`useEffect` 会占用一个槽位，
   * 而这次额外渲染之后 `renderIndex` 归零，紧随其后的 `settle()` 就会把状态写到错位的
   * 槽里）。实测后果是"面板明明开着，`findAll` 却返回空"，也就是点击静默失效。
   *
   * 需要状态落地（异步 effect 回来）时用 `settle()`；这里只做只读的界面读取。
   */
  const findNow = (attr, value) => {
    const current = collectHostNodes(render(ContextBar, props, rootKey).tree, rootKey)
    return current.find((node) => (value === undefined ? node.props?.[attr] !== undefined : node.props?.[attr] === value)) ?? null
  }

  /**
   * 按分支名找分支行。
   *
   * **不能用 `find('data-desktop-branch-option', name)`**：那个属性只是个空标记
   * （`=''`），分支名在 `data-desktop-branch-name` 上。早先写错之后的现象是"行明明
   * 列出了 5 行，按名字却一行都找不到"，点击于是静默失效——插件是对的，测试的选择器
   * 错了。列表里的行本来就需要一个按名字寻址的属性，用它才是稳定的。
   */
  const findRow = (branchName) =>
    collectHostNodes(render(ContextBar, props, rootKey).tree, rootKey).find(
      (node) => node.props?.['data-desktop-branch-name'] === branchName,
    ) ?? null

  /** 当前界面里的全部宿主节点。 */
  const allHostNodes = () => collectHostNodes(render(ContextBar, props, rootKey).tree, rootKey)

  /** 按 data 属性找宿主节点。 */
  const find = (attr, value) => findNow(attr, value)

  /** 按 data 属性找**全部**宿主节点（同样取当前界面）。 */
  const findAll = (attr) => allHostNodes().filter((node) => node.props?.[attr] !== undefined)

  /**
   * 在一个宿主节点的**子树**里找第一个匹配的子孙。
   *
   * `nodes()` 是全树的平铺列表，因此"在面板里找搜索框"这种查询不能直接在它上面
   * `find(type === 'search')`——那会命中任何一个 search 输入。这里按容器收窄。
   *
   * @param attr - 容器的 data 属性。
   * @param value - 容器的属性值（`undefined` 表示只按属性存在匹配）。
   * @param predicate - 对子树里的宿主节点做判定。
   * @returns 命中的宿主节点，或 null。
   */
  const within = (attr, value, predicate) => {
    const container = find(attr, value)
    if (container === null) return null
    return collectHostNodes(container, 'within').find(predicate) ?? null
  }

  /** 按文本找按钮（用于文案随状态变化的那个确定按钮）。 */
  const findByText = (text) =>
    allHostNodes().find((node) => node.props?.type === 'button' && textOf(node) === text) ?? null

  /** 徽章触发器：容器里的按钮（容器自己不带 onClick）。 */
  const badgeButton = () => findNow('data-desktop-branch-trigger')

  /** 点击：真的调用宿主节点的 onClick。 */
  const click = async (attr, value) => {
    const node = find(attr, value)
    if (node === null || typeof node.props?.onClick !== 'function') return false
    node.props.onClick({ stopPropagation() {}, preventDefault() {} })
    await settle()
    return true
  }

  /** 点某个分支行（按分支名，用 `data-desktop-branch-name`）。 */
  const clickRow = async (branchName) => {
    const node = findRow(branchName)
    if (node === null || typeof node.props?.onClick !== 'function') return false
    node.props.onClick({ stopPropagation() {}, preventDefault() {} })
    await settle()
    return true
  }

  /**
   * 双击某个分支行。
   *
   * IDEA 风格交互下**只有双击才切换分支**（单击是选中 + 打开操作菜单），因此凡是
   * "点一下就该 checkout"的断言都必须走这里。真实的双击在浏览器里会先派发两次 click
   * 再派发 dblclick；专门的交互测试（`scripts/test-gitbar-branch-interaction.mjs`）
   * 覆盖那条完整序列，这里只需要表达"用户双击了"。
   */
  const dblClickRow = async (branchName) => {
    const node = findRow(branchName)
    if (node === null || typeof node.props?.onDoubleClick !== 'function') return false
    node.props.onDoubleClick({ stopPropagation() {}, preventDefault() {} })
    await settle()
    return true
  }

  /** 点分支徽章。
   *
   * 用 `title`（永远是 `Git: <分支>…`）定位那个按钮，比按孩子序号取更难被布局改动打破。
   */
  const clickBadge = async () => {
    const button = badgeButton()
    if (button === null) return false
    button.props.onClick({ stopPropagation() {}, preventDefault() {} })
    await settle()
    return true
  }

  /** 确保面板处于打开状态。 */
  const openPanel = async () => {
    if (find('data-desktop-branch-menu') !== null) return true
    return clickBadge()
  }

  /** 触发受控输入：模拟 React 的 onChange。
   *
   * 传 `attr = 'data-desktop-branch-menu'` 时表示"面板里的那个输入框"，按容器收窄，
   * 避免命中对话框或别的 search 输入。
   */
  const type = async (attr, value, text) => {
    const node = attr === 'data-desktop-branch-menu'
      ? within(attr, value, (candidate) => typeof candidate.props?.onChange === 'function' && candidate.props?.type === 'search')
      : find(attr, value)
    if (node === null || typeof node.props?.onChange !== 'function') return false
    node.props.onChange({ target: { value: text } })
    await settle()
    return true
  }

  /** 勾选：模拟 checkbox 的 onChange。 */
  const toggle = async (attr, value, checked) => {
    const node = find(attr, value)
    if (node === null || typeof node.props?.onChange !== 'function') return false
    node.props.onChange({ target: { checked } })
    await settle()
    return true
  }

  /** 右键某个分支行。 */
  const contextMenu = async (branchName) => {
    const node = findRow(branchName)
    if (node === null || typeof node.props?.onContextMenu !== 'function') return false
    node.props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 300, clientY: 300 })
    await settle()
    return true
  }

  /** 派发一个文档级 Escape（面板级的关闭逻辑挂在 document 上）。 */
  const escape = async () => {
    emitDocumentEvent('keydown', { key: 'Escape', stopPropagation() {} })
    await settle()
    return true
  }

  /**
   * 关掉右键菜单，**但保留面板**。
   *
   * 真实浏览器里这两层是分开的：右键菜单渲染在容器内部，它的 `onKeyDown` 自己处理
   * Escape 并 `stopPropagation()`，因此挂在 document 上的"面板级 Esc"根本收不到这个
   * 事件。测试如果直接往 document 派发 Escape，就等于跳过了那层 stopPropagation，
   * 会把整个面板一起关掉——后面所有断言都会从"面板是开的"这个前提开始错位。
   * 所以这里走菜单自己的处理器。
   */
  const closeContextMenu = async () => {
    const menu = find('data-desktop-sc-menu')
    if (menu !== null && typeof menu.props?.onKeyDown === 'function') {
      menu.props.onKeyDown({ key: 'Escape', stopPropagation() {}, preventDefault() {} })
      await settle()
    }
    return true
  }

  /** 面板是否已打开（徽章上的 aria-expanded 是 open 状态的直接体现）。 */
  const panelOpen = () => badgeButton()?.props?.['aria-expanded'] === true

  await settle()
  return {
    nodes,
    find,
    findAll,
    findRow,
    allHostNodes,
    within,
    findByText,
    click,
    clickRow,
    dblClickRow,
    clickBadge,
    openPanel,
    panelOpen,
    type,
    toggle,
    contextMenu,
    closeContextMenu,
    escape,
    settle,
  }
}

// =================================================================================
console.log('=== 1. 徽章：第一次渲染就带上同步标记 ===')
let ui = await mount()
const badgeButton = ui.find('data-desktop-branch-trigger')
check('1) 徽章按钮已渲染', badgeButton !== undefined, 'true')
check('   徽章文案是当前分支', textOf(badgeButton).includes('main'), 'true')
check('   徽章带落后标记 ↓1', textOf(badgeButton).includes('\u21931'), 'true')
check('   title 带分支名', String(badgeButton?.props?.title).startsWith('Git: main'), 'true')
// `find` 对"不存在"返回 null，所以"关闭"是 `=== null`（值 true）。
check('   面板初始关闭', ui.find('data-desktop-branch-menu') === null, 'true')
check('   panelOpen 初始为 false', ui.panelOpen(), false)


console.log('')
console.log('=== 2. 打开面板：搜索、快捷操作、三段分组 ===')
await ui.clickBadge()
check('2) 点徽章后 open 变成 true', ui.panelOpen(), true)
check('   面板已打开', ui.panelOpen(), true)
for (const key of ['update', 'commit', 'push', 'new', 'tag']) {
  check(`   快捷操作 ${key}`, ui.find('data-desktop-sc-action', key) === null, 'false')
}
const sections = ui.findAll('data-desktop-sc-section').map((node) => node.props['data-desktop-sc-section'])
// 分组顺序：最近在前，其后本地、远程，最后是标签（标签在分支之后：它是"版本锚点"，
// 而用户打开这个面板多数时候是在找分支）。
check('   分组顺序（最近、本地、远程、标签）', sections.join(','), 'recent,local,remote,tags')
// 「最近」是本地分支的**副本**（2 个），加上「本地」2 个、「远程」1 个 = 5 行。
check('   分支行总数', ui.findAll('data-desktop-branch-option').length, 5)
// 「最近」是「本地」的副本，因此当前分支会**出现两次**（VS Code 也是这样）。这里要断言
// 的是"当前分支这一行有被标记"，所以按分支名去重，而不是数全树的标记个数。
const currentMarked = new Set(
  ui
    .findAll('data-desktop-branch-option')
    .filter((row) => collectHostNodes(row, 'probe').some((n) => n.props?.['data-desktop-branch-mark'] === 'current'))
    .map((row) => row.props['data-desktop-branch-name']),
)
check('   当前分支只有一个，且被标记', [...currentMarked].join(','), 'main')

console.log('')
console.log('=== 3. 同步标记：三种形状各自可辨 ===')
/** 每一行分支的同步标记类型。 */
const syncOf = (name) => {
  const row = ui.findAll('data-desktop-branch-option').find((n) => n.props['data-desktop-branch-name'] === name)
  if (row === undefined) return '(no-row)'
  const sync = collectHostNodes(row, 'probe').find((n) => n.props?.['data-desktop-branch-sync'] !== undefined)
  return sync?.props?.['data-desktop-branch-sync'] ?? '(none)'
}
check('   main 的标记是 behind', syncOf('main'), 'behind')
check('   develop 的标记是 behind', syncOf('develop'), 'behind')
check('   远程分支没有同步标记', syncOf('origin/develop'), '(none)')
const syncTexts = ui.findAll('data-desktop-branch-sync').map((n) => textOf(n))
check('   落后 150 显示成 99+', syncTexts.includes('\u219399+'), 'true')

console.log('')
console.log('=== 4. 上游名字只留分支名，不带远端前缀 ===')
// 按**分支行**收窄统计：`findAll` 是全树平铺，"最近"分组是本地分支的副本，因此同一个
// 上游会按行数重复出现——按行去重才是这里想断言的东西。
const upstreamByBranch = new Map(
  ui.findAll('data-desktop-branch-option').map((row) => {
    const nodes = collectHostNodes(row, 'probe')
    const upstream = nodes.find((n) => n.props?.['data-desktop-branch-upstream'] !== undefined)
    return [row.props['data-desktop-branch-name'], upstream === undefined ? '(none)' : textOf(upstream)]
  }),
)
check('4) 不出现 origin/ 前缀', [...upstreamByBranch.values()].every((text) => !text.includes('origin/')), 'true')
// 只有本地分支有上游；远程分支行的上游是空串，不显示。
const withUpstream = [...upstreamByBranch.entries()].filter(([, text]) => text !== '(none)').map(([name]) => name)
check('   只有本地分支显示上游', withUpstream.sort().join(','), 'develop,main')

console.log('')
console.log('=== 5. 搜索过滤：只筛分支，快捷操作不动 ===')
await ui.type('data-desktop-branch-menu', undefined, 'zzz')
const searchInput = ui.within('data-desktop-branch-menu', undefined, (n) => n.props?.type === 'search')
check('5) 搜索框是受控的', searchInput?.props?.value, 'zzz')
check('   分支行被过滤空', ui.findAll('data-desktop-branch-option').length, 0)
check('   快捷操作仍在', ui.find('data-desktop-sc-action', 'push') === null, 'false')
check('   空态说的是"没有匹配"', textOf(ui.find('data-desktop-branch-menu')).includes('noMatchingBranches'), 'true')
await ui.type('data-desktop-branch-menu', undefined, 'develop')
check('   搜 develop 命中本地与远程各一', ui.findAll('data-desktop-branch-option').length, 2)
// 有搜索词时不显示「最近」分组：过滤结果里再套一层"最近"只会让人以为匹配变少了。
// 按分区标题的文案判断（`data-desktop-sc-section` 同时打在容器和标题上，按属性值查会
// 命中容器自己，判不出分组有没有渲染）。
check('   过滤时收起「最近」分组', textOf(ui.find('data-desktop-branch-menu')).includes('sectionRecent'), 'false')
await ui.type('data-desktop-branch-menu', undefined, '')

console.log('')
console.log('=== 6. 右键菜单：按上下文禁用 ===')
check('6) 右键打开了菜单', await ui.contextMenu('develop'), 'true')
check('   菜单挂在被右键的分支上', ui.find('data-desktop-sc-menu', 'develop') !== null, 'true')
await ui.closeContextMenu()
check('   关掉右键菜单后，面板仍然打开', ui.panelOpen(), true)

/** 打开某个分支的右键菜单，返回 `菜单项 -> 是否禁用`。 */
const menuState = async (branchName) => {
  await ui.contextMenu(branchName)
  const state = new Map()
  // 从菜单的 children 直接读，不经过整树再展开：右键菜单的每个条目都是宿主节点，
  // 而 `data-desktop-sc-menuitem` 就打在它们身上。
  for (const child of ui.find('data-desktop-sc-menu', branchName)?.props?.children ?? []) {
    const key = child?.props?.['data-desktop-sc-menuitem']
    if (key !== undefined) state.set(key, child.props.disabled === true)
  }
  await ui.closeContextMenu()
  return state
}
const mainMenu = await menuState('main')
// 当前分支：不能签出自己、不能合并/变基到自己、不能删除自己。
//
// 注意「签出」是**存在但禁用**而不是消失：单击任何一行都会打开这个菜单（IDEA 风格），
// 条目随分支增减会让同一个位置上的动作上下移动，用户靠位置记忆点操作时就会点错。
check('   main（当前分支）：签出项存在但被禁用', mainMenu.get('checkout'), true)
check('   main：合并到自己被禁用', mainMenu.get('merge'), true)
check('   main：变基到自己被禁用', mainMenu.get('rebase'), true)
check('   main：删除自己被禁用', mainMenu.get('delete'), true)

const devMenu = await menuState('develop')
check('   develop：可以签出', devMenu.get('checkout'), false)
check('   develop：可以合并到当前分支', devMenu.get('merge'), false)
check('   develop：可以重命名', devMenu.get('rename'), false)
check('   develop：可以删除', devMenu.get('delete'), false)

const remoteMenu = await menuState('origin/develop')
check('   远程分支：可以签出', remoteMenu.get('checkout'), false)
// 远程分支不能重命名：本地改名只会换掉跟踪引用的名字，远端那个分支纹丝不动。
check('   远程分支：重命名被禁用', remoteMenu.get('rename'), true)
check('   远程分支：可以删除（删远端）', remoteMenu.get('delete'), false)

console.log('')
console.log('=== 7. 点击外部关闭面板 ===')
check('7) 面板当前是打开的', ui.panelOpen(), true)
emitDocumentEvent('mousedown', { target: null })
await ui.settle()
check('   点外部后收起面板', ui.panelOpen(), false)
await ui.openPanel()
check('   可以重新打开', ui.panelOpen(), true)
await ui.escape()
check('   Esc 收起面板', ui.panelOpen(), false)
await ui.openPanel()

console.log('')
console.log('=== 8. 切换分支：请求体与成功后的关闭 ===')
await ui.openPanel()
check('8) 前置：面板打开且列出了分支', `${ui.panelOpen()}/${ui.findAll('data-desktop-branch-option').length}`, 'true/5')
posts.length = 0
await ui.clickRow('develop')
// 单击**不是** checkout：IDEA 风格下它只选中并打开操作菜单。
check('8) 单击不产生 checkout', posts.length, 0)
await ui.dblClickRow('develop')
check('   双击发出 checkout', posts.map((p) => p.route).join(','), 'checkout')
check('   请求体是分支名', JSON.stringify(posts[0]?.body), '{"branch":"develop"}')
check('   成功后关闭面板', ui.panelOpen(), false)

console.log('')
console.log('=== 9. 有未提交改动被拒：短句 + 暂存入口 + git 原文 ===')
nextWriteError = {
  error: 'checkout failed',
  code: 'localChanges',
  detail: 'error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt',
}
await ui.openPanel()
await ui.dblClickRow('develop')
// 失败时面板必须保持打开，否则用户看不到原因。
check('9) 失败后面板仍打开', ui.panelOpen(), true)
check('   错误区带 code 标记', ui.find('data-desktop-sc-error', 'localChanges') === null, 'false')
const errorText = textOf(ui.find('data-desktop-sc-error'))
check('   显示本地化短句（字典键）', errorText.includes('error_localChanges'), 'true')
check('   原样显示 git 英文原文', errorText.includes('would be overwritten by checkout'), 'true')
const stashButton = ui.findByText('stashAndSwitch')
check('   给出「暂存并切换」入口', stashButton === null, 'false')
posts.length = 0
stashButton.props.onClick({ stopPropagation() {}, preventDefault() {} })
await ui.settle()
check('   点它是 stash + checkout', posts[0]?.body?.stash === true && posts[0]?.body?.branch === 'develop', 'true')
// 储藏消息由**客户端**给（宿主不知道界面语言，而这条消息会出现在储藏列表里给用户看）；
// 未跟踪文件一并储藏 —— 它们同样会让 checkout 失败（目标分支里有同名文件）。
check('   带上本地化的储藏消息', posts[0]?.body?.message === 'stashBeforeCheckoutMessage', 'true')
check('   包含未跟踪文件（否则可能再被拒一次）', posts[0]?.body?.includeUntracked, true)

console.log('')
console.log('=== 10. 新建分支对话框：请求体与校验 ===')
posts.length = 0
await ui.openPanel()
await ui.click('data-desktop-sc-action', 'new')
check('10) 对话框已打开', ui.find('data-desktop-sc-dialog', 'create') === null, 'false')
// 名字为空时确定按钮必须禁用——否则会发一个必然 400 的请求。
check('   空名字时确定被禁用', ui.find('data-desktop-sc-button', 'confirm')?.props?.disabled, true)
await ui.type('data-desktop-sc-field', 'name', 'feature/new')
check('   填了名字后确定可用', ui.find('data-desktop-sc-button', 'confirm')?.props?.disabled, false)
await ui.type('data-desktop-sc-field', 'from', 'develop')
// 默认勾选"创建后切换"，这里取消以验证请求体如实反映勾选状态。
await ui.toggle('data-desktop-sc-check', 'checkout', false)
posts.length = 0
await ui.click('data-desktop-sc-button', 'confirm')
check('   发出 branch/create', posts.map((p) => p.route).join(','), 'branch/create')
check('   请求体完整', JSON.stringify(posts[0]?.body), '{"name":"feature/new","from":"develop","checkout":false}')
check('   成功后对话框关闭', ui.find('data-desktop-sc-dialog') === null, 'true')
{
  console.log(`  [debug] 删除前 open=${ui.panelOpen()} 对话框=${ui.find('data-desktop-sc-dialog', 'delete') === null ? 'null' : 'ok'} 强删按钮=${ui.find('data-desktop-sc-force') === null ? 'null' : 'ok'}`)
}

console.log('')
console.log('=== 11. 删除分支：未并入要二次确认，才带 force ===')
posts.length = 0
await ui.openPanel()
await ui.contextMenu('develop')
await ui.click('data-desktop-sc-menuitem', 'delete')
check('11) 删除确认框已打开', ui.find('data-desktop-sc-dialog', 'delete') !== null, 'true')
check('   有二次确认入口', ui.find('data-desktop-sc-force') !== null, 'true')
check('   第一次确定按钮文案是「删除」', textOf(ui.find('data-desktop-sc-button', 'confirm')), 'confirmDeleteButton')

// 第一次删除：host 用 `--is-ancestor` 判定未并入，回 409 notMerged。
// **必须先让这次请求失败**，否则对话框会（正确地）直接关掉——"点一次就删掉了分支"
// 正是这条二次确认要防的事，测试不能把危险路径当成正常路径来测。
nextWriteError = { error: 'not fully merged', code: 'notMerged', detail: "error: the branch 'develop' is not fully merged" }
posts.length = 0
await ui.click('data-desktop-sc-button', 'confirm')
check('   第一次**不带** force', JSON.stringify(posts[0]?.body), '{"name":"develop"}')
check('   被拒后对话框仍然打开', ui.find('data-desktop-sc-dialog', 'delete') !== null, 'true')
check('   提示里说明未合并', textOf(ui.find('data-desktop-sc-error')).includes('error_notMerged'), 'true')

// 点「仍然删除」之后，确定按钮文案要变，并且请求带 force。
await ui.click('data-desktop-sc-force')
check('   确认后按钮文案变成「仍然删除」', textOf(ui.find('data-desktop-sc-button', 'confirm')), 'confirmForceDeleteButton')
posts.length = 0
await ui.click('data-desktop-sc-button', 'confirm')
check('   第二次带 force', JSON.stringify(posts[0]?.body), '{"name":"develop","force":true}')
check('   成功后对话框关闭', ui.find('data-desktop-sc-dialog') === null, 'true')

console.log('')
console.log('=== 12. 删除远端分支：请求带 remote，并提示影响其它人 ===')
posts.length = 0
await ui.openPanel()
await ui.contextMenu('origin/develop')
await ui.click('data-desktop-sc-menuitem', 'delete')
check('12) 提示会影响其它人', textOf(ui.find('data-desktop-sc-dialog', 'delete')).includes('confirmDeleteRemote'), 'true')
posts.length = 0
await ui.click('data-desktop-sc-button', 'confirm')
check('   请求带 remote: true', JSON.stringify(posts[0]?.body), '{"name":"origin/develop","remote":true}')

console.log('')
console.log('=== 13. 合并与变基：对话框与请求体 ===')
posts.length = 0
await ui.openPanel()
await ui.contextMenu('develop')
await ui.click('data-desktop-sc-menuitem', 'merge')
check('13) 合并对话框已打开', ui.find('data-desktop-sc-dialog', 'merge') === null, 'false')
await ui.toggle('data-desktop-sc-check', 'no-ff', true)
posts.length = 0
await ui.click('data-desktop-sc-button', 'confirm')
check('   发出 branch/merge', posts.map((p) => p.route).join(','), 'branch/merge')
check('   请求体带 noFf', JSON.stringify(posts[0]?.body), '{"name":"develop","noFf":true}')

posts.length = 0
await ui.openPanel()
await ui.contextMenu('develop')
await ui.click('data-desktop-sc-menuitem', 'rebase')
posts.length = 0
await ui.click('data-desktop-sc-button', 'confirm')
check('   发出 branch/rebase', posts.map((p) => p.route).join(','), 'branch/rebase')
check('   请求体是 onto', JSON.stringify(posts[0]?.body), '{"onto":"develop"}')

console.log('')
console.log('=== 14. 重命名：预填原名，未改动则不请求 ===')
posts.length = 0
await ui.openPanel()
await ui.contextMenu('develop')
await ui.click('data-desktop-sc-menuitem', 'rename')
check('14) 名字预填为原名', ui.find('data-desktop-sc-field', 'name')?.props?.value, 'develop')
posts.length = 0
await ui.click('data-desktop-sc-button', 'confirm')
check('   没改名字时不发请求', posts.length, 0)
check('   而是直接关掉对话框', ui.find('data-desktop-sc-dialog') === null, 'true')

await ui.openPanel()
await ui.contextMenu('develop')
await ui.click('data-desktop-sc-menuitem', 'rename')
await ui.type('data-desktop-sc-field', 'name', 'develop-v2')
posts.length = 0
await ui.click('data-desktop-sc-button', 'confirm')
check('   改了就发 rename', JSON.stringify(posts[0]?.body), '{"from":"develop","to":"develop-v2"}')

console.log('')
console.log('=== 15. 推送：直接执行，不再弹二次确认 ===')
posts.length = 0
await ui.openPanel()
await ui.contextMenu('develop')
await ui.click('data-desktop-sc-menuitem', 'push')
// 点击即执行：不再有「推送」对话框，也不再需要再点一次确定。
check('15) 菜单项点击后没有跳出推送对话框', ui.find('data-desktop-sc-dialog', 'push') === null, 'true')
check('   发出 remote 路由', posts.map((p) => p.route).join(','), 'remote')
const pushBody = posts[0]?.body
check('   action 是 push', pushBody?.action, 'push')
check('   带分支名', pushBody?.branch, 'develop')
// develop 有上游（origin/develop），因此不该顺手改跟踪配置。
check('   有上游时不带 setUpstream', pushBody?.setUpstream, undefined)

console.log('')
console.log('=== 16. 「签出标记或修订」===')
posts.length = 0
await ui.openPanel()
await ui.click('data-desktop-sc-action', 'tag')
check('16) 对话框已打开', ui.find('data-desktop-sc-dialog', 'checkout-ref') === null, 'false')
check('   空值时确定被禁用', ui.find('data-desktop-sc-button', 'confirm')?.props?.disabled, true)
await ui.type('data-desktop-sc-field', 'ref', 'v1.0.0')
posts.length = 0
await ui.click('data-desktop-sc-button', 'confirm')
check('   走的是 checkout 路由', posts.map((p) => p.route).join(','), 'checkout')
check('   请求体是引用的名字', JSON.stringify(posts[0]?.body), '{"branch":"v1.0.0"}')

console.log('')
console.log('=== 17. 进行中的合并：必须露出中止入口 ===')
statusOverride = { merging: true }
ui = await mount()
await ui.clickBadge()
check('17) 显示合并进行中', ui.find('data-desktop-sc-progress', 'merge') === null, 'false')
check('   文案指向 mergeInProgress', textOf(ui.find('data-desktop-sc-progress')).includes('mergeInProgress'), 'true')
posts.length = 0
const abortButton = collectHostNodes(ui.find('data-desktop-sc-progress'), 'probe').find(
  (node) => node.props?.type === 'button',
)
abortButton.props.onClick({ stopPropagation() {}, preventDefault() {} })
await ui.settle()
check('   中止走 op/abort', posts[0]?.route, 'op/abort')
check('   请求体是 kind=merge', JSON.stringify(posts[0]?.body), '{"kind":"merge"}')
statusOverride = {}

console.log('')
console.log('=== 18. 未知 code 不吞掉原始错误 ===')
writeErrorAlways = { error: 'weird', code: 'somethingNew', detail: 'raw git words' }
ui = await mount()
await ui.clickBadge()
await ui.dblClickRow('develop')
check('18) 落到通用短句', textOf(ui.find('data-desktop-sc-error')).includes('error_unknown'), 'true')
check('   仍然显示 git 原文', textOf(ui.find('data-desktop-sc-error')).includes('raw git words'), 'true')
// 未知 code 不能在界面上留下一个"看起来已知"的分类。
check('   错误区的 code 标记回退成 unknown', ui.find('data-desktop-sc-error', 'unknown') === null, 'false')

console.log('')
console.log('=== 19. 储藏：直接储藏 / 带选项储藏 ===')
writeErrorAlways = null
statusOverride = {}
ui = await mount()
await ui.clickBadge()
check('19) 快捷操作里有「储藏」与「带选项储藏」两条', ui.find('data-desktop-sc-action', 'stash') === null, 'false')
check('   带选项那条也在', ui.find('data-desktop-sc-action', 'stash-options') === null, 'false')
posts.length = 0
await ui.click('data-desktop-sc-action', 'stash')
check('   直接储藏：一步发 stash/push', posts.map((p) => p.route).join(','), 'stash/push')
// 不带消息 = 让 git 写它自己的 WIP 主题；也不动未跟踪文件（那是要用户明说的）。
check('   不带消息', posts[0]?.body?.message, undefined)
check('   默认不含未跟踪', posts[0]?.body?.includeUntracked, undefined)

posts.length = 0
await ui.click('data-desktop-sc-action', 'stash-options')
check('   带选项储藏打开对话框', ui.find('data-desktop-sc-dialog', 'stash') === null, 'false')
check('   未跟踪默认不勾选', ui.find('data-desktop-sc-check', 'stash-untracked')?.props?.checked, false)
await ui.type('data-desktop-sc-field', 'stash-message', 'WIP: feature login')
await ui.toggle('data-desktop-sc-check', 'stash-untracked', true)
posts.length = 0
await ui.click('data-desktop-sc-button', 'confirm')
check('   确认后发 stash/push', posts.map((p) => p.route).join(','), 'stash/push')
check('   带上消息', posts[0]?.body?.message, 'WIP: feature login')
check('   带上包含未跟踪', posts[0]?.body?.includeUntracked, true)

console.log('')
console.log('=== 20. 储藏冲突：没有「继续 / 中止」这两个动作 ===')
// `git stash apply` 冲突时 git 不写 MERGE_HEAD，因此宿主报的是 `stash`（无标记冲突）。
statusOverride = {
  operation: { type: 'stash', currentLabel: 'Updated upstream', incomingLabel: 'Stashed changes', labelsSwapped: false, markerless: true },
  conflictCount: 1,
  merging: false,
  rebasing: false,
}
ui = await mount()
await ui.clickBadge()
check('20) 进度卡片标成 stash', ui.find('data-desktop-sc-progress', 'stash') === null, 'false')
check('   文案说明"逐块解决即可，储藏不会被自动删除"', textOf(ui.find('data-desktop-sc-progress')).includes('opStashInProgress'), 'true')
check('   不给「继续」（git 没有这个动作）', ui.find('data-desktop-sc-continue') === null, 'true')
const progressButtons = collectHostNodes(ui.find('data-desktop-sc-progress'), 'probe').filter((node) => node.props?.type === 'button')
check('   也不给「中止」', progressButtons.length, 0)
statusOverride = {}

console.log('')
console.log('=== 21. 储藏并切换：切换失败时改动没丢，给恢复入口 ===')
nextWriteError = {
  error: 'branch not found',
  code: 'noSuchRef',
  detail: 'fatal: invalid reference: nope',
  // 宿主把"那次储藏已经建好了"放在错误响应里——这是**不可丢**的信息。
  stash: { stashed: true, ref: 'stash@{0}', message: 'auto', branch: 'main', hasUntracked: true },
}
ui = await mount()
await ui.clickBadge()
await ui.dblClickRow('develop')
check('21) 失败仍然报错（面板保持打开）', textOf(ui.find('data-desktop-sc-error')).includes('error_noSuchRef'), 'true')
check('   同时明确告知"改动已存入储藏"', textOf(ui.find('data-desktop-sc-notice')).includes('stashCreatedBeforeFailure'), 'true')
check('   并给出「恢复储藏的改动」入口', ui.find('data-desktop-sc-restore', 'stash@{0}') === null, 'false')
posts.length = 0
await ui.click('data-desktop-sc-restore', 'stash@{0}')
check('   点恢复走 stash/pop', posts.map((p) => p.route).join(','), 'stash/pop')
check('   带的是那条储藏的引用', posts[0]?.body?.ref, 'stash@{0}')
nextWriteError = null

console.log('')
console.log('=== 22. 标签：列表 / 搜索 / 菜单 / 新建 / 删除 / 推送 / 比较 ===')
writeErrorAlways = null
statusOverride = {}
TAGS = [
  { name: 'v1.6.0', sha: 'a'.repeat(40), short: 'aaaaaaa', annotated: true, date: '2026-01-02T10:00:00+08:00', subject: 'Release 1.6.0', tagger: 'T', pointsAtHead: true },
  { name: 'v1.5.8', sha: 'b'.repeat(40), short: 'bbbbbbb', annotated: false, date: '2026-01-01T10:00:00+08:00', subject: 'release 1.5.8', tagger: '', pointsAtHead: false },
]
ui = await mount()
await ui.openPanel()
{
  const rows = ui.findAll('data-desktop-tag-name')
  check('22) 标签分组列出了全部标签', rows.map((node) => node.props['data-desktop-tag-name']).join(','), 'v1.6.0,v1.5.8')
  check('   附注标记标成 annotated', ui.find('data-desktop-tag-name', 'v1.6.0')?.props?.['data-desktop-tag-annotated'], 'true')
  check('   轻量标记标成 lightweight', ui.find('data-desktop-tag-name', 'v1.5.8')?.props?.['data-desktop-tag-annotated'], 'false')
  check('   指向 HEAD 的标出「当前版本」', ui.find('data-desktop-tag-name', 'v1.6.0')?.props?.['data-desktop-tag-head'], 'true')
  const tagText = textOf(ui.find('data-desktop-tag-name', 'v1.6.0'))
  check('   行里区分附注 / 轻量（不会误以为是分支）', tagText.includes('tagAnnotated'), 'true')
  check('   分组标题是标签', ui.find('data-desktop-sc-section', 'tags') === null, 'false')
}
// 搜索框同时过滤标签：找一个不存在的名字 → 标签区显示空态。
await ui.type('data-desktop-branch-menu', undefined, 'v1.5')
check('   搜索也过滤标签（只剩匹配的那一个）', ui.findAll('data-desktop-tag-name').map((n) => n.props['data-desktop-tag-name']).join(','), 'v1.5.8')
await ui.type('data-desktop-branch-menu', undefined, 'zzz')
check('   全不匹配时给出空态', ui.find('data-desktop-tags-empty') === null, 'false')
await ui.type('data-desktop-branch-menu', undefined, '')

// 单击一行标签 → 标签菜单（条目与分支菜单不同）。
posts.length = 0
{
  const row = ui.find('data-desktop-tag-name', 'v1.5.8')
  row.props.onClick({ stopPropagation() {}, preventDefault() {}, currentTarget: null })
  await ui.settle()
  check('   单击标签弹出标签菜单', ui.find('data-desktop-sc-tagmenu', 'v1.5.8') === null, 'false')
  const items = ui.findAll('data-desktop-sc-tagitem').map((node) => node.props['data-desktop-sc-tagitem'])
  check('   菜单条目（签出 / 建分支 / 比较 / 推送 / 复制 / 删除）', items.join(','), 'checkout,create-branch,compare,push,copy,delete')
}

// 「推送标记」→ 单推这一条（绝不 --tags）。
posts.length = 0
await ui.click('data-desktop-sc-tagitem', 'push')
check('   推标签走 tag/push', posts.map((p) => p.route).join(','), 'tag/push')
check('   只带这一个标签名', posts[0]?.body?.name, 'v1.5.8')
check('   没有 --tags 之类的批量参数', posts[0]?.body?.all, undefined)

// 「删除本地标记」→ 确认框（并说明不动远端）。
await ui.openPanel()
{
  const row = ui.find('data-desktop-tag-name', 'v1.5.8')
  row.props.onClick({ stopPropagation() {}, preventDefault() {}, currentTarget: null })
  await ui.settle()
}
await ui.click('data-desktop-sc-tagitem', 'delete')
check('   删除弹确认框', ui.find('data-desktop-sc-dialog', 'delete-tag') === null, 'false')
check('   正文说明只删本地', textOf(ui.find('data-desktop-sc-dialog', 'delete-tag')).includes('confirmDeleteTagRemote'), 'true')
posts.length = 0
await ui.click('data-desktop-sc-button', 'confirm')
check('   确认后发 tag/delete', posts.map((p) => p.route).join(','), 'tag/delete')
check('   带标签名', posts[0]?.body?.name, 'v1.5.8')

// 「从这里新建分支」→ 复用既有的建分支对话框，起点是标签名。
await ui.openPanel()
{
  const row = ui.find('data-desktop-tag-name', 'v1.6.0')
  row.props.onClick({ stopPropagation() {}, preventDefault() {}, currentTarget: null })
  await ui.settle()
}
await ui.click('data-desktop-sc-tagitem', 'create-branch')
check('   建分支对话框已打开', ui.find('data-desktop-sc-dialog', 'create') === null, 'false')
check('   起点预填标签名', ui.find('data-desktop-sc-field', 'from')?.props?.value, 'v1.6.0')

// 「与当前比较」→ 交给 review 的跨插件比较入口（并说明它请求了哪两端）。
{
  const calls = []
  const previous = globalThis.window.__dshDesktopReviewCompare
  globalThis.window.__dshDesktopReviewCompare = { open: (request) => calls.push(request) }
  await ui.openPanel()
  const row = ui.find('data-desktop-tag-name', 'v1.5.8')
  row.props.onClick({ stopPropagation() {}, preventDefault() {}, currentTarget: null })
  await ui.settle()
  await ui.click('data-desktop-sc-tagitem', 'compare')
  check('   比较请求发给了 review 桥', calls.length, 1)
  check('   一端是标签、另一端是 HEAD', `${calls[0]?.a}↔${calls[0]?.b}`, 'v1.5.8↔HEAD')
  check('   带上工作区（面板才能认出是哪个项目）', typeof calls[0]?.workspace === 'string' && calls[0].workspace !== '', 'true')
  globalThis.window.__dshDesktopReviewCompare = previous
}

// 快速操作里的「新建标记…」→ 对话框（附注默认跟随仓库现状：这里已有附注标签 → 默认开）。
posts.length = 0
await ui.openPanel()
await ui.click('data-desktop-sc-action', 'create-tag')
check('   新建标记对话框已打开', ui.find('data-desktop-sc-dialog', 'create-tag') === null, 'false')
check('   仓库有附注标签 → 默认附注', ui.find('data-desktop-sc-check', 'tag-annotated')?.props?.checked, true)
await ui.type('data-desktop-sc-field', 'tag-name', 'v1.7.0')
await ui.type('data-desktop-sc-field', 'tag-message', 'Release 1.7.0')
posts.length = 0
await ui.click('data-desktop-sc-button', 'confirm')
check('   创建走 tag/create', posts.map((p) => p.route).join(','), 'tag/create')
check('   带名字与信息（附注）', JSON.stringify(posts[0]?.body), '{"name":"v1.7.0","message":"Release 1.7.0"}')

// 只有轻量标签的仓库 → 默认轻量（信息为空 = 轻量，不会去开编辑器）。
TAGS = [{ name: 'v0.1.0', sha: 'c'.repeat(40), short: 'ccccccc', annotated: false, date: '2025-01-01T10:00:00+08:00', subject: 'first', tagger: '', pointsAtHead: false }]
ui = await mount()
await ui.openPanel()
await ui.click('data-desktop-sc-action', 'create-tag')
check('   仓库只有轻量标签 → 默认轻量', ui.find('data-desktop-sc-check', 'tag-annotated')?.props?.checked, false)
check('   轻量时给出类型说明', textOf(ui.find('data-desktop-sc-dialog', 'create-tag')).includes('dialogTagTypeHint'), 'true')

// 签出标签 → 游离 HEAD 提示 + 「从这里新建分支」。
posts.length = 0
writeExtra = { detached: true }
await ui.openPanel()
{
  const row = ui.find('data-desktop-tag-name', 'v0.1.0')
  row.props.onDoubleClick({ stopPropagation() {}, preventDefault() {} })
  await ui.settle()
}
check('   双击标签走 checkout', posts.map((p) => p.route).join(','), 'checkout')
check('   请求体是标签名', posts[0]?.body?.branch, 'v0.1.0')
// 面板在成功后会收起，重新打开看提示区（`detachedFrom` 住在组件状态里）。
await ui.openPanel()
check('   游离 HEAD 时给出提示', textOf(ui.find('data-desktop-sc-notice')).includes('detachedNotice'), 'true')
check('   并给出「从这里新建分支」', ui.find('data-desktop-sc-branch-from-tag', 'v0.1.0') === null, 'false')
posts.length = 0
await ui.click('data-desktop-sc-branch-from-tag', 'v0.1.0')
check('   点它打开建分支对话框，起点是那个标签', ui.find('data-desktop-sc-field', 'from')?.props?.value, 'v0.1.0')
writeExtra = {}

console.log('')
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
