# `omd-client/1` protocol

Use it when you implement or debug a client's messages: initialization and errors, every `omd/*` request, the
host's notifications and server requests, action tokens, epochs and reconnecting, renderer fallbacks and
delegation. Transports, adapters and the SDK are in [External clients](external-clients.md); the steps to build a
client are in [Build an external client](../../docs/mod-authors/build-a-client.md).

In Mod API `1.0.0` every `omd/*` method is experimental. The host runs on Apple Silicon macOS.

## Initialize and errors

A client sends `initialize {clientInfo, capabilities: {experimentalApi: true}}` and the `initialized` notification.
`omd/*` methods are experimental and need that opt-in.

Wait for `omd/client/attach` to return before any other `omd/*` call. Until then every method fails with
`client_not_attached`, and the host doesn't queue requests.

Errors are JSON-RPC errors whose message starts with the code. Besides the codes listed with each request, these
exist:

- `mod_host_inactive`: no mods run in this host
- `session_unavailable`: no thread runs in this host
- `host_operation_unavailable`: this host has no session runtime
- `view_unavailable`: this host hasn't published a view
- `command_unavailable` and `command_unavailable_during_turn` for the action's command
- `render_slot_invalid` and `render_props_invalid`
- `resource_not_in_view` and `resource_unavailable`
- `recovery_action_invalid` and `mod_store_unavailable` from recovery

## Requests

Each request below is a method a client sends to the host.

### `omd/client/attach`

```text
omd/client/attach {name, renderer: {kind: 'terminal'|'gui'|'text', formats: ('svg'|'png'|'jpeg'|'cells'|'text')[], pointer: 'pixel'|'cell'|'half_cell'|'none', reducedMotion, cellPx?}, operations}
// → {clientId, protocol: 'omd-client/1', epoch, roster, features, delegable}, then omd/view/updated
```

- The result's `roster` already lists the new client, and `omd/roster/updated` reports later changes.
- Attaching again on the connection replaces its entry.
- Attach also succeeds while mods are inactive or failed to start (empty `epoch`, null `snapshot`), so the recovery
  calls stay reachable.

### `omd/client/update`

```text
omd/client/update {renderer?, viewport?: {width, height, unit}, focus?}
// → {}
```

`focus` sets the entry's `focused`. Every client gets `omd/roster/updated` and mods render again.

### `omd/client/detach`

```text
omd/client/detach {}
// → {}
```

### `omd/view/read`

```text
omd/view/read {}
// → {epoch, revision, snapshot, actionToken}
```

### `omd/client/event`

```text
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
- The component's owner, as listed in the snapshot's `component_owners` (see
  [Host notifications](#host-notifications-and-server-requests)), gets
  [`component_event`](terminal-input.md#component_event) with `client: clientId` and only the kind's fields above.
  `origin`, `events`, `anchor`, `range`, `index` and any other field a client sends are dropped.

| Error | When |
| --- | --- |
| `view_stale` | Another epoch |
| `view_stale: <component>` | The component is gone |
| `component_event_invalid` | Another kind, a missing or malformed field the kind requires, or an event over 64 KiB |

### `omd/action`

```text
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

### `omd/render`

```text
omd/render {slot, props}
// → {original, effective, tree, answeredBy}
```

`omd/render` runs the mods' `render` interceptors over a component the client draws natively. `slot` names that
component, one of the [render components](render-hooks.md#render-components) such as `tool_call`, and `props` are its
native props. This `slot` is unrelated to the `slot` component type.

- The result gives the client's native props before and after `render` interceptors, drawn with the envelope `{id:
  'client:<slot>', surface: 'inline', lifecycle: 'final', viewport: {columns: 80, rows: 24}, owner: null}`.
- Slot `module` with `props: {component, columns?, rows?}` (1–65535 cells) steps the client's own instance of that
  view's component module and answers its `tree` with `effective: {next_ms}`.

### `omd/resource/read`

```text
omd/resource/read {reference}
// → {mediaType, data, sha256}
```

`data` is base64. Only references in the current view can be read.

### `omd/recovery/read` and `omd/recovery/apply`

```text
omd/recovery/read {}
omd/recovery/apply {action: 'enable'|'disable'|'reload'|'reset', target}
```

`omd/recovery/read` returns the host-owned `/omd` recovery state, and `omd/recovery/apply` returns the result:

```text
{mods: [{id, path, scope, enabled, packaged, failing, error}], resettable, store_error, activation_error, reload_error}
```

- `reload` reloads the mods at once, refreshes the session's limits and contract and pushes the new view, or fails
  with `recovery_unavailable_during_turn` while the lead thread's turn runs. It needs no attached client: `/omd`'s
  Reload mods sends it from the terminal.
- `enable`, `disable` and `reset` change what runs or reset `host.json`/`mods.json`, so like `packages.apply` and
  `config.set` they need the terminal (`/omd`) or `omd-mod` and fail for a client with
  `client_surface_operation_unavailable`.
- `resettable` names the files `/omd` and `omd-mod` can reset; a client reads it but cannot reset them.
- When a mod's source changes after trust, its last trusted code keeps running. The mod reports
  `source_changed: ...`, and `reload_error` is `untrusted_source: ...`. The new source loads after `omd-mod trust`
  and a reload. Administered content that no longer matches its pin reports `managed_content_stale: ...` instead and
  loads after `omd-mod package-sync`.

## Host notifications and server requests

A surface operation is a host operation the terminal normally serves, such as `terminal.notice` or
`terminal.prompt`. The host mirrors some of them to clients (`omd/surface/mirrored`) and, with no terminal attached,
delegates others (`omd/surface/call`, see [Delegation](#delegation)).

The host sends these notifications:

- `omd/view/updated {epoch, revision, snapshot, actionToken}`: the full, coalesced `ModViewSnapshot`
- `omd/roster/updated {roster}`
- `omd/surface/mirrored {caller, operation, arguments}`

The `ModViewSnapshot` fields are `view`, `component_owners`, `layout_owner` (the mod whose view supplied
`view.layout`), `progress`, `activity` and `diagnostics`.

The host also sends the server request `omd/surface/call {caller, operation, arguments, confirm?}`. A client
answers it with the operation's result or an error whose message the mod receives. When the mod's call is cancelled
or outlives its callback budget first, the host drops the request and a late answer is ignored.

Other server requests (approvals, `requestUserInput`, permissions, elicitation) reach every subscribed client, and
the first answer wins, an error included. An SDK client answers only what its `onServerRequest` returns a value for
(`undefined` leaves the request unanswered). So a client that ignores a request leaves it for the user at the
terminal to answer.

## Actions and tokens

A client names a component and row, never a command. The host resolves the action from its own current view and
runs it like Space/Enter in the terminal: `command` interceptors, then the command as a user action.

- Tokens are random, per connection and bound to the view's epoch and revision.
- A pushed revision or a use replaces the token, while progress and activity pushes keep it.
- A use spends the token even when the action then fails, so re-read the view after an error.
- The last 8 retired tokens keep `action_stale` and `action_replayed` accurate.
- Send one action at a time per connection and keep the newest token from the last view or action result.
- Roster-driven re-renders coalesce, and a view that did not change keeps its revision, so one client's viewport or
  focus update does not rotate the others' tokens.

## Ordering, epochs and reconnecting

State is per connection. A disconnect removes the roster entry and at once fails that client's pending surface
calls with `client_surface_closed` (an attach on a closing connection gets `client_surface_closed: the connection
is closing`).

- `epoch` is an opaque decimal string (empty, with revision 0 and a null snapshot, until the host publishes its
  first view).
- `revision` grows within an `epoch`.
- A new `epoch` means the host restarted and invalidates everything the client stored.

Reconnecting is `initialize`, attach (a full snapshot, never deltas), then `thread/resume` per thread, which
replays pending approvals. `thread/resume` also joins a loaded thread before its first turn.

- Approvals stay upstream server requests broadcast to subscribed connections (first answer wins,
  `serverRequest/resolved` tells the rest).
- `turn/interrupt` cancels a turn.
- `thread/rewritten` invalidates a thread's cached history.

## Renderer capabilities and fallback

The wire roster lists `{id, name, renderer, viewport, focused, attachedMs}` (camelCase renderer). Mods see it as
`clients: ClientEntry[]` beside [`client`](terminal-operations.md#terminal-event-client) in the `terminal` input, in
snake_case (`renderer.reduced_motion`, `renderer.cell_px`, `focused`, `attached_ms`); neither lists declared operations.
`client` stays the local terminal's facts, or null headless.

A view serves every attached renderer, so draw for the least capable or branch on `clients`.

- An SVG `image` shows its alt text in terminals (SVG rules in
  [SVG assets](state-and-storage.md#svg-assets-svg_assets_v1)); a client listing `svg`, `png` or `jpeg` reads the
  resource with `omd/resource/read` and draws it.
- `terminal.notify`, `terminal.notice` and `terminal.blit` are mirrored to attached clients whether the host is
  headless or a terminal is attached. Blits go only to clients listing `cells`; others draw a raster's `alt`.

Headless, the host answers those three itself with the terminal's validation:

- A blit is checked against `component_owners` (`terminal_blit_not_owned`, `terminal_blit_unknown`) and the
  raster's size, and paced at one frame per 16 ms. Once 32 updates are waiting for a raster, a blit gets
  `{status: 'backpressure', retry_after_ms}`.
- A notice fails with `terminal_notice_invalid` like in the terminal, and a `model`-audience notice is still queued
  for the model.

## Delegation

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

`prompts.consent` is never delegated either. When a client's action or event caused the call, these operations and
a `terminal.pty` start fail, whether the host is headless or a terminal is attached. The error is
`client_surface_operation_unavailable: <operation> needs the terminal (/omd) or omd-mod`, so clients never reach
grant-writing or user-only operations. To change what runs, use `/omd` in the terminal or
`omd-mod enable|disable|reload|reset`.

- Headless, a `terminal.pty` start from a non-user context is `host_operation_user_only`.
- An operation no attached client declared fails with `client_surface_operation_unavailable: no attached client
  serves <operation>`.
- `app.request` runs on the headless host itself. For a method that needs confirmation, the host first sends
  `omd/surface/call terminal.prompt {kind: 'confirm', title, message}` to the clients that declared
  `terminal.prompt`. The method runs only on `{status: 'accepted'}`. Otherwise, or when no client declared
  `terminal.prompt`, it returns `{status: 'declined'}`.
- A call with `confirm` needs the user's consent in the client before it acts.
