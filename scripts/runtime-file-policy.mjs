// Desktop Production Runtime 的文件策略。
//
// 参考官方 `deepseek-ai/deepseek-harness` 的 `apps/desktop/scripts/runtime-file-policy.ts`：
// 桌面版只携带**运行时真的会读到**的文件，而 `npm install @deepseek-ai/dsh` 得到的是通用
// CLI 闭包，里面带着大量只对开发/其它平台有意义的东西。
//
// 这个模块只回答一个问题：**给定 `node_modules` 下的相对路径，要不要保留？** 它被
// `scripts/prepare-desktop-runtime.mjs` 用来生成裁剪后的 Runtime 树，而每一条剔除理由都必须
// 能被 `scripts/test-desktop-runtime.mjs` 的真实启动 smoke test 证明。
//
// 刻意不做的两件事：
//   * **不按"包名看着没用"删包**。只删明确的构建/调试/文档/其它平台产物；
//   * **不动非 native 包的目录结构**。非目标平台只按 npm 的平台命名约定识别。
//
// 关于 LibreOffice：`@deepseek-ai/libreoffice-kit` 把平台二进制声明为 **optionalDependencies**
// （win32-x64 单包 170 MiB）。已发布的 1.7.3 归档里**一个都没有**（那次解析的截止时间早于
// 该包发布），也就是说"不带它"正是当前用户手上的形态。这里用同一条规则继续不带它，并把它
// 记成一条**显式**策略，而不是让 npm 的解析时机悄悄决定。

/** 目标平台与架构（打包时由调用方传入）。 */
export const DEFAULT_TARGET = { platform: 'win32', arch: 'x64' }

/** 后缀类：纯构建/调试产物，运行时永远不会读到。 */
const DROP_FILE_SUFFIX = [
  [/\.map$/iu, 'source map'],
  [/\.d\.[cm]?ts$/iu, 'TypeScript declaration'],
  [/\.tsbuildinfo$/iu, 'TypeScript build cache'],
  [/\.flow$/iu, 'Flow types'],
  // **刻意不按 `.md` 后缀一刀切**：`@deepseek-ai/dsh-agent-preset/skills/**/SKILL.md`
  // 是**智能体技能定义**，属于运行时数据而不是文档——按后缀删会把技能功能删掉。
  // 因此只删明确是文档的那几类（README / CHANGELOG / HISTORY / AUTHORS 与包根 docs/）。
  // 调试符号：node-pty 的 conpty 符号单独就有约 10 MB。
  [/\.pdb$/iu, 'debug symbols'],
  [/\.ilk$/iu, 'incremental linker output'],
  [/\.exp$/iu, 'linker export file'],
  [/\.lib$/iu, 'static import library'],
]

/** 文件名类。 */
const DROP_FILE_NAME = [
  [/^LICEN[CS]E(\..*)?$/iu, 'license text'],
  [/^CHANGELOG(\..*)?$/iu, 'changelog'],
  [/^HISTORY(\..*)?$/iu, 'history'],
  [/^AUTHORS(\..*)?$/iu, 'authors'],
  [/^README(\..*)?$/iu, 'readme'],
  [/^\.npmignore$/iu, 'npm metadata'],
  [/^\.eslintrc(\..*)?$/iu, 'lint config'],
  [/^html5lib-tests\.json$/iu, 'test fixture'],
]

/**
 * 目录名类——**任意层级**都安全的那种。只放包管理器元数据与平台目录。
 *
 * 这些名字与"代码目录"不可能撞车：没有任何运行时逻辑会去 require 一个 `.yarn/`。
 */
const DROP_DIR_ANYWHERE = [
  [/^\.bin$/u, 'package-manager shim'],
  [/^\.pnpm$/u, 'package-manager metadata'],
  [/^\.yarn$/u, 'package-manager metadata'],
  // node-pty 的 conpty 预构建：目标平台是 win10-x64，arm64/arm 那两份白占 2 MiB。
  [/^win10-arm64$/u, 'node-pty conpty 非目标架构'],
  [/^win10-arm$/u, 'node-pty conpty 非目标架构'],
]

/**
 * 目录名类——**只认包根下的那一层**。
 *
 * 为什么必须限制层级：`yaml` 包的 `dist/doc/directives.js` 是**运行时代码**
 * （`dist/compose/composer.js` 会 `require('../doc/directives.js')`）。早期版本按"目录名
 * 叫 doc 就删"处理，结果打包后的应用启动即
 * `Cannot find module '../doc/directives.js'`——真实启动 smoke test 抓到的就是这个。
 *
 * 同理 `dist/examples`、`lib/tests` 之类也不该动：只处理 `<pkg>/test/`、`<pkg>/docs/`
 * 这种**紧贴包根**的目录，那才是随包分发的开发资料。
 */
const DROP_DIR_PACKAGE_ROOT = [
  [/^__tests__$/u, 'tests'],
  [/^(?:test|tests)$/u, 'tests'],
  [/^(?:fixtures?|__fixtures__)$/u, 'fixtures'],
  [/^(?:examples?|samples?)$/u, 'examples'],
  [/^(?:benchmarks?|bench)$/u, 'benchmarks'],
  [/^(?:docs?|documentation)$/u, 'docs'],
  [/^man$/u, 'man pages'],
]

/** npm 平台命名约定里会用到的平台 token。 */
const PLATFORM_TOKENS = ['darwin', 'linux', 'win32', 'android', 'freebsd', 'openbsd']

/**
 * `runtime/` **顶层**条目的策略（与 `node_modules` 内部无关）。
 *
 * `node/` 是历史上随 Runtime 一起 stage 的便携 Node。Electron 44 自带 Node 24，子进程直接用
 * `process.execPath` + `ELECTRON_RUN_AS_NODE=1`，因此这份 88 MiB 的副本（曾占解压后 Runtime 的
 * 46%）在发布产物里不应该存在。放在策略里而不是只在 electron-builder 的 `files` 里写一条
 * `!`，是为了让"为什么它没了、值多少字节"出现在同一份报告里。
 */
const DROP_TOP_LEVEL = [
  [/^node\//u, '便携 Node（Electron 自带 Node 24；子进程用 process.execPath + ELECTRON_RUN_AS_NODE）'],
]

/**
 * 判断 `runtime/` 顶层（非 node_modules）的一个相对路径是否应当剔除。
 *
 * @param rel - 相对 `runtime/` 的路径（POSIX 分隔符，可以带结尾斜杠）。
 * @returns 剔除原因；undefined 表示保留。
 */
export function desktopRuntimeTopLevelExclusion(rel) {
  for (const [pattern, reason] of DROP_TOP_LEVEL) {
    if (pattern.test(rel)) return reason
  }
  return undefined
}

/** 架构 token → Node 的 `process.arch` 写法。 */
const ARCH_TOKENS = {
  x64: 'x64',
  x86_64: 'x64',
  amd64: 'x64',
  arm64: 'arm64',
  aarch64: 'arm64',
  ia32: 'ia32',
  arm: 'arm',
}

/**
 * 桌面版**显式不携带**的重型 optional native 负载。
 *
 * 与"非目标平台的包"不同：它们的平台是对的，只是体积与用途决定了不该塞进安装包。
 * 每一项都要写明理由，并由 smoke test 保证不携带它们时应用照常启动。
 */
const DESKTOP_DROP_NATIVE_PAYLOAD = [
  [/^@deepseek-ai\/libreoffice-kit-/u, 'LibreOffice kit（optionalDependency；单平台 170 MiB）'],
  // 实验性语音转文字的原生运行时（onnxruntime 17 MiB + c-api 4.4 MiB）。它是
  // `dsh-experimental-speech-to-text-sensevoice` 的必需依赖，但**已发布的 1.7.3 同样不携带**
  // （09-27 的解析截止时间早于该包发布），也就是说它从未随桌面版交付过。
  // 桌面版不把它塞进安装包：这是"保持与已发布形态一致"，而不是"为了体积新增削减"。
  [/^sherpa-onnx-/u, 'sherpa-onnx native（实验性语音转文字；已发布版本同样不携带）'],
]

/**
 * 判断 `node_modules` 下的一个相对路径是否应当从 Desktop Runtime 中剔除。
 *
 * @param path - 相对 `node_modules/` 的路径（POSIX 分隔符）。
 * @param target - 目标平台与架构。
 * @returns 剔除原因；undefined 表示保留。
 */
export function desktopRuntimeExclusion(path, target = DEFAULT_TARGET) {
  const parts = path.split('/').filter((part) => part !== '')
  if (parts.length === 0) return undefined

  // 包名占几段（`@scope/name` 是两段）。
  const nameParts = parts[0]?.startsWith('@') === true ? 2 : 1

  // 1) 任意层级的目录名规则。
  for (const part of parts.slice(0, -1)) {
    for (const [pattern, reason] of DROP_DIR_ANYWHERE) {
      if (pattern.test(part)) return reason
    }
  }

  // 2) **包根下那一层**的目录名规则。层级限制是硬性的：`yaml/dist/doc/` 是运行时代码，
  //    按名字删会让应用起不来（真实 smoke test 抓过）。
  const rootDir = parts[nameParts]
  if (rootDir !== undefined && parts.length > nameParts + 1) {
    for (const [pattern, reason] of DROP_DIR_PACKAGE_ROOT) {
      if (pattern.test(rootDir)) return reason
    }
  }

  // 3) 文件名与后缀。
  const file = parts.at(-1) ?? ''
  for (const [pattern, reason] of DROP_FILE_NAME) {
    if (pattern.test(file)) return reason
  }
  for (const [pattern, reason] of DROP_FILE_SUFFIX) {
    if (pattern.test(file)) return reason
  }

  // 4) 包名层面的显式策略（`@scope/name` 或 `name`）。
  const name = parts.slice(0, nameParts).join('/')
  for (const [pattern, reason] of DESKTOP_DROP_NATIVE_PAYLOAD) {
    if (pattern.test(name)) return reason
  }

  // 5) node-pty 的预编译目录：只留目标平台那一份。
  const nodePty = pretendNodePty(path, target)
  if (nodePty !== undefined) return nodePty

  // 6) 非目标平台的 native 包：只按**包名**里的 npm 平台命名约定判断，不去猜包内容。
  const nameTokens = name.split('-').slice(1)
  for (const token of PLATFORM_TOKENS) {
    if (!nameTokens.includes(token)) continue
    const archTokens = nameTokens.filter((part) => part in ARCH_TOKENS)
    const platformMatches = token === target.platform
    const archMatches = archTokens.length === 0 || archTokens.some((arch) => ARCH_TOKENS[arch] === target.arch)
    if (!platformMatches || !archMatches) {
      return `非目标平台 native 包（目标 ${target.platform}-${target.arch}）`
    }
  }

  return undefined
}

/**
 * `node-pty` 的 `prebuilds/<platform>-<arch>/` 只保留目标平台。
 *
 * 单独一条是因为它的平台信息在**目录名**上（`prebuilds/win32-x64`），而不是包名后缀。
 *
 * @param path - 相对 `node_modules/` 的路径。
 * @param target - 目标平台与架构。
 * @returns 剔除原因；undefined 表示保留。
 */
function pretendNodePty(path, target) {
  const marker = 'node-pty/prebuilds/'
  const index = path.indexOf(marker)
  if (index < 0) return undefined
  const platform = path.slice(index + marker.length).split('/')[0] ?? ''
  if (platform === `${target.platform}-${target.arch}`) return undefined
  return `node-pty 非目标平台预编译（${platform}）`
}

/** 便于测试与日志：把策略表导出去，避免"策略只存在于代码里"。 */
export const POLICY = {
  DROP_FILE_SUFFIX,
  DROP_FILE_NAME,
  DROP_DIR_ANYWHERE,
  DROP_DIR_PACKAGE_ROOT,
  DROP_TOP_LEVEL,
  DESKTOP_DROP_NATIVE_PAYLOAD,
  PLATFORM_TOKENS,
  ARCH_TOKENS,
}
