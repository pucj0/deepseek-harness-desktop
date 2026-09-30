// 打包应用的冷/热启动基准。
//
//   node scripts/benchmark-desktop-startup.mjs                 # 5 次冷 + 5 次热
//   node scripts/benchmark-desktop-startup.mjs --runs=9
//   node scripts/benchmark-desktop-startup.mjs --host          # 只量 Runtime（Node 模式，无需图形界面）
//   node scripts/benchmark-desktop-startup.mjs --json
//
// 两种模式，因为它们的**可跑环境不同**，混在一起报数只会得到假数据：
//
//   * `--host`（无需图形界面）：用 `ELECTRON_RUN_AS_NODE=1` 直接跑打包产物里的
//     `app.asar/runtime/server.mjs`，量到 `dsh web:` 就绪。这是"Runtime + 插件装载"
//     的净时间，也是**唯一能在无显示环境（CI、容器）里跑出数**的那部分。
//   * 默认（需要图形界面）：启动打包后的 `dsh-desktop.exe` 本体，从它 stderr 里抓
//     `[dsh-startup] ...` 时间线（见 src/main/startup-timeline.ts），报
//     `harnessUsable`（界面可用）的 P50/P95。
//
// 冷/热的定义写死在代码里，避免"这次算冷、下次算热"：
//
//   * **冷** = 先按路径清掉操作系统的文件缓存（Windows 用 `RAMMap` 不可得时的可行替代：
//     用一次"驱逐"读把缓存挤掉并等待）**并且**换一个全新的 DSH home；
//   * **热** = 同一个 DSH home 再跑一次，进程与缓存都是热的。
//
// Windows 上没有免提权的"清空 standby list"接口，因此冷启动用**大文件顺序读**把页缓存挤走
// （`--cold-scrub-mb`，默认 2048 MiB；不够大时会**明确标注**冷启动可能不纯）。
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const ROOT = resolve(import.meta.dirname, '..')
const option = (name, fallback) => {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}
const RUNS = Number(option('runs', '5'))
const HOST_ONLY = process.argv.includes('--host')
const JSON_OUT = process.argv.includes('--json')
const COLD_SCRUB_MIB = Number(option('cold-scrub-mb', '2048'))
const READY_TIMEOUT_MS = Number(option('timeout-ms', '120000'))

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const UNPACKED = join(ROOT, 'release', version, 'win-unpacked')
const EXE = join(UNPACKED, process.platform === 'win32' ? 'dsh-desktop.exe' : 'dsh-desktop')
const APP = join(UNPACKED, 'resources', 'app.asar')

if (!existsSync(EXE)) {
  console.error(`找不到打包产物：${EXE}`)
  console.error('先跑：npx electron-builder --win --x64 --dir')
  process.exit(1)
}

/** 百分位（最接近的秩，样本少时不做插值——不假装有比样本更多的信息）。 */
function percentile(sorted, fraction) {
  if (sorted.length === 0) return Number.NaN
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index]
}

/**
 * 把操作系统的文件缓存挤走，让下一次启动尽量接近"冷"。
 *
 * 做法：写一个比可用内存小、比 Electron 工作集大的临时文件，再顺序读它。
 * 这不是精确的清缓存，但**方向是对的**：它会把刚用过的 Runtime 文件页挤出内存。
 *
 * @returns 实际挤出用的 MiB（0 表示跳过）。
 */
function scrubFileCache() {
  if (COLD_SCRUB_MIB <= 0) return 0
  const path = join(tmpdir(), `dsh-cold-scrub-${process.pid}.bin`)
  const chunk = Buffer.alloc(4 * 1024 * 1024, 0x5a)
  const handle = openSync(path, 'w')
  try {
    for (let written = 0; written < COLD_SCRUB_MIB; written += 4) {
      writeSync(handle, chunk)
    }
  } finally {
    closeSync(handle)
  }
  // 顺序读一遍：写入只占 page cache，读回来才把它钉在那里、把旧页挤出去。
  const buffer = Buffer.alloc(4 * 1024 * 1024)
  const readHandle = openSync(path, 'r')
  try {
    for (;;) {
      const read = readSync(readHandle, buffer, 0, buffer.length, null)
      if (read <= 0) break
    }
  } finally {
    closeSync(readHandle)
  }
  rmSync(path, { force: true })
  return COLD_SCRUB_MIB
}

/** 造一个全新的 DSH home（冷启动用）。 */
function freshHome(label) {
  const home = join(tmpdir(), `dsh-bench-${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(join(home, 'ws'), { recursive: true })
  return home
}

/**
 * 删掉一次运行的 home，**失败不抛**。
 *
 * 刚被 SIGKILL 的子进程在 Windows 上还会短暂握着目录句柄，`rmSync` 因此会 EPERM。
 * 那是清理问题，不是测量问题——把它变成噪音只会让基准在中途挂掉。
 *
 * @param path - 目录。
 */
function removeQuietly(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    // 留给下一次（临时目录，系统会清）。
  }
}

/**
 * 跑一次 **host** 启动（Node 模式），返回 ready 毫秒数。
 *
 * @param home - DSH home。
 * @returns ready 用时；失败时为 undefined。
 */
function runHostOnce(home) {
  return new Promise((settle) => {
    const started = performance.now()
    const child = spawn(
      EXE,
      [
        join(APP, 'runtime', 'server.mjs'),
        '--max-http-header-size=1048576',
        '--dsh-home',
        home,
        '--install-anchor',
        join(APP, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
        '--bundled-plugins-dir',
        join(UNPACKED, 'resources', 'plugins'),
        '--workspace',
        join(home, 'ws'),
      ],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home } },
    )
    let stdout = ''
    let done = false
    const deadline = setTimeout(() => finish(undefined), READY_TIMEOUT_MS)
    /** 收尾。 */
    function finish(ms) {
      if (done) return
      done = true
      clearTimeout(deadline)
      try {
        child.kill('SIGKILL')
      } catch {
        // 已退出。
      }
      settle(ms)
    }
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
      if (/^dsh web:\s+\S+/mu.test(stdout)) finish(performance.now() - started)
    })
    child.on('error', () => finish(undefined))
    child.on('exit', () => finish(undefined))
  })
}

/**
 * 跑一次 **UI** 启动，从 stderr 抓 `[dsh-startup]` 时间线。
 *
 * @param home - DSH home。
 * @returns `{ harnessUsable, timeline }`；失败时 harnessUsable 为 undefined。
 */
function runUiOnce(home) {
  return new Promise((settle) => {
    const child = spawn(EXE, [], { env: { ...process.env, DSH_DESKTOP_HOME: home } })
    let stderr = ''
    let done = false
    const deadline = setTimeout(() => finish(), READY_TIMEOUT_MS)
    /** 收尾。 */
    function finish() {
      if (done) return
      done = true
      clearTimeout(deadline)
      try {
        child.kill('SIGKILL')
      } catch {
        // 已退出。
      }
      const timeline = new Map()
      for (const match of stderr.matchAll(/\[dsh-startup\]\s+(\w+)\s+\+(\d+)ms/gu)) {
        if (!timeline.has(match[1])) timeline.set(match[1], Number(match[2]))
      }
      settle({ harnessUsable: timeline.get('harnessUsable'), timeline, stderr })
    }
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
      if (/\[dsh-startup\]\s+harnessUsable/u.test(stderr)) setTimeout(finish, 500)
    })
    child.on('error', () => finish())
    child.on('exit', () => finish())
  })
}

/** 打印一组样本的 P50/P95。 */
function summarize(label, samples) {
  const clean = samples.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (clean.length === 0) {
    console.log(`  ${label}: 没有有效样本`)
    return { label, count: 0 }
  }
  const p50 = percentile(clean, 0.5)
  const p95 = percentile(clean, 0.95)
  console.log(
    `  ${label}: n=${clean.length} P50=${p50.toFixed(0)}ms P95=${p95.toFixed(0)}ms ` +
      `min=${clean[0].toFixed(0)} max=${clean.at(-1).toFixed(0)}`,
  )
  return { label, count: clean.length, p50, p95, min: clean[0], max: clean.at(-1), samples: clean }
}

const results = { version, mode: HOST_ONLY ? 'host' : 'ui', runs: RUNS, cold: null, warm: null, timeline: null, scrubMiB: 0 }

if (HOST_ONLY) {
  console.log(`=== host 启动基准（Node 模式，${RUNS} 冷 + ${RUNS} 热）===`)
  const cold = []
  for (let index = 0; index < RUNS; index += 1) {
    results.scrubMiB = scrubFileCache()
    const home = freshHome(`cold${index}`)
    const ms = await runHostOnce(home)
    removeQuietly(home)
    cold.push(ms)
    console.log(`  cold #${index + 1}: ${ms === undefined ? '失败' : `${ms.toFixed(0)}ms`}`)
  }
  const warmHome = freshHome('warm')
  await runHostOnce(warmHome) // 预热：这一次不计入（它把 Runtime 页装进缓存）
  const warm = []
  for (let index = 0; index < RUNS; index += 1) {
    const ms = await runHostOnce(warmHome)
    warm.push(ms)
    console.log(`  warm #${index + 1}: ${ms === undefined ? '失败' : `${ms.toFixed(0)}ms`}`)
  }
  rmSync(warmHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  console.log('')
  console.log('=== 结果 ===')
  results.cold = summarize('cold（挤掉文件缓存 + 全新 home）', cold)
  results.warm = summarize('warm（同一 home）', warm)
  console.log(`  冷启动前的缓存挤压：${results.scrubMiB} MiB`)
} else {
  console.log(`=== UI 启动基准（${RUNS} 冷 + ${RUNS} 热）===`)
  console.log('  需要能运行 Electron 图形界面的环境；无显示时进程会立刻退出（拿不到时间线）。')
  const cold = []
  let firstTimeline = null
  for (let index = 0; index < RUNS; index += 1) {
    results.scrubMiB = scrubFileCache()
    const home = freshHome(`ui-cold${index}`)
    const { harnessUsable, timeline } = await runUiOnce(home)
    if (firstTimeline === null && timeline.size > 0) firstTimeline = Object.fromEntries(timeline)
    removeQuietly(home)
    cold.push(harnessUsable)
    console.log(`  cold #${index + 1}: ${harnessUsable === undefined ? '失败（拿不到 harnessUsable）' : `${harnessUsable}ms`}`)
  }
  const warmHome = freshHome('ui-warm')
  await runUiOnce(warmHome)
  const warm = []
  for (let index = 0; index < RUNS; index += 1) {
    const { harnessUsable } = await runUiOnce(warmHome)
    warm.push(harnessUsable)
    console.log(`  warm #${index + 1}: ${harnessUsable === undefined ? '失败' : `${harnessUsable}ms`}`)
  }
  rmSync(warmHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  console.log('')
  console.log('=== 结果 ===')
  results.cold = summarize('cold harnessUsable', cold)
  results.warm = summarize('warm harnessUsable', warm)
  results.timeline = firstTimeline
  if (firstTimeline !== null) {
    console.log(`  时间线：${Object.entries(firstTimeline).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  }
}

const jsonPath = option('json-out', undefined)
if (JSON_OUT) console.log(JSON.stringify(results, null, 2))
if (jsonPath !== undefined) writeFileSync(resolve(ROOT, jsonPath), JSON.stringify(results, null, 2) + '\n')
