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
// （它验证的"点外部关闭 / 入口 toggle"已整体移除：开合改由官方侧栏负责。）
//
// 验证抽屉的关闭方式：点击外部、按 Escape；并确认点击入口按钮不会"一闪一关"。
//
//   node scripts/test-drawer-dismiss.mjs
//
// 需求是"点击其他地方需要关闭弹窗"。分支菜单早先已有这个行为，但审查抽屉一直没有——
// 它只能靠右上角的 × 关闭。这类缺陷用户只能感觉到"关不掉"，因此用脚本固化。
const PORT = Number(process.env.DSH_CDP_PORT ?? 9333)
const keyword = 'DeepSeek Harness'

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && String(t.title).includes(keyword))
if (page === undefined) {
  console.error(`找不到页面（端口 ${PORT}）`)
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
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `: ${detail}`}`)
}

// `data-review-trigger` 标在**外层 div** 上（供抽屉判定"哪块区域不算外部点击"），
// 而 `onClick` 在**内层 button** 上。点 div 不会触发 onClick——测试因此一度误报
// "点击无效"，实际是点错了元素。这里始终点 inner button。
const TRIGGER = `document.querySelector('[data-review-trigger="1"] button')`
const DRAWER = `document.querySelector('aside[style*=fixed]')`

/** 打开抽屉（先归零状态并重载，避免持久化状态造成"点一下反而关掉"）。 */
async function openDrawer() {
  await evaluate(`localStorage.removeItem('dsh.review.panelOpen'), location.reload(), true`)
  await wait(9000)
  await evaluate(`(${TRIGGER})?.click(), true`)
  await wait(1800)
  return (await evaluate(`Boolean(${DRAWER})`)) === true
}

console.log('=== 准备：打开抽屉 ===')
const opened = await openDrawer()
check('抽屉已打开', opened)

if (!opened) {
  socket.close()
  process.exit(1)
}

console.log('')
console.log('=== 点击抽屉内部：不应关闭 ===')
await evaluate(`
  (() => {
    const drawer = ${DRAWER};
    const inner = drawer.querySelector('div') || drawer;
    inner.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return true;
  })()
`)
await wait(800)
check('点击内部后仍打开', (await evaluate(`Boolean(${DRAWER})`)) === true)

console.log('')
console.log('=== 点击抽屉外部：应关闭 ===')
await evaluate(`
  (() => {
    // 点页面中间偏左的空白区：既不在抽屉里，也不在入口按钮上。
    const target = document.elementFromPoint(200, 400) || document.body;
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return true;
  })()
`)
await wait(900)
check('点击外部后已关闭', (await evaluate(`Boolean(${DRAWER})`)) === false)

console.log('')
console.log('=== Escape：应关闭 ===')
const reopened = await openDrawer()
check('重新打开成功', reopened)
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`)
await wait(800)
check('按 Escape 后已关闭', (await evaluate(`Boolean(${DRAWER})`)) === false)

console.log('')
console.log('=== 点击入口按钮：应是"打开"而不是一闪一关 ===')
const finalOpen = await openDrawer()
check('点入口后抽屉保持打开', finalOpen)

console.log('')
console.log('=== 分支菜单 / 入口按钮：不许被当成"外部" ===')
{
  // 需求：抽屉**占 80% 宽**，而分支右键菜单由 gitbar 渲染在 body 级（`position: fixed`），
  // 不在抽屉的 DOM 子树里。如果它被当成"外部"，用户一点菜单项抽屉就会消失——菜单还在、
  // 抽屉没了，看起来像两件事互相打架。这里用真实的 mousedown/mouseup/click 走一遍。
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`)
  await wait(500)
  const reopened = await openDrawer()
  check('前置：抽屉已重新打开', reopened)

  // 打开分支来源面板（composer 上方的工具条），并右键一行打开菜单。
  const menuOpened = await evaluate(`
    (() => {
      const chip = [...document.querySelectorAll('button')].find((el) => (el.getAttribute('title') || '').startsWith('Git:'));
      if (!chip) return 'no-chip';
      chip.click();
      return 'clicked';
    })()
  `)
  await wait(900)
  const rowInfo = await evaluate(`
    (() => {
      const panel = document.querySelector('[data-desktop-branch-menu]');
      if (!panel) return JSON.stringify({ ok: false, why: 'no-panel' });
      const rows = [...panel.querySelectorAll('[data-desktop-branch-option]')];
      const row = rows[0];
      if (!row) return JSON.stringify({ ok: false, why: 'no-row' });
      const r = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 10, clientY: r.top + 8 }));
      return JSON.stringify({ ok: true, name: row.getAttribute('data-desktop-branch-name') });
    })()
  `)
  const row = JSON.parse(rowInfo)
  if (row.ok !== true) {
    console.log(`  SKIP  分支菜单：${row.why}（chip=${menuOpened}）`)
  } else {
    await wait(700)
    const menuShown = await evaluate(`document.querySelector('[data-desktop-sc-menu]') !== null`)
    check('分支右键菜单已打开', menuShown)
    // 在菜单项上按下鼠标：**抽屉必须留着**（菜单自己是"内部"的一种延伸）。
    const clickedInsideMenu = await evaluate(`
      (() => {
        const menu = document.querySelector('[data-desktop-sc-menu]');
        if (!menu) return false;
        const item = menu.querySelector('[data-desktop-sc-menuitem]') || menu.firstElementChild;
        if (!item) return false;
        item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        return true;
      })()
    `)
    check('可在菜单里按下鼠标', clickedInsideMenu)
    await wait(700)
    check('点分支菜单内部后抽屉仍打开', (await evaluate(`Boolean(${DRAWER})`)) === true)

    // 点右上角入口：只 toggle 一次——捕获阶段的 mousedown 不能先关再开（那会闪一下）。
    await evaluate(`
      (() => {
        const el = ${TRIGGER};
        if (!el) return false;
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        el.click();
        return true;
      })()
    `)
    await wait(900)
    check('点入口后抽屉被关闭（toggle 生效且只生效一次）', (await evaluate(`Boolean(${DRAWER})`)) === false)
    check('入口按钮本身仍在', (await evaluate(`Boolean(${TRIGGER})`)) === true)
  }

  // 收尾：关掉分支面板，避免影响后续手工操作。
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`)
  await wait(400)
}

socket.close()
console.log('')
console.log(failures === 0 ? '抽屉关闭行为全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
