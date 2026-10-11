/** Runs in the application document; the loading page and native menu are not readiness signals. */
export function waitForHarnessPaint(): Promise<void> {
  return new Promise((resolve) => {
    let mounted = false
    const observer = new MutationObserver(check)
    function check(): void {
      if (mounted || document.querySelector('[data-shell-overlay]') === null) return
      mounted = true
      observer.disconnect()
      // The first callback precedes painting. Yield through another frame, then
      // an idle callback so update initialization cannot compete with first paint.
      requestAnimationFrame(() => requestAnimationFrame(() => requestIdleCallback(() => resolve())))
    }
    observer.observe(document.documentElement, { childList: true, subtree: true })
    check()
  })
}

export const HARNESS_PAINTED_SCRIPT = `(${waitForHarnessPaint.toString()})()`
