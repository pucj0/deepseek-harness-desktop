# DeepSeek Harness Desktop

**中文 | [English](README.en.md)**

DeepSeek Harness Desktop 是 [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness) 的可安装桌面客户端。

它把官方 `@deepseek-ai/dsh` 运行时、便携 Node.js 和 Electron 外壳打包在一起。安装后即可在桌面窗口中使用官方 Harness Web UI，无需自行安装 Node.js、npm，或手动运行 `dsh web`。本项目不是官方 DeepSeek 产品，也不是 Harness 的 fork；桌面外壳负责启动和监督官方运行时，并通过插件增加桌面与 Git 工作流能力。

[![Releases](https://img.shields.io/badge/release-GitHub_Releases-blue)](https://github.com/pucj0/deepseek-harness-desktop/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
![Platforms: Windows, macOS, Linux](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

当前仓库版本：**1.5.9**。详细变更见 [发布记录](RELEASE_NOTES.md)。

## 为什么需要桌面版

官方 npm 工作流适合已经使用 Node.js 的开发者：

```bash
npm install -g @deepseek-ai/dsh
dsh web
```

桌面版提供下载安装即可运行的形态：自动启动本地 Harness 服务，在独立窗口中打开官方 Web UI，并提供原生菜单、托盘、工作区操作和 Git 面板。它沿用官方运行时及界面，未重新实现智能体。

## 核心能力

### 官方 DeepSeek Harness

桌面版通过官方 `dsh-base` 与 `dsh-web-app` bundle 启动 Harness，因此保留其工具执行、文件操作、会话、权限控制、后台任务、子代理、技能和 MCP 等能力。具体可用功能随所运行的官方版本和配置而变化；参见 [Harness 用户指南](https://github.com/deepseek-ai/deepseek-harness/tree/master/docs/user/guide)。

### 桌面集成

- Electron 窗口、原生菜单、系统托盘；关闭窗口后可从托盘重新打开，运行中的服务继续保持。窗口顶部是**自绘标题栏**（菜单按钮 + 原生最小化/最大化/关闭，最大化按钮仍能弹出 Windows 贴靠布局），Harness 官方界面作为子视图占据标题栏以下的区域。
- 系统文件夹选择器、最近打开的工作区、在文件管理器中打开工作区和复制路径。
- 单实例启动、窗口位置与大小记忆；外部链接交给系统浏览器。
- 工作区切换时重启应用并重新导航，保留桌面窗口。新目录会在下次启动时登记进 Harness 的项目列表，因此官方界面的侧栏会真的切到它，而不只是外壳和 Git 插件看到了新目录；首选工作区会记住。
- **外壳的语言跟随 Harness 的语言设置**：顶部菜单、标题栏、托盘与外壳对话框都读同一个来源（Harness 设置里的语言），在 Harness 里切换语言后立即生效，无需重启应用；Harness 没有设置过语言时才按系统语言显示。
- 中文和英文的外壳文案，以及独立的界面字号设置插件。

### Git 工作流

这些能力由本仓库的 `gitbar` 和 `review` 插件提供，运行在官方 Harness Web UI 中：

- **Git 工具条：**显示当前分支、未提交状态及相对上游的领先/落后；可搜索本地和远程分支并切换。分支行右键可按 IDEA 的习惯操作（切换、从它新建分支、合并/变基到当前、重命名、推送、删除、复制分支名）。只有用户明确选择“暂存并切换”时才会先创建 stash。
- **更新与推送：**「更新项目」（fetch → pull）与「推送」直接执行，不再弹二次确认，进度显示在动作行上。首次推送自动建立上游（等价 `push -u`）；被拒绝时给出「更新项目」与受确认保护的**强制推送**（只用 `--force-with-lease`，不会覆盖协作者刚推上去的提交）；没有上游、没有配置远端、认证失败、远端不可达各有各的提示。除破坏性操作（还原、删除分支、强制推送、签出标记或修订）外都不再二次确认。
- **合并冲突：**Changes 里冲突文件单独成组（不再同时出现在已暂存/未暂存里，也不再提供会丢掉改动的还原按钮）；点开是**冲突解决面板**——逐块显示 Current / Incoming 两侧、按块选择「用当前 / 用对方 / 两者都要」、可直接编辑结果，另有「标记为已解决」（宿主会复扫文件，残留标记一律拒绝）与按操作类型给出的「继续 / 中止」（合并 / 变基 / 摘取 / 还原）。合并、变基、摘取、还原的进行中状态由宿主判定，界面不猜。
- **项目改动（Changes）：**按冲突、已暂存、未暂存和未跟踪文件查看改动；支持逐文件 diff、暂存、取消暂存、提交，以及使用当前 Harness 模型起草提交信息。
- **提交记录（Log）：**分支树、提交图与提交详情；可查看提交中的文件差异。
- **多仓库工作区：**识别工作区所属 Git 仓库，并在工作区下有多个独立仓库时提供仓库选择器；所有 Git 操作（含更新、推送、提交、冲突解决）都只作用于当前选中的仓库。发现过程有目录深度、数量和时间上限，不保证遍历任意深度的目录。
- **本轮修改审查：**在任务轮次开始时记录 Git 快照，比较轮次后的工作区状态，以区分本轮修改和开始前已有的未提交改动。
- **实现约定：**所有 Git 命令都以仓库根为工作目录、用 `execFile` + 参数数组执行（不拼字符串），客户端只能传标量，引用/远端/提交号逐一校验；网络与 `--continue` 类操作以非交互方式执行（不会挂在不存在的终端提示或编辑器上）。

## 下载安装

从 [GitHub Releases](https://github.com/pucj0/deepseek-harness-desktop/releases) 选择对应平台的附件。以下文件名来自当前打包配置与发布工作流；文件名不含版本号，版本由 Release 标签标识。

| 平台 | 发布产物 | 使用方式 |
|---|---|---|
| Windows x64 | `dsh-desktop-x64.exe` | NSIS 安装程序，安装界面为简体中文 |
| macOS Intel | `dsh-desktop-x64.dmg`、`dsh-desktop-x64.zip` | 打开 dmg 并拖入“应用程序”，或使用 zip |
| macOS Apple Silicon | `dsh-desktop-arm64.dmg`、`dsh-desktop-arm64.zip` | 同上 |
| Linux x64 | `dsh-desktop-x86_64.AppImage`、`dsh-desktop-amd64.deb` | AppImage 直接运行，或安装 deb |

Linux AppImage：

```bash
chmod +x dsh-desktop-x86_64.AppImage
./dsh-desktop-x86_64.AppImage
```

Windows 构建未配置代码签名，SmartScreen 可能提示“未知发布者”；请核对下载来源后按系统提示继续。macOS 工作流默认走未签名构建；只有仓库启用 `SIGN_MACOS` 并配置证书时才走签名步骤。若 Gatekeeper 拦截未签名版本，可在 Finder 中右键应用并选择“打开”。当前 Release 附件的最终签名状态应以下载文件为准。

## 快速开始

1. 下载并安装对应平台版本，然后打开应用。首次启动会解包随应用携带的官方运行时。
2. 通过 **文件 → 打开文件夹** 选择工作区；未选择时默认使用用户主目录。
3. 在官方 Harness 界面的 **设置 → 模型** 中配置模型及 API Key，然后开始会话。具体设置项取决于内置或已更新的 Harness 版本。
4. 需要 Git 功能时打开 Git 工具条或项目改动面板；工作区不是 Git 仓库时，先选择仓库或打开一个仓库目录。

## 与官方 npm 版的关系

下表比较运行方式和本项目增加的桌面能力；两者使用的是官方 Harness 运行时与 Web UI。

| 项目 | 官方 npm 工作流 | Desktop |
|---|---|---|
| 安装与启动 | 安装 Node.js/npm，运行 `dsh web` | 安装应用，自动启动 |
| 界面 | 浏览器中的官方 Web UI | Electron 窗口中的官方 Web UI |
| 工作区入口 | Harness 自身的工作区操作 | 加上原生目录选择器和最近打开列表 |
| 托盘与原生菜单 | — | 提供 |
| Git 工具条、Changes、Log、本轮审查 | — | 由桌面插件提供 |
| Harness 更新 | npm | 应用内按 npm dist-tag 更新 |
| 桌面外壳更新 | 不适用 | 打包应用通过 GitHub Releases 检查和下载 |

## 架构

```text
Electron Desktop Shell
  窗口 / 菜单 / 托盘 / 工作区 / 更新 / 插件同步
                    │ 启动并监督
                    ▼
           便携 Node.js Runtime
                    │ 运行
                    ▼
        官方 @deepseek-ai/dsh
        dsh-base + dsh-web-app
        官方 Agent Runtime 与 Web UI
                    ▲
                    │ 官方 bundle / UI 插件机制
        gitbar / review / typography
```

外壳在独立子进程中，通过官方 `loadProfileDirectory()` 等入口加载应用拥有的 `desktop` profile。Web 服务监听本机随机端口，由 Electron 窗口承载。官方运行时包不被 fork；桌面插件随外壳发布，并在每次启动时同步到当前使用的运行时。

## 凭据与数据

桌面应用使用独立的 `<userData>/home` 作为 `DSH_HOME`，与命令行版 Harness 的主目录分开，因而不会覆盖已有的 CLI 配置。

代码中实现了使用 Electron `safeStorage` 包装密钥、再以 AES-GCM 加密凭据的存储类；Windows、macOS 和可用的 Linux secret storage 后端由 Electron 提供。不过，当前仓库没有把界面的 API Key 保存动作接到该存储类。通过官方 Harness 设置界面输入的凭据仍由 Harness 自身的配置机制管理，不能将其描述为已经保存在桌面外壳的 `safeStorage` 中。Linux 上如果系统加密能力不可用，该存储类会拒绝写入。

## 更新机制

- **Harness 运行时：**应用内更新界面从 npm registry 检查 `@deepseek-ai/dsh`；默认跟随 `latest`，设置文件支持 `next` 和 `alpha`。新版本安装到用户数据目录，重启后启用。若更新后的运行时启动失败，应用会回退到随安装包携带的版本。
- **桌面外壳：**打包应用使用 `electron-updater` 和 GitHub Releases 的更新元数据。用户从 **更新 → 检查更新** 主动检查与下载；开发模式不支持外壳自更新。
- 两条更新轨道独立。外壳每次启动都会把本仓库的三个 UI 插件同步到实际使用的 Harness 运行时。

## 项目结构

```text
src/main/                 Electron 生命周期、窗口、工作区、凭据与更新
src/preload/              隔离的 Electron 预加载桥接
src/server/server.mjs     官方 Harness profile 的启动入口
plugins/                  Git 工具条、改动审查、字号插件
scripts/                  运行时准备、校验与测试
build/                    图标和打包资源
.github/workflows/        跨平台发布工作流
```

关键实现位于 `src/main/index.ts`、`window.ts`、`titlebar.ts`、`menu.ts`、`dsh-server.ts`、`updater.ts`、`shell-updater.ts`、`credentials.ts`、`plugin-sync.ts`、`workspace.ts`、`workspace-switch.ts`、`git.ts` 和 `i18n.ts`。

## 开发与测试

开发环境使用 Node.js 22（与 CI 一致）和 npm。首次准备需要下载 Electron、官方 Harness 及便携 Node。

```bash
git clone https://github.com/pucj0/deepseek-harness-desktop.git
cd deepseek-harness-desktop
npm ci
npm run stage
npm run dev
```

`npm start` 在已有编译产物和已准备的运行时上启动应用。常用检查与打包命令：

```bash
npm run typecheck
npm run test:i18n
npm run test:startup
npm run test:locale
npm run test:git
npm run dist:win
npm run dist:linux
npm run dist:mac
```

打包需在对应平台执行。`npm run test:locale` 验证外壳语言跟随 Harness：语言归一化、设置文档解析与监听、菜单模板（中英对照 + 命令不变）、运行中切换（真实应用实例，不重启）、切换工作区不重置语言，以及标题栏按钮与文档 `lang` 的同步。`npm run test:git` 依次跑 Git 工作流的全部回归测试：冲突（合并 / 变基 / 摘取 / 还原，真实临时仓库）、端到端发布流程、分支条交互与源面板、改动审查的冲突界面与暂存区。`scripts/` 还包含 Git 分支、仓库发现、改动审查、暂存与提交、插件同步、运行时准备及 Electron/CDP 冒烟测试；涉及真实窗口的测试需要图形环境。

## 发布

版本以 `package.json` 为准；`v*` 标签触发 [GitHub Actions 发布工作流](.github/workflows/release.yml)，分别在 Windows、Linux、macOS runner 上构建并创建 GitHub Release。每版说明取自 [RELEASE_NOTES.md](RELEASE_NOTES.md) 的对应章节。Windows 的 `build.bat`、`version.bat`、`release.bat` 为本地构建、版本和发布流程提供入口；发布脚本会创建提交、标签并推送，使用前请先检查其行为。

## 已知限制

- Git 工作流需要系统已安装 Git，并能从应用进程的 `PATH` 找到 `git`。
- Windows 的端到端验证最充分；Linux 和 macOS 有 CI 构建配置，但仓库记录的真机安装验证较少。
- Windows 安装包未配置商业代码签名；macOS 默认构建未签名。系统可能要求首次手动放行。
- 外壳自更新代码已接入，仓库记录的跨版本真机完整升级验证有限。
- 运行时更新依赖 npm registry 和 npm 的依赖解析；联网更新需要可访问 registry。
- 本轮审查的基线保存在运行中的宿主进程内存里；应用重启后需新轮次重新建立。
- Electron 与内置运行时会增加安装包体积；首次启动需要解包内置运行时。
- 桌面 `safeStorage` 凭据写入尚未接入可见的设置流程。

## 许可证

本仓库自身代码采用 [MIT 许可证](LICENSE)。打包的 DeepSeek Harness 及其依赖由各自作者持有，并遵循各自的许可证。
