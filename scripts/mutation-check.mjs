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

console.log('')
console.log(failures === 0 ? '变异验证全部符合预期' : `${failures} 项变异不符合预期`)
process.exit(failures === 0 ? 0 : 1)
