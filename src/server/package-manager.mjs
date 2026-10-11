import { delimiter } from 'node:path'

/** Package operations own their tool PATH; Host and agent commands keep theirs. */
export function desktopPackageManager(environment = process.env) {
  const entry = environment.DSH_DESKTOP_PNPM_CLI
  const bin = environment.DSH_DESKTOP_NODE_BIN
  if (!entry || !bin) throw new Error('dsh-desktop: bundled plugin package manager is missing')
  const path = Object.entries(environment).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
  return {
    command: process.execPath,
    args: ['--expose-internals', entry],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
      PATH: `${bin}${delimiter}${path}`,
    },
  }
}
