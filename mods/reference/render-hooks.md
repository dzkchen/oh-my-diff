# Render hooks (`render_hooks_v1`)

Use it when a mod restyles, wraps, replaces or hides a native terminal component such as a tool call, a message or
a built-in list. How interceptor chains run in general is in [Interceptors](interceptors.md).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](stability-and-migration.md#experimental-entries-in-the-registry)). Render hooks need the `terminal`
capability and draw in the OMD terminal on Apple Silicon macOS.

## Render interceptor and hook results

`api.intercept('render', {match: {component: 'tool_call'}}, async (e, next) => …)` draws one native terminal
component instance. `e` is `{component, id, surface, viewport: {columns, rows}, lifecycle, owner, props}`:

| Field | Meaning |
| --- | --- |
| `surface` | `inline` or `fullscreen`. |
| `lifecycle` | `live` while the component can still change and `final` once it cannot. |
| `owner` | `null` for host components. |

`next(e)` resolves to `{tree}`. In that tree, the node `{type: 'native', style?}` is the host's own drawing. A hook
can:

- observe: return what `next` returned;
- restyle: set `style` on the native node (`tone`, `bold`, `italic`, `underline`, `fg`, `bg`);
- wrap: place the native node in a tree;
- replace: return a tree without it;
- hide: return `{tree: []}`.

A tree contains `box` (without `style` or `flex`), `line`, `text`, `markdown`, `code`, `diff`, `list` and `native`
components. It has at most 64 components, depth 6 and 256 KiB, its ids are unique, and the native node appears at
most once. Hooks run as one continuation chain in interceptor order, so unrelated wrappers nest. Each hook sees the
props the hook before it passed on.

## Render components

Each native component a hook can match, with its `id` and props. The Rewritable column names the props a hook can
change in the `e` it passes to `next`. Rewrites to other props have no effect.

| `component` | `id` | Props (`RenderProps`) | Rewritable |
| --- | --- | --- | --- |
| `user_message` (experimental) | content digest | `text`, `images`, `spoken` | none |
| `assistant_message` | content digest | `text`, `first`, `truncated` | none |
| `tool_call` | call id (row id for agent rows; `explore:<first call id>` for an exploration group) | every agent tool row (`RenderToolCall`); see [`tool_call` props](#tool_call-props) | none |
| `tool_result` (experimental) | call id | `tool`, `success`, `text` (MCP results inside their call) | none |
| `spinner` | `main` | `header`, `elapsed_seconds`, `details`, `message`, `interrupt_hint` | `header` |
| `turn_duration` (experimental) | `turn-<completed ms>` | `seconds`, `completed_at_ms` | none |
| `notice` (experimental) | content digest | `kind` (`info`/`warning`/`error`), `text`, `hint` | `text` |
| `session_mode` (experimental) | `collaboration` | `mode`, `label`, `cycle_hint` | `label` |
| `composer_hint` (experimental) | `placeholder` or `footer` | see below | `placeholder` |
| `question` | item id or content digest | `questions` (`id`, `header`, `question`, `secret`, option labels), then the state props below | none |
| `list` | view id | `view_id`, `title`, `subtitle`, `items`, `selected` | none |

- `assistant_message` covers streamed chunks and the final message. The streaming tail is `live`. `truncated` is
  true when the host cut `text` at 48 KiB.
- `composer_hint` has id `placeholder` with props `slot`, `placeholder` and `input_enabled`, or id `footer` with
  props `mode`, `text` and `task_running`.
- A `question` adds `current` and `queued` while `live`, and `answered` and `interrupted` once `final`.

## `tool_call` props

Every agent tool row (`RenderToolCall`) contains `call_id`, `kind`, `status` (`running`/`completed`/`failed`/
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

## Grouped members

For grouped exploration and computer activity, the host runs `tool_call` hooks on each member of the group, as kind
`exec` or `mcp`.

- When those member hooks replace the drawing, each member has its own focus, pointer region and `expanded` flag;
  `next` draws a collapsed member as its compact row, and transcript search (Find) searches every member expanded.
- Native grouping remains when no member is replaced.
- Aggregate exploration rendering remains available on the group when member rendering does not replace it.

## Render hook behavior

Text props are at most 48 KiB. A content digest stays the same across resume and reflow, so equal content draws
identically. Tool rows are offered from live cells and committed history.

- In the fullscreen transcript a hooked tool row needs no control row. F4 focuses it, and Enter, →/← or a click
  opens and closes it. `expanded` is `true` while the row is open and for every row of the full transcript
  (Ctrl+T). A hook that shortens rows returns `next(e)` when `expanded` is `true`.
- Selection copies what is drawn; raw mode never runs hooks.
- Approvals are [native confirmations](glossary.md#trust-and-authority) and have no render hook. Their identity,
  decision text, options, focus and grants stay native, and `surface_styles.approval` only paints the frame.
- A question hook changes the presentation only; answers, focus and keys stay native.
- The existing panes, `above_composer` band and named sites stay declarative views.

## Render callback runtime

Render callbacks get no host operations and can't write state. A write fails with `render_side_effect_refused`, and
a write during activation stays local to that render. Read `api.state` or atoms instead.

- Renders run in a runner that stays activated while the package revision, settings and persisted state stay
  unchanged. Changing state requires a new activation.
- Stateless renders can reuse the runner across rows, including renders that call `next`. Activation-local state is
  restored before each reused render. Module variables may survive between renders, so never draw from them.
- The host keeps a tree until its input changes or a state key its hooks read changes. Live components and
  fullscreen transcript cells redraw asynchronously and show their last tree until the new one arrives. Inline
  scrollback is written once, so it waits for each cell's hooks as the cell is inserted. A narrower or wider
  terminal is a new input.
- A hook that throws, times out or returns an invalid tree is skipped with the input it received, so the native
  drawing survives. A disabled or failed mod's hooks are gone at once, and every failed render joins the status
  `chains` log.
- With no `render` interceptor the host never calls a mod while drawing.

## List rows (`terminal_lists_v1`)

Use a `list` hook to redraw the rows of Codex's built-in lists, such as its pickers. `terminal_lists_v1` lets a
`render` hook on component `list` replace built-in list rows. The host keeps selection actions, session state,
keyboard handling and native fallback when the mod is absent or fails.

The same feature lets a component's `action` be `{insert: TEXT}`, which inserts the text in the composer.
