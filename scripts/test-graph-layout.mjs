// 验证提交图的泳道布局：plugins/dsh-client-ui-review/lib/graph-layout.js。
//
//   node scripts/test-graph-layout.mjs
//
// 为什么必须有它：这张图是「纯数据变换 + 渲染」两段拼出来的，而错的那一段几乎总是布局。
// 布局错了的表现是**看着像对的**——线还是连着的，只是连到了错误的祖先上，或者两条不相干的
// 分支被画成同一条、同一种颜色。这种错误在界面上没法一眼分辨（要拿真实仓库的
// `git log --graph` 对着看），所以这里把每条规则都钉成断言：谁在哪一列、合并从哪一列分叉、
// 根提交之后列号有没有回收、窗口外的父提交会不会永久占列、颜色会不会撞、上限截断后还画不画得出。
//
// 关于 `kind` 的读法：任务描述里「线性历史每一条边都是 through」与「第二行带有 commit 边」
// 两句不能同时成立——线性历史第二行只有一条边，不可能既是 through 又是 commit。本模块按
// `edges` 的详细语义实现，也按它断言：
//   * `commit`  —— 承载本行提交点的那条线（第一个父提交接管它继续往下）；
//   * `through` —— 经过本行、本行没有点的线（含汇入本行提交的那条线）；
//   * `merge`   —— 本行提交为额外的父提交分出去的一叉。
// 于是线性历史的每一行都是 `commit`（点自己的线），没有 `merge`，也没有任何「净穿过」的线。
// 下面把两种读法都覆盖：既钉「第二行有 commit 边」，也钉「没有 merge 边、没有净穿过的线」。
//
// 不依赖 Electron、不依赖网络、不碰真实仓库：夹具全是 'a'/'b'/'c' 这种假哈希。
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 用 pathToFileURL 从**本文件位置**推出模块路径，而不是用相对 cwd 的路径：这样从仓库根、
// 从 scripts/ 里、或从别的 cwd 调用都指向同一个文件。
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MODULE_URL = pathToFileURL(join(ROOT, 'plugins', 'dsh-client-ui-review', 'lib', 'graph-layout.js')).href

const { layoutGraph, COLOR_COUNT, LANE_COUNT_MAX_DEFAULT } = await import(MODULE_URL)

let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `（期望 ${expected}）`}`)
}
/** 断言为真。用于无法用等值表达的形状判断（集合性质、递增性之类）。 */
const checkTrue = (label, actual) => check(label, actual === true, true)

/** 把一行的边压成 `from->to:kind` 的短文本：整行形状因此能用一条断言钉住。 */
const edgeText = (row) => row.edges.map((edge) => `${edge.fromLane}->${edge.toLane}:${edge.kind}`).join(' ') || '-'

/** 一次布局里所有的边，供集合性质的断言使用。 */
const allEdges = (out) => out.rows.flatMap((row) => row.edges)

/** 深比较：输出只有字符串/数字/数组，没有循环引用，序列化比较足够且不需要任何依赖。 */
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** 深冻结：模块若试图写入入参，严格模式下会直接抛错，比事后比对更能说明问题。 */
const deepFreeze = (value) => {
  if (value === null || typeof value !== 'object') return value
  for (const inner of Object.values(value)) deepFreeze(inner)
  return Object.freeze(value)
}

// ---- 夹具：全部是显式的假哈希列表 ------------------------------------------------
//
// 每个夹具对应真实仓库里的一种形状，注释里写明「它代表什么」，这样断言失败时能立刻判断是
// 布局错了还是夹具的期望写错了。

/** 线性历史：一条主线，谁也不分叉。最常见的形状。 */
const LINEAR = [
  { hash: 'a', parents: ['b'] },
  { hash: 'b', parents: ['c'] },
  { hash: 'c', parents: ['d'] },
  { hash: 'd', parents: [] },
]

/** 一个普通合并提交，两个父提交都在窗口里。 */
const MERGE = [
  { hash: 'm', parents: ['a', 'b'] },
  { hash: 'a', parents: ['r'] },
  { hash: 'b', parents: ['r'] },
  { hash: 'r', parents: [] },
]

/** 窗口里只有一个合并提交，两个父提交都被截断在窗口外（分页最右端的极端情况）。 */
const LONE_MERGE = [{ hash: 'm', parents: ['a', 'b'] }]

/** 八爪鱼合并：一个提交直接合三个分支。 */
const OCTOPUS = [
  { hash: 'm', parents: ['a', 'b', 'c'] },
  { hash: 'a', parents: ['r'] },
  { hash: 'b', parents: ['r'] },
  { hash: 'c', parents: ['r'] },
  { hash: 'r', parents: [] },
]

/** 同样只有一个提交，但它是八爪鱼合并。 */
const LONE_OCTOPUS = [{ hash: 'm', parents: ['a', 'b', 'c'] }]

/**
 * 分叉：两条互不相干的分支尖端交错出现。
 *
 * 关键是**先出现的那条（f 分支）先结束**：它一结束，另一条（a→b）的列号必须往左收一格，
 * 否则图上会留下一列永久空着的竖线（`git log --graph` 不会这样画）。
 */
const FORK = [
  { hash: 'f1', parents: ['f2'] },
  { hash: 'a', parents: ['b'] },
  { hash: 'f2', parents: [] },
  { hash: 'b', parents: [] },
]

/** 分页边界：`m` 的第二个父提交不在窗口里（面板一次只取最近几条时的常态）。 */
const PAGED = [
  { hash: 'm', parents: ['a', 'paged-out'] },
  { hash: 'a', parents: ['r'] },
  { hash: 'r', parents: [] },
]

/** 每行都有一个父提交被截断：用来证明「窗口外的父提交不会让列数无限增长」。 */
const LONG_PAGED = []
for (let n = 1; n <= 8; n += 1) {
  LONG_PAGED.push(n === 8 ? { hash: `c${n}`, parents: [] } : { hash: `c${n}`, parents: [`c${n + 1}`, `x${n}`] })
}

/** 根提交之后紧跟一个无关的新提交：它必须用回被释放的列号。 */
const ROOT_FREE = [
  { hash: 'a', parents: ['b'] },
  { hash: 'b', parents: [] },
  { hash: 'c', parents: [] },
]

/** 同上，但先把两条分支都撑开，再让其中一条的根提交释放列。 */
const ROOT_TWO = [
  { hash: 'a', parents: ['b'] },
  { hash: 'x', parents: ['y'] },
  { hash: 'b', parents: [] },
  { hash: 'y', parents: ['z'] },
  { hash: 'z', parents: [] },
]

/**
 * 复用一个已有列：`m` 的第二个父提交 `q` 早就有一条线在等它。
 *
 * 这时**不能**为 `q` 另开一列：两条分支汇入同一个祖先，本来就该画在同一条线上。
 * 这个夹具同时是唯一会出现「同一行里两条边同色」的形状（一条是穿过 q 的线，一条是
 * 从 `m` 分叉进 q 的线），因此它专门用来钉「同色 ⟺ 同一条线」。
 */
const REUSE = [
  { hash: '1', parents: ['m'] },
  { hash: '2', parents: ['q'] },
  { hash: 'm', parents: ['a', 'q'] },
  { hash: 'a', parents: ['q'] },
  { hash: 'q', parents: [] },
]

/** 自引用父提交 + 重复哈希：都不许抛错，也不许让列数增长。 */
const SELF_DUP = [
  { hash: 'a', parents: ['a'] },
  { hash: 'a', parents: [] },
]

/** 乱序：父提交 `b` 出现在子提交 `a` 的**上面**（真实 `--topo-order` 不会这样）。 */
const SHUFFLED = [
  { hash: 'b', parents: [] },
  { hash: 'a', parents: ['b'] },
]

/** 各种形状混在一起，用于「确定性 / 不修改入参」的断言。 */
const MIXED = [
  { hash: 'm', parents: ['a', 'b'] },
  { hash: 'a', parents: ['c'] },
  { hash: 'b', parents: ['c', 'paged-out'] },
  { hash: 'c', parents: [] },
  { hash: 'z', parents: ['c'] },
]

/** 跑通用不变量的夹具（都不为空，且列数 ≤ 提交数）。 */
const INVARIANT_FIXTURES = {
  LINEAR,
  MERGE,
  OCTOPUS,
  FORK,
  PAGED,
  LONG_PAGED,
  ROOT_FREE,
  ROOT_TWO,
  REUSE,
  SELF_DUP,
  SHUFFLED,
  MIXED,
}

// ---- 0. 模块契约 -----------------------------------------------------------------

check('[0] layoutGraph 是函数', typeof layoutGraph, 'function')
check('[0] COLOR_COUNT', COLOR_COUNT, 10)
checkTrue(
  `[0] LANE_COUNT_MAX_DEFAULT 是正整数（${LANE_COUNT_MAX_DEFAULT}）`,
  Number.isInteger(LANE_COUNT_MAX_DEFAULT) && LANE_COUNT_MAX_DEFAULT >= 1,
)

const contract = layoutGraph(LINEAR)
check('[0] 顶层键恰好是 lanes/rows/truncated', Object.keys(contract).join(','), 'lanes,rows,truncated')
check('[0] 行的键恰好是 hash/lane/laneCount/edges', Object.keys(contract.rows[0]).join(','), 'hash,lane,laneCount,edges')
check('[0] 边的键恰好是 fromLane/toLane/color/kind', Object.keys(contract.rows[0].edges[0]).join(','), 'fromLane,toLane,color,kind')
check(
  '[0] 行的 hash 与输入顺序一致',
  contract.rows.map((row) => row.hash).join(','),
  LINEAR.map((commit) => commit.hash).join(','),
)

// 模块里混进一句 console.log 会把面板的日志刷满，而且单测里看不出来（这里主动抓一次）。
{
  const realLog = console.log
  let moduleLogs = 0
  console.log = () => {
    moduleLogs += 1
  }
  try {
    layoutGraph(MIXED)
  } finally {
    console.log = realLog
  }
  check('[0] 模块内没有 console.log', moduleLogs, 0)
}

// ---- 1. 线性历史 ----------------------------------------------------------------

const linear = layoutGraph(LINEAR)
check('[1] 线性历史每行的 lane（全程 lane 0）', linear.rows.map((row) => row.lane).join(','), '0,0,0,0')
check('[1] 线性历史的 lanes', linear.lanes, 1)
check('[1] 线性历史每行的 column 数', linear.rows.map((row) => row.laneCount).join(','), '1,1,1,1')
check(
  '[1] 线性历史每行的边（每行只有承载提交点的那条 commit 边）',
  linear.rows.map(edgeText).join(' | '),
  '0->0:commit | 0->0:commit | 0->0:commit | 0->0:commit',
)
checkTrue('[1] 线性历史里没有 merge 边', allEdges(linear).every((edge) => edge.kind !== 'merge'))
checkTrue(
  '[1] 线性历史里没有「净穿过」的 through 边（每条线都承载着一个点）',
  allEdges(linear).every((edge) => edge.kind === 'commit'),
)
check('[1] 第二行承载第一行提交点的 commit 边', edgeText(linear.rows[1]), '0->0:commit')
checkTrue(
  '[1] 第一行与第二行的 commit 边是同一条线（颜色相同）',
  linear.rows[0].edges[0].color === linear.rows[1].edges[0].color,
)

// ---- 2. 单个合并提交 -------------------------------------------------------------

const merge = layoutGraph(MERGE)
check('[2] 合并窗口的 lanes', merge.lanes, 2)
check('[2] 合并提交那一行', edgeText(merge.rows[0]), '0->0:commit 0->1:merge')
check('[2] 合并提交分出的 merge 边数量', merge.rows[0].edges.filter((edge) => edge.kind === 'merge').length, 1)
checkTrue(
  '[2] merge 边的 fromLane 就是提交自己的列',
  merge.rows[0].edges.filter((edge) => edge.kind === 'merge').every((edge) => edge.fromLane === merge.rows[0].lane),
)
check('[2] merge 边落在新开的第 1 列', merge.rows[0].edges.find((edge) => edge.kind === 'merge').toLane, 1)
check('[2] 合并窗口每行的 lane', merge.rows.map((row) => row.lane).join(','), '0,0,1,0')
check('[2] 两条线在共同祖先处合流（V 形）', edgeText(merge.rows[3]), '0->0:commit 1->0:through')
check('[2] 共同祖先之后没有残留的列', merge.rows[3].lane, 0)

const loneMerge = layoutGraph(LONE_MERGE)
check('[2] 父提交全在窗口外时，单个合并提交也给 2 列', loneMerge.lanes, 2)
check('[2] 父提交全在窗口外时，merge 边照样画出来', edgeText(loneMerge.rows[0]), '0->0:commit 0->1:merge')

// ---- 3. 八爪鱼合并（3 个父提交） --------------------------------------------------

const octopus = layoutGraph(OCTOPUS)
check('[3] 八爪鱼的 lanes', octopus.lanes, 3)
check('[3] 八爪鱼那一行', edgeText(octopus.rows[0]), '0->0:commit 0->1:merge 0->2:merge')
check('[3] merge 边数量', octopus.rows[0].edges.filter((edge) => edge.kind === 'merge').length, 2)
check(
  '[3] 两条 merge 边分别落到第 1、2 列',
  octopus.rows[0].edges.filter((edge) => edge.kind === 'merge').map((edge) => edge.toLane).join(','),
  '1,2',
)
check('[3] 八爪鱼那一行三条线的颜色互不相同', new Set(octopus.rows[0].edges.map((edge) => edge.color)).size, 3)
check('[3] 八爪鱼每行的 lane（三条线各占一列，不交叉）', octopus.rows.map((row) => row.lane).join(','), '0,0,1,2,0')
check('[3] 三条线在共同祖先处合流', edgeText(octopus.rows[4]), '0->0:commit 1->0:through 2->0:through')

const loneOctopus = layoutGraph(LONE_OCTOPUS)
check('[3] 父提交全在窗口外时，单个八爪鱼也给 3 列', loneOctopus.lanes, 3)
check(
  '[3] 父提交全在窗口外时，两条 merge 边照样画出来',
  loneOctopus.rows[0].edges.filter((edge) => edge.kind === 'merge').length,
  2,
)

// ---- 4. 两条分支交错（分叉后回收列） ----------------------------------------------

const fork = layoutGraph(FORK)
check('[4] 分叉窗口的 lanes', fork.lanes, 2)
check('[4] 分叉每行的 lane（先结束的那条让出列号）', fork.rows.map((row) => row.lane).join(','), '0,1,0,0')
check('[4] 分叉每行的 column 数', fork.rows.map((row) => row.laneCount).join(','), '1,2,2,1')
check('[4] 第二条分支尖端那一行', edgeText(fork.rows[1]), '0->0:through 1->1:commit')
check(
  '[4] f 分支结束后，另一条线从列 1 收到列 0（不留永久空隙）',
  edgeText(fork.rows[2]),
  '0->0:commit 1->0:through',
)
check('[4] 被让出的列号随后被 b 用上', fork.rows[3].lane, 0)
check('[4] 分叉行的两条线颜色不同', new Set(fork.rows[1].edges.map((edge) => edge.color)).size, 2)

// ---- 5. 窗口外的父提交（分页截断 / 嫁接边界） -------------------------------------

const paged = layoutGraph(PAGED)
check('[5] 不抛错且给出完整的行', paged.rows.length, PAGED.length)
check('[5] m 的第二个父提交在窗口外，仍画出一条 merge 边', edgeText(paged.rows[0]), '0->0:commit 0->1:merge')
check('[5] 窗口外的父提交只多占一行的列，随后释放', paged.rows.map((row) => row.laneCount).join(','), '2,2,1')
check('[5] 释放之后剩下的行只用 1 列', paged.rows[2].edges.length, 1)

const longPaged = layoutGraph(LONG_PAGED)
check('[5] 8 个窗口外父提交之后 lanes 仍然只有 2', longPaged.lanes, 2)
check(
  '[5] 8 行里用到的最大列号仍是 1（列数不随缺失父提交的数量增长）',
  Math.max(...allEdges(longPaged).flatMap((edge) => [edge.fromLane, edge.toLane])),
  1,
)
check(
  '[5] 每行的 column 数恒为 2',
  longPaged.rows.map((row) => row.laneCount).join(','),
  '2,2,2,2,2,2,2,2',
)
checkTrue('[5] 主线始终在 lane 0', longPaged.rows.every((row) => row.lane === 0))

// ---- 6. 根提交不留残余列 ---------------------------------------------------------

const rootFree = layoutGraph(ROOT_FREE)
check('[6] 根提交之后的新提交用回 lane 0', rootFree.rows.map((row) => row.lane).join(','), '0,0,0')
check('[6] 整个窗口只需要 1 列', rootFree.lanes, 1)
checkTrue(
  '[6] 根提交那一行没有别的线在往下走',
  rootFree.rows[1].edges.every((edge) => edge.kind === 'commit'),
)

const rootTwo = layoutGraph(ROOT_TWO)
check('[6] 两列时，根提交之后另一条线收到 lane 0', rootTwo.rows.map((row) => row.lane).join(','), '0,1,0,0,0')
check('[6] 两列的窗口 lanes', rootTwo.lanes, 2)
check('[6] y 把 z 也带到了 lane 0', rootTwo.rows[4].lane, 0)

// ---- 7~9、14. 所有夹具的通用不变量 ------------------------------------------------

for (const [name, fixture] of Object.entries(INVARIANT_FIXTURES)) {
  const out = layoutGraph(fixture)
  const edges = allEdges(out)

  checkTrue(
    `[7] ${name}: lanes(${out.lanes}) 不超过提交数(${fixture.length})`,
    out.lanes <= fixture.length,
  )
  checkTrue(
    `[8] ${name}: 每条边的 fromLane/toLane 都落在 [0, lanes)`,
    edges.every(
      (edge) =>
        Number.isInteger(edge.fromLane) &&
        Number.isInteger(edge.toLane) &&
        edge.fromLane >= 0 &&
        edge.fromLane < out.lanes &&
        edge.toLane >= 0 &&
        edge.toLane < out.lanes,
    ),
  )
  checkTrue(
    `[9] ${name}: 每行的 edges 按 fromLane 升序`,
    out.rows.every((row) => row.edges.every((edge, index) => index === 0 || row.edges[index - 1].fromLane <= edge.fromLane)),
  )
  checkTrue(
    `[8] ${name}: 每行的 lane 落在它自己声明的列数内`,
    out.rows.every((row) => row.lane >= 0 && row.lane < row.laneCount),
  )
  check(
    `[8] ${name}: lanes 等于各行列数的最大值`,
    out.lanes,
    Math.max(...out.rows.map((row) => row.laneCount)),
  )
  checkTrue(
    `[8] ${name}: kind 只取 through/commit/merge`,
    edges.every((edge) => edge.kind === 'through' || edge.kind === 'commit' || edge.kind === 'merge'),
  )
  checkTrue(
    `[8] ${name}: color 是 0..COLOR_COUNT-1 的整数`,
    edges.every((edge) => Number.isInteger(edge.color) && edge.color >= 0 && edge.color < COLOR_COUNT),
  )
  checkTrue(
    `[14] ${name}: 同一行里颜色相同的边指向同一条线（不会两条线撞色）`,
    out.rows.every((row) =>
      row.edges.every((edge) =>
        row.edges.filter((other) => other.color === edge.color).every((other) => other.toLane === edge.toLane),
      ),
    ),
  )
}

// 复用的那一列是「同色 ⟺ 同一条线」唯一真实的形状，单独钉一次，免得上面那条断言被写空。
{
  const reuse = layoutGraph(REUSE)
  const row = reuse.rows[2]
  check('[14] 复用已有列时，穿过 q 的线与分叉进 q 的线是同一个颜色', new Set(row.edges.map((edge) => edge.color)).size, 2)
  check(
    '[14] 复用已有列时，同色的两条边指向同一个 toLane',
    row.edges
      .filter((edge) => edge.color === row.edges.find((item) => item.kind === 'merge').color)
      .map((edge) => edge.toLane)
      .join(','),
    '1,1',
  )
  check('[14] 复用已有列时不会多开一列', reuse.lanes, 2)
}

// ---- 10. 确定性与「不修改入参」 --------------------------------------------------

{
  const snapshot = JSON.stringify(MIXED)
  const first = layoutGraph(MIXED)
  const second = layoutGraph(MIXED)
  checkTrue('[10] 两次布局的结果深度相等', deepEqual(first, second))
  checkTrue('[10] 入参没有被修改（序列化前后一致）', JSON.stringify(MIXED) === snapshot)
  checkTrue('[10] 对入参深拷贝后的结果与之一致', deepEqual(first, layoutGraph(structuredClone(MIXED))))
  checkTrue(
    '[10] 冻结的入参也能布局（模块不写入入参）',
    Array.isArray(layoutGraph(deepFreeze(structuredClone(MIXED))).rows),
  )
}

// ---- 11. maxLanes 截断 -----------------------------------------------------------

const clamped = layoutGraph(OCTOPUS, { maxLanes: 1 })
check('[11] maxLanes=1 时 truncated', clamped.truncated, true)
check('[11] maxLanes=1 时 lanes', clamped.lanes, 1)
check('[11] maxLanes=1 时行数不变（提交一个都不少）', clamped.rows.length, OCTOPUS.length)
checkTrue(
  '[11] maxLanes=1 时没有任何 lane/fromLane/toLane >= 1',
  clamped.rows.every(
    (row) => row.lane < 1 && row.laneCount <= 1 && row.edges.every((edge) => edge.fromLane < 1 && edge.toLane < 1),
  ),
)
checkTrue('[11] 没超过上限时 truncated 为假', layoutGraph(LINEAR, { maxLanes: 1 }).truncated === false)
check('[11] maxLanes=2 时 lanes', layoutGraph(OCTOPUS, { maxLanes: 2 }).lanes, 2)
check('[11] maxLanes=2 时 truncated', layoutGraph(OCTOPUS, { maxLanes: 2 }).truncated, true)
checkTrue(
  '[11] 非法 maxLanes(0) 退回默认上限而不是抛错',
  layoutGraph(OCTOPUS, { maxLanes: 0 }).lanes === 3 && layoutGraph(OCTOPUS, { maxLanes: 0 }).truncated === false,
)
checkTrue(
  '[11] 非法 maxLanes(小数/字符串) 同样不抛错',
  layoutGraph(OCTOPUS, { maxLanes: 2.5 }).lanes === 3 && layoutGraph(OCTOPUS, { maxLanes: 'x' }).lanes === 3,
)

// ---- 12. 空输入 ------------------------------------------------------------------

check('[12] 空数组的返回值', JSON.stringify(layoutGraph([])), '{"lanes":0,"rows":[],"truncated":false}')
check('[12] 空数组的 lanes', layoutGraph([]).lanes, 0)
check('[12] 空数组的 rows 长度', layoutGraph([]).rows.length, 0)
check('[12] 空数组的 truncated', layoutGraph([]).truncated, false)
check('[12] 只有一个根提交的窗口', JSON.stringify(layoutGraph([{ hash: 'a', parents: [] }])), JSON.stringify({
  lanes: 1,
  rows: [{ hash: 'a', lane: 0, laneCount: 1, edges: [{ fromLane: 0, toLane: 0, color: 0, kind: 'commit' }] }],
  truncated: false,
}))
checkTrue('[12] 不是数组的入参也不抛错', deepEqual(layoutGraph(undefined), layoutGraph([])))
checkTrue('[12] 元素形状不对也不抛错', Array.isArray(layoutGraph([null, {}, { hash: 'a', parents: 'b' }]).rows))
checkTrue(
  '[12] 非字符串父提交也不抛错',
  Array.isArray(layoutGraph([{ hash: 'a', parents: [null, 7] }]).rows),
)

// ---- 13. 颜色沿线下稳定 ----------------------------------------------------------

check(
  '[13] 线性历史每行 commit 边的颜色（同一条线同一个颜色）',
  linear.rows.map((row) => row.edges.find((edge) => edge.kind === 'commit').color).join(','),
  '0,0,0,0',
)
check(
  '[13] 分叉里主线穿过回收点后颜色不变（a 与 b 同色）',
  fork.rows[1].edges.find((edge) => edge.kind === 'commit').color,
  fork.rows[3].edges.find((edge) => edge.kind === 'commit').color,
)
check(
  '[13] 八爪鱼第三条线：从分叉处到它自己的点颜色一致',
  octopus.rows[0].edges.find((edge) => edge.toLane === 2).color,
  octopus.rows[3].edges.find((edge) => edge.kind === 'commit').color,
)
check(
  '[13] 合并窗口里共同祖先沿用的是主线颜色',
  merge.rows[3].edges.find((edge) => edge.kind === 'commit').color,
  merge.rows[0].edges.find((edge) => edge.kind === 'commit').color,
)

// ---- 附：退化的历史形状 ----------------------------------------------------------

const selfDup = layoutGraph(SELF_DUP)
check('[附] 自引用父提交不抛错且只有 1 列', selfDup.lanes, 1)
check('[附] 自引用父提交的两行都在 lane 0', selfDup.rows.map((row) => row.lane).join(','), '0,0')
const shuffled = layoutGraph(SHUFFLED)
check('[附] 父提交排在上面的乱序输入不抛错', shuffled.rows.length, 2)
check('[附] 乱序输入的 lanes', shuffled.lanes, 1)

console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
