// 验证差异视图在**浅色与深色两种主题**下都可读，且具备行号与增删着色。
//
//   node scripts/test-diff-readability.mjs
//
// 为什么需要：差异视图此前只有一套为深色底设计的配色（浅绿/浅红文字）。界面一旦是浅色
// 主题，浅色文字叠浅色底就糊成一片——"变动记录看不清"正是这么来的。用对比度来断言，
// 比肉眼核对可靠，也能同时覆盖两种主题。
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

const send = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    socket.send(JSON.stringify({ id, method, params }))
  })
const evaluate = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `: ${detail}`}`)
}

/**
 * 打开抽屉、展开第一个文件、并测量差异行的对比度。
 * @param themeBaseValue - 当前主题基色（用于对比），形如 `#ffffff`。
 * @returns 测量结果。
 */
async function measure(themeBaseValue) {
  const raw = await evaluate(`
    (() => {
      const parse = (value) => {
        // 同时支持 #rrggbb（主题变量多是这个形式）与 rgb()/rgba()。
        const hex = (value || '').trim().match(/^#([0-9a-f]{6})$/i);
        if (hex !== null) {
          const n = parseInt(hex[1], 16);
          return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
        }
        const m = (value || '').match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/);
        return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
      };
      const lum = (c) => {
        const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
      };
      const over = (fg, bg) => ({
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a),
      });
      const ratio = (fg, bg) => {
        const l1 = lum(fg); const l2 = lum(bg);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };

      // 差异容器的背景（最外层带 border 的那个）。
      const drawer = document.querySelector('aside[style*=fixed]');
      if (!drawer) return JSON.stringify({ found: false, why: 'no-drawer' });

      // 差异行：按插件自己打的标记取，而不是靠层级猜——面板的外观会变，这个标记不会。
      // 行的子元素顺序是插件保证的契约：children[0] 行号栏、children[1] 增删标记、
      // children[2] 代码正文。
      const rows = [...drawer.querySelectorAll('[data-review-diff-row]')];
      if (rows.length === 0) return JSON.stringify({ found: false, why: 'no-diff-rows' });

      // 断言方式：测出**实际渲染的前景色**，与"主题基色"比较亮度。
      //
      // 为什么不直接用合成后的行底色算对比度：行底色是半透明的，要正确合成必须
      // 沿祖先逐级混合，实测这层合成很容易算错（深色下曾得出 1.25 这种不可能的比值，
      // 而同一段代码在浅色下是正常的 5.72 —— 说明错在测量而非配色）。
      // 前景色是实色、不受合成影响，与主题基色比较既等价又可靠：
      // 文字必须明显亮于（或暗于）它所处的背景，否则就是"看不清"。
      const base = parse(themeBaseValue) ?? { r: 255, g: 255, b: 255, a: 1 };
      const sample = (wantAdd) => {
        for (const row of rows) {
          const marker = (row.children[1].textContent || '').trim();
          if (wantAdd ? marker !== '+' : marker !== '−') continue;
          const s = getComputedStyle(row);
          const fg = parse(s.color);
          if (fg === null) continue;
          return {
            ratio: Math.round(ratio(fg, base) * 100) / 100,
            fg: s.color,
            bg: s.backgroundColor,
          };
        }
        return null;
      };

      return JSON.stringify({
        found: true,
        rowCount: rows.length,
        added: sample(true),
        removed: sample(false),
        // 取"至少有一行带行号"而不是只看第一行：文件头（diff --git …）那类元数据行
        // 本来就没有行号，用第一行判定会误报。
        hasLineNumbers: rows.some((row) => /\\d/.test(row.children[0]?.textContent || '')),
        // 等宽字体挂在差异容器上，测容器比测某一行稳（行的字体随实现变）。
        monoFont: /mono/i.test(getComputedStyle(drawer.querySelector('[data-review-diff]') ?? rows[0] ?? drawer).fontFamily || ''),
      });
    })()
  `)
  return JSON.parse(raw)
}

/**
 * 把界面切到指定主题。
 *
 * 直接改写官方主题变量，而不是去猜它的 localStorage 键：官方把配色写在
 * `--dsw-alias-*` 上，改写它们就能确定地得到该主题下的配色，测试也不再依赖
 * 官方内部的状态键名（那是会变的）。
 * @param dark - 是否深色。
 */
async function setTheme(dark) {
  await evaluate(`
    (() => {
      const root = document.documentElement;
      if (${String(dark)}) {
        root.style.setProperty('--dsw-alias-bg-base', '#1b1b1f');
        root.style.setProperty('--dsw-alias-bg-layer-1', '#17171b');
        root.style.setProperty('--dsw-alias-bg-overlay', '#1f1f24');
        root.style.setProperty('--dsw-alias-label-primary', '#e8e8ea');
        root.style.setProperty('--dsw-alias-label-secondary', '#c8c8d0');
        root.style.setProperty('--dsw-alias-label-tertiary', '#8a8a93');
      } else {
        root.style.setProperty('--dsw-alias-bg-base', '#ffffff');
        root.style.setProperty('--dsw-alias-bg-layer-1', '#f7f7f9');
        root.style.setProperty('--dsw-alias-bg-overlay', '#ffffff');
        root.style.setProperty('--dsw-alias-label-primary', '#1f1f24');
        root.style.setProperty('--dsw-alias-label-secondary', '#5f5f68');
        root.style.setProperty('--dsw-alias-label-tertiary', '#8a8a93');
      }
      return true;
    })()
  `)
  await wait(600)
}

for (const [theme, dark] of [
  ['light', false],
  ['dark', true],
]) {
  console.log('')
  console.log(`=== 主题: ${theme} ===`)
  await setTheme(dark)

  // 打开抽屉（面板开关是持久化的，先归零并重载，避免"点一下反而关掉"）。
  await evaluate(`localStorage.removeItem('dsh.review.panelOpen'), location.reload(), true`)
  await wait(9000)
  await setTheme(dark)
  await evaluate(
    `(() => { const el = [...document.querySelectorAll('button')].find((e) => /项目改动|选择要查看的项目/.test(e.getAttribute('title') || '')); if (el) el.click(); return true })()`,
  )
  await wait(2500)

  // 展开第一个文件以显示差异。
  const expanded = await evaluate(`
    (() => {
      const drawer = document.querySelector('aside[style*=fixed]');
      if (!drawer) return 'no-drawer';
      const btns = [...drawer.querySelectorAll('button')].filter((b) => (b.getAttribute('title') || '').includes('/'));
      if (btns.length === 0) return 'no-file';
      btns[0].click();
      return 'clicked';
    })()
  `)
  console.log(`  展开文件: ${expanded}`)
  await wait(1500)

  // 与 setTheme 用的基色一致，作为对比的参照面。
  const data = await measure(dark ? '#1b1b1f' : '#ffffff')
  console.log(`  测量: ${JSON.stringify(data)}`)

  if (!data.found || data.rowCount === 0) {
    console.log('  SKIP  当前没有可展示的差异（项目可能没有改动）')
    continue
  }
  check('差异行带行号', data.hasLineNumbers === true)
  check('差异用等宽字体', data.monoFont === true)
  check('新增行对比度 ≥ 4.5', (data.added?.ratio ?? 0) >= 4.5, String(data.added?.ratio))
  check('删除行对比度 ≥ 4.5', (data.removed?.ratio ?? 0) >= 4.5, String(data.removed?.ratio))
}

// 复位主题变量覆盖。
await evaluate(`
  (() => {
    const root = document.documentElement;
    for (const name of ['--dsw-alias-bg-base','--dsw-alias-bg-layer-1','--dsw-alias-bg-overlay','--dsw-alias-label-primary','--dsw-alias-label-secondary','--dsw-alias-label-tertiary']) {
      root.style.removeProperty(name);
    }
    return true;
  })()
`)

socket.close()
console.log('')
console.log(failures === 0 ? '差异可读性全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
