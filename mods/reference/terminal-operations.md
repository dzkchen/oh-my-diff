# Terminal operations

Use it when a mod calls an operation the terminal serves (notifications, threads and imports, selection and
clipboard, opening files, prompts, panes, panels, notices and PTY sessions) or reads what the `terminal` event
reports about the terminal itself. Raster updates (`terminal.blit`) are in [Graphics](graphics.md).

Operations the TUI serves, such as `terminal.panel`, need a running TUI. From `omd-mod command` they fail with
`host_operation_unavailable: requires a native task`. Call them with `api.host.tryCall` and fall back to returning
text.

## Notifications and commands

- `terminal.notify {title, body?}` uses the configured notification method with a focus condition and a 2 s rate
  limit.
- `commands.list`, `commands.describe` and `commands.invoke` are described in
  [Commands and configuration](commands-and-composer.md#commands-and-configuration-command_config_middleware_v1).
- `sessions.ports` (`session_ports_v1`, `sessions` capability) returns `{ports: [{port, pid, address}]}`: TCP
  listeners owned by the current thread's background terminals and their child processes, read by the host outside
  the mod sandbox (at most 32 ports, 3 s per probe).

## Threads, imports and composer

`terminal.show_thread`, `terminal.import_file` (confirmed, at most 8 MiB), `composer.read`, `composer.write` and
`composer.suggest` (see [Composer drafts and
suggestions](commands-and-composer.md#composer-drafts-and-suggestions-composer_v2)). The import confirmation shows
the resolved path.

### Import lifetime

`terminal.import_file` adds `lifetime: thread|package` (default thread).

- Package imports retain repository, owner, exact source and immutable content identity across settings/reload/new
  threads.
- A source change requires a new confirmed import. The original path is never reread.
- Existing blob and resource quotas apply; removing the mod store removes retained assets.

Keeping settings, selected assets and image-to-ASCII conversion in a mod lets outside authors use the same APIs for
document viewers, image previews, warnings, watermarks and dashboards.

## Selection and clipboard

`terminal.selection {}` (`terminal`) returns `{text, truncated}` for the current TUI selection, or `text: null`
when there is none. It prefers the visible transcript overlay and never reads obscured transcript text, another
client's selection or the OS clipboard.

- UTF-8 text is capped at 64 KiB and further bounded by its JSON-encoded size so a selection followed by a copy
  fits one callback's receipt budget. Any shortening sets `truncated: true`.
- `terminal.copy {text}` uses the native plain-text clipboard backend with the same 64 KiB limit. Its status is
  `confirmed`, `unconfirmed`, `pending` or `busy`; the native host waits for the matching clipboard worker's
  delivery result. `unconfirmed` means the backend cannot confirm delivery.

Both operations require a local user callback and reject event/tool calls and attached-client requests. Invoke
selection from a clicked component action, as the terminal example does; typing a slash command clears the
transcript selection before its callback. Require `terminal_selection_v1` and `terminal_copy_v1` for these
operations.

### Copy-on-select and right-click paste

Copy-on-select and right-click paste are Codex settings (`tui.copy_on_select`, `tui.right_click_paste`); mods
change them through `config.write`.

## `terminal.open`

`terminal.open {url} | {path}` opens an http(s) URL or an existing HTML, Markdown, text, PDF or image file after a
native confirmation.

`{path, line?, editor: true}` (`terminal_editor_v1`) opens a workspace file in the argv the user sets as `editor`
in `host.json`, with `{path}` and `{line}` substituted.

## `terminal.prompt`

`terminal.prompt {kind: 'confirm' | 'text', title, message, masked?}` asks the user; mods never answer prompts.

`{kind: 'choice', title, message, options: [{value, label}], multiple?, other?}` (`ui_composition_v1`) shows a
native picker of up to 32 options: one value, several with `multiple`, or a typed answer through an `Other…` row
with `other`. It returns `{status: 'accepted', values, other?}` or `declined` when cancelled.

## `terminal.pane` and `terminal.panes`

`terminal.pane {action, id, offset?}` (`ui_composition_v1`) opens, closes, focuses, scrolls or reveals one of the
caller's own panes, dialogs or controls; another mod's component is `terminal_pane_not_owned`. Scrolling uses
`offset`; a pane shows 8 rows and stops scrolling once its last row is in view.

`terminal.panes {}` (`ui_controls_v1`, experimental) returns the caller's own panes as
`{panes: [{id, visible, collapsed, focused, scroll}]}`; a pane is `visible` while its header row was on screen in the
last frame.

## `terminal.panel`

`terminal.panel {title, subtitle?, tabs?, items, search?, query?, selected?, close_args?, action}` (`terminal_panel_v1`)
opens Codex's own list panel in the bottom pane, where `/config` lives. `title` is at most 128 bytes and `subtitle` at
most 2,000 bytes of plain text that keeps its line breaks. `tabs` lists up to 8 `{id, title}` (titles up to 32 bytes);
with tabs, every item names its `tab`. `items` holds 1–200
`{id, tab?, label, description?, group?, keywords?, detail?, kind, value?, options?}` with unique ids without spaces (up
to 128 bytes), labels up to 128 bytes and descriptions up to 256 bytes:

| `kind` | `value` | Space or Enter |
| --- | --- | --- |
| `toggle` | boolean | Flips it. |
| `choice` | one of `options`, 1–32 `{value, label}` with unique values without spaces | Moves to the next option. |
| `text` | string up to 2,000 bytes | Opens Codex's single-line prompt; an empty answer is ignored. |
| `action` | none | Runs the action. |

Each change runs the caller's command `action.command` with `args`, the item id and the new value joined by spaces
(`set bars true`), and the panel shows the new value at once. Up and Down move and repeat while held, Left and Right
switch tabs, `/` searches every tab when `search` is true: labels match fuzzily, best first, then items whose
description, keywords or tab title contain the query; Esc clears the search or closes the panel. Outside a search, a
letter moves to the next item whose label starts with it, `g` and `G` go to the first and last row, and Home, End, PgUp
and PgDn work as in every Codex list.

Experimental (`terminal_panel_navigation_v1`): an item's `group` (up to 32 bytes) gathers items under a header row with
their count, in order of first appearance after any ungrouped items; Space or Enter on the header collapses or expands
it. `keywords` (up to 256 bytes) is searched but not shown, and `detail` (up to 512 bytes) shows below the list while
the item is selected. `query` (up to 128 bytes) opens the panel with that search, and `selected` names the item to
select first. With `close_args`, closing the panel runs `action.command` with `close_args`, the selected item id (`-` on
a header) and the search the user last chose an item with (cleared when the user ends a search without choosing one),
joined by spaces, so a mod can reopen the panel where the user left it. A call with the title of the caller's open panel
replaces it in place and keeps its tab (also across a tab-less panel such as a confirmation), selected item and search;
another title opens a new panel over it, and Esc returns to the one below. Only the user's own commands and panel
actions open panels (`host_operation_user_only` elsewhere). Returns `{shown: true}`.

A package or settings change (`packages.apply`, `settings.write`) reloads mods, and the rest of that callback's
panel calls fail with `callback_cancelled`. When a command that changed packages or settings finishes, every open
panel's `action.command` runs again with its `args` alone, bottom panel first, so each mod redraws its panels from
current state; keep anything the redraw needs, such as a result notice, in `api.uiState` or in `args`.

## `terminal.notice`

`terminal.notice {text, kind?, placement?, ...}` (`ui_controls_v1`) shows a notice of at most 512 bytes attributed
to the mod. `kind` is `info` (default), `warning` or `error`.

| `placement` | Where |
| --- | --- |
| `placement: 'toast'` (default) | Below the composer notes. |
| `placement: 'status'` | In the status row (first 40 characters). |
| `placement: 'transcript'` | Appends a log notice to the transcript that never reaches the model unless `audience: 'model'`. |

Toast and status notices:

- Each lasts `ttl_ms` (1,000 to 60,000, default 5,000).
- At most 4 per mod; a new notice with the same `id` replaces the old one.
- `{id, placement, clear: true}` removes it early and returns `{cleared}`.

Transcript notices:

- `audience: 'model'` also adds the text as mod-provided context to the thread's next model request and every retry
  of it until a response completes. At most 8 are queued per thread (`model_context_queue_full`); with
  `model_request` interceptors' inserted sections, at most 8 per request, the rest waiting for the next one.
- `tool_call_id` draws a transcript notice beneath that tool call's cell in the owned transcript, or as a notice
  naming the call in inline mode or when no drawn cell holds the call.

## `terminal.pty`

`terminal.pty {action: 'start' | 'write' | 'read' | 'stop', session}` starts an interactive shell from a user
command after confirmation, in the session sandbox without network (macOS) with a scratch `HOME`.

`start` accepts:

| Field | Meaning |
| --- | --- |
| `program`, `argv`, `sha256` | May name a program (`pty_programs_v1`). |
| `write: true` | Lets the pane write the workspace; needs `fs.write`. |
| `network: 'loopback'` | Lets it reach services on this computer only; needs `network`. |

The confirmation names the program, write and network access and that the mod can type into the pane.

With the `os` grant, `sandbox: 'none'` starts a listed program unsandboxed with the real `HOME` (no `write` or
`network` fields), skips the per-start confirmation and stops when the grant ends.

Sessions:

- Belong to the calling mod, thread and admitted generation (`pty_panes_per_mod` in `host.json` `mod_limits`: four by
  default, up to sixteen, and sixteen in all).
- Render only in terminal components owned by that mod.
- Stop when the thread, repository, permission context or admitted generation changes, or the mod unloads.
- Queued requests and terminal input retain their original binding and cannot address a replacement session.
- A focused `terminal` component receives keys; Ctrl+] (or Ctrl+5) leaves it.

## Terminal identity (`terminal_identity_v1`)

The `terminal` input carries a read-only `identity` (`terminal_identity_v1`):

- `codex_version` from the installed build;
- `omd_version`, the installed OMD release, such as `1.2.0` or `1.3.0-rc.2` (experimental);
- `install_profile` (`full`, `platform_only`, `private`, `unknown` or `unreported`);
- effective `mode` (`omd`);
- installed, enabled, active and failed mod counts.

Upstream-style direct mode loads no mods.

## `terminal` event `client`

The `terminal` event carries `client: {kind: 'terminal', graphics, pointer, reduced_motion, cell_px, columns,
rows, sites?}` and, with external clients attached, `clients` (see
[Capabilities and fallback](omd-client-protocol.md#capabilities-and-fallback)):

| Field | Meaning |
| --- | --- |
| `graphics` | `kitty` (pixel images), `iip` (iTerm2 inline images: Orca, iTerm2, WezTerm), `cells` (half-block) or `text` (`NO_COLOR`). |
| `pointer` | `half_cell`, `cell` or `none` (no mouse capture: tmux, `OMD_TUI_MOUSE=off`, inline viewport). |
| `reduced_motion` | Follows `tui.animations` and the system setting, and mods that animate stop when it is true. |
| `cell_px` | The measured cell size or null. |
| `columns` and `rows` | The terminal grid. |
| `sites` | `terminal_site_area_v1` (an experimental field): `{[site]: {columns, rows}}` for each of the receiving mod's own `mod/site` sites the last frame drew as a layout leaf or an overlay, the cells its components got inside the frame's border, padding and title. Absent when the last frame drew none; sites stacked in the sidebar are not listed. |
| `welcome` | `terminal_welcome_area_v1`: `{columns, rows}` of the blank area a `welcome` site gets this frame (the chat width beside any sidebar or dock, by the unused transcript height), or null when the welcome cannot show. Size welcome content from it; a change renders the view again. |
| `chat` | `terminal_chat_area_v1`: `{x, y, columns, rows}` of the chat column this frame (the conversation and prompt box, beside any sidebar, dock or layout region), or null before the first fullscreen draw. Place art relative to the conversation with it; a change renders the view again. |
| `colors` | `terminal_colors_v1`: the colors the terminal shows, `truecolor`, `256` or `16`. |

`client` is null without a terminal client. When any of these change (the window or font is resized, animations are
turned off) the view renders again with the new `client`; a burst of changes renders once per render in progress.
A drawn site's area renders the view again the same way, except when it returns within a second to the area it had
before the last change, as a view that sizes its own layout from `sites` would cause.
