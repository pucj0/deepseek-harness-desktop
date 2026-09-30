/** Check the official DeepSeek Harness GitHub Releases for the newest runtime. */

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

/** Convert the upstream `dsh-v1.2.3` release tag to a semver string. */
export function versionFromRuntimeTag(tag: string): string | undefined {
  const match = /^dsh-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(tag)
  return match?.[1]
}

interface ParsedVersion {
  core: readonly [number, number, number]
  prerelease: readonly string[]
}

function parseVersion(version: string): ParsedVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(version)
  if (match === null) return undefined
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined
  return { core: [major, minor, patch], prerelease: match[4]?.split('.') ?? [] }
}

/** Semver ordering needed by the release checker, including rc/alpha identifiers. */
export function compareRuntimeVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === undefined || b === undefined) return left.localeCompare(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = a.core[index]! - b.core[index]!
    if (difference !== 0) return difference
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const av = a.prerelease[index]
    const bv = b.prerelease[index]
    if (av === undefined || bv === undefined) return av === bv ? 0 : av === undefined ? -1 : 1
    if (av === bv) continue
    const an = /^\d+$/u.test(av) ? Number(av) : undefined
    const bn = /^\d+$/u.test(bv) ? Number(bv) : undefined
    if (an !== undefined && bn !== undefined) return an - bn
    if (an !== undefined || bn !== undefined) return an !== undefined ? -1 : 1
    return av.localeCompare(bv)
  }
  return 0
}

/**
 * Query the upstream repository directly. This is deliberately read-only: an
 * installable runtime is authorised by a published official `dsh-v*` GitHub
 * Release, never by a source archive (those carry no built dependency tree) and
 * never by a dist-tag alone.
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
      available: compareRuntimeVersions(latest.version, current) > 0,
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
