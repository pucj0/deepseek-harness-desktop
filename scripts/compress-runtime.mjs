// 把 runtime 目录瘦身并打成**单个 brotli 压缩包**，供安装包携带。
//
//   node scripts/compress-runtime.mjs [--keep]
//
// 为什么这样做：runtime 有 27 400 个文件、314 MB，而其中大半在运行期用不到
// （.ts 源文件、.map、.d.ts、.pdb 调试符号、非本平台二进制、Node 自带的 npm）。
// 瘦身后约 199 MB，brotli q6 压到约 51 MB。q11 再省约 11 MB，
// 但每个平台构建都要多等约 10 分钟；发布速度优先使用 q6。
//
// 实测过的取舍：
//   zstd 19  = 55 MB / 2 秒
//   brotli 11 = 40.5 MB / 10 分钟
// 仍用 brotli 归档格式，现以 q6 平衡下载大小和构建时间。
//
// 归档格式是自己定义的（不用 tar），因为 Node 内置没有 tar 写入器、也不想为此加依赖：
//   magic "DSHRT1\n" + 若干记录；每条记录 = 4 字节头长度 + JSON 头 + 文件内容。
// 整体再套一层 brotli。JSON 头里存相对路径与可执行位，解包时还原。
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { createBrotliCompress, constants } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const SOURCE = resolve(option('source') ?? join(ROOT, 'runtime'))
const OUTPUT = resolve(option('output') ?? join(ROOT, 'build', 'runtime.br'))
const QUALITY = Number(option('quality') ?? 6)
if (!Number.isInteger(QUALITY) || QUALITY < 0 || QUALITY > 11) throw new Error('quality must be an integer from 0 to 11')
const MAGIC = 'DSHRT1\n'

/** 运行期用不到的文件名/扩展名。 */
const DROP_FILE = [
  /\.map$/u,
  /\.d\.ts$/u,
  /\.d\.mts$/u,
  /\.ts$/u,
  /\.mts$/u,
  /\.md$/u,
  /\.markdown$/u,
  /\.flow$/u,
  // 调试符号：纯调试用途，node-pty 的 conpty 符号单独就有约 10MB。
  /\.pdb$/u,
  /\.ilk$/u,
  /\.exp$/u,
  /\.lib$/u,
  // 每个包都带一份的许可证与变更日志。
  /^LICENSE$/iu,
  /^LICENCE$/iu,
  /^LICENSE\.(txt|md)$/iu,
  /^CHANGELOG(\..*)?$/iu,
  /^HISTORY(\..*)?$/iu,
  /^AUTHORS(\..*)?$/iu,
  // 测试夹具。
  /^html5lib-tests\.json$/u,
]

/** 按路径后缀剔除整个目录。 */
const DROP_DIR = [
  // Node 分发自带的 npm 与 corepack：外壳用自己那份 npm 做更新，这份用不到。
  join('node', 'node_modules'),
  // 非本平台（win32-x64）的预编译二进制。
  'win32-arm64',
  'darwin',
  'linux-x64',
  'linux-arm64',
  'linux-arm',
  join('third_party', 'conpty', '1.25.260303002', 'win10-arm64'),
]

/** 收集要打包的文件（已剔除无关者），返回相对路径、绝对路径、大小与可执行位。 */
function collect() {
  const files = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        if (DROP_DIR.some((fragment) => path.endsWith(fragment))) continue
        walk(path)
        continue
      }
      if (!entry.isFile()) continue
      if (DROP_FILE.some((pattern) => pattern.test(entry.name))) continue
      const stats = statSync(path)
      const archivePath = relative(SOURCE, path).split('\\').join('/')
      // The shell refreshes these beside node_modules when launching. Including
      // development copies would invalidate the runtime on shell-only updates.
      if (archivePath === 'server.mjs' || archivePath === 'client-module-cache.mjs') continue
      // Staging timestamps do not change the runtime. Keep archive identity stable
      // when rebuilding only the Electron shell, without changing staged files.
      let content
      if (archivePath === 'runtime.json' || archivePath === 'node/node-runtime.json') {
        const metadata = JSON.parse(readFileSync(path, 'utf8'))
        delete metadata.stagedAt
        delete metadata.downloadedAt
        content = Buffer.from(JSON.stringify(metadata, null, 2) + '\n')
      }
      files.push({
        path: archivePath,
        absolute: path,
        size: content?.length ?? stats.size,
        content,
        // 解包到 Linux/macOS 时要还原可执行位，否则 node/node.exe 之类无法运行。
        mode: stats.mode & 0o111 ? 0o755 : 0o644,
      })
    }
  }
  walk(SOURCE)
  return files
}

const files = collect()
const keptBytes = files.reduce((sum, file) => sum + file.size, 0)
console.log(`[compress] 保留 ${files.length} 个文件 / ${(keptBytes / 1048576).toFixed(1)} MB`)

/**
 * 生成归档的字节流：先写 magic，再逐条写记录。
 * 用生成器避免把 188MB 一次性读进内存。
 * @returns 异步生成器，产出 Buffer。
 */
async function* archive() {
  yield Buffer.from(MAGIC, 'utf8')
  for (const file of files) {
    const header = Buffer.from(JSON.stringify({ path: file.path, size: file.size, mode: file.mode }), 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32LE(header.length, 0)
    yield length
    yield header
    // 逐块读文件内容，避免大文件占满内存。
    if (file.content !== undefined) yield file.content
    else for await (const chunk of createReadStream(file.absolute)) yield chunk
  }
  // 结束哨兵：头长度为 0。
  const end = Buffer.alloc(4)
  end.writeUInt32LE(0, 0)
  yield end
}

mkdirSync(dirname(OUTPUT), { recursive: true })
rmSync(OUTPUT, { force: true })
const started = Date.now()
const contentHash = createHash('sha256')
async function* hashedArchive() {
  for await (const chunk of archive()) {
    contentHash.update(chunk)
    yield chunk
  }
}
await pipeline(
  hashedArchive(),
  createBrotliCompress({
    params: {
      [constants.BROTLI_PARAM_QUALITY]: QUALITY,
      [constants.BROTLI_PARAM_LGWIN]: 24,
      [constants.BROTLI_PARAM_SIZE_HINT]: keptBytes,
    },
  }),
  createWriteStream(OUTPUT),
)

const outSize = statSync(OUTPUT).size
/** 记录包内清单与统计，供外壳诊断显示。 */
writeFileSync(
  join(dirname(OUTPUT), 'runtime.json'),
  JSON.stringify(
    {
      format: 'dsh-runtime-archive',
      version: 1,
      files: files.length,
      rawBytes: keptBytes,
      archiveBytes: outSize,
      contentHash: contentHash.digest('hex'),
      codec: `brotli-q${QUALITY}`,
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  ) + '\n',
)

console.log(
  `[compress] ${(outSize / 1048576).toFixed(1)} MB  (${((Date.now() - started) / 1000).toFixed(1)}s)  ->  ${relative(ROOT, OUTPUT)}`,
)
