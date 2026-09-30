/**
 * 应用内直接更新 Harness Runtime。
 *
 * 这一版之前，Runtime 只能随 Desktop Release 一起装：官方 `deepseek-ai/deepseek-harness`
 * 的 `dsh-v*` Release **没有预构建的 Runtime 压缩资产**（它们只是源码 tag），因此
 * "下载 GitHub source archive 当 Runtime"从来不是可行路径。Runtime 真正可安装的来源只有
 * 一个——npm registry 上的 `@deepseek-ai/dsh` **已发布版本**；而"哪个版本算官方发布"
 * 由官方 GitHub Release 授权（见 runtime-release.ts）。
 *
 * 本模块负责把这件事实成：
 *
 *   1. **版本先校验**：`isSafeRuntimeVersion` 只接受严格 semver，且落到磁盘的每一段路径都
 *      由 `runtimePath()` 拼好并断言仍在 `<userData>/runtime` 之下——版本号来自远端，
 *      绝不能被当成路径片段使用（`../../` 这种输入必须在这里就死掉）。
 *   2. **内置 npm，不要求用户装 Node**：npm CLI 随应用打包（`asarUnpack` 解到
 *      `resources/app.asar.unpacked/node_modules/npm`），用 Electron 自己的
 *      `ELECTRON_RUN_AS_NODE=1` Node 模式执行。用户机器上不需要任何 node/npm。
 *   3. **同级 staging 安装**：先装到 `<userData>/runtime/.staging-<version>-<随机>`，校验
 *      **真实** package.json 的版本号，写 `runtime.json`，然后 rename 成
 *      `<userData>/runtime/<version>`，最后才把 `current` 指过去。中断/失败只会留下一个
 *      staging 目录，当前正在用的 Runtime 一个字节都不会被动。
 *   4. **依赖闭包按发布时间截止**：`--before = GitHub Release 的 published_at + 24h`。
 *      理由与 `scripts/stage-runtime.mjs` 里那段完全相同：dsh 的子包之间用 `^0.1.5-rc.2`
 *      这样的范围互相依赖，上游"半波发布"时（rc.3 的几十个子包陆续上架、其中某个还没上）
 *      `^` 会向上解析到那半波，直接 ETARGET。24 小时窗口能等到同一次发布的兄弟包，
 *      又不会跨进下一波（相邻预发布相隔数天）。
 *   5. **registry 回退**：先 npmmirror（国内可达性最好），失败再 npmjs。
 *   6. **重复点击共享同一个 Promise**：两个窗口（或同一个窗口连点）只会跑一次 npm。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { RuntimeReleaseCheck } from './runtime-release'

/** 随包携带的 npm 所安装的包名。 */
export const RUNTIME_PACKAGE = '@deepseek-ai/dsh'

/** 首选 registry（可达性优先），失败后回退到官方 registry。 */
export const RUNTIME_REGISTRIES = ['https://registry.npmmirror.com', 'https://registry.npmjs.org'] as const

/** 同一次发布波的窗口：与 `scripts/stage-runtime.mjs` 的 SAME_WAVE_WINDOW_MS 一致。 */
export const SAME_WAVE_WINDOW_MS = 24 * 60 * 60 * 1000

/** `<userData>/runtime` 下 staging 目录的前缀（也是"这是半成品"的标记）。 */
const STAGING_PREFIX = '.staging-'

/** 严格 semver（含预发布标识），且长度有界——它来自 network，不能无界。 */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u

/** `runtime/current` 这个链接的文件名。 */
const CURRENT_NAME = 'current'

/** 写进版本目录的元数据文件名。 */
const METADATA_NAME = 'runtime.json'

/** 一次安装的进度回调。 */
export interface RuntimeInstallProgress {
  /** 面向界面的进度/日志文本（npm 的 http 级别日志行）。 */
  message: string
  /** 使用的 registry（开始时就知道）。 */
  registry: string
}

/** 安装并激活成功后的结果。 */
export interface RuntimeInstallResult {
  version: string
  /** 实际被激活的版本目录。 */
  dir: string
  registry: string
  /** 本次是复用已存在的版本目录（没有跑 npm）。 */
  reused: boolean
}

/** 写进 `<version>/runtime.json` 的元数据。 */
export interface RuntimeMetadata {
  package: string
  version: string
  installedAt: string
  registry: string
  /** 授权这次安装的官方 GitHub Release（tag，如 `dsh-v0.2.0-rc.1`）。 */
  sourceRelease: string
  /** npm `--before`（依赖闭包截止时间）；没有时为 null。 */
  closureBefore: string | null
}

/** 依赖注入点：测试用假的 release 检查与 fake npm，真实运行用默认实现。 */
export interface RuntimeUpdaterOptions {
  /** `<userData>`：版本目录、staging 与 npm cache 都在它下面。 */
  userDataDir: string
  /** Electron 的 `process.resourcesPath`。 */
  resourcesPath: string
  /** `app.getAppPath()`（开发期是仓库根）——开发运行时 npm 在这里的 node_modules 里。 */
  appPath: string
  /** 是否运行在打包后的应用里（只在打包形态下允许安装）。 */
  packaged: boolean
  /** 内置 dsh 版本；比它旧的下载版本不该被激活（见 paths.ts）。 */
  bundledVersion?: string | undefined
  /** 授权查询：默认走官方 GitHub Releases（runtime-release.ts）。 */
  checkRelease?: (current: string) => Promise<RuntimeReleaseCheck>
  /** npm CLI 定位（默认 locateBundledNpm）。 */
  locateNpm?: () => string | undefined
  /** registry 列表（默认 RUNTIME_REGISTRIES）；测试用来注入不可达的源。 */
  registries?: readonly string[]
  /** 允许安装的形态判定；默认 `packaged === true`。测试可放开。 */
  allowUnpackaged?: boolean
}

/**
 * 校验一个 Runtime 版本号是否可以安全地当成路径片段。
 *
 * 它同时是**安全边界**（拒绝 `../`、绝对路径、空串）与**格式校验**（必须是 semver）。
 * 版本号一路来自 GitHub Release 与 npm，属于不受本进程控制的数据。
 *
 * @param version - 待校验的版本字符串。
 * @returns 是否是安全、合法的 semver。
 */
export function isSafeRuntimeVersion(version: unknown): version is string {
  if (typeof version !== 'string') return false
  if (version.length === 0 || version.length > 64) return false
  if (version.includes('/') || version.includes('\\') || version.includes('\0')) return false
  if (version.startsWith('.')) return false
  return VERSION_PATTERN.test(version)
}

/**
 * 读取一个 Runtime 目录里 dsh 包**真实**的版本号。
 *
 * 刻意读 `node_modules/@deepseek-ai/dsh/package.json` 而不是自己写的 `runtime.json`：
 * 后者是"我们以为装上了什么"，前者才是"实际装上了什么"，而这条区分正是"只切换完整且
 * 版本正确的安装"的判据。
 *
 * @param runtimeDir - Runtime 目录（`<userData>/runtime/current` 或 `<version>` 目录）。
 * @returns 版本号；目录不完整/损坏时 undefined。
 */
export function readRuntimeVersion(runtimeDir: string): string | undefined {
  try {
    const manifest = JSON.parse(
      readFileSync(join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'),
    ) as { version?: unknown }
    return isSafeRuntimeVersion(manifest.version) ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/** 读取我们自己写的 `runtime.json`（诊断用；不作为"装好了"的判据）。 */
export function readRuntimeMetadata(runtimeDir: string): RuntimeMetadata | undefined {
  try {
    const meta = JSON.parse(readFileSync(join(runtimeDir, METADATA_NAME), 'utf8')) as RuntimeMetadata
    return typeof meta?.version === 'string' ? meta : undefined
  } catch {
    return undefined
  }
}

/**
 * 计算 npm `--before` 的截止时间。
 *
 * 纯函数：只做"发布时间 + 24h"，把无法解析的输入表达成 undefined（调用方据此不加
 * `--before`，也就是退回"按当前仓库状态装"——宁可像以前那样装，也不要拿一个猜出来的
 * 时间点去装）。
 *
 * @param publishedAt - GitHub Release 的 `published_at`（ISO 8601）。
 * @param windowMs - 窗口长度，默认 24 小时。
 * @returns 可以交给 npm 的 ISO 字符串；无法计算时 undefined。
 */
export function closureBefore(publishedAt: unknown, windowMs: number = SAME_WAVE_WINDOW_MS): string | undefined {
  if (typeof publishedAt !== 'string' || publishedAt.trim() === '') return undefined
  const published = Date.parse(publishedAt)
  if (!Number.isFinite(published)) return undefined
  if (!Number.isFinite(windowMs) || windowMs < 0) return undefined
  return new Date(published + windowMs).toISOString()
}

/** 版本段比较（数字段按数值比，其余按字典序），供本地大小判断使用。 */
function compareCore(left: string, right: string): number {
  const parse = (version: string): number[] | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version)
    return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
  }
  const a = parse(left)
  const b = parse(right)
  if (a === undefined || b === undefined) return 0
  for (let index = 0; index < 3; index += 1) {
    const difference = a[index]! - b[index]!
    if (difference !== 0) return difference
  }
  return 0
}

/** 目标版本是否比当前正在使用的版本更新（只比核心三段的**保守**判断）。 */
export function isNewerRuntimeVersion(target: string, current: string | undefined): boolean {
  if (current === undefined) return true
  return compareCore(target, current) > 0
}

/**
 * 定位随包携带的 npm CLI（`npm-cli.js`）。
 *
 * 打包形态下它必须落在**真实路径**上：`asarUnpack` 把它解到
 * `resources/app.asar.unpacked/node_modules/npm`，因为 Electron 的 Node 模式要从磁盘
 * 加载它（asar 内的路径对 `--prefix`、`npm-cli.js` 的自身解析都不可靠）。开发期它就在
 * 仓库根部的 `node_modules/npm`。
 *
 * 刻意**不**退回"系统 npm"：本功能的前提就是用户机器上没有 node/npm。
 *
 * @param resourcesPath - Electron 的 resources 目录。
 * @param appPath - `app.getAppPath()`。
 * @returns npm-cli.js 的绝对路径；找不到时 undefined。
 */
export function locateBundledNpm(resourcesPath: string, appPath: string): string | undefined {
  const candidates = [
    // 打包形态：asarUnpack 解出来的真实路径（electron-builder 断言的就是这一条）。
    join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(resourcesPath, 'app', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(resourcesPath, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // 开发期（appPath 是仓库根，或是 app.asar 时上面的候选已经命中）。
    join(appPath, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** `npm install` 的 argv（不含可执行文件本身）。纯函数，测试直接断言参数。 */
export function npmInstallArgs(options: {
  npmCli: string
  staging: string
  registry: string
  version: string
  cache: string
  before?: string | undefined
}): string[] {
  const args = [
    options.npmCli,
    'install',
    `${RUNTIME_PACKAGE}@${options.version}`,
    '--prefix',
    options.staging,
    '--registry',
    options.registry,
    '--no-audit',
    '--no-fund',
    '--loglevel',
    'http',
    '--cache',
    options.cache,
    // 不写 lockfile：版本目录是一次性安装产物，lockfile 只会让"同一版本目录被复用"这种
    // 判断多一个需要维护的东西。
    '--no-package-lock',
  ]
  if (typeof options.before === 'string' && options.before !== '') args.push('--before', options.before)
  return args
}

/**
 * Runtime 的应用内安装器。
 *
 * 生命周期（每一步都可失败，且失败不破坏当前 Runtime）：
 *   `install()` → 查官方 Release（授权版本 + published_at）→ 建 staging → npm install
 *   → 校验真实版本 → 写 runtime.json → rename 到 `<version>` → 指 `current`。
 */
export class RuntimeUpdater {
  private readonly root: string
  private readonly npmCli: string | undefined
  private readonly registries: readonly string[]
  /** 正在执行的安装：多窗口/重复点击共享同一个 Promise（见 install）。 */
  private inFlight: Promise<RuntimeInstallResult> | undefined

  constructor(private readonly options: RuntimeUpdaterOptions) {
    this.root = join(options.userDataDir, 'runtime')
    this.npmCli = (options.locateNpm ?? (() => locateBundledNpm(options.resourcesPath, options.appPath)))()
    this.registries = options.registries ?? RUNTIME_REGISTRIES
  }

  /** `<userData>/runtime`（版本目录与 `current` 的父目录）。 */
  get runtimeRoot(): string {
    return this.root
  }

  /** 随包 npm 的位置；undefined 表示这份安装无法直接更新 Runtime。 */
  get npmPath(): string | undefined {
    return this.npmCli
  }

  /** 当前形态是否允许应用内安装。 */
  get canInstall(): boolean {
    return this.npmCli !== undefined && (this.options.packaged || this.options.allowUnpackaged === true)
  }

  /** `<version>` 版本目录的绝对路径（拒绝任何不安全的版本号）。 */
  versionDir(version: string): string {
    return this.resolveUnderRoot(version)
  }

  /** `<version>` 完整安装好的目录；不存在或损坏时为 undefined。 */
  installedVersionDir(version: string): { dir: string; version: string } | undefined {
    if (!isSafeRuntimeVersion(version)) return undefined
    const dir = this.versionDir(version)
    const actual = readRuntimeVersion(dir)
    return actual === undefined ? undefined : { dir, version: actual }
  }

  /** `current` 链接的绝对路径。 */
  get currentPath(): string {
    return join(this.root, CURRENT_NAME)
  }

  /**
   * 安装并激活指定版本（由官方 GitHub Release 授权）。
   *
   * 并发调用**共享同一个 Promise**：两个窗口同时点"安装"只会跑一次 npm。这是必要的，
   * 因为两次并发 npm 会同时写同一个 staging/版本目录，而那种冲突的失败信息毫无意义。
   *
   * @param options - 目标版本与其 GitHub Release 发布时间。
   * @returns 安装结果。
   */
  install(options: {
    version: string
    publishedAt?: string | undefined
    onProgress?: (progress: RuntimeInstallProgress) => void
  }): Promise<RuntimeInstallResult> {
    if (this.inFlight !== undefined) return this.inFlight
    const started = this.runInstall(options)
    this.inFlight = started
    // 收尾用 `then(onFulfilled, onRejected)` 而**不是** `.finally(...)`：后者会派生一个新
    // Promise，清理要等一个微任务才发生，于是"刚结束的那一瞬间"再点一次会重复跑一次 npm。
    // 两个回调各自返回 undefined，因此也不会留下未处理的 rejection。
    void started.then(
      () => {
        if (this.inFlight === started) this.inFlight = undefined
      },
      () => {
        if (this.inFlight === started) this.inFlight = undefined
      },
    )
    return started
  }

  /** 是否已有一次安装在跑（界面据此显示"正在安装…"）。 */
  get installing(): boolean {
    return this.inFlight !== undefined
  }

  /**
   * 回退：只移除 `current` 链接。
   *
   * 回退的语义是"下一次启动用回内置 Runtime"，因此**不删任何版本目录**——用户的下载
   * 仍然留在磁盘上（可能需要事后取证，或者下次直接激活而不用重装）。
   *
   * @returns 是否真的移除了一个链接。
   */
  rollback(): boolean {
    if (!existsSync(this.currentPath)) return false
    this.removeCurrent()
    return true
  }

  /** 清理遗留的 staging 目录（上一次中断/失败留下的）。 */
  cleanupStaging(): string[] {
    const removed: string[] = []
    let entries
    try {
      entries = readdirSync(this.root, { withFileTypes: true })
    } catch {
      return removed
    }
    for (const entry of entries) {
      if (!entry.name.startsWith(STAGING_PREFIX)) continue
      try {
        rmSync(join(this.root, entry.name), { recursive: true, force: true })
        removed.push(entry.name)
      } catch {
        // 删不掉（例如另一个进程正占着）不算错误：它只是一个半成品目录。
      }
    }
    return removed
  }

  // ------------------------------------------------------------------ 内部实现 -----

  /** 把 `<version>` 拼到 root 下，并断言结果仍在 root 之内。 */
  private resolveUnderRoot(segment: string): string {
    if (!isSafeRuntimeVersion(segment)) {
      throw new Error(`dsh-desktop: 不安全的 Runtime 版本号 "${segment}"`)
    }
    const target = resolve(this.root, segment)
    const root = resolve(this.root)
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`dsh-desktop: Runtime 版本号越界 "${segment}"`)
    }
    return target
  }

  /** 执行一次完整安装（`install` 的并发壳子之外的真实实现）。 */
  private async runInstall(options: {
    version: string
    publishedAt?: string | undefined
    onProgress?: (progress: RuntimeInstallProgress) => void
  }): Promise<RuntimeInstallResult> {
    const { version, onProgress } = options
    if (!isSafeRuntimeVersion(version)) {
      throw new Error(`dsh-desktop: 非法 Runtime 版本号 "${version}"`)
    }
    if (this.npmCli === undefined) {
      throw new Error('dsh-desktop: 安装包内未找到 npm CLI，无法直接安装 Runtime')
    }
    if (!this.options.packaged && this.options.allowUnpackaged !== true) {
      throw new Error('dsh-desktop: 开发模式下不执行 Runtime 安装')
    }

    // 1. 授权：必须是一个**官方 GitHub Release**里发布过的版本。
    const release = await (this.options.checkRelease ?? (await import('./runtime-release')).checkRuntimeRelease)(
      this.options.bundledVersion ?? '0.0.0',
    )
    if (release.reason !== undefined && release.latest === undefined) {
      throw new Error(`dsh-desktop: 无法确认官方 Runtime Release：${release.reason}`)
    }
    if (release.latest !== version) {
      throw new Error(
        `dsh-desktop: Runtime ${version} 未获官方 GitHub Release 授权（最新官方版本：${release.latest ?? '未知'}）`,
      )
    }

    // 2. 内置版本更新的情形：不能把用户降到旧版本上（paths.ts 也会拒绝激活它）。
    const bundled = this.options.bundledVersion
    if (bundled !== undefined && !isNewerRuntimeVersion(version, bundled) && bundled !== version) {
      throw new Error(`dsh-desktop: 内置 Runtime ${bundled} 不低于目标版本 ${version}，无需安装`)
    }

    // 3. 已经装好且版本正确的目录直接复用：没有网络、没有 npm。
    const existing = this.installedVersionDir(version)
    if (existing !== undefined) {
      this.activate(existing.dir)
      onProgress?.({ message: `已复用已安装的 Runtime ${version}`, registry: this.registries[0] ?? '' })
      return { version, dir: existing.dir, registry: 'reused', reused: true }
    }

    mkdirSync(this.root, { recursive: true })
    // 上一次中断留下的半成品：现在清掉，避免磁盘上越积越多。
    this.cleanupStaging()

    const before = closureBefore(options.publishedAt)
    const cache = join(this.options.userDataDir, 'npm-cache')
    mkdirSync(cache, { recursive: true })

    const failures: string[] = []
    for (const registry of this.registries) {
      const staging = join(this.root, `${STAGING_PREFIX}${version}-${Math.random().toString(36).slice(2, 8)}`)
      try {
        mkdirSync(staging, { recursive: true })
        onProgress?.({ message: `正在从 ${registry} 安装 ${RUNTIME_PACKAGE}@${version}…`, registry })
        await this.runNpm({ registry, staging, version, cache, before, onProgress })

        // 4. **真实**版本校验：只看实际 package.json，不看 npm 的退出码。
        const actual = readRuntimeVersion(staging)
        if (actual !== version) {
          throw new Error(
            actual === undefined
              ? `安装结果里缺少 ${RUNTIME_PACKAGE} 的 package.json`
              : `安装到的版本是 ${actual}，与目标 ${version} 不一致`,
          )
        }

        // 5. 元数据随版本目录一起落盘（诊断：这次是谁授权、用了哪个源、闭包截止点）。
        const metadata: RuntimeMetadata = {
          package: RUNTIME_PACKAGE,
          version,
          installedAt: new Date().toISOString(),
          registry,
          sourceRelease: `dsh-v${version}`,
          closureBefore: before ?? null,
        }
        writeFileSync(join(staging, METADATA_NAME), JSON.stringify(metadata, null, 2) + '\n')

        // 6. staging → 版本目录（rename 是同一文件系统上的原子操作）。
        const target = this.versionDir(version)
        rmSync(target, { recursive: true, force: true })
        renameSync(staging, target)

        // 7. 切换 `current`：只有到这一步，下一次启动才会用上新 Runtime。
        this.activate(target)
        return { version, dir: target, registry, reused: false }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        failures.push(`${registry}: ${reason}`)
        onProgress?.({ message: `${registry} 安装失败：${reason}`, registry })
        // staging 一律清掉；`current` 与已有版本目录**一个都不动**。
        try {
          rmSync(staging, { recursive: true, force: true })
        } catch {
          // 清不掉只留下一个半成品目录，不影响"当前 Runtime 未被破坏"。
        }
      }
    }

    throw new Error(`dsh-desktop: Runtime ${version} 安装失败\n${failures.join('\n')}`)
  }

  /** 跑一次 npm install，并把 http 级别日志行转成进度回调。 */
  private runNpm(options: {
    registry: string
    staging: string
    version: string
    cache: string
    before?: string | undefined
    onProgress?: ((progress: RuntimeInstallProgress) => void) | undefined
  }): Promise<void> {
    const npmCli = this.npmCli!
    const args = npmInstallArgs({
      npmCli,
      staging: options.staging,
      registry: options.registry,
      version: options.version,
      cache: options.cache,
      before: options.before,
    })
    return new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, args, {
        // Electron 以 Node 模式运行 npm：用户机器上不需要任何 node/npm。
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          // 关掉 npm 的更新提示（它会往 stdout 写一句与进度无关的话）。
          npm_config_update_notifier: 'false',
          npm_config_audit: 'false',
          npm_config_fund: 'false',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })

      let tail: string[] = []
      const onLine = (line: string): void => {
        if (line.trim() === '') return
        tail.push(line)
        if (tail.length > 30) tail = tail.slice(-30)
        options.onProgress?.({ message: line, registry: options.registry })
      }
      attachLines(child.stdout, onLine)
      attachLines(child.stderr, onLine)

      child.once('error', (error) => rejectPromise(error))
      child.once('exit', (code, signal) => {
        if (code === 0) {
          resolvePromise()
          return
        }
        rejectPromise(
          new Error(`npm 退出码 ${String(code)}${signal === null ? '' : `（信号 ${signal}）`}\n${tail.join('\n')}`),
        )
      })
    })
  }

  /** 把 `current` 指到给定目录（Windows 用 junction，其余平台用目录符号链接）。 */
  private activate(target: string): void {
    this.removeCurrent()
    mkdirSync(this.root, { recursive: true })
    const type = process.platform === 'win32' ? 'junction' : 'dir'
    symlinkSync(resolve(target), this.currentPath, type)
  }

  /** 移除 `current`（目录链接或符号链接都适用）。 */
  private removeCurrent(): void {
    rmSync(this.currentPath, { recursive: true, force: true })
  }
}

/** 把可读流按行切分并逐行回调（npm 的日志是行导向的）。 */
function attachLines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
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
