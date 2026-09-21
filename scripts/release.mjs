// 发布一个新版本：递增版本号、提交、打标签、推送，并触发 CI。
//
//   node scripts/release.mjs              按递增序列发下一个版本（1.0.0 → 1.0.1 → …）
//   node scripts/release.mjs 1.0.3        指定版本号，但**必须**与序列一致
//   node scripts/release.mjs 2.0.0 --force 真正需要跳出序列时才用
//   node scripts/release.mjs --dry-run    只打印将要发生的事，不改任何东西
//
// 存在的理由：手工发布踩过两次严重的坑。
//
//   1. 先 `version.mjs next`（得到 1.0.1），却把标签打成了 `v1.1.0`。结果 CI 构建出
//      1.0.1 的安装包、挂到名为 v1.1.0 的 Release 上，自动更新 metadata 里的版本号
//      与标签不符，用户会收到"有新版本"却永远装不上。
//   2. 用显式版本号跳过了整段补丁号（1.1.0 → 1.2.0，跳掉 1.1.1…1.1.9）。
//      本项目的规则是**先在次版本内走完补丁号**：1.0.0 → … → 1.0.9 → 1.1.0。
//
// 所以本脚本在打标签之前强制核对：
//   * package.json 的 version 与要打的标签一致
//   * package-lock.json 同步（否则 CI 的 npm ci 会失败）
//   * package.json 已提交（未提交时 CI 拿到的是旧版本号）
//   * 显式指定的版本号必须等于序列给出的下一个版本，除非显式加了 --force
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { extractReleaseNotes } from './release-notes.mjs'
import { next, readVersion, writeVersion } from './version.mjs'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const force = args.includes('--force')
const explicit = args.find((token) => !token.startsWith('-'))

/** 跑一条 git 命令并返回输出。 */
function git(...argv) {
  return execFileSync('git', argv, { encoding: 'utf8' }).trim()
}

/** 按项目配置给 git 加上代理（推送需要）。 */
function gitWithProxy(...argv) {
  return execFileSync(
    'git',
    ['-c', 'http.proxy=http://127.0.0.1:7890', '-c', 'https.proxy=http://127.0.0.1:7890', ...argv],
    { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
  ).trim()
}

/**
 * 校验本版本的发布说明已经写好。
 *
 * 约定：`RELEASE_NOTES.md` 是**累积的变更日志**（新版本写在新的一节 `# <版本>`，旧版本用
 * `---` 分隔留在下面），CI 只把**本版本的那一节**填进 Release 正文。
 *
 * 这一步以前只检查"第一个标题里有没有这个版本号"，于是踩过一次很显眼的坑：正文里被塞进了
 * 整份变更日志（v1.4.4 的 Release 带着 1.4.3、1.4.2……一直回到 1.3.1）。现在改为真正
 * **取出那一节**再校验，取不到、或者短得不像话，都在打标签之前拒掉。
 *
 * @param version - 即将发布的版本号。
 */
function assertReleaseNotes(version) {
  const path = resolve(import.meta.dirname, '..', 'RELEASE_NOTES.md')
  if (!existsSync(path)) {
    console.error(`\n缺少 RELEASE_NOTES.md——请先写好 ${version} 的更新说明再发布。`)
    process.exit(1)
  }
  const text = readFileSync(path, 'utf8')
  let body
  try {
    body = extractReleaseNotes(text, version)
  } catch (error) {
    console.error('')
    console.error(error.message)
    console.error(`请先在 RELEASE_NOTES.md 顶部写上「# ${version}」那一节。`)
    console.error('')
    process.exit(1)
  }
  if (body.length < 200) {
    console.error('')
    console.error(`RELEASE_NOTES.md 里 ${version} 那一节只有 ${body.length} 个字符，像是没写完。`)
    console.error('它会被原样填进 Release 正文，而用户正是来看这个的。')
    console.error('')
    process.exit(1)
  }
  console.log(`发布说明: RELEASE_NOTES.md 的 ${version} 一节（${body.length} 字符）`)
}

const current = readVersion()
const expected = next(current)
const target = explicit ?? expected

// 校验显式版本号格式；next() 已经保证格式。
if (explicit !== undefined && !/^\d+\.\d+\.\d+$/u.test(explicit)) {
  console.error(`版本号 "${explicit}" 不是 X.Y.Z 形式`)
  process.exit(1)
}

console.log(`当前版本: ${current}`)
console.log(`序列下一个: ${expected}`)
console.log(`目标版本: ${target}`)
console.log(`标签    : v${target}`)

// 拦截"跳过补丁号"。这是本脚本最重要的一条约束：版本序列要可预期，否则用户看到
// 一堆跳号会怀疑是不是漏发了版本。
if (target !== expected && !force) {
  console.error('')
  console.error(`拒绝发布：${target} 跳过了序列中的 ${expected}。`)
  console.error('')
  console.error(`本项目的规则是先在次版本内走完补丁号：`)
  console.error(`  1.0.0 -> 1.0.1 -> … -> 1.0.9 -> 1.1.0 -> 1.1.1 -> … -> 1.1.9 -> 1.2.0`)
  console.error('')
  console.error(`想按序列发布请直接运行：node scripts/release.mjs`)
  console.error(`确实需要跳出序列（例如大版本）才加 --force：node scripts/release.mjs ${target} --force`)
  process.exit(1)
}

// 工作区必须干净：否则"提交了什么"说不清，标签与内容的一致性也无法保证。
const dirty = git('status', '--porcelain')
if (dirty !== '') {
  console.error('\n工作区不干净，先提交或撤销改动：')
  console.error(dirty)
  process.exit(1)
}

// 发布说明必须写好，否则拒绝发布。
//
// 每个版本的说明写在 RELEASE_NOTES.md 里，CI 会把它填进 Release 正文。把它做成硬性
// 检查，是因为"忘了写"从外部看不出来：Release 会正常发出，只是没有本次更新内容，
// 而用户恰恰是来看这个的。
assertReleaseNotes(target)

const existing = git('tag', '--list', `v${target}`)
if (existing !== '') {
  console.error(`\n标签 v${target} 已存在。发布下一个版本请用：node scripts/release.mjs`)
  process.exit(1)
}

if (dryRun) {
  console.log('\n--dry-run：将执行以下步骤，但不做任何改动')
  console.log(`  1. 把 package.json / package-lock.json 的版本改为 ${target}`)
  console.log(`  2. git commit -m "release: ${target}"`)
  console.log(`  3. git tag -a v${target}`)
  console.log('  4. push master 与标签（触发 CI 构建并发布 Release）')
  process.exit(0)
}

writeVersion(target)
const after = readVersion()
if (after !== target) {
  // 这一步几乎不可能失败，但"版本号写错"的代价很高，值一次断言。
  console.error(`写入失败：期望 ${target}，实际 ${after}`)
  process.exit(1)
}

git('add', 'package.json', 'package-lock.json')
git('commit', '-q', '-m', `release: ${target}`)

// 打标签**之前**再核对一次标签指向的提交里的版本号。
// 这是本脚本存在的核心理由：它挡住"标签与内容不一致"这类从外部看不出的错误。
const committedVersion = JSON.parse(git('show', 'HEAD:package.json')).version
if (committedVersion !== target) {
  console.error(`提交里的版本是 ${committedVersion}，与目标 ${target} 不一致，已中止`)
  process.exit(1)
}

git('tag', '-a', `v${target}`, '-m', `dsh-desktop ${target}`)
console.log('\n已提交并打标签，正在推送 …')
gitWithProxy('push', 'origin', 'master')
gitWithProxy('push', 'origin', `v${target}`)

console.log(`\n完成：v${target}（提交 ${git('rev-parse', '--short', 'HEAD')}）`)
console.log('CI 会构建三平台并直接发布 Release，可用以下命令查看进度：')
console.log('  node scripts/ci-status.mjs')
