// 验证"点击审查概览 -> 打开官方右侧栏标签"这条链路。
//
//   node scripts/test-review-sidebar.mjs
//
// 需求是把审查从自制浮层改为用官方自带的侧边栏。这条链路的每一环都可能悄悄失败：
// sidebarRight 服务没注入、keyed 槽位没登记、openTab 的类型名不匹配——而失败的表现
// 只是"点了没反应"，从界面看不出原因。因此这里逐环断言。
const keyword = 'DeepSeek Harness'

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && String(t.title).includes(keyword))
if (page === undefined) {
  console.error('找不到页面，先启动带 --remote-debugging-port=9222 的实例')
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

/** 精确定位审查概览入口。
 *
 * 不能用"文本含本轮"来匹配：分支徽章的文本也可能含同样的字，早先因此点错了按钮，
 * 而失败表现只是"点了没反应"，很难看出是点错了。这里用专用标记精确匹配。 */
const CHIP = `document.querySelector('[data-desktop-review]')`

/** 侧边栏是否可见：找右侧栏容器。 */
const SIDEBAR_STATE = `
  (() => {
    const chip = ${CHIP};
    const titleNode = [...document.querySelectorAll('*')].find(
      (el) => el.children.length === 0 && (el.innerText || '').trim() === '本轮修改审查',
    );
    // 收起时标签仍挂载，必须同时检查侧栏的展开状态。
    const panel = titleNode?.closest('[data-sidebar-right-panel]');
    return JSON.stringify({
      chip: Boolean(chip),
      chipLabel: chip ? chip.innerText.trim() : null,
      tabTitle: Boolean(titleNode),
      reviewVisible: Boolean(panel?.hasAttribute('data-sidebar-right-open')),
      hasBinaryNote: (document.body.innerText || '').includes('二进制'),
    });
  })()
`

// 从收起状态开始，让脚本可反复运行。
await evaluate(`document.querySelector('[data-sidebar-right-open] [data-sidebar-right-toggle]')?.click()`)
await wait(300)
console.log('=== 打开前 ===')
let state = JSON.parse(await evaluate(SIDEBAR_STATE))
console.log(`  ${JSON.stringify(state)}`)
check('概览入口存在', state.chip, 'true')

console.log('')
console.log('=== 点击概览入口 ===')
const clicked = await evaluate(`
  (() => {
    const chip = ${CHIP};
    if (!chip) return 'no-chip';
    chip.click();
    return 'clicked';
  })()
`)
check('点击成功', clicked, 'clicked')
await wait(2500)

state = JSON.parse(await evaluate(SIDEBAR_STATE))
console.log(`  ${JSON.stringify(state)}`)
check('侧边栏出现了审查标签', state.tabTitle, 'true')
check('审查面板已展开', state.reviewVisible, 'true')

// 再点一次收起，第三次重新打开同一审查面板。
console.log('')
console.log('=== 再点一次（应收起）===')
await evaluate(`
  (() => {
    const chip = ${CHIP};
    chip?.click();
    return true;
  })()
`)
await wait(1500)
state = JSON.parse(await evaluate(SIDEBAR_STATE))
check('再次点击收起审查面板', state.reviewVisible, 'false')
check('收起保留审查标签', state.tabTitle, 'true')
await evaluate(`${CHIP}?.click()`)
await wait(1500)
state = JSON.parse(await evaluate(SIDEBAR_STATE))
check('第三次点击重新打开审查面板', state.reviewVisible, 'true')

// 标签正文应显示内容（本仓库有改动；若恰好干净则应显示"没有改动"）。
const body = await evaluate(`
  (() => {
    const text = document.body.innerText || '';
    const markers = ['个文件', '没有改动任何文件', '尚未记录基线', '没有发现 Git 仓库', '正在读取差异'];
    return markers.find((m) => text.includes(m)) || '(无匹配)';
  })()
`)
console.log(`  标签正文状态标记: ${body}`)
check('标签正文有内容', body !== '(无匹配)', 'true')

socket.close()
console.log('')
console.log(failures === 0 ? '侧边栏链路全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
