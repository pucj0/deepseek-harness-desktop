/**
 * Runtime 版本比较的**唯一事实来源**。
 *
 * 为什么必须只有一份：这里曾经有三套比较器——`runtime-release.ts` 的
 * `compareRuntimeVersions()`（能正确处理预发布）、`runtime-updater.ts` 的 `compareCore()`
 * （只看 major.minor.patch）、`paths.ts` 的 `compareVersions()`（同样只看三段）。后果是
 * 1.7.5 的真实故障：
 *
 *   * 更新窗口检查得出 `0.2.0-rc.1 → 0.2.0-rc.2`、`available: true`（release 那套是对的）；
 *   * 点「安装 Runtime 并重启」却报
 *     `内置 Runtime 0.2.0-rc.1 不低于目标版本 0.2.0-rc.2，无需安装`——
 *     因为 installer 那套把 `0.2.0-rc.1` 与 `0.2.0-rc.2` 都解析成 `[0,2,0]`，比较结果相等。
 *
 * 所以版本语义只能有一处实现，三边都 import 它。**不要**再在任何调用点内联版本规则，也
 * 不要为某个具体版本（`rc.2`）打补丁：`0.2.0-rc.10`、`0.2.1-alpha.1`、`0.3.0` 马上就要来。
 *
 * 实现的是 SemVer 2.0.0 的优先级规则（https://semver.org/lang/zh-CN/）：
 *   1. 先比 major / minor / patch（数值）；
 *   2. 核心三段相同时，**正式版 > 预发布版**（`0.2.0` > `0.2.0-rc.99`）；
 *   3. 双方都是预发布时逐 identifier 比较：
 *      * 数字 vs 数字 → 按数值（`rc.10` > `rc.2`，绝不能按字符串得到 `"10" < "2"`）；
 *      * 数字 vs 非数字 → **数字优先级更低**（`alpha.1` < `alpha.beta`）；
 *      * 非数字 vs 非数字 → 按 ASCII 字典序（`alpha` < `beta` < `rc`）；
 *   4. 前面的 identifier 都相同、只有长度不同时，**更长的一方优先级更高**
 *      （`alpha` < `alpha.1`）。
 *
 * 解析不出来时（不是合法 semver）返回 `undefined`，调用方必须自己决定怎么处理；比较函数
 * 在拿到无法解析的输入时退回**字符串比较**，这样至少是确定性的，而不是静默返回 0。
 */

/** 解析后的 Runtime 版本。 */
export interface ParsedRuntimeVersion {
  major: number
  minor: number
  patch: number
  /** 预发布标识符（`-` 之后按 `.` 切分）；正式版为空数组。 */
  prerelease: string[]
}

/** 严格 semver（含预发布标识），且长度有界——版本号来自 network，不能无界。 */
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u

/**
 * 解析一个 Runtime 版本号。
 *
 * 只接受标准 semver（`X.Y.Z` 或 `X.Y.Z-prerelease`）：不允许 `v` 前缀、不允许 build
 * metadata（`+`），因为 Git tag 到版本号的转换在 `runtime-release.ts` 里已经做过一次，
 * 而这里再宽容一次只会让"到底哪个字符串算合法"变得模糊。
 *
 * @param version - 待解析的版本字符串。
 * @returns 解析结果；不是合法 semver 时 undefined。
 */
export function parseRuntimeVersion(version: unknown): ParsedRuntimeVersion | undefined {
  if (typeof version !== 'string' || version.length === 0 || version.length > 64) return undefined
  const match = VERSION_PATTERN.exec(version)
  if (match === null) return undefined
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined
  const prerelease = match[4] === undefined ? [] : match[4].split('.')
  // 空 identifier（`1.0.0-`、`1.0.0-a..b`）不是合法 semver。
  if (prerelease.some((identifier) => identifier === '')) return undefined
  return { major, minor, patch, prerelease }
}

/** 一个预发布 identifier 是不是纯数字（SemVer 规则 3 的判据）。 */
function isNumericIdentifier(identifier: string): boolean {
  return /^\d+$/u.test(identifier)
}

/**
 * 比较两个预发布标识符序列（SemVer 规则 3 与 4）。
 *
 * @param left - 左侧 identifier 数组。
 * @param right - 右侧 identifier 数组。
 * @returns `<0` / `0` / `>0`。
 */
function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  // 正式版（空数组）优先级**高于**任何预发布版本（规则 2）。
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1

  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index]!
    const b = right[index]!
    if (a === b) continue
    const aNumeric = isNumericIdentifier(a)
    const bNumeric = isNumericIdentifier(b)
    if (aNumeric && bNumeric) {
      const difference = Number(a) - Number(b)
      if (difference !== 0) return difference
      continue
    }
    // 数字 identifier 的优先级**低于**非数字 identifier。
    if (aNumeric) return -1
    if (bNumeric) return 1
    // 都是非数字：ASCII 字典序（`<`/`>` 而不是 localeCompare：localeCompare 会把
    // `alpha` 与 `alpha` 之外的字符按语言习惯排序，而 SemVer 规定的是字节序）。
    if (a < b) return -1
    return 1
  }
  // 前缀完全相同：identifier 更多的一方优先级更高（规则 4：`alpha` < `alpha.1`）。
  return left.length - right.length
}

/**
 * 比较两个 Runtime 版本（SemVer 2.0.0 优先级）。
 *
 * @param left - 左侧版本号。
 * @param right - 右侧版本号。
 * @returns `<0` 表示 `left < right`，`0` 表示相等，`>0` 表示 `left > right`。
 *   任一输入无法解析时退回字符串比较（确定性优先，绝不静默返回 0）。
 */
export function compareRuntimeVersions(left: string, right: string): number {
  const a = parseRuntimeVersion(left)
  const b = parseRuntimeVersion(right)
  if (a === undefined || b === undefined) {
    if (left === right) return 0
    return left < right ? -1 : 1
  }
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  return comparePrerelease(a.prerelease, b.prerelease)
}

/**
 * `candidate` 是否**严格新于** `current`。
 *
 * `current` 缺席（读不到内置版本）时按"是新的"处理：那种情况下没有可比较的基准，拒绝安装
 * 会把用户永久卡住。
 *
 * @param candidate - 候选版本（通常是官方 Release 的最新版本）。
 * @param current - 当前 / 基准版本；undefined 表示没有基准。
 * @returns 候选是否更新。
 */
export function isRuntimeVersionNewer(candidate: string, current: string | undefined): boolean {
  if (current === undefined) return true
  return compareRuntimeVersions(candidate, current) > 0
}

/**
 * `candidate` 是否**不低于** `current`（即 `candidate >= current`）。
 *
 * @param candidate - 候选版本。
 * @param current - 基准版本。
 * @returns 候选是否不低于基准。
 */
export function isRuntimeVersionAtLeast(candidate: string, current: string): boolean {
  return compareRuntimeVersions(candidate, current) >= 0
}

/**
 * 校验一个 Runtime 版本号是否可以安全地当成**路径片段**。
 *
 * 与解析分开：这是安全边界（拒绝 `../`、分隔符、空串、过长），格式校验交给
 * {@link parseRuntimeVersion}。版本号一路来自 GitHub Release 与 npm，属于不受本进程
 * 控制的数据，绝不能直接拼进路径。
 *
 * @param version - 待校验的版本字符串。
 * @returns 是否既安全、又是合法 semver。
 */
export function isSafeRuntimeVersion(version: unknown): version is string {
  if (typeof version !== 'string') return false
  if (version.includes('/') || version.includes('\\') || version.includes('\0')) return false
  if (version.startsWith('.')) return false
  return parseRuntimeVersion(version) !== undefined
}
