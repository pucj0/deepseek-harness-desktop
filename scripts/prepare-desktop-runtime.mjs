// 生成 **Desktop Production Runtime**：把 `runtime/` 按 `runtime-file-policy.mjs` 裁剪成
// `build/runtime-desktop/`，供 electron-builder 打包。
//
//   node scripts/prepare-desktop-runtime.mjs                  # win32-x64（默认）
//   node scripts/prepare-desktop-runtime.mjs --platform=darwin --arch=arm64
//   node scripts/prepare-desktop-runtime.mjs --report         # 只打印会剔除什么，不写盘
//
// 为什么要有这一步（而不是在 electron-builder 的 `files` 里写一堆 `!`）：
//
//   1. 策略要能被**测试直接驱动**（`scripts/test-desktop-runtime.mjs` 用同一个模块判断，
//      并对裁剪后的树做真实启动 smoke test）；
//   2. 剔除必须**可报告**：每条原因各占多少字节要能打出来，否则"为什么这个包没了"只能靠猜；
//   3. 裁剪后的树是"将要发布的东西"的单一事实来源——第三份副本（runtime 归档）已经删除，
//      因此产物里 Runtime 只可能来自这里。
//
// 复制而不是移动：`runtime/` 仍是开发/测试用的完整树（测试要跑完整闭包），
// 只有打包才用裁剪版。
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { DEFAULT_TARGET, desktopRuntimeExclusion, desktopRuntimeTopLevelExclusion } from './runtime-file-policy.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const SOURCE = join(ROOT, 'runtime')
const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const REPORT_ONLY = process.argv.includes('--report')
const target = { platform: option('platform') ?? DEFAULT_TARGET.platform, arch: option('arch') ?? DEFAULT_TARGET.arch }
const OUTPUT = resolve(option('output') ?? join(ROOT, 'build', 'runtime-desktop'))

if (!existsSync(join(SOURCE, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))) {
  console.error('[prepare-desktop-runtime] runtime/ 未就绪；先跑 npm run stage:runtime')
  process.exit(1)
}

/**
 * 判断某个相对路径是否要剔除。
 *
 * 先看 `runtime/` 顶层的策略（便携 Node），再把 `node_modules` 内部的路径交给策略模块；
 * 其余顶层条目一律保留（`package.json`、`runtime.json`、`server.mjs`、
 * `client-module-cache.mjs` 都是启动必需的）。
 *
 * @param rel - 相对 `runtime/` 的路径（POSIX 分隔符）。
 * @returns 剔除原因；undefined 表示保留。
 */
function exclusionFor(rel) {
  const topLevel = desktopRuntimeTopLevelExclusion(rel)
  if (topLevel !== undefined) return topLevel
  const marker = 'node_modules/'
  const index = rel.indexOf(marker)
  if (index < 0) return undefined
  return desktopRuntimeExclusion(rel.slice(index + marker.length), target)
}

/** 递归收集要保留/剔除的文件。 */
function collect(dir, kept, dropped) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name)
    const rel = relative(SOURCE, absolute).split(sep).join('/')
    if (entry.isDirectory()) {
      // 目录整体命中策略时不再往下走：否则每个文件都要重复判断一次，报告也会变成噪声。
      const reason = exclusionFor(`${rel}/`)
      if (reason !== undefined) {
        dropped.push({ rel, reason, bytes: directoryBytes(absolute), files: countFiles(absolute) })
        continue
      }
      collect(absolute, kept, dropped)
      continue
    }
    let stat
    try {
      stat = statSync(absolute)
    } catch {
      continue
    }
    const reason = exclusionFor(rel)
    if (reason === undefined) kept.push({ rel, bytes: stat.size })
    else dropped.push({ rel, reason, bytes: stat.size, files: 1 })
  }
}

/** 目录体积（用于报告）。 */
function directoryBytes(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name)
    try {
      if (entry.isDirectory()) total += directoryBytes(absolute)
      else total += statSync(absolute).size
    } catch {
      // 读不到就当作 0：报告不该因为一个坏文件而失败。
    }
  }
  return total
}

/** 目录里的文件数（用于报告）。 */
function countFiles(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    try {
      if (entry.isDirectory()) total += countFiles(join(dir, entry.name))
      else total += 1
    } catch {
      // 同上。
    }
  }
  return total
}

const kept = []
const dropped = []
collect(SOURCE, kept, dropped)

const mib = (bytes) => (bytes / 1048576).toFixed(1)
const keptBytes = kept.reduce((sum, file) => sum + file.bytes, 0)
const droppedBytes = dropped.reduce((sum, entry) => sum + entry.bytes, 0)

/** 按原因聚合。 */
const byReason = new Map()
for (const entry of dropped) {
  const current = byReason.get(entry.reason) ?? { bytes: 0, files: 0, sample: entry.rel }
  byReason.set(entry.reason, { bytes: current.bytes + entry.bytes, files: current.files + entry.files, sample: current.sample })
}

console.log(`[prepare-desktop-runtime] 目标 ${target.platform}-${target.arch}`)
console.log(`[prepare-desktop-runtime] 保留 ${kept.length} 个文件 / ${mib(keptBytes)} MiB`)
console.log(`[prepare-desktop-runtime] 剔除 ${dropped.length} 项 / ${mib(droppedBytes)} MiB`)
for (const [reason, stats] of [...byReason.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(`  ${mib(stats.bytes).padStart(8)} MiB  ${String(stats.files).padStart(6)} 项  ${reason}  (例如 ${stats.sample})`)
}

if (REPORT_ONLY) {
  console.log('[prepare-desktop-runtime] --report：未写盘')
  process.exit(0)
}

rmSync(OUTPUT, { recursive: true, force: true })
mkdirSync(OUTPUT, { recursive: true })
for (const file of kept) {
  const destination = join(OUTPUT, ...file.rel.split('/'))
  mkdirSync(resolve(destination, '..'), { recursive: true })
  cpSync(join(SOURCE, ...file.rel.split('/')), destination)
}
writeFileSync(
  join(OUTPUT, 'desktop-runtime.json'),
  JSON.stringify(
    {
      target,
      keptFiles: kept.length,
      keptBytes,
      droppedEntries: dropped.length,
      droppedBytes,
      droppedByReason: Object.fromEntries([...byReason.entries()].map(([reason, stats]) => [reason, { bytes: stats.bytes, files: stats.files }])),
    },
    null,
    2,
  ) + '\n',
)
console.log(`[prepare-desktop-runtime] 已写入 ${relative(ROOT, OUTPUT)}（${mib(keptBytes)} MiB）`)
