# Frame stream

A conformance fixture (not packed in the author SDK) of a full-pane raster fed
by a managed Node process. The producer supports encoded PNG and file-backed
RGB publication (`raster_pixels_v1`). The same raw transport works for video
decoders, image viewers and simulations. The synthetic producer offers up to
120 frames/sec; the host's 16 ms raster cadence folds pending images to the
newest frame.

From a repository checkout, set `producer` to the absolute path of
`scripts/frame_producer.mjs` and `transport` to `raw` or `png`, then trust and
enable this directory. No model request is required. The producer writes timing
records inside its private process directory; the mod exposes their path as
`state.metrics`.

Raw mode starts the process with `pixels: true`, opens the host-provided
`pixels.path`, writes one packed RGB frame,
and publishes its source handle, dimensions and increasing sequence number.
It waits for the matching acknowledgement before overwriting that file. The
host copies an immutable frame before acknowledging it. Handles are scoped to
the process binding and package generation and disappear on process cleanup.
Raw errors other than temporary surface, layout and callback admission stop
the producer; backpressure, including a newer frame arriving before the
pending one is drawn, leaves the buffer unconsumed for retry.

## Optional mouse look on macOS

Compile `scripts/mouse_look.swift` with `swiftc -O` and set `mouse_helper` to
the resulting absolute path. This requests the existing `os` capability and
an unrestricted child process; cursor control belongs to this author helper.
The default renderer stays sandboxed and does not request cursor access.

Click inside the raster to lock and hide the cursor. The windowless helper
takes foreground focus while locked so macOS can hide and pin the pointer;
ordinary typing does not reach the terminal during that time. Relative movement
changes the scene horizontally. Esc or Command releases it and returns focus
to the terminal; focus loss, process exit and a ten-second safety timeout also
release it. Switching to another app releases without taking focus back.
Ctrl+J is not a mouse-look binding. macOS may require the terminal application's
existing OS privacy grants for cursor control. The helper reports activation,
monitor, cursor association and cursor hiding failures in the producer's metrics
file; it does not report a successful lock until activation and cursor setup succeed.
Motion is summed and emitted every 8 ms while locked. If the helper's output
pipe closes or fills, it releases the cursor and refuses further locks for
that helper process.
The helper preserves `NSEvent` movement deltas without sensitivity scaling.
Older background `CGGetLastMouseDelta` runs that captured no movement are not
a mouse-sensitivity baseline. Compare frame rates with matching mouse activity;
the frame-rate harness does not generate mouse movement.

The local macOS probe succeeds unrestricted and rejects cursor association
under the base read-only Seatbelt profile. The helper therefore requires both
the package's `os` grant and `sandbox: none`; physical click/move and Esc/Command
release still require the terminal walkthrough.

## Measurement

On macOS with Screen Recording access, run:

```sh
mise exec -- python3 scripts/frame_rate_check.py --binaries /path/to/release --terminal kitty --transport raw
```

Use `ghostty`, `orca` or `wezterm` for another installed terminal. `--mouse`
builds and enables the optional helper. Each run creates its own terminal and
fixture, performs no provider requests, and closes that terminal afterwards.
The capture reads sequence markers from WindowServer-presented frames. It
reports shown FPS over the full capture after a three-second warmup, including
zero-frame windows and a rate-normalized final partial second,
producer-to-presentation latency, capture cadence, process CPU and opt-in native
stage timings. Stage CPU totals overlap when one stage contains another; they
must not be added together. Orca and other shared app process CPU can include
unrelated windows. Logs and a screenshot remain in the printed run directory.
Captures are limited to 400 seconds to leave startup allowance before the
16-bit marker wraps at 120 FPS; already-wrapped producer logs are rejected.
