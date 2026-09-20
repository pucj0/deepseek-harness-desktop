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
// 状态刻意覆盖 porcelain 的四种形状（已用真实 git 验证过）：
//   `A  new-staged.txt`  只有已暂存
//   ` M unstaged.txt`    只有未暂存
//   `MM both.txt`        **两边都有**（同一个文件会出现在两组里）
//   `?? untracked-N.txt` 未跟踪
const STATUS = {
  isRepo: true,
  branch: 'main',
  tracked: [
    { path: 'new-staged.txt', index: 'A', worktree: ' ' },
    { path: 'unstaged.txt', index: ' ', worktree: 'M' },
    { path: 'both.txt', index: 'M', worktree: 'M' },
  ],
  trackedCount: 3,
  untrackedCount: 25,
  untrackedSample: ['untracked-1.txt', 'untracked-2.txt', 'untracked-3.txt'],
}

const posts = []
let statusResponse = () => STATUS
let writeError = null

globalThis.fetch = async (url, init) => {
  const target = String(url)
  const route = target.slice(target.indexOf('/dsh-desktop/review/') + '/dsh-desktop/review/'.length).split('?')[0]
  const body = init?.body === undefined ? undefined : JSON.parse(init.body)
  // 本插件的 `call` 是**只发 POST** 的辅助函数，读接口也走 POST —— 因此"是不是写操作"
  // 必须按**路由**判断，不能按 method 判断。早先按 method 判断，于是读 status 也被当成
  // 写操作，返回了 `{ isRepo: true }`（没有 tracked/untracked），面板于是显示"工作区干净"，
  // 而真实界面是对的。
  if (route === 'status' || route === 'untracked') {
    const payload = route === 'status' ? statusResponse() : { isRepo: true, paths: [], total: 0, truncated: false }
    return { ok: true, text: async () => JSON.stringify(payload) }
  }
  posts.push({ route, body })
  if (writeError !== null) {
    const failure = writeError
    writeError = null
    return { ok: false, text: async () => JSON.stringify(failure) }
  }
  return { ok: true, text: async () => JSON.stringify({ isRepo: true }) }
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
const mountProps = {
  t: (key, params) => {
    if (params === undefined) return key
    return Object.entries(params).reduce((text, [name, value]) => text.split(`{${name}}`).join(String(value)), key)
  },
  workspace: 'F:\\code\\projA',
  onCommitted: () => undefined,
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

async function mount() {
  rootKey = `staging${mountSeq++}`
  settledNodes = []
  await settle()
}

console.log('')
console.log('=== 2. 三组文件按 XY 分类 ===')
await mount()
check('2) 区块已渲染', find('data-staging') !== null, 'true')
{
  const groups = findAll('data-staging-group').map((n) => n.props['data-staging-group'])
  // 三组各取一次标题（组容器与标题各带一次属性，因此按出现顺序去重）。
  check('   三组都在（已暂存/更改/未跟踪）', [...new Set(groups)].join(','), 'staged,unstaged,untracked')
  const rows = findAll('data-staging-row')
  const bySide = (side) => rows.filter((r) => r.props['data-staging-side'] === side).map((r) => r.props['data-staging-row'])
  check('   已暂存组', bySide('staged').join(','), 'new-staged.txt,both.txt')
  check('   更改组', bySide('unstaged').join(','), 'unstaged.txt,both.txt')
  // both.txt 在两组里都出现——这正是 `MM` 的正确表现。
  checkTrue('   both.txt 同时在两组', bySide('staged').includes('both.txt') && bySide('unstaged').includes('both.txt'))
}
// 未跟踪组默认折叠：实测一个真实仓库有 6,636 个未跟踪文件。
check('   未跟踪组默认折叠', find('data-staging-untracked-list') === null, 'true')
// 未跟踪组的计数必须用 host 给的**总数**（25），不是本地样本的 3 条：界面上"6,636 个文件"
// 这个数字本身就是用户想知道的第一件事。
{
  // 用整棵树的文本：`textOf(find(...))` 读的是没有异步状态的另一次渲染（见 viewText 的说明）。
  const titleText = viewText().replace(/\s+/gu, '')
  check('   未跟踪计数用 host 给的总数（25，不是样本的 3）', titleText.includes('untrackedTitle25'), 'true')
}

console.log('')
console.log('=== 3. 展开未跟踪组：只列样本 + 截断说明 ===')
await click(find('data-staging-toggle', 'untracked'))
check('3) 展开后出现列表', find('data-staging-untracked-list') !== null, 'true')
check('   列出样本 3 条', findAll('data-staging-row').filter((r) => r.props['data-staging-side'] === 'untracked').length, 3)
checkTrue('   说明还有 22 个没显示', textOf(find('data-staging-untracked-truncated')).includes('untrackedTruncated'))

console.log('')
console.log('=== 4. 单文件暂存 / 取消暂存 ===')
{
  posts.length = 0
  // 更改组里 unstaged.txt 的"+"按钮。
  const row = findAll('data-staging-row').find((r) => r.props['data-staging-row'] === 'unstaged.txt' && r.props['data-staging-side'] === 'unstaged')
  const button = collectHostNodes(row, 'probe').find((n) => n.props?.['data-staging-row-action'] !== undefined)
  await click(button)
  check('4) 发出 stage', posts.map((p) => p.route).join(','), 'stage')
  check('   只暂存这一个文件', JSON.stringify(posts[0].body), JSON.stringify({ workspace: 'F:\\code\\projA', paths: ['unstaged.txt'] }))
  checkTrue('   暂存后给出提示', textOf(find('data-staging-notice')).includes('stagedNotice'))
}
{
  posts.length = 0
  const row = findAll('data-staging-row').find((r) => r.props['data-staging-row'] === 'new-staged.txt' && r.props['data-staging-side'] === 'staged')
  const button = collectHostNodes(row, 'probe').find((n) => n.props?.['data-staging-row-action'] !== undefined)
  await click(button)
  check('   取消暂存走 unstage 路由', posts.map((p) => p.route).join(','), 'unstage')
  check('   请求体', JSON.stringify(posts[0].body), JSON.stringify({ workspace: 'F:\\code\\projA', paths: ['new-staged.txt'] }))
  check('   按钮动作标记是 unstage', button?.props?.['data-staging-row-action'], 'unstage')
}

console.log('')
console.log('=== 5. 批量按钮 ===')
// 注意桩里的 `body` 已经 JSON.parse 过了，这里直接读对象，不要再 parse 一次。
{
  posts.length = 0
  await click(find('data-staging-action', 'stage-all'))
  check('5) 全部暂存：路径是被分类为"未暂存"的那批', JSON.stringify(posts[0]?.body?.paths), '["unstaged.txt","both.txt"]')
}
{
  posts.length = 0
  await click(find('data-staging-action', 'unstage-all'))
  check('   全部取消暂存：路径是被分类为"已暂存"的那批', JSON.stringify(posts[0]?.body?.paths), '["new-staged.txt","both.txt"]')
}
{
  posts.length = 0
  await click(find('data-staging-action', 'stage-all-untracked'))
  // **只暂存列出的样本**，不是全部 25 个：一次 add 上万个文件几乎不是用户想要的
  // （那里面有构建产物与日志），而且会让 git 跑很久。
  check('   未跟踪批量只针对列出的样本', JSON.stringify(posts[0]?.body?.paths), '["untracked-1.txt","untracked-2.txt","untracked-3.txt"]')
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
  checkTrue('   提示改成快捷键说明', textOf(find('data-staging-hint')).includes('commitHintCtrlEnter'))
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
  statusResponse = () => ({ isRepo: true, branch: 'main', tracked: [], trackedCount: 0, untrackedCount: 0, untrackedSample: [] })
  await mount()
  checkTrue('9) 干净时给出空态', viewText().includes('noStagedOrChanged'))
  check('   没有任何分组', findAll('data-staging-group').length, 0)
  check('   提交按钮禁用', find('data-staging-commit')?.props?.disabled, true)
}
{
  statusResponse = () => ({ isRepo: false })
  await mount()
  checkTrue('   非仓库给出提示', viewText().includes('notRepo'))
}
{
  statusResponse = () => STATUS
  globalThis.fetch = (() => {
    const original = globalThis.fetch
    return async (url, init) => {
      // 按**路由**判断而不是按 method：本插件的 `call` 只发 POST，读接口也是 POST，
      // 用 `init.method === undefined` 当"读请求"的判据永远不会命中。
      if (String(url).includes('/review/status')) {
        return { ok: false, text: async () => JSON.stringify({ error: 'boom', code: 'workspaceNotAllowed', detail: 'workspace must be one of the workspaces known to this app' }) }
      }
      return original(url, init)
    }
  })()
  await mount()
  {
    // 读接口失败时走的也是与"非仓库"同一个 `statusBlock` 分支（上一条已经断言它能渲染出
    // 文案），这里确认走到的是**错误态**而不是把失败当成"工作区干净"。
    const all = collectHostNodes(render(Staging, mountProps, rootKey).tree, rootKey)
    const text = all.map((n) => textOf(n)).join(' ')
    checkTrue('   失败态渲染出提示块', all.length > 0)
    check('   没有把失败误当成"工作区干净"', text.includes('noStagedOrChanged'), false)
    check('   没有渲染出任何分组', all.filter((n) => n.props?.['data-staging-group'] !== undefined).length, 0)
  }
}

console.log('')
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
