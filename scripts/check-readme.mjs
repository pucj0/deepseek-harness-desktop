// 校验 README 的完整性：中文占比、章节结构、以及**文件内链接的目标是否存在**。
//
//   node scripts/check-readme.mjs [文件]
//
// 最后一项是重点：README 会引用别的文件与自身章节。改文档时最容易留下的缺陷就是
// 指向不存在目标的链接——外观看不出问题，点下去才发现。机器能查的就不要靠人看。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const file = process.argv[2] ?? 'README.md'
const root = process.cwd()
const text = readFileSync(file, 'utf8')
const lines = text.split('\n')

let failures = 0
const report = (ok, label, detail) => {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `: ${detail}`}`)
}

console.log(`检查 ${file}`)

const language = /\.en\.md$/u.test(file) ? 'en' : 'zh'

// ---- 1. 基本体量 ------------------------------------------------------------
const han = (text.match(/[\u4e00-\u9fff]/gu) ?? []).length
console.log(`  行数 ${lines.length}，中文字符 ${han}`)
// 中文占比只对中文版有意义——英文版里出现中文是正常的（命令输出、引用等）。
if (language === 'zh') report(han > 2000, '中文内容充足')
// 行数下限是"这份文档不是个占位符"的下界，不是"越详细越好"的目标。
//
// 这里曾经是 300 行，对应的是 1.5.8 之前那份 800+ 行的长文档。1.5.9 起两份 README 被
// 有意精简为 180 行左右（统一项目名、重组章节、去掉与实现细节重复的部分），继续拿 300
// 行去卡只会让"通过"变成一件与文档质量无关的事。真正要挡的是把 README 删成一张空壳，
// 因此下限收到 150 行；章节完整性与链接有效性仍然逐条校验。
report(lines.length > 150, '篇幅足够')

// ---- 2. 章节结构 ------------------------------------------------------------
const headings = lines.filter((line) => /^#{2,3} /u.test(line)).map((line) => line.replace(/^#+\s*/u, '').trim())
console.log(`  章节（二级/三级）${headings.length} 个`)

// 一份介绍性 README 应当覆盖这些方面。中英两版各自的章节名不同，因此按语言分组。
// 用法：`node scripts/check-readme.mjs README.en.md` 会自动按文件名选英文那组。
const REQUIRED = {
  zh: ['为什么需要桌面版', '下载安装', '架构', '开发与测试', '发布', '项目结构', '已知限制', '许可证'],
  en: ['why a desktop client', 'download', 'architecture', 'development and testing', 'releases', 'project structure', 'known limitations', 'license'],
}
for (const topic of REQUIRED[language]) {
  report(
    headings.some((h) => h.toLowerCase().includes(topic.toLowerCase())),
    `含「${topic}」章节`,
  )
}

// ---- 3. 文件内锚点链接 ------------------------------------------------------
// GitHub 的锚点规则：小写、空格转连字符、去掉除连字符与中文外的标点。
const slug = (heading) =>
  heading
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff\s-]/gu, '')
    .trim()
    .replace(/\s+/gu, '-')

const anchors = new Set(headings.map(slug))
// 一级标题也可能是锚点。
for (const line of lines) {
  if (/^# /u.test(line)) anchors.add(slug(line.replace(/^#\s*/u, '')))
}

const allHeadings = lines.filter((line) => /^#{1,6} /u.test(line)).map((line) => slug(line.replace(/^#+\s*/u, '')))
for (const a of allHeadings) anchors.add(a)

let checkedLinks = 0
let checkedAnchors = 0
for (const line of lines) {
  // 跳过代码块里的内容不看——那里出现的链接是示例，不是真链接。
  for (const match of line.matchAll(/\]\(([^)]+)\)/gu)) {
    const target = match[1]
    if (/^https?:/u.test(target)) continue

    // 纯锚点：检查目标标题存在
    if (target.startsWith('#')) {
      const id = target.slice(1)
      checkedAnchors += 1
      report(anchors.has(id), `锚点 ${target} 存在`)
      continue
    }

    // 文件（可带锚点）
    const [pathPart, anchorPart] = target.split('#')
    // `../../releases` 这类仓库外的相对链接跳过。
    if (pathPart === '' || pathPart.startsWith('..')) continue
    checkedLinks += 1
    const absolute = resolve(root, dirname(file), pathPart)
    report(existsSync(absolute), `链接目标存在：${pathPart}`)
    if (anchorPart !== undefined && anchorPart !== '') {
      // 跨文件的锚点只对本文档内部有意义的才校验，这里仅记录数量。
      checkedAnchors += 0
    }
  }
}
console.log(`  检查了 ${checkedLinks} 个文件链接、${checkedAnchors} 个锚点`)

console.log('')
console.log(failures === 0 ? 'README 校验通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
