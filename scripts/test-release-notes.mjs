// 钉住"Release 正文只包含**本次版本**的说明"。
//
//   node scripts/test-release-notes.mjs
//
// 为什么需要它：v1.4.4 的 GitHub Release 正文里带着 1.4.3、1.4.2、……一直回到 1.3.1 的
// 全部更新说明——因为 `RELEASE_NOTES.md` 是**累积的变更日志**，而发布工作流当时是
// `cat RELEASE_NOTES.md` 整篇塞进正文。这类错误在本地完全看不出来（文件是好好的、
// release.mjs 的校验也过），只有发完之后点开 Release 页面才会发现。
//
// 因此这里同时钉三件事：
//   1. 取一节的规则本身（边界、版本号不能前缀误配、缺版本要报错）；
//   2. **整份文件里取出来的正文不许含任何其它版本的标题**（就是上面那个 bug 的形状）；
//   3. 发布工作流确实在用它，而不是又退回 `cat`（源码文本断言，和 graph-layout 的
//      parity 测试同一手法：契约在文件里，就断言文件里）。
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractReleaseNotes, listReleaseNoteVersions } from './release-notes.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const NOTES = readFileSync(join(ROOT, 'RELEASE_NOTES.md'), 'utf8')
const WORKFLOW = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8')
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `（期望 ${expected}）`}`)
}
const checkTrue = (label, actual) => check(label, actual === true, true)

console.log('=== 1. 取一节的规则 ===')
{
  const fixture = [
    '# 2.0.0',
    '',
    '本次的大改动。',
    '',
    '## 变更',
    '',
    '- 甲',
    '',
    '---',
    '',
    '# 1.9.9',
    '',
    '旧版本的说明。',
    '',
    '---',
    '',
    '# 1.9.8',
    '',
    '更旧的说明。',
    '',
  ].join('\n')
  const top = extractReleaseNotes(fixture, '2.0.0')
  check('1) 取到第一节（含标题）', top.startsWith('# 2.0.0') && top.includes('本次的大改动') && top.includes('- 甲'), 'true')
  // 关键：正文里**不能**出现下一个版本的标题，也不能出现它后面的内容。
  check('   不含下一个版本的内容', top.includes('旧版本的说明'), 'false')
  check('   不含分隔线（它是版本之间的，不属于任何一版）', top.includes('---'), 'false')
  const mid = extractReleaseNotes(fixture, '1.9.9')
  check('   中间一节只含自己', mid, '# 1.9.9\n\n旧版本的说明。')
  const last = extractReleaseNotes(fixture, '1.9.8')
  check('   最后一节到文件末尾', last, '# 1.9.8\n\n更旧的说明。')
  check('   版本清单', listReleaseNoteVersions(fixture).map((entry) => entry.version).join(','), '2.0.0,1.9.9,1.9.8')
}

console.log('')
console.log('=== 2. 版本号必须整段匹配 ===')
{
  const fixture = '# 1.4.40\n\n四十。\n\n---\n\n# 1.4.4\n\n四。\n\n---\n\n# 1.4.4-rc.1\n\n候选。\n'
  check('2) 1.4.4 拿到的是 1.4.4 那一节', extractReleaseNotes(fixture, '1.4.4'), '# 1.4.4\n\n四。')
  check('   1.4.40 不被 1.4.4 误配', extractReleaseNotes(fixture, '1.4.40'), '# 1.4.40\n\n四十。')
  // 预发布版本的写法是 `1.4.4-rc.1`，标题里含 `1.4.4` —— 这时取正式版仍必须命中正式版那一节。
  checkTrue('   预发布标题不会把 1.4.4 抢走', extractReleaseNotes(fixture, '1.4.4') === '# 1.4.4\n\n四。')
}

console.log('')
console.log('=== 3. 缺版本 / 空文件要明确报错（而不是静默发一篇空正文）===')
{
  const missing = (() => {
    try {
      extractReleaseNotes('# 1.0.0\n\n旧。\n', '9.9.9')
      return 'no-error'
    } catch (error) {
      return error.message.includes('9.9.9') ? 'named' : `other:${error.message}`
    }
  })()
  check('3) 找不到版本时抛错且带上版本号', missing, 'named')
  const empty = (() => {
    try {
      extractReleaseNotes('', '1.0.0')
      return 'no-error'
    } catch {
      return 'error'
    }
  })()
  check('   空文件也抛错', empty, 'error')
}

console.log('')
console.log('=== 4. 真实的 RELEASE_NOTES.md：本版本的正文里不许有别的版本 ===')
{
  const versions = listReleaseNoteVersions(NOTES).map((entry) => entry.version)
  checkTrue('4) 文件里有多个版本（正是这个 bug 的前提）', versions.length >= 2)
  const body = extractReleaseNotes(NOTES, MANIFEST.version)
  checkTrue('   本版本的正文非空', body.length > 200)
  // 这就是 v1.4.4 那次事故的直接断言：正文里出现任何**别的**版本标题都算失败。
  const leaked = versions.filter((version) => version !== MANIFEST.version && new RegExp(`^#\\s+${version}\\s*$`, 'mu').test(body))
  check('   正文里没有别的版本标题', leaked.join(',') || '（无）', '（无）')
  // 也检查"别的版本的正文内容"没被带进来：各节的第一行**正文**（跳过 `# 版本` 标题）
  // 不该出现在本版正文里。
  const firstLineOf = (version) => extractReleaseNotes(NOTES, version).split('\n').filter((line) => line.trim() !== '')[1] ?? ''
  const foreignLines = versions
    .filter((version) => version !== MANIFEST.version)
    .map((version) => firstLineOf(version))
    .filter((line) => line !== '' && body.includes(line))
  check('   正文里没有别的版本的正文首行', foreignLines.length, 0)
  check('   正文长度远小于整份文件', body.length < NOTES.length / 2, 'true')
}

console.log('')
console.log('=== 5. 发布工作流用的是"取一节"，不是"整篇 cat" ===')
{
  // 契约在文件里，就断言文件里：这两条一起才能防住"某次重构又改回 cat"。
  checkTrue('5) 工作流调用了 release-notes.mjs', WORKFLOW.includes('scripts/release-notes.mjs --extract'))
  checkTrue('   工作流按标签取版本号', WORKFLOW.includes('${GITHUB_REF_NAME#v}'))
  // `cat RELEASE_NOTES.md` 是那次事故的写法；现在只允许 `cat notes.md`（取出来的那一节）。
  //
  // 断言前先剥掉 YAML 注释行：工作流里那段说明**故意**把旧写法写在注释里（"不要再改回
  // `cat RELEASE_NOTES.md`"），否则这条断言会被自己的注释绊倒。
  const executable = WORKFLOW.split('\n')
    .filter((line) => !/^\s*#/u.test(line))
    .join('\n')
  checkTrue('   不再把整份说明文件打进正文', !executable.includes('cat RELEASE_NOTES.md'))
}

console.log('')
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
