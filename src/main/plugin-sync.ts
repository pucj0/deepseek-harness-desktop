/**
 * 随本应用发布的客户端插件的就位与自愈（外壳侧）。
 *
 * 背景（这是本模块存在的唯一理由）：应用可以**整体替换运行时**——`RuntimeUpdater`
 * 把新版 `@deepseek-ai/dsh` 装进 `<userData>/runtime/<版本>`，再用 `current` 联接把它
 * 激活。而契约里说的"内置插件"是随本应用发布的三个包（gitbar / review / typography），
 * 它们**不在 dsh 的依赖闭包里**，只存在于被打包进安装包的那份运行时里。
 *
 * 于是运行时一被换掉，新 runtime 的 `node_modules` 里就没有它们，而 `server.mjs` 的
 * 处理是"没有就跳过"：
 *   * `linkBundledPlugins` 找不到包 → 静默 continue，不报错；
 *   * `reconcileBundles` 随即把它们从 profile 的 bundle 列表里摘掉。
 * 结果不是崩溃，而是**三个插件一起从界面上消失**（实测：运行时更新到 0.1.5-rc.2 后
 * 分支徽章、本轮修改、审查面板全部不见，控制台一句警告都没有，因此很难判断是"插件
 * 没加载"还是"界面坏了"）。
 *
 * 所以插件不能只"随运行时携带"，必须由外壳在**每次启动时**从自己携带的那份
 * （打包后是 `<resources>/plugins`，开发期是仓库的 `plugins/`）同步进**当前实际使用**
 * 的那个运行时的 `node_modules`。这样一次处理三件事：
 *   * 运行时更新后自动补齐（不必在更新器里再维护一份同样逻辑）；
 *   * 已经被换到"插件缺失"的运行时也能就地修好（用户无需回滚或重装）；
 *   * 外壳升级带来新插件或新版本时，旧 runtime 目录里的旧副本会被刷新。
 *
 * 时机很关键：必须在服务端进程启动**之前**完成，因为 `server.mjs` 只在启动时把
 * 已存在的插件链进 profile。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { UNPACKED_DIRNAME } from './runtime-unpack'

/** 一次同步的结果。 */
export interface PluginSyncOutcome {
  /** 实际使用的来源目录；没找到任何可用来源时为 undefined。 */
  source?: string
  /** 来源里可用的插件名。 */
  available: string[]
  /** 本次真正写入（首次就位或内容有变）的插件名。 */
  written: string[]
  /** 目标里已有且内容一致、无需改动的插件名。 */
  kept: string[]
  /** 写入失败的插件与原因；不阻断启动，但调用方应当把它打出来。 */
  failures: Array<{ name: string; reason: string }>
}

/** 一个候选来源解析后的样子：插件包所在的父目录 + 该来源里可用的插件名。 */
export interface PluginSource {
  /** 插件包所在的父目录（插件目录本身，或运行时的 `node_modules`）。 */
  dir: string
  /** 该来源里可用的插件名，已按字典序排序。 */
  names: string[]
}

/** 读目录项，读不到就当作空目录（缺目录不在这里报错）。 */
function readEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * 文件清单指纹：`相对路径:字节数`（排序后拼接）。
 *
 * 为什么不用时间戳：拷贝与 git 检出都会无谓地刷新时间戳，用它判断会变成"每次启动
 * 都重写一遍"。为什么不用内容哈希：那要读全部内容，而这里每次启动都要比一次——插件
 * 虽小，也没有必要。**大小一旦不同就一定不同**，而本项目的插件是打包产物，改一处
 * 必然改变长度；代价是"同长度的改动"不会被发现，这在实践中不会发生。
 * @param dir - 待取指纹的目录。
 * @returns 指纹字符串；目录不存在时为空串。
 */
export function fingerprint(dir: string): string {
  const parts: string[] = []
  const walk = (current: string, prefix: string): void => {
    for (const entry of readEntries(current)) {
      const path = join(current, entry.name)
      const key = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        walk(path, key)
        continue
      }
      if (!entry.isFile()) continue
      try {
        parts.push(`${key}:${statSync(path).size}`)
      } catch {
        // 读不到大小：当作"与任何目标都不同"，宁可多拷一次。
        parts.push(`${key}:?`)
      }
    }
  }
  walk(dir, '')
  return parts.sort().join('|')
}

/**
 * 列出目录里可作为插件发布的包：带 `package.json` 的直接子目录。
 *
 * 刻意**不硬编码插件名**：插件随外壳版本增删，名单只应有一处（`plugins/` 目录本身），
 * 写死在代码里就又会多出一份需要对账的清单。
 * @param dir - 插件包所在目录。
 * @returns 插件名，按字典序排序。
 */
export function listPluginPackages(dir: string): string[] {
  return readEntries(dir)
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(dir, name, 'package.json')))
    .sort()
}

/**
 * 读取运行时元数据里登记的插件名（由 `scripts/stage-runtime.mjs` 写入）。
 * @param runtimeDir - 运行时目录。
 * @returns 登记过的插件名；没有或读不到时为空数组。
 */
export function declaredPlugins(runtimeDir: string): string[] {
  try {
    const meta = JSON.parse(readFileSync(join(runtimeDir, 'runtime.json'), 'utf8')) as { plugins?: unknown }
    if (!Array.isArray(meta.plugins)) return []
    return meta.plugins.filter((name): name is string => typeof name === 'string' && name !== '')
  } catch {
    return []
  }
}

/**
 * 把一个候选目录解析成插件来源。
 *
 * 候选有两种形态，按目录内容自行判断，不要求调用方声明：
 *   * **插件目录**（仓库的 `plugins/`）：每个子目录就是一个插件包；
 *   * **运行时目录**：插件在其 `node_modules/` 下，且 `runtime.json` 通常会登记名单。
 *
 * 运行时可能"登记了但包里没有"（例如被更新器换掉的那份），此时返回 undefined，
 * 让调用方继续尝试下一个候选——这正是"已损坏的运行时不能当来源"的表达。
 * @param candidate - 候选目录。
 * @returns 解析结果；该候选不可用时 undefined。
 */
export function readPluginSource(candidate: string): PluginSource | undefined {
  if (!existsSync(candidate)) return undefined

  const modules = join(candidate, 'node_modules')
  const isRuntime = existsSync(modules)
  const dir = isRuntime ? modules : candidate

  const declared = isRuntime ? declaredPlugins(candidate) : []
  const names =
    declared.length > 0
      ? declared.filter((name) => existsSync(join(dir, name, 'package.json')))
      : listPluginPackages(dir)

  return names.length > 0 ? { dir, names: [...names].sort() } : undefined
}

/**
 * 候选来源，按权威性排序。
 *
 * 顺序的道理：
 *   1. **应用自带的那份**（`<resources>/plugins`）——与外壳版本严格对应，因此最权威，
 *      外壳升级带来的新插件/新版本以它为准；
 *   2. 安装包携带的内置运行时（归档解开后的那份）——内容与 (1) 同源，是备用来源；
 *   3. `<resources>/runtime`——运行时以散文件形式随包发布的形态（开发/旧包）。
 *
 * @param options - 路径与形态。
 * @returns 去重后的候选目录，优先级从高到低。
 */
export function pluginSourceCandidates(options: {
  /** Electron 的 resources 目录。 */
  resourcesPath: string
  /** 仓库根目录（仅开发期使用）。 */
  repoRoot: string
  /** 应用数据目录。 */
  userDataDir: string
  /** 是否运行在打包后的应用里。 */
  packaged: boolean
  /** 本次启动解包出来的运行时目录（若有）。 */
  unpackedDir?: string
}): string[] {
  const { resourcesPath, repoRoot, userDataDir, packaged, unpackedDir } = options
  const candidates = [
    packaged ? join(resourcesPath, 'plugins') : join(repoRoot, 'plugins'),
    ...(unpackedDir === undefined ? [] : [unpackedDir]),
    // 归档解开后的常驻位置：运行时自动更新占的是旁边的 `runtime/`，两者并列不嵌套。
    join(userDataDir, UNPACKED_DIRNAME, 'runtime'),
    join(resourcesPath, 'runtime'),
  ]
  return [...new Set(candidates)]
}

/**
 * 启动时的插件同步：解析来源、同步，并给出要打印的诊断行。
 *
 * 把"同步 + 该说什么"一并放在这里而不是留在 `index.ts`：启动编排那一层只负责写日志，
 * 判断逻辑则可以被 `scripts/test-plugin-sync.mjs` 直接驱动——包括"运行时被换掉后补齐"
 * 这种只在真实更新之后才出现的分支。
 *
 * @param options - 路径、形态与当前运行时。
 * @returns 同步结果与诊断行（调用方原样写 stderr 即可）。
 */
export function syncPluginsAtStartup(options: {
  /** 当前实际使用的运行时目录。 */
  runtimeDir: string
  /** Electron 的 resources 目录。 */
  resourcesPath: string
  /** 仓库根目录（仅开发期使用）。 */
  repoRoot: string
  /** 应用数据目录。 */
  userDataDir: string
  /** 是否运行在打包后的应用里。 */
  packaged: boolean
  /** 本次启动解包出来的运行时目录（若有）。 */
  unpackedDir?: string
}): { outcome: PluginSyncOutcome; messages: string[] } {
  const outcome = syncPluginsIntoRuntime(options.runtimeDir, pluginSourceCandidates(options))
  const messages: string[] = []
  // 只在**确实写入**时报告：正常情况下插件已就位，每次启动都打一行日志只会淹没真正的
  // 异常（这条路径此前就是"静默失效"，可诊断性必须留在"发生了修复"这一刻）。
  if (outcome.written.length > 0) {
    messages.push(`[dsh-desktop] 已同步内置插件 ${outcome.written.join(', ')} -> ${options.runtimeDir}`)
  }
  for (const failure of outcome.failures) {
    messages.push(`[dsh-desktop] 警告: 内置插件 ${failure.name} 同步失败: ${failure.reason}`)
  }
  if (outcome.available.length === 0) {
    messages.push('[dsh-desktop] 警告: 没有找到随应用携带的内置插件，分支徽章与改动审查将不可用。')
  }
  return { outcome, messages }
}

/**
 * 把插件同步进**当前实际使用**的运行时的 `node_modules`。
 *
 * 单个插件失败只记录不抛出：插件坏掉应当表现为"某个功能不见了"，而不是整个应用起不来。
 * @param runtimeDir - 当前实际使用的运行时目录。
 * @param candidates - 候选来源，按优先级从高到低。
 * @returns 同步结果，供调用方决定是否打日志。
 */
export function syncPluginsIntoRuntime(
  runtimeDir: string,
  candidates: readonly string[],
): PluginSyncOutcome {
  const outcome: PluginSyncOutcome = { available: [], written: [], kept: [], failures: [] }
  // 运行时目录不存在时什么都不做：启动路径随后会给出更准确的诊断（缺运行时是致命错误）。
  if (!existsSync(runtimeDir)) return outcome

  let source: PluginSource | undefined
  for (const candidate of candidates) {
    const resolved = readPluginSource(candidate)
    if (resolved !== undefined) {
      source = resolved
      break
    }
  }
  if (source === undefined) return outcome

  outcome.source = source.dir
  outcome.available = [...source.names]

  const targetModules = join(runtimeDir, 'node_modules')
  mkdirSync(targetModules, { recursive: true })

  for (const name of source.names) {
    const from = join(source.dir, name)
    const to = join(targetModules, name)
    try {
      // 内容一致就不动：既避免每次启动都重写一遍，也让"这次修好了什么"在结果里看得清。
      if (existsSync(to) && fingerprint(from) === fingerprint(to)) {
        outcome.kept.push(name)
        continue
      }
      // 先删后拷，而不是直接覆盖：覆盖会留下**已被删除的文件**（例如旧版客户端
      // bundle），而 dsh 是按包名发现它们再按路径加载的，残留文件会被真的用上。
      rmSync(to, { recursive: true, force: true })
      cpSync(from, to, { recursive: true })
      outcome.written.push(name)
    } catch (error) {
      outcome.failures.push({
        name,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return outcome
}
