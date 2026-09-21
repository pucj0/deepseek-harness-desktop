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
        //
        // 注意：这段代码本身**在一个模板字符串里**，因此注释里不能出现反引号。
        // 抽屉现在是 Changes / Log 两个页签：默认停在 Changes（改动清单 + 提交区），
        // 提交记录在 Log 页签里（下面点过去再看）。
        hasTabs: (p.innerText || '').includes('Changes') && (p.innerText || '').includes('Log'),
        hasChangesPane: p.querySelector('[data-review-tab-body="changes"]') !== null,
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
// 关键需求：项目级要能看到 git 记录。现在它分成两个页签：默认的 Changes 与提交记录所在的 Log。
check('面板有 Changes | Log 两个页签', panel.hasTabs, 'true')
check('默认停在 Changes 页签', panel.hasChangesPane, 'true')
check('面板能确定工作区（未提示没有可用工作区）', panel.asksForWorkspace, 'false')
// 关键需求：工作区跟随当前对话，面板既不可编辑、也不展示绝对路径。
check('面板没有工作区选择器', panel.hasPicker, 'false')
check('面板不展示工作区路径', panel.showsPath, 'false')
console.log(`  面板开头: ${panel.head}`)
console.log(`  面板结尾: ${panel.tail}`)

console.log('')
console.log('=== Log 页签里的提交记录 ===')
await evaluate(`document.querySelector('[data-review-tab="log"]')?.click(), true`)
await wait(3000)
const logTab = JSON.parse(
  await evaluate(`
    (() => {
      const p = ${PANEL};
      if (!p) return '{"found":false}';
      return JSON.stringify({
        found: true,
        hasGraph: p.querySelector('[data-graph-view]') !== null,
        hasDetailPane: p.querySelector('[data-graph-pane="detail"]') !== null,
        hasCommitRow: /\\d{7}/.test(p.innerText || ''),
        body: (p.innerText || '').replace(/\\n+/g, ' | ').slice(0, 200),
      });
    })()
  `),
)
// 提交图必须真的渲染出来，而不只是切了个页签。
check('Log 页签里有提交图', logTab.hasGraph, 'true')
check('提交图是三栏（带详情栏）', logTab.hasDetailPane, 'true')
check('提交图里有提交条目（短哈希）', logTab.hasCommitRow, 'true')
console.log(`  Log 页签: ${logTab.body}`)

socket.close()
console.log('')
console.log(failures === 0 ? '项目级面板全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
