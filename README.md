# 🧭 Git Compass

A friendly, visual Git cockpit for VS Code — your private alternative to GitLens' paid features, built for people who
want to *understand* what Git is doing.

![icon](media/icon.png)

## What you get

| Where | What |
|---|---|
| **Overview** (sidebar) | Current branch, ↑ to push / ↓ to pull, a plain-language **"what to do next"** hint, the **commit box** (Commit, Commit & Sync, Amend), quick actions, banners with **Continue / Skip / Abort** during merges and rebases |
| **Changes** | Conflicts / Staged / Changes groups with coloured status letters; stage, unstage, discard (new files go to the trash), keep current/incoming version, merge editor, add to `.gitignore`; list or folder-tree view; multi-select |
| **Commits** | History of the current branch; **unpushed** (orange ↑) and **incoming** (blue ↓) commits are marked; expand a commit to see changed files with +/− counts |
| **Branches** | Local and remote branches with ahead/behind; switch, merge, rebase, compare, rename, delete (local or remote), set upstream, publish, open on GitHub, create pull request |
| **Worktrees** | Several branches checked out at once in separate folders: create (from a branch, remote branch, tag, commit or a new branch), open in a new window / this window / add to workspace, see uncommitted changes per worktree, lock/unlock, remove, prune; switching to a branch that is open elsewhere offers to open that worktree |
| **Stashes / Tags** | Create, apply, pop, drop, branch from stash, browse stash contents; create, push, delete tags |
| **File History** | Every commit that touched the current file (follows renames); pin to keep a file; restore an old version |
| **Compare** | Any two branches / tags / commits (or your working files): commits only on each side + every differing file |
| **Undo History** | The reflog in human words ("Switched from main to feature", "Reset to …") — restore to any point |
| **Pull Requests** | Open GitHub PRs, their changed files (diffs fetched through the API), checkout, create — sign-in via VS Code, no tokens |
| **Graph** (sidebar) | Compact commit graph of all branches next to your work: lanes, badges, search, click to unfold details/files inline, right-click actions, one click to the big graph |
| **Commit Graph** (editor tab) | Colour-coded lanes for all branches, ref badges, uncommitted-changes row, search by message / author / ID / **changed text** / **file path**, details pane with files and actions, native right-click menus, double-click a branch to switch |
| **Edit History** (editor tab) | Visual interactive rebase: drag to reorder, keep / reword / edit / squash / fixup / drop |
| **Blame** | Who changed the current line (end-of-line hint + rich hover), full-file blame with age colours |
| **Guide** (editor tab) | Illustrated handbook: Git in 3 minutes, everyday workflow, branches, remote, **conflicts step by step**, **"undo anything" cheat-sheet**, rewriting history, GitHub, glossary, and the git commands behind every button |
| **Walkthrough** | Getting-started tour in VS Code's Welcome page |

Safety rails everywhere: dangerous actions ask first and explain the consequences in plain words; force push always uses
`--force-with-lease`; amending/resetting already-pushed commits warns you; uncommitted changes blocking a switch can be
stashed automatically. Every git command that runs is logged in **Output → Git Compass**.

## Install / update (this computer)

Requirements: VS Code ≥ 1.90 and Git. **No Node.js or npm needed** — the scripts use the JavaScript runtime that ships inside VS Code.

```bash
./install.sh            # Linux/macOS: builds git-compass-<version>.vsix and installs it
./install.sh --test     # same, but runs all tests first
```

```powershell
.\install.ps1           # Windows (if blocked: powershell -ExecutionPolicy Bypass -File .\install.ps1)
.\install.ps1 -Test
```

Then run **Developer: Reload Window** (Ctrl+Shift+P). The compass icon appears in the activity bar.

Manual alternative: Extensions view → `⋯` → **Install from VSIX…** → pick the `.vsix` file.

**Remote SSH / WSL:** the extension runs where your repository is. In a remote window open the Extensions view and click
**Install in SSH: …** on Git Compass once.

## Using it on all your devices

Right now Git Compass is installed only on this machine. The easiest way to share it between your Linux and Windows
computers — using Git Compass itself:

1. Open this folder in VS Code → Git Compass → **Initialize repository** → commit.
2. **Publish to GitHub** → choose **Private**.
3. On another computer: Git Compass → **Clone repository** → pick `git-compass` → run `install.ps1` / `install.sh`.
4. To update a device later: **Pull** in that clone, run the install script again, reload.

(Fully automatic syncing would mean publishing to the public Marketplace, or adding a small self-updater that pulls the
private repo — both can be added later.)

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `gitCompass.smartCommit` | `ask` | When nothing is staged: ask / always / never commit all changes |
| `gitCompass.pullStrategy` | `merge` | Pull via merge, rebase or fast-forward only |
| `gitCompass.autoFetch` | `10` | Background fetch every N minutes (0 = off) |
| `gitCompass.viewAsTree` | `false` | Changed files as folder tree |
| `gitCompass.switchToNewBranch` | `true` | Switch to a branch right after creating it |
| `gitCompass.blame.currentLine` / `.hover` | `true` | Current-line blame and its hover |
| `gitCompass.graph.pageSize` | `400` | Commits loaded per page in the graph |
| `gitCompass.statusBar` | `true` | Branch / ↑↓ / changes in the status bar |
| `gitCompass.useVSCodeGitForNetwork` | `true` | Push/pull/fetch through VS Code's Git so GitHub sign-in works automatically |
| `gitCompass.gitPath` | auto | Path to `git` |

## Development

```
src/
  extension.js        activation, wiring, status bar, auto-fetch
  git.js              git CLI wrapper + parsers (no vscode dependency, unit-tested)
  graphLayout.js      commit-graph lane algorithm
  repoManager.js      repository discovery, state, file watching
  commands.js         every user action (≈100 commands)
  diff.js             virtual "file at revision" documents + diff helpers
  github.js           GitHub REST client (VS Code authentication)
  blame.js            inline / file blame + hover
  views/              tree views (changes, commits, branches, …)
  webviews/           overview, commit graph, interactive rebase, guide (host side)
media/                webview scripts/styles, guide, icons, walkthrough pages
test/
  unit.test.js        git layer against real temporary repositories
  manifest.test.js    package.json ↔ code consistency
  host.test.js        headless end-to-end run of the whole extension (mock vscode API)
  integration/        the same scenario runnable inside a real VS Code instance
scripts/package.js    builds the .vsix (no npm/vsce needed)
```

Run the tests with `./install.sh --test`, or individually, e.g.
`ELECTRON_RUN_AS_NODE=1 /snap/code/current/usr/share/code/code test/unit.test.js` (or `node test/unit.test.js` if Node is installed).

To hack on it live: open this folder in VS Code and press **F5** (Run Extension) — a second window loads the extension from source.
