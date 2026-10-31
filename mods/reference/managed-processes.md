# Managed processes

Use it when a mod runs a long-lived helper process, such as a language server, and exchanges framed messages with
it, or when a package declares an adapter or the session configures code-mode kernels. A process that feeds a
terminal raster is described in [Graphics](graphics.md#raster-processes-process_raster_v1).

Mod API `1.0.0`: `process.*` is frozen; raw streams (`process_streams_v1`) are experimental. Platform: Apple Silicon
macOS, in the native sandbox.

The `exec` capability grants `process.which`, `process.start`, `process.exchange`, `process.status`, and
`process.stop`. The host resolves an installed executable and its hash, verifies that identity at launch, and runs
it in a read-only repository sandbox with restricted network access and a private scratch directory.

- A process session is the named handle that `process.start` creates. Each one belongs to one mod and generation.
  The host cleans it up when the mod is disabled or reloaded, the call is cancelled or the thread stops.
- A process cannot write the repository through this API.

## Process operations

| Operation | Arguments | Result |
| --- | --- | --- |
| `process.which` | `{names, sandbox?: 'none'}` | `{found: [{name, path, sha256}]}` |
| `process.start` | see [`process.start` options](#processstart-options) | `{session, running: true}` |
| `process.exchange` | `{session, send?, wait_ms?}` | `{session, messages, running: true}` |
| `process.status` | `{session}` | `{session, running: true, idle_ms}` |
| `process.stop` | `{session}` | `{stopped}` |

- `process.which` resolves 1 to 8 names and leaves out names that don't resolve. With `sandbox: 'none'` it
  resolves as an unsandboxed `process.start` does (the `os` grant), so a version-manager shim returns its link
  path, not the manager's binary.
- `process.start` needs the `path` and `sha256` that `process.which` returned for `name`.
- `process.exchange` writes `send`, then waits up to `wait_ms` for messages; see
  [`process.exchange`](#processexchange).
- `process.status` and `process.exchange` fail with `process_stopped` once the process has exited and its output
  has been read.

### Process limits

| Limit | Value |
| --- | --- |
| Sessions | 8 per host, 5 per mod; a session name is used once |
| Session name | 1 to 64 characters of `A-Z`, `a-z`, `0-9`, `-` and `_` |
| `arguments` | at most 16, 4,096 bytes in total |
| `environment` | at most 8 variables; names 1 to 64 characters of `A-Z`, `0-9` and `_`; values at most 1,024 bytes |
| Executable | at most 128 MiB |
| Framed message | at most 4 MiB |
| `content-length` header | 8 KiB |
| `send` per exchange | at most 32 messages |
| `wait_ms` | default 0, at most 10,000 |
| Messages returned per exchange | at most 64 and 256 KiB encoded, but at least one when any is queued |
| Queued output | 128 messages, 32 MiB |

### Process errors

| Error | When |
| --- | --- |
| `process_candidate_limit` | `process.which` without names or with more than 8 |
| `process_program_or_arguments_invalid` | A session name, argument, variable, framing, network or `stdin` value is invalid, or `path` is not what `name` resolves to |
| `process_executable_changed` | The file at `path` does not match `sha256` or is over 128 MiB |
| `process_session_limit_or_duplicate` | The session limit is reached or the name is in use |
| `process_notify_invalid` | `notify` has entries other than `output` and `exit` |
| `process_program_declined` | The user declined the first unsandboxed start of the program |
| `process_exchange_limit` | `send` has more than 32 messages or `wait_ms` is over 10,000 |
| `process_message_invalid_or_too_large` | A sent message is not an object or is over 4 MiB |
| `process_stdin_null` | `send` to a process started with `stdin: "null"` |
| `process_stopped` | The process has exited and its output has been read |
| `process_session_unavailable` | No such session for this mod |
| `process_cancelled` | The call was cancelled |

### Process example

```ts
const { found } = api.host.call('process.which', { names: ['pyright-langserver'] });
const server = found[0];
api.host.call('process.start', { session: 'py', name: server.name, path: server.path, sha256: server.sha256, arguments: ['--stdio'] });
const { messages } = api.host.call('process.exchange', { session: 'py', send: [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }], wait_ms: 1000 });
```

## Framed processes

Each process frames its stdio in one of three ways, chosen at `process.start`, and gets its own environment and
sandbox.

### `process.start` options

```text
process.start {session, name, path, sha256, arguments?, environment?, framing?, network?, notify?, sandbox?,
               raster?, keys?, pixels?, stdin?}
```

`process.start` takes:

- `framing: "content-length"` (default), `"ndjson"` or `"raw"`. The host stops a process whose stdout breaks the
  framing: a line that isn't JSON under `ndjson`, or a blank line or 8 KiB without a valid header under
  `content-length`. stderr is discarded except under `raw`, which streams both unframed.
- `network: "none"` or `"loopback"`.

`network`, `stdin`, `environment` and `sandbox` are described below, `notify` under
[Process notifications](#process-notifications), and `raster`, `keys` and `pixels` under
[Raster processes](graphics.md#raster-processes-process_raster_v1).

### `process.exchange`

`process.exchange` returns messages until the next one would push the encoded `messages` past 256 KiB (at most 64,
and always at least one), so a result fits the callback's
[1 MiB host call transport budget](host-model.md#host-call-transport-budget). The rest stays queued for the next call.

After the process exits, its readers get one second to deliver what it wrote. Exchanges return that queued output
first, and the exchange after that fails with `process_stopped`. `process.status` reports `running: true` until that
output has been exchanged. Once the process has exited, the host drops the `send` of any exchange.

### `stdin: "null"`

`stdin: "null"` starts the process with standard input at end of file, for commands that would otherwise wait on an
open pipe. Its exchanges cannot `send` (`process_stdin_null`) and it cannot take `raster`.

### Raw streams (`process_streams_v1`)

Experimental (`process_streams_v1`). Under `framing: "raw"` the host reads stdout and stderr as the process writes
them and queues each read as `{stream: "stdout" | "stderr", data}`. A read is at most 8,000 bytes, so a chunk fits one
exchange even when every byte is escaped.

- Bytes that are not UTF-8 arrive as their own `{stream, data_base64}` chunk between the text chunks around them,
  so one read can queue several chunks.
- A character split across writes arrives whole in the later chunk.
- The two streams are separate pipes, so chunks keep their order within a stream but not across streams.
- `send` takes strings, written verbatim.
- The queue keeps its bound of 128 messages: a process that writes faster than the mod exchanges blocks on its
  pipe, and nothing is dropped.
- `raw` cannot take `raster`, `keys` or `pixels`.

### Process environment and sandbox

These rules set what a started process can see and reach.

- The host replaces `{process.home}` in process arguments with that session's private scratch directory, for tools
  that do not honor the `HOME` environment.
- `environment` supplies explicit variables to that process ([Process limits](#process-limits)). The host
  rejects its own reserved variables and loader overrides.
- Sandboxed processes also cannot read or write protected and credential paths.
- `network: "loopback"` (with the `network` capability) allows local binding while keeping external network access
  restricted.
- The host terminates the started process's whole process group. Each process gets an owner-only scratch directory,
  and a sandboxed process starts with a cleared host environment.

With the `os` grant, `sandbox: "none"` starts a listed program (`path` and `sha256` still pinned) with the same
environment rules as [unsandboxed `exec.run`](running-commands.md#execrun-with-sandbox-none); `network` comes from
`os_access`. The first start of a binary asks the user, who can decline (`process_program_declined`); see
[Authority grants](authority-grants.md#os_access-manifest-field). The host still manages the process: it enforces
limits, handles cancellation and tears down the process group. It stops the process when the grant expires or is
revoked, when the mod reloads or is disabled, or when the mod's source changes.

### Process notifications

`process.start {notify: ['output','exit']}` delivers coalesced `process_event`s. `exit` fires once, when the
process group leader (the started program) exits, even while a background child keeps the output streams open and
more output may follow.

A `process_event` exit contains only the session; read the exit status with `process.status`.

## Adapters

An adapter module translates the Mod API for other packages: its default export receives a dependent package's `api`
and returns the object that package's default export is called with. A library package can declare
`adapter_module: {entry, aliases}`. A dependent package with `adapter: "<package id>"` is wrapped by that module
before activation and may import its aliases. The adapted package keeps only its own capabilities.

## Code-mode kernels

A kernel is a persistent interpreter that the `kernel` code-mode tool runs cells in. Kernels are Codex configuration,
not a Mod API: `[[features.code_mode.kernels]]` entries with `name`, `command`, absolute `driver` and
`driver_sha256` register kernels for the `kernel` code-mode tool. The driver hash is checked before each worker
starts; with no entries the tool reports that no kernel is configured.

## Expected failures and `api.host.tryCall`

`api.host.tryCall` returns `{ok:true,value}` or `{ok:false,error}` for an operation that is expected to be
unavailable, such as a language server that isn't installed. A mod can then report a fallback without the missing
server counting as a callback failure. `call` and `tryCall` go through the same declared capability and host
permission checks.
