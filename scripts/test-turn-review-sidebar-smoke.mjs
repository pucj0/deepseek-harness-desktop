// **真实 Electron + CDP 回归**：点「本轮修改 N」必须打开官方右侧栏的**审查**标签，
// 并且里面列出的文件数与入口那个数字**一致**。
//
//   node scripts/test-turn-review-sidebar-smoke.mjs
//
// 这是当前截图那个场景的自动化版本。为什么它必须存在：仓库里绝大多数测试用的是自制桩
// React，它们能证明"组件按预期拿数据"，但证明不了**真实 Harness 的槽位会给什么**——
// 而这次故障恰恰就出在那里：`shell.overlay` 是 root 作用域，真实渲染器不会给它注入
// `useSessions`，于是自制抽屉里的 workspace 永远是 undefined，界面报
// 「当前没有可用的工作区」，而入口那个数字明明是对的。
//
// 需要带远程调试端口的实例：
//   npm start -- --remote-debugging-port=9333
// 端口可用 `DSH_CDP_PORT` 覆盖。
//
// 默认**只读**：它只断言"入口有数字 → 点开 → 侧栏停在审查标签、正文文件数与入口一致、
// 不出现 noWorkspace"。
//
// 若要连"4 个文件"这个具体数字一起断言，把要用的**临时 fixture 仓库**告诉它（这个仓库会
// 被改写，绝不能指向真实项目）：
//   $env:DSH_SMOKE_TURN_FIXTURE='D:\tmp\turn-fixture'
// 此时它会先在页面里用宿主路由给该仓库造出 4 个改动并记录本轮基线，然后断言
// 入口显示 4、正文也显示 4。
import { setTimeout as sleep } from 'node:timers/promises'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.DSH_CDP_PORT ?? 9333)
const KEYWORD = 'DeepSeek Harness'
const FIXTURE = process.env.DSH_SMOKE_TURN_FIXTURE ?? ''

let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `（期望 ${expected}）`}`)
}
const has = (label, actual) => check(label, actual === true, true)

// ---- 连接 CDP --------------------------------------------------------------------
const isHarnessPage = (target) =>
  target.type === 'page' && String(target.title).includes(KEYWORD) && /^https?:/u.test(String(target.url))
let page
try {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  page = list.find(isHarnessPage) ?? list.find((t) => t.type === 'page' && String(t.title).includes(KEYWORD))
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

function evaluate(expression, timeoutMs = 20000) {
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

async function waitFor(expression, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await evaluate(expression).catch(() => undefined)
    if (value === true) return true
    if (Date.now() > deadline) return false
    await sleep(200)
  }
}
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

// ---- 页面侧：造 4 个文件的 fixture（可选） ---------------------------------------
//
// 只有给了 `DSH_SMOKE_TURN_FIXTURE` 才动手，而且只碰那个目录——绝不去改用户真实项目。
// 造完之后必须让 Harness 的当前会话 cwd 就是它，否则"本轮修改"看的是别的仓库。
async function prepareFixture() {
  if (FIXTURE === '') return { prepared: false, reason: '未设置 DSH_SMOKE_TURN_FIXTURE' }
  if (!existsSync(join(FIXTURE, '.git'))) {
    mkdirSync(FIXTURE, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', FIXTURE])
    execFileSync('git', ['-C', FIXTURE, 'config', 'user.email', 'smoke@example.com'])
    execFileSync('git', ['-C', FIXTURE, 'config', 'user.name', 'smoke'])
    for (const name of ['a.txt', 'b.txt', 'old.txt']) writeFileSync(join(FIXTURE, name), `${name} base\n`)
    execFileSync('git', ['-C', FIXTURE, 'add', '.'])
    execFileSync('git', ['-C', FIXTURE, 'commit', '-q', '-m', 'init'])
  }
  return { prepared: true, reason: '' }
}

// ---- 页面侧的状态读取 ------------------------------------------------------------
const STATE = `(() => {
  const panel = document.querySelector('[data-sidebar-right-open]');
  const body = document.querySelector('[data-sidebar-right-tab="dsh-client-ui-review/review"]');
  const tabs = [...document.querySelectorAll('[data-sidebar-right-tab]')].map((n) => n.getAttribute('data-sidebar-right-tab'));
  const chip = document.querySelector('[data-review-turn-chip]');
  const count = document.querySelector('[data-review-turn-count]');
  const turnSurface = document.querySelector('[data-review-turn-surface]');
  const noWorkspace = /noWorkspace|没有可用的工作区|No workspace is available/.test(document.body.innerText);
  return JSON.stringify({
    sidebarOpen: panel !== null,
    tabs,
    reviewTabMounted: body !== null,
    chipText: chip === null ? '' : chip.textContent.trim(),
    panelCountText: count === null ? '' : count.textContent.trim(),
    turnSurface: turnSurface === null ? null : turnSurface.getAttribute('data-review-turn-surface'),
    noWorkspace,
    diagnostic: window.__dshDesktopReviewTab ?? null,
    openDiagnostic: window.__dshDesktopReviewOpen ?? null,
    gitTabDiagnostic: window.__dshDesktopGitTab ?? null,
  });
})()`

const readState = () => evaluateJson(STATE, '读取审查标签状态')

/** 页面里的宿主路由调用（与插件同源、同一条 `/dsh-desktop/review/...`）。 */
function callRoute(route, body) {
  const url = JSON.stringify(`/dsh-desktop/review/${route}`)
  const payload = JSON.stringify(JSON.stringify(body))
  return [
    '(async () => {',
    `  const response = await fetch(${url}, {`,
    "    method: 'POST',",
    "    headers: { 'content-type': 'application/json' },",
    `    body: ${payload},`,
    '  });',
    '  return JSON.stringify({ status: response.status, payload: await response.json().catch(() => ({})) });',
    '})()',
  ].join('\n')
}

console.log('=== 0. 环境 ===')
console.log(`  端口 ${PORT}，页面 ${page.url}`)
const fixture = await prepareFixture()
if (fixture.prepared) console.log(`  fixture 仓库：${FIXTURE}`)
else console.log(`  只读模式（${fixture.reason}）：只验证入口与标签的一致性，不造改动`)

console.log('')
console.log('=== 1. 入口「本轮修改」是否在页面上 ===')
const chipPresent = await waitFor(`document.querySelector('[data-review-turn-chip]') !== null`, 15000)
if (!chipPresent) {
  console.log('  SKIP  页面上没有 [data-review-turn-chip]：需要桌面版 review 插件、且当前会话有 workspace。')
  console.log('        ——未验证，不当作通过。')
  process.exit(0)
}
has('入口存在', chipPresent)
let state = await readState()
console.log(`  INFO  入口文案 = ${JSON.stringify(state.chipText)}`)
console.log(`  INFO  侧栏已展开 = ${state.sidebarOpen}，标签 = ${JSON.stringify(state.tabs)}`)

// ---- 可选：把 fixture 造成"本轮 4 个文件" ----------------------------------------
if (fixture.prepared) {
  console.log('')
  console.log('=== 2. 在 fixture 里造出 4 个本轮改动并记录基线 ===')
  // 4 个改动：改 2 个、新增 1 个、删除 1 个（与需求里的截图场景同形）。
  writeFileSync(join(FIXTURE, 'a.txt'), 'a.txt base\nchanged-by-turn\n')
  writeFileSync(join(FIXTURE, 'b.txt'), 'b.txt base\nchanged-by-turn\n')
  writeFileSync(join(FIXTURE, 'new.txt'), 'created-by-turn\n')
  execFileSync('git', ['-C', FIXTURE, 'rm', '-q', '--cached', 'old.txt'])
  execFileSync('git', ['-C', FIXTURE, 'rm', '-q', '-f', 'old.txt'])
  const workspace = state.diagnostic?.workspace ?? state.gitTabDiagnostic?.workspace ?? FIXTURE
  const sessionId = state.diagnostic?.sessionId ?? state.gitTabDiagnostic?.sessionId ?? 'smoke-session'
  const baseline = await evaluateJson(callRoute('baseline', { workspace, sessionId }), '记录基线')
  check('   基线记录成功（HTTP 200）', baseline.status, 200)
  // 让入口立刻重算（它每 POLL_MS 轮询一次；这里等一下就够）。
  await sleep(1500)
}

console.log('')
console.log('=== 3. 点入口 → 官方侧栏停在审查标签 ===')
const before = await readState()
// 真实点击（`element.click()` 只派发 click，对 React 的 onClick 足够）。
await evaluate(`(() => { const node = document.querySelector('[data-review-turn-chip]'); if (node) node.click(); return true; })()`)
const opened = await waitFor(`document.querySelector('[data-sidebar-right-open]') !== null`, 8000)
has('侧栏被打开', opened)
// 审查标签的正文必须挂载（`data-sidebar-right-tab` 用的是**类型 id**）。
const reviewMounted = await waitFor(`document.querySelector('[data-sidebar-right-tab="dsh-client-ui-review/review"]') !== null`, 8000)
has('审查标签的正文已挂载', reviewMounted)

state = await readState()
console.log(`  INFO  打开诊断 = ${JSON.stringify(state.openDiagnostic)}`)
console.log(`  INFO  标签诊断 = ${JSON.stringify(state.diagnostic)}`)
check('打开的是 review 类型', state.openDiagnostic?.kind, 'review')
check('侧栏展开着', state.sidebarOpen, true)
check('正文 surface 标记是 sidebar', state.turnSurface, 'sidebar')
has('审查标签出现在侧栏标签列表里', state.tabs.includes('dsh-client-ui-review/review'))

console.log('')
console.log('=== 4. 入口数字与正文文件数一致（这次故障的核心） ===')
{
  // 入口里最后一个数字就是"本轮修改 N"的 N。
  const chipNumber = Number((/(\d+)/u.exec(state.chipText) ?? [])[1] ?? Number.NaN)
  const panelNumber = Number((/(\d+)/u.exec(state.panelCountText) ?? [])[1] ?? Number.NaN)
  console.log(`  INFO  入口 = ${chipNumber}，正文 = ${panelNumber}`)
  has('入口与正文都给出了数字', Number.isFinite(chipNumber) && Number.isFinite(panelNumber))
  check('两处数字一致', panelNumber, chipNumber)
  if (typeof state.diagnostic?.fileCount === 'number') {
    check('诊断里的 fileCount 与正文一致', state.diagnostic.fileCount, panelNumber)
    check('诊断 phase 是 ready', state.diagnostic.phase, 'ready')
  }
  if (fixture.prepared) check('fixture 场景下就是 4 个文件', panelNumber, 4)
  // **绝不允许**的假错误。
  check('没有出现"当前没有可用的工作区"', state.noWorkspace, false)
}

console.log('')
console.log('=== 5. Git 标签仍然独立存在 ===')
{
  const tabs = state.tabs.join(',')
  has('Git 标签也在（两个标签共存）', tabs.includes('dsh-client-ui-review/git'))
  // 切到 Git：正文应该是项目级面板，而不是审查面板。
  await evaluate(`(() => {
    const node = document.querySelector('[data-sidebar-right-tab="dsh-client-ui-review/git"]');
    if (node && typeof node.click === 'function') node.click();
    return true;
  })()`)
  await sleep(600)
  const after = await readState()
  const projectSurface = await evaluateJson(`JSON.stringify({ present: document.querySelector('[data-desktop-review-surface]') !== null, turn: document.querySelector('[data-review-turn-surface]') !== null })`, '读取 Git 标签')
  has('切到 Git 后出现项目级面板', projectSurface.present)
  // 审查面板此时可以仍在（官方 keepMounted 行为），但它不该被当成项目 Git 面板。
  console.log(`  INFO  切到 Git 之后 stillMountedTurnPanel=${projectSurface.turn}，侧栏 open=${after.sidebarOpen}`)
}

console.log('')
console.log('=== 6. 页面没有 React 异常 ===')
{
  const relevant = pageErrors.filter((line) => /Minified React error|Rendered more hooks|Rendered fewer hooks|The result of getSnapshot/u.test(line))
  if (relevant.length > 0) for (const line of relevant.slice(0, 5)) console.log(`    ${line}`)
  check('没有 React 渲染异常', relevant.length, 0)
}

console.log('')
console.log(failures === 0 ? '真实 Electron 下本轮审查标签与入口一致' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
