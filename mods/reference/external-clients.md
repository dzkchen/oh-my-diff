# External clients

Use it when you build or review a renderer other than the terminal, such as a desktop window, an editor webview or a
text console. A client attaches to a running session over JSON-RPC to Codex's app server (see
[Transports and auth](#transports-and-auth)) and draws the same composed mod view. Oh My Diff ships no desktop or editor
client of its own; a mod ships its adapter (see [Client adapters](#client-adapters)). The exact messages are in the
[`omd-client/1` protocol](omd-client-protocol.md), and the steps to build one are in
[Build an external client](../../docs/mod-authors/build-a-client.md).

In Mod API `1.0.0` the `omd/*` methods are experimental and need the `experimentalApi` opt-in
([Initialize and errors](omd-client-protocol.md#initialize-and-errors)). The host runs on Apple Silicon macOS, and
the client SDK runs in browsers and Node.

## Transports and auth

- `unix://PATH`, or `unix://` for the default socket under `$CODEX_HOME`: a WebSocket over a 0600, owner-checked
  Unix socket, no token. The default choice for local clients.
- `ws://IP:PORT` with `--ws-auth capability-token` (`--ws-token-file` or `--ws-token-sha256`) or `--ws-auth
  signed-bearer-token` (`--ws-shared-secret-file`, optional `--ws-issuer`/`--ws-audience`). A non-loopback listener
  refuses to start without auth.
- `stdio`: the spawning process speaks newline-delimited JSON-RPC to `codex app-server`.
- `codex app-server --listen URL` runs a headless host, with no terminal.
- `codex --listen URL` serves the running terminal session's app server, so a client attaches beside the terminal.
  It takes the same `--ws-*` flags, including `--ws-allowed-origin`, and accepts only `unix://PATH` or
  `ws://IP:PORT` with an explicit port. It refuses a bare `unix://` and port 0.

## WebSocket bearer tokens and origins

- Native clients send `Authorization: Bearer <token>`.
- Browsers offer the subprotocols `codex-app-server` and `codex.bearer.<token>` instead, and the server selects
  `codex-app-server`.
- The server compares the raw token, so a capability token used from a browser must be base64url or hex
  (subprotocol values cannot contain `+`, `/` or `=`, and browsers may log them).
- `--ws-allowed-origin ORIGIN` (repeatable, `scheme://host[:port]`, requires `--ws-auth`) allows a browser or
  webview origin. Origins are compared exactly after normalization, which drops a default port (`:80`, `:443`); any
  other `Origin` is refused.
- The `codex exec-server` listener (upstream Codex's remote execution environment) honors the same allowed origins
  and subprotocol bearer.

## Client adapters

A client adapter is the part of a mod that starts the client's UI process. The mod ships the adapter. It starts the
UI process with `process.start` from a native callback, such as a `channel` handler that a command publishes to. The
adapter starts it in one of two ways:

- Unsandboxed, with `{sandbox: 'none'}`, which needs the `os` capability with the program in `os_access.programs`
  (for example `node`).
- Sandboxed, with `network: 'loopback'`, which needs the `network` capability and works with a loopback `ws://`
  listener.

In both cases:

- It passes the listen URL and the token, or a token file path, through `environment` or on ndjson stdin.
  Environment names must be listed in `exec_environment`, and a name containing `TOKEN`, `KEY` or `SECRET` needs
  `--allow-secret-env`.
- The host stops the process with the mod.
- Its stdout is the framed message channel, so a UI process logs to stderr or a file: output that breaks the
  framing stops the process (an `exit` `process_event` follows).

## Client SDK (`@oh-my-diff/mod-api/client`)

The UI process connects with the SDK in `@oh-my-diff/mod-api/client`:

```text
connect({url, token?, command?, name, renderer, operations?, reconnect?, onView, onRoster, onMirrored, onSurfaceCall?, onServerRequest?, onNotification?, onReconnect?, onClose?})
```

It is dependency-free ESM for browsers and Node over `ws://`/`wss://` (bearer subprotocol), `unix://PATH` and
`stdio` (Node; spawns `codex app-server`).

- The object `connect` returns has `attach`, `update`, `detach`, `read`, `event`, `action` (serialized), `render`,
  `resource`, `recovery` and `request(method, params)`. Together they cover every `omd/*` and app-server method.
- After a disconnect it reconnects with backoff (`reconnect: false` turns that off), re-initializes, re-attaches,
  replays the last update, resumes the threads it resumed through `request('thread/resume', …)` and reports
  `onReconnect({epoch, previousEpoch})`.
- `unsupported(component, renderer, drawable)` returns null when the renderer can draw the component. Otherwise it
  returns an error with `fallback` set to the component's alt text, text or label. A renderer can't draw a type
  outside `drawable`, a `raster` without `cells` or an `image` without an image format. The error message has the
  form `unsupported_element: <type> '<id>': <reason>; drawing its fallback "<text>"`.

`mods/examples/external_client` (a text renderer) and `mods/examples/approval_desk` (a GUI-shaped renderer that
answers approvals) are complete adapters for unrelated mods.

## Security

Clients cannot mint grants or evidence. No `omd/*` method writes a grant, consent or evidence record. The host
resolves actions against its own view. Events reach only the component's owner, and a client can read only resources
in the view.

Mod callbacks still run in the mod's [runner](glossary.md#mods-and-the-host), without ambient Node, DOM or secrets.
Only the confined renderer process uses its own UI runtime.
