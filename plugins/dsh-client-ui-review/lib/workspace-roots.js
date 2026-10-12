import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The official launcher supplies profileContext; Desktop also supplies an
// explicit workspace. Capture cwd once for hosts without a profile context.
const launchCwd = process.cwd()

export function collectWorkspaceRoots(ctx) {
  const profile = ctx?.get?.('profileContext')
  const roots = new Set([process.env.DSH_DESKTOP_WORKSPACE || profile?.cwd || launchCwd])
  const registry = ctx?.get?.('workspaceRegistry')
  if (typeof registry?.list === 'function') {
    // Read the live registry on every request, including removals. Never grant
    // access using a stale on-disk copy when the official service is available.
    for (const workspace of registry.list()) {
      if (typeof workspace?.path === 'string' && workspace.path !== '') roots.add(workspace.path)
    }
  } else {
    const home = profile?.home || process.env.DSH_HOME
    if (typeof home === 'string' && home !== '') {
      try {
        const table = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'))?.tables?.workspaces
        for (const record of Object.values(table ?? {})) {
          const root = record?.root ?? record?.path
          if (typeof root === 'string' && root !== '') roots.add(root)
        }
      } catch {
        // A minimal host may have no workspace persistence yet.
      }
    }
  }
  return [...roots]
}
