# Terminal input

Use it when a mod takes keys, pastes or pointer events, binds keys, moves focus between regions and controls,
reacts to `component_event`, guards focus changes with `component_change`, or draws with component modules.

## Input and focus

- A dialog focuses its first item when it opens, or the control it `autofocus`es.
- Tab and Shift+Tab cycle focus while a dialog shows or a control has focus; otherwise they stay the composer's, and
  a click, a `hotkey`, `autofocus` or a `{focus}` keybinding focuses a control first. Up and Down move within a
  list, multiselect, document or scrolled pane and, at its first or last row (or on any other control), focus the
  previous or next control; entering a list from above starts at its first row, from below at its last; key panes
  and terminals are reached with Tab once a control has focus, a click or a `{focus}` keybinding.
  Left and Right change a `select`.
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
64 KiB).

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
- Key contexts of the component's site owner that name its site get each key before the component does.

Input callbacks run in the terminal process with read-only workspace access, and the view redraws as soon as one
changes the mod's state. A key that must write (a save) publishes an `events.publish` hop whose `channel` callback
runs with the session's access.

Terminal-side callbacks (slash commands, input) run beside the session, so their hop can arrive before their own
`api.state` write lands: keep the request in state and, when the `channel` callback does not find it yet, serve it
from a short `events.schedule` timer.

The mod owns the buffer, cursor and selection and draws them as spans; a key `document` keeps its scroll across
content changes and scrolls to `selected`. A paste into a focused `terminal` component goes to the PTY, bracketed
when the program asked for it.

## View keybindings and command ownership

View `keybindings` accept `Ctrl+`, `Alt+` and `Shift+` combinations of letters, digits, F2–F12 and named keys
(`Up`, `PageDown`, `Enter`, ...), except terminal control keys and Shift+Tab; a binding that collides with a native
key is ignored with a warning.

On macOS, Kitty and Ghostty send Option+letter as a composed character (`π` for Option+p) unless Option-as-Alt is
enabled (`macos_option_as_alt` in Kitty, `macos-option-as-alt` in Ghostty), so an `Alt+` binding should not be a
control's only affordance: name its slash command next to it in the hint.

Key bindings and component actions run only the contributing mod's commands: a bare name is its own `id:name`, and
a binding or control naming another mod's command is dropped.

## Focus regions, key contexts and help (`terminal_focus_v1`)

With a view `layout`, the host computes focus regions every frame. The chat (transcript and composer) is region 0
and each drawn `site:` leaf is a region named by its site, numbered from 1 in layout order; only a `tabs` node's
active tab counts. When a `tabs` node's active tab changes (a tab click or a new `active`), focus inside it moves to
the node's newly drawn region.

- A `{region}` key action moves focus without a mod callback: `left`, `right`, `up` and `down` pick the nearest region
  on that side, `next` and `previous` cycle in layout order, `chat` or `0` returns to the chat, a number from 1 to 12 is
  that site region and a site name focuses that region. A region gets back the control last focused there, else its
  first control that is not a keys component or terminal, else no control.
- The focused region's frame draws in the accent color, or with its leaf's `style.focus` accent.
- While a region has focus, keys it does not bind never reach the composer. Ctrl, Alt and F-keys still reach
  `keybindings` and native shortcuts, and native confirmations such as approvals keep their keys.
- Esc in a region returns to the chat. Ctrl+] in a region returns to the chat, or from a focused keys component or
  terminal to its region; in the chat it focuses the last region (else the first) when the view has key contexts.
  Clicking a region or a control in it focuses the region, and pastes into a focused region never reach the
  composer.

View `key_contexts` (experimental) bind keys that apply only while `when` holds, at most 8 contexts and 32 keys per mod
(16 and 128 composed):

| `when` field | Holds when |
| --- | --- |
| `focus` | One name or a list of up to 8 different names: `chat`, `site` (any site region or a control in any site) or a site name. Omitted, anywhere. |
| `composer` | `empty` or `draft`, by the composer's text. |

- A context that cannot hold in the chat may also bind unmodified keys: named keys other than Esc, Shift+Tab and single
  printable characters (`h`, `1`, `[`, `?`, `G`; letters match case exactly). A context that can hold there takes
  `keybindings` key names, and there a key that collides with a native binding is ignored as in `keybindings`.
- A binding is a key action or `{action, label}`; `label` (at most 64 bytes) names it in the help overlay.
- Contexts of the focused site's owner (the `owner` of `owner/site`) match first, then the others in composition
  order. A focused control keeps Enter, Space, Up, Down and a select's Left and Right.
- `{region}` and `{help: true}` also work in `keybindings` (experimental fields there); commands follow the ownership
  rule below.

`{help: true}` opens a host overlay listing the bindings that apply to the focused region with their labels and
owning mod, then `keybindings` and the host keys. `/` searches, Up and Down (or `j` and `k`) move, Enter runs the
selected binding and Esc clears the search or closes the overlay.

## Pointer events

`box`, `pane`, `image` and `raster` accept `pointer: true`. The owner then receives `component_event {kind:
'pointer'}` with:

- `action` `enter`, `leave`, `move`, `down`, `up` and `drag`;
- `column`/`row` relative to the component's first cell (a nested box counts its title and children);
- `half` (0 or 1, the half-cell row) on terminals that report pixel positions (Kitty, Ghostty and WezTerm), else
  null.

A press captures the pointer until release, so `drag` and `up` reach the component outside its cells with
out-of-range or negative coordinates. Motion is latest-wins per component: a slow callback sees the newest
position, never a backlog. Views with no pointer components add no pointer work.

## `component_event`

`component_event`, `view` and `focus` (both experimental) report interaction. `component_event` goes only to the
component's owner and also reports, with `origin` `user` or `mod`:

| Event | Reports |
| --- | --- |
| `focus` and `blur` | Focus changes. |
| `change` | An input's or select's new `value` or a multiselect's checked `values`, on every edit. |
| `scroll` | A pane's `offset`. |
| `pointer` | Cell-relative `{column, row, action, button}`. |
| `open` / `close` | Panes and dialogs (`ui_composition_v1`). |

The other kinds are described with their sources: `input` under [Component key and paste
input](#component-key-and-paste-input-terminal_input_v1), `pointer` under [Pointer events](#pointer-events), and
`resize`, `select` and `dock` under [Layout region sizing, split resize and tab
select](layout-and-styling.md#layout-region-sizing-split-resize-and-tab-select).

Every `component_event` carries the `thread_id` of the session thread it came from (null before the session has
one), and a `state_scope: "thread"` owner's callback runs with that thread's state.

These events wait in order behind a slow callback; beyond 256 waiting events new ones are dropped and the next
delivered event reports the count as `dropped`.

## `component_change` interceptor

`api.intercept('component_change', …)` (capability `terminal`, `ui_controls_v1`, experimental) runs before a user's
focus or scroll change is reported, and only for the mod that owns the component being left or entered:
`{kind: 'focus', id, from, to, origin: 'user'}` or `{kind: 'scroll', id, from, to, origin}`.

Handlers answer:

- `{deny}` to keep the previous focus or offset;
- `{focus: id}` to move focus to another of their own components (or `null` to release it);
- `{scroll: n}` to clamp the offset.

They run while the terminal handles the gesture, so they get no host operations. The whole chain, including any wait
for a runtime busy with another callback, gets 50 ms; when that runs out the change applies unchanged.

## Component modules (`component_modules_v1`)

Component modules need the feature `component_modules_v1`, which `mod_host_check.py --static`
requires of any package that calls `api.component`.

`api.component(module, {init?, view, key?, pointer?, every?})` is registered during activation under the `terminal`
capability (at most 16 per mod) and draws `{type: 'module', id, label, module, props?, height?, keys?, pointer?}`
nodes.

### Component module lifecycle

Each mounted node runs in its own runner that stays alive while the node is in the view, so `init(props, ui)` runs
once and the state handlers return carries over between frames (returning `undefined` keeps it).

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

- Handlers have no host authority (`host_operation_unavailable`, `time.sleep` included, and no `host_operation`
  hook or interceptor sees the attempt) and cannot write state, but `api.state.get()` and `api.uiState.get()` read
  the current values at every step.
- A throw, three consecutive steps over 8 ms after the mounting one (`component_overrun`) or an invalid tree
  unmounts the node, which then draws one dim error line (the error's first line) until the next view revision
  mounts it again. A failed step never counts toward the mod's [fault limit](host-model.md#fault-limit).
- Without `height` the region is as tall as its latest tree.

### Component modules for external clients

External clients read a node's tree with [`omd/render`](omd-client-protocol.md#omdrender)
`{slot: 'module', props: {component, columns?, rows?}}` (their own instance, sized as given or as last rendered, 80
columns and rows 0 by default; `effective.next_ms` says when the next tick is due) and send it key and pointer events
through `omd/client/event`.

Their posts reach `component_post` as `{component, module, client, data}` (hooks there make the same host
operations `component_event` hooks make, on either surface), and detaching unmounts their instances.
