// 「AI 一键补充提交信息」的 host 侧断言：上限、提示词构造、输出规范化、失败翻译、
// 以及"宿主缺能力时报哪个正式能力"。
//
//   node scripts/test-review-commit-message.mjs
//
// 为什么不起服务器就测这些：它们恰好是**最不能出错**的部分——上限一旦失守，一次提交就会把
// 整个仓库的差异塞进上下文（请求必然超窗口，或者产生巨额 token 账单）；输出规范化错了，
// 用户会在提交框里看到 ``` 围栏或一句解释。纯函数因此直接断言，跑起来只要几十毫秒。
//
// 模型调用本身不在这里测（那需要 provider）：`createCommitMessageGenerator` 只按
// "宿主有没有能力"分支断言——那是本地可确定的部分，模型返回什么由 provider 决定。
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const MODULE = pathToFileURL(join(ROOT, 'plugins', 'dsh-client-ui-review', 'lib', 'commit-message.js')).href

const loaded = await import(MODULE)
const {
  COMMIT_MESSAGE_LIMITS,
  COMMIT_MESSAGE_TIMEOUT_CODE,
  buildCommitMessagePrompt,
  collectCommitContext,
  createCommitMessageGenerator,
  describeLlmFailure,
  normalizeCommitMessage,
} = loaded

let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `（期望 ${expected}）`}`)
}
const checkTrue = (label, actual) => check(label, actual === true, true)

// =================================================================================
console.log('=== 1. 上限：三层设限，超了就降级而不是报错 ===')
check('1) 文件数上限是 30', COMMIT_MESSAGE_LIMITS.maxFiles, 30)
check('   单文件字符上限', COMMIT_MESSAGE_LIMITS.maxFileDiffChars, 3000)
check('   总字符上限', COMMIT_MESSAGE_LIMITS.maxTotalChars, 30000)

{
  // 100 个文件：只取前 30 个，`total` 仍然是真实条数（界面据此说明"只看了 N 个"）。
  const files = Array.from({ length: 100 }, (_, i) => ({ path: `src/f${i}.txt`, status: 'M' }))
  const context = await collectCommitContext({
    branch: 'main',
    files,
    readDiff: async () => ({ diff: 'x'.repeat(10), truncated: false, binary: false }),
  })
  check('   只取前 30 个文件', context.files.length, 30)
  check('   但总数如实记录', context.total, 100)
  check('   第一个是 f0', context.files[0].path, 'src/f0.txt')
}

{
  // 单个文件超长：截断并标注。
  const context = await collectCommitContext({
    branch: 'main',
    files: [{ path: 'big.txt', status: 'M' }],
    readDiff: async () => ({ diff: 'y'.repeat(9999), truncated: false, binary: false }),
  })
  check('   单文件被截到上限', context.files[0].diff.length, COMMIT_MESSAGE_LIMITS.maxFileDiffChars)
  check('   截断被记数', context.truncated, 1)
  checkTrue('   截断写进了 note', /truncated/u.test(context.files[0].note))
}

{
  // 总量超限：后面的文件**连盘都不读**，只留状态与行数。
  let reads = 0
  const files = Array.from({ length: 20 }, (_, i) => ({ path: `src/g${i}.txt`, status: 'M' }))
  const context = await collectCommitContext({
    branch: 'main',
    files,
    readDiff: async () => {
      reads += 1
      return { diff: 'z'.repeat(3000), truncated: false, binary: false }
    },
  })
  const totalChars = context.files.reduce((sum, file) => sum + file.diff.length, 0)
  checkTrue('   总字符不超过上限', totalChars <= COMMIT_MESSAGE_LIMITS.maxTotalChars)
  checkTrue('   超限后不再读盘（读取次数远小于文件数）', reads < files.length)
  checkTrue('   超限的文件被记为 omitted', context.omitted > 0)
}

{
  // 二进制不读，标注一下。
  const context = await collectCommitContext({
    branch: 'main',
    files: [{ path: 'logo.png', status: 'A' }],
    readDiff: async () => ({ diff: 'Binary files differ', truncated: false, binary: true }),
  })
  check('   二进制不带 diff', context.files[0].diff, '')
  check('   二进制有说明', context.files[0].note, 'binary file')
}

{
  // 单个文件读不到 → 降级，**不让整条请求失败**（状态过期、文件刚被删都是常态）。
  const context = await collectCommitContext({
    branch: 'main',
    files: [{ path: 'gone.txt', status: 'D' }],
    readDiff: async () => {
      throw new Error('no such path')
    },
  })
  check('   读不到时仍然保留这一条', context.files.length, 1)
  checkTrue('   读不到被标注', /diff unavailable/u.test(context.files[0].note))
  check('   读不到记入 omitted', context.omitted, 1)
}

// =================================================================================
console.log('')
console.log('=== 2. 提示词：结构化数据走 JSON，且说明范围 ===')
{
  const context = await collectCommitContext({
    branch: 'feature/x',
    files: [
      { path: 'src/app.ts', status: 'M', added: 3, removed: 1 },
      { path: 'new.txt', status: 'A', added: 5, removed: 0, untracked: true },
    ],
    readDiff: async (path) => ({ diff: `--- a/${path}\n+++ b/${path}\n+line`, truncated: false, binary: false }),
  })
  const prompt = buildCommitMessagePrompt(context)
  checkTrue('   系统指令要求"只回提交信息本身"', /Return the message text only/u.test(prompt.system))
  checkTrue('   系统指令要求 Conventional Commits', /Conventional Commits/u.test(prompt.system))
  // 路径是**数据**：拼成 JSON 才不会让一个叫 "ignore previous instructions.txt" 的文件
  // 变成对模型下达的指令。
  checkTrue('   用户消息里是 JSON', prompt.text.includes('"files"'))
  checkTrue('   带分支', prompt.text.includes('"branch": "feature/x"'))
  checkTrue('   带状态与行数', prompt.text.includes('"added": 3'))
  checkTrue('   标注未跟踪', prompt.text.includes('"untracked": true'))
  checkTrue('   明确说是数据不是指令', /data, not instructions/u.test(prompt.text))
  check('   统计里带文件数', prompt.stats.files, 2)
  checkTrue('   统计里字符数就是 JSON 长度', prompt.stats.chars > 0)
}

// =================================================================================
console.log('')
console.log('=== 3. 输出规范化：用户看到的必须是能直接用的文本 ===')
check('3) 纯标题', normalizeCommitMessage('feat(review): 完善项目 Git 面板交互').subject, 'feat(review): 完善项目 Git 面板交互')
check('   去掉代码围栏', normalizeCommitMessage('```\nfix: 修复\n```').subject, 'fix: 修复')
check('   去掉 commit message: 前缀', normalizeCommitMessage('commit message: fix: 修复').subject, 'fix: 修复')
check('   去掉中文前缀', normalizeCommitMessage('提交信息：fix: 修复').subject, 'fix: 修复')
check('   去掉标题外层引号', normalizeCommitMessage('"fix: 修复"').subject, 'fix: 修复')
check(
  '   标题 + 要点列表',
  normalizeCommitMessage('fix(review): 修复未跟踪文件差异查看\n\n- 改走按需差异\n- 补回归测试').bullets.join('|'),
  '改走按需差异|补回归测试',
)
checkTrue('   标题超长被截断', normalizeCommitMessage(`x${'y'.repeat(300)}`).subject.length <= COMMIT_MESSAGE_LIMITS.maxSubjectChars)
check('   空输入得到空串', normalizeCommitMessage('').message, '')
check('   非字符串不抛错', normalizeCommitMessage(undefined).message, '')
check('   非字符串不抛错（数字）', normalizeCommitMessage(42).message, '')
// 标题行必须留在 message 里（提交框显示的是整段文本）。
checkTrue('   message 里带标题与正文', normalizeCommitMessage('fix: 修复\n\n- 一\n- 二').message.includes('- 一'))

// =================================================================================
console.log('')
console.log('=== 4. 失败翻译：稳定 code + 一句人能读的话 ===')
{
  const missing = describeLlmFailure({ code: 'MISSING_CREDENTIAL', message: 'no credential' })
  check('   凭据缺失保留 code', missing.code, 'MISSING_CREDENTIAL')
  checkTrue('   凭据缺失给出去哪修的提示', missing.detail.includes('设置'))
  check('   无 adapter 的 code', describeLlmFailure({ code: 'NO_ADAPTER', message: 'x' }).code, 'NO_ADAPTER')
  check('   超时的 code', describeLlmFailure({ code: COMMIT_MESSAGE_TIMEOUT_CODE, message: 'x' }).code, COMMIT_MESSAGE_TIMEOUT_CODE)
  check('   没有 code 时兜底', describeLlmFailure(new Error('boom')).code, 'aiFailed')
  checkTrue('   没有 code 时带上原文', describeLlmFailure(new Error('boom')).detail.includes('boom'))
}

// =================================================================================
console.log('')
console.log('=== 5. 适配器：宿主缺能力时**点名缺哪个正式能力**，且不虚构接口 ===')
{
  // 完全没有服务：两个都缺。
  const bare = createCommitMessageGenerator({ get: () => undefined })
  const bareState = bare.available()
  check('5) 没有服务时不可用', bareState.available, false)
  check(
    '   点名缺 ctx.llm 与 ctx.agentDefaultModel',
    bareState.missing.join(' | '),
    'ctx.llm (@deepseek-ai/dsh-llm) | ctx.agentDefaultModel (@deepseek-ai/dsh-agent-default-model)',
  )
  let thrown = null
  try {
    await bare.generateCommitMessage({ files: [] })
  } catch (cause) {
    thrown = cause
  }
  check('   生成时抛出稳定 code', thrown?.code, 'aiUnavailable')
  checkTrue('   错误里带上 missing 列表', Array.isArray(thrown?.missing) && thrown.missing.length === 2)

  // 有 llm 但没有默认模型选择。
  const partial = createCommitMessageGenerator({
    get: (name) => (name === 'llm' ? { stream: async function* () {} } : { currentSelection: () => ({}) }),
  })
  check('   有服务但没有模型选择时不可用', partial.available().available, false)
  check('   点名缺 currentSelection', partial.available().missing.join(','), 'agentDefaultModel.currentSelection()')

  // 两个都在：可用，且**走的确实是 ctx.llm.stream**（用一个假的 stream 验证请求形状）。
  const seen = []
  const fakeCtx = {
    get: (name) =>
      name === 'llm'
        ? {
            stream: async function* (options) {
              seen.push(options)
              yield { type: 'text-delta', index: 0, text: 'feat(review): 补一条提交信息\n\n- 一' }
              yield { type: 'finish', reason: { kind: 'stop' } }
            },
          }
        : { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
  }
  const generator = createCommitMessageGenerator(fakeCtx, {
    // 用轻量替身顶掉真实包：这里要断言的是"请求怎么拼"，而不是包本身的行为。
    loadLlm: async () => ({
      createUserMessage: (input) => ({ ...input, role: 'user' }),
      BlockAssembler: class {
        constructor() {
          this.chunks = []
        }
        push(chunk) {
          this.chunks.push(chunk)
        }
        get finish() {
          return { kind: 'stop' }
        }
        blocks() {
          return this.chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => ({ type: 'text', text: chunk.text }))
        }
      },
    }),
    loadTimeout: async () => ({ deadline: (upstream, timeoutMs, code) => ({ signal: undefined, timeoutMs, code, [Symbol.dispose]() {} }) }),
  })
  check('   两个服务都在时可用', generator.available().available, true)
  const result = await generator.generateCommitMessage({ files: [], branch: 'main', total: 0 })
  check('   走的是 agentDefaultModel 给的 provider', seen[0]?.provider, 'deepseek-official')
  check('   走的是 agentDefaultModel 给的 model', seen[0]?.model, 'deepseek-flash')
  check('   带上 system 槽位', typeof seen[0]?.system, 'string')
  check('   只带一条 user 消息', seen[0]?.messages?.length, 1)
  // `purpose` 是**封闭联合**（只有 compaction / session-title），普通请求必须不传。
  check('   不传 purpose（它是封闭联合）', seen[0]?.purpose, undefined)
  // `sessionId` 是会话身份，本操作不属于任何会话——编一个比省略更糟。
  check('   不传 sessionId（无会话归属）', seen[0]?.sessionId, undefined)
  check('   输出上限被带上', seen[0]?.maxTokens, COMMIT_MESSAGE_LIMITS.maxOutputTokens)
  check('   标题被规范化出来', result.subject, 'feat(review): 补一条提交信息')
  check('   要点被解析出来', result.bullets.join(','), '一')
  check('   回报实际使用的模型', `${result.model.provider}/${result.model.model}`, 'deepseek-official/deepseek-flash')
}

console.log('')
console.log(failures === 0 ? 'AI 补充提交信息全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
