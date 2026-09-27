/**
 * 「文件」菜单里与工作区有关的动作。
 *
 * ## 这一层为什么从 index.ts 里搬出来
 *
 * 搬出来只为一个理由：**它必须能被回归测试直接驱动**。需求里最容易悄悄退回旧行为的
 * 地方就是这几个菜单项——它们的实现一旦写成
 *
 * ```ts
 * projectInfo: () => showProjectInfo({ workspace, ... })   // workspace = 启动时的常量
 * revealWorkspace: () => shell.openPath(workspace)
 * copyWorkspacePath: () => clipboard.writeText(workspace)
 * ```
 *
 * 就会重新变成 BUG B（Harness 切了项目，菜单还在动旧目录）。因此这里：
 *
 *   * 所有"当前工作区"都**在点击那一刻**读 `active.get()`，绝不闭包捕获路径；
 *   * Electron 的三件事（目录选择器、确认框、打开/复制/提示）全部**注入**，
 *     于是脚本可以在没有图形环境的情况下把每个菜单项点一遍并断言它拿到了谁。
 *
 * ## 「最近打开」与「移除工作区」是两件事
 *
 *     从最近项目中移除  → 只删 Desktop settings 的 `recent`
 *     移除工作区        → 只删 Harness 注册表里的登记（文件与提交全留着）
 *     删除目录          → 删磁盘文件（本应用从不做）
 *
 * 三者各有各的入口，绝不互相触发：`removeRecent()` 不会 unregister，`forgetWorkspace()`
 * 不会动 `recent`。
 */
import type { RecentEntry } from './menu'
import type { ShellStrings } from './i18n'
import type { ActiveWorkspaceController } from './active-workspace'
import { readSettings, removeFromRecent, writeSettings } from './settings'
import { pruneRecent, recentLabels } from './workspace'
import { pickFolderToOpen } from './workspace-switch'

/** 需要 Electron 才能做的几件事（注入，便于离线测试）。 */
export interface WorkspaceActionEffects {
  /** 弹出原生目录选择器；用户关闭时返回 undefined。 */
  pickDirectory: () => string | undefined
  /** 切换前的确认框：返回用户是否确认。 */
  confirmSwitch: (candidate: string) => boolean
  /** 移除工作区前的确认框：返回用户是否确认。 */
  confirmForget: (candidate: string) => boolean
  /** 在系统文件管理器里打开一个路径。 */
  revealPath: (path: string) => void
  /** 把文本写进剪贴板。 */
  copyText: (text: string) => void
  /** 弹一个信息/警告框。 */
  alert: (message: { type: 'info' | 'warning'; title: string; detail: string }) => void
  /** 「最近打开」的数据变了：重建菜单（菜单是静态构建的）。 */
  refreshRecent: () => void
}

/** 「文件」菜单用到的工作区动作集合。 */
export interface WorkspaceActions {
  /** 「最近打开」子菜单的数据。 */
  recent: RecentEntry[]
  openFolder: () => void
  openRecent: (path: string) => void
  removeRecent: (path: string) => void
  projectInfo: () => void
  revealWorkspace: () => void
  copyWorkspacePath: () => void
  forgetWorkspace: (path?: string) => void
}

/** 构造动作所需的依赖。 */
export interface WorkspaceActionsDeps {
  /** 运行期 active workspace 的唯一权威。 */
  active: ActiveWorkspaceController
  userDataDir: string
  strings: ShellStrings
  effects: WorkspaceActionEffects
  /** 真正的"切换到新工作区"（写意图 + 重启应用）。 */
  onSwitchWorkspace: (dir: string) => void
  /** 真正的"从 Harness 注册表移除"（写意图 + 重启应用）。 */
  onForgetWorkspace: (dir: string) => void
  /** 打开项目信息面板（拿到的已经是**当前**工作区）。 */
  onProjectInfo: (workspace: string) => void
}

/** 「最近打开」的路径 + 显示文案。 */
function recentEntries(userDataDir: string): RecentEntry[] {
  const recent = pruneRecent(readSettings(userDataDir).recent)
  return recentLabels(recent).map((label, index) => ({ label, path: recent[index] ?? '' }))
}

/**
 * 一个目录现在还能用吗（存在且是目录）。
 *
 * 直接复用 `pruneRecent` 的判定，而不是在这里再写一遍 `existsSync` + `statSync`：
 * 「最近打开」的过滤与「当前工作区是否还在」必须是同一个判断，否则会出现"菜单里没了、
 * 但菜单项还愿意打开它"这种自相矛盾的状态。
 */
const usableDirectory = (dir: string): boolean => pruneRecent([dir]).length === 1

/**
 * 组装「文件」菜单的工作区动作。
 *
 * @param deps - 见 {@link WorkspaceActionsDeps}。
 * @returns 可交给 `applicationMenuTemplate` 的动作集合。
 */
export function createWorkspaceActions(deps: WorkspaceActionsDeps): WorkspaceActions {
  const { active, userDataDir, effects, strings: s } = deps

  /** 点击时发现当前工作区已经不存在：对账 + 提示 + 重建菜单，绝不静默失败。 */
  const guardCurrent = (): boolean => {
    const current = active.get()
    if (usableDirectory(current)) return true
    active.reportMissing(current)
    effects.refreshRecent()
    effects.alert({
      type: 'warning',
      title: s.workspaceMissingTitle,
      detail: `${current}\n\n${s.workspaceMissingDetail}`,
    })
    return false
  }

  return {
    recent: recentEntries(userDataDir),

    openFolder: (): void => {
      // 关闭选择器、确认框里取消、以及"选中的就是当前目录"都在这里被挡掉：三种情况
      // 都不该改设置、不该写标记、更不该重启。判定本身在 workspace-switch.ts，
      // 因此可以被回归测试直接跑（那里的对话框是注入的）。
      const dir = pickFolderToOpen({
        // **点击时**读当前值：Harness 里切过项目之后，"选中的就是当前目录"必须按新值判。
        currentWorkspace: active.get(),
        showOpenDialog: () => effects.pickDirectory(),
        confirm: (candidate) => effects.confirmSwitch(candidate),
      })
      if (dir === undefined) return
      deps.onSwitchWorkspace(dir)
    },

    openRecent: (dir: string): void => {
      // 菜单是**构建时**的快照：用户完全可能在这之后把目录删掉（需求 17：不能
      // "菜单启动时存在 → 用户后来删除 → 点击 → 重启到不存在路径"）。因此点击时
      // 再验一次，并把这次对账真正落盘（prune + persist）。
      if (dir === '' || !usableDirectory(dir)) {
        if (dir !== '') {
          writeSettings(userDataDir, { recent: pruneRecent(readSettings(userDataDir).recent) })
          effects.refreshRecent()
          effects.alert({
            type: 'warning',
            title: s.workspaceMissingTitle,
            detail: `${dir}\n\n${s.workspaceMissingDetail}`,
          })
        }
        return
      }
      // 空条目与"已经是当前工作区"都由 restartIntoWorkspace 挡掉（同一个判定，
      // 因此这里不需要再写一遍）。
      deps.onSwitchWorkspace(dir)
    },

    removeRecent: (dir: string): void => {
      // 只删 Desktop 的 recent 记录。**不**碰 Harness 注册表，**更**不碰磁盘目录：
      // 用户以后仍然可以在「打开文件夹」里重新打开它。
      removeFromRecent(userDataDir, dir)
      effects.refreshRecent()
    },

    projectInfo: (): void => {
      // 需求 14 的直接落点：必须读 active.get()，不能捕获启动时那个常量。
      const current = active.get()
      if (!guardCurrent()) return
      deps.onProjectInfo(current)
    },

    revealWorkspace: (): void => {
      const current = active.get()
      if (!guardCurrent()) return
      effects.revealPath(current)
    },

    copyWorkspacePath: (): void => {
      const current = active.get()
      if (!guardCurrent()) return
      effects.copyText(current)
      effects.alert({
        type: 'info',
        title: s.copiedPathTitle,
        detail: `${current}\n\n${s.copiedPathMessage}`,
      })
    },

    forgetWorkspace: (path?: string): void => {
      // 目标是当前工作区时，`onForgetWorkspace` 那侧会先把下一次启动的工作区换成
      // 另一个仍然有效的目录（注册表里最近的，或主目录），再移除——绝不会留下
      // "active 指着已移除工作区"的半失效状态。
      const target = path ?? active.get()
      if (target === '') return
      if (!effects.confirmForget(target)) return
      deps.onForgetWorkspace(target)
    },
  }
}
