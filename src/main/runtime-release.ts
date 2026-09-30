/**
 * 查询官方 DeepSeek Harness GitHub Releases，找出最新的 Runtime。
 *
 * 这个模块**只负责一件事**：把 GitHub 的 Release 列表变成"最新版本 + 它的发布信息"。
 * 版本语义（谁比谁新）一律来自 `runtime-version.ts`——那是唯一的事实来源，不要在这里
 * 再写一遍 SemVer 解析或比较（历史上一共有三套，正是 1.7.5 的安装器拒绝 `rc.2` 的原因）。
 *
 * 刻意只读：可安装的 Runtime 必须由**已发布的官方 `dsh-v*` GitHub Release** 授权，绝不
 * 使用源码压缩包（那些 tag 没有构建好的依赖闭包），也不能只凭一个 dist-tag。
 */
import { compareRuntimeVersions, isRuntimeVersionNewer } from './runtime-version'

export const RUNTIME_RELEASES_URL = 'https://github.com/deepseek-ai/deepseek-harness/releases'
export const RUNTIME_RELEASES_API = 'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=30'

interface GithubRelease {
  tag_name?: unknown
  html_url?: unknown
  draft?: unknown
  /** Release 的发布时间（ISO 8601）。它是依赖闭包截止时间（npm `--before`）的唯一依据。 */
  published_at?: unknown
}

export interface RuntimeReleaseCheck {
  available: boolean
  current: string
  latest?: string
  releaseUrl?: string
  /**
   * 最新那个 Release 的 `published_at`。
   *
   * 应用内安装 Runtime 时，它决定 `npm --before`（见 runtime-updater.ts）：按"该版本发布
   * 当时的仓库状态"装依赖，避免上游半波发布时 `^` 范围把还没上架的兄弟包解析进来。
   */
  publishedAt?: string
  reason?: string
}

/**
 * 把上游的 `dsh-v1.2.3` 标签转成版本号。
 *
 * 这里做的是**标签形状**的校验（必须是 `dsh-v` 前缀 + 合法 semver），不是版本比较：
 * `desktop-v1.2.3`、`v1.2.3`、`dsh-v1.2` 都要被拒掉。
 *
 * @param tag - Release 的 `tag_name`。
 * @returns 版本号；不是官方 Runtime 标签时 undefined。
 */
export function versionFromRuntimeTag(tag: string): string | undefined {
  const match = /^dsh-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(tag)
  return match?.[1]
}

// 兼容旧的导入路径：早先 `compareRuntimeVersions` 就导出在本模块，而测试与其它模块一直
// 从这里 import。真正实现已经搬到 runtime-version.ts（唯一事实来源），这里只是转发。
export { compareRuntimeVersions }

/**
 * 查询上游仓库，给出最新 Runtime 与"相对 current 是否有更新"。
 *
 * @param current - 当前正在使用的 Runtime 版本。
 * @param fetchImpl - fetch 实现（测试注入用）。
 * @returns 检查结果；失败时 `available: false` 并带 `reason`。
 */
export async function checkRuntimeRelease(
  current: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RuntimeReleaseCheck> {
  try {
    const response = await fetchImpl(RUNTIME_RELEASES_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'deepseek-harness-desktop',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`)
    const body: unknown = await response.json()
    if (!Array.isArray(body)) throw new Error('GitHub API returned an invalid release list')

    const releases = body.flatMap((value): Array<{ version: string; releaseUrl: string; publishedAt?: string }> => {
      if (typeof value !== 'object' || value === null) return []
      const release = value as GithubRelease
      if (release.draft === true || typeof release.tag_name !== 'string' || typeof release.html_url !== 'string') return []
      const version = versionFromRuntimeTag(release.tag_name)
      if (version === undefined) return []
      return [
        {
          version,
          releaseUrl: release.html_url,
          ...(typeof release.published_at === 'string' ? { publishedAt: release.published_at } : {}),
        },
      ]
    })
    releases.sort((a, b) => compareRuntimeVersions(b.version, a.version))
    const latest = releases[0]
    if (latest === undefined) throw new Error('No dsh-v* GitHub Release was found')
    return {
      available: isRuntimeVersionNewer(latest.version, current),
      current,
      latest: latest.version,
      releaseUrl: latest.releaseUrl,
      ...(latest.publishedAt === undefined ? {} : { publishedAt: latest.publishedAt }),
    }
  } catch (error) {
    return {
      available: false,
      current,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}
