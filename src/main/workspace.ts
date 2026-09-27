/**
 * 工作区（项目）管理：选目录、记设置、以及"待切换"标记的读写。
 *
 * "工作区"就是智能体读写文件的根目录。它在服务端启动时作为 `--workspace` 传入，
 * 而 Harness 侧的项目记录只在那次启动里登记，因此切换工作区意味着**重启应用**。
 * 重启的两半协议分别是：
 *   1. 切换时把目标写进 `<userData>/pending-workspace`（本模块的
 *      `markPendingWorkspace`）；
 *   2. 下次启动时把它读出来并消费掉（`takePendingWorkspace`）。
 * 两侧都在本模块，只有一套协议；编排在 `workspace-switch.ts`。
 *
 * 本模块只负责"选"与"记"，不负责重启，也不碰 Electron。
 */
import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

/** 最近打开列表的最大长度——够用即可，避免菜单过长。 */
const MAX_RECENT = 8

/** "待切换工作区"标记的文件名（位于应用数据目录）。 */
export const PENDING_WORKSPACE_FILENAME = 'pending-workspace'

/** "待移除工作区"标记的文件名（位于应用数据目录）。 */
export const PENDING_FORGET_FILENAME = 'pending-forget-workspaces.json'

/**
 * 本次启动的工作区是**怎么来的**。
 *
 * 这一层 provenance 是本轮修复的核心：`--workspace` 曾经只是一条路径，于是
 * "用户明确要求打开这个目录"与"上次 Desktop 记着这个目录"在服务端看起来一模一样，
 * server.mjs 便对两者都调用 `workspaceRegistry.create()`。结果用户在 Harness UI 里
 * 删掉的工作区，会在下一次 Desktop 启动时被**无声地重新创建**回来。
 *
 * 语义：
 *   * `pending`    「打开文件夹」/「最近打开」写下的切换意图 —— 明确的用户意图；
 *   * `argv`       命令行里显式给出的目录 —— 明确的用户意图；
 *   * `remembered` 只是 `<userData>/settings.json` 里上次记住的值 —— **不是**意图；
 *   * `fallback`   以上都没有可用值，落到主目录 —— **不是**意图。
 *
 * 只有前两种允许登记进 Harness 注册表（见 workspace-reconcile.ts）。
 */
export type WorkspaceSource = 'pending' | 'argv' | 'remembered' | 'fallback'

/** 一次工作区解析：路径 + 来源。 */
export interface WorkspaceResolution {
  path: string
  source: WorkspaceSource
}

/** 落盘的工作区相关设置。 */
export interface WorkspaceSettings {
  /** 当前工作区。 */
  workspace?: string
  /** 最近打开过的目录，最新的在前。 */
  recent?: string[]
}

/**
 * 记录一次工作区选择：更新当前值并把它提到最近列表首位。
 * @param settings - 现有设置。
 * @param dir - 选中的目录绝对路径。
 * @returns 更新后的设置（不落盘，交给调用方）。
 */
export function rememberWorkspace(settings: WorkspaceSettings, dir: string): WorkspaceSettings {
  const existing = (settings.recent ?? []).filter((item) => item !== dir)
  return { ...settings, workspace: dir, recent: [dir, ...existing].slice(0, MAX_RECENT) }
}

/**
 * 让"最近打开"里只保留仍然存在的目录。
 *
 * 目录被删或被改名是常态，菜单里留一堆打不开的条目只会让人误点。
 * @param recent - 原始列表。
 * @returns 过滤后的列表。
 */
export function pruneRecent(recent: readonly string[] | undefined): string[] {
  return (recent ?? []).filter((dir) => {
    try {
      return existsSync(dir) && statSync(dir).isDirectory()
    } catch {
      return false
    }
  })
}

/**
 * 判断一个路径是否是"真实目录"而非链接。
 *
 * 存在这个判断是因为 Windows 上 junction 与真实目录用 `statSync` 无法区分，
 * 而我们要避免把链接路径写进最近列表（链接目标被删除后会变成死条目）。
 * @param dir - 待检查的路径。
 * @returns 是否是可直接使用的工作区目录。
 */
export function isUsableWorkspace(dir: string): boolean {
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return false
    // readlinkSync 对普通目录抛错，对 junction/符号链接成功——用它区分两者。
    readlinkSync(dir)
    return true
  } catch {
    // 普通目录：readlink 失败，说明是真实目录。
    return true
  }
}

/**
 * 清理一个可能残留的加载页文件。
 *
 * 加载页是启动瞬态产物，退出后没有保留价值，也不该出现在数据目录里被误认为配置。
 * @param userDataDir - 应用数据目录。
 */
export function removeSplashFile(userDataDir: string): void {
  try {
    rmSync(join(userDataDir, 'splash.html'), { force: true })
  } catch {
    // 清理失败不影响任何功能。
  }
}

/**
 * 记下"下次启动请把这个目录当工作区"。
 *
 * 为什么需要这枚标记，而不是只写 settings.json：`app.relaunch()` 会**沿用原来的
 * 命令行**，于是重启后的 `process.argv` 里仍带着旧工作区，而 argv 的优先级高于
 * settings 里记住的选择——只写 settings 会被旧参数盖掉（表现为"重启了但还是老目录"，
 * 见 c968ab4a）。标记文件在启动时被读取并删除，只对紧接着的那一次生效。
 *
 * 用文件而不是环境变量：`app.relaunch()` 是否继承当前环境不由我们保证，文件一定跨得过
 * 重启。
 *
 * @param userDataDir - 应用数据目录。
 * @param dir - 目标工作区绝对路径。
 */
export function markPendingWorkspace(userDataDir: string, dir: string): void {
  try {
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(join(userDataDir, PENDING_WORKSPACE_FILENAME), `${dir}\n`)
  } catch (error) {
    // 写不进去只意味着"这次切换可能退回旧工作区"，不该让切换流程本身崩掉。
    console.warn(`[shell] 无法写入待切换工作区: ${String(error)}`)
  }
}

/**
 * 读取并**消费**"待切换工作区"标记。
 *
 * 读到即删：它只对紧接着的那一次启动有效，留着会影响后续每一次启动。
 * 文件坏掉或指向不存在的目录时返回 undefined（调用方回落到常规解析），但**仍然删掉**
 * 它——否则一个坏标记会每次启动都被读一遍。
 *
 * @param userDataDir - 应用数据目录。
 * @returns 规范化后的目标工作区，或 undefined（没有标记 / 标记不可用）。
 */
export function takePendingWorkspace(userDataDir: string): string | undefined {
  const pendingPath = join(userDataDir, PENDING_WORKSPACE_FILENAME)
  if (!existsSync(pendingPath)) return undefined
  try {
    const requested = readFileSync(pendingPath, 'utf8').trim()
    rmSync(pendingPath, { force: true })
    return requested === '' ? undefined : normalizeWorkspaceArgument(requested)
  } catch (error) {
    // 标记文件坏掉不该阻止启动——回落到常规解析。
    console.warn(`[shell] 无法读取待切换工作区: ${String(error)}`)
    return undefined
  }
}

/**
 * 判断两个路径是否指向同一个目录。
 *
 * 存在的理由：菜单里选中的路径来自原生目录选择器，而当前工作区可能来自
 * settings / argv / 标记文件，两者的写法不一定逐字相同（尾部分隔符、大小写、
 * 冗余的 `..`）。用它避免"选了同一个目录却重启一次"。
 *
 * Windows 的路径比较不区分大小写，macOS 默认也不区分，但只有前者是确定的，
 * 因此只在 win32 上折叠大小写——在区分大小写的平台上折叠会误判。
 *
 * @param left - 一个目录路径。
 * @param right - 另一个目录路径。
 * @returns 是否指向同一个目录。
 */
export function isSameWorkspace(left: string, right: string): boolean {
  return workspaceIdentity(left) === workspaceIdentity(right)
}

/**
 * 路径的**比较形态**（identity）——只用于判断"是不是同一个目录"。
 *
 * 与"显示形态"是两件事，必须分开：
 *   * **显示形态**就是用户看到 / 记住的那个写法（`settings.workspace`、项目信息面板、
 *     「复制工作区路径」用的都是它）。**不能**拿 realpath 去改写它，否则用户选的是
 *     链接目录，界面却显示成链接目标，看起来像"路径被偷偷换掉了"。
 *   * **比较形态**只求"同一个目录得到同一个字符串"：先尽量 realpath（链接、junction、
 *     8.3 短名、驱动器大小写都由它统一），失败（目录已不存在）再退回
 *     `resolve` + 去尾部分隔符 + Windows 折叠大小写。
 *
 * Harness 注册表里存的正是 realpath 之后的规范路径（见 dsh-workspace 的 `create`），
 * 因此把"用户写法"与"registry 里的路径"对比时，也必须走这一层。
 *
 * @param value - 任意目录路径写法。
 * @returns 用于比较的字符串。
 */
export function workspaceIdentity(value: string): string {
  let absolute = resolve(value)
  try {
    absolute = realpathSync.native(absolute)
  } catch {
    // 目录不存在（或没有权限）：退回纯词法规范化，仍然能挡住尾部分隔符与 `..`。
  }
  const trimmed = absolute.length > 1 && absolute.endsWith(sep) ? absolute.slice(0, -1) : absolute
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

/**
 * 记下"下次启动时把这些工作区从 Harness 注册表里移除"。
 *
 * 为什么也走"标记 + 重启"而不是就地删：注册表由服务端子进程里的
 * `ctx.workspaceRegistry` 独占（官方 API 是 `delete(id)`），而本进程只是外壳。
 * 让删除跟着**同一条启动路径**走，就不存在"外壳以为删了、服务端还留着"的中间态，
 * 也不需要为一次删除维护第二套控制通道。
 *
 * 与 settings 的 `recent` **无关**：从注册表移除不等于从「最近打开」移除，更不等于
 * 删除磁盘目录（见 workspace-actions.ts 的三段语义）。
 *
 * @param userDataDir - 应用数据目录。
 * @param dir - 要移除的工作区路径（用户写法）。
 */
export function markPendingForget(userDataDir: string, dir: string): void {
  // 用**不消费**的读：写入不能先删后写（进程在这两步之间退出就会丢掉整个意图）。
  const existing = readPendingForgets(userDataDir)
  if (existing.some((entry) => isSameWorkspace(entry, dir))) return
  const next = [...existing, dir]
  try {
    mkdirSync(userDataDir, { recursive: true })
    // 原子替换：先写同目录的临时文件再改名，读到的永远是完整 JSON。
    const target = join(userDataDir, PENDING_FORGET_FILENAME)
    const temporary = `${target}.tmp`
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`)
    renameSync(temporary, target)
  } catch (error) {
    console.warn(`[shell] 无法写入待移除工作区: ${String(error)}`)
  }
}

/**
 * 读取"待移除工作区"标记（**不**消费）。
 *
 * @param userDataDir - 应用数据目录。
 * @returns 要移除的路径数组；文件缺失或损坏时为空数组。
 */
export function readPendingForgets(userDataDir: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(userDataDir, PENDING_FORGET_FILENAME), 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
  } catch {
    return []
  }
}

/**
 * 读取并**消费**"待移除工作区"标记。
 *
 * 读到即删：这些路径只对紧接着的那一次启动有效。坏文件返回空数组并顺手删掉，
 * 否则一个坏标记会每次启动都被读一遍。
 *
 * @param userDataDir - 应用数据目录。
 * @returns 要移除的路径数组（可能为空）。
 */
export function takePendingForgets(userDataDir: string): string[] {
  const path = join(userDataDir, PENDING_FORGET_FILENAME)
  if (!existsSync(path)) return []
  const entries = readPendingForgets(userDataDir)
  try {
    rmSync(path, { force: true })
  } catch {
    // 删不掉也无妨：下次启动会再移除一遍（`delete` 对未知 id 是幂等的）。
  }
  return entries
}

/**
 * 把命令行传入的路径规范成工作区。
 *
 * 传文件时取其所在目录——用户从"用…打开"里选中一个文件是常见操作，
 * 此时把文件所在目录当工作区比拒绝更符合预期。
 * @param candidate - 命令行传入的路径。
 * @returns 规范化后的绝对路径，或 undefined（路径无效）。
 */
export function normalizeWorkspaceArgument(candidate: string): string | undefined {
  const absolute = isAbsolute(candidate) ? candidate : resolve(candidate)
  if (!existsSync(absolute)) return undefined
  try {
    return statSync(absolute).isDirectory() ? absolute : resolve(absolute, '..')
  } catch {
    return undefined
  }
}

/**
 * 兜底工作区：用户主目录。
 *
 * 主目录一定存在，且是用户最可能想操作的范围；比硬编码 `C:\` 或当前目录更合理
 * （后者在安装后可能是系统目录）。
 * @returns 主目录绝对路径。
 */
export function fallbackWorkspace(): string {
  return homedir()
}

/**
 * 为菜单生成"最近打开"的显示文案。
 *
 * 只显示目录名，重名时补上父目录名，避免菜单里出现两个一模一样的条目
 * 而用户无从分辨。
 * @param dirs - 最近目录列表。
 * @returns 显示文案，与入参一一对应。
 */
export function recentLabels(dirs: readonly string[]): string[] {
  const names = dirs.map((dir) => resolve(dir).split(/[\\/]/u).filter(Boolean).pop() ?? dir)
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)

  return dirs.map((dir, index) => {
    const name = names[index] ?? dir
    if ((counts.get(name) ?? 0) <= 1) return name
    // 重名时用父目录 + 目录名消歧。
    const parts = resolve(dir).split(/[\\/]/u).filter(Boolean)
    const parent = parts[parts.length - 2] ?? ''
    return parent === '' ? dir : `${parent}/${name}`
  })
}
