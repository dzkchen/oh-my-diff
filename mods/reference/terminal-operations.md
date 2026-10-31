# Terminal operations

Use it when a mod calls an operation the terminal serves (notifications, threads and imports, selection and
clipboard, opening files, prompts, panes, panels, notices and PTY sessions) or reads what the `terminal` event
reports about the terminal itself. Raster updates (`terminal.blit`) are in [Graphics](graphics.md).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](stability-and-migration.md#experimental-entries-in-the-registry)). They run in the OMD terminal on
Apple Silicon macOS. Every `terminal.*` operation except `terminal.pty` needs
the `terminal` capability; `terminal.pty` needs `pty`.

Operations the terminal UI serves, such as `terminal.panel`, need a running `codex` terminal. `omd-mod command` has no
terminal, so there they fail with `host_operation_unavailable: requires a native task`. Call them with
`api.host.tryCall` and fall back to returning text.

## Notifications and ports

```text
terminal.notify {title, body?} → {delivered, method, reason?}
sessions.ports → {ports: [{port, pid, address}]}
```

- `terminal.notify` uses the configured notification method with a focus condition and a 2 s rate limit. `method`
  is `osc9`, `osc99`, `osc777`, `bel` or `none`, and `reason` says why nothing was delivered.
- `sessions.ports` (`session_ports_v1`, `sessions` capability) returns the TCP listeners owned by the current
  thread's background terminals and their child processes, read by the host outside the mod sandbox (at most 32
  ports, 3 s per probe).

`commands.list`, `commands.describe` and `commands.invoke` are in
[Commands and configuration](commands-and-composer.md#commands-and-configuration-command_config_middleware_v1), and
the `composer.*` operations in
[Composer drafts and suggestions](commands-and-composer.md#composer-drafts-and-suggestions-composer_v2).

## Threads and imports

```text
terminal.show_thread {thread_id} → {shown}
terminal.import_file {path, max_bytes?, lifetime?} → ResourceRef | {status: 'declined'}
```

`terminal.show_thread` switches the terminal to `thread_id`. `terminal.import_file` imports a file the user confirms,
at most 8 MiB, and returns its resource; the confirmation shows the resolved path. SVG text is labeled
`image/svg+xml` and checked as an [SVG asset](state-and-storage.md#svg-assets-svg_assets_v1).

### Import lifetime

`lifetime` (`terminal_import_lifetime_v1`) is `thread` (the default) or `package`.

- A `package` import stays available across settings changes, reloads and new threads. It keeps its repository,
  owner, exact source and content identity, and the content can't change.
- A source change requires a new confirmed import. The original path is never reread.
- Existing blob and resource quotas apply; removing the mod store removes retained assets.

## Selection and clipboard

```text
terminal.selection {} → {text, truncated}
terminal.copy {text} → {status}
```

`terminal.selection` returns the current selection in the Codex terminal UI, or `text: null` when there is none. It
prefers the visible transcript overlay and never reads obscured transcript text, another client's selection or the OS
clipboard.

- UTF-8 text is capped at 64 KiB and further bounded by its JSON-encoded size so a selection followed by a copy fits one
  callback's [host call transport budget](host-model.md#host-call-transport-budget). Any shortening sets
  `truncated: true`.
- `terminal.copy {text}` uses the native plain-text clipboard backend with the same 64 KiB limit. Its status is
  `confirmed`, `unconfirmed`, `pending` or `busy`; the native host waits for the matching clipboard worker's
  delivery result. `unconfirmed` means the backend cannot confirm delivery.

List `terminal_selection_v1` and `terminal_copy_v1` in `required_features`. Both operations work only from a
callback the local user started, such as a command or a clicked control. They reject calls from event and tool
handlers and from attached clients. Call `terminal.selection` from a clicked component action, as the terminal
example does, because typing a slash command clears the transcript selection before its callback runs.

### Copy-on-select and right-click paste

Copy-on-select and right-click paste are Codex settings (`tui.copy_on_select`, `tui.right_click_paste`); mods
change them through `config.write`.

## `terminal.open`

```text
terminal.open {url} | {path} | {path, line?, editor: true} → {opened: true} | {status: 'declined'}
```

It opens an http(s) URL or an existing HTML, Markdown, text, PDF or image file after a
native confirmation.

`{path, line?, editor: true}` (`terminal_editor_v1`) opens a workspace file in the argv the user sets as `editor`
in `host.json`, with `{path}` and `{line}` substituted.

## `terminal.prompt`

```text
terminal.prompt {kind: 'confirm', title, message} → {status: 'accepted'} | {status: 'declined'}
terminal.prompt {kind: 'text', title, message, masked?} → {status: 'accepted', value} | {status: 'declined'}
terminal.prompt {kind: 'choice', title, message, options, multiple?, other?} → {status: 'accepted', values, other?} | {status: 'declined'}
```

It asks the user; mods never answer prompts. `masked` hides typed text.

`choice` (`ui_composition_v1`) shows a native picker of up to 32 `options` `{value, label}`: one value, several with
`multiple`, or a typed answer through an `Other…` row with `other`. Cancelling returns `declined`.

```ts
const answer = api.host.tryCall('terminal.prompt', { kind: 'confirm', title, message });
```

That call is from [`omd_git`](../first-party/omd_git/index.ts).

## `terminal.pane` and `terminal.panes`

```text
terminal.pane {action: 'open' | 'close' | 'focus' | 'reveal', id} → {applied: true}
terminal.pane {action: 'scroll', id, offset} → {applied: true}
terminal.panes {} → {panes: [{id, visible, collapsed, focused, scroll}]}
```

`terminal.pane` (`ui_composition_v1`) opens, closes, focuses, scrolls or reveals one of the caller's own panes,
dialogs or controls; another mod's component is `terminal_pane_not_owned`. Scrolling uses
`offset`; a pane shows 8 rows and stops scrolling once its last row is in view.

`terminal.panes` (`ui_controls_v1`, experimental) returns the caller's own panes; a pane is `visible` while its
header row was on screen in the last frame.

## `terminal.panel`

```text
terminal.panel {title, subtitle?, tabs?, items, search?, query?, selected?, close_args?, action} → {shown: true}
```

`terminal.panel` (`terminal_panel_v1`) opens Codex's own list panel in the bottom pane, where `/config` is. Only
the user's own commands and panel actions open panels (`host_operation_user_only` elsewhere).

| Argument | Meaning |
| --- | --- |
| `title` | At most 128 bytes |
| `subtitle` | At most 2,000 bytes of plain text that keeps its line breaks |
| `tabs` | Up to 8 `{id, title}`, titles up to 32 bytes; with tabs, every item names its `tab` |
| `items` | 1–200 `{id, tab?, label, description?, group?, keywords?, detail?, kind, value?, options?}`: unique ids without spaces up to 128 bytes, labels up to 128 bytes, descriptions up to 256 bytes |
| `search` | `true` lets `/` search every tab |
| `action` | The caller's command that each change runs |
| `query`, `selected`, `close_args` | Experimental, under [Panel navigation](#panel-navigation-terminal_panel_navigation_v1) |

Item kinds:

| `kind` | `value` | Space or Enter |
| --- | --- | --- |
| `toggle` | boolean | Flips it. |
| `choice` | one of `options`, 1–32 `{value, label}` with unique values without spaces | Moves to the next option. |
| `text` | string up to 2,000 bytes | Opens Codex's single-line prompt; an empty answer is ignored. |
| `action` | none | Runs the action. |

Each change runs the caller's command `action.command` with `args`, the item id and the new value joined by spaces
(`set bars true`), and the panel shows the new value at once.

Keys in the panel:

- Up and Down move and repeat while held, and Left and Right switch tabs.
- `/` searches every tab when `search` is true: labels match fuzzily, best first, then items whose description,
  keywords or tab title contain the query. Esc clears the search or closes the panel.
- Outside a search, a letter moves to the next item whose label starts with it, `g` and `G` go to the first and last
  row, and Home, End, PgUp and PgDn work as in every Codex list.

A call with the same title as the caller's open panel replaces that panel in place. The new panel keeps the open panel's
tab, selected item and search, even across a panel without tabs, such as a confirmation. Another title opens a new panel
over it, and Esc returns to the one below.

### Panel navigation (`terminal_panel_navigation_v1`)

These fields are experimental:

| Field | Meaning |
| --- | --- |
| Item `group` | Up to 32 bytes. Gathers items under a header row with their count, in order of first appearance after any ungrouped items; Space or Enter on the header collapses or expands it. |
| Item `keywords` | Up to 256 bytes, searched but not shown. |
| Item `detail` | Up to 512 bytes, shown below the list while the item is selected. |
| `query` | Up to 128 bytes; opens the panel with that search. |
| `selected` | The item to select first. |
| `close_args` | Arguments for the command that runs when the panel closes |

When the user closes the panel, the host runs `action.command` with `close_args`, the selected item id (`-` on a
header) and the user's last search, joined by spaces. The last search is the one the user last chose an item with,
and it is cleared when the user ends a search without choosing. A mod can use these to reopen the panel where the
user left it.

### Panels after a reload

A package or settings change (`packages.apply`, `settings.write`) reloads mods, and the rest of that callback's
panel calls fail with `callback_cancelled`. When a command that changed packages or settings finishes, every open
panel's `action.command` runs again with its `args` alone, bottom panel first, so each mod redraws its panels from
current state; keep anything the redraw needs, such as a result notice, in `api.uiState` or in `args`.

## `terminal.notice`

```text
terminal.notice {text, kind?, placement?: 'toast' | 'status', ttl_ms?, id?} → {shown: true}
terminal.notice {id, placement?, clear: true} → {cleared}
terminal.notice {text, kind?, placement: 'transcript', audience?, tool_call_id?} → {shown: true, model?}
```

`terminal.notice` (`ui_controls_v1`) shows a notice of at most 512 bytes attributed to the mod. `kind` is `info`
(default), `warning` or `error`.

| `placement` | Where |
| --- | --- |
| `placement: 'toast'` (default) | Below the composer notes. |
| `placement: 'status'` | In the status row (first 40 characters). |
| `placement: 'transcript'` | Appends a log notice to the transcript. Only a notice with `audience: 'model'` reaches the model. |

Toast and status notices:

- Each lasts `ttl_ms` (1,000 to 60,000, default 5,000).
- At most 4 per mod; a new notice with the same `id` replaces the old one.
- `{id, placement, clear: true}` removes it early and returns `{cleared}`.

Transcript notices:

- `audience: 'model'` also adds the text as mod-provided context to the thread's next model request and every retry
  of it until a response completes. At most 8 such notices are queued per thread. Another one fails with
  `model_context_queue_full`. A request contains at most 8 of these notices and `model_request` interceptor sections
  together, and the rest wait for the next request.
- `tool_call_id` draws a transcript notice beneath that tool call's cell in the fullscreen transcript, or as a notice
  naming the call in inline mode or when no drawn cell contains the call.

## `terminal.pty`

```text
terminal.pty {action: 'start', session, cwd?, program?, argv?, sha256?, write?, network?, sandbox?, files?} → {session, running: true} | {status: 'declined'}
terminal.pty {action: 'write', session, text} → {written}
terminal.pty {action: 'read', session} → {text, running, exit_code, files?}
terminal.pty {action: 'stop', session} → {stopped: true}
```

`start` starts an interactive shell after the user confirms. Call it from a user command. The shell runs in the
session sandbox, without network, with a scratch `HOME`.

`start` accepts:

| Field | Meaning |
| --- | --- |
| `program`, `argv`, `sha256` | May name a program (`pty_programs_v1`). |
| `write: true` | Lets the pane write the workspace; needs `fs.write`. |
| `network: 'loopback'` | Lets it reach services on this computer only; needs `network`. |

The confirmation names the program, write and network access and that the mod can type into the pane.

With the `os` grant, `sandbox: 'none'` starts a listed program unsandboxed with the real `HOME` (no `write` or
`network` fields) and stops when the grant ends.

- The host hashes the resolved program and asks once per mod and binary ("Allow and remember"). It starts without
  asking while the hash matches and asks again when the binary changes, for example after a package manager upgrade.
  Pins are in `program-pins.json` in the mod store and are shared with the other unsandboxed starts, as described in
  [Authority grants](authority-grants.md#os_access-manifest-field).
- A declined prompt returns `{status: 'declined'}`. A start that reaches the spawn without that approval or a matching
  pin fails `pty_program_unpinned`.
- The pane gets the environment of an
  [unsandboxed `exec.run`](running-commands.md#execrun-with-sandbox-none), the mod's declared `exec_environment` names
  included, plus `SSH_AUTH_SOCK`, `TERM=xterm-256color` and, on a 24-bit color terminal, `COLORTERM=truecolor`. 24-bit
  colors are drawn at the terminal's color depth.

Each mod can have up to `pty_panes_per_mod` sessions, set in `host.json` `mod_limits` (default four, maximum
sixteen). The host allows sixteen sessions in all.

Sessions:

- Are bound to the calling mod, thread and admitted generation.
- Render only in terminal components owned by that mod.
- Stop when the thread, repository, permission context or admitted generation changes, or the mod unloads. A stop
  hangs up the program (SIGHUP) and kills it 2 s later if it still runs.
- Queued requests and terminal input retain their original binding and cannot address a replacement session.
- A focused `terminal` component receives keys; Ctrl+] (or Ctrl+5) leaves it.

### Terminal pane extension (`terminal_pty_v2`)

`terminal_pty_v2` (experimental) adds:

| Addition | Behavior |
| --- | --- |
| Keys | xterm encodings: F1-F12, PgUp/PgDn, Insert, Home/End, Shift+Tab, modified arrows (`CSI 1;m X`), Alt as an Esc prefix, Ctrl+Space and Ctrl+symbol control bytes, application-cursor mode. |
| Drawing | A focused pane draws its cursor; wide characters take two cells; italic, underline and dim are kept. |
| Links | OSC 8 `http`/`https` links become terminal hyperlinks. |
| Replies | The pane answers device attributes (`CSI c`), status (`CSI 5n`) and cursor position (`CSI 6n`) queries, as a terminal does. |

It also adds the mouse, signal, clipboard, session directory and focus behavior below.

#### Pane mouse input

When the program enables mouse reporting, clicks, releases, drags, motion and the wheel go to it in its encoding
(SGR, UTF-8 or X10) with modifiers. Otherwise the wheel scrolls the pane's scrollback, or sends Up/Down on the
alternate screen.

#### Pane signals

- Title changes (OSC 0/2), the bell and OSC 9 / OSC 777 notifications reach the owner as `component_event`
  `title {title}`, `bell` and `notify {text}` (1 KiB, ten a second).
- The exit arrives once as `exit {session, exit_code, files}`.
- A drawn `terminal` component whose session isn't running (never started, stopped, or ended by the host on a thread
  switch, reload or restart) reports `exit {session, exit_code: null}` once, so the owner can drop its layout.

#### Pane clipboard

An OSC 52 copy asks the user once per pane ("Allow for this pane"), then goes through the terminal's clipboard. A
decline lasts for the pane.

#### Session directory

`start {files: {NAME: text}}` (four files, 16 KiB each, names `[A-Za-z0-9._-]`) writes a private directory. Every
`{dir}` in `argv` is its path. Errors are `pty_files_invalid`.

- The exit event and a `read` after the exit return its top-level regular files (64 KiB in all; symlinks and hard
  links are skipped), including files the program wrote.
- It is removed when the session stops or is replaced. One left behind when OMD quits is removed by the next start.
- Unsandboxed panes keep it in `pty-sessions` in the mod store, out of every sandbox's reach. Sandboxed panes keep it
  in the scratch `HOME` they share, so other sandboxed panes can read it.

#### Pane focus

- `autofocus: true` on the `terminal` component focuses it when it appears while nothing else has focus, and when
  its focus region is entered.
- A focused terminal shows a Ctrl+] hint until the first key. Inside a focus region the first Ctrl+] leaves for the
  region and a second for the chat.
- A key for a terminal whose program has ended leaves it.
- When a focused terminal unmounts, focus returns to where it was before.

## Terminal identity (`terminal_identity_v1`)

The `terminal` input has a read-only `identity` (`terminal_identity_v1`):

- `codex_version` from the installed build;
- `omd_version`, the installed OMD release, such as `1.2.0` or `1.3.0-rc.2` (experimental);
- `install_profile` (`full`, `platform_only`, `private`, `unknown` or `unreported`);
- effective `mode` (`omd`);
- installed, enabled, active and failed mod counts.

In [`direct` mode](glossary.md#stores-and-data), which runs plain Codex with no mods, no `terminal` handler runs.

## `terminal` event `client`

The `terminal` event has `client: {kind: 'terminal', graphics, pointer, reduced_motion, cell_px, columns,
rows, sites?}` and, with external clients attached, `clients` (see
[Renderer capabilities and fallback](omd-client-protocol.md#renderer-capabilities-and-fallback)):

| Field | Meaning |
| --- | --- |
| `graphics` | `kitty` (pixel images), `iip` (iTerm2 inline images: Orca, iTerm2, WezTerm), `cells` (half-block) or `text` (`NO_COLOR`). |
| `pointer` | `half_cell`, `cell` or `none` (no mouse capture: tmux, `OMD_TUI_MOUSE=off`, inline viewport). |
| `reduced_motion` | Follows `tui.animations` and the system setting, and mods that animate stop when it is true. |
| `cell_px` | The measured cell size or null. |
| `columns` and `rows` | The terminal grid. |
| `sites` | `terminal_site_area_v1` (an experimental field): `{[site]: {columns, rows}}` for the mod's own drawn sites |
| `welcome` | `terminal_welcome_area_v1`: `{columns, rows}` of the blank area a `welcome` site gets this frame, or null when the welcome cannot show |
| `chat` | `terminal_chat_area_v1`: `{x, y, columns, rows}` of the chat column this frame, or null before the first fullscreen draw |
| `colors` | `terminal_colors_v1`: the colors the terminal shows, `truecolor`, `256` or `16`. |

- `sites` lists each of the receiving mod's own `owner/name` sites that the last frame drew as a layout leaf or an
  overlay. Each entry is the cells its components got inside the frame's border, padding and title. `sites` is
  absent when the last frame drew none, and sites stacked in the sidebar are not listed.
- The `welcome` area is the chat width beside any sidebar or dock, by the unused transcript height. Size welcome
  content from it.
- The `chat` column is the conversation and composer, beside any sidebar, dock or layout region. Place art relative
  to the conversation with it.
- A change in `welcome` or `chat` renders the view again.

`client` is null without a terminal client. When any of these change (the window or font is resized, animations are
turned off) the view renders again with the new `client`. If several changes arrive while a render is in progress,
the host renders once more after it. A change in a drawn site's area also renders the view again. The exception is
when the area returns within a second to the size it had before the last change. A view that sizes its own layout
from `sites` can cause that loop, so the host skips the render.
