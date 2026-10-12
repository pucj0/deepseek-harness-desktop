import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const isDiffMode = value => value === 'unified' || value === 'side-by-side'

// Profile storage survives Desktop's random HTTP ports and is independent of Git.
// The client cannot select a file path or write arbitrary settings.
export function createViewPreferences(ctx) {
  const directory = ctx?.get?.('profileContext')?.dir
  const file = typeof directory === 'string' && directory !== ''
    ? join(directory, 'ui-review', 'view-preferences.json') : undefined
  return {
    read() {
      if (!file) throw new Error('Review preferences require a local profile')
      try {
        const value = JSON.parse(readFileSync(file, 'utf8'))
        return { diffMode: isDiffMode(value?.diffMode) ? value.diffMode : null }
      } catch (error) {
        if (error.code === 'ENOENT') return { diffMode: null }
        throw error
      }
    },
    write(diffMode) {
      if (!isDiffMode(diffMode)) throw new Error('Invalid diff view mode')
      if (!file) throw new Error('Review preferences require a local profile')
      mkdirSync(join(directory, 'ui-review'), { recursive: true })
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        writeFileSync(temporary, JSON.stringify({ diffMode }) + '\n', { flag: 'wx', mode: 0o600 })
        renameSync(temporary, file)
      } finally {
        rmSync(temporary, { force: true })
      }
      return { diffMode }
    },
  }
}
