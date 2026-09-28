/**
 * 模块回退链接的自愈。
 *
 * 背景：dsh 在 `$DSH_HOME/profiles/node_modules` 下建立一批目录链接（Windows 上是
 * junction），指向其安装目录里的各个包。启动插件树时，Node 从 profile 目录向上
 * 查找，正是靠这批链接才能解析 `@deepseek-ai/*`。
 *
 * 问题：dsh 判断"链接是否已是最新"靠比较**链接目标字符串**
 * （`readlinkSync(link) === entry.packageDir`）。当安装目录整体移动后——例如本应用
 * 从 `D:\Program Files\…` 换到 `%LOCALAPPDATA%\Programs\…`，或用户换了安装位置——
 * 旧链接指向的路径已不存在，但字符串仍与新安装的期望目标**逐字相等**时会被判定为
 * "最新"，于是重建被跳过，结果是每个 `@deepseek-ai/*` 都解析失败：
 *
 *   Error: Cannot find package '@deepseek-ai/dsh-client-ui-plan'
 *   imported from …\profiles\desktop\
 *
 * 这里在启动服务端之前主动检查一遍：只要发现失效链接，就删掉整个
 * `$DSH_HOME/profiles/node_modules`，让 dsh 在本次启动时重建。删除是安全的——
 * 该目录完全是 dsh 自己管理的派生数据，没有任何用户内容。
 *
 * 注意适用版本：这条路径只对 **0.1.5 及更早** 的运行时有效。0.1.7 起
 * `healProfilesModuleFallback` 被 `createRuntimeResolution` + `PluginPackages`
 * 取代，安装闭包改由进程内的解析拦截提供，这个目录里剩下的链接已经**不参与**
 * 启动解析（服务端那边的分支见 `src/server/server.mjs` 的 `prepareModuleResolution`）。
 * 所以保留这里的清理不会帮到 0.1.7，也不会伤到它——中性与无害，但不要误以为它是
 * 新版运行时的模块解析修复手段。
 */
import { existsSync, lstatSync, readdirSync, readlinkSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 自愈结果，用于日志与诊断。 */
export interface FallbackHealResult {
  /** 是否执行了清理。 */
  cleaned: boolean
  /** 被判定为失效的链接数。 */
  brokenLinks: number
  /** 检查过的链接总数。 */
  checkedLinks: number
  /** 清理的目录（执行时才有）。 */
  cleanedPath?: string
}

/**
 * 判断一个链接的目标（绝对化后）是否存在。
 *
 * 相对链接按链接自身所在目录解析——Windows 的 junction 存的是绝对路径，
 * 但其它平台的符号链接可能是相对的。
 * @param linkPath - 链接自身的路径。
 * @param target - `readlink` 返回的原始目标。
 * @returns 目标是否存在。
 */
function targetExists(linkPath: string, target: string): boolean {
  const isAbsolute = target.startsWith('\\\\') || /^[A-Za-z]:[\\/]/u.test(target) || target.startsWith('/')
  const absolute = isAbsolute ? target : resolve(join(linkPath, '..'), target)
  return existsSync(absolute)
}

/**
 * 扫描一个目录，统计其中的链接是否有效。
 * @param dir - 要扫描的目录。
 * @returns 检查数与失效数。
 */
function scanLinks(dir: string): { checked: number; broken: number } {
  let checked = 0
  let broken = 0

  const walk = (current: string, depth: number): void => {
    // 只深入到 scope 层（@scope/name），再深就不是包链接了。
    if (depth > 2) return
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      let stat
      try {
        stat = lstatSync(path)
      } catch {
        continue
      }
      if (stat.isSymbolicLink()) {
        checked += 1
        let target: string
        try {
          target = readlinkSync(path)
        } catch {
          broken += 1
          continue
        }
        if (!targetExists(path, target)) broken += 1
        continue
      }
      if (stat.isDirectory()) walk(path, depth + 1)
    }
  }

  walk(dir, 0)
  return { checked, broken }
}

/**
 * 在启动 dsh 之前检查并修复模块回退链接。
 *
 * 只在确实发现失效链接时才动文件系统：正常情况下这是一个只读扫描，代价可忽略。
 * @param dshHome - Harness 主目录。
 * @returns 自愈结果。
 */
export function healModuleFallback(dshHome: string): FallbackHealResult {
  const modulesDir = join(dshHome, 'profiles', 'node_modules')
  if (!existsSync(modulesDir)) return { cleaned: false, brokenLinks: 0, checkedLinks: 0 }

  const { checked, broken } = scanLinks(modulesDir)
  if (broken === 0) return { cleaned: false, brokenLinks: 0, checkedLinks: checked }

  // 整个删掉而不是逐个删：这个目录是 dsh 的派生缓存，整体重建比局部修补更可靠，
  // 也避免了"删了一半、剩下的一半仍被判为最新"的中间态。
  try {
    rmSync(modulesDir, { recursive: true, force: true })
    return { cleaned: true, brokenLinks: broken, checkedLinks: checked, cleanedPath: modulesDir }
  } catch (error) {
    // 删不掉就交给 dsh 自己处理：它会报出原始错误，比吞掉更有用。
    return {
      cleaned: false,
      brokenLinks: broken,
      checkedLinks: checked,
      cleanedPath: `清理失败: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
