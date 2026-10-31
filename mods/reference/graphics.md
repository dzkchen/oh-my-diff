# Graphics

Use it when a mod shows pictures or draws pixels and cells: the `image` component and its renderers, image sampling,
rasters and `terminal.blit`, the underlay, and processes that feed a raster frames or raw pixel buffers. Which renderer
a terminal or client offers is in the [`terminal` event `client`](terminal-operations.md#terminal-event-client).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](stability-and-migration.md#experimental-entries-in-the-registry)); rasters and `terminal.blit` are
experimental. They draw in the OMD terminal on Apple Silicon macOS and in
[external clients](external-clients.md).

## `image` component

An `image` draws a picture in its cells, aspect-fit to the measured cell size. The renderer depends on the terminal:

| Renderer | Where |
| --- | --- |
| Kitty graphics image (Unicode placeholders, so it scrolls, clips and hides under dialogs and overlays like text) | local Kitty and Ghostty |
| iTerm2 inline image (`iip`) | local Orca, iTerm2 and WezTerm |
| Truecolor half-block cells | elsewhere |
| Alt text | under `NO_COLOR` or below 4 columns |

Each image component has its own image id; replacing or removing the component deletes it, and exit and suspend
delete every image.

## Image formats and pixel mapping

An image is PNG or JPEG, at most 8 MiB and 4,096 pixels a side (`terminal_raster_v1`). An SVG `image`
([`svg_assets_v1`](state-and-storage.md#svg-assets-svg_assets_v1)) draws `[image unavailable: alt]` in the terminal,
which has no SVG rasterizer; external renderers receive the same resource and draw it natively.

The image is aspect-fit into the component's cells from its top-left cell. Kitty uses `client.cell_px` as the cell
size, or 8×16 pixels when that is unknown. Half-block cells count as 1×2 pixels. With these sizes a mod can map
`pointer` cells and `half` rows on an `image` back to image pixels.

## `terminal.image_sample`

Use it to read a picture's colors at cell resolution, for example to draw it into a raster.
`terminal.image_sample {resource, columns, rows}` (experimental) returns `{width,height,rgba}` (row-major RGBA bytes)
for a caller-owned PNG/JPEG.

| Limit | Value |
| --- | --- |
| Columns | integers 1..120 |
| Rows | 1..60 |
| Source size | at most 8 MiB |
| Source dimensions | 4,096 pixels per dimension |
| Decoder allocation | 64 MiB |

## Rasters (`terminal_raster_v1`)

A raster is a keyed canvas of cells that a mod fills with `terminal.blit`.

### `raster` component

`{type: 'raster', id, label, alt, width?, height?, pointer?}` (experimental) is a keyed canvas of 1–512 × 1–256 cells
that shows `alt` until its first frame and clips to the component's width.

- An omitted `width` fills the region's width.
- An omitted `height` shares the rows left in a layout region like `terminal`, `document`, `diff` and `list` (12
  elsewhere).
- A raster with an omitted `width` or `height` has the size it last rendered at, and a cells `terminal.blit` before
  its first render is `terminal_blit_unknown`.
- A mod can have at most 16 rasters: a blit to a 17th key is `terminal_blit_limit`; a raster's frames are dropped with
  its component.

### `terminal.blit` cells

`terminal.blit {key, rect: {x, y, width, height}, cells}` (experimental) updates part of the caller's own raster (`key`
is its id). `cells` lists the rect's cells row by row, each a one-cell glyph or `[glyph, fg, bg]` with theme colors or
null.

`terminal.blit {key, rect, packed}` (`terminal_raster_packed_v1`) passes the same cells as base64 of `rect.width ×
rect.height` little-endian u32 triplets `[codePoint, fg, bg]`, row by row:

- A code point is one printable column (no controls, combining marks or wide characters).
- A color is `0x00RRGGBB`, `0x01000000` for the theme default or `0x02000000 | index` for a 0–255 palette color;
  under `NO_COLOR` every cell draws in the default colors.
- A cell takes 16 bytes of base64, about half a colored JSON cell, and the host decodes it without a JSON tree. The
  runner has no `btoa`; the [`raster_wave`](../examples/raster_wave/index.ts) example has a base64 encoder.
- A callback's host calls, arguments included, share its 1 MiB
  [host call transport budget](host-model.md#host-call-transport-budget): a packed cell takes 16 bytes of it and
  a colored JSON cell about 29. Timer ticks are 16 ms apart, so a larger raster should redraw only the cells that
  change.
- External clients receive `packed` updates as `cells`.

| Error | When |
| --- | --- |
| `terminal_blit_not_owned` | The raster is another mod's. |
| `terminal_blit_unknown` | The terminal has not received the raster in a view yet, such as one returned by the same callback. |
| `terminal_blit_too_large` | One call is over 256 KiB. |
| `terminal_blit_limit` | A blit to a 17th key. |
| `terminal_blit_packed_invalid` | `packed` is not base64, is not 12 bytes a cell once decoded, or has a code point or color outside the rules above; the message names the cell. |

Cells and packed updates that reach a raster before its next 16 ms frame merge into that frame, and later cells
overwrite earlier ones. So one timer tick can draw a frame in several calls. The host drops cells identical to what
the raster already shows. A call that changes nothing returns `queued: 0` and draws no frame.

The call returns `{frame, queued, frame_ms}`. `frame` is the frame the update shows in, and `queued` counts the
pending frames, such as a picture and the cells merged after it. Merged cells never need more room than the raster,
so cell updates get `{status: 'backpressure', retry_after_ms: 250}` only while a pending frame stays undrawn for four
ticks, for example in an inactive tab or an unplaced layout. Image and pixel frames follow the pacing in
[Frame pacing](#frame-pacing-and-profiling).

### `terminal.blit` images

`terminal.blit {key, image: {media_type: 'image/png' | 'image/jpeg', base64}}` (instead of `rect` and `cells`)
draws one transient picture in a raster you own, aspect-fit from the top-left cell into the raster's width × height
cells by the same rule and renderers as `image` (Kitty placeholders, iTerm2 inline images, truecolor half-blocks,
`alt` under `NO_COLOR`).

- The newest frame replaces the previous one, a cells blit replaces the frame and a frame replaces the cells.
- It is never stored as a resource. Prefer it to a new `image` resource per frame, which uses up the record quota,
  and to cells, which give two effective pixels a cell.
- External clients whose renderer `formats` include the media type receive the frame as sent, other clients with
  `cells` receive half-block cells.

| Error | When |
| --- | --- |
| `terminal_blit_image_invalid` | A wrong media type, bad base64 or an image that does not decode within 4,096 px per side. |
| `terminal_blit_invalid` | Not exactly one of `cells`, `packed`, `image` and `pixels` is passed. |

The host returns both errors before it queues the frame.

### Underlay (`terminal_underlay_v1`)

`underlay: {raster: KEY}` draws one of the mod's own cell rasters under the whole fullscreen screen, behind the
conversation, the composer and the footer. It is experimental and exclusive: the first mod in composition order
gets it, and later claims become `terminal.conflicts` entries. A raster key another mod already draws is refused the
same way: the underlay is dropped and the conflict names that mod.

- The raster has the screen's size (at most 512 × 256) and needs no component; blit it with `terminal.blit` like any
  raster. Before the first draw a blit is `terminal_blit_unknown`. After a resize the old frame draws clipped until a
  blit at the new size starts a fresh raster; a reply with `frame: 1` and `queued: 1` means the raster restarted, so
  send it whole.
- It is painted after the transcript and the bottom pane and before selection, layout regions, the sidebar,
  overlays, the `welcome` site and dialogs, so all of those draw over it.
- Its background colors every cell whose background is the terminal default, and Codex's raised surface (menus,
  list views, the composer, submitted prompts) gets the same color lifted the way Codex lifts the terminal
  background. Text with the default color on a colored cell gets a readable foreground; explicit colors stay,
  except on a light terminal, where any that would be hard to read get a readable one.
- The underlay's glyphs draw only in blank cells after each row's last character plus a 2-cell gutter. They draw at
  full color in the transcript and at 35 % on the raised surface. Transcript images and the footer never show them,
  and OMD's own copies never include them. The terminal's own selection (for example Shift-drag) copies what the
  screen shows.
- Image and pixel frames draw nothing. Nothing draws under `NO_COLOR`, with fewer than 256 colors (`colors: '16'`),
  below 60 columns, inline (`--no-alt-screen`) or in an external client.

## Raster processes (`process_raster_v1`)

With `process_raster_v1` and the `terminal` capability, `process.start` for an `ndjson`
[managed process](managed-processes.md) accepts:

- `raster: KEY` (one of the caller's raster ids);
- optionally `keys: ID` (a `keys: true` component).

The host draws each stdout message `{"blit": {media_type, base64}}` into that raster, as if the mod had called
[`terminal.blit {key, image}`](#terminalblit-images). It applies the same validation but needs no callback per
frame. The newest frame wins, and a frame the terminal cannot take yet is retried for up to 5 s.

### Pixel buffers (`raster_pixels_v1`)

With `raster_pixels_v1` and `pixels: true` the host also creates a private raw buffer and sends `{"pixels":
{"source": HANDLE, "path": PATH}}` on stdin before any raster input. Without `pixels: true` the process gets no
buffer, and the host stops the process with `terminal_blit_source_not_owned` when it publishes raw pixels.

The process opens that file, writes exactly `width * height * channels` packed bytes at offset zero, and publishes:

```text
{"blit": {"pixels": {"source": HANDLE, "format": "rgb" | "rgba", "width": W, "height": H, "sequence": N}}}
```

The equivalent mod call is `terminal.blit {key, pixels: {...}}`. Sequence numbers start at 1 and increase for each
publication.

### Pixel publication acknowledgement

The process must not modify the buffer until stdin acknowledges `{"pixels": {"source": HANDLE, "sequence": N,
"ready": true, "error": null}}`.

- The host sends a successful acknowledgement when the next frame should start, which can be later than the copy.
  It times the acknowledgement so the next publication arrives just before the following 16 ms tick, based on how
  long the process took to publish after its previous acknowledgement.
- A process that renders on each acknowledgement shows fresh frames with one copy per shown frame.
- An owned invalid descriptor or failed copy returns `ready: false` with an error at once.
- A failed copy does not consume the sequence, so direct callers may retry the same publication.
- Retrying an accepted publication reuses its copy without a second acknowledgement.

### Pixel publication retries and backpressure

A process's pending raw publication is retried while the process is active only for surface, layout and
callback admission errors (`terminal_blit_unknown`, `terminal_blit_not_owned`, `terminal_blit_limit`, `callback_*`,
`client_surface_*`). Any other error, and confirmed owner revocation, stops the process.

- While a raw frame waits for its 16 ms tick, a newer raw publication gets backpressure.
- A raster whose last frame stayed undrawn for four ticks (an inactive tab or unplaced layout) answers
  `retry_after_ms: 250` until it is drawn again.
- Backpressure neither copies nor acknowledges the buffer, so the same publication can be retried safely.

### Pixel buffer safety and limits

- The host retains the original descriptor, copies a bounded immutable frame, and never reopens a process-supplied
  path. Replacing the pathname cannot redirect the read.
- Handles are bound to the thread, mod generation, raster and process lifetime; stopping/reloading the process
  revokes them.
- Frames are limited to 4,096 pixels per side (64 MiB for RGBA), with one newest pending image per raster.
- General POSIX shared memory is not granted by the sandbox; the private file works under the existing process
  sandbox.

Raw frames reach Kitty without PNG encoding. Inline-image terminals and external PNG/JPEG clients receive encoded
snapshots scaled down to the raster's pixel size (a client's `cell_px`, else 8×16) and at most 8 MiB, and
cells-only clients receive half-blocks. Host paths and handles never reach external renderers.

### Frame pacing and profiling

Frames are paced at 16 ms while experimental, and the pacing may change; `terminal.blit` returns the current `frame_ms`,
and backpressure returns `retry_after_ms`. Processes that publish encoded frames keep their stdin and stdout shapes.

For local profiling, `OMD_FRAME_TRACE=/absolute/new/file.jsonl` enables per-stage wall and thread-CPU timings; the
file must not already exist.

### Raster pointer, key and box input

Stdout messages other than `blit` reach `process_event` and `process.exchange` as usual. Input on a bound raster is
written to the process's stdin instead of [`component_event`](terminal-input.md#component_event) callbacks:

| Input | Stdin message |
| --- | --- |
| Pointer events on the raster | `{"pointer": {action, button, x, y, inside}}`, with `x`/`y` in the drawn frame's pixels (null before a frame; sub-cell on terminals that report pixel positions) |
| Key and paste input on the keys component | `{"input": [events]}` |
| After the first render, and whenever the raster's drawable box or the client cell changes | `{"box": {columns, rows, cell_px: {width, height}}}` |

- A left press on the raster focuses the keys component.
- Bindings are scoped to the owning conversation thread.
- Input queues contain at most 128 messages and 256 KiB; consecutive motion and resize messages coalesce.
- Overflow or a write blocked for two seconds stops the process and discards queued input.
- The binding ends with the process.
- An invalid key or another framing is `process_raster_invalid`; without `terminal`, `capability_denied: terminal`.
