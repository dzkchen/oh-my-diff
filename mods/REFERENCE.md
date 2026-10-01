# Mod API reference

This reference is version-matched to `@oh-my-diff/mod-api` and host API
`0.2.0-experimental.5` on OMD `0.1.0` and Codex `0.159.1`. The package's
[`api.d.ts`](api.d.ts) is the complete typed surface. API 0.1 packages are
historical and do not load in the current host; the later .9 reference sections
remain only as migration evidence. A store also generates `active-host.d.ts` and
`installed-contracts.d.ts`; those files identify the running host and the exact
service contracts available to consumers.

## API 0.2 host primitives

The host is feature-agnostic: every operation, event and capability below is
available to any trusted mod on equal terms, and none of them names a product
feature. `OMD_MODE=omd` runs the mod host in the default session;
`OMD_MODE=upstream_direct` (or no `OMD_MODE`) runs pinned upstream behavior
without mods. `OMD_MODE=platform`, `OMD_MODE=enabled` and
`OMD_CONTROLLED_MANIFEST` are rejected with a message naming `OMD_MODE=omd`.
The [`release_check` example](examples/release_check) is an independent
author package that uses only this surface.

Host call arguments and results share a 128 KiB transport budget per
callback. A result that would exceed the remaining
budget becomes a `host_result_limit` error the mod can catch; the operation has
still run. Primitive limits below keep single results inside that budget; page
or use artifacts for larger data.

### Capabilities

Capabilities name authority classes. A call or registration outside the
package's trusted capabilities fails with `capability_denied: NAME` before any
native work.

| Capability | Grants |
| --- | --- |
| `exec` | `exec.run`, `process.*`, `sidecars.*`, the `process_event` event; `app.request mcpServer/tool/call` |
| `pty` | `terminal.pty` (a writable pane also needs `fs.write`) |
| `history` | the `history` replacement |
| `outputs` | the `tool_output` replacement and observers |
| `fs.read` | `workspace.read`, `workspace.list`, `workspace.stat`, read-only `workspace.check_access`, `workspace.snapshot`, `workspace.fingerprint`, `workspace.watch`, the `workspace_change` event; `app.request fuzzyFileSearch*` |
| `fs.write` | write-mode `workspace.check_access`, `workspace.transaction`, `workspace.backup`, `workspace.restore`, `workspace.request_rename`, the `workspace_pre_rename` event, `exec.run` with `write: true` |
| `network` | `exec.run` and `process.start` with `network: "loopback"` |
| `model` | `routes.list`, `routes.select`, `providers.*`, the `routing` event |
| `agents` | `agents.*`, `model.complete`, `task.status`, `workspace.integrate` |
| `store` | `store.*`, `evidence.write`, `evidence.read`, `api.state` |
| `sessions` | `sessions.list`, `sessions.read`, `turns.activity`, turn evidence on `turn_end` |
| `contracts` | `api.contract`, `receipts.submit`, `task.complete`, `contract.status`, `contract.restrict`, the `contract` event |
| `builtins` | `api.builtins` |
| `terminal` | `terminal` and `list` events; `component_event`, `view`, `focus`; `terminal.notify`, `terminal.show_thread`, `terminal.import_file`, `terminal.open`, `terminal.prompt` |
| `threads`, `config`, `config.write`, `inventory`, `account` | `app.request` for the routed app-server methods of that class; `app_notification` |
| `approvals` | the `approval` middleware and `approval_result`; `app_server_request` |
| `events` | `events.publish`, `events.schedule`, `events.cancel`, the `channel` and `timer` events |
| `credentials` | `credentials.list`, `credentials.request` |
| `composer` | `composer.read`, `composer.write`, the `completion` replacement |
| `packages` | `packages.list`, `packages.preview`, `packages.apply`, `packages.reload` |
| `tools` | `api.tool`, `api.dynamicTools`, `tools.define`, `tools.undefine`, the `tool_specs` replacement |
| `context`, `commands`, `lifecycle`, `input`, `interception`, `compaction`, `middleware`, `services`, `virtual_reads` | Their registrations and events, unchanged from 0.1 |

`tool_result_fingerprints_v1` supplies observe-only `thread_id`, `call_sha256`,
`result_sha256` and `result_complete` fields on `tool_result`. The result digest
covers the accepted model-visible output with a fixed call ID; blocked, failed,
aborted and unavailable lifecycle results have no result digest. `tool_before` supplies `thread_id`
for thread-scoped interception decisions.

A manifest may list up to 16 `exec_environment` names that `exec.run` passes
through from the host environment; `PATH`, `HOME`, `TMPDIR`, shell, loader and
interpreter variables and the `DYLD_`, `LD_`, `OMD_`, `CODEX_`, `SSH_`, `GPG_`
and `GIT_CONFIG` prefixes are refused.

### One-shot commands: `exec.run`

`{program, sha256?, argv?, cwd?, env?, stdin?, timeout_ms?, max_output_bytes?, output_artifact?,
write?, network?, guards?, required_access?}` runs one program in the session's effective sandbox. A bare
program name resolves on `PATH` outside the repository; an absolute path must
be canonical and outside the repository; `sha256` pins the resolved file. `cwd`
is repository-relative. The environment starts empty except `PATH`, a private
`HOME`/`TMPDIR`, `TERM=dumb`, locale variables, the declared `exec_environment`
names and `env` entries limited to those names. The default timeout is 10 s and
the ceiling 120 s; the host captures at most 1 MiB of stdout and of stderr and
reports `stdout_truncated`/`stderr_truncated`; `stdout_sha256` and `stdout_bytes`
cover the captured stdout. The returned `stdout` and `stderr` are previews of at
most 64 KiB and 16 KiB so the result fits a callback's host-call transport;
`stdout_preview_truncated`/`stderr_preview_truncated` report a shortened
preview. Use `output_artifact` for complete output. Output draining shares the
command's deadline and cancellation, so a descendant that keeps a pipe open
cannot hold the call past its timeout. At most 4 runs per repository are
concurrent. Without `write` the
repository is read-only; with `network: "loopback"` only local binding is
allowed. Cancellation kills the process group and returns `exec_cancelled`.
The result is `{exit_code, signal, stdout, stdout_sha256, stderr,
stdout_truncated, stderr_truncated, timed_out, duration_ms, program: {path,
sha256}, guards_verified}`. The digest covers the raw captured stdout bytes.
With `output_artifact: true`, the host accepts complete UTF-8 stdout up to 16 MiB,
returns a 4 KiB preview plus `{reference, sha256}` in `output_artifact`, and
reports `stdout_bytes` and `stdout_preview_truncated`. Oversize output fails
without creating an artifact. `exec.output_page {artifact, cursor?, max_bytes?}`
reads at most 16 KiB per call with a byte cursor. The artifact is bound to the
repository, current mod source and thread, hash-checked on reads, and subject
to a 64 MiB quota per binding. This keeps large command output outside mod
callback receipts; callers can page it in later callbacks.

`api.assets.read(name)` returns a selected package's UTF-8 entrypoint or
declared text asset with its SHA-256. It reads only the caller's hash-bound
package. Installed package caches include declared assets. The total declared
text sent to one callback is limited to 128 KiB. A mod can supply its own
source to a sandboxed `exec.run` process without relying on a workspace copy.
For a live-workspace write, `guards` may contain up to four read-only command
preconditions: `{program, sha256?, argv?, cwd?, env?, stdout_sha256}`. The host
runs them without network under its exclusive workspace operation guard and
compares their full, non-truncated stdout to the expected digest immediately
before the write. Each guard is limited to 10 s and 1 MiB of output, and its
time counts against the write's timeout. A failed or changed guard prevents the
write. Guarded writes cannot target a frozen snapshot. Other processes outside
the host can still modify the workspace between a guard and the write; commands
that support their own locking or expected-version options should use them.
`required_access: {write: [paths]}` checks up to 128 named workspace paths for
write permission after the command guards and before the write, under that same
host operation guard. It requires `write: true` and cannot target a snapshot.
It is intended for commands that mutate metadata on behalf of selected files,
such as staging. The command itself still runs under the effective filesystem
sandbox; the host cannot infer which files an arbitrary command represents.

### Workspace: list, stat, preconditions, backups and changes

`workspace.list {path?, recursive?, include_ignored?, max_entries?}` returns at
most 20,000 readable entries, skipping `.git`, `.omd` and paths the session
cannot read. `workspace.stat {paths, hash?}` returns `{kind, size, mtime_ms,
sha256?}` or `null`. `workspace.check_access {paths, write?}` verifies up to
128 distinct named paths against the caller's current read or write grant and
effective workspace permissions, returning `{paths, write}` on success. A
separate check does not reserve permission for a later command; guarded
`exec.run.required_access` rechecks inside the write operation. Every
`workspace.transaction` path needs an `expected`
fingerprint: a SHA-256, `{size, mtime_ms}` or `null` for absent; it accepts
`writes`, `deletes`, `renames` and `backup: true`, which stores the prior bytes
outside the repository and returns a `ResourceRef`. `workspace.backup
{expected}` and `workspace.restore {backup, expected}` save and restore up to
256 files (64 MiB) under the same preconditions. Transactions and restores are
exclusive per repository within the host. `workspace_change {repository, source, call_id, changes,
status, reason}` is delivered after a tool call changes readable files
(`source: "tool"`, with `call_id`), and after a `workspace.transaction`,
`workspace.restore` or `workspace.integrate` (`"transaction"`) or a writing
`exec.run` (`"exec"`) performed by a slash command or lifecycle callback.
Host operations inside a tool call are covered by that tool's single
notification, and writes made by a `workspace_change` callback are not
re-announced. Command and callback changes are delivered when the originating
callback finishes, or at the next turn or tool boundary for slash commands. If
more than 64 unannounced changes accumulate, subscribers receive one
`source: "rescan"`, `unavailable` notification instead. The host scans only
while a mod subscribes, is bounded to 20,000 files and 128 MiB, and reports
`unavailable` instead of partial coverage.

`workspace.snapshot {agent?, expected?}` requires `fs.read` and returns
`{snapshot: ResourceRef, candidate_sha256}`. It freezes the current tracked and
approved-untracked files, or a completed owned agent's workspace (`agents` is
also required). `expected` rejects a changed candidate. References are bound to
the caller, package source, generation and thread. Each mod generation and
thread holds at most 8 snapshots and 64 MiB, the host at most 32 and 256 MiB;
a full host evicts the oldest snapshot of the largest holder. Identical captures
are deduplicated, and the registry clears on owner cleanup or session stop.
Snapshots do not authorize reading denied paths.

`workspace.fingerprint {agent?, expected?}` takes the same arguments and
permissions and returns only `{candidate_sha256}`, the digest `workspace.snapshot`
would report. It stores nothing, so use it to check freshness; it is also
available in the `context` event, where `workspace.snapshot` is not.

`exec.run` accepts `snapshot` to run against a private copy of frozen input.
Normal command, filesystem and cancellation permissions still apply. It may
create build artifacts, but changing captured source rejects the result. The
result includes `candidate_sha256` and host-recorded `evidence`. Submit that
reference with `receipts.submit {execution: true, ...}` for a `host` producer;
the host verifies ownership, candidate, reference and outcome. A successful
receipt requires exit zero, no signal or timeout, and untruncated output. Each
mod generation and thread holds at most 64 execution records, the host at most
256.

### Durable data: `store.*` and evidence

`store.get/put/delete/list/export/reset` operate on a per-mod namespace with
`repository` (default) or `user` scope. `put` and `delete` require the current
`expected_revision` (`null` to create); a stale revision fails. Keys are at
most 256 bytes, values 64 KiB, a scope 16 MiB and 4,096 keys; `list` pages
256 keys and `export {scope?, cursor?}` pages entries in at most 64 KiB, returning
`{schema, owner, scope, generation, entries, cursor}`. Every record carries
host-attested provenance `{mod, source_sha256, thread_id, origin, at}`. `reset`
needs the current generation. Outside a session, `omd store export|reset --mod
ID [--repo PATH] [--store PATH] [--scope repository|user]` exports the complete
namespace or resets it without running any mod code. `evidence.write
{media_type, content, label?}` stores content-addressed evidence and returns a
`ResourceRef`; `evidence.read` reads it back in bounded pages.

### Routes

Routes are configuration, not names in the API. `<OMD_MOD_STORE>/host.json`
lists `routes` with `name, provider, model, reasoning_effort, responses_url,
rates, roles (lead|worker), tools, mods, grant`. `routes.list` returns the
routes visible to the calling mod with `billing` and `available`. The
`routing` replacement returns `{route}` to choose a configured lead route at
thread start; `model_request` middleware returns `{route}` to switch a request
among the lead routes on the same provider; `agents.spawn.route` names a worker
route or a registered provider. Worker routes require a grant file whose hash,
repository, provider, model and URL are rechecked on every request.

### Ledger

Every lead and native sub-agent request is observed and recorded in the
session ledger (`task.status`, the `ledger` field of `context` and `terminal`
events). Limits are enforced only on mod-initiated agents, and on the lead
when its model matches a configured lead route with rates. OMD sessions use the
observed HTTP Responses transport; WebSocket transport is disabled for their
threads and refused if any request would use it.

### Stream control

A `response_stream` middleware may return `{stop: {reason}}` or `{stop:
{reason}, retry: {inject}}` only for an event with `boundary: true` (a
completed output item). The host keeps that completed item in the
transcript, records a developer note that a mod stopped the response, ends the
response, optionally adds `inject` as lower-priority developer context and
retries under the same turn and admission, at most twice per turn across all
of its sampling requests. Older APIs and non-boundary events cannot stop a
stream.

### Built-in controls

`api.builtins({commands: {hide}, modes: {disable}})`, registered during
activation, hides slash commands and disables collaboration modes from the next
idle boundary until the mod is disabled, unloaded or fails. `/quit`,
`/exit`, `/approvals`, `/permissions`, `/status`, `/logout` and the default mode
cannot be removed. A turn that requests a disabled mode runs in the default mode
with that mode's instructions cleared and a warning (a `warning` notification
for app-server clients), including the turn at whose boundary the mod loads.
Tools limited to collaboration modes lose the disabled ones and are not offered
when none remain.

### Contracts and receipts

`api.contract(document)` registers a versioned schema-2 contract document:
`{schema: 2, id, version, description, assurance, gates: {complete?,
integrate?}, restrict?}`. A requirement names a receipt kind, a producer (`any`,
`lead`, `host`, `integration` or `separate_agent`), bindings (`candidate`, `acceptance`) and whether
blocking findings are allowed. Users select a contract with `omd-contract select
STORE REPOSITORY ID@VERSION`; `omd-contract require` records a project floor in
`.omd/contract-selection.json`. Selections pin the document digest, so a mod
that changes a registered document makes the selection unavailable instead of
silently weakening it; a weaker selection needs the confirmation printed by
`omd-contract plan`. With no selection nothing is gated. `receipts.submit`
records a receipt with a host-attested producer. `agent` must be a completed,
read-only agent handle owned by the caller in the same session, spawned on a
snapshot of the receipt's candidate; `evidence` must be that agent's result
reference, and a claimed `acceptance_sha256` must equal the evidence the agent
was given. An isolated-worktree agent cannot attest its own candidate. Only a successful `workspace.integrate` can
record an `integration` producer; an execution receipt cannot impersonate one.
`task.complete {candidate_sha256, acceptance_sha256?}` checks
the current workspace against the `complete` gate and returns `completed` or
`refused` with the missing requirements; `workspace.integrate` checks the
`integrate` gate against the agent's candidate (`candidate_sha256` from
`agents.result`) and records an integration receipt tied to the resulting parent
candidate and the supplied acceptance digest. It refuses before touching the
parent when the contract cannot hold another receipt; if the receipt cannot be
recorded after the files are applied, the result is still `integrated` and
carries `receipt_error`. An unavailable selection fails
closed. Old `workflow.json` selections are not imported. `contract.restrict`
only narrows operations for the rest of the session.

For an active contract, blocking finding fingerprints remain open across later
receipts and candidate changes. `contract.status.finding_ledger` reports each
finding and its resolution. A passing `receipts.submit` from a completed,
host-attested agent may include `resolves: [fingerprint, ...]` for at most 32
distinct open findings. The resolution must use a changed candidate, the
original acceptance digest and a different agent from the reporting agent.
The agent must be spawned read-only from a frozen snapshot with
`resolution_context: {acceptance_sha256, findings}` and the matching acceptance
evidence. The host delivers the open finding details, binds that context to the
agent, and checks a matching top-level `resolution_assertion` in the agent's
actual JSON result before accepting `resolves`. The assertion contains
`outcome: "pass"`, `candidate_sha256`, `acceptance_sha256`, and the exact
fingerprint set. This attests the independent result and its declared review
context; interpretation of the finding and fix remains the agent's judgment.
Submitting a clean later receipt does not erase an earlier blocker. The ledger
survives explicit resume and is replay-checked on restore. `task.complete`
refuses while any blocker remains, returning `reason:
"unresolved_blocking_findings"` and `outstanding_findings`; a session without a
selected contract remains ungated.

`contract.restrict {operations?, scoped?, reason}` can also narrow matching
arguments. Each scoped rule is `{operation, when: {"/json/pointer": scalar}}`;
all predicates must match. For example, restricting `agents.spawn` when
`"/workspace"` equals `"isolated_worktree"` leaves read-only agents available.
There are at most 64 rules with 1–8 scalar predicates each. Restrictions are
monotone, and saved rules are validated again on restart.

The host rechecks the selected document at each turn start and after a mod
fails: if no active mod still registers the same document digest, the contract
becomes unavailable (`contract_withdrawn`) and completion, integration and
receipts fail closed until the same document is registered again.

Contract receipts and restrictions survive restart in protected session state.
The selected document and owner must still match; invalid state fails closed.
Pass `acceptance_sha256` to `task.complete` or `workspace.integrate` when the
selected contract binds receipts to acceptance criteria.

### Agents

`agents.spawn {role, route, prompt, workspace?, tools?, evidence?, snapshot?, parent_history?}` starts a
read-only or isolated-worktree agent on a worker route under the session's
worker limits; `evidence` delivers a stored evidence reference to the agent.
`snapshot` selects a frozen copy and requires `fs.read`; its permission is
always `read_only`, its result identifies the captured candidate, and it cannot
be integrated as an edit. Permissions are rechecked when the agent starts.
`agents.message`, `agents.wait` (at most 30 s), `agents.result`,
`agents.cancel` and `agents.list` address only the caller's handles. Calls on
one handle run in order; a wait on one handle does not block calls on another.
The host holds at most 16 agents, counting spawns in progress. Agents live
until cancelled, the mod is disabled or fails, or the session stops.

`parent_history: true` additionally requires `sessions` and delivers frozen
parent conversation records including visible tool calls and outputs. It
refuses more than 8,192 records or 1 MiB instead of silently truncating them.
The spawn result includes the history digest, byte count, item count and
revision. The records are labelled untrusted task data. `sessions.snapshot
{call_ids?}` preserves the same history in a caller-bound evidence reference
and additionally requires `store`. A selection contains 1–32 unique IDs and
must include each complete call/output pair; evidence storage's 256 KiB limit
still applies. This does not expose hidden reasoning.

Failed `agents.result`/`agents.wait` and `agent_end` retain an optional
`failure: {category, code, message}` from the host error. Categories are
`transport`, `rate_limit`, `authorization`, `sandbox`, `allowance`,
`invalid_request` or `unknown`. Missing details are unknown, never evidence
of an outage. The message is bounded to 1,024 characters; `code` preserves
the structured protocol error. Mods own retry policy; the host owns admission.

Explicit thread resume reopens the same task ledger, preserving requests,
exposure, observed lead usage and uncertain in-flight requests. Repository,
thread identity, original limits and saved journal must validate. Implicit
reopening, changed limits and completed tasks are refused. Agent handles and snapshot handles do not survive process restart;
mods must reconcile saved pending work without silently spawning replacements.

### Framed processes

`process.start` takes `framing: "content-length"` (default) or `"ndjson"` and
`network: "none"` or `"loopback"`; the protocol-named transports are removed.
The host replaces `{process.home}` in process arguments with that session's
private scratch directory, for tools that do not honor the `HOME` environment.
`environment` supplies at most eight explicit, bounded variables to that
process. The host rejects its own reserved variables and loader overrides.

### Terminal lists, insert, placeholder and glyphs

`api.replace('list', event)` renders built-in pickers as components; the host
keeps keyboard handling and the chosen action. Components accept an
`{insert}` action. A terminal view may set `placeholder` and
`theme.glyphs` (2–4 printable ASCII characters mapped to the same number of
characters; width-changing mappings are ignored).

### Code-mode kernels

Kernels are configuration: `[[features.code_mode.kernels]]` entries with
`name`, `command`, absolute `driver` and `driver_sha256` register kernels for
the `kernel` code-mode tool. The driver hash is checked before each worker
starts; with no entries the tool reports that no kernel is configured.

### Adapters

A library package can declare `adapter_module: {entry, aliases}`; a dependent
package with `adapter: "<package id>"` is wrapped by that module before
activation and may import its aliases. The adapted package keeps only its own
capabilities.

## Batch 2.6 host primitives

API `0.2.0-experimental.5` adds these generic primitives; earlier API versions
no longer load. Each advertises a host feature a package can require.
With no mod registered for a primitive the host allocates nothing for it and
changes no decision. Mapping from pinned upstream surfaces to these routes, and
the recorded exclusions, live in `scripts/upstream_routes.json`;
`mise run upstream:candidate` flags new upstream surfaces without a route.

### App-server bridge (`app_v1`)

`app.request {method, params}` sends a method listed by `app.routes`. Each route
names a capability class, allowed contexts (`user` commands or `event`
callbacks), whether a native confirmation is needed and the thread scope. Each
route lists the parameter fields it accepts; any other non-null field is refused,
so authority fields (approval policy, sandbox, permissions, config, roots,
environments, dynamic tools, base instructions, service tier) and fields added
by a later upstream stay closed until reviewed. `model` is allowed only as a
configured route; `thread/start` and `fuzzyFileSearch` roots must be the session
root or one of its `git worktree list` entries. Thread-scoped methods reach the
current thread and threads the mod itself started or forked. Local image and
audio inputs must be `{resource}` references; raw paths are refused.
Turn-starting methods run only from user contexts; `turn/steer` runs from
events into a running turn; `mcpServer/tool/call` asks for a native
confirmation on every call.
`command/exec`, `process/*`, `fs/*`, `thread/shellCommand`,
`thread/inject_items` and credential flows are excluded. Declare
`subscriptions.app` in the manifest to receive `app_notification` (deltas
coalesced, 256 events / 1 MiB per mod, oldest dropped with a count) and
`app_server_request` phases. Only the in-process app-server (TUI and
`codex exec`) is reachable; other clients get `client_surface_unavailable`.

### Approvals (`approval_v1`)

`approval` middleware sees exec, patch, MCP, network and permission requests
before hooks, automatic review and full-access shortcuts. It returns `null`,
`{deny}` or `{ask}`; any deny rejects and any `ask` forces the native prompt.
A mod can never approve, and a failing middleware counts as `ask`.
`approval_result` reports the decision and its source.

### Tool output, feedback, batches and specs

- `replace('tool_output')` (`tool_output_v1`) returns `{text}` of at most
  64 KiB before upstream truncation and history recording. Handlers receive the
  first 48 KiB as `text`, the last 16 KiB as `tail` when the output is longer,
  and the total `bytes`. Image and audio items appear as `[image]` and
  `[audio]` markers, and a replacement drops them. The owner receives
  `original`, a readable evidence reference; originals rotate per mod, newest
  256 kept.
- `on('tool_output')` observers (`tool_feedback_v1`) return `{append}` of at
  most 4 KiB, 16 KiB per call in total, added after any replacement at any
  output size. Observers receive `original: null`.
- Tool-output callbacks may call every host operation their grants allow in
  lifecycle events, such as language-server exchanges or `model.complete`,
  before the model sees the result. The output waits for them.
- `replace('tool_batch')` (`tool_batch_v1`) may merge parallel-safe calls of
  one response into one call of a tool the mod registered; the merged call runs
  through ordinary admission and approvals, and results fan out by call id.
- `replace('tool_specs')` (`tool_specs_v1`) hides or re-describes
  model-visible tools per route; execution is unchanged.
- `tool_before` also receives `schema`, `raw_arguments` and `batch`.

### Channels, processes and watches (`events_v1`)

`events.publish {channel, data, correlation?}` publishes under the caller's
namespace; subscribers declare channel patterns and receive `channel` events
(256 events / 1 MiB per subscriber). `process.start {notify: ['output','exit']}`
delivers coalesced `process_event`s. `workspace.watch {paths, recursive?,
debounce_ms?}` reports external edits as `workspace_change` with source
`external` (16 watches per mod, ignored and protected paths excluded). Watches
and timers end when their mod is disabled or its source changes, and each
delivery runs in the thread that registered it. A `channel`, `timer`,
`process_event` or watched `workspace_change` callback that changes its mod's
state republishes the terminal view, so background results appear without
waiting for the next turn. `process_event` exits carry
only the session; read the exit status with `process.status`.
`events.schedule {key, delay_ms}` (`timers_v1`) delivers one `timer` event
`{key}` to the calling mod after 1 s to 24 h; scheduling a key again replaces
it, `events.cancel {key}` stops it, 16 timers per mod. A timer never starts a
turn.

### Credentials, secrets and routes (`credentials_v1`, `secrets_v1`)

`credentials.list` returns profiles without secret material, with `status`
`ready` once enrolled; secrets are listed only to the mod that owns them.
`credentials.request` opens native flows from user contexts: ChatGPT sign-in,
masked API-key entry, refresh and removal, and `{kind: 'secret', label,
origin}` for an origin-bound secret owned by the calling mod. A mod can remove
only its own secrets, and the confirmation names the profile's kind and label. Route entries
may name a `credential`; its token replaces the request's authorization after
upstream auth, and a missing or expired credential blocks the request.
`routes.select {route, scope}` applies a configured route at the next request
or for the thread. `sidecars.start {id, credential?, secrets?}` injects a
host-approved credential and the caller's own secrets (`OMD_SECRETS`, JSON
`[{id, label, origin, value}]`) into the sidecar only; values never reach the
mod runtime or the model.

### Thread store, resume and turn activity (`store_thread_v1`, `turn_activity_v1`)

`store.*` accepts `scope: 'thread'`: data forks with the thread, is removed
when the thread is deleted and kept when it is archived. `resume` carries
`last_turn` and `restarted`. `turns.activity {turn_id?, last?}` reads turn
outcomes, tool calls, processes and file changes for the current thread from
event, tool and terminal slash-command callbacks, recorded only while an
enabled mod's source calls `turns.activity`. File changes come from the same workspace
observer as `workspace_change`, which rereads only files whose size, ctime or
inode changed. Commands record their exit
code when they finish, including commands that outlive their tool call; the log
is removed when the thread is deleted.

### Startup presentation (`terminal_welcome_v1`)

The terminal event's read-only `presentation` is `{thread_id, phase}`. A new
thread is `fresh`, an accepted native turn start makes it `started`, and a
resumed or forked thread is `resumed`, from existing host markers before the
first ready publication. Before the first editable frame, a repeatable
`event: 'startup'` callback has `ledger: null` and a null `thread_id`; its phase
comes from the host's new/resume/fork selection. Native task, app and paid
operations are unavailable through the host boundary in this preview. This is
a presentation refresh, not a once-only session or turn event. Before local
presentation is available, the whole presentation value may be absent or null.
Composer input, submission rejection, ordinary
view refreshes, and mod reload do not reset it. It describes the host session;
mods do not need to persist their own first-turn flag. A locally queued draft
is not an accepted turn. Empty bootstrap snapshots preserve the initial view;
real disabled, broken or reloaded publications replace it.

The reserved `welcome` site renders bounded generic components centered in
the owned transcript's unused area. `welcome: {show_while_composing: true}`
keeps the site visible with a draft; the default shows it only with an empty
composer. Accepted/running and resumed sessions, transcript selection/search,
raw output and overlays suppress it. Existing transcript, failures, approvals
and input retain their space; if no blank space fits the components, the site
does not draw. Inline output retains the native transcript without the
centered decoration. No welcome site preserves Codex's normal blossom policy.

`session_title_suffix` appends up to 80 visible characters to the upstream
version heading, including inline/raw output; the host keeps its source-backed
version and attribution. `greeting` overrides the startup phrase with up to
256 visible characters, and an empty string hides it. Both are last-writer
scalars in dependency order, then mod ID order, so a later opt-in theme can
override an earlier presentation default. Escape/control injection is refused.
Disable, a broken mod, or direct mode restores the upstream fields.

### Terminal surface (`terminal_surface_v1`, `terminal_media_v1`, `terminal_prompt_v1`, `terminal_pty_v1`)

The appearance additions (`terminal_surface_paint_v1`,
`terminal_backdrop_transform_v1`, `terminal_image_sample_v1`,
`terminal_import_lifetime_v1`) remain generic presentation primitives:

- `surface_styles.composer`, `.backdrop` and `.approval` accept a `TerminalSurfacePaint`
  with `top`, `bottom`, `foreground`, `border` RGB/indexed colors and
  `opacity` from 0 to 1. Background colors interpolate vertically and blend
  with existing colors. The foreground is independent of background opacity;
  reset foregrounds get a readable color against the surviving background.
  Explicit native foregrounds and special backgrounds remain. Borders use
  blank edge cells and disappear at zero opacity. `NO_COLOR` omits styling.
  Solid backdrop colors remain in narrow terminals. Inline rendering uses
  the current bounded viewport; it does not repaint earlier terminal scrollback.
  `approval` frames native approval prompts and mod confirmations; their
  text, options, default selection, focus and grants stay host-owned.
- Image and ASCII backdrops accept `position: center|fit|fill|tile`,
  `scale: 0.1..4`, signed `offset: {x,y}` in -4096..4096 cells,
  `dim`, `opacity` from 0 to 1 and optional `tint`. Image dimming blends
  toward the tint, or black if absent; ASCII tint colors decorative glyphs.
  Images may add an independent `overlay: TerminalSurfacePaint` for pixel
  gradients. Placement assumes an 8×16 pixel cell and caps its working canvas
  at 2048×2048. The host does not choose a gloss or background policy.
- `terminal.image_sample {resource, columns, rows}` returns
  `{width,height,rgba}` (row-major RGBA bytes) for a caller-owned PNG/JPEG.
  Columns are integers 1..120 and rows 1..60; sources are at most 8 MiB and
  4096 pixels per dimension, with a 64 MiB decoder allocation limit. A mod can
  implement ASCII ramps or image inspection without a new file read.
- `terminal.import_file` adds `lifetime: thread|package` (default thread).
  Package imports retain repository, owner, exact source and immutable content
  identity across settings/reload/new threads. A source change requires a new
  confirmed import. The original path is never reread. Existing blob and
  resource quotas apply; removing the mod store removes retained assets.

Surface paints compose by surface name with the later contributor replacing
that surface's paint. Backdrops retain one owner. Keeping settings, selected
assets, image-to-ASCII conversion, greetings and glass composition in a mod
lets outside authors use the same APIs for document viewers, image previews,
warnings, watermarks and dashboards.

Views may declare a `layout` tree of splits and tabs with transcript, composer
and mod-named sites (`mod/site`), plus an ASCII or image `backdrop`. Local
detected Kitty graphics use images in an owned viewport; SSH, multiplexers,
reduced motion, other protocols and inline viewports use ASCII fallback.
Decorative backdrops are omitted below 60 columns and under `NO_COLOR`.
Components add `document` (up to 100,000 lines with anchors, selection and
find), `diff`, `image` (truecolor half-block cells, alt text under
`NO_COLOR`) and `terminal` (a PTY session). Spans accept `fg` and `bg` theme
colors, `italic` and `underline` (`terminal_style_v1`); `document` keeps
span styles. A `pane` or `document` with `keys: true` (`terminal_input_v1`)
forwards keys and pastes while focused as `component_event {kind: 'input',
events}`, each event `{key, text}` or `{paste, truncated?}` (a paste is at most
64 KiB). Input waiting for one component arrives in order as one batch of at
most 64 events and 64 KiB, so a slow callback adds at most one batch of lag;
beyond 256 queued events input is dropped and the next batch reports
`dropped`. Ctrl+] leaves the component; Ctrl+C leaves it and keeps its native
meaning (interrupt or quit); Esc goes to the mod.
The mod owns the buffer, cursor and selection and draws them as spans; a key
`document` keeps its scroll across content changes and scrolls to `selected`.
A paste into a focused `terminal` component goes to the PTY, bracketed when
the program asked for it. In a layout
region, `terminal`, `document`, `diff` and `list` components without a
`height` share the rows left after the region's other components. Releasing a
mouse drag on a split border sends `component_event {kind: 'resize',
component, ratio}`, where `component` is the split's path (`r` for the root,
then `.N` per child index) and `ratio` its new percentages, so a mod can keep
the ratio in its layout. View
`keybindings` accept `Ctrl+`, `Alt+` and `Shift+` combinations of letters,
digits, F2–F12 and named keys (`Up`, `PageDown`, `Enter`, ...), except
terminal control keys and Shift+Tab; a binding that collides with a native key
is ignored with a warning. `component_event`, `view` and `focus` report
interaction. Operations:

- `terminal.notify {title, body?}` uses the configured notification method
  with a focus condition and a 2 s rate limit.
- `terminal.show_thread`, `terminal.import_file` (confirmed, at most 8 MiB),
  `composer.read` and `composer.write` (text and `{image}` resource
  attachments). The import confirmation shows the resolved path.
- `terminal.open {url} | {path}` opens an http(s) URL or an existing HTML,
  Markdown, text, PDF or image file after a native confirmation;
  `{path, line?, editor: true}` (`terminal_editor_v1`) opens a workspace file in
  the argv the user sets as `editor` in `host.json`, with `{path}` and `{line}`
  substituted.
- `terminal.prompt {kind: 'confirm' | 'text', title, message, masked?}` asks
  the user; mods never answer prompts.
- `terminal.pty {action: 'start' | 'write' | 'read' | 'stop', session}`
  starts an interactive shell from a user command after confirmation, in the
  session sandbox without network (macOS) with a scratch `HOME`. `start` may
  name a `program`, `argv` and `sha256` (`pty_programs_v1`); `write: true`
  lets the pane write the workspace and needs `fs.write`; `network:
  'loopback'` lets it reach services on this computer only and needs
  `network`. The confirmation names the program, write and network access and
  that the mod can type into the pane.
  Sessions belong to the calling mod (four per mod, sixteen in all), render
  only in views that mod owns or contributes to, and stop when it unloads. A
  focused `terminal` component receives keys; Ctrl+] leaves it.
- `builtins.invoke {command} | {action}` runs a built-in command or key action
  from user contexts; `api.builtins({keys, commands: {replace}})` overlays key
  bindings (never `approval.*`) and routes a built-in command to a mod command.

### Composer completion (`completion_v1`)

`replace('completion')` receives each `@` mention query with up to 200
upstream candidates and returns `{items: [{path}]}` in the order to show.
Paths must be workspace-relative. Without an owner upstream ranking is used;
stale results are dropped. While the user types arguments to a mod command
(`completion_arguments_v1`), the mod that registered the command receives
`{kind: 'argument', command, query, line}` when it handles `completion`
(`api.on` or `replace`), otherwise the exclusive owner does; it returns
`{items: [{insert}]}` and the list opens only when it has items. A mod can
therefore complete its own commands without owning `@` mention ranking.

### One-shot model calls (`model_complete_v1`)

`model.complete {route, prompt, timeout_ms?}` runs one tool-less, read-only
completion on a configured worker route under the task's admission, ledger
and allowance and returns `{text}`. Prompts are at most 8 KiB, the timeout at
most 300 s, and completions count against agent limits. It is available in
event and tool callbacks during a task, ends with the callback when it is
cancelled, and does not block other mods' hooks while it waits.

### Model-bound history (`history_v1`)

`replace('history')` receives a bounded view of each model request's items
(`index`, `type`, `role`, `call_id`, `editable`, a 2 KiB text preview and byte
size and `images` count) and may return `{drop?, replace?, insert?}`. Messages,
tool outputs and tool call arguments can be replaced; replacing a message with
images keeps only the new text. A reasoning item can be dropped only together
with the item it precedes and an insert cannot separate them; call and output
items are dropped as pairs; the last item (the current input) is kept; inserts
are `user` or `developer` text. The
transcript and resume data are unchanged, each applied edit is recorded, and an
invalid edit or failing mod keeps the original request.

### Binary evidence and package controls

`evidence.write` accepts `{media_type: 'image/png' | 'image/jpeg' |
'application/octet-stream', base64}` up to 8 MiB (`binary_evidence_v1`);
image references can be attached through `composer.write` and image-capable
app methods. `packages.list`, `packages.preview`, `packages.apply` and
`packages.reload` (`package_controls_v1`) install, update, remove, roll back,
enable and disable packages from local directories, pinned Git revisions and
curated index releases; `index` resolves dependencies. `packages.list` reports
every store selection: managed packages and trusted `omd-mod` selections
(`source: 'selection'`, which enable, disable and `trust` but do not update).
`effective`, `pending: 'reload'` and `failed` describe the serving session, so
a change shows as pending until that session's next safe boundary, and a
removed mod stays listed with `installed: false` until it stops.
`reload_error` names a rejected change while the previous mods keep running.
`trust` re-approves an edited selection's current source and capabilities and
keeps it enabled. `apply` and `reload` run from user contexts; `apply` shows a
native confirmation naming every new grant, dependencies as `id:capability`,
and applies exactly the confirmed plan or refuses if the package, lock or
selection changed. An update resolves dependencies through the index the
package came from and previews the capabilities it adds. `packages.reload`
makes every enabled selection revalidate at the next safe boundary, retrying
failed mods. `/omd` stays the native recovery path; its Mods row opens `/mods`
when a mod provides it.

### Dynamic tools (`dynamic_tools_v1`)

`api.dynamicTools(handler)` lets a mod define tools at run time:
`tools.define {name, description, parameters}` adds or replaces one (at most
64 per mod, names distinct from its static tools) and `tools.undefine {name}`
removes it. Definitions take effect at the next model request, reach the
handler as `{name, arguments}`, run from native event and tool callbacks, and
reset when the mod reloads.

### Host limits

`host.json` may set `mod_limits` for `watches_per_mod` (up to 64),
`paths_per_watch` (256), `timers_per_mod` (64), `pty_panes_per_mod` (8) and
`completion_items` (1000); defaults are 16, 32, 16, 4 and 200.

### Streaming providers

Mod-owned model providers need no additional primitive: a `services` grant with
a `route` runs a loopback server that Codex uses as a Responses provider, which
streams normally. `max_request_bytes` in `host.json` bounds request size and
has no host maximum, so a provider's context window is configuration.

## Author commands

| Command | Result |
| --- | --- |
| `omd-mod-author create DIR ID` | Minimal typed package with pnpm scripts and offline tests |
| `omd-mod-author examples DIR` | Live routing, coordination, recovery, terminal, workflow, and stream-replacement mod examples |
| `pnpm check` | Strict TypeScript validation against this exact SDK |
| `pnpm test` | Engine-owned scenario execution with no provider requests |
| `pnpm run run` | Runs the same deterministic scenario and prints the full trace |
| `pnpm debug` | Runs an intentional failure and retains its mapped source location |
| `pnpm run package` | Produces a checked package directory, JavaScript debug build, source map, and digest report |
| `pnpm watch -- STORE` | Re-inspects unchanged capabilities, approves the edited digest, and queues reload |
| `omd-mod-author report STORE` | Declared-versus-used capabilities, services, operations, and environment |
| `omd-mod-author events STORE` | Composition order, scope precedence, events, replacements, and conflicts |
| `omd-mod-author diagnostics STORE OUTPUT` | Reproducible JSON bundle with paths, settings, environment, and credentials removed |
| `omd-mod-author explain DENIAL` | Cause, safe remedy, and the authority boundary for a denial |

The `omd-mod` binary is part of the OMD engine. Set `OMD_MOD_BIN` only when a
development build is not already on `PATH`; set `OMD_MOD_NODE` to the supported
Node 24.18.0 executable. pnpm is the package manager. The repository also
publishes equivalent `mise run mods:*` tasks without making pnpm a mise tool.

## Package commands

| Command | Result |
| --- | --- |
| `omd-mod package-plan STORE REQUEST_JSON` | Resolve and preview the exact graph, authority, settings, and activation changes |
| `omd-mod package-apply STORE REQUEST_JSON CONFIRMATION` | Re-resolve and atomically apply only the unchanged preview |
| `omd-mod package-lock STORE` | Print exact current versions, sources, integrity, trust, settings, and rollback history |
| `omd-mod selection-status STORE` | Show saved user/project selections, precedence, source errors, and setting keys without running mod code |
| `omd-mod package-enable STORE ID` | Re-enable an unchanged trusted package at the next turn boundary, retaining settings and state |
| `omd-mod package-disable STORE ID` | Disable a managed package without deleting source, state, or cache |
| `omd-mod plugin-preview CODEX_BIN CODEX_HOME NAME@MARKETPLACE CANDIDATE` | Compare a local plugin candidate and its skills/hooks against the installed cache without applying it |
| `omd-mod package-rollback-plan STORE ID` | Preview the prior integrity-addressed package version |
| `omd-mod package-rollback STORE ID CONFIRMATION` | Restore the prior cached package disabled, preserving explicit settings |
| `omd-mod package-uninstall-plan STORE ID` | Preview removal and reject installed dependents |
| `omd-mod package-uninstall STORE ID CONFIRMATION` | Remove the managed selection while retaining local source, state, cache, and history |

A package-index file is bounded JSON with schema 1:

```json
{
  "schema": 1,
  "packages": {
    "example": [
      {
        "version": "1.2.3",
        "source": {
          "kind": "repository",
          "repository": "https://example.invalid/example.git",
          "revision": "0123456789abcdef0123456789abcdef01234567",
          "subdirectory": "mod"
        },
        "integrity": "SHA256_FROM_OMD_MOD_INSPECT"
      }
    ]
  }
}
```

A managed package manifest must declare `license` and `provenance`; the
scaffold emits both with placeholders to change. An optional `description` of
1–160 printable characters says what the mod adds; `packages.list` and the
`/mods` screen show it. Package rollback repoints the
selection at the immutable store cache, so returning to editable local
development is a fresh local install of the rolled-back source.

Resolution selects the highest exact/caret-compatible semantic version and then
checks the index integrity against the manifest, entrypoint, and every declared
lifecycle script. Each dependency needs its own exact trust entry. Index files
do not grant capabilities or script execution.

## Offline scenarios

A `mod.test.json` file uses schema 1. `virtual_time_ms` fixes `Date.now()` and
zero-argument `new Date()` inside every callback. `host_operations` supplies an
ordered result/error queue for each approved host operation. Any unmocked call
fails before external work, and every result records `paid_requests: 0`.
`settings` is a map from mod ID to that mod's explicit settings; the author
commands apply it through `omd-mod settings` before the run, so configured
behaviour is testable offline. A store-level `omd-mod test STORE SCENARIO` uses
the store's own settings instead.

A mod that fails to activate reports its retained cause, so a missing service
provider, denied capability or source error names itself instead of only asking
for a reload.

Steps can advance virtual time, invoke tools or commands, dispatch ordinary
events, model-request and response-stream middleware, tool outcomes and agent
lifecycle, reload at a safe boundary, mount a terminal view, and interact with
a mounted key or component ID. Component interaction activates buttons, inputs,
and selectors with an optional `value`; copy actions return without touching the
system clipboard. A step can carry `expect`, `expect_error`, or `cancelled`.
Additional trusted packages are listed in `packages`, enabling provider/consumer
and conflict fixtures without shared globals or ambient authority.

API `.8` adds `task_scoped: true` on `api.tool` and the `tool_exposure` event.
Before each sampling step, the event receives the host `ledger`, thread ID,
and only the current mod's optional tool names. It returns `{enable: [...]}`
for a subset of those names. A missing or failed decision exposes none of that
mod's optional tools; an invalid or foreign name disables the mod with a visible
error. Ordinary registered tools and every native tool keep their existing
exposure. A tool still executes through native
permission, cancellation, accounting, and workflow gates. Context contributors
can attach a bounded subordinate fragment for the same task without replacing
base instructions. In an offline scenario, `{"type":"tool_exposure", "payload":
{...ledger...}}` records the exact names registered for that step.

## Typed worker and workspace operations

`agents.spawn` accepts a host-authorized route and a `workspace` of `read_only`
or `isolated_worktree`. A writable child receives a captured, isolated worktree
under the native task scratch area; its parent repository is never its working
directory. `agents.wait` and `agents.result` return a host-attested thread
reference and SHA256 of the final text. A mod should validate that text against
its declared result schema and source-reference rules before calling
`agents.result` with `consume: true`. The host requires consumption before
`workspace.integrate` accepts that mod's private handle.
The typed-task mod reads the native checkpoint before spawning, passes its
bounded objective and revision into each worker prompt, and reports the
revision with the validated batch. It never marks acceptance criteria complete
on behalf of the parent.

`workspace.integrate` captures the worker's changed paths, merges against the
current parent snapshot, runs the task's configured executable check on an
isolated candidate, and obtains a candidate review before applying the exact
checked delta. It refuses conflicting parent edits, a changed candidate, a
failed check or review, or a changed parent before apply. The native ledger
owns allowance, permissions, lifecycle, and evidence. A failed apply retains
diagnostic evidence and may need operator inspection; external concurrent
writers are not locked. Cancellation, mod disable, and turn end retire owned
handles and clean their worktrees. Direct mode never loads this mod.

## Workspace reads, transactions, and write observation

The experimental `workspace` capability grants `workspace.read`,
`workspace.transaction`, `workspace.request_rename`, and the `workspace_write`
and `workspace_pre_rename` events. The host accepts only
the current canonical local repository and checks the effective read and write
permissions for every path. Reads return UTF-8 text and SHA256 for at most 128
repository-relative paths and 4 MiB. A transaction requires an exact
`expected` SHA256 or `null` for every affected path, plus bounded `writes` and
optional `{old,new}` renames. It rejects stale files, symlinks, `.git` paths,
overlapping moves, and changes outside the declared scope. Files are replaced
atomically one at a time, with a checked rollback after cancellation or a
failed multi-file operation; an external writer that changes a touched path
during rollback causes a visible conflict that needs inspection. This is not
a repository-wide filesystem transaction or a replacement for user approval.

`workspace.request_rename` captures the source and absent destination, invokes
selected `workspace_pre_rename` subscribers before the move, and accepts one
`{status:"ready",expected,writes}` proposal. No proposal, an unsupported
operation, or an unavailable server yields `{status:"fallback",reason}`.
Conflicting proposals fail visibly. The host checks all expected hashes and
effective write permissions, then applies the companion writes and move in one
checked transaction. A subscriber can read additional companion files before
returning its proposal. The [independent workspace example](examples/workspace)
demonstrates this path without using a language server.

`workspace_write` is delivered after an OMD tool call changes a source file,
with the tool call ID, path, and before/after hashes. Only a selected mod that
subscribes to the event triggers its index scan. The scan excludes `.git`,
`.omd`, `.docs`, package and Python caches, `target`, `node_modules`, `.venv`,
`venv`, `build`, and `dist`, and is
bounded to 20,000 files and 128 MiB. A failed scan reports `unavailable` rather
than claiming write coverage; more than 128 changed paths or 16 KiB of path
names also reports `unavailable`. The independent example also shows a direct
transaction for a mod tool. A change outside the thread's effective read
scope reports `unavailable` without exposing its path or hash.

The experimental `process` capability grants `process.which`, `process.start`,
`process.exchange`, `process.status`, and `process.stop`. The host resolves an
installed executable and its hash, verifies that identity at launch, and runs
it in a read-only repository sandbox with restricted network access and a
private scratch directory. The framed JSON exchange has bounded message size,
wait, output, and session count. Sessions belong to one mod and generation;
disable, reload, cancellation, and thread stop clean them up. A process cannot
write the repository through this API. The first-party `omd_lsp_sync` mod owns
Python, TypeScript/JavaScript, Rust and Java server choices and language
protocol; it is installed inactive with OMD+ and can also be installed
explicitly in a OMD Core store. It never installs a language server.
Definition, references and code-action discovery return bounded read-only
results for observed sources; applying an action and symbol rename remain
unsupported. Absent or unsupported servers report fallback.
`api.host.tryCall` returns `{ok:true,value}` or `{ok:false,error}` for an
expected unavailable operation, so a mod can report fallback without treating
server absence as a callback failure. Both `call` and `tryCall` remain subject
to the same declared capability and host permission checks.

`process.start` frames stdio as `content-length` (default) or `ndjson`;
`network: "loopback"` (with the `network` capability) allows local binding
while keeping external network access restricted. It owns process group termination
and starts adapters with a cleared host environment and an owner-only scratch
directory. The opt-in debugger package in `plugins/optional/plugins/omd-debugger`
exposes **Python launch only**; LLDB, Delve and attach are not supported. Its mod requires
separate review, trust, and enablement. Plugin installation does not activate
the mod or install Python or debugpy. OMD+ stages the plugin inactive.

## Terminal identity, rich lines and picker

Terminal views are drawn on Codex's alternate screen, including its default
fullscreen transcript; inline `--no-alt-screen` sessions keep only status
segments and commands. The `terminal` input carries a read-only `identity`
(`terminal_identity_v1`): `codex_version` from the installed build,
`install_profile` (`full`, `platform_only`, `private`, `unknown` or
`unreported`), effective `mode` (`omd`), and installed,
enabled and active mod counts. Upstream-style direct mode loads no mods.

`terminal_rich_line_v1` adds a one-row `line` component with up to 12 styled
`spans` (`text`, `tone`, `bold`; 256 characters in total), whose `label` is
the accessible text, and optional `min_width`/`max_width` (1–500 columns) on
`box`. Native draws a bounded box only when the site's inner width fits, and
header height counts only drawn boxes. Header rows are never spaced by the
comfortable density.

`terminal_lists_v1` lets a mod replace built-in list rows through
`api.replace('list', event)`. The host keeps selection actions, session state,
keyboard handling and native fallback when the mod is absent or fails.

Copy-on-select and right-click paste are Codex settings (`tui.copy_on_select`,
`tui.right_click_paste`); mods change them through `config.write`.

## Git operations

The first-party `omd_git` mod owns Git reads, the sidebar, previews and
user-invoked mutations through the public API 0.2 operations. It runs fixed
`git` argument lists through `exec.run` in the session's effective sandbox
with `network: "none"`. Reads have a 10 s timeout and reject truncated output;
the mod bounds status to 1,000 entries and 64 KiB, log to 50 commits, and each
diff to 64 KiB. The mod disables pagers and the filesystem monitor for its
commands, and external diffs and text conversion for diff reads. The host has no
`git.*` operations or Git-specific capability.

Stage and unstage require an exact single-file scope and reject conflicts and
renames. Stage additionally requires a regular file or tracked deletion.
Before each sandboxed Git write, the host checks `required_access` for every
affected path and verifies bounded `exec.run` guards. Index writes guard
status, HEAD and the full index; stage also guards file content. The guards
run inside the exclusive write operation; a mismatch rejects a stale preview.
The mod refuses incomplete or oversized scopes, and path-mutating actions
reject non-regular files. Git metadata still needs to be writable under the
session's effective permissions; installing the mod does not grant access. The
default workspace profile protects `.git`, so staging, committing, and switching
require a permission profile that explicitly grants `.git` write access for the
selected workspace. The current-host terminal fixture verifies both the default
denial and the explicitly granted path without changing the default profile.
For an opt-in workspace profile, the relevant configuration is:

```toml
default_permissions = "git-workspace"

[permissions.git-workspace]
extends = ":workspace"

[permissions.git-workspace.filesystem.":workspace_roots"]
".git" = "write"
```

Commit previews list staged paths and can show the staged diff. Confirmation
guards status, HEAD and the full index, then runs ordinary Git hooks and
signing in the sandbox. A failed hook reports the failure and whether HEAD
moved. A successful commit compares the committed tree with the previewed
index; a hook that changed the index produces an explicit warning to inspect
the resulting commit. This post-check reports a difference after the commit;
it cannot prevent a hook from changing staged content during execution.

Discard supports regular tracked worktree changes and untracked files. It
backs up the exact file outside the repository before changing it; untracked
deletion uses `workspace.transaction` with an expected content hash. Restore
requires the path to still match the post-discard state. Branch switching
requires a clean worktree, a local destination, a bounded nonempty set of
regular or absent affected paths, and a backup. Its guards bind status, HEAD,
destination commit and branch diff before `git switch --no-overwrite-ignore`.
Conflicts, symlinks, directories, oversized scopes and unsupported path
shapes fail closed.

## Diagnostics and source maps

The engine transforms TypeScript with an inline source map and runs Node with
source maps enabled, so callback stacks resolve to the authored `index.ts` line.
Status retains a bounded per-mod log containing event, handler, generation,
outcome, and elapsed microseconds plus aggregate timing. It never adds mod-side
filesystem or process access.

The source-use report is derived from registrations and literal host/service
calls. It compares declared capabilities, service imports/exports, and admitted
environment access with what the source uses; undeclared use is rejected and
unused grants are reported. Diagnostics explain how to narrow or explicitly
approve authority, but tooling cannot grant permissions by itself.

## Composition and safety

The mod runtime is single-threaded and never runs re-entrantly. Request and
stream hooks wait up to 2 s while another request or stream hook holds the
runtime. When a non-hook callback holds it, such as a tool waiting for the agent
it spawned, a mod-spawned agent's request and every response stream proceed at
once without hooks; other requests wait up to 2 s first. Each skip is recorded as
`middleware_skipped` with the hook and reason, and a skipped or unsubscribed
stream runs without stream hooks for the rest of that response. The middleware
log records only selections, transformations and fallbacks, and stops growing
at 8 MiB.

`service_dispatch_v1` keeps a service provider's own capability grants, source identity, storage namespace and host-operation provenance when a consumer calls it. A nested call shares the initiating callback's cancellation, 32-call and 5 s execution budgets; recursive providers and chains beyond eight callback frames fail closed. Standalone invocations without a provider-aware host dispatcher refuse that provider's host operation. Offline `host_calls` records the actual mod caller for every mocked operation.

The host answers each host call inside the running callback, so a callback
runs once. `hook_budget_ms` bounds the callback's own JavaScript time; waiting
for host calls does not count. A separate 5 s host total bounds the callback's
execution; exceeding it fails the callback with `callback_execution_budget`.
Offline runners without an interactive host replay the callback once per host
call instead.

Dependencies run before consumers and remaining mods use lexical ID order.
Project scope shadows user scope without inheriting its state or grants.
Observers compose in that order; exclusive replacements, contract IDs, service
providers, and namespaced tools fail closed when contested. Native permissions,
credentials, accounting, cancellation, evidence, workflow enforcement, and
provider authorization remain outside the mod API.


## Plugin components and shell commands

A plugin can contain `.codex-plugin/omd.json` with `{"schema":1,"component":"component","sha256":"<inspected package digest>"}`. The contained directory is an ordinary public-API package with `mod.json` and `index.ts`. Inspect it with `omd-mod plugin-component PLUGIN_ROOT`; the inspector rejects traversal, symlinks and digest changes. Trust and enable the inspected component through the existing mod-store workflow. The descriptor does not activate it.

`omd COMMAND --repo PATH --store STORE [--home CODEX_HOME]` dispatches an exported CLI alias. It offers `evidence.*` and `sessions.*` only; model and process operations are unavailable. The host store must be protected from agent process writes. Ambiguous command ownership fails closed.

Independent examples live in [`examples/virtual_reader`](examples/virtual_reader), [`examples/scoped_data`](examples/scoped_data), [`examples/review_probe`](examples/review_probe), and the existing [`examples/workspace`](examples/workspace). Their fixture tests demonstrate shared interfaces; they are not production advisor, GitHub, memory, edit-anchor or report implementations, and they do not establish live model usefulness or release qualification.

Completed-turn packets retain bounded original visible records across a host-observed compaction, tagging each segment's records with its history revision. Compaction summaries do not replace those records. An unobserved history reset or interrupted compaction still rejects evidence explicitly. The extension decides how to select and summarize a truncated packet.

Live session reads use the runtime's configured state database, including a separate SQLite home. Standalone commands resolve the selected user configuration/profile and `CODEX_SQLITE_HOME`; `--sqlite-home` explicitly selects the state directory. If a repository or system configuration redirects SQLite, standalone dispatch requires that explicit directory rather than guessing. Relative SQLite directories are rejected. The pinned reader consults `state_5.sqlite` read-only before and after a read, and does not modify transcripts or opt-out state.

Granted request helpers use the host's bounded request supervisor. It captures a completed helper result before returning it, then terminates the process group; cancellation, deadline and loss of the host also terminate the group. Existing long-running service supervision remains separate. The helper, supplied by the extension, owns request parsing, remote protocols and content selection.
