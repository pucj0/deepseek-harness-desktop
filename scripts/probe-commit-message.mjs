// 真实模型 smoke test：「AI 补充提交信息」到底收到什么 finish、以及 400 token 是否就是根因。
//
//   node scripts/probe-commit-message.mjs                # 用当前的 1024 预算跑一次
//   node scripts/probe-commit-message.mjs --max-tokens=400   # 把预算改回 400 再跑一次（对照）
//
// 为什么要它：`finish=max-tokens` 这条报错只能**在真实 provider 上**复现/验证——假 stream 能
// 证明"我们怎么处理 finish"，但证明不了"真实模型到底给什么 finish"。因此这里：
//   1. 起一个**隔离的** shell 运行时（临时 home + 临时 git 仓库），跑的是 `plugins/` 里
//      当前的 host 代码（先同步进 runtime）；
//   2. 凭据只从**进程环境**注入（`DEEPSEEK_API_KEY` 优先于 home 里的 .credentials.yaml，
//      见 dsh-credentials-local 的层级说明），因此不会把真实凭据写进临时 home；
//   3. 直接打 `/dsh-desktop/review/commit-message`（就是界面上那个按钮走的那条路由），
//      把 `{ message, subject, bullets, truncated, finishReason, stats }` 原样打出来。
//
// `--max-tokens=N` 只改 **runtime 里那份副本**（并在结束时还原），因此源码、git 工作区
// 都不会被动到——它的用途是"同一台机器、同一条仓库、同一个模型，只换输出预算"做对照。
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { syncBundledPlugins } from './sync-plugins.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const RUNTIME = join(ROOT, 'runtime')
const PLUGIN_COPY = join(RUNTIME, 'node_modules', 'dsh-client-ui-review', 'lib', 'commit-message.js')

const arg = process.argv.slice(2).find((token) => token.startsWith('--max-tokens='))
const overrideMaxTokens = arg === undefined ? undefined : Number(arg.slice('--max-tokens='.length))
/** 把 runtime 副本改回**旧语义**（`finish !== 'stop'` 直接抛），用来复现实机那条报错。 */
const oldSemantics = process.argv.includes('--old-semantics')

const run = (args, cwd) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })

/**
 * 从真实 home 的凭据文档里取 `DEEPSEEK_API_KEY`（只读、不打印）。
 *
 * 环境里已经有就直接用；`dsh-credentials-local` 的层级是"进程环境优先于文件"，因此把它放进
 * 子进程的 env 就够了——临时 home 里不需要出现任何凭据。
 *
 * @returns API key，或 undefined。
 */
function deepseekKey() {
  if (typeof process.env.DEEPSEEK_API_KEY === 'string' && process.env.DEEPSEEK_API_KEY !== '') return process.env.DEEPSEEK_API_KEY
  const home = process.env.DSH_HOME
  if (typeof home !== 'string' || home === '') return undefined
  const file = join(home, '.credentials.yaml')
  if (!existsSync(file)) return undefined
  const text = readFileSync(file, 'utf8')
  // 只认 `DEEPSEEK_API_KEY: <value>` 这一行；值本身不写进任何输出。
  const match = /^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$/mu.exec(text)
  return match === null ? undefined : match[1]
}

/** 起一次服务端、调一次路由、返回结果。 */
async function probeOnce(label) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-commit-message-'))
  const repo = join(root, 'repo')
  const home = join(root, 'home')
  let child
  try {
    // ---- 造一个有真实改动的仓库 -------------------------------------------------
    mkdirSync(join(repo, 'src'), { recursive: true })
    mkdirSync(home, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'probe@example.com'])
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'probe'])
    execFileSync('git', ['-C', repo, 'config', 'commit.gpgsign', 'false'])
    writeFileSync(join(repo, 'src', 'app.js'), 'export const version = 1\n')
    writeFileSync(join(repo, 'README.md'), '# demo\n')
    run(['add', '.'], repo)
    run(['commit', '-q', '-m', 'init'], repo)
    // 改动：两处内容变化 + 一个新文件（让提示词里有真实差异可读）。
    writeFileSync(join(repo, 'src', 'app.js'), 'export const version = 2\nexport const name = "demo"\n')
    writeFileSync(join(repo, 'README.md'), '# demo\n\n## Usage\n\nRun it.\n')
    writeFileSync(join(repo, 'src', 'helper.js'), 'export const noop = () => undefined\n')
    const revision = run(['rev-parse', 'HEAD'], repo).trim()

    // ---- 起服务端（隔离 home）---------------------------------------------------
    //
    // 工作区记录必须满足宿主的 schema（`title` / `sessionIds` / 时间戳都要在）——少一个字段
    // 就会以 `stored record 'probe' in table 'workspaces' does not match its schema` 起不来。
    mkdirSync(join(home, 'storages'), { recursive: true })
    const now = new Date().toISOString()
    writeFileSync(
      join(home, 'storages', 'workspace.json'),
      JSON.stringify(
        {
          unit: { name: 'workspace', version: 2 },
          global: { initialized: true, workspaceIds: ['probe'], archivedSessionIds: [] },
          tables: {
            workspaces: {
              probe: { path: repo, title: 'probe', sessionIds: [], createdAt: now, updatedAt: now },
            },
          },
        },
        null,
        2,
      ) + '\n',
    )
    child = spawn(
      join(RUNTIME, 'node', 'node.exe'),
      [
        join(RUNTIME, 'server.mjs'),
        '--dsh-home',
        home,
        '--install-anchor',
        join(RUNTIME, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
        '--workspace',
        repo,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DEEPSEEK_API_KEY: deepseekKey() ?? '' } },
    )
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))

    let base
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 1500))
      const m = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/u.exec(out)
      if (m !== null) {
        base = m[1]
        break
      }
    }
    if (base === undefined) throw new Error(`服务端未就绪\n${out.slice(-4000)}`)

    const started = Date.now()
    const response = await fetch(`${base}/dsh-desktop/review/commit-message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace: repo,
        sessionId: 'probe',
        branch: 'main',
        revision,
        files: [
          { path: 'src/app.js', status: 'M', added: 2, removed: 1 },
          { path: 'README.md', status: 'M', added: 3, removed: 1 },
          { path: 'src/helper.js', status: 'A', added: 1, removed: 0, untracked: true },
        ],
      }),
    })
    const text = await response.text()
    const elapsed = Date.now() - started
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { error: text.slice(0, 200) }
    }
    return { label, status: response.status, elapsed, payload }
  } finally {
    if (child !== undefined) child.kill()
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // 临时目录清不掉不影响结论。
    }
  }
}

/**
 * 把 runtime 里那份 host 代码临时改掉，返回还原函数。
 *
 * @param options - `{ maxTokens, oldSemantics }`：两者都可选。
 * @returns 还原函数。
 */
function patchRuntime(options) {
  if (!existsSync(PLUGIN_COPY)) throw new Error(`runtime 里没有插件副本：${PLUGIN_COPY}（先 npm run stage）`)
  const original = readFileSync(PLUGIN_COPY, 'utf8')
  let patched = original
  if (Number.isFinite(options.maxTokens)) {
    patched = patched.replace(/maxOutputTokens:\s*\d+/u, `maxOutputTokens: ${options.maxTokens}`)
    if (patched === original) throw new Error('没找到 maxOutputTokens')
  }
  if (options.oldSemantics === true) {
    // 旧写法：**先判 finish、再读 blocks**，于是 max-tokens 会把已生成的文本整段丢掉，
    // 并把 `finish=max-tokens` 当成用户可见的失败原因。
    const anchor = '  const blocks = typeof assembler?.blocks === \'function\' ? assembler.blocks() : []'
    if (!patched.includes(anchor)) throw new Error('没找到 blocks() 那一行')
    patched = patched.replace(
      anchor,
      [
        '  const earlyFinish = assembler?.finish',
        "  if (earlyFinish?.kind !== 'stop') {",
        '    const described = describeLlmFailure(earlyFinish.failure ?? { code: \'aiFailed\', message: `finish=${String(earlyFinish?.kind)}` })',
        '    throw aiError(described.code, described.detail)',
        '  }',
        anchor,
      ].join('\n'),
    )
  }
  if (patched === original) throw new Error('补丁没有产生任何改动')
  writeFileSync(PLUGIN_COPY, patched, 'utf8')
  return () => writeFileSync(PLUGIN_COPY, original, 'utf8')
}

console.log('=== 真实模型 smoke：AI 补充提交信息 ===')
if (!existsSync(join(RUNTIME, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))) {
  console.log('  缺少 staged 运行时（runtime/），跳过：请先 npm run stage:runtime')
  process.exit(0)
}
const key = deepseekKey()
console.log(`  凭据: ${key === undefined ? '未找到 DEEPSEEK_API_KEY（下面的调用会以 MISSING_CREDENTIAL 失败）' : `已从${process.env.DEEPSEEK_API_KEY === undefined ? ' home 凭据' : '环境变量'}注入（长度 ${key.length}）`}`)
console.log('')

// ---- 第一跑：源码里当前的实现（预算 = 源码常量，1024）-------------------------
syncBundledPlugins()
const current = await probeOnce(overrideMaxTokens === undefined ? '当前实现（源码预算 1024）' : `当前实现（源码预算 1024）`)
const show = (result) => {
  const p = result.payload
  console.log(`  [${result.label}] HTTP ${result.status}，耗时 ${result.elapsed}ms`)
  if (result.status !== 200) {
    console.log(`    code：${p.code}   detail：${String(p.detail).slice(0, 200)}`)
    return
  }
  console.log(`    finishReason：${p.finishReason}   truncated：${p.truncated === true}`)
  console.log(`    subject：${p.subject}`)
  if (Array.isArray(p.bullets) && p.bullets.length > 0) console.log(`    bullets：${p.bullets.length} 条 → ${p.bullets.join(' | ')}`)
  console.log(`    行数：${String(p.message ?? '').split('\n').length}   字符数：${String(p.message ?? '').length}`)
  console.log(`    提示词统计：${JSON.stringify(p.stats)}`)
  console.log(`    模型：${p.model?.provider}/${p.model?.model}`)
}
show(current)

/**
 * 打补丁 → 跑一次 → 还原。
 * @param label - 这一次的标签。
 * @param options - `{ maxTokens, oldSemantics }`。
 */
async function probePatched(label, options) {
  console.log('')
  console.log(`=== ${label} ===`)
  const restore = patchRuntime(options)
  try {
    show(await probeOnce(label))
  } finally {
    restore()
    syncBundledPlugins()
  }
}

if (overrideMaxTokens !== undefined) {
  await probePatched(`对照：MAX_OUTPUT_TOKENS=${overrideMaxTokens}（新语义）`, { maxTokens: overrideMaxTokens })
}
if (oldSemantics) {
  // 复现实机那条报错：同一条仓库、同一个模型，只把"非 stop 即抛错"的旧语义放回去。
  await probePatched('复现：旧语义（finish !== stop 即抛错）', {
    maxTokens: Number.isFinite(overrideMaxTokens) ? overrideMaxTokens : 40,
    oldSemantics: true,
  })
}

console.log('')
console.log('结论：看上面每一次的 finishReason 与 truncated ——')
console.log('      * 预算够用时是 stop，正常生成，修复前后没有差别；')
console.log('      * 预算被用尽（max-tokens）时，新实现保留已生成的文本（truncated=true），')
console.log('        旧语义则把它整段丢掉并报 `finish=max-tokens`。')
