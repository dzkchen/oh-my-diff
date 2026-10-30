# Managed processes

Use it when a mod runs a long-lived helper process, such as a language server, and exchanges framed messages with
it, or when a package declares an adapter or the session configures code-mode kernels. A process that feeds a
terminal raster is described in [Graphics](graphics.md#raster-processes-process_raster_v1).

The `exec` capability grants `process.which`, `process.start`, `process.exchange`,
`process.status`, and `process.stop`. The host resolves an installed executable and its hash, verifies that
identity at launch, and runs it in a read-only repository sandbox with restricted network access and a private
scratch directory.

- The framed JSON exchange has bounded message size, wait, output, and session count.
- Sessions belong to one mod and generation; disable, reload, cancellation, and thread stop clean them up.
- A process cannot write the repository through this API.
- `process.which {names, sandbox: 'none'}` resolves as an unsandboxed `process.start` does (the `os` grant), so a
  version-manager shim returns its link path, not the manager's binary.

## Language servers and `api.host.tryCall`

The first-party `omd_lsp_sync` mod owns Python, TypeScript/JavaScript, Rust and Java server choices and language
protocol; it is off by default in OMD+ and can be installed in an OMD Core store. It never installs a language
server.

- Definition, references and code-action discovery return bounded read-only results for observed sources.
- Symbol rename and text-only code actions apply with a backup and roll back on failure; actions that run server
  commands are refused.
- Absent or unsupported servers report fallback.

`api.host.tryCall` returns `{ok:true,value}` or `{ok:false,error}` for an expected unavailable operation, so a mod
can report fallback without treating server absence as a callback failure. Both `call` and `tryCall` remain subject
to the same declared capability and host permission checks.

## Framed processes

This section covers `process.start` options and framing, `process.exchange`, raw streams, the process environment and
sandbox, process notifications, service launch snapshots and request helper supervision.

### `process.start` options

```ts
process.start {session, name, path, sha256, arguments?, environment?, framing?, network?, notify?, sandbox?,
               raster?, keys?, pixels?, stdin?}
```

`process.start` takes:

- `framing: "content-length"` (default), `"ndjson"` or `"raw"`;
- `network: "none"` or `"loopback"`.

`stdin`, `environment` and `sandbox` are described below, `notify` under [Process
notifications](#process-notifications), and `raster`, `keys` and `pixels` under [Raster
processes](graphics.md#raster-processes-process_raster_v1).

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
environment rules as [unsandboxed `exec.run`](running-commands.md#execrun-with-sandbox-none); `network` comes from
`os_access`. The host keeps ownership, limits, cancellation and process-group teardown, and stops it when the grant
expires or is revoked, the mod reloads or is disabled, or its source changes.

### `process.start` framing

`process.start` frames stdio as `content-length` (default) or `ndjson`, and stops a process whose stdout breaks the
framing (a line that is not JSON under `ndjson`; a blank line or 8 KiB without a valid header under
`content-length`).

- stderr is discarded except under `raw`, which streams both unframed.
- `network: "loopback"` (with the `network` capability) allows local binding while keeping external network access
  restricted.
- `process.start` owns process group termination and starts adapters with a cleared host environment and an
  owner-only scratch directory.

### Process notifications

`process.start {notify: ['output','exit']}` delivers coalesced `process_event`s. `exit` fires once, when the leader
exits, even while a background child keeps the output streams open and more output may follow.

`process_event` exits carry only the session; read the exit status with `process.status`.

### Service launch snapshots

Service launches use private read-only sandbox snapshots of the package's admitted entrypoint and assets,
preserving their relative paths. Original package paths are denied to the child.

Grants may include `code_roots` mapping canonical dependency directories to SHA-256 digests of sorted JSON
`[relativePath, kind, value]` rows: `kind` is `file` with a content SHA-256 or `link` with an internal relative
target. Verified bytes are copied without reopening the source; `OMD_SERVICE_ROOT` names the snapshot root, under
which absolute dependency paths are mirrored.

Changed dependencies require a new grant. Reload and disable stop stale services before their IDs can be reused.

### Request helper supervision

Granted request helpers use the host's bounded request supervisor. It captures a completed helper result before
returning it, then terminates the process group; cancellation, deadline and loss of the host also terminate the
group. Existing long-running service supervision remains separate. The helper, supplied by the extension, owns
request parsing, remote protocols and content selection.

## Adapters

A library package can declare `adapter_module: {entry, aliases}`. A dependent package with `adapter: "<package
id>"` is wrapped by that module before activation and may import its aliases. The adapted package keeps only its
own capabilities.

## Code-mode kernels

Kernels are configuration: `[[features.code_mode.kernels]]` entries with `name`, `command`, absolute `driver` and
`driver_sha256` register kernels for the `kernel` code-mode tool. The driver hash is checked before each worker
starts; with no entries the tool reports that no kernel is configured.
