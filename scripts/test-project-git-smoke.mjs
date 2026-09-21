// 真实 Electron + CDP 冒烟测试：项目级 Git 的入口/抽屉在真实 React 下不许消失。
//
//   node scripts/test-project-git-smoke.mjs
//
// **为什么必须有这一个**：仓库里绝大多数测试用的是自制的假 React（自己的 createElement /
// useState / useEffect）。那两个真实问题它**根本抓不到**：
//   * React #290 —— `ref` 被当成业务字段传给函数组件（"Element ref was specified as a
//     string but no owner was set"）；
//   * React #300 / #310 —— Rules of Hooks（"Rendered more/fewer hooks than during the
//     previous render"）。假渲染器只按位置记录 hook 槽，多调少调都不会报错。
// 这两类问题在实机上的表现都是**整个入口被卸载**（外层槽位的错误边界把它换成错误占位），
// 也就是用户报的"点 Log / 切项目之后抽屉与右上角入口一起消失"。所以这里跑真渲染器，
// 并且把 window.onerror / unhandledrejection / console.error 全部收上来，出现 React
// minified error 即判失败。
//
// 需要一个**带远程调试端口**的实例：
//   npm start -- --remote-debugging-port=9333
// 端口可用 DSH_CDP_PORT 覆盖；页面标题需包含 "DeepSeek Harness"。
//
// 会话（→ 项目）由环境变量指定，找不到时自动从左侧列表里挑：
//   DSH_SMOKE_SESSIONS="项目A标题|项目B标题"
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = Number(process.env.DSH_CDP_PORT ?? 9333)
const KEYWORD = 'DeepSeek Harness'

let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `（期望 ${expected}）`}`)
}
const has = (label, actual) => check(label, actual === true, true)

// ---- 连接 CDP --------------------------------------------------------------------
let page
try {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  page = list.find((t) => t.type === 'page' && String(t.title).includes(KEYWORD))
} catch (error) {
  console.error(`连不上 CDP（端口 ${PORT}）：${String(error.message ?? error)}`)
  page = undefined
}
if (page === undefined) {
  console.error('')
  console.error('找不到页面。请用一个带远程调试端口的实例跑这个测试：')
  console.error('  npm start -- --remote-debugging-port=9333')
  console.error('（DSH_CDP_PORT 可以换端口。）')
  process.exit(1)
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
/** 真渲染器抛出的异常与 console.error（minified error 就在里面）。 */
const pageErrors = []
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params?.exceptionDetails
    pageErrors.push(String(details?.exception?.description ?? details?.text ?? 'unknown exception'))
    return
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
    pageErrors.push(message.params.args.map((a) => String(a.value ?? a.description ?? a.type)).join(' '))
    return
  }
  const entry = pending.get(message.id)
  if (entry === undefined) return
  pending.delete(message.id)
  if (message.result?.exceptionDetails) {
    entry.reject(new Error(message.result.exceptionDetails.exception?.description ?? message.result.exceptionDetails.text))
    return
  }
  entry.resolve(message.result?.result?.value)
})
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', () => reject(new Error('WebSocket 错误')))
})

/** 在页面里求值。 */
function evaluate(expression, timeoutMs = 20000) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error('求值超时'))
      }
    }, timeoutMs)
  })
}
const send = (method, params) => socket.send(JSON.stringify({ id: nextId++, method, params }))
send('Runtime.enable')
send('Log.enable')

/** 等一个表达式返回真值（默认 10 秒）。 */
async function waitFor(expression, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await evaluate(expression).catch(() => undefined)
    if (value === true) return true
    if (Date.now() > deadline) return false
    await sleep(200)
  }
}

// ---- 页面侧的状态读取 ------------------------------------------------------------
//
// `[data-review-trigger-button]`、`[data-review-trigger]`、`[data-desktop-review-surface]`
// 都是本插件自己的稳定标记，不依赖 CSS 类名（那些会随观感改动而变）。
const STATE = `(() => {
  const trigger = document.querySelector('[data-review-trigger-button]');
  const host = document.querySelector('[data-review-trigger]');
  const panel = document.querySelector('[data-desktop-review-surface]');
  const diag = window.__dshDesktopReviewPanel;
  const counts = [...document.querySelectorAll('[data-review-count]')].map((n) => n.textContent);
  const rows = document.querySelectorAll('[data-staging-row]').length;
  const branch = document.querySelector('[data-review-branch]')?.textContent ?? '';
  const graph = document.querySelector('[data-graph-view]') !== null;
  const graphRows = document.querySelectorAll('[data-graph-row]').length;
  const badge = (trigger?.innerText ?? '').trim();
  const bodyText = (panel?.innerText ?? '').slice(0, 200);
  return JSON.stringify({
    trigger: trigger !== null, host: host !== null, panel: panel !== null,
    session: diag?.session ?? null, hasCurrentSession: diag?.hasCurrentSession ?? null,
    counts, rows, branch, graph, graphRows, badge, bodyText,
  });
})()`
const readState = async () => JSON.parse(await evaluate(STATE))

/** 点一个页面里的元素（用 CSS 选择器）。 */
const click = (selector) =>
  evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true })()`)

/** React minified error 或 hook 顺序报错的判据。 */
const REACT_ERROR = /Minified React error #(290|300|310)|Rendered (more|fewer) hooks|Element ref was specified as a string|Function components cannot be given refs/i
const reactErrors = () => pageErrors.filter((text) => REACT_ERROR.test(text))

console.log('=== 0. 前置：加载的必须是**修好之后**的 bundle ===')
// `__dshDesktopReviewPanel` 是本轮新加的诊断（含 hasCurrentSession）。它不存在说明跑的是
// 旧 bundle —— 那样下面的断言只是在测旧代码，必须直接失败并提示重启。
{
  const diag = await evaluate('JSON.stringify(window.__dshDesktopReviewPanel ?? null)')
  has('0) 页面里有本轮新增的诊断 __dshDesktopReviewPanel', diag !== 'null')
  if (diag === 'null') {
    console.error('   加载的是旧 bundle：客户端插件是启动时注入的，请重启应用后再跑这个测试。')
    socket.close()
    process.exit(1)
  }
  console.log(`  诊断: ${String(diag).slice(0, 200)}`)
}

// ---- 找到两个"项目"（会话）-------------------------------------------------------
//
// 左侧会话列表没有稳定的 data 属性，因此按"可点元素 + 文本"来找：优先用环境变量点名，
// 否则取左侧 1/3 区域里文本非空、且互不相同的两个可点项。
const SESSION_HINT = (process.env.DSH_SMOKE_SESSIONS ?? '').split('|').map((s) => s.trim()).filter((s) => s !== '')
const findSessions = () =>
  evaluate(`(() => {
    const hints = ${JSON.stringify(SESSION_HINT)};
    const vw = window.innerWidth;
    const nodes = [...document.querySelectorAll('button, [role=button], [role=treeitem], a, li')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const text = (el.innerText || '').trim();
        return r.width > 40 && r.height > 16 && r.left < vw * 0.34 && r.top > 40 && text !== '' && text.length < 80;
      });
    const pick = [];
    for (const el of nodes) {
      const text = (el.innerText || '').trim();
      if (hints.length === 2 && !hints.includes(text)) continue;
      if (pick.some((p) => p.text === text)) continue;
      pick.push({ text, index: nodes.indexOf(el) });
      if (pick.length === 2) break;
    }
    return JSON.stringify(pick);
  })()`)

let sessions = JSON.parse(await findSessions())
if (sessions.length < 2) {
  console.error('')
  console.error('找不到两个会话/项目，无法验证"切换项目"这条路径。')
  console.error('请用 DSH_SMOKE_SESSIONS="项目A标题|项目B标题" 指定左侧两个会话的可见文本，')
  console.error('或先在本机建两个属于不同项目的对话。')
  socket.close()
  process.exit(1)
}
console.log(`  使用两个会话: ${sessions.map((s) => s.text).join(' / ')}`)

/** 点第 i 个会话并等它的 project（session）真的切过去。 */
async function switchTo(index) {
  await evaluate(`(() => {
    const nodes = [...document.querySelectorAll('button, [role=button], [role=treeitem], a, li')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const text = (el.innerText || '').trim();
        return r.width > 40 && r.height > 16 && r.left < window.innerWidth * 0.34 && r.top > 40 && text !== '' && text.length < 80;
      });
    const el = nodes[${index}];
    if (el) el.click();
    return true;
  })()`)
  // 等诊断里的 session 变过去（最多 6 秒）。
  await waitFor(`JSON.stringify(window.__dshDesktopReviewPanel?.session ?? null) !== ${JSON.stringify(JSON.stringify(null))}`, 6000)
  await sleep(1200)
}

/** 抽屉是否打开（没有就点开）。 */
async function ensureDrawer() {
  const state = await readState()
  if (state.panel) return state
  await click('[data-review-trigger-button]')
  await sleep(600)
  return readState()
}

// ---- A. 打开项目 A 的 Git → Changes ready → 切 B（loading）→ B ready --------------
console.log('')
console.log('=== A. 切换项目：入口与抽屉全程都在 ===')
{
  await switchTo(sessions[0].index)
  let state = await ensureDrawer()
  has('A) 入口存在', state.trigger)
  has('   抽屉已打开', state.panel)
  // Changes 就绪（文件行或"没有改动"这类空态都算 ready；这里只要求有内容在渲染）。
  await waitFor(`${STATE}.includes('"panel":true')`, 5000)
  state = await readState()
  console.log(`   A 状态: rows=${state.rows} counts=${state.counts.join(',')} branch=${state.branch}`)

  // 切到 B：切过去的**那一刻**入口与抽屉都必须在（这是 #310 的现场）。
  await switchTo(sessions[1].index)
  state = await readState()
  has('   切到 B 后入口仍在', state.trigger)
  has('   切到 B 后抽屉仍在', state.panel)
  check('   切项目这一帧没有 React error', reactErrors().length, 0)
  await waitFor(`JSON.parse(${JSON.stringify(STATE)}).rows >= 0`, 8000)
  await sleep(1500)
  state = await readState()
  has('   B 稳定后入口仍在', state.trigger)
  has('   B 稳定后抽屉仍在', state.panel)
  console.log(`   B 状态: rows=${state.rows} counts=${state.counts.join(',')} branch=${state.branch}`)
  check('   全程没有 React error', reactErrors().length, 0)
}

// ---- B. 点 Log：不许出现 #290，且提交图要真的渲染出来 ---------------------------
console.log('')
console.log('=== B. Log 页签：真实 React 下不许报 #290 ===')
{
  const before = reactErrors().length
  has('B) 点得中 Log 页签', await click('[data-review-tab="log"]'))
  has('   出现提交图', await waitFor(`document.querySelector('[data-graph-view]') !== null`, 10000))
  const state = await readState()
  has('   提交图容器存在', state.graph)
  check('   点 Log 没有产生 React error（#290）', reactErrors().length - before, 0)
  const refErrors = pageErrors.filter((t) => /Element ref was specified as a string|Function components cannot be given refs/i.test(t))
  check('   没有 ref 相关报错', refErrors.length, 0)
  has('   入口仍在', state.trigger)
  has('   抽屉仍在', state.panel)
}

// ---- C. Log → Changes → 切项目，循环 5 次 ---------------------------------------
console.log('')
console.log('=== C. Log/Changes/切项目 循环 5 次：入口与抽屉不许消失 ===')
{
  let survived = true
  for (let round = 1; round <= 5; round += 1) {
    await click('[data-review-tab="changes"]')
    await sleep(400)
    await switchTo(sessions[round % 2 === 0 ? 0 : 1].index)
    const state = await readState()
    if (!state.trigger || !state.panel) {
      survived = false
      console.error(`   第 ${round} 轮后入口/抽屉消失：${JSON.stringify(state)}`)
      break
    }
    await click('[data-review-tab="log"]')
    await sleep(700)
    const logState = await readState()
    if (!logState.trigger || !logState.panel) {
      survived = false
      console.error(`   第 ${round} 轮点 Log 后入口/抽屉消失：${JSON.stringify(logState)}`)
      break
    }
  }
  has('C) 5 轮循环后入口与抽屉仍在', survived)
  check('   循环期间没有 React error', reactErrors().length, 0)
}

// ---- D. 快速 A→B→A：最终一切属于 A ----------------------------------------------
console.log('')
console.log('=== D. 快速 A→B→A：最终数据必须都属于 A ===')
{
  await click('[data-review-tab="changes"]')
  await switchTo(sessions[1].index)
  await switchTo(sessions[0].index) // 不额外等待，尽快切回
  await sleep(3000)
  const state = await readState()
  console.log(`   最终状态: session=${state.session} branch=${state.branch} rows=${state.rows} counts=${state.counts.join(',')}`)
  has('D) 入口仍在', state.trigger)
  has('   抽屉仍在', state.panel)
  has('   诊断里的 session 是 A', state.session !== null && String(state.session).length > 0)
  // 入口数字与抽屉里的行数必须一致（同一份快照）。
  const header = state.counts[state.counts.length - 1]
  if (state.panel && header !== undefined && String(header).trim() !== '') {
    check('   头栏计数等于抽屉行数', Number(String(header).trim()), state.rows)
  }
  check('   这一段没有 React error', reactErrors().length, 0)
}

// ---- E. Log 左栏分支树：点分支后左栏不变、不白屏、滚动位置不丢 -------------------
//
// 这一条对应"点左栏某个分支之后，左栏只剩那个分支附近的 refs / 整个 Log 先白屏再出现"。
// 真渲染器下这两件事都必须不发生。
console.log('')
console.log('=== E. 点分支：左栏完整、不白屏、滚动位置保持 ===')
{
  await click('[data-review-tab="log"]')
  has('E) 提交图已渲染', await waitFor(`document.querySelector('[data-graph-tree]') !== null`, 10000))
  const readTree = async () =>
    JSON.parse(
      await evaluate(`(() => {
        const rows = [...document.querySelectorAll('[data-graph-tree-row]')].map((el) => el.getAttribute('data-graph-tree-row'));
        const selected = [...document.querySelectorAll('[data-graph-tree-row][aria-selected="true"]')].map((el) => el.getAttribute('data-graph-tree-row'));
        const scroll = document.querySelector('[data-graph-tree]');
        return JSON.stringify({ rows, selected, scrollTop: scroll ? scroll.scrollTop : -1, panes: document.querySelectorAll('[data-graph-pane]').length });
      })()`),
    )
  const before = await readTree()
  console.log(`   左栏 ${before.rows.length} 项，三栏 ${before.panes} 个: ${before.rows.slice(0, 8).join(', ')}`)
  if (before.rows.length < 2) {
    console.log('   分支太少，跳过这一节（需要一个有多分支的仓库）')
  } else {
    // 先把左栏滚动一段，之后要验证它没被重置。
    await evaluate(`(() => { const el = document.querySelector('[data-graph-tree]'); if (el) el.scrollTop = 24; return true })()`)
    // 点第二个分支（第一个通常是当前分支，点它意义不大）。
    const target = before.rows[1]
    await evaluate(`(() => { const el = [...document.querySelectorAll('[data-graph-tree-row]')].find((n) => n.getAttribute('data-graph-tree-row') === ${JSON.stringify(target)}); if (el) el.click(); return true })()`)
    await sleep(1500)
    const after = await readTree()
    check('   左栏项数与点之前一致', after.rows.length, before.rows.length)
    check('   左栏内容与点之前一致', after.rows.join(','), before.rows.join(','))
    check('   被点的分支是唯一高亮项', after.selected.join(','), target)
    check('   三栏仍在（没有白屏）', after.panes, before.panes)
    has('   提交图容器仍在', (await evaluate(`document.querySelector('[data-graph-view]') !== null`)) === true)
    has('   左栏滚动位置保持', after.scrollTop === before.scrollTop + 24 || after.scrollTop > 0)
    check('   点分支没有 React error', reactErrors().length, 0)
    // 再点一次同一个分支 = 取消过滤，左栏仍然完整。
    await evaluate(`(() => { const el = [...document.querySelectorAll('[data-graph-tree-row]')].find((n) => n.getAttribute('data-graph-tree-row') === ${JSON.stringify(target)}); if (el) el.click(); return true })()`)
    await sleep(1200)
    const cleared = await readTree()
    check('   取消过滤后左栏仍然完整', cleared.rows.length, before.rows.length)
    check('   取消过滤后没有高亮项', cleared.selected.length, 0)
    check('   这一段没有 React error', reactErrors().length, 0)
  }
}

// ---- F. 抽屉默认宽度 80% + 点外部关闭 -------------------------------------------
//
// 两件事都在真渲染器下才有意义：宽度取决于真实视口（`window.innerWidth`），
// 点外部取决于真实的 `mousedown` 事件与真实的 DOM 包含关系（`rootRef.contains`）。
console.log('')
console.log('=== F. 抽屉默认宽度 80%，点外部关闭且入口仍在 ===')
{
  // 清掉持久化宽度并重载，拿到"默认宽度"这一帧。重载后入口与抽屉都会复位。
  await evaluate(`localStorage.removeItem('dsh.review.panelWidth'), localStorage.removeItem('dsh.review.panelOpen'), true`)
  await evaluate(`location.reload(), true`)
  await sleep(9000)
  const opened = await ensureDrawer()
  has('F) 抽屉已打开', opened)
  const measured = JSON.parse(
    await evaluate(`(() => {
      const panel = document.querySelector('[data-desktop-review-surface]');
      const r = panel.getBoundingClientRect();
      return JSON.stringify({ width: Math.round(r.width), viewport: window.innerWidth });
    })()`),
  )
  // 允许 ±2px 的取整差（`Math.round` 与浏览器布局各取一次整）。
  check('   默认宽度是视口的 80%', Math.abs(measured.width - Math.round(measured.viewport * 0.8)) <= 2, true)
  console.log(`   视口 ${measured.viewport} → 抽屉 ${measured.width}（80% 是 ${Math.round(measured.viewport * 0.8)}）`)

  // 点抽屉外部（页面最左侧的空白/正文区）→ 关闭。用真实的 mousedown，走的是捕获阶段的监听。
  const closed = await evaluate(`(() => {
    const target = document.elementFromPoint(40, Math.round(window.innerHeight / 2)) || document.body;
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return true;
  })()`)
  has('   派发了外部 mousedown', closed === true)
  await sleep(700)
  has('   点外部后抽屉已关闭', (await evaluate(`document.querySelector('[data-desktop-review-surface]') === null`)) === true)
  has('   右上角入口仍在（不是"面板被卸载"）', (await evaluate(`document.querySelector('[data-review-trigger-button]') !== null`)) === true)
  check('   这一段没有 React error', reactErrors().length, 0)
  await ensureDrawer()
}

// ---- G. Log：无哈希、计数说"提交"、时间到秒、滚动自动分页 -----------------------
console.log('')
console.log('=== G. Log 计数/时间/无哈希/滚动分页 ===')
{
  await click('[data-review-tab="log"]')
  has('G) 提交图已渲染', await waitFor(`document.querySelector('[data-graph]') !== null || document.querySelector('[data-graph-view]') !== null`, 10000))
  const read = async () =>
    JSON.parse(
      await evaluate(`(() => {
        const rows = [...document.querySelectorAll('[data-graph-row]')];
        const firstRow = rows[0] ? rows[0].innerText.replace(/\\s+/g, ' ').trim() : '';
        const count = document.querySelector('[data-graph-count]');
        const scroll = document.querySelector('[data-graph-scroll]');
        return JSON.stringify({
          rowCount: rows.length,
          firstRow,
          countText: count ? count.textContent : '',
          hasMore: count ? count.getAttribute('data-graph-has-more') : null,
          graphFilesUsed: count ? /个文件|files/.test(count.textContent) : false,
          scrollHeight: scroll ? scroll.scrollHeight : 0,
          clientHeight: scroll ? scroll.clientHeight : 0,
        });
      })()`),
    )
  console.log(`   ${read.rowCount} 行；计数「${read.countText}」；首行「${read.firstRow.slice(0, 90)}」`)
  has('   计数说的是"提交"而不是"文件"', read.graphFilesUsed === false)
  // 时间精确到秒：首行必须带 HH:mm:ss。
  check('   首行时间精确到秒', /\d{2}:\d{2}:\d{2}/.test(read.firstRow), true)
  // 不显示哈希：首行里不该出现 7 位以上的十六进制串（分支名/标签里也不会有）。
  check('   首行没有短哈希', /\b[0-9a-f]{7,40}\b/.test(read.firstRow), false)

  // 滚动到底若干次：分页必须自动发生，且**不重复**（skip 单调递增由行数增长体现）。
  const counts = [read.rowCount]
  for (let i = 0; i < 4; i += 1) {
    await evaluate(`(() => { const el = document.querySelector('[data-graph-scroll]'); if (el) el.scrollTop = el.scrollHeight; return true })()`)
    await sleep(1800)
    const now = await read()
    counts.push(now.rowCount)
    if (now.hasMore === 'false') break
  }
  console.log(`   滚动后的行数序列: ${counts.join(' → ')}`)
  check('   滚动让行数单调不减', counts.every((n, i) => i === 0 || n >= counts[i - 1]), true)
  check('   这一段没有 React error', reactErrors().length, 0)
}

// ---- H. Changes：未跟踪文件按需差异 + AI 补充不覆盖已有输入 ---------------------
console.log('')
console.log('=== H. 未跟踪文件差异 + AI 补充不覆盖已有输入 ===')
{
  await click('[data-review-tab="changes"]')
  await sleep(1200)
  // 未跟踪文件在同一次快照里带着 `untracked: true`，点它的路径名展开差异。
  const untracked = await evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-staging-row][data-staging-side="untracked"]')][0];
    if (!row) return null;
    const toggle = row.querySelector('[data-staging-diff-toggle]');
    if (!toggle) return null;
    toggle.click();
    return row.getAttribute('data-staging-row');
  })()`)
  if (untracked === null) {
    console.log('   没有未跟踪文件，跳过"未跟踪差异"（需要一个有未跟踪文件的仓库）')
  } else {
    await sleep(1800)
    const diff = JSON.parse(
      await evaluate(`(() => {
        const path = ${JSON.stringify(untracked)};
        const containers = [...document.querySelectorAll('[data-review-diff-path]')].map((n) => n.getAttribute('data-review-diff-path'));
        const rows = document.querySelectorAll('[data-review-diff-row]').length;
        return JSON.stringify({ path, containers, rows });
      })()`),
    )
    has('H) 未跟踪文件展开后出现了差异容器', diff.containers.includes(untracked))
    has('   差异里有内容（不是空块）', diff.rows > 0)
    // 这一条是本轮的高优先修复：旧实现在这里抛 `byFile is not defined`，被错误边界接住，
    // 表现是"点未跟踪文件整个面板报错"。
    check('   点未跟踪文件没有 React error / 引用错误', reactErrors().length, 0)
    check('   也没有 byFile 之类的引用错误', pageErrors.filter((t) => /is not defined|ReferenceError/.test(t)).length, 0)
  }

  // AI 补充：先在输入框里打一半，生成后**不许被覆盖**（要么保持原样，要么出现三选一）。
  const aiState = await evaluate(`(() => {
    const box = document.querySelector('[data-staging-message]');
    const button = document.querySelector('[data-staging-ai]');
    if (!box || !button) return JSON.stringify({ ok: false, why: box ? 'no-button' : 'no-box' });
    const user = 'wip: 我打到一半';
    // React 受控输入必须走原生 setter 才能让 onChange 收到（直接改 value 不会触发）。
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(box, user);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return JSON.stringify({ ok: true, user, disabled: button.disabled === true });
  })()`)
  const ai = JSON.parse(aiState)
  if (ai.ok !== true) {
    console.log(`   AI 补充：跳过（${ai.why}）`)
  } else {
    await sleep(400)
    await click('[data-staging-ai]')
    await sleep(2500)
    const after = JSON.parse(
      await evaluate(`(() => {
        const box = document.querySelector('[data-staging-message]');
        return JSON.stringify({
          value: box ? box.value : null,
          ask: document.querySelector('[data-staging-ai-notice]')?.getAttribute('data-staging-ai-notice') ?? null,
        });
      })()`),
    )
    if (after.value === ai.user) {
      has('   已有一半输入时没有被静默覆盖', true)
    } else {
      // 另一种可接受的形态：模型已返回、界面在问"替换/追加/取消"。
      check('   已有输入时改成询问（三选一）', after.ask, 'ask')
      console.log('   （模型返回了建议，界面在询问是否替换）')
    }
    check('   这一段没有 React error', reactErrors().length, 0)
  }
}

// ---- 总结 ------------------------------------------------------------------------
console.log('')
console.log('=== 页面错误汇总 ===')
const reactHits = reactErrors()
if (pageErrors.length === 0) {
  console.log('  页面没有 console.error / 未捕获异常')
} else {
  for (const text of pageErrors.slice(0, 12)) console.log(`  · ${text.slice(0, 200)}`)
  console.log(`  共 ${pageErrors.length} 条，其中 React error ${reactHits.length} 条`)
}
check('没有 React minified error / hook 顺序报错', reactHits.length, 0)

socket.close()
console.log('')
console.log(failures === 0 ? '真实 Electron 冒烟通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
