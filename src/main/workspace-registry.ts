/**
 * Harness 工作区注册表的**只读**投影。
 *
 * ## 为什么要读它，而不是问服务端
 *
 * 注册表（`<dshHome>/storages/workspace.json`）是 `ctx.workspaceRegistry` 的落盘形态，
 * 它由**服务端子进程**独占写入（唯一的公开写入口是 `create()` / `delete()` 等官方 API）。
 * 外壳在启动早期需要回答两个问题，而那时服务端还没起来：
 *
 *   1. "上次记住的那个工作区，用户是不是已经在 Harness 里删掉了？"
 *      —— 是的话就**不能**再 `registry.create()`（那正是把 A 复活的 bug）；
 *   2. "界面刚刚上报的 active workspace，是不是一个真正登记过的工作区？"
 *      —— 渲染进程送来的路径必须过这道校验（安全边界，见 window.ts）。
 *
 * 两处都只**读**。任何写入都留在服务端进程里、走官方 API——外壳绝不直接改这个文件。
 *
 * ## 只清理"确实是文件系统工作区"的记录
 *
 * 记录里表达"这是一个本地目录"的字段就是 `path`。没有可用 `path` 的记录（将来的远端 /
 * 虚拟工作区，或结构变化后的新形态）一律归入 {@link WorkspaceRegistryView.foreign}，
 * **绝不**自动清理、也**绝不**自动移除——"字段不像本地目录就删掉"是最危险的猜法。
 */
import { isAbsolute } from 'node:path'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { workspaceIdentity } from './workspace'

/** 一条文件系统工作区记录。 */
export interface RegisteredWorkspace {
  /** 注册表里的稳定 id（uuid）。 */
  id: string
  /** 规范化（realpath）之后的目录路径——注册表存的就是这个形态。 */
  path: string
  /** 显示标题。 */
  title: string
  /** 创建时刻（ISO-8601）。 */
  createdAt: string
}

/** 读到的注册表视图。 */
export interface WorkspaceRegistryView {
  /** 只含**文件系统**工作区，顺序 = 注册表自己的顺序（新的在前）。 */
  entries: RegisteredWorkspace[]
  /** 记录存在但没有可用 `path` 的条目：不参与任何自动清理。 */
  foreign: string[]
  /** 注册表是否已经完成过一次引导（`global.initialized`）。 */
  initialized: boolean
  /** 文件是否存在且能解析出结构。 */
  readable: boolean
}

/** 注册表文件路径。 */
export const workspaceRegistryPath = (dshHome: string): string =>
  join(dshHome, 'storages', 'workspace.json')

/** `record.path` 是不是一个能让 shell 当作工作区用的绝对路径。 */
function asFilesystemPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || !isAbsolute(trimmed)) return undefined
  return trimmed
}

/**
 * 读取 Harness 工作区注册表。
 *
 * 文件缺失、损坏、结构变化都只是"读不到"，返回一个空视图而不是抛错：注册表是增强信息，
 * 不该因为它让应用起不来。调用方据此把"读不到"与"里面没有这条记录"区分开
 * （`readable`），因为只有后者才意味着"用户删掉了它"。
 *
 * @param dshHome - Harness 主目录。
 * @returns 注册表视图。
 */
export function readWorkspaceRegistry(dshHome: string): WorkspaceRegistryView {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(workspaceRegistryPath(dshHome), 'utf8'))
  } catch {
    return { entries: [], foreign: [], initialized: false, readable: false }
  }
  const document = parsed as { tables?: { workspaces?: unknown }; global?: { workspaceIds?: unknown; initialized?: unknown } }
  const table = document?.tables?.workspaces
  if (table === null || typeof table !== 'object') {
    return { entries: [], foreign: [], initialized: false, readable: false }
  }
  const records = table as Record<string, unknown>
  const order = Array.isArray(document?.global?.workspaceIds)
    ? document.global.workspaceIds.filter((id): id is string => typeof id === 'string')
    : []
  // 注册表自己的顺序是权威的；表里多出来的 id（结构变化）追加在后面而不是丢掉。
  const ids = [...order, ...Object.keys(records).filter((id) => !order.includes(id))]

  const entries: RegisteredWorkspace[] = []
  const foreign: string[] = []
  for (const id of ids) {
    const raw = records[id]
    if (raw === null || typeof raw !== 'object') {
      foreign.push(id)
      continue
    }
    const record = raw as { path?: unknown; title?: unknown; createdAt?: unknown }
    const path = asFilesystemPath(record.path)
    if (path === undefined) {
      foreign.push(id)
      continue
    }
    entries.push({
      id,
      path,
      title: typeof record.title === 'string' ? record.title : '',
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    })
  }
  return { entries, foreign, initialized: document?.global?.initialized === true, readable: true }
}

/**
 * 在注册表里按目录路径找一条记录（比较用 {@link workspaceIdentity}，不比较字面量）。
 * @param view - 注册表视图。
 * @param path - 任意写法的目录路径。
 * @returns 命中的记录，或 undefined。
 */
export function findRegistered(
  view: WorkspaceRegistryView,
  path: string,
): RegisteredWorkspace | undefined {
  const wanted = workspaceIdentity(path)
  return view.entries.find((entry) => workspaceIdentity(entry.path) === wanted)
}

/**
 * 注册表里是否登记过这个目录。
 * @param view - 注册表视图。
 * @param path - 任意写法的目录路径。
 * @returns 登记过则 true。
 */
export const isRegisteredWorkspace = (view: WorkspaceRegistryView, path: string): boolean =>
  findRegistered(view, path) !== undefined
