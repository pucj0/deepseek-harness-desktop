// Side-by-Side 差异视图的回归测试（对齐是纯函数，视图是真实 bundle 渲染）。
//
//   node scripts/test-review-diff-sbs.mjs
//
// 为什么把"对齐"单独测：并排视图最容易糊弄的地方就是**把左右两列各自独立地列出来**——那样
// 看起来像 side-by-side，实际上一旦有增删，两边的行就整体错位一行。因此这里直接对
// `alignHunkRows()` / `buildDiffModel()` 断言（纯函数、可枚举所有边界），再用假 React 挂载
// 真实的 `ReviewDiffViewer` 验证工具条（Unified | Side-by-Side、改动导航）与并排 DOM 契约。
//
// 覆盖需求里的五种情况：
//   A. context 不变        B. 新增行       C. 删除行
//   D. 修改（配对同一行，并做字符级高亮）   E. 多个 hunk（导航计数）
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
// 最小 React 子集（与其它 review 测试同一套形状：createElement + hook 槽）
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

/** 递归展开函数组件，返回宿主（字符串标签）节点。 */
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

let mountSeq = 0
let mountKey = ''
async function settle(component, props, key, passes = 3) {
  let nodes = []
  renderKey = key
  slotCursor = 0
  nodes = collectHostNodes(component(props), key)
  for (let index = 0; index < passes; index += 1) {
    while (effectQueue.length > 0) {
      const effect = effectQueue.shift()
      effect()
    }
    await new Promise((done) => setTimeout(done, 0))
    renderKey = key
    slotCursor = 0
    nodes = collectHostNodes(component(props), key)
  }
  return nodes
}
const mount = async (component, props) => {
  mountKey = `m${mountSeq++}`
  return await settle(component, props, mountKey)
}
const rerender = async (component, props) => await settle(component, props, mountKey, 2)

const find = (nodes, attr, value) => nodes.find((node) => (value === undefined ? node.props[attr] !== undefined : node.props[attr] === value))
const findAll = (nodes, attr) => nodes.filter((node) => node.props[attr] !== undefined)
/** 节点文本（含子树）。 */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child) => textOf(child)).join('')
  if (typeof node !== 'object') return ''
  return textOf(node.props?.children)
}
const click = (node) => node.props.onClick?.({ stopPropagation() {}, preventDefault() {} })

// ---------------------------------------------------------------------------
// 插件 bundle 的加载环境
// ---------------------------------------------------------------------------
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
  const ctx = {
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: { register: () => {}, bind: () => (key) => key },
    slots: {
      inject: (_name, register) => register(),
      register: () => {},
    },
    settingsScope: { bind: () => ({ getSnapshot: () => ({ value: undefined, writable: false }), set: async () => {}, subscribe: () => () => {} }) },
    remote: {},
    sidebarRight: {},
    on: () => () => {},
  }
  loaded.apply(ctx)
}

const model = loaded.__diffModelForTest
const DiffViewer = loaded.__diffViewerForTest
const { unified, sideBySide } = model.modes

/** 造一份统一差异文本（hunk 头 + 体，行尾 LF）。 */
function diffOf(hunks) {
  return hunks
    .map((hunk, index) => {
      const oldStart = hunk.oldStart ?? (index === 0 ? 1 : 1)
      const newStart = hunk.newStart ?? oldStart
      return [`@@ -${oldStart},${hunk.body.length} +${newStart},${hunk.body.length} @@`, ...hunk.body].join('\n')
    })
    .join('\n')
}
/** 解析 + 对齐一个 hunk，返回对齐结果。 */
function align(body) {
  const rows = model.parse(diffOf([{ body }]))
  const built = model.build(rows, sideBySide)
  const hunk = built.segments.find((segment) => segment.kind === 'hunk')
  assert.ok(hunk !== undefined, '没有解析出 hunk')
  return hunk.aligned
}
/** 把对齐结果压成便于断言的形状：`[kind, leftText|'', rightText|'']`。 */
const shape = (aligned) =>
  aligned.map((row) => [row.kind, row.left?.text ?? '', row.right?.text ?? ''])

// =====================================================================================
console.log('=== A. context：两侧完全一致 ===')
// =====================================================================================
await check('A) 三行上下文逐行左右对齐，行号两侧一致', () => {
  const aligned = align([' A', ' B', ' C'])
  assert.deepEqual(shape(aligned), [
    ['context', 'A', 'A'],
    ['context', 'B', 'B'],
    ['context', 'C', 'C'],
  ])
  assert.deepEqual(
    aligned.map((row) => [row.left.oldLine, row.left.newLine, row.right.oldLine, row.right.newLine]),
    [
      [1, 1, 1, 1],
      [2, 2, 2, 2],
      [3, 3, 3, 3],
    ],
  )
})

// =====================================================================================
console.log('')
console.log('=== B. 新增行：左边留空位，右边插在正确位置 ===')
// =====================================================================================
await check('B) A,X,B（X 为新增）→ A|A、空|X、B|B', () => {
  const aligned = align([' A', '+X', ' B'])
  assert.deepEqual(shape(aligned), [
    ['context', 'A', 'A'],
    ['added', '', 'X'],
    ['context', 'B', 'B'],
  ])
  // 空位那一行左边没有行号（就是"这里没有对应的旧行"），右边拿到新文件的行号 2。
  assert.equal(aligned[1].left, null)
  assert.deepEqual([aligned[1].right.newLine, aligned[2].right.newLine], [2, 3])
  assert.deepEqual([aligned[2].left.oldLine, aligned[2].left.newLine], [2, 3])
})

// =====================================================================================
console.log('')
console.log('=== C. 删除行：右边留空位 ===')
// =====================================================================================
await check('C) A,X,B（X 为删除）→ A|A、X|空、B|B', () => {
  const aligned = align([' A', '-X', ' B'])
  assert.deepEqual(shape(aligned), [
    ['context', 'A', 'A'],
    ['deleted', 'X', ''],
    ['context', 'B', 'B'],
  ])
  assert.equal(aligned[1].right, null)
})

// =====================================================================================
console.log('')
console.log('=== D. 修改：左右配成同一行，并做字符级高亮 ===')
// =====================================================================================
await check('D) 一删一增配成 modified（不是错位一行）', () => {
  const aligned = align(['-const timeout = 1000', '+const timeout = 3000'])
  assert.equal(aligned.length, 1)
  assert.equal(aligned[0].kind, 'modified')
  assert.equal(aligned[0].left.text, 'const timeout = 1000')
  assert.equal(aligned[0].right.text, 'const timeout = 3000')
})
await check('D) 字符级高亮只圈出变化的部分（1000 / 3000）', () => {
  const aligned = align(['-const timeout = 1000', '+const timeout = 3000'])
  const range = aligned[0].charDiff
  assert.ok(range !== undefined, '没有算出字符级变化')
  assert.equal(aligned[0].left.text.slice(range.left[0], range.left[1]), '1000')
  assert.equal(aligned[0].right.text.slice(range.right[0], range.right[1]), '3000')
})
await check('D) 删得比增多时：先配对，多出来的删除行单独成 deleted', () => {
  const aligned = align(['-a1', '-a2', '-a3', '+b1'])
  assert.deepEqual(shape(aligned), [
    ['modified', 'a1', 'b1'],
    ['deleted', 'a2', ''],
    ['deleted', 'a3', ''],
  ])
})
await check('D) 增得比删得多时：多出来的新增行单独成 added', () => {
  const aligned = align(['-a1', '+b1', '+b2', '+b3'])
  assert.deepEqual(shape(aligned), [
    ['modified', 'a1', 'b1'],
    ['added', '', 'b2'],
    ['added', '', 'b3'],
  ])
})
await check('D) 两侧完全相同的行不算变化（不产生高亮）', () => {
  assert.equal(model.charDiff('same', 'same'), undefined)
  assert.equal(model.charDiff('', 'x'), undefined)
  // 只有尾部多一个字符：高亮范围就是那一个字符。
  const range = model.charDiff('abc', 'abcd')
  assert.deepEqual(range, { left: [3, 3], right: [3, 4] })
})
await check('D) 修改块之间夹着上下文时不会跨块配对', () => {
  const aligned = align(['-a1', '+b1', ' keep', '-a2', '+b2'])
  assert.deepEqual(shape(aligned), [
    ['modified', 'a1', 'b1'],
    ['context', 'keep', 'keep'],
    ['modified', 'a2', 'b2'],
  ])
})

// =====================================================================================
console.log('')
console.log('=== E. 多个 hunk：模型与导航计数 ===')
// =====================================================================================
const twoHunkDiff = [
  '@@ -1,2 +1,2 @@',
  ' keep',
  '-old one',
  '+new one',
  '@@ -10,2 +10,3 @@',
  ' tail',
  '+added tail',
  ' end',
].join('\n')
await check('E) 两个 hunk 各自成段，hunkCount = 2', () => {
  const built = model.build(model.parse(twoHunkDiff), sideBySide)
  assert.equal(built.hunkCount, 2)
  assert.deepEqual(
    built.segments.map((segment) => segment.kind),
    ['hunk', 'hunk'],
  )
  assert.deepEqual(
    built.segments.map((segment) => segment.aligned.length),
    // 第一个 hunk 是"上下文 + 一删一增"，删增配对成**一行** modified，因此只有 2 行；
    // 第二个 hunk 是"上下文 + 新增 + 上下文"，新增单独占一行，因此 3 行。
    [2, 3],
  )
})
await check('E) 统一模式与并排模式读同一个模型（只有渲染不同）', () => {
  const unifiedModel = model.build(model.parse(twoHunkDiff), unified)
  const sideModel = model.build(model.parse(twoHunkDiff), sideBySide)
  assert.equal(unifiedModel.hunkCount, sideModel.hunkCount)
  assert.equal(unifiedModel.segments[0].header.text, sideModel.segments[0].header.text)
  assert.deepEqual(
    unifiedModel.segments[0].rows.map((row) => row.kind),
    ['context', 'del', 'add'],
  )
})
await check('E) 文件头 / meta 行不会被当成 hunk 正文', () => {
  const withHeader = ['diff --git a/x b/x', 'index 111..222 100644', '--- a/x', '+++ b/x', '@@ -1,1 +1,1 @@', '-a', '+b'].join('\n')
  const built = model.build(model.parse(withHeader), sideBySide)
  assert.equal(built.hunkCount, 1)
  assert.equal(built.segments[0].kind, 'fileheader')
  assert.equal(built.segments[1].kind, 'hunk')
  assert.deepEqual(
    built.segments[1].aligned.map((row) => row.kind),
    ['modified'],
  )
})

// =====================================================================================
console.log('')
console.log('=== F. 视图：模式切换、工具条、并排 DOM ===')
// =====================================================================================
model.modeStore.set(sideBySide)
const viewerProps = {
  t: (key, params) => (params === undefined ? key : `${key}(${Object.values(params).join(',')})`),
  file: { path: 'src/app.ts', status: 'M', added: 2, removed: 1 },
  diff: twoHunkDiff,
}
let nodes = await mount(DiffViewer, viewerProps)

await check('F) 默认是并排：渲染 data-review-sbs-row，不再渲染统一行', () => {
  assert.equal(find(nodes, 'data-review-diff-body')?.props['data-review-diff-mode'], sideBySide)
  assert.ok(findAll(nodes, 'data-review-sbs-row').length > 0, '没有并排行')
  // hunk 头是两种模式共用的（它同时是导航锚点），这里只断言"统一模式的正文行"没有出现。
  const kinds = findAll(nodes, 'data-review-diff-kind').map((node) => node.props['data-review-diff-kind'])
  assert.deepEqual(kinds, ['hunk', 'hunk'], `并排模式下不该有统一样式的正文行：${kinds.join(',')}`)
})
await check('F) 并排表头写着 Before / After', () => {
  const head = find(nodes, 'data-review-sbs-head')
  assert.ok(head !== undefined, '缺少并排表头')
  const text = textOf(head)
  assert.match(text, /diffBefore/u)
  assert.match(text, /diffAfter/u)
})
await check('F) 每行左右两格都在，且对齐空位有独立的标记', () => {
  const rows = findAll(nodes, 'data-review-sbs-row')
  assert.ok(rows.length >= 4)
  for (const row of rows) {
    const cells = findAll(collectHostNodes(row, 'probe'), 'data-review-sbs-cell')
    assert.equal(cells.length, 2, '每一行必须是左右两格')
  }
  const empties = findAll(nodes, 'data-review-sbs-empty')
  assert.ok(empties.length > 0, '新增/删除行的对面应当是空位格')
})
await check('F) 行号来自各自的旧/新文件', () => {
  const lines = findAll(nodes, 'data-review-sbs-line').map((node) => node.props['data-review-sbs-line'])
  assert.ok(lines.includes('1'), `行号缺失：${lines.join(',')}`)
})
await check('F) 修改行两侧都带字符级高亮', () => {
  const rows = findAll(nodes, 'data-review-sbs-row').filter((row) => row.props['data-review-sbs-kind'] === 'modified')
  assert.ok(rows.length > 0)
  const chars = findAll(collectHostNodes(rows[0], 'probe'), 'data-review-sbs-char')
  assert.equal(chars.length, 2, '左右各一处高亮')
})
await check('F) 工具条：Unified | Side-by-Side 两个按钮，当前模式按下', () => {
  const modes = findAll(nodes, 'data-review-diff-mode-option')
  assert.deepEqual(modes.map((node) => node.props['data-review-diff-mode-option']), [unified, sideBySide])
  assert.equal(modes.find((node) => node.props['data-review-diff-mode-option'] === sideBySide).props['aria-pressed'], true)
  assert.equal(modes.find((node) => node.props['data-review-diff-mode-option'] === unified).props['aria-pressed'], false)
  // 容器上的模式标记与按下的按钮一致（一个说"现在是什么"，一个说"点了会变成什么"）。
  assert.equal(find(nodes, 'data-review-diff-body')?.props['data-review-diff-mode'], sideBySide)
})
await check('F) 改动导航：显示 {current}/{total}，初始停在 0', () => {
  assert.equal(find(nodes, 'data-review-diff-change-count')?.props['data-review-diff-change-count'], '0/2')
  assert.equal(find(nodes, 'data-review-diff-prev-change')?.props.disabled, true, '还没导航时"上一个"应当禁用')
  assert.equal(find(nodes, 'data-review-diff-next-change')?.props.disabled, false)
})

click(find(nodes, 'data-review-diff-next-change'))
nodes = await rerender(DiffViewer, viewerProps)
await check('F) 点「下一个改动」→ 计数变 1/2，当前 hunk 被强调', () => {
  assert.equal(find(nodes, 'data-review-diff-change-count')?.props['data-review-diff-change-count'], '1/2')
  const active = findAll(nodes, 'data-review-diff-hunk-body').filter((node) => node.props['data-review-diff-hunk-active'] === '1')
  assert.equal(active.length, 1)
  assert.equal(active[0].props['data-review-diff-hunk-body'], '0')
})
click(find(nodes, 'data-review-diff-next-change'))
nodes = await rerender(DiffViewer, viewerProps)
await check('F) 到最后一个改动后「下一个」禁用', () => {
  assert.equal(find(nodes, 'data-review-diff-change-count')?.props['data-review-diff-change-count'], '2/2')
  assert.equal(find(nodes, 'data-review-diff-next-change')?.props.disabled, true)
})
click(find(nodes, 'data-review-diff-prev-change'))
nodes = await rerender(DiffViewer, viewerProps)
await check('F) 点「上一个改动」回到 1/2', () => {
  assert.equal(find(nodes, 'data-review-diff-change-count')?.props['data-review-diff-change-count'], '1/2')
})

// 切到统一模式：现有的四列行必须回来（并排是新增，统一没有被删掉）。
click(findAll(nodes, 'data-review-diff-mode-option').find((node) => node.props['data-review-diff-mode-option'] === unified))
nodes = await rerender(DiffViewer, viewerProps)
await check('F) 切到 Unified：回到四列统一行（行号两列 + 标记 + 正文）', () => {
  assert.equal(find(nodes, 'data-review-diff-body')?.props['data-review-diff-mode'], unified)
  assert.equal(findAll(nodes, 'data-review-sbs-row').length, 0)
  const kinds = findAll(nodes, 'data-review-diff-kind').map((node) => node.props['data-review-diff-kind'])
  assert.deepEqual(kinds, ['hunk', 'context', 'del', 'add', 'hunk', 'context', 'add', 'context'])
  // 行号两列是**固定四列布局的一部分**：两侧的 gutter 格子每行都有，只是某一侧没有行号时
  // 内容为空（删除行没有新行号、新增行没有旧行号）。因此两列各自都是 6 格 = 全部正文行。
  assert.equal(findAll(nodes, 'data-review-diff-line-old').length, 6, '每个正文行都有旧行号列')
  assert.equal(findAll(nodes, 'data-review-diff-line-new').length, 6, '每个正文行都有新行号列')
  const oldTexts = findAll(nodes, 'data-review-diff-line-old').map((node) => textOf(node))
  const newTexts = findAll(nodes, 'data-review-diff-line-new').map((node) => textOf(node))
  //   第 1 个 hunk：` keep`(1/1) → `-old one`(旧 2) → `+new one`(新 2)
  //   第 2 个 hunk：` tail`(10/10) → `+added tail`(新 11) → ` end`(旧 11 / 新 12)
  assert.deepEqual(oldTexts, ['1', '2', '', '10', '', '11'], `旧行号列：${oldTexts.join(',')}`)
  assert.deepEqual(newTexts, ['1', '', '2', '10', '11', '12'], `新行号列：${newTexts.join(',')}`)
  // 标记列：每一行都有一个（hunk 头也有一个占满整行的空标记格，见 `hunkHeaderRow` 的说明）。
  assert.equal(findAll(nodes, 'data-review-diff-sign').length, kinds.length)
})
await check('F) 模式偏好被记住（同一份 store，切回并排仍是并排）', () => {
  model.modeStore.set(sideBySide)
  assert.equal(model.modeStore.get(), sideBySide)
})

// =====================================================================================
console.log('')
console.log('=== G. 特殊文件：新文件 / 删除文件 / 重命名无内容变化 / 二进制 ===')
// =====================================================================================
await check('G) 新文件：左边全空、右边完整（对齐成 added）', () => {
  const newFile = ['@@ -0,0 +1,2 @@', '+line one', '+line two'].join('\n')
  const built = model.build(model.parse(newFile), sideBySide)
  const aligned = built.segments.find((segment) => segment.kind === 'hunk').aligned
  assert.deepEqual(shape(aligned), [
    ['added', '', 'line one'],
    ['added', '', 'line two'],
  ])
  assert.ok(aligned.every((row) => row.left === null))
})
await check('G) 删除文件：右边全空、左边完整（对齐成 deleted）', () => {
  const deleted = ['@@ -1,2 +0,0 @@', '-line one', '-line two'].join('\n')
  const built = model.build(model.parse(deleted), sideBySide)
  const aligned = built.segments.find((segment) => segment.kind === 'hunk').aligned
  assert.deepEqual(shape(aligned), [
    ['deleted', 'line one', ''],
    ['deleted', 'line two', ''],
  ])
  assert.ok(aligned.every((row) => row.right === null))
})
await check('G) 只有重命名（无内容变化）：模型里没有 hunk，视图给出专门提示', async () => {
  const renameDiff = ['diff --git a/old.ts b/new.ts', 'similarity index 100%', 'rename from old.ts', 'rename to new.ts'].join('\n')
  const built = model.build(model.parse(renameDiff), sideBySide)
  assert.equal(built.hunkCount, 0)
  const renameNodes = await mount(DiffViewer, {
    t: viewerProps.t,
    file: { path: 'new.ts', status: 'R', added: 0, removed: 0 },
    diff: renameDiff,
  })
  const body = find(renameNodes, 'data-review-diff-body')
  assert.equal(body.props['data-review-diff-state'], 'renamed')
  assert.match(textOf(body), /diffRenamedNoChanges/u)
})
await check('G) 二进制：不做文本 diff，给出"二进制文件已更改"', async () => {
  const binaryNodes = await mount(DiffViewer, {
    t: viewerProps.t,
    file: { path: 'logo.png', status: 'M' },
    diff: 'Binary files a/logo.png and b/logo.png differ',
  })
  const body = find(binaryNodes, 'data-review-diff-body')
  assert.equal(body.props['data-review-diff-state'], 'binary')
  const text = textOf(body)
  assert.match(text, /diffBinaryChanged/u)
  assert.equal(findAll(binaryNodes, 'data-review-sbs-row').length, 0, '二进制不该尝试并排渲染')
})

console.log('')
console.log(`${passed} 项通过${failed === 0 ? '' : `，${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
