// Compatibility entry point retained for existing local/CI commands.
//
// The project Git surface no longer lives in `shell.overlay`; its equivalent
// contract is now the official Harness Right Sidebar registration plus the
// active-workspace race test. Keep this filename so older automation continues
// to exercise the replacement instead of silently testing a removed UI path.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const tests = [
  new URL('./test-git-sidebar-contract.mjs', import.meta.url),
  new URL('./test-review-workspace-race.mjs', import.meta.url),
]

for (const test of tests) {
  const result = spawnSync(process.execPath, [fileURLToPath(test)], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) process.exit(result.status ?? 1)
}

console.log('PASS legacy overlay test command now validates the official Right Sidebar path')
