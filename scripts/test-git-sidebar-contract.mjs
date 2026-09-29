// 项目级 Git 的**入口契约**：它必须完全由 Harness 官方右侧栏承载。
//
//   node scripts/test-git-sidebar-contract.mjs
//
// 与 `scripts/test-turn-review-drawer.mjs` 是**刻意分开**的两个文件：
//   * 这里只回答"项目级 Git 走官方侧栏"——Git 标签类型、keyed 槽位、图标、正文组件；
//   * 那个文件只回答"本轮修改走自己的抽屉，绝不碰官方侧栏"。
//
// 为什么要分成两个文件、而不是一个文件里两节：这两个 surface 曾经共用过一个 `KIND`，
// 结果「本轮修改 5」打开的是整个项目的 Git Changes。把契约写在同一处，恰好方便下一次
// 顺手把两者的常量、开关或组件接回去——分开之后，任何"合流"都要同时改两个文件的意图。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../plugins/dsh-client-ui-review/lib/client.js', import.meta.url), 'utf8')

// ---- 1. 标签类型注册进官方侧栏的类型表 -----------------------------------------
assert.match(source, /const GIT_KIND = 'git'/u)
assert.match(source, /const GIT_SIDEBAR_ID = 'dsh-client-ui-review\/git'/u)
assert.match(source, /sidebarRightTabs[\s\S]*register\(\{[\s\S]*kind: GIT_KIND/u)
assert.match(source, /id: GIT_SIDEBAR_ID/u)
assert.match(source, /IconBranchOutline16/u)

// 正文与标题是 keyed 槽位，key 就是上面注册的标签类型。
assert.match(source, /name: GIT_TAB_SLOT,\s*\n\s*key: GIT_SIDEBAR_ID/u)
assert.match(source, /name: GIT_TAB_TITLE_SLOT,\s*\n\s*key: GIT_SIDEBAR_ID/u)

// ---- 2. 正文就是项目 Git 面板（workspace scope），且只有嵌入形态 ------------------
assert.match(source, /function GitSidebarTab\(props\)/u)
assert.match(source, /react\.createElement\(ProjectGitPanel, \{ t, workspace, sessionId, switching \}\)/u)
// 面板不再接受 `scope` / `embedded`：它的数据 scope 恒为 workspace，容器由侧栏管。
assert.doesNotMatch(source, /function ProjectGitPanel\(props\)\s*\{[^}]*scope/u)
assert.doesNotMatch(source, /react\.createElement\(ProjectGitPanel,[\s\S]{0,120}embedded/u)
// 面板不自造宽度手柄、也不自造「收起」按钮（那两样都属于官方侧栏）。
assert.doesNotMatch(source, /data-review-resizer/u)
assert.doesNotMatch(source, /t\('collapse'\)/u)

// ---- 3. 侧栏跟随 Harness 的**当前**会话 ----------------------------------------
assert.match(source, /const activeId = state\?\.current \?\? sessionId/u)
assert.match(source, /state\?\.byId\?\.\[activeId\]\?\.cwd/u)

// ---- 4. 跨插件的「与当前比较」仍然走官方 Git 标签 + Log 意图 ---------------------
assert.match(source, /panelLogIntent\.request\(\)[\s\S]*sidebar\.openTab\(GIT_KIND, \{\}\)/u)

// ---- 5. 项目级 Git 的正文**不碰**本轮审查抽屉 -----------------------------------
// 这是这次修复的对称面：Git 标签只能读项目数据，绝不能改本轮审查的开关。
assert.doesNotMatch(source, /function ProjectGitPanel\(props\)[\s\S]{0,4000}turnDrawerStore/u)
assert.doesNotMatch(source, /function GitSidebarTab\(props\)[\s\S]{0,2000}turnDrawerStore/u)
// 本轮审查也不注册成侧栏标签类型（整份客户端只有**一次**标签类型注册）。
assert.equal((source.match(/registry\.register\(/gu) ?? []).length, 1)
assert.match(source, /const registry = ctx\.sidebarRightTabs/u)

console.log('PASS Git is registered through the official right Sidebar API and icon system')
console.log('PASS the Git tab body is ProjectGitPanel and never a turn-review surface')
console.log('PASS Sidebar Git derives its workspace from the active Harness session')
console.log('PASS compare navigation opens the official Git Sidebar and preserves refresh')
console.log('PASS the project Git surface never touches the turn-review drawer state')
