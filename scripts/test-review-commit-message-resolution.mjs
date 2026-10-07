// Load a real plugin from resources/plugins, outside the Runtime dependency tree.
// Use real LLM/timeout modules and a local stream; no credentials or API calls.
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const tempRoot = join(root, '.tmp')
mkdirSync(tempRoot, { recursive: true })
const scratch = mkdtempSync(join(tempRoot, 'ai-resolution-'))
const runtime = resolve(process.env.DSH_AI_TEST_RUNTIME ?? join(root, 'runtime'))
const anchor = join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const pluginDir = join(scratch, 'resources', 'plugins', 'dsh-client-ui-review')
mkdirSync(join(pluginDir, 'lib'), { recursive: true })
writeFileSync(join(pluginDir, 'package.json'), '{"type":"module"}')
const entry = join(pluginDir, 'lib', 'commit-message.js')
copyFileSync(join(root, 'plugins', 'dsh-client-ui-review', 'lib', 'commit-message.js'), entry)

try {
  // This must reproduce the installed layout's original failure, otherwise the
  // repo's development links could hide the bug and invalidate this test.
  for (const name of ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-timeout']) {
    assert.throws(() => createRequire(entry).resolve(name), { code: 'MODULE_NOT_FOUND' })
    assert(createRequire(anchor).resolve(name), `Runtime must contain ${name}`)
  }
  const { createCommitMessageGenerator } = await import(pathToFileURL(entry).href)
  const requests = []
  const services = {
    profileContext: { installAnchor: anchor },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
    llm: {
      async *stream(options) {
        requests.push(options)
        yield { type: 'text-delta', index: 0, text: 'fix: resolve runtime dependencies\n\n- Reuse the active Runtime' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  const generator = createCommitMessageGenerator({ get: name => services[name] })
  const context = { branch: 'main', files: [], total: 0 }
  for (let i = 0; i < 2; i += 1) {
    const result = await generator.generateCommitMessage(context)
    assert.equal(result.subject, 'fix: resolve runtime dependencies')
    assert.deepEqual(result.bullets, ['Reuse the active Runtime'])
    assert.deepEqual(result.model, { provider: 'test-provider', model: 'test-model' })
  }
  assert.equal(requests.length, 2)
  assert.equal(requests[0].messages[0].role, 'user')
  assert(requests[0].signal instanceof AbortSignal)
  console.log(`PASS external resources/plugins resolves real LLM and timeout modules via Runtime anchor (${process.versions.electron ? 'Electron Node mode' : 'Node'})`)
} finally {
  if (!resolve(scratch).startsWith(resolve(tempRoot) + sep)) throw new Error('Unsafe cleanup path')
  rmSync(scratch, { recursive: true, force: true })
}
