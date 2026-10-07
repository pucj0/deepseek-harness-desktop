/**
 * Spawn and supervise the dsh server child process.
 *
 * The child is a plain Node process. The pinned Node that ships inside the
 * runtime is preferred; re-executing Electron as Node is only a fallback for
 * hosts whose own Node is new enough for the harness.
 *
 * Contract with src/server/server.mjs:
 *   - it prints one line `dsh web: <url>?token=<token>` once the web server is up
 *   - it prints `[dsh-desktop] ready` afterwards, as our readiness signal
 *   - everything else on stdout/stderr is forwarded to the app log
 *
 * The URL line is only where the address comes from; readiness is the later
 * `[dsh-desktop] ready` line, because the boot script does work between the two
 * that the window must not race — most importantly registering the workspace in
 * Harness's workspace registry, which is what makes the new project appear in
 * the official UI. Resolving on the URL line meant the parent could navigate the
 * window before that registration landed.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { resolve } from 'node:path'
import type { RuntimeLocation } from './paths'

/** One parsed readiness announcement from the server child. */
export interface ServerReady {
  /** Canonical loopback URL *without* the launch token, e.g. http://127.0.0.1:58645 */
  url: string
  /** The authenticated URL including ?token=..., used for the initial cookie exchange. */
  authenticatedUrl: string
  /** The OS-assigned listen port. */
  port: number
}

export interface ServerOptions {
  runtime: RuntimeLocation
  /** Harness home (DSH_HOME) for this app instance. */
  dshHome: string
  /** Workspace root handed to the agent; also the child's cwd. */
  workspace: string
  /**
   * 是否允许把这个工作区 `workspaceRegistry.create()` 进 Harness。
   *
   * **不能**无条件为 true。`--workspace` 只说明"本次进程的 cwd 是哪里"，它同时被两种
   * 完全不同的情形使用：
   *   * 用户明确要求打开这个目录（「打开文件夹」/「最近打开」/ 命令行参数）；
   *   * 只是上次 Desktop 记住的值（`settings.workspace`）或兜底值。
   *
   * 旧代码对两者都登记，于是用户在 Harness UI 里删掉的工作区会在下次启动时被无声地
   * 创建回来。这个开关只由 `reconcileWorkspaceState()` 的决定打开（见 workspace-reconcile.ts）。
   */
  registerWorkspace?: boolean
  /**
   * 本次启动要从 Harness 注册表里移除的工作区路径（「移除工作区」的意图）。
   *
   * 传空数组表示什么都不移除；省略时由 {@link registerWorkspace} 的默认值决定。
   */
  forgetWorkspaces?: readonly string[]
  /** Extra environment for the child, e.g. decrypted credentials. */
  env?: Record<string, string>
  /**
   * 内置插件的**真实**目录（`resources/plugins`，开发期是仓库的 `plugins/`）。
   *
   * 子进程要把这些插件链接进 profile 的 node_modules，而 `symlinkSync` 的目标必须是文件
   * 系统上真实存在的路径。Runtime 现在打在 `app.asar` 里，`<runtime>/node_modules/…` 只存在
   * 于归档内部，OS 看不到它——不显式给出这个目录，四个内置插件会在打包版里全部消失。
   */
  bundledPluginsDir?: string
  /** Milliseconds to wait for the readiness line before treating boot as failed. */
  readyTimeoutMs?: number
}

const READY_PATTERN = /^dsh web:\s+(?<url>\S+)/u
const DESKTOP_READY = '[dsh-desktop] ready'

/**
 * Ensure the boot script exists at `<runtime>/server.mjs` and return that path.
 *
 * Node resolves bare specifiers from the script's own directory upward, so the
 * script must live beside the runtime's `node_modules`. Running the shipped copy
 * in place (`resources/server/`) fails on any install path without a reachable
 * ancestor `node_modules` — for example `D:\Program Files\…`, where the lookup
 * walks up to the drive root and finds nothing.
 *
 * The copy is refreshed when the content differs, so a shell update that changes
 * the boot script takes effect without reinstalling the runtime, and an updated
 * runtime (which has no copy of its own) gets one too.
 *
 * @param runtime - the resolved runtime location.
 * @returns the absolute path to execute.
 */
function resolveServerEntry(runtime: RuntimeLocation): string {
  const target = runtime.serverRunEntry
  if (resolve(runtime.serverEntry) === resolve(target)) return target

  try {
    for (const name of ['client-module-cache.mjs', path.basename(runtime.serverEntry)]) {
      const source = readFileSync(path.join(path.dirname(runtime.serverEntry), name))
      const destination = name === path.basename(runtime.serverEntry) ? target : path.join(runtime.dir, name)
      let current: Buffer | undefined
      try {
        current = readFileSync(destination)
      } catch {
        current = undefined
      }
      if (current === undefined || !current.equals(source)) {
        mkdirSync(runtime.dir, { recursive: true })
        writeFileSync(destination, source)
      }
    }
    return target
  } catch {
    // 目标不可写时（Runtime 打包在 app.asar 里）**不需要**写：`npm run stage` 已经把
    // 这两个脚本放进 `runtime/`，因此 target 本来就在、内容也对。只有"目标不存在"
    // 才是真的没救——那时退回安装包里那份，让模块解析错误自己说话（比我们这里的记账
    // 失败更有信息量）。
    if (existsSync(target)) return target
    return runtime.serverEntry
  }
}

/**
 * Owns one dsh server child process and its lifecycle.
 *
 * Emits: `ready` (ServerReady), `exit` ({code, signal}), `log` ({stream, line}).
 */
export class DshServer extends EventEmitter {
  private child: ChildProcess | undefined
  private stopping = false
  private readyInfo: ServerReady | undefined

  constructor(private readonly options: ServerOptions) {
    super()
  }

  /** The readiness announcement, once received. */
  get ready(): ServerReady | undefined {
    return this.readyInfo
  }

  /** Whether the child process is currently alive. */
  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null && !this.child.killed
  }

  /**
   * Start the child and resolve once it announces its URL.
   * @returns the readiness announcement.
   */
  async start(): Promise<ServerReady> {
    if (this.child !== undefined) throw new Error('dsh-desktop: server already started')

    const { runtime, dshHome, workspace, env, readyTimeoutMs = 120_000 } = this.options
    const registerWorkspace = this.options.registerWorkspace === true
    const forgetWorkspaces = this.options.forgetWorkspaces ?? []

    // Prefer a portable Node when one is staged next to the runtime (development
    // convenience, `npm run stage:node`). In a packaged release there is none: the
    // runtime requires Node ^22.19.0 || >=24 and Electron ≥ 44 bundles Node 24, so the
    // child simply re-executes this same binary in Node mode (`ELECTRON_RUN_AS_NODE=1`).
    const useBundledNode = runtime.nodeBinary !== undefined
    const program = useBundledNode ? runtime.nodeBinary! : process.execPath

    // Put the pinned Node on the child's PATH so any tool the agent runs that
    // shells out to `node` finds a known-good version instead of whatever the
    // host happens to have (or nothing at all). The runner process itself always
    // uses process.execPath, so this only affects tool-spawned commands.
    const nodeDir = useBundledNode ? path.dirname(program) : undefined
    const pathValue = process.env['PATH'] ?? ''
    const childPath =
      nodeDir === undefined ? pathValue : `${nodeDir}${path.delimiter}${pathValue}`
    let runtimeVersion = runtime.stagedVersion
    if (runtimeVersion === undefined) {
      try {
        runtimeVersion = (JSON.parse(readFileSync(runtime.installAnchor, 'utf8')) as { version?: string }).version
      } catch {
        // The normal startup validation reports an invalid anchor separately.
      }
    }

    const child = spawn(
      program,
      [
        // 放宽 HTTP 请求头上限。
        //
        // 客户端要按插件清单请求一个"合并后的 bundle"，做法是把**所有**插件的
        // `client.js` 路径串成一个查询串：
        //   /plugins/??@deepseek-ai/dsh-api-gateway/client.js,@deepseek-ai/…&v=…
        // 请求头还包含浏览器保存的认证 Cookie。Harness 按 authority（含端口）命名
        // Cookie，而桌面每次启动都换端口；老 Cookie 也会发给同一 loopback 主机。
        // 累积后连 GET /?token=… 都可能超过 Node 默认的 16 KiB 上限，返回空的 431，
        // 此时文档加载完成但应用根本没拿到 HTML，表现为白屏。
        //
        // 同时容纳插件清单和重复启动累积的认证 Cookie，沿用桌面的 1 MiB 上限。
        '--max-http-header-size=1048576',
        // Node 选项必须位于入口脚本之前；放在后面只会进入 process.argv，不会生效。
        resolveServerEntry(runtime),
        '--dsh-home',
        dshHome,
        '--install-anchor',
        runtime.installAnchor,
        // 插件必须从**真实**目录链接（app.asar 内部路径无法作为符号链接目标）。
        ...(this.options.bundledPluginsDir === undefined
          ? []
          : ['--bundled-plugins-dir', this.options.bundledPluginsDir]),
        '--workspace',
        workspace,
        // 登记意图**必须**显式传递：只看到 `--workspace A` 就 `create(A)` 正是把
        // Harness 里已删除的工作区复活的 bug（见 ServerOptions.registerWorkspace）。
        ...(registerWorkspace ? ['--register-workspace'] : []),
        // 「移除工作区」的意图：由服务端进程用官方 `workspaceRegistry.delete()` 执行。
        ...forgetWorkspaces.flatMap((dir) => ['--forget-workspace', dir]),
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          ...env,
          ...(useBundledNode ? { PATH: childPath } : { ELECTRON_RUN_AS_NODE: '1' }),
          DSH_HOME: dshHome,
          DSH_DESKTOP: '1',
          DSH_CLIENT_VERSION: process.env.DSH_CLIENT_VERSION ?? runtimeVersion ?? 'unknown',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    this.child = child

    return await new Promise<ServerReady>((resolve, reject) => {
      let settled = false
      let tail: string[] = []

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error(`dsh-desktop: server did not become ready within ${readyTimeoutMs}ms`))
      }, readyTimeoutMs)

      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }

      const onLine = (stream: 'stdout' | 'stderr', line: string): void => {
        this.emit('log', { stream, line })
        tail.push(line)
        if (tail.length > 40) tail = tail.slice(-40)

        if (stream !== 'stdout') return
        // URL 行只用来取地址。**不能在这里 settle**：dsh-web-app 打印它的时候服务端
        // 还没走完收尾（工作区登记就在之后），父进程若此时导航窗口，界面拉到的项目
        // 列表里会还没有本次的工作区——正是"选了目录但界面没进入新项目"的成因之一。
        const match = READY_PATTERN.exec(line)
        if (match?.groups?.url !== undefined) {
          const authenticatedUrl = match.groups.url
          const parsed = new URL(authenticatedUrl)
          this.readyInfo = {
            url: `${parsed.protocol}//${parsed.host}`,
            authenticatedUrl,
            port: Number(parsed.port),
          }
          this.emit('ready', this.readyInfo)
          return
        }
        if (line.trim() === DESKTOP_READY && !settled) {
          settled = true
          clearTimeout(timer)
          if (this.readyInfo === undefined) {
            // 没有 URL 的"就绪"没法导航；报出来比让窗口去加载空地址清楚得多。
            reject(new Error('dsh-desktop: server reported ready without announcing a web URL'))
            return
          }
          resolve(this.readyInfo)
        }
      }

      attachLineReader(child.stdout, (line) => onLine('stdout', line))
      attachLineReader(child.stderr, (line) => onLine('stderr', line))

      child.once('error', (error) => fail(error))
      child.once('exit', (code, signal) => {
        this.child = undefined
        this.emit('exit', { code, signal })
        if (!settled) {
          fail(
            new Error(
              `dsh-desktop: server exited before ready (code=${String(code)}, signal=${String(signal)})\n` +
                tail.join('\n'),
            ),
          )
        }
      })
    })
  }

  /**
   * Stop the child, escalating SIGTERM -> SIGKILL.
   * @param graceMs - how long to wait after SIGTERM before force-killing.
   */
  async stop(graceMs = 5_000): Promise<void> {
    const child = this.child
    if (child === undefined) return
    this.stopping = true

    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, graceMs)
      child.once('exit', () => {
        clearTimeout(force)
        resolve()
      })
      child.kill('SIGTERM')
    })

    this.child = undefined
    this.stopping = false
  }

  /** Whether {@link stop} has been requested. */
  get isStopping(): boolean {
    return this.stopping
  }
}

/** Split a readable stream into lines, forwarding each to `onLine`. */
function attachLineReader(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (stream === null) return
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      onLine(buffer.slice(0, index).replace(/\r$/u, ''))
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
    }
  })
  stream.on('end', () => {
    if (buffer !== '') onLine(buffer)
  })
}
