# Raster wave example

Animates a half-block wave in a `raster` with packed `terminal.blit` cells (`terminal_raster_packed_v1`). It's an independent-author API `1.0.0` mod and uses no first-party mod.

## What it shows

- `/raster_wave:wave [start|stop]` toggles the animation. The command hops through `events.publish` to the mod's own `channel` handler, which schedules the first `timer` tick; each tick reschedules itself 16 ms later while the wave runs, so the state the command wrote is in place before the first tick.
- Each tick draws a whole frame: one `▀` per cell with the top and bottom pixel as foreground and background, packed as little-endian u32 `[codePoint, fg, bg]` triplets and base64-encoded with a small helper, since the runner has no `btoa`.
- The reply's `frame` counts the frames the terminal showed, so the status line reports frames and cells shown per second. Updates that arrive between two frames merge into the next one.
- Setting `mode` to `cells` sends the same frame as JSON `[glyph, fg, bg]` cells for comparison, and `width` and `height` size the raster (up to 512 × 256).
- The animation stops while the client asks for reduced motion, and a stopped wave schedules nothing.

## Try it

Install it with `omd-mod`, grant `terminal`, `commands`, `events` and `store`, run `/raster_wave:wave` in an `OMD_MODE=omd` session, and run it again to stop.

## Test it

`mod.test.json` runs offline and checks the layout, a start, a tick and a stop. `raster_wave.test.mjs` decodes the packed cells the tick sends.
