// 修复**已发布**的 Release 正文：把它裁剪成"只有本次版本"的说明。
//
//   node scripts/repair-release-notes.mjs            # 只报告将要做什么（默认 dry-run）
//   node scripts/repair-release-notes.mjs --apply     # 真的改（需要 GitHub 凭据）
//   node scripts/repair-release-notes.mjs --apply --only v1.4.4
//
// 为什么需要它：发布工作流曾经是 `cat RELEASE_NOTES.md` 整篇塞进正文，于是 v1.4.4 的
// Release 里带着 1.4.3、1.4.2、……一直回到 1.3.1 的全部说明（那个写法已在
// `.github/workflows/release.yml` 里改掉，并由 `scripts/test-release-notes.mjs` 钉住）。
// 已经发出去的那几个版本还得修——这正是本脚本做的事。
//
// 修复规则（与 CI 现在生成的形状一致）：
//   正文 = 该标签**当时**的 RELEASE_NOTES.md 里对应那一节
//        + 固定的"安装包 / 注意事项"尾注（直接从工作流里读出来，保证与以后发的一致）
//        + 原有的 `**Full Changelog**: …`（GitHub 自动附的那一行，PATCH 时必须自己带上）
//
// 只改正文：标题、标签、附件、发布时间一律不动。默认 dry-run，且幂等（正文已经正确就跳过）。
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { extractReleaseNotes } from './release-notes.mjs'

const REPO = 'pucj0/deepseek-harness-desktop'
/**
 * 改动之前先把原文备份下来。
 *
 * 发布正文是**外部可见**的东西，改它必须留一条退路：万一裁错了，直接拿备份 PATCH 回去即可
 * （脚本本身就是"把 body 设成某个字符串"，所以恢复只是一次同形状的调用）。
 */
const BACKUP_DIR = join(tmpdir(), `dsh-release-bodies-${Date.now()}`)
const args = process.argv.slice(2)
const apply = args.includes('--apply')
const onlyIndex = args.indexOf('--only')
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined
/**
 * 忽略"看起来已经没问题"这条跳过规则。
 *
 * 用途：裁剪规则本身改过之后（例如决定正文要不要保留 `# <版本>` 标题），需要把已经处理过的
 * 版本再套用一遍——那时它的正文只含一个版本标题，会被正常规则跳过。
 */
const redo = args.includes('--redo')

/**
 * 从发布工作流里读出固定的正文尾注。
 *
 * 从工作流读而不是在本脚本里再抄一份：抄一份就等于有了第二个真相来源，而"以后发布的正文
 * 与修复后的历史正文不一致"是那种没人会去比对的不一致。
 *
 * @returns 尾注 markdown（不含结尾换行）。
 */
function readFooter() {
  const workflow = readFileSync(resolve(import.meta.dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8')
  const lines = workflow.split('\n')
  const bodyAt = lines.findIndex((line) => /^\s*body:\s*\|/u.test(line))
  if (bodyAt < 0) throw new Error('发布工作流里找不到 `body: |`')
  const indent = lines[bodyAt].match(/^\s*/u)[0].length
  const block = []
  for (let i = bodyAt + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() !== '' && line.match(/^\s*/u)[0].length <= indent) break
    block.push(line.slice(indent + 2))
  }
  // 第一行是 `${{ steps.notes.outputs.body }}`（本次说明的占位），去掉它。
  const withoutNotes = block.slice(block.findIndex((line) => line.includes('steps.notes.outputs.body')) + 1)
  return withoutNotes.join('\n').replace(/\s+$/u, '')
}

/**
 * 取某个标签当时的发布说明。
 *
 * @param tag - 形如 `v1.4.4`。
 * @returns 该版本的说明正文，或 undefined（那个标签上还没有 RELEASE_NOTES.md）。
 */
function notesAtTag(tag) {
  let text
  try {
    // stderr 要吞掉：老标签上根本没有这个文件，`git show` 的 fatal 只会把输出淹掉。
    text = execFileSync('git', ['show', `${tag}:RELEASE_NOTES.md`], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return undefined
  }
  try {
    return extractReleaseNotes(text, tag.replace(/^v/u, ''))
  } catch {
    return undefined
  }
}

/**
 * 从"已经发错"的正文里切出应当保留的尾部（附件清单/注意事项/Full Changelog）。
 *
 * 刻意保留**当时那一份**尾部，而不是用工作流里现在的版本重建：历史上附件表的写法变过
 * （早期还有 `.msi`），重建会把老版本的正文改成"今天的说明"，那是另一种失真——这次修复
 * 只该去掉"混进来的旧版本说明"，别的一律不动。
 *
 * @param body - 当前正文。
 * @returns 要保留的尾部（以 `---` 开头），或 undefined（找不到标记）。
 */
function keepTail(body) {
  const marker = '\n---\n\n### 安装包'
  const at = body.lastIndexOf(marker)
  if (at < 0) return undefined
  return body.slice(at + 1)
}

/** GitHub token：与 backfill-release-notes.mjs 同一做法（走 git 的凭据助手）。 */
function githubToken() {
  const filled = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  })
  const line = filled.split('\n').find((entry) => entry.startsWith('password='))
  if (line === undefined) throw new Error('git credential fill 没给出 password（先在终端登录一次 GitHub）')
  return line.slice('password='.length).trim()
}

const footer = readFooter()
console.log(`尾注: ${footer.length} 字符（读自 .github/workflows/release.yml）`)
console.log(apply ? '模式: --apply（会真的改 GitHub Release 正文）' : '模式: dry-run（只报告；加 --apply 才写）')

const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-desktop-repair-notes' }
if (apply) headers.authorization = `Bearer ${githubToken()}`

const releases = await (await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, { headers })).json()
if (!Array.isArray(releases)) throw new Error(`列出 Release 失败：${JSON.stringify(releases).slice(0, 300)}`)

let changed = 0
let skipped = 0
for (const release of releases) {
  const tag = release.tag_name
  if (only !== undefined && tag !== only) continue
  const current = String(release.body ?? '')
  // **只修真正发错的那一种**：正文里出现了不止一个版本标题。已经正确的老版本一律不动
  // （它们的附件表/注意事项是当时的写法，重写等于把历史改成今天的样子）。
  const headings = current.match(/^#\s+\d+\.\d+\.\d+/gmu) ?? []
  if (headings.length <= 1 && !redo) {
    console.log(`${tag}: 正文里只有 ${headings.length} 个版本标题，无需修复`)
    skipped += 1
    continue
  }
  const notes = notesAtTag(tag)
  if (notes === undefined) {
    console.log(`${tag}: 正文混了多个版本，但该标签上没有可取的说明（无从裁剪），跳过`)
    skipped += 1
    continue
  }
  const changelog = /^\*\*Full Changelog\*\*: .*$/mu.exec(current)?.[0]
  const tail =
    keepTail(current) ??
    // 找不到附件表标记（理论上不会发生）：退回用工作流里现在的尾部，并保留 Full Changelog 行。
    `---\n\n${footer}${changelog === undefined ? '' : `\n\n${changelog}`}\n`
  const next = `${notes}\n\n${tail}`.replace(/\s+$/u, '') + '\n'
  console.log(`${tag}: ${current.length} 字符（含 ${headings.length} 个版本标题）→ ${next.length} 字符（只留 ${tag.replace(/^v/u, '')}）`)
  if (!apply) {
    changed += 1
    continue
  }  // 备份原文（见 BACKUP_DIR 的说明）。
  mkdirSync(BACKUP_DIR, { recursive: true })
  writeFileSync(join(BACKUP_DIR, `${tag}.md`), current)
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/${release.id}`, {
    method: 'PATCH',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ body: next }),
  })
  if (response.status === 200) {
    changed += 1
    console.log('  已更新')
  } else {
    console.log(`  失败(${response.status})：${(await response.text()).slice(0, 200)}`)
  }
}

console.log('')
if (apply) {
  console.log(`共修复 ${changed} 个 Release，跳过 ${skipped} 个`)
  console.log(`原文备份: ${BACKUP_DIR}`)
} else {
  console.log(`将有 ${changed} 个 Release 需要修复，跳过 ${skipped} 个（dry-run，未做改动）`)
  console.log('确认无误后加 --apply 执行；先单个试可以用 --apply --only v1.4.4')
}
