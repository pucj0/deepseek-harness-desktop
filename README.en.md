# dsh-desktop

**English (this page) | [中文文档](README.md)**

A desktop client for **DeepSeek Harness (`dsh`)**.

It bundles the official agent runtime, so an end user needs **no Node.js and no
npm**: install the app, launch it, use the full harness. The official Web UI is
reused verbatim, which means everything `dsh web` has — tools, sandboxing,
sessions, jobs, subagents, workflows, skills, MCP — plus what only a desktop shell
can add: a real window, a tray that keeps long-running work alive, OS-keychain
credentials, and self-updating of the agent runtime.

[![release](https://img.shields.io/badge/release-GitHub%20Releases-blue)](../../releases)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

## Why this design

Three facts from the official `@deepseek-ai/dsh` package drive the whole
architecture. They are findings, not preferences:

| Finding | Source | Consequence |
|---|---|---|
| The `desktop` profile name is *reserved for the Electron application* | `dsh/README.md:20`, and `dsh/lib/bin.js:29` refuses it | We are the intended owner of a profile named `desktop`. We do not patch or fork `dsh`. |
| `loadProfileDirectory()` exists for *"application-owned profiles whose package project and lifecycle belong to that application"* | `@deepseek-ai/dsh-app-boot` | The app boots the tree through public APIs; it never shells out to the `dsh` CLI. |
| `dsh web` accepts `--no-open` and `--port 0` | `@deepseek-ai/dsh-web-app/lib/startup.js` | The shell owns the window and lets the OS pick a free port. |

The runtime also needs **Node 22.13+/24** (`zlib.createZstdCompress`,
`util.getSystemErrorMessage`, `module.stripTypeScriptTypes`) — newer than the Node
inside Electron 33. So a pinned portable Node ships next to Electron rather than
being borrowed from it.

---

## Features

Inherited from the official Web UI (because that UI *is* what runs inside the window):

- Every tool: file read/write, search, PowerShell/Bash, web search and fetch, subagents, workflows, Ralph loops, goals, skills, MCP
- Filesystem sandboxing and permission presets
- Session persistence and resume, background jobs, schedules
- **Right sidebar**: workspace file tree + document preview (Markdown, code, images, PDF, HTML), with line-level jumps from tool output
- **Open In…**: open the workspace in an editor, terminal, or file manager
- Chinese and English UI, following the system language

Added by the shell:

- A real desktop window with remembered geometry
- **A tray that keeps work alive** — goals, background jobs, and subagents keep running after the window closes
- Automatic discovery and installation of newer agent runtimes, with automatic rollback
- Credentials encrypted with the OS keychain (DPAPI / Keychain / libsecret)
- A separate harness home, so a command-line `dsh` install can coexist untouched
- Native directory picker, native menus, single instance, external links to the real browser
- **A toolbar above the composer**: a branch chip with a searchable switcher, and a
  turn-changes entry that opens a collapsible review sidebar

---

## How this differs from the official distribution

The following capabilities are **not part of the official npm distribution**; they come from
this project's desktop shell. The table exists so you know what changed, not to suggest the
official package is lacking anything.

### Environment and installation

| Capability | Official (npm) | This project |
|---|---|---|
| Requires a preinstalled Node.js | yes | **no** |
| Requires npm | yes | **no** (bundled npm is used for updates) |
| Installation | `npm install -g` | installer with a graphical wizard |
| Installer UI language | — | **Simplified Chinese** (Windows NSIS) |
| Uninstall | manual `npm uninstall` | normal entry in Apps & features |

### Desktop integration

| Capability | Official (npm) | This project |
|---|---|---|
| Window | a browser tab | native window with a menu bar |
| **Git branch in the title bar** | no | current branch, dirty marker, ahead/behind |
| **Tray residency** | no | keeps running after the window closes; restore, restart the server, check for updates |
| Native folder picker | no | "Open Folder" uses the system dialog |
| Menu bar | no | File / Edit / View / Update / Help |
| Single instance | no (each `dsh web` takes a port) | a second launch focuses the existing window |

### Project-level operations (not in the official distribution)

| Capability | What it does |
|---|---|
| **Open Folder / switch project** | pick a new workspace with the native dialog; the app restarts into it. Recent list (up to 8, dead entries pruned automatically) |
| **Reveal workspace in file manager** | no need to copy paths by hand |
| **Copy workspace path** | straight to the clipboard, ready to paste into a terminal |
| **Project info panel** | workspace path, git branch and change count, runtime version and source, bundled Node and Electron versions, harness home |
| **Per-turn change review** | after a turn finishes, see every file that turn changed, with unified diffs |
| **Project changes panel** | top-right drawer, following the current conversation's project; `Changes / Log` tabs (`Changes`: staged / changes / untracked plus a pinned commit box, click a file for its line-level diff; `Log`: branch tree + commit graph + details in three columns with draggable, remembered widths), resizable (double-click to reset, arrow keys to nudge). When the workspace itself is not a Git repository (the repositories live in subdirectories) the sub-repositories are discovered automatically and a repository picker is shown |
| **Branch badge and switching** | branch and turn changes above the composer, with long branch names truncated; click to switch to a local or remote branch. Multi-repository projects additionally show `Git · N repositories` and a repository picker in front |

### Updates

| Capability | Official (npm) | This project |
|---|---|---|
| Update the agent runtime | `npm update -g` | in-app Updates window, one click, then restart |
| Follow a release channel | choose a dist-tag yourself | `latest` / `next` / `alpha` |
| **Update the app shell itself** | n/a | built-in auto-update (`electron-updater`) |
| Bundled client plugins after a runtime update | n/a | carried automatically: the shell re-syncs them into whichever runtime is in use on every start |
| Failed update | diagnose yourself | if the new runtime fails to boot, the app rolls back to the bundled one and restarts |

The bundled plugins (composer toolbar, change review, font-size control) are not part of
`@deepseek-ai/dsh`'s dependency closure — they ship with this app. A runtime update therefore
replaces the whole runtime with one that does not contain them, and the harness skips missing
plugins silently, so all three controls would simply disappear. `src/main/plugin-sync.ts` runs
before the server child starts and copies them from the copy shipped in `resources/plugins/`
into the runtime actually in use, which also repairs an install that already lost them.

Everything shell-owned (menus, tray, dialogs, plugin strings) follows the **system language**
and ships in Chinese and English.

---

## Download

Grab the file for your platform from [Releases](../../releases).

| Platform | File |
|---|---|
| Windows | `dsh-desktop-x64.exe` — NSIS installer, **Chinese UI** |
| Linux | `dsh-desktop-x86_64.AppImage` — no install, `chmod +x` and run |
| Linux | `dsh-desktop-amd64.deb` |
| macOS | `dsh-desktop-x64.dmg` (Intel) |
| macOS | `dsh-desktop-arm64.dmg` (Apple silicon) |

Filenames carry no version number; the version lives in the Release tag.

### Windows: SmartScreen blocks the first run

Double-clicking the installer shows the blue "Windows protected your PC" dialog with an
**unknown publisher**:

> Microsoft Defender SmartScreen prevented an unrecognized app from starting.

**This is expected, not a corrupted or tampered build.** The artifacts are **not code-signed**,
and Windows shows this prompt for any program that was downloaded, carries no trusted
signature, and has not accumulated enough download reputation — the `.exe` and the `.msi`
behave the same.

To proceed: click **More info → Run anyway**.

> "More info" is small and easy to miss; the "Run anyway" button only appears after you expand it.

**Only a code signing certificate removes this prompt.** With an OV or EV certificate: EV takes
effect immediately; OV still has to build reputation but no longer says "unknown publisher".

> This differs from macOS: Gatekeeper needs a one-time approval (see below) and stays quiet
> afterwards, whereas SmartScreen prompts again for **every new version**, because reputation is
> evaluated per file hash and signing certificate. **Waiting will not make it go away.**

If you have a certificate, configure it as a repository secret and CI signs automatically;
without one, CI skips signing (the log shows `no signing info identified, signing is skipped`).

On **first launch** the app unpacks the bundled runtime (about 197 MB / 10 000 files).
Bounded asynchronous writes keep the splash responsive; progress updates do not reload it.
New archives use a content fingerprint, so installer timestamp changes alone do not trigger
another extraction. An active updated runtime skips preparing the bundled fallback until needed.
Older archives retain their original cache compatibility.

The shell caches immutable client scripts and source maps in memory for an explicitly verified
runtime implementation. Installed package files remain untouched; an upstream source change
automatically falls back to the official implementation. Run `npm run test:startup` for regression
checks, or `npm run benchmark:startup -- --archive=<runtime.br> --baseline=<pre-change-commit>`
to compare extraction and server readiness (excluding Electron and browser rendering).

macOS builds are **unsigned**, so Gatekeeper quarantines them. Open once via
**right-click → Open**, or clear the flag:

```bash
xattr -dr com.apple.quarantine "/Applications/DeepSeek Harness.app"
```

### Installer language

The installer UI language differs per platform, because only one platform has an
installer UI to localize:

| Platform | Installer | Language |
|---|---|---|
| Windows `setup.exe` | NSIS wizard | **Simplified Chinese** |
| Linux `.deb` / AppImage | none — `dpkg -i`, or run directly | n/a |
| macOS `.dmg` | none — drag to Applications | n/a |

The NSIS installer is pinned to Simplified Chinese via two options in
`electron-builder.yml`:

```yaml
nsis:
  language: 2052               # LCID decimal, NOT a language name
  installerLanguages: [zh_CN]  # language name, mapped to NSIS's SimpChinese
```

> The Windows `.msi` is **no longer published**. Its installer UI is English only —
> MsiTarget exposes no language option, and the WiX toolchain it fetches ships
> `WixUIExtension.dll` without any localized `.wxl` files — and building it requires a
> very short path root (WiX is bound by `MAX_PATH`). The target is still available for
> local use: `npx electron-builder --win msi --x64`.

> That is the **installer** language. The installed app's own UI is a separate
> mechanism — it follows the system language (Chinese/English) and is controlled by
> `src/main/i18n.ts`.

On first launch the app asks for an API key. It is encrypted with the OS keychain
into this app's own data directory — never written as plaintext.

---

## Composer controls

A single toolbar sits **above the composer**, shared by two bundled plugins: the
**branch chip on the left**, the **turn-changes entry on the right**. It joins the
composer card visually — the background extends behind the card and reuses the same
22px corner radius, so no seam shows at the junction. Long branch names are truncated.

> Both controls used to be squeezed into the right-hand end of the composer toolbar
> (left of the send button), where a long branch name deformed the layout. They could
> not simply move up, because the obvious slot was the wrong one:
> `conversation.composer.bar` **is the composer itself** — registering there displaces
> the official registration, which surfaces as `Failed to load plugins` or makes the
> **composer disappear entirely**.
>
> gitbar now registers the whole row at `conversation.input.dock` and exposes a
> session-scoped child slot, `dsh.desktop.composer.actions`, for the review plugin, so
> both sit side by side without crowding each other.

**Branch chip** (`dsh-client-ui-gitbar`)

- Shows the current branch, the uncommitted change count, and ahead/behind (`master*  ↑2 ↓1`)
- **Multi-repository projects** (the workspace itself is not a repository; the repositories are in
  subdirectories) show `Git · 2 repositories` plus a repository picker first: the branch and change
  count are always those of the current repository, and switching re-fetches status, branches and
  remotes immediately. With a single repository this whole block is **not rendered** and requests
  carry no extra parameter
- Click to open the branch switcher; a **search box** sits at the top — focused and
  cleared on open, filtering as you type
- Branch rows behave the way IDEA's do: a **single click** selects the row and opens its
  action menu (the ~200 ms delay is what tells a single click from a double), a **double
  click** switches, and a **right click** opens exactly the same menu
- The action menu is an **outside cascade** (like IDEA's branch popup): the second level opens
  to the **right of the whole first-level panel** (`panel right edge + 6px`), falls back to the
  left side when there is no room, and only clamps inside the viewport when neither side fits;
  vertically it is anchored to the clicked row and flips up when needed. It **never covers the
  first-level panel**, and it can no longer survive the panel being closed — every close path
  goes through one function that drops panel + submenu + dialog + pending timer together, and
  the render layer adds an `open === true` gate on top of that
- Shows "Loading branches…" while the list is fetched, and distinguishes
  "No matching branches" from "no branches at all"
- The list puts **local branches first, remotes after**, tags remote entries, marks the
  current branch with a checkmark; switching to a remote branch creates the matching
  tracking branch automatically
- The first paint of the branch list spawns exactly **one git process** (a single
  `for-each-ref`); ahead/behind starts from the upstream data it already carries, and exact
  values are computed asynchronously only for the rows **actually inside the viewport** plus
  whatever the user selected (concurrency capped at 4; each name is asked for at most once
  per list, with a total ceiling independent of repo size). Hundreds of branches therefore
  never mean hundreds of `git rev-list` processes, and the background never walks the whole
  repository. The current branch's ahead/behind always comes from `git status`, so it is exact
- The menu flips above or below depending on viewport height, and its width and position
  stay inside the window; only the result list scrolls, the search box stays pinned
- If uncommitted changes would be overwritten, git refuses the switch — the menu **stays
  open and shows git's own error**, plus a "Stash changes and switch to X" button (a
  stash is recoverable; the plugin never discards your work for you)
- Closes on an outside click or `Esc`; after `Esc`, focus returns to the chip button

**Turn-changes review** (`dsh-client-ui-review`)

- Shows how many files this turn changed; click to open the review panel in the right sidebar
- **A second click collapses the sidebar, a third reopens it**; collapsing keeps the tab
  and any expanded diffs so you can compare back and forth
- Lists each changed file with its status (added / modified / deleted / renamed) and line counts
- Expands per-file unified diffs with added/removed coloring
- The baseline is the load-bearing detail: a git snapshot is taken **when a turn starts**,
  and the turn's changes are computed against it — so uncommitted work that predates the
  turn is **not** attributed to it

Both controls are labelled for assistive tech (`aria-label`, `aria-expanded`,
`aria-haspopup`), operable from the keyboard, and show a visible focus ring.

**Project-changes drawer** (top-right entry, `shell.overlay`)

- Follows the **current conversation's** workspace: switching conversations and starting a new
  one both move it; the panel itself has no workspace picker and never shows an absolute path
- **Two scopes: `workspaceRoot` (the directory you opened) and `repositoryRoot` (the top of the
  Git working tree).** The repository root is derived by the host via
  `git rev-parse --show-toplevel` (bounded cache + single-flight, and it is **never** taken from
  the client — otherwise `repositoryRoot=C:/` would cross the workspace security boundary). Every
  Git command runs with it as its cwd and every returned path is **repo-relative**. So when the
  workspace is a subdirectory (say `…/pages/mse`), `Changes` still lists the **whole repository**
  (`root.txt`, `src/a.js`, `pages/x.json`) and no `../src/a.js` ever shows up.
- **One snapshot and one polling loop per repository.** The snapshot store is keyed by the
  **repository root**, so `repo/src` and `repo/pages` share a single record: changing directories
  no longer clears the branch/Changes/badge, re-scans everything, or starts a second 10-second poll.
- **A workspace that is not itself a repository no longer reports "not a git repository".** The
  project-level scope comes from a single `/project-git-scope` route: it probes the workspace
  itself (`.git` may be a **file** — that is what worktrees and submodules look like, so existence
  is followed by one `rev-parse --show-toplevel --absolute-git-dir`) and then looks at
  subdirectories. Discovery is **bounded**: depth ≤ 4, at most 4000 directories visited, a 250 ms
  budget for the fast path (itself + the first level) after which the partial answer is returned
  and the rest continues in the background, concurrency 8, and 14 dependency/output directories
  (`node_modules`, `dist`, `build`, `target`, `.next`, `vendor`, `__pycache__`, …) are never
  descended into — a `.git` down there is a ghost repository. Finding one repository does **not**
  stop the scan, so siblings such as `haiweiNew/haiwei-manage-fronted` and
  `…/haiwei-manage-backend` are both listed. Results are cached per workspace for 60 seconds with
  single-flight and are **not** part of the 10-second poll. `isRepo:false` is only reported when
  that list is genuinely empty.
- **In a multi-repository project, "which repository am I looking at" is panel-wide state.** A
  repository picker (name + branch + change count, with the workspace-relative path) appears next
  to the tabs, and the `Changes` file list and diffs, the `Log` branch tree / commit graph /
  details and the commit box all follow it; each repository still gets its own snapshot cell and
  its own polling loop (two subdirectories of the same repository still share one). Until you pick
  one, a deterministic default applies (the repository the workspace belongs to, else the first in
  the list) and the host uses the **same** rule, so the picker can never say A while the panel
  shows B. The badge number is the **sum** over all repositories and says how many there are.
  Staging and committing only ever touch the selected repository (multi-repo requests carry
  `repository`, and the host accepts only repositories it discovered — anything else is a 400
  `repositoryNotAllowed`). Single-repository projects send **no** extra parameter at all, exactly
  as in 1.5.2.
- **Resident polling takes a fast path, so Git work is decoupled from the number of untracked
  files.** `/workspace` and `/status` use
  `status --porcelain=v2 --branch -z --untracked-files=normal`, which collapses whole untracked
  directories into a single `tmp/` entry: 6,846 untracked files become 1–2 records per poll
  (measured on the same fixture: `-uall` **174.4 KB / 6,855 records** → `-unormal` **0.6 KB /
  10 records**; `/workspace` **96 ms / 1.6 KB**, with **no untracked path sent to the renderer**).
  `changedFiles` carries `changedFilesExact: true` when it is exact and is explicitly marked as an
  estimate while directories are still collapsed.
- **The default width is 80% of the viewport** (1920 → 1536, 2560 → 2048), with no fixed pixel
  ceiling — the 80% ratio *is* the ceiling (it keeps 20% of the shell visible). A persisted width
  wins over the default. **Resizable**: drag the left edge (double-click to reset to 80%; focus it
  and use ←/→, or Home to reset). The width is remembered per app
- Two tabs at the top, like IDEA's Git tool window:
  - `Changes`: **Staged / Changes / Unversioned** groups (all filtered from one snapshot, so a
    group's count always equals the rows listed), laid out as **two panes** — the left pane is
    "which files am I committing" (per-row stage / unstage / revert / file history), the right pane
    is "what exactly changed in this file". The splitter between them is draggable (the left pane
    defaults to **34%**, clamps between 280px and 50% of the available width, resets on double-click
    and is remembered in `dsh.review.changesFileWidth`); below ~900px of available width the two
    panes stack vertically.
    The message box (4 rows tall, vertically resizable) and **✨ AI draft / Commit / Commit and
    Push** are pinned to the bottom and never scroll away with a long file list
    - **Untracked files come in two modes** (threshold **50**): at **≤ 50** the main pane lists
      **every** untracked file (checkbox, add to Git, diff, file history — plus an exact `+N`
      computed within a bounded budget: ≤ 1 MB per file, ≤ 8 MB per round, binaries marked
      without being read, and never one `git` fork per file); above **50** the main pane lists
      **no rows at all** and shows only "Unversioned files: 6,846 files [Browse]". The old
      behaviour — "first 50 rows plus 6,796 more not shown" — was neither a complete list nor a
      summary. While the exact count is still unknown it says "Counting untracked files…" and
      requests one enumeration.
    - **Browse is a lazy tree dialog**: directories are collapsed by default and only the
      **direct children** of the current prefix are fetched, with pagination for large levels
      (200 rows + "Load more"), so expanding a directory that holds 6,835 files never mounts
      thousands of rows. Files and directories can both be ticked (ticking a directory means its
      whole subtree — the directory path is handed to `git add`), partial selection shows as
      indeterminate, nothing is selected by default, and the header offers Select all / Clear.
      Adding to Git refreshes the loaded levels in place, and the main pane flips from browse
      back to inline (`51 → add 3 → 48` is pinned by an assertion).
    - **Exact enumeration is lazy**: it only happens when Changes has to decide inline vs browse,
      when the user opens Browse, or after a write. The result is cached per `repositoryRoot` for
      20 seconds (`repo/src → repo/pages` reuses it; 6,848 entries measured at **115 ms / 1.2 KB**).
    - **Adding thousands of files cannot blow up the command line**: paths go into a NUL-separated
      temporary pathspec file via `git add --pathspec-from-file=… --pathspec-file-nul` (removed in
      a `finally`), with a bounded batching fallback (both path count and total argv length) for
      older gits. "Select all → Add to Git" sends only `{ all: 'untracked' }` and lets the host use
      the complete list it already holds, so the renderer never carries those thousands of paths
      (measured: one add of 6,835 paths takes 4.4 s).
  - `Log`: **branch tree / commit graph / commit details**, three panes. A single click on a
    commit only changes the selection and shows its details (and changed files) on the right —
    no inline expansion. The two splitters
    are draggable and remembered, narrow windows can collapse the tree or the details, and the
    toolbar has refresh, a `{count} commits` counter (suffixed with "scroll for more" while deeper
    history exists) and search
    - **The code diff lives in the Diff Preview below, not in the right pane.** The detail pane
      holds only "metadata + the changed-file list" (340px by default, draggable up to
      `min(600, 40% of viewport)`); clicking a file just hands it to the wide pane that **spans the
      commit graph and the details**. That is what gives long Go / Java lines real width, instead of
      cramming line numbers, add/remove columns and code into a 320–420px column where every line
      needed horizontal scrolling. The Preview defaults to **40%** of the Log's usable height
      (drag the splitter, double-click it to reset, remembered in `dsh.review.graphDiffHeight`);
      `×`, Escape and a toolbar button all hide it, and clicking the same file again restores it
      without refetching. When the window is narrow the graph and the Preview are kept and the tree
      / details panes can be collapsed.
    - **`Log` and `Changes` share one diff viewer** (`ReviewDiffViewer`): the header (status badge
      + path + `+N −M` + word-wrap + close), the row body, the gutter, hunk headers, the collapsed
      file header and the loading / error / binary / truncated states exist in exactly one place, so
      both tabs render and behave identically.
    - Each diff row is a fixed four-column structure: `old line | new line | +/− | code`. The gutter
      has a fixed width, right-aligned numbers, its own background and a right border, and is
      unselectable. **Word wrap is on by default** (`white-space: pre-wrap` + `overflow-wrap:
      anywhere` + `word-break: break-word`, which keeps indentation and tabs while folding long
      lines into the visible width — long URLs and minified content cannot blow the container up),
      and the body then shows **no horizontal scrollbar**. The "word wrap" button in the header
      turns it off, which restores `white-space: pre` and moves horizontal scrolling back onto the
      container. The preference is **shared by both tabs** (turn it off in `Log` and `Changes`
      stops wrapping too) and persists in `dsh.review.diffWrap`; line height is 1.45.
    - **Wrapping never duplicates line numbers**: when one logical line folds into three visual
      lines, the old/new numbers and the `+` / `−` marker still appear once (each is a single grid
      cell) while the row background covers every visual continuation.
    - Visually the rule is "**add/remove is a background, the code is the content**": added and
      removed lines get only a ~9% green/red tint while the text keeps the normal code colour, and
      the saturated colours are reserved for the `+` / `−` markers and the gutter. git's
      `diff --git` / `index` / `--- a/…` / `+++ b/…` header is collapsed into a single
      `File changed` row (the raw lines stay in its `title`), and `@@ … @@` hunk headers get their
      own row, a smaller size and a faint blue background — what a reader wants is where and what
      changed, not patch metadata.
    - Font sizes are **layered by purpose** instead of mechanically reusing the UI size: commit
      title 12.5, secondary metadata 11.5, changed-file rows 11.5, **diff body 11**, line numbers
      and hunk headers 10.5. All of them still derive from `uiPx()`, so Settings → UI font size at
      12 / 18 scales everything proportionally.
    - **The left tree and the middle list have separate data sources.** The tree
      (`HEAD / Local / Remote / Tags`) is built from the **unfiltered** commits
      (`treeCommits`, written only by the "all branches" response); the middle list is what
      `selectedRef` filters. Clicking a branch therefore only swaps the middle list and the tree
      stays complete; clicking the same branch again clears the filter and restores everything.
    - **Clicking a branch does not blank the pane.** When data is already on screen a refresh only
      sets `refreshing` (a "Loading…" chip in the toolbar, the list dimmed) and the three panes —
      including the tree's own scroll position — stay mounted; a failure only adds a non-blocking
      note in the middle pane instead of replacing the whole Log with an error page. The full-page
      loading state is reserved for the first load, when there is nothing to show yet.
    - Each ref's first page is cached (module level, capped at 12 entries, keyed by workspace), so
      `develop → master → develop` is visible **in the same frame** and revalidates in the
      background.
    - **Scrolling within 320px of the bottom loads the next page** (it stops once `hasMore` is
      false, and only one request per `ref + skip` can be in flight, so continuous scrolling or
      repeated clicks never duplicate it). While a page is loading the footer shows
      "Loading more…"; the **Load more** button stays as the retry affordance. **Paging only ever
      appends to the middle list** — `treeCommits` is written solely by the unfiltered first page,
      so the tree never changes under the user while they scroll (the footnote in the tree says
      exactly that: branches come from the loaded commits, earlier ones may be missing).
    - Commit rows **do not show a hash** (a SHA adds nothing to reading a graph and costs a fixed
      column; `hash` is still kept internally for React keys, selection identity, detail requests,
      layout and cache keys). A row reads `[lanes] [branch/tag] subject author 2026-09-21
      15:42:18`; times go through `formatCommitTime`, which is **accurate to the second** and takes
      the date and time straight out of the ISO string without any timezone conversion (a commit
      time is a historical fact; `new Date()` would render the same commit differently per machine).
- The change count on the entry and the file list inside the drawer come from the **same shared
  snapshot** (one poll), so "shows 0 outside, has files inside" cannot happen; `stage /
  unstage / revert / commit` all invalidate that snapshot and refetch once
- **A failed `Log` render only degrades that one tab.** Every graph field is normalised where it
  is fetched (`/graph` and `/commit-detail` can omit or mistype fields and nothing malformed ever
  reaches the render layer), and an error boundary wraps the tab — so a crash shows diagnosable
  detail (component and field) plus a "Reload Log" button while the drawer, the `Changes` tab and
  the top-right entry all stay put. The observed symptom used to be the whole drawer *and* the entry
  vanishing on a `Log` click, which reads as "the panel closed itself" but is really a render-time
  exception taking the whole slot entry down through the slot-level error boundary.
- **The entry button and the panel are two subtrees that cannot take each other down.** The
  top-right button (`ProjectChangesTriggerButton`) and the panel
  (`ProjectGitPanelErrorBoundary` → `ReviewPanel`) are separate: any render-time exception inside
  the panel (Changes / Log / staging / the commit box) only makes the **panel** show
  "Git panel failed to load + details + Reload + Close", and the entry stays. The `Log` tab has a
  finer boundary of its own.
- **Switching projects is an explicit three-step**: `A → switching project… → B`. As long as a
  current session exists its cwd wins; while the session is switching and the cwd has not arrived
  the panel says "Switching project…" and **never** falls back to the previous session's (or the
  shell's) directory. Every hook is called unconditionally and before any phase guard
  (`check-react-rules.mjs` pins this statically), so a project switch cannot trip React #310.
- **Clicking anywhere ordinary outside the drawer closes it**: the chat body, the left-hand lists,
  empty space — and so do Escape and the X. The handful of things that must *not* be mistaken for
  "outside" are exempted one by one: the drawer's own subtree (including its overlays and confirm
  dialogs, via `contains`), the branch context menu and branch panel (rendered at body level by
  gitbar; exempted by the stable markers they already carry), and the top-right entry button —
  which **has to** be exempt, because a capture-phase `mousedown` would close the drawer and the
  button's own `onClick` would immediately reopen it, i.e. the user sees a flicker and no panel.
  The entry toggles itself.
- **“✨ AI draft” writes a commit message from the files you picked.** The input is exactly
  `commitPaths` (the checked files, not the whole workspace) and the host caps it three ways —
  30 files, 3000 characters per file, 30000 characters total — degrading oversized files to
  "status + line counts" instead of stuffing the repository into the context. Generation goes
  through the host's official capability — `ctx.llm.stream()` (`@deepseek-ai/dsh-llm`, the same
  path the agent loop and session titles use) plus `ctx.agentDefaultModel.currentSelection()`
  (**reusing your current login and model configuration**); there is **no API key, no hard-coded
  endpoint and no new provider inside the plugin**, and a host without the capability answers
  `aiUnavailable` naming the missing service. Behaviour: the button is disabled with a loading
  label while generating; an empty box is filled directly; **existing user text is never silently
  overwritten** — you get Replace / Append / Cancel instead; switching projects or changing the
  selection mid-flight discards the late response (request token + workspace + selection
  fingerprint); a failure keeps your text and only adds a non-blocking note.
  - **The output budget is 1024 tokens, and "hit the budget" is not a failure** (the field saw
    `AI draft failed: finish=max-tokens`). The old code treated *any* non-`stop` finish as fatal,
    so a model that had **already written a perfectly usable message** had it thrown away. The
    order is now fixed at `blocks() → normalise → then read finish`: `stop` returns normally;
    `max-tokens` with usable text (a subject or bullets) **still fills the box** and only adds the
    non-blocking note "The AI output hit its length limit; the generated message was kept"
    (the response carries `truncated: true` and `finishReason`); `max-tokens` with nothing usable
    reports a localised "The AI response exceeded the length limit. Please try again."
    (code `aiOutputLimit`, and `finish=max-tokens` is **never** shown to users); an `error` /
    `aborted` finish that carries a `failure` (auth, provider, timeout, cancellation) still fails —
    **an auth failure is never disguised as success**. The system prompt also bounds the output at
    the source (exactly one subject line, at most 3 bullets, at most 8 lines / 500 characters, no
    reasoning). `scripts/probe-commit-message.mjs` reproduces and verifies this path against a real
    model (`--max-tokens=40 --old-semantics` prints the old `finish=max-tokens` error).
- **Font sizes follow Settings → UI font size**: every size inside the drawer derives from
  `--dsh-ui-px-14` (`calc(var(--dsh-ui-px-14, 14px) * N / 14)`), which is pixel-identical at the
  14px default and scales the commit details, changed-file list, diff body and line counts together
  at 12 / 18. 14 is the base precisely because that token is guaranteed to exist (it comes from the
  typography plugin's own stylesheet) rather than depending on that plugin happening to observe
  this plugin's styles.
- **Per-file diffs are lazy.** `/workspace` is a **metadata-level** snapshot
  (`status --porcelain=v2` once for files plus index state, `diff --numstat HEAD` for line counts)
  with **no** repository-wide unified diff; clicking a file calls `/workspace-file`, which diffs
  that one path (untracked files go through `--no-index` against an empty file). The cache key is
  `workspace + HEAD + path`, so switching projects or committing invalidates it, and late
  responses are guarded by both a token and the key. Measured on a repo with 6,639
  changed/untracked paths: polling went from 10 git processes / 6.3 s to **2 processes / 0.32 s**,
  and the 38.7 MB repository-wide diff is no longer produced at all. **Untracked files take the
  very same lazy path** (`LazyFileDiff` plus `untracked: true`) and no longer reference any
  "split the whole page" artefact — which is exactly what produced
  `byFile is not defined` when clicking an untracked file.
- **A file whose only change is its mode (a `chmod`) is not a change.** On Windows, a repo with
  `core.fileMode=true` makes git record a `100755` script as `100644` — a `0/0` "modification"
  with identical content. The host snapshots with `-c core.fileMode=false` and additionally
  filters such entries out of the response.

**Writing a slot plugin: do not inject the standard hooks.** `useSessions` /
`useWorkspaces` are not service members — the renderer synthesises them for root-scoped
entries from the sources official plugins publish with
`slots.provideRoot({ hooks: { sessions } })` / `… workspaces …`. The renderer merges props
as `{ ...kit, ...injected, ... }`, so **an entry's own `inject` shadows the kit**, and
`undefined` values are not stripped: returning `useSessions: ctx.sessions?.useSessions`
(no such member exists) silently kills the working hook while the reading code looks
correct. The project-changes panel did exactly that and could therefore only fall back to
the host's `process.cwd()` — the app's launch directory, often the user's home — which is
why it kept reporting "the current workspace is not a git repository" while the project
the user actually worked in was one. Regression test:
`scripts/test-review-overlay-hooks.mjs`.

---

## Where "check for updates" lives

The official web UI has no such control; it is shell-level, so it lives in the
shell's own chrome: **menu bar → Update → Check for Updates…** (`Ctrl+Shift+U`), or
the tray icon's "Check for updates…".

The window opens immediately with "Checking…" and runs both checks **in parallel**,
pushing each result as it arrives:

| Section | What it shows |
|---|---|
| **Agent runtime** | installed version, newest on the followed channel, runtime source (bundled / downloaded), registry, channel, install location |
| **Application shell** | installed version, newest published release |

When an update exists, that section grows an action button ("Update runtime and
restart" / "Download and install", the latter showing download progress).

**The shell section explains why it cannot check** instead of just saying
"could not check" — an unpackaged dev run has no `app-update.yml`, so self-update is
unavailable, and the window says so.

> The shell is **no longer checked silently at startup**. That used to pop a dialog
> after launch with no indication of who triggered it or when. Both tracks are now
> checked only when the user opens the update window. The one exception is
> `autoInstallOnAppQuit`: an already-downloaded update installs on quit, so a user who
> clicked download is not stuck on the old version by forgetting to restart.

The menu bar is deliberately **not** auto-hidden: this is the only user-reachable
update entry point.

---

## Architecture

```
Electron main process                        dsh server child process
──────────────────────────                   ─────────────────────────
single-instance gate                         cwd            = user workspace
window / tray / menu / deep links            DSH_HOME       = <userData>/home
credential decryption (OS keychain)          profile        = desktop
runtime updater                              bundles        = dsh-base + dsh-web-app
      │                                             │
      │  spawn (pinned Node)                        │  loadProfileDirectory()
      └────────────────────────────────────────────►│  healProfilesModuleFallback()
                                                    │  boot() + provideCmdline()
      ◄──── stdout: "dsh web: http://127.0.0.1:PORT/?token=…"
      ◄──── stdout: "[dsh-desktop] ready"
```

Everything that executes agent code lives in the child process, so a crashed or
OOM-killed agent never takes the window down.

Each server process mints a random launch token, accepted **only** on `GET /`,
where it is exchanged for a signed HttpOnly cookie before redirecting to a clean
`/`. The window loads the token URL exactly once, so no credential stays in the
address bar.

`runtime/` must stay outside `app.asar`: the harness creates real directory
junctions at boot, spawns native helpers, and loads native addons by path.

**The boot script must run from `<runtime>/server.mjs`**, not from
`resources/server/`. Node resolves bare specifiers upward from the *script's own
directory*, so the shipped copy under `resources/server/` walks up to the drive
root and dies with `ERR_MODULE_NOT_FOUND` on install paths such as
`D:\Program Files\…`. The main process copies it beside the runtime's
`node_modules` before spawning.

---

## Building

Node 20+ and npm are needed on the **build machine only**.

```bash
npm install
npm run stage      # stage the dsh runtime and the pinned Node
npm run icon       # generate build/icon.png (replace with real branding)
npm run dist:win   # Windows: setup.exe
```

Or use the batch wrappers on Windows:

```bat
build.bat          Windows (setup.exe)
build.bat msi      only the .msi (local, on demand; not published with releases)
build.bat linux    prints why Linux cannot be built on Windows
build.bat mac      prints why macOS cannot be built on Windows
build.bat clean    wipe dist and the current version dir, then a full Windows build
build.bat help     full usage
```

#### Artifacts are grouped per version

One directory per version, and **no version number in the file names**:

```
release/
  1.0.0/
    dsh-desktop-x64.exe               <- NSIS installer
    latest.yml                        <- electron-updater metadata
  1.0.1/
    ...
  latest.txt                          <- names the newest version directory
```

Multiple versions coexist per platform without overwriting each other, and download
URLs stay stable across releases instead of changing with the version.

`build.bat clean` clears **only the current version directory**, never the others —
that is the point of splitting them.

### Per-platform buildability (verified, not assumed)

| Target | Buildable on Windows | Why |
|---|---|---|
| `setup.exe` (NSIS) | ✅ | |
| `.msi` | ✅ | needs WiX (fetched automatically); local use only — not published with releases |
| `.AppImage` | ❌ | needs the Linux `mksquashfs`; fails with `appimage-12.0.1/linux-x64/mksquashfs: file does not exist` |
| `.deb` | ❌ | needs `fpm`; fails with `fpm: executable file not found in %PATH%` |
| `.rpm` | — | not a publish target: no `rpmbuild` locally or in CI, so no `.rpm` is produced |
| `.dmg` / `.zip` (macOS) | ❌ | needs `hdiutil` / `codesign` / `productbuild`, which exist only on macOS |

**Linux and macOS artifacts cannot be produced on Windows** — missing toolchain,
not configuration. `build.bat linux` and `build.bat mac` stop immediately and print
the alternatives instead of downloading hundreds of megabytes before failing.

Use [`.github/workflows/release.yml`](.github/workflows/release.yml), which builds
all three platforms on their own runners.

---

## Versioning

Versions live in `package.json` (`package-lock.json` is kept in sync, otherwise
`npm ci` fails); `electron-builder` reads them from there and uses them in the
artifact directory name.

### Packaging bumps automatically

**Every `build.bat` increments the version by one**, so consecutive builds land in
their own directories:

```
build.bat   ->  1.0.0 -> release/1.0.0/
build.bat   ->  1.0.1 -> release/1.0.1/
build.bat   ->  1.0.2 -> release/1.0.2/
```

The increment rule carries into the minor version after patch `.9`:

```
1.0.0 -> 1.0.1 -> ... -> 1.0.8 -> 1.0.9 -> 1.1.0 -> 1.1.1 -> ...
```

**Rebuild without changing the version**: pass `--no-bump` (useful after editing
packaging configuration and wanting to re-verify the same version).

```bat
build.bat win --no-bump
```

**Debugging does not burn version numbers**: repeated builds within 5 minutes do not
increment again. Use `version.bat next --force` to bypass that.

### Manual control

```bat
version.bat              show current and next version
version.bat next         bump (subject to the 5-minute throttle)
version.bat next --force bump regardless of the throttle
version.bat list         list the release sequence
version.bat 1.0.3        set explicitly
```

Check that all three places agree (a mismatch breaks CI's `npm ci`):

```bat
node scripts\check-version.mjs
```

A typical release:

```bat
:: 1. write this version's notes first (see below); the heading in RELEASE_NOTES.md
::    must contain the version you are about to release
:: 2. release: bump, commit, tag, push, and trigger CI
release.bat
```

Pushing a `v*` tag makes GitHub Actions build all three platforms and **publish** the
Release directly (not a draft), filling its body from `RELEASE_NOTES.md`.

> Note: `build.bat` also bumps the version. **Local builds are for self-testing**; use
> `release.bat` for an actual release — it verifies that the tag matches the
> `package.json` version and that the release notes are written before tagging.

### Release notes (required per version)

Each version's "what changed" lives in `RELEASE_NOTES.md` at the repository root:

```markdown
# 1.0.9

## Fixes

- What changed, and what it means for the user
```

**`release.bat` enforces this**: the file must exist and its first heading must contain
the version being released, otherwise the release is refused. The check exists because a
missing note is invisible from the outside — the Release still goes out, it just has no
changelog, which is exactly what users came to read. CI additionally appends the commit
list since the previous tag as the full changelog.

After releasing, move the heading to the next version and keep writing.

### Before publishing

1. `publish.owner` / `publish.repo` in
   [`electron-builder.yml`](electron-builder.yml) are already set to this
   repository, so pushing a `v*` tag publishes directly.
2. For signed builds, add repository secrets: `MAC_CERT_P12`,
   `MAC_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
   `APPLE_TEAM_ID`.

Unsigned builds work fine but trigger SmartScreen (Windows) and Gatekeeper (macOS).

---

## Project layout

| Path | Role |
|---|---|
| `src/main/index.ts` | lifecycle: single instance, wiring, tray, update dialogs, IPC |
| `src/main/i18n.ts` | shell localization catalog (system-locale driven) |
| `src/main/dsh-server.ts` | spawns and supervises the server child; parses its readiness line |
| `src/main/window.ts` | `BrowserWindow`, token handshake, navigation fence, geometry |
| `src/main/paths.ts` | runtime/toolchain resolution for dev and packaged layouts |
| `src/main/updater.ts` | npm registry checks, versioned installs, junction activation, rollback |
| `src/main/plugin-sync.ts` | copies the bundled client plugins into the runtime in use, on every start (also self-heals a swapped-in runtime) |
| `src/main/credentials.ts` | `safeStorage`-backed sealed credential store |
| `src/main/tray.ts` | tray menu and close-to-tray |
| `src/server/server.mjs` | the boot chain, run by the child process |
| `plugins/dsh-client-ui-gitbar/` | composer toolbar: branch chip and switching |
| `plugins/dsh-client-ui-review/` | per-turn change review |
| `plugins/dsh-client-ui-typography/` | UI font-size control |
| `scripts/build.mjs` | packaging orchestration (the `.bat` files only forward) |
| `scripts/version.mjs` | version management |
| `scripts/release.mjs` | bump, commit, tag, push — with consistency gates |
| `scripts/stage-runtime.mjs` | stages `@deepseek-ai/dsh` into `runtime/` |
| `scripts/stage-node.mjs` | downloads and checksum-verifies the pinned Node |
| `build.bat` / `version.bat` / `release.bat` | one-command packaging / versioning / release |

### Diagnostic scripts

Build-machine helpers, not shipped. They exist because every claim in this README
was verified rather than assumed:

| Script | Purpose |
|---|---|
| `scripts/test-i18n.cjs` | asserts the locale mapping and catalog key parity |
| `scripts/check-imports.mjs` | every relative import resolves, catching "file not committed" |
| `scripts/check-version.mjs` | `package.json`, the lockfile, and `packages[""]` all agree |
| `scripts/test-review-host.mjs` | review-plugin snapshots and diffs (throwaway temp repo) |
| `scripts/test-gitbar-checkout.mjs` | branch switching (throwaway temp repo) |
| `scripts/test-plugin-sync.mjs` | bundled plugins land in the runtime in use, including the "runtime was swapped" repair (no Electron needed) |
| `scripts/test-review-overlay-hooks.mjs` | the project panel's overlay entry does not shadow the standard hooks, and its workspace follows the current session (no Electron needed) |
| `scripts/test-gitbar-workspace-race.mjs` | switching projects: a late response from the old workspace must never land |
| `scripts/test-review-workspace-race.mjs` | shared-snapshot and commit-graph races; the entry's number and the drawer's list come from one snapshot |
| `scripts/test-review-log-tab-crash.mjs` | clicking Log must not take the drawer and the top-right entry down with it (missing host fields + an error boundary) |
| `scripts/test-review-graph-branch-filter.mjs` | the Log branch tree is decoupled from the filtered commit list: clicking a ref never shrinks the tree, never blanks the panes, and out-of-order responses never overwrite |
| `scripts/test-review-project-git.mjs` | the project-switch state machine: the hook count must never change, the entry never disappears, "switching project…", panel-level crash isolation |
| `scripts/test-review-lazy-diff.mjs` | per-file diffs on demand: nothing fetched before a click, exactly one request per file, cache keyed by workspace + HEAD |
| `scripts/test-review-repo-scope.mjs` | scope split and untracked scale: a subdirectory workspace lists the whole repo, the fast path carries no paths, the lazy tree and bulk `git add` stay bounded (6,846 untracked files in the fixture) |
| `scripts/test-review-commit-message.mjs` | the AI commit-message draft: the three context caps, the prompt is data, output normalisation, the `finish` semantics (`max-tokens`), and naming the missing host service |
| `scripts/test-review-staging.mjs` | the staging / commit area: the three groups, per-row actions, the commit box, the two untracked modes and the Browse dialog, and the AI-draft interaction |
| `scripts/test-review-graph-view.mjs` | the three-pane commit graph: the counter, second-accurate times, scroll-triggered paging, and no hash column |
| `scripts/test-review-drawer-style.mjs` | the drawer's appearance layer: its data markers and style contract stay intact |
| `scripts/check-react-rules.mjs` | static guard for React #310 (hook order) and #290 (`ref` used as a business prop) |
| `scripts/mutation-check.mjs` | mutation check: every fix in this round is reverted to its old form and the matching assertion has to go red |
| `scripts/measure-workspace-snapshot.mjs` | real measurements of the project snapshot: git processes and wall time, before vs after |
| `scripts/probe-commit-message.mjs` | **real-model** smoke test for "✨ AI draft": what `finish` the provider actually returns (costs one real call) |
| `scripts/test-project-git-smoke.mjs` | **real Electron/CDP smoke test** (needs an instance started with `--remote-debugging-port=9333`) |
| `scripts/test-gitbar-branch-interaction.mjs` | branch rows: single click opens the menu, double click switches, right click opens the same menu |
| `scripts/test-gitbar-branch-perf.mjs` | the process ceiling for branch listing (300 branches must not mean 300 `git` processes) |
| `scripts/test-gitbar-branch-sync.mjs` | the enrichment contract (`syncExact`) and the boundedness of "only visible rows" |
| `scripts/test-release-notes.mjs` | a Release body carries only its own version's notes |
| `scripts/verify-release.mjs` | after publishing, re-checks the **published** body, draft flag and asset list through the GitHub API |
| `scripts/probe-web.mjs` | boots the runtime headlessly and reports the URL it serves |
| `scripts/probe-ui.mjs` | drives the live UI over CDP: dump controls, click, evaluate |
| `scripts/list-slots.mjs`, `scripts/list-slot-kinds.mjs` | enumerate UI extension slots and their kinds |
| `scripts/probe-locale.cjs` | prints what the Electron locale APIs report |
| `scripts/probe-tray.cjs` | verifies the tray icon loads and a `Tray` constructs |
| `scripts/capture-window.cjs` | screenshots the window, to verify layout claims |
| `scripts/ci-status.mjs`, `scripts/ci-logs.mjs` | query GitHub Actions runs and logs |

> Tests that start Electron and drive the UI over CDP — `test-review-sidebar.mjs`,
> `test-ui-typography.cjs` — need a graphical session; they cannot run in a restricted sandbox.

> **Why a "real React" test exists at all.** Most client tests here run against a hand-written fake
> React (`createElement` / `useState` / `useEffect` of our own). It cannot catch the two errors that
> only a real renderer raises — `#290` (`ref` passed to a function component as a business prop) and
> `#300/#310` (Rules of Hooks). Both show up on a real machine as **the whole entry being unmounted**,
> i.e. "after switching projects or clicking Log, the drawer and the top-right entry disappear".
> So:
>
> * `scripts/check-react-rules.mjs` blocks those two shapes statically, without Electron;
> * `scripts/test-project-git-smoke.mjs` runs the real renderer and collects `window.onerror` /
>   `unhandledrejection` / `console.error`, failing on any React minified error. It needs an
>   instance with a remote debugging port:
>
>   ```bash
>   npm start -- --remote-debugging-port=9333     # in another terminal
>   node scripts/test-project-git-smoke.mjs       # DSH_CDP_PORT overrides the port
>   ```
>
>   It looks for two sessions/projects to drive A→B→A (`DSH_SMOKE_SESSIONS="ProjectA title|ProjectB title"` names them explicitly). It currently covers A–H:
>
>   | Case | What it pins |
>   |---|---|
>   | A | the entry and the drawer survive a project switch, with no React error |
>   | B | clicking `Log` never trips #290 and the graph really renders |
>   | C | `Log / Changes / switch project` five times: neither the entry nor the drawer may disappear |
>   | D | a fast `A→B→A`: everything shown belongs to A, and the header count equals the drawer's row count |
>   | E | after clicking a branch the tree is complete, no pane blanks, and the tree's scroll position survives |
>   | F | the drawer defaults to 80% of the viewport; clicking outside closes it **while the top-right entry stays** |
>   | G | the `Log` counter says "commits" (not files), times are second-accurate, rows carry no hash, and scrolling really pages |
>   | H | an untracked file opens its diff with **no `is not defined` / ReferenceError**, and a half-typed message is not overwritten by the AI draft |
>
>   `scripts/test-drawer-dismiss.mjs` (also CDP-driven) covers click-outside / click-inside / Escape /
>   no-flicker on the entry, plus **clicking inside the branch menu must not close the drawer**.

### Release notes

`RELEASE_NOTES.md` is an **accumulating changelog**: each version adds a section at the top
(`# <version>`), older ones stay below separated by `---` so history remains readable.

A Release body contains **only that version's section**. There is exactly one implementation of
"which slice" (`scripts/release-notes.mjs`), shared by three callers:

```bash
node scripts/release-notes.mjs --extract 1.4.4   # CI uses this to build the body
node scripts/release-notes.mjs --check           # verifies package.json's version has a section
node scripts/release.mjs                         # also validates before tagging (missing or stub-thin section blocks the release)
```

The workflow used to paste the **whole file** into the body (`cat RELEASE_NOTES.md`), so v1.4.4's
Release carried every note back to 1.3.1. That is fixed and pinned by
`scripts/test-release-notes.mjs` (including "no other version's heading may appear"). The releases
already published that way (v1.3.2–v1.4.4) have been trimmed back to their own notes; the repair
script is:

```bash
node scripts/repair-release-notes.mjs          # dry-run by default
node scripts/repair-release-notes.mjs --apply   # body only; tags and assets untouched, original text backed up first
```

After publishing, check the release that actually went out (not the local file) through the GitHub API:

```bash
node scripts/verify-release.mjs         # checks package.json's current version
node scripts/verify-release.mjs 1.4.9   # or an explicit version
```

`test-release-notes.mjs` validates the **local** file, while the incident happened in the
**published** body — that is the gap `verify-release.mjs` closes: it pulls the release back and
counts version headings, checks the draft flag, and verifies the asset list (the three platform
installers plus the three `latest*.yml` update metadata files).

---

## Known limitations

- **Only Windows has been verified end to end.** Linux and macOS build
  configuration is in place and CI produces artifacts, but neither has been
  installed on real hardware here.
- **Shell self-update has not been verified on real hardware.** The code path is
  wired and the metadata files ship with the Release, but proving it needs a full round
  trip (publish a new version, watch the old one upgrade), which requires two real
  releases. **One blocker was already removed**: the filename inside the metadata must
  match the Release asset name character for character, and it previously did not
  because `productName` contained a space (see the `productName` note below).
- **`productName` is `dsh-desktop`, so the install path and executable contain no
  spaces.** Early builds (v1.0.0) used `DeepSeek Harness` and installed to
  `%LOCALAPPDATA%\Programs\DeepSeek Harness\`; that path is now
  `…\Programs\dsh-desktop\`. Uninstall the old version before upgrading, or you will
  end up with two installs. The rename was necessary: only a space-free filename makes
  electron-builder's metadata and the GitHub asset name identical, which is what lets
  auto-update find the download. User-facing names (shortcuts, window title) are
  unchanged and still read "DeepSeek Harness".
- **Runtime updates depend on npm.** The installer carries npm (~5 MB) and drives
  it with Electron's own Node. Reimplementing semver resolution and peer hoisting
  would risk a tree that boots but misbehaves.
- **The built-in `desktop` profile cannot be customized from the CLI.**
  `dsh --profile desktop` is refused by design; edit
  `$DSH_HOME/profiles/desktop/cordis.patch.yml` instead, which hot-reloads.
- **First build needs network** — Electron, the portable Node, and
  `@deepseek-ai/dsh` total roughly 700 MB, cached afterwards.

---

## Troubleshooting

**A dialog says `Error launching app` with a path that looks like JavaScript source.**
Electron has no `-e` flag — that one belongs to Node. Running
`npx electron -e "…"` makes Electron treat the source text as an *application
path*, fail, and raise that dialog. Use a script file instead. The dialog is a
native Windows message box, so it outlives the process that spawned it.

**A development run exits immediately with code 0 and prints nothing.**
The single-instance lock is held by an already-running copy.
`DSH_DESKTOP_HOME` does *not* change the lock scope — Electron derives it from
`app.getPath('userData')` before that override is read.

**Packaging fails with `remove …\resources\app.asar: The process cannot access the
file because it is being used by another process`.**
Windows Defender or the search indexer is holding the just-written asar. Build to a
different output directory, or retry after a pause.

**`.bat` output is mangled, or `'xxx' is not recognized as an internal or external command`.**
`cmd.exe` reads a `.bat` byte by byte and splits multi-byte UTF-8 characters into
bogus commands, so every `.bat` here is **pure ASCII** and all localized output
comes from `scripts/*.mjs`. Keep it that way when editing them.

---

## License

MIT. Bundles the MIT-licensed official DeepSeek Harness runtime:
<https://github.com/deepseek-ai/deepseek-harness>
