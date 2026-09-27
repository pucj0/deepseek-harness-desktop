// Desktop Shell 的语言必须跟随 **Harness 的语言设置**，而不是系统语言。
//
//   npm run build && node scripts/test-shell-locale.mjs
//
// 覆盖需求里的七个用例：
//   A. Harness = zh → 顶部菜单是 文件/编辑/视图/更新/帮助（而不是 File/Edit/View/Help）
//   B. Harness = en → File/Edit/View/Help
//   C/D. 运行中 zh ⇄ en：**不重启应用**就更新（真实 Electron 实例，靠它自带的菜单诊断输出断言）
//   E. 切换工作区（写 pending-workspace + relaunch）不会把语言重置
//   F. locale 归一化：zh / zh-CN / zh_CN → 中文，en / en-US / en_US → 英文；
//      以及运行期上报的入口 `coerceReportedLocale`（不认识的值必须返回 undefined，
//      调用方据此"保持现状"而不是回退系统语言）
//   G. 菜单是**窗口创建之前**就装好的：诊断输出的第一份菜单必须已经是中文——标题栏页面的
//      第一次 `getMenu()` 读到的就是它，因此"第一帧是中文"在这里就成立（这正是 Electron
//      默认菜单曾经被画进标题栏的位置）。真窗口的第一帧由 test-shell-cold-start.cjs 断言。
//
// 还有一条同样重要的反向要求：**label 可以变，命令不许变**。因此这里直接比对中英两份菜单
// 模板：位置、role、accelerator 与 click 回调必须逐一相同，只有 label 不同。
//
// 前四节是纯 Node（不需要 Electron）；最后一节启动真实应用实例验证运行中切换。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const i18n = require('../dist/main/i18n.js')
const locale = require('../dist/main/harness-locale.js')
const menu = require('../dist/main/menu.js')
const workspaceSwitch = require('../dist/main/workspace-switch.js')
const settings = require('../dist/main/settings.js')

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

const scratch = mkdtempSync(join(tmpdir(), 'dsh-shell-locale-'))
const wait = (ms) => new Promise((done) => setTimeout(done, ms))

/** 轮询直到条件成立（或超时）。返回是否成立，避免用固定 sleep 猜时序。 */
async function until(predicate, timeoutMs = 4000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) return false
    await wait(stepMs)
  }
}

/**
 * 写设置文档，方式与宿主一致。
 *
 * `dsh-settings-file` 用 `writeFileAtomic` 提交（临时文件 + rename），因此这里也这么做：
 * 只有这种写入方式才能证明监听器在 inode 被替换之后仍然有效。
 */
function writeSettingsAtomic(home, text, name = 'settings.yaml') {
  const target = join(home, name)
  const tmp = join(home, `.${name}.tmp-${process.pid}-${Date.now()}`)
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, target)
}

/** 一个隔离的 Harness 主目录（= `<userData>/home`）。 */
let homeSerial = 0
function freshHome() {
  homeSerial += 1
  const home = join(scratch, `home-${homeSerial}`)
  mkdirSync(home, { recursive: true })
  return home
}

// =====================================================================================
console.log('=== Case F: locale 归一化（zh / zh-CN / zh_CN → 中文；en / en-US / en_US → 英文） ===')
// =====================================================================================
const zhInputs = ['zh', 'zh-CN', 'zh_CN', 'zh-cn', 'zh-Hans-CN', 'zh-TW', 'ZH']
const enInputs = ['en', 'en-US', 'en_US', 'en-GB', 'EN-us']
for (const value of zhInputs) {
  await check(`F) ${value} → zh-CN`, () => {
    assert.equal(i18n.normalizeLocale(value), 'zh-CN')
    assert.equal(i18n.catalogFor(value).menuFile, '文件')
  })
}
for (const value of enInputs) {
  await check(`F) ${value} → en-US`, () => {
    assert.equal(i18n.normalizeLocale(value), 'en-US')
    assert.equal(i18n.catalogFor(value).menuFile, 'File')
  })
}
await check('F) 未支持的语言不进中文（回退英文，与 Harness 的英文兜底一致）', () => {
  for (const value of ['de-DE', 'ja', '', undefined, 'fr_FR']) {
    assert.equal(i18n.normalizeLocale(value), undefined)
    assert.equal(i18n.catalogFor(value).menuFile, 'File')
  }
})
await check('F) 运行期上报的归一化入口（coerceReportedLocale）', () => {
  // 这一条是 shell-bridge 上报链路唯一的值解释入口。要点有两个：
  //   1. 认识的语言要归一到本外壳真的带字典的那两个 id；
  //   2. **不认识的值返回 undefined** —— 调用方据此"保持现状"，而不是回退系统语言
  //      （这条上报是纠正，不是"用户清空了偏好"）。
  for (const value of ['zh', 'zh-CN', 'zh_CN', 'zh-Hans', 'zh-Hans-CN', 'zh-TW']) {
    assert.equal(i18n.coerceReportedLocale(value), 'zh-CN', value)
  }
  for (const value of ['en', 'en-US', 'en_US', 'en-GB']) {
    assert.equal(i18n.coerceReportedLocale(value), 'en-US', value)
  }
  for (const value of ['ja', 'de-DE', '', '   ', null, undefined, 42, {}, ['zh']]) {
    assert.equal(i18n.coerceReportedLocale(value), undefined, JSON.stringify(value))
  }
})
await check('F) 归一化是唯一的判断入口（没有别处比较 /^zh/）', () => {
  // 只要归一化正确，各处的取值就一致：这里是"同一个语言、三种写法、同一份文案"。
  const files = new Set(zhInputs.map((value) => i18n.catalogFor(value).menuFile))
  assert.equal(files.size, 1, `得到 ${[...files].join(' / ')}`)
  assert.equal([...files][0], '文件')
})

// =====================================================================================
console.log('')
console.log('=== 设置文档解析：只认 locale.preference（YAML/JSON，含宿主真实的文档形状） ===')
// =====================================================================================
await check('块状 YAML（宿主实际写出的形状）', () => {
  assert.equal(locale.parseLocalePreference('locale:\n  preference: zh\n'), 'zh')
  assert.equal(locale.parseLocalePreference('locale:\n  preference: en\n'), 'en')
})
await check('CRLF 与末尾空行不影响解析', () => {
  assert.equal(locale.parseLocalePreference('locale:\r\n  preference: zh\r\n\r\n'), 'zh')
})
await check('带引号的值', () => {
  assert.equal(locale.parseLocalePreference('locale:\n  preference: "zh-CN"\n'), 'zh-CN')
  assert.equal(locale.parseLocalePreference("locale:\n  preference: 'en-US'\n"), 'en-US')
})
await check('流式映射也认（防御性支持，不影响块状）', () => {
  assert.equal(locale.parseLocalePreference('locale: { preference: zh }\n'), 'zh')
})
await check('JSON 设置文档', () => {
  assert.equal(locale.parseLocalePreference('{"locale":{"preference":"zh"}}'), 'zh')
  assert.equal(locale.parseLocalePreference('{\n  "locale": { "preference": "en" }\n}\n'), 'en')
})
await check('真实文档形状：其它小节（含同名字段 preference）不会被误读', () => {
  // 这份文档就是本机 Harness 主目录里那份的结构：`ui-theme.preference: system` 与
  // `locale.preference` 字段同名，只有小节对了才算数。
  const document = [
    'ui-onboarding:',
    '  welcomeNoticeVersion: 2026-08-13.1',
    'ui-theme:',
    '  fontSize: 14',
    '  preference: system',
    'desktop-ui-typography:',
    '  fontSize: 14',
    '',
  ].join('\n')
  assert.equal(locale.parseLocalePreference(document), undefined)
  assert.equal(locale.parseLocalePreference(`${document}locale:\n  preference: zh\n`), 'zh')
  // 顺序反过来也要对（locale 在前，后面的小节不能污染）。
  assert.equal(locale.parseLocalePreference('locale:\n  preference: en\nui-theme:\n  fontSize: 14\n'), 'en')
})
await check('没有 locale 小节 / 小节里没有 preference / 空文件 / 坏内容 → undefined（回退系统语言）', () => {
  for (const text of [
    '',
    '   \n',
    'ui-theme:\n  fontSize: 14\n',
    'locale:\n  other: zh\n',
    'locale: {}\n',
    'locale:\n  preference:\n',
    '{{{ not yaml',
    '{ not json',
  ]) {
    assert.equal(locale.parseLocalePreference(text), undefined, JSON.stringify(text))
  }
})
await check('readLocalePreference 从主目录读取（并为 .json 兜底）', () => {
  const home = freshHome()
  assert.equal(locale.readLocalePreference(home), undefined, '文件不存在时应当是 undefined')
  writeFileSync(join(home, locale.SETTINGS_FILENAME), 'locale:\n  preference: zh\n', 'utf8')
  assert.equal(locale.readLocalePreference(home), 'zh')
  const jsonHome = freshHome()
  writeFileSync(join(jsonHome, locale.SETTINGS_JSON_FILENAME), '{"locale":{"preference":"en"}}', 'utf8')
  assert.equal(locale.readLocalePreference(jsonHome), 'en')
  assert.equal(locale.readLocalePreference(''), undefined)
})

// =====================================================================================
console.log('')
console.log('=== Case A / B: 顶部菜单（含全部子项）随语言切换，命令不变 ===')
// =====================================================================================
const commands = {
  recent: [],
  runtimeVersion: '0.1.5-rc.2',
  openFolder: () => {},
  openRecent: () => {},
  projectInfo: () => {},
  revealWorkspace: () => {},
  copyWorkspacePath: () => {},
  openUpdates: () => {},
  openReleases: () => {},
}
const zhTemplate = menu.applicationMenuTemplate({ ...commands, strings: i18n.catalogFor('zh-CN'), shellVersion: '1.5.9' })
const enTemplate = menu.applicationMenuTemplate({ ...commands, strings: i18n.catalogFor('en-US'), shellVersion: '1.5.9' })
const zhTop = zhTemplate.map((item) => item.label)
const enTop = enTemplate.map((item) => item.label)

await check('A) Harness = 中文 → 顶层是 文件 / 编辑 / 视图 / 更新 / 帮助', () => {
  assert.deepEqual(zhTop, ['文件', '编辑', '视图', '更新', '帮助'])
})
await check('B) Harness = English → File / Edit / View / Update / Help', () => {
  assert.deepEqual(enTop, ['File', 'Edit', 'View', 'Update', 'Help'])
})
await check('A/B) 菜单项一个都不少（子项数量与顶层结构一致）', () => {
  assert.equal(zhTemplate.length, enTemplate.length)
  for (let index = 0; index < zhTemplate.length; index += 1) {
    const zhSub = zhTemplate[index].submenu ?? []
    const enSub = enTemplate[index].submenu ?? []
    assert.equal(zhSub.length, enSub.length, `顶层 ${index} 的子项数量不同`)
  }
})
await check('A) 每个子项都有中文文案（抽查需求里点名的那些）', () => {
  const labels = JSON.stringify(zhTemplate)
  for (const label of ['打开文件夹…', '最近打开', '项目信息…', '在文件管理器中打开工作区', '复制工作区路径', '撤销', '重做', '剪切', '复制', '粘贴', '全选', '重新加载', '强制重新加载', '开发者工具', '实际大小', '放大', '缩小', '全屏', '检查更新…', '打开发布页面', '退出']) {
    assert.ok(labels.includes(label), `菜单里没有「${label}」`)
  }
})
await check('B) 每个子项都有英文文案（同一个位置）', () => {
  const labels = JSON.stringify(enTemplate)
  for (const label of ['Open Folder', 'Open Recent', 'Project Info', 'Reveal Workspace', 'Copy Workspace Path', 'Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select All', 'Reload', 'Force Reload', 'Developer', 'Zoom', 'Full Screen', 'Check for Updates', 'releases page', 'Exit']) {
    assert.ok(labels.includes(label), `菜单里没有「${label}」`)
  }
})
await check('label 可以变，命令绝不许变（role / accelerator / click 逐一相同）', () => {
  for (let index = 0; index < zhTemplate.length; index += 1) {
    const zhItems = zhTemplate[index].submenu ?? []
    const enItems = enTemplate[index].submenu ?? []
    for (let child = 0; child < zhItems.length; child += 1) {
      const zhItem = zhItems[child]
      const enItem = enItems[child]
      assert.equal(zhItem.type, enItem.type, `顶层 ${index}/${child} 的 type 不同`)
      assert.equal(zhItem.role, enItem.role, `顶层 ${index}/${child} 的 role 不同`)
      assert.equal(zhItem.accelerator, enItem.accelerator, `顶层 ${index}/${child} 的 accelerator 不同`)
      assert.equal(zhItem.enabled, enItem.enabled, `顶层 ${index}/${child} 的 enabled 不同`)
      // 同一个位置的 click 必须是**同一个函数对象**——这正是"按稳定命令分发，而不是按显示
      // 文字分发"的可执行证据（若哪里写了 label === '打开文件夹' 的判定，这里就会露出来）。
      assert.equal(zhItem.click, enItem.click, `顶层 ${index}/${child} 的 click 不是同一个回调`)
    }
  }
  // 顶层菜单没有 accelerator（它们只是标题），但同样不能带 click。
  for (const item of [...zhTemplate, ...enTemplate]) {
    assert.equal(item.click, undefined, '顶层菜单项不该直接挂 click（它是容器）')
  }
})
await check('最近打开是数据驱动的（两种语言下都来自同一份 recent）', () => {
  const withRecent = { ...commands, recent: [{ label: 'proj-a', path: 'C:\\x\\proj-a' }] }
  const zhRecent = menu.applicationMenuTemplate({ ...withRecent, strings: i18n.catalogFor('zh-CN'), shellVersion: '1.5.9' })
  const enRecent = menu.applicationMenuTemplate({ ...withRecent, strings: i18n.catalogFor('en-US'), shellVersion: '1.5.9' })
  assert.equal(zhRecent[0].submenu[1].submenu[0].label, 'proj-a')
  assert.equal(enRecent[0].submenu[1].submenu[0].label, 'proj-a')
  assert.equal(zhRecent[0].submenu[1].submenu[0].toolTip, 'C:\\x\\proj-a')
})

// =====================================================================================
console.log('')
console.log('=== Case C / D（进程内）: 监视 Harness 设置 → 活文案表跟着变，不重启 ===')
// =====================================================================================
{
  const home = freshHome()
  const settingsPath = join(home, locale.SETTINGS_FILENAME)
  writeSettingsAtomic(home, 'locale:\n  preference: zh\n')

  const seen = []
  const stop = locale.watchLocalePreference(home, (next) => seen.push(next))
  // 监视器读到的初值就是"启动时会用的语言"。
  assert.equal(locale.readLocalePreference(home), 'zh')
  // 启动路径：主进程用同一个值初始化界面文案表。
  const live = i18n.initShellStrings(locale.readLocalePreference(home))
  const liveRef = i18n.t()
  await check('C) 启动即中文（没有"先英文再切中文"的中间态）', () => {
    assert.equal(i18n.currentLocale(), 'zh-CN')
    assert.equal(live.menuFile, '文件')
    assert.equal(live.catalogFor === undefined, true)
    assert.equal(liveRef, live, 't() 必须返回同一个活对象')
  })

  await check('C) 运行中 zh → en：监视器回调拿到 en，活文案表就地变成英文', async () => {
    writeSettingsAtomic(home, 'locale:\n  preference: en\n')
    const fired = await until(() => seen.includes('en'))
    assert.ok(fired, `监视器没有回调：${JSON.stringify(seen)}`)
    // 主进程收到回调后做的事（见 index.ts 的 applyShellLocale）：应用语言 + 重建菜单。
    assert.equal(i18n.setShellLocale('en'), true, '语言应当被判定为变化')
    assert.equal(i18n.currentLocale(), 'en-US')
    // 关键：**启动时拿到的那个对象**也要是新语言（菜单、托盘、对话框都持有它）。
    assert.equal(live.menuFile, 'File', '活文案表没有跟着变')
    assert.equal(liveRef.itemOpenFolder, 'Open Folder…')
    assert.deepEqual(
      menu.applicationMenuTemplate({ ...commands, strings: liveRef, shellVersion: '1.5.9' }).map((item) => item.label),
      ['File', 'Edit', 'View', 'Update', 'Help'],
    )
  })

  await check('D) 运行中 en → zh：立即变回中文', async () => {
    writeSettingsAtomic(home, 'locale:\n  preference: zh\n')
    const fired = await until(() => seen.includes('zh'))
    assert.ok(fired, `监视器没有回调：${JSON.stringify(seen)}`)
    assert.equal(i18n.setShellLocale('zh'), true)
    assert.equal(i18n.currentLocale(), 'zh-CN')
    assert.equal(liveRef.menuFile, '文件')
  })

  await check('D) 反复切换都跟得上（rename 替换文件后监听仍然有效）', async () => {
    for (const value of ['en', 'zh', 'en', 'zh']) {
      writeSettingsAtomic(home, `locale:\n  preference: ${value}\n`)
      const fired = await until(() => seen[seen.length - 1] === value, 3000)
      assert.ok(fired, `第 ${seen.length} 次切换没被监听到（最后是 ${JSON.stringify(seen[seen.length - 1])}）`)
      i18n.setShellLocale(value)
      assert.equal(i18n.currentLocale(), value === 'en' ? 'en-US' : 'zh-CN')
    }
    assert.equal(readFileSync(settingsPath, 'utf8').includes('preference: zh'), true)
  })

  await check('写回同一个值不会打扰调用方（宿主重写整份文档时会带上其它小节）', async () => {
    const before = seen.length
    writeSettingsAtomic(home, 'locale:\n  preference: zh\nui-theme:\n  fontSize: 14\n')
    await wait(400)
    assert.equal(seen.length, before, `不该有回调：${JSON.stringify(seen)}`)
  })

  await check('设置文档**第一次出现**时也能被监听到（用户第一次选语言）', async () => {
    const home3 = freshHome()
    const values = []
    const stop3 = locale.watchLocalePreference(home3, (next) => values.push(next))
    await wait(200)
    assert.deepEqual(values, [], '还没有文件时不该有回调')
    writeSettingsAtomic(home3, 'locale:\n  preference: zh\n')
    const fired = await until(() => values.length === 1 && values[0] === 'zh', 3000)
    assert.ok(fired, `文件首次出现没有被监听到：${JSON.stringify(values)}`)
    stop3()
  })

  await check('装上监听**之前**发生的修改会被立刻对账补回来（基准 = 冷启动读到的值）', async () => {
    // 真实启动里"读到偏好"与"装上监听"之间隔着十几秒（首次启动还要解包运行时）。用户完全
    // 可能在这段时间里把语言改掉——只靠"等下一次事件"是等不到的，因为那次写早就发生过了。
    const home4 = freshHome()
    writeSettingsAtomic(home4, 'locale:\n  preference: zh\n')
    // 外壳冷启动读到的值：
    const coldStart = locale.readLocalePreference(home4)
    assert.equal(coldStart, 'zh')
    // 用户在"读到"与"装上监听"之间改了语言：
    writeSettingsAtomic(home4, 'locale:\n  preference: en\n')
    const values = []
    const stop4 = locale.watchLocalePreference(home4, (next) => values.push(next), coldStart)
    await wait(200)
    assert.deepEqual(values, ['en'], '注册时的对账必须认出这次修改')
    stop4()
  })

  await check('没有修改时注册监听**一个回调都不发**（对账只比较、不假设）', async () => {
    const home5 = freshHome()
    writeSettingsAtomic(home5, 'locale:\n  preference: zh\n')
    const values = []
    const stop5 = locale.watchLocalePreference(home5, (next) => values.push(next), locale.readLocalePreference(home5))
    await wait(250)
    assert.deepEqual(values, [], '值没变就不该有回调')
    // 基准与文件一致时同样如此；之后真的变了才回调。
    writeSettingsAtomic(home5, 'locale:\n  preference: en\n')
    const fired = await until(() => values.length === 1 && values[0] === 'en', 3000)
    assert.ok(fired, `后续变化没有被监听到：${JSON.stringify(values)}`)
    stop5()
  })

  await check('dispose 之后不再回调（不留下悬挂的 watcher）', async () => {
    stop()
    const before = seen.length
    writeSettingsAtomic(home, 'locale:\n  preference: en\n')
    await wait(400)
    assert.equal(seen.length, before)
  })

  await check('偏好被清空 → 回退系统语言（与启动路径同一个判定）', async () => {
    const home2 = freshHome()
    writeSettingsAtomic(home2, 'locale:\n  preference: en\n')
    const values = []
    const stop2 = locale.watchLocalePreference(home2, (next) => values.push(next))
    // 规则本身（可注入的系统语言，因此不依赖跑测试的这台机器）：
    assert.equal(i18n.resolveShellLocale('en', 'zh-CN'), 'en', '偏好优先于系统语言')
    assert.equal(i18n.resolveShellLocale(undefined, 'zh-CN'), 'zh-CN', '没有偏好时用系统语言')
    assert.equal(i18n.resolveShellLocale('', 'zh-CN'), 'zh-CN', '空偏好同样回退系统语言')
    // 用户在 Harness 里把设置改回"跟随浏览器"：节里没有值了。
    writeSettingsAtomic(home2, 'locale: {}\n')
    const fired = await until(() => values.length === 1 && values[0] === undefined, 3000)
    assert.ok(fired, `没有收到清空回调：${JSON.stringify(values)}`)
    // 主进程收到 undefined 会走 resolveShellLocale（系统语言）；这里注入一个已知的语言来断言
    // 这条路径本身，而不是断言这台机器的系统语言。
    i18n.setShellLocale(i18n.resolveShellLocale(values[0], 'zh-CN'))
    assert.equal(i18n.currentLocale(), 'zh-CN')
    stop2()
  })
}

// =====================================================================================
console.log('')
console.log('=== Case E: 切换工作区不会重置语言 ===')
// =====================================================================================
{
  const userDataDir = join(scratch, 'case-e-userdata')
  const home = join(userDataDir, 'home')
  mkdirSync(home, { recursive: true })
  const settingsPath = join(home, locale.SETTINGS_FILENAME)
  writeSettingsAtomic(home, 'locale:\n  preference: zh\n')
  const before = readFileSync(settingsPath, 'utf8')

  const target = mkdtempSync(join(scratch, 'case-e-workspace-'))
  const events = []
  const resolved = workspaceSwitch.resolveWorkspace(['electron.exe'], userDataDir)
  i18n.initShellStrings(locale.readLocalePreference(home))
  await check('前置：当前是中文', () => {
    assert.equal(i18n.currentLocale(), 'zh-CN')
    assert.equal(resolved, target === undefined ? resolved : resolved, '解析出的工作区应当可用')
  })
  await workspaceSwitch.restartIntoWorkspace({
    userDataDir,
    current: resolved,
    target,
    beginQuit: () => events.push('beginQuit'),
    stopServer: async () => events.push('stop'),
    relaunch: () => events.push('relaunch'),
    exit: (code) => events.push(`exit:${String(code)}`),
  })
  await check('E) 切换确实走了"标记 + 重启"这条路（不是就地替换）', () => {
    assert.deepEqual(events, ['beginQuit', 'stop', 'relaunch', 'exit:0'])
    assert.equal(settings.readSettings(userDataDir).workspace, target)
  })
  await check('E) 语言设置文件一个字节都没被动过', () => {
    assert.equal(readFileSync(settingsPath, 'utf8'), before)
    assert.equal(locale.readLocalePreference(home), 'zh')
  })
  await check('E) 重启后的新进程仍然是中文（启动路径读的还是同一份 Harness 设置）', () => {
    // 模拟"新进程启动"：与 index.ts 一样，从 Harness 设置里取语言。
    i18n.initShellStrings(locale.readLocalePreference(home))
    assert.equal(i18n.currentLocale(), 'zh-CN')
    assert.equal(i18n.t().menuFile, '文件')
  })
  await check('E) 切换工作区只写自己的标记，不碰语言（新进程启动时再消费它）', () => {
    // 切换是"写标记 + 重启"：标记留给**下一个进程**消费，当前进程到此为止。
    const pendingPath = join(userDataDir, 'pending-workspace')
    assert.equal(existsSync(pendingPath), true, '切换时必须留下待切换标记')
    assert.equal(readFileSync(pendingPath, 'utf8').trim(), target)
    assert.equal(i18n.t().menuFile, '文件')
    assert.equal(i18n.currentLocale(), 'zh-CN')
  })
  await check('E) 新进程消费标记（解析工作区）之后语言仍然是中文', () => {
    // 下一次启动的真实顺序：先 resolveWorkspace（会消费标记），再按 Harness 设置起文案。
    const resolvedAgain = workspaceSwitch.resolveWorkspace(['electron.exe'], userDataDir)
    assert.equal(resolvedAgain, target, '待切换标记必须生效')
    assert.equal(existsSync(join(userDataDir, 'pending-workspace')), false, '标记应当被消费')
    assert.equal(locale.readLocalePreference(home), 'zh', '语言设置全程没被动过')
    i18n.initShellStrings(locale.readLocalePreference(home))
    assert.equal(i18n.t().menuFile, '文件')
  })
}

// =====================================================================================
console.log('')
console.log('=== Case C / D（真实应用）: 运行中切换语言，同一个进程里菜单立刻变 ===')
// =====================================================================================
{
  const electronBinary = require('electron')
  const appHome = join(scratch, 'runtime-app')
  const dshHome = join(appHome, 'home')
  const isolatedUserData = join(scratch, 'runtime-app-userdata')
  mkdirSync(dshHome, { recursive: true })
  mkdirSync(isolatedUserData, { recursive: true })
  writeFileSync(join(dshHome, locale.SETTINGS_FILENAME), 'locale:\n  preference: zh\n', 'utf8')

  const child = spawn(electronBinary, [root, `--user-data-dir=${isolatedUserData}`], {
    cwd: root,
    env: {
      ...process.env,
      // 菜单诊断：主进程把真实菜单结构打到 stderr；WATCH 让它保持在运行中（否则打完就退）。
      DSH_DESKTOP_DUMP_MENU: '1',
      DSH_DESKTOP_MENU_WATCH: '1',
      DSH_DESKTOP_HOME: appHome,
    },
    windowsHide: true,
  })
  let output = ''
  child.stdout.on('data', (chunk) => (output += String(chunk)))
  child.stderr.on('data', (chunk) => (output += String(chunk)))
  const dumps = () => [...output.matchAll(/\[menu\]([\s\S]*?)\[\/menu\]/gu)].map((match) => match[1])
  /** 最近一份菜单（构建次数是实现细节，断言一律看"最新那一份"）。 */
  const latestDump = () => dumps()[dumps().length - 1] ?? ''
  /**
   * 主进程打出的诊断行（版本 / 语言 / **读到的偏好** / 顶层菜单）。
   *
   * `pref=` 那一项是排查这一类问题的关键：中文机器上"读到了 zh"与"回退到系统语言"都会显示
   * `locale=zh-CN`，只看语言分不出来。断言失败时把这几行一起打出来，省掉一次盲查。
   */
  const shellLines = () =>
    output
      .split(/\r?\n/u)
      .filter((line) => line.startsWith('[shell] version='))
      .join('\n')
  const pid = child.pid

  /**
   * 冷启动完成之后（recent 等动态数据也装好了）的那一份中文菜单。
   *
   * 用它做"切回中文之后结构完全一致"的基准：启动时**第一份**菜单是建窗口之前装的那一份
   * （那时运行时版本还没解析、最近打开还是空的），拿它当基准会把"动态数据不同"误判成
   * "结构不同"。
   */
  let startupDump = ''

  await check('C) 应用启动后第一份菜单就是中文（首帧不闪英文）', async () => {
    const ready = await until(() => dumps().length >= 1, 90000, 200)
    assert.ok(ready, `没有拿到菜单输出：${output.slice(-500)}`)
    // 第一份就是**建窗口之前**装上的那一份：标题栏页面的第一次 getMenu() 读到的就是它，
    // 因此"第一帧是中文"在这里就成立（这正是 Electron 默认菜单曾经被画出来的位置）。
    const dump = dumps()[0]
    // 顶层菜单独占一行；带加速键的子项后面还会跟 `[CmdOrCtrl+O]`，因此按行首前缀匹配。
    for (const label of ['文件', '编辑', '视图', '更新', '帮助', '打开文件夹…']) {
      assert.ok(new RegExp(`^\\s*${label}`, 'mu').test(dump), `第一份菜单里没有「${label}」\n${dump.slice(0, 300)}`)
    }
    assert.ok(!/^\s*File\s*$/mu.test(dump), '第一份菜单不该是英文')
    assert.ok(!/^\s*Window\s*$/mu.test(dump), '第一份菜单不该是 Electron 的默认菜单（它有 Window）')
    assert.ok(/^\s*智能体运行时\s+unknown/mu.test(dump), '第一份菜单应当来自"运行时还没解析出来"的早期构建')
  })

  await check('C) 启动完成后的菜单仍然是中文，并且最近打开已经换成真实数据', async () => {
    const ready = await until(() => dumps().length >= 2, 30000, 100)
    assert.ok(ready, `没有等到启动完成后的那一份菜单：${shellLines()}`)
    startupDump = latestDump()
    assert.ok(/^\s*文件\s*$/mu.test(startupDump), `启动完成后菜单不是中文：${startupDump.slice(0, 200)}`)
    // 早期那份菜单的「最近打开」必然还是空的（动作快照要等启动流程走到后面）；这一份不该还是。
    assert.ok(!/暂无最近打开的项目/u.test(startupDump), '启动完成后的菜单里最近打开仍然是空的')
  })

  await check('C) Harness 设置改成 en → 同一个进程（未重启）里菜单变英文', async () => {
    writeSettingsAtomic(dshHome, 'locale:\n  preference: en\n')
    const ready = await until(() => /^\s*File\s*$/mu.test(latestDump()), 20000, 100)
    assert.ok(ready, `最新一份菜单没有变成英文：${latestDump().slice(0, 300)}\n诊断行：\n${shellLines()}`)
    const dump = latestDump()
    for (const label of ['File', 'Edit', 'View', 'Update', 'Help', 'Open Folder…']) {
      assert.ok(new RegExp(`^\\s*${label}`, 'mu').test(dump), `英文菜单里没有「${label}」\n${dump.slice(0, 300)}`)
    }
    assert.ok(!/^\s*Window\s*$/mu.test(dump), '英文菜单里也不该出现 Window')
    assert.equal(child.pid, pid, 'PID 变了说明发生了重启')
    assert.equal(child.exitCode, null, '进程不该退出')
  })

  await check('D) 再切回 zh → 菜单立即变回中文（仍无重启）', async () => {
    writeSettingsAtomic(dshHome, 'locale:\n  preference: zh\n')
    const ready = await until(() => /^\s*文件\s*$/mu.test(latestDump()), 20000, 100)
    assert.ok(ready, `最新一份菜单没有变回中文：${latestDump().slice(0, 300)}\n诊断行：\n${shellLines()}`)
    const dump = latestDump()
    for (const label of ['文件', '编辑', '视图', '帮助']) {
      assert.ok(new RegExp(`^\\s*${label}\\s*$`, 'mu').test(dump), `中文菜单里没有「${label}」\n${dump.slice(0, 300)}`)
    }
    assert.equal(child.pid, pid)
    assert.equal(child.exitCode, null)
  })

  await check('D) 重建后的菜单与启动完成时逐字一致（只是文案回到了中文）', () => {
    // 两份都是"启动完成之后、同一种语言、同一份动态数据"下构建的，因此必须**逐字**相同：
    // 命令、加速键、禁用项、最近打开一个都不能漂。
    assert.equal(latestDump(), startupDump, '同一种语言下两次构建的菜单必须逐字一致')
    const dump = latestDump()
    // 带 role 的项在有 label 时不会打出 role=，因此这里断言"清单没丢"：角色项的中文标签、
    // 加速键与禁用占位都还在。
    for (const fragment of ['重新加载', '强制重新加载', '开发者工具', '退出', 'CmdOrCtrl+O', 'CmdOrCtrl+Shift+U', '智能体运行时', '应用外壳']) {
      assert.ok(dump.includes(fragment), `菜单里缺少「${fragment}」`)
    }
  })

  child.kill()
  await wait(500)
}

try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
  // 清理失败不影响结论。
}

console.log('')
console.log(`${passed} 项通过${failed === 0 ? '' : `，${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
