// 实测内置运行时的解包：耗时、文件数、校验和，并验证解出来的运行时能启动。
//
//   node scripts/test-unpack.mjs
//
// 这是本轮改动里最容易写错的一处（二进制归档的边界解析），所以单独可测；顺带量出耗时，
// 用来决定启动时要不要显示解包进度。
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureRuntimeUnpacked, reusableUnpacked } from '../dist/main/runtime-unpack.js'

const ARCHIVE = join(process.cwd(), 'build', 'runtime.br')
if (!existsSync(ARCHIVE)) {
  console.error(`缺少归档 ${ARCHIVE}，先运行 node scripts/compress-runtime.mjs`)
  process.exit(1)
}

const archiveMb = statSync(ARCHIVE).size / 1048576
console.log(`归档: ${archiveMb.toFixed(1)} MB`)

// 归档完整性：与 build/runtime.json 里记录的字节数比对。
//
// 这条断言是补上的：归档曾被截断成 21.5 MB（应为 42.9 MB），而测试只报了一句
// "unexpected end of file"——虽然解包器的报错行为是对的，但那时才发现的代价是
// 又要等 11 分钟重新压缩。体积不符说明归档本身就不完整，应当先被挡下。
const expected = JSON.parse(readFileSync(join(process.cwd(), 'build', 'runtime.json'), 'utf8'))
const actualBytes = statSync(ARCHIVE).size
if (expected.archiveBytes !== actualBytes) {
  console.error(
    `归档体积与 runtime.json 记录不符：实际 ${(actualBytes / 1048576).toFixed(1)} MB，` +
      `记录 ${(expected.archiveBytes / 1048576).toFixed(1)} MB。归档可能被截断，请重新运行 compress-runtime.mjs。`,
  )
  process.exit(1)
}
console.log(`  与 runtime.json 一致（${expected.files} 个文件 / ${(expected.rawBytes / 1048576).toFixed(1)} MB 原始）`)

const scratch = mkdtempSync(join(tmpdir(), 'dsh-unpack-'))
let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (期望 ${expected})`}`)
}

try {
  // 1) 首次解包
  //
  // 顺带断言进度百分比的取值范围。这条断言是补上的：早先进度用"解压后字节数"除以
  // "归档大小"（197.6 MB / 42.9 MB），界面显示到 444%，而当时的测试只验证了"能解包"、
  // 没有验证进度是否合理，所以没能发现。
  const percents = []
  const started = Date.now()
  const first = await ensureRuntimeUnpacked(ARCHIVE, scratch, (readBytes, archiveBytes) => {
    percents.push((readBytes / Math.max(archiveBytes, 1)) * 100)
  })
  const seconds = (Date.now() - started) / 1000

  console.log('')
  console.log(`首次解包: ${seconds.toFixed(1)}s  文件 ${first.files} 个`)
  check('标记为已解包', first.unpacked, 'true')
  check('进度回调被调用', percents.length > 0, 'true')
  check('进度最大值不超过 100', Math.max(...percents) <= 100, 'true')
  check('进度最小值不小于 0', Math.min(...percents) >= 0, 'true')
  check('进度最终接近 100', Math.round(percents[percents.length - 1]) >= 99, 'true')
  console.log(`       进度采样 ${percents.length} 次，峰值 ${Math.max(...percents).toFixed(1)}%`)
  check('node 可执行文件存在', existsSync(join(first.dir, 'runtime', 'node', 'node.exe')), 'true')
  check(
    'dsh 锚点存在',
    existsSync(join(first.dir, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')),
    'true',
  )
  // 三个内置插件都要随包。只查一个不够：`scripts/sync-plugins.mjs` 是按目录自动带走的，
  // 而"某个插件目录没被 stage 进压缩包"这种错误在只抽查一个插件时完全看不出来。
  for (const plugin of ['dsh-client-ui-gitbar', 'dsh-client-ui-review', 'dsh-client-ui-typography']) {
    check(
      `插件随包（${plugin}）`,
      existsSync(join(first.dir, 'runtime', 'node_modules', plugin, 'package.json')),
      'true',
    )
  }
  // 附属文件也要在包里：提交图的泳道算法是独立文件，客户端 bundle 之外还要能被
  // 开发期的单测按路径读到（见 test-graph-layout.mjs / test-graph-layout-parity.mjs）。
  check(
    '插件附属文件随包（graph-layout.js）',
    existsSync(join(first.dir, 'runtime', 'node_modules', 'dsh-client-ui-review', 'lib', 'graph-layout.js')),
    'true',
  )
  // host 侧新增的模块同样必须在包里：`lib/index.js` 是**静态 import** 它的，缺了就是
  // 插件加载失败（整个 git 面板消失），而不是"某个功能不好用"。
  check(
    '插件附属文件随包（commit-message.js）',
    existsSync(join(first.dir, 'runtime', 'node_modules', 'dsh-client-ui-review', 'lib', 'commit-message.js')),
    'true',
  )

  // 2) 二次调用应复用，不再解包
  const againStarted = Date.now()
  const second = await ensureRuntimeUnpacked(ARCHIVE, scratch)
  const againSeconds = (Date.now() - againStarted) / 1000
  check('二次调用复用', second.unpacked, 'false')
  console.log(`二次调用: ${againSeconds.toFixed(2)}s（应远小于首次）`)
  check('复用确实很快', againSeconds < 2, 'true')
  check('reusableUnpacked 认可', reusableUnpacked(first.dir, ARCHIVE) !== undefined, 'true')

  // 3) 完整性：解出来的 node.exe 与非压缩源一致（抽查关键文件）
  const sourceNode = join(process.cwd(), 'runtime', 'node', 'node.exe')
  if (existsSync(sourceNode)) {
    const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
    check('node.exe 内容一致', hash(join(first.dir, 'runtime', 'node', 'node.exe')), hash(sourceNode))
  }

  // 4) 解出来的运行时能真正启动
  const { execFileSync } = await import('node:child_process')
  const out = execFileSync(join(first.dir, 'runtime', 'node', 'node.exe'), ['-e', 'console.log("node ok", process.version)'], {
    encoding: 'utf8',
    timeout: 30000,
  })
  check('解出的 node 可运行', out.trim().startsWith('node ok'), 'true')
  console.log(`       ${out.trim()}`)
} catch (error) {
  failures += 1
  console.error('测试异常:', String(error.message).slice(0, 400))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log('')
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
