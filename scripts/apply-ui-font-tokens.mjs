// 一次性改写：把 review 客户端里的内联字号改成跟随"设置 → UI 字号"的 uiPx() 派生值。
//
//   node scripts/apply-ui-font-tokens.mjs
//
// 为什么用脚本而不是手工改：这里有 90 多处内联 fontSize，手工改必然漏掉几处，而漏掉的表现
// 是"某个角落的字号不跟随设置"——正是这一版要修的问题。脚本只认 `fontSize: '<数字>px'`
// 这一种形态（内联样式），CSS 模板里那些已经写成 `${uiPx(N)}` 的声明不会被二次改写。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TARGET = join(ROOT, 'plugins', 'dsh-client-ui-review', 'lib', 'client.js')

const source = readFileSync(TARGET, 'utf8')
let hits = 0
const next = source
  // 内联字号：`fontSize: '12.5px'` → `fontSize: uiPx(12.5)`
  .replace(/fontSize: '(\d+(?:\.\d+)?)px'/g, (_match, px) => {
    hits += 1
    return `fontSize: uiPx(${px})`
  })
  // 分支徽标的行高与字号是配套的（见 [data-review-branch]），一起派生。
  .replace(/line-height: 17px;/g, () => {
    hits += 1
    return 'line-height: ${uiPx(17)};'
  })

writeFileSync(TARGET, next, 'utf8')
console.log(`apply-ui-font-tokens: ${hits} 处已改为 uiPx()`)
