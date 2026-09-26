/**
 * Shell localization.
 *
 * Only *this* shell's own chrome needs translating: the official web UI already
 * localizes itself from its own locale setting. These strings cover the window
 * menu, the tray menu, and the update/error dialogs.
 *
 * The language follows the operating system, matching how the harness UI behaves:
 * a Chinese system gets Chinese, everything else gets English.
 */
import { app } from 'electron'

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
  /** 解包内置运行时时的提示，`{percent}` 会被替换成百分比。 */
  splashUnpacking: string

  // 自定义标题栏（窗口控制按钮是原生的，因此这里只有导航按钮与菜单的无障碍文案）
  titlebarBack: string
  titlebarForward: string

  // 工作区 / 最近项目
  itemOpenFolder: string
  itemOpenRecent: string
  itemNoRecent: string
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
  itemShellVersion: 'Shell',
  itemUpdateAvailable: 'New version available',
  itemUpToDate: 'Up to date',
  itemOpenReleases: 'Open the releases page',

  updateWindowTitle: 'Updates',
  updateChecking: 'Checking…',
  updateSectionRuntime: 'Agent runtime',
  updateSectionShell: 'Application shell',
  updateStateLatest: 'up to date',
  updateStateAvailable: 'update available',
  updateStateUnknown: 'could not check',
  updateLatestLabel: 'Latest',
  updateDetailLabel: 'Details',
  updateButtonClose: 'Close',
  updateButtonRuntime: 'Update runtime and restart',
  updateButtonShell: 'Download and install',
  updateShellUnavailable: 'Automatic shell updates need a published release with update metadata.',
  updateShellProgress: 'Downloading… {percent}%',
  updateButtonDownloading: 'Downloading {percent}%…',
  updateShellFailedTitle: 'Shell update failed',
  updateShellReadyTitle: 'Shell update ready',
  updateShellReadyDetail: 'The new version has been downloaded. Restart to apply it.',
  updateShellRestartNow: 'Restart now',
  updateShellRestartLater: 'Later',
  updateRuntimeLatestLabel: 'Newest on this channel',
  updateShellLatestLabel: 'Newest published release',

  splashTitle: 'DeepSeek Harness',
  splashHint: 'Starting the agent runtime…',
  splashUnpacking: 'Unpacking the bundled runtime… {percent}%',

  titlebarBack: 'Back',
  titlebarForward: 'Forward',

  itemOpenFolder: 'Open Folder…',
  itemOpenRecent: 'Open Recent',
  itemNoRecent: 'No recent folders',
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
  projectRuntimeDownloaded: "downloaded update (this app's data directory)",
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
  trayCheckUpdates: 'Check for runtime updates…',
  trayQuit: 'Quit',

  updateCheckFailedTitle: 'Could not check for updates',
  updateCheckFailedDetail:
    'The app queries the npm registry for @deepseek-ai/dsh. Check your network or proxy, then try again.',
  updateUpToDateTitle: 'The agent runtime is up to date',
  updateInstalledLabel: 'Installed version',
  updateNewestLabel: 'Latest available',
  updateRuntimeSourceLabel: 'Runtime source',
  updateLocationLabel: 'Location',
  updateRegistryLabel: 'Registry',
  updateSourceBundled: 'bundled with the application',
  updateSourceDownloaded: "downloaded update (this app's data directory)",
  updateAvailableTitle: 'Agent runtime {version} is available',
  updateAvailableLabel: 'Available',
  updateChannelLabel: 'Channel',
  updateAvailableDetail:
    "The new runtime is downloaded into this app's data directory and applied on restart. " +
    'If it fails to start, the bundled runtime is restored automatically.',
  updateButtonInstall: 'Download and restart',
  updateButtonLater: 'Later',
  updateNoNpmTitle: 'Cannot install the update',
  updateNoNpmDetail: 'No npm CLI was found inside the application bundle.',
  updateProgressTitle: 'Updating agent runtime',
  updateProgressStarting: 'starting',
  updateFailedTitle: 'Update failed',
  updateFailedUnknown: 'unknown error',

  startupFailedTitle: 'DeepSeek Harness could not start',
  startupMissingRuntimeDetail:
    'The bundled runtime is missing. Reinstall the application, or run "npm run stage" in a development checkout.',
  restartFailedTitle: 'Restart failed',
  rollbackTitle: 'Runtime update rolled back',
  rollbackMessage:
    'The updated agent runtime did not start, so the bundled version was restored.',
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
  itemShellVersion: '应用外壳',
  itemUpdateAvailable: '有新版本',
  itemUpToDate: '已是最新',
  itemOpenReleases: '打开发布页面',

  updateWindowTitle: '更新',
  updateChecking: '正在检查…',
  updateSectionRuntime: '智能体运行时',
  updateSectionShell: '应用外壳',
  updateStateLatest: '已是最新',
  updateStateAvailable: '有可用更新',
  updateStateUnknown: '无法检查',
  updateLatestLabel: '最新',
  updateDetailLabel: '详情',
  updateButtonClose: '关闭',
  updateButtonRuntime: '更新运行时并重启',
  updateButtonShell: '下载并安装',
  updateShellUnavailable: '外壳自动更新需要已发布且带更新元数据的版本。',
  updateShellProgress: '正在下载… {percent}%',
  updateButtonDownloading: '下载中 {percent}%…',
  updateShellFailedTitle: '外壳更新失败',
  updateShellReadyTitle: '外壳更新已就绪',
  updateShellReadyDetail: '新版本已下载完成，重启后生效。',
  updateShellRestartNow: '立即重启',
  updateShellRestartLater: '稍后',
  updateRuntimeLatestLabel: '该通道最新版本',
  updateShellLatestLabel: '最新已发布版本',

  splashTitle: 'DeepSeek Harness',
  splashHint: '正在启动智能体运行时，首次启动可能需要十几秒…',
  splashUnpacking: '正在解包内置运行时… {percent}%',

  titlebarBack: '返回',
  titlebarForward: '前进',

  itemOpenFolder: '打开文件夹…',
  itemOpenRecent: '最近打开',
  itemNoRecent: '暂无最近打开的项目',
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
  projectRuntimeDownloaded: '已下载的更新（位于本应用数据目录）',
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
  trayCheckUpdates: '检查运行时更新…',
  trayQuit: '退出',

  updateCheckFailedTitle: '无法检查更新',
  updateCheckFailedDetail:
    '应用需要访问 npm 源查询 @deepseek-ai/dsh。请检查网络或代理设置后重试。',
  updateUpToDateTitle: '智能体运行时已是最新版本',
  updateInstalledLabel: '已安装版本',
  updateNewestLabel: '最新可用版本',
  updateRuntimeSourceLabel: '运行时来源',
  updateLocationLabel: '安装位置',
  updateRegistryLabel: '所用源',
  updateSourceBundled: '随应用内置',
  updateSourceDownloaded: '已下载的更新（位于本应用数据目录）',
  updateAvailableTitle: '有可用的智能体运行时 {version}',
  updateAvailableLabel: '可用版本',
  updateChannelLabel: '通道',
  updateAvailableDetail:
    '新运行时会下载到本应用的数据目录，重启后生效。若启动失败，将自动回退到内置版本。',
  updateButtonInstall: '下载并重启',
  updateButtonLater: '稍后',
  updateNoNpmTitle: '无法安装更新',
  updateNoNpmDetail: '在应用包中未找到 npm，无法下载更新。',
  updateProgressTitle: '正在更新智能体运行时',
  updateProgressStarting: '正在准备',
  updateFailedTitle: '更新失败',
  updateFailedUnknown: '未知错误',

  startupFailedTitle: 'DeepSeek Harness 无法启动',
  startupMissingRuntimeDetail:
    '未找到内置的运行时。请重新安装应用，或在开发环境中执行 “npm run stage”。',
  restartFailedTitle: '重启失败',
  rollbackTitle: '已回退运行时更新',
  rollbackMessage: '更新后的智能体运行时未能启动，已自动恢复为内置版本。',
  rollbackDetailIntro: '',
  buttonOk: '确定',
}

/** Language tag used before `app` is ready; the system locale is unavailable then. */
const FALLBACK_LANGUAGE = 'en'

/** All shipped languages, keyed by a lowercase language subtag. */
const CATALOG: Record<string, ShellStrings> = {
  en,
  zh,
}

let current: ShellStrings | undefined

/**
 * Pick the language for a locale string.
 *
 * Matches on the primary subtag so `zh-CN`, `zh-Hans-CN`, and `zh-TW` all resolve
 * to the Chinese catalog — the harness UI itself does not distinguish them either.
 *
 * @param locale - a BCP-47 locale such as `zh-CN`; may be empty or undefined.
 * @returns the matching catalog, or English.
 */
export function catalogFor(locale: string | undefined): ShellStrings {
  if (locale === undefined || locale === '') return en
  const primary = locale.toLowerCase().split(/[-_]/u)[0] ?? ''
  return CATALOG[primary] ?? en
}

/**
 * Resolve the shell's strings from the operating system language.
 *
 * Must be called after `app.whenReady()`, because `getPreferredSystemLanguages()`
 * and `getLocale()` are only populated then.
 *
 * @returns the active catalog.
 */
export function initShellStrings(): ShellStrings {
  const preferred = app.getPreferredSystemLanguages()
  const locale = preferred.length > 0 ? preferred[0] : app.getLocale()
  current = catalogFor(locale ?? FALLBACK_LANGUAGE)
  return current
}

/**
 * The active catalog.
 *
 * Falls back to English when read before {@link initShellStrings}, so a string
 * lookup can never throw during early startup.
 */
export function t(): ShellStrings {
  return current ?? en
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
