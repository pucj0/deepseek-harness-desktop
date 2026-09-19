// gitbar 的 host 半边。
//
// 职责只有一件：在 webServer 上注册两个只读/低风险的 git 路由，供客户端半边取
// 分支信息与切换分支。UI 本身完全在 client.js 里实现。
//
// 为什么走 HTTP 而不是在渲染进程里跑 git：渲染进程是 sandbox + contextIsolation
// 的纯 web 环境，没有 Node 能力，也不应该获得——那正是外壳一直坚持的边界。git 由
// host 侧用 execFile 调用，客户端只发请求。
//
// 安全约束（这些不是可选的，见 createGitHandler 的注释）：
//   1. 只允许白名单内的 git 子命令，不接受任意命令字符串
//   2. 分支名严格校验，杜绝把 `--upload-pack=…` 之类的参数或路径穿越塞进来
//   3. 用 execFile（参数数组）而不是 exec（shell 字符串），从根上避免 shell 注入
//   4. 不做自动 stash：切换分支会改变用户工作区，必须由用户明确选择
import { execFile } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** 插件名，用于诊断与 effect 标签。 */
export const name = 'gitbar'

/** 必须先有 webServer 服务，路由才有地方注册。 */
export const inject = ['webServer']

/**
 * 两个路由共用的路径前缀。
 *
 * 用 `/dsh-desktop/` 前缀是为了与 dsh 自身的路由区分开，将来排查时一眼能看出这是
 * 外壳侧插件提供的。
 */
const ROUTE_PREFIX = '/dsh-desktop/gitbar'

/**
 * 允许通过路由切换到的分支名格式。
 *
 * 刻意收紧到"像分支名"的字符集：Git 允许的名字比这宽得多，但这里的目标是**不可能**
 * 构造出选项或路径穿越。以 `-` 开头被排除，因此 `--upload-pack=…` 之类无法通过；
 * 不含 `..`，因此无法越出仓库。
 */
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,200}$/u

/** git 命令的超时。仓库很大时 `status` 可能略慢，但不该拖住 UI。 */
const GIT_TIMEOUT_MS = 8000

/** 单次响应体的上限，防止收集分支列表时把大仓库的极端输出全塞进内存。 */
const MAX_BRANCHES = 500

/**
 * 运行一条 git 命令。
 *
 * **一律带上 `-c core.fileMode=false`**：Windows 表达不了可执行位，而仓库若带着
 * `core.fileMode=true`（从 Linux 仓库带过来的配置极常见），`git status` 会把
 * `docker/entrypoint.sh` 这类"HEAD 是 100755、工作区是 100644"的文件报成已修改——
 * 内容一个字没变，徽章上的改动数却是 1。带上该标志后 git 不再比较可执行位，
 * 实测改动数从 1 变 0（审查插件那边同理，见 dsh-client-ui-review 的说明）。
 *
 * @param args - 参数数组（不含 `git` 本身）。
 * @param cwd - 仓库工作目录。
 * @returns stdout；失败时抛出带 stderr 的错误。
 */
function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      // `-C <dir>` 而不是 cwd 选项：显式指定仓库目录，且不依赖进程当前目录。
      ['-c', 'core.fileMode=false', '-C', cwd, ...args],
      { timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(String(stderr).trim() || error.message))
          return
        }
        resolve(String(stdout))
      },
    )
  })
}

/**
 * 解析外壳启动时的工作区。
 *
 * 优先取外壳注入的环境变量：`server.mjs` 在启动时已经知道工作区，注入它比让插件
 * 靠 `process.cwd()` 猜测更可靠（当前目录会被其它代码改变）。两者都拿不到时不报错，
 * 而是返回 undefined 由调用方给出明确诊断。
 *
 * @returns 绝对路径，或 undefined。
 */
function shellWorkspace() {
  const injected = process.env.DSH_DESKTOP_WORKSPACE
  if (typeof injected === 'string' && injected !== '') return injected
  return process.cwd()
}

/**
 * 收集允许被当作工作区的目录。
 *
 * = 外壳启动时的工作区 + 应用侧登记过的所有工作区。后者存在
 * `<home>/storages/workspace.json`（同一份文件应用界面用来列出可选项目）。
 *
 * 读不到或不认识该文件时退化为"只有外壳工作区"，而不是抛错——本地化/多项目是增强，
 * 不该因为它而让整个插件挂不上。
 *
 * @returns 绝对路径数组（可能只含外壳工作区）。
 */
function collectAllowedRoots() {
  const roots = new Set()
  const shell = shellWorkspace()
  if (shell !== undefined) roots.add(shell)

  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') {
    const file = join(home, 'storages', 'workspace.json')
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const table = parsed?.tables?.workspaces
      if (table !== null && typeof table === 'object') {
        for (const record of Object.values(table)) {
          const root = record?.root ?? record?.path
          if (typeof root === 'string' && root !== '') roots.add(root)
        }
      }
    } catch {
      // 文件不存在或结构变化——只用外壳工作区即可。
    }
  }
  return [...roots]
}

/**
 * 读取当前分支与工作区状态。
 *
 * 一次 `status --porcelain=v2 --branch` 同时给出分支、上游、领先/落后与改动文件数，
 * 比多次调用更省进程也更一致（多次调用之间用户可能刚好切了分支）。
 *
 * @param cwd - 工作区路径。
 * @returns 供客户端渲染的状态对象。
 */
async function readStatus(cwd) {
  const raw = await git(['status', '--porcelain=v2', '--branch'], cwd)

  const state = {
    isRepo: true,
    branch: '',
    detached: false,
    upstream: '',
    ahead: 0,
    behind: 0,
    changedFiles: 0,
  }

  for (const line of raw.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const value = line.slice('# branch.head '.length).trim()
      // git 在游离 HEAD 上会给出 "(detached)"。
      if (value === '(detached)') state.detached = true
      else state.branch = value
    } else if (line.startsWith('# branch.upstream ')) {
      state.upstream = line.slice('# branch.upstream '.length).trim()
    } else if (line.startsWith('# branch.ab ')) {
      const match = /\+(\d+)\s+-(\d+)/u.exec(line)
      if (match !== null) {
        state.ahead = Number(match[1])
        state.behind = Number(match[2])
      }
    } else if (line !== '' && !line.startsWith('#')) {
      state.changedFiles += 1
    }
  }
  return state
}

/**
 * 列出可切换的分支：本地在前，远程在后，各自带 `isRemote` 标记。
 *
 * 只列本地是不够的。实测一个真实仓库：本地 4 个分支、远程 27 个——团队协作时大部分
 * 分支只存在于远程，用户想在界面上切换却看不到它们，会直接得出"这个功能没用"的结论。
 *
 * 切换远程分支时用 `git checkout <名字>`：git 会自动创建同名的本地跟踪分支，这正是
 * 用户在 IDE 里期待的行为，不需要 `-b` 或 `--track`。
 *
 * @param cwd - 工作区路径。
 * @returns 分支条目数组，本地在前。
 */
async function listBranches(cwd) {
  // 用两个独立的 refname 空间查询，而不是 `branch --all` 后靠"名字里有没有斜杠"猜：
  // 后者会把远程的符号引用 `origin` 误判成本地分支（实测踩到过，它不带斜杠）。
  //   refs/heads/   —— 本地分支
  //   refs/remotes/ —— 远程分支（含各远程的 HEAD 符号引用，需排除）
  const format = '%(refname)\t%(HEAD)'
  const [localRaw, remoteRaw] = await Promise.all([
    git(['for-each-ref', '--format=' + format, 'refs/heads/'], cwd),
    git(['for-each-ref', '--format=' + format, 'refs/remotes/'], cwd),
  ])

  const parse = (raw, prefix, isRemote) =>
    raw
      .split('\n')
      .map((line) => line.split('\t'))
      .map(([refname, head]) => ({
        // 去掉 `refs/heads/` 或 `refs/remotes/` 前缀，得到可切换的名字。
        name: (refname ?? '').slice(prefix.length).trim(),
        head: (head ?? '').trim(),
      }))
      .filter(({ name }) => name !== '')
      // `origin/HEAD` 之类的符号引用不是可切换的分支。
      .filter(({ name }) => !name.endsWith('/HEAD'))
      .map(({ name, head }) => ({ name, isRemote, current: head === '*' }))

  const local = parse(localRaw, 'refs/heads/', false)
  const remote = parse(remoteRaw, 'refs/remotes/', true)

  // 本地在前（用户最常切的是本地），各自按名字排序，最后按上限截断。
  const byName = (a, b) => a.name.localeCompare(b.name)
  local.sort(byName)
  remote.sort(byName)
  return [...local, ...remote].slice(0, MAX_BRANCHES)
}

/**
 * 给响应体写 JSON。
 *
 * @param response - HTTP 响应。
 * @param status - 状态码。
 * @param payload - 可序列化的负载。
 */
function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  // 分支状态会随用户操作（切分支、改文件）立刻变化，不能缓存。
  response.setHeader('cache-control', 'no-store')
  response.end(body)
}

/**
 * 读取并限制请求体，避免 unbounded 读取。
 *
 * @param request - HTTP 请求。
 * @returns 请求体文本（上限 8 KiB）。
 */
async function readSmallBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 8192) throw new Error('request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 判断仓库当前是否有未提交改动（含未跟踪文件）。
 *
 * 用 `status --porcelain` 而不是只看已跟踪改动：未跟踪文件同样可能被 checkout 拦下
 * （目标分支里存在同名文件时），此时只报"暂存并切换"才准确。
 *
 * @param cwd - 工作区路径。
 * @returns 是否有未提交改动。
 */
async function isDirty(cwd) {
  const raw = await git(['status', '--porcelain'], cwd)
  return raw.trim() !== ''
}

/**
 * 把未提交改动存进 stash（含未跟踪文件），并返回 stash 引用。
 *
 * 只在用户明确点了「暂存并切换」时调用——**绝不自动执行**。stash 是可恢复的
 * （`git stash pop`），但仍是替用户移动了他的工作区状态，必须由他决定。
 *
 * @param cwd - 工作区路径。
 * @param branch - 目标分支名，仅用于生成可辨认的 stash 消息。
 * @returns 成功时的 `{ stashed: true, ref }`；无改动可暂存时 `{ stashed: false }`。
 */
async function stashChanges(cwd, branch) {
  if (!(await isDirty(cwd))) return { stashed: false }
  // -u 把未跟踪文件一并纳入：否则它们可能在切换后被目标分支的同名文件覆盖或残留。
  await git(['stash', 'push', '-u', '-m', `dsh-gitbar: 切换到 ${branch} 前的自动暂存`], cwd)
  const ref = (await git(['rev-parse', '--short', 'stash'], cwd)).trim()
  return { stashed: true, ref }
}

/**
 * 解析本次请求要操作的工作区。
 *
 * **必须是每次请求传入的**，不能用外壳启动时的那个。原因：应用内可以给会话选择
 * 工作区（侧边栏「选择工作区」），它与外壳的 `--workspace` 是两回事。实测踩到过：
 * 外壳工作区是 `mmsm-amis`、会话切到了 `scheduler-service-task`，徽章却一直显示
 * 前一个仓库的分支——因为 host 拿的是固定的外壳工作区。
 *
 * 安全约束：只接受**已存在于 allowedRoots** 的路径。否则任何能访问 loopback 的
 * 页面都能让 host 对任意目录执行 git 命令，那是明显的越权面。
 * 用 realpath 比较以消除 `..` 与符号链接造成的等价路径绕过。
 *
 * @param requestUrl - 请求的 URL 对象。
 * @param allowedRoots - 允许的工作区集合（外壳工作区 + 已登记的应用工作区）。
 * @returns 绝对路径，或 undefined（不在允许集合内）。
 */
function resolveRequestWorkspace(requestUrl, allowedRoots) {
  const requested = requestUrl.searchParams.get('cwd')
  // 必须同时判 null 与空串：`URLSearchParams.get()` 在参数缺失时返回 **null**，
  // 只判 undefined/'' 会让 null 漏下去，随后 realpathSync 抛出
  // "The path argument must be of type string. Received null"（实测踩到过，
  // 表现为本该 400 的请求变成 500）。
  if (typeof requested !== 'string' || requested === '') return undefined
  if (!isAbsolute(requested)) return undefined

  let real
  try {
    real = realpathSync.native(requested)
  } catch {
    return undefined
  }
  for (const root of allowedRoots) {
    try {
      if (realpathSync.native(root) === real) return real
    } catch {
      // 允许集合里的某个根已不存在——跳过，不影响其它根。
    }
  }
  return undefined
}

/**
 * 创建 git 路由的处理器。
 *
 * @param allowedRoots - 允许作为工作区的目录集合。
 * @returns `(request, response)` 处理器。
 */
function createGitHandler() {
  return async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')

      // 每次请求都解析工作区，并且**每次都重读**允许集合。
      //
      // 重读的原因：应用侧的 `workspace.json` 会在运行中被更新（用户新选一个项目），
      // 而在 apply 时算一次就会把新项目挡在门外。重读一个小 JSON 的成本可以忽略。
      const workspace = resolveRequestWorkspace(url, collectAllowedRoots())
      if (workspace === undefined) {
        sendJson(response, 400, {
          error: 'workspace not allowed',
          code: 'workspaceNotAllowed',
          detail: 'cwd must be one of the workspaces known to this app',
        })
        return
      }

      // GET  —— 分支状态（含改动数、领先/落后）
      if (request.method === 'GET') {
        if (url.pathname === `${ROUTE_PREFIX}/status`) {
          sendJson(response, 200, await readStatus(workspace))
          return
        }
        if (url.pathname === `${ROUTE_PREFIX}/branches`) {
          sendJson(response, 200, { branches: await listBranches(workspace) })
          return
        }
        sendJson(response, 404, { error: 'not found' })
        return
      }

      // POST —— 切换分支
      if (request.method === 'POST' && url.pathname === `${ROUTE_PREFIX}/checkout`) {
        let payload
        try {
          payload = JSON.parse(await readSmallBody(request))
        } catch (error) {
          sendJson(response, 400, { error: `invalid body: ${String(error.message)}` })
          return
        }
        const branch = payload?.branch
        if (typeof branch !== 'string' || !BRANCH_PATTERN.test(branch)) {
          // 明确拒绝并说明原因：这是安全边界，不是"参数格式错误"的客套话。
          sendJson(response, 400, {
            error: 'invalid branch name',
            detail: 'only [A-Za-z0-9._/-] up to 200 chars is accepted',
          })
          return
        }
        // 用户明确要求先暂存：只有这种情况才动 stash，绝不自动执行。
        // stash 是可恢复的（git stash pop），但仍是替用户移动了工作区状态，
        // 必须由他明确选择。
        let stash = { stashed: false }
        if (payload?.stash === true) {
          try {
            if (!(await isDirty(workspace))) {
              // 只回稳定的 code，不带任何自然语言：host 不知道界面语言，
              // 提示文案由客户端按当前语言渲染。
              sendJson(response, 400, { error: 'nothing to stash', code: 'nothingToStash' })
              return
            }
            stash = await stashChanges(workspace, branch)
          } catch (error) {
            sendJson(response, 409, {
              error: 'stash failed',
              code: 'stashFailed',
              detail: String(error.message),
            })
            return
          }
        }

        try {
          // 不加 --force：有未提交改动时 git 自己会拒绝，把这个决定留给用户，
          // 而不是替他丢弃或暂存改动。
          await git(['checkout', branch], workspace)
        } catch (error) {
          // 带一个**稳定的 code**：客户端据此渲染当前语言的提示。
          // git 自己的英文原文照旧放在 `detail` 里——它是权威信息，翻译反而失真。
          sendJson(response, 409, {
            error: 'checkout failed',
            code: 'localChanges',
            detail: String(error.message),
          })
          return
        }
        // 把 stash 结果一并返回：界面要能告诉用户"改动存到哪个 stash 了"，
        // 否则他会以为改动丢了。
        sendJson(response, 200, { ...(await readStatus(workspace)), stash })
        return
      }

      response.setHeader('allow', 'GET, POST')
      sendJson(response, 405, { error: 'method not allowed' })
    } catch (error) {
      // 任何未预期错误都转成 JSON，避免客户端拿到 HTML 错误页而无法解析。
      sendJson(response, 500, { error: String(error?.message ?? error) })
    }
  }
}

/**
 * 挂载插件。
 * @param ctx - host 侧 cordis 上下文。
 */
export function apply(ctx) {
  // 工作区在**每次请求**里解析（见 createGitHandler），因为会话可以选择自己的项目：
  // 那只存在应用侧状态里（`<home>/storages/workspace.json`），外壳启动时的
  // `--workspace` 只是其中之一。不这样处理，用户切换项目后徽章会继续显示上一个
  // 仓库的分支——实测踩到过。
  const handler = createGitHandler()

  // 注册为两条精确路由而不是一条前缀路由：webServer 的 kind 只有 exact 与 prefix
  // 两类语义，用精确路径可以让"哪些路径属于本插件"在注册表里一目了然。
  for (const path of [`${ROUTE_PREFIX}/status`, `${ROUTE_PREFIX}/branches`, `${ROUTE_PREFIX}/checkout`]) {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path, handler }),
      `gitbar: ${path}`,
    )
  }
}
