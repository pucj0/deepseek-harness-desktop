/**
 * 应用自身的设置文件（`<userData>/settings.json`）。
 *
 * 与 Harness 自己的配置分开：这里是**外壳**的偏好（当前工作区、最近打开列表、
 * 更新通道）。Harness 的设置由 dsh 自己管理，两者互不干涉。
 *
 * ## `workspace` 与 `recent` 是两个不同的语义
 *
 *   * `workspace`（**记住的当前工作区**）是"上次 Desktop 用的是哪个目录"。它是**记忆**，
 *     不是意图：如果 Harness 注册表里已经没有它，说明用户主动移除过，Desktop 必须让位
 *     （见 workspace-reconcile.ts）。
 *   * `recent` 是「最近打开」菜单的数据源，纯粹是给用户重新选择的入口。目录被删掉时它
 *     必须被真正清掉（见 {@link reconcileSettings}），但从 Harness 注册表移除一个工作区
 *     并**不**要求把它从 recent 里删掉——用户应当还能在「最近打开」里主动再打开它。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isSameWorkspace, pruneRecent, rememberWorkspace } from './workspace'

/** 落盘的外壳设置。 */
export interface DesktopSettings {
  /** 上次 Desktop 使用的工作区（**记忆**，不是"用户要求打开"的意图）。 */
  workspace?: string
  /** 最近打开过的项目目录，最新的在前。 */
  recent?: string[]
  /** 运行时更新跟随的 dist-tag：latest | next | alpha。 */
  channel?: string
}

const FILENAME = 'settings.json'

/** 设置文件的绝对路径。 */
export const settingsPath = (userDataDir: string): string => join(userDataDir, FILENAME)

/**
 * 读取设置。
 *
 * 读取时顺手过滤掉已不存在的最近目录：目录被删或被改名是常态，菜单里留着打不开的
 * 条目只会让人误点。**注意**：这里只过滤返回值。要让磁盘上的文件也干净，必须走
 * {@link reconcileSettings}（"prune + persist"是两件事，只做前一半正是 BUG A）。
 *
 * @param userDataDir - 应用数据目录。
 * @returns 设置；文件缺失或损坏时返回空对象而不是抛错。
 */
export function readSettings(userDataDir: string): DesktopSettings {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(userDataDir), 'utf8')) as DesktopSettings
    return { ...parsed, recent: pruneRecent(parsed.recent) }
  } catch {
    return {}
  }
}

/**
 * 读取设置：**不做**任何过滤。
 *
 * 给"落盘内容与期望内容是否一致"这类判断用——{@link readSettings} 会把不存在的最近目录
 * 过滤掉，于是"磁盘里还有旧路径"这件事在它的返回值里看不出来。
 *
 * @param userDataDir - 应用数据目录。
 * @returns 原样的设置对象。
 */
export function readSettingsRaw(userDataDir: string): DesktopSettings {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(userDataDir), 'utf8')) as DesktopSettings
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 合并写入设置。
 * @param userDataDir - 应用数据目录。
 * @param patch - 要合并进去的字段。
 * @returns 写入后的设置。
 */
export function writeSettings(userDataDir: string, patch: DesktopSettings): DesktopSettings {
  const next = { ...readSettings(userDataDir), ...patch }
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(settingsPath(userDataDir), JSON.stringify(next, null, 2) + '\n')
  return next
}

/**
 * prune + persist：把"最近打开"里已不存在的目录**真正从磁盘上删掉**。
 *
 * 这是对 BUG A 的直接修复。此前只有 `readSettings()` 在返回值里过滤，磁盘上的
 * `settings.json` 永远留着旧路径；于是：
 *   * 「最近打开」每次都要重新过滤一遍（只是内存里的假象）；
 *   * `settings.workspace` 仍指向已删除的目录，下一次启动又要重新判一次；
 *   * 外部工具（或用户自己）看这个文件时，看到的是一个已经不存在的"当前工作区"。
 *
 * 只在**内容真的变了**时写盘：这个文件被 Harness 的设置监听与几个测试盯着，无谓的写入
 * 会制造"状态变了"的假信号。
 *
 * @param userDataDir - 应用数据目录。
 * @param options - 可注入的目录存在性判断（测试用）。
 * @returns `{ settings, changed, removed }`——`changed` 表示这次确实落盘了。
 */
export function reconcileSettings(
  userDataDir: string,
  options: { isDirectory?: (dir: string) => boolean } = {},
): { settings: DesktopSettings; changed: boolean; removed: string[] } {
  const raw = readSettingsRaw(userDataDir)
  const keep = (dir: string): boolean =>
    options.isDirectory === undefined
      ? pruneRecent([dir]).length === 1
      : options.isDirectory(dir)
  const recent = (Array.isArray(raw.recent) ? raw.recent : []).filter(
    (dir): dir is string => typeof dir === 'string' && dir !== '' && keep(dir),
  )
  const removed = (Array.isArray(raw.recent) ? raw.recent : []).filter(
    (dir): dir is string => typeof dir === 'string' && !keep(dir),
  )
  const before = JSON.stringify({ ...raw, recent: Array.isArray(raw.recent) ? raw.recent : [] })
  const after = JSON.stringify({ ...raw, recent })
  if (before === after) return { settings: { ...raw, recent }, changed: false, removed }
  const written = writeSettings(userDataDir, { recent })
  return { settings: written, changed: true, removed }
}

/**
 * 记录一次工作区切换：设为当前并提到最近列表首位。
 * @param userDataDir - 应用数据目录。
 * @param dir - 选中的目录绝对路径。
 * @returns 写入后的设置。
 */
export function switchWorkspace(userDataDir: string, dir: string): DesktopSettings {
  return writeSettings(userDataDir, rememberWorkspace(readSettings(userDataDir), dir))
}

/**
 * 只从「最近打开」里移除一个目录（**不**碰当前工作区，也**不**碰 Harness 注册表）。
 *
 * 这就是菜单里的「从最近项目中移除」。它与"移除工作区"（Harness registry）和
 * "删除目录"是三件完全不同的事，因此这里只动 `recent` 一个字段。
 *
 * @param userDataDir - 应用数据目录。
 * @param dir - 要移除的目录。
 * @returns 写入后的设置。
 */
export function removeFromRecent(userDataDir: string, dir: string): DesktopSettings {
  const current = readSettings(userDataDir)
  const recent = (current.recent ?? []).filter((entry) => !isSameWorkspace(entry, dir))
  return writeSettings(userDataDir, { recent })
}
