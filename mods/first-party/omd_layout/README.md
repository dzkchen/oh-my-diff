# omd_layout

Opt-in first-party mod (`0.1.0-preview.2`, API `0.2.0-experimental.5`) for the
workspace layout: a cmux-style session list, agent-written session briefs, find, quick open, a jump palette
and a command palette. It composes `omd_panes` (tabs, viewer, cockpit),
`omd_worktree` (task worktrees) and `omd_frecency` (file ranking) through their
optional services and adds no Git engine of its own.

| Key (setting `keys`) | Command | Opens |
| --- | --- | --- |
| Ctrl+Alt+P (`palette`) | `/omd_layout:palette` | command palette |
| Ctrl+Alt+G (`jump`) | `/omd_layout:jump` | sessions, worktrees and tabs |
| Ctrl+Alt+O (`quick_open`) | `/omd_layout:quick_open [QUERY]` | quick open |
| Ctrl+Alt+F (`find`) | `/omd_layout:find [QUERY]` | find in the transcript and panes |
| Ctrl+Alt+S (`sessions`) | `/omd_layout:sessions` | session list dialog |

Ctrl+Alt+letter reaches the mod in terminals without the kitty keyboard
protocol. Remap keys with the `keys` setting, for example `{"palette": "F2"}`;
invalid names are skipped. The same key closes an open picker. Picker and list
state belongs to the session thread, so two terminals keep their own.

**Session list.** The sidebar (setting `sidebar`, default on), the dialog and
the `omd_layout/sessions` site (shown by `/pane cockpit` or `/pane split right
site omd_layout/sessions`) list the 30 most recent sessions grouped by project,
with status (working, waiting for approval or input, done, error), unread
activity since you last viewed a session, branch, the linked issue or PR from
`omd_worktree`, folder, model, context use and the latest notification. Search
applies Codex's title search. Selecting a session offers switch, fork (current
session), a new session in its folder or a new session. Switching keeps the
composer draft for the session you leave and restores it when you return to it
through the list, unless the composer already holds text. The status line counts
working, waiting and unread sessions.

**Briefs.** The agent keeps a brief of its session with the `brief` tool
(`mod_omd_layout_brief`): current work, next step, up to 12 remaining tasks, up
to 6 questions or decisions for you and an optional estimate it declares;
oversized or empty fields are refused. A Brief panel below the session list
shows the host's session state (working, waiting for you, idle, last turn
failed) apart from the agent's text, the workflow objective and remaining-work
count when `omd_workflow` runs, the brief's age, and `Estimate: unknown` without
a declared estimate. A brief from an earlier turn is labelled stale, one carried
into a fork or into a session resumed after OMD restarted is labelled until the
agent updates it, and a changed workflow objective clears it. The brief belongs to the session thread
(forks copy it); the agent writes only its own session's brief, and other
sessions and their agents never read or change it. Each session-list row shows
a session's first line and question count, which reaches other OMD processes
through the shared status below. `/omd_layout:brief` shows the brief (and the
panel), `hide` hides the panel and `clear` deletes the brief. No observer model
or compaction summary is involved.

**Ports** are the TCP listeners of the session's background terminals and their
child processes, read by the host (`sessions.ports`).

**Other terminals.** Each OMD process publishes its current session's status,
note, context use, ports and brief summary to the mod's user-scope store, refreshed every five
minutes while a turn runs. Sessions running in another terminal show that live
status instead of their stored one; a working or waiting entry older than 15
minutes (for example after a crash) falls back to the stored status, and
entries expire after seven days.

**Pickers.** Type a query and press Enter to filter; Enter again runs the first
match, and Tab reaches the list. The command palette is a port of
[`@d3ara1n/pi-command-palette`](https://github.com/d3ara1n/pi-extensions/tree/main/packages/pi-command-palette)
0.8.0 (MIT): built-in actions on the root page and nested Models, Sessions, Mod
actions, Commands, Skills and Templates pages; a root query searches every page.
Built-in and mod commands run at once (a mod command runs after the palette
closes, as if typed); skills (`$name`) and Pi prompt templates (with
`omd_project_pi_prompts`) fill the composer, since they need a prompt, saving its
text for the Restore entry. Models switch through a configured route or open `/model`.
Quick open lists tracked and untracked files first, ranked by `omd_frecency`
when it runs, then ignored files, and opens the choice in the `omd_panes` viewer
(or inserts `@path`). Find counts plain or regular-expression matches with or
without case in the last 20 turns of the transcript and in open viewers, which
highlight them.

Inline (`--no-alt-screen`) sessions keep the commands; `/omd_layout:sessions
list` prints the list. Disabling the mod removes its sites and keys; native
`/resume`, `/new`, `/fork` and `/omd` remain.

Capabilities: `commands`, `terminal`, `lifecycle`, `store` (state and the
shared status), `sessions` (thread list, turns, ports), `threads` (start,
settings), `model` and `inventory` (model and skill lists), `builtins`,
`composer`, `exec` (`git ls-files`), `fs.read` (Pi templates), `events` (the
status refresh timer), `services` and `tools` (the brief tool).
