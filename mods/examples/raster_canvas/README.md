# Raster canvas example

An independent-author API `0.2.0-experimental.5` mod that exercises the terminal raster, pointer and overlay API (`terminal_raster_v1`).

- The sidebar holds a 40x8 `raster` component, `canvas_graph`, with `pointer: true`. The mod draws a sine series into it with `terminal.blit`, one `[glyph, fg, bg]` cell per position, and the raster shows its `alt` text until the first frame.
- A `start` event schedules a one-second `events.schedule` timer. Each `timer` tick enqueues up to 30 frames, one per 16 ms host frame, then reschedules itself. A `backpressure` result ends that tick's enqueueing early.
- Animation stops while the last `terminal` event's `client` reports `reduced_motion` or `pointer: 'none'`, and no timer is scheduled for such a client; the next pointer `enter` under an animating client restarts it (rescheduling the key replaces the pending timer). The client is kept in `api.state`; a counter in state drives the animation, never the clock.
- Hovering (`enter`, `move`, `leave`) keeps the hovered cell in state. While it is set the mod returns the `raster_canvas/tip` overlay site anchored to the raster, offset to the pointer, showing the value under it. Dragging (`down`, `drag`, `up`) pans the series and redraws immediately, so panning works without animation.

`mod.test.json` runs offline: a cells client renders the raster without a tip, a pointer enter and move add the tip overlay, and a reduced-motion client schedules no further animation. Run it with `python3 scripts/mod_host_check.py --omd-mod <omd-mod> --no-commands --scenarios raster_canvas`.

Install it with `omd-mod`, grant `terminal`, `lifecycle`, `events` and `store`, and run it in an `OMD_MODE=omd` session on a mouse-capable terminal. This is a local API demonstration, not a rendering benchmark.
