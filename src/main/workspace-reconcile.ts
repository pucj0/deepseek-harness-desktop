/**
 * 启动期的工作区对账（reconciliation）。
 *
 * ## 它解决的三个真实缺陷
 *
 * **BUG A — 磁盘上删掉的工作区仍然"有效"。**
 * `readSettings()` 只在**返回值**里过滤掉不存在的最近目录，磁盘上的 `settings.json`
 * 一直留着旧路径；`workspace` 也没有做存在性对账。于是删掉目录、重启之后，Desktop
 * 仍然把它当成当前工作区。
 *
 * **BUG C — Harness 里删掉的工作区会在下次启动时被复活。**
 * 旧启动链是「`--workspace A` ⇒ server.mjs 无条件 `workspaceRegistry.create(A)`」。
 * 用户在 Harness UI 里删掉 A 之后，Desktop 的 `settings.workspace` 仍是 A，于是下次启动
 * 又把它 create 回去。**记住 ≠ 意图**，这是本轮修复的核心。
 *
 * **注册表里的僵尸记录。**
 * 目录被删掉后，Harness 注册表里的记录仍然在（官方 UI 的项目列表就是它的投影），
 * 于是不存在的工作区会一直在界面上出现。清理走官方 API，在服务端进程里做
 * （见 `src/server/server.mjs` 的 `reconcileWorkspaceRegistry`）。
 *
 * ## 冲突时谁说了算
 *
 *     Harness workspaceRegistry = 用户当前认可的"已注册工作区集合"
 *     Desktop settings.workspace = 上次 Desktop 用过的目录
 *
 * 两者冲突（Desktop 记着 A、注册表里没有 A）且这**不是**一次新的显式打开时：
 * **Harness 胜出**。Desktop 不能把 A 自动复活——那是用户在 Harness 里做出的决定。
 * 用户以后仍可以在「文件 → 打开文件夹 / 最近打开」里主动重新打开 A，那是一次新的
 * 显式意图（`source = 'pending'`），那时允许重新登记。
 *
 * ## 允许登记注册表的唯一条件
 *
 * 只有 {@link WorkspaceResolution.source} 为 `pending` / `argv`（用户明确要求打开这个
 * 目录）时才允许 `registry.create()`；外加一个引导例外：注册表里**一个可用的文件系统
 * 工作区都没有**时，用主目录把它引导起来（否则界面里一个项目都没有，应用不可用）。
 * 这条例外永远不会复活用户删掉的目录——它用的是主目录，不是被删的那个路径。
 */
import { existsSync, statSync } from 'node:fs'
import type { DesktopSettings } from './settings'
import { readSettings, readSettingsRaw, switchWorkspace, writeSettings } from './settings'
import type { WorkspaceResolution, WorkspaceSource } from './workspace'
import { workspaceIdentity } from './workspace'
import type { WorkspaceRegistryView } from './workspace-registry'
import { findRegistered, readWorkspaceRegistry } from './workspace-registry'

/** 对账结果：本次启动**真正**使用的工作区，以及是否允许登记它。 */
export interface WorkspaceReconciliation {
  /** 本次启动使用的工作区（Desktop active workspace 的初值）。 */
  active: string
  /** 是否允许把这个工作区 `registry.create()` 进 Harness。 */
  register: boolean
  /** `active` 的来源：显式意图原样保留，否则是回退的结果。 */
  source: WorkspaceSource
  /**
   * 决定的依据（诊断与测试断言用）：
   *   `explicit`            用户明确要求打开，允许登记；
   *   `registered`          记住的那个目录已经在注册表里，正常使用；
   *   `harness-registry`    Desktop 记的和注册表不一致 → 采用注册表里最近的有效工作区；
   *   `bootstrap`           注册表里没有可用的文件系统工作区 → 用主目录引导；
   *   `registry-unreadable` 读不到注册表（首次 / 损坏）→ 按引导处理。
   */
  reason:
    | 'explicit'
    | 'registered'
    | 'harness-registry'
    | 'bootstrap'
    | 'registry-unreadable'
  /** 参数里那个被放弃的工作区（诊断用）。 */
  abandoned?: string
  /** `settings.workspace` 是否被这次对账改写。 */
  workspaceChanged: boolean
  /** 从「最近打开」里真正清掉的路径（已落盘）。 */
  recentRemoved: string[]
}

/** 默认的"这是一个可用目录吗"判断。 */
function defaultIsDirectory(dir: string): boolean {
  try {
    return existsSync(dir) && statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/**
 * 从注册表里挑一个仍然存在的文件系统工作区。
 *
 * 用注册表**自己的顺序**（`create()` 会把新记录前置，因此顺序就是"最近的在前"），
 * 而不是自己按字母序或时间戳再排一遍：这个顺序正是官方 UI 自己的取用顺序，跟着它
 * 才能让"Desktop active"与"Harness active"落在同一个项目上。
 *
 * @param registry - 注册表视图。
 * @param isDirectory - 目录存在性判断。
 * @returns 命中的路径，或 undefined（没有任何可用的已注册工作区）。
 */
export function pickRegisteredFallback(
  registry: WorkspaceRegistryView,
  isDirectory: (dir: string) => boolean = defaultIsDirectory,
): string | undefined {
  return registry.entries.find((entry) => isDirectory(entry.path))?.path
}

/** {@link reconcileWorkspaceState} 的输入。 */
export interface ReconcileOptions {
  /** 应用数据目录。 */
  userDataDir: string
  /** Harness 主目录（注册表所在处）。 */
  dshHome: string
  /** `resolveWorkspaceIntent()` 给出的解析结果。 */
  resolution: WorkspaceResolution
  /** 引导用的兜底工作区（用户主目录）。 */
  home: string
  /** 目录存在性判断（测试注入用）。 */
  isDirectory?: (dir: string) => boolean
  /** 已经读好的注册表视图（省略时按 dshHome 现读）。 */
  registry?: WorkspaceRegistryView
}

/**
 * 执行一次启动期对账，并把结果**落盘**。
 *
 * 副作用只有两个，都在 `<userData>/settings.json` 上：
 *   * `recent` 里不存在的目录被真正删掉（prune + persist，BUG A）；
 *   * `workspace` 指向一个被放弃的目录时改写成实际使用的那个（BUG C 的一半）。
 *
 * 它**不**写 Harness 注册表。注册表只由服务端进程按官方 API 改（`register` 字段就是
 * 给那边的指令）。
 *
 * @param options - 见 {@link ReconcileOptions}。
 * @returns 本次启动的工作区决定。
 */
export function reconcileWorkspaceState(options: ReconcileOptions): WorkspaceReconciliation {
  const { userDataDir, dshHome, resolution, home } = options
  const isDirectory = options.isDirectory ?? defaultIsDirectory
  const registry = options.registry ?? readWorkspaceRegistry(dshHome)

  // 第 0 步：prune + persist。即使下面什么都不改，「最近打开」也要先真的干净下来。
  //
  // **必须**用 `readSettingsRaw()`：`readSettings()` 的返回值已经在内存里过滤过一遍，
  // 拿它来算"哪些该删"永远得到空集——那正是 BUG A（只在内存里 prune、磁盘上留着旧路径）。
  const settings: DesktopSettings = readSettings(userDataDir)
  const prunedRecent = reconcileRecent(userDataDir, readSettingsRaw(userDataDir), isDirectory)

  const remembered = typeof settings.workspace === 'string' && settings.workspace !== '' ? settings.workspace : undefined

  /**
   * 收尾：把 `settings.workspace` 对齐到实际使用的值，并在需要时把它提到「最近打开」首位。
   *
   * @param result - 决定（`register` / `source` / `reason` 都已定好）。
   * @param promote - 是否**无条件**记一次选择（显式意图用：用户刚打开的目录必须进
   *   「最近打开」，即使它本来就是当前工作区）。
   */
  const settle = (
    result: Omit<WorkspaceReconciliation, 'workspaceChanged' | 'recentRemoved'>,
    promote = false,
  ): WorkspaceReconciliation => {
    const changed = promote || remembered === undefined || !samePath(remembered, result.active)
    if (changed) switchWorkspace(userDataDir, result.active)
    return { ...result, workspaceChanged: changed, recentRemoved: prunedRecent }
  }

  // ---- 1) 显式意图：可以登记 ------------------------------------------------
  if (resolution.source === 'pending' || resolution.source === 'argv') {
    return settle(
      {
        active: resolution.path,
        register: true,
        source: resolution.source,
        reason: 'explicit',
      },
      // 「打开文件夹 / 最近打开 / 命令行参数」都是用户刚做过的一次选择：进「最近打开」。
      true,
    )
  }

  // ---- 2) 读不到注册表：当作引导 -------------------------------------------
  //
  // 只有 `readable === false` 才走这里。**不能**把它与"注册表里没有这条记录"混为一谈：
  // 前者是"不知道"，后者是"用户删掉了它"。注册表缺失（例如 <userData>/home 被删）
  // 时必须允许 create，否则全新安装会一个项目都没有。
  if (!registry.readable) {
    const active = isDirectory(resolution.path) ? resolution.path : home
    return settle({ active, register: true, source: resolution.source, reason: 'registry-unreadable' })
  }

  // ---- 3) 记住的那个目录已在注册表里：正常使用（不重复登记）------------------
  if (isDirectory(resolution.path) && findRegistered(registry, resolution.path) !== undefined) {
    return settle({
      active: resolution.path,
      register: false,
      source: resolution.source,
      reason: 'registered',
    })
  }

  // ---- 4) 冲突：Harness 胜出 -----------------------------------------------
  const fallback = pickRegisteredFallback(registry, isDirectory)
  if (fallback !== undefined) {
    return settle({
      active: fallback,
      register: false,
      source: 'fallback',
      reason: 'harness-registry',
      ...(resolution.path === fallback ? {} : { abandoned: resolution.path }),
    })
  }

  // ---- 5) 注册表里一个可用的文件系统工作区都没有：用主目录引导 ---------------
  //
  // 这里是"用户把工作区全删了"的情形。用**主目录**引导，而不是把被删的那个路径写回来，
  // 因此不会复活任何用户主动移除的工作区；用户随时可以再把它移掉。
  return settle({
    active: home,
    register: true,
    source: 'fallback',
    reason: 'bootstrap',
    ...(resolution.path === home ? {} : { abandoned: resolution.path }),
  })
}

/** 两个路径是否指向同一个目录（`workspaceIdentity` 的比较形态）。 */
const samePath = (left: string, right: string): boolean => workspaceIdentity(left) === workspaceIdentity(right)

/**
 * 把「最近打开」里已不存在的目录清掉并落盘。
 *
 * 入参必须是**未经过滤**的 settings（`readSettingsRaw`）：`readSettings()` 已经过滤过，
 * 用它算出来的"该删哪些"永远是空集。
 *
 * @param userDataDir - 应用数据目录。
 * @param settings - 磁盘上的原始设置。
 * @param isDirectory - 目录存在性判断。
 * @returns 被清掉的路径。
 */
function reconcileRecent(
  userDataDir: string,
  settings: DesktopSettings,
  isDirectory: (dir: string) => boolean,
): string[] {
  const raw = Array.isArray(settings.recent) ? settings.recent : []
  const keep = raw.filter((dir) => typeof dir === 'string' && dir !== '' && isDirectory(dir))
  const removed = raw.filter((dir) => typeof dir === 'string' && !isDirectory(dir))
  if (removed.length === 0) return []
  writeSettings(userDataDir, { recent: keep })
  return removed
}
