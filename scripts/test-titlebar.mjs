// 自定义标题栏与菜单桥的回归测试（不需要图形环境）。
//
//   npm run build && node scripts/test-titlebar.mjs
//
// 钉住三类容易悄悄坏掉的东西：
//   1. 平台策略：Windows 自绘标题栏 + 原生菜单栏隐藏；macOS 不重复画菜单；
//      Linux 保留原生边框与原生菜单栏（行为完全不变）。
//   2. 菜单桥：菜单栏按钮来自**同一份原生菜单**，弹出的也是那个 MenuItem 的子菜单——
//      因此点菜单项执行的就是原来的 handler / role，不存在第二份命令表。
//   3. 标题栏页面：高度、拖拽区、no-drag 交互元素、以及无障碍属性都在。
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import {
  TITLEBAR_HEIGHT,
  drawsMenusInTitleBar,
  keepsNativeMenuBar,
  normalizeHex,
  overlayColors,
  systemThemeTokens,
  usesCustomTitleBar,
} from '../dist/main/titlebar.js'
import { menuBarEntries, openMenuAt } from '../dist/main/menu.js'
import { shellPageHtml } from '../dist/main/shell-page.js'

let passed = 0
let failed = 0
async function check(name, action) {
  try {
    await action()
    passed += 1
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('=== 1. 标题栏几何与平台策略 ===')
await check('标题栏高度在 38–44px 之间', () => {
  assert.ok(TITLEBAR_HEIGHT >= 38 && TITLEBAR_HEIGHT <= 44, `实际 ${TITLEBAR_HEIGHT}`)
})
await check('Windows 自绘标题栏并隐藏原生菜单栏', () => {
  assert.equal(usesCustomTitleBar('win32'), true)
  assert.equal(drawsMenusInTitleBar('win32'), true)
  assert.equal(keepsNativeMenuBar('win32'), false)
})
await check('macOS 自绘标题栏但菜单留在系统菜单栏', () => {
  assert.equal(usesCustomTitleBar('darwin'), true)
  assert.equal(drawsMenusInTitleBar('darwin'), false)
})
await check('Linux 保留原生边框与原生菜单栏（行为不变）', () => {
  assert.equal(usesCustomTitleBar('linux'), false)
  assert.equal(keepsNativeMenuBar('linux'), true)
})

console.log('')
console.log('=== 2. 主题换算 ===')
await check('系统深浅色回退值可用于覆盖层', () => {
  const dark = overlayColors(systemThemeTokens(true))
  const light = overlayColors(systemThemeTokens(false))
  assert.match(dark.color, /^#[0-9a-f]{6}$/u)
  assert.match(dark.symbolColor, /^#[0-9a-f]{6}$/u)
  assert.notEqual(dark.color, light.color)
})
await check('页面令牌优先，rgb() 会归一化成 #rrggbb', () => {
  const colors = overlayColors({ bg: 'rgb(21, 21, 23)', fg: 'rgb(249, 250, 251)' })
  assert.deepEqual(colors, { color: '#151517', symbolColor: '#f9fafb' })
})
await check('带 alpha 的令牌丢掉 alpha（覆盖层要求不透明）', () => {
  assert.equal(normalizeHex('#2631480f'), '#263148')
  assert.equal(normalizeHex('#0f1115ff'), '#0f1115')
})
await check('透明与不可解析的颜色被拒绝（退回系统色）', () => {
  assert.equal(normalizeHex('rgba(0, 0, 0, 0)'), undefined)
  assert.equal(normalizeHex('#00000000'), undefined)
  assert.equal(normalizeHex('transparent'), undefined)
  assert.equal(normalizeHex(undefined), undefined)
})
await check('三位 hex 会展开', () => {
  assert.equal(normalizeHex('#abc'), '#aabbcc')
})

console.log('')
console.log('=== 3. 菜单栏来自同一份原生菜单 ===')
const fakeSubmenuA = { items: [{ label: '打开文件夹…' }], popup: () => {} }
const fakeSubmenuB = { items: [{ label: '撤销' }], popup: () => {} }
const fakeMenu = {
  items: [
    { type: 'normal', label: '文件', submenu: fakeSubmenuA },
    { type: 'separator' },
    { type: 'normal', label: '编辑', submenu: fakeSubmenuB },
    { type: 'normal', label: '无子菜单项（不该画出来）' },
  ],
}
await check('只列出带子菜单的顶层项，并保留原生顺序与下标', () => {
  assert.deepEqual(menuBarEntries(fakeMenu), [
    { index: 0, label: '文件' },
    { index: 2, label: '编辑' },
  ])
})

console.log('')
console.log('=== 4. 弹菜单：弹出的是同一个子菜单对象 ===')
await check('在给定坐标弹出对应子菜单并透传关闭回调', () => {
  let captured
  const menu = {
    items: [
      {
        type: 'normal',
        label: '文件',
        submenu: {
          items: [{ label: '打开文件夹…' }],
          popup: (options) => {
            captured = options
          },
        },
      },
    ],
  }
  const target = menu.items[0].submenu
  const fakeWindow = { id: 'window' }
  let closed = 0
  const ok = openMenuAt(menu, 0, fakeWindow, { x: 100, y: 40 }, () => {
    closed += 1
  })
  assert.equal(ok, true)
  assert.equal(captured.window, fakeWindow)
  assert.equal(captured.x, 100)
  assert.equal(captured.y, 40)
  assert.equal(typeof captured.callback, 'function')
  captured.callback()
  assert.equal(closed, 1)
  // 弹出的是那个 MenuItem 自己的子菜单：命令实现只有一份。
  assert.equal(typeof target.popup, 'function')
})
await check('非法下标与没有子菜单的项都不会弹', () => {
  const menu = { items: [{ type: 'normal', label: '文件', submenu: { items: [{}], popup: () => {} } }, { type: 'normal', label: '空' }] }
  assert.equal(openMenuAt(menu, '0', {}, { x: 0, y: 0 }), false)
  assert.equal(openMenuAt(menu, -1, {}, { x: 0, y: 0 }), false)
  assert.equal(openMenuAt(menu, 9, {}, { x: 0, y: 0 }), false)
  assert.equal(openMenuAt(menu, 1, {}, { x: 0, y: 0 }), false)
})
await check('坐标被钳到非负整数（不可信输入）', () => {
  let captured
  const menu = { items: [{ submenu: { items: [{}], popup: (options) => { captured = options } } }] }
  openMenuAt(menu, 0, {}, { x: -20.7, y: Number.NaN })
  assert.equal(captured.x, 0)
  assert.equal(captured.y, 0)
})

console.log('')
console.log('=== 5. 标题栏页面 ===')
const html = shellPageHtml({
  platform: 'win32',
  height: TITLEBAR_HEIGHT,
  custom: true,
  menus: true,
  splashTitle: 'DeepSeek Harness',
  splashHint: '正在启动…',
  backLabel: '返回',
  forwardLabel: '前进',
  dark: false,
})
await check('窗口控制交给系统：标题栏里没有自绘的最小化/最大化/关闭', () => {
  // 自绘这些按钮就拿不到 Win11 的最大化按钮贴靠布局（Snap Layout），因此本方案里一个都不画。
  for (const forbidden of ['nav-minimize', 'nav-maximize', 'nav-close', 'window-control', 'tb-controls']) {
    assert.ok(!html.includes(forbidden), `标题栏里出现了自绘的窗口控制：${forbidden}`)
  }
})
await check('包含标题栏、菜单栏与导航按钮，并保留旧加载页 id', () => {
  for (const id of ['id="titlebar"', 'id="menubar"', 'id="nav-back"', 'id="nav-forward"', 'id="startup-hint"']) {
    assert.ok(html.includes(id), `缺少 ${id}`)
  }
  assert.ok(html.includes('role="menubar"'))
})
await check('交互元素有 aria-label / title（无障碍）', () => {
  assert.ok(html.includes('aria-label="返回"') && html.includes('title="返回"'))
  assert.ok(html.includes('aria-label="前进"') && html.includes('title="前进"'))
})
await check('整条是拖拽区，交互元素逐个让开', () => {
  assert.ok(html.includes('-webkit-app-region: drag'))
  assert.ok(html.includes('-webkit-app-region: no-drag'))
  // 每个可点元素都必须自己声明 no-drag，否则"点菜单等于拖窗口"。
  const noDragRuleCount = (html.match(/no-drag/gu) ?? []).length
  assert.ok(noDragRuleCount >= 4, `no-drag 规则偏少：${noDragRuleCount}`)
})
/** 绝对定位式的像素坐标（`left: 1134px` 这种）；`padding-left` 不算。 */
const ABSOLUTE_PIXEL = /(?:^|[;{]\s*)(?:left|right|top)\s*:\s*-?\d+(?:\.\d+)?px/mu

await check('右侧原生按钮的占地由 env(titlebar-area-*) 算出（不硬编码像素）', () => {
  assert.ok(html.includes('env(titlebar-area-x'))
  assert.ok(html.includes('env(titlebar-area-width'))
  assert.ok(!ABSOLUTE_PIXEL.test(html), '出现了硬编码的绝对定位像素值')
})
await check('高度是单点变量，且没有绝对定位像素坐标', () => {
  assert.ok(html.includes('--tb-height: 40px'))
  assert.ok(html.includes('height: var(--tb-height)'))
  assert.ok(!ABSOLUTE_PIXEL.test(html), '出现了硬编码的绝对定位像素值')
  // 布局靠 flex：DPI 变化时不会错位。
  assert.ok(html.includes('display: flex'))
})
await check('有 CSP，且不引用任何远程资源', () => {
  assert.ok(html.includes('Content-Security-Policy'))
  assert.ok(!/https?:\/\//u.test(html), '页面里不应出现远程地址')
})
await check('标题与提示按数据转义', () => {
  const evil = shellPageHtml({
    platform: 'win32',
    height: 40,
    custom: true,
    menus: true,
    splashTitle: '<script>alert(1)</script>',
    splashHint: '"><img src=x>',
    backLabel: '<b>',
    forwardLabel: '"',
    dark: true,
  })
  assert.ok(!evil.includes('<script>alert(1)</script>'))
  assert.ok(evil.includes('&lt;script&gt;'))
  assert.ok(!evil.includes('"><img src=x>'))
})
await check('不自绘标题栏时整条隐藏（Linux 保留原生边框）', () => {
  const native = shellPageHtml({
    platform: 'linux',
    height: 0,
    custom: false,
    menus: false,
    splashTitle: 'T',
    splashHint: 'H',
    backLabel: 'B',
    forwardLabel: 'F',
    dark: false,
  })
  assert.ok(native.includes('id="titlebar" hidden'))
  assert.ok(native.includes('id="menubar" role="menubar" hidden'))
  assert.ok(native.includes('inset: 0px 0 0 0'))
})
await check('平台与主题反映在 html 属性上', () => {
  assert.ok(html.includes('data-platform="win32"'))
  assert.ok(html.includes('data-theme="light"'))
  const darkHtml = shellPageHtml({
    platform: 'darwin',
    height: 40,
    custom: true,
    menus: false,
    splashTitle: 'T',
    splashHint: 'H',
    backLabel: 'B',
    forwardLabel: 'F',
    dark: true,
  })
  assert.ok(darkHtml.includes('data-theme="dark"'))
  assert.ok(darkHtml.includes('data-platform="darwin"'))
  // macOS 的交通灯不画在我们的内容上：左侧留位由平台选择器负责。
  assert.ok(darkHtml.includes('data-platform="darwin"] #titlebar { padding-left'))
})

console.log('')
console.log('=== 6. 页面脚本只转发、不实现业务 ===')
await check('页面不直接实现任何工作区/窗口动作', () => {
  // 业务动作全在主进程；页面只通过桥调用。出现这些词就说明有人把逻辑抄进了渲染层。
  for (const forbidden of ['pending-workspace', 'workspaceRegistry', 'ctx.workspace', 'openFolderV2']) {
    assert.ok(!html.includes(forbidden), `页面里出现了 ${forbidden}`)
  }
})
await check('窗口控制由系统负责，页面不调用 minimize/maximize/close', () => {
  for (const forbidden of ['window.minimize', 'window.maximize', 'window.close', "'minimize'", "'maximize'"]) {
    assert.ok(!html.includes(forbidden), `页面里出现了 ${forbidden}`)
  }
})
await check('路径无关：页面不拼任何本地路径', () => {
  assert.ok(!html.includes(resolve('/')))
})

console.log('')
console.log(`${passed} 项通过${failed === 0 ? '' : `，${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
