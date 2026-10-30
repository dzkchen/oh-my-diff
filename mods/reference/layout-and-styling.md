# Layout and styling

Use it when a mod places and styles what it draws: the startup presentation, layout trees, the component types,
region sizing, overlays, the box model, text styles, surface paint and the view limits. Keys, focus and pointer
input are in [Terminal input](terminal-input.md); images and rasters are in [Graphics](graphics.md).

## Startup presentation (`terminal_welcome_v1`)

This section covers the presentation value, the `welcome` site, and the title suffix and greeting.

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
`welcome: {show_while_composing: true}` keeps the site visible with a draft, including while the slash command, file
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

## Layouts and component types

Views may declare a `layout` tree of splits and tabs with transcript, composer and mod-named sites (`mod/site`). A
`site:` or `transcript` leaf may set `title` (`terminal_layout_title_v1`, experimental), at most 64 bytes without
control characters: a site's frame shows it instead of the site name and `''` draws no title, and a titled transcript
gives its top row to a rule carrying the title, accented while the chat has focus in a view with `key_contexts`. A
`composer` leaf takes no title. A layout nests splits and tabs at most 6 levels deep, with 2–4 children per split, 1–6
tabs per `tabs` node and at most 12 leaves. Components add `document` (up to 100,000 lines with anchors, selection and
find), `diff`, `image`, `raster` and `terminal` (a PTY session).

Updating only a document's anchors updates activation targets without resetting its cursor, selection or scroll,
including when source-backed text is unchanged.

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
| `list` | `id, label, rows, selected?, height?, action, hotkey?, autofocus?` | [Layout region sizing](#layout-region-sizing-split-resize-and-tab-select) |
| `markdown` | `id, label, text` | [View limits](#view-limits) |
| `code` | `id, label, text, language?, start?` | [Code highlighting](#code-highlighting-terminal_code_highlight_v1) |
| `pane` | `id, label, title?, collapsed?, scroll?, keys?, children?, style?, flex?, min_width?, max_width?, pointer?` | [Box model](#box-model-terminal_box_model_v1), [`terminal.pane`](terminal-operations.md#terminalpane-and-terminalpanes) |
| `dialog` | `id, label, title, children?, style?` | [Input and focus](terminal-input.md#input-and-focus) |
| `document` | `id, label, lines?, source?, anchors?, selected?, find?, height?, action?, keys?` | [Layouts and component types](#layouts-and-component-types) |
| `diff` | `id, label, unified, selected?, height?, action?` | [Layout region sizing](#layout-region-sizing-split-resize-and-tab-select) |
| `image` | `id, label, image, alt, height?, pointer?` | [Graphics](graphics.md#image-component) |
| `raster` (experimental) | `id, label, alt, width?, height?, pointer?` | [Graphics](graphics.md#raster-component) |
| `terminal` | `id, label, session, height?` | [`terminal.pty`](terminal-operations.md#terminalpty) |
| `module` | `id, label, module, props?, height?, keys?, pointer?` | [Component modules](terminal-input.md#component-modules-component_modules_v1) |
| `slot` | none | [View limits](#view-limits) |
| `native` | `style?` | [Render hooks](render-hooks.md#render-interceptor-and-hook-results) |

## Layout region sizing, split resize and tab select

In a layout region, `terminal`, `document`, `diff`, `list` and `raster` components without a `height` share the
rows left after the region's other components and gaps. In a row layout each gets the region's full inner height.

- Releasing a mouse drag on a split border sends `component_event {kind: 'resize', component, ratio}`, where
  `component` is the split's path (`r` for the root, then `.N` per child index) and `ratio` its new percentages, so
  a mod can keep the ratio in its layout.
- Clicking a tab title switches the tab and sends `component_event {kind: 'select', component, index}` with the
  `tabs` node's path (`terminal_tabs_v1`), so the owner can keep `active` in its layout.
- Releasing a drag that started on a `site:` leaf's top frame row (not a tab bar or split border) over another site leaf
  or the chat sends one `component_event {kind: 'dock', component, content, target, edge, columns, rows}`
  (`terminal_layout_dock_v1`; `content`, `target` and `edge` are experimental fields). `component` is the dragged leaf's
  path and `content` its `site:<name>`. `target` is the leaf path it was dropped on; for the chat it is the path of the
  split holding the transcript and composer, or the transcript leaf without a composer. `edge` is `left`, `right`, `top`
  or `bottom` over the outer quarter of the target and `center` over its middle, never over the chat. `columns` and
  `rows` are the size of the area the layout was drawn in. While dragging, the host shades where the pane would land. It
  changes nothing itself and sends nothing when the drag is cancelled with Esc or ends on the dragged leaf or outside
  every zone, so the owner republishes its layout.

These go only to the mod whose view supplied the layout.

## Overlays

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
- In a column, `min_width`/`max_width` hide the box outside its bounds.

### Hover and focus accents

- `hover` applies while the pointer is over the box (no `pointer: true` needed; events still need it).
- `focus` applies while the box or a descendant has focus.
- Accents never add or remove a border, so geometry stays put.

### Default styling

Unstyled panes, dialogs and layout sites are cards: the theme `border`, `padding: [0, 1]` and the title in the top
edge. A pane with `border: 'none'` is a flat panel whose title row leads its content. Unstyled boxes and overlays
draw no frame.

- The sidebar has no padding, one row between its components under the comfortable density, and no border unless
  `sidebar_style` sets one, which then carries the view `title`.
- A split's `gap` (0–4) leaves cells between its children.
- Render hook trees refuse `style` and `flex`.
- The host's progress and mod diagnostics draw as cards above the prompt (four entries each, wrapped to six lines, then
  `+N more`), so the sidebar opens only for a mod's `sidebar` components, `panels` or unplaced named sites.

## Span styles

Spans accept `fg` and `bg` theme colors, `italic` and `underline` (`terminal_style_v1`); `document` keeps span
styles.

## Code highlighting (`terminal_code_highlight_v1`)

A `code` component with a `language` (a name or file extension such as `rust`, `ts` or `py`) draws its `text` in the
user's syntax theme. An unknown or missing `language`, or a line over 4 KiB, draws it plain. `start` (a line index,
default 0; an experimental field) draws from that line while highlighting from the top of `text`, so a scrolled view
keeps comments and strings that open above it.

## Rich lines (`terminal_rich_line_v1`)

`terminal_rich_line_v1` adds a one-row `line` component with up to 12 styled `spans` (`text`, `tone`, `bold`, `italic`,
`underline`, `fg`, `bg`, `link`; 256 characters in total), whose `label` is the accessible text, and optional
`min_width`/`max_width` (1–500 columns) on `box` and `pane`.

Native draws a bounded box only when the site's inner width fits, and header height counts only drawn boxes. Header
rows are never spaced by the comfortable density.

## Appearance primitives

The appearance additions (`terminal_surface_paint_v1`, [`terminal_image_sample_v1`](graphics.md#terminalimage_sample),
[`terminal_import_lifetime_v1`](terminal-operations.md#import-lifetime))
remain generic presentation primitives.

### Surface paint

`surface_styles.composer` and `.approval` (an experimental view field) accept a `TerminalSurfacePaint` with `top`,
`bottom`, `foreground`, `border` RGB/indexed colors and `opacity` from 0 to 1.

- Background colors interpolate vertically and blend with existing colors.
- The foreground is independent of background opacity; reset foregrounds get a readable color against the surviving
  background. Explicit native foregrounds and special backgrounds remain.
- Borders use blank edge cells and disappear at zero opacity.
- `NO_COLOR` omits styling.
- Inline rendering uses the current bounded viewport; it does not repaint earlier terminal scrollback.
- `approval` frames native approval prompts and mod confirmations; their text, options, default selection, focus
  and grants stay host-owned.

Surface paints compose by surface name with the later contributor replacing that surface's paint.

## View placeholder and glyphs

A terminal view may set `placeholder` (experimental) and `theme.glyphs` (2–4 printable ASCII characters mapped to the
same number of characters; width-changing mappings are ignored).

## View limits

Keybindings:

- Each mod's view or patch has at most 24 keybindings.
- The view composed from every mod has at most 128, and a key bound by two mods rejects the later mod's patch.

Components:

- A view holds at most 64 components nested at most 6 deep.
- Component ids use `a-z`, `0-9` and `_`, up to 48 bytes, and are unique across the composed view.
- A `select` or `multiselect` has at most 16 options and a `list` at most 200 rows.
- A `wrap` site contains exactly one `slot`.

Links and hotkeys:

- A span `link` is an http(s) URL of at most 2,048 bytes on `line` and `list` spans (documents refuse it), drawn as
  an OSC 8 hyperlink, and `markdown` links become hyperlinks too.
- A control `hotkey` uses the keybinding names.

Text sizes:

- Row values, labels and spans are at most 256 bytes.
- `text`, `code`, `markdown`, `diff` and `document` are at most 49,152 bytes. The terminal keeps recent markdown
  renders, so a large `markdown` costs its parse, about 1 ms per KiB, only when its text or width changes; stream
  into `code` or `text`.
- A view or patch is at most 256 KiB of JSON and the composed view 1 MiB. Those JSON limits still apply to
  text-heavy views, and escaping can double a text (`\n`, `"` and `\` take two bytes), so clip long text on its
  `JSON.stringify` size rather than its 48 KiB length.
- Text fields refuse control characters except newlines where a field is multi-line.
- The status row holds at most 4 segments of 40 characters across all mods.

An invalid view is dropped with the failing field named and the mod's last valid view stays; `omd-mod status`
reports the composed view's diagnostics under `terminal`.
