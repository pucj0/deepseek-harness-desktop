// 验证项目级面板：入口存在、可展开、能取到工作区、并且显示提交历史。
//
//   node scripts/test-project-panel.mjs
//
// 需求是"进入项目就能点开侧边栏，不必先在对话里"。官方右侧栏做不到（其内容槽带
// scope: "session"），因此这块面板是自绘的、挂在全局覆盖层上。
//
// 需要 dev 实例带 --remote-debugging-port 启动。
const PORT = Number(process.env.DSH_CDP_PORT ?? 9333)
const keyword = 'DeepSeek Harness'

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && String(t.title).includes(keyword))
if (page === undefined) {
  console.error(`找不到页面（端口 ${PORT}），先启动带 --remote-debugging-port=${PORT} 的实例`)
  process.exit(1)
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  const entry = pending.get(message.id)
  if (entry === undefined) return
  pending.delete(message.id)
  entry(message.result?.result?.value)
})
await new Promise((resolve) => socket.addEventListener('open', resolve))

const evaluate = (expression) =>
  new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    socket.send(
      JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }),
    )
  })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (期望 ${expected})`}`)
}

/** 审查入口：右上角的固定按钮（title 固定为「项目改动」）。 */
const TRIGGER = `[...document.querySelectorAll('button')].find((el) => /项目改动/.test(el.getAttribute('title') || ''))`
const PANEL = `document.querySelector('aside[style*=fixed]')`

console.log('=== 入口 ===')
const triggerText = await evaluate(`(${TRIGGER})?.innerText?.trim() ?? 'not-found'`)
console.log(`  入口文案: ${triggerText}`)
check('项目页存在审查入口', triggerText !== 'not-found', 'true')

// 入口应当固定在视口右上角，不参与任何槽位布局。
const rect = JSON.parse(
  await evaluate(`
    (() => {
      const el = ${TRIGGER};
      if (!el) return '{"found":false}';
      const r = el.getBoundingClientRect();
      return JSON.stringify({ found: true, top: Math.round(r.top), right: Math.round(r.right), vw: window.innerWidth });
    })()
  `),
)
console.log(`  位置: ${JSON.stringify(rect)}`)
check('入口在视口内', rect.right <= rect.vw, 'true')

console.log('')
console.log('=== 展开 ===')
await evaluate(`(${TRIGGER})?.click(), true`)
await wait(6000)

const panel = JSON.parse(
  await evaluate(`
    (() => {
      const p = ${PANEL};
      if (!p) return '{"found":false}';
      const r = p.getBoundingClientRect();
      return JSON.stringify({
        found: true,
        // 只回传断言用得上的片段，而不是全文：文本可能上千字符，整段回传会因为
        // 序列化体积被截断成 undefined（实测踩到，断言因此全假失败）。
        hasHistoryTitle: (p.innerText || '').includes('最近提交'),
        hasCommitRow: /\\d{7}/.test(p.innerText || ''),
        asksForWorkspace: (p.innerText || '').includes('当前没有可用的工作区'),
        // 工作区必须不可编辑、也不展示路径。
        hasPicker: p.querySelector('select') !== null,
        showsPath: /[A-Za-z]:\\\\\\\\/.test(p.innerText || ''),
        head: (p.innerText || '').replace(/\\n+/g, ' | ').slice(0, 120),
        tail: (p.innerText || '').replace(/\\n+/g, ' | ').slice(-160),
        top: Math.round(r.top), left: Math.round(r.left),
        right: Math.round(r.right), bottom: Math.round(r.bottom),
        vw: window.innerWidth, vh: window.innerHeight,
      });
    })()
  `),
)
console.log(`  ${JSON.stringify(panel)}`)
check('面板已展开', panel.found, 'true')
check('面板在视口内（右）', panel.right <= panel.vw, 'true')
check('面板在视口内（下）', panel.bottom <= panel.vh, 'true')

console.log('')
console.log('=== 内容 ===')
// 关键需求：项目级要能看到 git 记录。
check('面板含「最近提交」一节', panel.hasHistoryTitle, 'true')
check('历史不再停留在加载中', !/最近提交 \| 正在读取差异/.test(panel.head + panel.tail), 'true')
check('面板能确定工作区（未提示没有可用工作区）', panel.asksForWorkspace, 'false')
// 关键需求：工作区跟随当前对话，面板既不可编辑、也不展示绝对路径。
check('面板没有工作区选择器', panel.hasPicker, 'false')
check('面板不展示工作区路径', panel.showsPath, 'false')
// 提交历史必须真的有条目，而不只是有个标题。
check('历史里有提交条目（短哈希）', panel.hasCommitRow, 'true')
console.log(`  面板开头: ${panel.head}`)
console.log(`  面板结尾: ${panel.tail}`)

socket.close()
console.log('')
console.log(failures === 0 ? '项目级面板全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
