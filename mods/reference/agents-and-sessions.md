# Agents, contracts and sessions

This page covers contracts and receipts, agents and their definitions, peer sessions, autonomous turns, user prompt
submissions, and lifecycle events with classic hooks. Use it when a mod spawns workers, gates completion on
receipts, talks to other sessions, queues its own turns or adapts classic hook names.

## Contracts and receipts

A contract is a versioned document that gates task completion and workspace integration on receipts. Mods register
documents; users select one.

### Registering a contract

`api.contract(document)` registers a versioned schema-2 contract document:

```ts
{schema: 2, id, version, description, assurance, gates: {complete?, integrate?}, restrict?}
```

A requirement names a receipt kind, a producer (`any`, `lead`, `host`, `integration` or `separate_agent`), bindings
(`candidate`, `acceptance`) and whether blocking findings are allowed.

### Selecting a contract

- Users select a contract with `omd-contract select STORE REPOSITORY ID@VERSION`.
- `omd-contract require` records a project floor in `.omd/contract-selection.json`.
- Selections pin the document digest. A mod that changes a registered document makes the selection unavailable
  instead of silently weakening it.
- A weaker selection needs the confirmation printed by `omd-contract plan`.
- With no selection nothing is gated.
- An unavailable selection fails closed.

### `receipts.submit`

`receipts.submit` records a receipt with a host-attested producer.

- `agent` must be a completed, read-only agent handle owned by the caller in the same session, spawned on a
  snapshot of the receipt's candidate.
- `evidence` must be that agent's result reference.
- A claimed `acceptance_sha256` must equal the evidence the agent was given.
- An isolated-worktree agent cannot attest its own candidate.
- Only a successful `workspace.integrate` can record an `integration` producer; an execution receipt cannot
  impersonate one.

### Completion, integration and restriction

`task.complete {candidate_sha256, acceptance_sha256?}` checks the current workspace against the `complete` gate and
returns `completed` or `refused` with the missing requirements.

`workspace.integrate` checks the `integrate` gate against the agent's candidate (`candidate_sha256` from
`agents.result`) and records an integration receipt tied to the resulting parent candidate and the supplied
acceptance digest.

- It refuses before touching the parent when the contract cannot hold another receipt.
- If the receipt cannot be recorded after the files are applied, the result is still `integrated` and carries
  `receipt_error`.

Pass `acceptance_sha256` to `task.complete` or `workspace.integrate` when the selected contract binds receipts to
acceptance criteria.

`contract.restrict` only narrows operations for the rest of the session.

### Blocking findings and the finding ledger

For an active contract, blocking finding fingerprints remain open across later receipts and candidate changes.
`contract.status.finding_ledger` reports each finding and its resolution.

A passing `receipts.submit` from a completed, host-attested agent may include `resolves: [fingerprint, ...]` for at
most 32 distinct open findings. The resolution must use:

- a changed candidate;
- the original acceptance digest;
- a different agent from the reporting agent.

The resolving agent must be spawned read-only from a frozen snapshot with `resolution_context: {acceptance_sha256,
findings}` and the matching acceptance evidence. The host:

- delivers the open finding details;
- binds that context to the agent;
- checks a matching top-level `resolution_assertion` in the agent's actual JSON result before accepting `resolves`.

The assertion contains `outcome: "pass"`, `candidate_sha256`, `acceptance_sha256`, and the exact fingerprint set.
This attests the independent result and its declared review context; interpretation of the finding and fix remains
the agent's judgment.

- Submitting a clean later receipt does not erase an earlier blocker.
- The ledger survives explicit resume and is replay-checked on restore.
- `task.complete` refuses while any blocker remains, returning `reason: "unresolved_blocking_findings"` and
  `outstanding_findings`.
- A session without a selected contract remains ungated.

### Scoped restrictions

`contract.restrict {operations?, scoped?, reason}` can also narrow matching arguments. Each scoped rule is
`{operation, when: {"/json/pointer": scalar}}`; all predicates must match.

For example, restricting `agents.spawn` when `"/workspace"` equals `"isolated_worktree"` leaves read-only agents
available.

- There are at most 64 rules with 1–8 scalar predicates each.
- Restrictions are monotone, and saved rules are validated again on restart.

### Contract withdrawal and persistence

The host rechecks the selected document at each turn start and after a mod fails. If no active mod still registers
the same document digest, the contract becomes unavailable (`contract_withdrawn`). Completion, integration and
receipts fail closed until the same document is registered again.

Contract receipts and restrictions survive restart in protected session state. The selected document and owner must
still match; invalid state fails closed.

## Agents

### `agents.spawn`

```ts
agents.spawn {role?, route?, prompt, definition?, workspace?, tools?, evidence?, snapshot?, parent_history?,
              resolution_context?, model?}
```

It starts a read-only or isolated-worktree agent on a worker route under the session's worker limits.

- `route` may also be a lead route of a registered provider whose `mods` is empty or lists the caller; the agent is
  admitted like a cross-provider native child under `worker_limits`, with no grant.
- `model` picks another model from that provider's runtime catalog on such a lead route (rates and billing stay the
  route's); outside the catalog it fails with `agent_model_not_in_route_provider_catalog`, and on any other route a
  `model` other than the route's fails with `agent_model_requires_provider_lead_route`.
- `evidence` delivers a stored evidence reference to the agent.
- `snapshot` selects a frozen copy and requires `fs.read`. Its permission is always `read_only`, its result
  identifies the captured candidate, and it cannot be integrated as an edit.
- Permissions are rechecked when the agent starts.

### Agent handles and limits

`agents.message`, `agents.wait` (at most 30 s), `agents.result`, `agents.cancel` and `agents.list` address only the
caller's handles.

- Calls on one handle run in order; a wait on one handle does not block calls on another.
- The host holds at most 16 agents, counting spawns in progress.
- Agents live until cancelled, the mod is disabled or fails, or the session stops.

### Parent history and `sessions.snapshot`

`parent_history: true` additionally requires `sessions` and `sessions_tools` and delivers frozen parent
conversation records including visible tool calls and outputs. It refuses more than 8,192 records or 1 MiB instead
of silently truncating them.

- The spawn result includes the history digest, byte count, item count and revision.
- The records are labelled untrusted task data.

`sessions.snapshot {call_ids?}` preserves the same history in a caller-bound evidence reference and requires
`sessions`, `sessions_tools` and `store`.

- A selection contains 1–32 unique IDs and must include each complete call/output pair.
- Evidence storage's 256 KiB limit still applies.
- This does not expose hidden reasoning.

### Agent failure details

Failed `agents.result`/`agents.wait` and `agent_end` retain an optional `failure: {category, code, message}` from
the host error. The same object is `error` on an `error` outcome of `turn_end`, `turns.activity` turns and
`agents.inventory` `last_turn`; `reason` names only an abort.

| Field | Meaning |
| --- | --- |
| `category` | `transport`, `rate_limit`, `authorization`, `sandbox`, `allowance`, `invalid_request` or `unknown` |
| `code` | Preserves the structured protocol error |
| `message` | Bounded to 1,024 characters |

Missing details are unknown, never evidence of an outage. Mods own retry policy; the host owns admission.

### Explicit thread resume

Explicit thread resume reopens the same task ledger, preserving requests, exposure, observed lead usage and
uncertain in-flight requests.

- Repository, thread identity, original limits and saved journal must validate.
- Implicit reopening, changed limits and completed tasks are refused.
- Agent handles and snapshot handles do not survive process restart; mods must reconcile saved pending work without
  silently spawning replacements.

## Agent definitions, inventory and spawn interception (`agent_lifecycle_v1`)

### Agent definitions

```ts
api.agent({name, description, instructions, route?, effort?, tools?, offer?})
```

It registers up to 8 definitions per mod during activation, named `<mod>/<name>`. Configured and built-in role
names always win.

With `offer: true` the definition appears in the native `spawn_agent` role list, after `agent_offers` interceptors,
which may drop or re-describe offers but never add, rename or reassign one.

A model that names a definition, or a mod that calls `agents.spawn {definition, prompt}`, gets:

- the definition's instructions as subordinate developer instructions;
- its route: a lead route on the thread's own provider for native spawns, a worker route for mod spawns;
- its effort;
- when `tools` is set, only those tools: other tools are hidden from the child and refused if called
  (`agent_tool_denied`).

A definition that disappears with its mod's reload or disable can no longer be spawned
(`agent_definition_unavailable`). Running agents keep going and their inventory records keep the source digest.

### `agent_spawn` interceptors

`agent_spawn` interceptors see every model `spawn_agent` call and every mod `agents.spawn` as:

```ts
{origin, caller, thread_id, agent_id, definition, prompt, model, effort, cwd, tools}
```

They may change:

- `definition` (retarget);
- `prompt`;
- `model`;
- `effort`;
- `cwd` (native spawns only: the session root or one of its `git worktree list` entries);
- `tools` (narrow only);

or answer `{deny}`.

- `next` runs the spawn and resolves `{agent_id, output, success}`. Outer handlers may rewrite `output` but not the
  identity or outcome.
- A `cwd` or `tools` change on a configured role is refused (`agent_spawn_override_requires_definition`): express
  it as a definition.
- After the transform the host validates the model and effort, and the child keeps the parent's permission profile.
  Nested tool and model calls of the child go through interception and admission as usual.
- A `model` that a provider registered (the spawn tool's model list names its provider) runs the child on that
  provider. It needs a lead route there (`agent_route_unavailable` otherwise); the child is then admitted as a
  worker on that route under `worker_limits` and accounted at the route's rates; if admission fails, every request of
  the child is refused. Opaque reasoning and compaction items from the parent's history are not sent to it.
- With `agent_spawn` interceptors registered, native spawn calls reach them instead of `tool` interceptors.

### `agents.inventory`

`agents.inventory` returns every agent of the session: model spawns, mod workers and engine-started sub-agents
(`origin`). Each record carries:

- the parent thread and agent;
- the owner mod, definition and source digest;
- role;
- provider, model and billing basis, once known;
- status (`running`, `completed`, `failed`, `cancelled`);
- start and end time, and duration;
- turn count;
- the last turn's outcome and visible answer;
- the final visible answer (4,096 characters);
- usage, described below;
- the failure or cancel reason.

Usage is summed from `model_response` reports (`source: accounting`). `basis: unknown` means nothing was priced and
`partial` means some responses were unpriced. For engine sub-agents outside OMD accounting, such as review, usage
is the engine's token totals (`source: engine`, request count and cost unknown).

A mod worker's `agent_id` is its handle. At most 64 finished records are kept.

### `agent` middleware event

The `agent` middleware event delivers `{phase: 'start' | 'turn' | 'end', agent}` with the same record, in order and
under the state of the session thread at the root of the agent's parents.

Observation grants nothing: `agents.message`, `agents.wait`, `agents.result` and `agents.cancel` still address only
the caller's own handles.

## Peer sessions (`peer_sessions_v1`)

A mod with the `peers` authority grant declares `peer_access: {projects: "same" | "any"}`. While at least one
loaded mod holds the grant, each lead thread registers a peer session in the mod store (`peers/`), live while its
process holds the session lock.

### `peers.list` and `peers.send`

`peers.list {package?}` lists other live sessions where that package (the caller by default) accepts messages.
Sessions in other repositories appear only when both packages declare `"any"`.

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

Every message and receipt is countersigned by the authority broker over the canonical digest of its sender identity
(session, repository, package and source digest), recipient, correlation, data and expiry, so only pinned OMD
binaries can mint one.

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

A key already queued by the same mod returns `duplicate`.

### How queued turns start

- The host starts the best entry (priority, then age) one second after the thread goes idle, through the engine's
  start-if-idle path. Typed input that arrives first wins, and the entry waits for the next idle.
- The turn's message begins with `[Queued by mod <id> on <event> (key <key>); not typed by the user]`, and its
  trigger is `mod:<id>`.
- The `prompt` event's `provenance` and the `input` interceptors' `origin` name the package, source digest,
  originating event and key.
- The turn keeps the thread's route, permissions and approvals.

### `turns.queued`, `turns.dequeue` and `turn_queue` events

`turns.queued` lists the caller's entries, turns started and settled spend. `turns.dequeue {key}` removes one.

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
{turn_id, outcome, error, message, continued, limit, provenance}
```

`outcome` is `completed` or `error`.

Answering `{continue: prompt}` keeps the same turn sampling with a labelled continuation, at most
`max_continuations` per turn for that mod and 4 in total. Continuations cannot mark verifiers passed or submit
receipts.

## User prompt submissions (`user_submissions_v1`)

A mod with `composer` can hold prompts the user captured and send them later as the user's own messages.

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

## Lifecycle events and classic hooks (`lifecycle_events_v1`)

### Lifecycle events

Observe-only events (capability `lifecycle` unless noted), all for the lead thread:

- `tool_batch_end {turn_id, calls: [{call_id, tool, outcome}]}` after every call one model response dispatched has
  settled.
- `instructions_loaded {kind, source, sha256, bytes, reason}` when the host loads AGENTS.md instructions
  (`instructions`, at `session_start` or on `refresh` when they change), a skill (`skill`, `explicit` or
  `implicit`) or a user attachment (`attachment`).
- `thread_settings {cwd, roots: {added, removed}, model, effort, provider}` with `before`/`after` values after the
  thread's working directory, workspace roots or model settings change.
- `worktree {phase: 'created' | 'removed', path, owner: 'agent' | 'tui'}` for isolated agent worktrees and
  worktrees the terminal creates or removes.
- `elicitation_result {server, request_id, action, content, by}` (capability `approvals`) after an MCP elicitation
  is answered; password and write-only fields are `[redacted]`, and `content` is the string `[redacted]` when the
  host no longer holds the request's schema.

### `elicitation` interceptor

`api.intercept('elicitation', …)` (capability `approvals`) sees MCP form elicitations before the user is asked:

```ts
{server, request_id, mode, message, schema}
```

A handler may answer:

- `{accept: content}` (only declared fields and every required one);
- `{decline}`;
- `{cancel}`.

Passing it on asks the user. URL and user-verification elicitations and forms with password or write-only fields
are never offered to mods.

### `api.hook`

`api.hook(name, [options], handler)` adapts the 33 classic hook names onto these events and the existing events and
interceptors.

| Classic hook | Event or interceptor |
| --- | --- |
| `PreToolUse` | `tool` |
| `PostToolUse`, `PostToolUseFailure` | `tool_result` |
| `PostToolBatch` | `tool_batch_end` |
| `PermissionRequest` | `approval` |
| `PermissionDenied` | `approval_result` |
| `UserPromptSubmit` | `input` |
| `UserPromptExpansion` | `prompt_expanded` |
| `SessionStart`, `SessionEnd` | `session` |
| `Setup` | `start` |
| `Stop`, `StopFailure` | `turn_stop` |
| `SubagentStart`, `SubagentStop` | `agent` (model-spawned) |
| `TaskCreated`, `TaskCompleted` | `agent` (other workers) |
| `TeammateIdle` | `idle` |
| `PreCompact` | `compaction` |
| `PostCompact` | `compaction_end` |
| `PreModelSwitch` | `model_request` |
| `PostModelSwitch`, `CwdChanged`, `DirectoryAdded` | `thread_settings` |
| `ConfigChange` | `config_change` |
| `InstructionsLoaded` | `instructions_loaded` |
| `FileChanged` | `workspace_change` |
| `WorktreeCreate`, `WorktreeRemove` | `worktree` |
| `Elicitation` | `elicitation` |
| `ElicitationResult` | `elicitation_result` |
| `MessageDisplay` | `model_response` |
| `Notification` | `app_notification` |

### Hook handler input and delivery

The handler receives:

```ts
{hook, event, subject, thread_id, turn_id, origin, generation, original, effective, delivery}
```

`options.match` filters the hook's subject (for example the tool name) with exact values, arrays, regular
expressions, `api.match.glob(pattern)` and `api.match.not(matcher)`, which also work in interceptor `match`
options.

- Interceptor-backed hooks may be `required` and may return an answer such as `{deny}` or `{continue}`; returning
  nothing passes the call on.
- Event-backed hooks are delivered best-effort (`delivery: 'optional'`).
- A mod that uses a hook cannot also register the same native event itself.
- Hooks may be registered only during activation, including when their native event is already registered.
