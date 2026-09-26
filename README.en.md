# DeepSeek Harness Desktop

**[中文](README.md) | English**

DeepSeek Harness Desktop is an installable desktop client for [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness).

It packages the official `@deepseek-ai/dsh` runtime, a portable Node.js runtime, and an Electron shell. Install the app to use the official Harness Web UI in a desktop window without installing Node.js or npm yourself or running `dsh web` manually. This is neither an official DeepSeek product nor a fork of Harness. The shell starts and supervises the official runtime and adds desktop and Git workflows through plugins.

[![Releases](https://img.shields.io/badge/release-GitHub_Releases-blue)](https://github.com/pucj0/deepseek-harness-desktop/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
![Platforms: Windows, macOS, Linux](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

Repository version: **1.5.9**. See [release notes](RELEASE_NOTES.md) for the version history.

## Why a desktop client?

The official npm workflow is a good fit for developers who already use Node.js:

```bash
npm install -g @deepseek-ai/dsh
dsh web
```

The desktop client offers an install-and-launch workflow. It starts the local Harness service, hosts the official Web UI in its own window, and adds native menus, a tray, workspace actions, and Git panels. It does not reimplement the agent.

## Features

### Official DeepSeek Harness

The app boots the official `dsh-base` and `dsh-web-app` bundles. Harness features such as tool execution, file operations, sessions, permissions, background jobs, subagents, skills, and MCP remain available. The exact set depends on the official runtime version and configuration; see the [Harness user guide](https://github.com/deepseek-ai/deepseek-harness/tree/master/docs/user/guide).

### Desktop integration

- An Electron window, native menu, and system tray. Closing the window can leave the service running; reopen it from the tray. The top of the window is a **custom title bar** (menu buttons plus the native minimize/maximize/close controls, so the maximize button still opens the Windows snap layout), with the official Harness UI in a child view below it.
- A native folder picker, recent workspaces, a file-manager action, and a copy-workspace-path action.
- Single-instance behavior, remembered window size and position, and external links opened in the system browser.
- Workspace switching that restarts the app and navigates the existing window. The new directory is registered in Harness's own project list on the next launch, so the official sidebar really switches to it — not just the shell and the Git plugins. The selected workspace is remembered.
- Chinese and English shell text, plus a separate UI font-size plugin.

### Git workflow

The repository's `gitbar` and `review` plugins add these controls to the official Harness Web UI:

- **Git toolbar:** current branch, dirty state, and ahead/behind counts; searchable local and remote branches with switching. A branch row's context menu follows IDEA's layout (checkout, new branch from here, merge/rebase into current, rename, push, delete, copy branch name). A stash is created before switching only when the user explicitly chooses that action.
- **Update and push:** “Update project” (fetch → pull) and “Push” run directly instead of asking for a second confirmation, and report progress on the action row. The first push sets the upstream automatically (equivalent to `push -u`). A rejected push offers “Update project” plus a confirmation-protected **force push** that only ever uses `--force-with-lease`, so a collaborator's newer commit is never overwritten. Missing upstream, no configured remote, authentication failure, and an unreachable remote each get their own message. Only destructive actions (discard, delete branch, force push, checkout tag or revision) still ask first.
- **Merge conflicts:** conflicted files form their own group in Changes (they no longer appear under both staged and unstaged, and no longer offer a discard that would throw the work away). Opening one shows the **conflict resolver**: Current and Incoming side by side per block, per-block “take current / take incoming / take both”, an editable result, “mark as resolved” (the host re-scans the file and refuses leftover markers), and per-operation “continue / abort” for merge, rebase, cherry-pick and revert. The host decides which operation is in progress; the UI never guesses.
- **Project Changes:** conflicts, staged, unstaged, and untracked groups; per-file diffs, stage, unstage, commit, and an AI-assisted commit message draft using the configured Harness model.
- **Log:** a branch tree, commit graph, commit details, and diffs for files in a commit.
- **Multiple repositories:** a selector for independent Git repositories found beneath a workspace, as well as the repository containing the workspace. Every Git operation (including update, push, commit and conflict resolution) applies only to the selected repository. Discovery has depth, directory-count, and time limits; it is not an unlimited filesystem scan.
- **Per-turn change review:** a Git snapshot taken at the start of a turn is compared with the later workspace state, separating that turn's changes from pre-existing uncommitted work.
- **Implementation rules:** every Git command runs with the repository root as its working directory and through `execFile` with argument arrays (no string concatenation); the client may only send scalars, and refs, remotes and revisions are validated individually. Network and `--continue` operations run non-interactively, so they can never hang on a missing terminal prompt or editor.

## Download

Choose the appropriate asset from [GitHub Releases](https://github.com/pucj0/deepseek-harness-desktop/releases). These names come from the current packaging configuration and release workflow. The version is in the Release tag, not the asset filename.

| Platform | Release assets | Use |
|---|---|---|
| Windows x64 | `dsh-desktop-x64.exe` | NSIS installer with a Simplified Chinese installer UI |
| macOS Intel | `dsh-desktop-x64.dmg`, `dsh-desktop-x64.zip` | Open the dmg and drag the app to Applications, or use the zip |
| macOS Apple silicon | `dsh-desktop-arm64.dmg`, `dsh-desktop-arm64.zip` | Same |
| Linux x64 | `dsh-desktop-x86_64.AppImage`, `dsh-desktop-amd64.deb` | Run the AppImage or install the deb |

To run the Linux AppImage:

```bash
chmod +x dsh-desktop-x86_64.AppImage
./dsh-desktop-x86_64.AppImage
```

Windows builds have no configured code signing, so SmartScreen may show an unknown-publisher prompt. Verify the download source before following the system prompt. The macOS workflow builds unsigned by default; it uses signing only when `SIGN_MACOS` and certificate secrets are configured. If Gatekeeper blocks an unsigned build, use Finder's **right-click → Open**. Check the downloaded asset for its final signing status.

## Quick start

1. Download the build for your platform, install it, and launch it. The first launch unpacks the bundled official runtime.
2. Use **File → Open Folder** to choose a workspace. Until one is chosen, the app uses your home directory.
3. In the official Harness UI, open **Settings → Models**, configure your model and API key, and start a session. Available settings depend on the bundled or updated Harness version.
4. For Git operations, use the toolbar or Project Changes panel. If the workspace is not itself a repository, select a discovered repository or open a repository directory.

## Relationship to the official npm distribution

This compares launch methods and additions provided by this project's shell. Both use the official Harness runtime and Web UI.

| Item | Official npm workflow | Desktop |
|---|---|---|
| Install and launch | Install Node.js/npm, then run `dsh web` | Install the app; it starts Harness |
| UI | Official Web UI in a browser | Official Web UI in an Electron window |
| Workspace access | Harness workspace controls | Also offers a native picker and recent list |
| Tray and native menu | — | Included |
| Git toolbar, Changes, Log, per-turn review | — | Desktop plugins |
| Harness updates | npm | In-app update from npm dist-tags |
| Shell updates | Not applicable | Packaged app checks GitHub Releases |

## Architecture

```text
Electron Desktop Shell
  Window / Menu / Tray / Workspace / Updates / Plugin sync
                         │ starts and supervises
                         ▼
                Portable Node.js Runtime
                         │ runs
                         ▼
               Official @deepseek-ai/dsh
               dsh-base + dsh-web-app
               Official Agent Runtime and Web UI
                         ▲
                         │ official bundle / UI plugin mechanism
               gitbar / review / typography
```

The shell boots an application-owned `desktop` profile in a child process through official entry points such as `loadProfileDirectory()`. The Web service listens on an OS-assigned loopback port and is displayed in Electron. The official runtime packages are not forked. The shell ships its own plugins and syncs them into the runtime selected at each launch.

## Credentials and data

The app sets a separate `<userData>/home` as `DSH_HOME`. It does not overwrite an existing command-line Harness home, so desktop and CLI installations can coexist.

The code includes a credential store that wraps a key with Electron `safeStorage` and encrypts data with AES-GCM. Electron uses the available OS-backed encryption mechanism on Windows, macOS, and Linux. However, the current repository does not connect the UI's API-key save action to that store. Credentials entered through the official Harness settings UI are managed by Harness itself; they should not be described as already stored by the shell's `safeStorage`. On Linux, the store refuses writes when OS encryption is unavailable.

## Updates

- **Harness runtime:** the in-app Updates window checks the npm registry for `@deepseek-ai/dsh`. It follows `latest` by default; its settings file also supports `next` and `alpha`. A new version is installed under user data and activated after restart. If it fails to boot, the app falls back to the bundled runtime.
- **Desktop shell:** packaged builds use `electron-updater` and GitHub Releases metadata. The user starts checks and downloads from **Update → Check for Updates**. Shell self-update is unavailable in development mode.
- The two update tracks are independent. At startup, the shell syncs all three bundled UI plugins into whichever Harness runtime is active.

## Project structure

```text
src/main/                 Electron lifecycle, window, workspace, credentials, updates
src/preload/              Isolated Electron preload bridge
src/server/server.mjs     Official Harness profile bootstrap
plugins/                  Git toolbar, change review, typography
scripts/                  Runtime staging, validation, tests
build/                    Icons and packaging resources
.github/workflows/        Cross-platform release workflow
```

The main implementation is in `src/main/index.ts`, `window.ts`, `titlebar.ts`, `menu.ts`, `dsh-server.ts`, `updater.ts`, `shell-updater.ts`, `credentials.ts`, `plugin-sync.ts`, `workspace.ts`, `workspace-switch.ts`, `git.ts`, and `i18n.ts`.

## Development and testing

Use Node.js 22 (as CI does) and npm. Initial setup downloads Electron, the official Harness runtime, and portable Node.

```bash
git clone https://github.com/pucj0/deepseek-harness-desktop.git
cd deepseek-harness-desktop
npm ci
npm run stage
npm run dev
```

`npm start` launches from an existing build and staged runtime. Common checks and packaging commands:

```bash
npm run typecheck
npm run test:i18n
npm run test:startup
npm run dist:win
npm run dist:linux
npm run dist:mac
```

Build each package on its target platform. `scripts/` also contains tests for Git branches, repository discovery, change review, staging and commits, plugin sync, runtime staging, and Electron/CDP smoke runs. Tests that drive a real window need a graphical session.

## Releases

The version comes from `package.json`. Pushing a `v*` tag triggers the [GitHub Actions release workflow](.github/workflows/release.yml), which builds on Windows, Linux, and macOS runners and publishes a GitHub Release. Its notes come from the corresponding section of [RELEASE_NOTES.md](RELEASE_NOTES.md). On Windows, `build.bat`, `version.bat`, and `release.bat` provide local build, version, and release entry points. The release script creates a commit and tag and pushes them, so review its behavior before using it.

## Known limitations

- Git workflows require Git installed on the system and available as `git` on the application process `PATH`.
- Windows has the most complete end-to-end verification. CI builds Linux and macOS assets, but the repository records less installation testing on real machines for those platforms.
- Windows installers have no configured commercial code signing; macOS builds are unsigned by default. The OS may require a one-time manual approval.
- Shell self-update is wired up, but the repository records limited full, cross-version testing on real machines.
- Runtime updates rely on the npm registry and npm dependency resolution; online updates require registry access.
- Per-turn baselines live in host-process memory. A new turn must establish a new baseline after an app restart.
- Electron and the bundled runtime add to package size. First launch unpacks the runtime.
- The shell's `safeStorage` credential write path is not connected to a visible settings flow.

## License

This repository's own code is licensed under [MIT](LICENSE). The bundled DeepSeek Harness packages and their dependencies remain the property of their respective authors and retain their own licenses.
