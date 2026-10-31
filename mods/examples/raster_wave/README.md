# raster_wave

Animates a half-block wave in a `raster` with packed `terminal.blit` cells (`terminal_raster_packed_v1`). It's an
example for mod authors. OMD+ and OMD Core don't install it, and it isn't in the curated directory.

Read it if you're building a mod that animates
[rasters with `terminal.blit`](../../reference/graphics.md#rasters-terminal_raster_v1).

It's an API `1.0.0` mod that uses only the public mod API, like any outside author's mod
([host primitives](../../reference/host-model.md#host-primitives)), and it uses no first-party mod. It shows:

- The command hops through `events.publish` to the mod's own `channel` handler, which schedules the first `timer`
  tick 100 ms later, so the state the command wrote is in place before the first tick. After a frame is shown, each
  tick reschedules itself 16 ms later. A failed blit reschedules after 250 ms.
- Each tick draws a whole frame: one `▀` per cell with the top and bottom pixel as foreground and background, packed
  as little-endian u32 `[codePoint, fg, bg]` triplets and base64-encoded with a small helper, since the runner has
  no `btoa`.
- The reply's `frame` counts the frames the terminal showed, so the status line reports frames and cells shown per
  second. Updates that arrive between two frames merge into the next one.
- The animation stops while the client asks for reduced motion, and a stopped wave schedules nothing. It doesn't
  resume when reduced motion clears. Run `/raster_wave:wave start` to start it again.

## Install it

From a checkout of this repository:

```sh
omd install ./mods/examples/raster_wave
omd mods enable raster_wave
```

Grant `terminal`, `commands`, `events` and `store`. See [Manage mods](../../../docs/manage-mods.md) for the other
ways to install mods, and [Trust and permissions](../../../docs/trust-and-permissions.md) for what a grant allows.

## Use it

In an [`OMD_MODE=omd`](../../reference/host-model.md#omd_mode) session, run `/raster_wave:wave` to start the wave and
run it again to stop. `/raster_wave:wave start` and `/raster_wave:wave stop` set it directly.

### Test it

`mod.test.json` runs offline and checks the layout, a start, a tick and a stop. `raster_wave.test.mjs` decodes the
packed cells the tick sends. From the repository root:

```sh
python3 scripts/mod_host_check.py --no-commands --scenarios raster_wave
mise exec -- node --test mods/examples/raster_wave/raster_wave.test.mjs
```

It uses the `omd-mod` on your `PATH`. [Tests](../../../tests/README.md) covers the other test runners.

## Settings

Change settings in `/mods`.

| Setting | Default | What it does |
| --- | --- | --- |
| `mode` | `packed` | `packed` sends packed cells. `cells` sends the same frame as JSON `[glyph, fg, bg]` cells for comparison. |
| `width` | `64` | Raster width in cells, up to 512. |
| `height` | `16` | Raster height in cells, up to 256. Each cell draws two pixels. |

## Needs and limits

- It needs a host with `terminal_raster_packed_v1`.
- It's a rendering demonstration, not a tool you'd keep on.

## More

- [Terminal UI reference](../../reference/terminal-ui.md)
- [Graphics reference](../../reference/graphics.md)
- [Events and lifecycle reference](../../reference/events-and-lifecycle.md)
