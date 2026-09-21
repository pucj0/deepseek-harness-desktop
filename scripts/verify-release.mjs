// 用 GitHub API 校验某个版本的 Release：**正文只有一个版本标题**、不是 draft、附件齐全。
//
//   node scripts/verify-release.mjs            # 校验 package.json 的当前版本
//   node scripts/verify-release.mjs 1.4.9      # 校验指定版本
//
// 这一步存在的理由与 release.mjs 里的 assertReleaseNotes 相同：正文里混进整份变更日志
// （v1.4.4 那次）从外部完全看不出来，只有把**已发布的那份**拉回来数标题才知道——
// 而 `test-release-notes.mjs` 校验的只是本地文件，事故恰恰发生在发布之后。
//
// 它刻意**不调用 `process.exit()`**：此刻 fetch（undici）的句柄可能仍在收尾，在 Windows 上
// 强退会命中 libuv 的 `!(handle->flags & UV_HANDLE_CLOSING)` 断言——结果是"校验通过"却拿到
// 0xC0000409 的非零退出码，一条本来用于把关的检查反而变成噪音。设 `process.exitCode`
// 让事件循环自然排空即可。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const currentVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
// 默认校验**当前 package.json 的版本**（发布脚本刚刚 bump 过的那个），因此不需要每次改参数。
const version = process.argv[2] ?? currentVersion
const tag = `v${version}`
const repo = 'pucj0/deepseek-harness-desktop'
// 「上一版」按补丁号 -1 推出来，用于"正文里混进了上一版"这条断言（写死版本号会在下一版失效）。
const parts = version.split('.').map(Number)
const previous = parts.length === 3 ? `${parts[0]}.${parts[1]}.${Math.max(0, parts[2] - 1)}` : ''

/** 从 git 凭据助手取 GitHub token（与 ci-*.mjs 同一套做法，不落盘）。 */
function githubToken() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  })
  const line = out.split('\n').find((l) => l.startsWith('password='))
  if (!line) throw new Error('git 凭据里没有 github.com 的 token')
  return line.slice('password='.length).trim()
}

const response = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
  headers: { authorization: `Bearer ${githubToken()}`, accept: 'application/vnd.github+json', 'user-agent': 'dsh-verify-release' },
})

if (!response.ok) {
  console.error(`无法读取 ${tag} 的 Release：API ${response.status}`)
  console.error((await response.text()).slice(0, 300))
  process.exitCode = 1
} else {
  const release = await response.json()
  const body = String(release.body ?? '')
  const heads = body.split('\n').filter((line) => /^#\s/u.test(line))
  const assets = (release.assets ?? []).map((asset) => asset.name)

  console.log(`tag        : ${release.tag_name}`)
  console.log(`name       : ${release.name}`)
  console.log(`draft      : ${release.draft}`)
  console.log(`prerelease : ${release.prerelease}`)
  console.log(`published  : ${release.published_at}`)
  console.log(`正文标题   : ${JSON.stringify(heads)}（应为 1 个，且是 # ${version}）`)
  console.log(`正文长度   : ${body.length}`)
  console.log(`资产       : ${assets.join(', ') || '(none)'}`)
  console.log('')

  const problems = []
  if (heads.length !== 1) problems.push(`正文里有 ${heads.length} 个版本标题`)
  if (heads[0] !== `# ${version}`) problems.push(`正文标题是 ${heads[0]}，期望 # ${version}`)
  if (previous !== '' && body.includes(`# ${previous}`)) problems.push(`正文里混入了上一版（# ${previous}）`)
  if (release.draft) problems.push('Release 仍是 draft')
  // 附件是"用户能不能装、能不能收到更新"的硬条件：三平台安装包 + 三份自动更新 metadata，
  // 少一个就有一部分用户装不上。页面上肉眼也能看，但正是最容易漏看的那一类。
  for (const required of ['latest.yml', 'latest-mac.yml', 'latest-linux.yml']) {
    if (!assets.includes(required)) problems.push(`缺少附件 ${required}`)
  }
  if (!assets.some((name) => name.endsWith('.exe'))) problems.push('缺少 Windows 安装包')
  if (!assets.some((name) => name.endsWith('.dmg'))) problems.push('缺少 macOS 安装包')
  if (!assets.some((name) => name.endsWith('.AppImage'))) problems.push('缺少 Linux 安装包')

  console.log(problems.length === 0 ? 'Release 校验通过' : `Release 校验失败：${problems.join('；')}`)
  process.exitCode = problems.length === 0 ? 0 : 1
}
