// 实测项目级快照的代价：**重构前 vs 重构后**，数 git 进程数与耗时。
//
//   node scripts/measure-workspace-snapshot.mjs [仓库路径]
//
// 这条测量对应"切过去要等很久"那个反馈：`/review/workspace` 是右上角数字的轮询路径，
// 而它以前会
//   1. 用临时索引 `read-tree` + `add -A` + `write-tree` 造一棵树（大仓库上数秒），
//   2. 再算一份**全仓库统一差异**（实测 45.9 MB），
//   3. 连同 numstat / name-status / status / symbolic-ref 一共 6 条命令；
// 而"改了 N 个文件"这个数字只需要文件清单与状态。重构后是 2 条命令、0 份差异正文。
//
// 只读：临时索引落在系统 temp 目录里，不动仓库状态（测完删掉）。
import { execFile } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const workspace = process.argv[2] ?? 'E:\\workspace\\mmsm-amis'
const GIT_TIMEOUT_MS = 240000
const GIT_MAX_BUFFER = 32 * 1024 * 1024
const GIT_MAX_BUFFER_LARGE = 256 * 1024 * 1024
let processes = 0

/** 与 host 实现一致的调用方式（`-c core.fileMode=false -c core.quotePath=false`）。 */
function git(args, env, maxBuffer = GIT_MAX_BUFFER) {
  processes += 1
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.fileMode=false', '-c', 'core.quotePath=false', '-C', workspace, ...args],
      { timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        if (error !== null) reject(new Error(String(stderr).trim() || error.message))
        else resolve(String(stdout))
      },
    )
  })
}
/** 计时并统计进程数。 */
async function measure(label, task) {
  const before = processes
  const started = Date.now()
  let note = ''
  try {
    note = (await task()) ?? ''
  } catch (error) {
    note = `失败: ${String(error.message).slice(0, 80)}`
  }
  const ms = Date.now() - started
  const procs = processes - before
  console.log(`  ${label.padEnd(46)} ${String(procs).padStart(2)} 个进程  ${String(ms).padStart(6)} ms  ${note}`)
  return { ms, procs }
}

const indexFor = (label) => join(tmpdir(), `dsh-measure-${label}-${process.pid}.index`)

console.log(`仓库: ${workspace}`)
if (!existsSync(join(workspace, '.git'))) {
  console.error('不是 git 仓库（没有 .git）')
  process.exit(1)
}
console.log('')

// ---- 前置：数一下规模 ------------------------------------------------------------
const statusRaw = await git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], undefined, GIT_MAX_BUFFER_LARGE)
const statusFiles = statusRaw.split('\0').filter((line) => line !== '' && !line.startsWith('# ')).length
const numstatRaw = await git(['diff', '--numstat', 'HEAD'], undefined, GIT_MAX_BUFFER_LARGE).catch(() => '')
const changedTracked = numstatRaw.split('\n').filter((line) => line.trim() !== '').length
console.log(`规模: status 条目 ${statusFiles}，相对 HEAD 有内容差异的已跟踪文件 ${changedTracked}`)
console.log('')

// ---- 旧实现：/workspace（临时索引树 + 全仓库统一差异）----------------------------
console.log('重构前的 /review/workspace（每一次轮询都做这些）:')
let oldTotal = 0
const oldResult = await measure('1) 临时索引树 read-tree+add -A+write-tree', async () => {
  const env = { GIT_INDEX_FILE: indexFor('old') }
  await git(['read-tree', 'HEAD'], env).catch(() => undefined)
  await git(['add', '-A'], env)
  return `tree=${(await git(['write-tree'], env)).trim().slice(0, 8)}`
})
oldTotal += oldResult.ms
const tree = await (async () => {
  const env = { GIT_INDEX_FILE: indexFor('old') }
  return (await git(['write-tree'], env)).trim()
})().catch(() => '')
const oldSteps = []
oldSteps.push(await measure('2) diff --numstat <tree>', async () => {
  const raw = await git(['diff', '--numstat', 'HEAD', tree])
  return `${raw.split('\n').filter((line) => line.trim() !== '').length} 条`
}))
oldSteps.push(await measure('3) diff --name-status <tree>', async () => {
  const raw = await git(['diff', '--name-status', 'HEAD', tree])
  return `${raw.split('\n').filter((line) => line.trim() !== '').length} 条`
}))
oldSteps.push(await measure('4) status --porcelain', () => git(['status', '--porcelain'])))
oldSteps.push(await measure('5) symbolic-ref --short HEAD', () => git(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')))
const oldDiff = await measure('6) diff --unified=3 <tree>（全仓库差异正文）', async () => {
  const raw = await git(['diff', '--unified=3', 'HEAD', tree], undefined, GIT_MAX_BUFFER_LARGE)
  return `${(raw.length / 1024 / 1024).toFixed(1)} MB`
})
const oldMs = oldTotal + oldSteps.reduce((sum, item) => sum + item.ms, 0) + oldDiff.ms
const oldProcs = 5 + oldSteps.length + 1

console.log('')
console.log('重构后的 /review/workspace:')
const newStatus = await measure('1) status --porcelain=v2 --branch -z -uall', async () => {
  const raw = await git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], undefined, GIT_MAX_BUFFER_LARGE)
  return `${raw.split('\0').filter((line) => line !== '' && !line.startsWith('# ')).length} 条状态`
})
const newNumstat = await measure('2) diff --numstat HEAD（只有行数，无正文）', async () => {
  const raw = await git(['diff', '--numstat', 'HEAD'], undefined, GIT_MAX_BUFFER_LARGE)
  return `${raw.split('\n').filter((line) => line.trim() !== '').length} 条行数`
})
const newMs = newStatus.ms + newNumstat.ms

console.log('')
console.log('重构后：点一个文件才取的差异（/workspace-file）:')
const oneFile = changedTracked > 0 ? numstatRaw.split('\n')[0].split('\t').slice(2).join('\t') : ''
const single = oneFile === '' ? { ms: 0, procs: 0 } : await measure(`1) diff --unified=3 HEAD -- ${oneFile.slice(0, 30)}`, async () => {
  const raw = await git(['diff', '--unified=3', 'HEAD', '--', oneFile])
  return `${(raw.length / 1024).toFixed(0)} KB`
})

console.log('')
console.log('对比（同一台机器、同一个仓库）:')
console.log(`  轮询一次的 git 进程数:  ${oldProcs}  ->  ${newStatus.procs + newNumstat.procs}`)
console.log(`  轮询一次的耗时:        ${(oldMs / 1000).toFixed(2)}s  ->  ${(newMs / 1000).toFixed(2)}s`)
console.log(`  轮询一次产出的差异正文: ${oldDiff.ms > 0 ? '全仓库统一差异' : '（未测到）'}  ->  0（点了某个文件才产生 1 条单文件差异：${single.procs} 个进程 / ${single.ms} ms）`)

for (const file of [indexFor('old')]) rmSync(file, { force: true })
