# Processes, kernels and events

This page covers framed processes and their streaming, raster and pixel-buffer protocols, terminal list hooks,
code-mode kernels, library adapters, and the channel, process, watch and timer events. Use it when a mod runs a
managed process, feeds a terminal raster, or reacts to background events.

## Framed processes

### `process.start` options

`process.start` takes:

- `framing: "content-length"` (default), `"ndjson"` or `"raw"`;
- `network: "none"` or `"loopback"`.

### `process.exchange`

`process.exchange` returns messages until the next one would push the encoded `messages` past 256 KiB (at most 64,
and always at least one), so a result fits a callback's receipt budget; the rest stays queued for the next call.

Once the process exits, its readers get one second to deliver what it wrote. Output queued by then is returned
before the exchange that fails with `process_stopped`. `process.status` reports `running: true` until it has been
exchanged, and an exchange's `send` is dropped.

### `stdin: "null"`

`stdin: "null"` starts the process with standard input at end of file, for commands that would otherwise wait on an
open pipe. Its exchanges cannot `send` (`process_stdin_null`) and it cannot take `raster`.

### Raw streams (`process_streams_v1`)

Experimental (`process_streams_v1`): under `raw` the host reads stdout and stderr as written and queues each read
(at most 8,000 bytes, so a chunk fits one exchange even when every byte is escaped) as `{stream: "stdout" |
"stderr", data}`.

- Bytes that are not UTF-8 arrive as their own `{stream, data_base64}` chunk between the text chunks around them,
  so one read can queue several chunks.
- A character split across writes arrives whole in the later chunk.
- The two streams are separate pipes, so chunks keep their order within a stream but not across streams.
- `send` takes strings, written verbatim.
- The queue keeps its bound of 128 messages: a process that writes faster than the mod exchanges blocks on its
  pipe, and nothing is dropped.
- `raw` cannot take `raster`, `keys` or `pixels`.

### Process environment and sandbox

- The host replaces `{process.home}` in process arguments with that session's private scratch directory, for tools
  that do not honor the `HOME` environment.
- `environment` supplies at most eight explicit, bounded variables to that process. The host rejects its own
  reserved variables and loader overrides.
- Sandboxed processes also cannot read or write protected and credential paths.

With the `os` grant, `sandbox: "none"` starts a listed program (`path` and `sha256` still pinned) with the same
environment rules as unsandboxed `exec.run`; `network` comes from `os_access`. The host keeps ownership, limits,
cancellation and process-group teardown, and stops it when the grant expires or is revoked, the mod reloads or is
disabled, or its source changes.

### Raster processes (`process_raster_v1`)

With `process_raster_v1` and the `terminal` capability, an `ndjson` process can take:

- `raster: KEY` (one of the caller's raster ids);
- optionally `keys: ID` (a `keys: true` component).

Its stdout messages `{"blit": {media_type, base64}}` are drawn into that raster by the host as `terminal.blit {key,
image}` from the mod, with the same validation, but without a callback per frame. The newest frame wins, and a
frame the terminal cannot take yet is retried for up to 5 s.

### Pixel buffers (`raster_pixels_v1`)

With `raster_pixels_v1` and `pixels: true` the host also creates a private raw buffer and sends `{"pixels":
{"source": HANDLE, "path": PATH}}` on stdin before bound input. Without it the process gets no buffer and its raw
publications stop it with `terminal_blit_source_not_owned`.

The child opens that file, writes exactly `width * height * channels` packed bytes at offset zero, and publishes:

```json
{"blit": {"pixels": {"source": HANDLE, "format": "rgb" | "rgba", "width": W, "height": H, "sequence": N}}}
```

The equivalent mod call is `terminal.blit {key, pixels: {...}}`. Sequence numbers start at 1 and increase for each
publication.

### Pixel publication acknowledgement

The child must not modify the buffer until stdin acknowledges `{"pixels": {"source": HANDLE, "sequence": N,
"ready": true, "error": null}}`.

- The host sends a successful acknowledgement when the next frame should start, not right after the copy: it aims
  the next publication just before the following 16 ms tick, using the time the producer took from its previous
  acknowledgement to publish.
- A producer that renders on each acknowledgement shows fresh frames with one copy per shown frame.
- An owned invalid descriptor or failed copy returns `ready: false` with an error at once.
- A failed copy does not consume the sequence, so direct callers may retry the same publication.
- Retrying an accepted publication reuses its copy without a second acknowledgement.

### Pixel publication retries and backpressure

A managed producer's pending raw publication is retried while the process is active only for surface, layout and
callback admission errors (`terminal_blit_unknown`, `terminal_blit_not_owned`, `terminal_blit_limit`, `callback_*`,
`client_surface_*`). Any other error, and confirmed owner revocation, stops the process.

- While a raw frame waits for its 16 ms tick, a newer raw publication gets backpressure.
- A raster whose last frame stayed undrawn for four ticks (an inactive tab or unplaced layout) answers
  `retry_after_ms: 250` until it is drawn again.
- Backpressure neither copies nor acknowledges the buffer, so the same publication can be retried safely.

### Pixel buffer safety and limits

- The host retains the original descriptor, copies a bounded immutable frame, and never reopens a child-supplied
  path. Replacing the pathname cannot redirect the read.
- Handles are bound to the thread, mod generation, raster and process lifetime; stopping/reloading the process
  revokes them.
- Frames are limited to 4096 pixels per side (64 MiB for RGBA), with one newest pending image per raster.
- General POSIX shared memory is not granted by the sandbox; the private file works under the existing process
  sandbox.

Raw frames reach Kitty without PNG encoding. Inline-image terminals and external PNG/JPEG clients receive encoded
snapshots scaled down to the raster's pixel size (a client's `cell_px`, else 8×16) and at most 8 MiB, and
cells-only clients receive half-blocks. Host paths and handles never reach external renderers.

### Frame pacing and profiling

Frames are paced at 16 ms while experimental. Use `frame_ms` and `retry_after_ms` instead of hardcoded timing.
Encoded producers keep their stdin and stdout shapes.

For local profiling, `OMD_FRAME_TRACE=/absolute/new/file.jsonl` enables per-stage wall and thread-CPU timings; the
file must not already exist.

### Raster pointer, key and box input

Other messages reach `process_event` and `process.exchange` as usual. Input on a bound raster is written to the
process's stdin instead of `component_event` callbacks:

| Input | Stdin message |
| --- | --- |
| Pointer events on the raster | `{"pointer": {action, button, x, y, inside}}`, with `x`/`y` in the drawn frame's pixels (null before a frame; sub-cell on terminals that report pixel positions) |
| Key and paste input on the keys component | `{"input": [events]}` |
| After the first render, and whenever the raster's drawable box or the client cell changes | `{"box": {columns, rows, cell_px: {width, height}}}` |

- A left press on the raster focuses the keys component.
- Bindings are scoped to the owning conversation thread.
- Input queues hold at most 128 messages and 256 KiB; consecutive motion and resize messages coalesce.
- Overflow or a write blocked for two seconds stops the process and discards queued input.
- The binding ends with the process.
- An invalid key or another framing is `process_raster_invalid`; without `terminal`, `capability_denied: terminal`.

## Terminal lists, insert, placeholder and glyphs

A `render` hook on component `list` draws built-in pickers as components; the host keeps keyboard handling,
selection and the chosen action. Components accept an `{insert}` action.

A terminal view may set `placeholder` and `theme.glyphs` (2–4 printable ASCII characters mapped to the same number
of characters; width-changing mappings are ignored).

## Code-mode kernels

Kernels are configuration: `[[features.code_mode.kernels]]` entries with `name`, `command`, absolute `driver` and
`driver_sha256` register kernels for the `kernel` code-mode tool. The driver hash is checked before each worker
starts; with no entries the tool reports that no kernel is configured.

## Adapters

A library package can declare `adapter_module: {entry, aliases}`. A dependent package with `adapter: "<package
id>"` is wrapped by that module before activation and may import its aliases. The adapted package keeps only its
own capabilities.

## Channels, processes and watches (`events_v1`)

### `events.publish`

`events.publish {channel, data, correlation?}` publishes under the caller's namespace. Subscribers declare channel
patterns and receive `channel` events (256 events / 1 MiB per subscriber) in the publishing thread.

- Events whose originating thread is gone are dropped.
- Sequence numbers are independent per publisher/channel.

### Channel counters

The host retains at most 256 channel counters per publisher and 4,096 process-wide. A new channel beyond either
limit fails with `channel_sequence_limit`, while existing channels remain publishable.

- On publication, counters for a publisher with no successful publication for at least 15 minutes and no queued
  events are reclaimed. Its next publication starts at sequence 1.
- Successful publication with no subscribers still counts as activity; rejected publication does not.
- Unsubscribing alone does not reset counters.

### Process notifications

`process.start {notify: ['output','exit']}` delivers coalesced `process_event`s. `exit` fires once, when the leader
exits, even while a background child keeps the output streams open and more output may follow.

`process_event` exits carry only the session; read the exit status with `process.status`.

### `workspace.watch`

`workspace.watch {paths, recursive?, debounce_ms?, include_ignored?, key?, git?}` reports external edits as `workspace_change`
with source `external`.

- At most 16 watches per mod.
- A `key` (1-64 bytes) names one watch per mod in this OMD process. Calling again from the same thread with the
  same arguments keeps it; other arguments or another thread replace it without counting against the limit, and
  changes it already queued are still delivered. `workspace.unwatch {key}` stops it; `{watch_id}` stops one of the
  mod's watches. Keys require `workspace_watch_key_v1`.
- Protected paths are always excluded.
- Git-ignored paths are excluded unless `include_ignored` is true.
- `git: true` (`workspace_watch_git_v1`) also reports changes to the repository's Git metadata, found from the
  workspace root upward (linked worktrees and submodules included): `HEAD`, `index`, `packed-refs` and `refs/…`, as
  paths `.git/HEAD` and so on with `before` and `after` null. Lock files and objects are left out. A `.git` file is
  followed only to a Git directory that proves the link: a worktree's backlink, or a submodule directory under an
  enclosing repository's `.git/modules`. Outside a repository, and for a `--separate-git-dir` repository or a submodule
  of a linked worktree, the call fails `watch_git_unavailable`.

### Callback delivery

- Watches and timers end when their mod is disabled or its source changes, and each delivery runs in the thread
  that registered it.
- A `channel`, `timer`, `process_event` or watched `workspace_change` callback that changes its mod's state
  republishes the terminal view, so background results appear without waiting for the next turn.

### Timers (`timers_v1`)

`events.schedule {key, delay_ms}` (`timers_v1`) delivers one `timer` event `{key}` to the calling mod after 16 ms
to 24 h.

- Scheduling a key again replaces it within that thread.
- `events.cancel {key}` stops only that thread's timer.
- There are 16 timers per mod across all threads, including ticks pending delivery.
- Require `timers_16ms_v1` for delays below 1000 ms.
- Deliveries are spaced at least 16 ms apart per mod/thread, and each is a full callback: draw animation from a
  component module's frame clock instead.
- Pending ticks with the same key coalesce, and other owners continue while one owner waits for its budget.
- A timer never starts a turn by itself; only `turns.queue` under an `autonomous` grant can.
