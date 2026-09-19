# dsh-desktop · DeepSeek Harness 桌面客户端

**中文（当前）| [English documentation](README.en.md)**

把 **DeepSeek Harness（`dsh`）** 做成一个装完即用的桌面应用。

终端用户**不需要安装 Node.js，也不需要 npm**：装好打开就能用完整功能。官方 Web UI 被原样复用，因此 `dsh web` 提供的一切——工具、沙箱、会话、后台任务、子代理、工作流、技能、MCP——都在这里。桌面外壳在此之上补齐只有原生应用才能提供的能力：真正的窗口与菜单、关闭后仍在运行的托盘、系统密钥链存储凭据、跳过补丁号以外的自动更新，以及若干官方发行形态未包含的项目级操作。

[![release](https://img.shields.io/badge/release-GitHub%20Releases-blue)](../../releases)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#下载安装)

---

## 目录

- [这是什么](#这是什么)
- [与官方发行形态的差异](#与官方发行形态的差异)
- [下载安装](#下载安装)
- [界面与用法](#界面与用法)
- [架构](#架构)
- [更新机制](#更新机制)
- [凭据存储](#凭据存储)
- [二次开发](#二次开发)
- [打包与发布](#打包与发布)
- [项目结构](#项目结构)
- [已知限制](#已知限制)
- [故障排查](#故障排查)
- [许可证](#许可证)

---

## 这是什么

`dsh` 官方以 npm 包的形式发行，使用方式是：

```bash
npm install -g @deepseek-ai/dsh
dsh web          # 然后在浏览器里打开它打印的地址
```

这对开发者很自然，但对"只想用这个工具"的人有三道门槛：先要有 Node 环境、要会用 npm、还要自己记住启动命令并管理一个常驻的浏览器标签页。

本项目把这三道门槛一次性去掉。它做两件事：

1. **内置整个运行时。** 官方 `dsh`、它完整的依赖树、以及一个固定版本的便携 Node，全部随安装包携带。用户的机器上可以完全没有 Node 与 npm。
2. **提供原生外壳。** 用 Electron 承载官方 Web UI，补上窗口、菜单、托盘、原生目录选择器、系统密钥链、自动更新等桌面应用应有的部分。

**不 fork `dsh`，不改写已安装的运行时包。** 外壳通过 `dsh` 的公开 API 启动它。针对已验证的客户端模块实现，外壳在进程内缓存重复生成的脚本与 source map；适配器校验完整源码摘要，运行时升级后不匹配就自动使用官方原实现。

> `dsh` 把 profile 名 `desktop` 预留给了 Electron 应用（`dsh/lib/bin.js` 明确拒绝 `dsh --profile desktop`），因此本项目正是该 profile 的预期拥有者，而不是"占用"了它。

### 主要优点

| 优点 | 具体表现 |
|---|---|
| **零环境依赖** | 内置 Node 24 与完整 `dsh` 运行时，用户无需安装或配置任何东西 |
| **官方 UI 原样复用** | 不是重做的界面，就是官方 Web UI 本身，功能与观感一致 |
| **不做 fork** | 通过公开 API 使用 `dsh`，升级无合并负担，行为可预期 |
| **双轨更新** | 智能体运行时与外壳各自独立更新，互不牵连 |
| **凭据进系统密钥链** | 不落明文，与命令行 `dsh` 的安装完全隔离、可共存 |
| **一次安装，三平台可用** | Windows（NSIS）、macOS（dmg）、Linux（AppImage / deb） |

---

## 与官方发行形态的差异

以下能力**不在官方 npm 发行形态内**，由本项目的桌面外壳提供。列入此表是为了让你清楚"换了什么"，而不是声称官方有何欠缺。

### 环境与安装

| 能力 | 官方（npm） | 本项目 |
|---|---|---|
| 需要预装 Node.js | 需要 | **不需要** |
| 需要 npm | 需要 | **不需要**（更新用内置的那份 npm） |
| 安装方式 | `npm install -g` | 安装包，图形化安装向导 |
| 安装界面语言 | — | **简体中文**（Windows NSIS） |
| 卸载 | 手动 `npm uninstall` | 系统「应用和功能」中正常卸载 |

### 桌面集成

| 能力 | 官方（npm） | 本项目 |
|---|---|---|
| 独立窗口 | 浏览器标签页 | 原生窗口，带菜单栏与标题栏 |
| **窗口标题显示 Git 分支** | 无 | 显示当前分支、未提交标记、领先/落后 |
| **托盘常驻** | 无 | 关窗后继续运行，托盘可唤回、重启服务端、检查更新 |
| 原生目录选择器 | 无 | 「打开文件夹」使用系统对话框 |
| **菜单栏** | 无 | 文件 / 编辑 / 视图 / 更新 / 帮助 |
| 全屏、缩放 | 浏览器负责 | 原生菜单项，带快捷键 |
| 单实例 | 无（多个 `dsh web` 会占多个端口） | 第二次启动聚焦已有窗口 |

### 项目级操作（官方发行形态未包含）

这些是日常使用中"总得切出去做一下"的事，被收进了外壳：

| 能力 | 说明 |
|---|---|
| **打开文件夹 / 切换项目** | 原生目录选择器选新工作区，自动重启到该工作区；最近打开列表（最多 8 条，自动过滤已删除的目录） |
| **在文件管理器中打开工作区** | 不必手抄路径 |
| **复制工作区路径** | 一键进剪贴板，直接粘到终端 |
| **项目信息面板** | 工作区路径、Git 分支与改动数、运行时版本与来源、内置 Node 与 Electron 版本、Harness 主目录 |
| **本轮修改审查** | 一轮任务结束后可查看该轮改动的全部文件与统一差异 |
| **分支徽章与切换** | 输入框上方显示当前分支与本轮修改入口，长分支名自动省略，点击可切换到本地或远程分支 |

### 更新

| 能力 | 官方（npm） | 本项目 |
|---|---|---|
| 更新智能体运行时 | `npm update -g` | 应用内「更新」界面，一键完成并重启 |
| 跟随发布通道 | 自行指定 dist-tag | 可配置 `latest` / `next` / `alpha` |
| **更新应用外壳本身** | 不适用 | 内置自动更新（`electron-updater`） |
| 更新失败处理 | 自行排查 | 新运行时启动失败时自动回退到内置版本并重启 |

### 界面语言

外壳自有的一切（菜单、托盘、对话框、插件文案）**跟随系统语言**，提供中文与英文两套。

---

## 下载安装

到 [Releases](../../releases) 下载对应平台的文件。

| 平台 | 文件 | 说明 |
|---|---|---|
| **Windows** | `dsh-desktop-x64.exe` | NSIS 安装程序，可选安装目录，**中文界面** |
| **Linux** | `dsh-desktop-x86_64.AppImage` | 免安装，`chmod +x` 后直接运行 |
| **Linux** | `dsh-desktop-amd64.deb` | Debian / Ubuntu |
| **macOS** | `dsh-desktop-x64.dmg` | Intel 芯片 |
| **macOS** | `dsh-desktop-arm64.dmg` | Apple 芯片（M 系列） |

文件名里不带版本号，版本体现在 Release 标签上。

### Windows 首次运行会被 SmartScreen 拦截

双击安装包时，Windows 会弹出蓝色的「Windows 已保护你的电脑」，提示**发布者未知**：

> Microsoft Defender SmartScreen 阻止了无法识别的应用启动。

**这是预期行为，不是安装包损坏或被篡改。** 原因是产物**没有代码签名证书**——Windows 对「从网络下载、没有可信签名、且积累的下载声誉不足」的程序一律这样提示，`.exe` 与 `.msi` 都一样。

处理方式：点 **「更多信息」→「仍要运行」**。

> 「更多信息」这几个字在弹窗里很小，容易被忽略；不展开它就不会出现「仍要运行」。

**只有购买代码签名证书能彻底去掉这个提示。** 用 OV 或 EV 证书签名后：EV 证书即时生效；OV 证书虽仍需积累声誉，但不再显示"发布者未知"。

> 这一点与 macOS 不同：macOS 的 Gatekeeper 只需手动放行一次（见下），之后不再提示；而 Windows 的 SmartScreen 对**每个新版本**都会重新提示——它按文件哈希与签名证书评估声誉，**仅靠时间推移不会让它消失**。

有证书时把它配成仓库 Secret，CI 会自动签名；没有证书时 CI 会跳过（日志里可见 `no signing info identified, signing is skipped`）。

### macOS 首次打开

macOS 产物**未签名**（发布流程未配置 Apple 开发者证书），Gatekeeper 会拦截。首次打开请：

**右键点击应用 → 打开 → 在弹窗里再次点「打开」**

之后就能正常双击启动了。如果提示「已损坏」，执行一次：

```bash
xattr -dr com.apple.quarantine "/Applications/DeepSeek Harness.app"
```

### 首次启动

首次启动会**解压内置运行时**（约 197 MB / 10 000 个文件），耗时取决于磁盘性能，启动页会显示进度。解包使用有并发上限的异步写入，进度只更新文字、不重载页面。新归档按内容摘要复用，安装或更新造成的时间戳变化不会让相同运行时重新解包；已有独立更新的运行时可用时，也不会预先解包内置备份。旧归档仍兼容原来的缓存判断。

启动优化回归测试：`npm run test:startup`。速度对照可运行 `npm run benchmark:startup -- --archive=<runtime.br路径> --baseline=<优化前提交>`，交叉测量首次解包、重复启动和归档仅时间戳变化三种情形。该测试统计解包至服务端就绪，不包含 Electron 和浏览器渲染时间。

应用会引导你填入 **API Key**。填入后即可开始使用。凭据用操作系统密钥链加密后存在本应用自己的数据目录里，**不会**写进明文的 `.credentials.yaml`。

### 安装界面语言

安装界面的语言按平台能力区分，不是统一的：

| 平台 | 安装界面 | 语言 |
|---|---|---|
| Windows `setup.exe` | NSIS 安装向导 | **简体中文** |
| Linux `.deb` / AppImage | 无界面，`dpkg -i` / 直接运行 | 不适用 |
| macOS `.dmg` | 无界面，拖拽到「应用程序」 | 不适用 |

**只有 Windows 的 NSIS 安装程序有可本地化的安装向导**，它已固定为简体中文，由 `electron-builder.yml` 的两个选项控制：

```yaml
nsis:
  language: 2052               # LCID 十进制，不是语言名
  installerLanguages: [zh_CN]  # 语言名，映射到 NSIS 自带的 SimpChinese
```

> Windows 的 `.msi` **不再随 Release 发布**。它的安装界面只有英文——MsiTarget 不提供语言选项，其拉取的 WiX 工具链只含 `WixUIExtension.dll`、不含本地化 `.wxl` 文件；且构建需要很短的路径根（WiX 受 `MAX_PATH` 限制）。目标本身仍保留，需要时可在本地出：`npx electron-builder --win msi --x64`。

> 这是**安装程序**的语言；安装后的应用界面跟随系统语言（中英文），由 `src/main/i18n.ts` 控制。

---

## 界面与用法

### 顶部菜单

| 菜单 | 内容 |
|---|---|
| 文件 | **打开文件夹…**（`Ctrl+O`）、**最近打开**、**项目信息…**（`Ctrl+I`）、在文件管理器中打开工作区、复制工作区路径、重新加载、强制重新加载、开发者工具、退出 |
| 编辑 | 撤销 / 重做 / 剪切 / 复制 / 粘贴 / 全选 |
| 视图 | 缩放、全屏 |
| **更新** | **检查更新…**（`Ctrl+Shift+U`） |
| 帮助 | 检查更新…、打开发布页面、当前版本号 |

菜单栏**刻意不自动隐藏**：它是用户唯一能主动让应用变新的入口。

### 切换项目（工作区）

**文件 → 打开文件夹…**（`Ctrl+O`）选一个目录，即可把它作为新工作区打开；也可以用 **文件 → 最近打开** 快速切回之前的项目。

**切换工作区会重启应用**，这是刻意的取舍：工作区是在服务端启动时传入的，中途更换需要重建整棵插件树（约 11 秒），而重启走的是同一条已验证的启动路径，不存在"半个进程还在用旧工作区"的中间态。会话已持久化，重启后可继续之前的对话。

> 修复过的一个缺陷：`app.relaunch()` 会沿用原来的命令行，导致重启后**旧工作区把新选择盖掉**——表现为"重启了但还是老目录"。现在切换意图通过一个一次性标记文件传递，优先级高于命令行参数。

### 项目信息与 Git 分支

**文件 → 项目信息…**（`Ctrl+I`），或托盘的「项目信息…」，会打开一个只读面板，显示：

- **Git 分支**，含未提交改动条数与相对上游的领先 / 落后（`master*  ↑2 ↓1`）
- 工作区路径
- 智能体运行时版本，以及它来自**内置**还是**已下载的更新**
- 内置 Node 与 Electron 版本
- Harness 主目录与应用数据目录

当前工作区的分支还会显示在**窗口标题栏**上，例如 `DeepSeek Harness — master*`。

### 输入框上方的工具条

输入框**上方**有一整行工具条，由两个内置插件共用：**左侧是分支徽章，右侧是本轮改动入口**。它和输入卡片视觉上连成一体——背景延伸到卡片后面、圆角也用同一个 22px，所以交接处不会露出底色。分支名过长时自动省略。

> 这两个入口原先挤在输入框工具栏的右侧（发送按钮左边），分支名一长就被压缩变形。之所以不能直接放到上方，是因为扩展点选错了：`conversation.composer.bar` 就是**输入框本体**——往那里注册会顶掉官方注册，表现为界面报 `Failed to load plugins`，甚至**输入框直接消失**。
>
> 现在改由 gitbar 在 `conversation.input.dock` 注册整行，并在其中提供一个会话级子槽 `dsh.desktop.composer.actions` 给审查插件，两个插件因此能平铺在同一排、互不挤压。

**分支徽章**（`dsh-client-ui-gitbar`）

- 显示当前分支、未提交改动数、领先/落后（`master*  ↑2 ↓1`）
- 点击展开分支切换菜单，菜单顶部是**搜索框**：打开即聚焦并清空，输入即时过滤
- 分支多时先显示「正在加载分支…」；搜索无结果时说「没有匹配的分支」，与「没有分支」区分开
- 列表**本地在前、远程在后**，远程条目标注「远程」，当前分支带对勾；切换远程分支时 git 会自动创建同名跟踪分支
- 菜单按视口高度自动决定向上还是向下弹出，宽度与位置都限制在窗口内；滚动只作用于结果列表，搜索框始终留在顶部
- 若工作区有未提交改动会被覆盖，git 会拒绝切换——此时**保持菜单打开并显示 git 的原始报错**，并给出「暂存改动并切换到 X」按钮（stash 是可恢复的，本插件不会替你丢弃改动）
- 点击菜单外部或按 `Esc` 关闭，`Esc` 之后焦点回到徽章按钮

**本轮改动审查**（`dsh-client-ui-review`）

- 显示本轮任务改动的文件数，点击在右侧栏打开审查面板
- **再点一次收起侧栏，第三次重新打开**；收起会保留标签与已展开的差异，便于来回对照
- 列出每个变更文件的状态（新增 / 修改 / 删除 / 重命名）与增删行数
- 逐文件展开统一差异，带增删行着色
- 基线的取法是关键：**一轮对话开始时**为工作区拍一张 git 快照，本轮改动相对它计算。因此即使你在本轮开始前就有未提交改动，那些也**不会**被算进本轮

两个入口都带无障碍标注（`aria-label`、`aria-expanded`、`aria-haspopup`），可用键盘操作并有可见的焦点环。

### 托盘

关闭窗口后应用驻留托盘，任务继续运行。托盘菜单提供：

- 显示主窗口
- 重启智能体运行时
- 检查更新
- 项目信息
- 退出

---

## 架构

```
Electron 主进程                                 dsh 服务端子进程
┌──────────────────────────────┐               ┌─────────────────────────────┐
│ 窗口 / 菜单 / 托盘            │               │ 官方 @deepseek-ai/dsh        │
│ 原生目录选择器                │               │ + dsh-base / dsh-web-app     │
│ 运行时解析与解包              │  spawn        │ + 本项目的三个内置插件        │
│ 运行时更新（npm）             │ ────────────► │   （外壳每次启动同步进去）    │
│ 内置插件同步（plugin-sync）   │               │                             │
│ 外壳更新（electron-updater）  │               │ 监听 127.0.0.1:<随机端口>     │
│ 凭据（系统密钥链）            │ ◄──────────── │ 打印 dsh web: <url>?token=   │
└──────────────────────────────┘   stdout      └─────────────────────────────┘
              │                                              │
              │  BrowserWindow.loadURL(<带 token 的 url>)    │
              └──────────────────────────────────────────────┘
                    官方 Web UI（在 Chromium 中运行）
```

### 认证握手

每个服务端进程生成一个随机启动 token。服务端**只**在 `GET /` 上接受它，用它换取一个绑定 authority 的签名 Cookie，然后重定向到干净的 `/`。因此窗口只加载一次带 token 的 URL，地址栏里永远不会留下凭据。不带 Cookie 直接请求 `/` 会返回 `401`——那是防护在正常工作。

### 运行时目录布局

```
resources/                     安装包释放，位于 app.asar 之外
  runtime.br                   压缩后的运行时归档（42.9 MB，brotli q11）
  runtime.json                 归档的文件数与体积，供诊断
  server/server.mjs            启动脚本（见 src/server/）
  plugins/                     随应用携带的客户端插件（约 164 KB），每次启动同步进当前运行时

<userData>/bundled-runtime/runtime/   首次启动从 runtime.br 解出（197 MB）
  node_modules/@deepseek-ai/dsh
  node/                        固定版本的便携 Node

app.asar
  dist/main/…                  编译后的外壳
  dist/preload/…
  node_modules/npm/            解包存放，使运行时更新无需系统 npm
```

**运行时是压缩携带、首次启动解压的**，不是以散文件形式装进安装目录。原因与实测数据：

| 形态 | 安装包 | 解包后磁盘 |
|---|---|---|
| 散文件（交给 NSIS 的 LZMA 压缩） | 149.2 MB | 278 MB |
| `runtime.br` 归档 | **124.2 MB** | 42.9 MB（归档）+ 首次解出的 197 MB |

归档方案安装包小 25 MB、且安装目录少占 235 MB，代价是首次启动多约 9 秒（加载页显示解包进度）。压缩流程见 `scripts/compress-runtime.mjs`：先剔除运行期用不到的文件（`.ts` 源文件、`.map`、`.d.ts`、`.md`、`.pdb` 调试符号、非本平台二进制、Node 自带的 npm），把 314 MB 瘦到 197 MB，再用 brotli q11 压到 42.9 MB。

> 不携带散文件是刻意的：`runtime.br` 已被 brotli 压满，NSIS 的 LZMA 对它几乎无效（实测再压只省 0.2%），所以两种形态只能二选一——对照实验的结论就是上表。

**解包位置在 `<userData>/bundled-runtime/` 而不是 `<userData>/runtime/`**：后者是运行时自动更新的地盘（它在那里管理 `<版本>/` 目录与 `current` 联接），放在旁边互不干扰。

`runtime/` **必须**在 `app.asar` 之外：harness 启动时会创建真实的目录联接（junction）、会 spawn 原生目录选择器等辅助进程、还会按路径加载原生插件——这些在 asar 虚拟文件系统里都不成立。同理，**解压出来的运行时也必须在 asar 之外**，这也是它落在 `<userData>` 的原因之一。

### 内置插件如何接线

三个插件（gitbar、review、typography）都是标准 `dsh` 插件，走**官方插件机制**，不是外壳 hack：

- 它们的 `package.json` 声明 `dsh.bundle.patch`（使其可作为 profile bundle 挂载）与 `dsh.client`（使其客户端半边进入模块图）
- `scripts/stage-runtime.mjs` 把它们复制进 `runtime/node_modules/`，`extraResources` 另外随应用带一份散文件到 `<resources>/plugins/`
- **应用每次启动时**由 `src/main/plugin-sync.ts` 把它们同步进**当前实际使用**的那个运行时的 `node_modules/`（详见下面的「为什么插件要每次启动同步」）
- `src/server/server.mjs` 把它们**链接进 profile 的 `node_modules`** 并**登记为 profile bundle**
- `dsh` 装载它们：host 半边注册 HTTP 路由，client 半边注册到界面槽位（见 [输入框上方的工具条](#输入框上方的工具条)）

#### 为什么插件要每次启动同步

插件不在 `dsh` 的依赖闭包里，只随本应用发布。而运行时可以在应用内被**整体替换**（新版 `dsh` 装进 `<userData>/runtime/<版本>/`）——换进来的那份里没有这些插件，`server.mjs` 又是「找不到就跳过」：

- `linkBundledPlugins` 静默 `continue`，`reconcileBundles` 随即把它们从 bundle 列表里摘掉；
- 结果**不是崩溃，而是三个插件一起从界面上消失**，控制台一句警告都没有。

`0.1.5-rc.2` 成为 npm 的 `latest` 后就真实发生过一次。因此外壳改为每次启动从自己携带的那份（`<resources>/plugins/`，开发期是仓库的 `plugins/`）同步进当前运行时，一次覆盖三种情形：**更新后自动补齐**、**已经装坏的运行时就地修好**、**外壳升级后刷新旧副本**。

同步只做文件拷贝

#### 写槽位插件时的一个坑：不要注入标准钩子

`useSessions` / `useWorkspaces` 不是服务成员，而是**渲染器按 root 作用域提供的标准钩子**：官方 `dsh-client-ui-session` 用 `slots.provideRoot({ hooks: { sessions } })` 提供 source，`dsh-client-ui-workspace` 同理提供 `workspaces`，渲染器按 `use${Capitalize<N>}` 把它们绑成 props 传给组件。

而渲染器合并 props 的顺序是 `{ ...kit, ...injected, ... }`——**`inject` 会盖掉 kit**，且不会剔除 `undefined`。因此在自己的 `inject` 里回传 `useSessions: ctx.sessions?.useSessions`（服务上并没有这个成员）等于用 `undefined` 遮蔽掉标准钩子：取值代码看着完全正确，运行时却永远拿不到值。

项目级面板踩过这个坑。它因此一直只能退到宿主给的 `process.cwd()`（外壳启动目录，常常是用户主目录），于是长期显示"当前工作区不是 git 仓库"，而用户实际在用的项目明明是 git 仓库。**结论：需要标准钩子时什么都别注入，让它原样送到。** 回归测试见 `scripts/test-review-overlay-hooks.mjs`。

同步只做文件拷贝、单个插件失败只记一条警告，不会阻断启动；内容一致时跳过不重写。

---

## 更新机制

刻意分成两条独立的轨道：

| 轨道 | 更新对象 | 方式 |
|---|---|---|
| **运行时** | `@deepseek-ai/dsh` 及其 bundle | 应用查询 npm registry，把新版本装进 `<userData>/runtime/<版本>/`，然后原子切换 `current` 目录联接 |
| **外壳** | 本 Electron 应用自身 | `electron-updater` 走 GitHub Releases |

分开的原因：`dsh` 迭代很快（`0.1.5-rc.1`、`rc.2`……）。把运行时混进安装包里，意味着每个补丁版本都要用户重装整个应用。

### 在哪里触发更新

两条轨道共用一个入口：**菜单栏 → 更新 → 检查更新…**（`Ctrl+Shift+U`），或托盘右键 →「检查更新…」。

窗口立刻打开并显示「正在检查」，两条检查**并行**进行、结果各自推送：

| 分节 | 展示内容 |
|---|---|
| **智能体运行时** | 已安装版本、该通道最新版本、运行时来源（内置 / 已下载）、所用源、通道、安装位置 |
| **应用外壳** | 已安装版本、最新已发布版本 |

> 启动时**不再**自动静默检查外壳更新。此前那会在启动后偷偷弹一个对话框，用户既不知道是谁触发的、也不知道何时检查的。

### 安全设计

新版本先装进临时目录，校验通过后再改名就位——下载中断不会留下一个"看起来能用"的运行时。如果更新后的运行时启动失败，应用会删掉 `current` 联接、回退到内置运行时、并重启。

`profiles/node_modules` 在每次启动时自动重建，所以切换运行时后**不需要任何重装步骤**。内置插件同样在每次启动时被同步进当前运行时——见 [为什么插件要每次启动同步](#为什么插件要每次启动同步)。

### 通道

运行时更新跟随 npm 的 dist-tag。默认走 `latest`，可在设置中改为 `next` 或 `alpha`。

默认 registry 是 `https://registry.npmmirror.com`（国内可达性更好），失败时回退到 `https://registry.npmjs.org`。

> `latest` 在镜像上**可能比 `next` 旧**。需要更新的版本时请显式把通道改为 `next`。

---

## 凭据存储

API Key 等凭据用 **Electron 的 `safeStorage`** 加密后存放在本应用的数据目录：

| 平台 | 底层机制 |
|---|---|
| Windows | DPAPI |
| macOS | Keychain |
| Linux | libsecret（缺失时无法加密，会明确告知） |

主进程解密后，把凭据**通过子进程的启动环境**传给 dsh——这排在 dsh 自己的凭据优先级最高位，因此不会与命令行 `dsh` 的存储互相干扰。

应用使用**独立的 Harness 主目录**（`<userData>/home`），与命令行 `dsh` 的 `~/.dsh` 完全分离：**两者可以同时使用，互不影响**。

---

## 二次开发

### 环境要求

| 项 | 版本 |
|---|---|
| Node.js | 22.13+ 或 24（构建机需要；最终用户不需要） |
| npm | 随 Node 提供 |
| 平台 | Windows / macOS / Linux 均可开发，但**打包受平台限制**（见下） |

首次构建需要联网：要下载 Electron、便携 Node 与 `@deepseek-ai/dsh`（合计约 700 MB），之后复用缓存。

### 起步

```bash
git clone https://github.com/pucj0/deepseek-harness-desktop.git
cd deepseek-harness-desktop
npm ci                # 安装依赖（postinstall 会链接运行时，此时尚无 runtime/ 属正常）
npm run stage         # 下载运行时 + 便携 Node + 压缩归档（首次约数分钟，含 11 分钟压缩）
npm run build         # 编译 TypeScript 到 dist/
npm start             # 启动（需已 stage）
```

### 开发期运行

```bash
npm run dev           # 同步本地插件、编译后启动
npm start             # 同步本地插件后直接启动（改完 TypeScript 需先 build）
npm run sync:plugins  # 单独把 plugins/ 更新到 runtime/node_modules/
```

开发启动会刷新随桌面端维护的插件副本，清除这些插件中已删除的旧文件，避免修改了 `plugins/` 却继续运行旧代码。同步使用本地文件，不会下载或升级官方运行时；首次运行仍需先完成 `npm run stage`。

Windows 上推荐用仓库自带的 `run-dev.bat`：它在**独立的可见窗口**里启动，便于看到 stdout/stderr，也避免被沙箱的 Job 对象回收。

```bat
run-dev.bat           独立窗口启动开发版
rebuild-and-install.bat   重新编译、打包并安装到本机（用于验证打包后的行为）
```

### 开发期状态隔离

`DSH_DESKTOP_HOME` 可把应用数据目录指向别处，从而与日常使用的实例完全隔离：

```bash
DSH_DESKTOP_HOME=./.dev-home npm start
```

**注意**：它**不改变单实例锁的作用域**——锁由 `app.getPath('userData')` 决定，在读取该变量之前就已确定。因此开发版与已安装版**不能同时运行**：同时启动时第二个会聚焦第一个的窗口后退出（表现为"静默退出、退出码 0"）。

### 可用的环境变量

| 变量 | 作用 |
|---|---|
| `DSH_DESKTOP_HOME` | 覆盖应用数据目录（开发期隔离、测试用） |
| `DSH_DESKTOP_TIMING=1` | 让服务端把各启动阶段耗时打到 stderr（定位"启动慢"用） |
| `DSH_DESKTOP_DISABLE_STARTUP_CACHE=1` | 禁用客户端产物缓存，供诊断和对照测试使用 |
| `DSH_DESKTOP_DUMP_MENU=1` | 打印应用菜单结构后退出（菜单改动的快速断言） |
| `DSH_DESKTOP_WORKSPACE` | 由外壳注入给插件，无需手工设置 |
| `DSH_HOME` | Harness 主目录（由外壳注入给插件） |

### 国内构建机的镜像配置

首次下载量大，建议设置镜像：

```bash
npm config set registry https://registry.npmmirror.com
set ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/
```

`scripts/build.mjs` 与 `build.bat` 会自动带上这些设置。

### 开发新插件

三个内置插件是本仓库最好的范例，照它们的结构新增一个即可：

```
plugins/dsh-client-ui-<名字>/
  package.json          # 声明 dsh.bundle.patch 与 dsh.client
  cordis.patch.yml      # 用 - insert: 挂载自己
  lib/index.js          # host 半边（可选，注册 HTTP 路由等）
  lib/client.js         # client 半边（注册界面）
```

四个必须注意的点（都是实际踩过的）：

1. **`cordis.patch.yml` 里新增行必须包在 `- insert:` 之下。** 写成顶层会被当作"按 id 覆盖既有行"，而该 id 不存在，于是既不报错也不生效。
2. **客户端半边的 `exports.inject` 必须声明 `['slots', 'locale']`。** 漏了会抛 `cannot get property "slots" without inject`，而且这个错误会让**整个界面白屏**，不只是你的插件。
3. **`package.json` 必须同时声明 `dsh.bundle.patch` 与 `dsh.client`**，否则 dsh 在装载阶段直接报错。
4. **先确认槽位的 `kind` 再往里注册。** `single` 槽（例如 `conversation.composer.bar`，它就是输入框本体）被第三方抢先注册会顶掉官方内容，表现为界面报 `Failed to load plugins` 或控件整个消失。要往那一排加东西，应当由别人的 `list`/`session` 槽提供一个子槽——本仓库的 `dsh.desktop.composer.actions` 就是这么来的。`scripts/list-slots.mjs` 与 `scripts/list-slot-kinds.mjs` 可以列出实际槽位及其种类。

新插件写好后，把它加进 `src/server/server.mjs` 的 `BUNDLED_PLUGINS` 数组，它就会在启动时自动链接进 profile 并登记为 bundle。

### 测试

```bash
npm run typecheck                  # 类型检查
node scripts/test-i18n.cjs         # 外壳中英文案键位对齐
node scripts/test-version.mjs      # 版本递增规则与节流
node scripts/check-imports.mjs     # 相对 import 目标存在（防"忘了提交文件"）
node scripts/check-version.mjs     # package.json / lock / packages[""] 三处版本一致
node scripts/test-unpack.mjs       # 运行时解包（含进度取值、归档完整性）
node scripts/test-gitbar-checkout.mjs    # 分支切换（一次性临时仓库）
node scripts/test-gitbar-workspace.mjs   # 插件按请求的工作区查询
node scripts/test-review-host.mjs        # 审查插件的快照与差异
node scripts/test-review-sidebar.mjs     # 审查侧栏链路：打开 / 收起 / 重新打开
node scripts/test-plugin-sync.mjs        # 内置插件同步进运行时（含"换掉运行时后补齐"）
node scripts/test-review-overlay-hooks.mjs   # 项目级入口：inject 不遮蔽标准钩子、工作区跟随当前会话
node scripts/check-plugin-i18n.mjs       # 插件里没有硬编码文案
```

> 其中 `test-review-sidebar.mjs`、`test-ui-typography.cjs` 这类会启动 Electron 并从 CDP 驱动界面的脚本，需要图形环境；在受限沙箱里 Electron 起不来，应放到本机桌面会话中运行。

> 会移动工作区状态的测试（分支切换、审查）一律使用**一次性临时仓库**——绝不能拿真实仓库当试验场。

### 诊断脚本

`scripts/` 下有大量诊断工具，都是为定位具体问题写的，可直接复用：

| 脚本 | 用途 |
|---|---|
| `probe-startup.mjs` | 启动各阶段耗时（定位"启动慢"） |
| `probe-boot-manifest.mjs` | 客户端插件是否进入模块图 |
| `cdp-errors.mjs` | 通过 CDP 读渲染进程控制台报错（白屏问题用） |
| `cdp-eval.mjs` / `cdp-read.mjs` | 在渲染进程里求值 / 读 DOM（比截图可靠） |
| `probe-installed-gitbar.mjs` | 扫本地端口，验证已安装实例的插件路由 |
| `doctor.mjs` | 只读诊断模块回退链接 |
| `ci-status.mjs` / `ci-tail.mjs` / `ci-grep.mjs` | 查 GitHub Actions 状态与日志 |

---

## 打包与发布

### 各平台的可构建性（已实测）

| 目标 | Windows 构建机 | Linux 构建机 | macOS 构建机 |
|---|---|---|---|
| Windows NSIS | ✅ | ❌ | ❌ |
| Linux AppImage / deb | ❌（需 `mksquashfs`、`fpm`） | ✅ | ❌ |
| macOS dmg | ❌（需 `hdiutil`、`codesign`） | ❌ | ✅ |

因此**三平台产物由 GitHub Actions 生成**：每个平台在自己的 runner 上构建。

### 用 bat 一键打包（Windows 构建机）

```bat
build.bat                打包 Windows：NSIS setup.exe
build.bat msi            只出 .msi（本地按需；不再随 Release 发布）
build.bat clean          清理 dist 与当前版本目录后完整打包
build.bat help           显示说明
build.bat win --no-bump  按当前版本重新打包，不递增版本号
```

`build.bat` 内部调用 `scripts/build.mjs`，`.bat` 文件**保持纯 ASCII**——`cmd.exe` 按字节读取批处理，多字节 UTF-8 会被拆开当成命令（这个坑踩过）。

### GitHub Actions

推送到 `v*` 标签会触发 `.github/workflows/release.yml`：

1. 三个平台并行构建（含运行时 staging 与 brotli 压缩，每平台约 11 分钟）
2. 产物统一收集到扁平目录再上传（避免把 `win-unpacked` 里的构建工具产物带进 Release）
3. 单个 job 创建 Release，正文取自仓库里的 `RELEASE_NOTES.md`

首次发布前需确认 `electron-builder.yml` 里的 `publish.owner` / `publish.repo` 指向你的仓库。

### 版本管理

版本号只写在 `package.json` 里（`package-lock.json` 会同步，否则 `npm ci` 会失败）。

**每次 `build.bat` 都会自动 +1**，递增规则是先在次版本内走完补丁号：

```
1.0.0 → 1.0.1 → … → 1.0.9 → 1.1.0 → 1.1.1 → … → 1.1.9 → 1.2.0
```

不改版本号重新打包用 `--no-bump`；调试期 5 分钟内的重复打包不会反复递增。手动管理：

```bat
version.bat             显示当前与下一个版本
version.bat next        递增（受 5 分钟节流限制）
version.bat next --force 强制递增
```

### 发布说明（每个版本必填）

每个版本的「本次更新内容」写在仓库根目录的 `RELEASE_NOTES.md`：

```markdown
# 1.1.3

## 修复

- 这次修了什么，对用户意味着什么
```

**`release.bat` 会强制校验**：文件必须存在，且第一个标题里必须出现本次版本号——否则拒绝发布。做成硬性检查是因为"忘了写"从外部看不出来：Release 会照常发出，只是没有更新内容，而用户正是来看这个的。

### 一键发布

```bat
release.bat              按序列发下一个版本：递增、提交、打标签、推送、触发 CI
release.bat 1.1.0        指定版本号（必须与序列一致）
release.bat --force      允许跳出序列（大版本时用）
release.bat --dry-run    只打印将要发生的事
```

`release.bat` 在打标签前会强制核对：工作区干净、标签不存在、标签版本与 `package.json` 一致、`package-lock.json` 已同步、发布说明已写好。

---

## 项目结构

```
src/
  main/                         Electron 主进程
    index.ts                    生命周期、菜单、托盘、启动编排
    window.ts                   窗口与加载页（含"先显示后导航"）
    paths.ts                    运行时位置解析
    runtime-unpack.ts           内置运行时的解包（单状态机）
    dsh-server.ts               spawn 并监督服务端子进程
    updater.ts                  运行时更新（npm）
    plugin-sync.ts              把内置插件同步进当前运行时（每次启动，含自愈）
    shell-updater.ts            外壳更新（electron-updater）
    credentials.ts              凭据加密存储（safeStorage）
    module-heal.ts              修复失效的模块回退链接
    workspace.ts                工作区路径工具
    settings.ts                 外壳设置读写
    git.ts                      git 状态探测
    panel.ts / project-info.ts / update-window.ts   三个信息面板
    i18n.ts                     外壳中英文案
  preload/                      渲染进程桥（contextIsolation + sandbox）
  server/server.mjs             服务端启动脚本（在 dsh 的 Node 里运行）

plugins/
  dsh-client-ui-gitbar/         输入框上方工具条：分支徽章与切换
  dsh-client-ui-review/         本轮修改审查
  dsh-client-ui-typography/     界面字号控制

scripts/                        构建、打包、发布与诊断工具（见上）

build/
  icon.png                      应用图标（1024×1024）
  entitlements.mac.plist        macOS 硬运行时权限
```

---

## 已知限制

- **Windows 已端到端验证；Linux 与 macOS 的产物由 CI 生成，尚未在真机安装验证。**
- **应用外壳自更新尚未在真机上端到端验证。** 代码路径已接线、元数据文件也已随 Release 发布，但要真正验证需要"发布新版本 → 旧版本自动升级"的完整往返。
- **安装包体积的下限由 Electron 决定。** 实测：Electron 分发包解包 268 MB / 压缩 110 MB（`electron.exe` 单个 180 MB，内嵌 Chromium 与 V8，压缩率仅约 40%）。因此**带 Electron 的方案不可能做到 30 MB 以内**；要做到那个量级必须换成系统 WebView2 外壳，代价是首次启动需联网获取运行时。当前形态（124 MB）是保持"装完即用、离线可跑"前提下的实测结果。
- **运行时更新依赖 npm。** 应用内置了 npm（约 5 MB）并由 Electron 自带的 Node 驱动它。不自己实现 semver 解析与 peer 提升，是因为错误依赖树会产生"能启动但行为异常"的应用。
- **本轮修改审查的基线存在宿主进程内存中。** 应用重启后需重新开始一轮才会再次记录基线。
- **内置的 `desktop` profile 无法通过命令行定制。** `dsh --profile desktop` 被官方刻意拒绝；要定制请改 `<userData>/home/profiles/desktop/cordis.patch.yml`，运行时热重载。
- **不再发布 `.msi`。** 其安装界面只有英文，且构建受 WiX 的路径长度限制；需要时可在本地生成（见 [打包与发布](#打包与发布)）。
- **`productName` 为 `dsh-desktop`，因此安装路径与可执行文件名不含空格。** 这是必需的：只有文件名无空格，electron-builder 生成的更新元数据与 GitHub 上的附件名才会逐字相同，自动更新才能找到下载文件。面向用户显示的名称（快捷方式、窗口标题）仍是「DeepSeek Harness」。
- **首次构建需要联网**，要下载 Electron、便携 Node 与 `@deepseek-ai/dsh`（合计约 700 MB）。

---

## 故障排查

**应用启动后随即静默退出，退出码 0。**
单实例锁已被占用。锁的作用域由 `app.getPath('userData')` 决定，`DSH_DESKTOP_HOME` **不改变**它。请先关闭已安装的版本（或另一个开发实例）。

**启动页长时间停在"正在解包内置运行时"。**
首次启动的正常行为（约 10 秒）。若超过一分钟，检查磁盘空间（需约 200 MB）与杀毒软件是否拦截了大量小文件写入。

**弹窗提示 `Error launching app`，路径看起来像 JavaScript 源码。**
Electron 没有 `-e` 参数——那是 Node 的。执行 `npx electron -e "…"` 会让 Electron 把源码文本当成*应用路径*，加载失败后弹出该对话框。请改用脚本文件（`npx electron scripts/probe-*.cjs`）。该对话框是 Windows 原生消息框，**不随父进程退出而关闭**。

**启动失败并提示 `Cannot find package '@deepseek-ai/dsh-client-ui-…'`。**
模块回退链接失效。先运行 `node scripts/doctor.mjs` 诊断，应用在每次启动时也会自动扫描并修复；修复发生在启动阶段，重启一次即可。

**打包失败，`remove …\resources\app.asar: The process cannot access the file`。**
Windows Defender 或搜索索引器正在占用刚写好的 asar。换一个输出目录，或稍等后重试。

**`.bat` 输出乱码，或提示 `'xxx' is not recognized as an internal or external command`。**
`cmd.exe` 按字节读取 `.bat`，会把多字节 UTF-8 字符拆开当成命令。本项目的 `.bat` 文件因此**保持纯 ASCII**，所有中文输出都由 `scripts/*.mjs` 打印。

**从 PowerShell 里读含中文的文件显示乱码。**
PowerShell 的 `Get-Content` 对无 BOM 的 UTF-8 按 ANSI 解码，显示为乱码，但**文件本身没有坏**。请用 `read` 工具或 Node 读取。

**`npm.ps1` 无法加载（执行策略）。**
用 `node <路径>/npm-cli.js <命令>` 绕过，或执行 `Set-ExecutionPolicy -Scope Process Bypass`。

---

## 许可证

MIT。详见 [LICENSE](LICENSE)。

本项目分发 `@deepseek-ai/dsh` 及其依赖，它们各自遵循自己的许可证。DeepSeek Harness 的版权归其作者所有；本项目不对其做任何修改，仅通过公开 API 使用并提供桌面外壳。
