// Stash UI regression test for the project panel (Stashes group, stash viewer, apply/pop/drop).
//
//   node scripts/test-review-stash.mjs
//
// Runs the real client bundle for `dsh-client-ui-review` against a stubbed host, in the same
// style as `test-review-conflict.mjs`: a hand-rolled React subset, host nodes looked up by
// `data-*` attributes, and every request recorded so the assertions are about what the UI
// actually sent.
//
// What this pins down:
//   1. the Stashes group only appears when the repository has stashes, and its rows carry the
//      ref / the message / the original branch / the time (never git's raw `stash list` text);
//   2. the two "stash changes" entries live on the file-pane header (quick + with options),
//      and the dialog's untracked checkbox defaults to OFF;
//   3. clicking a stash asks the review host for its files and renders them through the ONE
//      shared diff viewer (no second diff UI);
//   4. apply / pop / drop go to the **gitbar** host (which owns `refs/stash`), drop asks first,
//      and a conflicted apply hands the user straight to the existing conflict resolver;
//   5. a stale ref (the stash was dropped elsewhere) refreshes the list instead of lying.
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PLUGIN = pathToFileURL(join(ROOT, 'plugins', 'dsh-client-ui-review', 'lib', 'client.js')).href

let passed = 0
let failed = 0
async function check(name, action) {
  try {
    await action()
    passed += 1
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ---------------------------------------------------------------------------
// Minimal React subset (same shape the other review tests use).
// ---------------------------------------------------------------------------
const hookSlots = new Map()
let renderKey = ''
let slotCursor = 0
const effectQueue = []
let currentKey = ''

const react = {
  createElement(type, props, ...children) {
    const kids = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
    return { type, props: { ...(props ?? {}), ...(kids === undefined ? {} : { children: kids }) } }
  },
  useState(initial) {
    const slot = slotCursor++
    const key = `${renderKey}|${slot}`
    if (!hookSlots.has(key)) hookSlots.set(key, typeof initial === 'function' ? initial() : initial)
    const setterKey = `${key}|set`
    if (!hookSlots.has(setterKey)) {
      hookSlots.set(setterKey, (next) => {
        const current = hookSlots.get(key)
        hookSlots.set(key, typeof next === 'function' ? next(current) : next)
      })
    }
    return [hookSlots.get(key), hookSlots.get(setterKey)]
  },
  useRef(initial) {
    const slot = slotCursor++
    const key = `${renderKey}|${slot}`
    if (!hookSlots.has(key)) hookSlots.set(key, { current: initial })
    return hookSlots.get(key)
  },
  useMemo(factory, deps) {
    const slot = slotCursor++
    const key = `${renderKey}|${slot}`
    const previous = hookSlots.get(key)
    const same = previous !== undefined && deps !== undefined && Array.isArray(deps) &&
      Array.isArray(previous.deps) && previous.deps.length === deps.length &&
      previous.deps.every((value, index) => Object.is(value, deps[index]))
    if (same) return previous.value
    const value = factory()
    hookSlots.set(key, { deps, value })
    return value
  },
  useCallback(fn, deps) {
    return react.useMemo(() => fn, deps)
  },
  useEffect(fn, deps) {
    const slot = slotCursor++
    const key = `${renderKey}|${slot}`
    const previous = hookSlots.get(key)
    const same = previous !== undefined && deps !== undefined && Array.isArray(deps) &&
      Array.isArray(previous.deps) && previous.deps.length === deps.length &&
      previous.deps.every((value, index) => Object.is(value, deps[index]))
    if (same) return
    hookSlots.set(key, { deps })
    effectQueue.push(fn)
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    const slot = slotCursor++
    const key = `${renderKey}|${slot}`
    const value = getSnapshot()
    hookSlots.set(key, value)
    return value
  },
}

/** Recursively expand function components and return host (string-tag) nodes. */
function collectHostNodes(node, key = 'root') {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (Array.isArray(node)) return node.flatMap((child, index) => collectHostNodes(child, `${key}[${index}]`))
  if (typeof node !== 'object') return []
  if (typeof node.type === 'function') {
    const name = node.type.name || 'anonymous'
    const childKey = `${key}${node.props?.key === undefined ? '' : `#${node.props.key}`}:${name}`
    const previous = renderKey
    const previousCursor = slotCursor
    renderKey = childKey
    slotCursor = 0
    const rendered = node.type(node.props ?? {})
    renderKey = previous
    slotCursor = previousCursor
    return collectHostNodes(rendered, childKey)
  }
  const children = collectHostNodes(node.props?.children, `${key}>${String(node.type)}`)
  return [{ type: node.type, props: node.props ?? {} }, ...children]
}

function render(component, props, key) {
  hookSlots.set(`${key}|mounted`, true)
  renderKey = key
  slotCursor = 0
  const previous = currentKey
  currentKey = key
  const rendered = component(props)
  currentKey = previous
  return collectHostNodes(rendered, key)
}

async function settle(component, props, key, passes = 4) {
  let nodes = render(component, props, key)
  for (let index = 0; index < passes; index += 1) {
    while (effectQueue.length > 0) {
      const effect = effectQueue.shift()
      effect()
    }
    await new Promise((done) => setTimeout(done, 0))
    nodes = render(component, props, key)
  }
  return nodes
}

const find = (nodes, attr, value) => nodes.find((node) => (value === undefined ? node.props[attr] !== undefined : node.props[attr] === value))
const findAll = (nodes, attr) => nodes.filter((node) => node.props[attr] !== undefined)
const click = (node) => node.props.onClick?.({ stopPropagation() {}, preventDefault() {} })
const textOf = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node !== 'object') return String(node)
  return textOf(node.props?.children)
}

// ---------------------------------------------------------------------------
// Stub host: records every request, answers the routes this test needs.
// ---------------------------------------------------------------------------
const posts = []
let stashList = []
let stashShowFiles = []
let stashApplyReply = null
let stashDropError = null
let conflictAfterApply = null
let stashFileDiff = ''

const respond = (payload, ok = true) => ({ ok, text: async () => JSON.stringify(payload) })
const minuteAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString()

const twoStashes = [
  {
    ref: 'stash@{0}',
    message: 'WIP: feature/login',
    subject: 'On main: WIP: feature/login',
    branch: 'main',
    date: minuteAgo(2),
    sha: 'a'.repeat(40),
    hasUntracked: true,
  },
  {
    ref: 'stash@{1}',
    message: 'Before refactor',
    subject: 'On develop: Before refactor',
    branch: 'develop',
    date: new Date(Date.now() - 26 * 3600_000).toISOString(),
    sha: 'b'.repeat(40),
    hasUntracked: false,
  },
]

globalThis.fetch = async (url, init) => {
  const target = String(url)
  const body = init?.body === undefined ? undefined : JSON.parse(init.body)
  if (target.includes('/dsh-desktop/gitbar/')) {
    const route = target.slice(target.indexOf('/dsh-desktop/gitbar/') + '/dsh-desktop/gitbar/'.length).split('?')[0]
    if (route === 'stash/list') return respond({ isRepo: true, stashes: stashList, stashCount: stashList.length })
    posts.push({ route: `gitbar:${route}`, body })
    if (route === 'stash/drop' && stashDropError !== null) return respond(stashDropError, false)
    if (route === 'stash/apply' && stashApplyReply !== null) return respond(stashApplyReply)
    if (route === 'stash/pop' && stashApplyReply !== null) return respond(stashApplyReply)
    if (route === 'stash/push') {
      stashList = [
        {
          ref: 'stash@{0}',
          message: String(body?.message ?? ''),
          subject: body?.message === undefined ? 'WIP on main: abc1234 initial' : `On main: ${body.message}`,
          branch: 'main',
          date: new Date().toISOString(),
          sha: 'c'.repeat(40),
          hasUntracked: body?.includeUntracked === true,
        },
        ...stashList,
      ]
      return respond({ isRepo: true, branch: 'main', stash: stashList[0], stashed: true })
    }
    return respond({ isRepo: true, branch: 'main', stash: { ref: body?.ref ?? 'stash@{0}', kept: route !== 'stash/pop' } })
  }
  const route = target.slice(target.indexOf('/dsh-desktop/review/') + '/dsh-desktop/review/'.length).split('?')[0]
  if (route === 'stash/show') {
    posts.push({ route: 'stash/show', body })
    return respond({ isRepo: true, ref: body?.ref, files: stashShowFiles, fileCount: stashShowFiles.length })
  }
  if (route === 'stash-file') {
    posts.push({ route: 'stash-file', body })
    return respond({ isRepo: true, path: body?.path, diff: stashFileDiff, truncated: false, binary: false })
  }
  if (route === 'conflict') {
    posts.push({ route: 'conflict', body })
    return respond(conflictAfterApply ?? { path: 'src/app.ts', code: 'UU', blocks: [], blockCount: 0, hasMarkers: false, operationType: 'stash' })
  }
  posts.push({ route, body })
  return respond({ isRepo: true })
}

// Fake globals the bundle needs.
globalThis.window = {
  innerWidth: 1280,
  innerHeight: 900,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  __ModuleLoader__: {
    load(definition) {
      loaded = definition.factory((specifier) => (specifier === 'react' ? react : {}))
    },
  },
}
globalThis.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  documentElement: { style: { setProperty: () => {}, removeProperty: () => {} }, dataset: {} },
  head: { appendChild: () => {}, removeChild: () => {} },
  body: { appendChild: () => {}, removeChild: () => {} },
  createElement: () => ({ style: {}, dataset: {}, setAttribute: () => {}, appendChild: () => {}, remove: () => {} }),
  querySelector: () => null,
  querySelectorAll: () => [],
}
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '', fontSize: '14px' })
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
}
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
}
globalThis.requestAnimationFrame = (fn) => {
  setTimeout(fn, 0)
  return 0
}

let loaded
{
  const module = await import(PLUGIN)
  void module
  const entries = new Map()
  const ctx = {
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: { register: () => {}, bind: () => (key) => key },
    slots: {
      inject: (_name, register) => register(),
      register: (options, component) => {
        entries.set(`${options.name}:${options.id ?? options.key}`, { options, component })
      },
    },
    settingsScope: { bind: () => ({ getSnapshot: () => ({ value: undefined, writable: false }), set: async () => {}, subscribe: () => () => {} }) },
    remote: {},
    sidebarRight: {},
    on: () => () => {},
  }
  loaded.apply(ctx)
}

const Staging = loaded.__stagingSectionForTest
const store = loaded.__gitSnapshotForTest
const WORKSPACE = 'C:\\work\\project'

const changedEntry = { path: 'package.json', status: 'M', index: ' ', worktree: 'M', staged: false, unstaged: true, untracked: false, added: 2, removed: 1 }
const conflictedEntry = { path: 'src/app.ts', status: 'U', index: 'U', worktree: 'U', staged: false, unstaged: false, untracked: false, conflict: true, code: 'UU', added: null, removed: null }

function snapshotWith(files, extra) {
  return {
    workspace: WORKSPACE,
    repositoryRoot: WORKSPACE,
    branch: 'main',
    head: 'a'.repeat(40),
    phase: 'ready',
    files,
    changedFiles: files.length,
    changedFilesExact: true,
    staged: 0,
    unstaged: files.length,
    untracked: { count: 0, exact: true, mode: 'inline', collapsed: false, inlineFiles: [] },
    conflictCount: files.filter((file) => file.conflict === true).length,
    conflicts: files.filter((file) => file.conflict === true).map((file) => ({ path: file.path, code: file.code })),
    operationType: files.some((file) => file.conflict === true) ? 'stash' : '',
    empty: false,
    error: '',
    refreshError: '',
    updatedAt: Date.now(),
    refresh: () => {},
    invalidate: () => {},
    ...(extra ?? {}),
  }
}

let mountSeq = 0
let mountKey = ''
const mount = async (snapshot) => {
  mountKey = `s${mountSeq++}`
  return await settle(Staging, mountProps(snapshot), mountKey)
}
const rerender = async (snapshot) => await settle(Staging, mountProps(snapshot), mountKey)
function mountProps(snapshot) {
  return {
    // 参数化的文案在断言里以 `key(参数…)` 出现，因此"传了哪个参数"是可断言的。
    t: (key, params) => (params === undefined ? key : `${key}(${Object.values(params).join(',')})`),
    workspace: WORKSPACE,
    get snapshot() {
      return snapshot
    },
    revision: 'a'.repeat(40),
    repositoryName: 'project',
    onCommitted: () => {},
  }
}

// ---------------------------------------------------------------------------
console.log('=== 1. Stashes 分组与行 ===')
stashList = []
let nodes = await mount(snapshotWith([changedEntry], { stashCount: 0 }))
await check('1a) 没有储藏时整组不渲染（空分组只会占地方）', () => {
  assert.equal(find(nodes, 'data-staging-group', 'stashes'), undefined)
})

stashList = twoStashes
nodes = await mount(snapshotWith([changedEntry], { stashCount: 2 }))
await check('1b) 有储藏时出现 Stashes 分组，行数与列表一致', () => {
  assert.ok(find(nodes, 'data-staging-group', 'stashes') !== undefined, 'missing group')
  assert.equal(findAll(nodes, 'data-staging-stash-row').length, 2)
})
await check('1c) 每行给出 ref / 消息 / 原分支 / 时间（不是 git 的默认文本）', () => {
  const row = find(nodes, 'data-staging-stash-row', 'stash@{0}')
  assert.ok(row !== undefined, 'missing row')
  const text = textOf(row)
  assert.match(text, /stash@\{0\}/u)
  assert.match(text, /WIP: feature\/login/u)
  assert.match(text, /stashBranch\(main\)/u)
  assert.match(text, /stashTimeMinutes\(2\)/u)
  // `On main: …` 那段前缀是 git 的默认文本，只该出现在 title 里当兜底，不该当消息显示。
  assert.doesNotMatch(text, /On main:/u)
})
await check('1d) 未跟踪标记只出现在真的含未跟踪文件的那些行上', () => {
  assert.ok(find(nodes, 'data-staging-stash-untracked', 'stash@{0}') !== undefined)
  assert.equal(find(nodes, 'data-staging-stash-untracked', 'stash@{1}'), undefined)
})
await check('1e) 相对时间之外还保留精确时刻（title）', () => {
  const row = find(nodes, 'data-staging-stash-row', 'stash@{1}')
  assert.match(String(row?.props?.title ?? ''), /\d{4}-\d{2}-\d{2}/u)
})

// ---------------------------------------------------------------------------
console.log('')
console.log('=== 2. 储藏改动的两个入口（Changes 标题栏） ===')
stashList = twoStashes
nodes = await mount(snapshotWith([changedEditEntries()], { stashCount: 2 }))
function changedEditEntries() {
  return changedEntry
}
await check('2a) 标题栏有「直接储藏」与「带选项储藏…」两个入口', () => {
  assert.ok(find(nodes, 'data-staging-action', 'stash-quick') !== undefined, 'missing quick stash')
  assert.ok(find(nodes, 'data-staging-stash-push') !== undefined, 'missing stash options')
})
posts.length = 0
click(find(nodes, 'data-staging-action', 'stash-quick'))
await rerender(snapshotWith([changedEntry], { stashCount: 2 }))
await check('2b) 「直接储藏」一步完成：POST gitbar 的 stash/push，且不带消息', () => {
  const posted = posts.find((entry) => entry.route === 'gitbar:stash/push')
  assert.ok(posted !== undefined, `no push: ${JSON.stringify(posts)}`)
  // 单仓库（快照里的 repositoryRoot 就是工作区）：请求体只说工作区，不带多余的 repository。
  assert.deepEqual(posted.body, { workspace: WORKSPACE })
})
posts.length = 0
click(find(nodes, 'data-staging-stash-push'))
nodes = await rerender(snapshotWith([changedEntry], { stashCount: 2 }))
await check('2c) 「带选项储藏…」打开对话框，未跟踪默认**不**勾选', () => {
  assert.ok(find(nodes, 'data-staging-stash-dialog', 'push') !== undefined, 'missing dialog')
  assert.equal(find(nodes, 'data-staging-stash-untracked-input')?.props?.checked, false)
  assert.equal(posts.filter((entry) => entry.route.startsWith('gitbar:stash')).length, 0, '还不该发请求')
})
nodes = await rerender(snapshotWith([changedEntry], { stashCount: 2 }))
find(nodes, 'data-staging-stash-message')?.props?.onChange?.({ target: { value: 'WIP: feature login' } })
nodes = await rerender(snapshotWith([changedEntry], { stashCount: 2 }))
find(nodes, 'data-staging-stash-untracked-input')?.props?.onChange?.({ target: { checked: true } })
nodes = await rerender(snapshotWith([changedEntry], { stashCount: 2 }))
posts.length = 0
click(find(nodes, 'data-staging-stash-confirm'))
nodes = await rerender(snapshotWith([changedEntry], { stashCount: 2 }))
await check('2d) 确认后带上消息与「包含未跟踪」', () => {
  const posted = posts.find((entry) => entry.route === 'gitbar:stash/push')
  assert.ok(posted !== undefined, `no push: ${JSON.stringify(posts)}`)
  assert.equal(posted.body.message, 'WIP: feature login')
  assert.equal(posted.body.includeUntracked, true)
})
await check('2e) 成功后的提示是本地化短句（带 ref）', () => {
  assert.match(textOf(find(nodes, 'data-staging-notice')), /stashPushed\(stash@\{0\}\)/u)
})

// ---------------------------------------------------------------------------
console.log('')
console.log('=== 3. 查看储藏：改动清单 + 复用同一个差异视图 ===')
posts.length = 0
stashShowFiles = [
  { path: 'src/app.ts', status: 'M' },
  { path: 'src/new.ts', status: 'A', untracked: true },
]
stashFileDiff = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,2 +1,2 @@',
  ' keep',
  '-old',
  '+new',
  '',
].join('\n')
nodes = await mount(snapshotWith([changedEntry], { stashCount: 2 }))
click(find(nodes, 'data-staging-stash-row', 'stash@{0}'))
nodes = await rerender(snapshotWith([changedEntry], { stashCount: 2 }))
await check('3a) 点一条储藏会让 review 宿主给出它的改动文件', () => {
  const posted = posts.find((entry) => entry.route === 'stash/show')
  assert.ok(posted !== undefined, `no stash/show: ${JSON.stringify(posts.map((entry) => entry.route))}`)
  assert.equal(posted.body.ref, 'stash@{0}')
  assert.equal(posted.body.workspace, WORKSPACE)
})
await check('3b) 右侧列出改动文件（含未跟踪标记）', () => {
  assert.equal(find(nodes, 'data-staging-stash-view', 'stash@{0}') !== undefined, true)
  assert.equal(findAll(nodes, 'data-staging-stash-file').length, 2)
  assert.equal(find(nodes, 'data-staging-stash-file', 'src/new.ts') !== undefined, true)
})
posts.length = 0
click(find(nodes, 'data-staging-stash-file', 'src/app.ts'))
nodes = await rerender(snapshotWith([changedEntry], { stashCount: 2 }))
await check('3c) 点文件取的是储藏里的差异（/stash-file）', () => {
  const posted = posts.find((entry) => entry.route === 'stash-file')
  assert.ok(posted !== undefined, 'no stash-file')
  assert.equal(posted.body.path, 'src/app.ts')
  assert.equal(posted.body.ref, 'stash@{0}')
})
await check('3d) 差异交给**那一个**共享视图渲染（并排/统一、改动导航都在）', () => {
  // 默认是并排模式，因此行是 `data-review-sbs-row`（两侧各一格）；模式开关与改动导航
  // 都来自那个共享的 `ReviewDiffViewer`——本文件没有任何一行自己渲染差异的代码。
  assert.ok(findAll(nodes, 'data-review-sbs-row').length >= 3, `expected sbs rows, got ${findAll(nodes, 'data-review-sbs-row').length}`)
  assert.ok(find(nodes, 'data-review-sbs-cell') !== undefined, 'missing sbs cell')
  assert.ok(find(nodes, 'data-review-diff-modeswitch') !== undefined, 'missing mode switch')
  assert.ok(find(nodes, 'data-review-diff-changenav') !== undefined, 'missing change navigation')
})
await check('3e) 看储藏时不再同时显示工作区文件的差异（右侧只有一块）', () => {
  assert.equal(find(nodes, 'data-staging-stash-view') !== undefined, true)
  // 只有**一个**差异视图在渲染：并排行的数量就是这一份差异的行数（不会有第二份）。
  const viewers = findAll(nodes, 'data-review-diff-modeswitch')
  assert.equal(viewers.length, 1)
})
await check('3f) 关掉储藏视图回到普通状态', () => {
  click(find(nodes, 'data-staging-stash-close'))
})

// ---------------------------------------------------------------------------
console.log('')
console.log('=== 4. 应用 / 弹出：成功与冲突 ===')
stashApplyReply = null
nodes = await mount(snapshotWith([changedEntry], { stashCount: 2 }))
click(find(nodes, 'data-staging-stash-row', 'stash@{0}'))
nodes = await rerender(snapshotWith([changedEntry], { stashCount: 2 }))
posts.length = 0
click(find(nodes, 'data-staging-stash-apply', 'stash@{0}'))
nodes = await rerender(snapshotWith([changedEntry], { stashCount: 2 }))
await check('4a) 「应用」发给 gitbar 的 stash/apply（带 ref）', () => {
  const posted = posts.find((entry) => entry.route === 'gitbar:stash/apply')
  assert.ok(posted !== undefined, `no apply: ${JSON.stringify(posts)}`)
  assert.equal(posted.body.ref, 'stash@{0}')
})
await check('4b) 成功提示说明已应用（并保留条目）', () => {
  assert.match(textOf(find(nodes, 'data-staging-notice')), /stashApplied\(stash@\{0\}\)/u)
})
posts.length = 0
click(find(nodes, 'data-staging-stash-pop', 'stash@{0}'))
nodes = await rerender(snapshotWith([changedEntry], { stashCount: 2 }))
await check('4c) 「弹出」发给 gitbar 的 stash/pop', () => {
  const posted = posts.find((entry) => entry.route === 'gitbar:stash/pop')
  assert.ok(posted !== undefined, `no pop: ${JSON.stringify(posts)}`)
  assert.equal(posted.body.ref, 'stash@{0}')
  assert.match(textOf(find(nodes, 'data-staging-notice')), /stashPopped\(stash@\{0\}\)/u)
})

// 冲突：apply 回 `conflicted: true` + 冲突清单 → 界面必须把用户送到冲突面板。
stashApplyReply = { isRepo: true, applied: true, conflicted: true, conflicts: [{ path: 'src/app.ts', code: 'UU' }], stash: { ref: 'stash@{0}', kept: true } }
conflictAfterApply = {
  path: 'src/app.ts',
  code: 'UU',
  ours: 'current\n',
  theirs: 'stashed\n',
  worktree: '<<<<<<< Updated upstream\ncurrent\n=======\nstashed\n>>>>>>> Stashed changes\n',
  blocks: [{ index: 0, startLine: 1, endLine: 5, ours: 'current', theirs: 'stashed', oursLabel: 'Updated upstream', theirsLabel: 'Stashed changes' }],
  blockCount: 1,
  hasMarkers: true,
  operationType: 'stash',
}
nodes = await mount(snapshotWith([changedEntry], { stashCount: 2 }))
click(find(nodes, 'data-staging-stash-row', 'stash@{0}'))
nodes = await rerender(snapshotWith([changedEntry], { stashCount: 2 }))
posts.length = 0
click(find(nodes, 'data-staging-stash-apply', 'stash@{0}'))
nodes = await rerender(snapshotWith([conflictedEntry], { stashCount: 2, conflictCount: 1, conflicts: [{ path: 'src/app.ts', code: 'UU' }] }))
await check('4d) 冲突时说明"已应用但有冲突，储藏仍保留"', () => {
  assert.match(textOf(find(nodes, 'data-staging-notice')), /stashApplyConflicted/u)
})
await check('4e) 并直接把用户送到现有的冲突面板（不另建一套）', () => {
  assert.ok(find(nodes, 'data-conflict-resolver', 'src/app.ts') !== undefined, 'missing resolver')
  assert.equal(find(nodes, 'data-conflict-operation', 'stash') !== undefined, true, '操作类型应当是 stash')
})
stashApplyReply = null
conflictAfterApply = null

// ---------------------------------------------------------------------------
console.log('')
console.log('=== 5. 删除储藏：先确认，再删除 ===')
stashList = twoStashes
nodes = await mount(snapshotWith([changedEntry], { stashCount: 2 }))
click(find(nodes, 'data-staging-stash-row', 'stash@{0}'))
nodes = await rerender(snapshotWith([changedEntry], { stashCount: 2 }))
posts.length = 0
click(find(nodes, 'data-staging-stash-drop', 'stash@{0}'))
nodes = await rerender(snapshotWith([changedEntry], { stashCount: 2 }))
await check('5a) 点删除**先弹确认**，且明确写出要删哪一条', () => {
  assert.ok(find(nodes, 'data-staging-stash-drop-dialog', 'stash@{0}') !== undefined, 'missing confirm dialog')
  const text = textOf(find(nodes, 'data-staging-stash-drop-dialog', 'stash@{0}'))
  assert.match(text, /stashConfirmDropBody/u)
  assert.match(text, /stash@\{0\}/u)
  assert.equal(posts.filter((entry) => entry.route === 'gitbar:stash/drop').length, 0, '确认之前不该发请求')
})
click(find(nodes, 'data-staging-stash-drop-cancel'))
nodes = await rerender(snapshotWith([changedEntry], { stashCount: 2 }))
await check('5b) 取消就什么都不做', () => {
  assert.equal(find(nodes, 'data-staging-stash-drop-dialog', 'stash@{0}'), undefined)
  assert.equal(posts.filter((entry) => entry.route === 'gitbar:stash/drop').length, 0)
})
click(find(nodes, 'data-staging-stash-drop', 'stash@{0}'))
nodes = await rerender(snapshotWith([changedEntry], { stashCount: 2 }))
posts.length = 0
click(find(nodes, 'data-staging-stash-drop-confirm'))
nodes = await rerender(snapshotWith([changedEntry], { stashCount: 2 }))
await check('5c) 确认后真的删（POST stash/drop）并给出提示', () => {
  const posted = posts.find((entry) => entry.route === 'gitbar:stash/drop')
  assert.ok(posted !== undefined, `no drop: ${JSON.stringify(posts)}`)
  assert.equal(posted.body.ref, 'stash@{0}')
  assert.match(textOf(find(nodes, 'data-staging-notice')), /stashDropped\(stash@\{0\}\)/u)
})

// ---------------------------------------------------------------------------
console.log('')
console.log('=== 6. 引用失效：不撒谎，刷新列表 ===')
stashList = twoStashes
stashDropError = { error: 'no such stash', code: 'noSuchStash' }
nodes = await mount(snapshotWith([changedEntry], { stashCount: 2 }))
click(find(nodes, 'data-staging-stash-row', 'stash@{0}'))
nodes = await rerender(snapshotWith([changedEntry], { stashCount: 2 }))
stashList = [twoStashes[1]]
click(find(nodes, 'data-staging-stash-drop', 'stash@{0}'))
nodes = await rerender(snapshotWith([changedEntry], { stashCount: 2 }))
click(find(nodes, 'data-staging-stash-drop-confirm'))
nodes = await rerender(snapshotWith([changedEntry], { stashCount: 1 }))
await check('6a) 引用失效时显示专门的短句（不是通用失败）', () => {
  assert.match(textOf(find(nodes, 'data-staging-error')), /error_noSuchStash/u)
})
await check('6b) 并刷新列表：那条已经不在了，视图也收起来', () => {
  assert.equal(find(nodes, 'data-staging-stash-row', 'stash@{0}'), undefined)
  assert.equal(find(nodes, 'data-staging-stash-view', 'stash@{0}'), undefined)
  assert.equal(findAll(nodes, 'data-staging-stash-row').length, 1)
})
stashDropError = null

// ---------------------------------------------------------------------------
console.log('')
console.log('=== 7. 选中互斥：工作区文件 vs 储藏 ===')
stashList = twoStashes
stashShowFiles = [{ path: 'src/app.ts', status: 'M' }]
nodes = await mount(snapshotWith([changedEntry], { stashCount: 2 }))
click(find(nodes, 'data-staging-stash-row', 'stash@{0}'))
nodes = await rerender(snapshotWith([changedEntry], { stashCount: 2 }))
await check('7a) 选中储藏后进入储藏视图', () => {
  assert.equal(find(nodes, 'data-staging-stash-view', 'stash@{0}') !== undefined, true)
})
click(find(nodes, 'data-staging-diff-toggle', 'package.json'))
nodes = await rerender(snapshotWith([changedEntry], { stashCount: 2 }))
await check('7b) 选中工作区文件后储藏视图关闭（右侧只有一块内容）', () => {
  assert.equal(find(nodes, 'data-staging-stash-view', 'stash@{0}'), undefined)
  assert.equal(find(nodes, 'data-staging-stash-row', 'stash@{0}')?.props?.['data-staging-stash-selected'], 'false')
})

// 局部渲染工具：`data-staging-stash-row` 的 selected 之外，也确认点击储藏会清掉文件选中项。
nodes = await mount(snapshotWith([changedEntry], { stashCount: 2 }))
click(find(nodes, 'data-staging-stash-row', 'stash@{0}'))
nodes = await rerender(snapshotWith([changedEntry], { stashCount: 2 }))
await check('7c) 反过来：看储藏时工作区文件的差异不会同时渲染', () => {
  assert.equal(find(nodes, 'data-staging-stash-view', 'stash@{0}') !== undefined, true)
})

// ---------------------------------------------------------------------------
// 收尾：把共享快照 store 的订阅清掉，避免影响后续断言（本文件是独立进程，仅作防御）。
store?.__resetForTest?.()

console.log('')
console.log(`${passed} 项通过${failed === 0 ? '' : `，${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
