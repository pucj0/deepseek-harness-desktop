// shell-bridge 的客户端半边：把「Harness 当前项目」与「Harness 当前语言」上报给 Electron 外壳。
//
// 要解决的问题（BUG B）：外壳里那个 `const workspace = resolveWorkspace(process.argv, …)`
// 是**启动时**算出来的常量，而用户可以在 Harness UI 里随时切换当前项目——每个会话属于一个
// 工作区，点一下侧栏里的另一个项目就换了。两者一旦不一致：
//
//     Harness 当前项目 = B
//     文件 → 项目信息 / 在文件管理器中打开工作区 / 复制工作区路径 = A   ← 错
//
// 同一个形状的问题还有一个：**语言**。外壳冷启动只能读
// `<harness home>/settings.yaml` 里的 `locale.preference`，而"用户从未选过语言"（Harness
// 用的是从浏览器语言推导的 provisional 值）或"语言由语言包注册"时，那份文件给不出答案，
// 于是 Harness 界面已经是中文、外壳菜单却是英文。运行期的**生效语言**只有 Harness 自己
// 知道，因此也由这里上报（见下面 `ctx.inject(['locale'])` 那段）。
//
// ## 为什么必须由渲染进程上报，而不是外壳自己去猜
//
// 「当前项目」是**客户端状态**：`ctx.sessions.list` 的 `current` 是用户在界面上打开的会话，
// 它既不在 URL 里（Harness 不做路由），也不在服务端（服务端只知道每个会话的 cwd）。
// 所以外壳只有两条路：读界面（侧栏文字 / 页面标题 / MutationObserver —— 需求明确禁止，
// 而且换个语言或改个样式就失效），或者由这个插件把真正的状态送出来。
//
// 这里用的是**官方数据源**：`ctx.sessions.list` 是官方 `useSessions` 标准钩子背后那个
// store，`state.current → state.byId[current].cwd` 正是官方会话面板判定"当前项目"的依据。
// 不解析 DOM、不猜文字。
//
// ## 送出去的东西必须由外壳再校验一遍
//
// 上报的路径是**渲染进程的输入**，因此外壳侧还要验类型、绝对路径、目录是否存在、以及
// 是否已经是 Harness 注册表里的工作区（见 src/main/window.ts / active-workspace.ts）。
// 这里同时带上工作区 id，外壳可以据此交叉核对"id 对应的路径 == 上报的路径"，比只看路径
// 更强。本插件不做任何写操作，也不碰 `window` 上除这一个上报函数之外的东西。
window.__ModuleLoader__.load({
  id: 'dsh-client-ui-shell-bridge',
  factory: () => {
    var module = { exports: {} }
    var exports = module.exports

    /** 插件名。 */
    const name = 'dsh-client-ui-shell-bridge'

    /**
     * 官方工作区 id 与实时目录路径。
     *
     * `ctx.workspaces.list` 是官方工作区 store（`useWorkspaces` 背后那一份），
     * `items[].workspaceId` / `items[].path` 就是注册表投影。
     * @param workspaces - `ctx.workspaces`（可能尚未就绪）。
     * @returns `{ path, workspaceId }`；没有可用工作区时 path 为 undefined。
     */
    const readWorkspaces = (workspaces) => {
      try {
        const state = workspaces?.list?.getSnapshot?.()
        const items = Array.isArray(state?.items) ? state.items : []
        return items
      } catch {
        return []
      }
    }

    /**
     * 当前会话所属的工作区。
     *
     * 只认 `current`（用户在界面上打开的那个会话），**不**退化成"最近一个会话"——那样
     * 用户切回一个更早的、属于别的项目的对话时，外壳会停在上一个新会话的项目上。
     * @param sessions - `ctx.sessions`。
     * @returns `{ path, workspaceId }`，或 `{ path: undefined }`。
     */
    const readActive = (sessions, workspaces) => {
      let state
      try {
        state = sessions?.list?.getSnapshot?.()
      } catch {
        state = undefined
      }
      const current = state?.current
      const cwd = current === undefined || current === null ? undefined : state?.byId?.[current]?.cwd
      const path = typeof cwd === 'string' && cwd !== '' ? cwd : undefined
      // 工作区 id 只是**附加**的交叉核对信息：路径才是权威，且只有路径会被外壳拿去用。
      let workspaceId
      if (path !== undefined) {
        const match = readWorkspaces(workspaces).find((item) => item?.path === path)
        if (match !== undefined && typeof match.workspaceId === 'string') workspaceId = match.workspaceId
      }
      return { path, workspaceId }
    }

    /**
     * 官方 locale runtime 里**当前生效**的语言 id。
     *
     * 用的是官方数据源：`ctx.locale.getLocale().active`（`@deepseek-ai/dsh-client-locale`
     * 的 LocaleRuntime 快照，界面文案就是按它查字典的）。刻意**不**读
     * `document.documentElement.lang`、更不读页面文字——前者不是官方写入的保证，后者换个
     * 语言或改一次样式就失效（与"当前项目"同一个理由，见文件头）。
     *
     * @param locale - `ctx.locale`（可能尚未就绪）。
     * @returns 语言 id；读不到或形状不对时 undefined。
     */
    const readLocale = (locale) => {
      try {
        const active = locale?.getLocale?.()?.active
        return typeof active === 'string' && active !== '' ? active : undefined
      } catch {
        return undefined
      }
    }

    /**
     * 挂载插件。
     * @param ctx - 客户端 cordis 上下文。
     */
    function apply(ctx) {
      /** 上一次上报的内容，用来去重（store 一次变更常常通知多次）。 */
      let last = '\u0000'

      /** 读一次当前项目并上报（未变化时不发）。 */
      const report = () => {
        const sessions = ctx.get('sessions')
        const workspaces = ctx.get('workspaces')
        const active = readActive(sessions, workspaces)
        const payload = {
          // null 而不是省略：语义是"Harness 此刻没有当前会话"，外壳据此保持上一个已知值。
          path: active.path ?? null,
          ...(active.workspaceId === undefined ? {} : { workspaceId: active.workspaceId }),
        }
        const fingerprint = JSON.stringify(payload)
        if (fingerprint === last) return
        last = fingerprint
        try {
          const api = typeof window === 'undefined' ? undefined : window.dshDesktop
          if (api !== undefined && typeof api.reportActiveWorkspace === 'function') {
            api.reportActiveWorkspace(payload)
          }
        } catch {
          // 上报是尽力而为：外壳拿不到时会退回启动时的工作区，界面不该因此受影响。
        }
      }

      // 会话变化（切换 / 新建 / 关闭对话）与工作区变化（添加 / 移除工作区）都要重新上报：
      // 后者让外壳能在"当前工作区刚刚被移除"时立刻对账，而不是等到下一次启动。
      for (const service of ['sessions', 'workspaces']) {
        ctx.inject([service], (scoped) => {
          const store = scoped.get(service)?.list
          if (store === undefined || typeof store.subscribe !== 'function') return
          scoped.effect(() => {
            const unsubscribe = store.subscribe(report)
            report()
            return unsubscribe
          }, `shell-bridge: ${service} list`)
        })
      }

      /**
       * 语言上报：把 Harness 的**生效语言**送给外壳，外壳据此对齐菜单/托盘/标题栏。
       *
       * 为什么必须有这一条：外壳冷启动只能读 `<harness home>/settings.yaml` 的
       * `locale.preference`，而那份文件在"用户从没选过语言"（Harness 用的是从浏览器语言推导
       * 的 provisional 值）或"语言由语言包注册"时给不出答案。这就是"Harness 界面已经是中文、
       * 外壳菜单却是英文"的来源——文件里没有值，外壳只能回退系统语言。
       *
       * 订阅的是官方 locale runtime（`subscribe` 在切换语言与注册字典时都会通知），因此
       * `zh → en` / `en → zh` 会立刻上报；重复的报同一值是空操作（外壳侧也会去重）。
       */
      ctx.inject(['locale'], (scoped) => {
        const locale = scoped.get('locale')
        if (locale === undefined || typeof locale.subscribe !== 'function') return
        /** 上一次上报的语言：store 的通知很密，重复值不发。 */
        let lastLocale = ''
        const reportLocale = () => {
          const active = readLocale(locale)
          if (active === undefined || active === lastLocale) return
          lastLocale = active
          try {
            const api = typeof window === 'undefined' ? undefined : window.dshDesktop
            if (api !== undefined && typeof api.reportLocale === 'function') api.reportLocale(active)
          } catch {
            // 同上：上报是尽力而为，外壳读不到时按下一次变化或下一次启动收敛。
          }
        }
        scoped.effect(() => {
          const unsubscribe = locale.subscribe(reportLocale)
          reportLocale()
          return unsubscribe
        }, 'shell-bridge: locale')
      })
    }

    exports.name = name
    exports.apply = apply

    return module.exports
  },
})
