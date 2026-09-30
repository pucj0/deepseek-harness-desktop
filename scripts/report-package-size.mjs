// 安装包体积清单 + Size Gate。
//
//   node scripts/report-package-size.mjs                 # 默认量 release/<version>/win-unpacked
//   node scripts/report-package-size.mjs --dir <path>     # 指定解包目录
//   node scripts/report-package-size.mjs --top 100        # 最大文件/目录条数
//   node scripts/report-package-size.mjs --json           # 只输出 JSON（CI 用）
//
// 存在的理由：这一版把"安装包为什么这么大"从猜测变成数字。它回答四件事：
//
//   1. 各部分各占多少（Electron 主程序 / locales / app.asar / app.asar.unpacked /
//      runtime 归档 / 插件 / server）；
//   2. 最大的 N 个文件与 N 个目录；
//   3. **重复内容**：同一个 `@deepseek-ai/*` 包是否同时出现在 `app.asar`、
//      `app.asar.unpacked` 与 runtime 归档里（三份副本是这一版要根除的浪费）；
//   4. **门禁**：NSIS 安装包与下面这三条是否越界——越界即 exit 1，CI 直接失败：
//        * 第二份 portable Node（Electron 自带 Node 24，再带一份纯浪费）；
//        * 重复交付的 @deepseek-ai Runtime；
//        * **打包 npm CLI 缺失**（应用内更新 Runtime 要用它；它必须被解包到真实路径
//          `resources/app.asar.unpacked/node_modules/npm/bin/npm-cli.js`，见
//          electron-builder.yml 的 asarUnpack）。npm 本身不再是禁止项——它现在是
//          生产依赖，约 9 MiB 解包体积，是"用户不必装 node/npm"的代价。
//
// 它只读产物，不改任何东西；`app.asar` 用 `@electron/asar` 的原始头解析（与运行时读到的
// 是同一份表），runtime 归档按 `scripts/compress-runtime.mjs` 的格式流式解析头（不落盘）。
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { createBrotliDecompress } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Writable } from 'node:stream'

const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const ROOT = resolve(import.meta.dirname, '..')
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const DIR = resolve(ROOT, argValue('--dir', join('release', version, 'win-unpacked')))
const TOP = Number(argValue('--top', '100'))
const JSON_ONLY = args.includes('--json')
/** Size Gate 的两阶段上限（MiB）。第一阶段的硬门槛，第二阶段的目标。 */
const LIMIT_MIB = Number(argValue('--limit-mib', '136'))
const STRETCH_MIB = Number(argValue('--stretch-mib', '100'))

const MIB = 1024 * 1024
const mib = (bytes) => (bytes / MIB).toFixed(1)
const mib3 = (bytes) => (bytes / MIB).toFixed(3)

if (!existsSync(DIR)) {
  console.error(`找不到解包目录：${DIR}`)
  console.error('先构建：npx electron-builder --win --x64 --dir')
  process.exit(1)
}

/** 递归走一棵真实的目录树（不跟随符号链接，避免把 dev junction 算进来）。 */
function walk(dir, onFile) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    let stat
    try {
      stat = statSync(path)
    } catch {
      continue
    }
    if (stat.isDirectory()) walk(path, onFile)
    else onFile(path, stat.size)
  }
}

// ---------------------------------------------------------------- 解包目录清单 -----
const files = []
walk(DIR, (path, size) => files.push({ path, size, rel: path.slice(DIR.length + 1) }))
const totalBytes = files.reduce((sum, file) => sum + file.size, 0)

/** 某个路径前缀下的总字节数。 */
const sizeOf = (prefix) => files.filter((file) => file.rel === prefix || file.rel.startsWith(prefix + sep)).reduce((sum, file) => sum + file.size, 0)
/** 某个路径前缀下的文件数。 */
const countOf = (prefix) => files.filter((file) => file.rel === prefix || file.rel.startsWith(prefix + sep)).length

/** 按"给定深度"聚合目录体积。 */
function dirSizes(depth) {
  const map = new Map()
  for (const file of files) {
    const parts = file.rel.split(sep)
    const key = parts.slice(0, Math.min(depth, parts.length - 1)).join('/') || '(root)'
    map.set(key, (map.get(key) ?? 0) + file.size)
  }
  return [...map.entries()].map(([path, size]) => ({ path, size })).sort((a, b) => b.size - a.size)
}

const largestFiles = [...files].sort((a, b) => b.size - a.size).slice(0, TOP)
const largestDirs = dirSizes(4).slice(0, Math.max(50, TOP / 2))

// ---------------------------------------------------------------- app.asar --------
const ASAR = join(DIR, 'resources', 'app.asar')
const UNPACKED = join(DIR, 'resources', 'app.asar.unpacked')

/**
 * 从 asar 原始头里取出每个文件的 `{ path, size }`。
 *
 * 直接遍历头部的文件树，因此拿到的是**打包时写进归档的真实大小**（而不是再解一次）。
 * @param {string} archive - app.asar 路径。
 * @returns {{ path: string, size: number }[]}
 */
function readAsarFiles(archive) {
  if (!existsSync(archive)) return []
  const { getRawHeader } = require('@electron/asar')
  // `getRawHeader` 返回 `{ headerString, header, headerSize }`，文件树在 `header` 上。
  const header = getRawHeader(archive).header
  const out = []
  const visit = (node, prefix) => {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const path = prefix === '' ? name : `${prefix}/${name}`
      if (value.files !== undefined) visit(value, path)
      else if (value.unpacked !== true) out.push({ path, size: Number(value.size ?? 0) })
      else out.push({ path: `${path} (unpacked)`, size: Number(value.size ?? 0) })
    }
  }
  visit(header, '')
  return out
}

// `@electron/asar` 是 CJS，在 ESM 里用 createRequire 取。
const { createRequire } = await import('node:module')
const require = createRequire(import.meta.url)

const asarFiles = readAsarFiles(ASAR)
const asarBytes = asarFiles.reduce((sum, file) => sum + file.size, 0)
const asarTopDirs = (() => {
  const map = new Map()
  for (const file of asarFiles) {
    const key = file.path.split('/').slice(0, 3).join('/')
    map.set(key, (map.get(key) ?? 0) + file.size)
  }
  return [...map.entries()].map(([path, size]) => ({ path, size })).sort((a, b) => b.size - a.size).slice(0, 20)
})()

const unpackedFiles = []
if (existsSync(UNPACKED)) walk(UNPACKED, (path, size) => unpackedFiles.push({ path, size, rel: path.slice(UNPACKED.length + 1) }))
const unpackedBytes = unpackedFiles.reduce((sum, file) => sum + file.size, 0)

// ------------------------------------------------------- runtime 归档（runtime.br）--
const ARCHIVE = join(DIR, 'resources', 'runtime.br')
const MAGIC = Buffer.from('DSHRT1\n', 'utf8')

/**
 * 流式解析 runtime 归档，收集每个文件的大小。
 *
 * 只读头、跳过内容（内容仍要流过 brotli，但**不落盘**），因此这是对归档内容的**完整**枚举。
 * @param {string} archive - runtime.br 路径。
 * @returns {Promise<{ path: string, size: number }[]>}
 */
async function readRuntimeArchive(archive) {
  if (!existsSync(archive)) return []
  const out = []
  let buffer = Buffer.alloc(0)
  let phase = 'magic'
  let headerLength = 0
  let pending = null
  let remaining = 0
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      for (;;) {
        if (phase === 'done') {
          buffer = Buffer.alloc(0)
          return callback()
        }
        if (phase === 'magic') {
          if (buffer.length < MAGIC.length) return callback()
          buffer = buffer.subarray(MAGIC.length)
          phase = 'length'
          continue
        }
        if (phase === 'length') {
          if (buffer.length < 4) return callback()
          headerLength = buffer.readUInt32LE(0)
          buffer = buffer.subarray(4)
          if (headerLength === 0) {
            phase = 'done'
            continue
          }
          phase = 'header'
          continue
        }
        if (phase === 'header') {
          if (buffer.length < headerLength) return callback()
          pending = JSON.parse(buffer.subarray(0, headerLength).toString('utf8'))
          buffer = buffer.subarray(headerLength)
          out.push({ path: pending.path, size: pending.size })
          remaining = pending.size
          phase = 'content'
          continue
        }
        if (phase === 'content') {
          if (buffer.length < remaining) {
            remaining -= buffer.length
            buffer = Buffer.alloc(0)
            return callback()
          }
          buffer = buffer.subarray(remaining)
          remaining = 0
          phase = 'length'
          continue
        }
      }
      return callback()
    },
  })
  await pipeline(createReadStream(archive), createBrotliDecompress(), sink)
  return out
}

const archiveFiles = await readRuntimeArchive(ARCHIVE)
const archiveBytes = archiveFiles.reduce((sum, file) => sum + file.size, 0)
const archiveOnDisk = existsSync(ARCHIVE) ? statSync(ARCHIVE).size : 0

// ------------------------------------------------------------------ 重复检测 -------
/** 从一组路径里取出 `@deepseek-ai/<name>` 的包名集合。 */
const deepseekPackages = (paths) => {
  const set = new Set()
  for (const path of paths) {
    const match = /(?:^|\/)node_modules\/@deepseek-ai\/([^/]+)/u.exec(path) ?? /^@deepseek-ai\/([^/]+)/u.exec(path)
    if (match !== null) set.add(match[1])
  }
  return set
}
const inAsar = deepseekPackages(asarFiles.map((file) => file.path))
const inUnpacked = deepseekPackages(unpackedFiles.map((file) => file.rel))
const inArchive = deepseekPackages(archiveFiles.map((file) => file.path))
/** 同时出现在 >= 2 处的包（真正的重复交付）。 */
const duplicated = [...new Set([...inAsar, ...inUnpacked, ...inArchive])].filter(
  (name) => [inAsar.has(name), inUnpacked.has(name), inArchive.has(name)].filter(Boolean).length > 1,
)

/** 归档里 @deepseek-ai 的总体积（= 每个包一份）。 */
const archiveDeepseekBytes = archiveFiles.filter((file) => file.path.includes('node_modules/@deepseek-ai/')).reduce((sum, file) => sum + file.size, 0)

/** 归档内的目录体积（前 3 段），用来看"这 190 MB 到底是什么"。 */
const archiveTopDirs = (() => {
  const map = new Map()
  for (const file of archiveFiles) {
    const key = file.path.split('/').slice(0, 3).join('/')
    map.set(key, (map.get(key) ?? 0) + file.size)
  }
  return [...map.entries()].map(([path, size]) => ({ path, size })).sort((a, b) => b.size - a.size)
})()

/**
 * 归档里的"可裁剪"类别。
 *
 * 每一项都是**候选**：能不能删必须由真实启动 smoke test 证明（见 scripts/test-*.mjs），
 * 这里只负责把"有多大"量出来，避免凭感觉优化。
 */
const ARCHIVE_JUNK = [
  ['source map (*.map)', (p) => /\.map$/iu.test(p)],
  ['TypeScript 声明 (*.d.ts)', (p) => /\.d\.ts$/iu.test(p)],
  ['TypeScript 源码 (*.ts/*.tsx)', (p) => /\.tsx?$/iu.test(p) && !/\.d\.ts$/iu.test(p)],
  ['markdown (*.md)', (p) => /\.md$/iu.test(p)],
  ['文档目录 (docs/ man/)', (p) => /(^|\/)(docs|man)\//iu.test(p)],
  ['测试目录 (test/tests/__tests__)', (p) => /(^|\/)(tests?|__tests__)\//iu.test(p)],
  ['fixtures', (p) => /(^|\/)fixtures?\//iu.test(p)],
  ['examples', (p) => /(^|\/)examples?\//iu.test(p)],
  ['benchmark', (p) => /(^|\/)benchmark/iu.test(p)],
  ['非 win32 预编译 native', (p) => /(darwin|linux|android)/iu.test(p) && /\.(node|so|dylib)$/iu.test(p)],
  ['LICENSE/CHANGELOG', (p) => /(^|\/)(LICENSE|CHANGELOG|AUTHORS|NOTICE)/iu.test(p)],
]
const archiveJunk = ARCHIVE_JUNK.map(([label, test]) => {
  const hit = archiveFiles.filter((file) => test(file.path))
  return { label, bytes: hit.reduce((sum, file) => sum + file.size, 0), files: hit.length }
}).sort((a, b) => b.bytes - a.bytes)

// ------------------------------------------------------------------ 禁止项 ---------
//
// 这一版的"允许/必须/禁止"三张单子：
//
//   * **必须**：`node_modules/npm/**` 被解包到真实路径（应用内更新 Runtime 要用它）。
//     缺失即失败——这正是"用户不需要装 node/npm"这句话的物理载体。
//   * **允许**：Runtime 归档/裁剪树里出现 npm。上游 `@deepseek-ai/dsh` 把 npm 当普通
//     依赖带进来时，它只是被解包多占几 MiB；以前把它整个当禁止项会让一次上游改动
//     莫名其妙地挂在体积门禁上。真正要挡的是"同一份内容交付两遍"（下面的重复检测）
//     与"第二份 portable Node"。
//   * **禁止**：第二份 portable `node.exe`（Electron 自带 Node 24，再带一份纯浪费）。
/** 归档里是否带着第二份 portable Node。 */
const archiveNodeExe = archiveFiles.filter((file) => /(^|\/)node\.exe$/iu.test(file.path) || /(^|\/)bin\/node$/u.test(file.path))
/** 裁剪后的 Runtime 里是否带着 portable Node（打包后落在 app.asar 的 `runtime/`）。 */
const asarRuntimeNodeExe = asarFiles.filter((file) => /^runtime\/(?:.*\/)?node(?:\.exe)?$/iu.test(file.path))

/**
 * npm CLI 的三处落点。
 *
 * `app.asar.unpacked/...` 是**必须存在**的那一份（electron-builder 的 asarUnpack 结果）；
 * 另外两处只要出现就说明同一份 npm 被交付了第二遍，属于体积回归。
 */
const NPM_CLI_SUFFIX = 'node_modules/npm/bin/npm-cli.js'
const minifiedPath = (path) => path.split(/[\\/]/u).join('/')
/**
 * asar 头表里的条目名 → 规范路径。
 *
 * `readAsarFiles` 给解包条目加的是 `" (unpacked)"` 后缀（那是人读的大小报告里要的标记），
 * 这里做判断时先摘掉它，否则同一份文件会被当成两条。同时也丢掉 `' (unpacked)'` 后可能
 * 残留的反斜杠差异——`files` 与 `unpackedFiles` 用不同的分隔符。
 */
const asarRegularPath = (path) => minifiedPath(path.replace(/ \(unpacked\)$/u, ''))
const unpackedNpmCli = unpackedFiles.filter((file) => minifiedPath(file.rel).endsWith(NPM_CLI_SUFFIX))
const asarNpmCli = asarFiles.filter((file) => asarRegularPath(file.path).endsWith(NPM_CLI_SUFFIX) && !file.path.endsWith(' (unpacked)'))
const asarUnpackedNpmCli = asarFiles.filter((file) => file.path.endsWith(`${NPM_CLI_SUFFIX} (unpacked)`))
const archiveNpmCli = archiveFiles.filter((file) => minifiedPath(file.path).endsWith(NPM_CLI_SUFFIX))
/** 解包出来的整棵生产 npm（体积报告用）。 */
const unpackedNpmBytes = unpackedFiles
  .filter((file) => minifiedPath(file.rel).startsWith('node_modules/npm/'))
  .reduce((sum, file) => sum + file.size, 0)

const installer = ['dsh-desktop-x64.exe', 'dsh-desktop-arm64.exe'].map((name) => join(ROOT, 'release', version, name)).find((path) => existsSync(path))
const installerBytes = installer === undefined ? 0 : statSync(installer).size

// ------------------------------------------------------------------ 输出 -----------
const report = {
  version,
  dir: DIR,
  totalBytes,
  fileCount: files.length,
  parts: {
    electron: sizeOf('dsh-desktop.exe'),
    locales: sizeOf('locales'),
    resources: sizeOf('resources'),
    appAsar: existsSync(ASAR) ? statSync(ASAR).size : 0,
    appAsarUnpacked: unpackedBytes,
    runtimeArchive: archiveOnDisk,
    plugins: sizeOf(join('resources', 'plugins')),
    server: sizeOf(join('resources', 'server')),
  },
  runtime: { files: archiveFiles.length, rawBytes: archiveBytes, archiveBytes: archiveOnDisk },
  deepseek: {
    inAsar: [...inAsar].sort(),
    inUnpacked: [...inUnpacked].sort(),
    inArchive: [...inArchive].sort(),
    duplicated: duplicated.sort(),
    archiveBytes: archiveDeepseekBytes,
  },
  forbidden: {
    archiveNodeExe: archiveNodeExe.map((file) => file.path),
    asarRuntimeNodeExe: asarRuntimeNodeExe.map((file) => file.path),
    asarNpmCli: asarNpmCli.map((file) => file.path),
    archiveNpmCli: archiveNpmCli.map((file) => file.path),
  },
  /** 打包 npm CLI 的落点与体积（见上面的"允许/必须/禁止"单子）。 */
  bundledNpm: {
    unpackedCli: unpackedNpmCli.map((file) => file.rel),
    asarUnpackedMarker: asarUnpackedNpmCli.map((file) => file.path),
    unpackedBytes: unpackedNpmBytes,
  },
  installer: { path: installer ?? null, bytes: installerBytes, mib: Number((installerBytes / MIB).toFixed(2)) },
  gate: { limitMib: LIMIT_MIB, stretchMib: STRETCH_MIB },
  // 完整清单也进 JSON：报告与 CI 都要能拿到"最大的 N 个文件 / N 个目录"。
  largestFiles: largestFiles.map((file) => ({ path: file.rel, bytes: file.size })),
  largestDirs: largestDirs.map((dir) => ({ path: dir.path, bytes: dir.size })),
  archiveTopDirs: archiveTopDirs.slice(0, TOP).map((dir) => ({ path: dir.path, bytes: dir.size })),
  archiveJunk,
}

const line = (label, bytes, extra = '') => `  ${label.padEnd(30)} ${mib(bytes).padStart(9)} MiB${extra}`
const list = (items, render, count) => items.slice(0, count).forEach(render)

if (!JSON_ONLY) {
  console.log(`=== 解包产物 ${DIR}`)
  console.log(line('总计（win-unpacked）', totalBytes, `  (${files.length} 个文件)`))
  console.log('')
  console.log('=== 各部分 ===')
  for (const [name, bytes] of Object.entries(report.parts)) {
    console.log(line(name, bytes, name === 'runtimeArchive' ? `  (${mib(archiveBytes)} MiB 解压后)` : ''))
  }
  console.log('')
  console.log('=== 最大的文件 (top 20) ===')
  list(largestFiles, (file) => console.log(`  ${mib3(file.size).padStart(10)} MiB  ${file.rel}`), 20)
  console.log('')
  console.log(`=== 最大的目录 (top 20 / 共 ${new Set(dirSizes(4).map((d) => d.path)).size}) ===`)
  list(largestDirs, (dir) => console.log(`  ${mib(dir.size).padStart(9)} MiB  ${dir.path}`), 20)
  console.log('')
  console.log('=== app.asar 内部 (top 20 目录) ===')
  list(asarTopDirs, (dir) => console.log(`  ${mib(dir.size).padStart(9)} MiB  ${dir.path}`), 20)
  console.log(`  app.asar: ${asarFiles.length} 个条目 / ${mib(asarBytes)} MiB（归档文件本身 ${mib3(report.parts.appAsar)} MiB）`)
  console.log('')
  console.log(`=== 归档内最大的目录 (top 20) ===`)
  console.log(`  归档：${archiveFiles.length} 个文件 / ${mib(archiveBytes)} MiB（磁盘上 ${mib(archiveOnDisk)} MiB）`)
  list(archiveTopDirs, (dir) => console.log(`  ${mib(dir.size).padStart(9)} MiB  ${dir.path}`), 20)
  console.log('')
  console.log('=== 归档内可裁剪类别（候选，必须由 smoke test 证明） ===')
  for (const category of archiveJunk) {
    console.log(`  ${category.label.padEnd(34)} ${mib(category.bytes).padStart(8)} MiB  (${category.files} 个文件)`)
  }
  console.log('')
  console.log('=== @deepseek-ai 副本检查 ===')
  console.log(`  app.asar          : ${inAsar.size} 个包`)
  console.log(`  app.asar.unpacked : ${inUnpacked.size} 个包`)
  console.log(`  runtime 归档      : ${inArchive.size} 个包（${mib(archiveDeepseekBytes)} MiB）`)
  console.log(`  **重复交付**      : ${duplicated.length === 0 ? '无' : duplicated.join(', ')}`)
  console.log('')
  console.log('=== 打包 npm（应用内更新 Runtime 用） ===')
  console.log(`  解包后的 npm CLI  : ${unpackedNpmCli.length > 0 ? unpackedNpmCli.map((f) => f.rel).join(', ') : '**缺失**'}`)
  console.log(`  解包后的 npm 体积 : ${mib(unpackedNpmBytes)} MiB`)
  console.log(`  app.asar 内 npm   : ${asarNpmCli.length === 0 ? '无（只有 unpacked 条目）' : asarNpmCli.map((f) => f.path).join(', ')}`)
  console.log('')
  console.log('=== 禁止项 ===')
  console.log(`  归档内第二份 node  : ${archiveNodeExe.length === 0 ? '无' : archiveNodeExe.map((f) => `${f.path}（${mib(f.size)} MiB）`).join(', ')}`)
  console.log(`  asar 内第二份 node: ${asarRuntimeNodeExe.length === 0 ? '无' : asarRuntimeNodeExe.map((f) => f.path).join(', ')}`)
  console.log('')
  console.log('=== Size Gate ===')
  if (installer === undefined) {
    console.log(`  NSIS 安装包：尚未构建（--dir 只产出 win-unpacked）`)
    console.log(`  目标：<= ${LIMIT_MIB} MiB（第二阶段 <= ${STRETCH_MIB} MiB）`)
  } else {
    const passed = installerBytes <= LIMIT_MIB * MIB
    console.log(`  NSIS 安装包：${mib(installerBytes)} MiB（${installerBytes} 字节）`)
    console.log(`  门槛 <= ${LIMIT_MIB} MiB：${passed ? 'PASS' : 'FAIL'}${installerBytes <= STRETCH_MIB * MIB ? `，且已达 stretch (<= ${STRETCH_MIB} MiB)` : ''}`)
  }
}

if (JSON_ONLY) console.log(JSON.stringify(report, null, 2))

// `--out <file>`：把同一份 JSON 落盘（**由脚本自己写**，避免不同 shell 的重定向编码差异
// 把一个 UTF-8 的 JSON 写成 UTF-16）。
const outPath = argValue('--out', undefined)
if (outPath !== undefined) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(resolve(ROOT, outPath), JSON.stringify(report, null, 2) + '\n')
  if (!JSON_ONLY) console.log(`\nJSON 已写入 ${outPath}`)
}

// ------------------------------------------------------------------ 退出码 ---------
const problems = []
if (duplicated.length > 0) problems.push(`@deepseek-ai 重复交付：${duplicated.join(', ')}`)
if (archiveNodeExe.length > 0) problems.push('runtime 归档里仍带第二份 portable Node')
if (asarRuntimeNodeExe.length > 0) problems.push(`app.asar 的 runtime/ 里仍带 portable Node：${asarRuntimeNodeExe.map((f) => f.path).join(', ')}`)
// 打包 npm 是**必须项**：没有它，应用内更新 Runtime 就只能退回"打开 Release"。
if (unpackedNpmCli.length === 0) {
  problems.push('app.asar.unpacked 里缺少 node_modules/npm/bin/npm-cli.js（应用内更新 Runtime 依赖它）')
}
// 同一份 npm 出现在三处中的多处 = 体积回归（它不是被 require 的库，只需要解包那一份）。
if (asarNpmCli.length > 0) problems.push('app.asar 里仍带一份 npm CLI（应只保留解包后的那一份）')
if (archiveNpmCli.length > 0) problems.push('裁剪后的 Runtime 里仍带一份 npm CLI（应由应用自己携带）')
if (installer !== undefined && installerBytes > LIMIT_MIB * MIB) problems.push(`NSIS ${mib(installerBytes)} MiB > ${LIMIT_MIB} MiB`)

if (problems.length > 0) {
  console.error('')
  console.error('Size Gate 未通过：')
  for (const problem of problems) console.error(`  * ${problem}`)
  process.exit(1)
}
if (!JSON_ONLY) {
  console.log('')
  console.log('Size Gate 通过。')
}
