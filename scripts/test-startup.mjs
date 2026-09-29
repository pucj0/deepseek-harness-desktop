// npm run build && node scripts/test-startup.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { brotliCompressSync, constants } from 'node:zlib'
import { runInNewContext } from 'node:vm'
import { ensureRuntimeUnpacked, reusableUnpacked } from '../dist/main/runtime-unpack.js'
import { cachedClientModuleSource } from '../src/server/client-module-cache.mjs'

const root = resolve(import.meta.dirname, '..')
mkdirSync(join(root, '.probe-home'), { recursive: true })
const scratch = mkdtempSync(join(root, '.probe-home', 'startup-tests-'))
let passed = 0
async function check(name, action) { await action(); passed++; console.log(`PASS ${name}`) }
function archive(files, { sentinel = true, identity = true } = {}) {
  const chunks = [Buffer.from('DSHRT1\n')]
  for (const [path, content] of files) {
    const bytes = Buffer.from(content)
    const header = Buffer.from(JSON.stringify({ path, size: bytes.length, mode: 0o644 }))
    const length = Buffer.alloc(4); length.writeUInt32LE(header.length)
    chunks.push(length, header, bytes)
  }
  if (sentinel) chunks.push(Buffer.alloc(4))
  const raw = Buffer.concat(chunks)
  const compressed = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })
  const target = join(scratch, 'runtime.br')
  writeFileSync(target, compressed)
  if (identity) writeFileSync(join(scratch, 'runtime.json'), JSON.stringify({
    format: 'dsh-runtime-archive', archiveBytes: compressed.length,
    contentHash: createHash('sha256').update(raw).digest('hex'),
  }))
  else rmSync(join(scratch, 'runtime.json'), { force: true })
  return target
}
const files = [
  ['node/node.exe', 'test-node'],
  ['node_modules/@deepseek-ai/dsh/package.json', '{"version":"test"}'],
  ['node_modules/test/empty', ''],
  ['node_modules/test/large', '多字节内容\n'.repeat(100000)],
]
const home = join(scratch, 'home')
try {
  let target = archive(files)
  await check('extract file bytes and empty files; progress bounded', async () => {
    const progress = []
    const result = await ensureRuntimeUnpacked(target, home, (read, total) => progress.push(read / total))
    assert.equal(result.unpacked, true); assert.equal(result.files, files.length)
    for (const [path, content] of files) assert.deepEqual(readFileSync(join(result.dir, 'runtime', path)), Buffer.from(content))
    assert(progress.every(value => value >= 0 && value <= 1)); assert.equal(progress.at(-1), 1)
  })
  await check('same content survives installer timestamp changes', async () => {
    const stat = statSync(target)
    utimesSync(target, stat.atime, new Date(stat.mtimeMs + 10000))
    assert.equal((await ensureRuntimeUnpacked(target, home)).unpacked, false)
  })
  await check('changed content invalidates cache and removes obsolete files', async () => {
    target = archive(files.slice(0, 2).concat([['changed', 'new version']]))
    const result = await ensureRuntimeUnpacked(target, home)
    assert.equal(result.unpacked, true)
    assert.equal(readFileSync(join(result.dir, 'runtime/changed'), 'utf8'), 'new version')
    assert.equal(existsSync(join(result.dir, 'runtime/node_modules/test/large')), false)
  })
  await check('missing package anchor is not accepted as a usable runtime', async () => {
    rmSync(join(home, 'bundled-runtime/runtime/node_modules/@deepseek-ai/dsh/package.json'))
    assert.equal(reusableUnpacked(join(home, 'bundled-runtime'), target), undefined)
    assert.equal((await ensureRuntimeUnpacked(target, home)).unpacked, true)
  })
  await check('legacy archives without a manifest still start and reuse', async () => {
    target = archive(files, { identity: false })
    assert.equal((await ensureRuntimeUnpacked(target, home)).unpacked, true)
    assert.equal((await ensureRuntimeUnpacked(target, home)).unpacked, false)
  })
  await check('truncation leaves no reusable partial extraction', async () => {
    target = archive(files, { sentinel: false })
    await assert.rejects(ensureRuntimeUnpacked(target, home), /不完整/u)
    assert.equal(existsSync(join(home, 'bundled-runtime')), false)
  })
  await check('mismatched manifest fails integrity verification', async () => {
    target = archive(files)
    const manifestPath = join(scratch, 'runtime.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.contentHash = '0'.repeat(64); writeFileSync(manifestPath, JSON.stringify(manifest))
    await assert.rejects(ensureRuntimeUnpacked(target, home), /校验失败/u)
    assert.equal(existsSync(join(home, 'bundled-runtime')), false)
  })
  await check('archive paths cannot escape the extraction root', async () => {
    target = archive([['../escaped', 'bad']])
    await assert.rejects(ensureRuntimeUnpacked(target, home), /越界/u)
    assert.equal(existsSync(join(home, 'bundled-runtime/escaped')), false)
  })
  await check('write errors drain pending writes and remove partial output', async () => {
    target = archive([['conflict', 'file'], ['conflict/child', 'cannot create']])
    await assert.rejects(ensureRuntimeUnpacked(target, home))
    assert.equal(existsSync(join(home, 'bundled-runtime')), false)
  })
  await check('build identity ignores staging timestamps but notices runtime changes', () => {
    const fixture = join(scratch, 'fixture'); mkdirSync(join(fixture, 'node'), { recursive: true })
    const output = join(scratch, 'built/runtime.br')
    const build = () => {
      execFileSync(process.execPath, [join(root, 'scripts/compress-runtime.mjs'), `--source=${fixture}`, `--output=${output}`, '--quality=4'], { stdio: 'pipe', windowsHide: true })
      return JSON.parse(readFileSync(join(scratch, 'built/runtime.json'), 'utf8')).contentHash
    }
    writeFileSync(join(fixture, 'runtime.json'), JSON.stringify({ version: '1', stagedAt: 'old' }))
    writeFileSync(join(fixture, 'node/node-runtime.json'), JSON.stringify({ version: '24', downloadedAt: 'old' }))
    const first = build()
    writeFileSync(join(fixture, 'runtime.json'), JSON.stringify({ version: '1', stagedAt: 'new' }))
    writeFileSync(join(fixture, 'node/node-runtime.json'), JSON.stringify({ version: '24', downloadedAt: 'new' }))
    writeFileSync(join(fixture, 'server.mjs'), '// a newer shell launcher')
    writeFileSync(join(fixture, 'client-module-cache.mjs'), '// a newer shell adapter')
    assert.equal(build(), first)
    writeFileSync(join(fixture, 'node/node-runtime.json'), JSON.stringify({ version: '25', downloadedAt: 'new' }))
    assert.notEqual(build(), first)
  })

  const source = readFileSync(join(root, 'runtime/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js'), 'utf8')
  const cached = cachedClientModuleSource(source)
  if (cached === undefined) {
    await check('new upstream client module implementation keeps response bodies lazy and cached', () => {
      assert.match(source, /function lazyBody\(/u)
      assert.match(source, /this\.responses\.get\(artifact\.url\) \?\?/u)
      assert.match(source, /scriptBody: lazyBody/u)
    })
  } else {
  const loadCombo = text => {
    const helpers = text.slice(text.indexOf('function shortHash('), text.indexOf('/** Add initial-load scheduling metadata'))
    return runInNewContext(`const HASH_REVISION_LENGTH=12; const COMBO_REVISION_PLACEHOLDER='000000000000'; const MAX_COMBO_URL_BYTES=3072;
      const SOURCE_MAP_TRAILER = /(?:\\r?\\n)?\\/\\/# sourceMappingURL=[^\\r\\n]*(?:\\r?\\n)?$/;
      const SOURCE_URL_TRAILER = /(?:\\r?\\n)?\\/\\/# sourceURL=([^\\r\\n]+)(?:\\r?\\n)?$/;
      ${helpers}; buildCombo`, { Buffer, URL, createHash })
  }
  const originalCombo = loadCombo(source)
  const cachedCombo = loadCombo(cached)
  const record = { entry: { id: 'test-plugin' }, bundle: Buffer.from('console.log("你好😀");\n//# sourceURL=client/test.js\n') }
  const second = { entry: { id: 'second-plugin' }, bundle: Buffer.from('const a=1;\r\n') }
  const compare = (records, rev) => {
    const expected = originalCombo(records, rev); const actual = cachedCombo(records, rev)
    assert.equal(actual.script.toString(), expected.script.toString())
    assert.equal(actual.sourceMap.toString(), expected.sourceMap.toString())
    assert.equal(actual.rev, expected.rev); assert.equal(actual.url, expected.url)
    assert.equal(actual.sourceMapUrl, expected.sourceMapUrl)
    return actual
  }
  await check('cached JavaScript, source maps and revisions are byte-identical', () => {
    const first = compare([record], 'v1')
    assert.equal(compare([record], 'v1'), first)
    compare([record, second]); compare([record]); compare([record], 'v2'); compare([])
  })
  await check('HMR bundle/map changes invalidate cached artifacts', () => {
    const first = compare([record], 'v1')
    record.bundle = Buffer.from('console.log("updated");\n')
    assert.notEqual(compare([record], 'v1'), first)
    record.sourceMap = { parsed: { version: 3, sources: ['../source.ts'], names: [], mappings: 'AAAA', sourceRoot: './' } }
    compare([record], 'v3'); compare([record, second])
    delete record.sourceMap; record.entry.id = 'renamed-plugin'; compare([record], 'v3')
  })
  await check('unknown upstream source uses the untouched implementation', () => {
    assert.equal(cachedClientModuleSource(source + '\n// new upstream implementation'), undefined)
  })
  }
  console.log(`${passed} startup checks passed`)
} finally {
  if (!resolve(scratch).startsWith(join(root, '.probe-home') + '\\') && !resolve(scratch).startsWith(join(root, '.probe-home') + '/')) throw new Error('Unsafe cleanup path')
  rmSync(scratch, { recursive: true, force: true })
}
