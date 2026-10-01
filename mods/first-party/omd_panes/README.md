# omd_panes

Opt-in first-party mod (`0.1.0-preview.2`, API `0.2.0-experimental.5`) that
arranges the terminal into recursive split panes: the conversation, a
Git-aware file tree, a file viewer, shell and command panes with their own
working directory, a `git diff` pane, other mods' panels, and an in-harness
browser.

```text
/pane split right|down [shell [DIR] | run CMD... | diff [PATH] | tree | view PATH
                       | site NAME | notes | lsp | browser [SESSION]]
/pane focus left|right|up|down|ID     /pane move left|right|up|down
/pane grow|shrink width|height        /pane close | restart | reset | (list)
/pane tab new [KIND...] | close | rename TITLE | next | prev | 1-6
/pane cockpit                                    sessions, conversation and tabs
/tree [select PATH | find QUERY | refresh]      toggle the file tree
/open PATH[:LINE]                                open a file in the viewer
```

Every pane operation takes an optional `@ID` target; otherwise it acts on the
active pane (marked `●` in its menu row).

| Key | Action |
| --- | --- |
| Alt+h/j/k/l | focus the pane to the left, below, above, right |
| Alt+v / Alt+o | split the active pane right / down with a new shell |
| Alt+x | close the active pane (the conversation pane stays) |
| Alt+Shift+arrows | shrink or grow the active pane |
| Ctrl+Alt+arrows | swap the active pane with its neighbour |
| Alt+e | toggle the file tree |
| Alt+t | move keyboard focus into the active pane (Ctrl+] leaves a shell) |
| Alt+y | copy the selected tree path |
| Alt+c / Alt+1–6 | open a new tab / show tab N |

The mouse works too: each pane's first row is a menu (click to run the shown
action, scroll to pick another), dragging a split border resizes it, and
clicking a row or component focuses it. Clicking a tab title switches the tab
and is saved with the layout.

**Tabs.** Tabs hold pane layouts beside the conversation, which always stays
outside them so Codex's transcript, composer and approvals remain visible.
`/pane tab new` turns the active pane into the first tab (or opens a tab group
right of the conversation) and adds a tab with a new pane of the given kind;
splits inside a tab stay in that tab. Up to six tabs share the 12-cell limit.
Closing a tab's last pane removes the tab. `/pane cockpit` replaces the panes
with the Herdr/Crush-style cockpit: the `omd_layout` session list, the
conversation, and Changes (the sidebar with `omd_git` and `omd_workspace`),
Files and Diff tabs.

**Services.** `omd.panes` 1.0.0 lets other mods list and show tabs, open a file
in the viewer, apply the cockpit and set a find query; viewers then highlight
the matches and report their count. `omd_layout` uses it for jump, quick open
and find.

**Layout.** The layout is a tree of splits persisted per session in the
thread-scoped store, so resuming a session restores its panes and forking
copies them; a new session starts from the current layout. Keyboard and mouse
resizes are both saved. The host allows at most 12 layout cells nested four
deep (the conversation counts twice) and each mod panel once; a split beyond
that is refused. Codex's transcript, composer, approvals and `/omd` recovery
stay in the conversation pane, which cannot be closed. Terminals narrower than
60 columns or shorter than 12 rows fall back to the normal view, and inline
(`--no-alt-screen`) sessions keep only the commands. If the mod fails, the host
drops its layout.

**File tree.** Directories list on demand (200 entries each, six expanded at
once, 300 rows drawn around the selection) in natural order with Git colours and markers: staged, modified,
untracked (`U`), conflicted and ignored (dimmed); directories take their
strongest child state (600 Git states at most, ignored ones last). Find uses the upstream fuzzy file search, scoped to the
selected folder, and reorders the results by frecency and Git status when
`omd_frecency` is enabled. Enter on a file opens it in the viewer. The selected entry's
action row creates files and folders, renames, moves and deletes them, inserts
the path into the composer or opens the file in your editor. Every change
shows a confirmation with the paths and file count, then runs as one
`workspace.transaction` with expected hashes (folders up to 128 files); deletes
keep a backup that Undo restores. Changes by the agent, commands and (in
watched folders) other programs refresh the tree. With `git: true` a second row
stages, unstages or discards through `omd_git`.

**Viewer.** Files open in a document pane 300 lines (20 KB) at a time with line numbers,
native find and selection. Enter selects a line; the line row inserts
`path:line` (or the selected range) into the composer, opens the editor or
pages. With `lsp: true` a code-intelligence row sends definition, references,
hover, code actions, symbols, diagnostics and formatting to `omd_lsp_sync`, and
with `notes: true` a button turns the selected lines into a note in `omd_notes`.

**Shells and commands.** Shell panes run in the session sandbox after the
host's confirmation, write the workspace when `shell_write` is true (the
default), and start in the chosen directory, which each pane keeps. `run CMD`
starts a program instead of a shell. Shells do not survive a restart; the menu's
restart action starts them again. The host allows four terminal panes per mod
unless `host.json` raises `mod_limits.pty_panes_per_mod`.

**Browser.** `browser [SESSION]` opens a pane attached to a running
[`omd-browser`](../../../plugins/optional/plugins/omd-browser/README.md)
session whose profile sets `"pane": true`. Set the `browser` setting to that
plugin's `pane.json` path (normally
`$OMD_MOD_STORE/plugin-data/omd-browser/pane.json`). The pane runs the plugin's
text client with loopback-only network.

Capabilities: `commands`, `terminal`, `store`, `lifecycle`, `events` (watch
registration), `exec` (`git`, `awk`, `mkdir`, `find`), `fs.read`, `fs.write`,
`pty`, `network` (the browser pane's loopback client), `composer` and
`services` (the optional `omd.frecency` ranking and the `omd.panes` export).

Ported from [neoism](https://github.com/parkers0405/neoism) (Parker Settle and
the Neoism contributors, MIT; see `THIRD_PARTY_NOTICES.md`): panes and splits,
per-pane working directories, the file tree and its operations. This package
reimplements that behavior over the OMD mod API and copies no code. The session
and worktree list, quick open and palettes are in `omd_layout`.
