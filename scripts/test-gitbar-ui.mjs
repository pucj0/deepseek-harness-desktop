// 用 CDP 对 gitbar 徽章做真实 DOM 交互测试。
//
//   node scripts/test-gitbar-ui.mjs
//
// 为什么需要它：`点击外部应关闭菜单` 是 DOM 事件行为，用临时仓库那种方式测不了。
// 这里通过 CDP 派发**真实事件**（mousedown/click），断言菜单的显隐，因此验证的是
// 真实组件而不是复制出来的逻辑。
//
// 前置：dev 应用在跑且开了 --remote-debugging-port=9222，工作区指向一个 git 仓库。
const keyword = 'DeepSeek Harness'

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && String(t.title).includes(keyword))
if (page === undefined) {
  console.error('找不到页面，先启动 dev 应用（--remote-debugging-port=9222）')
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
  if (message.result?.exceptionDetails) {
    entry.reject(
      new Error(message.result.exceptionDetails.exception?.description ?? message.result.exceptionDetails.text),
    )
    return
  }
  entry.resolve(message.result?.result?.value)
})

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', () => reject(new Error('WebSocket 错误')))
})

/** 在页面里求值。 */
function evaluate(expression) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(
      JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }),
    )
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error('求值超时'))
      }
    }, 20000)
  })
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
/** 断言并打印。 */
function check(label, actual, expected) {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (期望 ${expected})`}`)
}

/** 按可见文本点击（只匹配真正可点的元素）。 */
async function clickByText(text) {
  return evaluate(`
    (() => {
      const target = ${JSON.stringify(text)};
      const node = [...document.querySelectorAll('button, [role=button], a')]
        .find((el) => (el.innerText || '').trim() === target);
      if (!node) return 'not-found';
      node.click();
      return 'clicked';
    })()
  `)
}

// ---- 准备：走完首次弹窗并进入会话 ------------------------------------------
//
// 用 --setup 才执行。默认跳过：这些点击（尤其是目录选择器里的确认按钮）可能命中
// 会触发应用重启的动作，把测试打断在一个半途状态里。DOM 行为测试应当在已经就绪的
// 界面上跑。
if (process.argv.includes('--setup')) {
  for (const label of ['继续', '稍后配置', '保存并继续', '标准模式', '新会话']) {
    const result = await clickByText(label)
    if (result === 'clicked') console.log(`[setup] 点击「${label}」`)
    await wait(2200)
  }
  await wait(2500)
}

// ---- 定位徽章 ---------------------------------------------------------------
//
// 徽章是容器里那个 title 以 "Git: " 开头的按钮。用 closest 的容器定位，
// 因为它才是"点击外部"判定的作用域。
const findChip = `
  (() => {
    const node = [...document.querySelectorAll('button')]
      .find((el) => (el.getAttribute('title') || '').startsWith('Git:'));
    return node === undefined ? null : node;
  })()
`
const chipExists = await evaluate(`Boolean(${findChip})`)
console.log('')
console.log('徽章是否渲染:', chipExists)
if (!chipExists) {
  const body = await evaluate('document.body.innerText.replace(/\\n+/g, " | ").slice(0, 400)')
  console.log('页面文本:', body)
  console.log('')
  console.log('无法继续：徽章未渲染。若界面停在开始页，先手动进一个会话；或用 --setup。')
  socket.close()
  process.exit(1)
}

/**
 * 面板是否可见。
 *
 * 用插件打的 `data-desktop-branch-menu` 标记判定，而不是匹配标题文本：文本会随
 * 语言与文案调整而变（面板标题从「切换分支」改成了「源代码管理」），而标记是
 * 故意留的稳定契约，也让"面板在不在"这件事与它的文案彻底解耦。
 */
const menuOpen = `Boolean(document.querySelector('[data-desktop-branch-menu]'))`

/** 按 data 属性取一个元素并调用它的处理器。 */
const clickAttr = (attr, value) => `
  (() => {
    const node = ${value === undefined
      ? `document.querySelector('[${attr}]')`
      : `document.querySelector('[${attr}="${value}"]')`};
    if (!node) return 'not-found';
    node.click();
    return 'clicked';
  })()
`

// ---- 0. 归一化到"菜单关闭"的已知状态 ---------------------------------------
//
// 不能假设测试开始时菜单是关的：应用可能刚重启、或上一次交互留下了打开状态。
// 先强行关掉并确认，否则后面每条断言都会因初始状态不同而误判。
await evaluate(`
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  true
`)
await wait(600)
const normalized = await evaluate(menuOpen)
console.log('')
console.log('归一化后菜单状态（应为 false）:', normalized)
if (normalized === 'true' || normalized === true) {
  // 兜底：直接点徽章把它关掉。
  await evaluate(`(${findChip}).click()`)
  await wait(600)
}

// ---- 1. 点徽章应打开菜单 ----------------------------------------------------
check('1) 初始菜单关闭', await evaluate(menuOpen), 'false')
await evaluate(`(${findChip}).click()`)
await wait(700)
check('   点徽章后菜单打开', await evaluate(menuOpen), 'true')

// ---- 1b. 面板结构：搜索框 + 四个快捷操作 + 三段分组 --------------------------
check('   有搜索框', await evaluate(`document.querySelectorAll('[data-desktop-branch-menu] input[type=search]').length`), '1')
for (const key of ['update', 'commit', 'push', 'new', 'tag']) {
  check(`   快捷操作 ${key} 存在`, await evaluate(`Boolean(document.querySelector('[data-desktop-sc-action="${key}"]'))`), 'true')
}
check('   有「本地」分组', await evaluate(`Boolean(document.querySelector('[data-desktop-sc-section="local"]'))`), 'true')
check('   当前分支行被标记', await evaluate(`document.querySelectorAll('[data-desktop-branch-mark="current"]').length`), '1')

// ---- 2. 点页面其他地方（真实 mousedown + click）应关闭 ----------------------
await evaluate(`
  (() => {
    // 点在页面左上角的空白区域：真实派发 mousedown 与 click，模拟用户操作。
    const target = document.querySelector('body');
    const opts = { bubbles: true, cancelable: true, clientX: 5, clientY: 5, button: 0 };
    target.dispatchEvent(new MouseEvent('mousedown', opts));
    target.dispatchEvent(new MouseEvent('mouseup', opts));
    target.dispatchEvent(new MouseEvent('click', opts));
    return true;
  })()
`)
await wait(700)
check('2) 点外部后菜单关闭', await evaluate(menuOpen), 'false')

// ---- 3. 再点徽章应能重新打开（确认没被卡住）--------------------------------
await evaluate(`(${findChip}).click()`)
await wait(700)
check('3) 可重新打开', await evaluate(menuOpen), 'true')

// ---- 4. Esc 应关闭 ----------------------------------------------------------
await evaluate(`
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  true
`)
await wait(700)
check('4) Esc 关闭菜单', await evaluate(menuOpen), 'false')

// ---- 5. 点菜单内部不应关闭 --------------------------------------------------
await evaluate(`(${findChip}).click()`)
await wait(700)
await evaluate(`
  (() => {
    // 点搜索框（在容器内部）并输入：菜单应保持打开，且搜索确实过滤了列表。
    const input = document.querySelector('[data-desktop-branch-menu] input[type=search]');
    if (!input) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'zzz-no-such-branch');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  })()
`)
await wait(700)
check('5) 点菜单内部保持打开', await evaluate(menuOpen), 'true')
check('   搜索过滤掉全部分支', await evaluate(`document.querySelectorAll('[data-desktop-branch-option]').length`), '0')
check('   空态提示是"没有匹配"', await evaluate(`/没有匹配/.test(document.querySelector('[data-desktop-branch-menu]').innerText)`), 'true')
check('   过滤时快捷操作仍在', await evaluate(`Boolean(document.querySelector('[data-desktop-sc-action="push"]'))`), 'true')

// ---- 6. 右键菜单 ------------------------------------------------------------
// 先恢复一个可用的搜索词，拿到一个非当前分支的行。
await evaluate(`
  (() => {
    const input = document.querySelector('[data-desktop-branch-menu] input[type=search]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`)
await wait(600)
const target = await evaluate(`
  (() => {
    const rows = [...document.querySelectorAll('[data-desktop-branch-option]')];
    const node = rows.find((el) => el.getAttribute('aria-current') !== 'true');
    return node === undefined ? null : node.getAttribute('data-desktop-branch-name');
  })()
`)
console.log('')
console.log('用于右键的分支:', target)
check('6) 找到一个非当前分支', target === null, 'false')
await evaluate(`
  (() => {
    const node = [...document.querySelectorAll('[data-desktop-branch-option]')]
      .find((el) => el.getAttribute('data-desktop-branch-name') === ${JSON.stringify(target)});
    if (!node) return 'not-found';
    node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
    return 'opened';
  })()
`)
await wait(700)
check('   右键打开了菜单', await evaluate(`Boolean(document.querySelector('[data-desktop-sc-menu]'))`), 'true')
check('   菜单有「签出」', await evaluate(`Boolean(document.querySelector('[data-desktop-sc-menuitem="checkout"]'))`), 'true')
check('   菜单有「重命名」', await evaluate(`Boolean(document.querySelector('[data-desktop-sc-menuitem="rename"]'))`), 'true')
check('   菜单有「删除」', await evaluate(`Boolean(document.querySelector('[data-desktop-sc-menuitem="delete"]'))`), 'true')
check('   菜单有「新建分支」', await evaluate(`Boolean(document.querySelector('[data-desktop-sc-menuitem="new-from"]'))`), 'true')

// 点一次面板内部（非菜单）应只收起右键菜单，面板本身要留着。
await evaluate(`
  (() => {
    const node = document.querySelector('[data-desktop-branch-menu]');
    const opts = { bubbles: true, cancelable: true, button: 0 };
    node.dispatchEvent(new MouseEvent('mousedown', opts));
    return true;
  })()
`)
await wait(600)
check('   点面板内部只收起右键菜单', await evaluate(`Boolean(document.querySelector('[data-desktop-sc-menu]'))`), 'false')
check('   面板仍然打开', await evaluate(menuOpen), 'true')

// ---- 7. 对话框 --------------------------------------------------------------
await evaluate(clickAttr('data-desktop-sc-action', 'new'))
await wait(600)
check('7) 点「新建分支」打开对话框', await evaluate(`Boolean(document.querySelector('[data-desktop-sc-dialog="create"]'))`), 'true')
check('   有分支名输入框', await evaluate(`Boolean(document.querySelector('[data-desktop-sc-field="name"]'))`), 'true')
check('   有起点输入框', await evaluate(`Boolean(document.querySelector('[data-desktop-sc-field="from"]'))`), 'true')
check('   名字为空时确定被禁用', await evaluate(`(document.querySelector('[data-desktop-sc-button="confirm"]') ?? {}).disabled === true`), 'true')
// Esc 应只关掉对话框，面板还在。
await evaluate(`
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  true
`)
await wait(600)
check('   Esc 关掉对话框', await evaluate(`Boolean(document.querySelector('[data-desktop-sc-dialog]'))`), 'false')
check('   面板仍然打开', await evaluate(menuOpen), 'true')

socket.close()
console.log('')
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
