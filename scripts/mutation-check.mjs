// 变异验证：把这一轮的每个关键修复**改回旧写法**，确认对应断言真的会变红，再还原。
//
//   node scripts/.mutation-check-v149.mjs
//
// 为什么必须做：一条永远为绿的断言等于没有断言。这里的每一行都是"改回去必须红、还原必须绿"，
// 因此它同时证明了"修复真的被覆盖"与"测试真的在测那件事"。
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLIENT = join(ROOT, 'plugins', 'dsh-client-ui-review', 'lib', 'client.js')
const INDEX = join(ROOT, 'plugins', 'dsh-client-ui-review', 'lib', 'index.js')
/** review 的 host 半边（路由、快照、未跟踪枚举都在这里）。 */
const HOST = INDEX
/** gitbar 的客户端 bundle（级联菜单的几何在这里）。 */
const GITBAR_CLIENT = join(ROOT, 'plugins', 'dsh-client-ui-gitbar', 'lib', 'client.js')
/** gitbar 的 host 半边（路由、作用域解析在这里）。 */
const GITBAR_HOST = join(ROOT, 'plugins', 'dsh-client-ui-gitbar', 'lib', 'index.js')
/** 「AI 补充提交信息」的 host 半边（输出预算与 finish 语义在这里）。 */
const COMMIT_MESSAGE = join(ROOT, 'plugins', 'dsh-client-ui-review', 'lib', 'commit-message.js')

const run = (script) => {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts', script)], { encoding: 'utf8', cwd: ROOT })
  return { code: result.status, out: `${result.stdout ?? ''}\n${result.stderr ?? ''}` }
}

/**
 * 写文件，遇到 Windows 上的瞬时占用（杀软 / 索引器握着句柄）时重试。
 *
 * 实测踩到过：写到一半抛 `UNKNOWN: unknown error, open ...client.js`，此时文件**已经是变异
 * 后的内容**、还原还没执行，会留下一个"变异版"的源码（必须手工改回来）。重试能避免这种
 * 假崩溃；真要失败时下面的 restore 也才有机会跑完。
 *
 * @param file - 目标文件。
 * @param text - 完整内容。
 */
const writeWithRetry = (file, text) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      writeFileSync(file, text, 'utf8')
      return
    } catch (cause) {
      if (attempt >= 20) throw cause
      // 同步 sleep：这里的调用方本来就是同步流程，不值得为它改成异步。
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
}

let failures = 0
const report = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `：${detail}`}`)
}

/**
 * 跑一次 TypeScript 构建。
 *
 * 只给"变异点在 `src/`"的那几条用：外壳的测试读的是 `dist/`（`npm run build` 的产物），
 * 因此改了源码不重新编译，测试根本看不到变异。直接调 `tsc` 的入口而不是 `npm.cmd`：
 * 后者在本机的 PATH 上是坏的（`npm.ps1`），而且多一层进程。
 */
const runBuild = () => {
  const result = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
    encoding: 'utf8',
    cwd: ROOT,
  })
  if (result.status !== 0) throw new Error(`构建失败：\n${result.stdout ?? ''}\n${result.stderr ?? ''}`)
}

/**
 * 可选的命令行过滤：只跑标签里含这个子串的变异。
 *
 *   node scripts/mutation-check.mjs 34
 *
 * 全量一轮要跑几十次测试（十几分钟），改完一条断言想只确认那一条时，全量重跑是浪费。
 * 不带参数时行为与以前完全一致（全跑）。
 */
const FILTER = process.argv[2] ?? ''

/**
 * 一次变异：改文件 → 跑测试（期望失败）→ 还原 → 再跑一次（期望通过）。
 * @param options - `{ file, from, to, script, label, prepare }`；`prepare` 在每次跑测试前执行
 *   （`src/` 下的变异要先用它把源码编译进 `dist/`）。
 */
/**
 * 每个被变异过的文件的**原始内容**。
 *
 * 为什么必须记下来并在最后核对一次：`mutate()` 的顺序是"读原文件 → 写变异版 → 跑测试 →
 * 写回原文件"，中间任何一个环节被打断（Ctrl-C、进程被杀、写盘失败），源码就会**留在变异
 * 状态**——而那是一份会真的被编译、被打包、被发布的源码。实测踩到过：一次中断之后
 * `paths.ts` 里留着"只看 major.minor.patch"的变异版，而它看起来跟正常代码一模一样。
 *
 * @type {Map<string, string>}
 */
const originals = new Map()

const mutate = ({ file, from, to, script, label, prepare }) => {
  if (FILTER !== '' && !label.includes(FILTER)) return
  const original = readFileSync(file, 'utf8')
  originals.set(file, original)
  if (!original.includes(from)) {
    report(label, false, `变异点没找到：${from.slice(0, 60)}`)
    return
  }
  /**
   * 变异 → 编译 → 跑测试 → **无论成败都还原** → 编译 → 再跑一次。
   *
   * `prepare`（TS 编译）必须包在 `try` 里：变异版的 `src/` **可能编译不过**（那正是
   * "这个变异改变行为"的一种表现），而 `runBuild()` 在编译失败时抛错。没有这层 `try`，
   * 异常会直接从 `mutate()` 冒出去，**还原那一步就永远不会执行**——源码里于是留下一份
   * 变异版，而它看起来和真代码一模一样。实测踩到过：`paths.ts` 的版本比较被留成了
   * "只看 major.minor.patch"。
   */
  let mutated
  try {
    writeWithRetry(file, original.split(from).join(to))
    prepare?.()
    mutated = run(script)
  } finally {
    writeWithRetry(file, original)
  }
  try {
    prepare?.()
  } catch {
    // 还原后的编译失败必须暴露在下面那次 `run(script)` 的结果里，而不是在这里中断流程。
  }
  const restored = run(script)
  const mutatedFailed = mutated === undefined || mutated.code !== 0
  const restoredOk = restored.code === 0
  report(
    label,
    mutatedFailed && restoredOk,
    `变异后 exit=${mutated === undefined ? 'prepare 抛错' : mutated.code}（应非 0）/ 还原后 exit=${restored.code}（应为 0）`,
  )
  if (restoredOk && !mutatedFailed) {
    const tail = (mutated?.out ?? '').split('\n').filter((line) => line.includes('FAIL')).slice(0, 2).join(' / ')
    console.log(`       变异后的测试仍然通过，说明断言没覆盖到：${tail}`)
  }
}

console.log('=== 变异验证（改回旧写法必须变红）===')

// ===========================================================================
// 0. 两个侧栏标签的隔离（本轮审查 = review 标签；项目级 Git = git 标签）
//
// 这几条覆盖的正是"两者被接回同一个界面 / 同一份上下文"的两次真实回归：
//   * `test-turn-review-sidebar.mjs` —— 入口 → 打开哪个 kind、上下文是否同源
//   * `test-git-sidebar-contract.mjs` —— 项目级 Git 的 kind / 数据 / 正文
//   * `test-turn-review-scope.mjs`   —— 数据 scope 的隔离（真实仓库）
// ===========================================================================

mutate({
  file: CLIENT,
  label: '0) 「本轮修改」入口改回打开 Git 标签 → 入口断言变红',
  // 这就是最初那次回归的写法：入口借官方侧栏打开 `git` 标签，用户在"本轮修改"里看到的是
  // 整个项目的 Git。现在 kind 必须是 review。
  from: '            sidebar.openTab(REVIEW_KIND, { revealIfOpened: true })',
  to: '            sidebar.openTab(GIT_KIND, { revealIfOpened: true })',
  script: 'test-turn-review-sidebar.mjs',
})

mutate({
  file: CLIENT,
  label: '0b) Git 标签正文换成 TurnReviewPanel → 侧栏契约断言变红',
  from: '        react.createElement(ProjectGitPanel, { t, workspace, sessionId, switching }),',
  to: '        react.createElement(TurnReviewPanel, { t, workspace, sessionId, onClose: () => undefined }),',
  script: 'test-git-sidebar-contract.mjs',
})

mutate({
  file: HOST,
  label: '0c) 本轮差异改用 HEAD 当基线（= 把项目改动当成本轮改动）→ scope 语义断言变红',
  // 这正是"两个 scope 又混在一起"的**数据层**写法：`/changes` 一旦拿 HEAD 当基线，
  // 用户在本轮之前自己改的文件就会出现在"本轮修改"里。真实仓库测试必须因此变红。
  from: "          git(['diff', '--numstat', stored.revision, current], cwd),\n          git(['diff', '--name-status', stored.revision, current], cwd),",
  to: "          git(['diff', '--numstat', 'HEAD', current], cwd),\n          git(['diff', '--name-status', 'HEAD', current], cwd),",
  script: 'test-turn-review-scope.mjs',
})

mutate({
  file: CLIENT,
  label: '0d) 审查面板改读空上下文（= 又变成"没有可用的工作区"）→ 上下文断言变红',
  // 这条正是本轮故障的形状：面板拿到的 workspace 一旦不是当前会话的 cwd，
  // `useChanges` 就进入 noWorkspace，而入口明明已经算出了 4 个文件。
  from: '      return react.createElement(ReviewSidebarTabBody, { t, workspace, sessionId })',
  to: '      return react.createElement(ReviewSidebarTabBody, { t, workspace: undefined, sessionId })',
  script: 'test-turn-review-sidebar.mjs',
})

mutate({
  file: CLIENT,
  label: '0d2) 侧栏正文退回"只有 t"的注入面（= 拿不到会话）→ 上下文断言变红',
  // `shell.overlay` 时代的注册只注入 `t`；这里把注入面换成空的 props，等价于那个槽位
  // 根本没有 `useSessions`，于是上下文解析不出来（正文不再由审查标签的会话渲染）。
  from: '      const { sessionId, workspace } = useTurnContext(props)',
  to: '      const { sessionId, workspace } = useTurnContext({})',
  script: 'test-turn-review-sidebar.mjs',
})

// ===========================================================================
// 0.5 项目 Git 两个视图的重构（Changes 统一视图 / Log 去掉左栏）
// ===========================================================================

mutate({
  file: CLIENT,
  label: '0e) 把左侧分支栏加回来（选择器那一格标成 tree 分栏）→ "没有左侧分支栏"断言变红',
  from: "        { ref: rootRef, 'data-graph-ref-select': '', style: { position: 'relative', flexShrink: 0, maxWidth: '220px' } },",
  to: "        { ref: rootRef, 'data-graph-ref-select': '', 'data-graph-pane': 'tree', style: { position: 'relative', flexShrink: 0, maxWidth: '220px' } },",
  script: 'test-review-graph-branch-filter.mjs',
})

mutate({
  file: CLIENT,
  label: '0f) 分支选择器不再占首行第一格 → "首行第一格就是分支选择器"断言变红',
  from: '              // 分支 / ref 选择器：占掉的是首行的一格，而不是左边一整列。\n              react.createElement(GraphRefSelector, {',
  to: "              react.createElement('span', null, 'x'),\n              // 分支 / ref 选择器：占掉的是首行的一格，而不是左边一整列。\n              react.createElement(GraphRefSelector, {",
  script: 'test-review-graph-branch-filter.mjs',
})

mutate({
  file: CLIENT,
  label: '0g) 未跟踪汇总栏又变回软底色盒子 → "没有底色"断言变红',
  from: "                          { key: 'bar', 'data-review-untracked-bar': '' },",
  to: "                          { key: 'bar', 'data-review-untracked-bar': '', style: { background: 'var(--dsh-review-soft)' } },",
  script: 'test-project-git-panel-style.mjs',
})

mutate({
  file: CLIENT,
  label: '0h) 自动保存提示从分组标题里拿掉 → "提示仍然存在"断言变红',
  from: '                note: autoSaveNotice,',
  to: '                note: null,',
  script: 'test-project-git-panel-style.mjs',
})

mutate({
  file: CLIENT,
  label: '3) 把 commit.short 加回提交行 → "不显示哈希"断言变红',
  from: '            // **不显示哈希**：这一列对"看提交图"这件事没有信息量（用户是在认标题、作者、',
  to: "            react.createElement('span', { style: { flexShrink: 0 } }, commit.short),\n            // **不显示哈希**：这一列对\"看提交图\"这件事没有信息量（用户是在认标题、作者、",
  script: 'test-review-graph-view.mjs',
})

mutate({
  file: CLIENT,
  label: '4) 顶部计数换回 graphFiles → 计数断言变红',
  from: "                ? t('graphCommitsMore', { count: visibleCommits.length })\n                : t('graphCommits', { count: visibleCommits.length }),",
  to: "                ? t('graphFiles', { count: visibleCommits.length })\n                : t('graphFiles', { count: visibleCommits.length }),",
  script: 'test-review-graph-view.mjs',
})

mutate({
  file: CLIENT,
  label: '5) 左栏分类退回"名字里有斜杠就算远程"→ 带 `/` 的本地分支断言变红',
  from: '        const isRemote = raw.isRemote === true',
  to: "        const isRemote = raw.isRemote === true || name.includes('/')",
  script: 'test-review-graph-branch-filter.mjs',
})

mutate({
  file: CLIENT,
  label: '5b) 不再挡掉符号引用 origin/HEAD → "没有把 HEAD 当分支"断言变红',
  from: "        if (name.endsWith('/HEAD')) continue",
  to: '        if (false) continue',
  script: 'test-review-graph-branch-filter.mjs',
})

mutate({
  file: CLIENT,
  label: '5c) 让 refs 清单跟着过滤条件重拉 → "过滤没有重发清单请求"断言变红',
  from: '        void loadRefs()\n      }, [loadRefs, refreshToken])',
  to: '        void loadRefs()\n      }, [loadRefs, refreshToken, fresh.ref])',
  script: 'test-review-graph-branch-filter.mjs',
})

mutate({
  file: CLIENT,
  label: '5d) 清单效应去掉依赖数组（每次渲染都重发）→ "一轮挂载只拉一次"断言变红',
  from: '        void loadRefs()\n      }, [loadRefs, refreshToken])',
  to: '        void loadRefs()\n      })',
  script: 'test-review-graph-branch-filter.mjs',
})

mutate({
  file: CLIENT,
  label: '6) 时间退回"只到分钟"→ 秒级断言变红',
  from: '              formatCommitTime(commit.committedAt),',
  to: '              textSlice(commit.committedAt, 16),',
  script: 'test-review-graph-view.mjs',
})

mutate({
  file: CLIENT,
  label: '7) 字号的 CSS 退回裸 px → token 断言变红',
  from: '        font-family: ${UI_FONT}; font-size: ${uiPx(11.5)};\n      }',
  to: '        font-family: ${UI_FONT}; font-size: 11.5px;\n      }',
  script: 'test-review-overlay-hooks.mjs',
})

mutate({
  file: CLIENT,
  label: '8) 提交框退回 4 行 → rows 断言变红',
  from: '            rows: COMMIT_ROWS,',
  to: '            rows: 4,',
  script: 'test-review-staging.mjs',
})

mutate({
  file: CLIENT,
  label: '9) AI 结果无条件覆盖输入框 → "不覆盖"断言变红',
  from: "          // 输入框是空的 → 直接填入（这正是\"一键补充\"要的）。\n          if (message.trim() === '') {\n            setMessage(text)\n            setAiNotice(truncated ? t('aiCommitTruncated') : t('aiCommitFilled'))\n            return\n          }",
  to: "          if (true) {\n            setMessage(text)\n            setAiNotice(truncated ? t('aiCommitTruncated') : t('aiCommitFilled'))\n            return\n          }",
  script: 'test-review-staging.mjs',
})

mutate({
  file: CLIENT,
  label: '10) 未跟踪差异退回 FileDiff + byFile → 未跟踪断言变红（应直接抛 ReferenceError）',
  from: "          : react.createElement(LazyFileDiff, {\n              // key 带 workspace + HEAD + 路径：切项目 / 提交之后换实例，旧差异不会被复用。",
  to: "          : react.createElement(FileDiff, {\n              diff: byFile.get(previewEntry.path) ?? '',\n              // key 带 workspace + HEAD + 路径：切项目 / 提交之后换实例，旧差异不会被复用。",
  script: 'test-review-staging.mjs',
})

mutate({
  file: CLIENT,
  label: '6b) 中栏时间退回"只到分钟"→ 中栏秒级断言变红',
  from: '              formatCommitTime(commit.committedAt),\n            ),',
  to: '              textSlice(commit.committedAt, 16),\n            ),',
  script: 'test-review-graph-view.mjs',
})

mutate({
  file: CLIENT,
  label: '11) 把差异重新塞回右栏（内联展开）→ "右栏没有差异行"断言变红',
  from: "        { 'data-graph-files': '', style: { display: 'flex', flexDirection: 'column' } },",
  to: "        { 'data-graph-files': '', style: { display: 'flex', flexDirection: 'column' } },\n        react.createElement('div', { 'data-review-diff-row': '' }, 'inline!'),",
  script: 'test-review-graph-view.mjs',
})

mutate({
  file: CLIENT,
  label: '11b) 把 pre-wrap 偷偷改回 pre（自动换行失效）→ 自动换行断言变红',
  from: "            ? { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word', tabSize: reviewMetrics.tabSize }",
  to: "            ? { whiteSpace: 'pre', overflowWrap: 'normal', wordBreak: 'normal', tabSize: reviewMetrics.tabSize }",
  script: 'test-review-graph-view.mjs',
})

mutate({
  file: CLIENT,
  label: '11f) 查看器忽略共享的换行偏好（写死开启）→ 换行开关断言变红',
  from: "      const wrap = typeof props?.wrap === 'boolean' ? props.wrap : storeWrap",
  to: "      const wrap = typeof props?.wrap === 'boolean' ? props.wrap : true",
  script: 'test-review-graph-view.mjs',
})

mutate({
  file: CLIENT,
  label: '11g) 换行偏好不落盘（localStorage 不写）→ 持久化断言变红',
  from: "            window.localStorage.setItem(DIFF_WRAP_KEY, wrap ? '1' : '0')",
  to: "            void DIFF_WRAP_KEY",
  script: 'test-review-graph-view.mjs',
})

mutate({
  file: CLIENT,
  label: '12) 把差异 inline 插回 Changes 的文件行 → "左栏没有差异行"断言变红',
  from: "          react.createElement('input', {\n            type: 'checkbox',\n            'data-staging-file-pick': entry.path,",
  to: "          react.createElement('div', { 'data-review-diff-row': '' }, 'inline!'),\n          react.createElement('input', {\n            type: 'checkbox',\n            'data-staging-file-pick': entry.path,",
  script: 'test-review-staging.mjs',
})

mutate({
  file: CLIENT,
  label: '12b) 关闭 Changes 的差异预览时不清选中 → "关闭同时取消选中"断言变红',
  from: "              onClose: () => setSelectedFile(''),",
  to: '              onClose: () => undefined,',
  script: 'test-review-staging.mjs',
})

mutate({
  file: CLIENT,
  label: '12c) 点文件名顺手改勾选状态 → "勾选状态没被改动"断言变红',
  from: '              onClick: () => selectFile(entry.path),',
  to: '              onClick: () => {\n                selectFile(entry.path)\n                setDeselectedFiles((current) => [...current, entry.path])\n              },',
  script: 'test-review-overlay-hooks.mjs',
})

mutate({
  file: CLIENT,
  label: '11c) Diff Preview 高度不持久化 → 持久化断言变红',
  from: '                onMouseDown: startGraphDiffResize(measureDiff, setDiffHeight, () => graphDiffStore.set(diffHeightRef.current)),',
  to: '                onMouseDown: startGraphDiffResize(measureDiff, setDiffHeight, () => undefined),',
  script: 'test-review-graph-view.mjs',
})

mutate({
  file: CLIENT,
  label: '11d) 切提交时不清空选中文件 → "切提交没有残留 Preview"断言变红',
  from: '        (selectedDiffFile.compare !== undefined || selectedDiffFile.revision === selectedCommit)',
  to: '        (selectedDiffFile.compare !== undefined || true)',
  script: 'test-review-graph-view.mjs',
})

mutate({
  file: CLIENT,
  label: '11e) 文件头不再折叠（回到逐行 meta）→ 折叠断言变红',
  from: '        const isHeader = /^(diff --git|index |--- |\\+\\+\\+ |new file mode|deleted file mode|old mode|new mode|similarity index|rename from|rename to|copy from|copy to)/u.test(raw)\n        if (isHeader) {',
  to: '        const isHeader = false\n        if (isHeader) {',
  script: 'test-review-graph-view.mjs',
})

// ===========================================================================
// 1.6.0：作用域（workspaceRoot / repositoryRoot）、未跟踪双模式、浏览弹窗
// ===========================================================================

mutate({
  file: CLIENT,
  label: '13) 未跟踪大量时仍逐行列出（回到"列前 50 个"）→ "主面板 0 行"断言变红',
  from: "      const untrackedMode = untrackedInfo.exact === false && untrackedInfo.mode === 'pending' ? 'pending' : untrackedInfo.mode",
  to: "      const untrackedMode = 'inline'",
  script: 'test-review-staging.mjs',
})

mutate({
  file: CLIENT,
  label: '13b) 把未跟踪摘要当裸数字（旧形状）→ 双模式断言变红',
  // 旧实现里 `snapshot.untracked` 是一个数字；改回去之后 `untrackedInfo.mode` 等字段全是
  // undefined，于是 browse 摘要 / 浏览入口 / 精确枚举都不会出现。
  from: '          untracked,\n          empty: payload?.empty === true,',
  to: '          untracked: untracked.count,\n          empty: payload?.empty === true,',
  script: 'test-review-staging.mjs',
})

mutate({
  file: CLIENT,
  label: '13c) 精确枚举的结果用错字段（读 payload.untracked）→ "合并后变成 browse"变红',
  from: '            const untracked = untrackedFromExact(payload)',
  to: '            const untracked = untrackedSummary(payload?.untracked, tracked)',
  script: 'test-review-staging.mjs',
})

mutate({
  file: CLIENT,
  label: '14) 快照 store 退回按工作区建格 → "同仓库只有一格"断言变红',
  from: '          const key = repositoryRoot\n          const target = records.get(key)',
  to: '          const key = provisionalKey(workspace)\n          const target = records.get(key)',
  script: 'test-review-staging.mjs',
})

mutate({
  file: CLIENT,
  label: '14b) 合并同仓库的两格时留下僵尸记录 → "记录数只有 1"断言变红',
  from: '          records.delete(record.key)\n          stopPolling(record)\n          for (const listener of record.listeners) target.listeners.add(listener)',
  to: '          stopPolling(record)\n          for (const listener of record.listeners) target.listeners.add(listener)',
  script: 'test-review-staging.mjs',
})

mutate({
  file: HOST,
  label: '15) 未跟踪枚举退回 -uall（常驻轮询搬全量）→ "folded/pending"断言变红',
  from: "          git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], cwd, undefined, GIT_MAX_BUFFER_LARGE),",
  to: "          git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], cwd, undefined, GIT_MAX_BUFFER_LARGE),",
  // 必须用**带大量未跟踪文件**的那个夹具：小仓库里 -uall 与 -unormal 的输出相同，
  // 断言根本区分不出来（这条本身也是"测试要选对夹具"的一个例子）。
  script: 'test-review-repo-scope.mjs',
})

mutate({
  file: HOST,
  label: '15b) 快照把未跟踪塞回 files（几千条路径）→ 有界性断言变红',
  from: '        const untracked = describeUntrackedFast(cwd, untrackedEntries)',
  to: '        const untracked = describeUntrackedFast(cwd, untrackedEntries)\n        files.push(...untrackedEntries.map((entry) => ({ ...entry, added: null, removed: null })))',
  script: 'test-review-repo-scope.mjs',
})

mutate({
  file: HOST,
  label: '16) 大批量 add 退回单个命令行参数 → 6818 路径的请求变红',
  from: "      await git(['add', `--pathspec-from-file=${file}`, '--pathspec-file-nul'], cwd)\n      return { mode: 'pathspec-file', batches: 1 }",
  to: "      await git(['add', '--', ...normalized], cwd)\n      return { mode: 'pathspec-file', batches: 1 }",
  script: 'test-review-repo-scope.mjs',
})

mutate({
  file: HOST,
  label: '17) 所有 Git 命令退回工作区（不用 repositoryRoot）→ 子目录漏文件/路径不一致变红',
  from: '      const cwd = context.repositoryRoot',
  to: '      const cwd = workspace',
  script: 'test-review-repo-scope.mjs',
})

mutate({
  file: HOST,
  label: '18) /untracked 的惰性树退回"前缀不存在也返回根层"→ 404 断言变红',
  from: '        if (page === undefined) {\n          sendJson(response, 404, { error: \'no such directory\', code: \'noSuchPrefix\' })\n          return\n        }',
  to: '        if (page === undefined) {\n          sendJson(response, 200, { isRepo: true, total, mode, exact: true, inlineFiles: [], tree: { prefix, directories: [], files: [], total: 0, truncated: false, offset, limit } })\n          return\n        }',
  script: 'test-review-repo-scope.mjs',
})

mutate({
  file: GITBAR_CLIENT,
  label: '19) 二级菜单不再优先右侧展开 → 级联几何断言变红',
  from: '      if (rightRoom >= width + margin) {\n        left = panel.right + gap\n        side = \'right\'',
  to: '      if (false) {\n        left = panel.right + gap\n        side = \'right\'',
  script: 'test-gitbar-branch-interaction.mjs',
})

// ===========================================================================
// 1.5.3：AI 补充提交信息的 finish 语义（max-tokens 不再等于失败）
// ===========================================================================

mutate({
  file: COMMIT_MESSAGE,
  label: '20) 把 finish !== stop 重新当成硬失败 → max-tokens 有文本的断言变红',
  // 这就是实机那条报错的写法：先判 finish、再读 blocks，于是 max-tokens 会把已经生成好的
  // 提交信息整段丢掉。
  from: "  const blocks = typeof assembler?.blocks === 'function' ? assembler.blocks() : []",
  to: "  const earlyFinish = assembler?.finish\n  if (earlyFinish?.kind !== 'stop') {\n    const described = describeLlmFailure(earlyFinish.failure ?? { code: 'aiFailed', message: `finish=${String(earlyFinish?.kind)}` })\n    throw aiError(described.code, described.detail)\n  }\n  const blocks = typeof assembler?.blocks === 'function' ? assembler.blocks() : []",
  script: 'test-review-commit-message.mjs',
})

mutate({
  file: COMMIT_MESSAGE,
  label: '20b) 输出预算退回 400 → 预算断言变红',
  from: '  maxOutputTokens: 1024,',
  to: '  maxOutputTokens: 400,',
  script: 'test-review-commit-message.mjs',
})

mutate({
  file: COMMIT_MESSAGE,
  label: '20c) 系统指令去掉输出长度约束 → 约束断言变红',
  from: "    'Output constraints:',",
  to: "    'Ignored constraints:',",
  script: 'test-review-commit-message.mjs',
})

mutate({
  file: COMMIT_MESSAGE,
  label: '20d) 让 failure 也走"有文本即成功" → 认证失败被伪装成成功的断言变红',
  from: '  if (failure !== null && failure !== undefined) {',
  to: '  if (false) {',
  script: 'test-review-commit-message.mjs',
})

// ===========================================================================
// 1.5.4：项目级多仓库发现（工作区自己不是仓库时不许再说"不是 git 仓库"）
// ===========================================================================

mutate({
  file: HOST,
  label: '21) 宿主退回"只有唯一子仓库才认"→ 实机那句"不是 git 仓库"变红',
  // 这就是实机形状：父目录不是仓库、子目录里有两个仓库。旧写法（只在恰好一个时才认）
  // 会让 `isRepo` 变回 false——界面于是说"当前工作区（haiweiNew）不是 git 仓库"。
  from: "  if (repositories.length >= 1) return { context: pick(repositories[0]), scope, error: '' }",
  to: "  if (repositories.length === 1) return { context: pick(repositories[0]), scope, error: '' }",
  script: 'test-review-repo-scope.mjs',
})

mutate({
  file: HOST,
  label: '21b) 宿主忽略 repository（多仓库时永远操作默认那个）→ 分支/暂存落错仓库变红',
  from: "  const explicit = typeof repository === 'string' && repository !== ''",
  to: "  const explicit = false && typeof repository === 'string' && repository !== ''",
  script: 'test-review-repo-scope.mjs',
})

mutate({
  file: HOST,
  label: '21c) 宿主不校验 repository（越界路径也照跑）→ 400 断言变红',
  from: "    if (match === undefined) return { context: undefined, scope, error: 'repositoryNotAllowed' }",
  to: "    if (match === undefined) return { context: { workspaceRoot: workspace, repositoryRoot: repository, gitDir: '' }, scope, error: '' }",
  script: 'test-review-repo-scope.mjs',
})

mutate({
  file: CLIENT,
  label: '22) 客户端"没选过"时不再取第一个仓库（留空）→ 默认项断言变红',
  from: "        const own = list.find((entry) => entry.relativePath === '')\n        if (own !== undefined) return own.repositoryRoot\n        return list[0].repositoryRoot",
  to: "        const own = list.find((entry) => entry.relativePath === '')\n        if (own !== undefined) return own.repositoryRoot\n        return ''",
  script: 'test-review-staging.mjs',
})

mutate({
  file: CLIENT,
  label: '22b) 客户端单仓库也带 repository → "1.5.2 请求形状"断言变红',
  from: '      if (scope === undefined || scope.repositories.length <= 1) return body',
  to: '      if (scope === undefined) return body',
  script: 'test-review-staging.mjs',
})

mutate({
  file: CLIENT,
  label: '22c) 迁移到仓库根那一格时留下旧键 → "记录数只有 1"变红',
  from: '            records.delete(record.key)\n            record.key = key\n            record.repositoryRoot = repositoryRoot',
  to: '            record.key = key\n            record.repositoryRoot = repositoryRoot',
  script: 'test-review-staging.mjs',
})

mutate({
  file: GITBAR_HOST,
  label: '23) gitbar 宿主不回项目级仓库列表 → 多仓库断言变红',
  from: '            repositories: scope.repositories,\n            discovery: scope.discovery,\n          },\n        }\n  if (context === undefined) return { workspaceRoot: workspace, ...projectScope }',
  to: '            repositories: [],\n            discovery: scope.discovery,\n          },\n        }\n  if (context === undefined) return { workspaceRoot: workspace, ...projectScope }',
  script: 'test-gitbar-branches.mjs',
})

mutate({
  file: GITBAR_CLIENT,
  label: '24) gitbar 徽章不再读项目级仓库列表 → "多仓库选择器/计数"断言变红',
  from: '      const scopeRepositories = Array.isArray(status.projectScope?.repositories) ? status.projectScope.repositories : null',
  to: '      const scopeRepositories = null',
  script: 'test-gitbar-branch-interaction.mjs',
})

mutate({
  file: GITBAR_CLIENT,
  label: '24b) gitbar 请求不再带 repository（多仓库时永远操作默认那个）→ 选择器断言变红',
  from: '      const repositoryRoot = activeRepositoryOf(cwd)\n      if (repositoryRoot !== \'\') params.set(\'repository\', repositoryRoot)',
  to: '      const repositoryRoot = activeRepositoryOf(cwd)\n      if (false) params.set(\'repository\', repositoryRoot)',
  script: 'test-gitbar-branch-interaction.mjs',
})

// ===========================================================================
// 1.5.6：Changes 底部提交区（默认 8 行 / 顶部可拖 / 持久化）
// ===========================================================================

mutate({
  file: CLIENT,
  label: '25) 拖动方向反了（往下拖变高）→ "往上拖 +80px"变红',
  from: '          onChange(clampCommitAreaHeight(startHeight + (startY - moveEvent.clientY), start?.available))',
  to: '          onChange(clampCommitAreaHeight(startHeight + (moveEvent.clientY - startY), start?.available))',
  script: 'test-review-staging.mjs',
})

mutate({
  file: CLIENT,
  label: '26) 把"拖出来的负数"当成没拖过 → 拖到底反而跳回默认高度',
  // 这正是实现时真的写错过一次的地方：`value > 0` 的判据让"往下拖 1000px"变成"用默认值"。
  from: '      const raw = Number.isFinite(value) ? value : commitDefaultHeight()',
  to: '      const raw = Number.isFinite(value) && value > 0 ? value : commitDefaultHeight()',
  script: 'test-review-staging.mjs',
})

mutate({
  file: CLIENT,
  label: '27) 最小高度放宽到 1 行 → "停在最小高度"变红',
  from: '    const COMMIT_MIN_ROWS = 4',
  to: '    const COMMIT_MIN_ROWS = 1',
  script: 'test-review-staging.mjs',
})

mutate({
  file: CLIENT,
  label: '28) 上限不再给主区留位置 → "给主区留下至少 200px"变红',
  from: '      const max = Math.max(min, Math.min(viewport * 0.55, room * 0.65, room - COMMIT_MAIN_MIN_PX))',
  to: '      const max = Math.max(min, Math.min(viewport * 0.55, room * 0.65))',
  script: 'test-review-staging.mjs',
})

mutate({
  file: CLIENT,
  label: '29) 重开抽屉不再读回用户高度 → "重新打开后仍是用户的高度"变红',
  from: '      const [commitHeight, setCommitHeight] = react.useState(() => commitAreaHeightStore.get())',
  to: '      const [commitHeight, setCommitHeight] = react.useState(() => undefined)',
  script: 'test-review-staging.mjs',
})

mutate({
  file: CLIENT,
  label: '30) 双击手柄不复位持久化 → "清掉持久化记录"变红',
  from: '            onDoubleClick: () => {\n              commitAreaHeightStore.reset()\n              setCommitHeight(undefined)\n            },',
  to: '            onDoubleClick: () => {\n              setCommitHeight(undefined)\n            },',
  script: 'test-review-staging.mjs',
})

mutate({
  file: CLIENT,
  label: '31) 输入框重新开原生 resize 且不再填满提交区 → "没有原生 resize"变红',
  from: "              flex: '1 1 auto',\n              minHeight: 0,\n              padding: '7px 9px',",
  to: "              minHeight: '90px',\n              padding: '7px 9px',",
  script: 'test-review-staging.mjs',
})

mutate({
  file: CLIENT,
  label: '32) 去掉底部留白 → "底部留白 12px"变红',
  from: "              paddingBottom: '12px',",
  to: "              paddingBottom: '2px',",
  script: 'test-review-staging.mjs',
})

// ===========================================================================
// 1.6.5：项目级 Git 界面（重复入口 / 权威 refs / 大屏虚拟化 / 自动补页 / 抽屉宽度 / 标题栏）
// ===========================================================================

mutate({
  file: CLIENT,
  label: '33) 挂载后不再量真实视口 → "大屏首屏按真实高度渲染"断言变红',
  from: '        measureViewport()\n        const node = scrollRef.current',
  to: '        const node = scrollRef.current',
  script: 'test-review-graph-view.mjs',
})

mutate({
  file: CLIENT,
  label: '34) ResizeObserver 不再观察滚动容器 → "视口变大后自动补数据"断言变红',
  from: '        observer.observe(node)',
  to: '        void node',
  script: 'test-review-graph-view.mjs',
})

mutate({
  file: CLIENT,
  label: '35) 自动补页不再发请求（退回"只能靠用户滚动"）→ 22a 断言变红',
  from: '        if (remaining > GRAPH_LOAD_MORE_THRESHOLD) return\n        void loadMore()\n      }, [fresh.hasMore, fresh.loadingMore, fresh.refreshing, fresh.autoFillStopped, loadMore])',
  to: '        if (remaining > GRAPH_LOAD_MORE_THRESHOLD) return\n        void 0\n      }, [fresh.hasMore, fresh.loadingMore, fresh.refreshing, fresh.autoFillStopped, loadMore])',
  script: 'test-review-graph-view.mjs',
})

mutate({
  file: CLIENT,
  label: '36) 去掉"没有进展就停闸"的判断 → 空页被无限请求的断言变红',
  from: '        if (fresh.autoFillStopped === true) return',
  to: '        if (false) return',
  script: 'test-review-graph-view.mjs',
})

mutate({
  file: CLIENT,
  label: '37) 空页不再立停闸标记 → 22b 断言变红',
  from: '              autoFillStopped: stalled ? true : false,',
  to: '              autoFillStopped: false,',
  script: 'test-review-graph-view.mjs',
})

mutate({
  file: CLIENT,
  label: '38) 再注册一个标签类型（= 让本轮审查也能被 openTab 打开）→ 单类型断言变红',
  // 项目级 Git 是**唯一**注册标签类型的 surface。多注册一个，就说明有人又想给本轮审查
  // 开一条"能被官方侧栏打开"的路——那正是这次回归的形状。
  from: '        return registry.register({',
  to: "        registry.register({ id: 'dsh-client-ui-review/turn-review', kind: 'turn-review' })\n        return registry.register({",
  script: 'test-git-sidebar-contract.mjs',
})

mutate({
  file: join(ROOT, 'src', 'main', 'shell-page.ts'),
  label: '39) 把「后退」按钮加回标题栏 → DOM 断言变红（需要重新编译）',
  from: '  <span class="tb-group">\n    <span class="tb-icon" aria-hidden="true">',
  to: '  <span class="tb-group">\n    <button class="tb-btn" id="nav-back" aria-label="back">\u2039</button>\n    <span class="tb-icon" aria-hidden="true">',
  prepare: runBuild,
  script: 'test-titlebar.mjs',
})

mutate({
  file: HOST,
  label: '40) 提交图退回 --decorate=short → 带斜杠分支的命名空间断言变红',
  // 短名装饰分不清 `refs/heads/feature/foo` 与 `refs/remotes/origin/foo`（两者都印成
  // `feature/foo`），因此"按 namespace 分类"必须有 `--decorate=full`（需求 12/13）。
  from: "    '--decorate=full',",
  to: "    '--decorate=short',",
  script: 'test-review-graph.mjs',
})

mutate({
  file: CLIENT,
  label: '41) 审查标签的 kind 改成 git（两个标签同名）→ 隔离断言变红',
  // `kind` 同名正是最初那次回归：`openTab` 分不出两者，「本轮修改」打开的是项目 Git。
  // 另外也顺带钉住"两个标签的 id 必须不同"。
  from: "    const REVIEW_KIND = 'review'",
  to: "    const REVIEW_KIND = 'git'",
  script: 'test-turn-review-sidebar.mjs',
})

// ===========================================================================
// 42-44. Runtime 版本比较（1.7.5 的线上故障：installer 拒绝 rc.2）
//
// 这三条覆盖的是"三套比较器各自为政"这一整类回归。它们都指向 `src/`，因此每次变异后都要
// 重新编译（`prepare: runBuild`）。
// ===========================================================================

const RUNTIME_VERSION = join(ROOT, 'src', 'main', 'runtime-version.ts')
const RUNTIME_UPDATER = join(ROOT, 'src', 'main', 'runtime-updater.ts')
const PATHS = join(ROOT, 'src', 'main', 'paths.ts')

mutate({
  file: RUNTIME_VERSION,
  label: '42) 版本比较退回"只看 major.minor.patch" → rc.1 → rc.2 的断言变红',
  // 这就是原 compareCore() 的语义：核心三段相同就返回 0，于是 rc.1 与 rc.2 相等、
  // installer 抛出"不低于目标版本，无需安装"（线上那条错误信息）。
  from: '  return comparePrerelease(a.prerelease, b.prerelease)',
  to: '  void comparePrerelease\n  return 0',
  prepare: runBuild,
  script: 'test-runtime-updater.cjs',
})

mutate({
  file: RUNTIME_VERSION,
  label: '43) 预发布 identifier 退回字符串比较 → rc.10 > rc.2 的断言变红',
  // 字符串序会得出 `"10" < "2"`，也就是 `rc.10 < rc.2`——一个"每发布一个新的 rc 就出错"的坑。
  from: '      const difference = Number(a) - Number(b)\n      if (difference !== 0) return difference',
  to: '      if (a !== b) return a < b ? -1 : 1\n      const difference = 0\n      if (difference !== 0) return difference',
  prepare: runBuild,
  script: 'test-runtime-version.mjs',
})

mutate({
  file: PATHS,
  label: '44) 启动选择退回"只看核心三段" → 下载版选择断言变红',
  // 同类的第二处：`paths.ts` 曾经自己有一份 compareVersions()，把 0.2.0-rc.1、0.2.0-rc.2 与
  // 0.2.0 全看成同一个版本。这里把它换回"只比核心三段"的写法。
  from: 'compareRuntimeVersions(downloaded.version, bundledVersion) >= 0',
  to: "downloaded.version.split('-')[0] >= bundledVersion.split('-')[0]",
  prepare: runBuild,
  script: 'test-runtime-paths.cjs',
})

mutate({
  file: RUNTIME_UPDATER,
  label: '45) 把"内置不低于目标"改回抛错 → already-current 断言变红',
  // 旧写法把"目标 == 当前"也当成失败抛出（用户看到红色的「Runtime 更新失败」，正文却是
  // "无需安装"）。这里在 `already-current` 分支**之前**插一句同样的抛错。
  //
  // ⚠️ `from` 必须**唯一**：`mutate()` 用的是 `split(from).join(to)`，字面量出现两次就会
  // 被替换两次（实测：只写 `status: 'already-current',` 会把下面 `installed` 分支的同一行
  // 也改掉，插入两条抛错）。因此这里带上紧跟其后的 `version,`／`dir:` 两行一起做锚点。
  from: "        status: 'already-current',\n        version,\n        dir: installed?.dir ?? this.options.userDataDir,",
  to: "        status: 'installed',\n        version,\n        dir: installed?.dir ?? this.options.userDataDir,",
  prepare: runBuild,
  script: 'test-runtime-updater.cjs',
})

mutate({
  file: join(ROOT, 'src', 'main', 'update-window.ts'),
  label: '46) 更新窗口尺寸退回 520x460 → 真实布局断言变红',
  // 520x460 实测 main 内容 381 > 358，右侧必然出现滚动条（就是被反馈的那张截图）。
  from: '    width: 560, height: 560,',
  to: '    width: 520, height: 460,',
  prepare: runBuild,
  script: 'test-update-window-layout.mjs',
})

// 收尾核对：所有被变异过的文件都必须与开始时**逐字节相同**。不同就说明源码被留在了变异
// 状态（见 `originals` 的说明），此时必须失败——它比任何一条变异断言都重要。
for (const [file, before] of originals) {
  const after = readFileSync(file, 'utf8')
  if (after !== before) {
    failures += 1
    console.error(`源码被留在了变异状态：${file}（请手工还原后再提交）`)
  }
}

console.log('')
console.log(failures === 0 ? '变异验证全部符合预期' : `${failures} 项变异不符合预期`)
process.exit(failures === 0 ? 0 : 1)
