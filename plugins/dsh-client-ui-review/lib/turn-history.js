import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function createTurnHistory(ctx, { capture, pin }) {
  const directory = ctx?.get?.('profileContext')?.dir
  const queues = new Map()
  const memory = new Map()
  const key = id => createHash('sha256').update(id).digest('hex')
  const file = id => directory ? join(directory, 'ui-review', 'turns', `${key(id)}.json`) : undefined
  const read = id => {
    if (memory.has(id)) return memory.get(id)
    let rounds = []
    try {
      const data = JSON.parse(readFileSync(file(id), 'utf8'))
      if (data.sessionId === id && Array.isArray(data.rounds)) rounds = data.rounds
    } catch (error) { if (file(id) && error.code !== 'ENOENT') throw error }
    memory.set(id, rounds)
    return rounds
  }
  const save = id => {
    const target = file(id)
    if (!target) return
    mkdirSync(join(directory, 'ui-review', 'turns'), { recursive: true })
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify({ sessionId: id, rounds: read(id) }) + '\n', { flag: 'wx', mode: 0o600 })
      renameSync(temporary, target)
    } finally { rmSync(temporary, { force: true }) }
  }
  const enqueue = (id, action) => {
    const next = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(action)
    queues.set(id, next)
    return next
  }
  return {
    async begin(sessionId, turn, repositoryRoot) {
      return enqueue(sessionId, async () => {
        const rounds = read(sessionId)
        const existing = rounds.find(round => round.turn === turn)
        if (existing) return existing
        const revision = await capture(repositoryRoot, `${sessionId}:${turn}:before`)
        await pin(repositoryRoot, `refs/dsh-review/${key(sessionId)}/${turn}/before`, revision)
        const round = { id: String(turn), turn, repositoryRoot, revision, takenAt: Date.now(), status: 'running' }
        rounds.push(round)
        save(sessionId)
        return round
      })
    },
    async end(sessionId, turn) {
      return enqueue(sessionId, async () => {
        const round = read(sessionId).find(round => round.turn === turn)
        if (!round || round.status === 'completed') return
        const after = await capture(round.repositoryRoot, `${sessionId}:${turn}:after`)
        await pin(round.repositoryRoot, `refs/dsh-review/${key(sessionId)}/${turn}/after`, after)
        Object.assign(round, { after, endedAt: Date.now(), status: 'completed' })
        save(sessionId)
      })
    },
    async select(sessionId, id) {
      await queues.get(sessionId)?.catch(() => {})
      const rounds = read(sessionId)
      const selected = id ? rounds.find(round => round.id === id) : rounds.at(-1)
      return { selected, rounds: [...rounds].reverse().map(({ id, turn, takenAt, endedAt, status }) => ({ id, turn, takenAt, endedAt, status })) }
    },
    flush: sessionId => queues.get(sessionId) ?? Promise.resolve(),
  }
}
