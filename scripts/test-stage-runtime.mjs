// `stage-runtime.mjs` 里"依赖闭包截止时间"的离线单测。
//
//   node scripts/test-stage-runtime.mjs
//
// 为什么必须有它：这个截止时间决定了**内置运行时到底是哪一套依赖**。写错的后果不是构建报错，
// 而是悄悄装出另一套（缺失的半波新版本、或者被 `--before` 挡掉的合法新版本）——正是它要修的
// 那类事故。因此这里不跑网络：把 packument 当夹具喂进去，断言算出来的时间点与 npm 参数。
import {
  SAME_WAVE_WINDOW_MS,
  computeClosureBefore,
  npmInstallArgs,
  readPackument,
} from './stage-runtime.mjs'

let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `（期望 ${expected}）`}`)
}
const checkTrue = (label, actual) => check(label, actual === true, true)

const RC2 = '2026-09-10T14:57:10.790Z'
const RC3 = '2026-09-22T05:55:20.869Z'
const packument = {
  'dist-tags': { latest: '0.1.5-rc.2', next: '0.1.5-rc.3', alpha: '0.1.7-alpha.1' },
  versions: {
    '0.1.5-rc.2': { name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' },
    '0.1.5-rc.3': { name: '@deepseek-ai/dsh', version: '0.1.5-rc.3' },
  },
  time: { '0.1.5-rc.2': RC2, '0.1.5-rc.3': RC3 },
}

console.log('=== 1. 从 packument 解析要装的版本 ===')
{
  check('1) dist-tag latest 解析出版本', readPackument(packument, 'latest').version, '0.1.5-rc.2')
  check('   并且带出发布时间', readPackument(packument, 'latest').publishedAt, RC2)
  check('   精确版本也认', readPackument(packument, '0.1.5-rc.3').version, '0.1.5-rc.3')
  check('   不存在的版本不猜', readPackument(packument, '9.9.9').version, undefined)
  check('   packument 缺失时也不炸', readPackument(undefined, 'latest').version, undefined)
}

console.log('')
console.log('=== 2. 截止时间：发布时间 + 24 小时 ===')
{
  const latest = computeClosureBefore({ requested: 'latest', packument })
  check('2) latest → 版本', latest.version, '0.1.5-rc.2')
  check(
    '   截止 = 发布时间 + 24h',
    latest.before,
    new Date(Date.parse(RC2) + SAME_WAVE_WINDOW_MS).toISOString(),
  )
  checkTrue('   且 24h 窗口远早于下一波预发布', Date.parse(latest.before) < Date.parse(RC3))
  // 这正是今天的构建事故：latest(=rc.2) 的 `^0.1.5-rc.2` 范围会被解析到 rc.3 那一波。
  checkTrue('   截止时间把半波新版本挡在外面', Date.parse(latest.before) < Date.parse(RC3) - 86400_000)
  const pinned = computeClosureBefore({ requested: '0.1.5-rc.3', packument })
  check('   指定 rc.3 时截止跟着它走', pinned.before, new Date(Date.parse(RC3) + SAME_WAVE_WINDOW_MS).toISOString())
}

console.log('')
console.log('=== 3. 拿不到发布时间 / 版本时：不猜，退回不加 --before ===')
{
  const noTime = computeClosureBefore({ requested: 'latest', packument: { ...packument, time: undefined } })
  check('3) 没有 time → 不加截止', noTime.before, undefined)
  checkTrue('   并且给出可读的原因', String(noTime.note).includes('拿不到发布时间'))
  const unknown = computeClosureBefore({ requested: '9.9.9', packument })
  check('   未知版本 → 不加截止', unknown.before, undefined)
  const noPackument = computeClosureBefore({ requested: 'latest', packument: undefined })
  check('   packument 拿不到 → 不加截止', noPackument.before, undefined)
}

console.log('')
console.log('=== 4. 显式覆盖（排查用的逃生口）===')
{
  const off = computeClosureBefore({ requested: 'latest', packument, override: 'off' })
  check('4) DSH_STAGE_BEFORE=off → 不加截止', off.before, undefined)
  checkTrue('   并且说明是显式关闭', String(off.note).includes('off'))
  const explicit = computeClosureBefore({ requested: 'latest', packument, override: '2026-09-11T00:00:00Z' })
  check('   显式 ISO 时间被采用', explicit.before, '2026-09-11T00:00:00.000Z')
  const garbage = computeClosureBefore({ requested: 'latest', packument, override: 'not-a-date' })
  check('   解析不了的时间被忽略（不加截止）', garbage.before, undefined)
  checkTrue('   并且说明忽略了', String(garbage.note).includes('解析不了'))
}

console.log('')
console.log('=== 5. npm 参数：只有真的算出截止时间才带 --before ===')
{
  const base = { npmExecPath: '/npm-cli.js', runtime: '/runtime', registry: 'https://registry.npmmirror.com', requested: 'latest' }
  const withBefore = npmInstallArgs({ ...base, before: '2026-09-11T14:57:10.790Z' })
  checkTrue('5) 带 --before（加了截止时间）', withBefore.includes('--before'))
  check('   值就是算出来的时间', withBefore[withBefore.indexOf('--before') + 1], '2026-09-11T14:57:10.790Z')
  checkTrue('   仍然带上 registry 与 prefix', withBefore.includes('--registry') && withBefore.includes('--prefix'))
  check('   装的是 requested 那个版本', withBefore[withBefore.indexOf('install') + 1], '@deepseek-ai/dsh@latest')
  const without = npmInstallArgs(base)
  checkTrue('   没有截止时间时一个参数都不多带', !without.includes('--before'))
  check('   参数个数不变', without.length, withBefore.length - 2)
}

console.log('')
console.log(failures === 0 ? 'stage-runtime 截止时间测试全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
