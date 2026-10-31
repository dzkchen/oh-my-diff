# Layout and styling

Use it when a mod places and styles what it draws: the startup presentation, layout trees, the component types,
region sizing, overlays, the box model, text styles, surface paint and the view limits. Keys, focus and pointer
input are in [Terminal input](terminal-input.md); images and rasters are in [Graphics](graphics.md).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](stability-and-migration.md#experimental-entries-in-the-registry)). They draw in the OMD terminal on
Apple Silicon macOS and in [external clients](external-clients.md).

## Startup presentation (`terminal_welcome_v1`)

A mod can change what the terminal shows when a session starts.

### Presentation value

The terminal event's read-only `presentation` is `{thread_id, phase, surface?}`.

- `surface` is `fullscreen` when the terminal client draws on the alternate screen and `inline` otherwise (inline
  sessions never draw the `welcome` site); it is absent until the client has chosen its screen mode.
- `phase` is `fresh` for a new thread, `started` once the host accepts the thread's first turn, and `resumed` for a
  resumed or forked thread. The host sets it from its own records before it first publishes the view.
- Before the composer first accepts input, the host can run the `terminal` handler with `event: 'startup'`, more
  than once. That event has `ledger: null` and a null `thread_id`, and its phase depends on whether the session is
  new, resumed or forked. During these `startup` callbacks, native task, app and paid host operations are
  unavailable.
- Before local presentation is available, the whole presentation value may be absent or null.

`presentation` describes the host session, so a mod doesn't need to persist its own first-turn flag. The host sends
it with every presentation refresh. Composer input, a rejected submission, ordinary view refreshes and a mod reload
don't reset it. A locally queued draft isn't an accepted turn. An empty view the host publishes while mods start
keeps the initial view on screen. A view from a disabled, broken or reloaded mod replaces it.

### `welcome` site

The reserved `welcome` site renders bounded generic components centered in the unused area of the fullscreen transcript.
`welcome: {show_while_composing: true}` keeps the site visible with a draft, including while the slash command, file
or mention popup is open; the default shows it only with an empty composer.

`welcome: {hidden: true}` (`terminal_welcome_hidden_v1`, experimental) keeps the welcome area under the same rules, with
Codex's own welcome and animation off, but draws no `welcome` site there. Use it when a mod fills the fresh screen
another way, such as an underlay. `hidden` takes effect only when it comes from the mod whose underlay is in the
composed view. A later mod that sets `welcome` can't show the site again, even with `show_while_composing` off. If
the host refuses the underlay, the usual welcome comes back.

- Accepted/running and resumed sessions, transcript selection/search, raw output and overlays suppress the
  `welcome` site.
- Any history beyond the startup header and notices (a command's output, a rejected submission) hides it until a new
  thread, like Codex's own welcome.
- Approvals and input retain their space; if no blank space fits the components, the site does not draw.
- Inline output retains the native transcript without the centered decoration.
- Without a `welcome` site, Codex keeps its normal empty-screen animation (its blossom policy).

### Title suffix and greeting

- `session_title_suffix` appends up to 80 bytes to the upstream version heading, including inline/raw output; the
  host keeps its source-backed version and attribution.
- `greeting` overrides the startup phrase with up to 256 bytes, and an empty string hides it.

For each field, the last mod to set it wins. Mods are ordered by dependency, then by mod id, so a later opt-in theme can
override an earlier presentation default. Escape/control injection is refused. Disable, a broken mod, or direct mode
restores the upstream fields.

## Layouts and component types

Views may declare a `layout` tree of splits and tabs with transcript, composer and mod sites (`owner/name`).

| Limit | Value |
| --- | --- |
| Depth | Splits and tabs nest at most 6 levels deep |
| Split children | 2–4 |
| Tabs per `tabs` node | 1–6 |
| Leaves | At most 12 |

A `site:` or `transcript` leaf may set `title` (`terminal_layout_title_v1`, experimental), at most 64 bytes without
control characters. A `composer` leaf takes no title.

- A site's frame shows the title instead of the site name, and `''` draws no title.
- A titled transcript gives its top row to a rule with the title, accented while the chat has focus in a view
  with `key_contexts`.

Layout sites contain the component types below, including `document` (see [Documents](#documents)), `diff`, `image`,
`raster` and `terminal` (a PTY session).

## Component types

Every `TerminalComponent` type in [`api.d.ts`](../api.d.ts) with its fields (`?` marks an optional field).

| `type` | Fields | Details |
| --- | --- | --- |
| `box` | `id, label, title?, children?, style?, flex?, min_width?, max_width?, pointer?` | [Box model](#box-model-terminal_box_model_v1) |
| `line` | `id, label, spans` | [Rich lines](#rich-lines-terminal_rich_line_v1) |
| `text` | `id, label, text, tone?` | [View limits](#view-limits) |
| `button` | `id, label, text, action, hotkey?, autofocus?` | [Input and focus](terminal-input.md#input-and-focus) |
| `input` | `id, label, value?, placeholder?, action, hotkey?, autofocus?` | [Input and focus](terminal-input.md#input-and-focus) |
| `select` | `id, label, value, options, action, hotkey?, autofocus?` | [Input and focus](terminal-input.md#input-and-focus) |
| `multiselect` | `id, label, value?, options, action, hotkey?, autofocus?` | [Input and focus](terminal-input.md#input-and-focus) |
| `list` | `id, label, rows, selected?, height?, action, hotkey?, autofocus?` | [Region sizing](#region-sizing-and-layout-events) |
| `markdown` | `id, label, text` | [View limits](#view-limits) |
| `code` | `id, label, text, language?, start?` | [Code highlighting](#code-highlighting-terminal_code_highlight_v1) |
| `pane` | `id, label, title?, collapsed?, scroll?, keys?, children?, style?, flex?, min_width?, max_width?, pointer?` | [Box model](#box-model-terminal_box_model_v1), [`terminal.pane`](terminal-operations.md#terminalpane-and-terminalpanes) |
| `dialog` | `id, label, title, children?, style?` | [Input and focus](terminal-input.md#input-and-focus) |
| `document` | `id, label, lines?, source?, anchors?, selected?, find?, height?, action?, keys?` | [Documents](#documents) |
| `diff` | `id, label, unified, selected?, height?, action?` | [Region sizing](#region-sizing-and-layout-events) |
| `image` | `id, label, image, alt, height?, pointer?` | [Graphics](graphics.md#image-component) |
| `raster` (experimental) | `id, label, alt, width?, height?, pointer?` | [Graphics](graphics.md#raster-component) |
| `terminal` | `id, label, session, height?, autofocus?` | [`terminal.pty`](terminal-operations.md#terminalpty) |
| `module` | `id, label, module, props?, height?, keys?, pointer?` | [Component modules](terminal-input.md#component-modules-component_modules_v1) |
| `slot` | none | [View limits](#view-limits) |
| `native` | `style?` | [Render hooks](render-hooks.md#render-interceptor-and-hook-results) |

## Documents

A `document` shows up to 100,000 lines with a cursor, selection, find and per-line anchors.

| Field | Meaning |
| --- | --- |
| `lines` | Lines of styled spans; `document` keeps span styles but refuses span `link` |
| `source` | Instead of `lines`, an [evidence](state-and-storage.md#evidencewrite-and-evidenceread) `ResourceRef` the mod owns, drawn as plain text lines; an unreadable one draws one `unavailable: ERROR` line |
| `anchors` | One string per line, by line index; `activate`, `select` and the action report the line's anchor |
| `selected` | `{start, end}` line indexes from 0; a new value moves the cursor and selection there |
| `find` | `{query, regex?, case?}`: a literal search unless `regex`, case-insensitive unless `case`; matching lines are underlined |
| `height` | Rows. Defaults to 12, or the line count when the document is shorter. In a layout region, see [Region sizing](#region-sizing-and-layout-events). |
| `action` | A command action run on `activate`, with the line's anchor or, without one, its line number from 1 as the argument |
| `keys` | `true` or `'all'` forwards keys to the mod instead, under [Component key and paste input](terminal-input.md#component-key-and-paste-input-terminal_input_v1) |

While a document without `keys` has focus:

- Up and Down move the cursor, Shift+Up and Shift+Down extend the selection, and PageUp, PageDown, Home and End
  jump.
- Enter on one line sends `component_event {kind: 'activate', range, anchor}` and runs `action`. Enter on a
  multi-line selection sends `{kind: 'select', range, anchor}` and runs nothing; extending the selection sends
  `select` too.
- `n` and `N` move to the next and previous match, and Esc clears the find.

A new `find` moves the cursor to the first match at or after it and sends `component_event {kind: 'find', matches}`.
An invalid regex sends `matches: 0` and `error: 'find_pattern_invalid: ...'`. Find stops at 10,000 matches, and a
regex find scans the first 256 KiB of text.

Updating only a document's anchors updates activation targets without resetting its cursor, selection or scroll,
including when source-backed text is unchanged.

## Region sizing and layout events

In a layout region, `terminal`, `document`, `diff`, `list` and `raster` components without a `height` share the
rows left after the region's other components and gaps. In a row layout each gets the region's full inner height.

- Releasing a mouse drag on a split border sends `component_event {kind: 'resize', component, ratio}`, where
  `component` is the split's path (`r` for the root, then `.N` per child index) and `ratio` its new percentages, so
  a mod can keep the ratio in its layout.
- Clicking a tab title switches the tab and sends `component_event {kind: 'select', component, index}` with the
  `tabs` node's path (`terminal_tabs_v1`), so the owner can keep `active` in its layout.
- Releasing a drag that started on a `site:` leaf's top frame row (not a tab bar or split border) over another site
  leaf or the chat sends one `component_event {kind: 'dock', component, content, target, edge, columns, rows}`
  (`terminal_layout_dock_v1`), described below.

These go only to the mod whose view supplied the layout.

### Dock events

A dock event reports a drag of a `site:` leaf onto another leaf or the chat. `content`, `target`, `edge`, `columns`
and `rows` are experimental fields.

| Field | Value |
| --- | --- |
| `component` | The dragged leaf's path |
| `content` | The dragged leaf's `site:<name>` |
| `target` | The leaf path it was dropped on; for the chat, the path of the split containing the transcript and composer, or the transcript leaf without a composer |
| `edge` | `left`, `right`, `top` or `bottom` over the outer quarter of the target, `center` over its middle; never set over the chat |
| `columns`, `rows` | The size of the area the layout was drawn in |

- While dragging, the host tints where the pane would drop and draws its edge in the accent. Cells it can't blend
  (including ANSI 0-15 backgrounds) keep their color and get the edge reversed.
- The host changes nothing itself, so the owner republishes its layout.
- Nothing is sent when Esc cancels the drag or it ends on the dragged leaf or outside every zone.

## Overlays

A mod site (`owner/name`) with `overlay: {anchor, offset?, width, height, z?, clip?, style?}` draws above the
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
- When several patches set an overlay for the same site, the patch that composes last wins. A `wrap` patch
  overrides another mod's overlay without a claim or a `terminal.conflicts` entry.

## Box model (`terminal_box_model_v1`)

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

### Row layout

With `direction: 'row'`:

- A `button`, `text` or `line` takes its natural width; every other child gets a share of the rest by its `flex`
  weight (1–12, default 1).
- When natural widths exceed the available space, shorter children keep their width and longer children share the
  remaining columns.
- `max_width` caps a child's width and a child with fewer columns than its `min_width` drops out.
- In a column layout, a box is hidden when the available width is outside its `min_width` to `max_width` range.

### Hover and focus accents

`hover` and `focus` restyle a `box` or `pane` while it is in that state.

- `hover` applies while the pointer is over the box (no `pointer: true` needed; events still need it).
- `focus` applies while the box or a descendant has focus.
- Accents never add or remove a border, so geometry stays put.

### Default styling

Unstyled panes, dialogs and layout sites are cards: the theme `border`, `padding: [0, 1]` and the title in the top
edge. A pane with `border: 'none'` is a flat panel whose title row leads its content. Unstyled boxes and overlays
draw no frame.

- The sidebar has no padding, one row between its components under the comfortable density, and no border unless
  `sidebar_style` sets one, and then shows the view `title`.
- A split's `gap` (0–4) leaves cells between its children.
- Render hook trees refuse `style` and `flex`.
- The sidebar opens only for a mod's `sidebar` components, `panels` or unplaced mod sites. The host's progress and
  mod diagnostics draw as cards above the composer instead, four entries each, wrapped to six lines, then
  `+N more`.

## Span styles

Spans accept `fg` and `bg` theme colors, `italic` and `underline` (`terminal_style_v1`).

## Code highlighting (`terminal_code_highlight_v1`)

A `code` component with a `language` (a name or file extension such as `rust`, `ts` or `py`) draws its `text` in the
user's syntax theme. An unknown or missing `language`, or a line over 4 KiB, draws it plain. `start` (a line index,
default 0; an experimental field) draws from that line while highlighting from the top of `text`, so a scrolled view
keeps comments and strings that open above it.

## Rich lines (`terminal_rich_line_v1`)

`terminal_rich_line_v1` adds the one-row `line` component. A `line` has up to 12 styled `spans` (`text`, `tone`,
`bold`, `italic`, `underline`, `fg`, `bg`, `link`), 256 characters in total, and its `label` is the accessible text.
The feature also adds optional `min_width` and `max_width` (1–500 columns) on `box` and `pane`.

The host draws a box with width bounds only when the site's inner width fits it, and header height counts only drawn
boxes. Header
rows are never spaced by the comfortable density.

## Surface paint

`surface_styles.composer` and `.approval` (`terminal_surface_paint_v1`, an experimental view field) accept a
`TerminalSurfacePaint` with `top`, `bottom`, `foreground`, `border` RGB/indexed colors and `opacity` from 0 to 1.

- Background colors interpolate vertically and blend with existing colors.
- The foreground is independent of background opacity; reset foregrounds get a readable color against the surviving
  background. Explicit native foregrounds and special backgrounds remain.
- Borders use blank edge cells and disappear at zero opacity.
- `NO_COLOR` omits styling.
- Inline rendering uses the current bounded viewport; it does not repaint earlier terminal scrollback.
- `approval` paints the frame of [native confirmations](glossary.md#trust-and-authority), such as approvals and mod
  confirmations. The host still draws their text, options, default selection, focus and grants.

Surface paints compose by surface name with the later contributor replacing that surface's paint.

## View placeholder and glyphs

A terminal view may set `placeholder` (experimental) and `theme.glyphs`.

- `placeholder` replaces the composer's placeholder text.
- `theme.glyphs` maps a sequence of 2–4 printable ASCII characters to a replacement with the same number of
  characters. The host ignores a mapping that changes the drawn width.

## View limits

The host checks every view and patch against these limits.

Keybindings:

- Each mod's view or patch has at most 24 keybindings.
- The view composed from every mod has at most 128, and a key bound by two mods rejects the later mod's patch.

Components:

- A view contains at most 64 components nested at most 6 deep.
- Component ids use `a-z`, `0-9` and `_`, up to 48 bytes, and are unique across the composed view.
- A `select` or `multiselect` has at most 16 options and a `list` at most 200 rows.
- A `wrap` site contains exactly one `slot`.

Links and hotkeys:

- A span `link` is an http(s) URL of at most 2,048 bytes on `line` and `list` spans (documents refuse it), drawn as
  an OSC 8 hyperlink, and `markdown` links become hyperlinks too.
- A control `hotkey` uses the keybinding names.

Text sizes:

- Row values, labels and spans are at most 256 bytes.
- `text`, `code`, `markdown`, `diff` and `document` are at most 49,152 bytes. The terminal caches recent
  markdown renders, so a large `markdown` is parsed again, at about 1 ms per KiB, only when its text or width
  changes. Stream text into `code` or `text` instead.
- A view or patch is at most 256 KiB of JSON and the composed view 1 MiB. Those JSON limits still apply to
  text-heavy views, and escaping can double a text (`\n`, `"` and `\` take two bytes), so clip long text on its
  `JSON.stringify` size rather than its 48 KiB length.
- Text fields refuse control characters except newlines where a field is multi-line.
- The status row contains at most 4 segments of 40 characters across all mods.

An invalid view is dropped with the failing field named and the mod's last valid view stays; `omd-mod status`
reports the composed view's diagnostics under `terminal`.
