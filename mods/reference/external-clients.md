# External clients

Other renderers (a desktop window, an editor webview, a text console) attach to a running session over the upstream
app-server JSON-RPC and draw the same composed mod view. Use this page to build or review such a client. Oh My Diff
ships no desktop or editor client of its own; a mod ships its adapter (see [Client adapters](#client-adapters)).

## External clients (`omd-client/1`)

### Transports and auth

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

### WebSocket bearer tokens and origins

- Native clients send `Authorization: Bearer <token>`.
- Browsers offer the subprotocols `codex-app-server` and `codex.bearer.<token>` instead, and the server selects
  `codex-app-server`.
- The server compares the raw token, so a capability token used from a browser must be base64url or hex
  (subprotocol values cannot carry `+`, `/` or `=`, and browsers may log them).
- `--ws-allowed-origin ORIGIN` (repeatable, `scheme://host[:port]`, requires `--ws-auth`) admits a browser or
  webview origin. Origins are compared exactly after normalization, which drops a default port (`:80`, `:443`); any
  other `Origin` is refused.
- The exec-server listener honors the same allowed origins and subprotocol bearer.

### Initialize and errors

A client sends `initialize {clientInfo, capabilities: {experimentalApi: true}}` and the `initialized` notification.
`omd/*` methods are experimental and need that opt-in.

Requests are not serialized by the host, so a client awaits the attach before any other `omd/*` call; before it
every method fails with `client_not_attached`.

Errors are JSON-RPC errors whose message starts with the code. Besides the codes listed with each request, these
exist:

- `mod_host_inactive`, `session_unavailable`, `host_operation_unavailable` and `view_unavailable` (no mods, thread,
  session runtime or published view in this host)
- `command_unavailable` and `command_unavailable_during_turn` for the action's command
- `render_slot_invalid` and `render_props_invalid`
- `resource_not_in_view` and `resource_unavailable`
- `recovery_action_invalid` and `mod_store_unavailable` from recovery

### Requests

#### `omd/client/attach`

```ts
omd/client/attach {name, renderer: {kind: 'terminal'|'gui'|'text', formats: ('svg'|'png'|'jpeg'|'cells'|'text')[], pointer: 'pixel'|'cell'|'half_cell'|'none', reducedMotion, cellPx?}, operations}
// → {clientId, protocol: 'omd-client/1', epoch, roster, features, delegable}, then omd/view/updated
```

- The result's `roster` already lists the new client, and `omd/roster/updated` reports later changes.
- Attaching again on the connection replaces its entry.
- Attach also succeeds while mods are inactive or failed to start (empty `epoch`, null `snapshot`), so the recovery
  calls stay reachable.

#### `omd/client/update`

```ts
omd/client/update {renderer?, viewport?: {width, height, unit}, focus?}
// → {}
```

`focus` sets the entry's `focused`. Every client gets `omd/roster/updated` and mods render again.

#### `omd/client/detach`

```ts
omd/client/detach {}
// → {}
```

#### `omd/view/read`

```ts
omd/view/read {}
// → {epoch, revision, snapshot, actionToken}
```

#### `omd/client/event`

```ts
omd/client/event {epoch, component, event}
// → {delivered}
```

`event` is one of:

- `{kind: 'change', value}`
- `{kind: 'change', values}` (strings)
- `{kind: 'pointer', pointer: {column, row, half?: 0|1|null, action:
  'down'|'up'|'scroll_up'|'scroll_down'|'move'|'drag'|'enter'|'leave', button: 'left'|'right'|'middle'|null}}`
- `{kind: 'scroll', offset}`
- `{kind: 'key', key, text?}`
- `{kind: 'focus'}`

Behavior:

- `{delivered}` is answered in the order the connection sent its events and actions.
- The owner (from `component_owners`) gets `component_event` with `client: clientId` and only the kind's fields
  above. `origin`, `events`, `anchor`, `range`, `index` and any other field a client sends are dropped.

| Error | When |
| --- | --- |
| `view_stale` | Another epoch |
| `view_stale: <component>` | The component is gone |
| `component_event_invalid` | Another kind, a missing or malformed field the kind requires, or an event over 64 KiB |

#### `omd/action`

```ts
omd/action {actionToken, component, row?, value?}
// → {status: 'completed', outcome, actionToken}
```

`outcome` is the command's result (`insert`, `submit`, `display`, `preview`) or null, which the client applies in
its own UI (a `submit` through `turn/start`).

Errors:

- `action_stale` (also when the view changed before the action ran)
- `action_replayed`
- `action_unknown`
- `action_unavailable: <component>`
- `action_value_invalid: <component>` (including document anchors and lines and diff lines)

#### `omd/render`

```ts
omd/render {slot, props}
// → {original, effective, tree, answeredBy}
```

- The result gives the client's native props before and after `render` interceptors, drawn with the envelope `{id:
  'client:<slot>', surface: 'inline', lifecycle: 'final', viewport: {columns: 80, rows: 24}, owner: null}`.
- Slot `module` with `props: {component, columns?, rows?}` (1–65535 cells) steps the client's own instance of that
  view's component module and answers its `tree` with `effective: {next_ms}`.

#### `omd/resource/read`

```ts
omd/resource/read {reference}
// → {mediaType, data, sha256}
```

`data` is base64. Only references in the current view can be read.

#### `omd/recovery/read` and `omd/recovery/apply`

```ts
omd/recovery/read {}
omd/recovery/apply {action: 'enable'|'disable'|'reload'|'reset', target}
```

`omd/recovery/read` returns the host-owned `/omd` recovery state, and `omd/recovery/apply` returns the result:

```ts
{mods: [{id, path, scope, enabled, packaged, failing, error}], resettable, store_error, activation_error, reload_error}
```

- `reload` reloads the mods at once, refreshes the session's limits and contract and pushes the new view, or fails
  with `recovery_unavailable_during_turn` while the lead thread's turn runs. It needs no attached client: `/omd`'s
  Reload mods sends it from the terminal.
- `enable`, `disable` and `reset` change what runs or reset `host.json`/`mods.json`, so like `packages.apply` and
  `config.set` they need the terminal (`/omd`) or `omd-mod` and fail for a client with
  `client_surface_operation_unavailable`.
- `resettable` names the files `/omd` and `omd-mod` can reset; a client reads it but cannot reset them.
- A source changed after trust keeps its last trusted code running, reports `source_changed: ...` on the mod and
  `untrusted_source: ...` as `reload_error`, and loads after `omd-mod trust` and a reload. Administered content that
  no longer matches its pin reports `managed_content_stale: ...` instead and loads after `omd-mod package-sync`.

### Host notifications and server requests

The host sends these notifications:

- `omd/view/updated {epoch, revision, snapshot, actionToken}`: the full, coalesced `ModViewSnapshot` (`view`,
  `component_owners`, `layout_owner` (the mod whose view supplied `view.layout`), `progress`, `activity`,
  `diagnostics`).
- `omd/roster/updated {roster}`
- `omd/surface/mirrored {caller, operation, arguments}`

The host also sends the server request `omd/surface/call {caller, operation, arguments, confirm?}`. A client
answers it with the operation's result or an error whose message the mod receives. When the mod's call is cancelled
or outlives its callback budget first, the host drops the request and a late answer is ignored.

Other server requests (approvals, `requestUserInput`, permissions, elicitation) reach every subscribed client, and
the first answer wins, an error included. An SDK client answers only what its `onServerRequest` returns a value for
(`undefined` leaves the request unanswered), so a client that does not handle a request never resolves it before
the user at the terminal.

### Actions and tokens

A client names a component and row, never a command. The host resolves the action from its own current view and
runs it like Space/Enter in the TUI: `command` interceptors, then the command as a user action.

- Tokens are random, per connection and bound to the view's epoch and revision.
- A pushed revision or a use replaces the token, while progress and activity pushes keep it.
- A use spends the token even when the action then fails, so re-read the view after an error.
- The last 8 retired tokens keep `action_stale` and `action_replayed` accurate.
- Send one action at a time per connection and keep the newest token from the last view or action result.
- Roster-driven re-renders coalesce, and a view that did not change keeps its revision, so one client's viewport or
  focus update does not rotate the others' tokens.

### Ordering, epochs and reconnecting

State is per connection. A disconnect removes the roster entry and at once fails that client's pending surface
calls with `client_surface_closed` (an attach on a closing connection gets `client_surface_closed: the connection
is closing`).

- `epoch` is an opaque decimal string (empty, with revision 0 and a null snapshot, until the host publishes its
  first view).
- `revision` grows within an `epoch`.
- A new `epoch` means the host restarted and invalidates everything the client holds.

Reconnecting is `initialize`, attach (a full snapshot, never deltas), then `thread/resume` per thread, which
replays pending approvals. `thread/resume` also joins a loaded thread before its first turn.

- Approvals stay upstream server requests broadcast to subscribed connections (first answer wins,
  `serverRequest/resolved` tells the rest).
- `turn/interrupt` cancels a turn.
- `thread/rewritten` invalidates a thread's cached history.

### Capabilities and fallback

The wire roster lists `{id, name, renderer, viewport, focused, attachedMs}` (camelCase renderer). Mods see it as
`clients: ClientEntry[]` beside `client` in the `terminal` input, in snake_case (`renderer.reduced_motion`,
`renderer.cell_px`, `focused`, `attached_ms`); neither lists declared operations. `client` stays the local
terminal's facts, or null headless.

A view serves every attached renderer, so draw for the least capable or branch on `clients`.

- An SVG `image` shows its alt text in terminals (SVG rules in [Binary evidence and package
  controls](packages-and-limits.md#binary-evidence-and-package-controls)); a client listing `svg`, `png` or `jpeg`
  reads the resource with `omd/resource/read` and draws it.
- `terminal.notify`, `terminal.notice` and `terminal.blit` are mirrored to attached clients in both modes, blits
  only to clients listing `cells`; others draw a raster's `alt`.

Headless, the host answers those three itself with the terminal's validation:

- A blit is checked against `component_owners` (`terminal_blit_not_owned`, `terminal_blit_unknown`) and the
  raster's size and paced at one frame per 16 ms with the same 32-update backpressure.
- A notice fails with `terminal_notice_invalid` like in the terminal, and a `model`-audience notice is still queued
  for the model.

### Delegation

With no terminal attached, `features` includes `surface_call` and `delegable` lists the declared operations the
host delegates. A mod's surface operation goes to the clients that declared it, and the first answer wins.

User-only operations are never delegated:

- `credentials.request`
- `terminal.import_file`
- `builtins.invoke`
- `commands.invoke`
- `config.set`
- `packages.apply`
- `routes.add`
- `routes.write`
- `contract.select`

`prompts.consent` is never delegated either. Whenever a client's action or event caused the call, these operations
and a `terminal.pty` start fail in both modes (`client_surface_operation_unavailable: <operation> needs the
terminal (/omd) or omd-mod`), so clients never reach grant-writing or user-only operations: use the terminal's
`/omd` or `omd-mod enable|disable|reload|reset`.

- Headless, a `terminal.pty` start from a non-user context is `host_operation_user_only`.
- An operation no attached client declared fails with `client_surface_operation_unavailable: no attached client
  serves <operation>`.
- `app.request` runs on the headless host itself. A confirmed method first goes as `omd/surface/call
  terminal.prompt {kind: 'confirm', title, message}` to the clients that declared `terminal.prompt` and runs only
  on `{status: 'accepted'}`, returning `{status: 'declined'}` otherwise or when none did.
- A call with `confirm` needs the user's consent in the client before it acts.

### Security

Clients cannot mint grants or evidence. No `omd/*` method writes a grant, consent or evidence record; actions
resolve against the host's view, events reach only a component's owner, and resources only those in the view.

Mod engine callbacks keep running in the host runner without ambient Node, DOM or secrets; only the confined
renderer process uses its own UI runtime.

### Client adapters

A mod owns its client adapter. It declares `os` with `os_access.programs` (for example `node`) and starts its UI
process from a native callback (a `channel` hop from a command) with `process.start {sandbox: 'none'}`, or starts
it sandboxed with `network: 'loopback'` (`network`) for a loopback `ws://` listener.

- It passes the listen URL and the token, or a token file path, through `environment` (names listed in
  `exec_environment`; a name containing `TOKEN`, `KEY` or `SECRET` needs `--allow-secret-env`) or ndjson stdin.
- The host stops the process with the mod.
- Its stdout is the framed message channel, so a UI process logs to stderr or a file: output that breaks the
  framing stops the process (an `exit` `process_event` follows).

### Client SDK (`@oh-my-diff/mod-api/client`)

The UI process connects with the SDK in `@oh-my-diff/mod-api/client`:

```ts
connect({url, token?, command?, name, renderer, operations?, reconnect?, onView, onRoster, onMirrored, onSurfaceCall?, onServerRequest?, onNotification?, onReconnect?, onClose?})
```

It is dependency-free ESM for browsers and Node over `ws://`/`wss://` (bearer subprotocol), `unix://PATH` and
`stdio` (Node; spawns `codex app-server`).

- The session's `attach`, `update`, `detach`, `read`, `event`, `action` (serialized), `render`, `resource`,
  `recovery` and `request(method, params)` cover every `omd/*` and app-server method.
- After a disconnect it reconnects with backoff (`reconnect: false` turns that off), re-initializes, re-attaches, replays the last update, resumes the
  threads it resumed through `request('thread/resume', …)` and reports `onReconnect({epoch, previousEpoch})`.
- `unsupported(component, renderer, drawable)` returns null or an `unsupported_element: <type> '<id>': <reason>;
  drawing its fallback "<text>"` error for a component the renderer cannot draw (a type outside `drawable`, a
  `raster` without `cells`, an `image` without an image format), with `fallback` set to its alt text, text or
  label.

`mods/examples/external_client` (a text renderer) and `mods/examples/approval_desk` (a GUI-shaped renderer that
answers approvals) are complete adapters for unrelated mods.

### Desktop apps and editor webviews

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
