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
      const name = current.type.name === '' ? 'anonymous' : current.type.name
      const keyed = `${path}${current.props?.key === undefined ? '' : `#${String(current.props.key)}`}:${name}`
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
/** `window` 上的监听器（提交区的"窗口尺寸变化重新夹取"依赖它）。 */
const windowListeners = new Map()
globalThis.window = {
  innerWidth: 1400,
  innerHeight: 900,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  addEventListener(type, handler) {
    if (!windowListeners.has(type)) windowListeners.set(type, new Set())
    windowListeners.get(type).add(handler)
  },
  removeEventListener(type, handler) {
    windowListeners.get(type)?.delete(handler)
  },
  __ModuleLoader__: {
    load({ factory }) {
      loaded = factory((specifier) => (specifier === 'react' ? react : {}))
    },
  },
}
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#ffffff' })
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

/** 往 `document` / `window` 上派发一个事件（拖动与窗口 resize 的监听都挂在这两处）。 */
const emitOn = (registry, type, event) => {
  for (const handler of [...(registry.get(type) ?? [])]) handler(event)
}
const emitDocument = (type, event) => emitOn(domListeners, type, event)
const emitWindow = (type, event) => emitOn(windowListeners, type, event)

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
 * `/repo-context` 的响应。
 *
 * 固定回答"这些工作区都属于同一个仓库根"：`WORKSPACE` 与 `WORKSPACE\\pages` 因此必须落在
 * 同一格里（第 14 节钉的就是这件事）。真实 host 那边是 `git rev-parse --show-toplevel` 的
 * 结果，这里只需要形状一致。
 */
const REPO_ROOT = 'F:\\code\\projA'

/**
 * `/project-git-scope` 的仓库列表（项目级发现的结果）。
 *
 * 默认单仓库：工作区自己就是仓库根（`relativePath === ''`）。改成两个仓库就能测"多仓库时
 * 只有 active 那一个被操作"（见第 15 节）。
 */
let scopeRepositories = () => [
  { repositoryRoot: REPO_ROOT, gitDir: `${REPO_ROOT}\\.git`, relativePath: '', name: 'projA' },
]

/** 发现诊断信息（第 21 节要求这些数字可见）。默认"一次就找全了"。 */
let scopeDiscovery = () => ({
  complete: true,
  directoriesVisited: 3,
  candidatesFound: 1,
  gitProbes: 1,
  durationMs: 2,
  truncatedByBudget: false,
  cached: false,
})

/**
 * `/untracked` 的响应。
 *
 * 默认给一份"大量未跟踪 + 一层目录 + 一页 200 条"的形状，用来验证惰性树与分页；测试可以
 * 在需要时替换它（例如让精确枚举失败）。
 */
/**
 * 非 null 时 `/untracked` 会**挂起**，直到测试调用它放行（用来观察"正在统计…"那一帧）。
 * 与 `aiHold` 同一套做法。
 */
let untrackedHold = null

let untrackedResponse = (body) => {
  const prefix = String(body?.prefix ?? '')
  const offset = Number(body?.offset ?? 0)
  const limit = Number(body?.limit ?? 200)
  const tree = (directories, files) => ({
    prefix,
    directories,
    files,
    total: directories.length + files.length,
    directoryCount: directories.length,
    fileCount: files.length,
    offset,
    limit,
    truncated: false,
  })
  if (prefix === '') {
    return {
      isRepo: true,
      total: 6846,
      mode: 'browse',
      exact: true,
      cached: false,
      inlineFiles: [],
      paths: [],
      tree: tree([{ name: 'tmp', path: 'tmp', descendantCount: 6846 }], []),
    }
  }
  if (prefix === 'tmp') {
    return {
      isRepo: true,
      total: 6846,
      mode: 'browse',
      exact: true,
      inlineFiles: [],
      paths: [],
      tree: tree([{ name: 'magic-api', path: 'tmp/magic-api', descendantCount: 6835 }], []),
    }
  }
  // 叶子层：一次一页 200 条（用 total 表示还有更多，客户端据此显示「继续加载」）。
  const files = []
  for (let i = offset; i < Math.min(offset + limit, 6835); i += 1) {
    files.push({ name: `f${String(i).padStart(5, '0')}.js`, path: `tmp/magic-api/f${String(i).padStart(5, '0')}.js` })
  }
  return {
    isRepo: true,
    total: 6846,
    mode: 'browse',
    exact: true,
    inlineFiles: [],
    paths: [],
    tree: { prefix, directories: [], files, total: 6835, directoryCount: 0, fileCount: 6835, offset, limit, truncated: offset + files.length < 6835 },
  }
}

/** 假的"新增文件"统一差异：内容里带路径，因此"谁的差异画在谁下面"可以直接从文本上看出来。 */
const UNTRACKED_DIFF = (path) =>
  [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    '@@ -0,0 +1,2 @@',
    `+hello from ${path}`,
    '+second line',
  ].join('\n')

// ---- 「AI 补充提交信息」的夹具 ----
/** `/commit-message` 的默认成功响应。 */
let aiResponse = { isRepo: true, message: 'fix(review): 修复未跟踪文件差异查看\n\n- 改走按需差异', subject: 'fix(review): 修复未跟踪文件差异查看', bullets: ['改走按需差异'] }
/** 非 null 时 `/commit-message` 返回这个失败（`{ code, detail }`）。 */
let aiError = null
/** 非 null 时 `/commit-message` 会挂起，直到测试调用它放行。 */
let aiHold = null

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

/**
 * gitbar 侧两个跨插件读写的夹具。
 *
 * 储藏列表由 gitbar 拥有，本插件的面板会跨插件问它一次——这套用例与储藏无关，但**必须**
 * 在这里接住：否则下面按 `/review/` 切路由的逻辑会切出一个乱七八糟的 route，然后把它当成
 * "写操作"记进 `posts`，而那些按 posts 计数的断言（例如"加入 git 之后又重取了未跟踪根层"）
 * 就会失真。`head-commit` 则是 amend / 撤销提交要读的 HEAD 信息（含"是否已发布"）。
 */
let headCommit = {
  isRepo: true,
  hasCommits: true,
  branch: 'main',
  upstream: '',
  published: false,
  head: {
    sha: 'a'.repeat(40),
    short: 'aaaaaaa',
    subject: 'Fix login bug',
    message: 'Fix login bug',
    author: 'tester',
    email: 't@example.com',
    date: '2026-01-01T10:00:00+08:00',
    parents: ['b'.repeat(40)],
  },
}

const fetchBase = async (url, init) => {
  const target = String(url)
  if (target.includes('/dsh-desktop/gitbar/')) {
    const gitbarRoute = target.slice(target.indexOf('/dsh-desktop/gitbar/') + '/dsh-desktop/gitbar/'.length).split('?')[0]
    // gitbar 的写路由（reset）也要**留下请求体**：撤销提交/重置的断言看的就是它发了什么。
    requests.push({ route: `gitbar:${gitbarRoute}`, body: init?.body === undefined ? undefined : JSON.parse(init.body), url: target })
    if (gitbarRoute === 'stash/list') return { ok: true, text: async () => JSON.stringify({ isRepo: true, stashes: [], stashCount: 0 }) }
    // 「修改最后一次提交」与「撤销最后一次提交」都要先读 HEAD 的完整信息（信息 + 是否已发布）。
    if (gitbarRoute === 'head-commit') return { ok: true, text: async () => JSON.stringify(headCommit) }
    return { ok: true, text: async () => JSON.stringify({ isRepo: true, reset: { mode: 'soft', previousHead: { sha: 'a'.repeat(40), short: 'aaaaaaa' } } }) }
  }
  const route = target.slice(target.indexOf('/dsh-desktop/review/') + '/dsh-desktop/review/'.length).split('?')[0]
  const body = init?.body === undefined ? undefined : JSON.parse(init.body)
  requests.push({ route, body, url: target })
  // 本插件的 `call` 是**只发 POST** 的辅助函数，读接口也走 POST —— 因此"是不是写操作"
  // 必须按**路由**判断，不能按 method 判断。早先按 method 判断，于是读 status 也被当成
  // 写操作，返回了 `{ isRepo: true }`（没有 tracked/untracked），面板于是显示"工作区干净"，
  // 而真实界面是对的。
  if (route === 'workspace') return { ok: true, text: async () => JSON.stringify(workspaceResponse()) }
  if (route === 'file-history') return { ok: true, text: async () => JSON.stringify(FILE_HISTORY) }
  // 按需差异。项目级快照（`/workspace`）是**元数据级**的，不带任何统一差异，因此每个
  // 文件展开时都必须单独来要一次——未跟踪文件也一样（host 侧走
  // `git diff --no-index /dev/null <path>`，所以 `untracked: true` 是有意义的入参）。
  if (route === 'workspace-file') {
    const path = String(body?.path ?? '')
    return {
      ok: true,
      text: async () =>
        JSON.stringify({
          workspace: body?.workspace,
          path,
          revision: body?.revision ?? '',
          untracked: body?.untracked === true,
          diff: UNTRACKED_DIFF(path),
          truncated: false,
        }),
    }
  }
  if (route === 'repo-context') {
    return { ok: true, text: async () => JSON.stringify({ isRepo: true, workspaceRoot: body?.workspace, repositoryRoot: REPO_ROOT }) }
  }
  // 项目级仓库发现（多仓库模型）。1.5.4 起客户端不再问 `/repo-context`——它问的是这一条，
  // 因为"工作区自己是仓库"只是众多情况之一（工作区可能只是某个仓库的父目录）。
  //
  // 默认回答**单仓库**且 `relativePath === ''`（工作区自己就是仓库）：于是 active 仓库就是
  // 它本身，所有请求都不带 `repository`，行为与 1.5.2 逐字一致——这一节与第 14 节钉的就是
  // "单仓库没有回归"。多仓库场景见 `scopeRepositories`。
  if (route === 'project-git-scope') {
    return {
      ok: true,
      text: async () =>
        JSON.stringify({
          workspaceRoot: body?.workspace,
          repositories: scopeRepositories(),
          discovery: scopeDiscovery(),
        }),
    }
  }
  if (route === 'untracked') {
    // 可以挂起（用来观察"还没统计出来"那一帧，并在其间断言"不重复发请求"）。
    if (untrackedHold !== null) {
      return await new Promise((resolve) => {
        untrackedHold = () => resolve({ ok: true, text: async () => JSON.stringify(untrackedResponse(body)) })
      })
    }
    return { ok: true, text: async () => JSON.stringify(untrackedResponse(body)) }
  }
  // 「AI 补充提交信息」。夹具可以控制它：成功给一段文本、失败给一个稳定 code、
  // 或者**挂起**（用来验证"生成期间切工作区/重新生成时，迟到结果不许写入"）。
  if (route === 'commit-message') {
    if (aiHold !== null) {
      return await new Promise((resolve) => {
        aiHold = () => resolve({ ok: true, text: async () => JSON.stringify(aiResponse) })
      })
    }
    if (aiError !== null) {
      const failure = aiError
      return { ok: false, text: async () => JSON.stringify(failure) }
    }
    return { ok: true, text: async () => JSON.stringify(aiResponse) }
  }
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
check('1) `A ` 只有已暂存', JSON.stringify(classify({ index: 'A', worktree: ' ' })), '{"conflicted":false,"staged":true,"unstaged":false}')
check('   ` M` 只有未暂存', JSON.stringify(classify({ index: ' ', worktree: 'M' })), '{"conflicted":false,"staged":false,"unstaged":true}')
// 这一条是本区块最容易做错的地方：同一个文件两边都有改动时，它必须在**两组里都出现**。
check('   `MM` 两边都有', JSON.stringify(classify({ index: 'M', worktree: 'M' })), '{"conflicted":false,"staged":true,"unstaged":true}')
check('   `??` 两组都不算（它是未跟踪）', JSON.stringify(classify({ index: '?', worktree: '?' })), '{"conflicted":false,"staged":false,"unstaged":false}')
check('   `D ` 已暂存的删除', JSON.stringify(classify({ index: 'D', worktree: ' ' })), '{"conflicted":false,"staged":true,"unstaged":false}')
check('   ` M`（删除未暂存）', JSON.stringify(classify({ index: ' ', worktree: 'D' })), '{"conflicted":false,"staged":false,"unstaged":true}')
// 未合并（冲突）是**第三类**：它既不属于已暂存也不属于未暂存，而是自己的那一组——冲突行上
// 的 stage / revert 都是错的（前者会把 `<<<<<<<` 加进索引，后者会丢掉用户还没看过的改动）。
check('   `UU` 是冲突，不算已暂存也不算未暂存', JSON.stringify(classify({ index: 'U', worktree: 'U' })), '{"conflicted":true,"staged":false,"unstaged":false}')
check('   宿主给的 conflict 标记同样判为冲突', JSON.stringify(classify({ index: 'A', worktree: 'A', conflict: true })), '{"conflicted":true,"staged":false,"unstaged":false}')
// 形状不对时不许抛错：面板在中间态下会照样调用它。
check('   空对象不抛错', JSON.stringify(classify({})), '{"conflicted":false,"staged":false,"unstaged":false}')
check('   undefined 不抛错', JSON.stringify(classify(undefined)), '{"conflicted":false,"staged":false,"unstaged":false}')

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
   *
   * 读的是 `mountProps.workspace` 而非常量 `WORKSPACE`：切项目那一段会改这个字段，
   * 快照必须跟着它走，否则测的就不是真实行为。
   */
  get snapshot() {
    return snapshotStore.get(mountProps.workspace)
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
  checkTrue('   非仓库给出提示', viewText().includes('notGitProject'))
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

  // ---- 历史行的四项信息（日期 / 作者 / 提交信息 / SHA）+ 点开该提交里这个文件的改动 ----
  await click(find('data-staging-history', 'unstaged.txt'))
  const rows = findAll('data-staging-history-row')
  check('   历史行数与宿主一致', rows.length, 2)
  {
    const text = rows.map((node) => textOf(node)).join(' | ')
    check('   行里有短 SHA', text.includes('aaaaaaa'), 'true')
    check('   行里有提交信息', text.includes('second touch'), 'true')
    check('   行里有作者（不只是 hover 提示）', text.includes('tester'), 'true')
    check('   行里有日期', text.includes('2026-01-02'), 'true')
  }
  requests.length = 0
  await click(find('data-staging-history-row', 'a'.repeat(40)))
  const commitFile = requests.filter((r) => r.url.includes('/review/commit-file')).pop()
  checkTrue('   点历史行取的是"这个提交里对这个文件的改动"', commitFile !== undefined)
  check('   带的是那个提交', commitFile?.body?.revision, 'a'.repeat(40))
  check('   以及文件路径', commitFile?.body?.path, 'unstaged.txt')
  checkTrue('   差异用共享的查看器渲染（并排/统一都在）', find('data-review-sbs-row') !== null || find('data-review-diff-row') !== null)
  checkTrue('   并保留"这是历史某一步"的上下文（关闭按钮在）', find('data-review-diff-close') !== null)
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
console.log('=== 11. 未跟踪文件的按需差异（点开不许报错）===')
{
  // 用户报的问题：在 Changes 里点一个**未跟踪**文件，直接报错。
  //
  // 根因是 v1.4.7 把"整页统一差异"改成按需取（`/workspace-file` + `LazyFileDiff`）时，
  // 删掉了 `StagingSection` 里的 `byFile`（它是整页差异 `splitByFile` 的产物），
  // 但未跟踪分支仍在传 `diff: byFile.get(path) ?? ''` —— 于是点击立刻
  // `ReferenceError: byFile is not defined`，整个面板被错误边界接住。
  //
  // 因此这一段钉三件事，缺一不可：
  //   1. 点击**不抛错**（这是回归本体：旧写法的报错发生在渲染期，会直接冒出来）；
  //   2. 请求形状对（路由、path、revision、`untracked: true`），且**只发一次**；
  //   3. 界面上真的出现了那份差异的内容（"没报错但什么都没画"同样是坏的）。
  //
  // 这一版差异**不再 inline 插在文件行下面**，而是出现在右栏的 Diff Preview 里，因此
  // 第 3 条改成"右栏里画出了内容"，并额外断言"再点同一个文件不会重复请求"。
  await mount()
  const before = requests.filter((r) => r.route === 'workspace-file').length
  const toggle = find('data-staging-diff-toggle', 'untracked-1.txt')
  checkTrue('11) 未跟踪行有选中入口', toggle !== null)

  let threw = null
  try {
    await click(toggle)
  } catch (cause) {
    threw = cause
  }
  check('   点击不抛错（回归：byFile is not defined）', threw === null ? 'ok' : String(threw?.message ?? threw), 'ok')

  const calls = requests.filter((r) => r.route === 'workspace-file')
  check('   只发了一次按需差异请求', calls.length - before, 1)
  check('   请求带的是这个未跟踪文件', calls[calls.length - 1]?.body?.path, 'untracked-1.txt')
  checkTrue('   请求标记 untracked', calls[calls.length - 1]?.body?.untracked === true)
  check('   请求带上了 HEAD 作为基线', calls[calls.length - 1]?.body?.revision, 'a'.repeat(40))
  // 差异在**右栏**里画出来，而不是那个文件行下面。
  //
  // 断言取材很关键：这里读 `settledNodes`（`settle()` 跑过副作用之后收集的那份平铺列表），
  // **不要**再调一次 `collectHostNodes(render(...))` 去找内容。这个桩按"树中位置 + props.key"
  // 给嵌套组件分配 hook 槽，而 `LazyFileDiff` 是"挂载之后才去取数"的状态组件：重新遍历一次
  // 会拿到一个**全新的槽位**，于是它永远停在 loading、断言假红（实测踩到过，排查成本很高）。
  const flat = settledNodes.map((n) => textOf(n)).join(' ')
  const paneAt = settledNodes.findIndex((n) => n.props?.['data-changes-diff-preview'] !== undefined)
  const rowAt = settledNodes.findIndex((n) => n.props?.['data-review-diff-row'] !== undefined)
  checkTrue('   右栏画出了新增内容', flat.includes('hello from untracked-1.txt'))
  check('   差异在右栏之后（不是文件行下面）', rowAt > paneAt, 'true')
  check('   左栏里没有差异行（不是 inline 展开）', settledNodes.slice(0, paneAt).some((n) => n.props?.['data-review-diff-row'] !== undefined), 'false')
  // 选中的行被标记（aria-selected + data 标记），用户才知道右边那块属于谁。
  check('   选中的行被标记', find('data-staging-row', 'untracked-1.txt')?.props?.['data-staging-selected'], 'true')
  check('   路径按钮标记 aria-selected', find('data-staging-diff-toggle', 'untracked-1.txt')?.props?.['aria-selected'], true)

  // 再点同一个文件：保持选中，且**不重复请求**（缓存 + 同一键只问一次）。
  await click(find('data-staging-diff-toggle', 'untracked-1.txt'))
  check('   再次点击仍保持选中', find('data-staging-diff-toggle', 'untracked-1.txt')?.props?.['aria-selected'], true)
  check('   再次点击不重复请求', requests.filter((r) => r.route === 'workspace-file').length - before, 1)
  checkTrue('   内容仍在右栏', settledNodes.map((n) => textOf(n)).join(' ').includes('hello from untracked-1.txt'))

  // 关闭按钮：取消选中（行高亮消失、右栏回到空态）；再点同一个文件从缓存恢复，不再请求。
  await click(find('data-review-diff-close'))
  checkTrue('   关闭后差异内容消失', settledNodes.map((n) => textOf(n)).join(' ').includes('hello from untracked-1.txt') === false)
  check('   关闭同时取消选中', find('data-staging-row', 'untracked-1.txt')?.props?.['data-staging-selected'], 'false')
  await click(find('data-staging-diff-toggle', 'untracked-1.txt'))
  check('   再点同一个文件恢复显示且不再请求', requests.filter((r) => r.route === 'workspace-file').length - before, 1)
  checkTrue('   内容回来了', settledNodes.map((n) => textOf(n)).join(' ').includes('hello from untracked-1.txt'))

  // 换一个 workspace：缓存键里有 workspace，旧项目的差异**不允许**被复用。
  const otherWorkspace = 'F:\\code\\projB'
  const otherStore = snapshotStore
  const savedProps = mountProps.workspace
  mountProps.workspace = otherWorkspace
  rootKey = `staging-other-${mountSeq++}`
  otherStore.set(otherWorkspace, { ...SNAPSHOT, head: 'b'.repeat(40) })
  await settle()
  await click(find('data-staging-diff-toggle', 'untracked-1.txt'))
  const afterSwitch = requests.filter((r) => r.route === 'workspace-file')
  check('   切项目后重新取差异', afterSwitch.length - before, 2)
  check('   新请求带的是新 workspace', afterSwitch[afterSwitch.length - 1]?.body?.workspace, otherWorkspace)
  check('   新请求带的是新 HEAD', afterSwitch[afterSwitch.length - 1]?.body?.revision, 'b'.repeat(40))
  mountProps.workspace = savedProps
}

console.log('')
console.log('=== 12. AI 一键补充提交信息（item 9）===')
{
  // 需求要点（逐条对应下面的断言）：
  //   * 输入**只来自 commitPaths**（勾选的那批），不是整个工作区；
  //   * 生成中按钮禁用 + loading；
  //   * 输入框为空 → 直接填入；
  //   * 已有用户输入 → **不许静默覆盖**，给"替换/追加/取消"三选一；
  //   * 生成期间切工作区/改勾选 → 旧结果不得写入；
  //   * 失败 → 保留原文本 + 非阻塞提示。
  const aiButtons = () => findAll('data-staging-ai')
  const aiRequest = () => requests.filter((r) => r.route === 'commit-message').at(-1)
  const textarea = () => find('data-staging-message')

  await mount()
  check('12) 有「AI 补充」按钮', aiButtons().length, 1)
  check('   按钮文案是 AI 补充', textOf(aiButtons()[0]), 'aiCommit')

  // 输入框为空 → 直接填入，且请求体**只带勾选的文件**。
  const before = requests.filter((r) => r.route === 'commit-message').length
  await click(find('data-staging-ai'))
  check('   发了一次 commit-message 请求', requests.filter((r) => r.route === 'commit-message').length - before, 1)
  const body = aiRequest()?.body
  check('   请求带上工作区', body?.workspace, WORKSPACE)
  // 默认勾选 = 全部已跟踪改动（new-staged.txt / both.txt / unstaged.txt），未跟踪默认不勾。
  check('   只带已勾选的已跟踪文件', (body?.files ?? []).map((f) => f.path).sort().join(','), 'both.txt,new-staged.txt,unstaged.txt')
  check('   未勾选的未跟踪文件不在请求里', (body?.files ?? []).some((f) => f.path.startsWith('untracked-')), 'false')
  check('   带上状态与增删行数', JSON.stringify(body?.files?.find((f) => f.path === 'both.txt')), JSON.stringify({ path: 'both.txt', status: 'M', added: 3, removed: 3 }))
  check('   填入输入框', textarea()?.props?.value, aiResponse.message)
  checkTrue('   给出非阻塞说明', viewText().includes('aiCommitFilled'))

  // 生成中：按钮禁用 + loading 文案（防连点）。
  await mount()
  aiHold = () => undefined
  const heldBefore = requests.filter((r) => r.route === 'commit-message').length
  const pending = click(find('data-staging-ai'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  await settle()
  check('   生成中按钮禁用', findAll('data-staging-ai')[0]?.props?.disabled, true)
  check('   生成中显示 loading 文案', textOf(findAll('data-staging-ai')[0] ?? null), 'aiCommitBusy')
  check('   生成中标记 aria-busy', findAll('data-staging-ai')[0]?.props?.['aria-busy'], true)
  check('   生成中再点不会多发请求', (() => {
    findAll('data-staging-ai')[0]?.props?.onClick?.()
    return requests.filter((r) => r.route === 'commit-message').length
  })(), heldBefore + 1)
  aiHold()
  await pending
  await settle()
  aiHold = null

  // 已有用户输入 → 不覆盖，先问。
  await mount()
  const userText = 'wip: 我打到一半的提交信息'
  find('data-staging-message').props.onChange({ target: { value: userText } })
  await settle()
  await click(find('data-staging-ai'))
  check('   已有输入时不被覆盖', textarea()?.props?.value, userText)
  check('   出现三选一提示', findAll('data-staging-ai-notice')[0]?.props?.['data-staging-ai-notice'], 'ask')
  checkTrue('   提示里带上 AI 建议的标题', viewText().includes('aiCommitSuggested'))
  check('   有替换按钮', find('data-staging-ai-replace') !== null, 'true')
  check('   有追加按钮', find('data-staging-ai-append') !== null, 'true')
  check('   有取消按钮', find('data-staging-ai-cancel') !== null, 'true')
  // 追加：保留用户原文，AI 的内容接到后面。
  await click(find('data-staging-ai-append'))
  check('   追加保留原文并接上建议', textarea()?.props?.value, `${userText}\n\n${aiResponse.message}`)
  // 选过之后"询问"必须消失（三个按钮不再挂着），但会换成一句"已填入"的说明。
  check('   选过之后不再询问', find('data-staging-ai-replace'), null)
  check('   选过之后给出已填入说明', findAll('data-staging-ai-notice')[0]?.props?.['data-staging-ai-notice'], 'notice')

  // 替换：整体换成建议。
  find('data-staging-message').props.onChange({ target: { value: userText } })
  await settle()
  await click(find('data-staging-ai'))
  await click(find('data-staging-ai-replace'))
  check('   替换成 AI 建议', textarea()?.props?.value, aiResponse.message)

  // 取消：原文一字不动。
  find('data-staging-message').props.onChange({ target: { value: userText } })
  await settle()
  await click(find('data-staging-ai'))
  await click(find('data-staging-ai-cancel'))
  check('   取消后原文不动', textarea()?.props?.value, userText)

  // 失败：保留原文本 + 非阻塞提示（AI 不可用不该看起来像面板坏了）。
  aiError = { error: '宿主缺少生成提交信息所需的正式能力', code: 'aiUnavailable', detail: 'MISSING_CREDENTIAL: 当前模型未登录' }
  await click(find('data-staging-ai'))
  check('   失败后原文保留', textarea()?.props?.value, userText)
  checkTrue('   失败提示非阻塞地显示出来', viewText().includes('aiCommitFailed'))
  const failedNotice = findAll('data-staging-ai-notice')[0]
  check('   失败提示不是"询问"态', failedNotice?.props?.['data-staging-ai-notice'], 'notice')
  // 失败之后必须能再试（闸门要放开），否则"AI 失败一次就再也点不动"。
  check('   失败后按钮不再禁用', findAll('data-staging-ai')[0]?.props?.disabled, false)
  const retryBefore = requests.filter((r) => r.route === 'commit-message').length
  await click(find('data-staging-ai'))
  check('   失败后可以重试（再发一次请求）', requests.filter((r) => r.route === 'commit-message').length - retryBefore, 1)
  check('   重试仍失败时原文依旧保留', textarea()?.props?.value, userText)
  aiError = null

  // ---- 「模型达到输出预算」是**成功**，不是失败（实机反馈：finish=max-tokens）----
  //
  // 旧实现把 `finish !== 'stop'` 一律当硬失败，于是模型明明写完了提交信息也会被整段丢弃，
  // 界面显示"AI 补充失败：finish=max-tokens"。现在：内容照常填进输入框，只给一句非阻塞的
  // 截断说明——**绝不能**出现 aiCommitFailed / finish=。
  await mount()
  aiResponse = {
    isRepo: true,
    message: 'fix(review): 修复 Git 面板\n\n- 一',
    subject: 'fix(review): 修复 Git 面板',
    bullets: ['一'],
    truncated: true,
    finishReason: 'max-tokens',
  }
  await click(find('data-staging-ai'))
  check('   截断但成功：内容照常填入', textarea()?.props?.value, 'fix(review): 修复 Git 面板\n\n- 一')
  checkTrue('   给的是"达到长度上限"的说明', viewText().includes('aiCommitTruncated'))
  checkTrue('   不是失败提示（不出现 aiCommitFailed）', !viewText().includes('aiCommitFailed'))
  checkTrue('   也不把内部原因端给用户（没有 finish=）', !viewText().includes('finish='))

  // ---- 只有输出预算、一个字都没有 → aiOutputLimit 走本语言短句（同样不露内部原因）----
  await mount()
  aiResponse = { isRepo: true, message: '', subject: '', bullets: [], truncated: true, finishReason: 'max-tokens' }
  aiError = { error: 'AI generation exceeded the output limit', code: 'aiOutputLimit', detail: 'AI 生成内容超过长度限制，请重试。' }
  await click(find('data-staging-ai'))
  checkTrue('   输出上限走本语言短句', viewText().includes('aiCommitOutputLimit'))
  checkTrue('   不显示通用失败文案', !viewText().includes('aiCommitFailed'))
  aiError = null
  // 恢复默认响应，后面的小节按原样继续。
  aiResponse = { isRepo: true, message: 'fix(review): 修复未跟踪文件差异查看\n\n- 改走按需差异', subject: 'fix(review): 修复未跟踪文件差异查看', bullets: ['改走按需差异'] }

  // 未勾选任何文件：按钮禁用 + 点了给一句说明（不是打一次空请求）。
  await mount()
  find('data-staging-file-pick', 'new-staged.txt').props.onChange({ target: { checked: false } })
  find('data-staging-file-pick', 'both.txt').props.onChange({ target: { checked: false } })
  find('data-staging-file-pick', 'unstaged.txt').props.onChange({ target: { checked: false } })
  await settle()
  check('   没有勾选时按钮禁用', findAll('data-staging-ai')[0]?.props?.disabled, true)

  // ---- 迟到结果不许写入：生成期间换工作区 ----
  await mount()
  const aiBefore = requests.filter((r) => r.route === 'commit-message').length
  aiHold = () => undefined
  const late = click(find('data-staging-ai'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  await settle()
  // 换工作区（组件会清空 AI 状态并让令牌作废）。
  const savedWorkspace = mountProps.workspace
  mountProps.workspace = 'F:\\code\\projB'
  snapshotStore.set('F:\\code\\projB', { ...SNAPSHOT, head: 'c'.repeat(40), files: FILES })
  rootKey = `staging-ai-other-${mountSeq++}`
  await settle()
  aiHold()
  await late
  await settle()
  check('   切项目后旧结果没有写进新的输入框', find('data-staging-message')?.props?.value, '')
  check('   切项目后没有 AI 提示残留', find('data-staging-ai-notice'), null)
  mountProps.workspace = savedWorkspace
  aiHold = null
  check('   期间只发过一次请求', requests.filter((r) => r.route === 'commit-message').length - aiBefore, 1)
}

console.log('')
console.log('=== 13. 未跟踪双模式：少量逐行 / 大量只给摘要 +「浏览」===')
{
  // ---- 13a. 少量（≤ 50）：逐行列出**全部**，没有"浏览"摘要 ----
  await mount()
  check('13a) 少量模式下列出全部 3 条', findAll('data-staging-row').filter((n) => n.props['data-staging-side'] === 'untracked').length, 3)
  check('   没有 browse 摘要', find('data-staging-untracked-browse'), null)
  check('   有「加入 git」栏', find('data-staging-add-chosen') !== null, 'true')

  // ---- 13b. 大量（> 50）：主面板**一行都不列**，只给摘要 +「浏览」 ----
  const trackedOnly = FILES.filter((entry) => entry.untracked !== true)
  const bigSnapshot = {
    ...SNAPSHOT,
    files: trackedOnly,
    changedFiles: trackedOnly.length + 6846,
    changedFilesExact: true,
    untracked: { count: 6846, exact: true, mode: 'browse', collapsed: false, inlineFiles: [] },
  }
  const beforeBig = requests.filter((r) => r.route === 'untracked').length
  setSnapshot(bigSnapshot)
  await settle()
  check('13b) 主面板里 0 条未跟踪行（需求 21.E）', findAll('data-staging-row').filter((n) => n.props['data-staging-side'] === 'untracked').length, 0)
  check('   也没有内联列表容器', find('data-staging-untracked-list'), null)
  check('   有 browse 摘要，模式为 browse', find('data-staging-untracked-browse')?.props?.['data-staging-untracked-browse'], 'browse')
  checkTrue('   摘要里带总数 6846', viewText().includes('6846'))
  check('   有「浏览」按钮', find('data-staging-browse') !== null, 'true')
  check('   没有「加入 git」栏（没行可勾）', find('data-staging-add-chosen'), null)
  // 已经精确了 → 不该再发精确枚举请求（"常驻轮询不枚举"这条在界面上也成立）。
  check('   精确快照不再触发枚举请求', requests.filter((r) => r.route === 'untracked').length - beforeBig, 0)

  // ---- 13c. `pending`（快路径只看到折叠目录）→ 显示"正在统计…"并自动补一次枚举 ----
  const pendingSnapshot = {
    ...SNAPSHOT,
    files: trackedOnly,
    changedFiles: trackedOnly.length + 3,
    changedFilesExact: false,
    untracked: { count: 3, exact: false, mode: 'pending', collapsed: true, inlineFiles: [] },
  }
  setSnapshot(pendingSnapshot)
  // 让精确枚举**挂起**，于是"正在统计…"那一帧可以被稳定观察（真实界面里这一段只有
  // 几十到一百毫秒，测试不能靠抢时序）。
  untrackedHold = () => undefined
  await settle()
  check('13c) 还没统计出来时给"正在统计…"', find('data-staging-untracked-browse')?.props?.['data-staging-untracked-browse'], 'pending')
  checkTrue('   文案是统计中', viewText().includes('untrackedCounting'))
  check('   「浏览」按钮此时禁用', find('data-staging-browse')?.props?.disabled, true)
  const exactCalls = requests.filter((r) => r.route === 'untracked')
  check('   自动发了**一次**精确枚举', exactCalls.length - beforeBig, 1)
  check('   请求带 exact: true', exactCalls[exactCalls.length - 1]?.body?.exact, true)
  check('   请求带工作区', exactCalls[exactCalls.length - 1]?.body?.workspace, WORKSPACE)
  check('   请求带 force（写操作之后要重数）', String(exactCalls[exactCalls.length - 1]?.body?.force ?? 'false'), 'false')
  // 统计期间再渲染几轮（模拟轮询）：在途请求只有一个，不许再发。
  await settle()
  await settle()
  check('   统计期间不重复发请求', requests.filter((r) => r.route === 'untracked').length - beforeBig, 1)
  // 放行：结果合并进快照 → 界面变成 browse 摘要（stub 返回 total=6846 / mode=browse）。
  const release = untrackedHold
  untrackedHold = null
  release()
  await settle()
  check('   合并后变成 browse 摘要', find('data-staging-untracked-browse')?.props?.['data-staging-untracked-browse'], 'browse')
  check('   合并后「浏览」可用', find('data-staging-browse')?.props?.disabled, false)
  // 已经是精确快照了：再多渲染几轮也不该再有枚举请求。
  await settle()
  await settle()
  check('   精确之后不再枚举', requests.filter((r) => r.route === 'untracked').length - beforeBig, 1)

  // ---- 13d. 「浏览」弹窗：惰性树 + 分页 + 勾选 + 加入 ----
  await click(find('data-staging-browse'))
  check('13d) 弹窗打开了', find('data-untracked-browse') !== null, 'true')
  const rootDirs = findAll('data-untracked-browse-dir').map((n) => n.props['data-untracked-browse-dir'])
  check('   根层只有 tmp 一个目录（惰性：只拿一层）', rootDirs.join(','), 'tmp')
  check('   根层文件行也没有（tmp 下没有直接文件）', findAll('data-untracked-browse-file').length, 0)
  check('   目录带后代文件数', textOf(find('data-untracked-browse-dir', 'tmp')).includes('untrackedBrowseDirCount'), 'true')
  // 展开 tmp：发一次带 prefix 的请求，只多出这一层。
  const prefixCalls = () => requests.filter((r) => r.route === 'untracked' && r.body?.prefix !== undefined)
  const beforeExpand = prefixCalls().length
  await click(find('data-untracked-browse-toggle', 'tmp'))
  check('   展开发出了 prefix 请求', prefixCalls().length - beforeExpand, 1)
  check('   带的是 tmp', prefixCalls()[prefixCalls().length - 1]?.body?.prefix, 'tmp')
  const secondLevel = findAll('data-untracked-browse-dir').map((n) => n.props['data-untracked-browse-dir'])
  check('   多出第二层目录', secondLevel.sort().join(','), 'tmp,tmp/magic-api')
  // 展开 magic-api：拿到 200 条 + 「继续加载」（分页，而不是一次几千行）。
  await click(find('data-untracked-browse-toggle', 'tmp/magic-api'))
  const filesInLeaf = findAll('data-untracked-browse-file').length
  check('   叶子层只渲染一页（200 行）', filesInLeaf, 200)
  check('   有「继续加载」', find('data-untracked-more', 'tmp/magic-api') !== null, 'true')
  const beforeMore = findAll('data-untracked-browse-file').length
  await click(find('data-untracked-more', 'tmp/magic-api'))
  check('   继续加载后多了一页', findAll('data-untracked-browse-file').length - beforeMore, 200)
  check('   请求带了 offset', requests.filter((r) => r.route === 'untracked' && r.body?.offset === 200).length >= 1, 'true')
  // 勾一个文件 → 计数 1 → 加入 git 只发这个路径。
  const firstFile = findAll('data-untracked-browse-file')[0].props['data-untracked-browse-file']
  await toggleCheck(find('data-untracked-pick', firstFile))
  check('   勾选计数为 1', find('data-untracked-count')?.props?.['data-untracked-count'], 1)
  const beforeAdd = posts.length
  await click(find('data-untracked-add'))
  check('   发出 stage', posts[posts.length - 1]?.route, 'stage')
  check('   只带勾选的那一个路径', JSON.stringify(posts[posts.length - 1]?.body?.paths), JSON.stringify([firstFile]))
  check('   加入成功后清空勾选', find('data-untracked-count')?.props?.['data-untracked-count'], 0)
  check('   加入后弹窗仍在（就地刷新）', find('data-untracked-browse') !== null, 'true')
  check('   且重取了根层', requests.filter((r) => r.route === 'untracked').length > beforeAdd, 'true')
  // 全选 → 加入 git 时**不把几千条路径发回去**，而是让 host 用完整清单。
  await click(find('data-untracked-all'))
  check('   全选后显示总数', textOf(find('data-untracked-count')).includes('untrackedBrowseAll'), 'true')
  await click(find('data-untracked-add'))
  check('   全选加入走 all: untracked', JSON.stringify(posts[posts.length - 1]?.body), JSON.stringify({ workspace: WORKSPACE, all: 'untracked' }))
  await click(find('data-untracked-none'))
  check('   清空后计数为 0', find('data-untracked-count')?.props?.['data-untracked-count'], 0)
  await click(find('data-untracked-close'))
  check('   关闭后弹窗消失', find('data-untracked-browse'), null)
}

console.log('')
console.log('=== 14. 同一个仓库的两个工作区：只有一格、一套轮询 ===')
{
  // 这一节直接测 store（不挂界面）：它是"同 repo 共享一份快照"的判据所在。
  //
  // 夹具让 `/repo-context` 对两个工作区都回答同一个仓库根，于是 `projA` 与
  // `projA\\pages` 必须落在**同一条记录**上——这正是"切目录不清空、不重扫"的前提。
  snapshotStore.reset()
  const otherWorkspace = `${WORKSPACE}\\pages`
  let ticks = 0
  const unsubA = snapshotStore.subscribe(WORKSPACE, () => { ticks += 1 })
  const unsubB = snapshotStore.subscribe(otherWorkspace, () => { ticks += 1 })
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  check('14) 两个工作区解析到同一个仓库根', snapshotStore.cellKeyFor(otherWorkspace), WORKSPACE)
  check('   两个工作区挂在同一条记录上', snapshotStore.cellKeyFor(WORKSPACE), snapshotStore.cellKeyFor(otherWorkspace))
  check('   记录数只有 1（不是每个工作区一格）', snapshotStore.cells().length, 1)
  check('   只有一套轮询', snapshotStore.cells()[0]?.polling, true)
  check('   两个订阅者都记在同一格上', snapshotStore.cells()[0]?.listeners, 2)
  checkTrue('   已经取到数据（订阅即拉一次）', snapshotStore.get(WORKSPACE)?.phase === 'ready')
  // 切工作区（同仓库）：快照**不清空**，也不换代。
  await snapshotStore.refresh(otherWorkspace)
  check('   同仓库换工作区后快照仍在', snapshotStore.get(WORKSPACE) !== undefined, true)
  check('   而且文件列表没有被清空', snapshotStore.get(WORKSPACE)?.files?.length >= 1, true)
  check('   还是同一条记录', snapshotStore.cellKeyFor(otherWorkspace), snapshotStore.cellKeyFor(WORKSPACE))
  checkTrue('   订阅回调确实被触发过（数据真的更新过）', ticks > 0)
  unsubA()
  unsubB()
  check('   全部退订后停止轮询', snapshotStore.cells()[0]?.polling, false)
}

console.log('')
console.log('=== 15. 多仓库：一次只操作 active 那一个仓库 ===')
{
  // 实机场景：工作区 `haiweiNew` 自己**不是**仓库，仓库在子目录里。因此这里给的列表里
  // 没有 `relativePath === ''` 的那一项——"工作区自己所属的仓库"这次不存在。
  snapshotStore.reset()
  const FRONTEND = `${WORKSPACE}\\haiwei-manage-fronted`
  const BACKEND = `${WORKSPACE}\\haiwei-manage-backend`
  scopeRepositories = () => [
    { repositoryRoot: FRONTEND, gitDir: `${FRONTEND}\\.git`, relativePath: 'haiwei-manage-fronted', name: 'haiwei-manage-fronted' },
    { repositoryRoot: BACKEND, gitDir: `${BACKEND}\\.git`, relativePath: 'haiwei-manage-backend', name: 'haiwei-manage-backend' },
  ]
  requests.length = 0
  posts.length = 0
  // 走一次**真实请求**（`reload`）：默认选中项只有真发请求时才看得见——直接写快照的那条
  // 路径根本不发 `/workspace`（它是夹具，不是行为）。
  await mount({ reload: true })
  check('15) 发现两个仓库', snapshotStore.cells().length, 1)
  // 用户还没选过时用的是**默认项**：列表里的第一个（没有"工作区自己所属的仓库"）。
  // 宿主侧的 `resolveScopedRepo` 用的是同一条规则，因此两边一定指向同一个仓库；这条
  // 断言同时钉住"客户端不会自己挑一个别的"。
  const firstRepo = `${WORKSPACE}\\haiwei-manage-fronted`
  check('   默认解析到列表里的第一个仓库', snapshotStore.cellKeyFor(WORKSPACE), firstRepo)
  check(
    '   而且请求带的就是那一个',
    [...new Set(requests.filter((r) => r.route === 'workspace').map((r) => r.body?.repository))].join(','),
    firstRepo,
  )

  // 用户在界面上选了 frontend（头栏里的仓库选择器就是调这一条）。
  requests.length = 0
  await snapshotStore.selectRepository(WORKSPACE, FRONTEND)
  check('   选过之后记录迁到那个仓库', snapshotStore.cellKeyFor(WORKSPACE), FRONTEND)
  check('   仍然只有一格（不是每个仓库一格）', snapshotStore.cells().length, 1)
  checkTrue('   切换后立刻就有那一份数据', snapshotStore.get(WORKSPACE)?.phase === 'ready')
  const afterFrontend = requests.filter((r) => r.route === 'workspace' || r.route === 'untracked')
  checkTrue('   之后的读请求都带上了该仓库', afterFrontend.length >= 1)
  check(
    '   每一个都带同一个 repository',
    [...new Set(afterFrontend.map((r) => r.body?.repository))].join(','),
    FRONTEND,
  )

  // 列表里的写操作（暂存一行）也必须落在同一个仓库上——"提交/暂存跨仓库"是硬禁止项。
  const stageRow = findAll('data-staging-row').find(
    (n) => n.props['data-staging-row'] === 'unstaged.txt' && n.props['data-staging-side'] === 'unstaged',
  )
  const stageButton = collectHostNodes(stageRow, 'probe').find((n) => n.props?.['data-staging-row-action'] !== undefined)
  posts.length = 0
  await click(stageButton)
  check('   暂存发到 host', posts[posts.length - 1]?.route, 'stage')
  check('   写操作也带同一个 repository', posts[posts.length - 1]?.body?.repository, FRONTEND)

  // 切到 backend：**从这一刻起**没有任何请求还带着 frontend。
  requests.length = 0
  posts.length = 0
  await snapshotStore.selectRepository(WORKSPACE, BACKEND)
  check('   切到另一个仓库后记录也换了', snapshotStore.cellKeyFor(WORKSPACE), BACKEND)
  check('   仍然只有一格', snapshotStore.cells().length, 1)
  check(
    '   切走之后不再有请求发往旧仓库',
    requests.filter((r) => r.body?.repository === FRONTEND).length,
    0,
  )
  const afterBackend = requests.filter((r) => r.route === 'workspace')
  check(
    '   新请求都带新的 repository',
    [...new Set(afterBackend.map((r) => r.body?.repository))].join(','),
    BACKEND,
  )

  // 收尾：把夹具与 store 还原，后面的断言（若有）仍在单仓库世界里。
  scopeRepositories = () => [
    { repositoryRoot: REPO_ROOT, gitDir: `${REPO_ROOT}\\.git`, relativePath: '', name: 'projA' },
  ]
  snapshotStore.reset()
}

console.log('')
console.log('=== 16. 单仓库项目：请求形状与 1.5.2 逐字一致（一个字都不多带）===')
{
  // 多仓库那一套（`repository` 参数）**绝不能**渗进单仓库：宿主侧也有测试钉着它，但那条
  // 只能证明"多带了也能工作"，证明不了"没多带"——而后者才是 1.5.2 的行为契约。
  scopeRepositories = () => [
    { repositoryRoot: REPO_ROOT, gitDir: `${REPO_ROOT}\\.git`, relativePath: '', name: 'projA' },
  ]
  snapshotStore.reset()
  requests.length = 0
  await mount({ reload: true })
  check('16) 单仓库时不带 repository', requests.filter((r) => r.body?.repository !== undefined).length, 0)
  check('   仓库根就是工作区自己', snapshotStore.cellKeyFor(WORKSPACE), REPO_ROOT)
  check('   快照正常取到', snapshotStore.get(WORKSPACE)?.phase, 'ready')
}

console.log('')
console.log('=== 17. 提交区：默认 8 行 + 顶部可拖 + 持久化（实机反馈的三条）===')
{
  // 这一节要动 `localStorage`（持久化）与 `window.PointerEvent`（拖动走 Pointer Events），
  // 因此换成可观测的版本，结束时还原——其它小节依赖的是"什么都没写过"的 stub。
  const realLocalStorage = window.localStorage
  const realPointerEvent = window.PointerEvent
  const storage = new Map()
  window.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => {
      storage.set(key, String(value))
    },
    removeItem: (key) => {
      storage.delete(key)
    },
  }
  window.PointerEvent = function PointerEvent() {}

  const card = () => find('data-staging-commit-card')
  const handle = () => find('data-staging-commit-resize')
  const messageBox = () => find('data-staging-message')
  const actions = () => find('data-staging-commit-actions')
  const heightOf = () => Number.parseFloat(String(card()?.props?.style?.height ?? '0'))
  const storedHeight = () => Number(storage.get('dsh.review.commitAreaHeight'))
  /**
   * 假 DOM 里没有布局：把"Changes 可用高度"直接喂给根节点的 ref，并派发一次 resize
   * 让组件重新测量（真实环境里这件事由布局与窗口事件完成）。
   */
  const setRoom = (room) => {
    find('data-staging').props.ref.current = { getBoundingClientRect: () => ({ height: room }) }
    emitWindow('resize', {})
  }
  /**
   * 一次完整拖动：按下 → 移动 → 松手。
   *
   * 走的是 `onPointerDown` + document 上的 `pointermove`/`pointerup`——与真实浏览器一致
   * （那里 PointerEvent 一定存在），而不是测试专用的旁路。
   */
  const drag = async (deltaY, options = {}) => {
    const startY = 600
    handle().props.onPointerDown({
      button: 0,
      clientY: startY,
      pointerId: 7,
      currentTarget: { setPointerCapture() {} },
      preventDefault() {},
    })
    if (options.onMove !== undefined) options.onMove()
    emitDocument('pointermove', { clientY: startY + deltaY })
    await settle()
    if (options.hold !== true) {
      emitDocument('pointerup', {})
      await settle()
    }
  }

  // ---- A. 默认 8 行：一条正常提交信息不用先手动拉高 ----
  await mount()
  setRoom(700)
  await settle()
  const defaultHeight = heightOf()
  check('17) 输入框默认 8 行', messageBox()?.props?.rows, 8)
  check('   输入框用 flex 填满提交区', String(messageBox()?.props?.style?.flex), '1 1 auto')
  check('   输入框最小高度归零（拖小也不会顶破布局）', String(messageBox()?.props?.style?.minHeight), '0')
  check('   输入框没有原生 resize', messageBox()?.props?.style?.resize, 'none')
  check('   默认高度按行高算出来（远高于旧版 4 行的 90px）', defaultHeight >= 200 && defaultHeight <= 260, true)
  check('   提交区顶部有高度手柄', handle() !== null, true)
  check(
    '   手柄是横向分隔条语义',
    `${handle()?.props?.role}/${handle()?.props?.['aria-orientation']}`,
    'separator/horizontal',
  )
  check('   按钮行固定不参与收缩', String(actions()?.props?.style?.flexShrink), '0')
  check('   底部留白 12px（按钮不再贴窗口底边）', card()?.props?.style?.paddingBottom, '12px')
  check(
    '   左右各留白 8px',
    `${card()?.props?.style?.paddingLeft}/${card()?.props?.style?.paddingRight}`,
    '8px/8px',
  )

  // ---- B. 往上拖：提交区变高，且松手前不落盘 ----
  const beforeUp = heightOf()
  await drag(-80, {
    hold: true,
    onMove: () => {
      check('   拖动期间给 body 打标记（禁选文本）', document.body.dataset.reviewDragging, '1')
      check('   纵向拖动用 ns-resize 光标', document.body.dataset.reviewDraggingAxis, 'vertical')
    },
  })
  check('   往上拖 80px → 提交区高 80px', heightOf() - beforeUp, 80)
  check('   松手前不落盘', storage.has('dsh.review.commitAreaHeight'), false)
  emitDocument('pointerup', {})
  await settle()
  check('   松手后清掉拖动标记', document.body.dataset.reviewDragging, undefined)
  check('   松手后才落盘', storedHeight(), heightOf())

  // ---- C. 往下拖：不能低于下限（约 4 行 + 按钮行） ----
  await drag(1000)
  check('   往下拖超过下限 → 停在最小高度', heightOf(), 148)
  check('   最小高度仍放得下 4 行正文', heightOf() >= 140, true)

  // ---- D. 往上拖很多：不能超过上限（给主区留位置） ----
  await drag(-5000)
  check('   往上拖很多 → 停在允许上限', heightOf(), 455)
  check('   上限按"容器 65% / 视口 55%"里更小的那个', heightOf() <= 455, true)

  // ---- E. 双击手柄复位 ----
  handle().props.onDoubleClick()
  await settle()
  check('   双击复位到默认高度', heightOf(), defaultHeight)
  check('   并清掉持久化记录', storage.has('dsh.review.commitAreaHeight'), false)

  // ---- F. 重开抽屉继续用用户的高度 ----
  await drag(-40)
  const kept = heightOf()
  check('   拖过的值已落盘', storedHeight(), kept)
  await mount()
  setRoom(700)
  await settle()
  check('   重新打开后仍是用户的高度', heightOf(), kept)

  // ---- G. 窗口变小：自动夹取，绝不把主区吃光 ----
  window.innerHeight = 400
  setRoom(300)
  await settle()
  check('   窗口变矮后自动夹取（不超过视口 55%）', heightOf() <= 220, true)
  // 容器不算高时，"给主区留 200px"这条约束必须真的生效——它是三项里最小的那个：
  // 视口 55%（2000 → 1100）、容器 65%（400 → 260）、留白（400 − 200 = 200）。
  window.innerHeight = 2000
  setRoom(400)
  await settle()
  check('   上限取"可用高度 − 200"（65% 更大时）', heightOf(), 200)
  check('   因此主区至少留下 200px', 400 - heightOf() >= 200, true)
  setRoom(1300)
  await settle()
  window.innerHeight = 900
  emitWindow('resize', {})
  await settle()
  check('   换回大窗口后仍是用户拖过的值（夹取不覆盖选择）', heightOf(), kept)

  // ---- J. AI 填入的多行提交信息不会被拖动弄丢 ----
  await mount()
  await click(find('data-staging-ai'))
  const generated = messageBox()?.props?.value
  check('   前置：AI 已填入多行提交信息', generated === aiResponse.message, true)
  await drag(-30)
  check('   拖动后内容原样保留', messageBox()?.props?.value, generated)
  check('   而且仍是同一个 8 行输入框', messageBox()?.props?.rows, 8)

  // ---- K. Ctrl+Enter 仍然提交 ----
  posts.length = 0
  messageBox().props.onKeyDown({ key: 'Enter', ctrlKey: true, preventDefault() {}, stopPropagation() {} })
  await settle()
  checkTrue('   Ctrl+Enter 仍然提交', posts.some((p) => p.route === 'commit'))

  window.localStorage = realLocalStorage
  window.PointerEvent = realPointerEvent
}

console.log('')
console.log('=== 19. 修改最后一次提交（amend）与撤销最后一次提交 ===')
{
  /**
   * 这两条都是**历史操作**，因此断言的重点是"信息从哪来、请求发什么"：
   *   * amend 开启时去宿主读 HEAD 的完整信息并填进输入框，同时拿到"是否已发布"；
   *   * 已发布的提交要**确认一次**（需求允许，但只一次）；未发布的直接执行；
   *   * 撤销提交 = `reset --soft <父提交>`，并且把提交信息填回输入框。
   */
  const messageBox = () => find('data-staging-message')
  /** 触发受控输入框的 onChange。 */
  const typeMessage = async (value) => {
    messageBox()?.props?.onChange({ target: { value } })
    await settle()
  }
  /** 切换「修改最后一次提交」（受控 checkbox 的 onChange）。 */
  const toggleAmend = async (next) => {
    find('data-staging-amend')?.props?.onChange({ target: { checked: next } })
    await settle()
  }

  await mount()
  const amendBox = find('data-staging-amend')
  checkTrue('19) 提交区有「修改最后一次提交」开关', amendBox !== null)
  check('   默认关闭', amendBox?.props?.['data-staging-amend-state'], 'off')
  checkTrue('   也有「撤销最后一次提交」', find('data-staging-undo-commit') !== null)

  // ---- A. 打开 amend：自动读取 HEAD 的信息 ----
  requests.length = 0
  headCommit = { ...headCommit, published: false, upstream: '', head: { ...headCommit.head, message: 'Fix login bug\n\n详细说明' } }
  await toggleAmend(true)
  check('   去宿主读了 HEAD', requests.filter((entry) => entry.route === 'gitbar:head-commit').length, 1)
  check('   提交信息被自动填入', messageBox()?.props?.value, 'Fix login bug\n\n详细说明')
  check('   开关状态是开', find('data-staging-amend')?.props?.['data-staging-amend-state'], 'on')
  check('   横幅说明在改哪一条', String(find('data-staging-amend-banner')?.props?.['data-staging-amend-banner']), 'a'.repeat(40))
  checkTrue('   横幅带标题（文案键，本文件的 t 不做插值）', textOf(find('data-staging-amend-banner')).includes('amendBanner'))
  check('   未发布时不出现警告', find('data-staging-amend-published'), null)

  // ---- B. 未发布：点提交就是 amend（不再多问一次） ----
  posts.length = 0
  await click(find('data-staging-commit'))
  const amendCall = posts.filter((entry) => entry.route === 'commit').pop()
  check('   发到 review 的 commit', amendCall !== undefined, true)
  check('   带 amend 标记', amendCall?.body?.amend, true)
  check('   带当前输入框里的信息', amendCall?.body?.message, 'Fix login bug\n\n详细说明')
  checkTrue('   未发布时没有确认框', find('data-staging-amend-dialog') === null)
  checkTrue('   成功后提示"已修改"', textOf(find('data-staging-notice')).includes('amendedNotice'))
  check('   成功后开关复位', find('data-staging-amend')?.props?.['data-staging-amend-state'], 'off')

  // ---- C. 关掉开关要把用户原来的草稿还回来 ----
  await typeMessage('我的草稿')
  await toggleAmend(true)
  check('   开启后被 HEAD 的信息替换', messageBox()?.props?.value, 'Fix login bug\n\n详细说明')
  await toggleAmend(false)
  check('   关闭后草稿回来了', messageBox()?.props?.value, '我的草稿')

  // ---- D. 已发布：必须确认一次（而且只有一次） ----
  headCommit = { ...headCommit, published: true, upstream: 'origin/main' }
  await toggleAmend(true)
  check('   已发布时横幅给出警告', String(find('data-staging-amend-published')?.props?.['data-staging-amend-published']), 'origin/main')
  posts.length = 0
  await click(find('data-staging-commit'))
  check('   未确认前不发 amend', posts.filter((entry) => entry.route === 'commit').length, 0)
  const dialog = find('data-staging-amend-dialog', 'origin/main')
  checkTrue('   弹出确认框', dialog !== null)
  checkTrue('   正文说明会改写已发布历史', textOf(dialog).includes('amendConfirmBody'))
  checkTrue('   并说明之后只能 force-with-lease', textOf(dialog).includes('amendConfirmForceHint'))
  posts.length = 0
  await click(find('data-staging-amend-confirm'))
  const confirmed = posts.filter((entry) => entry.route === 'commit').pop()
  check('   确认后才发 amend', confirmed?.body?.amend, true)
  checkTrue('   提示变成"已修改"', textOf(find('data-staging-notice')).includes('amendedNotice'))

  // ---- E. 取消：什么都不发 ----
  await toggleAmend(true)
  posts.length = 0
  await click(find('data-staging-commit'))
  await click(find('data-staging-amend-cancel'))
  check('   取消后不发任何提交', posts.filter((entry) => entry.route === 'commit').length, 0)
  checkTrue('   确认框已关闭', find('data-staging-amend-dialog') === null)
  await toggleAmend(false)

  // ---- F. 宿主说"没什么可改的"：错误短句要落在提交区 ----
  // 先回到"未发布"：已发布的提交点提交会先弹确认框（上一节刚验证过），这里的重点是错误映射。
  headCommit = { ...headCommit, published: false, upstream: '' }
  writeError = { error: 'nothing to amend', code: 'nothingToAmend', detail: 'nothing changed' }
  await toggleAmend(true)
  await click(find('data-staging-commit'))
  check('   显示专门短句', find('data-staging-error')?.props?.['data-staging-error'], 'nothingToAmend')
  checkTrue('   提示是可读的键名', textOf(find('data-staging-error')).includes('error_nothingToAmend'))
  writeError = null
  await toggleAmend(false)

  // ---- G. 撤销最后一次提交：soft reset 到父提交，信息填回输入框 ----
  requests.length = 0
  headCommit = { ...headCommit, head: { ...headCommit.head, subject: '刚提交的东西', message: '刚提交的东西' } }
  await click(find('data-staging-undo-commit'))
  const resetCall = requests.filter((entry) => entry.route === 'gitbar:reset').pop()
  check('   走 gitbar 的 reset', resetCall !== undefined, true)
  check('   模式是 soft（绝不是 hard）', resetCall?.body?.mode, 'soft')
  check('   目标是 HEAD 的父提交', resetCall?.body?.revision, 'b'.repeat(40))
  check('   不带破坏性确认', resetCall?.body?.acknowledgeDestructive, undefined)
  check('   提交信息被填回输入框', messageBox()?.props?.value, '刚提交的东西')
  checkTrue('   提示说明改动仍在暂存区', textOf(find('data-staging-notice')).includes('undoneNotice'))

  // ---- H. 第一个提交（没有父提交）：走 root 那条路 ----
  headCommit = { ...headCommit, head: { ...headCommit.head, parents: [], subject: 'initial', message: 'initial' } }
  requests.length = 0
  await click(find('data-staging-undo-commit'))
  const rootCall = requests.filter((entry) => entry.route === 'gitbar:reset').pop()
  check('   root 撤销带 root 标记', rootCall?.body?.root, true)
  check('   而且仍然带 mode=soft', rootCall?.body?.mode, 'soft')
  check('   不带 revision（没有父提交可指向）', rootCall?.body?.revision, undefined)
}

console.log('')
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
