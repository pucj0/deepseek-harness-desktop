// ⚠️ 历史脚本，**当前不可用**——它对准的 DOM 已经不存在。
//
// 本项目级 Git 曾经是**自制浮层抽屉**：入口 `[data-review-trigger]`、容器
// `aside[style*=fixed]`、开合状态 `localStorage['dsh.review.panelOpen']`，并且点外部会关闭。
// 那个抽屉与它的入口**已经全部删除**，现在项目级 Git 是**官方右侧栏里的 Git 标签**：
//
//   * 入口 = 官方侧栏的 Git 图标（标签类型与图标由 `sidebarRightTabs` 注册）；
//   * 正文 = `<aside data-desktop-review-surface="panel">`，`position: relative`，
//     尺寸/拖动/关闭/全屏全部由官方侧栏管理，插件不再自造；
//   * 定位 = `window.__dshDesktopGitTab`（`{ sessionId, workspace, switching }`）。
//
// 顺带一提：「本轮修改」是**另一个完全独立的 surface**（`TurnReviewChip` →
// `TurnReviewDrawer`，挂在 `shell.overlay`），不是这个 Git 标签，也不再经 `sidebarRight`。
//
// 因此：重新对准上面这套 DOM 之前，本文件跑不出结论。不需要 Electron 的等价回归在
// `scripts/test-git-sidebar-contract.mjs`、`scripts/test-turn-review-drawer.mjs`、
// `scripts/test-turn-review-scope.mjs`、`scripts/test-review-project-git.mjs`，
// 它们都在 `npm run test:git-sidebar` 里。
// （它诊断的"点了入口抽屉不开"已不存在：那个入口本身已删除。）
//
// 诊断：为什么点击入口按钮后抽屉没打开。
//
//   node scripts/probe-drawer-click.mjs
//
// `.click()` 只派发 click 事件，而真实点击是 mousedown -> mouseup -> click。抽屉的
// "点击外部关闭"监听 mousedown（捕获阶段），两者的交互可能与合成点击不同。这里对比
// 两种派发方式的结果，判断问题出在哪一环。
const PORT = Number(process.env.DSH_CDP_PORT ?? 9333)
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && String(t.title).includes('DeepSeek Harness'))
if (page === undefined) {
  console.error('找不到页面')
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

/** 复位成关闭状态。 */
async function reset() {
  await evaluate(`localStorage.removeItem('dsh.review.panelOpen'), location.reload(), true`)
  await wait(9000)
}

const STATE = `JSON.stringify({ stored: localStorage.getItem('dsh.review.panelOpen'), drawer: Boolean(document.querySelector('aside[style*=fixed]')) })`

console.log('=== 方式一：只派发 click（合成点击）===')
await reset()
await evaluate(`(document.querySelector('[data-review-trigger]')?.click(), true)`)
await wait(1500)
console.log(`  ${await evaluate(STATE)}`)

console.log('')
console.log('=== 方式二：完整事件序列（mousedown + mouseup + click）===')
await reset()
await evaluate(`
  (() => {
    const el = document.querySelector('[data-review-trigger]');
    if (!el) return 'no-trigger';
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    return 'dispatched';
  })()
`)
await wait(1500)
console.log(`  ${await evaluate(STATE)}`)

console.log('')
console.log('=== 方式三：只派发 mousedown（看它是否会关闭）===')
await reset()
await evaluate(`localStorage.setItem('dsh.review.panelOpen','1'), location.reload(), true`)
await wait(9000)
console.log(`  打开后: ${await evaluate(STATE)}`)
await evaluate(`
  (() => {
    const el = document.querySelector('[data-review-trigger]');
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    return 'mousedown';
  })()
`)
await wait(1200)
console.log(`  仅 mousedown 后: ${await evaluate(STATE)}`)

socket.close()
