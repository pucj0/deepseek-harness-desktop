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
 * 一次变异：改文件 → 跑测试（期望失败）→ 还原 → 再跑一次（期望通过）。
 * @param options - `{ file, from, to, script, label, expectFail }`。
 */
const mutate = ({ file, from, to, script, label }) => {
  const original = readFileSync(file, 'utf8')
  if (!original.includes(from)) {
    report(label, false, `变异点没找到：${from.slice(0, 60)}`)
    return
  }
  writeWithRetry(file, original.split(from).join(to))
  const mutated = run(script)
  writeWithRetry(file, original)
  const restored = run(script)
  const mutatedFailed = mutated.code !== 0
  const restoredOk = restored.code === 0
  report(
    label,
    mutatedFailed && restoredOk,
    `变异后 exit=${mutated.code}（应非 0）/ 还原后 exit=${restored.code}（应为 0）`,
  )
  if (restoredOk && !mutatedFailed) {
    const tail = mutated.out.split('\n').filter((line) => line.includes('FAIL')).slice(0, 2).join(' / ')
    console.log(`       变异后的测试仍然通过，说明断言没覆盖到：${tail}`)
  }
}

console.log('=== 变异验证（改回旧写法必须变红）===')

mutate({
  file: CLIENT,
  label: '1) 默认宽度 50% → 宽度断言变红',
  from: '      return clampPanelWidth(Math.round(viewport * 0.8))',
  to: '      return clampPanelWidth(Math.round(viewport * 0.5))',
  script: 'test-review-overlay-hooks.mjs',
})

mutate({
  file: CLIENT,
  label: '1b) 恢复 1600 像素上限 → 宽屏 80% 断言变红',
  from: '      return Math.max(PANEL_WIDTH_MIN, Math.round(viewport * 0.8))',
  to: '      return Math.max(PANEL_WIDTH_MIN, Math.min(1600, Math.round(viewport * 0.8)))',
  script: 'test-review-overlay-hooks.mjs',
})

mutate({
  file: CLIENT,
  label: '2) 恢复"项目级不点外关"→ 点外关闭断言变红',
  from: '        document.addEventListener(\'mousedown\', onPointerDown, true)\n        document.addEventListener(\'keydown\', onKeyDown)',
  to: '        if (scope !== \'workspace\') document.addEventListener(\'mousedown\', onPointerDown, true)\n        document.addEventListener(\'keydown\', onKeyDown)',
  script: 'test-review-overlay-hooks.mjs',
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
  label: '5) 让未过滤分页重新写 treeCommits → 左栏不被污染断言变红',
  from: '              loadingMore: false,\n              loadMoreError: \'\',\n              // 注意：**这里没有 `treeCommits`**。分页不写左栏（见上面的说明）。',
  to: '              loadingMore: false,\n              loadMoreError: \'\',\n              ...(filterRef === \'\' ? { treeCommits: [...prev.commits, ...more], treeHasMore: outcome.value?.hasMore === true } : {}),',
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
  from: '        font-family: ${UI_FONT}; font-size: ${uiPx(11.5)};\n      }\n\n      /* Log 页签工具条里的搜索框',
  to: '        font-family: ${UI_FONT}; font-size: 11.5px;\n      }\n\n      /* Log 页签工具条里的搜索框',
  script: 'test-review-overlay-hooks.mjs',
})

mutate({
  file: CLIENT,
  label: '8) 提交框退回 2 行 → rows 断言变红',
  from: '            rows: 4,',
  to: '            rows: 2,',
  script: 'test-review-overlay-hooks.mjs',
})

mutate({
  file: CLIENT,
  label: '9) AI 结果无条件覆盖输入框 → "不覆盖"断言变红',
  from: '          if (message.trim() === \'\') {\n            setMessage(text)\n            setAiNotice(t(\'aiCommitFilled\'))\n            return\n          }',
  to: '          {\n            setMessage(text)\n            setAiNotice(t(\'aiCommitFilled\'))\n            return\n          }',
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
  from: "        wrap === true\n          ? { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word', tabSize: reviewMetrics.tabSize }",
  to: "        wrap === true\n          ? { whiteSpace: 'pre', overflowWrap: 'normal', wordBreak: 'normal', tabSize: reviewMetrics.tabSize }",
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
  from: '              onClick: () => setSelectedFile(entry.path),',
  to: '              onClick: () => {\n                setSelectedFile(entry.path)\n                setDeselectedFiles((current) => [...current, entry.path])\n              },',
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
  from: '        selectedDiffFile !== null && selectedDiffFile.revision === selectedCommit ? selectedDiffFile : null',
  to: '        selectedDiffFile',
  script: 'test-review-graph-view.mjs',
})

mutate({
  file: CLIENT,
  label: '11e) 文件头不再折叠（回到逐行 meta）→ 折叠断言变红',
  from: '        const isHeader = /^(diff --git|index |--- |\\+\\+\\+ |new file mode|deleted file mode|old mode|new mode|similarity index|rename from|rename to|copy from|copy to)/u.test(raw)\n        if (isHeader) {',
  to: '        const isHeader = false\n        if (isHeader) {',
  script: 'test-review-graph-view.mjs',
})

console.log('')
console.log(failures === 0 ? '变异验证全部符合预期' : `${failures} 项变异不符合预期`)
process.exit(failures === 0 ? 0 : 1)
