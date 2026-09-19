// 验证「内置插件同步」：把随应用携带的插件补进当前实际使用的运行时。
//
//   npm run build && node scripts/test-plugin-sync.mjs
//
// 为什么要这个测试：这条逻辑修的是"运行时更新后三个插件一起从界面消失"的故障，而它
// 本身发生在启动路径上、失败时只写一行 stderr——不写成断言就只能靠肉眼盯界面。
//
// 与其它 test-*.mjs 的区别：它**不需要**跑起来的应用，也不需要 CDP。被测模块只碰文件
// 系统，因此可以用临时目录把"已损坏的运行时"精确造出来再修。
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)

let sync
try {
  sync = require(join(ROOT, 'dist', 'main', 'plugin-sync.js'))
} catch (error) {
  console.error('先运行 npm run build（或 node node_modules/typescript/bin/tsc -p tsconfig.json）')
  console.error(String(error.message))
  process.exit(1)
}

let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `（期望 ${expected}）`}`)
}

const work = mkdtempSync(join(tmpdir(), 'dsh-plugin-sync-'))

/** 造一个插件包目录。 */
function writePlugin(dir, name, body) {
  const root = join(dir, name)
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version: '1.0.0' }) + '\n')
  writeFileSync(join(root, 'lib', 'client.js'), body)
  writeFileSync(join(root, 'lib', 'index.js'), `// ${name} host\n`)
  return root
}

/** 造一个运行时目录：有 @deepseek-ai/dsh，但没有内置插件（这就是被换掉的那份）。 */
function writeRuntime(dir, { plugins = [] } = {}) {
  const dsh = join(dir, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(dsh, { recursive: true })
  writeFileSync(join(dsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' }) + '\n')
  writeFileSync(join(dir, 'runtime.json'), JSON.stringify({ package: '@deepseek-ai/dsh', version: '0.1.5-rc.2', plugins }, null, 2) + '\n')
  return dir
}

const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)

console.log('=== 1. 运行时被换掉后：插件被补齐 ===')
const bundled = join(work, 'resources', 'plugins')
mkdirSync(bundled, { recursive: true })
writePlugin(bundled, 'dsh-client-ui-gitbar', '// gitbar v1\n')
writePlugin(bundled, 'dsh-client-ui-review', '// review v1\n')
// 一个与插件无关的目录必须被忽略。
mkdirSync(join(bundled, '.cache'), { recursive: true })
writeFileSync(join(bundled, '.cache', 'junk.txt'), 'x')
mkdirSync(join(bundled, 'not-a-package'), { recursive: true })

const active = writeRuntime(join(work, 'runtime', '0.1.5-rc.2'))
const first = sync.syncPluginsIntoRuntime(active, [bundled])
console.log(`  来源: ${first.source}`)
check('发现的插件数', first.available.length, 2)
check('写入的插件', first.written.join(','), 'dsh-client-ui-gitbar,dsh-client-ui-review')
check('无失败', first.failures.length, 0)
check('gitbar 客户端就位', read(join(active, 'node_modules', 'dsh-client-ui-gitbar', 'lib', 'client.js')), '// gitbar v1\n')
check('review 的 host 半边就位', read(join(active, 'node_modules', 'dsh-client-ui-review', 'lib', 'index.js')), '// dsh-client-ui-review host\n')
check('非包目录未被复制', existsSync(join(active, 'node_modules', 'not-a-package')), 'false')
check('隐藏目录未被复制', existsSync(join(active, 'node_modules', '.cache')), 'false')

console.log('')
console.log('=== 2. 再次同步：内容一致就不重写 ===')
const second = sync.syncPluginsIntoRuntime(active, [bundled])
check('无需写入', second.written.length, 0)
check('全部保留', second.kept.join(','), 'dsh-client-ui-gitbar,dsh-client-ui-review')

console.log('')
console.log('=== 3. 外壳升级带来新版本：旧副本被刷新 ===')
writePlugin(bundled, 'dsh-client-ui-gitbar', '// gitbar v2 with longer body\n')
const third = sync.syncPluginsIntoRuntime(active, [bundled])
check('刷新了 gitbar', third.written.join(','), 'dsh-client-ui-gitbar')
check('内容已更新', read(join(active, 'node_modules', 'dsh-client-ui-gitbar', 'lib', 'client.js')), '// gitbar v2 with longer body\n')

console.log('')
console.log('=== 4. 覆盖时不留残骸 ===')
writeFileSync(join(bundled, 'dsh-client-ui-review', 'lib', 'stale.js'), '// 旧版才有\n')
sync.syncPluginsIntoRuntime(active, [bundled])
check('新文件被复制', existsSync(join(active, 'node_modules', 'dsh-client-ui-review', 'lib', 'stale.js')), 'true')
rmSync(join(bundled, 'dsh-client-ui-review', 'lib', 'stale.js'))
sync.syncPluginsIntoRuntime(active, [bundled])
check('源里删除后目标不再残留', existsSync(join(active, 'node_modules', 'dsh-client-ui-review', 'lib', 'stale.js')), 'false')

console.log('')
console.log('=== 5. 候选顺序：应用自带那份优先，损坏的运行时被跳过 ===')
const brokenRuntime = writeRuntime(join(work, 'runtime', '0.1.5-rc.1'), { plugins: ['dsh-client-ui-gitbar'] })
const repaired = writeRuntime(join(work, 'runtime', '0.1.5-rc.3'))
const fourth = sync.syncPluginsIntoRuntime(repaired, [brokenRuntime, bundled])
check('采用了可用的那份', fourth.source, bundled)
check('补齐了两个插件', fourth.written.length, 2)

console.log('')
console.log('=== 6. 运行时作为来源（含 runtime.json 名单） ===')
const donor = writeRuntime(join(work, 'runtime', 'donor'))
writePlugin(join(donor, 'node_modules'), 'dsh-client-ui-typography', '// typography host\n')
writeFileSync(
  join(donor, 'runtime.json'),
  JSON.stringify({ package: '@deepseek-ai/dsh', version: '0.1.5-rc.1', plugins: ['dsh-client-ui-typography'] }, null, 2) + '\n',
)
const receiver = writeRuntime(join(work, 'runtime', 'receiver'))
const fifth = sync.syncPluginsIntoRuntime(receiver, [donor])
check('从运行时的 node_modules 取到了插件', fifth.written.join(','), 'dsh-client-ui-typography')
check('名单声明但缺失的插件不会被算作可用', fifth.available.length, 1)

// 名单里登记了、但包里没有：这份运行时不能当来源。
const declaredOnly = writeRuntime(join(work, 'runtime', 'declared-only'), { plugins: ['dsh-client-ui-gitbar'] })
check('登记但缺失 → 来源不可用', String(sync.readPluginSource(declaredOnly)), 'undefined')

console.log('')
console.log('=== 7. 没有可用来源时不炸、也不乱建目录 ===')
const lonely = writeRuntime(join(work, 'runtime', 'lonely'))
const empty = sync.syncPluginsIntoRuntime(lonely, [join(work, 'resources', 'does-not-exist')])
check('没有写入', empty.written.length, 0)
check('没有可用来源', empty.available.length, 0)
check('没有凭空造出插件目录', existsSync(join(lonely, 'node_modules', 'dsh-client-ui-gitbar')), 'false')

const missingRuntime = join(work, 'runtime', 'never-existed')
const absent = sync.syncPluginsIntoRuntime(missingRuntime, [bundled])
check('运行时不存在时不做任何事', existsSync(missingRuntime), 'false')
check('运行时不存在时无失败记录', absent.failures.length, 0)

console.log('')
console.log('=== 8. 来源候选（打包 / 开发） ===')
const packaged = sync.pluginSourceCandidates({
  resourcesPath: 'C:\\app\\resources',
  repoRoot: 'C:\\repo',
  userDataDir: 'C:\\data',
  packaged: true,
})
check('打包后首选 resources/plugins', packaged[0], join('C:\\app\\resources', 'plugins'))
check('打包后含内置运行时解包位置', packaged.includes(join('C:\\data', 'bundled-runtime', 'runtime')), 'true')

const dev = sync.pluginSourceCandidates({
  resourcesPath: 'C:\\electron\\resources',
  repoRoot: ROOT,
  userDataDir: 'C:\\data',
  packaged: false,
  unpackedDir: 'C:\\data\\bundled-runtime\\runtime',
})
check('开发期首选仓库 plugins/', dev[0], join(ROOT, 'plugins'))
check('本次解包目录排在前面', dev[1], 'C:\\data\\bundled-runtime\\runtime')

console.log('')
console.log('=== 9. 启动入口 syncPluginsAtStartup：修复时报告，正常时安静 ===')
// 这就是 index.ts 在 spawn 服务端之前调用的那一个函数，用真实的仓库 plugins/ 当来源。
const freshRuntime = writeRuntime(join(work, 'runtime', '0.1.5-rc.9'))
const repair = sync.syncPluginsAtStartup({
  runtimeDir: freshRuntime,
  resourcesPath: join(work, 'resources'),
  repoRoot: ROOT,
  userDataDir: work,
  packaged: false,
})
check('确实补齐了插件', repair.outcome.written.length, 3)
check('打出了一行"已同步内置插件"', repair.messages.length, 1)
console.log(`  ${repair.messages[0]}`)
check('日志里点名了运行时目录', repair.messages[0].includes(freshRuntime), 'true')

const again = sync.syncPluginsAtStartup({
  runtimeDir: freshRuntime,
  resourcesPath: join(work, 'resources'),
  repoRoot: ROOT,
  userDataDir: work,
  packaged: false,
})
check('第二次启动不重复写', again.outcome.written.length, 0)
check('第二次启动不打日志', again.messages.length, 0)

// 找不到任何来源时必须吭声——这正是当初故障"静默"的地方。
const orphanRuntime = writeRuntime(join(work, 'runtime', 'orphan'))
const orphan = sync.syncPluginsAtStartup({
  runtimeDir: orphanRuntime,
  resourcesPath: join(work, 'nowhere'),
  repoRoot: join(work, 'no-repo'),
  userDataDir: join(work, 'no-data'),
  packaged: true,
})
check('没有来源时给出警告', orphan.messages.length, 1)
check('警告说明了后果', orphan.messages[0].includes('插件'), 'true')

console.log('')
console.log('=== 10. 真实仓库的 plugins/ 是可用的来源 ===')
const real = sync.readPluginSource(join(ROOT, 'plugins'))
check('仓库 plugins/ 可解析', real !== undefined, 'true')
console.log(`  实际插件: ${real === undefined ? '(无)' : real.names.join(', ')}`)
check('至少包含三个内置插件', (real?.names.length ?? 0) >= 3, 'true')

// 走一遍真实来源 + 假运行时的完整链路，确保真实包结构也能被复制。
const realTarget = writeRuntime(join(work, 'runtime', 'real-source'))
const realSync = sync.syncPluginsIntoRuntime(realTarget, [join(ROOT, 'plugins')])
check('真实插件全部就位', realSync.written.length, real?.names.length ?? 0)
check('客户端 bundle 可读', existsSync(join(realTarget, 'node_modules', 'dsh-client-ui-review', 'lib', 'client.js')), 'true')
check('package.json 可读', existsSync(join(realTarget, 'node_modules', 'dsh-client-ui-review', 'package.json')), 'true')
// 复制过去的内容必须与源逐字节一致，否则 dsh 会加载到一个半成品。
const sourceText = read(join(ROOT, 'plugins', 'dsh-client-ui-review', 'lib', 'client.js'))
const targetText = read(join(realTarget, 'node_modules', 'dsh-client-ui-review', 'lib', 'client.js'))
check('客户端 bundle 内容一致', sourceText === targetText && sourceText !== undefined, 'true')

rmSync(work, { recursive: true, force: true })

console.log('')
console.log(failures === 0 ? '插件同步全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
