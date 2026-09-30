// 应用内 Runtime 安装：staging → 真实版本校验 → rename → 切换 `current`，以及失败与回退。
//
// 全程**不联网**：授权那一层注入假的 release 检查，npm 那一层注入一个几十行的 fake
// `npm-cli.js`（它只做一件事：把目标版本的 package.json 写进 `--prefix`）。真实 HTTP
// 只会让这个测试在 CI 上随机失败，而它真正要证明的是**磁盘上的状态机**：
//
//   * 版本号必须安全（../ 之类不能变成路径）；
//   * 参数里必须有 --prefix / --registry / --no-audit / --no-fund / --loglevel http / --before；
//   * registry 失败按顺序回退；
//   * 只有"真实 package.json 版本 == 目标"才会 rename + 切 current；
//   * 失败/中断**不切换** current，当前 Runtime 一个字节都不动；
//   * 已装好的版本被复用（不再跑 npm）；
//   * rollback 只摘掉 current 链接，不删版本目录。
const assert = require('node:assert/strict')
const { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const { RuntimeUpdater, RUNTIME_REGISTRIES, isSafeRuntimeVersion, readRuntimeVersion } = require('../dist/main/runtime-updater')

/** 假的 npm CLI：只认识一个 registry 白名单，其余按网络失败处理。 */
const FAKE_NPM = `'use strict'
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const argv = process.argv.slice(2)
const flag = (name) => {
  const index = argv.indexOf(name)
  return index < 0 ? undefined : argv[index + 1]
}
const target = argv.find((value) => value.startsWith('@deepseek-ai/dsh@'))
const prefix = flag('--prefix')
const registry = flag('--registry')
const logPath = join(__dirname, 'invocations.jsonl')
const record = (entry) => writeFileSync(logPath, JSON.stringify(entry) + '\\n', { flag: 'a' })

if (argv[0] !== 'install' || target === undefined || prefix === undefined) {
  record({ ok: false, reason: 'bad argv', argv })
  process.exit(2)
}
if (flag('--cache') === undefined || flag('--loglevel') !== 'http' || argv.includes('--no-audit') !== true || argv.includes('--no-fund') !== true) {
  record({ ok: false, reason: 'missing required flags', argv })
  process.exit(2)
}

const allowedRaw = readFileSync(join(__dirname, 'registries.txt'), 'utf8')
const allowed = allowedRaw.split(/\\s+/u).filter((value) => value !== '')
record({ ok: true, prefix, registry, before: flag('--before'), version: target.slice('@deepseek-ai/dsh@'.length), argv })
if (process.env.DSH_FAKE_NPM_FAIL === '1' || !allowed.includes(registry)) {
  process.stderr.write('npm error code ECONNREFUSED  (fake registry unavailable)\\n')
  process.exit(1)
}

const version = target.slice('@deepseek-ai/dsh@'.length)
const pkgDir = join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
mkdirSync(pkgDir, { recursive: true })
writeFileSync(join(prefix, 'package.json'), JSON.stringify({ name: 'dsh-desktop-runtime', private: true, version: '0.0.0' }, null, 2) + '\\n')
writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }, null, 2) + '\\n')
process.stdout.write('npm http fetch GET 200 ' + registry + ' 12ms (fake)\\n')
if (process.env.DSH_FAKE_NPM_WRONG_VERSION === '1') {
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.1-broken' }, null, 2) + '\\n')
}
`

/** 假的官方 Release 检查：只有一个被授权的版本。 */
const releaseCheck = (authorized, publishedAt = '2025-09-20T08:30:00Z') => async () => ({
  available: true,
  current: '0.1.0',
  latest: authorized,
  releaseUrl: `https://example.invalid/dsh-v${authorized}`,
  publishedAt,
})

function readInvocations(dir) {
  const path = join(dir, 'invocations.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-updater-'))
  const userDataDir = join(root, 'userData')
  const npmDir = join(root, 'npm')
  mkdirSync(npmDir, { recursive: true })
  const npmCli = join(npmDir, 'npm-cli.js')
  writeFileSync(npmCli, FAKE_NPM)
  writeFileSync(join(npmDir, 'registries.txt'), `${RUNTIME_REGISTRIES[1]}\n`)

  const make = (options = {}) => new RuntimeUpdater({
    userDataDir,
    resourcesPath: join(root, 'resources'),
    appPath: join(root, 'app'),
    packaged: true,
    bundledVersion: '0.1.0',
    locateNpm: () => npmCli,
    ...options,
  })

  // ------------------------------------------------------------------ 版本号安全 ----
  assert.equal(isSafeRuntimeVersion('0.2.0-rc.1'), true)
  assert.equal(isSafeRuntimeVersion('0.2.0'), true)
  for (const bad of ['../escape', '..', 'a/b', 'a\\b', '', '.hidden', '1.2', 'v1.2.3', '1.2.3/../4', 'x'.repeat(80)]) {
    assert.equal(isSafeRuntimeVersion(bad), false, `${bad} must be rejected`)
  }
  const guard = make()
  assert.throws(() => guard.versionDir('../evil'), /不安全|越界/u)
  assert.throws(() => guard.versionDir('..'), /不安全|越界/u)

  // ------------------------------------------------------- registry 回退 + 激活 ----
  const updater = make({ checkRelease: releaseCheck('0.2.0-rc.1') })
  assert.equal(updater.canInstall, true)
  const progress = []
  const result = await updater.install({
    version: '0.2.0-rc.1',
    publishedAt: '2025-09-20T08:30:00Z',
    onProgress: (entry) => progress.push(entry),
  })
  assert.equal(result.version, '0.2.0-rc.1')
  assert.equal(result.registry, RUNTIME_REGISTRIES[1], 'first registry must fail, second must succeed')
  assert.equal(result.reused, false)
  assert.equal(result.dir, join(userDataDir, 'runtime', '0.2.0-rc.1'))
  assert.equal(readRuntimeVersion(result.dir), '0.2.0-rc.1')
  assert.equal(readRuntimeVersion(join(userDataDir, 'runtime', 'current')), '0.2.0-rc.1')

  const invocations = readInvocations(npmDir)
  assert.equal(invocations.length, 2, 'one failed attempt + one successful attempt')
  assert.equal(invocations[0].registry, RUNTIME_REGISTRIES[0])
  assert.equal(invocations[1].registry, RUNTIME_REGISTRIES[1])
  assert.equal(invocations[1].version, '0.2.0-rc.1')
  // --before = published_at + 24h（见 closureBefore 的说明）。
  assert.equal(invocations[1].before, '2025-09-21T08:30:00.000Z')
  assert.equal(invocations[0].before, '2025-09-21T08:30:00.000Z')
  // npm 自己的 cache 在应用数据目录下、且与版本目录分开。
  assert.ok(invocations[1].argv.includes('--cache'))
  assert.ok(existsSync(join(userDataDir, 'npm-cache')))
  assert.ok(progress.length > 0 && progress.some((entry) => entry.message.includes('安装失败')))

  // runtime.json 记录 version / installedAt / registry / sourceRelease / closureBefore。
  const metadata = JSON.parse(readFileSync(join(result.dir, 'runtime.json'), 'utf8'))
  assert.equal(metadata.package, '@deepseek-ai/dsh')
  assert.equal(metadata.version, '0.2.0-rc.1')
  assert.equal(metadata.registry, RUNTIME_REGISTRIES[1])
  assert.equal(metadata.sourceRelease, 'dsh-v0.2.0-rc.1')
  assert.equal(metadata.closureBefore, '2025-09-21T08:30:00.000Z')
  assert.ok(!Number.isNaN(Date.parse(metadata.installedAt)))

  // staging 目录不会留在磁盘上。
  assert.deepEqual(
    readdirSync(join(userDataDir, 'runtime')).filter((name) => name.startsWith('.staging-')),
    [],
  )

  // ---------------------------------------------------------- 重复点击共享一个 Promise --
  const again = make({ checkRelease: releaseCheck('0.2.0-rc.1') })
  const [a, b] = await Promise.all([
    again.install({ version: '0.2.0-rc.1', publishedAt: '2025-09-20T08:30:00Z' }),
    again.install({ version: '0.2.0-rc.1', publishedAt: '2025-09-20T08:30:00Z' }),
  ])
  assert.equal(a, b, 'concurrent installs must share one promise')
  assert.equal(a.reused, true, 'already installed version is reused without npm')
  assert.equal(readInvocations(npmDir).length, 2, 'the reuse path must not run npm again')

  // ------------------------------------------------------------------ rollback -----
  assert.equal(again.rollback(), true)
  assert.equal(existsSync(join(userDataDir, 'runtime', 'current')), false)
  assert.equal(existsSync(result.dir), true, 'rollback must not delete the downloaded version')
  assert.equal(again.rollback(), false, 'a second rollback is a no-op')

  // ------------------------------------------------- 未授权 / 内置版本更新：拒绝安装 ----
  const unauthorized = make({ checkRelease: releaseCheck('0.3.0') })
  await assert.rejects(
    () => unauthorized.install({ version: '0.2.0-rc.1', publishedAt: '2025-09-20T08:30:00Z' }),
    /未获官方 GitHub Release 授权/u,
  )
  const newerBundledRoot = join(root, 'newerBundled')
  mkdirSync(join(newerBundledRoot, 'userData'), { recursive: true })
  const newerBundled = new RuntimeUpdater({
    userDataDir: join(newerBundledRoot, 'userData'),
    resourcesPath: join(newerBundledRoot, 'resources'),
    appPath: join(newerBundledRoot, 'app'),
    packaged: true,
    // 内置 0.2.0 > 目标 0.1.0：这条路径必须直接拒绝，否则就是把用户降级。
    bundledVersion: '0.2.0',
    locateNpm: () => npmCli,
    checkRelease: releaseCheck('0.1.0'),
  })
  await assert.rejects(
    () => newerBundled.install({ version: '0.1.0', publishedAt: '2025-09-20T08:30:00Z' }),
    /不低于目标版本/u,
  )

  // ------------------------------------------------- 安装失败不切换 current（关键） ----
  const brokenRoot = join(root, 'broken')
  mkdirSync(join(brokenRoot, 'userData', 'runtime'), { recursive: true })
  // 先摆一个"当前正在用"的版本目录 + current 链接，证明失败不会动它。
  const keep = join(brokenRoot, 'userData', 'runtime', '0.2.0-rc.1')
  mkdirSync(join(keep, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
  writeFileSync(join(keep, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.1' }))
  symlinkSync(keep, join(brokenRoot, 'userData', 'runtime', 'current'), process.platform === 'win32' ? 'junction' : 'dir')
  const broken = new RuntimeUpdater({
    userDataDir: join(brokenRoot, 'userData'),
    resourcesPath: join(brokenRoot, 'resources'),
    appPath: join(brokenRoot, 'app'),
    packaged: true,
    bundledVersion: '0.1.0',
    locateNpm: () => npmCli,
    checkRelease: releaseCheck('0.3.0-rc.1'),
  })
  // 让 fake npm 在**两个**源上都失败：这正是"网络断了"的样子。
  process.env.DSH_FAKE_NPM_FAIL = '1'
  try {
    await assert.rejects(
      () => broken.install({ version: '0.3.0-rc.1', publishedAt: '2025-09-20T08:30:00Z' }),
      /安装失败/u,
    )
  } finally {
    delete process.env.DSH_FAKE_NPM_FAIL
  }
  assert.equal(readRuntimeVersion(join(brokenRoot, 'userData', 'runtime', 'current')), '0.2.0-rc.1', 'current must be untouched')
  assert.equal(existsSync(join(brokenRoot, 'userData', 'runtime', '0.3.0-rc.1')), false, 'no version dir on failure')
  assert.deepEqual(
    readdirSync(join(brokenRoot, 'userData', 'runtime')).filter((name) => name.startsWith('.staging-')),
    [],
    'staging must be cleaned up after a failure',
  )

  // ------------------------------------------- 装到的版本与目标不一致：同样不激活 ----
  const wrongRoot = join(root, 'wrong')
  mkdirSync(join(wrongRoot, 'userData'), { recursive: true })
  const wrong = new RuntimeUpdater({
    userDataDir: join(wrongRoot, 'userData'),
    resourcesPath: join(wrongRoot, 'resources'),
    appPath: join(wrongRoot, 'app'),
    packaged: true,
    bundledVersion: '0.1.0',
    locateNpm: () => npmCli,
    checkRelease: releaseCheck('0.2.0-rc.1'),
  })
  process.env.DSH_FAKE_NPM_WRONG_VERSION = '1'
  let mismatchMessage = ''
  try {
    await assert.rejects(
      () => wrong.install({ version: '0.2.0-rc.1', publishedAt: '2025-09-20T08:30:00Z' }),
      (error) => {
        mismatchMessage = error.message
        return /安装失败/u.test(error.message)
      },
    )
  } finally {
    delete process.env.DSH_FAKE_NPM_WRONG_VERSION
  }
  // 关键断言：拒绝的理由必须是"版本对不上"，而不是含糊的"失败了"。
  assert.match(mismatchMessage, /安装到的版本是 0\.0\.1-broken/u)
  assert.equal(existsSync(join(wrongRoot, 'userData', 'runtime', 'current')), false, 'a mismatched version must never be activated')

  // ------------------------------------------------------------ 缺少 npm CLI -------
  const noNpm = new RuntimeUpdater({
    userDataDir: join(root, 'noNpm'),
    resourcesPath: join(root, 'resources'),
    appPath: join(root, 'app'),
    packaged: true,
    bundledVersion: '0.1.0',
    locateNpm: () => undefined,
    checkRelease: releaseCheck('0.2.0-rc.1'),
  })
  assert.equal(noNpm.canInstall, false)
  assert.equal(noNpm.npmPath, undefined)
  await assert.rejects(
    () => noNpm.install({ version: '0.2.0-rc.1', publishedAt: '2025-09-20T08:30:00Z' }),
    /未找到 npm CLI/u,
  )

  // --------------------------------------------------------- 开发模式默认不安装 ----
  const dev = make({ packaged: false, checkRelease: releaseCheck('0.2.0-rc.1') })
  assert.equal(dev.canInstall, false)
  await assert.rejects(
    () => dev.install({ version: '0.2.0-rc.1', publishedAt: '2025-09-20T08:30:00Z' }),
    /开发模式/u,
  )

  rmSync(root, { recursive: true, force: true })
  console.log('PASS runtime updater staging, version verification, activation, registry fallback and rollback')
  console.log('PASS a failed or mismatched install never switches current')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
