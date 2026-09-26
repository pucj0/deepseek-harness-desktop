// 检查插件客户端里的本地化：面向用户的硬编码文案（注释与字典本身除外），
// 以及两份字典的键位是否一一对应。
//
//   node scripts/check-plugin-i18n.mjs [文件路径]
//
// 存在的理由：本地化最容易漏掉一两处，而漏掉的那处在英文界面下就会突然冒出中文（或者反过来，
// 中文界面里冒出一行英文）。更难发现的是**键位不齐**：某个键只在 en 里有，中文界面就会显示
// 原始键名或英文兜底，而代码评审时逐行比对两份字典并不现实。这个脚本把这两件事都变成可自动
// 检查的结论。
import { readFileSync } from 'node:fs'

const file = process.argv[2] ?? 'plugins/dsh-client-ui-gitbar/lib/client.js'
const lines = readFileSync(file, 'utf8').split('\n')

/** 取字典块的起止行（`const zh = {` … 独占一行的 `}`）。 */
function dictionaryRange(startIndex) {
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\}/u.test(lines[index])) return index
  }
  return lines.length - 1
}

/** 字典定义所在区间：这两块里的中文/英文是数据，不是硬编码文案。 */
const dictionaryBlocks = []
lines.forEach((line, index) => {
  if (/^\s*const (zh|en) = \{/u.test(line)) dictionaryBlocks.push([index, dictionaryRange(index)])
})

/** 判断某行是否落在字典块内。 */
function inDictionary(lineIndex) {
  return dictionaryBlocks.some(([from, to]) => lineIndex >= from && lineIndex <= to)
}

/** 取出某个语言字典里的键。 */
function dictionaryKeys(language) {
  const start = lines.findIndex((line) => new RegExp(`^\\s*const ${language} = \\{$`, 'u').test(line))
  if (start === -1) return undefined
  const end = dictionaryRange(start)
  const keys = []
  for (let index = start + 1; index < end; index += 1) {
    // 字典是扁平的 `key: '…',`：只认这一种形状，避免把嵌套对象的字段也算进来。
    const match = /^\s{2,}([A-Za-z_$][\w$]*):\s/u.exec(lines[index])
    if (match !== null) keys.push(match[1])
  }
  return keys
}

const HAN = /[\u4e00-\u9fff]/u
const findings = []
let parityFailures = 0

lines.forEach((line, index) => {
  const trimmed = line.trim()
  // 注释里的中文是说明，不是界面文案。
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
  if (inDictionary(index)) return
  // 显式豁免的诊断信息。
  //
  // 有些中文是给开发者看的（例如把服务实际提供的键名列进错误信息），它含技术细节，
  // 翻译反而无益。这类行以 `i18n-allow` 标记，比放宽整体规则更精确——也让人一眼看出
  // 那是有意为之，而不是漏掉了本地化。
  if (/i18n-allow/u.test(line)) return
  if (!HAN.test(line)) return
  findings.push({ line: index + 1, text: trimmed.slice(0, 100) })
})

console.log(`检查 ${file}`)
if (findings.length === 0) {
  console.log('  没有面向用户的硬编码中文文案')
} else {
  console.log(`  发现 ${findings.length} 处可疑文案：`)
  for (const item of findings) console.log(`    L${item.line}: ${item.text}`)
}

// ---- 字典键位对齐 -----------------------------------------------------------
// 一个键只存在于一种语言里，另一种语言下就会露出键名或英文兜底，而"半中半英"正是最难
// 一眼看出的本地化缺陷。这里只比对键，不比对措辞。
const zhKeys = dictionaryKeys('zh')
const enKeys = dictionaryKeys('en')
if (zhKeys === undefined || enKeys === undefined) {
  console.log('  字典块缺失（zh/en 至少一个没找到），跳过键位比对')
} else {
  const en = new Set(enKeys)
  const zh = new Set(zhKeys)
  const onlyZh = zhKeys.filter((key) => !en.has(key))
  const onlyEn = enKeys.filter((key) => !zh.has(key))
  parityFailures = onlyZh.length + onlyEn.length
  if (parityFailures === 0) {
    console.log(`  字典键位对齐（zh ${zhKeys.length} / en ${enKeys.length}）`)
  } else {
    if (onlyZh.length > 0) console.log(`  zh 独有的键（en 缺失）：${onlyZh.join(', ')}`)
    if (onlyEn.length > 0) console.log(`  en 独有的键（zh 缺失）：${onlyEn.join(', ')}`)
  }
}

if (findings.length === 0 && parityFailures === 0) process.exit(0)
process.exit(1)
