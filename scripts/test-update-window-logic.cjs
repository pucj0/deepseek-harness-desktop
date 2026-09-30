// 更新窗口的**渲染逻辑**：纯 node 下驱动 `update-window.ts` 生成的那段页面脚本。
//
//   node scripts/test-update-window-logic.cjs
//
// 为什么与 `test-update-window.cjs` 并存：那一个在**真实 Electron 窗口**里跑（量真实的
// 布局几何、真的点按钮），是首选；但它需要能启动 Electron 的图形环境，而某些 CI/沙箱
// 宿主机上 Electron 44 会以 Windows 退出码 0x80000003 直接结束（无 stdout/stderr）。
// 这一份把同一段脚本放进一个最小 DOM 桩里跑，因此**任何**环境都能验证"按钮什么时候显示、
// 点它回传什么 action、安装中显示什么"，只有几何量测留在那边。
//
// 做法上刻意只桩住 `update-window.ts` 真正用到的东西：`openPanel` 返回一个窗口对象，
// 页面脚本由 `did-finish-load` 之后经 `push` 收到状态。脚本正文从**源码**里取（编译产物
// 里同样是这段字符串），因此它验证的是真实生成的那段 JS，而不是重新实现一遍。
const assert = require('node:assert/strict')
const Module = require('node:module')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')

/** 捕获 `openPanel` 收到的 spec（body/footer/script），并假装窗口已加载完成。 */
function loadUpdateWindow() {
  const captured = { spec: undefined, actions: [], listeners: [] }
  const original = Module._load
  Module._load = function patched(request, parent, isMain) {
    if (request === 'electron') return { BrowserWindow: class {} }
    if (request === './panel') {
      return {
        escapeHtml: (value) => String(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;'),
        openPanel: (parent, userDataDir, spec, onAction) => {
          captured.spec = spec
          captured.actions = []
          const listeners = []
          captured.listeners = listeners
          const window = {
            destroyed: false,
            webContents: {
              on: (event, handler) => { listeners.push({ event, handler }) },
            },
            isDestroyed: () => false,
          }
          // 立刻模拟"加载完成"：真实实现会在这之后把最新状态推给页面。
          for (const listener of listeners) if (listener.event === 'did-finish-load') listener.handler()
          void parent
          void userDataDir
          void onAction
          return {
            window,
            push: (channel, payload) => {
              if (channel === 'state') captured.lastPush = payload
            },
          }
        },
      }
    }
    return original.call(this, request, parent, isMain)
  }
  try {
    delete require.cache[require.resolve('../dist/main/update-window.js')]
    const mod = require('../dist/main/update-window.js')
    return { mod, captured }
  } finally {
    Module._load = original
  }
}

/**
 * 极简 DOM 桩：只需要 `getElementById` + `textContent`/`hidden`/`disabled`/`style` +
 * `className`，以及把生成脚本里 `document.getElementById(id)` 用到的 id 都先建出来。
 */
function makeDom(ids) {
  const elements = new Map()
  for (const id of ids) {
    elements.set(id, { id, textContent: '', hidden: false, disabled: false, className: '', style: {} })
  }
  const document = {
    getElementById: (id) => {
      const element = elements.get(id)
      if (element === undefined) throw new Error(`DOM 桩里没有 id=${id}，说明生成脚本用到了未预期的元素`)
      return element
    },
    addEventListener: () => {},
    documentElement: { clientWidth: 520, scrollWidth: 520 },
    querySelectorAll: () => [],
  }
  return { document, elements }
}

const STRINGS = {
  title: 'Updates', checking: 'Checking GitHub Releases…', stateLatest: 'Up to date',
  stateAvailable: 'Available', stateUnknown: 'Unavailable', installedLabel: 'Current version',
  latestLabel: 'Latest version', buttonClose: 'Close', buttonDownload: 'Download update',
  progress: 'Downloading update… {percent}%', buttonDownloading: 'Downloading {percent}%…',
  sectionDesktop: 'Desktop App · project GitHub', sectionRuntime: 'Harness Runtime · official GitHub',
  runtimeBundledNote: 'Bundled with Desktop', runtimeAvailableNote: 'Runtime {version} is available',
  buttonRuntimeRelease: 'Open Runtime Release', buttonRuntimeInstall: 'Install Runtime and Restart',
  runtimeInstalling: 'Installing runtime…', runtimeProgress: 'npm: {line}',
}
const RUNTIME_AVAILABLE = {
  installed: '0.1.7-rc.2', latest: '0.2.0-rc.1', state: 'available',
  releaseUrl: 'https://example.invalid/dsh-v0.2.0-rc.1',
}
const DESKTOP_AVAILABLE = { installed: '1.7.0', latest: '1.8.0', state: 'available' }

const { mod, captured } = loadUpdateWindow()
const panel = mod.openUpdateWindow({}, '/tmp', STRINGS, (action) => captured.actions.push(action))
assert.ok(captured.spec !== undefined, 'openUpdateWindow 必须通过 openPanel 建页面')
assert.match(captured.spec.body, /id="btn-runtime-install"/u)
assert.match(captured.spec.body, /id="runtime-install-progress"/u)
assert.match(captured.spec.footer, /data-action="runtime-release"/u)

// 生成脚本里引用的所有 id 都要在桩里存在（漏一个就是真实页面上的 `null` 崩溃）。
const { document, elements } = makeDom([
  'desktop-installed', 'desktop-latest', 'desktop-status', 'desktop-note',
  'runtime-installed', 'runtime-latest', 'runtime-status', 'runtime-note',
  'btn-download', 'progress-wrap', 'progress-bar', 'progress-text',
  'btn-runtime-install', 'runtime-install-progress', 'btn-runtime-release',
])
const pushed = []
const sandbox = {
  document,
  window: {
    __panelReady: () => {},
    dshPanel: { onPush: (handler) => { pushed.push(handler) } },
  },
}
// 页面脚本只用 document/window 两个全局；用 Function 构造出与浏览器一致的作用域。
const run = new Function('document', 'window', captured.spec.script)
run(sandbox.document, sandbox.window)
assert.equal(pushed.length, 1, '页面脚本必须注册一个 push 处理器')
const push = pushed[0]

/** 推一次状态并返回关心的元素快照（隐藏的进度文本按空串返回，模拟用户看到的内容）。 */
const render = (state) => {
  push({ channel: 'state', payload: state })
  const progress = elements.get('runtime-install-progress')
  return {
    downloadHidden: elements.get('btn-download').hidden,
    downloadText: elements.get('btn-download').textContent,
    runtimeHidden: elements.get('btn-runtime-install').hidden,
    runtimeText: elements.get('btn-runtime-install').textContent,
    runtimeDisabled: elements.get('btn-runtime-install').disabled,
    runtimeStatus: elements.get('runtime-status').textContent,
    runtimeProgressHidden: progress.hidden,
    runtimeProgress: progress.hidden ? '' : progress.textContent,
    releaseHidden: elements.get('btn-runtime-release').hidden,
  }
}

// 1. 可直装：直装按钮出现，Release 备用入口隐藏。
assert.deepEqual(render({ desktop: DESKTOP_AVAILABLE, runtime: RUNTIME_AVAILABLE, canInstall: true, canInstallRuntime: true, runtimeInstalling: false }), {
  downloadHidden: false, downloadText: 'Download update',
  runtimeHidden: false, runtimeText: 'Install Runtime and Restart', runtimeDisabled: false,
  runtimeStatus: 'Available', runtimeProgressHidden: true, runtimeProgress: '', releaseHidden: true,
})

// 2. 安装中：按钮与状态徽章同文案、禁用、进度可见，且 Desktop 下载被挡住（互斥）。
assert.deepEqual(render({
  desktop: DESKTOP_AVAILABLE, runtime: RUNTIME_AVAILABLE, canInstall: true, canInstallRuntime: true,
  runtimeInstalling: true, runtimeProgress: 'npm http fetch GET 200 https://registry.npmmirror.com/@deepseek-ai%2fdsh',
}), {
  downloadHidden: true, downloadText: 'Download update',
  runtimeHidden: false, runtimeText: 'Installing runtime…', runtimeDisabled: true,
  runtimeStatus: 'Installing runtime…', runtimeProgressHidden: false,
  runtimeProgress: 'npm: npm http fetch GET 200 https://registry.npmmirror.com/@deepseek-ai%2fdsh',
  releaseHidden: true,
})

// 3. 不能直装（开发模式 / 缺 npm CLI）：只剩 Release 备用入口。
assert.deepEqual(render({ desktop: DESKTOP_AVAILABLE, runtime: RUNTIME_AVAILABLE, canInstall: true, canInstallRuntime: false, runtimeInstalling: false }), {
  downloadHidden: false, downloadText: 'Download update',
  runtimeHidden: true, runtimeText: 'Install Runtime and Restart', runtimeDisabled: false,
  runtimeStatus: 'Available', runtimeProgressHidden: true, runtimeProgress: '', releaseHidden: false,
})

// 4. Runtime 已经是新版时：没有直装按钮，但 Release 链接仍可用。
assert.deepEqual(render({ desktop: DESKTOP_AVAILABLE, runtime: { ...RUNTIME_AVAILABLE, state: 'latest' }, canInstall: true, canInstallRuntime: true, runtimeInstalling: false }), {
  downloadHidden: false, downloadText: 'Download update',
  runtimeHidden: true, runtimeText: 'Install Runtime and Restart', runtimeDisabled: false,
  runtimeStatus: 'Up to date', runtimeProgressHidden: true, runtimeProgress: '', releaseHidden: false,
})

// 5. Desktop 下载进度与两条轨道的互斥（下载中 Runtime 直装按钮禁用）。
const downloading = render({ desktop: DESKTOP_AVAILABLE, runtime: RUNTIME_AVAILABLE, canInstall: true, canInstallRuntime: true, runtimeInstalling: false, progress: 42 })
assert.equal(downloading.downloadText, 'Downloading 42%…')
assert.equal(elements.get('progress-bar').style.width, '42%')
assert.equal(downloading.runtimeDisabled, true, '下载 Desktop 安装包时不能同时装 Runtime')
assert.equal(downloading.runtimeHidden, false)

// 6. 未知状态（检查失败）时不该冒出任何动作按钮。
const unknown = render({ desktop: { installed: '1.7.0', state: 'unknown', reason: 'offline' }, runtime: { installed: '0.1.7-rc.2', state: 'unknown', reason: 'offline' }, canInstall: false, canInstallRuntime: true, runtimeInstalling: false })
assert.equal(unknown.runtimeHidden, true)
assert.equal(unknown.releaseHidden, true)
assert.equal(unknown.downloadHidden, true)
// 失败原因优先显示在备注里。
assert.equal(elements.get('runtime-note').textContent, 'offline')

console.log('PASS update window renderer: install button visibility, installing state, mutual exclusion and release fallback')
void panel
