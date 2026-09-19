// 查清「项目改动」面板当前是**怎么决定显示哪个工作区**的。
//
//   node scripts/probe-project-workspace-choice.mjs
//
// 用户反馈面板显示的是应用自己的仓库（F:\code\dshDesktop），而他在用的项目是另一个
// （mmsm-amis）。要修就不能靠猜优先级——先把取值链上每一环的实际值打出来。
//
// 现在这一链的答案是"当前会话的 cwd"，因此在客户端的 `window.__dshDesktopReviewPanel`
// 上能看到 `session`（当前会话）、`hostCurrent`（外壳工作区）、`fromHooks`（登记列表）
// 与 `roots`（宿主允许名单）四个实际值。
import { readFileSync, existsSync } from 'node:fs'

const candidates = [
  `${process.env.APPDATA}\\dsh-desktop\\bundled-runtime\\runtime\\node_modules\\dsh-client-ui-review\\lib\\client.js`,
  'plugins/dsh-client-ui-review/lib/client.js',
]

const file = candidates.find((path) => existsSync(path))
if (file === undefined) {
  console.error('找不到 review 插件的客户端代码')
  process.exit(1)
}
console.log(`检查: ${file}`)
console.log('')

const text = readFileSync(file, 'utf8')

// 1) 决定工作区的那一行。
const line = /const workspace = session[^\n]*/u.exec(text)
console.log(`决定工作区: ${line === null ? '(未找到)' : line[0].trim()}`)

// 2) 当前工作区取自哪里，以及是否还保留"可编辑/可选"的入口。
const useCurrent = /function useCurrentWorkspace\(props\)\s*\{/u.exec(text)
if (useCurrent !== null) {
  const body = text.slice(useCurrent.index, useCurrent.index + 1200)
  console.log(`读当前会话: state.current -> byId[current].cwd = ${body.includes('state?.current') && body.includes('?.cwd')}`)
}
const picker = /createElement\(\s*'select'/u.test(text)
console.log(`仍有工作区选择器（select）: ${picker}`)
console.log(`工作区可编辑（onPick）: ${text.includes('onPick')}`)

// 3) 是否向宿主问过工作区清单，以及问到的清单是否包含所有已登记工作区。
console.log(`调用 /roots: ${text.includes("call('roots'")}`)
console.log(`候选来源含 roots: ${text.includes('roots.length > 0 ? roots : fromHooks')}`)

// 4) 面板正文里是否还会出现绝对路径（需求：不展示当前空间地址）。
const codeOnly = text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
const pathLiterals = [...codeOnly.matchAll(/'[A-Za-z]:\\\\[^']*'/gu)].map((match) => match[0])
console.log(`代码里写死的绝对路径字面量: ${pathLiterals.length === 0 ? '无' : pathLiterals.join(', ')}`)
console.log('')

// 5) 宿主侧到底会返回哪些工作区。
const hostFile = file.replace('client.js', 'index.js')
const host = readFileSync(hostFile, 'utf8')
const usesShell = host.includes('DSH_DESKTOP_WORKSPACE')
const usesRegistry = host.includes('workspace.json')
console.log('宿主 /roots 的来源:')
console.log(`  外壳工作区（DSH_DESKTOP_WORKSPACE）: ${usesShell}`)
console.log(`  应用登记的工作区（workspace.json）: ${usesRegistry}`)
