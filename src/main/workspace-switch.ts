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
import {
  fallbackWorkspace,
  isSameWorkspace,
  markPendingWorkspace,
  normalizeWorkspaceArgument,
  takePendingWorkspace,
} from './workspace'

/**
 * 决定本次启动把哪个目录当作工作区。
 *
 * 优先级：**切换意图 > 命令行参数 > 上次记住的选择 > 用户主目录**。
 *
 * 为什么"切换意图"排在命令行参数之前：`app.relaunch()` 会沿用原来的命令行，而
 * 「打开文件夹」正是靠重启生效的，于是重启后的 argv 里带着**旧**工作区。若让它排在前面，
 * 用户刚选的新路径会被盖掉（表现为"重启了但还是老目录"，见 c968ab4a）。因此切换时把目标
 * 写进 `pending-workspace`，它在本次启动里优先级最高，读到即删。
 *
 * @param argv - 本次启动的 `process.argv`。
 * @param userDataDir - 应用数据目录。
 * @returns 工作区绝对路径。
 */
export function resolveWorkspace(argv: string[], userDataDir: string): string {
  const pending = takePendingWorkspace(userDataDir)
  if (pending !== undefined) {
    switchWorkspace(userDataDir, pending)
    return pending
  }

  const fromArgv = argv.slice(1).find((token) => !token.startsWith('--') && !token.startsWith('-'))
  if (fromArgv !== undefined) {
    const normalized = normalizeWorkspaceArgument(fromArgv)
    if (normalized !== undefined) {
      // 走 switchWorkspace 而不是只写 workspace：命令行打开一个目录同样应当
      // 进入"最近打开"列表。
      switchWorkspace(userDataDir, normalized)
      return normalized
    }
  }

  const remembered = readSettings(userDataDir).workspace
  if (remembered !== undefined && existsSync(remembered)) return remembered
  return fallbackWorkspace()
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
