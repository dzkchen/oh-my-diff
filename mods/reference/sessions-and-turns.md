# Sessions and turns

Use it when a mod messages other live sessions, keeps the Mac awake, queues its own turns or continues a turn that
would end, or submits prompts the user captured. Thread-scoped data, `turns.abort` and session reads are in
[Threads, turns and sessions](threads-and-sessions-store.md).

## Peer sessions (`peer_sessions_v1`)

Peer sessions are experimental: the `peers` capability, `peers.list`, `peers.send`, the `peer_send` and
`peer_receive` interceptors and the `peer_message` and `peer_receipt` events.

A mod with the `peers` authority grant declares `peer_access: {projects: "same" | "any"}`. While at least one
loaded mod holds the grant, each lead thread registers a peer session in the mod store (`peers/`), live while its
process holds the session lock.

### `peers.list` and `peers.send`

`peers.list {package?}` lists other live sessions where that package (the caller by default) accepts messages.
Sessions in other repositories appear only when both packages declare `"any"`. It returns `{session, peers:
[{session, package, repository, same_project}]}`.

`peers.send {to, package?, data, correlation?, ttl_ms?}` writes the message to the recipient's mailbox and returns
`{id, status: 'queued'}`.

| Limit | Value |
| --- | --- |
| Data | at most 64 KiB |
| TTL | 1 s to 1 h, default 60 s |
| Waiting messages per recipient | 64 |

| Error | When |
| --- | --- |
| `peer_closed` | The recipient is closed |
| `peer_scope_denied` | The scope does not match |
| `peers_unavailable` | No broker is deployed; every peer operation fails closed |

### Peer message authentication and delivery

Every message and receipt is countersigned by the [authority broker](protected-authority.md) over the canonical digest
of its sender identity (session, repository, package and source digest), recipient, correlation, data and expiry, so
only pinned OMD binaries can mint one.

The recipient session:

- verifies the tag;
- drops replays of a message ID it already took;
- answers expired messages with `expired`;
- re-checks its own package's scope;
- runs `peer_receive` interceptors, which may transform `data` or refuse;
- calls the package's `peer_message` handler with `untrusted: true`.

Senders' `peer_send` interceptors may transform `data` or refuse before the message is written.

### `peer_receipt` events

The sender's package gets `peer_receipt` events:

| Event | Meaning |
| --- | --- |
| `delivered` | The message was delivered |
| `refused` | The recipient refused it (with reason) |
| `failed` | The handler threw |
| `expired` | The message expired |
| `closed` | The recipient's time ran out without a receipt and its session is gone |

Receiving never starts a turn, changes roots or routes, or lends authority; a receiver that wants to act queues its
own work under its own grants. Revoking or expiring the grant, disabling the mod or stopping the session closes the
registration.

## Power holds (`power_hold_v1`)

Power holds are experimental: the `power` capability, `power.hold` and `power.release`.

A mod with the `power` authority grant keeps the Mac awake. `power.hold {reason, lid_closed?, max_duration_ms, lease?}`
returns `{lease, lid_closed}`; passing a `lease` that is still live with the same `lid_closed` returns it unchanged,
otherwise a new lease starts. `power.release {lease}` returns `{released}`, false when the lease already ended or
belongs to another mod. Only event callbacks (lifecycle events, timers, channels) may hold
(`host_operation_event_only` otherwise).

Every lease holds an idle-sleep assertion, so the Mac doesn't sleep from inactivity while the lid is open; the display
may still sleep. With `lid_closed: true` the lease also asks the authority broker to set `SleepDisabled`, which keeps a
closed Mac running on battery. Leases from every mod and OMD process share that setting: the first records the previous
value and the last one to end restores it, then sleeps the Mac if the lid is closed.

A lease ends at `power.release`, after `max_duration_ms`, when the session stops and when OMD exits or crashes. A
disabled, failed or changed mod loses its leases at the next host event in the session. If the broker or its helper
exits, the setting is restored and the lease ends, so holding again with that `lease` starts a new one.

| Limit | Value |
| --- | --- |
| `reason` | 1 to 128 bytes |
| `max_duration_ms` | 60 s to 24 h |
| Live leases per mod in a session | 4 |

| Error | When |
| --- | --- |
| `power_unavailable` | `lid_closed` without the deployed broker, or a broker installed before power holds (run `omd-package broker install` again); lid-open holds still work |
| `authority_power_unavailable` | The broker's power helper is not installed or could not change the setting |
| `power_lease_limit` | The mod already holds 4 leases |
| `host_operation_event_only` | `power.hold` from a tool, CLI or component callback |
| `power_request_invalid` | `reason` or `max_duration_ms` is out of range |

## Autonomous turns (`autonomous_turns_v1`)

Autonomous turns are experimental: the `autonomous` capability, `turns.queue`, `turns.queued`, `turns.dequeue`, the
`turn_queue` event and `turn_stop` interceptors.

A mod with the `autonomous` authority grant declares:

```ts
autonomy: {max_queued (1-16), max_turns (1-100), max_continuations? (0-4), spend_microusd?}
```

### `turns.queue`

`turns.queue {prompt, key, priority?, deadline_ms?}` works from any callback, including timers, channels and peer
messages, and queues the prompt for the caller's lead thread.

| Argument | Limit |
| --- | --- |
| `prompt` | 8 KiB |
| `priority` | `high`, `normal` or `low` |
| `deadline_ms` | 1 s to 24 h |

It returns `{key, status: 'queued' | 'duplicate', paused?}`. A key already queued by the same mod returns
`duplicate`.

### How queued turns start

- The host starts the best entry (priority, then age) one second after the thread goes idle, through the engine's
  start-if-idle path. Typed input that arrives first wins, and the entry waits for the next idle.
- The turn's message begins with `[Queued by mod <id> on <event> (key <key>); not typed by the user]`, and its
  trigger is `mod:<id>`.
- The `prompt` event's `provenance` and the `input` interceptors' `origin` name the package, source digest,
  originating event and key.
- The turn keeps the thread's route, permissions and approvals.

### `turns.queued`, `turns.dequeue` and `turn_queue` events

`turns.queued` lists the caller's entries, turns started and settled spend: `{paused, started, spent_microusd,
entries: [{key, priority, event, queued_at_ms, deadline_ms}]}`. `turns.dequeue {key}` removes one.

The owner gets `turn_queue` events:

- `started`;
- `expired`;
- `dropped`: `stale_generation` after a source change or unload, or `grant_expired`;
- `denied`: `turn_budget_exhausted` or `spend_budget_exhausted`;
- `failed`.

Interrupting a turn (Esc) pauses every mod queue of the thread until the user next sends input. Disabling the mod
or revoking its grant drops its entries.

### `turn_stop` interceptors

`turn_stop` interceptors run when the model would end a lead turn, and after a lead turn fails without being
interrupted. They receive:

```ts
{thread_id, turn_id, outcome, error, message, continued, limit, provenance}
```

`outcome` is `completed` or `error`.

Answering `{continue: prompt}` keeps the same turn sampling with a labeled continuation, at most
`max_continuations` per turn for that mod and 4 in total. Continuations cannot mark verifiers passed or submit
receipts.

## User prompt submissions (`user_submissions_v1`)

A mod with `composer` can hold prompts the user captured and send them later as the user's own messages.
`prompts.consent`, `prompts.submit`, `prompts.status` and `prompts.revoke` are experimental.

### `prompts.consent`

`prompts.consent {text, attachments?}` (61,440 bytes, at most 8 image resources) runs only in user contexts (a
command, key binding or user component action). It records a single-use consent bound to the mod, the thread and
the exact content.

- At most 64 consents are pending per mod and thread, and consents of mods that are no longer loaded are dropped.
- Consents live in the mod store outside mod state and are not copied into forks.

### `prompts.submit`

`prompts.submit {consent, text, attachments?, mode, client_id?}` works from any context. It spends the consent on
exactly that content and submits it through the terminal's own path as a user message, under the thread's
permissions, route and spending.

- `mode: 'turn'` starts a turn when the thread is idle.
- `mode: 'steer'` steers the running turn.

It returns `{status: 'started' | 'steered', client_id}` or, without spending the consent, `{status:
'not_submitted', reason}`. A spent, changed or missing consent fails.

The `reason` values are:

- `busy`;
- `no_active_turn`;
- `session_starting`;
- `input_held`, while the terminal holds its own queued input after a disconnect, an unconfirmed submission,
  rate-limit recovery or an unavailable thread.

### `prompts.status` and `prompts.revoke`

`prompts.status {consent}` is one of:

- `pending`;
- `missing`;
- `delivered`: the message with that `client_id` was committed to the thread, also when replayed on resume;
- `unconfirmed`: spent, but no commit seen.

A caller can use it to reconcile an uncertain submission instead of sending twice. `prompts.revoke {consent}` drops
one.

A consent never grants autonomous authority: anything not captured by the user still needs `autonomous`.
