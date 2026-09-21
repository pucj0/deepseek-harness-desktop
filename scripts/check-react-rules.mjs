// 静态检查：两个客户端插件有没有触发"只有真实 React 才会报"的两类错误。
//
//   node scripts/check-react-rules.mjs [文件…]
//
// 为什么必须是静态检查：假 React 单测**抓不到**这两类问题。桩渲染器只按位置记录 hook 槽，
// 多调一个少调一个都不会报错；`ref` 被当成业务字段也照收不误。而真实 React 会直接抛：
//   * #310 Rendered more/fewer hooks than during the previous render（并把整棵子树卸掉）
//   * #290 Element ref was specified as a string but no owner was set /
//          Function components cannot be given refs
// 两者在实机上的表现都是"切换项目或点 Log 之后抽屉与右上角入口一起消失"，看起来像面板被
// 关掉了，实际是一次崩溃。真实渲染器下的回归由 `scripts/test-project-git-smoke.mjs` 跑
// （需要带远程调试端口的 Electron 实例），这个脚本负责在没有 Electron 的地方也挡住它。
//
// 检查三组规则：
//   A. 任何 hook 调用都不许出现在**函数体顶层的 `return` 之后**（early return 后面的
//      hook 会让两次渲染的 hook 数量不同）。
//   B. hook 不许出现在**条件表达式分支**里（`cond ? useX(...) : ...`、`a && useX(...)`）：
//      条件为真/假时数量就变了。要表达"可能缺席的钩子"，用 useLatchedHook 之类的写法
//      （见 client.js 里的说明），把条件收进选择器。
//   C. `react.createElement(SomeComponent, { ref: ... })` —— `ref` 是 React 的保留键，
//      传给**函数组件**时既不会进 props（业务代码读到 undefined），又会触发 #290。
//      只有宿主元素（小写字符串标签 `'div'` 等）才允许用 `ref`。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DEFAULT_FILES = [
  join(ROOT, 'plugins', 'dsh-client-ui-review', 'lib', 'client.js'),
  join(ROOT, 'plugins', 'dsh-client-ui-gitbar', 'lib', 'client.js'),
]

/** hook 调用的形状：`react.useXxx(`、`props.useSessions(`、`useSessions(` 这类标准源钩子。 */
const HOOK_CALL = /(?:react\.use[A-Z][A-Za-z]*|\.use(?:Sessions|Workspaces))\s*\(/u

/**
 * 从 `start` 行的 `{` 开始做括号配对，找出函数体的结束行。
 * @param lines - 文件的所有行。
 * @param start - 签名所在行的下标。
 * @returns 结束行的下标（含），找不到时返回 -1。
 */
function bodyEnd(lines, start) {
  let depth = 0
  let seen = false
  for (let i = start; i < lines.length; i += 1) {
    for (const ch of lines[i]) {
      if (ch === '{') {
        depth += 1
        seen = true
      } else if (ch === '}') {
        depth -= 1
        if (seen && depth === 0) return i
      }
    }
  }
  return -1
}

/**
 * 检查一个文件。
 * @param file - 文件路径。
 * @returns 违规列表 `{ line, kind, text }`。
 */
function checkFile(file) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const findings = []
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/u.exec(lines[i])
    if (match === null) continue
    const name = match[1]
    const end = bodyEnd(lines, i)
    if (end < 0) continue
    // 只有**会调 hook** 的函数才有必要查；纯工具函数直接跳过。
    const body = lines.slice(i, end + 1)
    if (!body.some((line) => HOOK_CALL.test(line))) continue

    // 函数体语句的基准缩进：取第一个非空行里最小的缩进。
    const indents = body
      .slice(1)
      .filter((line) => line.trim() !== '' && line.trim() !== '}')
      .map((line) => line.length - line.trimStart().length)
    const base = indents.length === 0 ? 0 : Math.min(...indents)

    // 规则 A：顶层 return（含 `if (...) return ...` 这种单行守卫，以及
    // `if (...) { ... return ... }` 这种块守卫）之后的 hook。
    //
    // 为什么把整块 if 也算进来：本项目要求的形状是"**所有 hook 都在最前面，之后才是
    // 任何阶段判断**"。只要那个 if 里含有 return，它就是一个"某些渲染会提前退出"的守卫，
    // 后面的 hook 数量就会随阶段变化。
    let guard = -1
    for (let j = i + 1; j <= end && guard < 0; j += 1) {
      const line = lines[j]
      const indent = line.length - line.trimStart().length
      if (indent !== base) continue
      const trimmed = line.trim()
      if (/^return\b/u.test(trimmed)) {
        guard = j
        continue
      }
      if (!/^(if|else)\b/u.test(trimmed)) continue
      if (/\breturn\b/u.test(trimmed)) {
        guard = j
        continue
      }
      // 多行守卫：看这个 if 块里有没有 return。
      const stop = bodyEnd(lines, j)
      if (stop < 0) continue
      for (let k = j + 1; k <= stop; k += 1) {
        if (/^\s*return\b/u.test(lines[k])) {
          guard = j
          break
        }
      }
    }
    if (guard >= 0) {
      for (let j = guard + 1; j <= end; j += 1) {
        if (!HOOK_CALL.test(lines[j])) continue
        findings.push({
          line: j + 1,
          kind: `hook after early return（${name} 的守卫在第 ${guard + 1} 行）`,
          text: lines[j].trim(),
        })
      }
    }

    // 规则 B：条件分支里的 hook。
    for (let j = i + 1; j <= end; j += 1) {
      const line = lines[j]
      const call = HOOK_CALL.exec(line)
      if (call === null) continue
      const prefix = line.slice(0, call.index)
      // `?.` 是可选链，不是分支；先把它去掉再找 `?` / `&&` / `||`。
      const cleaned = prefix.replace(/\?\./gu, '')
      if (/[?]|&&|\|\|/u.test(cleaned)) {
        findings.push({
          line: j + 1,
          kind: `conditional hook call（${name}）`,
          text: line.trim(),
        })
      }
    }
  }
  findings.push(...checkRefProps(lines))
  return findings
}

/**
 * 规则 C：`react.createElement(<组件>, { ref: … })`。
 *
 * 只查**大写开头的标识符**（函数组件 / 类组件的引用）：宿主元素写的是字符串标签
 * （`'div'`、`'button'`…），那些的 `ref` 是合法的。`menuRef`、`listRef` 这类自定义名字
 * 不受影响——它们与 React 的保留键无关。
 *
 * **只看 props 对象的顶层键**：`onPickRef: (name) => update({ ref: name })` 里的 `ref`
 * 在嵌套对象里，那是普通业务字段，不是 React 的 ref（早先按行匹配就误报了这一条）。
 *
 * @param lines - 文件的所有行。
 * @returns 违规列表。
 */
function checkRefProps(lines) {
  const findings = []
  const CREATE = /react\.createElement\(\s*([A-Za-z_$][\w$]*)\s*,\s*\{/gu
  for (let i = 0; i < lines.length; i += 1) {
    CREATE.lastIndex = 0
    let match = CREATE.exec(lines[i])
    while (match !== null) {
      const typeName = match[1]
      if (/^[A-Z]/u.test(typeName)) {
        const propsColumn = lines[i].indexOf('{', match.index)
        if (propsColumn >= 0) findings.push(...scanPropsKeys(lines, i, propsColumn, typeName))
      }
      match = CREATE.exec(lines[i])
    }
  }
  return findings
}

/**
 * 扫描一个 JSX-props 对象字面量，找出**顶层**的 `ref` 键。
 *
 * @param lines - 所有行。
 * @param startLine - props 对象开始的行。
 * @param startColumn - props 对象 `{` 所在的列。
 * @param typeName - 组件名（用于报错信息）。
 * @returns 违规列表。
 */
function scanPropsKeys(lines, startLine, startColumn, typeName) {
  const findings = []
  let depth = 0
  for (let line = startLine; line < lines.length; line += 1) {
    const text = line === startLine ? lines[line].slice(startColumn) : lines[line]
    let index = 0
    let closed = false
    while (index < text.length) {
      const ch = text[index]
      if (ch === '{') {
        depth += 1
        index += 1
        continue
      }
      if (ch === '}') {
        depth -= 1
        index += 1
        if (depth === 0) closed = true
        continue
      }
      if (depth === 1 && /[A-Za-z_$]/u.test(ch)) {
        let identifier = ''
        while (index < text.length && /[\w$]/u.test(text[index])) {
          identifier += text[index]
          index += 1
        }
        // 顶层键：`ref:`、`ref,`、`ref }`（简写）。**前面不能是 `.`**：`fresh.ref` 是属性
        // 访问，不是 props 的键（早先没排除，于是 `selectedRef: fresh.ref` 被误报）。
        const precededByDot = text[index - identifier.length - 1] === '.'
        if (identifier === 'ref' && !precededByDot && /^\s*[:,}]/u.test(text.slice(index))) {
          findings.push({ line: line + 1, kind: `ref prop passed to component <${typeName}>（React #290；业务字段请换名）`, text: lines[line].trim() })
        }
        continue
      }
      index += 1
    }
    if (closed) break
  }
  return findings
}

const files = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_FILES
let total = 0
for (const file of files) {
  const findings = checkFile(file)
  total += findings.length
  console.log(`检查 ${file}`)
  if (findings.length === 0) {
    console.log('  没有违规：hook 无条件且在 early return 之前；没有把 ref 传给组件')
    continue
  }
  for (const finding of findings) console.log(`  L${finding.line}: ${finding.kind}\n      ${finding.text}`)
  console.log(`  发现 ${findings.length} 处违规`)
}
process.exit(total === 0 ? 0 : 1)
