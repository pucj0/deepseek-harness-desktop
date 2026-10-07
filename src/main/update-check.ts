import type { RuntimeReleaseCheck } from './runtime-release'
import type { ShellCheck } from './shell-updater'

export const UPDATE_CHECK_TIMEOUT_MS = 15_000

/** Bound the whole check, including redirects and response parsing. Late results are ignored. */
export async function withUpdateTimeout<T>(check: () => Promise<T>, timeoutMs = UPDATE_CHECK_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(check),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('GitHub update check timed out')), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export interface UpdateCheckResults {
  desktop: ShellCheck
  runtime: RuntimeReleaseCheck
}

/** Startup and menu checks share pending requests; a later manual check can retry. */
export function createUpdateChecker(deps: {
  desktopVersion: string
  runtimeVersion: string
  checkDesktop: () => Promise<ShellCheck>
  checkRuntime: () => Promise<RuntimeReleaseCheck>
  timeoutMs?: number
}): { check: () => Promise<UpdateCheckResults> } {
  let pending: Promise<UpdateCheckResults> | undefined
  const failure = (current: string, error: unknown): ShellCheck => ({
    available: false, current, reason: error instanceof Error ? error.message : String(error),
  })
  return {
    check: () => {
      if (pending !== undefined) return pending
      pending = Promise.allSettled([
        withUpdateTimeout(deps.checkDesktop, deps.timeoutMs),
        withUpdateTimeout(deps.checkRuntime, deps.timeoutMs),
      ]).then(([desktop, runtime]) => ({
        desktop: desktop.status === 'fulfilled' ? desktop.value : failure(deps.desktopVersion, desktop.reason),
        runtime: runtime.status === 'fulfilled' ? runtime.value : failure(deps.runtimeVersion, runtime.reason),
      })).finally(() => { pending = undefined })
      return pending
    },
  }
}

/** Only confirmed newer versions warrant a startup prompt; offline checks stay quiet. */
export async function checkStartupUpdates(deps: {
  check: () => Promise<UpdateCheckResults>
  canNotify: () => boolean
  notify: (results: UpdateCheckResults) => void
}): Promise<void> {
  const results = await deps.check()
  if (deps.canNotify() && (results.desktop.available || results.runtime.available)) deps.notify(results)
}
