// Exercise the actual DshServer spawn, including Electron's Node mode.
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const http = require('node:http')
const { join, resolve, sep } = require('node:path')
const { DshServer } = require('../dist/main/dsh-server')

const root = resolve(__dirname, '..')
const tempRoot = join(root, '.tmp')
mkdirSync(tempRoot, { recursive: true })

async function run() {
  console.log(`START request-header regression: Node ${process.versions.node}, Electron ${process.versions.electron ?? 'none'}`)
  const scratch = mkdtempSync(join(tempRoot, 'request-headers-'))
  const entry = join(scratch, 'server.mjs')
  // A small real HTTP server isolates the launcher contract from Harness boot.
  writeFileSync(entry, `
    import http from 'node:http';
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ maxHeaderSize: http.maxHeaderSize, cookieLength: (req.headers.cookie || '').length, urlLength: req.url.length }));
    });
    server.listen(0, '127.0.0.1', () => {
      console.log('dsh web: http://127.0.0.1:' + server.address().port + '/?token=test');
      console.log('[dsh-desktop] ready');
    });
  `)
  writeFileSync(join(scratch, 'package.json'), '{"version":"0.2.0"}')
  const server = new DshServer({
    runtime: {
      dir: scratch, installAnchor: join(scratch, 'package.json'),
      serverEntry: entry, serverRunEntry: entry, packaged: false,
      nodeBinary: process.versions.electron ? undefined : process.execPath,
    },
    workspace: scratch, dshHome: join(scratch, 'home'), readyTimeoutMs: 10000,
  })
  try {
    const ready = await server.start()
    console.log('READY test HTTP server')
    const cookie = 'dsh-auth-test=' + 'x'.repeat(32 * 1024)
    for (const path of ['/?token=test', '/plugins/??' + 'module,'.repeat(500)]) {
      const result = await new Promise((resolveRequest, reject) => {
        const request = http.get(ready.url + path, { agent: false, headers: { Cookie: cookie } }, res => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', chunk => { body += chunk })
          res.on('end', () => resolveRequest({ status: res.statusCode, body }))
          res.on('error', reject)
        }).on('error', reject)
        const timer = setTimeout(() => request.destroy(new Error('HTTP regression request timed out')), 10000)
        request.on('close', () => clearTimeout(timer))
      })
      assert.equal(result.status, 200, `${path.slice(0, 24)} rejected accumulated authentication cookies`)
      const data = JSON.parse(result.body)
      assert.equal(data.maxHeaderSize, 1048576, 'Node must consume the header option before the script')
      assert.equal(data.cookieLength, cookie.length)
      assert.equal(data.urlLength, path.length)
    }
    console.log(`PASS ${process.versions.electron ? 'Electron as Node' : 'Node'}: launch handshake and plugin bundle accept 32 KiB cookies`)
  } finally {
    await server.stop(1000)
    console.log('STOPPED test HTTP server')
    if (!resolve(scratch).startsWith(resolve(tempRoot) + sep)) throw new Error('Unsafe cleanup path')
    rmSync(scratch, { recursive: true, force: true })
  }
}

run().then(() => {
  if (process.versions.electron) return
  console.log('START Electron Node-mode regression')
  const electronBinary = process.env.DSH_HEADER_TEST_ELECTRON || require('electron')
  const result = spawnSync(electronBinary, [__filename], {
    cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8', windowsHide: true, timeout: 20000,
  })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  if (result.error) throw result.error
  assert.equal(result.status, 0, 'Electron Node mode regression failed')
}).catch(error => { console.error(error); process.exitCode = 1 })
