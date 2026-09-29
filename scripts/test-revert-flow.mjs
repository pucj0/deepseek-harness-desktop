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
// （还原功能仍在 Git 标签里，只需把入口与容器选择器对准新 DOM。）
//
// 端到端验证"还原"：造一个未跟踪的新文件 → 在抽屉里找到它 → 还原 → 确认文件真的被删掉。
//
//   node scripts/test-revert-flow.mjs [仓库路径]
//
// 用户反馈"AI 新增的文件点击还原还原不了"。服务端在独立仓库里能正确删除，所以问题在
// 客户端到服务端的这一段。这个脚本走真实界面，把每一环都断言出来。
//
// 会在目标仓库里创建并随后删除一个临时文件；默认用工作区，路径可用参数覆盖。
const PORT = Number(process.env.DSH_CDP_PORT ?? 9333)
const workspace = process.argv[2] ?? 'F:\\code\\dshDesktop'
const SCRATCH = '.dsh-revert-probe.txt'

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && String(t.title).includes('DeepSeek Harness'))
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

const TRIGGER = `document.querySelector('[data-review-trigger="1"] button')`
const DRAWER = `document.querySelector('aside[style*=fixed]')`

try {
  // 造出"AI 新建的文件"。
  const { writeFileSync, existsSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const scratchPath = join(workspace, SCRATCH)
  writeFileSync(scratchPath, 'created by the revert flow test\n')
  console.log(`已创建未跟踪文件: ${scratchPath}`)

  // 复位抽屉状态并打开（面板开关是持久化且模块加载时读入内存的，必须重载才归零）。
  await evaluate(`localStorage.removeItem('dsh.review.panelOpen'), location.reload(), true`)
  await wait(9000)
  await evaluate(`(${TRIGGER})?.click(), true`)
  await wait(3000)

  const drawerText = await evaluate(`(${DRAWER})?.innerText ?? ''`)
  check('抽屉里列出了这个新文件', String(drawerText).includes(SCRATCH), String(drawerText).slice(0, 120))

  // 找到该文件所在行，点它的"还原"按钮。
  const clicked = await evaluate(`
    (() => {
      const drawer = ${DRAWER};
      if (!drawer) return 'no-drawer';
      // 找到包含该文件路径的行，再点其中的还原按钮（title 为"还原"）。
      const rows = [...drawer.querySelectorAll('div')].filter((el) => (el.innerText || '').includes(${JSON.stringify(SCRATCH)}));
      if (rows.length === 0) return 'no-row';
      // 取最内层的那一行（避免命中整个列表容器）。
      const row = rows[rows.length - 1];
      const button = [...(row.parentElement ?? row).querySelectorAll('button')].find((b) => (b.getAttribute('title') || '') === '还原');
      if (!button) return 'no-button';
      button.click();
      return 'clicked';
    })()
  `)
  check('点击了还原按钮', clicked === 'clicked', clicked)

  // 应弹出确认框。
  await wait(1000)
  const dialogShown = await evaluate(`Boolean(document.querySelector('[role=dialog]'))`)
  check('弹出了确认框', dialogShown === true)

  if (dialogShown === true) {
    const confirmed = await evaluate(`
      (() => {
        const dialog = document.querySelector('[role=dialog]');
        const ok = [...dialog.querySelectorAll('button')].find((b) => /还原|Revert/.test((b.innerText || '').trim()));
        if (!ok) return 'no-confirm-button';
        ok.click();
        return 'confirmed';
      })()
    `)
    check('点击了确认', confirmed === 'confirmed', confirmed)
  }

  await wait(3000)
  check('文件已被删除', !existsSync(scratchPath), String(existsSync(scratchPath)))

  const after = await evaluate(`(${DRAWER})?.innerText ?? ''`)
  check('文件已从列表消失', !String(after).includes(SCRATCH), String(after).slice(0, 120))

  // 收尾：无论断言如何都清掉这个临时文件。
  if (existsSync(scratchPath)) rmSync(scratchPath, { force: true })
} catch (error) {
  failures += 1
  console.error('测试异常:', String(error.message).slice(0, 300))
}

socket.close()
console.log('')
console.log(failures === 0 ? '还原流程全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
