// Runtime 版本比较：**唯一事实来源**的纯函数测试（SemVer 2.0.0 优先级）。
//
//   node scripts/test-runtime-version.mjs
//
// 为什么单独立一个文件：1.7.5 的真实故障就是"同一个问题有三套比较器，其中两套只比
// major.minor.patch"。这个文件把规则本身钉死，并且额外做两件架构性断言：
//
//   * **只有一个实现**：`runtime-release.ts` / `runtime-updater.ts` / `paths.ts` 里不允许
//     再出现任何 `parse`/`compare` 形式的版本算法（正则解析 semver、或自己比较数字段）；
//   * **三个调用点都真的用了它**：release checker 的 available 判断、installer 的
//     升级/相同/降级三分支、`resolveRuntime()` 的下载版选择。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const { compareRuntimeVersions, isRuntimeVersionAtLeast, isRuntimeVersionNewer, isSafeRuntimeVersion, parseRuntimeVersion } = await import(
  '../dist/main/runtime-version.js'
)

let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `（期望 ${expected}）`}`)
}
const has = (label, ok) => check(label, ok === true, true)

console.log('=== 1. 需求给出的完整比较矩阵（left < right，且反向成立）===')
const MATRIX = [
  ['0.1.9', '0.2.0'],
  ['0.2.0-alpha', '0.2.0-alpha.1'],
  ['0.2.0-alpha.1', '0.2.0-alpha.2'],
  ['0.2.0-alpha.9', '0.2.0-alpha.10'],
  ['0.2.0-alpha.10', '0.2.0-beta.1'],
  ['0.2.0-beta.1', '0.2.0-rc.1'],
  ['0.2.0-rc.1', '0.2.0-rc.2'],
  ['0.2.0-rc.2', '0.2.0-rc.10'],
  ['0.2.0-rc.10', '0.2.0'],
  ['0.2.0', '0.2.1'],
]
for (const [left, right] of MATRIX) {
  const forward = compareRuntimeVersions(left, right)
  const backward = compareRuntimeVersions(right, left)
  const ok = forward < 0 && backward > 0
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${left} < ${right}（正 ${forward} / 反 ${backward}）`)
}

console.log('')
console.log('=== 2. 自己与自己相等 ===')
for (const version of ['0.2.0', '0.2.0-rc.2', '0.2.0-rc.10', '0.2.0-alpha.1', '1.0.0']) {
  check(`compare(${version}, ${version})`, compareRuntimeVersions(version, version), 0)
}

console.log('')
console.log('=== 3. 预发布标识符规则 ===')
// 数字 identifier 必须按**数值**比较：字符串序会得到 "10" < "2"，那是这个 bug 的另一面。
has('rc.10 > rc.2（按数值，不是按字符串）', compareRuntimeVersions('0.2.0-rc.10', '0.2.0-rc.2') > 0)
check('字符串序会得出相反结论（反证）', '10' < '2', true)
// 数字 identifier 优先级**低于**非数字。
has('alpha.1 < alpha.beta（数字 < 非数字）', compareRuntimeVersions('0.2.0-alpha.1', '0.2.0-alpha.beta') < 0)
has('alpha.beta > alpha.1', compareRuntimeVersions('0.2.0-alpha.beta', '0.2.0-alpha.1') > 0)
// 非数字按 ASCII 字典序。
has('alpha < beta < rc', compareRuntimeVersions('0.2.0-alpha', '0.2.0-beta') < 0 && compareRuntimeVersions('0.2.0-beta', '0.2.0-rc') < 0)
// identifier 更多的一方（前缀相同时）优先级更高。
has('alpha < alpha.1', compareRuntimeVersions('0.2.0-alpha', '0.2.0-alpha.1') < 0)
has('rc < rc.1', compareRuntimeVersions('0.2.0-rc', '0.2.0-rc.1') < 0)
// 正式版高于任何预发布。
has('0.2.0 > 0.2.0-rc.99', compareRuntimeVersions('0.2.0', '0.2.0-rc.99') > 0)
has('0.2.0-rc.99 < 0.2.0', compareRuntimeVersions('0.2.0-rc.99', '0.2.0') < 0)

console.log('')
console.log('=== 4. isRuntimeVersionNewer / isRuntimeVersionAtLeast ===')
has('rc.2 比 rc.1 新（1.7.5 的故障场景）', isRuntimeVersionNewer('0.2.0-rc.2', '0.2.0-rc.1'))
has('rc.1 不比 rc.2 新', isRuntimeVersionNewer('0.2.0-rc.1', '0.2.0-rc.2') === false)
has('rc.2 比 rc.2 不新（相同）', isRuntimeVersionNewer('0.2.0-rc.2', '0.2.0-rc.2') === false)
has('rc.10 比 rc.2 新', isRuntimeVersionNewer('0.2.0-rc.10', '0.2.0-rc.2'))
has('0.2.0 比 rc.10 新（正式版）', isRuntimeVersionNewer('0.2.0', '0.2.0-rc.10'))
has('没有基准时视为更新', isRuntimeVersionNewer('0.0.1', undefined))
has('rc.2 >= rc.2', isRuntimeVersionAtLeast('0.2.0-rc.2', '0.2.0-rc.2'))
has('rc.2 >= rc.1', isRuntimeVersionAtLeast('0.2.0-rc.2', '0.2.0-rc.1'))
has('rc.1 >= rc.2 为假', isRuntimeVersionAtLeast('0.2.0-rc.1', '0.2.0-rc.2') === false)

console.log('')
console.log('=== 5. 解析与安全检查 ===')
assert.deepEqual(parseRuntimeVersion('0.2.0-rc.1'), { major: 0, minor: 2, patch: 0, prerelease: ['rc', '1'] })
assert.deepEqual(parseRuntimeVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] })
check('parse 不可解析时 undefined', parseRuntimeVersion('v1.2.3'), undefined)
check('parse 拒绝 build metadata', parseRuntimeVersion('1.2.3+build'), undefined)
check('parse 拒绝空 identifier', parseRuntimeVersion('1.2.3-a..b'), undefined)
for (const bad of ['../escape', '..', 'a/b', 'a\\b', '', '.hidden', '1.2', 'v1.2.3', 'x'.repeat(80)]) {
  has(`isSafeRuntimeVersion 拒绝 ${JSON.stringify(bad)}`, isSafeRuntimeVersion(bad) === false)
}
has('isSafeRuntimeVersion 接受 0.2.0-rc.1', isSafeRuntimeVersion('0.2.0-rc.1') === true)

console.log('')
console.log('=== 6. 架构：只允许一份版本比较实现 ===')
{
  const files = {
    'runtime-version.ts': readFileSync(new URL('../src/main/runtime-version.ts', import.meta.url), 'utf8'),
    'runtime-release.ts': readFileSync(new URL('../src/main/runtime-release.ts', import.meta.url), 'utf8'),
    'runtime-updater.ts': readFileSync(new URL('../src/main/runtime-updater.ts', import.meta.url), 'utf8'),
    'paths.ts': readFileSync(new URL('../src/main/paths.ts', import.meta.url), 'utf8'),
  }
  /** 去掉注释：说明文字里会提到历史写法。 */
  const code = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^[ \t]*\/\/.*$/gmu, '')

  // 唯一实现：解析与比较都必须定义在这里。
  has('runtime-version.ts 定义了 parseRuntimeVersion', /export function parseRuntimeVersion\(/u.test(files['runtime-version.ts']))
  has('runtime-version.ts 定义了 compareRuntimeVersions', /export function compareRuntimeVersions\(/u.test(files['runtime-version.ts']))

  // 旧的重复实现必须消失。
  check('runtime-updater.ts 不再有 compareCore', code(files['runtime-updater.ts']).includes('compareCore'), false)
  check('runtime-updater.ts 不再有 isNewerRuntimeVersion 的本地实现', /function isNewerRuntimeVersion/u.test(code(files['runtime-updater.ts'])), false)
  check('paths.ts 不再有 compareVersions', code(files['paths.ts']).includes('compareVersions'), false)
  check('runtime-release.ts 不再有 parseVersion', /function parseVersion\b/u.test(code(files['runtime-release.ts'])), false)

  // 三处都必须 import 这一份。
  for (const name of ['runtime-release.ts', 'runtime-updater.ts', 'paths.ts']) {
    has(`${name} 从 runtime-version 导入`, /from '\.\/runtime-version'/u.test(files[name]))
  }
  // 不允许再出现"自己解析 semver 三段"的正则（那就是第四套比较器的开端）。
  for (const [name, text] of Object.entries(files)) {
    if (name === 'runtime-version.ts') continue
    check(`${name} 里没有 semver 解析正则`, /\^\(\\d\+\)\\\.\(\\d\+\)/u.test(code(text)), false)
  }
  // release checker 与 installer 都调用统一接口。
  has('release checker 用 isRuntimeVersionNewer', /isRuntimeVersionNewer\(latest\.version, current\)/u.test(files['runtime-release.ts']))
  has('installer 用 compareRuntimeVersions 做三态判断', /compareRuntimeVersions\(version, bundled\)/u.test(files['runtime-updater.ts']))
  has('paths 用 compareRuntimeVersions 做选择', /compareRuntimeVersions\(downloaded\.version, bundledVersion\)/u.test(files['paths.ts']))
}

console.log('')
if (failures > 0) {
  console.error(`Runtime 版本比较测试失败：${failures} 项`)
  process.exit(1)
}
console.log('Runtime 版本比较全部通过，且只有一份实现')
