// 菜单清单回归：改标题栏**不能弄丢任何菜单项**。
//
//   npm run build && node scripts/test-menu-inventory.mjs
//
// 做法是启动真实应用并使用它自带的诊断开关 `DSH_DESKTOP_DUMP_MENU=1`：主进程会把
// **真实的**菜单模板打到 stderr，因此这里断言的是生产代码构建出来的菜单，而不是测试里
// 复刻的一份。它同时覆盖：
//   * 五个顶层菜单与每一项都在（含"更新"这一个容易被漏掉的顶层菜单）；
//   * 「最近打开」是**动态**的——写进 settings.json 的最近目录必须出现在子菜单里，
//     并且不存在的目录被过滤掉（这条行为属于外壳设置层，不是渲染层写死的）；
//   * 版本信息仍是不可点击的禁用项。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// electron 是一个导出可执行文件路径的 CommonJS 包。
const electronBinary = createRequire(import.meta.url)('electron')
const root = resolve(import.meta.dirname, '..')

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

const scratch = mkdtempSync(join(tmpdir(), 'dsh-menu-inventory-'))
// 单独给被测实例一个 Electron userData：开发期的应用名与"正在运行的这个桌面应用"相同，
// 共用一个 userData 会撞上单实例锁——第二个实例会直接 quit，什么都打不出来。
const isolatedUserData = join(scratch, 'electron-user-data')
mkdirSync(isolatedUserData, { recursive: true })
const recentA = join(scratch, 'recent-project-alpha')
const recentB = join(scratch, 'recent-project-beta')
mkdirSync(recentA, { recursive: true })
mkdirSync(recentB, { recursive: true })
// 一个不存在的目录：菜单里不该出现（pruneRecent 的既有行为）。
const missing = join(scratch, 'deleted-project-gamma')
// 顺序：最新的在前。
writeFileSync(
  join(scratch, 'settings.json'),
  JSON.stringify({ workspace: recentA, recent: [recentA, missing, recentB] }, null, 2) + '\n',
)

const result = spawnSync(electronBinary, [root, `--user-data-dir=${isolatedUserData}`], {
  cwd: root,
  env: { ...process.env, DSH_DESKTOP_DUMP_MENU: '1', DSH_DESKTOP_HOME: scratch },
  encoding: 'utf8',
  timeout: 120000,
  windowsHide: true,
})

const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
const match = /\[menu\]([\s\S]*?)\[\/menu\]/u.exec(output)
const dump = match === null ? '' : match[1]

console.log('=== 1. 诊断开关确实输出了菜单 ===')
await check('应用以 DSH_DESKTOP_DUMP_MENU=1 启动并打印了菜单结构', () => {
  assert.notEqual(dump, '', `未拿到菜单输出；stderr 片段：${output.slice(-400)}`)
})

console.log('')
console.log('=== 2. 顶层菜单一个都不少 ===')
for (const label of ['文件', '编辑', '视图', '更新', '帮助']) {
  await check(`顶层菜单「${label}」存在`, () => {
    assert.ok(new RegExp(`^${label}$`, 'mu').test(dump), `菜单里没有 ${label}`)
  })
}

console.log('')
console.log('=== 3. 每一项都还在（行为保持不变） ===')
const expected = [
  '打开文件夹…',
  '最近打开',
  '项目信息…',
  '在文件管理器中打开工作区',
  '复制工作区路径',
  '重新加载',
  '强制重新加载',
  '开发者工具',
  '退出',
  '撤销',
  '重做',
  '剪切',
  '复制',
  '粘贴',
  '全选',
  '实际大小',
  '放大',
  '缩小',
  '全屏',
  '检查更新…',
  '打开发布页面',
]
for (const label of expected) {
  await check(`菜单项「${label}」保留`, () => {
    assert.ok(dump.includes(label), `菜单里没有 ${label}`)
  })
}
await check('快捷键提示仍由原生菜单给出（Ctrl+O / Ctrl+I / Ctrl+Shift+U）', () => {
  for (const accelerator of ['CmdOrCtrl+O', 'CmdOrCtrl+I', 'CmdOrCtrl+Shift+U']) {
    assert.ok(dump.includes(accelerator), `菜单里没有加速键 ${accelerator}`)
  }
})

console.log('')
console.log('=== 4. 最近打开仍是动态数据 ===')
await check('settings.json 里的最近目录出现在子菜单里', () => {
  assert.ok(dump.includes('recent-project-alpha'), '缺少 recent-project-alpha')
  assert.ok(dump.includes('recent-project-beta'), '缺少 recent-project-beta')
})
await check('已删除的目录被过滤掉（沿用既有行为）', () => {
  assert.ok(!dump.includes('deleted-project-gamma'), '不该出现已删除的目录')
})
await check('最近打开的条目是可点击项（不是禁用占位）', () => {
  const lines = dump.split('\n').map((line) => line.trim())
  const index = lines.indexOf('recent-project-alpha')
  assert.ok(index > 0, '没找到最近打开条目')
  assert.ok(!lines[index].includes('(禁用)'), '最近打开条目被禁用了')
})

console.log('')
console.log('=== 5. 版本行仍是不可点击的信息 ===')
await check('运行时与外壳版本都是禁用项', () => {
  for (const label of ['智能体运行时', '应用外壳']) {
    const line = dump.split('\n').map((entry) => entry.trim()).find((entry) => entry.startsWith(label))
    assert.ok(line !== undefined, `没有版本行：${label}`)
    assert.ok(line.includes('(禁用)'), `${label} 应当是禁用项：${line}`)
  }
})

try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
  // 清理失败不影响结论。
}

console.log('')
console.log(`${passed} 项通过${failed === 0 ? '' : `，${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
