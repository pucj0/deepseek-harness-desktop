// Unit check for the shell locale mapping. Run: node scripts/test-i18n.cjs
const i18n = require('../dist/main/i18n.js')

let allPass = true
function check(locale, expectedMenuUpdate) {
  const catalog = i18n.catalogFor(locale)
  const pass = catalog.menuUpdate === expectedMenuUpdate
  if (!pass) allPass = false
  const label = locale === undefined ? 'undefined' : JSON.stringify(locale)
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label.padEnd(14)} -> menuUpdate=${JSON.stringify(catalog.menuUpdate)}`)
}

// Chinese locales must all resolve to the Chinese catalog.
check('zh-CN', '更新')
check('zh-Hans-CN', '更新')
check('zh-TW', '更新')
check('zh', '更新')
// Everything else falls back to English.
check('en-US', 'Update')
check('de-DE', 'Update')
check('', 'Update')
check(undefined, 'Update')

const zh = i18n.catalogFor('zh-CN')
console.log('\nChinese samples:')
for (const key of ['menuFile', 'menuEdit', 'menuView', 'menuHelp', 'itemCheckUpdates', 'trayQuit', 'updateUpToDateTitle']) {
  console.log(`  ${key.padEnd(24)} ${zh[key]}`)
}

console.log('\nPlaceholder rendering:')
console.log('  ' + i18n.format(zh.updateAvailableTitle, { version: '0.1.5-rc.3' }))

// Every key must exist in both catalogs, or a lookup renders "undefined" in the UI.
const en = i18n.catalogFor('en')
const missing = Object.keys(en).filter((key) => typeof zh[key] !== 'string')
console.log(`\nKey parity en/zh: ${missing.length === 0 ? 'OK' : 'MISSING ' + missing.join(', ')}`)
if (missing.length > 0) allPass = false

/**
 * Runtime 应用内更新的文案。
 *
 * 这一组必须**双语都有**且**非空**：更新窗口的 Runtime 轨道是这一版新增的交互，
 * 一条漏译就会在界面上显示 `undefined`。同时钉住两处**内容**约束：
 *   * "无需 node/npm" 与 "应用内置 npm" 必须说清楚（否则用户会以为要先装 Node）；
 *   * 旧文案的两句话必须消失——"Runtime 只能随 Desktop Release 安装"与"用户侧永不运行 npm"
 *     在这一版都不再成立。
 */
const RUNTIME_KEYS = [
  'updateButtonRuntimeInstall',
  'updateRuntimeInstalling',
  'updateRuntimeProgress',
  'updateRuntimeFailedTitle',
  'updateRuntimeReadyTitle',
  'updateRuntimeReadyDetail',
  'updateRuntimeDownloadedNote',
  'updateRuntimeRollbackTitle',
  'updateRuntimeRollbackDetail',
]
console.log('\nRuntime in-app update strings:')
for (const key of RUNTIME_KEYS) {
  const enValue = en[key]
  const zhValue = zh[key]
  const ok = typeof enValue === 'string' && enValue.trim() !== '' && typeof zhValue === 'string' && zhValue.trim() !== ''
  if (!ok) allPass = false
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${key.padEnd(28)} en=${JSON.stringify(enValue)} zh=${JSON.stringify(zhValue)}`)
}
// 进度模板必须带 {line}，否则界面只会显示一句没有内容的说明。
for (const [locale, catalog] of [['en', en], ['zh', zh]]) {
  const ok = catalog.updateRuntimeProgress.includes('{line}')
  if (!ok) allPass = false
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${locale} updateRuntimeProgress 带 {line} 占位符`)
}

console.log('\nStale claims must be gone:')
const STALE = [
  /npm is never run on the user device/u,
  /不会在用户电脑运行 npm/u,
  /Install the compatible Desktop release when it appears/u,
  /包含该版本的 Desktop Release 上线后即可安装/u,
]
for (const pattern of STALE) {
  const hit = [en, zh].some((catalog) => Object.values(catalog).some((value) => typeof value === 'string' && pattern.test(value)))
  if (hit) allPass = false
  console.log(`  ${hit ? 'FAIL' : 'PASS'}  ${String(pattern)}`)
}

console.log(`\n${allPass ? 'ALL PASS' : 'FAILURES'}`)
process.exit(allPass ? 0 : 1)
