# Terminal UI

How a mod draws in the terminal client: render hooks over native components, the startup presentation, the terminal
surface (layouts, documents, images, rasters, pointer events, overlays, the box model, prompts, notices and PTY
panes), and terminal identity. Read it when a mod restyles native output or adds panes, dialogs, sites or controls.

## Render hooks (`render_hooks_v1`)

### Render interceptor and hook results

`api.intercept('render', {match: {component: 'tool_call'}}, async (e, next) => …)` draws one native terminal
component instance. `e` is `{component, id, surface, viewport: {columns, rows}, lifecycle, owner, props}`:

| Field | Meaning |
| --- | --- |
| `surface` | `inline` or `fullscreen`. |
| `lifecycle` | `live` while the component can still change and `final` once it cannot. |
| `owner` | `null` for host components. |

`next(e)` resolves to `{tree}`; the host's own drawing is `{type: 'native', style?}`. A hook can:

- observe: return what `next` returned;
- restyle: `style` takes `tone`, `bold`, `italic`, `underline`, `fg`, `bg`;
- wrap: place the native node in a tree;
- replace: return a tree without it;
- hide: return `{tree: []}`.

Trees hold `box`, `line`, `text`, `markdown`, `code`, `diff`, `list` and `native` components (64 components, depth
6, unique ids, 64 KiB); the native node appears at most once. Hooks compose as one continuation chain in
interceptor order, so unrelated wrappers nest, and each hook sees the props the hook before it passed on.

### Render components

| `component` | `id` | Props (`RenderProps`) | Rewritable |
| --- | --- | --- | --- |
| `user_message` | content digest | `text`, `images`, `spoken` | — |
| `assistant_message` | content digest | `text`, `first`, `truncated` (the host cut `text` at 48 KiB; streamed chunks and the final message; the streaming tail is `live`) | — |
| `tool_call` | call ID (row ID for agent rows; `explore:<first call ID>` for an exploration group) | every agent tool row (`RenderToolCall`); see [`tool_call` props](#tool_call-props) | — |
| `tool_result` | call ID | `tool`, `success`, `text` (MCP results inside their call) | — |
| `spinner` | `main` | `header`, `elapsed_seconds`, `details`, `message`, `interrupt_hint` | `header` |
| `turn_duration` | `turn-<completed ms>` | `seconds`, `completed_at_ms` | — |
| `notice` | content digest | `kind` (`info`/`warning`/`error`), `text`, `hint` | `text` |
| `session_mode` | `collaboration` | `mode`, `label`, `cycle_hint` | `label` |
| `composer_hint` | `placeholder` / `footer` | `slot`, `placeholder`, `input_enabled` / `mode`, `text`, `task_running` | `placeholder` |
| `question` | item ID or content digest | `questions` (`id`, `header`, `question`, `secret`, option labels), then `current`, `queued` (live) or `answered`, `interrupted` (final) | — |
| `list` | view ID | `view_id`, `title`, `subtitle`, `items`, `selected` | — |

### `tool_call` props

Every agent tool row (`RenderToolCall`) carries `call_id`, `kind`, `status` (`running`/`completed`/`failed`/
`interrupted`), `duration_ms` and `expanded`, and per kind:

| `kind` | Props |
| --- | --- |
| `exec` | `command`, `parsed`, `exit_code`, `output_lines`, `output_tail`, `user_shell` |
| `explore` | `calls` (grouped reads, searches and listings) |
| `patch` | `files` (`path`, `change`, `added`, `removed`), `error` |
| `web_search` | `action`, `query` |
| `agent` | `tool`, `agents`, `prompt` |
| `mcp` | `server`, `tool`, `arguments`, `output_lines` |
| `dynamic` | `tool`, `arguments`, `output_lines` |
| `image` | `tool`, `path`, `prompt` |

Group and file limits:

- Exploration groups contain at most 32 calls; larger sequences split into additional rows without dropping calls.
- Patch `files` contains at most 32 details; `file_count`, `added` and `removed` are complete totals across all
  changed files.

### Grouped members

Grouped exploration and computer activity offer each member through `tool_call` as `exec` or `mcp`.

- When those member hooks replace the drawing, each member has its own focus, pointer region and `expanded` flag;
  `next` draws a collapsed member as its compact row, and Find searches every member expanded.
- Native grouping remains when no member is replaced.
- Aggregate exploration rendering remains available on the group when member rendering does not replace it.

### Render hook behavior

Text props carry at most 48 KiB; a content digest is stable across resume and reflow, so equal content draws
identically. Tool rows are offered from live cells and committed history.

- In the fullscreen transcript a hooked tool row needs no control row: F4 focuses it and Enter, →/← or a click
  opens and closes it, and `expanded` is `true` while it is open and for every row of the full transcript (Ctrl+T),
  so a hook that shortens rows returns `next(e)` then.
- Selection copies what is drawn; raw mode never runs hooks.
- Approval overlays have no render hook: their identity, decision text, options, focus and grants stay native, and
  `surface_styles.approval` only paints the frame.
- A question hook changes the presentation only; answers, focus and keys stay with the native dialog.
- The existing panes, `above_composer` band and named sites stay declarative views.

### Render callback runtime

Render callbacks get no host operations and cannot write state (`render_side_effect_refused`; a write during
activation stays local to that render); read `api.state` or atoms instead.

- Renders run in a runner that stays activated while the package revision, settings and persisted state stay
  unchanged. Changing state requires a new activation.
- Stateless renders can reuse the runner across rows, including renders that call `next`. Activation-local state is
  restored before each reused render. Module variables may survive between renders, so never draw from them.
- A tree lives until its input changes or a state key its hooks read changes. Live components redraw asynchronously
  and keep their last tree until the new one arrives, fullscreen transcript cells redraw the same way, and inline
  scrollback, which is written once, waits for each cell's hooks as it is inserted. A narrower or wider terminal is
  a new input.
- A hook that throws, times out or returns an invalid tree is skipped with the input it received, so the native
  drawing survives. A disabled or failed mod's hooks are gone at once, and every failed render joins the status
  `chains` log.
- With no `render` interceptor the host never calls a mod while drawing.

## Startup presentation (`terminal_welcome_v1`)

### Presentation value

The terminal event's read-only `presentation` is `{thread_id, phase, surface?}`.

- `surface` is `fullscreen` when the terminal client draws on the alternate screen and `inline` otherwise (inline
  sessions never draw the `welcome` site); it is absent until the client has chosen its screen mode.
- A new thread is `fresh`, an accepted native turn start makes it `started`, and a resumed or forked thread is
  `resumed`, from existing host markers before the first ready publication.
- Before the first editable frame, a repeatable `event: 'startup'` callback has `ledger: null` and a null
  `thread_id`; its phase comes from the host's new/resume/fork selection.
- Native task, app and paid operations are unavailable through the host boundary.
- Before local presentation is available, the whole presentation value may be absent or null.

This is a presentation refresh, not a once-only session or turn event. Composer input, submission rejection,
ordinary view refreshes, and mod reload do not reset it. It describes the host session; mods do not need to persist
their own first-turn flag. A locally queued draft is not an accepted turn. Empty bootstrap snapshots preserve the
initial view; real disabled, broken or reloaded publications replace it.

### `welcome` site

The reserved `welcome` site renders bounded generic components centered in the owned transcript's unused area.
`welcome: {show_while_composing: true}` keeps the site visible with a draft, including while the slash-command, file
or mention popup is open; the default shows it only with an empty composer.

- Accepted/running and resumed sessions, transcript selection/search, raw output and overlays suppress it.
- Any history beyond the startup header and notices (a command's output, a rejected submission) hides it until a new
  thread, like Codex's own welcome.
- Approvals and input retain their space; if no blank space fits the components, the site does not draw.
- Inline output retains the native transcript without the centered decoration.
- No welcome site preserves Codex's normal blossom policy.

### Title suffix and greeting

- `session_title_suffix` appends up to 80 visible characters to the upstream version heading, including inline/raw
  output; the host keeps its source-backed version and attribution.
- `greeting` overrides the startup phrase with up to 256 visible characters, and an empty string hides it.

Both are last-writer scalars in dependency order, then mod ID order, so a later opt-in theme can override an
earlier presentation default. Escape/control injection is refused. Disable, a broken mod, or direct mode restores
the upstream fields.

## Terminal surface (`terminal_surface_v1`, `terminal_media_v1`, `terminal_prompt_v1`, `terminal_pty_v1`)

### Selection and clipboard

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

### Appearance primitives

The appearance additions (`terminal_surface_paint_v1`, `terminal_image_sample_v1`, `terminal_import_lifetime_v1`)
remain generic presentation primitives.

#### Surface paint

`surface_styles.composer` and `.approval` accept a `TerminalSurfacePaint` with `top`, `bottom`, `foreground`,
`border` RGB/indexed colors and `opacity` from 0 to 1.

- Background colors interpolate vertically and blend with existing colors.
- The foreground is independent of background opacity; reset foregrounds get a readable color against the surviving
  background. Explicit native foregrounds and special backgrounds remain.
- Borders use blank edge cells and disappear at zero opacity.
- `NO_COLOR` omits styling.
- Inline rendering uses the current bounded viewport; it does not repaint earlier terminal scrollback.
- `approval` frames native approval prompts and mod confirmations; their text, options, default selection, focus
  and grants stay host-owned.

Surface paints compose by surface name with the later contributor replacing that surface's paint.

#### `terminal.image_sample`

`terminal.image_sample {resource, columns, rows}` returns `{width,height,rgba}` (row-major RGBA bytes) for a
caller-owned PNG/JPEG.

| Limit | Value |
| --- | --- |
| Columns | integers 1..120 |
| Rows | 1..60 |
| Source size | at most 8 MiB |
| Source dimensions | 4096 pixels per dimension |
| Decoder allocation | 64 MiB |

A mod can implement ASCII ramps or image inspection without a new file read.

#### Import lifetime

`terminal.import_file` adds `lifetime: thread|package` (default thread).

- Package imports retain repository, owner, exact source and immutable content identity across settings/reload/new
  threads.
- A source change requires a new confirmed import. The original path is never reread.
- Existing blob and resource quotas apply; removing the mod store removes retained assets.

Keeping settings, selected assets and image-to-ASCII conversion in a mod lets outside authors use the same APIs for
document viewers, image previews, warnings, watermarks and dashboards.

### Layouts and component types

Views may declare a `layout` tree of splits and tabs with transcript, composer and mod-named sites (`mod/site`).
Components add `document` (up to 100,000 lines with anchors, selection and find), `diff`, `image`, `raster` and
`terminal` (a PTY session).

Updating only a document's anchors updates activation targets without resetting its cursor, selection or scroll,
including when source-backed text is unchanged.

### `image` component

An `image` places a Kitty graphics image in its cells, aspect-fit to the measured cell size.

| Renderer | Where |
| --- | --- |
| Kitty graphics image (Unicode placeholders, so it scrolls, clips and hides under dialogs and overlays like text) | local Kitty and Ghostty |
| iTerm2 inline image (`iip`) | local Orca, iTerm2 and WezTerm |
| Truecolor half-block cells | elsewhere |
| Alt text | under `NO_COLOR` or below 4 columns |

Each image component has its own image id; replacing or removing the component deletes it, and exit and suspend
delete every image.

### Image formats and pixel mapping

Images decode at most 8 MiB, PNG or JPEG, 4,096 pixels a side (`terminal_raster_v1`). An SVG `image`
(`svg_assets_v1`) draws `[image unavailable: alt]` in the terminal, which has no SVG rasterizer; external renderers
receive the same resource and draw it natively.

Either way the image is aspect-fit into the component's cells from its top-left cell (Kitty with `client.cell_px`,
or 8×16 when unknown; half-block cells count as 1×2 pixels), so a mod can map `pointer` cells, and `half` rows, on
an `image` back to image pixels.

### Span styles

Spans accept `fg` and `bg` theme colors, `italic` and `underline` (`terminal_style_v1`); `document` keeps span
styles.

### Component key and paste input (`terminal_input_v1`)

A `pane` or `document` with `keys: true` (`terminal_input_v1`) forwards keys and pastes while focused as
`component_event {kind: 'input', events}`, each event `{key, text}` or `{paste, truncated?}` (a paste is at most
64 KiB).

| Limit | Value |
| --- | --- |
| Events per batch | at most 64 events and 64 KiB; input waiting for one component arrives in order as one batch, so a slow callback adds at most one batch of lag |
| Queued events | beyond 256 queued events input is dropped and the next batch reports `dropped` |

Leaving the component:

- Ctrl+] leaves the component (terminals without the kitty keyboard protocol send it as Ctrl+5, which also leaves).
- Ctrl+C leaves it and keeps its native meaning (interrupt or quit).
- Esc goes to the mod and leaves the component or closes the dialog.
- `keys: 'all'` (`terminal_focus_v1`, also on `module`) forwards Esc and Ctrl+C too, so only Ctrl+] (or Ctrl+5)
  leaves. Key contexts of the component's site owner that name its site get each key first.

Input callbacks run in the terminal process with read-only workspace access, and the view redraws as soon as one
changes the mod's state. A key that must write (a save) publishes an `events.publish` hop whose `channel` callback
runs with the session's access.

Terminal-side callbacks (slash commands, input) run beside the session, so their hop can arrive before their own
`api.state` write lands: keep the request in state and, when the `channel` callback does not find it yet, serve it
from a short `events.schedule` timer.

The mod owns the buffer, cursor and selection and draws them as spans; a key `document` keeps its scroll across
content changes and scrolls to `selected`. A paste into a focused `terminal` component goes to the PTY, bracketed
when the program asked for it.

### Layout region sizing, split resize and tab select

In a layout region, `terminal`, `document`, `diff`, `list` and `raster` components without a `height` share the
rows left after the region's other components and gaps. In a row layout each gets the region's full inner height.

- Releasing a mouse drag on a split border sends `component_event {kind: 'resize', component, ratio}`, where
  `component` is the split's path (`r` for the root, then `.N` per child index) and `ratio` its new percentages, so
  a mod can keep the ratio in its layout.
- Clicking a tab title switches the tab and sends `component_event {kind: 'select', component, index}` with the
  `tabs` node's path (`terminal_tabs_v1`), so the owner can keep `active` in its layout.

Both go only to the mod whose view supplied the layout.

### View keybindings and command ownership

View `keybindings` accept `Ctrl+`, `Alt+` and `Shift+` combinations of letters, digits, F2–F12 and named keys
(`Up`, `PageDown`, `Enter`, ...), except terminal control keys and Shift+Tab; a binding that collides with a native
key is ignored with a warning.

On macOS, Kitty and Ghostty send Option+letter as a composed character (`π` for Option+p) unless Option-as-Alt is
enabled (`macos_option_as_alt` in Kitty, `macos-option-as-alt` in Ghostty), so an `Alt+` binding should not be a
control's only affordance: name its slash command next to it in the hint.

Key bindings and component actions run only the contributing mod's commands: a bare name is its own `id:name`, and
a binding or control naming another mod's command is dropped.

### Focus regions, key contexts and help (`terminal_focus_v1`)

With a view `layout`, the host computes focus regions every frame. The chat (transcript and composer) is region 0
and each drawn `site:` leaf is a region named by its site, numbered from 1 in layout order; only a `tabs` node's
active tab counts.

- A `{region}` key action moves focus without a mod callback: `left`, `right`, `up` and `down` pick the nearest
  region on that side, `next` and `previous` cycle in layout order, `chat` or `0` returns to the chat, a number
  from 1 to 12 is that site region and a site name focuses that region. A region gets back the control last focused there, else its
  first control that is not a keys component or terminal, else no control.
- The focused region's frame draws in the accent color, or with its leaf's `style.focus` accent.
- While a region has focus, keys it does not bind never reach the composer. Ctrl, Alt and F-keys still reach
  `keybindings` and native shortcuts, and native prompts such as approvals keep their keys.
- Esc in a region returns to the chat. Ctrl+] in a region returns to the chat, or from a focused keys component or
  terminal to its region; in the chat it focuses the last region (else the first) when the view has key contexts.
  Clicking a region or a control in it focuses the region, and pastes into a focused region never reach the
  composer.

View `key_contexts` bind keys that apply only while `when` holds, at most 8 contexts and 32 keys per mod (16 and 128
composed):

| `when` field | Holds when |
| --- | --- |
| `focus` | One name or a list: `chat`, `site` (any site region or a control in any site) or a site name. Omitted, anywhere. |
| `composer` | `empty` or `draft`, by the composer's text. |

- A context that cannot hold in the chat may also bind unmodified keys: named keys, Shift+Tab and single printable
  characters (`h`, `1`, `[`, `?`, `G`). A context that can hold there takes `keybindings` key names, and there a key
  that collides with a native binding is ignored as in `keybindings`.
- A binding is a key action or `{action, label}`; `label` (at most 64 bytes) names it in the help overlay.
- Contexts of the focused site's owner (the `owner` of `owner/site`) match first, then the others in composition
  order. A focused control keeps Enter, Space, Up, Down and a select's Left and Right.
- `{region}` and `{help: true}` also work in `keybindings`; commands follow the ownership rule below.

`{help: true}` opens a host overlay listing the bindings that apply to the focused region with their labels and
owning mod, then `keybindings` and the host keys. `/` searches, Up and Down (or `j` and `k`) move, Enter runs the
selected binding and Esc clears the search or closes the overlay.

### `component_event`

`component_event`, `view` and `focus` report interaction. `component_event` goes only to the component's owner and
also reports, with `origin` `user` or `mod`:

| Event | Reports |
| --- | --- |
| `focus` and `blur` | Focus changes. |
| `change` | An input's or select's new `value` or a multiselect's checked `values`, on every edit. |
| `scroll` | A pane's `offset`. |
| `pointer` | Cell-relative `{column, row, action, button}`. |
| `open` / `close` | Panes and dialogs (`ui_composition_v1`). |

Every `component_event` carries the `thread_id` of the session thread it came from (null before the session has
one), and a `state_scope: "thread"` owner's callback runs with that thread's state.

These events wait in order behind a slow callback; beyond 256 waiting events new ones are dropped and the next
delivered event reports the count as `dropped`.

### Component modules (`component_modules_v1`)

Component modules need the feature `component_modules_v1`, which `mod_host_check.py --static`
requires of any package that calls `api.component`.

`api.component(module, {init?, view, key?, pointer?, every?})` is registered during activation under the `terminal`
capability (at most 16 per mod) and draws `{type: 'module', id, label, module, props?, height?, keys?, pointer?}`
nodes.

#### Component module lifecycle

Each mounted node runs in its own runner that stays alive while the node is in the view, so `init(props, ui)` runs
once and the state handlers return carries over between frames (returning `undefined` keeps it).

- At most four nodes are mounted at once for the terminal and four for each external client; a fifth node draws a
  `component_limit` error line and no mounted runner is evicted for it.
- Handlers are synchronous; a returned promise fails with `component_handlers_must_be_synchronous`.
- In the terminal, removing a node or changing its owner or module starts a new mount. Results, retries and
  undelivered posts from the previous mount are discarded.

#### Component module steps

A step runs at most once per 16 ms frame and only when something is pending: a mount, new props or size, queued
input, or a due `every: {ms, tick}` tick.

- `every` ticks run from 16 ms to 24 h, with at most 8 missed ticks caught up.
- `ms` may be a function of the state, and `null` pauses ticks, so a paused module costs nothing until input or new
  props arrive.

#### Component module handlers

- `key(state, {kind: 'key', key, text})` receives keys while the node, given `keys: true`, has focus from a click
  or Tab (Esc and Ctrl+] return focus; pasted text arrives as one event with `key: null`).
- `pointer(state, {kind: 'pointer', column, row, action, button})` receives pointer events over the region with
  `pointer: true`, consecutive moves coalesced.
- `view(state, ui)` returns a render tree (`box` without style, `line`, `text`, `markdown`, `code`, `diff`, `list`;
  at most 64 components, depth 6, 64 KiB).

`ui` is `{columns, rows, props, post(data)}`, where `rows` is the node's `height` and 0 when it has none (auto
height). `post` hands the mod's `component_post` hooks `{component, module, data}` at most once per frame (a later
post in the same frame replaces it; 64 KiB).

#### Component module authority and failure

- Handlers have no host authority (`host_operation_unavailable`, `time.sleep` included, and no `host_operation`
  hook or interceptor sees the attempt) and cannot write state, but `api.state.get()` and `api.uiState.get()` read
  the current values at every step.
- A throw, three consecutive steps over 8 ms after the mounting one (`component_overrun`) or an invalid tree
  unmounts the node, which then draws one dim error line (the error's first line) until the next view revision
  mounts it again. A failed step never counts toward the mod's [fault limit](packages-and-limits.md#fault-limit).
- Without `height` the region is as tall as its latest tree.

#### Component modules for external clients

External clients read a node's tree with `omd/render {slot: 'module', props: {component, columns?, rows?}}` (their
own instance, sized as given or as last rendered, 80 columns and rows 0 by default; `effective.next_ms` says when
the next tick is due) and send it key and pointer events through `omd/client/event`.

Their posts reach `component_post` as `{component, module, client, data}` (hooks there make the same host
operations `component_event` hooks make, on either surface), and detaching unmounts their instances.

### Raster, pointer and overlays (`terminal_raster_v1`)

#### `terminal` event `client`

The `terminal` event carries `client: {kind: 'terminal', graphics, pointer, reduced_motion, cell_px, columns,
rows}`:

| Field | Meaning |
| --- | --- |
| `graphics` | `kitty` (pixel images), `iip` (iTerm2 inline images: Orca, iTerm2, WezTerm), `cells` (half-block) or `text` (`NO_COLOR`). |
| `pointer` | `half_cell`, `cell` or `none` (no mouse capture: tmux, `OMD_TUI_MOUSE=off`, inline viewport). |
| `reduced_motion` | Follows `tui.animations` and the system setting, and mods that animate stop when it is true. |
| `cell_px` | The measured cell size or null. |
| `columns` and `rows` | The terminal grid. |

`client` is null without a terminal client. When any of these change (the window or font is resized, animations are
turned off) the view renders again with the new `client`; a burst of changes renders once per render in progress.

#### `raster` component

`{type: 'raster', id, label, alt, width?, height?, pointer?}` is a keyed canvas of 1–200 × 1–40 cells that shows
`alt` until its first frame and clips to the component's width.

- An omitted `width` fills the region's width.
- An omitted `height` shares the rows left in a layout region like `terminal`, `document`, `diff` and `list` (12
  elsewhere).
- A fill raster's size is the one it last rendered at, and a cells `terminal.blit` before its first render is
  `terminal_blit_unknown`.
- A mod holds at most 16 rasters: a blit to a 17th key is `terminal_blit_limit`; a raster's frames are dropped with
  its component.

#### `terminal.blit` cells

`terminal.blit {key, rect: {x, y, width, height}, cells}` updates part of the caller's own raster (`key` is its
id). `cells` lists the rect's cells row by row, each a one-cell glyph or `[glyph, fg, bg]` with theme colors or
null.

| Error | When |
| --- | --- |
| `terminal_blit_not_owned` | The raster is another mod's. |
| `terminal_blit_unknown` | The terminal has not received the raster in a view yet, such as one returned by the same callback. |
| `terminal_blit_too_large` | One call is over 256 KiB. |
| `terminal_blit_limit` | A blit to a 17th key. |

Updates queue per raster and apply one per 16 ms frame, so a timer tick can enqueue an animation. At 32 queued
updates or 256 KiB the call returns `{status: 'backpressure', retry_after_ms}` instead of `{frame, queued,
frame_ms}`.

#### `terminal.blit` images

`terminal.blit {key, image: {media_type: 'image/png' | 'image/jpeg', base64}}` (instead of `rect` and `cells`)
shows a raster you own as one transient picture, aspect-fit from the top-left cell into the raster's width × height
cells by the same rule and renderers as `image` (Kitty placeholders, iTerm2 inline images, truecolor half-blocks,
`alt` under `NO_COLOR`).

- The newest frame replaces the previous one, a cells blit replaces the frame and a frame replaces the cells.
- It is never stored as a resource, so prefer it to a new `image` resource per frame (which exhausts the record
  quota) or to cells (about 200 × 80 effective pixels).
- External clients whose renderer `formats` include the media type receive the frame as sent, other clients with
  `cells` receive half-block cells.

| Error | When |
| --- | --- |
| `terminal_blit_image_invalid` | A wrong media type, bad base64 or an image that does not decode within 4096 px per side. |
| `terminal_blit_invalid` | Both or neither of `image` and `rect`/`cells` are passed. |

Both refuse before queueing.

#### Pointer events

`box`, `pane`, `image` and `raster` accept `pointer: true`. The owner then receives `component_event {kind:
'pointer'}` with:

- `action` `enter`, `leave`, `move`, `down`, `up` and `drag`;
- `column`/`row` relative to the component's first cell (a nested box counts its title and children);
- `half` (0 or 1, the half-cell row) on terminals that report pixel positions (Kitty, Ghostty and WezTerm), else
  null.

A press captures the pointer until release, so `drag` and `up` reach the component outside its cells with
out-of-range or negative coordinates. Motion is latest-wins per component: a slow callback sees the newest
position, never a backlog. Views with no pointer components add no pointer work.

#### Overlays

A mod-named site (`mod/site`) with `overlay: {anchor, offset?, width, height, z?, clip?, style?}` draws above the
layout instead of in the sidebar.

| Field | Meaning |
| --- | --- |
| `anchor` | A screen corner (`top_left`, `top_right`, `bottom_left`, `bottom_right`) or `center`, or `{component}` (the component's top-left cell; the overlay is skipped while that component is not drawn). |
| `offset` | Moves the overlay by cells. |
| `z` | 0–9; orders overlays. |
| `clip` | `clip: 'anchor'` clips it to the anchor component's cells, otherwise to the screen. |

- An overlay hides what lies beneath it from pointer events, and a dialog stays above every overlay.
- A view with an overlay outside these bounds is invalid: `width` 1–200, `height` 1–60, `offset.x` within ±500,
  `offset.y` within ±200, and a screen anchor cannot use `clip: 'anchor'`.
- Overlays are not exclusive: when several patches set one for the same site, the patch that composes last wins,
  and a `wrap` patch overrides another mod's overlay without a claim or a `terminal.conflicts` entry.

### Box model (`terminal_box_model_v1`)

One `style: TerminalBoxStyle` object styles a `box`, `pane` or `dialog`, an overlay, a layout `site:` leaf and, as
`sidebar_style`, the sidebar.

- `border`: `none`, `plain`, `rounded`, `double` or `thick`; a title sits in the top edge. Under the theme's
  `icons: 'ascii'`, `OMD_TUI_ASCII=1`, or a non-Unicode locale, every border draws as `+`, `-` and `|`, and
  markers, cursors and separators draw in ASCII too.
- `padding` and `margin`: cells on every side, or `[vertical, horizontal]`, each 0–4.
- `gap` (0–4) separates children: rows in a column, cells in a row.
- `background` and `foreground`: a tone (`accent`, `muted`, ...) or a color (0–255 or `#rrggbb`). A filled or
  bordered box pads its rows to its width, so the fill reaches the edge; other boxes leave rows unpadded.
- `direction: 'row'` lays children side by side (see [Row layout](#row-layout)).
- `hover` and `focus` take `{border?, background?, foreground?}` on a `box` or `pane`, and `focus` on a layout
  `site:` leaf while its region has focus; other surfaces refuse them
  (see [Hover and focus accents](#hover-and-focus-accents)).

#### Row layout

With `direction: 'row'`:

- A `button`, `text` or `line` takes its natural width; every other child gets a share of the rest by its `flex`
  weight (1–12, default 1).
- When natural widths exceed the available space, shorter children keep their width and longer children share the
  remaining columns.
- `max_width` caps a child's width and a child with fewer columns than its `min_width` drops out.
- In a column, `min_width`/`max_width` hide the box outside its bounds.

#### Hover and focus accents

- `hover` applies while the pointer is over the box (no `pointer: true` needed; events still need it).
- `focus` applies while the box or a descendant has focus.
- Accents never add or remove a border, so geometry stays put.

#### Default styling

Unstyled panes, dialogs and layout sites are cards: the theme `border`, `padding: [0, 1]` and the title in the top
edge. A pane with `border: 'none'` is a flat panel whose title row leads its content. Unstyled boxes and overlays
draw no frame.

- The sidebar has no padding, one row between its components under the comfortable density, and no border unless
  `sidebar_style` sets one, which then carries the view `title`.
- A split's `gap` (0–4) leaves cells between its children.
- Render hook trees refuse `style` and `flex`.
- The host's progress and mod diagnostics draw as cards above the prompt (four entries each, wrapped to
  six lines, then `+N more`), so the sidebar opens only for a mod's `sidebar` components, `panels` or unplaced named sites.

### Terminal operations

Operations the TUI serves, such as `terminal.panel`, need a running TUI. From `omd-mod command` they fail with
`host_operation_unavailable: requires a native task`. Call them with `api.host.tryCall` and fall back to returning
text.

#### Notifications and commands

- `terminal.notify {title, body?}` uses the configured notification method with a focus condition and a 2 s rate
  limit.
- `commands.list`, `commands.describe` and `commands.invoke` are described in
  [Commands and configuration](commands-and-composer.md#commands-and-configuration-command_config_middleware_v1).
- `sessions.ports` (`session_ports_v1`, `sessions` capability) returns `{ports: [{port, pid, address}]}`: TCP
  listeners owned by the current thread's background terminals and their child processes, read by the host outside
  the mod sandbox (at most 32 ports, 3 s per probe).

#### Threads, imports and composer

`terminal.show_thread`, `terminal.import_file` (confirmed, at most 8 MiB), `composer.read`, `composer.write` and
`composer.suggest` (see [Composer drafts and
suggestions](commands-and-composer.md#composer-drafts-and-suggestions-composer_v2)). The import confirmation shows
the resolved path.

#### `terminal.open`

`terminal.open {url} | {path}` opens an http(s) URL or an existing HTML, Markdown, text, PDF or image file after a
native confirmation.

`{path, line?, editor: true}` (`terminal_editor_v1`) opens a workspace file in the argv the user sets as `editor`
in `host.json`, with `{path}` and `{line}` substituted.

#### `terminal.prompt`

`terminal.prompt {kind: 'confirm' | 'text', title, message, masked?}` asks the user; mods never answer prompts.

`{kind: 'choice', title, message, options: [{value, label}], multiple?, other?}` (`ui_composition_v1`) shows a
native picker of up to 32 options: one value, several with `multiple`, or a typed answer through an `Other…` row
with `other`. It returns `{status: 'accepted', values, other?}` or `declined` when cancelled.

#### `terminal.blit`

`terminal.blit {key, rect, cells}` (`terminal_raster_v1`, experimental) queues a raster update, described in
[Raster, pointer and overlays](#raster-pointer-and-overlays-terminal_raster_v1).

#### `terminal.pane` and `terminal.panes`

`terminal.pane {action, id, offset?}` (`ui_composition_v1`) opens, closes, focuses, scrolls or reveals one of the
caller's own panes, dialogs or controls; another mod's component is `terminal_pane_not_owned`. Scrolling uses
`offset`; a pane shows 8 rows and stops scrolling once its last row is in view.

`terminal.panes {}` (`ui_controls_v1`) returns the caller's own panes as `{panes: [{id, visible, collapsed,
focused, scroll}]}`; a pane is `visible` while its header row was on screen in the last frame.

#### `terminal.panel`

`terminal.panel {title, subtitle?, tabs?, items, search?, action}` (`terminal_panel_v1`) opens Codex's
own list panel in the bottom pane, where `/config` lives. `title` is at most 128 bytes and `subtitle` at most 2,000
bytes of plain text that keeps its line breaks. `tabs` lists up to 8 `{id, title}` (titles up to 32 bytes); with
tabs, every item names its `tab`. `items` holds 1–200 `{id, tab?, label, description?, kind, value?, options?}` with
unique ids without spaces (up to 128 bytes), labels up to 128 bytes and descriptions up to 256 bytes:

| `kind` | `value` | Space or Enter |
| --- | --- | --- |
| `toggle` | boolean | Flips it. |
| `choice` | one of `options`, 1–32 `{value, label}` with unique values without spaces | Moves to the next option. |
| `text` | string up to 2,000 bytes | Opens Codex's single-line prompt; an empty answer is ignored. |
| `action` | none | Runs the action. |

Each change runs the caller's command `action.command` with `args`, the item id and the new value joined by spaces
(`set bars true`), and the panel shows the new value at once. Up and Down move and repeat while held, Left and Right
switch tabs, `/` searches labels, descriptions and tab titles across every tab when `search` is true, and Esc clears
the search or closes the panel. A call with the title of the caller's open panel replaces it in place and keeps its
tab (also across a tab-less panel such as a confirmation), selected item and search; another title opens a new panel
over it, and Esc returns to the one below. Only the user's own commands and panel actions open panels
(`host_operation_user_only` elsewhere). Returns `{shown: true}`.

A package or settings change (`packages.apply`, `settings.write`) reloads mods, and the rest of that callback's
panel calls fail with `callback_cancelled`. When a command that changed packages or settings finishes, every open
panel's `action.command` runs again with its `args` alone, bottom panel first, so each mod redraws its panels from
current state; keep anything the redraw needs, such as a result notice, in `api.uiState` or in `args`.

#### `terminal.notice`

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

#### `terminal.pty`

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

- Belong to the calling mod, thread and admitted generation (four per mod, sixteen in all).
- Render only in terminal components owned by that mod.
- Stop when the thread, repository, permission context or admitted generation changes, or the mod unloads.
- Queued requests and terminal input retain their original binding and cannot address a replacement session.
- A focused `terminal` component receives keys; Ctrl+] (or Ctrl+5) leaves it.

#### `builtins.invoke` and `api.builtins`

`builtins.invoke {action}` runs a key action from user contexts. It is refused (`builtins_view_active`) while a
dialog, popup, overlay or focused mod component would take the key, and `list.*` and the permission-mode actions
are never invoked (`keymap_action_refused`).

`api.builtins({keys, commands: {replace}})` overlays key bindings (never `approval.*`) and routes a built-in
command to a mod command; the slash popup lists the built-in with that command's description and arguments.

## Terminal identity, rich lines and picker

### Alternate screen, inline mode and composer sites

Terminal views are drawn on Codex's alternate screen, including its default fullscreen transcript. Inline
`--no-alt-screen` sessions draw the sidebar, header and dialogs inside the current viewport, and `render` hooks and
status segments apply to scrollback.

When any mod's view sets `inline_sites: 'hidden'` (`terminal_inline_sites_v1`), the inline viewport omits the
sidebar, header and named sites; dialogs, status segments, mod progress and diagnostics, the composer, approvals
and scrollback remain, and the owned fullscreen viewport is unchanged.

A launcher can narrow one session's TUI with three environment variables. `OMD_TUI_MOD_UI=ID[,ID…]` keeps sites,
panels, header, footer, layout and status segments only from the listed mods; other mods keep their `dialog` site,
`render` hooks, commands, keys and theme, and the status row holds only the listed mods' segments, without upstream
`/statusline` items or the host summary unless a mod failed. `OMD_TUI_HEADER=off` drops the Codex session header and
first-run help, and `OMD_TUI_COMPOSER=plain` draws the composer as a bare prompt line without its background,
blank rows, placeholder or idle hint row. `omd mini` sets all three. They are read once at start, and agent tool
processes don't inherit them or the launcher's `OH_MY_DIFF_*` variables (a mod's `exec_environment` still can).

The `above_composer` and `below_composer` sites draw in both modes, host-sized to their wrapped
components, directly above and below the bottom pane (composer, native hints and status row), with styles, links
and focusable controls. `above_composer` is clipped to 8 rows and `below_composer` to 6, each scrolling to the
focused control. Both are hidden while an approval or popup replaces the composer.

### Terminal identity (`terminal_identity_v1`)

The `terminal` input carries a read-only `identity` (`terminal_identity_v1`):

- `codex_version` from the installed build;
- `install_profile` (`full`, `platform_only`, `private`, `unknown` or `unreported`);
- effective `mode` (`omd`);
- installed, enabled, active and failed mod counts.

Upstream-style direct mode loads no mods.

### Rich lines (`terminal_rich_line_v1`)

`terminal_rich_line_v1` adds a one-row `line` component with up to 12 styled `spans` (`text`, `tone`, `bold`; 256
characters in total), whose `label` is the accessible text, and optional `min_width`/`max_width` (1–500 columns) on
`box` and `pane`.

Native draws a bounded box only when the site's inner width fits, and header height counts only drawn boxes. Header
rows are never spaced by the comfortable density.

### List rows (`terminal_lists_v1`)

`terminal_lists_v1` lets a `render` hook on component `list` replace built-in list rows. The host keeps selection
actions, session state, keyboard handling and native fallback when the mod is absent or fails.

### Copy-on-select and right-click paste

Copy-on-select and right-click paste are Codex settings (`tui.copy_on_select`, `tui.right_click_paste`); mods
change them through `config.write`.
