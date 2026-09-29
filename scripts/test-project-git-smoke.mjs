// 真实 Electron + CDP 冒烟测试：官方 Git 标签与面板在真实 React 下不许消失。
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
// 也就是用户报的"点 Log / 切项目之后面板整块消失"。所以这里跑真渲染器，
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
//
// **必须挑那个 http(s) 页面**：外壳自己的 `shell.html`（标题栏那一页）标题也是
// "DeepSeek Harness"，而 `/json/list` 的顺序不保证。选错的表现是第 0 节报"加载的是旧
// bundle"——其实只是连到了外壳页。真页面是 `<本地服务器>/`，因此先按协议过滤。
const isHarnessPage = (target) =>
  target.type === 'page' && String(target.title).includes(KEYWORD) && /^https?:/u.test(String(target.url))
let page
try {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  page =
    list.find(isHarnessPage) ??
    list.find((t) => t.type === 'page' && String(t.title).includes(KEYWORD))
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
  // CDP 自己的错误（连接断了、上下文没了）走 `message.error`：**必须**把它带出来，
  // 否则调用方只会看到"求值超时/结果不是字符串"，完全不知道该查什么。
  if (message.error !== undefined) {
    entry.reject(new Error(`CDP ${message.error.code ?? ''}: ${message.error.message ?? 'unknown'}`))
    return
  }
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
  // 表达式必须是字符串。这里看似多余的守卫挡的是一个**真踩过**的坑：表达式写成模板字面量时，
  // 里面只要出现一个反引号（例如注释里的 `order: 3`），模板就会提前结束、把后半段当代码求值，
  // 最终 `expression` 变成一个字符串相除的 NaN。CDP 只会回
  // "Invalid parameters"（-32602），完全指不到现场；这一句直接把原因说出来。
  if (typeof expression !== 'string') {
    throw new Error(`求值表达式不是字符串（${typeof expression}）：模板字面量里是不是有反引号？`)
  }
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

/**
 * 求值并解析 JSON，结果不是字符串时**重试**再报错。
 *
 * 为什么不能直接 `JSON.parse(await evaluate(...))`：切项目/重载会让页面的执行上下文被销毁，
 * 那一瞬间 CDP 会回一个"没有 value"的结果（`value === undefined`），于是报出
 * `"undefined" is not valid JSON`——看起来像脚本坏了，其实只是页面正在导航。重试之后
 * 仍然拿不到字符串就是真的有问题，此时给一条能看懂的报错。
 * @param expression - 页面里求值的表达式（应当返回 JSON 字符串）。
 * @param label - 报错时点名用。
 * @returns 解析后的对象。
 */
async function evaluateJson(expression, label) {
  let lastError
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let raw
    try {
      raw = await evaluate(expression)
    } catch (error) {
      lastError = error
      await sleep(400)
      continue
    }
    if (typeof raw === 'string' && raw !== '') return JSON.parse(raw)
    lastError = new Error(`求值结果不是 JSON 字符串（${typeof raw}）`)
    await sleep(400)
  }
  throw new Error(`${label}: ${lastError === undefined ? '未知错误' : String(lastError.message ?? lastError)}`)
}

/** 头栏那个改动计数（标题右侧的胶囊）。 */
const HEADER_COUNT = `(() => {
  const node = document.querySelector('[data-review-header] [data-review-count]');
  return node ? node.textContent.trim() : '';
})()`

// ---- 页面侧的状态读取 ------------------------------------------------------------
//
// `[data-sidebar-right-open]` 是**官方侧栏**"已展开"的标记，`[data-desktop-review-surface]`
// 是 Git 标签正文（`ProjectGitPanel`）的标记。`trigger` / `host` 这两个字段名是历史遗留
// （那时本插件还有一个自己的浮动入口），现在两者都表示"官方侧栏里的 Git 标签已就位"。
const STATE = `(() => {
  const sidebar = document.querySelector('[data-sidebar-right-open]');
  const trigger = sidebar;
  const host = document.querySelector('[data-desktop-review-surface]');
  const panel = document.querySelector('[data-desktop-review-surface]');
  const diag = window.__dshDesktopGitTab;
  const counts = [...document.querySelectorAll('[data-review-count]')].map((n) => n.textContent);
  const rows = document.querySelectorAll('[data-staging-row]').length;
  const branch = document.querySelector('[data-review-branch]')?.textContent ?? '';
  const graph = document.querySelector('[data-graph-view]') !== null;
  const graphRows = document.querySelectorAll('[data-graph-row]').length;
  const badge = (panel?.querySelector('[data-review-count]')?.textContent ?? '').trim();
  const bodyText = (panel?.innerText ?? '').slice(0, 200);
  return JSON.stringify({
    trigger: trigger !== null, host: host !== null, panel: panel !== null,
    session: diag?.sessionId ?? null, hasCurrentSession: diag?.workspace != null,
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
// `__dshDesktopGitTab` 是 Git 标签自己的诊断（含它解析到的 sessionId 与工作区）。它不存在
// 说明跑的是旧 bundle —— 那样下面的断言只是在测旧代码，必须直接失败并提示重启。
{
  const diag = await evaluate('JSON.stringify(window.__dshDesktopGitTab ?? null)')
  has('0) 页面里有 Git 标签的诊断 __dshDesktopGitTab', diag !== 'null')
  if (diag === 'null') {
    console.error('   加载的是旧 bundle：客户端插件是启动时注入的，请重启应用后再跑这个测试。')
    socket.close()
    process.exit(1)
  }
  console.log(`  诊断: ${String(diag).slice(0, 200)}`)
}

// ---- A0. 「提交图」不再有独立入口（只留在 Git 标签的 Log 里）---------------------
//
// 需求 A：这个入口与 Git 标签的 Log 画的是同一个 `CommitGraphView`，用户在主界面左侧看到的是
// "多了一个重复入口"。它是两处槽位注册（`sidebar.panellist` 的图标 + `main` 的内容），
// 现在两处都删了。真实 DOM 里要能证明这一点：旧图标带着 `data-graph-icon` 标记，
// 且侧栏里不该再有任何文案是「提交图 / Commit graph」的可点项。
console.log('')
console.log('=== A0. 独立「提交图」入口已删除（不依赖 CSS 类名）===')
{
  const sidebar = await evaluateJson(
    `(() => {
      const icons = document.querySelectorAll('[data-graph-icon]').length;
      const labels = [...document.querySelectorAll('button, [role=button], [role=tab], [role=treeitem], a, li')]
        .filter((el) => el.closest('[data-desktop-review-surface]') === null)
        .map((el) => (el.innerText || '').trim())
        .filter((text) => /^(提交图|Commit graph\\s*图?)$/i.test(text));
      return JSON.stringify({ icons, labels });
    })()`,
    '侧栏入口',
  )
  check('A0) 侧栏里没有独立的「提交图」图标', sidebar.icons, 0)
  check('   侧栏里没有任何「提交图」可点项', sidebar.labels.length, 0)
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
  await waitFor(`JSON.stringify(window.__dshDesktopGitTab?.sessionId ?? null) !== ${JSON.stringify(JSON.stringify(null))}`, 6000)
  await sleep(1200)
}

/** 项目级 Git 面板是否就位（没有就让**官方侧栏**打开 Git 标签）。 */
async function ensureDrawer() {
  const state = await readState()
  if (state.panel) return state
  // 开关由 Harness 的官方侧栏管理。本插件把侧栏服务挂在 `window.__dshDesktopReview` 上
  // （跨插件的「与当前比较」用的就是同一条调用），这里借它把 Git 标签打开——
  // 不去猜官方侧栏的 DOM 结构。
  await evaluate(`(() => { window.__dshDesktopReview?.openTab?.('git', {}); return true })()`)
  await sleep(900)
  return readState()
}

// ---- A. 打开项目 A 的 Git → Changes ready → 切 B（loading）→ B ready --------------
console.log('')
console.log('=== A. 切换项目：官方侧栏与 Git 面板全程都在 ===')
{
  await switchTo(sessions[0].index)
  let state = await ensureDrawer()
  has('A) 官方侧栏已打开', state.trigger)
  has('   面板已就位', state.panel)
  // Changes 就绪（文件行或"没有改动"这类空态都算 ready；这里只要求有内容在渲染）。
  await waitFor(`${STATE}.includes('"panel":true')`, 5000)
  state = await readState()
  console.log(`   A 状态: rows=${state.rows} counts=${state.counts.join(',')} branch=${state.branch}`)

  // 切到 B：切过去的**那一刻**侧栏与面板都必须在（这是 #310 的现场）。
  await switchTo(sessions[1].index)
  state = await readState()
  has('   切到 B 后官方侧栏仍在', state.trigger)
  has('   切到 B 后面板仍在', state.panel)
  check('   切项目这一帧没有 React error', reactErrors().length, 0)
  await waitFor(`JSON.parse(${JSON.stringify(STATE)}).rows >= 0`, 8000)
  await sleep(1500)
  state = await readState()
  has('   B 稳定后官方侧栏仍在', state.trigger)
  has('   B 稳定后面板仍在', state.panel)
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
  has('   官方侧栏仍在', state.trigger)
  has('   面板仍在', state.panel)
}

// ---- C. Log → Changes → 切项目，循环 5 次 ---------------------------------------
console.log('')
console.log('=== C. Log/Changes/切项目 循环 5 次：侧栏与面板不许消失 ===')
{
  let survived = true
  for (let round = 1; round <= 5; round += 1) {
    await click('[data-review-tab="changes"]')
    await sleep(400)
    await switchTo(sessions[round % 2 === 0 ? 0 : 1].index)
    const state = await readState()
    if (!state.trigger || !state.panel) {
      survived = false
      console.error(`   第 ${round} 轮后侧栏/面板消失：${JSON.stringify(state)}`)
      break
    }
    await click('[data-review-tab="log"]')
    await sleep(700)
    const logState = await readState()
    if (!logState.trigger || !logState.panel) {
      survived = false
      console.error(`   第 ${round} 轮点 Log 后侧栏/面板消失：${JSON.stringify(logState)}`)
      break
    }
  }
  has('C) 5 轮循环后侧栏与面板仍在', survived)
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
  has('D) 官方侧栏仍在', state.trigger)
  has('   面板仍在', state.panel)
  has('   诊断里的 session 是 A', state.session !== null && String(state.session).length > 0)
  // 头栏计数与面板里的行数必须一致（同一份快照）。
  //
  // 这里**点名头栏**那个胶囊，而不是"最后一个 `[data-review-count]`"：Changes 里每个分区
  // （已暂存/未暂存/未跟踪）也带同一个标记，DOM 顺序上它们排在这个计数之后，取最后一个
  // 只会取到"未跟踪 183 个"这种分区计数——那是另一件事，两边本来就不该相等。
  const header = String(await evaluate(HEADER_COUNT)).trim()
  if (state.panel && header !== '') {
    check('   头栏计数等于面板行数', Number(header), state.rows)
  }
  check('   这一段没有 React error', reactErrors().length, 0)
}

// ---- E. Log 左栏分支树：点分支后左栏不变、不白屏、滚动位置不丢 -------------------
//
// 这一条对应"点左栏某个分支之后，左栏只剩那个分支附近的 refs / 整个 Log 先白屏再出现"。
// 真渲染器下这两件事都必须不发生。
console.log('')
console.log('=== E. 分支选择在首行下拉里（Log 没有左侧分支栏）===')
{
  await click('[data-review-tab="log"]')
  has('E) 提交图已渲染', await waitFor(`document.querySelector('[data-graph-view]') !== null`, 10000))

  // ---- 结构：没有左侧分支栏；选择器在提交图首行 ----
  const layout = await evaluateJson(
    `(() => {
      const toolbar = document.querySelector('[data-graph-toolbar]');
      const first = toolbar ? toolbar.firstElementChild : null;
      return JSON.stringify({
        treePanes: document.querySelectorAll('[data-graph-pane="tree"]').length,
        treeSplitters: document.querySelectorAll('[data-graph-splitter="tree"]').length,
        treeTools: document.querySelectorAll('[data-graph-tool="tree"]').length,
        listPanes: document.querySelectorAll('[data-graph-pane="list"]').length,
        detailPanes: document.querySelectorAll('[data-graph-pane="detail"]').length,
        // 首行第一格就是分支选择器（它曾经占掉左边一整列）。
        selectorFirstInToolbar: first !== null && first.hasAttribute('data-graph-ref-select'),
        // 下拉没打开时，ref 清单一个节点都不该有。
        rowsClosed: document.querySelectorAll('[data-graph-ref-row]').length,
      });
    })()`,
    'Log 布局',
  )
  check('   没有左侧分支栏', layout.treePanes, 0)
  check('   没有分支栏拖动手柄', layout.treeSplitters, 0)
  check('   没有「收起分支树」按钮', layout.treeTools, 0)
  check('   提交列表栏还在', layout.listPanes, 1)
  check('   详情栏还在', layout.detailPanes, 1)
  has('   首行工具栏第一格是分支选择器', layout.selectorFirstInToolbar)
  check('   下拉未打开时 ref 清单不占位', layout.rowsClosed, 0)

  // ---- 打开下拉：清单来自 gitbar 的权威 for-each-ref ----
  await click('[data-graph-ref-select-button]')
  has('   下拉已打开', await waitFor(`document.querySelector('[data-graph-ref-list]') !== null`, 4000))
  // 清单是**权威 refs 清单**（gitbar 的 `/branches` + `/tags`，宿主跑 `for-each-ref`），
  // 不是"第一页提交上的 `%D` 装饰"。真实页面里可以从 Resource Timing 看到那两条请求：
  // 少了它们，清单就只能来自 decor——那正是"远端分支被当成唯一真相"的老问题。
  const inventoryCalls = await evaluateJson(
    `(() => {
      const names = performance.getEntriesByType('resource').map((e) => e.name);
      return JSON.stringify({
        branches: names.filter((n) => /\\/dsh-desktop\\/gitbar\\/branches/.test(n)).length,
        tags: names.filter((n) => /\\/dsh-desktop\\/gitbar\\/tags/.test(n)).length,
      });
    })()`,
    'gitbar 清单请求',
  )
  has('   清单取自 gitbar /branches（权威 for-each-ref）', inventoryCalls.branches >= 1)
  has('   清单取自 gitbar /tags', inventoryCalls.tags >= 1)
  // 结构契约：三段（本地/远程/标签）、没有单独的 HEAD 分组、当前分支留在本地并带 ✓。
  const treeShape = await evaluateJson(
    `(() => {
      const sections = [...document.querySelectorAll('[data-graph-ref-section]')].map((n) => n.getAttribute('data-graph-ref-section'));
      const rows = [...document.querySelectorAll('[data-graph-ref-row]')];
      const current = rows.filter((n) => n.getAttribute('data-graph-ref-current') === 'true');
      const inLocal = (el) => {
        const section = el.closest('[data-graph-ref-section]');
        return section ? section.getAttribute('data-graph-ref-section') : '';
      };
      return JSON.stringify({
        sections,
        currentCount: current.length,
        currentName: current[0] ? current[0].getAttribute('data-graph-ref-row') : '',
        currentText: current[0] ? (current[0].innerText || '').trim() : '',
        currentSection: current[0] ? inLocal(current[0]) : '',
        hasAllRefsItem: document.querySelector('[data-graph-clear-ref]') !== null,
        // 带斜杠的本地分支必须落在 local 段（分类只看 namespace，不看名字里有没有斜杠）。
        localSlash: rows.filter((n) => inLocal(n) === 'local' && String(n.getAttribute('data-graph-ref-row')).includes('/')).map((n) => n.getAttribute('data-graph-ref-row')),
        // 反过来：remote 段里的每一行都必须是真·远端跟踪引用。
        remoteSlash: rows.filter((n) => inLocal(n) === 'remote').map((n) => n.getAttribute('data-graph-ref-row')),
      });
    })()`,
    'ref 清单结构',
  )
  check('   三段就是 本地/远程/标签', treeShape.sections.join(','), 'local,remote,tags')
  check('   没有 HEAD 分组', treeShape.sections.includes('head'), false)
  check('   恰好一个当前分支被标 current', treeShape.currentCount, 1)
  check('   当前分支在「本地」段里', treeShape.currentSection, 'local')
  has('   当前分支行带 ✓ 前缀', treeShape.currentText.startsWith('\u2713'))
  has('   下拉里有「全部分支」（= 清除筛选）', treeShape.hasAllRefsItem)
  console.log(`   当前分支: ${treeShape.currentText}（本地段）`)
  if (treeShape.localSlash.length > 0) {
    has('   带 `/` 的本地分支没有跑到远程段', treeShape.remoteSlash.some((n) => treeShape.localSlash.includes(n)) === false)
  }

  /** 读下拉里的 ref 行 + 高亮项；下拉关着时先打开。 */
  const readTree = async () => {
    await evaluate(`(() => {
      if (document.querySelector('[data-graph-ref-list]') === null) {
        document.querySelector('[data-graph-ref-select-button]')?.click();
      }
      return true;
    })()`)
    await sleep(500)
    return JSON.parse(
      await evaluate(`(() => {
        const rows = [...document.querySelectorAll('[data-graph-ref-row]')].map((el) => el.getAttribute('data-graph-ref-row'));
        const selected = [...document.querySelectorAll('[data-graph-ref-row][aria-selected="true"]')].map((el) => el.getAttribute('data-graph-ref-row'));
        return JSON.stringify({ rows, selected, panes: document.querySelectorAll('[data-graph-pane]').length });
      })()`),
    )
  }
  const before = await readTree()
  console.log(`   ref 清单 ${before.rows.length} 项，两栏 ${before.panes} 个: ${before.rows.slice(0, 8).join(', ')}`)
  if (before.rows.length < 2) {
    console.log('   分支太少，跳过这一节（需要一个有多分支的仓库）')
  } else {
    // 点第二个分支（第一个通常是当前分支，点它意义不大）。点完下拉会自动收起。
    const target = before.rows[1]
    await evaluate(`(() => { const el = [...document.querySelectorAll('[data-graph-ref-row]')].find((n) => n.getAttribute('data-graph-ref-row') === ${JSON.stringify(target)}); if (el) el.click(); return true })()`)
    await sleep(1800)
    has('   选完自动收起下拉', (await evaluate(`document.querySelector('[data-graph-ref-list]') === null`)) === true)
    // **提交图按该分支重新加载**：Resource Timing 里必须出现带 ref 的 graph 请求。
    const refCalls = await evaluateJson(
      `(() => {
        const names = performance.getEntriesByType('resource').map((e) => e.name);
        return JSON.stringify({ withRef: names.filter((n) => /\\/dsh-desktop\\/review\\/graph/.test(n) && /[?&]ref=/.test(n)).length });
      })()`,
      '按 ref 重载提交图',
    )
    has('   提交图按选中的分支重新加载（请求带 ref）', refCalls.withRef >= 1)
    const selectorValue = await evaluate(`document.querySelector('[data-graph-ref-value]')?.getAttribute('data-graph-ref-value') ?? ''`)
    check('   选择器上写着选中的 ref', selectorValue, target)
    const after = await readTree()
    check('   下拉里的项数与点之前一致', after.rows.length, before.rows.length)
    check('   下拉内容与点之前一致', after.rows.join(','), before.rows.join(','))
    check('   被点的分支是唯一高亮项', after.selected.join(','), target)
    check('   两栏仍在（没有白屏）', after.panes, before.panes)
    has('   提交图容器仍在', (await evaluate(`document.querySelector('[data-graph-view]') !== null`)) === true)
    check('   点分支没有 React error', reactErrors().length, 0)
    // 再点一次同一个分支 = 取消过滤（下拉里的「全部分支」做的是同一件事）。
    await evaluate(`(() => { const el = [...document.querySelectorAll('[data-graph-ref-row]')].find((n) => n.getAttribute('data-graph-ref-row') === ${JSON.stringify(target)}); if (el) el.click(); return true })()`)
    await sleep(1500)
    const cleared = await readTree()
    check('   取消过滤后下拉仍然完整', cleared.rows.length, before.rows.length)
    check('   取消过滤后没有高亮项', cleared.selected.length, 0)
    check('   这一段没有 React error', reactErrors().length, 0)
  }
}

// ---- F. 面板填满官方侧栏给的那一格；开合完全由 Harness 管理 ----------------------
//
// 这一节过去断言的是"自带抽屉的默认宽度是视口 80% + 点外部关闭"。**那个抽屉已经删除**：
// 项目级 Git 现在是官方侧栏里的一个标签，宽度、拖动、关闭、全屏都由侧栏自己管。
// 于是要钉住的契约正好相反——插件**不要**再插手这些事：
//   * 面板里没有自己的宽度手柄 / 收起按钮；
//   * 面板填满侧栏给它的容器（宽度 ≈ 容器宽度）；
//   * 点面板外部**不会**把面板卸载掉（Harness 决定什么时候关）。
console.log('')
console.log('=== F. 面板填满官方侧栏的格子，关开由 Harness 管理 ===')
{
  const opened = await ensureDrawer()
  // `ensureDrawer()` 回的是**状态对象**（`{ panel, trigger, ... }`），不是布尔值：这里曾经
  // 直接把它喂给 `has()`，于是这条断言永远是红的（对象 `!== true`），却看起来像"抽屉没开"。
  has('F) 面板已就位', opened.panel === true)

  const measured = JSON.parse(
    await evaluate(`(() => {
      const panel = document.querySelector('[data-desktop-review-surface]');
      const slot = panel.parentElement ?? panel;
      const r = panel.getBoundingClientRect();
      const s = slot.getBoundingClientRect();
      return JSON.stringify({
        width: Math.round(r.width), slot: Math.round(s.width), viewport: window.innerWidth,
        resizer: document.querySelector('[data-review-resizer]') !== null,
        collapseButton: [...panel.querySelectorAll('button')].some((b) => b.title === 'Collapse panel' || b.title === '收起面板'),
      });
    })()`),
  )
  has('   面板里没有插件自己的宽度手柄', measured.resizer === false)
  has('   面板里没有插件自己的收起按钮', measured.collapseButton === false)
  console.log(`   视口 ${measured.viewport} → 侧栏格子 ${measured.slot} → 面板 ${measured.width}`)
  // 允许 ±2px 的取整差：面板是 `width: 100%`，应当与容器同宽。
  check('   面板宽度等于侧栏给它的那格宽度', Math.abs(measured.width - measured.slot) <= 2, true)

  // 点面板外部：**不能**把面板卸掉（插件已经不再注册外部点击监听）。
  const dispatched = await evaluate(`(() => {
    const target = document.elementFromPoint(40, Math.round(window.innerHeight / 2)) || document.body;
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return true;
  })()`)
  has('   派发了外部 mousedown', dispatched === true)
  await sleep(700)
  has('   点外部后面板仍在（开合由 Harness 决定）', (await evaluate(`document.querySelector('[data-desktop-review-surface]') !== null`)) === true)
  has('   官方侧栏仍然开着', (await evaluate(`document.querySelector('[data-sidebar-right-open]') !== null`)) === true)
  check('   这一段没有 React error', reactErrors().length, 0)
  await ensureDrawer()
}

// ---- G. Log：无哈希、计数说"提交"、时间到秒、滚动自动分页 -----------------------
console.log('')
console.log('=== G. Log 计数/时间/无哈希/滚动分页 ===')
{
  await click('[data-review-tab="log"]')
  has('G) 提交图已渲染', await waitFor(`document.querySelector('[data-graph]') !== null || document.querySelector('[data-graph-view]') !== null`, 10000))
  // 行要等**渲染出来**再读：切页签的那一帧提交还没到，`rows[0]` 不存在，下面"首行时间到秒"
  // 之类会拿到空字符串（实测踩到过：计数「」、首行「」）。
  has('   提交行已渲染', await waitFor(`document.querySelector('[data-graph-row]') !== null`, 10000))
  await sleep(500)
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
  // `read` 是**函数**：必须 `await read()` 才能拿到对象。早先这里直接写 `read.rowCount`
  // （访问函数对象上的属性 → undefined），于是这一段在第一个 console.log 就抛
  // `Cannot read properties of undefined (reading 'slice')`——整个冒烟在这之前都跑不完。
  const first = await read()
  console.log(`   ${first.rowCount} 行；计数「${first.countText}」；首行「${first.firstRow.slice(0, 90)}」`)
  has('   计数说的是"提交"而不是"文件"', first.graphFilesUsed === false)
  // 时间精确到秒：首行必须带 HH:mm:ss。
  check('   首行时间精确到秒', /\d{2}:\d{2}:\d{2}/.test(first.firstRow), true)
  // 不显示哈希：首行里不该出现 7 位以上的十六进制串（分支名/标签里也不会有）。
  check('   首行没有短哈希', /\b[0-9a-f]{7,40}\b/.test(first.firstRow), false)

  // 滚动到底若干次：分页必须自动发生，且**不重复**（skip 单调递增由行数增长体现）。
  const counts = [first.rowCount]
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

// ---- G1. 大屏首屏：视口按真实 DOM 量 + 自动补页（需求 21/22/26）----------------
//
// 这一条只有在真实布局下才有意义：`viewport` 曾经初始化为 600 且**只在 onScroll 里更新**，
// 于是大窗口首次打开 Log 时，虚拟列表按 600px 算可见行数，下面一大片空白，而且不滚一下
// 永远不会自己补数据。这里量的是真实 `clientHeight` 与真实行数。
console.log('')
console.log('=== G1. 首屏按真实视口渲染并自动补页（不需要用户滚动）===')
{
  await click('[data-review-tab="log"]')
  has('G1) 提交图已渲染', await waitFor(`document.querySelector('[data-graph-scroll]') !== null`, 10000))
  // 上一节把滚动容器拉到底过，这里先回到顶部：这一节要证明的是"**不用滚动**就已按真实视口
  // 铺满"，而不是"滚动位置是 0"（那是上一节的副作用，不是产品的性质）。
  await evaluate(`(() => { const el = document.querySelector('[data-graph-scroll]'); if (el) el.scrollTop = 0; return true })()`)
  // 等自动补页把首屏填满（每轮是"请求 → 响应 → 渲染 → 再判断"，因此给它几秒）。
  await sleep(2500)
  const coverage = await evaluateJson(
    `(() => {
      const scroll = document.querySelector('[data-graph-scroll]');
      const count = document.querySelector('[data-graph-count]');
      const rows = document.querySelectorAll('[data-graph-row]').length;
      const digits = count ? (count.textContent.match(/\\d+/) ?? [])[0] : undefined;
      return JSON.stringify({
        rows,
        loadedTotal: digits === undefined ? -1 : Number(digits),
        clientHeight: scroll ? scroll.clientHeight : -1,
        scrollTop: scroll ? scroll.scrollTop : -1,
        hasMore: count ? count.getAttribute('data-graph-has-more') : null,
        loadingMore: document.querySelector('[data-graph-loading-more]') !== null,
      });
    })()`,
    '首屏覆盖率',
  )
  console.log(`   行数=${coverage.rows}/${coverage.loadedTotal} 视口=${coverage.clientHeight}px hasMore=${coverage.hasMore}`)
  has('   滚动容器有真实高度（不是 0）', coverage.clientHeight > 200)
  // 24px 是行高（`GRAPH_ROW_HEIGHT`）：**画出来的行必须铺满真实视口**。这是虚拟列表有没有
  // 按真实高度算的判据——老实现把 viewport 初始化为 600 且只在 onScroll 里更新，771px 的
  // 容器只会画 600px 对应的 25 行，下面一片空白，而且不滚一下永远不会自己补。
  //
  // 注意别写成"已加载的提交要全部渲染"：虚拟列表**本来**只画可见窗口（实测：219 条已加载、
  // 画 43 行正好覆盖 771px），要求全画出来等于要求关掉虚拟化。
  check('   首屏行数铺满真实视口（虚拟窗口按真实高度算）', coverage.rows * 24 >= coverage.clientHeight, true)
  if (coverage.hasMore === 'true') {
    has('   还有更多时不需要用户滚动（自动补页在跑）', coverage.rows * 24 >= coverage.clientHeight || coverage.loadingMore === true)
  }
  check('   G1 没有 React error', reactErrors().length, 0)
}

// ---- G2. Log：点改动文件 → 底部 Diff Preview（不再内联在窄右栏里）--------------
console.log('')
console.log('=== G2. Diff Preview：右栏不内联 diff、代码区默认自动换行且可切换、能关能恢复 ===')
{
  // 选一条提交（第一条），右栏出现改动文件清单。
  await evaluate(`(() => { const row = document.querySelector('[data-graph-row]'); if (row) row.click(); return true })()`)
  await sleep(1800)
  /**
   * 挑一个**有逐行差异**的文件来点。
   *
   * 不能无脑点第一个：这条提交可能改的是 lockfile / 图片之类的二进制文件，那时 Preview 会
   * 正大光明地显示"该文件是二进制内容，不展示逐行差异"，`[data-review-diff-code]` 根本不存在
   * ——断言全红，但界面是对的（实测就踩到了：HEAD 提交里第一个文件是 package-lock.json）。
   * 因此按顺序试，直到 Preview 里真的出现了代码区；全都不行才跳过。
   */
  const pickTextFile = async () => {
    const paths = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('[data-graph-file-row]')].map((n) => n.getAttribute('data-graph-file-row')))`))
    for (const path of paths) {
      await evaluate(`(() => {
        const row = [...document.querySelectorAll('[data-graph-file-row]')].find((n) => n.getAttribute('data-graph-file-row') === ${JSON.stringify(path)});
        if (row) row.click();
        return true;
      })()`)
      await sleep(2000)
      const hasCode = await evaluate(`document.querySelector('[data-review-diff-code]') !== null`)
      if (hasCode === true) return path
    }
    return null
  }
  const fileRow = await pickTextFile()
  if (fileRow === null) {
    console.log('   SKIP  这条提交的文件都是二进制/没有可展示的逐行差异')
  } else {
    const read = async () =>
      JSON.parse(
        await evaluate(`(() => {
          const preview = document.querySelector('[data-graph-diff-preview]');
          const detail = document.querySelector('[data-graph-detail]');
          const body = document.querySelector('[data-review-diff-body]');
          const code = document.querySelector('[data-review-diff-code]');
          const gutter = document.querySelector('[data-review-diff-gutter]');
          const header = document.querySelector('[data-review-diff-fileheader]');
          const pane = document.querySelector('[data-graph-pane="diff"]');
          const codeStyle = code ? getComputedStyle(code) : null;
          const oldCell = document.querySelector('[data-review-diff-line-old]');
          const newCell = document.querySelector('[data-review-diff-line-new]');
          return JSON.stringify({
            hasPreview: preview !== null,
            previewInDetail: detail !== null && detail.querySelector('[data-graph-diff-preview]') !== null,
            diffRowsInDetail: detail ? detail.querySelectorAll('[data-review-diff-row]').length : -1,
            diffRowsInPreview: preview ? preview.querySelectorAll('[data-review-diff-row]').length : -1,
            whiteSpace: code ? codeStyle.whiteSpace : '',
            overflowWrap: code ? codeStyle.overflowWrap : '',
            wordBreak: code ? codeStyle.wordBreak : '',
            codeScrollsX: code ? code.scrollWidth > code.clientWidth + 1 : false,
            overflowX: body ? getComputedStyle(body).overflowX : '',
            wrap: body ? body.getAttribute('data-review-diff-wrap') : null,
            mode: body ? body.getAttribute('data-review-diff-mode') : null,
            hasWrapToggle: document.querySelector('[data-review-diff-wrap]') !== null,
            gutterUserSelect: gutter ? getComputedStyle(gutter).userSelect : '',
            gutterGrid: oldCell && newCell ? getComputedStyle(oldCell).gridColumnStart + '/' + getComputedStyle(newCell).gridColumnStart : '',
            hasHeader: header !== null,
            headerText: header ? header.innerText.trim() : '',
            heightMode: pane ? pane.getAttribute('data-graph-diff-height') : null,
            flex: pane ? pane.style.flex : '',
          });
        })()`),
      )
    const first = await read()
    console.log(`   Preview=${first.hasPreview} 右栏内差异行=${first.diffRowsInDetail} Preview 内差异行=${first.diffRowsInPreview} 高度=${first.flex} wrap=${first.wrap}`)
    has('G2) 出现 Diff Preview', first.hasPreview)
    // 这一条是本次重构的核心约束：完整 diff 不许再出现在右栏里。
    check('   右栏里没有内联差异行', first.diffRowsInDetail, 0)
    check('   Preview 不在右栏里', first.previewInDetail, false)
    has('   Preview 里有差异行', first.diffRowsInPreview > 0)
    // 本轮的核心：默认自动换行；长代码不能把容器撑出横向滚动。
    check('   代码默认自动换行（white-space: pre-wrap）', first.whiteSpace, 'pre-wrap')
    check('   长词/URL 也断行（overflow-wrap: anywhere）', first.overflowWrap, 'anywhere')
    check('   默认 wrap 状态是 on', first.wrap, 'on')
    check('   换行态下容器不横向滚动', first.overflowX, 'hidden')
    check('   换行之后代码区没有横向溢出', first.codeScrollsX, false)
    has('   有「自动换行」开关', first.hasWrapToggle === true)
    has(
      '   文件头被折叠成一条',
      first.hasHeader &&
        /File changed|New file|Deleted file|Renamed file|文件已更改|新增文件|删除文件|重命名文件/.test(first.headerText),
    )
    check('   默认高度是百分比', first.flex, '0 0 40%')
    check('   这一段没有 React error / ReferenceError', pageErrors.filter((t) => /is not defined|ReferenceError/.test(t)).length, 0)

    /**
     * 切到「统一」再看行号栏的列契约。
     *
     * 两个原因：差异视图有「统一 / 并排」两种模式（默认跟随用户偏好，本机是并排），而
     * **行号栏的 grid 契约、以及"关掉换行后横向滚动落回容器"都只属于统一模式**——并排模式下
     * 左右两侧各自横滚，容器本身永远是 `hidden`。不先切模式，这两条断言测的其实是并排视图，
     * 报红也只说明"跑在另一种模式上"。
     */
    const switchedToUnified = await evaluate(`(() => {
      const button = document.querySelector('[data-review-diff-mode-option="unified"]');
      if (!button) return false;
      button.click();
      return true;
    })()`)
    if (switchedToUnified === true) {
      await sleep(900)
      const unified = await read()
      check('   切到统一模式后 body 标记跟着变', unified.mode ?? 'unified', 'unified')
      check('   行号栏不可选中', unified.gutterUserSelect, 'none')
      check('   旧/新行号各占一列（不重复）', unified.gutterGrid, '1/2')
    } else {
      console.log('   SKIP  没有「统一 / 并排」切换按钮，跳过行号栏列契约')
    }

    // 关掉自动换行 → 回到 pre + 容器横向滚动；再打开 → 回到 pre-wrap。
    const toggled = await evaluate(`(() => { const el = document.querySelector('[data-review-diff-wrap]'); if (!el) return false; el.click(); return true })()`)
    has('   点得中「自动换行」开关', toggled === true)
    await sleep(700)
    const nowrap = await read()
    check('   关掉后代码不再折行（white-space: pre）', nowrap.whiteSpace, 'pre')
    check('   关掉后 wrap 状态是 off', nowrap.wrap, 'off')
    if (switchedToUnified === true) {
      check('   关掉后横向滚动回到容器上', nowrap.overflowX, 'auto')
    }
    await evaluate(`(() => { const el = document.querySelector('[data-review-diff-wrap]'); if (el) el.click(); return true })()`)
    await sleep(700)
    const rewrapped = await read()
    check('   再打开回到自动换行', rewrapped.whiteSpace, 'pre-wrap')
    check('   再打开 wrap 状态回到 on', rewrapped.wrap, 'on')

    // 关闭 → 上半部三栏不受影响；再点同一文件 → 立即恢复。
    const closed = await evaluate(`(() => { const el = document.querySelector('[data-review-diff-close]'); if (!el) return false; el.click(); return true })()`)
    has('   点得中关闭按钮', closed === true)
    await sleep(900)
    check('   关闭后 Preview 消失', await evaluate(`document.querySelector('[data-graph-diff-preview]') === null`), true)
    check('   关闭后三栏仍在', await evaluate(`document.querySelectorAll('[data-graph-pane]').length >= 2`), true)
    await evaluate(`(() => { const row = [...document.querySelectorAll('[data-graph-file-row]')].find((n) => n.getAttribute('data-graph-file-row') === ${JSON.stringify(fileRow)}); if (row) row.click(); return true })()`)
    await sleep(1500)
    check('   再点同一文件 Preview 立即恢复', await evaluate(`document.querySelector('[data-graph-diff-preview]') !== null`), true)
    check('   这一段没有 React error', reactErrors().length, 0)
  }
}

// ---- G3. Changes：左栏选文件 / 右栏看差异（不再 inline 展开）+ 提交区常驻 ---------
console.log('')
console.log('=== G3. Changes 左右分栏：选文件、右栏看差异、提交区常驻 ===')
{
  await click('[data-review-tab="changes"]')
  await sleep(1500)
  const layout = JSON.parse(
    await evaluate(`(() => {
      const main = document.querySelector('[data-changes-main]');
      const files = document.querySelector('[data-changes-files]');
      const splitter = document.querySelector('[data-changes-splitter]');
      const pane = document.querySelector('[data-changes-diff-preview]');
      const card = document.querySelector('[data-staging-commit-card]');
      const rect = card ? card.getBoundingClientRect() : null;
      const mainRect = main ? main.getBoundingClientRect() : null;
      return JSON.stringify({
        hasMain: main !== null,
        mode: main ? main.getAttribute('data-changes-layout') : null,
        hasFiles: files !== null,
        filesBasis: files ? files.style.flexBasis : '',
        hasSplitter: splitter !== null,
        hasPane: pane !== null,
        paneInFiles: files !== null && files.querySelector('[data-changes-diff-preview]') !== null,
        rowsInFiles: files ? files.querySelectorAll('[data-review-diff-row]').length : -1,
        hasPreviewEmptyHint: pane !== null && pane.innerText.trim().length > 0,
        cardPinned: rect !== null && rect.bottom <= window.innerHeight + 1 && rect.top > 0,
        // **看的是屏幕位置，不是 DOM 顺序**：提交卡片在 DOM 里排在主区之前，靠 CSS
        // order:3（主区 order:1）落在下面。早先这里用 compareDocumentPosition 判
        // "卡片在主区之后"，那是 DOM 顺序——按现在的实现永远是 false，而界面是对的。
        cardBelowMain: rect !== null && mainRect !== null && rect.top >= mainRect.top,
      });
    })()`),
  )
  console.log(`   布局=${layout.mode} 左栏份额=${layout.filesBasis} 左栏内差异行=${layout.rowsInFiles} 提交区贴底=${layout.cardPinned}`)
  has('G3) Changes 有左右分栏容器', layout.hasMain && layout.hasFiles && layout.hasPane)
  has('   有可拖拽的分隔条', layout.hasSplitter)
  check('   Diff 预览不在文件列表里', layout.paneInFiles, false)
  check('   文件列表里没有内联差异行', layout.rowsInFiles, 0)
  has('   未选文件时右栏是空态提示（不是空白）', layout.hasPreviewEmptyHint)
  // 宽窗口默认左右分栏、左栏约 34%；窄窗口退化成上下堆叠。
  if (layout.mode === 'columns') {
    has('   左栏默认份额在 20%~50% 之间', Number.parseFloat(layout.filesBasis) >= 20 && Number.parseFloat(layout.filesBasis) <= 50)
  } else {
    check('   窄窗口退化成上下堆叠', layout.mode, 'stacked')
  }
  has('   提交区常驻在底部（没有被差异挤出视口）', layout.cardPinned)
  has('   提交区在主区下方（看屏幕位置）', layout.cardBelowMain)

  // 选中一个已跟踪文件：只改变选中，绝不动勾选/暂存状态。
  const picked = JSON.parse(
    await evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-staging-row]')].filter(
        (r) => r.querySelector('[data-staging-file-pick]') && r.querySelector('[data-staging-diff-toggle]'),
      );
      if (rows.length === 0) return JSON.stringify({ ok: false });
      const row = rows[0];
      const pick = row.querySelector('[data-staging-file-pick]');
      const before = { checked: pick.checked, checkedTotal: document.querySelectorAll('[data-staging-file-pick]:checked').length };
      row.querySelector('[data-staging-diff-toggle]').click();
      return JSON.stringify({ ok: true, path: row.getAttribute('data-staging-row'), before });
    })()`),
  )
  if (picked.ok !== true) {
    console.log('   没有可点的已跟踪改动文件，跳过选中/右栏断言')
  } else {
    await sleep(1800)
    const after = JSON.parse(
      await evaluate(`(() => {
        const path = ${JSON.stringify(picked.path)};
        const row = [...document.querySelectorAll('[data-staging-row]')].find((r) => r.getAttribute('data-staging-row') === path);
        const pick = row ? row.querySelector('[data-staging-file-pick]') : null;
        const pane = document.querySelector('[data-changes-diff-preview]');
        const files = document.querySelector('[data-changes-files]');
        const code = document.querySelector('[data-review-diff-code]');
        const body = document.querySelector('[data-review-diff-body]');
        return JSON.stringify({
          selected: row ? row.getAttribute('data-staging-selected') : null,
          ariaSelected: row ? row.querySelector('[data-staging-diff-toggle]')?.getAttribute('aria-selected') : null,
          checked: pick ? pick.checked : null,
          checkedTotal: document.querySelectorAll('[data-staging-file-pick]:checked').length,
          paths: [...document.querySelectorAll('[data-review-diff-path]')].map((n) => n.getAttribute('data-review-diff-path')),
          rows: pane ? pane.querySelectorAll('[data-review-diff-row]').length : -1,
          rowsInFiles: files ? files.querySelectorAll('[data-review-diff-row]').length : -1,
          viewers: document.querySelectorAll('[data-review-diff-viewer]').length,
          wrap: body ? body.getAttribute('data-review-diff-wrap') : null,
          whiteSpace: code ? getComputedStyle(code).whiteSpace : '',
        });
      })()`),
    )
    check('   选中的行被标记', after.selected, 'true')
    check('   路径按钮带 aria-selected', after.ariaSelected, 'true')
    check('   差异落在右栏', after.paths.includes(picked.path), true)
    has('   右栏画出差异内容', after.rows > 0)
    check('   文件列表里仍然没有内联差异行', after.rowsInFiles, 0)
    check('   整屏只有一个 Diff Viewer', after.viewers, 1)
    check('   Changes 的差异也默认自动换行', after.wrap, 'on')
    check('   Changes 的代码区默认 pre-wrap', after.whiteSpace, 'pre-wrap')
    // 本轮的硬约束：点文件名只改选中，勾选/暂存状态一律不许被牵连。
    check('   这一行的勾选状态没被改动', after.checked, picked.before.checked)
    check('   全局勾选数量没变', after.checkedTotal, picked.before.checkedTotal)
    check('   提交区仍然贴底', await evaluate(`(() => { const r = document.querySelector('[data-staging-commit-card]')?.getBoundingClientRect(); return r ? r.bottom <= window.innerHeight + 1 : false })()`), true)

    // 换一个文件：同一个右栏就地换内容，不新增 Viewer、不回到 inline。
    const second = JSON.parse(
      await evaluate(`(() => {
        const path = ${JSON.stringify(picked.path)};
        const rows = [...document.querySelectorAll('[data-staging-row]')].filter(
          (r) => r.querySelector('[data-staging-diff-toggle]') && r.getAttribute('data-staging-row') !== path,
        );
        if (rows.length === 0) return JSON.stringify({ ok: false });
        rows[0].querySelector('[data-staging-diff-toggle]').click();
        return JSON.stringify({ ok: true, path: rows[0].getAttribute('data-staging-row') });
      })()`),
    )
    if (second.ok === true) {
      await sleep(1800)
      const switched = JSON.parse(
        await evaluate(`(() => {
          const first = [...document.querySelectorAll('[data-staging-row]')].find((r) => r.getAttribute('data-staging-row') === ${JSON.stringify(picked.path)});
          return JSON.stringify({
            paths: [...document.querySelectorAll('[data-review-diff-path]')].map((n) => n.getAttribute('data-review-diff-path')),
            viewers: document.querySelectorAll('[data-review-diff-viewer]').length,
            rowsInFiles: document.querySelector('[data-changes-files]')?.querySelectorAll('[data-review-diff-row]').length ?? -1,
            firstSelected: first ? first.getAttribute('data-staging-selected') : null,
          });
        })()`),
      )
      check('   第二个文件在同一个右栏里打开', switched.paths.includes(second.path), true)
      check('   只有一个文件处于选中态', switched.paths.length, 1)
      check('   换文件不新增 Viewer', switched.viewers, 1)
      check('   上一个文件不再选中', switched.firstSelected, 'false')
      check('   换文件后列表里依然没有内联差异', switched.rowsInFiles, 0)
    }
    check('   G3 没有 React error / 引用错误', pageErrors.filter((t) => /is not defined|ReferenceError/.test(t)).length, 0)
  }
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
