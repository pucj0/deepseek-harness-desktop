/**
 * 运行期唯一权威的 **active workspace**。
 *
 * ## 为什么必须有这个对象
 *
 * 以前只有一个进程级常量：
 *
 * ```ts
 * const workspace = resolveWorkspace(process.argv, userDataDir)   // 启动时算一次
 * ```
 *
 * 菜单与托盘把它闭包捕获下来，于是「项目信息 / 在文件管理器中打开工作区 / 复制工作区
 * 路径」永远指向**启动时**那个目录。可是 Harness UI 可以在运行中切换当前项目（每个会话
 * 属于一个项目，用户点一下就换了），两者立刻不一致：
 *
 *     Harness 当前项目 = B
 *     外壳菜单动的却是 A     ← BUG B
 *
 * 现在把两件事拆开：
 *
 *     startup workspace   启动参数决定的引导工作区；本次进程内**永不改变**
 *     active workspace    运行期真正生效的工作区；Harness ready 之后由 Harness 决定
 *
 * `startupWorkspace` 仍然只用在三个地方（它们本来就该用启动值）：服务端启动参数、
 * 初始登记、启动期 Git 初始化。其余一切"当前工作区"的语义都读 {@link ActiveWorkspaceController.get}。
 *
 * ## 为什么 Harness 是 source of truth
 *
 * 项目/工作区是**会话的属性**（`sessions.current → byId[current].cwd`），只有 Harness 的
 * 渲染进程知道用户此刻在看哪个项目。外壳不去猜：不读侧栏文字、不看页面标题、不装
 * MutationObserver，而是由内置的 `dsh-client-ui-shell-bridge` 插件把
 * `ctx.sessions.list` 的当前会话 cwd 上报过来（见 preload.ts 与 window.ts）。
 *
 * 上报的路径是**不可信输入**，必须过三道校验才可能成为 active：
 *   1. 必须是绝对路径字符串；
 *   2. 必须是当前存在的目录；
 *   3. 必须已经是 Harness 注册表里的工作区（安全边界——渲染进程不能凭空让外壳
 *      去打开任意路径，见需求「不要允许网页发送 C:\Windows 然后 Shell 帮它打开」）。
 */
import type { WorkspaceResolution, WorkspaceSource } from './workspace'
import { workspaceIdentity } from './workspace'
import type { WorkspaceRegistryView } from './workspace-registry'

/** active workspace 的来源：启动期那四种，或运行期由 Harness 上报。 */
export type ActiveWorkspaceOrigin = WorkspaceSource | 'harness'

/** 一次上报的结果。 */
export type ActiveWorkspaceReport =
  /** 接受了，active 因此改变。 */
  | 'accepted'
  /** 合法，但和当前值相同（含"Harness 报告当前没有会话"）。 */
  | 'unchanged'
  /** 没通过校验，被丢弃。 */
  | 'rejected'

/** 构造控制器需要的外部依赖（全部注入，因此不依赖 Electron，可离线测试）。 */
export interface ActiveWorkspaceOptions {
  /** 启动期解析出的工作区与来源。 */
  startup: WorkspaceResolution
  /**
   * **严格**判定：这个路径现在是不是 Harness 注册表里的工作区。
   *
   * 只用于 {@link ActiveWorkspaceController.reportFromHarness} 的准入校验（安全边界：
   * 渲染进程送来的路径必须已经登记过才可能成为 active）。
   */
  isRegistered: (path: string) => boolean
  /**
   * **宽松**判定：还能不能证明这个路径**不再**是注册过的工作区。
   *
   * 用在点击菜单时的有效性检查上，因此必须偏向"不要误判为失效"：
   *   * 读不到注册表（首次启动、文件正在被服务端重写）→ 返回 **true**（"不知道"≠"被删了"）；
   *   * 注册表里一个文件系统工作区都没有 → 返回 **true**（那不是"你删了它"）；
   *   * 只有在**确实读到注册表、且里面没有这条记录**时才返回 false。
   *
   * 与 {@link isRegistered} 分开是刻意的：把这两件事合成一个谓词，要么让安全校验在
   * 注册表读不到时放行任意路径，要么让菜单项在启动瞬间误判自己的工作区已失效。
   */
  isStillRegistered: (path: string) => boolean
  /** 这个路径是不是当前存在的目录。 */
  isDirectory: (path: string) => boolean
  /** 计算一个仍然有效的回退工作区（排除某个已失效的路径）。 */
  fallback: (exclude?: string) => string
  /** 把"当前有效工作区"持久化到 Desktop settings（唯一的写入口）。 */
  persist: (path: string) => void
}

/** 两个路径是否指向同一个目录。 */
const samePath = (left: string, right: string): boolean => workspaceIdentity(left) === workspaceIdentity(right)

/**
 * 运行期 active workspace 的唯一持有者。
 *
 * 不自己读文件、不自己弹对话框：校验与回退策略都由构造时注入，因此这一个类就能同时被
 * 主进程（真实 Electron）与回归测试（纯 Node）使用。
 */
export class ActiveWorkspaceController {
  private current: string
  private origin: ActiveWorkspaceOrigin
  private readonly listeners = new Set<() => void>()

  /**
   * @param options - 启动值、校验与回退策略。
   */
  constructor(private readonly options: ActiveWorkspaceOptions) {
    this.current = options.startup.path
    this.origin = options.startup.source
  }

  /** 当前 active workspace（**菜单/托盘/项目信息都在点击时调它**）。 */
  get(): string {
    return this.current
  }

  /** 当前值的来源。 */
  get currentOrigin(): ActiveWorkspaceOrigin {
    return this.origin
  }

  /** 当前值是不是 Harness 上报的（false = 仍然是启动期的决定）。 */
  get fromHarness(): boolean {
    return this.origin === 'harness'
  }

  /** 本次进程启动时的引导工作区（只给服务端参数/初始登记/启动期 Git 用）。 */
  get startupWorkspace(): string {
    return this.options.startup.path
  }

  /** 启动期解析出的来源。 */
  get startupSource(): WorkspaceSource {
    return this.options.startup.source
  }

  /**
   * 订阅 active workspace 的变化（菜单重建、托盘刷新用）。
   * @param listener - 变化回调。
   * @returns 取消订阅。
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 接收 Harness 上报的 active workspace。
   *
   * `null` / `undefined` 是合法输入，语义是"Harness 此刻没有当前会话"：这时**保持**上一个
   * 已知值而不是退回兜底——用户只是关掉了对话，菜单里的"当前项目"不该跟着乱跳。
   *
   * 被拒绝的路径如果**恰好就是当前 active**，说明用户在 Harness 里把当前工作区移除/删掉了
   * （需求：不能出现 active 指着已移除工作区的半失效状态）。此时立刻回退到一个仍然有效的
   * 工作区并落盘，菜单不会继续操作那个已经不存在的项目。
   *
   * @param candidate - 上报的路径（不可信输入）。
   * @returns 上报结果。
   */
  reportFromHarness(candidate: unknown): ActiveWorkspaceReport {
    if (candidate === null || candidate === undefined) return 'unchanged'
    if (typeof candidate !== 'string') return 'rejected'
    const path = candidate.trim()
    if (path === '' || !isAbsolutePath(path)) return 'rejected'
    if (!this.options.isDirectory(path)) return this.dropIfCurrent(path)
    if (!this.options.isRegistered(path)) return this.dropIfCurrent(path)
    if (samePath(path, this.current)) {
      // 记下"这已经是 Harness 的答案"：此后 active 由 Harness 决定，启动值不再参与。
      if (this.origin !== 'harness') {
        this.origin = 'harness'
        this.emit()
      }
      return 'unchanged'
    }
    this.adopt(path, 'harness')
    return 'accepted'
  }

  /**
   * 点击菜单时发现当前工作区已经失效：目录被删，**或者**它已经不在 Harness 注册表里。
   *
   * 由项目信息 / 在文件管理器中打开 / 复制路径三处在操作前调用（见
   * {@link ActiveWorkspaceController.isCurrentUsable}）。绝不静默失败：调用方据此给出
   * "工作区已不存在"的提示，并且这里已经把状态对账到一个仍然有效的工作区。
   *
   * 为什么"不再注册"也要走这里（需求 42 的**拉取路径**）：Harness 里删除工作区之后，
   * 推送路径（bridge 重新上报 → 被拒 → 回退）通常很快就会到达，但外壳不能**依赖**它——
   * 用户完全可能在那一刻就点了「复制工作区路径」。因此点击时的有效性检查必须自己问一次
   * 注册表，而不是只看目录还在不在。
   *
   * @returns 是否真的发生了对账（true = 状态已改变）。
   */
  invalidateCurrent(): boolean {
    this.adopt(this.options.fallback(this.current), 'fallback')
    return true
  }

  /**
   * 当前工作区**是否仍然有效**：目录存在，且仍然（能确认为）Harness 注册过的工作区。
   *
   * 两种 `origin` 不参与注册判定：
   *   * `harness` 之外由**外壳自己**回退选出的值（`origin === 'fallback'`）——它之所以被选出来，
   *     正是因为注册表里已经没有可用的了（注册表里最近的失效工作区 → 主目录）。回头再拿
   *     "必须在注册表里"去卡它，就会变成一个**死循环**：每次点击都提示失效、回退到同一个值、
   *     永远不执行任何操作，用户连"复制主目录路径"都做不到。
   *   * 具体"能不能确认它不再注册"由注入的宽松判定负责（读不到注册表时不会误判，见
   *     {@link ActiveWorkspaceOptions.isStillRegistered}）。
   *
   * @returns 有效则 true。
   */
  isCurrentUsable(): boolean {
    if (!this.options.isDirectory(this.current)) return false
    if (this.origin === 'fallback') return true
    return this.options.isStillRegistered(this.current)
  }

  /**
   * 当前工作区是否还是一个存在的目录。
   * @returns 存在则 true。
   */
  isUsable(): boolean {
    return this.options.isDirectory(this.current)
  }

  /** 被拒绝的路径恰好是当前 active 时，回退到一个仍然有效的工作区。 */
  private dropIfCurrent(path: string): ActiveWorkspaceReport {
    if (!samePath(path, this.current)) return 'rejected'
    this.adopt(this.options.fallback(path), 'fallback')
    return 'rejected'
  }

  /** 换一个 active 值：变了就落盘并通知；没变就什么都不做。 */
  private adopt(path: string, origin: ActiveWorkspaceOrigin): void {
    if (path === '' || samePath(path, this.current)) {
      if (origin === 'harness' && this.origin !== 'harness') {
        this.origin = 'harness'
        this.emit()
      }
      return
    }
    this.current = path
    this.origin = origin
    this.options.persist(path)
    this.emit()
  }

  /** 通知订阅者。 */
  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        console.warn(`[shell] active workspace 订阅者抛错: ${String(error)}`)
      }
    }
  }
}

/**
 * 粗判一个字符串是不是绝对路径。
 *
 * Windows（`C:\` / `\\server\`）与 POSIX（`/`）两种形态都认，且**不**相信
 * `node:path.isAbsolute`——它按当前平台判定，而这里要挡住的是"渲染进程送来的任意字符串"。
 * @param value - 候选路径。
 * @returns 像绝对路径则 true。
 */
export function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\') || value.startsWith('/')
}

/** 一次 Harness 上报的结果（比 {@link ActiveWorkspaceReport} 多一个"id 对不上"）。 */
export type HarnessReportOutcome = ActiveWorkspaceReport | 'idMismatch'

/** {@link applyHarnessReport} 的输入。 */
export interface HarnessReportPayload {
  /** 上报的工作区路径；`null` = Harness 此刻没有当前会话。 */
  path: string | null
  /** 官方工作区 id（可选）。 */
  workspaceId?: string
}

/**
 * 把一条 Harness 上报应用到控制器上——**外壳侧唯一的策略入口**。
 *
 * 抽成独立函数（而不是写在 `index.ts` 的闭包里）是为了让它可被测试直接驱动：这条策略
 * 是"外壳相信谁"的全部内容，两端（真实主进程 / 回归测试）必须跑的是同一份代码。
 *
 * 校验链：
 *   1. `path: null` → 交给控制器（保持上一个已知值）；
 *   2. 带了 `workspaceId` 时，先按 id 在注册表里找；找不到、或**它指向的路径与上报的路径
 *      不一致**，整条丢弃（`idMismatch`）——交叉核对比只看路径更强；
 *   3. 剩下的交给 {@link ActiveWorkspaceController.reportFromHarness}：绝对路径 +
 *      目录存在 + 已注册，三者缺一即拒。
 *
 * @param controller - active workspace 控制器。
 * @param payload - 已通过形状校验的上报载荷。
 * @param registry - 读注册表视图的函数（每次现读：写入方是服务端子进程）。
 * @returns 上报结果。
 */
export function applyHarnessReport(
  controller: ActiveWorkspaceController,
  payload: HarnessReportPayload,
  registry: () => WorkspaceRegistryView,
): HarnessReportOutcome {
  if (payload.path === null) return controller.reportFromHarness(null)
  if (payload.workspaceId !== undefined) {
    const entry = registry().entries.find((candidate) => candidate.id === payload.workspaceId)
    if (entry === undefined || workspaceIdentity(entry.path) !== workspaceIdentity(payload.path)) {
      return 'idMismatch'
    }
  }
  return controller.reportFromHarness(payload.path)
}
