/**
 * 工作区切换协议（切换 → 重启 → 启动时解析）。
 *
 * ## 为什么必须重启整个应用，而不是只换掉 DshServer 的 `--workspace`
 *
 * 1.2.0–1.5.8 曾改成"就地切换"：停掉旧服务端、用新工作区新建一个 DshServer、把同一个
 * 窗口重新导航过去。它看起来只差一个"通知 Harness"的步骤，实际差的是**整个工作区生命
 * 周期**。Harness 的项目/工作区状态不是服务端进程的 cwd，而是 `ctx.workspaceRegistry`
 * 里的**持久化记录**（`<home>/storages/workspace.json`，官方 UI 的工作区列表就是它的
 * 投影）。它只在首次启动时按会话历史引导一次，之后不会再自己发现新目录；唯一会新增记录
 * 的公开入口是 `workspaceRegistry.create()`（官方 UI 的「添加工作区…」走的就是它）。
 *
 * 于是"就地切换"给出了一个错位状态：
 *
 *     Desktop Shell workspace = 新目录   ✅（settings.json）
 *     DshServer cwd           = 新目录   ✅（--workspace + chdir）
 *     Git 插件看到的目录       = 新目录   ✅（DSH_DESKTOP_WORKSPACE）
 *     Harness 项目/工作区状态  = 没有新目录 ❌（注册表里没有这条记录）
 *
 * 前三条只是**进程级**状态，第四条才是官方 UI 认的项目状态，所以界面停在旧项目上，
 * 而 git 插件（自己按 cwd 解析仓库）已经把新目录的提交图画了出来。这个区别由
 * `scripts/test-workspace-registration.mjs` 同时断言两层，防止再被混为一谈。
 *
 * 现在的分工是：启动路径负责登记（见 `src/server/server.mjs` 的 `registerWorkspace`），
 * 切换路径负责"写意图 + 重启"，让**每一次**工作区都经过同一条完整启动流程。
 * 重启这个动作本身也是刻意的：它只有一条启动路径，不存在"半个进程还在用旧工作区"的
 * 中间态，也不需要维护客户端陈旧状态（新的服务端端口意味着新的 origin）。
 *
 * 本模块不导入 Electron：重启的动作由调用方注入（`relaunch` / `exit`），因此整条协议
 * 都可以在没有图形环境的回归测试里跑。
 */
import { existsSync } from 'node:fs'
import { readSettings, switchWorkspace } from './settings'
import type { WorkspaceResolution } from './workspace'
import {
  fallbackWorkspace,
  isSameWorkspace,
  markPendingForget,
  markPendingWorkspace,
  normalizeWorkspaceArgument,
  takePendingWorkspace,
} from './workspace'

/**
 * 决定本次启动把哪个目录当作工作区，**并保留它的来源**。
 *
 * 优先级：**切换意图 > 命令行参数 > 上次记住的选择 > 用户主目录**。
 *
 * 为什么"切换意图"排在命令行参数之前：`app.relaunch()` 会沿用原来的命令行，而
 * 「打开文件夹」正是靠重启生效的，于是重启后的 argv 里带着**旧**工作区。若让它排在前面，
 * 用户刚选的新路径会被盖掉（表现为"重启了但还是老目录"，见 c968ab4a）。因此切换时把目标
 * 写进 `pending-workspace`，它在本次启动里优先级最高，读到即删。
 *
 * 返回 `source` 而不是只返回字符串，是因为"这个路径是怎么来的"决定了服务端是否应该把它
 * `registry.create()` 进 Harness（见 workspace-reconcile.ts）。旧代码只返回字符串，于是
 * "上次记住的 A"与"用户明确要打开 A"在服务端看起来一模一样——用户在 Harness 里删掉的
 * 工作区会在下次启动时被无声地创建回来。
 *
 * 本函数**不写任何文件**（除了消费 `pending-workspace` 标记）：落盘由
 * `reconcileWorkspaceState()` 统一负责，这样"prune + persist"只有一个入口。
 *
 * @param argv - 本次启动的 `process.argv`。
 * @param userDataDir - 应用数据目录。
 * @returns 工作区路径与来源。
 */
export function resolveWorkspaceIntent(argv: string[], userDataDir: string): WorkspaceResolution {
  const pending = takePendingWorkspace(userDataDir)
  if (pending !== undefined) return { path: pending, source: 'pending' }

  const fromArgv = argv.slice(1).find((token) => !token.startsWith('--') && !token.startsWith('-'))
  if (fromArgv !== undefined) {
    const normalized = normalizeWorkspaceArgument(fromArgv)
    if (normalized !== undefined) return { path: normalized, source: 'argv' }
  }

  const remembered = readSettings(userDataDir).workspace
  if (remembered !== undefined && existsSync(remembered)) return { path: remembered, source: 'remembered' }
  return { path: fallbackWorkspace(), source: 'fallback' }
}

/**
 * 决定本次启动把哪个目录当作工作区（只要路径）。
 *
 * 保留这个形状是为了不打断既有调用方与回归测试；启动路径请用
 * {@link resolveWorkspaceIntent} + `reconcileWorkspaceState()`，因为只有那两个一起
 * 才能回答"是否允许登记"。
 *
 * 这里顺手把**显式意图**记进 settings（`workspace` + `recent`）：命令行打开一个目录同样
 * 应当进入「最近打开」列表。记住的选择与兜底值不写——它们不是用户的选择。
 *
 * @param argv - 本次启动的 `process.argv`。
 * @param userDataDir - 应用数据目录。
 * @returns 工作区绝对路径。
 */
export function resolveWorkspace(argv: string[], userDataDir: string): string {
  const resolution = resolveWorkspaceIntent(argv, userDataDir)
  if (resolution.source === 'pending' || resolution.source === 'argv') {
    switchWorkspace(userDataDir, resolution.path)
  }
  return resolution.path
}

/** 重启式切换需要的外部动作（由 Electron 侧注入，便于测试）。 */
export interface WorkspaceSwitchEffects {
  /**
   * 宣告"本实例要退出了"。
   *
   * 只在**确实要重启**时调用：外壳的"关窗即隐藏到托盘"依赖这个标记让开，而若在一次
   * 没有发生的切换（选中的就是当前目录）上把它置位，之后关窗就会真的退出应用。
   */
  beginQuit: () => void
  /** 停掉当前的服务端子进程。 */
  stopServer: () => Promise<void>
  /** 重新启动本应用（`app.relaunch()`）。 */
  relaunch: () => void
  /** 结束当前实例（`app.exit(code)`）。 */
  exit: (code: number) => void
}

/** 一次切换请求的结果。 */
export type WorkspaceSwitchOutcome =
  /** 已记录切换意图，应用正在/即将重启。 */
  | 'restart'
  /** 目标就是当前工作区，什么都没做。 */
  | 'unchanged'

/**
 * 切换工作区：记录选择、留下"待切换"标记、然后重启应用。
 *
 * 先停子进程再重启：重启后的新进程会用同一个 harness home，两个服务端同时活着会争用它。
 * 停不掉也照样重启——停在一个"没有服务端"的状态比多重启一次更糟，因此这里的失败只记一笔。
 *
 * @param options - 目标工作区与外部动作。
 * @returns 本次请求的结果。
 */
export async function restartIntoWorkspace(
  options: { userDataDir: string; current: string; target: string } & WorkspaceSwitchEffects,
): Promise<WorkspaceSwitchOutcome> {
  const { userDataDir, current, target } = options
  // 允许 target 为空（菜单里"最近打开"的空条目）：那不是一次切换。
  if (target === '' || isSameWorkspace(target, current)) return 'unchanged'

  // 到这里才算真的切换了：先宣告退出意图，再落设置与标记。
  options.beginQuit()

  // 顺序有意义：先让 settings 里的"当前工作区 + 最近打开"落到目标，再写标记。
  // 标记是耗材（读到即删），写失败时 settings 仍是正确的，最多退回旧 argv。
  switchWorkspace(userDataDir, target)
  markPendingWorkspace(userDataDir, target)

  try {
    await options.stopServer()
  } catch (error) {
    console.warn(`[shell] 重启前停止服务端失败，继续重启: ${String(error)}`)
  }

  options.relaunch()
  options.exit(0)
  return 'restart'
}

/**
 * 「文件 → 移除工作区…」（Forget Workspace）的决策与执行。
 *
 * 语义（必须与另外两件事严格区分，见 workspace-actions.ts）：
 *
 *     从最近项目中移除  → 只删 Desktop 的 `recent` 记录
 *     移除工作区        → 只删 **Harness 注册表**里的登记（文件与提交全留着）
 *     删除目录          → 删磁盘上的文件（本应用**从不**做）
 *
 * 为什么它也要重启：注册表由服务端子进程里的 `ctx.workspaceRegistry` 独占，唯一安全的
 * 写入口是官方 `delete(id)`。让删除跟着**同一条启动路径**走，就不存在"外壳以为删了、
 * 服务端还留着"的中间态，也不需要为一次删除维护第二条控制通道。
 *
 * 当前工作区不能被"移除后留在原地"（需求：不能出现 active 指着已移除工作区的半失效
 * 状态），因此目标就是当前工作区时，**先**把下一次启动的工作区改成 `nextActive`
 * （必须是一个仍然存在的目录；调用方按"注册表里最近的有效工作区 → 主目录"给出），
 * 再留下移除意图。服务端按"先移除、后登记"的顺序执行，两者不会互相打架。
 *
 * @param options - 目标工作区、当前工作区、接管者与外部动作。
 * @returns `'forget'` 表示已记录意图并重启；`'unchanged'` 表示参数无效、什么都没做。
 */
export async function forgetWorkspaceAndRestart(
  options: {
    userDataDir: string
    /** 要移除的工作区（任意写法）。 */
    target: string
    /** 当前 active workspace。 */
    current: string
    /**
     * 目标就是当前工作区时用来接管的工作区。
     *
     * 省略或指向目标本身时用主目录：应用必须有一个工作区，而主目录是文档化的兜底。
     */
    nextActive?: string
  } & WorkspaceSwitchEffects,
): Promise<'forget' | 'unchanged'> {
  const { userDataDir, target, current } = options
  if (target === '') return 'unchanged'
  const forgettingCurrent = isSameWorkspace(target, current)
  const candidate = options.nextActive !== undefined && options.nextActive !== '' && !isSameWorkspace(options.nextActive, target)
    ? options.nextActive
    : fallbackWorkspace()

  options.beginQuit()
  if (forgettingCurrent) {
    // 顺序有意义：先把下一次启动的工作区钉住，再留移除意图。标记是耗材，写失败时
    // settings 仍然正确（最多退回旧 argv——而旧 argv 正是被移除的那个，因此这里先写
    // settings 再写标记，与 restartIntoWorkspace 同一个顺序）。
    switchWorkspace(userDataDir, candidate)
    markPendingWorkspace(userDataDir, candidate)
  }
  markPendingForget(userDataDir, target)

  try {
    await options.stopServer()
  } catch (error) {
    console.warn(`[shell] 移除工作区前停止服务端失败，继续重启: ${String(error)}`)
  }

  options.relaunch()
  options.exit(0)
  return 'forget'
}

/**
 * 「文件 → 打开文件夹」的决策流程。
 *
 * 与 Electron 对话框解耦：目录选择器与确认框由调用方注入，于是"关闭选择器"、
 * "确认框里取消"、"选中的就是当前目录"这三条早退分支都能被回归测试直接断言。
 *
 * 判定顺序是刻意的：
 *   * 先看有没有选中目录（关闭选择器 = 什么都不做）；
 *   * 再比当前工作区（选中同一个目录时不该弹确认框，更不该重启）；
 *   * 最后才问用户要不要切换（取消 = 什么都不做）。
 *
 * @param deps - 当前工作区、目录选择器与确认框。
 * @returns 要切换到的目录；`undefined` 表示不做任何改动。
 */
export function pickFolderToOpen(deps: {
  currentWorkspace: string
  /** 弹出目录选择器：返回选中的目录，或 undefined（用户关闭了选择器）。 */
  showOpenDialog: () => string | undefined
  /** 弹出确认框：返回用户是否确认切换。 */
  confirm: (dir: string) => boolean
}): string | undefined {
  const picked = deps.showOpenDialog()
  if (picked === undefined || picked === '') return undefined
  if (isSameWorkspace(picked, deps.currentWorkspace)) return undefined
  if (!deps.confirm(picked)) return undefined
  return picked
}
