/**
 * 启动埋点。
 *
 * 体积与启动是这一版的两个交付指标，而"感觉快了"不算数据。这里给出**一条可对比的时间线**：
 * 从进程开始（模块求值）到界面真正可用，每个阶段一行 `[dsh-startup] <name> +<ms>ms`，
 * 末尾再汇总一次，方便直接从 stderr 抠数（`scripts/benchmark-desktop-startup.mjs` 就是这么做的）。
 *
 * 设计取舍：
 *
 *   * **零依赖、零异步**：只用 `performance.now()`（单调时钟），不读磁盘、不发 IPC。
 *     埋点本身绝不能成为启动成本或失败点。
 *   * **默认开启**：启动数据只有在"真实发布产物、真实用户机器"上量才有意义，
 *     因此不做成需要开关的东西；每行只有几十字节，且只在启动期出现。
 *   * **顺序稳定**：`MARKS` 里列出的是预期的先后顺序，汇总时按它排序；
 *     未发生的阶段（例如失败路径）不会出现在输出里。
 */
import { performance } from 'node:perf_hooks'

/**
 * 预期发生的阶段，按先后顺序。
 *
 * 顺序本身也是契约的一部分：`scripts/test-desktop-runtime.mjs` 会检查打包启动的时间线里
 * 这些阶段**不倒退**（例如 `hostReady` 不可能早于 `hostSpawned`）。
 */
export const MARKS = [
  'processStart',
  'appReady',
  'runtimeReady',
  'pluginSyncFinished',
  'windowCreated',
  'hostSpawned',
  'hostReady',
  'navigationStarted',
  'domReady',
  'didFinishLoad',
  'harnessUsable',
] as const

export type MarkName = (typeof MARKS)[number]

/** 进程内的起点。模块被求值的时刻就当作 processStart。 */
const origin = performance.now()
const recorded = new Map<MarkName, number>()
let announcedOrigin = false

/**
 * 记录一个阶段。
 *
 * 同一阶段重复记录时**保留第一次**：启动路径上有重试与重启（切换工作区会重启服务端），
 * 而"首次可用"才是用户感知的那个数。
 *
 * @param name - 阶段名。
 * @returns 该阶段相对进程起点的毫秒数。
 */
export function markStartup(name: MarkName): number {
  const at = performance.now() - origin
  if (!recorded.has(name)) recorded.set(name, at)
  if (!announcedOrigin) {
    announcedOrigin = true
    // 先把"起点在哪"打出来：没有它，后面的相对时间无法与外部计时器对齐。
    process.stderr.write(`[dsh-startup] processStart +0ms\n`)
  }
  process.stderr.write(`[dsh-startup] ${name} +${at.toFixed(0)}ms\n`)
  return at
}

/**
 * 汇总时间线。
 *
 * @returns 各阶段毫秒数（按 {@link MARKS} 排序，只含已发生的）。
 */
export function startupTimeline(): Array<{ name: MarkName; ms: number }> {
  return MARKS.filter((name) => recorded.has(name)).map((name) => ({ name, ms: recorded.get(name)! }))
}

/**
 * 打印汇总，并给出"最慢的三个阶段"。
 *
 * 差值而不是绝对值才有诊断价值：总时长会被 Electron/Chromium 自身的冷启动主导，
 * 而阶段差能指出是谁在拖。
 */
export function reportStartup(): void {
  const timeline = startupTimeline()
  if (timeline.length === 0) return
  const parts = timeline.map(({ name, ms }) => `${name}=${ms.toFixed(0)}`)
  process.stderr.write(`[dsh-startup] timeline ${parts.join(' ')}\n`)

  const spans = timeline
    .map((entry, index) => ({ name: entry.name, ms: entry.ms - (timeline[index - 1]?.ms ?? 0) }))
    .slice(1)
    .sort((a, b) => b.ms - a.ms)
  if (spans.length > 0) {
    const total = timeline.at(-1)?.ms ?? 0
    const slowest = spans
      .slice(0, 3)
      .map((span) => `${span.name}=${span.ms.toFixed(0)}ms`)
      .join(' ')
    process.stderr.write(`[dsh-startup] slowest ${slowest} (total ${total.toFixed(0)}ms)\n`)
  }
}

/** 仅供测试：清空已记录阶段。 */
export function resetStartupForTest(): void {
  recorded.clear()
  announcedOrigin = false
}
