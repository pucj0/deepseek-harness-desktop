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
globalThis.fetch = async (url, init) => {
  fetches.push({ url: String(url), body: init?.body })
  if (String(url).includes('/roots')) {
    return {
      ok: true,
      text: async () =>
        JSON.stringify({
          roots: ['C:\\Users\\Administrator', 'F:\\code\\projA', 'F:\\code\\projB', 'F:\\code\\projC'],
          // 外壳的工作区：不是仓库，正是当初被误当成"当前工作区"的那个。
          current: 'C:\\Users\\Administrator',
        }),
    }
  }
  return { ok: true, text: async () => JSON.stringify({ isRepo: true, files: [] }) }
}

globalThis.document = {
  head: { appendChild() {} },
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  createElement: () => ({ dataset: {}, style: {}, textContent: '', remove() {} }),
}
const storage = { 'dsh.review.panelOpen': '1' }
globalThis.window = {
  innerWidth: 1400,
  innerHeight: 900,
  localStorage: { getItem: (k) => storage[k] ?? null, setItem: (k, v) => { storage[k] = v } },
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
const props = { ...kit, ...injected, t: (key) => key }

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

console.log('')
console.log(failures === 0 ? '项目级入口钩子全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
