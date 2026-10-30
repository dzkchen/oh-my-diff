# External clients

Use it when you build or review a renderer other than the terminal, such as a desktop window, an editor webview or
a text console. A client attaches to a running session over the upstream app-server JSON-RPC and draws the same
composed mod view. Oh My Diff ships no desktop or editor client of its own; a mod ships its adapter (see [Client
adapters](#client-adapters)). The exact messages are in the [`omd-client/1` protocol](omd-client-protocol.md).

## Build a client

1. Choose a transport and start or find a listener: [Transports and auth](#transports-and-auth).
2. Start your UI process from a mod, which owns the adapter: [Client adapters](#client-adapters).
3. Connect with the SDK, which attaches, re-attaches after a disconnect and serializes actions:
   [Client SDK](#client-sdk-oh-my-diffmod-apiclient).
4. Draw `snapshot.view.sites` by component type and call `unsupported()` for the rest: [Desktop apps and editor
   webviews](#desktop-apps-and-editor-webviews).
5. Send actions and component events, and answer the server requests your client handles: the
   [`omd-client/1` protocol](omd-client-protocol.md).
6. Run the conformance check at the end of [Desktop apps and editor webviews](#desktop-apps-and-editor-webviews).

## Transports and auth

- `unix://PATH`, or `unix://` for the default socket under `$CODEX_HOME`: a WebSocket over a 0600, owner-checked
  Unix socket, no token. The default choice for local clients.
- `ws://IP:PORT` with `--ws-auth capability-token` (`--ws-token-file` or `--ws-token-sha256`) or `--ws-auth
  signed-bearer-token` (`--ws-shared-secret-file`, optional `--ws-issuer`/`--ws-audience`). A non-loopback listener
  refuses to start without auth.
- `stdio`: the spawning process speaks newline-delimited JSON-RPC to `codex app-server`.
- `codex app-server --listen URL` runs a headless host. `codex --listen URL` (same `--ws-*` flags, including
  `--ws-allowed-origin`) exposes the live TUI's in-process app-server, so a client co-attaches to the terminal
  session; it takes only `unix://PATH` or `ws://IP:PORT` with an explicit port (bare `unix://` and port 0 are
  refused).

## WebSocket bearer tokens and origins

- Native clients send `Authorization: Bearer <token>`.
- Browsers offer the subprotocols `codex-app-server` and `codex.bearer.<token>` instead, and the server selects
  `codex-app-server`.
- The server compares the raw token, so a capability token used from a browser must be base64url or hex
  (subprotocol values cannot carry `+`, `/` or `=`, and browsers may log them).
- `--ws-allowed-origin ORIGIN` (repeatable, `scheme://host[:port]`, requires `--ws-auth`) admits a browser or
  webview origin. Origins are compared exactly after normalization, which drops a default port (`:80`, `:443`); any
  other `Origin` is refused.
- The exec-server listener honors the same allowed origins and subprotocol bearer.

## Client adapters

A mod owns its client adapter. It declares `os` with `os_access.programs` (for example `node`) and starts its UI
process from a native callback (a `channel` hop from a command) with `process.start {sandbox: 'none'}`, or starts
it sandboxed with `network: 'loopback'` (`network`) for a loopback `ws://` listener.

- It passes the listen URL and the token, or a token file path, through `environment` (names listed in
  `exec_environment`; a name containing `TOKEN`, `KEY` or `SECRET` needs `--allow-secret-env`) or ndjson stdin.
- The host stops the process with the mod.
- Its stdout is the framed message channel, so a UI process logs to stderr or a file: output that breaks the
  framing stops the process (an `exit` `process_event` follows).

## Client SDK (`@oh-my-diff/mod-api/client`)

The UI process connects with the SDK in `@oh-my-diff/mod-api/client`:

```ts
connect({url, token?, command?, name, renderer, operations?, reconnect?, onView, onRoster, onMirrored, onSurfaceCall?, onServerRequest?, onNotification?, onReconnect?, onClose?})
```

It is dependency-free ESM for browsers and Node over `ws://`/`wss://` (bearer subprotocol), `unix://PATH` and
`stdio` (Node; spawns `codex app-server`).

- The session's `attach`, `update`, `detach`, `read`, `event`, `action` (serialized), `render`, `resource`,
  `recovery` and `request(method, params)` cover every `omd/*` and app-server method.
- After a disconnect it reconnects with backoff (`reconnect: false` turns that off), re-initializes, re-attaches,
  replays the last update, resumes the threads it resumed through `request('thread/resume', …)` and reports
  `onReconnect({epoch, previousEpoch})`.
- `unsupported(component, renderer, drawable)` returns null or an `unsupported_element: <type> '<id>': <reason>;
  drawing its fallback "<text>"` error for a component the renderer cannot draw (a type outside `drawable`, a
  `raster` without `cells`, an `image` without an image format), with `fallback` set to its alt text, text or
  label.

`mods/examples/external_client` (a text renderer) and `mods/examples/approval_desk` (a GUI-shaped renderer that
answers approvals) are complete adapters for unrelated mods.

## Desktop apps and editor webviews

The same contract backs an independently packaged desktop app or editor webview; Oh My Diff ships neither.

- A desktop app spawns `codex app-server --listen unix://PATH` (or connects to a user's `codex --listen` session)
  from its main process and runs the SDK there.
- A VS Code extension's host starts or finds the listener, writes a base64url capability token, and passes the URL
  and token to its webview, which loads the SDK as ESM and connects over `ws://127.0.0.1:PORT` with `--ws-auth
  capability-token` and `--ws-allowed-origin` set to the webview origin.

Either renderer:

- draws `snapshot.view.sites` by component type and calls `unsupported()` for the rest;
- reads images with `omd/resource/read`;
- sends `omd/action` and `omd/client/event`;
- answers approval server requests through `onServerRequest`;
- re-renders from the full snapshot after `onReconnect`.

`python3 -m scripts.client_acceptance --binaries DIR` drives both example adapters against headless and co-attached
hosts with a scripted local provider and is the conformance check for a new client.

## Security

Clients cannot mint grants or evidence. No `omd/*` method writes a grant, consent or evidence record; actions
resolve against the host's view, events reach only a component's owner, and resources only those in the view.

Mod engine callbacks keep running in the host runner without ambient Node, DOM or secrets; only the confined
renderer process uses its own UI runtime.
