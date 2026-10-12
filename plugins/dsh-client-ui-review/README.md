# dsh-client-ui-review

代码差异的“统一 / 并排”选择保存在当前 dsh profile 的 `ui-review/view-preferences.json`，Changes、Log 和本轮审查共用。关闭界面、重启桌面端或服务端口变化后仍可恢复，并迁移当前浏览器已有的选择。

“本轮修改”按 dsh 的实际任务轮次记录，审查顶部可切换最近一轮及历史轮次。结束后的快照为只读，后续编辑不会混入旧轮次；历史存入 profile 的 `ui-review/turns/`，Git 私有引用 `refs/dsh-review/` 保留快照对象。开始记录前的旧轮次没有文件快照，无法补回历史差异。

官方 DeepSeek Harness Web UI 的独立审查与项目 Git 插件。无需安装 Desktop、gitbar 或 shell-bridge。

## 功能

- 官方右侧栏的 **Review / 审查** 标签：通过 Git 临时索引记录每轮基线，查看本轮文件与差异。
- 官方右侧栏的 **Git** 标签：Changes、暂存、提交、AI 提交信息、储藏、冲突编辑器、Log、提交图、修订比较、文件历史、标签、重置与交互式变基。
- 输入框上方的本轮修改入口和会话顶部的项目 Git 入口，支持中文、英文与多仓库工作区。

本轮基线根据浏览器观察到的会话运行状态记录；安装或刷新前已经发生的修改无法追溯成一轮。AI 提交信息使用宿主的默认模型，需在 dsh 中配置模型与凭据。

## 安装到官方 dsh

已在 **@deepseek-ai/dsh 0.2.0-rc.1** 的官方 `web` profile 验证。需要 Node.js 22+、Git 和官方插件管理命令所使用的 pnpm；当前版本不提供 TUI 界面。

在本目录执行 `npm pack` 得到 `dsh-client-ui-review-1.1.2.tgz`，也可以使用仓库根目录 `npm run pack:plugins` 生成的安装包。然后用安装包的绝对路径安装：

```bash
dsh plugin --profile web add "/absolute/path/dsh-client-ui-review-1.1.2.tgz"
dsh web
```

Windows 示例：

```powershell
dsh plugin --profile web add "E:\code\deepseek-harness-desktop\release\plugins\dsh-client-ui-review-1.1.2.tgz"
dsh web
```

插件管理器会通过 `dsh.bundle.patch` 自动启用 bundle。已有 dsh 进程需要重启，浏览器页面需要刷新。自定义 Web profile 可把命令中的 `web` 换成自己的 profile 名称。卸载：

```bash
dsh plugin --profile web remove dsh-client-ui-review
```

独立仓库：[dsh-client-ui-review](https://github.com/pucj0/dsh-client-ui-review)。从 [GitHub Releases](https://github.com/pucj0/dsh-client-ui-review/releases) 下载 tgz，或直接使用固定版本的 Release 地址安装：

```bash
dsh plugin --profile web add https://github.com/pucj0/dsh-client-ui-review/releases/download/v1.1.2/dsh-client-ui-review-1.1.2.tgz
```

尚未发布到 npm registry。此目录本身可复制为独立仓库，保留 `lib/`、`package.json`、`cordis.patch.yml`、`README.md` 和 `LICENSE` 即可，不需要构建 Desktop。

## 独立性与联动

包内包含 Git 操作后端，注册 `/dsh-desktop/review/*` 与 `/dsh-desktop/review/git/*` 路由；路径保留历史前缀以兼容既有界面，运行不依赖 Electron。工作区权限来自官方 `workspaceRegistry` 与 `profileContext`，每次请求重新读取已登记项目，只允许合法工作区及其发现的仓库。

可选安装 `dsh-client-ui-gitbar` 增加分支工具条。两者同时安装时，gitbar 可打开本插件的比较视图，并使工作区快照失效；服务端路由互不冲突。

review 的 `lib/git-operations.js` 是随包分发的 Git 操作实现，与 gitbar 使用同一套协议；本仓库可以独立修改、检查和发布，不依赖其他仓库的构建产物。

官方项目：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。本插件是社区扩展，许可证 MIT。

## 开发与发布

`npm test` 检查包契约与 JavaScript；`npm pack` 生成安装包，无构建依赖。推送与 package.json 版本一致的 `v<version>` tag 后，GitHub Actions 自动生成 tgz 和 SHA256SUMS.txt 并发布 GitHub Release。
