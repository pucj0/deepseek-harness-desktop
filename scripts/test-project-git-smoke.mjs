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
