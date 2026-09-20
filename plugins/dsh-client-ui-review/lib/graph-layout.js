// 提交图的泳道（lane / 列）布局：把 `git log --topo-order` 给出的平铺提交列表算成「每个提交
// 的点画在哪一列、行与行之间有哪些连线」，交给渲染器直接画成 SVG。
//
// 为什么把它单独拆成一个纯数据变换：真正的渲染在客户端插件里跑，而「哪条线在第几列」不需要
// React、不需要 DOM、也不需要调用 git。隔离出来之后就能在 node 里直接断言「合并提交分出的
// 第二条线落在哪一列」「根提交之后列号有没有回收」；否则验证这些形状得先把整个 Electron
// 渲染器跑起来，代价高到没人会去测。
//
// 输入前提（三条，任何一条错了图就会画歪）：
//   1. 提交按**显示顺序**给出：下标 0 最新、画在**最上面**一行；父提交一定在它后面的行。
//      实测本仓库 `git log --topo-order --pretty=format:'%H %P' -n 400`（140 个提交、其中
//      8 个合并提交、0 个八爪鱼合并）：没有任何一个父提交出现在子提交之前。所以下面各处
//      都用「后面的行」当「父提交可能出现的位置」；输入乱序时不会抛错，只是线会多拐一下。
//   2. 窗口一定是**被截断**的：父提交可能根本不在这个数组里。同一次实测里，取最近 20 条时
//      就正好有 1 个父提交落在窗口外（它是第 21 条）。因此「等不到的线」是常态而不是异常。
//   3. 输出里的 `lane` 是**本行的数组下标**，不是整张图的固定列号：每行的线都会向左紧凑，
//      同一列在不同行可能属于不同分支。渲染器必须按 `rows[i]` 加 `edges[].fromLane/toLane`
//      来画；把某一行的列号当成全局列号，线与点会随行错位。

/** 调色板大小：`color` 的取值恒在 `0..COLOR_COUNT-1` 之间。 */
export const COLOR_COUNT = 10

/**
 * 默认泳道上限。
 *
 * 实测本仓库全部 140 个提交里同时打开的线最多 3 条，所以 32 对真实仓库来说远够用；给默认值
 * 的真正理由是**画布宽度必须有界**：渲染器要用列数乘列宽得出一块画布的宽度，没有上限时一个
 * 畸形仓库（每个提交都合并好几个分支）能算出上千列，SVG 会宽到既画不出也没人看得懂。
 */
export const LANE_COUNT_MAX_DEFAULT = 32

/**
 * 计算一个提交窗口的泳道布局。
 *
 * @param {ReadonlyArray<{ hash: string, parents: ReadonlyArray<string> }>} commits
 *   显示顺序的提交：下标 0 最新、画在最上面一行。`parents` 是原始父哈希列表（第一项是第一个
 *   父提交）。父哈希**允许**不在 `commits` 里（分页截断、浅克隆/嫁接边界），不抛错。
 * @param {{ maxLanes?: number }} [options] `maxLanes` 给出这一屏最多画几列。
 * @returns {{ lanes: number, rows: Array<{ hash: string, lane: number, laneCount: number, edges: Array<{ fromLane: number, toLane: number, color: number, kind: 'through' | 'commit' | 'merge' }> }>, truncated: boolean }}
 */
export function layoutGraph(commits, options) {
  // 输入一律不信任：不是数组就当空窗口，元素形状不对就取兜底值。面板在「历史还没加载完」
  // 「仓库是空的」这些中间态下会照样调用它，这里抛一次异常就会让整块面板白屏。
  const list = Array.isArray(commits) ? commits : []
  const limit = normalizeLimit(options?.maxLanes)

  // 每个哈希**最后**出现的位置。一条线只要它的目标提交还在这之后出现，就值得继续占位；
  // 取「最后出现」而不是「下一次出现」，是因为重复哈希（同一个提交被列两次）也允许进来，
  // 两种写法在这种输入下的结论完全一样，而最后出现只需查一次表。
  const lastIndex = new Map()
  for (let i = 0; i < list.length; i += 1) {
    lastIndex.set(hashOf(list[i]), i)
  }

  const rows = []
  /**
   * 当前行开始时「活着的线」，按列紧凑排列（没有空洞），每项是 `{ hash, color }`，
   * `hash` 是这条线正在等的提交。行与行之间整体替换，元素本身从不就地修改。
   */
  let pending = []
  /** 整张图需要的列数 = 各行列数的最大值。空窗口是 0，与「没有行」保持一致。 */
  let lanes = 0

  for (let i = 0; i < list.length; i += 1) {
    const hash = hashOf(list[i])
    const parents = parentListOf(list[i])

    // 本行的列 = 上一行留下的线 + 需要时新开的一条（新分支尖端）。`slots` 就是这一行真正
    // 存在的线，后面每一步都按它的下标算列号。
    const slots = pending.slice()
    let lane = -1
    for (let j = 0; j < slots.length; j += 1) {
      if (slots[j].hash === hash) {
        lane = j
        break
      }
    }

    // 颜色取「当前任何活着的线都没占用」的最小非负整数。必须拿当前集合去算，不能按出现顺序
    // 编号：否则两条同时可见的线会撞色，图上就变成两条不相干的分支看起来是同一条，
    // 而用户正是靠颜色把一条分支从上读到下的。
    const usedColors = new Set(slots.map((line) => line.color))
    const takeColor = () => {
      for (let n = 0; n < COLOR_COUNT; n += 1) {
        if (!usedColors.has(n)) {
          usedColors.add(n)
          return n
        }
      }
      // 10 种颜色全在用（同时打开超过 10 条线）：调色板已经用满，只能复用。
      // 取「当前用色数对调色板取模」当轮转位置，保证返回值仍是 0..9 的稳定值。
      const recycled = usedColors.size % COLOR_COUNT
      usedColors.add(recycled)
      return recycled
    }

    let color
    if (lane < 0) {
      // 没有任何线在等它：这是并行的另一条分支的尖端，在右侧新开一列。
      lane = slots.length
      color = takeColor()
      slots.push({ hash, color })
    } else {
      // 有现成的线在等它，点就画在那条线上、沿用它的颜色——这正是「一条分支颜色不变」。
      color = slots[lane].color
    }

    // ---- 造下一行的线，同时记下每一列的去向 ---------------------------------
    //
    // `dest[j]` 是「本行第 j 列那条线，到了下一行在第几列」。线结束（不再向下）时 `dest[j]`
    // 取它自己这一列：渲染器于是只画一小段竖直的短头，而不是斜插到别的分支上去。
    const next = []
    const dest = new Array(slots.length).fill(0)
    const first = parents[0]

    // **必须一趟按列从左到右处理**，第一父提交的线就在轮到提交自己那一列时压进去。
    // 早先把它在整趟走完之后才追加，结果是它被排到了所有存活线的最后面：合并提交上面那条
    // 主线会从自己的列跳到最右列，而右边那条线同时左移，两线在图上凭空交叉一次。
    for (let j = 0; j < slots.length; j += 1) {
      if (j === lane) {
        // 第一个父提交接管提交自己的那一列，并沿用提交的颜色：主线于是笔直向下，而不是在
        // 每个提交处向旁边挪一格。它是**新建**的线，所以无条件占位——哪怕这个父提交在窗口
        // 外，这一叉也要画出来（渲染器据此在窗口下沿收住线头，而不是让线消失在半空中）。
        if (first === undefined) {
          // 根提交：本列到此为止，不再有线往下走。
          dest[j] = j
        } else {
          dest[j] = next.length
          next.push({ hash: first, color })
        }
        continue
      }
      const line = slots[j]
      if (line.hash === hash) {
        dest[j] = -1 // 汇入本提交的另一条线：等提交自己的那条线定下来再一起处理
        continue
      }
      if (appearsAtOrAfter(lastIndex, line.hash, i + 1)) {
        dest[j] = next.length
        next.push(line)
      } else {
        // 这条线等的提交再也不会出现了（被分页截断，或嫁接边界）。**必须**在这里把它丢掉：
        // 留着它这一列就永久空着，10 个这样的父提交就能把一屏挤成 10 列，而实际只有一条主线。
        dest[j] = j
      }
    }

    // 汇入本提交的其他线（同一个祖先被两条分支同时等待）：它们在本行结束，去向就是提交自己
    // 那条线的去向，于是图上画出一个「V」——两条线在点上合流后继续用同一条主线往下走。
    for (let j = 0; j < slots.length; j += 1) {
      if (j !== lane && slots[j].hash === hash) dest[j] = dest[lane]
    }

    // ---- 本行的边 -----------------------------------------------------------
    //
    // 每个存在的列都发一条边，`kind` 说明这条线在本行是什么角色。提交自己那一列恒为
    // `commit`（即使它是根提交、没有父提交）：渲染器得从这条边上拿到点的颜色，否则
    // 「只有一个根提交」的窗口里一个颜色都取不到，点只能画成黑色。
    //
    // 这类「不再向下」的边（根提交，或第一个父提交落在窗口外）表现为 `fromLane === toLane`，
    // 它只是点的颜色来源。渲染器手上有 `commits[i].parents`，据此对 `parents` 为空的行
    // 只画点、不画向下的连线即可——否则根提交下面会多出一段接在下一个提交点上的假线头。
    const edges = []
    for (let j = 0; j < slots.length; j += 1) {
      edges.push(
        j === lane
          ? { fromLane: j, toLane: dest[j], color, kind: 'commit' }
          : { fromLane: j, toLane: dest[j], color: slots[j].color, kind: 'through' },
      )
    }

    // 额外的父提交（第二、三……个）：各自占一条线。已经有线在等同一个父提交时**复用**那一列
    // ——两条分支汇入同一个祖先时它们本来就该画在同一条线上，另开一列会画出两条平行线，
    // 用户会以为那是两条独立分支。
    for (let p = 1; p < parents.length; p += 1) {
      const target = parents[p]
      let column = -1
      for (let k = 0; k < next.length; k += 1) {
        if (next[k].hash === target) {
          column = k
          break
        }
      }
      let mergeColor
      if (column < 0) {
        // 没有现成的线：在下一行最右边新开一列（第一列空闲位置），颜色取当前没被占用的。
        column = next.length
        mergeColor = takeColor()
        next.push({ hash: target, color: mergeColor })
      } else {
        mergeColor = next[column].color
      }
      edges.push({ fromLane: lane, toLane: column, color: mergeColor, kind: 'merge' })
    }

    // 按 fromLane 升序输出，渲染器可以一趟从左画到右。同列时保持插入顺序（提交自身的线在
    // 前、各条 merge 边按父提交顺序在后），`Array#sort` 是稳定排序，所以这个顺序是确定的。
    edges.sort((a, b) => a.fromLane - b.fromLane)

    let laneCount = lane + 1
    for (const edge of edges) {
      laneCount = Math.max(laneCount, edge.fromLane + 1, edge.toLane + 1)
    }
    if (laneCount > lanes) lanes = laneCount

    rows.push({ hash, lane, laneCount, edges })
    pending = next
  }

  // ---- 超出上限时压缩到前 maxLanes 列 ---------------------------------------
  //
  // 做法是**事后夹取**而不是在遍历中拒绝新列：遍历中的拒绝会让「哪些提交落在哪一列」依赖
  // 上限值，同一个仓库换个宽度就整张图重排。夹取只影响列号，行的顺序、边的条数、颜色都保持
  // 不变，于是 `truncated` 只是告诉渲染器「右边还有被压扁的线」。
  let truncated = false
  if (lanes > limit) {
    truncated = true
    const cap = limit - 1
    for (const row of rows) {
      row.lane = Math.min(row.lane, cap)
      row.laneCount = Math.min(row.laneCount, limit)
      for (const edge of row.edges) {
        edge.fromLane = Math.min(edge.fromLane, cap)
        edge.toLane = Math.min(edge.toLane, cap)
      }
    }
    lanes = limit
  }

  return { lanes, rows, truncated }
}

/**
 * 规范化泳道上限。
 *
 * 只接受 ≥1 的整数：`0`、负数、小数、字符串都退回默认值。让它们原样生效会出现「一列都不许
 * 画」这种无法表达的结果（`lane` 要落在 `[0, maxLanes-1]` 里），而抛错又会把面板带崩——
 * 这是客户端传来的可选参数，最安全的处理方式是当成没传。
 *
 * @param {unknown} value 调用方给出的 `maxLanes`。
 * @returns {number} 实际生效的上限（正整数）。
 */
function normalizeLimit(value) {
  return Number.isInteger(value) && value >= 1 ? value : LANE_COUNT_MAX_DEFAULT
}

/**
 * 取提交的哈希，形状不对时给空串。
 * @param {{ hash?: unknown } | undefined} commit 一个提交。
 * @returns {string} 哈希文本。
 */
function hashOf(commit) {
  const hash = commit?.hash
  return typeof hash === 'string' ? hash : String(hash ?? '')
}

/**
 * 取父提交哈希列表，形状不对时给空数组。
 *
 * 这一步是「遇到奇怪输入不许抛错」的主要落点：`parents` 可能是 `undefined`、可能不是数组、
 * 里面可能有非字符串。全部规整成字符串之后，后面的逻辑只需要处理「字符串」这一种情况。
 *
 * @param {{ parents?: unknown } | undefined} commit 一个提交。
 * @returns {string[]} 父提交哈希列表。
 */
function parentListOf(commit) {
  const parents = commit?.parents
  if (!Array.isArray(parents)) return []
  return parents.map((parent) => (typeof parent === 'string' ? parent : String(parent ?? '')))
}

/**
 * 判断某个哈希在 `from` 这一行（含）之后还会不会出现。
 *
 * 只用于「这条线还等不等得到人」。注意它与「这条线要不要新建」是两件事：窗口外的父提交
 * 该画的一叉照样要画（见上面第一条父提交的处理），只是不值得为它长期占着一列。
 *
 * @param {Map<string, number>} lastIndex 哈希 → 最后出现的行号。
 * @param {string} hash 目标哈希。
 * @param {number} from 起始行号（含）。
 * @returns {boolean} 还会出现则 true。
 */
function appearsAtOrAfter(lastIndex, hash, from) {
  const last = lastIndex.get(hash)
  return last !== undefined && last >= from
}
