# dsh-client-ui-gitbar

官方 DeepSeek Harness Web UI 的独立 Git 工具条插件。无需安装 Desktop、review 或 shell-bridge。

## 功能

- 输入框上方显示当前分支、未提交状态及上游领先/落后信息。
- 分支与标签列表、分支新建/切换/重命名/删除、合并与变基。
- 更新项目、推送、首次推送建立上游、受保护的强制推送。
- Smart Checkout：需要时安全储藏修改，切换后恢复；冲突时保留安全副本与恢复入口。
- 储藏、自动保存恢复、操作状态、中文和英文、多仓库工作区选择。

文件差异、逐块冲突编辑器和提交图由可选的 review 插件提供。gitbar 独立使用时可以在编辑器中解决冲突后，通过工具条继续或中止操作。

## 安装到官方 dsh

已在 **@deepseek-ai/dsh 0.2.0-rc.1** 的官方 `web` profile 验证。需要 Node.js 22+、Git 和官方插件管理命令所使用的 pnpm；当前版本不提供 TUI 界面。

在本目录执行 `npm pack` 得到 `dsh-client-ui-gitbar-1.1.1.tgz`，也可以使用仓库根目录 `npm run pack:plugins` 生成的安装包。然后用安装包的绝对路径安装：

```bash
dsh plugin --profile web add "/absolute/path/dsh-client-ui-gitbar-1.1.1.tgz"
dsh web
```

Windows 示例：

```powershell
dsh plugin --profile web add "E:\code\deepseek-harness-desktop\release\plugins\dsh-client-ui-gitbar-1.1.1.tgz"
dsh web
```

插件管理器会通过 `dsh.bundle.patch` 自动启用 bundle。已有 dsh 进程需要重启，浏览器页面需要刷新。自定义 Web profile 可把命令中的 `web` 换成自己的 profile 名称。卸载：

```bash
dsh plugin --profile web remove dsh-client-ui-gitbar
```

独立仓库：[dsh-client-ui-gitbar](https://github.com/pucj0/dsh-client-ui-gitbar)。从 [GitHub Releases](https://github.com/pucj0/dsh-client-ui-gitbar/releases) 下载 tgz，或直接使用固定版本的 Release 地址安装：

```bash
dsh plugin --profile web add https://github.com/pucj0/dsh-client-ui-gitbar/releases/download/v1.1.1/dsh-client-ui-gitbar-1.1.1.tgz
```

尚未发布到 npm registry。此目录本身可复制为独立仓库，保留 `lib/`、`package.json`、`cordis.patch.yml`、`README.md` 和 `LICENSE` 即可，不需要构建 Desktop。

## 独立性与联动

包内提供 `/dsh-desktop/gitbar/*` 的 Git 后端；路径保留历史前缀，运行不依赖 Electron。工作区权限来自官方 `workspaceRegistry` 与 `profileContext`，每次请求重新读取已登记项目，只允许合法工作区及其发现的仓库。

可选安装 `dsh-client-ui-review` 增加文件审查、Git Sidebar 与差异比较。安装两者时，标签菜单的“与当前比较”会打开 review 的 Git 标签；只装 gitbar 时不显示该入口。`dsh.desktop.composer.actions` 子槽提供同排组合；review 单独安装时自带工具条，同时安装时自动加入 gitbar 的同一排。

官方项目：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。本插件是社区扩展，许可证 MIT。

## 开发与发布

`npm test` 检查包契约与 JavaScript；`npm pack` 生成安装包，无构建依赖。推送与 package.json 版本一致的 `v<version>` tag 后，GitHub Actions 自动生成 tgz 和 SHA256SUMS.txt 并发布 GitHub Release。
