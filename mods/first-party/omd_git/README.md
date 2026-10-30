# omd_git

A Git panel in the workspace dock, modelled on lazygit: framed, numbered panels for status, files, branches, commits and the stash, the focused one expanded, a main view showing the selected diff and lazygit's options bar; hunk staging, push and pull, and adding a selection to the prompt. In a very wide terminal the panels sit beside the main view, as in lazygit; otherwise they stack above it, like lazygit's portrait mode.

```text
╭ [1] Status ─────────────────────────────╮
│  repo → main                            │
╰─────────────────────────────────────────╯
┏ [2] Files ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃  ▶  M src/a.ts                          ┃
┃    M  b.ts                              ┃
┃    ?? new.txt                           ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
╭ [3] Local branches ─────────────────────╮
│    * main                               │
╰─────────────────────────────────────────╯
╭ [4] Commits ────────────────────────────╮
│    d8cab10 second  Ann, 2 minutes ago   │
╰─────────────────────────────────────────╯
╭ [5] Stash ──────────────────────────────╮
│  No stashes                             │
╰─────────────────────────────────────────╯
╭ Diff ───────────────────────────────────╮
│  @@ -1,2 +1,2 @@                        │
│  -old                                   │
│  +new                                   │
╰─────────────────────────────────────────╯
Stage: Space | All: a | Hunks: Enter | Commit: c | …
```

## Turn it on

It comes with OMD+ but starts off, and it draws inside [`omd_workspace`](../omd_workspace/README.md), so turn that on first. Then turn on `omd_git` in `/mods`, or run:

```sh
omd-package mod enable omd_workspace
omd-package mod enable omd_git
```

The panel runs `git` outside the sandbox, because the session sandbox keeps `.git` read-only, so turning it on asks you to trust that one program. It runs with your own `HOME`, so your Git identity, credential helper and SSH configuration apply.

## Keys

Open the Git tab in the dock (its number, or `[` / `]`), and the keys below apply while it has focus. `?` lists the keys of the panel you're in. Esc returns to the chat.

| Key | Where | Does |
| --- | --- | --- |
| `1`–`5` | everywhere | Status, Files, Branches, Commits, Stash |
| `h` / `l` | everywhere | Previous / next panel |
| `j` / `k` | everywhere | Next / previous item; the main view follows |
| `J` / `K` | everywhere | Scroll the main view |
| `R` | everywhere | Refresh |
| `P` / `p` | everywhere | Push / pull, after you confirm (a branch without an upstream is pushed to `origin` and tracked) |
| `@` | everywhere | Add the selection to the prompt: an `@` mention for a file, the hunk as a diff block, or a branch, commit or stash reference |
| `Space` | Files | Stage or unstage the file |
| `a` | Files | Stage everything, or unstage everything when all is staged |
| `d` | Files | Discard the file's changes, after you confirm |
| `Enter` | Files | Stage hunks of the file (an untracked file has none: `Space` stages it whole) |
| `c` | Files | Commit the staged changes with a message you type |
| `A` | Files | Amend the last commit with the staged changes |
| `s` | Files | Stash every change, untracked files included, with a message you type |
| `e` | Files | Open the file in your editor (`editor` in `host.json`) |
| `Space` / `d` | Hunks | Stage or unstage the hunk / discard an unstaged hunk, after you confirm |
| `Enter`, `h` | Hunks | Back to the files |
| `Space` | Branches | Check out the branch |
| `n` / `d` | Branches | New branch from the selected one / delete it, after you confirm (and again to force an unmerged one) |
| `A` / `r` | Commits | Amend the selected commit with the staged changes / reword it |
| `Space` / `g` / `d` | Stash | Apply / pop / drop, after you confirm |

Amending or rewording an older commit rebases onto it with `--autostash`; if the rebase stops, it is aborted and the error shows in the panel.

`/git` shows the repository and usage, and `/git refresh` reloads the panel.

## Refresh

The panel reloads when you act in it, when a turn ends and when files or the repository's Git metadata (HEAD, index, refs) change on disk, a `workspace.watch` rather than polling, so a commit, checkout or fetch made in another terminal shows at once.

## Needs and limits

- `git` on your `PATH` and [`omd_workspace`](../omd_workspace/README.md) turned on. Outside a Git repository the panel says so.
- Push and pull run in the background with your real home directory and SSH agent, so credential helpers, the macOS keychain, `~/.ssh` keys and agent-held keys work. When git needs a password, a passphrase or a host key answer, the panel offers to rerun the command in a terminal pane in its main view: `i` types in it and Ctrl+] leaves it. Once git exits, `R` or the next refresh closes the pane and shows git's last line.
- The first 200 changed files and branches and the last 100 commits are listed. The main view keeps about 28 KB or 1,000 lines, and each line is cut at 240 bytes.
- The panel keeps state for the last two repositories you used it in.
