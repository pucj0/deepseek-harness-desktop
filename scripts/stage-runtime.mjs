// Build-machine helper: stage a self-contained @deepseek-ai/dsh installation into ./runtime.
//
// This is what gets shipped inside the installer (electron-builder copies ./runtime
// to resources/runtime), so an end user never needs node or npm.
//
// The staged tree doubles as the "install anchor" the dsh boot chain resolves its
// bundle packages from (resolveBundleDir probes the anchor's node_modules).
//
// Usage:
//   node scripts/stage-runtime.mjs                     # installs @deepseek-ai/dsh@latest
//   node scripts/stage-runtime.mjs 0.1.5-rc.2          # pin an exact version
//   node scripts/stage-runtime.mjs next                # follow a dist-tag (latest|next|alpha)
//
// 依赖闭包的截止时间（`--before`）——这一条是修一个真实的构建事故：
//
//   dsh 的 `@deepseek-ai/dsh-*` 子包之间用 `^0.1.5-rc.2` 这样的**范围**互相依赖。于是当
//   上游只发布了半波新版本时（例如今天：rc.3 的几十个子包陆续上架，其中
//   `@deepseek-ai/dsh-client-ui-sidebar-documentpreview@0.1.5-rc.3` 缺失），装 `latest`
//   （= rc.2）会被 `^` 范围**向上**解析到那半波 rc.3，直接 ETARGET 失败——而这跟我们要装的
//   版本毫无关系。三个平台的 CI 因此同时倒在"准备内置运行时"这一步。
//
//   修法不是把版本号写死（那只是把同一个坑留到下次），而是：先解析出这次真正要装的 dsh
//   版本，取它的**发布时间**，然后给 npm `--before=<发布时间 + 24h>` —— 即"按那个版本发布
//   当时的仓库状态装依赖"。同一次发布波里的兄弟包晚几分钟到几小时上架都能等到（24 小时的
//   窗口），而下一波预发布（rc.2 → rc.3 相隔 12 天）绝不会被卷进来。
//
//   可用 `DSH_STAGE_BEFORE=off` 关掉（排查用），或 `DSH_STAGE_BEFORE=<ISO 时间>` 显式指定。
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { syncBundledPlugins } from './sync-plugins.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const RUNTIME = join(ROOT, 'runtime')
const PKG = '@deepseek-ai/dsh'

/**
 * 同一次发布波的窗口（毫秒）。
 *
 * 一次发布里各子包是**陆续**上架的（实测 rc.2 与它邻近的包相差几十分钟）。窗口太小会在
 * 兄弟包还没上架时就把自己卡死；太大则会跨进下一波预发布。24 小时是个安全的中间值：
 * 同一天的发布都能等到，而相邻的预发布之间相隔数天。
 */
export const SAME_WAVE_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * 从 packument 里解析 `requested`（dist-tag 或精确版本）。
 *
 * 纯函数，便于单测：网络只发生在调用方。
 *
 * @param packument - registry 的包文档（`{ 'dist-tags', versions, time }`）。
 * @param requested - `latest` / `next` / 精确版本号。
 * @returns `{ version, publishedAt }`；解析不出来时两者都是 undefined。
 */
export function readPackument(packument, requested) {
  const versions = packument?.versions ?? {}
  const tagged = packument?.['dist-tags']?.[requested]
  // dist-tag 优先；不是 tag 就当作精确版本（必须真的存在，否则不猜）。
  const version = typeof tagged === 'string' && tagged !== '' ? tagged : versions[requested] !== undefined ? requested : undefined
  const publishedAt = version === undefined ? undefined : packument?.time?.[version]
  return { version, publishedAt }
}

/**
 * 算出依赖闭包的截止时间（npm `--before`）。
 *
 * 返回的一律是"能直接交给 npm 的 ISO 字符串或 undefined"，判定逻辑集中在这里，
 * 因为写错它的后果是**悄悄装出另一套依赖**（正是它要修的那类事故）。
 *
 * @param options - `{ requested, packument, windowMs, override }`。
 *   `override` 是 `DSH_STAGE_BEFORE`：`off` 关闭、ISO 时间显式指定。
 * @returns `{ version, publishedAt, before, note }`。
 */
export function computeClosureBefore(options = {}) {
  const requested = options.requested ?? 'latest'
  const windowMs = Number.isFinite(options.windowMs) ? options.windowMs : SAME_WAVE_WINDOW_MS
  const override = typeof options.override === 'string' && options.override !== '' ? options.override.trim() : undefined
  const { version, publishedAt } = readPackument(options.packument, requested)

  if (override !== undefined && override.toLowerCase() === 'off') {
    return { version, publishedAt, before: undefined, note: 'DSH_STAGE_BEFORE=off（显式关闭截止时间）' }
  }
  if (override !== undefined) {
    const parsed = Date.parse(override)
    if (Number.isFinite(parsed)) {
      return { version, publishedAt, before: new Date(parsed).toISOString(), note: `DSH_STAGE_BEFORE=${override}` }
    }
    return { version, publishedAt, before: undefined, note: `DSH_STAGE_BEFORE=${override} 解析不了（已忽略）` }
  }
  const published = typeof publishedAt === 'string' ? Date.parse(publishedAt) : Number.NaN
  if (!Number.isFinite(published)) {
    // 拿不到发布时间（registry 不给 `time`、或版本号解析不出来）：**不加** `--before`，
    // 也就是退回改动前的行为——宁可像以前那样装，也不要拿一个猜出来的时间点去装。
    return { version, publishedAt, before: undefined, note: '拿不到发布时间，本次不加 --before' }
  }
  return {
    version,
    publishedAt,
    before: new Date(published + windowMs).toISOString(),
    note: `${requested} → ${version}（发布于 ${publishedAt}）+ ${Math.round(windowMs / 3600000)}h`,
  }
}

/**
 * 组装 `npm install` 的参数。纯函数：测试直接断言参数里有没有 `--before`。
 *
 * @param options - `{ npmExecPath, runtime, registry, requested, before }`。
 * @returns argv 数组（不含 `process.execPath`）。
 */
export function npmInstallArgs(options) {
  const args = [
    options.npmExecPath,
    'install',
    `${PKG}@${options.requested}`,
    '--prefix',
    options.runtime,
    '--registry',
    options.registry,
    '--no-audit',
    '--no-fund',
    '--loglevel',
    'error',
  ]
  if (typeof options.before === 'string' && options.before !== '') args.push('--before', options.before)
  return args
}

/** 拉一个包文档；失败返回 undefined（调用方退回"不加 --before"）。 */
async function fetchPackument(registry, timeoutMs) {
  const url = `${registry.replace(/\/+$/u, '')}/${PKG.replace('/', '%2F')}`
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(Math.min(30_000, timeoutMs)),
    })
    if (!response.ok) return undefined
    return await response.json()
  } catch {
    return undefined
  }
}

async function main() {
  const requested = process.argv[2] ?? 'latest'
  const registry = process.env.DSH_STAGE_REGISTRY ?? 'https://registry.npmmirror.com'

  /**
   * npm 自己的网络超时（毫秒）。
   *
   * 没有它，一个卡住的 registry 连接会耗尽整个 CI 步骤的预算，最后只留下一个
   * 莫名其妙的失败。设成有界值，让失败快而明确。
   */
  const FETCH_TIMEOUT_MS = process.env.DSH_FETCH_TIMEOUT_MS ?? '300000'

  const npmExecPath = process.env.npm_execpath
  if (npmExecPath === undefined || !existsSync(npmExecPath)) {
    throw new Error('stage-runtime: run this through npm (npm run stage:runtime) so npm_execpath is available')
  }

  // A staged runtime is a real package so its node_modules is a valid resolution
  // anchor for `packageDirFromAnchor` in dsh-app-boot.
  mkdirSync(RUNTIME, { recursive: true })
  writeFileSync(
    join(RUNTIME, 'package.json'),
    JSON.stringify({ name: 'dsh-desktop-runtime', private: true, version: '0.0.0' }, null, 2) + '\n',
  )

  const start = Date.now()
  const closure = computeClosureBefore({
    requested,
    packument: await fetchPackument(registry, Number(FETCH_TIMEOUT_MS)),
  })
  if (closure.before !== undefined) {
    // 上一次尝试（或上一次构建）留下的 lockfile 可能已经把半波新版本解出来了：删掉它，
    // 让 npm 按截止时间**重新**解析。lockfile 是构建产物（runtime/ 不入库），删了会重建。
    rmSync(join(RUNTIME, 'package-lock.json'), { force: true })
  }
  console.log(`[stage-runtime] installing ${PKG}@${requested} into runtime/ via ${registry}`)
  console.log(`[stage-runtime] 依赖闭包截止：${closure.before ?? '(不设)'} —— ${closure.note}`)
  execFileSync(process.execPath, npmInstallArgs({ npmExecPath, runtime: RUNTIME, registry, requested, before: closure.before }), {
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_fetch_timeout: FETCH_TIMEOUT_MS,
      npm_config_fetch_retries: '3',
      npm_config_fetch_retry_maxtimeout: '60000',
    },
  })

  const require = createRequire(join(RUNTIME, 'package.json'))
  const anchor = require.resolve(`${PKG}/package.json`)
  const version = JSON.parse(readFileSync(anchor, 'utf8')).version

  /**
   * 把随包内置的客户端插件装进 runtime/node_modules。
   *
   * 为什么必须在这里做：插件的客户端半边要被 dsh 的模块系统发现，前提是 host 侧能
   * 从安装位置 resolve 到它的 `package.json`。而 `server.mjs` 会在启动时把它链进
   * profile 的 node_modules，因此先要让它存在于 runtime 的依赖树旁。
   *
   * 放在 npm install 之后是因为 npm 可能重建 node_modules 目录；放这里能保证插件不
   * 会被后续安装动作清掉。
   */
  const plugins = syncBundledPlugins()

  // 如果截止时间生效，实际装到的 dsh 版本应当就是解析出来的那一个——不一致说明 registry
  // 的 dist-tag 与 `--before` 打架了，**必须让人看见**，否则内置运行时与预期版本不符。
  if (closure.version !== undefined && closure.version !== version) {
    console.warn(`[stage-runtime] 注意：期望 ${closure.version}，实际装到 ${version}`)
  }

  // Record what was staged: the app reads this to know the in-box baseline version.
  writeFileSync(
    join(RUNTIME, 'runtime.json'),
    JSON.stringify(
      {
        package: PKG,
        version,
        stagedAt: new Date().toISOString(),
        registry,
        plugins,
        // 诊断用：这次是按哪个时间点选的依赖闭包（没有截止时间时为 null）。
        closureBefore: closure.before ?? null,
      },
      null,
      2,
    ) + '\n',
  )

  console.log(`[stage-runtime] staged ${PKG}@${version} in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  console.log(`[stage-runtime] anchor = ${anchor}`)
}

/**
 * 只有**被直接运行**时才跑安装流程（测试 import 本模块只拿上面那几个纯函数）。
 *
 * Windows 上路径大小写不敏感，因此先精确比较、再在 Windows 上退化为小写比较；
 * 反过来（漏判成"不是主模块"）会让构建**静默地什么都不做**，那比多跑一次更危险。
 */
const isMain = (() => {
  const invoked = process.argv[1]
  if (typeof invoked !== 'string' || invoked === '') return false
  const modulePath = fileURLToPath(import.meta.url)
  if (resolve(invoked) === resolve(modulePath)) return true
  return process.platform === 'win32' && resolve(invoked).toLowerCase() === resolve(modulePath).toLowerCase()
})()

if (isMain) await main()
