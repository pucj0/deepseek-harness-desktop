/**
 * Shell localization.
 *
 * Only *this* shell's own chrome needs translating: the official web UI localizes
 * itself. These strings cover the window menu, the tray menu, and the update/error
 * dialogs.
 *
 * ## One locale source of truth: the Harness preference
 *
 * The language is **not** chosen here. Harness owns the setting (`@deepseek-ai/dsh-client-locale`
 * persists it as `locale.preference` in the host settings document — see `harness-locale.ts`),
 * and this module only maps that value onto a catalog. `normalizeLocale` is the single place
 * that decides what a raw locale means, so no call site has to compare against `'zh'` itself.
 *
 * When Harness has no explicit preference yet, the effective locale is the browser-derived one
 * (its own fallback), which for this app is the operating system's language list — hence
 * {@link systemLanguage}. That keeps today's behaviour for a user who never opened the setting.
 *
 * {@link setShellLocale} swaps the catalog **in place** (see {@link LIVE}), so every component
 * that captured `t()` or the object returned by `initShellStrings` follows a runtime change
 * without re-plumbing.
 */
import { app } from 'electron'

/** The languages this shell ships, as canonical ids. */
export type ShellLocale = 'zh-CN' | 'en-US'

/** Every user-visible string this shell owns. */
export interface ShellStrings {
  // Application menu titles
  menuFile: string
  menuEdit: string
  menuView: string
  menuUpdate: string
  menuHelp: string

  // Application menu items
  itemReload: string
  itemForceReload: string
  itemToggleDevTools: string
  itemQuit: string
  itemUndo: string
  itemRedo: string
  itemCut: string
  itemCopy: string
  itemPaste: string
  itemSelectAll: string
  itemResetZoom: string
  itemZoomIn: string
  itemZoomOut: string
  itemToggleFullScreen: string
  itemCheckUpdates: string
  itemRuntimeVersion: string
  itemShellVersion: string
  itemUpdateAvailable: string
  itemUpToDate: string
  itemOpenReleases: string

  // 更新窗口（两条轨道统一展示）
  updateWindowTitle: string
  updateChecking: string
  updateSectionRuntime: string
  updateSectionShell: string
  updateStateLatest: string
  updateStateAvailable: string
  updateStateUnknown: string
  updateLatestLabel: string
  updateDetailLabel: string
  updateButtonClose: string
  updateButtonRuntime: string
  updateButtonShell: string
  updateShellUnavailable: string
  updateShellProgress: string
  /** 按钮在下载中的文案，`{percent}` 会被替换成百分比。 */
  updateButtonDownloading: string
  updateRuntimeBundledNote: string
  updateRuntimeAvailableNote: string
  updateButtonRuntimeRelease: string
  /** Runtime 直装按钮：有新版且本安装包能直接安装时显示。 */
  updateButtonRuntimeInstall: string
  /** 安装中的按钮/状态文案。 */
  updateRuntimeInstalling: string
  /** 安装进度文本前的说明（后面接 npm 的日志行）。 */
  updateRuntimeProgress: string
  updateRuntimeFailedTitle: string
  /** 失败正文的第一句用户文案，`{from}` / `{to}` 会被替换成版本号。 */
  updateRuntimeFailedDetail: string
  /** 失败正文里"详细信息"的引导语（后面接原始错误消息）。 */
  updateRuntimeFailedRaw: string
  /** 目标版本就是当前版本时的提示（**不是**失败）。 */
  updateRuntimeCurrentTitle: string
  updateRuntimeCurrentDetail: string
  updateRuntimeReadyTitle: string
  updateRuntimeReadyDetail: string
  /** 已下载更新的来源说明（内置 Runtime 与下载 Runtime 的差别）。 */
  updateRuntimeDownloadedNote: string
  updateRuntimeRollbackTitle: string
  updateRuntimeRollbackDetail: string
  updateShellFailedTitle: string
  updateShellReadyTitle: string
  updateShellReadyDetail: string
  updateShellRestartNow: string
  updateShellRestartLater: string
  /** 两条轨道各自的「最新版本」标签：运行时的"最新"指通道，外壳指已发布版本。 */
  updateRuntimeLatestLabel: string
  updateShellLatestLabel: string

  // 启动加载页（窗口先于服务端显示时用）
  splashTitle: string
  splashHint: string

  // 自定义标题栏：只有菜单的无障碍文案需要本地化（窗口控制按钮是原生的）。
  // 「返回 / 前进」两个按钮已从标题栏删除（需求 H），titlebarBack / titlebarForward 随之清理。

  // 工作区 / 最近项目
  itemOpenFolder: string
  itemOpenRecent: string
  itemNoRecent: string
  itemRemoveFromRecent: string
  itemForgetWorkspace: string
  itemRevealWorkspace: string
  itemCopyWorkspacePath: string
  dialogOpenFolderTitle: string
  dialogOpenFolderButton: string
  switchWorkspaceTitle: string
  switchWorkspaceMessage: string
  switchWorkspaceDetail: string
  switchWorkspaceConfirm: string
  switchWorkspaceCancel: string
  openFolderFailedTitle: string
  copiedPathTitle: string
  copiedPathMessage: string
  workspaceMissingTitle: string
  workspaceMissingDetail: string
  forgetWorkspaceTitle: string
  forgetWorkspaceMessage: string
  forgetWorkspaceDetail: string
  forgetWorkspaceConfirm: string
  forgetWorkspaceCancel: string

  // Project info window / git status
  menuProject: string
  itemProjectInfo: string
  projectInfoTitle: string
  projectWorkspace: string
  projectGitBranch: string
  projectGitNotARepo: string
  projectGitDirty: string
  projectGitClean: string
  projectGitDetached: string
  projectGitAhead: string
  projectGitBehind: string
  projectRuntimeVersion: string
  projectRuntimeSource: string
  projectRuntimeBundled: string
  projectRuntimeDownloaded: string
  projectElectron: string
  projectNode: string
  projectHarnessHome: string
  projectUserData: string
  projectWorkspaceHint: string
  projectHarnessHomeHint: string
  projectClose: string

  // Tray
  trayTooltip: string
  trayShow: string
  trayRestart: string
  trayCheckUpdates: string
  trayQuit: string

  // Update check
  updateCheckFailedTitle: string
  updateCheckFailedDetail: string
  updateUpToDateTitle: string
  updateInstalledLabel: string
  updateNewestLabel: string
  updateRuntimeSourceLabel: string
  updateLocationLabel: string
  updateRegistryLabel: string
  updateSourceBundled: string
  updateSourceDownloaded: string
  updateAvailableTitle: string
  updateAvailableLabel: string
  updateChannelLabel: string
  updateAvailableDetail: string
  updateButtonInstall: string
  updateButtonLater: string
  updateNoNpmTitle: string
  updateNoNpmDetail: string
  updateProgressTitle: string
  updateProgressStarting: string
  updateFailedTitle: string
  updateFailedUnknown: string

  // Startup failures
  startupFailedTitle: string
  startupMissingRuntimeDetail: string
  restartFailedTitle: string
  rollbackTitle: string
  rollbackMessage: string
  rollbackDetailIntro: string
  buttonOk: string
}

const en: ShellStrings = {
  menuFile: 'File',
  menuEdit: 'Edit',
  menuView: 'View',
  menuUpdate: 'Update',
  menuHelp: 'Help',

  itemReload: 'Reload',
  itemForceReload: 'Force Reload',
  itemToggleDevTools: 'Toggle Developer Tools',
  itemQuit: 'Exit',
  itemUndo: 'Undo',
  itemRedo: 'Redo',
  itemCut: 'Cut',
  itemCopy: 'Copy',
  itemPaste: 'Paste',
  itemSelectAll: 'Select All',
  itemResetZoom: 'Actual Size',
  itemZoomIn: 'Zoom In',
  itemZoomOut: 'Zoom Out',
  itemToggleFullScreen: 'Toggle Full Screen',
  itemCheckUpdates: 'Check for Updates…',
  itemRuntimeVersion: 'Agent runtime',
  itemShellVersion: 'Application',
  itemUpdateAvailable: 'New version available',
  itemUpToDate: 'Up to date',
  itemOpenReleases: 'Open the releases page',

  updateWindowTitle: 'Updates',
  updateChecking: 'Checking GitHub Releases…',
  updateSectionRuntime: 'Harness Runtime · official GitHub',
  updateSectionShell: 'Desktop App · project GitHub',
  updateStateLatest: 'Up to date',
  updateStateAvailable: 'update available',
  updateStateUnknown: 'could not check',
  updateLatestLabel: 'Latest',
  updateDetailLabel: 'Details',
  updateButtonClose: 'Close',
  updateButtonRuntime: 'Download application update',
  updateButtonShell: 'Download update',
  updateShellUnavailable: 'App self-update is unavailable in development mode',
  updateShellProgress: 'Downloading… {percent}%',
  updateButtonDownloading: 'Downloading {percent}%…',
  updateRuntimeBundledNote:
    'The runtime bundled with this Desktop release is what runs today. When an official runtime release is newer, the app installs it in place with the npm CLI it ships — no Node.js or npm on your machine.',  updateRuntimeAvailableNote:
    'Official runtime {version} is published. Install it in place; the app downloads @deepseek-ai/dsh with its bundled npm and switches over on restart.',
  updateButtonRuntimeRelease: 'Open Runtime Release',
  updateButtonRuntimeInstall: 'Install Runtime and Restart',
  updateRuntimeInstalling: 'Installing runtime…',
  updateRuntimeProgress: 'npm: {line}',
  updateRuntimeFailedTitle: 'Runtime update failed',
  updateRuntimeFailedDetail: 'Could not update the runtime from {from} to {to}.',
  updateRuntimeFailedRaw: 'Details:',
  updateRuntimeCurrentTitle: 'The runtime is already up to date',
  updateRuntimeCurrentDetail: 'The runtime is already at this version; nothing needed to be installed.',
  updateRuntimeReadyTitle: 'Runtime update ready',
  updateRuntimeReadyDetail: 'The new runtime is installed. Restart the app to start using it.',
  updateRuntimeDownloadedNote: 'downloaded update — installed in place with the bundled npm',
  updateRuntimeRollbackTitle: 'Runtime update rolled back',
  updateRuntimeRollbackDetail:
    'The updated runtime did not start, so the app restored the bundled runtime.',
  updateShellFailedTitle: 'App update failed',
  updateShellReadyTitle: 'Application update ready',
  updateShellReadyDetail: 'The new version has been downloaded. Restart to apply it.',
  updateShellRestartNow: 'Install and Restart Now',
  updateShellRestartLater: 'Later',
  updateRuntimeLatestLabel: 'Latest GitHub Release',
  updateShellLatestLabel: 'Latest GitHub Release',

  splashTitle: 'DeepSeek Harness',
  splashHint: 'Starting the agent runtime…',

  itemOpenFolder: 'Open Folder…',
  itemOpenRecent: 'Open Recent',
  itemNoRecent: 'No recent folders',
  itemRemoveFromRecent: 'Remove from Recent',
  itemForgetWorkspace: 'Forget Workspace…',
  itemRevealWorkspace: 'Reveal Workspace in Explorer',
  itemCopyWorkspacePath: 'Copy Workspace Path',
  dialogOpenFolderTitle: 'Choose a project folder to open',
  dialogOpenFolderButton: 'Open',
  switchWorkspaceTitle: 'Switch project',
  switchWorkspaceMessage: 'Open this folder as the workspace?',
  switchWorkspaceDetail:
    'The agent reads and writes inside the workspace. Switching restarts the app so the new project goes through the full startup path; the current session stays on disk and can be resumed.',
  switchWorkspaceConfirm: 'Open Folder',
  switchWorkspaceCancel: 'Cancel',
  openFolderFailedTitle: 'Could not open the folder',
  copiedPathTitle: 'Path copied',
  copiedPathMessage: 'The workspace path is on the clipboard.',
  workspaceMissingTitle: 'The workspace no longer exists',
  workspaceMissingDetail:
    'That directory is gone, so it is no longer a valid workspace. It has been removed from the recent list and the app switched to a workspace that still exists.',
  forgetWorkspaceTitle: 'Forget workspace',
  forgetWorkspaceMessage: 'Remove this workspace from Harness?',
  forgetWorkspaceDetail:
    'Only the registration is removed: the folder, its files and its sessions stay exactly as they are. The app restarts so the change goes through the normal startup path. You can open the folder again at any time.',
  forgetWorkspaceConfirm: 'Forget Workspace',
  forgetWorkspaceCancel: 'Cancel',

  menuProject: 'Project',
  itemProjectInfo: 'Project Info…',
  projectInfoTitle: 'Project Info',
  projectWorkspace: 'Workspace',
  projectGitBranch: 'Git branch',
  projectGitNotARepo: 'not a git repository',
  projectGitDirty: 'uncommitted',
  projectGitClean: 'clean',
  projectGitDetached: 'detached HEAD',
  projectGitAhead: 'ahead',
  projectGitBehind: 'behind',
  projectRuntimeVersion: 'Agent runtime',
  projectRuntimeSource: 'Runtime source',
  projectRuntimeBundled: 'bundled with the application',
  projectRuntimeDownloaded: 'downloaded update (installed in place)',
  projectElectron: 'Electron',
  projectNode: 'Bundled Node',
  projectHarnessHome: 'Harness home',
  projectUserData: 'App data',
  projectWorkspaceHint: 'the directory the agent reads and writes',
  projectHarnessHomeHint: 'sessions and credentials live here, separate from a CLI dsh install',
  projectClose: 'Close',

  trayTooltip: 'DeepSeek Harness',
  trayShow: 'Open DeepSeek Harness',
  trayRestart: 'Restart agent runtime',
  trayCheckUpdates: 'Check for app updates…',
  trayQuit: 'Quit',

  updateCheckFailedTitle: 'Could not check for updates',
  updateCheckFailedDetail:
    'The app checks GitHub Releases. Check your network or proxy, then try again.',
  updateUpToDateTitle: 'The application is up to date',
  updateInstalledLabel: 'Installed version',
  updateNewestLabel: 'Latest available',
  updateRuntimeSourceLabel: 'Runtime source',
  updateLocationLabel: 'Location',
  updateRegistryLabel: 'Registry',
  updateSourceBundled: 'bundled with the application',
  updateSourceDownloaded: 'GitHub Release',
  updateAvailableTitle: 'Application {version} is available',
  updateAvailableLabel: 'Available',
  updateChannelLabel: 'Channel',
  updateAvailableDetail: 'The full application update is downloaded from GitHub Releases and applied on restart.',
  updateButtonInstall: 'Download and restart',
  updateButtonLater: 'Later',
  updateNoNpmTitle: 'Cannot install the update',
  updateNoNpmDetail: 'The packaged application updater is unavailable.',
  updateProgressTitle: 'Updating application',
  updateProgressStarting: 'starting',
  updateFailedTitle: 'Update failed',
  updateFailedUnknown: 'unknown error',

  startupFailedTitle: 'DeepSeek Harness could not start',
  startupMissingRuntimeDetail:
    'The bundled runtime is missing. Reinstall the application, or run "npm run stage" in a development checkout.',
  restartFailedTitle: 'Restart failed',
  rollbackTitle: 'Application update could not be applied',
  rollbackMessage: 'Reopen the application and try the GitHub Release update again.',
  rollbackDetailIntro: '',
  buttonOk: 'OK',
}

const zh: ShellStrings = {
  menuFile: '文件',
  menuEdit: '编辑',
  menuView: '视图',
  menuUpdate: '更新',
  menuHelp: '帮助',

  itemReload: '重新加载',
  itemForceReload: '强制重新加载',
  itemToggleDevTools: '开发者工具',
  itemQuit: '退出',
  itemUndo: '撤销',
  itemRedo: '重做',
  itemCut: '剪切',
  itemCopy: '复制',
  itemPaste: '粘贴',
  itemSelectAll: '全选',
  itemResetZoom: '实际大小',
  itemZoomIn: '放大',
  itemZoomOut: '缩小',
  itemToggleFullScreen: '全屏',
  itemCheckUpdates: '检查更新…',
  itemRuntimeVersion: '智能体运行时',
  itemShellVersion: '应用',
  itemUpdateAvailable: '有新版本',
  itemUpToDate: '已是最新',
  itemOpenReleases: '打开发布页面',

  updateWindowTitle: '更新',
  updateChecking: '正在检查 GitHub Releases…',
  updateSectionRuntime: 'Harness Runtime · 官方 GitHub',
  updateSectionShell: 'Desktop 应用 · 本项目 GitHub',
  updateStateLatest: '当前已是最新版本',
  updateStateAvailable: '有可用更新',
  updateStateUnknown: '无法检查',
  updateLatestLabel: '最新',
  updateDetailLabel: '详情',
  updateButtonClose: '关闭',
  updateButtonRuntime: '下载应用更新',
  updateButtonShell: '下载更新',
  updateShellUnavailable: '开发模式不支持应用自更新',
  updateShellProgress: '正在下载… {percent}%',
  updateButtonDownloading: '下载中 {percent}%…',
  /**
   * 内置 Runtime 的说明。
   *
   * **刻意短**：它是更新窗口里最长的可变文本，直接决定 Runtime 轨道的高度，而窗口高度是
   * 按"三种状态（最新 / 有新版 / 安装中）都不出现滚动条"量出来的（见 update-window.ts）。
   * 中文比英文占宽，因此中文这一份尤其要压住两行以内。
   */
  updateRuntimeBundledNote: '内置的 Runtime 会随 Desktop Release 一起更新；官方有新版本时，也可以用自带的 npm 就地在应用内安装，你的电脑不需要 Node.js 或 npm。',
  updateRuntimeAvailableNote: '官方 Runtime {version} 已发布。可以直接就地安装：应用用自带的 npm 下载 @deepseek-ai/dsh，重启后切换过去。',
  updateButtonRuntimeRelease: '打开 Runtime Release',
  updateButtonRuntimeInstall: '安装 Runtime 并重启',
  updateRuntimeInstalling: '正在安装 Runtime…',
  updateRuntimeProgress: 'npm：{line}',
  updateRuntimeFailedTitle: 'Runtime 更新失败',
  updateRuntimeFailedDetail: '无法从 {from} 更新到 {to}。',
  updateRuntimeFailedRaw: '详细信息：',
  updateRuntimeCurrentTitle: 'Runtime 已是最新版本',
  updateRuntimeCurrentDetail: '当前已经是这个版本，无需安装。',
  updateRuntimeReadyTitle: 'Runtime 更新已就绪',
  updateRuntimeReadyDetail: '新 Runtime 已安装，重启应用后开始使用。',
  updateRuntimeDownloadedNote: '已下载更新——由应用内置 npm 就地安装',
  updateRuntimeRollbackTitle: 'Runtime 更新已回退',
  updateRuntimeRollbackDetail: '更新后的 Runtime 未能启动，已恢复使用应用内置版本。',
  updateShellFailedTitle: '应用更新失败',
  updateShellReadyTitle: '应用更新已就绪',
  updateShellReadyDetail: '新版本已下载完成，重启后生效。',
  updateShellRestartNow: '立即安装并重启',
  updateShellRestartLater: '稍后',
  updateRuntimeLatestLabel: 'GitHub Release 最新版本',
  updateShellLatestLabel: 'GitHub Release 最新版本',
  splashTitle: 'DeepSeek Harness',
  splashHint: '正在启动智能体运行时，首次启动可能需要十几秒…',

  itemOpenFolder: '打开文件夹…',
  itemOpenRecent: '最近打开',
  itemNoRecent: '暂无最近打开的项目',
  itemRemoveFromRecent: '从最近项目中移除',
  itemForgetWorkspace: '移除工作区…',
  itemRevealWorkspace: '在文件管理器中打开工作区',
  itemCopyWorkspacePath: '复制工作区路径',
  dialogOpenFolderTitle: '选择要打开的项目文件夹',
  dialogOpenFolderButton: '打开',
  switchWorkspaceTitle: '切换项目',
  switchWorkspaceMessage: '把这个文件夹作为工作区打开？',
  switchWorkspaceDetail:
    '智能体只在这个工作区内读写。切换会重启应用，让新项目走完整的启动流程；当前会话已存盘，之后仍可恢复。',
  switchWorkspaceConfirm: '打开文件夹',
  switchWorkspaceCancel: '取消',
  openFolderFailedTitle: '无法打开该文件夹',
  copiedPathTitle: '路径已复制',
  copiedPathMessage: '工作区路径已放入剪贴板。',
  workspaceMissingTitle: '工作区已不存在',
  workspaceMissingDetail:
    '这个目录已经被删掉，因此不再是有效的工作区。它已从「最近打开」里移除，应用也已切换到一个仍然存在的工作区。',
  forgetWorkspaceTitle: '移除工作区',
  forgetWorkspaceMessage: '把这个工作区从 Harness 里移除？',
  forgetWorkspaceDetail:
    '只移除登记：目录、里面的文件和会话都原样保留。应用会重启，让这次改动走正常的启动流程。你随时可以再把这个文件夹打开。',
  forgetWorkspaceConfirm: '移除工作区',
  forgetWorkspaceCancel: '取消',

  menuProject: '项目',
  itemProjectInfo: '项目信息…',
  projectInfoTitle: '项目信息',
  projectWorkspace: '工作区',
  projectGitBranch: 'Git 分支',
  projectGitNotARepo: '不是 git 仓库',
  projectGitDirty: '未提交',
  projectGitClean: '干净',
  projectGitDetached: '游离 HEAD',
  projectGitAhead: '领先',
  projectGitBehind: '落后',
  projectRuntimeVersion: '智能体运行时',
  projectRuntimeSource: '运行时来源',
  projectRuntimeBundled: '随应用内置',
  projectRuntimeDownloaded: '已下载更新（应用内就地安装）',
  projectElectron: 'Electron',
  projectNode: '内置 Node',
  projectHarnessHome: 'Harness 主目录',
  projectUserData: '应用数据目录',
  projectWorkspaceHint: '智能体读写的目录',
  projectHarnessHomeHint: '会话与凭据存在这里，与命令行版 dsh 相互独立',
  projectClose: '关闭',

  trayTooltip: 'DeepSeek Harness',
  trayShow: '打开 DeepSeek Harness',
  trayRestart: '重启智能体运行时',
  trayCheckUpdates: '检查应用更新…',
  trayQuit: '退出',

  updateCheckFailedTitle: '无法检查更新',
  updateCheckFailedDetail:
    '应用需要访问 GitHub Releases。请检查网络或代理设置后重试。',
  updateUpToDateTitle: '应用已是最新版本',
  updateInstalledLabel: '已安装版本',
  updateNewestLabel: '最新可用版本',
  updateRuntimeSourceLabel: '运行时来源',
  updateLocationLabel: '安装位置',
  updateRegistryLabel: '所用源',
  updateSourceBundled: '随应用内置',
  updateSourceDownloaded: 'GitHub Release',
  updateAvailableTitle: '有可用的应用版本 {version}',
  updateAvailableLabel: '可用版本',
  updateChannelLabel: '通道',
  updateAvailableDetail: '完整应用更新会从 GitHub Releases 下载，并在重启后生效。',
  updateButtonInstall: '下载并重启',
  updateButtonLater: '稍后',
  updateNoNpmTitle: '无法安装更新',
  updateNoNpmDetail: '当前安装包不支持应用内更新。',
  updateProgressTitle: '正在更新应用',
  updateProgressStarting: '正在准备',
  updateFailedTitle: '更新失败',
  updateFailedUnknown: '未知错误',

  startupFailedTitle: 'DeepSeek Harness 无法启动',
  startupMissingRuntimeDetail:
    '未找到内置的运行时。请重新安装应用，或在开发环境中执行 “npm run stage”。',
  restartFailedTitle: '重启失败',
  rollbackTitle: '应用更新未能完成',
  rollbackMessage: '请重新打开应用并再次尝试 GitHub Release 更新。',
  rollbackDetailIntro: '',
  buttonOk: '确定',
}

/** All shipped languages, keyed by canonical id. */
const CATALOG: Record<ShellLocale, ShellStrings> = {
  'en-US': en,
  'zh-CN': zh,
}

/**
 * Normalize any locale-ish string to a shipped canonical id.
 *
 * Accepts the spellings that actually reach us: Harness stores `zh` / `en` (its built-in
 * dictionary ids), a language pack could register `zh-Hans` or `en-GB`, and a browser says
 * `zh-CN` / `en_US`. Matching is on the primary subtag because the shell ships **one** Chinese
 * and **one** English catalog — the same simplification the harness dictionaries make.
 *
 * @param locale - raw locale (`zh`, `zh-CN`, `zh_CN`, `en-US`, …); may be empty or undefined.
 * @returns canonical id, or undefined when the language is not one this shell ships.
 */
export function normalizeLocale(locale: string | undefined): ShellLocale | undefined {
  if (typeof locale !== 'string') return undefined
  const primary = locale.trim().toLowerCase().split(/[-_]/u)[0] ?? ''
  if (primary === 'zh') return 'zh-CN'
  if (primary === 'en') return 'en-US'
  return undefined
}

/**
 * Validate a locale that arrived from the **Harness runtime** (the live report).
 *
 * Two different things can be reported: an explicit preference id (`zh` / `en`) or Harness's
 * *effective* locale, which may be its browser-derived provisional value. Both are mapped by
 * {@link normalizeLocale}; anything this shell does not ship (a language pack's `ja`, a
 * malformed value, a non-string from a renderer) resolves to `undefined` and the caller must
 * then **keep what it has** rather than fall back to English — the live report is a correction,
 * never a reason to drop a language the user picked.
 *
 * @param raw - the untrusted value from the renderer.
 * @returns a shipped canonical id, or undefined when nothing should change.
 */
export function coerceReportedLocale(raw: unknown): ShellLocale | undefined {
  return typeof raw === 'string' ? normalizeLocale(raw) : undefined
}

/**
 * The live string table.
 *
 * A single mutable object rather than "the current catalog": menus, the tray, dialogs and the
 * project-info window all receive this object once, and mutating it is what makes a runtime
 * locale switch reach every one of them without touching their call sites. Its keys are exactly
 * {@link ShellStrings}, and it starts as English so a lookup before startup cannot be blank.
 */
const LIVE: ShellStrings = { ...en }

/** Canonical id of the catalog currently copied into {@link LIVE}. */
let activeLocale: ShellLocale = 'en-US'

/**
 * Pick the catalog for a locale string.
 *
 * Unknown languages fall back to English, matching the harness dictionary chain (English is its
 * terminal fallback).
 *
 * @param locale - a BCP-47 locale such as `zh-CN`; may be empty or undefined.
 * @returns the matching catalog, or English.
 */
export function catalogFor(locale: string | undefined): ShellStrings {
  return CATALOG[normalizeLocale(locale) ?? 'en-US'] ?? en
}

/**
 * Resolve the language from the operating system.
 *
 * This is only the **fallback** for "Harness has no explicit preference": the official client
 * derives its own provisional locale from `navigator.languages` in exactly the same situation,
 * so following the system here is following Harness rather than inventing a rule.
 *
 * @returns a system language tag, or undefined when `app` is unavailable (plain-node tests).
 */
function systemLanguage(): string | undefined {
  try {
    const preferred = app?.getPreferredSystemLanguages?.() ?? []
    if (preferred.length > 0) return preferred[0]
    return app?.getLocale?.() ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Apply a locale to the live string table.
 *
 * @param locale - raw locale from Harness (or anything else); unknown values mean English.
 * @returns whether the **active language** changed (so callers can skip redundant work).
 */
export function setShellLocale(locale: string | undefined): boolean {
  const next = normalizeLocale(locale) ?? 'en-US'
  const changed = next !== activeLocale
  Object.assign(LIVE, CATALOG[next])
  activeLocale = next
  return changed
}

/** The canonical id of the language currently on screen. */
export function currentLocale(): ShellLocale {
  return activeLocale
}

/**
 * Resolve the language to use for a raw Harness preference.
 *
 * The preference wins; an absent/blank one means "Harness has nothing stored", and then the
 * operating system decides — the same fallback Harness itself uses (its provisional locale comes
 * from the browser's language list). Note this is the **only** place that fallback happens, so a
 * runtime switch to "no preference" re-resolves exactly like a fresh start does.
 *
 * @param locale - raw Harness preference (`zh`, `en`, …), possibly empty/undefined.
 * @param fallback - the language to use when there is no preference; defaults to the system's.
 *   Injectable so the rule itself can be tested without depending on the host machine.
 * @returns the locale to apply (possibly still undefined when nothing is known).
 */
export function resolveShellLocale(locale: string | undefined, fallback?: string): string | undefined {
  if (typeof locale === 'string' && locale.trim() !== '') return locale
  return fallback ?? systemLanguage()
}

/**
 * Initialize the shell strings for this process.
 *
 * @param locale - the Harness locale preference when there is one; when omitted, the operating
 *   system's language is used (Harness's own browser-derived fallback).
 * @returns the live string table (see {@link LIVE}).
 */
export function initShellStrings(locale?: string): ShellStrings {
  setShellLocale(resolveShellLocale(locale))
  return LIVE
}

/**
 * The active catalog.
 *
 * Returns the live table, so callers always see the current language.
 */
export function t(): ShellStrings {
  return LIVE
}

/**
 * Fill `{name}` placeholders in a template.
 * @param template - a string containing `{placeholder}` markers.
 * @param values - replacement values keyed by placeholder name.
 * @returns the rendered string.
 */
export function format(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/gu, (match, key: string) => values[key] ?? match)
}
