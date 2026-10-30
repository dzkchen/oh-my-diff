# Render hooks (`render_hooks_v1`)

Use it when a mod restyles, wraps, replaces or hides a native terminal component such as a tool call, a message or
a built-in list. How interceptor chains run in general is in [Interceptors](interceptors.md).

## Render interceptor and hook results

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

Trees hold `box` (without `style` or `flex`), `line`, `text`, `markdown`, `code`, `diff`, `list` and `native` components
(64 components, depth 6, unique ids, 256 KiB); the native node appears at most once. Hooks compose as one continuation
chain in interceptor order, so unrelated wrappers nest, and each hook sees the props the hook before it passed on.

## Render components

| `component` | `id` | Props (`RenderProps`) | Rewritable |
| --- | --- | --- | --- |
| `user_message` (experimental) | content digest | `text`, `images`, `spoken` | none |
| `assistant_message` | content digest | `text`, `first`, `truncated` (the host cut `text` at 48 KiB; streamed chunks and the final message; the streaming tail is `live`) | none |
| `tool_call` | call ID (row ID for agent rows; `explore:<first call ID>` for an exploration group) | every agent tool row (`RenderToolCall`); see [`tool_call` props](#tool_call-props) | none |
| `tool_result` (experimental) | call ID | `tool`, `success`, `text` (MCP results inside their call) | none |
| `spinner` | `main` | `header`, `elapsed_seconds`, `details`, `message`, `interrupt_hint` | `header` |
| `turn_duration` (experimental) | `turn-<completed ms>` | `seconds`, `completed_at_ms` | none |
| `notice` (experimental) | content digest | `kind` (`info`/`warning`/`error`), `text`, `hint` | `text` |
| `session_mode` (experimental) | `collaboration` | `mode`, `label`, `cycle_hint` | `label` |
| `composer_hint` (experimental) | `placeholder` / `footer` | `slot`, `placeholder`, `input_enabled` / `mode`, `text`, `task_running` | `placeholder` |
| `question` | item ID or content digest | `questions` (`id`, `header`, `question`, `secret`, option labels), then `current`, `queued` (live) or `answered`, `interrupted` (final) | none |
| `list` | view ID | `view_id`, `title`, `subtitle`, `items`, `selected` | none |

## `tool_call` props

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

## Grouped members

Grouped exploration and computer activity offer each member through `tool_call` as `exec` or `mcp`.

- When those member hooks replace the drawing, each member has its own focus, pointer region and `expanded` flag;
  `next` draws a collapsed member as its compact row, and Find searches every member expanded.
- Native grouping remains when no member is replaced.
- Aggregate exploration rendering remains available on the group when member rendering does not replace it.

## Render hook behavior

Text props carry at most 48 KiB; a content digest is stable across resume and reflow, so equal content draws
identically. Tool rows are offered from live cells and committed history.

- In the fullscreen transcript a hooked tool row needs no control row: F4 focuses it and Enter, →/← or a click
  opens and closes it, and `expanded` is `true` while it is open and for every row of the full transcript (Ctrl+T),
  so a hook that shortens rows returns `next(e)` then.
- Selection copies what is drawn; raw mode never runs hooks.
- Approval overlays have no render hook: their identity, decision text, options, focus and grants stay native, and
  `surface_styles.approval` only paints the frame.
- A question hook changes the presentation only; answers, focus and keys stay native.
- The existing panes, `above_composer` band and named sites stay declarative views.

## Render callback runtime

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

## List rows (`terminal_lists_v1`)

`terminal_lists_v1` lets a `render` hook on component `list` replace built-in list rows. The host keeps selection
actions, session state, keyboard handling and native fallback when the mod is absent or fails.

Components accept an `{insert}` action.
