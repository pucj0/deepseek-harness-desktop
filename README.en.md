# DeepSeek Harness Desktop

**[中文](README.md) | English**

DeepSeek Harness Desktop is an installable desktop client for [DeepSeek Harness (`dsh`)](https://github.com/deepseek-ai/deepseek-harness).

It packages the official `@deepseek-ai/dsh` runtime, a portable Node.js runtime, and an Electron shell. Install the app to use the official Harness Web UI in a desktop window without installing Node.js or npm yourself or running `dsh web` manually. This is neither an official DeepSeek product nor a fork of Harness. The shell starts and supervises the official runtime and adds desktop and Git workflows through plugins.

[![Releases](https://img.shields.io/badge/release-GitHub_Releases-blue)](https://github.com/pucj0/deepseek-harness-desktop/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
![Platforms: Windows, macOS, Linux](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

Repository version: **1.7.3**, bundling Harness Runtime **0.2.0-rc.1**. See [release notes](RELEASE_NOTES.md) for the version history.

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
- **One consistent notion of "the current workspace".** Startup decides which directory to boot with; from then on **Harness's current project is the source of truth**. A bundled `shell-bridge` plugin reports the workspace of the current session to the shell (over a minimal preload bridge; the path must pass three checks — absolute, existing directory, already registered), so "File → Project Info / Reveal Workspace / Copy Workspace Path" follow a project switch made in the Harness sidebar **immediately, without a restart**, instead of being captured from the startup directory. Startup also reconciles state: `recent` / `workspace` entries in `settings.json` that point at deleted directories are **pruned and written back to disk**, and registry records whose directory no longer exists are removed by the server through the official `workspaceRegistry.delete()`. **Registration only happens when the user explicitly asks to open a directory** (Open Folder / Open Recent / command line), so a workspace you removed inside Harness is never silently registered again on the next launch — while opening it again yourself is a new intent and registers it. "Remove from Recent" (shell list only), "Forget Workspace…" (Harness registry only; files and sessions are kept) and deleting a folder on disk are three different things, each with its own menu row, and none of them triggers another.
- **The shell's language follows Harness's own language setting**: the menu bar, title bar, tray and shell dialogs all read that one source, so changing the language inside Harness takes effect immediately — no restart. Only when Harness has no stored language does the system language decide.
- Chinese and English shell text, plus a separate UI font-size plugin.

### Git workflow

The repository's `gitbar` and `review` plugins add these controls to the official Harness Web UI:

- **Git toolbar and Smart Checkout:** branch switching first lets Git carry compatible changes normally. Only when Git refuses because local changes would be overwritten does the host create an OID-tracked safety stash, switch, restore with index preservation, verify the result, and drop that exact marked stash. Staged, unstaged, and untracked files are protected; restore conflicts stay on the target branch and open in the existing conflict editor while the safety stash remains.
- **Official Git Sidebar:** project Changes and Log are registered in the official Harness right Sidebar with its branch icon; the old fixed Project Changes drawer is gone. The active Harness session cwd is the sole workspace source, stale asynchronous responses are discarded, and multi-repository selection is scoped per workspace. Changes includes Conflicts, Staged, Changes, Unversioned, Auto-saved Changes, and Stashes; Log retains graph, filters, details, compare, reset, cherry-pick, and tags.
- **Stashes and Auto-saved Changes:** normal stashes remain viewable and manually applicable. Unrestored Smart Checkout backups are rediscovered from their `dsh-smart-switch:` marker after restart, can be inspected, restored, or switched back and restored. Automatic deletion requires the app marker, unique id, and exact OID; it never guesses from `stash@{0}` or deletes a user-created stash.
- **Update and push:** “Update project” (fetch → pull) and “Push” run directly instead of asking for a second confirmation, and report progress on the action row. The first push sets the upstream automatically (equivalent to `push -u`). A rejected push offers “Update project” plus a confirmation-protected **force push** that only ever uses `--force-with-lease`, so a collaborator's newer commit is never overwritten. Missing upstream, no configured remote, authentication failure, and an unreachable remote each get their own message. Only destructive actions (discard, delete branch, force push, checkout tag or revision) still ask first.
- **Merge conflicts:** conflicted files form their own group in Changes (they no longer appear under both staged and unstaged, and no longer offer a discard that would throw the work away). Opening one shows the **merge editor**: Current and Incoming per block, per-block “take current / take incoming / take both” (the choice updates the Result pane immediately, but only as a preview — nothing is written), an editable result (Tab indents), “mark as resolved” (the host re-scans the file and refuses leftover markers), and per-operation “continue / abort” for merge, rebase, cherry-pick and revert. Rebase and cherry-pick advance one commit at a time: if the next commit conflicts again — possibly in a *different file* — the host reports that the operation moved on to the next conflict instead of claiming completion, and the UI keeps resolving. The host decides which operation is in progress; the UI never guesses.
- **Project Changes:** conflicts, staged, unstaged, and untracked groups; per-file diffs, stage, unstage, commit, and an AI-assisted commit message draft using the configured Harness model. The diff viewer defaults to **side-by-side** and can switch back to **unified** (the choice is stored locally, not in Harness settings); because both sides are the same grid row the panes scroll together, delete/add runs are paired up, and the changed characters inside a line are highlighted. The toolbar offers previous/next change with an `n/N` counter and jumps to any hunk; binary-only changes and rename-only changes get their own explanation.
- **Amend and safe history rollback:** the commit area can **amend the last commit** (HEAD's message is read automatically into the box; you can change only the message, only the staged content, or both — `--amend` replaces HEAD and never touches anything older). If that commit is **already on the upstream**, the UI says plainly that amending rewrites published history and asks for one confirmation (it does not forbid it); pushing afterwards still goes through `--force-with-lease` only — a bare `--force` is never used. **Undo last commit** is `reset --soft HEAD~1`: the commit disappears, the changes stay staged, and the message goes back into the box (the very first commit takes the "delete HEAD" equivalent). Right-clicking any commit in the graph/Log (or the same button in the detail pane) offers **Reset Current Branch to Here…**: first a preview (current HEAD, target commit, how many commits are affected), then **Soft / Mixed / Hard** — soft moves HEAD only, mixed also unstages, hard discards local changes to tracked files (untracked files are kept), so hard only runs after a confirmation whose button reads **Reset Hard** (the request carries an explicit acknowledgement and the host rejects a hard reset without it). After a reset the panel offers a **one-click undo** that moves the branch back (undoing a hard reset asks again and says that discarded working-tree changes cannot be recovered by git).
- **Tags:** the Git toolbar panel has its own **Tags** section next to the branch sections (the search box filters it too): each row shows the tag name plus its type (**annotated / lightweight**) and whether it points at HEAD ("current version"); clicking one opens the tag menu — checkout tag (into a **detached HEAD**), new branch from here, push this tag, copy tag name, delete local tag, compare with current. Creating a tag takes a name and a message (**empty message = lightweight tag**, a message = annotated; the default follows the repository — a project that already has annotated tags defaults to annotated). **Pushing sends only the tag you clicked** (the refspec is the full `refs/tags/<name>`; `git push --tags` is never used). Deleting removes the **local** tag only and asks first (remote tag management is out of scope, and the dialog says so). Checking out a tag lands on a detached HEAD and the notice area offers "New branch from here". Right-clicking any commit in the graph also offers "Create Tag Here…".
- **Comparing revisions:** the commit context menu's "Compare with Current" compares that commit against HEAD; "Select for Compare" + "Compare with Selected" compares any two commits (A ↔ B); the branch/tag menu in gitbar opens the **same** compare view through a small cross-plugin entry point. The view states which two revisions are compared, how many commits each side has that the other lacks (`git rev-list --left-right --count`), and the changed files (renames included); clicking a file shows the diff between those two revisions in the **same diff viewer** — there is no second diff engine.
- **File history:** the "Show File History" action on every change row lists the file's commits via `git log --follow` (date / author / message / SHA, **including history from before a rename**); clicking a history entry shows **that commit's change to the file** (`/commit-file` plus the same diff viewer, the same path the commit graph uses).
- **Interactive rebase:** right-click any commit in the graph/Log and choose "Interactive Rebase from Here…" (the commit above a row works too). A **structured plan** opens: one row per commit from that commit to HEAD, each with an action — **Pick / Reword / Edit / Squash / Fixup / Drop** — and the order is changed with in-row move up/down buttons. There is **no** todo text and no terminal editor anywhere. `Squash` edits the combined commit message inline (the default matches what git would produce on its own), `Reword` takes a new message, `Drop` is highlighted in red and counted in a "commits will be dropped" line, and history that is already pushed gets its own warning line — the whole rewrite is confirmed **once**, by the Start button. What actually runs is a **real** `git rebase -i`: the host generates the todo and uses a script that only reads host-owned files as `GIT_SEQUENCE_EDITOR`/`GIT_EDITOR`, so vim/nano can never appear and the renderer can never send a shell or editor command. On an `Edit` stop the banner says "Rebase paused for edit" and offers modify files / stage / **Amend Commit** (an in-app commit message editor) / continue / abort; conflicts go back to the existing conflict panel (resolve block by block → mark resolved → continue) and **multiple conflict rounds keep working**; `Fixup` merges the content and discards the message while `Reword` changes only the message (commit count and file tree stay identical). The banner always shows real progress (`Rebasing 2/5 · Current: abc1234 <subject>`, never just a spinner) plus "Skip this commit" (`git rebase --skip`, naming the commit) and "Abort Interactive Rebase" (`git rebase --abort`). After a rewrite a normal push is refused and only `--force-with-lease` is offered (still refused when someone else moved the remote, so a collaborator's commits are never overwritten).
- **Log:** a branch tree, commit graph, commit details, and diffs for files in a commit; the current branch can be reset to any commit from there.
- **Commit context menu:** right-clicking any commit in the graph/Log offers copy full SHA, compare with current, select for compare, create branch here, create tag here, cherry-pick, revert, and — in its own visually separated group — the two branch-rewriting actions "Interactive Rebase from Here…" and "Reset Current Branch to Here…" (branch-rewriting actions are separated from read-only ones and carry a one-line explanation).
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
4. For project Git operations, open **Git** in the official Harness right Sidebar. If the workspace is not itself a repository, select a discovered repository or open a repository directory.

## Relationship to the official npm distribution

This compares launch methods and additions provided by this project's shell. Both use the official Harness runtime and Web UI.

| Item | Official npm workflow | Desktop |
|---|---|---|
| Install and launch | Install Node.js/npm, then run `dsh web` | Install the app; it starts Harness |
| UI | Official Web UI in a browser | Official Web UI in an Electron window |
| Workspace access | Harness workspace controls | Also offers a native picker and recent list |
| Tray and native menu | — | Included |
| Git toolbar, Changes, Log, per-turn review | — | Desktop plugins |
| Product updates | npm | Desktop and Runtime check their respective GitHub Releases; the complete runtime ships in the Desktop Release |

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

- **Two GitHub check tracks:** **Update → Check for Updates** checks both the `pucj0/deepseek-harness-desktop` Releases for the Desktop app and the official `deepseek-ai/deepseek-harness` Releases for Harness Runtime. Each track shows its installed and latest versions; the Runtime track links to the matching official Release.
- **Complete-product installation:** `electron-updater` downloads this project's Desktop GitHub Release. Each Release carries the shell, a compatibility-tested official Harness runtime, desktop plugins, platform installers, and `latest*.yml`. The app never mistakes upstream source archives—which have no built `lib` tree and contain `workspace:*` dependencies—for an executable runtime.
- **The Release runtime always wins:** after installation the app boots the runtime bundled with that Release. A legacy `<userData>/runtime/current` left by an older version is ignored and cannot override it; sessions, workspaces, settings, sign-in data, and user projects are not deleted.
- **Verifiable version source:** `package.json#dshRuntimeVersion` pins the runtime shipped by a build. `npm run stage` first verifies that the matching official `dsh-v*` GitHub Release is published, then prepares its complete dependency closure on the build machine. An installed app never runs npm, queries the npm registry, or compiles the upstream source. App self-update is explicitly unavailable in development mode.

## Project structure

```text
src/main/                 Electron lifecycle, window, workspace, credentials, updates
src/preload/              Isolated Electron preload bridge
src/server/server.mjs     Official Harness profile bootstrap
plugins/                  Git toolbar, change review, typography, shell bridge
scripts/                  Runtime staging, validation, tests
build/                    Icons and packaging resources
.github/workflows/        Cross-platform release workflow
```

The main implementation is in `src/main/index.ts`, `window.ts`, `titlebar.ts`, `menu.ts`, `dsh-server.ts`, `shell-updater.ts`, `credentials.ts`, `plugin-sync.ts`, `workspace.ts`, `workspace-switch.ts`, `git.ts`, and `i18n.ts`.

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
npm run test:locale
npm run test:git
npm run dist:win
npm run dist:linux
npm run dist:mac
```

Build each package on its target platform. `npm run test:locale` verifies that the shell language follows Harness: locale normalization, settings-document parsing and watching, the menu template (Chinese vs English, with the commands proven unchanged), a live switch inside a real app instance (no restart), a workspace switch that does not reset the language, and the title-bar buttons plus the document `lang`. `npm run test:workspace` covers the workspace lifecycle: which resolutions count as an explicit "open this" intent, the prune-and-persist reconciliation of `settings.json`, the decision to stop trusting a remembered workspace once Harness no longer lists it, the removal of registry records whose directory is gone (against a **real** dsh server through the official `workspaceRegistry.delete()`), the delete → restart → reopen sequence, and the rule that every "File" menu action reads the live active workspace rather than a captured path (including after a locale-driven menu rebuild). `npm run test:workspace-ui` drives the **real Harness UI** in a real Electron window: creating a session in another project must make the shell's active workspace follow without a restart, after which project info, reveal and copy all point at the new project; removing the **current** workspace from the registry while the app runs must make the shell stop operating on it immediately (with a "workspace no longer exists" notice instead of failing silently); and one regression walks the whole "delete the current workspace → quit completely → start again" sequence, asserting one by one that the registry, the Desktop settings, the shell's active workspace, Harness's active workspace and all three menu entries no longer point at the removed directory — while "Open Recent" keeps it so the user can explicitly open and re-register it. It also proves unregistered paths and mismatched workspace ids coming from the renderer are rejected. `npm run test:git` runs the whole Git workflow regression chain: **amend and reset** (message-only / staged-only / both, published-commit detection and `--force-with-lease` lease semantics, what soft/mixed/hard each do to HEAD, the index and the working tree, undo last commit, the explicit hard-reset acknowledgement, and multi-repository isolation), **tags and revision comparison** (lightweight/annotated tags, checkout into a detached HEAD, branching off a tag, deleting a local tag, pushing exactly one tag, commit ↔ HEAD / A ↔ B / branch ↔ HEAD comparison, file history across a rename, multi-repository isolation), **interactive rebase** (pick / reword / squash / fixup / drop / reorder / an edit stop with amend / skip / abort / multi-round conflicts / plan validation / published history with `--force-with-lease` and a stale lease / multi-repository isolation, each verified against the commit count, order, parent chain, messages and file tree), conflicts (merge, rebase, cherry-pick and revert, including a **multi-round rebase**), the **whole stash workflow**, the end-to-end publish flow, the branch toolbar and its source panel (including the Tags section, the stash entries and the commit menu), the review drawer's conflict UI, the side-by-side/unified diff viewer, the stash panel, the commit area (amend / undo / commit and push), the staging area (file history included) and the commit graph view (including the interactive-rebase plan dialog and progress banner) — all on real temporary repositories. `scripts/` also contains tests for Git branches, repository discovery, change review, staging and commits, plugin sync, runtime staging, and Electron/CDP smoke runs. Tests that drive a real window need a graphical session.

## Releases

The version comes from `package.json`. Pushing a `v*` tag triggers the [GitHub Actions release workflow](.github/workflows/release.yml), which builds on Windows, Linux, and macOS runners and publishes a GitHub Release. Its notes come from the corresponding section of [RELEASE_NOTES.md](RELEASE_NOTES.md). On Windows, `build.bat`, `version.bat`, and `release.bat` provide local build, version, and release entry points. The release script creates a commit and tag and pushes them, so review its behavior before using it.

## Known limitations

- Git workflows require Git installed on the system and available as `git` on the application process `PATH`.
- Windows has the most complete end-to-end verification. CI builds Linux and macOS assets, but the repository records less installation testing on real machines for those platforms.
- Windows installers have no configured commercial code signing; macOS builds are unsigned by default. The OS may require a one-time manual approval.
- Shell self-update is wired up, but the repository records limited full, cross-version testing on real machines.
- Complete app updates depend on GitHub Releases and an exact match between each platform's `latest*.yml` metadata and uploaded assets; real-device cross-version coverage remains smaller than the repository's automated coverage.
- Per-turn baselines live in host-process memory. A new turn must establish a new baseline after an app restart.
- Electron and the bundled runtime add to package size. First launch unpacks the runtime.
- The shell's `safeStorage` credential write path is not connected to a visible settings flow.

## License

This repository's own code is licensed under [MIT](LICENSE). The bundled DeepSeek Harness packages and their dependencies remain the property of their respective authors and retain their own licenses.
