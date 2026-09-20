// 验证「项目改动」抽屉的**结构与样式契约**：头栏、提交卡片、分组头、行内动作的收敛规则，
// 以及样式块本身确实注入了、括号是闭合的。
//
//   node scripts/test-review-drawer-style.mjs
//
// 为什么要单独一个文件、而不是塞进 test-review-overlay-hooks.mjs：
//
//   那个测试的桩渲染器把组件的 hook 槽**按树中位置**归属（`root.2.0:StagingSection`），
//   而它前七节已经把若干行的展开状态写进了那些槽里。于是"换一个挂载 key 重新挂载"并不
//   等于新挂载——嵌套组件根本不参与 key，状态与 effect 的依赖记录都还在原处，最终表现
//   是暂存区永远停在 loading（实测踩到：新加的断言全红，而产品代码是对的）。
//
//   这些外观断言需要的是**一次真正干净的渲染**，所以让它们跑在自己的进程里。
//
// 外观（颜色、间距）本身没法在桩里断言，能断言的是**结构与样式钩子**：类名、`data-*`
// 标记、样式块里的选择器。这些是"悬停才浮出动作按钮""提交卡片""分支徽标"能生效的
// 全部前提，被顺手改掉时不会有任何其它测试变红。
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
  const tree = Comp(props)
  componentHooks.set(key, hookSlots)
  const effects = effectQueue
  hookSlots = saved.hookSlots
  renderIndex = saved.renderIndex
  effectQueue = saved.effectQueue
  return { tree, effects }
}

/** 收集宿主节点、展开函数组件，并把嵌套组件产生的副作用收进 `queued`。 */
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
      const childKey = `${key}:${current.type.name === '' ? 'anonymous' : current.type.name}`
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

/** 元素文本（递归展开 children）。 */
const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node !== 'object') return ''
  return textOf(node.props?.children)
}

// ---- 假 DOM ----------------------------------------------------------------------
/** 插件注入的样式块。外观规则有没有真的被送到页面上，是这里唯一能验证的部分。 */
const styledBlocks = []
const domListeners = new Map()
globalThis.document = {
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
  emit(type, event) {
    for (const handler of domListeners.get(type) ?? []) handler(event)
  },
  querySelector: () => null,
  createElement: (tagName) => ({ tagName, dataset: {}, style: {}, textContent: '', remove() {} }),
}
/**
 * 持久化存储。
 *
 * `dsh.review.panelOpen` 必须是打开的：抽屉的开关状态存在这里，返回 `null` 时面板
 * 直接 `return null`，那样下面所有关于结构与样式的断言都会变成"元素不存在"——
 * 而原因跟外观毫无关系（实测第一次跑就是如此）。
 */
const panelStorage = { 'dsh.review.panelOpen': '1' }
globalThis.window = {
  innerWidth: 1400,
  innerHeight: 900,
  localStorage: {
    getItem: (key) => panelStorage[key] ?? null,
    setItem: (key, value) => {
      panelStorage[key] = String(value)
    },
    removeItem: (key) => {
      delete panelStorage[key]
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
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#ffffff' })
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

// ---- 假 host ---------------------------------------------------------------------
/** `/status`：一份"两组都有内容、有已暂存行"的最小负载。 */
const STATUS = {
  isRepo: true,
  branch: 'main',
  tracked: [
    { path: 'src/app.ts', index: 'M', worktree: ' ', staged: true, unstaged: false },
    { path: 'docs/readme.md', index: ' ', worktree: 'M', staged: false, unstaged: true },
  ],
  trackedCount: 2,
  untrackedCount: 1,
  untrackedPaths: ['src/new.ts'],
  untrackedTruncated: false,
}
/** `/workspace`：`FileList` 的数据源。 */
const WORKSPACE = {
  isRepo: true,
  scope: 'workspace',
  files: [
    { path: 'src/app.ts', status: 'M', added: 3, removed: 1, staged: true, unstaged: false, untracked: false },
    { path: 'docs/readme.md', status: 'M', added: 5, removed: 2, staged: false, unstaged: true, untracked: false },
  ],
  diff: '',
  truncated: false,
}
const HISTORY = {
  isRepo: true,
  branch: 'main',
  commits: [{ hash: 'a'.repeat(40), short: 'aaaaaaa', author: 'tester', date: '2026-01-02', subject: 'second commit' }],
}

globalThis.fetch = async (url) => {
  const target = String(url)
  const payload = target.includes('/workspace')
    ? WORKSPACE
    : target.includes('/history')
      ? HISTORY
      : target.includes('/roots')
        ? { roots: ['F:\\code\\projA'], current: 'F:\\code\\projA' }
        : STATUS
  return { ok: true, text: async () => JSON.stringify(payload) }
}

// ---- 加载插件 --------------------------------------------------------------------
let loaded
await import(PLUGIN)

const ctx = {
  effect(fn) {
    fn()
  },
  locale: { register() {}, bind: () => (key) => key },
  slots: {
    inject(_name, callback) {
      callback()
    },
    register() {
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
const is = (label, actual, expected) => {
  const ok = Object.is(actual, expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}${ok ? '' : `（期望 ${JSON.stringify(expected)}）`}`)
}
const has = (label, actual) => is(label, actual === true, true)
const rowsOf = (nodes, attr) => nodes.filter((n) => n.props?.[attr] !== undefined)

// ---- 渲染 ------------------------------------------------------------------------
const Panel = loaded.__reviewPanelForTest
check('导出了抽屉本体', typeof Panel, 'function')

const panelProps = { t: (key) => key, workspace: 'F:\\code\\projA', sessionId: 's1', scope: 'workspace' }
let tree = render(Panel, panelProps, 'style').tree
for (let pass = 0; pass < 8; pass += 1) {
  const queued = []
  collectHostNodes(tree, queued)
  if (queued.length === 0) break
  for (const effect of queued) effect()
  await new Promise((resolve) => setTimeout(resolve, 0))
  tree = render(Panel, panelProps, 'style').tree
}
const nodes = collectHostNodes(tree)

console.log('')
console.log('=== 1. 头栏：标题 + 分支 + 计数 + 图标动作 ===')
{
  has('有头栏', rowsOf(nodes, 'data-review-header').length === 1)
  const title = rowsOf(nodes, 'data-review-title')[0]
  has('头栏里有标题容器', title !== undefined)
  has('标题容器里有标题文案', textOf(title ?? null).includes('projectTitle'))
  // 分支徽标：整个抽屉里"我在哪个分支上提交"是第一个要回答的问题。
  //
  // 这里只断言"未读到分支时**不渲染**这块空壳"。分支名确实渲染成 `main` 由
  // test-review-overlay-hooks.mjs 负责——那里走的是完整挂载链路，`history.state` 已经
  // 落定；而这个桩里嵌套组件的状态只在被展开时才更新，面板那一层读到的可能还是加载中。
  check('没有分支信息时不渲染空徽标', rowsOf(nodes, 'data-review-branch').length, 0)
  has('头栏里有计数徽标', rowsOf(nodes, 'data-review-count').length >= 1)
  has('仍有刷新按钮（title 是脚本依赖）', nodes.some((n) => n.props?.title === 'refresh'))
  has('仍有收起按钮（title 是脚本依赖）', nodes.some((n) => n.props?.title === 'collapse'))
  has('图标按钮统一带样式钩子', nodes.filter((n) => n.props?.title === 'refresh' || n.props?.title === 'collapse').every((n) => n.props?.['data-review-icon-button'] === ''))
}

console.log('')
console.log('=== 2. 提交区：一张卡片 + 主次按钮 + 快捷键提示 ===')
{
  const cards = rowsOf(nodes, 'data-staging-commit-card')
  check('提交区是一张卡片', cards.length, 1)
  const card = cards[0]
  has('卡片里有提交信息框', collectHostNodes(card).some((n) => n.props?.['data-staging-message'] !== undefined))
  has('卡片里有提交按钮', collectHostNodes(card).some((n) => n.props?.['data-staging-commit'] !== undefined))
  const message = nodes.find((n) => n.props?.['data-staging-message'] !== undefined)
  // 样式钩子：焦点环与占位符颜色都挂在这个属性上（内联样式写不出 :focus）。
  is('提交信息框带输入框样式钩子', message?.props?.['data-review-input'], '')
  is('提交按钮是主按钮', nodes.find((n) => n.props?.['data-staging-commit'] !== undefined)?.props?.['data-review-primary'], '')
  is('提交并推送是次按钮', nodes.find((n) => n.props?.['data-staging-commit-push'] !== undefined)?.props?.['data-review-secondary'], '')
  // 为什么禁用、会提交什么、快捷键是什么——三件事都要写在界面上。
  const hint = nodes.find((n) => n.props?.['data-staging-hint'] !== undefined)
  has('有提交提示', hint !== undefined)
  // 提示在**卡片里**（与按钮同一行），而不是散落到列表中间。
  has('提示在提交卡片里', collectHostNodes(card).some((n) => n.props?.['data-staging-hint'] !== undefined))
  // 未填提交信息时，提示要说明原因（按钮灰着而不给理由，用户只会反复点它）。
  has('未填信息时说明原因', textOf(hint ?? null).includes('emptyMessage'))
  has('提示里给出 Ctrl+Enter', textOf(hint ?? null).includes('Ctrl+'))
}

console.log('')
console.log('=== 3. 分组与行：收敛的动作按钮 ===')
{
  const groupHeads = rowsOf(nodes, 'data-staging-group-head')
  has('分组头有统一样式钩子', groupHeads.length >= 2)
  // `data-staging-group` 必须**只**挂在分组外壳上：暂存测试按它统计分组数，
  // 多挂一处会让"只有两组"这条断言变成另一种含义（`new Set` 会掩盖重复）。
  has('分组标记只在外壳上', groupHeads.every((n) => n.props?.['data-staging-group'] === undefined))
  has('两个分组都在', rowsOf(nodes, 'data-staging-group').length >= 2)
  const badges = rowsOf(nodes, 'data-review-count')
  has('分组头有计数徽标', badges.length >= 2)
  // 行最小高度来自面板根上的令牌，头部与行共用同一个节奏。
  has('行有统一高度', rowsOf(nodes, 'data-staging-row').every((n) => String(n.props?.style?.minHeight ?? '').includes('--dsh-review-row-h')))
  // 行内动作默认收敛（透明度 0），悬停 / 键盘聚焦才浮现——前提是它们带上了被那条
  // CSS 规则命中的钩子。少了 @data-review-icon-button，动作会常显，行就又挤又吵。
  const history = rowsOf(nodes, 'data-staging-history')
  has('每行都有变更记录按钮', history.length >= 3)
  has('变更记录是图标按钮', history.every((n) => n.props?.['data-review-icon-button'] === ''))
  const actions = rowsOf(nodes, 'data-staging-row-action')
  has('每行都有暂存动作', actions.length >= 3)
  /**
   * 从行反查它里面有哪些动作按钮。
   *
   * 不能给每个按钮找父节点：桩渲染出来的是一棵单向的树，子节点拿不到父引用，
   * 而 `data-staging-side` 挂在**行**上。所以反过来做——拿每一行自己展开一遍。
   *
   * @param side - 行的标记（`staged` / `unstaged` / `untracked`）。
   * @returns 那一行里的动作按钮。
   */
  const actionsInRow = (side) => {
    const row = nodes.find((n) => n.props?.['data-staging-side'] === side)
    return collectHostNodes(row).filter((n) => n.props?.['data-staging-row-action'] !== undefined)
  }
  check('已暂存行一个动作', actionsInRow('staged').length, 1)
  check('未暂存行一个动作', actionsInRow('unstaged').length, 1)
  check('未跟踪行一个动作', actionsInRow('untracked').length, 1)
  // 已跟踪行的动作靠 `data-review-icon-button` 参与"悬停才浮现"；未跟踪行的那个 `+`
  // 是那一行的主要动作、常显，因此不强制带这个钩子。
  has(
    '已跟踪行的动作是图标按钮',
    [...actionsInRow('staged'), ...actionsInRow('unstaged')].every((n) => n.props?.['data-review-icon-button'] === ''),
  )
  // 已暂存那一行的动作必须**保持可见**：它代表"这个文件已在索引里"，藏起来用户就
  // 找不到取消暂存的入口了。
  has('已暂存行有可见性标记', actions.some((n) => n.props?.['data-review-level'] === 'on'))
  has('未暂存行也有标记', actions.some((n) => n.props?.['data-review-level'] === 'off'))
  // 未跟踪组：勾选 + 加入 git 的汇总栏。
  const bar = rowsOf(nodes, 'data-review-untracked-bar')
  check('未跟踪有汇总栏', bar.length, 1)
  has('汇总栏里有「加入 git」', collectHostNodes(bar[0]).some((n) => n.props?.['data-staging-add-chosen'] !== undefined))
  is('「加入 git」是主按钮', nodes.find((n) => n.props?.['data-staging-add-chosen'] !== undefined)?.props?.['data-review-primary'], '')
  has('汇总栏里有选中计数', collectHostNodes(bar[0]).some((n) => n.props?.['data-staging-chosen-count'] !== undefined))
}

console.log('')
console.log('=== 4. 样式块：现代观感层真的注入了 ===')
{
  check('样式块已注入', styledBlocks.length >= 1, 'true')
  const css = styledBlocks.map((entry) => entry.textContent ?? entry.text ?? '').join('\n')
  check('样式块非空', css.length > 1000, 'true')
  for (const selector of [
    "[data-desktop-review-surface='panel']",
    '[data-review-header]',
    '[data-review-title]',
    '[data-review-branch]',
    '[data-review-section-title]',
    '[data-review-primary]',
    '[data-review-secondary]',
    '[data-review-input]:focus',
    '[data-review-input]::placeholder',
    '[data-staging-row]:hover',
    '[data-staging-group-head]',
    '[data-review-untracked-bar]',
    '[data-review-commit] + [data-review-commit]',
  ]) {
    has(`样式里有 ${selector}`, css.includes(selector))
  }
  // 悬停才浮现的规则必须**同时**覆盖悬停、键盘聚焦与触摸屏：
  //   * 只写 :hover —— 键盘用户永远看不到那些动作按钮；
  //   * 只写 :hover —— 触摸屏没有悬停，那些动作等于不存在。
  has('收敛规则覆盖悬停', css.includes('[data-staging-row]:hover [data-staging-row-action]'))
  has('收敛规则覆盖键盘聚焦', css.includes('[data-staging-row] [data-staging-row-action]:focus-visible'))
  has('收敛规则覆盖触摸屏', css.includes('@media (hover: none)'))
  // 已暂存行的动作保持可见（同上：藏起来就找不到取消暂存的入口）。
  has('收敛规则为已暂存行动作开例外', css.includes("[data-review-level='on']"))
  // 焦点可见性：所有按钮都要有可见焦点环，不能只靠浏览器默认（会被内联样式盖掉）。
  has('按钮有可见焦点环', css.includes(':focus-visible'))
  // 未闭合的样式块会被浏览器**静默丢弃**，表现是"改了半天没反应"，所以粗查一次括号。
  is('样式块括号平衡', (css.match(/\{/gu) ?? []).length === (css.match(/\}/gu) ?? []).length, true)
}

console.log('')
console.log(failures === 0 ? '抽屉样式全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
