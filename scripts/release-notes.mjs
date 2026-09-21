// 从 RELEASE_NOTES.md 里取出**某一个版本**的说明。
//
//   node scripts/release-notes.mjs --list              列出文件里有说明的所有版本
//   node scripts/release-notes.mjs --extract 1.4.4     打印 1.4.4 那一节（缺了就非零退出）
//   node scripts/release-notes.mjs --check             校验 package.json 的版本有对应的一节
//
// 为什么需要它（这一条是踩出来的）：`RELEASE_NOTES.md` 是**累积的变更日志**——每个版本
// 在文件顶部新增一节，旧版本用 `---` 分隔留在下面（用户可以在仓库里翻历史）。而发布工作流
// 一度是 `cat RELEASE_NOTES.md` 整篇塞进 Release 正文，于是 v1.4.4 的正文里带着 1.4.3、
// 1.4.2、……一直回到 1.3.1 的全部说明：用户点开"本次更新"，看到的是一年半的更新日志。
//
// 根因不是"某处写错了一行"，而是**两个约定互相矛盾**：文件是日志（累积），CI 却当它是
// "本次说明"（单篇）。因此这里把"取哪一段"抽成唯一实现，让三处共用同一套边界规则：
//   * `.github/workflows/release.yml` 用 `--extract` 生成正文；
//   * `scripts/release.mjs` 在打标签**之前**用它校验；
//   * `scripts/test-release-notes.mjs` 直接对它做断言（含"正文里不许出现别的版本"）。
//
// 边界规则（刻意简单，因为文件是手写的）：
//   * 一节从 `# <版本>` 这一行开始；
//   * 到**下一个** `# ` 标题之前结束（`---` 分隔线与它前后的空行不算内容）；
//   * 版本号按"标题里出现该版本号"匹配，且必须是**完整的版本号片段**——`1.4.4` 不能匹配
//     `1.4.40`，也不能匹配 `1.4.4-rc.1` 的前缀（后者的标题写法不同，见下面的 token 规则）。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 默认的说明文件位置（相对仓库根）。 */
export const NOTES_PATH = resolve(import.meta.dirname, '..', 'RELEASE_NOTES.md')

/** 一个版本号 token 的正则（用于在标题里精确匹配，避免 `1.4.4` 命中 `1.4.40`）。 */
function versionToken(version) {
  return new RegExp(`(^|[^0-9A-Za-z.-])${version.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}([^0-9A-Za-z.-]|$)`, 'u')
}

/**
 * 列出文件里所有版本的标题。
 *
 * @param text - 文件内容。
 * @returns 版本号数组（文件顺序，通常是新→旧）。
 */
export function listReleaseNoteVersions(text) {
  const versions = []
  for (const line of String(text).replace(/\r\n?/gu, '\n').split('\n')) {
    const match = /^#\s+(.+?)\s*$/u.exec(line)
    if (match === null) continue
    const token = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u.exec(match[1])
    if (token !== null) versions.push({ version: token[1], title: match[1] })
  }
  return versions
}

/**
 * 取出某个版本的说明。
 *
 * 返回值**包含** `# <版本>` 这一行：Release 正文历来就是这个形状（v1.0.1…v1.4.4 的正文都以
 * `# x.y.z` 开头），去掉标题会让"修复后的历史"与"以后发布的"长得不一样。尾部那个 `---`
 * 只是版本之间的视觉分隔，不属于任何一版，会被去掉。
 *
 * @param text - `RELEASE_NOTES.md` 的内容。
 * @param version - 目标版本号（不带 `v` 前缀）。
 * @returns 该版本的整节正文（以 `# <版本>` 开头）。
 * @throws 当文件里没有该版本时抛出可读的错误（消息里列出实际有的版本）。
 */
export function extractReleaseNotes(text, version) {
  const normalized = String(text).replace(/\r\n?/gu, '\n')
  const lines = normalized.split('\n')
  const token = versionToken(version)

  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    const heading = /^#\s+(.+?)\s*$/u.exec(lines[i])
    if (heading === null) continue
    if (token.test(heading[1]) || heading[1] === version) {
      start = i
      break
    }
  }
  if (start < 0) {
    const known = listReleaseNoteVersions(normalized).map((entry) => entry.version)
    throw new Error(`RELEASE_NOTES.md 里没有 ${version} 的说明（现有：${known.join(', ') || '（空）'}）`)
  }

  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#\s+/u.test(lines[i])) {
      end = i
      break
    }
  }

  return lines
    .slice(start, end)
    .join('\n')
    // 去掉结尾的分隔线与空行（见上面关于 `---` 的说明）。
    .replace(/\n*-{3,}\s*$/u, '')
    .trim()
}

/**
 * 命令行入口。
 * @returns 无（直接写 stdout/stderr 并退出）。
 */
function main() {
  const args = process.argv.slice(2)
  const file = resolve(process.env.DSH_RELEASE_NOTES ?? NOTES_PATH)
  const text = readFileSync(file, 'utf8')

  if (args.includes('--list')) {
    for (const entry of listReleaseNoteVersions(text)) console.log(entry.version)
    return
  }

  const extractIndex = args.indexOf('--extract')
  if (extractIndex >= 0) {
    const version = args[extractIndex + 1]
    if (version === undefined) {
      console.error('用法：node scripts/release-notes.mjs --extract <版本>')
      process.exit(1)
    }
    try {
      // 只打印正文：调用方（CI）会把 stdout 原样当 Release 正文。
      const body = extractReleaseNotes(text, version.replace(/^v/u, ''))
      process.stdout.write(`${body}\n`)
    } catch (error) {
      console.error(`::error::${error.message}`)
      process.exit(1)
    }
    return
  }

  // 默认（含 --check）：用 package.json 的版本校验一次。
  const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8'))
  const versions = listReleaseNoteVersions(text)
  let body
  try {
    body = extractReleaseNotes(text, manifest.version)
  } catch (error) {
    console.error(error.message)
    console.error(`请先在 RELEASE_NOTES.md 顶部写上「# ${manifest.version}」那一节。`)
    process.exit(1)
  }
  console.log(`package.json 版本: ${manifest.version}`)
  console.log(`文件里的版本（新→旧）: ${versions.map((entry) => entry.version).join(', ')}`)
  console.log(`本次说明: ${body.length} 字符`)
  if (versions[0]?.version !== manifest.version) {
    // 不是错误，但值得提醒：CI 只取对应的一节，然而"最新的一节就是本次待发布的那一节"
    // 是维护者一眼看懂文件的前提。
    console.log(`提醒：文件顶部是 ${versions[0]?.version ?? '（无）'}，不是 ${manifest.version}。`)
  }
  process.exit(0)
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main()
}
