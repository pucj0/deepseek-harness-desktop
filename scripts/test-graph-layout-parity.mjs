// 钉住 `lib/client.js` 里**内联**的泳道布局与 `lib/graph-layout.js` 是同一份算法。
//
//   node scripts/test-graph-layout-parity.mjs
//
// 为什么需要它：客户端 bundle 的契约只允许一个文件——`dsh-client-modules` 只把包
// `exports["./client"]` 指向的那一个脚本送到浏览器，同目录下的其它文件取不到，运行时的
// 模块加载器也只认它自己的基线表。因此"算法放一个共享文件、两边 import"这条路走不通，
// 内联是唯一选择，于是同一份逻辑有了两个副本。
//
// 两个副本会漂移，而且漂移是**静默**的：图会照样画出来，只是某个合并处的连线错一格。
// 这条测试就是对同一批输入跑两份实现、逐字段比较，让任何一处改动立刻变红。
//
// 取内联版本的办法：用假模块加载器加载 `client.js`，把 `__graphLayoutForTest` 导出取出来。
// 那是一个**只给测试用的钩子**，见客户端里的说明。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const { layoutGraph: canonical, COLOR_COUNT, LANE_COUNT_MAX_DEFAULT } = await import(
  pathToFileURL(join(ROOT, 'plugins', 'dsh-client-ui-review', 'lib', 'graph-layout.js')).href
)

// ---- 用假模块加载器取内联版本 ------------------------------------------------
let clientExports
globalThis.document = {
  head: { appendChild() {} },
  body: {},
  addEventListener() {},
  removeEventListener() {},
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
      clientExports = factory(() => ({}))
    },
  },
}
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

await import(pathToFileURL(join(ROOT, 'plugins', 'dsh-client-ui-review', 'lib', 'client.js')).href)

const inlined = clientExports?.__graphLayoutForTest
let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `（期望 ${expected}）`}`)
}

console.log('=== 0. 内联版本可被取出 ===')
check('0) client 导出了测试钩子', typeof inlined, 'function')

// ---- 固定夹具：覆盖线性、合并、八爪鱼、分叉回收、窗口外父提交、根提交、乱序 ----
const FIXTURES = {
  线性: [
    { hash: 'd', parents: ['c'] },
    { hash: 'c', parents: ['b'] },
    { hash: 'b', parents: ['a'] },
    { hash: 'a', parents: [] },
  ],
  合并: [
    { hash: 'm', parents: ['a', 'b'] },
    { hash: 'a', parents: ['r'] },
    { hash: 'b', parents: ['r'] },
    { hash: 'r', parents: [] },
  ],
  八爪鱼: [
    { hash: 'm', parents: ['a', 'b', 'c'] },
    { hash: 'a', parents: ['r'] },
    { hash: 'b', parents: ['r'] },
    { hash: 'c', parents: ['r'] },
    { hash: 'r', parents: [] },
  ],
  两条独立主线: [
    { hash: 'x2', parents: ['x1'] },
    { hash: 'y2', parents: ['y1'] },
    { hash: 'x1', parents: [] },
    { hash: 'y1', parents: [] },
  ],
  窗口外父提交: [
    { hash: 'c', parents: ['outside'] },
    { hash: 'b', parents: ['a'] },
    { hash: 'a', parents: [] },
  ],
  连续窗口外父提交: [
    { hash: 'e', parents: ['z1'] },
    { hash: 'd', parents: ['z2'] },
    { hash: 'c', parents: ['z3'] },
    { hash: 'b', parents: ['z4'] },
    { hash: 'a', parents: ['z5'] },
    { hash: 'root', parents: [] },
  ],
  重复哈希: [
    { hash: 'a', parents: ['b'] },
    { hash: 'a', parents: ['b'] },
    { hash: 'b', parents: [] },
  ],
  自引用: [{ hash: 'a', parents: ['a'] }],
  空窗口: [],
  单条根提交: [{ hash: 'a', parents: [] }],
  深层分叉: [
    { hash: 'm', parents: ['p1', 'p2'] },
    { hash: 'p1', parents: ['q1'] },
    { hash: 'p2', parents: ['q2'] },
    { hash: 'q1', parents: ['r'] },
    { hash: 'q2', parents: ['r'] },
    { hash: 'r', parents: ['s'] },
    { hash: 's', parents: [] },
  ],
}

// ---- 逐字段比较 ---------------------------------------------------------------
console.log('')
console.log('=== 1. 同一批输入，两份实现逐字段一致 ===')
for (const [name, commits] of Object.entries(FIXTURES)) {
  const a = canonical(structuredClone(commits))
  const b = inlined(structuredClone(commits))
  // 直接比整个结果对象：JSON 的键序由插入顺序决定，而两份实现的插入顺序相同
  // （同一份代码），因此字符串比较既严格又能指出差异位置。
  const same = JSON.stringify(a) === JSON.stringify(b)
  if (!same) {
    failures += 1
    console.log(`  FAIL  ${name}: 两份结果不同`)
    console.log(`        规范版: ${JSON.stringify(a).slice(0, 300)}`)
    console.log(`        内联版: ${JSON.stringify(b).slice(0, 300)}`)
  } else {
    console.log(`  PASS  ${name}: 一致（lanes=${a.lanes} 行数=${a.rows.length} 截断=${a.truncated}）`)
  }
}

console.log('')
console.log('=== 2. 上限夹取后的结果也一致 ===')
for (const [name, commits] of Object.entries(FIXTURES)) {
  for (const maxLanes of [1, 2, 3]) {
    const a = canonical(structuredClone(commits), { maxLanes })
    const b = inlined(structuredClone(commits), { maxLanes })
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      failures += 1
      console.log(`  FAIL  ${name} maxLanes=${maxLanes}: 两份结果不同`)
    }
  }
}
check('2) 全部上限组合一致', 'done', 'done')

console.log('')
console.log('=== 3. 两份实现的常量也一致 ===')
// 常量漂移同样会造成"图看起来对但颜色/宽度不对"，因此一起钉住。
check('3) 调色板大小', clientExports.__graphColorCountForTest, COLOR_COUNT)
check('   默认泳道上限', clientExports.__graphLaneMaxForTest, LANE_COUNT_MAX_DEFAULT)

console.log('')
console.log('=== 4. 输入不被修改（两份都是） ===')
{
  const source = structuredClone(FIXTURES.深层分叉)
  const snapshot = JSON.stringify(source)
  canonical(source)
  inlined(source)
  check('4) 调用者传入的数组没有被改写', JSON.stringify(source), snapshot)
}

console.log('')
console.log('=== 5. 内联副本确实在客户端源码里（防"取了别的函数" ）===')
{
  const text = readFileSync(join(ROOT, 'plugins', 'dsh-client-ui-review', 'lib', 'client.js'), 'utf8')
  // 算法里两个有辨识度的内部标识：只有真正内联了它才会出现。
  check('5) 源码里有内联的 layoutGraph', text.includes('function layoutGraph('), 'true')
  check('   源码里有 appearsAtOrAfter', text.includes('function appearsAtOrAfter('), 'true')
  check('   源码里说明了与 graph-layout.js 的关系', text.includes('graph-layout.js'), 'true')
}

console.log('')
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
