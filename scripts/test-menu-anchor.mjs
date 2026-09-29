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
// （下拉定位的断言仍然成立，只需把入口与容器选择器对准新 DOM。）
//
// 验证下拉面板贴着各自的入口显示，而不是飘到屏幕角落。
//
//   node scripts/test-menu-anchor.mjs
//
// 背景：把面板从 `absolute` 改成 `fixed` 是为了跳出输入框容器的裁剪（小窗口下曾被裁成
// 一条），但 `fixed` 不再跟随入口——偏移写成常量就会钉在角落。实测分支菜单就飘到了左下角。
// 因此这里的断言不是"面板在视口内"（那太弱），而是"面板与入口在位置上相关"。
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

/**
 * 打开某个入口，量出入口与它面板的矩形，并判断两者的位置关系。
 * @param label - 展示名。
 * @param finder - 返回入口元素的表达式。
 * @param menuSelector - 面板选择器表达式。
 * @param side - 'above' 表示面板应在入口上方，'below' 表示在下方。
 */
async function verify(label, finder, menuSelector, side) {
  console.log('')
  console.log(`=== ${label} ===`)
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`)
  await wait(400)
  const clicked = await evaluate(`(() => { const el = ${finder}; if (!el) return 'not-found'; el.click(); return 'clicked' })()`)
  if (clicked === 'not-found') {
    console.log('  SKIP  入口不存在')
    return
  }
  await wait(1200)

  const raw = await evaluate(`
    (() => {
      const trigger = ${finder};
      const menu = ${menuSelector};
      if (!trigger || !menu) return JSON.stringify({ found: false, trigger: Boolean(trigger), menu: Boolean(menu) });
      const t = trigger.getBoundingClientRect();
      const m = menu.getBoundingClientRect();
      return JSON.stringify({
        found: true,
        trigger: { top: Math.round(t.top), bottom: Math.round(t.bottom), left: Math.round(t.left), right: Math.round(t.right) },
        menu: { top: Math.round(m.top), bottom: Math.round(m.bottom), left: Math.round(m.left), right: Math.round(m.right) },
        viewport: { w: window.innerWidth, h: window.innerHeight },
      });
    })()
  `)
  const data = JSON.parse(raw)
  console.log(`  入口: ${JSON.stringify(data.trigger)}`)
  console.log(`  面板: ${JSON.stringify(data.menu)}`)

  check('面板已展开', data.found === true)
  // 核心断言：面板与入口在位置上相关。
  const horizontalOverlap = data.menu.right > data.trigger.left && data.menu.left < data.trigger.right
  check('与入口水平方向有重叠（未飘到别处）', horizontalOverlap)
  if (side === 'above') {
    // 面板应在入口上方：其底边不高于入口顶边 + 容差。
    check('面板位于入口上方', data.menu.bottom <= data.trigger.top + 12, `${data.menu.bottom} <= ${data.trigger.top}`)
  } else {
    check('面板位于入口下方', data.menu.top >= data.trigger.bottom - 12, `${data.menu.top} >= ${data.trigger.bottom}`)
  }
  check('面板不越出视口（上）', data.menu.top >= 0, String(data.menu.top))
  check('面板不越出视口（下）', data.menu.bottom <= data.viewport.h, `${data.menu.bottom} <= ${data.viewport.h}`)

  if (label === '分支菜单') {
    // 分支项的可读性：当前分支此前是浅蓝字叠中蓝底、又因按钮 disabled 而整体半透明，
    // 结果几乎看不清（实际反馈）。这里用对比度量化，不再靠"看起来还行"。
    const contrast = JSON.parse(
      await evaluate(`
        (() => {
          const items = [...document.querySelectorAll('button')].filter((el) => (el.getAttribute('title') || '').match(/^(本地分支|远程分支|Local branch|Remote branch)$/));
          const parse = (value) => {
            const m = (value || '').match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/);
            return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
          };
          const luminance = (c) => {
            const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4) };
            return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
          };
          // 面板底色：取菜单容器的背景，用于把半透明前景合成上去。
          const menu = ${menuSelector};
          const menuBg = menu ? (parse(getComputedStyle(menu).backgroundColor) || { r: 35, g: 35, b: 41, a: 1 }) : { r: 35, g: 35, b: 41, a: 1 };
          const over = (fg, bg) => ({
            r: fg.r * fg.a + bg.r * (1 - fg.a),
            g: fg.g * fg.a + bg.g * (1 - fg.a),
            b: fg.b * fg.a + bg.b * (1 - fg.a),
          });
          const out = items.slice(0, 6).map((el) => {
            const s = getComputedStyle(el);
            const fg = parse(s.color);
            const elBg = parse(s.backgroundColor);
            const opacity = Number(s.opacity);
            const behind = elBg && elBg.a > 0 ? over(elBg, menuBg) : menuBg;
            // 元素自身的 opacity 会同时作用于文字与底色——合成时按它缩一次。
            const fgEff = fg ? { ...fg, a: (fg.a ?? 1) * opacity } : null;
            const bgEff = elBg ? { ...over(elBg, menuBg), a: 1 } : menuBg;
            const text = fgEff ? over(fgEff, bgEff) : null;
            const l1 = text ? luminance(text) : 0;
            const l2 = luminance(bgEff);
            const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
            return { name: (el.innerText || '').trim().slice(0, 24), opacity, ratio: Math.round(ratio * 100) / 100 };
          });
          return JSON.stringify(out);
        })()
      `),
    )
    console.log(`  分支项对比度: ${JSON.stringify(contrast)}`)
    // WCAG AA 对大号文字要求 3:1；分支名是 12px 等宽，按 4.5:1 要求更稳妥，
    // 这里取 3.5 作为下限——足以避免"看不清"，又不至于因主题差异误报。
    const worst = contrast.reduce((min, item) => Math.min(min, item.ratio), Number.POSITIVE_INFINITY)
    check('分支项对比度足够（≥3.5）', worst >= 3.5, `最差 ${worst}`)
    check('分支项没有被整体半透明', contrast.every((item) => item.opacity === 1), JSON.stringify(contrast.map((i) => i.opacity)))
  }

  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`)
  await wait(400)
}

// 分支菜单：在徽章上方展开。
await verify(
  '分支菜单',
  `[...document.querySelectorAll('button')].find((el) => (el.getAttribute('title') || '').startsWith('Git:'))`,
  `[...document.querySelectorAll('div')].find((el) => (el.innerText || '').trim().startsWith('切换分支'))`,
  'above',
)

// 项目改动面板：右侧全高抽屉（IDE 风格），而不是贴着入口的小浮层。
// 因此这里断言的是"贴住右边、占满高度"，而不是"在入口下方"——抽屉本来就覆盖整个
// 纵向范围，那个断言对抽屉没有意义。
console.log('')
console.log('=== 项目改动抽屉 ===')
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`)
// 面板开关是**持久化**的（localStorage），且它在插件模块加载时就被读进内存——
// 只删键不会改变运行中的状态。因此这里删键后**重载页面**，让状态真正归零，
// 否则"点一下"会把它从展开切成收起，测试随即误报为打不开。
await evaluate(`localStorage.removeItem('dsh.review.panelOpen'), location.reload(), true`)
await wait(9000)
const drawerClicked = await evaluate(
  `(() => { const el = ${`[...document.querySelectorAll('button')].find((el2) => /项目改动|选择要查看的项目/.test(el2.getAttribute('title') || ''))`}; if (!el) return 'not-found'; el.click(); return 'clicked' })()`,
)
if (drawerClicked === 'not-found') {
  console.log('  SKIP  入口不存在')
} else {
  await wait(1500)
  const drawer = JSON.parse(
    await evaluate(`
      (() => {
        const p = document.querySelector('aside[style*=fixed]');
        if (!p) return '{"found":false}';
        const r = p.getBoundingClientRect();
        const s = getComputedStyle(p);
        return JSON.stringify({
          found: true,
          top: Math.round(r.top), bottom: Math.round(r.bottom),
          left: Math.round(r.left), right: Math.round(r.right),
          height: Math.round(r.height),
          vw: window.innerWidth, vh: window.innerHeight,
          position: s.position,
        });
      })()
    `),
  )
  console.log(`  抽屉: ${JSON.stringify(drawer)}`)
  check('抽屉已展开', drawer.found === true)
  check('贴住窗口右边', Math.abs(drawer.right - drawer.vw) <= 1, `${drawer.right} vs ${drawer.vw}`)
  check('占满纵向（上边到底）', drawer.top === 0, String(drawer.top))
  check('占满纵向（下边到底）', Math.abs(drawer.bottom - drawer.vh) <= 1, `${drawer.bottom} vs ${drawer.vh}`)
  check('宽度合理（不至于占满全屏）', drawer.left > drawer.vw * 0.3, `left=${drawer.left}`)
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`)
  await wait(300)
}

socket.close()
console.log('')
console.log(failures === 0 ? '位置关系全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
