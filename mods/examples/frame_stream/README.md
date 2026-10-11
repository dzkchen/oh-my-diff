# Frame stream

An author example of a full-pane raster fed by a managed Node process. The
producer supports encoded PNG and file-backed RGB publication. The same raw
transport works for video decoders, image viewers and simulations.
The synthetic producer offers up to 120 frames/sec; the host's 16 ms raster
cadence folds pending images to the newest frame.

Set `producer` to the absolute path of `scripts/frame_producer.mjs` and
`transport` to `raw` or `png`. Trust and enable the package through the normal
mod author workflow. No model request is required. The producer writes timing
records inside its private process directory; the mod exposes their path as
`state.metrics`.

Raw mode opens the host-provided `pixels.path`, writes one packed RGB frame,
and publishes its source handle, dimensions and increasing sequence number.
It waits for the matching acknowledgement before overwriting that file. The
host copies an immutable frame before acknowledging it. Handles are scoped to
the process binding and package generation and disappear on process cleanup.
Fatal invalid raw publications stop the producer; ordinary backpressure leaves
the buffer unconsumed for retry.

## Optional mouse look on macOS

Compile `scripts/mouse_look.swift` with `swiftc -O` and set `mouse_helper` to
the resulting absolute path. This requests the existing `os` capability and
an unrestricted child process; cursor control belongs to this author helper.
The default renderer stays sandboxed and does not request cursor access.

Click inside the raster to lock and hide the cursor. Relative movement changes
the scene horizontally. Esc or Command releases it; focus loss, process exit
and a ten-second safety timeout also release it. macOS may require the terminal
application's existing OS privacy grants for cursor control. The helper reports
cursor association failures in the producer's metrics file.

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
reports shown FPS in complete one-second windows after a three-second warmup,
producer-to-presentation latency, capture cadence, process CPU and opt-in native
stage timings. Stage CPU totals overlap when one stage contains another; they
must not be added together. Orca and other shared app process CPU can include
unrelated windows. Logs and a screenshot remain in the printed run directory.
