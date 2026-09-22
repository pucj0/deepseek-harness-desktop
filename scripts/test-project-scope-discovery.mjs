// 项目级仓库发现（`PROJECT_SCOPE_LIMITS` / `resolveProjectScope`）的离线单测。
//
//   node scripts/test-project-scope-discovery.mjs
//
// 为什么必须是纯内存的假文件系统：这里要覆盖的正是"真实磁盘上造不出来"的形状——
//   * 10,000+ 个目录的宽树（在磁盘上建要几秒并污染临时目录，在这里只是一个对象）；
//   * `.git` 是**文件**（worktree / submodule）而不是目录；
//   * 时间预算被耗尽（注入的时钟按调用次数前进，不依赖真实时间）。
// 假 `runGit` 同理：这里验的是**发现的算法**（访问了哪些目录、跑了多少次 rev-parse、
// 账目对不对），不是 git 本身；真实仓库那一半由 scripts/test-review-repo-scope.mjs 与
// scripts/test-gitbar-*.mjs 在真 git + 真服务端上覆盖。
//
// 最后一个用例钉住两份副本**逐字节相同**：两个插件是各自独立的包，启动时整目录同步进
// runtime 的 node_modules，跨包 import 会让"另一个插件不存在"变成加载期错误。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const REVIEW = join(root, 'plugins', 'dsh-client-ui-review', 'lib', 'repo-context.js')
const GITBAR = join(root, 'plugins', 'dsh-client-ui-gitbar', 'lib', 'repo-context.js')

let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (ok === false) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `（期望 ${expected}）`}`)
}
const checkTrue = (label, actual) => check(label, actual === true, true)
const checkLe = (label, actual, bound) => check(label, actual <= bound, true)
const section = (title) => {
  console.log('')
  console.log(`=== ${title} ===`)
}

/**
 * 纯内存文件系统：`ensure(path)` 造目录，`file(path)` 造文件，`gitDir(path)` 放一个
 * **目录**形态的 `.git`，`gitFile(path)` 放一个**文件**形态的 `.git`（worktree / submodule）。
 *
 * 它同时是一份调用日志（`calls`）：发现算法"看了什么"必须可断言——只准 listDirectory +
 * exists，绝不许碰文件内容（见第 6 节）。
 */
function makeFs() {
  /** path → `{ kind: 'dir' | 'file', children: string[] }`；`children` 只有目录才有。 */
  const nodes = new Map()
  const calls = []
  let deferListing = false
  let releaseListing
  const gate = new Promise((resolve) => {
    releaseListing = resolve
  })

  const attach = (path, kind) => {
    const node = nodes.get(path) ?? { kind, children: [] }
    node.kind = kind
    nodes.set(path, node)
    const parent = path.slice(0, path.lastIndexOf('/'))
    if (parent !== '' && parent !== path) {
      const parentNode = nodes.get(parent)
      if (parentNode !== undefined) {
        const name = path.slice(parent.length + 1)
        if (parentNode.children.includes(name) === false) parentNode.children.push(name)
      }
    }
    return path
  }
  /** 造目录（父目录必须已经存在，和真实 fs 一样不给自动建整条路径）。 */
  const ensure = (path) => attach(path, 'dir')
  /** 造文件。 */
  const file = (path) => attach(path, 'file')
  /** 目录形态的 `.git`（普通仓库）。 */
  const gitDir = (path) => {
    ensure(path)
    return ensure(`${path}/.git`)
  }
  /** 文件形态的 `.git`（worktree / submodule）。 */
  const gitFile = (path) => {
    ensure(path)
    return file(`${path}/.git`)
  }

  return {
    nodes,
    calls,
    ensure,
    file,
    gitDir,
    gitFile,
    /** 让下一次 listDirectory 挂在 gate 上（single-flight 用例需要"扫描没跑完"的窗口）。 */
    holdNextListing() {
      deferListing = true
    },
    /** yield 几拍，让被挂住的那次 listDirectory 真正进入等待。 */
    async tick() {
      for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve))
    },
    release() {
      releaseListing()
    },
    listDirectory: async (path) => {
      calls.push({ kind: 'list', path })
      if (deferListing === true) {
        deferListing = false
        await gate
      }
      const node = nodes.get(path)
      if (node === undefined || node.kind !== 'dir') return []
      return node.children.map((name) => ({
        name,
        isDirectory: nodes.get(`${path}/${name}`)?.kind === 'dir',
        isFile: nodes.get(`${path}/${name}`)?.kind === 'file',
      }))
    },
    exists: (path) => {
      calls.push({ kind: 'exists', path })
      return nodes.has(path)
    },
    /** 某个目录下挂了几次 listDirectory（单飞的计数就靠它）。 */
    listCount(path) {
      return calls.filter((entry) => entry.kind === 'list' && entry.path === path).length
    },
    /** 有没有任何一次调用落在这些路径下（排除目录用例：必须一次都没有）。 */
    touchedUnder(prefix) {
      return calls.filter((entry) => entry.path.startsWith(prefix)).length
    },
  }
}

/**
 * 假 git：沿父目录往上找"在 fs 里存在 `.git`"的那个目录，返回它的 toplevel 与 git 目录。
 * `gitOverrides` 用来模拟 worktree / submodule——`gitDir` 与 `<dir>/.git` 根本不是一回事。
 */
function makeGit(fs, gitOverrides = new Map()) {
  const real = (path) => {
    const override = gitOverrides.get(path)
    return override === undefined ? path : override
  }
  const runGit = async (args, cwd) => {
    if (args[0] !== 'rev-parse') throw new Error(`假 git 只支持 rev-parse：${args.join(' ')}`)
    let dir = String(cwd).replace(/\\/gu, '/')
    while (dir !== '' && dir !== '/') {
      if (fs.exists(`${dir}/.git`)) {
        return `${real(dir)}\n${real(`${dir}/.git`)}\n`
      }
      const cut = dir.lastIndexOf('/')
      dir = cut <= 0 ? '' : dir.slice(0, cut)
    }
    throw new Error('not a git repository')
  }
  return { runGit }
}

/** 手工推进的时钟：`fastBudgetMs` 数的是 tick 数，用例因此完全不依赖真实时间。 */
function makeClock(start = 1_000_000, step = 1) {
  let value = start
  return {
    now: () => {
      value += step
      return value
    },
    /** 直接跳到某个时刻（TTL 用例用它把 60s 的缓存推过期）。 */
    set: (next) => {
      value = next
    },
    reads: () => value,
  }
}

/**
 * 等待后台那一段 BFS 落地。
 *
 * 快路径是"扫完第一层就返回"，因此第一次 `resolveProjectScope` 之后必须**再问一次**才
 * 能看到 `complete:true`。轮询用 `setImmediate` 而不是定时器：后台只要不再有宏任务等待，
 * 几拍内就会完成，用例不必为了稳去 sleep 一个魔数。
 */
async function settle(resolve, workspace, limit = 400) {
  for (let i = 0; i < limit; i += 1) {
    const scope = resolve.peekProjectScope(workspace)
    if (scope !== undefined && scope.discovery.complete === true) return scope
    await new Promise((done) => setImmediate(done))
  }
  return resolve.peekProjectScope(workspace)
}

const { createRepoContextResolver, PROJECT_SCOPE_LIMITS } = await import(pathToFileURL(REVIEW).href)

console.log('项目级仓库发现（有界）单测')
console.log(`  limits: ${JSON.stringify(PROJECT_SCOPE_LIMITS, null, 0)}`)
check('默认 maxDepth', PROJECT_SCOPE_LIMITS.maxDepth, 4)
check('默认 excludeDirs 里有 node_modules', PROJECT_SCOPE_LIMITS.excludeDirs.includes('node_modules'), true)
checkTrue('常量是冻结的', Object.isFrozen(PROJECT_SCOPE_LIMITS))

// ===========================================================================
section('1. 截图里的那个形状：工作区自己不是仓库，仓库在第一层子目录')
{
  const fs = makeFs()
  const workspace = '/ws/haiweiNew'
  fs.ensure(workspace)
  fs.file(`${workspace}/package.json`)
  fs.ensure(`${workspace}/src`)
  fs.file(`${workspace}/src/a.js`)
  fs.gitDir(`${workspace}/haiwei-manage-fronted`)
  fs.file(`${workspace}/haiwei-manage-fronted/package.json`)
  fs.ensure(`${workspace}/haiwei-manage-fronted/src`)
  fs.file(`${workspace}/haiwei-manage-fronted/src/main.js`)

  const resolver = createRepoContextResolver({ ...makeGit(fs), ...fs })
  const first = await resolver.resolveProjectScope(workspace)
  check('1) 第一次调用就给出了仓库（快路径只看自身 + 第一层）', first.repositories.length, 1)
  check('   repositoryRoot', first.repositories[0].repositoryRoot, `${workspace}/haiwei-manage-fronted`)
  check('   relativePath（POSIX、工作区相对）', first.repositories[0].relativePath, 'haiwei-manage-fronted')
  check('   name', first.repositories[0].name, 'haiwei-manage-fronted')
  check('   gitDir', first.repositories[0].gitDir, `${workspace}/haiwei-manage-fronted/.git`)
  check('   workspaceRoot 回显', first.workspaceRoot, workspace)
  // 第一层只看到 `src` 与 `haiwei-manage-fronted`，两者都有更深的内容，因此第一份是 partial。
  check('   第一份是 partial（更深的工作留给后台）', first.discovery.complete, false)
  const scope = await settle(resolver, workspace)
  checkTrue('   后台跑完后 complete', scope.discovery.complete === true)
  check('   truncatedByBudget', scope.discovery.truncatedByBudget, false)
  check('   仓库列表不变（没有重复）', scope.repositories.length, 1)
  // 这就是"今天面板说不是 git 仓库"的那一步：单仓库解析仍然说"不是"，但项目级作用域看得到。
  check('   单仓库解析仍然是 undefined（没有改变既有语义）', await resolver.resolve(workspace), undefined)
}

// ===========================================================================
section('2. 两个兄弟仓库：不许发现一个就停')
{
  const fs = makeFs()
  const workspace = '/ws/project'
  fs.ensure(workspace)
  fs.file(`${workspace}/README.md`)
  fs.gitDir(`${workspace}/frontend`)
  fs.file(`${workspace}/frontend/index.html`)
  fs.gitDir(`${workspace}/backend`)
  fs.file(`${workspace}/backend/server.js`)

  const resolver = createRepoContextResolver({ ...makeGit(fs), ...fs })
  const scope = await resolver.resolveProjectScope(workspace)
  check('2) repositories 长度', scope.repositories.length, 2)
  check('   顺序稳定（按发现顺序，同一层按 listDirectory 顺序）', scope.repositories.map((r) => r.relativePath).join(','), 'frontend,backend')
  check('   frontend 的 name', scope.repositories[0].name, 'frontend')
  check('   backend 的 name', scope.repositories[1].name, 'backend')
  check('   backend 的 gitDir', scope.repositories[1].gitDir, `${workspace}/backend/.git`)
  checkTrue('   第一层扫完 => complete', scope.discovery.complete === true)
  check('   两次 rev-parse（每个候选一次）', scope.discovery.gitProbes, 2)
  check('   candidatesFound', scope.discovery.candidatesFound, 2)
}

// ===========================================================================
section('3. 容器仓库 + 嵌套仓库：都报，且按 canonical 路径去重')
{
  const fs = makeFs()
  const workspace = '/ws/project'
  fs.gitDir(workspace) // 工作区自己就是仓库
  fs.ensure(`${workspace}/nested`)
  fs.gitDir(`${workspace}/nested`)

  const resolver = createRepoContextResolver({ ...makeGit(fs), ...fs })
  const scope = await resolver.resolveProjectScope(workspace)
  check('3) repositories 长度（容器仓库只出现一次）', scope.repositories.length, 2)
  check('   容器仓库 relativePath', scope.repositories[0].relativePath, '')
  check('   容器仓库 repositoryRoot', scope.repositories[0].repositoryRoot, workspace)
  check('   容器仓库 name', scope.repositories[0].name, 'project')
  check('   嵌套仓库 relativePath', scope.repositories[1].relativePath, 'nested')
  check('   嵌套仓库 repositoryRoot', scope.repositories[1].repositoryRoot, `${workspace}/nested`)
  // 容器仓库既在"containing probe"里出现一次，又会被扫描当成候选目录遇到一次（它自己有
  // `.git`）——第二遍必须被去重，不能变成两条。
  check('   去重后没有重复的 repositoryRoot', new Set(scope.repositories.map((r) => r.repositoryRoot)).size, 2)
}

// ===========================================================================
section('4. `.git` 是文件（worktree / submodule）：候选要找到，且以 rev-parse 结果为准')
{
  const fs = makeFs()
  const workspace = '/ws/mono'
  fs.ensure(workspace)
  const sub = `${workspace}/sub`
  fs.gitFile(sub)
  fs.file(`${sub}/main.js`)
  // 真实的 worktree/submodule：`.git` 文件里写着 `gitdir: ...`，真正的 git 目录在别处。
  const overrides = new Map([
    [sub, '/ws/mono'],
    [`${sub}/.git`, '/ws/mono/.git/worktrees/sub'],
  ])

  const resolver = createRepoContextResolver({ ...makeGit(fs, overrides), ...fs })
  const scope = await resolver.resolveProjectScope(workspace)
  check('4) repositories 长度', scope.repositories.length, 1)
  check('   repositoryRoot 来自 rev-parse（不是候选目录本身）', scope.repositories[0].repositoryRoot, '/ws/mono')
  check('   gitDir 来自 rev-parse（与 <dir>/.git 不同）', scope.repositories[0].gitDir, '/ws/mono/.git/worktrees/sub')
  checkTrue('   gitDir 确实不是候选项的 .git 文件', scope.repositories[0].gitDir !== `${sub}/.git`)
  check('   relativePath 仍然按候选目录算', scope.repositories[0].relativePath, 'sub')
  // `.git` 是文件这件事被 exists 接受（不能要求它必须是目录）。
  checkTrue('   检查的是 <dir>/.git 这个路径本身', fs.calls.some((c) => c.kind === 'exists' && c.path === `${sub}/.git`))
}

// ===========================================================================
section('5. 排除目录：不下钻、也不报它自己（依赖/构建产物里的 .git 是幽灵仓库）')
{
  const fs = makeFs()
  const workspace = '/ws/app'
  fs.ensure(workspace)
  for (const name of ['node_modules', 'dist', 'target', 'build']) {
    fs.ensure(`${workspace}/${name}/pkg`)
    fs.gitDir(`${workspace}/${name}/pkg`)
  }
  // 真实仓库仍然要被发现（排除逻辑不能误伤同层的正常目录）。
  fs.gitDir(`${workspace}/app-frontend`)

  const resolver = createRepoContextResolver({ ...makeGit(fs), ...fs })
  const scope = await resolver.resolveProjectScope(workspace)
  check('5) 只发现真实仓库', scope.repositories.map((r) => r.relativePath).join(','), 'app-frontend')
  check('   repositories 长度', scope.repositories.length, 1)
  for (const name of ['node_modules', 'dist', 'target', 'build']) {
    check(`   ${name} 一次都没有被 listDirectory`, fs.listCount(`${workspace}/${name}`), 0)
    check(`   ${name} 下面一次都没有被碰过`, fs.touchedUnder(`${workspace}/${name}`), 0)
  }
  // 大小写不敏感：Windows 上 `Node_Modules` 也必须是排除名单里的那个。
  const fs2 = makeFs()
  const ws2 = '/ws/app2'
  fs2.ensure(ws2)
  fs2.gitDir(`${ws2}/NODE_MODULES/pkg`)
  fs2.gitDir(`${ws2}/real`)
  const resolver2 = createRepoContextResolver({ ...makeGit(fs2), ...fs2 })
  const scope2 = await resolver2.resolveProjectScope(ws2)
  check('   大小写不敏感：NODE_MODULES 同样不下钻', scope2.repositories.map((r) => r.relativePath).join(','), 'real')
}

// ===========================================================================
section('6. 绝不读文件内容：只允许 listDirectory + exists(<dir>/.git)')
{
  const fs = makeFs()
  const workspace = '/ws/only'
  fs.ensure(workspace)
  fs.file(`${workspace}/package.json`)
  fs.file(`${workspace}/tsconfig.json`)
  fs.ensure(`${workspace}/src`)
  fs.file(`${workspace}/src/a.js`)
  fs.gitDir(`${workspace}/src/repo`)
  fs.file(`${workspace}/src/repo/index.js`)

  const resolver = createRepoContextResolver({ ...makeGit(fs), ...fs })
  await resolver.resolveProjectScope(workspace)
  await settle(resolver, workspace)

  const kinds = new Set(fs.calls.map((c) => c.kind))
  check('   只出现两种原语', [...kinds].sort().join(','), 'exists,list')
  const badExists = fs.calls.filter((c) => c.kind === 'exists' && c.path.endsWith('/.git') === false)
  check('   exists 只用于 <dir>/.git', badExists.length, 0)
  // 两个 `package.json` 与 `tsconfig.json` 都被 listDirectory 看到（列了名字），但**没有任何
  // 一次调用以它们为路径**——没有任何读取文件内容的原语存在。
  for (const name of ['package.json', 'tsconfig.json', 'src/a.js', 'src/repo/index.js']) {
    check(`   没有以 ${name} 为路径的调用`, fs.calls.filter((c) => c.path.endsWith(name)).length, 0)
  }
  check('   listDirectory 的路径全是目录形态（没有后缀）', fs.calls.filter((c) => c.kind === 'list' && /\.[a-z]+$/u.test(c.path)).length, 0)
}

// ===========================================================================
section('7. 10,000+ 目录 + 深链：maxDirs / 预算截断 / 快路径先答')
{
  const fs = makeFs()
  const workspace = '/ws/big'
  fs.ensure(workspace)
  // 真机形状：第一层是成千上万个**叶子**目录（依赖、资源、页面…），仓库埋在其中一个子目录里。
  // 快路径的时间预算一定会在"列完第一层"之前耗尽（每个目录都要 listDirectory + exists），
  // 因此它必须带着 `complete:false` 立刻返回；后台那一段接着把第一层列完，再按 BFS 下钻，
  // 才能在第 4 层找到 deepRepo。
  //
  // 深链挂在 `dir0000/chain/` 下，且**只到 `maxDepth`**：`dir0000/chain` 是第 2 层、`chain/d0001`
  // 是第 3 层、`d0001/deepRepo` 是第 4 层（= maxDepth）。这样后台那一段既走了好几层 BFS，
  // 又能真的把 deepRepo 访问到（第 5 层的目录会被 `maxDepth` 挡住，扫不到）。
  const FLAT = 600
  for (let i = 0; i < FLAT; i += 1) {
    fs.ensure(`${workspace}/dir${String(i).padStart(4, '0')}`)
  }
  fs.gitDir(`${workspace}/dir0000`)
  fs.gitDir(`${workspace}/dir0001`)
  fs.gitDir(`${workspace}/dir0002`)
  // **最后一个**第一层目录里也放一个仓库：它排在产出 depth-2 的 `dir0000` 之后，因此只有
  // "第一层全部看完才交棒"的实现才能在快路径的答案里带上它。这条断言钉的就是这个契约
  // （曾经是"一有 depth-2 入队就交棒"，那时这个仓库要等后台才出现）。
  fs.gitDir(`${workspace}/dir0599`)
  fs.ensure(`${workspace}/dir0000/chain`)
  fs.ensure(`${workspace}/dir0000/chain/d0001`)
  fs.gitDir(`${workspace}/dir0000/chain/d0001/deepRepo`)

  const dirCount = [...fs.nodes.entries()].filter(([, node]) => node.kind === 'dir').length
  checkTrue(`   合成树够大（实际 ${dirCount} 个目录）`, dirCount > 600)

  const clock = makeClock()
  const resolver = createRepoContextResolver({
    ...makeGit(fs),
    ...fs,
    now: clock.now,
  })

  const first = await resolver.resolveProjectScope(workspace)
  const afterFirst = clock.reads()
  // 关键的两段式断言：第一次调用**没有**等后台，带着 `complete:false` 回来，而深链里的
  // 那个仓库此刻还没被发现。
  check('7) 第一次调用 complete=false（深层还没扫）', first.discovery.complete, false)
  checkTrue('   快路径的答案在时间预算处截断', first.discovery.truncatedByBudget === true)
  checkLe('   directoriesVisited <= maxDirs', first.discovery.directoriesVisited, PROJECT_SCOPE_LIMITS.maxDirs)
  checkLe('   durationMs 有界（注入时钟，tick 数）', first.discovery.durationMs, PROJECT_SCOPE_LIMITS.fastBudgetMs * 2)
  // 后台那一段**可能已经跑了几拍**（它就在返回之前被启动），因此这里的界取后台的总预算：
  // 它要证的是"第一次调用没有等整棵树扫完"，而不是"后台一拍都没跑"。
  checkLe('   第一次调用的时钟推进有界（没有偷偷把整棵树扫完）', afterFirst - 1_000_000, PROJECT_SCOPE_LIMITS.fastBudgetMs * 8)
  // 快路径的契约：**第一层全部看完**（含排在最后的 dir0599），但更深的（第 4 层的
  // deepRepo）不包含在这一次答复里。
  check('   第一层四个仓库都已发现', first.repositories.length, 4)
  checkTrue('   含第一层最后一个目录里的仓库（第一层确实看完了）', first.repositories.some((r) => r.name === 'dir0599'))
  checkTrue('   deepRepo 还不在列表里（它在第 4 层）', first.repositories.every((r) => r.relativePath.endsWith('deepRepo') === false))

  const deep = await settle(resolver, workspace)
  check('   后台跑完后 complete=true', deep.discovery.complete, true)
  check('   完整结果没有截断', deep.discovery.truncatedByBudget, false)
  checkLe('   完整结果 directoriesVisited <= maxDirs', deep.discovery.directoriesVisited, PROJECT_SCOPE_LIMITS.maxDirs)
  check('   directoriesVisited 比快路径多（后台确实接着扫了）', deep.discovery.directoriesVisited > first.discovery.directoriesVisited, true)
  check('   后台多发现了深链里的仓库', deep.repositories.length, 5)
  checkTrue('   deepRepo 现在在列表里', deep.repositories.some((r) => r.name === 'deepRepo'))
  checkTrue('   durationMs 没有超过后台的 8 倍预算', deep.discovery.durationMs <= PROJECT_SCOPE_LIMITS.fastBudgetMs * 8)
  // 缓存里就是"最终那一份"：再问一次拿到的是 complete=true 且标着 cached。
  const again = await resolver.resolveProjectScope(workspace)
  check('   再问一次是缓存命中', again.discovery.cached, true)
  check('   缓存里已是完整结果', again.discovery.complete, true)
  check('   且没有再扫一遍（visited 不变）', again.discovery.directoriesVisited, deep.discovery.directoriesVisited)
}

// ===========================================================================
section('7b. 10,000+ 目录的宽树触发 maxDirs：truncatedByBudget 必须如实上报')
{
  const fs = makeFs()
  const workspace = '/ws/huge'
  fs.ensure(workspace)
  // 第一层 10,000 个目录，每个下面再挂 1 个：快路径列完第一层（预算内），后台的 BFS 在
  // 10,000 个 depth-2 目录上撞到 `maxDirs`（4,000）而停——这时 `complete` 必须是 false，
  // 而且**不能**无限扫下去。
  const FLAT = 10_000
  for (let i = 0; i < FLAT; i += 1) {
    const name = `d${String(i).padStart(4, '0')}`
    fs.ensure(`${workspace}/${name}`)
    fs.ensure(`${workspace}/${name}/s0`)
  }
  const dirCount = [...fs.nodes.entries()].filter(([, node]) => node.kind === 'dir').length
  checkTrue(`   合成树 > 10,000 个目录（实际 ${dirCount}）`, dirCount > 10_000)
  const resolver = createRepoContextResolver({ ...makeGit(fs), ...fs, limits: { fastBudgetMs: 10_000 } })
  const first = await resolver.resolveProjectScope(workspace)
  check('7b) 快路径返回时 complete=false（还有 depth-2）', first.discovery.complete, false)
  const scope = await settle(resolver, workspace)
  check('   maxDirs 命中后停下（不再无限扫）', scope.discovery.truncatedByBudget, true)
  check('   complete=false（被截断，不是扫完了）', scope.discovery.complete, false)
  checkLe('   directoriesVisited <= maxDirs', scope.discovery.directoriesVisited, PROJECT_SCOPE_LIMITS.maxDirs)
  checkTrue('   确实访问到了上限附近（不是半路就停）', scope.discovery.directoriesVisited > PROJECT_SCOPE_LIMITS.maxDirs - PROJECT_SCOPE_LIMITS.concurrency * 4)
  checkTrue('   被截断的那份仍然可用（空列表而不是抛错）', Array.isArray(scope.repositories))
}

// ===========================================================================
section('8. rev-parse 次数与候选数成正比，与访问目录数无关')
{
  const fs = makeFs()
  const workspace = '/ws/probe'
  fs.ensure(workspace)
  for (let i = 0; i < 10_000; i += 1) fs.ensure(`${workspace}/d${String(i).padStart(4, '0')}`)
  fs.gitDir(`${workspace}/d0000`)
  fs.gitDir(`${workspace}/d0001`)
  fs.gitDir(`${workspace}/d0002`)

  const git = makeGit(fs)
  let probes = 0
  const resolver = createRepoContextResolver({
    ...fs,
    runGit: (args, cwd) => {
      probes += 1
      return git.runGit(args, cwd)
    },
    now: makeClock().now,
  })
  const scope = await resolver.resolveProjectScope(workspace)
  check('8) 三个候选仓库都发现了', scope.repositories.length, 3)
  checkLe('   gitProbes <= 3 + 1（containing probe）', scope.discovery.gitProbes, 4)
  check('   gitProbes 与候选数一致', scope.discovery.gitProbes, 3)
  check('   candidatesFound', scope.discovery.candidatesFound, 3)
  // 真实 rev-parse 次数 = 1（containing probe）+ 3（每个候选一次）。
  check('   真实 runGit 调用次数', probes, 4)
  checkTrue('   访问目录数远大于探测数（10,000+ vs 3）', scope.discovery.directoriesVisited > 100 * scope.discovery.gitProbes)
}

// ===========================================================================
section('9. 缓存 + single-flight：并发只扫一次、TTL 命中、force 重扫、invalidate 丢弃')
{
  const fs = makeFs()
  const workspace = '/ws/cache'
  fs.ensure(workspace)
  // 九个第一层目录 => 快路径至少两轮（concurrency=8），足够制造"扫描还在跑"的窗口。
  for (let i = 0; i < 9; i += 1) fs.ensure(`${workspace}/p${i}`)

  const resolver = createRepoContextResolver({ ...makeGit(fs), ...fs, limits: { fastBudgetMs: 10_000 } })
  const baseline = fs.listCount(workspace)
  check('9) 起始没有缓存', resolver.peekProjectScope(workspace), undefined)

  // 让下一次 listDirectory 挂住：两个并发调用必须加入**同一次**扫描。
  fs.holdNextListing()
  const a = resolver.resolveProjectScope(workspace)
  const b = resolver.resolveProjectScope(workspace)
  await fs.tick()
  fs.release()
  const [first, second] = await Promise.all([a, b])
  check('   两个并发调用拿到同一份结果', first === second, true)
  check('   起点的 containing probe 只跑了一次 + 快路径只扫了一轮', fs.listCount(workspace), baseline + 1)
  check('   第一个是本次扫描（cached:false）', first.discovery.cached, false)

  const cached = await resolver.resolveProjectScope(workspace)
  check('   TTL 内二次调用 cached:true', cached.discovery.cached, true)
  check('   且没有重新扫描（root list 次数不变）', fs.listCount(workspace), baseline + 1)
  check('   peekProjectScope 也命中', resolver.peekProjectScope(workspace).discovery.cached, true)

  const forced = await resolver.resolveProjectScope(workspace, { force: true })
  check('   force:true 绕过缓存', forced.discovery.cached, false)
  check('   force:true 真的重扫了', fs.listCount(workspace), baseline + 2)

  resolver.invalidateProjectScope(workspace)
  check('   invalidate 后 peek 落空', resolver.peekProjectScope(workspace), undefined)
  const afterInvalidate = await resolver.resolveProjectScope(workspace)
  check('   invalidate 后重新扫描', afterInvalidate.discovery.cached, false)
  check('   又扫了一遍', fs.listCount(workspace), baseline + 3)

  // TTL 由注入的 now() 决定：把时钟推过 60s 之后必须重扫。
  const clock = makeClock()
  const fs2 = makeFs()
  const ws2 = '/ws/ttl'
  fs2.ensure(ws2)
  const resolver2 = createRepoContextResolver({ ...makeGit(fs2), ...fs2, now: clock.now })
  await resolver2.resolveProjectScope(ws2)
  check('   TTL 内命中', (await resolver2.resolveProjectScope(ws2)).discovery.cached, true)
  const beforeTtl = fs2.listCount(ws2)
  clock.set(clock.reads() + PROJECT_SCOPE_LIMITS.ttlMs + 1)
  check('   过期后 peek 落空（TTL = 60000）', resolver2.peekProjectScope(ws2), undefined)
  const rescanned = await resolver2.resolveProjectScope(ws2)
  check('   过期后重新扫描（而不是继续用旧结果）', rescanned.discovery.cached, false)
  check('   确实又扫了一遍', fs2.listCount(ws2), beforeTtl + 1)
}

// ===========================================================================
section('10. 既不是仓库、下面也没有仓库：空列表，不抛')
{
  const fs = makeFs()
  const workspace = '/ws/plain'
  fs.ensure(workspace)
  fs.ensure(`${workspace}/src`)
  fs.file(`${workspace}/src/a.js`)
  fs.file(`${workspace}/README.md`)

  const resolver = createRepoContextResolver({ ...makeGit(fs), ...fs })
  const scope = await resolver.resolveProjectScope(workspace)
  check('10) repositories 是空数组', JSON.stringify(scope.repositories), '[]')
  checkTrue('   complete=true（确实扫完了）', scope.discovery.complete === true)
  check('   gitProbes=0', scope.discovery.gitProbes, 0)
  check('   单仓库解析也是 undefined', await resolver.resolve(workspace), undefined)
  // 空字符串/非法输入不能抛。
  const weird = await resolver.resolveProjectScope('')
  check('   空 workspaceRoot 不抛，回空列表', JSON.stringify(weird.repositories), '[]')
}

// ===========================================================================
section('11. 两份副本逐字节相同，且都能 import')
{
  const reviewText = readFileSync(REVIEW, 'utf8')
  const gitbarText = readFileSync(GITBAR, 'utf8')
  checkTrue('11) 两个文件的文本完全相同', reviewText === gitbarText)
  const reviewModule = await import(pathToFileURL(REVIEW).href)
  const gitbarModule = await import(pathToFileURL(GITBAR).href)
  for (const name of ['toNativePath', 'isAbsoluteLike', 'createProjectGitScope', 'createRepoContextResolver', 'PROJECT_SCOPE_LIMITS', 'REPO_CONTEXT_CACHE_MAX', 'REPO_CONTEXT_TTL_MS', 'REPO_CONTEXT_NEGATIVE_TTL_MS']) {
    checkTrue(`   review 导出 ${name}`, typeof reviewModule[name] !== 'undefined')
    checkTrue(`   gitbar 导出 ${name}`, typeof gitbarModule[name] !== 'undefined')
  }
  check('   两个模块的 limits 一致', JSON.stringify(reviewModule.PROJECT_SCOPE_LIMITS), JSON.stringify(gitbarModule.PROJECT_SCOPE_LIMITS))
  const resolver = reviewModule.createRepoContextResolver({ runGit: async () => '' })
  for (const name of ['resolveProjectScope', 'peekProjectScope', 'invalidateProjectScope']) {
    check(`   resolver 有 ${name}`, typeof resolver[name], 'function')
  }
}

console.log('')
console.log(failures === 0 ? '项目级仓库发现测试全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
