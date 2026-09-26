// Conflict UI regression test for the project panel (Changes tab + conflict resolver).
//
//   node scripts/test-review-conflict.mjs
//
// Runs the real client bundle for `dsh-client-ui-review` against a stubbed host, in the same
// style as `test-review-staging.mjs`: a hand-rolled React subset, host nodes looked up by
// `data-*` attributes, and every request recorded so the assertions are about what the UI
// actually sent (not about what it rendered).
//
// What this pins down:
//   1. a conflicted entry belongs to NEITHER "staged" nor "unstaged" — it gets its own group
//      (before the fix, `UU` silently appeared in both);
//   2. conflicted rows offer no stage/unstage/discard action (those are meaningless — and
//      "discard" would throw away changes the user has not even looked at);
//   3. clicking one opens the resolver, which renders Current/Incoming per block with the
//      names git itself wrote into the markers;
//   4. per-block choices are sent as `resolutions`, "Mark as resolved" adds `markResolved`;
//   5. Continue / Abort are per-operation and hit the gitbar host (which owns the operation),
//      with the abort body carrying the right `kind`;
//   6. a 409 `markersRemain` surfaces as a translated message key instead of a generic error.
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

/** Render a component and return its host nodes. */
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

/** Run queued effects and render again, a few times (async work settles a macrotask later). */
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

// ---------------------------------------------------------------------------
// Stub host: records every request, answers the routes this test needs.
// ---------------------------------------------------------------------------
const requests = []
const writes = []
let conflictPayload = {
  path: 'src/app.ts',
  code: 'UU',
  ours: 'current line\n',
  theirs: 'incoming line\n',
  base: 'base line\n',
  worktree: '<<<<<<< HEAD\ncurrent line\n=======\nincoming line\n>>>>>>> feature/x\n',
  blocks: [
    { index: 0, startLine: 1, endLine: 5, ours: 'current line', theirs: 'incoming line', oursLabel: 'HEAD', theirsLabel: 'feature/x' },
  ],
  blockCount: 1,
  hasMarkers: true,
  operationType: 'merge',
}
let writeError = null
/** 下一次 `/conflict` 返回什么（多轮 rebase 的用例会换成"另一批冲突"）。 */
let conflictPayloadOverride = null
/** 让 `op/continue` 挂住，用来断言"正在继续…"这一瞬间的界面状态。 */
let gitbarGate = null
/** `op/continue` 的自定义回复（多轮变基：宿主说"已经前进到下一次冲突"）。 */
let gitbarPayloadOverride = null
/** `op/continue` 之后本文件那份 `/conflict` 载荷（"冲突跑到别的文件去了"时用）。 */
let afterContinuePayload = null

const respond = (payload, ok = true) => ({ ok, text: async () => JSON.stringify(payload) })

globalThis.fetch = async (url, init) => {
  const target = String(url)
  const body = init?.body === undefined ? undefined : JSON.parse(init.body)
  requests.push({ url: target, body })
  if (target.includes('/dsh-desktop/gitbar/')) {
    writes.push({ route: 'gitbar', url: target, body })
    if (gitbarGate !== null) await gitbarGate
    if (writeError !== null) return respond(writeError.payload, false)
    // 多轮变基：`--continue` 之后冲突可能已经跑到**别的文件**上，本文件重新读出来是干净的。
    if (target.includes('/op/continue') && afterContinuePayload !== null) conflictPayloadOverride = afterContinuePayload
    return respond(gitbarPayloadOverride ?? { isRepo: true, branch: 'main' })
  }
  const route = target.slice(target.indexOf('/dsh-desktop/review/') + '/dsh-desktop/review/'.length).split('?')[0]
  if (route === 'conflict') {
    const payload = conflictPayloadOverride ?? conflictPayload
    // 多轮变基：读完一次就换下一批（模拟"继续之后下一个提交又冲突"）。
    if (conflictPayloadOverride !== null && conflictPayloadOverride === conflictPayload) conflictPayloadOverride = null
    return respond(payload)
  }
  if (route === 'conflict-resolve') {
    writes.push({ route, body })
    if (writeError !== null) return respond(writeError.payload, false)
    const markResolved = body?.markResolved === true
    // 预览（只算不写）：回一份**能一眼认出来**的内容，断言 Result 面板拿到的是**宿主算的**
    // 那一份，而不是界面自己拼的。
    const preview = body?.preview === true
    return respond({
      isRepo: true,
      path: conflictPayload.path,
      content: preview ? `preview:${JSON.stringify(body?.resolutions ?? {})}` : conflictPayload.worktree,
      blocks: markResolved ? [] : conflictPayload.blocks,
      blockCount: markResolved ? 0 : 1,
      unresolved: 0,
      hasMarkers: !markResolved,
      markedResolved: markResolved,
      preview,
    })
  }
  writes.push({ route, body })
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
let entries
{
  const module = await import(PLUGIN)
  void module
  entries = new Map()
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
const classify = loaded.__stagingClassifyForTest
const store = loaded.__gitSnapshotForTest
const WORKSPACE = 'C:\\work\\project'

const conflictedEntry = { path: 'src/app.ts', status: 'U', index: 'U', worktree: 'U', staged: false, unstaged: false, untracked: false, conflict: true, code: 'UU', added: null, removed: null }
const stagedEntry = { path: 'README.md', status: 'M', index: 'M', worktree: ' ', staged: true, unstaged: false, untracked: false, added: 1, removed: 0 }
const changedEntry = { path: 'package.json', status: 'M', index: ' ', worktree: 'M', staged: false, unstaged: true, untracked: false, added: 2, removed: 1 }

function snapshotWith(files) {
  return {
    workspace: WORKSPACE,
    repositoryRoot: WORKSPACE,
    branch: 'main',
    head: 'a'.repeat(40),
    phase: 'ready',
    files,
    changedFiles: files.length,
    changedFilesExact: true,
    staged: files.filter((file) => file.staged).length,
    unstaged: files.filter((file) => !file.staged).length,
    untracked: { count: 0, exact: true, mode: 'inline', collapsed: false, inlineFiles: [] },
    conflictCount: files.filter((file) => file.conflict === true).length,
    conflicts: files.filter((file) => file.conflict === true).map((file) => ({ path: file.path, code: file.code })),
    operationType: files.some((file) => file.conflict === true) ? 'merge' : '',
    empty: false,
    error: '',
    refreshError: '',
    updatedAt: Date.now(),
    refresh: () => {},
    invalidate: () => {},
  }
}

let mountSeq = 0
let mountKey = ''
/**
 * Mount the panel with a fresh hook state, then re-render with the SAME key.
 *
 * Hook slots are keyed by tree position + the key we pass in, so every settle of one logical
 * mount must reuse the same key — otherwise the component remounts and any state the click
 * just set (which file is selected, which block was decided) is thrown away.
 */
const mount = async (snapshot) => {
  mountKey = `c${mountSeq++}`
  return await settle(Staging, mountProps(snapshot), mountKey)
}
const rerender = async (snapshot) => await settle(Staging, mountProps(snapshot), mountKey)

function mountProps(snapshot) {
  return {
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

console.log('=== 1. classification ===')
await check('冲突条目既不属于已暂存也不属于未暂存', () => {
  const result = classify(conflictedEntry)
  assert.equal(result.conflicted, true)
  assert.equal(result.staged, false)
  assert.equal(result.unstaged, false)
})
await check('普通条目不受影响', () => {
  assert.deepEqual(classify(stagedEntry), { conflicted: false, staged: true, unstaged: false })
  assert.deepEqual(classify(changedEntry), { conflicted: false, staged: false, unstaged: true })
})
await check('porcelain v1 来的 UU（没有 conflict 标记）同样判为冲突', () => {
  const result = classify({ path: 'x', index: 'U', worktree: 'U' })
  assert.equal(result.conflicted, true)
  assert.equal(result.staged, false)
})

console.log('')
console.log('=== 2. conflict group in Changes ===')
let nodes = await mount(snapshotWith([conflictedEntry, stagedEntry, changedEntry]))
await check('出现一个冲突分组', () => {
  const group = find(nodes, 'data-staging-group', 'conflicted')
  assert.ok(group !== undefined, 'missing conflicted group')
})
await check('冲突文件不在已暂存/未暂存分组里（不会被重复列出）', () => {
  const inStaged = findAll(nodes, 'data-staging-row').filter((node) => node.props['data-staging-side'] === 'staged' && node.props['data-staging-row'] === 'src/app.ts')
  const inUnstaged = findAll(nodes, 'data-staging-row').filter((node) => node.props['data-staging-side'] === 'unstaged' && node.props['data-staging-row'] === 'src/app.ts')
  assert.equal(inStaged.length, 0)
  assert.equal(inUnstaged.length, 0)
})
await check('冲突行没有暂存/还原按钮（解决之前这两个动作都没有意义）', () => {
  const row = find(nodes, 'data-staging-conflict-row', 'src/app.ts')
  assert.ok(row !== undefined, 'missing conflict row')
  // 三行文件里只有 README.md（已暂存）与 package.json（未暂存）该有动作按钮。修复前
  // 冲突文件会同时落进两个分组，这里的计数会各多出一个。
  assert.equal(findAll(nodes, 'data-staging-row-action').filter((node) => node.props['data-staging-row-action'] === 'stage').length, 1)
  assert.equal(findAll(nodes, 'data-staging-row-action').filter((node) => node.props['data-staging-row-action'] === 'unstage').length, 1)
  // 其它行（README.md / package.json）本来就有 discard，所以只能按路径过滤。
  const reverts = findAll(nodes, 'data-staging-revert').filter((node) => node.props['data-staging-revert'] === 'src/app.ts')
  assert.equal(reverts.length, 0, 'conflict row must not offer discard')
})
await check('冲突行显示冲突徽标与状态码', () => {
  const badge = find(nodes, 'data-staging-status', 'U')
  assert.ok(badge !== undefined)
  assert.equal(find(nodes, 'data-staging-conflict-code')?.props['data-staging-conflict-code'], 'UU')
})

console.log('')
console.log('=== 3. resolver ===')
const conflictRow = find(nodes, 'data-staging-conflict-row', 'src/app.ts')
click(conflictRow)
nodes = await rerender(snapshotWith([conflictedEntry, stagedEntry, changedEntry]))
await check('点击冲突行后右侧换成冲突解决面板（而不是普通差异）', () => {
  assert.ok(find(nodes, 'data-conflict-resolver') !== undefined, 'resolver not rendered')
  assert.equal(find(nodes, 'data-review-diff-viewer'), undefined, 'plain diff must not be used for conflicts')
})
await check('面板请求了 /conflict 三路内容', () => {
  assert.ok(requests.some((entry) => entry.url.includes('/dsh-desktop/review/conflict')), 'no /conflict request')
})
await check('每个冲突块都给出 Current / Incoming 两侧', () => {
  const block = find(nodes, 'data-conflict-block', '0')
  assert.ok(block !== undefined)
  assert.ok(find(nodes, 'data-conflict-side', 'current') !== undefined)
  assert.ok(find(nodes, 'data-conflict-side', 'incoming') !== undefined)
})
await check('两侧用的是 git 写在标记里的名字（HEAD / feature/x）', () => {
  const sides = findAll(nodes, 'data-conflict-side')
  const text = JSON.stringify(sides.map((node) => node.props.children))
  assert.match(text, /HEAD/u)
  assert.match(text, /feature\/x/u)
})
await check('操作类型显示为"合并进行中"', () => {
  assert.equal(find(nodes, 'data-conflict-operation')?.props['data-conflict-operation'], 'merge')
})

console.log('')
console.log('=== 4. per-block choices + mark resolved ===')
click(find(nodes, 'data-conflict-take', 'theirs'))
nodes = await rerender(snapshotWith([conflictedEntry, stagedEntry, changedEntry]))
writes.length = 0
click(find(nodes, 'data-conflict-apply'))
nodes = await rerender(snapshotWith([conflictedEntry, stagedEntry, changedEntry]))
await check('「应用选择」把逐块决定发成 resolutions', () => {
  const write = writes.find((entry) => entry.route === 'conflict-resolve')
  assert.ok(write !== undefined, 'no conflict-resolve request')
  assert.deepEqual(write.body.resolutions, { 0: 'theirs' })
  assert.equal(write.body.path, 'src/app.ts')
})
writes.length = 0
click(find(nodes, 'data-conflict-mark'))
nodes = await rerender(snapshotWith([conflictedEntry, stagedEntry, changedEntry]))
await check('「标记为已解决」带上 markResolved', () => {
  const write = writes.find((entry) => entry.route === 'conflict-resolve')
  assert.ok(write !== undefined)
  assert.equal(write.body.markResolved, true)
})

console.log('')
console.log('=== 5. continue / abort go to the gitbar host ===')
writes.length = 0
click(find(nodes, 'data-conflict-continue'))
await rerender(snapshotWith([conflictedEntry, stagedEntry, changedEntry]))
await check('「提交合并」打到 gitbar 的 op/continue', () => {
  const write = writes.find((entry) => entry.route === 'gitbar')
  assert.ok(write !== undefined, 'no gitbar request')
  assert.match(write.url, /\/dsh-desktop\/gitbar\/op\/continue/u)
})
writes.length = 0
click(find(nodes, 'data-conflict-abort'))
await rerender(snapshotWith([conflictedEntry, stagedEntry, changedEntry]))
await check('「中止合并」打到 op/abort 且带 kind=merge', () => {
  const write = writes.find((entry) => entry.route === 'gitbar')
  assert.ok(write !== undefined)
  assert.match(write.url, /\/dsh-desktop\/gitbar\/op\/abort/u)
  assert.deepEqual(write.body, { kind: 'merge' })
})
const rebaseSnapshot = { ...snapshotWith([conflictedEntry]), operationType: 'rebase' }
nodes = await rerender(rebaseSnapshot)
await check('变基时按钮文案换成"继续变基/中止变基"', () => {
  assert.ok(find(nodes, 'data-conflict-continue') !== undefined)
  const labels = JSON.stringify(findAll(nodes, 'data-conflict-op-actions').map((node) => node.props.children))
  assert.match(labels, /conflictContinueRebase/u)
  assert.match(labels, /conflictAbortRebase/u)
})
await check('还有冲突文件时「继续」被禁用（先解决再继续）', () => {
  const button = find(nodes, 'data-conflict-continue')
  assert.equal(button.props.disabled, true)
})

// 摘取与还原也必须各自给出正确的按钮文案：它们的继续命令都不是 merge 的"提交合并"。
// （宿主侧的四种操作语义由 `test-git-op-conflicts.mjs` 用真实仓库钉住，这里只钉界面文案
// 与发给宿主的 kind —— 两者必须一致，否则界面会调错命令。）
const cherryPickSnapshot = { ...snapshotWith([conflictedEntry]), operationType: 'cherry-pick' }
nodes = await rerender(cherryPickSnapshot)
await check('摘取时按钮文案换成"继续摘取/中止摘取"', () => {
  const labels = JSON.stringify(findAll(nodes, 'data-conflict-op-actions').map((node) => node.props.children))
  assert.match(labels, /conflictContinueCherryPick/u)
  assert.match(labels, /conflictAbortCherryPick/u)
})
await check('摘取的操作类型也显示在面板上', () => {
  assert.equal(find(nodes, 'data-conflict-operation')?.props['data-conflict-operation'], 'cherry-pick')
})
writes.length = 0
click(find(nodes, 'data-conflict-abort'))
await rerender(cherryPickSnapshot)
await check('摘取的中止带 kind=cherry-pick', () => {
  const write = writes.find((entry) => entry.route === 'gitbar')
  assert.ok(write !== undefined, 'no gitbar request')
  assert.match(write.url, /\/dsh-desktop\/gitbar\/op\/abort/u)
  assert.deepEqual(write.body, { kind: 'cherry-pick' })
})

const revertSnapshot = { ...snapshotWith([conflictedEntry]), operationType: 'revert' }
nodes = await rerender(revertSnapshot)
await check('还原时按钮文案换成"继续还原/中止还原"', () => {
  const labels = JSON.stringify(findAll(nodes, 'data-conflict-op-actions').map((node) => node.props.children))
  assert.match(labels, /conflictContinueRevert/u)
  assert.match(labels, /conflictAbortRevert/u)
})
writes.length = 0
click(find(nodes, 'data-conflict-abort'))
await rerender(revertSnapshot)
await check('还原的中止带 kind=revert', () => {
  const write = writes.find((entry) => entry.route === 'gitbar')
  assert.ok(write !== undefined, 'no gitbar request')
  assert.deepEqual(write.body, { kind: 'revert' })
})

console.log('')
console.log('=== 6. leftover markers are surfaced as a translated code ===')
writeError = { payload: { error: 'conflict markers remain', code: 'markersRemain', detail: '1' } }
writes.length = 0
nodes = await rerender(snapshotWith([conflictedEntry]))
click(find(nodes, 'data-conflict-mark'))
nodes = await rerender(snapshotWith([conflictedEntry]))
await check('残留标记被后端拒绝时，界面显示专门的提示而不是"操作失败"', () => {
  const strip = find(nodes, 'data-staging-error')
  assert.ok(strip !== undefined, 'no error strip')
  assert.equal(strip.props['data-staging-error'], 'markersRemain')
  const text = JSON.stringify(nodes.map((node) => node.props.children))
  assert.match(text, /error_markersRemain/u)
})
writeError = null
store.__resetForTest?.()

// =====================================================================================
console.log('')
console.log('=== 7. merge editor：逐块导航 / 立即更新 Result / 不落盘 ===')
// =====================================================================================
const twoBlockPayload = {
  ...conflictPayload,
  worktree: '<<<<<<< HEAD\nA current\n=======\nA incoming\n>>>>>>> feature/x\nmid\n<<<<<<< HEAD\nB current\n=======\nB incoming\n>>>>>>> feature/x\n',
  blocks: [
    { index: 0, startLine: 1, endLine: 5, ours: 'A current', theirs: 'A incoming', oursLabel: 'HEAD', theirsLabel: 'feature/x' },
    { index: 1, startLine: 7, endLine: 11, ours: 'B current', theirs: 'B incoming', oursLabel: 'HEAD', theirsLabel: 'feature/x' },
  ],
  blockCount: 2,
}
/**
 * 打开冲突面板：挂载 Changes → 点冲突行 →（这一次 /conflict 才返回我们要的夹具）。
 *
 * 必须**新挂一次**：冲突面板的块来自挂载时那次 `/conflict`，而面板按路径缓存实例，
 * 换夹具而不换实例是看不到新块的（这也是"多轮冲突要重新读"的另一面）。
 */
const openResolver = async (snapshot) => {
  const mounted = await mount(snapshot)
  click(find(mounted, 'data-staging-conflict-row', 'src/app.ts'))
  return await rerender(snapshot)
}

conflictPayloadOverride = twoBlockPayload
nodes = await openResolver(snapshotWith([conflictedEntry]))
await check('7a) 两个冲突块时显示"冲突 1 / 2"，并给出导航按钮', () => {
  assert.equal(find(nodes, 'data-conflict-counter')?.props['data-conflict-counter'], '1/2')
  assert.ok(find(nodes, 'data-conflict-prev') !== undefined)
  assert.ok(find(nodes, 'data-conflict-next') !== undefined)
  assert.equal(find(nodes, 'data-conflict-prev')?.props.disabled, true, '第一块时"上一个"应当禁用')
  assert.equal(find(nodes, 'data-conflict-resolved-count')?.props['data-conflict-resolved-count'], '0/2')
})
await check('7b) 默认定位到第一块（aria-current + 当前块标记）', () => {
  const panes = find(nodes, 'data-conflict-block', '0')
  assert.ok(panes !== undefined, '没有当前块容器')
  assert.equal(panes.props['aria-current'], 'true')
})
click(find(nodes, 'data-conflict-next'))
nodes = await rerender(snapshotWith([conflictedEntry]))
await check('7c) 「下一个冲突」切到第二块', () => {
  assert.equal(find(nodes, 'data-conflict-counter')?.props['data-conflict-counter'], '2/2')
  assert.equal(find(nodes, 'data-conflict-next')?.props.disabled, true)
  assert.equal(find(nodes, 'data-conflict-block', '1')?.props['aria-current'], 'true')
})
click(find(nodes, 'data-conflict-prev'))
nodes = await rerender(snapshotWith([conflictedEntry]))

writes.length = 0
click(find(nodes, 'data-conflict-take', 'theirs'))
nodes = await rerender(snapshotWith([conflictedEntry]))
await check('7d) 点「用对方」立刻把决定发给宿主**只算不写**（preview）', () => {
  const write = writes.find((entry) => entry.route === 'conflict-resolve')
  assert.ok(write !== undefined, '没有发出 conflict-resolve')
  assert.equal(write.body.preview, true, '必须是只算不写')
  assert.deepEqual(write.body.resolutions, { 0: 'theirs' })
  assert.equal(write.body.order, 'ours-first', '"两者都要"的顺序必须显式给定')
})
await check('7e) Result 面板立即换成宿主算出来的那份文本', () => {
  const textarea = find(nodes, 'data-conflict-result')
  assert.equal(textarea?.props.value, `preview:${JSON.stringify({ 0: 'theirs' })}`)
})
await check('7f) 决定过的块显示"已解决"，计数同步', () => {
  assert.equal(find(nodes, 'data-conflict-block-resolved', '0') !== undefined, true)
  assert.equal(find(nodes, 'data-conflict-resolved-count')?.props['data-conflict-resolved-count'], '1/2')
})
await check('7g) 「应用选择」才是真正写回（带 resolutions，不带 preview）', () => {
  writes.length = 0
  click(find(nodes, 'data-conflict-apply'))
  const write = writes.find((entry) => entry.route === 'conflict-resolve')
  assert.ok(write !== undefined)
  assert.equal(write.body.preview, undefined)
  assert.deepEqual(write.body.resolutions, { 0: 'theirs' })
})
conflictPayloadOverride = null

console.log('')
console.log('=== 8. merge editor：布局 / 文件导航 ===')
const resolver = loaded.__conflictResolverForTest
/** 直接挂载冲突面板（不走 Changes），用来断言布局与文件导航这类纯界面契约。 */
const mountResolver = async (props) => await settle(resolver, props, `r${mountSeq++}`)
const baseResolverProps = {
  t: (key, params) => (params === undefined ? key : `${key}(${Object.values(params).join(',')})`),
  workspace: WORKSPACE,
  repositoryRoot: WORKSPACE,
  path: 'src/app.ts',
  code: 'UU',
  operationType: 'rebase',
  conflictCount: 2,
  busy: false,
  run: async () => ({}),
  onCommitted: () => {},
  onOperationProgress: () => {},
}
const triNodes = await mountResolver({ ...baseResolverProps, triPane: true, conflictPaths: ['src/app.ts', 'src/other.ts'] })
await check('8a) 宽屏是三栏：CURRENT | RESULT | INCOMING', () => {
  assert.equal(find(triNodes, 'data-conflict-panes')?.props['data-conflict-panes'], 'tri')
  const panes = findAll(triNodes, 'data-conflict-pane').map((node) => node.props['data-conflict-pane'])
  // 两侧各出现一次（CURRENT 在前、INCOMING 在后），Result 在中间。
  assert.deepEqual(panes, ['current', 'result', 'incoming'])
  assert.equal(find(triNodes, 'data-conflict-tri-pane')?.props['data-conflict-tri-pane'], '1')
})
const stackedNodes = await mountResolver({ ...baseResolverProps, conflictCount: 1, triPane: false, conflictPaths: [] })
await check('8b) 窄屏退化成"两侧在上、Result 在下"', () => {
  assert.equal(find(stackedNodes, 'data-conflict-panes')?.props['data-conflict-panes'], 'stacked')
  const panes = findAll(stackedNodes, 'data-conflict-pane').map((node) => node.props['data-conflict-pane'])
  assert.deepEqual(panes, ['current', 'incoming', 'result'])
  assert.equal(find(stackedNodes, 'data-conflict-tri-pane')?.props['data-conflict-tri-pane'], '0')
})
await check('8c) 多个冲突文件时给出"文件 1 / 2"与上一个/下一个文件', () => {
  assert.equal(find(triNodes, 'data-conflict-file-nav')?.props['data-conflict-file-nav'], '2')
  assert.equal(find(triNodes, 'data-conflict-file-position')?.props['data-conflict-file-position'], '1')
  assert.equal(find(triNodes, 'data-conflict-file-prev')?.props.disabled, true, '第一个文件时不能往前')
  assert.equal(find(triNodes, 'data-conflict-file-next')?.props.disabled, false)
})
await check('8d) 点「下一个冲突文件」把目标路径交给父级', async () => {
  const picked = []
  const navNodes = await mountResolver({ ...baseResolverProps, triPane: true, conflictPaths: ['src/app.ts', 'src/other.ts'], onSelectPath: (next) => picked.push(next) })
  click(find(navNodes, 'data-conflict-file-next'))
  assert.deepEqual(picked, ['src/other.ts'])
})
await check('8e) 新文案全部走字典（不是硬编码英文）', () => {
  const texts = JSON.stringify(triNodes.map((node) => node.props.children))
  for (const key of ['conflictPrev', 'conflictNext', 'conflictPrevFile', 'conflictNextFile', 'conflictOfBlocks', 'conflictResolvedCount', 'conflictResult']) {
    assert.match(texts, new RegExp(key, 'u'), `界面里没有用到 ${key}`)
  }
})

console.log('')
console.log('=== 9. 多轮 rebase：继续之后又冲突，面板自动进入下一批 ===')
{
  conflictPayloadOverride = twoBlockPayload
  const multiNodes = await openResolver(snapshotWith([conflictedEntry]))
  click(find(multiNodes, 'data-conflict-continue'))
  const after = await rerender(snapshotWith([conflictedEntry]))
  await check('9a) 继续之后如果还有冲突块，界面说"还有 N 块"而不是"操作已完成"', () => {
    const notice = find(after, 'data-conflict-notice')
    assert.ok(notice !== undefined, '没有提示')
    assert.match(String(notice.props.children), /conflictNextRound/u)
    assert.equal(find(after, 'data-conflict-counter')?.props['data-conflict-counter'], '1/2')
  })
  await check('9b) 操作类型仍然是 rebase（没有把"这一轮解决完"当成操作结束）', () => {
    assert.equal(find(after, 'data-conflict-resolver') !== undefined, true)
    assert.equal(find(after, 'data-conflict-continue') !== undefined, true)
  })
  conflictPayloadOverride = null
}

console.log('')
console.log('=== 9c. 下一轮冲突落在**别的文件**上：宿主回报"前进到下一次冲突" ===')
{
  // 变基是一次一个提交地往前的：解决完这个文件，下一个提交的冲突完全可能在**另一个**
  // 文件上。这时本文件重新读出来是干净的（blockCount 0），只看本文件会以为"这一轮做完
  // 了"；宿主明确回报 `stoppedAtNextConflict`，界面必须把"还有冲突要解决"说出来。
  const cleanPayload = { ...conflictPayload, worktree: 'A current\nmid\nB current\n', blocks: [], blockCount: 0, hasMarkers: false }
  conflictPayloadOverride = twoBlockPayload
  afterContinuePayload = cleanPayload
  gitbarPayloadOverride = { continued: 'rebase', stoppedAtNextConflict: true, conflicts: 1, paths: ['src/other.ts'] }
  const otherNodes = await openResolver(snapshotWith([conflictedEntry]))
  click(find(otherNodes, 'data-conflict-continue'))
  const afterOther = await rerender(snapshotWith([conflictedEntry]))
  await check('9c) 自己的文件干净了，但别的文件又冲突：照样提示"还有 N 块"', () => {
    const notice = find(afterOther, 'data-conflict-notice')
    assert.ok(notice !== undefined, '没有提示：界面会以为这一轮已经做完')
    assert.match(String(notice.props.children), /^conflictNextRound\(1\)$/u, '条数要来自宿主的 stoppedAtNextConflict（1 个文件）')
    assert.equal(find(afterOther, 'data-conflict-state', 'clean') !== undefined, true, '本文件确实已经不冲突了')
  })
  await check('9d) 提示不会让用户以为操作已经结束（不显示"操作已完成"）', () => {
    assert.equal(find(afterOther, 'data-conflict-resolver') !== undefined, true)
  })
  afterContinuePayload = null
  gitbarPayloadOverride = null
  conflictPayloadOverride = null
}

console.log('')
console.log('=== 10. 「继续」进行中：按钮文案与防重复点击 ===')
{
  let release = () => {}
  gitbarGate = new Promise((done) => {
    release = () => {
      gitbarGate = null
      done()
    }
  })
  const busyNodes = await openResolver(snapshotWith([conflictedEntry]))
  writes.length = 0
  click(find(busyNodes, 'data-conflict-continue'))
  const during = await rerender(snapshotWith([conflictedEntry]))
  await check('10a) 继续期间按钮显示"正在继续…"并禁用（不会重复点击）', () => {
    const button = find(during, 'data-conflict-continue')
    assert.equal(button?.props['data-conflict-continuing'], '1')
    assert.equal(button?.props.disabled, true)
    assert.match(JSON.stringify(button?.props.children), /conflictContinuing/u)
    assert.equal(writes.filter((entry) => entry.route === 'gitbar').length, 1, '只发了一次 continue')
  })
  release()
  const done = await rerender(snapshotWith([conflictedEntry]))
  await check('10b) 结束后按钮恢复可用', () => {
    assert.equal(find(done, 'data-conflict-continue')?.props['data-conflict-continuing'], '0')
  })
}

console.log('')
console.log(`${passed} 项通过${failed === 0 ? '' : `，${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
