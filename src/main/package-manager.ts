import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Real CLI path: Electron's Node mode cannot execute scripts inside app.asar. */
export function bundledPackageManagerEnvironment(serverEntry: string, packaged: boolean): Record<string, string> {
  const manifest = require.resolve('pnpm')
  const pnpmRoot = dirname(manifest).replace(/([/\\])app\.asar([/\\])/u, '$1app.asar.unpacked$2')
  const { bin } = JSON.parse(readFileSync(join(pnpmRoot, 'package.json'), 'utf8')) as { bin: { pnpm: string } }
  const cli = resolve(pnpmRoot, bin.pnpm)
  const nodeBin = packaged
    ? resolve(dirname(serverEntry), '..', 'tooling')
    : resolve(__dirname, '..', '..', 'src', 'tooling')
  if (!existsSync(cli) || !existsSync(join(nodeBin, process.platform === 'win32' ? 'node.cmd' : 'node'))) {
    throw new Error('dsh-desktop: bundled plugin package manager is missing')
  }
  return { DSH_DESKTOP_PNPM_CLI: cli, DSH_DESKTOP_NODE_BIN: nodeBin }
}
