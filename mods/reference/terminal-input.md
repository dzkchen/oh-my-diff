# Terminal input

Use it when a mod takes keys, pastes or pointer events, binds keys, moves focus between regions and controls,
reacts to `component_event`, guards focus changes with `component_change`, or draws with component modules.

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](stability-and-migration.md#experimental-entries-in-the-registry)). They run in the OMD terminal on
Apple Silicon macOS and in [external clients](external-clients.md).

## Input and focus

- A dialog focuses its first item when it opens, or the control it `autofocus`es.
- Tab and Shift+Tab cycle focus while a dialog shows or a control has focus. Otherwise the composer receives them.
- To start cycling, focus a control first with a click, a `hotkey`, `autofocus` or a `{focus}` keybinding.
- Up and Down move within a list, multiselect, document or scrolled pane. At its first or last row, and on any other
  control, they focus the previous or next control.
- Entering a list from above starts at its first row, and from below at its last.
- [Keys components](#component-key-and-paste-input-terminal_input_v1) and `terminal` components are reached with
  Tab once a control has focus, or with a click or a `{focus}` keybinding.
- Left and Right change a `select`.
- While a dialog shows or a control has focus, held arrow, page, Home, End, Backspace, Delete and character keys
  repeat; Enter, Space, Tab and Esc act once per press, and a held key never fires a hotkey or view binding.
- In a dialog, typing that no binding takes goes to its `autofocus` input.
- Esc, Ctrl+] or a click outside releases focus and hides the dialog until a mod command runs, and Esc reaches the
  focused component's owner as `component_event {kind: 'input', events: [{key: 'Esc'}]}`.
- A shown dialog is modal: keys it does not bind never reach the composer behind it (Ctrl+C still interrupts).
- Space on a focused `list` row or `button` activates it like Enter; on a `select` it steps to the next option.
- On a focused `multiselect`, Space toggles the current option and Enter runs its action with the checked values as
  a JSON array argument.
- A `hotkey` on a button, input, select, multiselect or list focuses it (a button runs its action) unless a text
  input has focus. It obeys the keybinding collision rules, is checked before view `keybindings`, and when two
  controls share one the first wins.
- `autofocus` focuses the control when it first appears and nothing has focus, reported as a `focus` event with
  origin `mod`.
- An `input`, `select` or `multiselect` is controlled: the user's edits stay while the view repeats a value, an
  echo of one of the user's own recent values is ignored, and a new `value` from the mod resets the field.

## Component key and paste input (`terminal_input_v1`)

A `pane` or `document` with `keys: true` (`terminal_input_v1`) forwards keys and pastes while focused as
`component_event {kind: 'input', events}`, each event `{key, text}` or `{paste, truncated?}` (a paste is at most
64 KiB). These pages call a `pane`, `document` or `module` with `keys` set a keys component.

| Limit | Value |
| --- | --- |
| Events per batch | at most 64 events and 64 KiB; input waiting for one component arrives in order as one batch, so a slow callback adds at most one batch of lag |
| Queued events | beyond 256 queued events input is dropped and the next batch reports `dropped` |

Leaving the component:

- Ctrl+] leaves the component (terminals without the kitty keyboard protocol send it as Ctrl+5, which also leaves).
- Ctrl+C leaves it and keeps its native meaning (interrupt or quit).
- Esc goes to the mod and leaves the component or closes the dialog.
- `keys: 'all'` (`terminal_focus_v1`, also on `module`) also forwards Esc, Ctrl+C and the other Ctrl and Alt keys
  (Ctrl+Z still suspends), so only Ctrl+] (or Ctrl+5) leaves.
- [Key contexts](#focus-regions-key-contexts-and-help-terminal_focus_v1) of the component's site owner that name
  its site get each key before the component does.

Input callbacks run in the terminal process with read-only workspace access. The view redraws as soon as one
changes the mod's state. To write, the input callback publishes an event with
[`events.publish`](events-and-lifecycle.md#eventspublish) to the mod's `channel` handler, which runs with the
session's access. Terminal-side callbacks, such as slash commands and input, run beside the session. That event can
reach the `channel` handler before the input callback's own `api.state` write is saved.
[Handle keys in a terminal view](../../docs/mod-authors/handle-keys.md) shows the save pattern.

The mod stores the buffer, cursor and selection and draws them as spans. A `document` with `keys` set keeps its scroll
across content changes and scrolls to `selected`. A paste into a focused `terminal` component goes to the PTY, bracketed
when the program asked for it.

## View keybindings and command ownership

View `keybindings` accept `Ctrl+`, `Alt+` and `Shift+` combinations of letters, digits, F2–F12 and named keys
(`Up`, `PageDown`, `Enter`, ...), except terminal control keys and Shift+Tab; a binding that collides with a native
key is ignored with a warning.

On macOS, Kitty and Ghostty send Option+letter as a composed character (`π` for Option+p) unless Option-as-Alt is
enabled (`macos_option_as_alt` in Kitty, `macos-option-as-alt` in Ghostty), and the `Alt+` binding doesn't fire.

Key bindings and component actions run only the contributing mod's commands: a bare name is its own `id:name`, and
a binding or control naming another mod's command is dropped.

## Focus regions, key contexts and help (`terminal_focus_v1`)

With a view `layout`, the host computes focus regions every frame. The chat (transcript and composer) is region 0
and each drawn `site:` leaf is a region named by its site, numbered from 1 in layout order; only a `tabs` node's
active tab counts. When a `tabs` node's active tab changes (a tab click or a new `active`), focus inside it moves to
the node's newly drawn region.

- A `{region}` key action moves focus without a mod callback (table below). A region gets back the control last
  focused there, else its first control that is not a keys component or terminal, else no control.
- The focused region's frame draws in the accent color, or with its leaf's `style.focus` accent.
- While a region has focus, keys it does not bind never reach the composer. Ctrl, Alt and F-keys still reach
  `keybindings` and native shortcuts, and native confirmations such as approvals keep their keys.
- Esc in a region returns to the chat. Ctrl+] in a region returns to the chat. From a focused keys component or
  terminal, Ctrl+] returns to its region. In the chat, when the view has key contexts, Ctrl+] focuses the last region,
  or the first if none was focused. Clicking a region or a control in it focuses the region, and pastes into a focused
  region never reach the composer.

| `{region}` value | Focuses |
| --- | --- |
| `left`, `right`, `up`, `down` | The nearest region on that side |
| `next`, `previous` | The next or previous region in layout order |
| `chat` or `0` | The chat |
| 1–12 | That site region |
| A site name | That site's region |

View `key_contexts` (experimental) bind keys that apply only while `when` holds, at most 8 contexts and 32 keys per mod
(16 and 128 composed):

| `when` field | Holds when |
| --- | --- |
| `focus` | One name or a list of up to 8 different names: `chat`, `site` (any site region or a control in any site) or a site name. Omitted, anywhere. |
| `composer` | `empty` or `draft`, by the composer's text. |

- A context whose `when.focus` excludes the chat can also bind unmodified keys: named keys other than Esc and
  Shift+Tab, and single printable characters (`h`, `1`, `[`, `?`, `G`; letters match case exactly). A context that
  can apply in the chat takes only `keybindings` key names, and the host ignores a key there that collides with a
  native binding, as in `keybindings`.
- A binding is a key action or `{action, label}`; `label` (at most 64 bytes) names it in the help overlay.
- Contexts of the focused site's owner (the `owner` of `owner/name`) match first, then the others in composition
  order. A focused control keeps Enter, Space, Up, Down and a select's Left and Right.
- `{region}` and `{help: true}` also work in `keybindings` (experimental fields there); commands follow the ownership
  rule below.

`{help: true}` opens a host overlay listing the bindings that apply to the focused region with their labels and
owning mod, then `keybindings` and the host keys. `/` searches, Up and Down (or `j` and `k`) move, Enter runs the
selected binding and Esc clears the search or closes the overlay.

## Pointer events

`box`, `pane`, `image`, `raster` and `module` accept `pointer: true`. The owner then receives `component_event
{kind: 'pointer', pointer}`, where `pointer` has:

- `action`: `enter`, `leave`, `move`, `down`, `up`, `drag`, or `scroll_up` and `scroll_down` for the mouse wheel;
- `button`: `left`, `right`, `middle`, or null for motion and the wheel;
- `column`/`row` relative to the component's first cell (a nested box counts its title and children);
- `half` (0 or 1, the half-cell row) on terminals that report pixel positions (Kitty, Ghostty and WezTerm), else
  null.

A press captures the pointer until release, so `drag` and `up` reach the component outside its cells with
out-of-range or negative coordinates. Motion is latest-wins per component: a slow callback sees the newest
position, never a backlog. Views with no pointer components add no pointer work.

## `component_event`

`component_event` reports interaction with a mod's components and goes only to the component's owner. Two experimental
events report native state: `view` (`{phase, view, view_id, dropped?}`) when a native bottom-pane view or overlay opens
or closes, and `focus` (`{focused, dropped?}`) when the terminal window gains or loses focus. Each event names its
`component` and `kind`:

| Kind | Reports | Fields |
| --- | --- | --- |
| `focus` and `blur` | Focus changes | `origin` |
| `change` | An input's or select's new value, or a multiselect's checked values, on every edit | `value` or `values`, `origin` |
| `scroll` | A pane's new offset | `offset`, `origin` |
| `pointer` | A pointer event, under [Pointer events](#pointer-events) | `pointer` |
| `input` | Keys and pastes, under [Component key and paste input](#component-key-and-paste-input-terminal_input_v1) | `events`, `dropped` |
| `key` | One key from an [external client](omd-client-protocol.md#omdclientevent) | `key`, `text` |
| `activate` | Enter on a `document` line with no multi-line selection | `range`, `anchor` |
| `select` | A `document` multi-line selection (Shift+Up or Shift+Down, or Enter on it), or a tab click | `range`, `anchor` on a document; `index` on a `tabs` node |
| `find` | A `document`'s `find` changed and was run | `matches`, `error` |
| `resize` | A split border drag ended | `ratio` |
| `dock` | A site leaf was dragged onto another leaf or the chat | `content`, `target`, `edge`, `columns`, `rows` |
| `open` / `close` | Panes and dialogs (`ui_composition_v1`) | none |
| `exit`, `title`, `bell` and `notify` | A `terminal` component's program, under [the terminal pane extension](terminal-operations.md#terminal-pane-extension-terminal_pty_v2) (experimental) | `session`, `exit_code`, `files`, `title`, `text` |

The fields:

| Field | Meaning |
| --- | --- |
| `component` | The component id; for `resize`, `select` on tabs and `dock`, the layout path (`r`, then `.N` per child index) |
| `thread_id` | The session thread the event came from, or null before the session has one |
| `origin` | `user` or `mod` |
| `client` | The external client id, when a client sent the event |
| `value`, `values` | The new value, or the checked values in option order |
| `offset` | The pane's scroll offset |
| `pointer` | `{column, row, half?, action, button}` |
| `events` | Input events, each `{key, text}` or `{paste, truncated?}` |
| `key`, `text` | A key name, or null with the typed or pasted text |
| `range` | `{start, end}` line indexes from 0, inclusive |
| `anchor` | The `anchors` entry for the range's first line, or null |
| `matches` | The number of find matches, at most 10,000 |
| `error` | Why `find` failed, such as `find_pattern_invalid: ...`; `matches` is then 0 |
| `dropped` | Events dropped before this one |
| `ratio` | The split's new percentages |
| `index` | The tab clicked |
| `content`, `target`, `edge`, `columns`, `rows` | The `dock` fields, under [Dock events](layout-and-styling.md#dock-events) (experimental) |
| `session`, `exit_code`, `files`, `title` | The `terminal` component fields; `notify` puts its message in `text` |

`resize`, tab `select` and `dock` are described under
[Region sizing and layout events](layout-and-styling.md#region-sizing-and-layout-events), and `activate`, document
`select` and `find` under [Documents](layout-and-styling.md#documents).

When the owner sets [`state_scope: "thread"`](state-and-storage.md#state_scope-state_scopes_v1), its
`component_event` callback reads and writes the state of the event's `thread_id` thread.

These events wait in order behind a slow callback; beyond 256 waiting events new ones are dropped and the next
delivered event reports the count as `dropped`.

## `component_change` interceptor

A `component_change` interceptor, `api.intercept('component_change', …)`, can block or redirect a user's focus or
scroll change before the owner hears about it. It needs the `terminal` capability and `ui_controls_v1`, and it is
experimental. It runs only for the mod that owns the component being left or entered, with
`{kind: 'focus', id, from, to, origin: 'user'}` or `{kind: 'scroll', id, from, to, origin}`.

Handlers answer:

- `{deny}` to keep the previous focus or offset;
- `{focus: id}` to move focus to another of their own components (or `null` to release it);
- `{scroll: n}` to clamp the offset.

They run while the terminal handles the gesture, so they get no host operations and run under the
[terminal chain budget](interceptors.md#terminal-chain-budget). When it runs out the change applies unchanged.

## Component modules (`component_modules_v1`)

A component module is a view region drawn by synchronous handlers the mod registers with `api.component`. Use one
for a widget that reacts to keys, pointer events or timer ticks every frame without a `terminal` callback.

Component modules need the feature `component_modules_v1`, which `mod_host_check.py --static` requires of any
package that calls `api.component`.

`api.component(module, {init?, view, key?, pointer?, every?})` is registered during activation under the `terminal`
capability (at most 16 per mod) and draws `{type: 'module', id, label, module, props?, height?, keys?, pointer?}`
nodes.

### Component module lifecycle

Each mounted node runs in its own runner that stays alive while the node is in the view. `init(props, ui)` runs once
per mount. The state a handler returns is passed to the next handler call, and returning `undefined` keeps the
previous state.

- At most four nodes are mounted at once for the terminal and four for each external client; a fifth node draws a
  `component_limit` error line and no mounted runner is evicted for it.
- Handlers are synchronous; a returned promise fails with `component_handlers_must_be_synchronous`.
- In the terminal, removing a node or changing its owner or module starts a new mount. Results, retries and
  undelivered posts from the previous mount are discarded.

### Component module steps

A step runs at most once per 16 ms frame and only when something is pending: a mount, new props or size, queued
input, or a due `every: {ms, tick}` tick.

- `every` ticks run from 16 ms to 24 h, with at most 8 missed ticks caught up.
- `ms` may be a function of the state, and `null` pauses ticks, so a paused module costs nothing until input or new
  props arrive.

### Component module handlers

- `key(state, {kind: 'key', key, text})` receives keys while the node, given `keys: true`, has focus from a click
  or Tab (Esc and Ctrl+] return focus; pasted text arrives as one event with `key: null`).
- `pointer(state, {kind: 'pointer', column, row, action, button})` receives pointer events over the region with
  `pointer: true`, consecutive moves coalesced.
- `view(state, ui)` returns a render tree (`box` without style, `line`, `text`, `markdown`, `code`, `diff`, `list`;
  at most 64 components, depth 6, 256 KiB).

`ui` is `{columns, rows, props, post(data)}`, where `rows` is the node's `height` and 0 when it has none (auto
height). `post` hands the mod's `component_post` hooks `{component, module, data}` at most once per frame (a later
post in the same frame replaces it; 64 KiB).

### Component module authority and failure

- Handlers can't call host operations, including `time.sleep`. A call fails with `host_operation_unavailable`, and
  no `host_operation` hook or interceptor sees it. Handlers can't write state, but `api.state.get()` and
  `api.uiState.get()` return the current values at every step.
- A throw, three consecutive steps over 8 ms after the mounting one (`component_overrun`) or an invalid tree
  unmounts the node, which then draws one dim error line (the error's first line) until the next view revision
  mounts it again. A failed step never counts toward the mod's [fault limit](host-model.md#fault-limit).
- Without `height` the region is as tall as its latest tree.

### Component modules for external clients

External clients read a node's tree with [`omd/render`](omd-client-protocol.md#omdrender)
`{slot: 'module', props: {component, columns?, rows?}}`. Each client gets its own instance of the node. It is sized
by `columns` and `rows`, or as last rendered. The default is 80 columns and 0 rows. `effective.next_ms` in the result
says when the next tick is due. The client sends key and pointer events through `omd/client/event`.

Their posts reach `component_post` as `{component, module, client, data}`. `component_post` hooks can call the same
host operations as `component_event` hooks, for terminal and client posts alike. Detaching unmounts the client's
instances.
