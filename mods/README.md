# TypeScript mods

API `0.1.0-experimental.8` runs on the pinned Codex 0.157.0 OMD 0.1.0 host,
Apple Silicon macOS, and Node 24.18.0. Mods are editable, hash-approved TypeScript
packages. The API remains experimental; this delivery does not freeze the API or
complete independent preview feedback.

Install the exact `@oh-my-diff/mod-api@0.1.0-experimental.8` author package with
pnpm. It exports the typed SDK and `omd-mod-author` CLI. See
[REFERENCE.md](REFERENCE.md) for version-matched API and command documentation.
The quickest local flow is:

```sh
pnpm exec omd-mod-author create ./my_mod my_mod
cd my_mod
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm run run
pnpm debug
pnpm run package
```

`pnpm test` is owned by the OMD engine and refuses unmocked host operations, so
author checks do not make paid requests. `pnpm watch -- /absolute/mod-store`
re-inspects an edited local source, retains the exact declared capability set,
and queues a safe-boundary reload. The author package ships the executable
live-replacement examples with `omd-mod-author examples DIR`. Small
demonstrations remain repository-only conformance fixtures.
[EXTENSION_TYPES.md](EXTENSION_TYPES.md) records the checked classification and
rationale for every package.

## Install, edit, and recover

Build the patched runtime using the repository's normalized-upstream procedure:

```sh
cargo +1.95.0 build --locked -p codex-cli --bin codex -p codex-omd --bin omd-mod
omd-mod init /absolute/external/mod-store /absolute/node-24.18.0/bin/node
omd-mod inspect /absolute/package
omd-mod trust /absolute/external/mod-store /absolute/package SHA256 EXACT_CAPABILITIES_CSV
omd-mod enable /absolute/external/mod-store /absolute/package
omd-mod status /absolute/external/mod-store
```

Read the package's source and manifest before approving the displayed digest and
capabilities. The digest covers `mod.json`, a NUL byte, and `index.ts`. Local and
shared directories use the same pinned-source mechanism. Activation never
installs dependencies, runs package scripts, or downloads Node. Runtime imports
are rejected, except the optional Pi adapter's documented virtual `typebox` module.
Type-only SDK imports are erased by Node's erasable TypeScript loader.

Set `"mods": "/absolute/external/mod-store"` in the existing OMD host manifest.
The store must be outside the repository. Host permissions, spending, task
contracts, credentials, and service grants remain host/user configuration.
OMD-off never loads mods. A package whose own code fails at session start is
disabled with a visible source-located error while the rest of the session runs
normally; a selection the store itself rejects — an untrusted digest, a
capability grant that is too narrow, or a conflicting registration — fails
visibly, and disabling it or starting in native direct mode restores access.

After editing, inspect and trust the new digest, then enable it. Updates preserve
settings and state and initially remain disabled. These commands queue changes
for the next native turn boundary:

```sh
omd-mod reload /absolute/external/mod-store
omd-mod disable /absolute/external/mod-store /absolute/package
omd-mod settings /absolute/external/mod-store /absolute/package '{"route":"astra"}'
omd-mod command /absolute/external/mod-store counter reset null
```

Commands run from the manager CLI (JSON payload) or from the TUI. Every
registered command appears in the `/` popup as `/<mod_id>:<name>` with its
optional description (`api.command(name, handler, {description})`). A bare
`/<name>` alias is added only when no built-in command, other mod command, or
Pi prompt uses that name; a clashing alias is dropped and the namespaced entry
states why. Slash invocations pass the argument text as a string. A command may
return `{display, insert, submit}`: `display` adds transcript text, `insert`
adds composer text, and `submit` sends a user message through the normal native
submission path (queued while a turn runs; a leading `!` stays literal text and
never starts a local shell). `insert` and `submit` are mutually exclusive; other
return values are displayed. Commands never create a native task; operations
requiring one fail with `host_operation_unavailable`. Submit a message or use a
registered native tool for work that needs agents or task operations.

`omd-mod discover USER_DIRECTORY PROJECT_DIRECTORY` inspects packages without
activating them. Project IDs shadow user IDs in discovery output, which includes
the shadowed path. Explicit trust selections remain authoritative: enabling two
packages with the same ID in one scope is an activation conflict, and a
project-scoped package that takes precedence over a user-scoped one is recorded
with both paths and keeps its own state — never a silent privilege transfer.
For unmanaged editable packages, `requires` still declares presence and order
between already-trusted mods. Managed installation, exact repository revisions,
versioned package indexes, dependency resolution, integrity locks, previewed
updates, offline reuse, rollback, disable, and uninstall use the package manager
described below.

## Reproducible package lifecycle

`omd-mod package-plan STORE REQUEST_JSON` resolves a complete package graph and
prints every version, integrity, source, license, provenance, entrypoint, API,
dependency, capability, settings-schema, explicit-setting, lifecycle-script,
and activation change. Nothing is activated until the unchanged request and the
printed `confirmation` are passed to `package-apply`:

```sh
request='{"source":{"kind":"local","path":"/absolute/my_mod"},"scope":"user","activate":true,"offline":false,"trust":{"packages":{"my_mod":{"capabilities":["commands"],"dependencies":false,"lifecycle":[]}}},"settings":{"my_mod":{"mode":"safe"}}}'
omd-mod package-plan /absolute/mod-store "$request"
omd-mod package-apply /absolute/mod-store "$request" CONFIRMATION
omd-mod package-lock /absolute/mod-store
```

Local packages remain in place and are never overwritten; each approved version
is also copied into the integrity-addressed offline cache. A repository source
uses `{"kind":"repository","repository":"LOCAL_PATH_OR_HTTPS_GIT_URL","revision":"FULL_40_HEX_COMMIT","subdirectory":"optional/path"}`.
Remote repositories require HTTPS and are retained as bare Git caches. A versioned source uses
`{"kind":"package","index":"/absolute/index.json","id":"my_mod","version":"^1.2.0"}`;
the index maps IDs to exact versions, sources, and expected integrity digests.
Package locks retain the exact resolved graph and prior versions.

Managed manifests require `license` and `provenance`, may select a safe relative
TypeScript `entrypoint`, declare exact or caret-compatible `dependencies`, and
may publish the bounded settings-schema subset (`object`, typed properties,
`enum`, `default`, `required`, and `additionalProperties`). Updates preserve
explicit settings. A changed state version remains disabled until the existing
state migration command succeeds and a new activation plan is confirmed.

Every resolved package needs its own exact capability grant. Installing a
dependency never inherits the parent package's trust or adds permissions,
credentials, providers, spending authority, environment access, or lifecycle
authority. `dependencies: true` approves resolution for that one package.
`lifecycle` must exactly list its declared `install`, `update`, and `uninstall`
scripts; approved scripts run through the same bounded Node version, timeout,
empty environment, import denial, and macOS Seatbelt containment as mods. Scripts
cannot run package-manager commands or install ambient Node dependencies.

```sh
omd-mod package-disable /absolute/mod-store my_mod
omd-mod package-rollback-plan /absolute/mod-store my_mod
omd-mod package-rollback /absolute/mod-store my_mod CONFIRMATION
omd-mod package-uninstall-plan /absolute/mod-store my_mod
omd-mod package-uninstall /absolute/mod-store my_mod CONFIRMATION
```

Rollback activates nothing automatically. Uninstall removes only the managed
selection and active lock; it leaves local sources, state, history, and cached
bytes available for recovery or offline reinstall. An unavailable source may be
reused with `offline: true` only when its exact locked integrity is cached.
Integrity mismatches, unavailable dependencies, incompatible versions, cycles,
stale confirmations, and untrusted capability/script changes fail before the
configuration changes. A small journal restores the prior lock and selection if
an update is interrupted between their atomic writes.

## Write a mod

Use [api.d.ts](api.d.ts) and the author examples. Every offered example is a
`mod` because it replaces live engine or terminal behavior:

| Example | Extension type | Why a mod is required |
| --- | --- | --- |
| [routing](examples/routing/index.ts) | mod | Replaces the admitted model/provider/reasoning preset at the live request boundary |
| [coordination](examples/coordination/index.ts) | mod | Drives native agent coordination and consumes results during the active task |
| [recovery](examples/recovery/index.ts) | mod | Replaces live compaction and context recovery policy |
| [terminal](examples/terminal/index.ts) | mod | Replaces live terminal layout, rendering, theme, and key actions |
| [kernel](examples/kernel/index.ts) | mod | Alters admitted model requests and the live response stream |
| [workflow](examples/workflow/index.ts) | mod | Registers and restricts a host-enforced live workflow contract |

The context observer, counter, guard, simple interception, service provider and
service consumer sources stay in this repository for conformance. The synthetic
reader and tool packages stay in Rust integration tests. They are not packed as
SDK examples or offered by `omd-mod-author`; their user-facing forms belong in a
skill/hook or plugin rather than a mod.

Three first-party packages are shipped as an installable private preview of the
selected signature workflows. They use the same public API and capabilities as
any outside package:

| Package | Extension type | Workflow and mod requirement |
| --- | --- | --- |
| [omd_workspace](first-party/omd_workspace/index.ts) | mod | Replaces the live terminal workspace with declarative task, worker, allowance, activity, settings, key and rendering surfaces |
| [omd_coordination](first-party/omd_coordination/index.ts) | mod | Replaces live coordination and context policy: lead route, operating brief, delegated worker evidence; exports bounded delegation preparation |
| [omd_recovery](first-party/omd_recovery/index.ts) | mod | Replaces live escalation and delegation dispatch policy: failure class, tool eligibility, advisory route, and Contributor-outage action |

Three additional first-party packages are inactive Phase 11 candidates in
`extensions/development.json`: `omd_task_tools` selects optional checks at the
per-step tool boundary, `omd_verification_gate` registers a user-selectable
final-verification workflow and seals delegation through the native host, and
`omd_session_anchor` replaces local compaction policy with bounded host
checkpoint context. Their offline scenarios and lifecycle checks are described
in [the candidate audit](../.docs/audits/additional-first-party-live-mods-20260922.md).
They are not part of the private preview or a supported release bundle; install
and enable them only through exact source trust while their task-value and
overhead gates remain open.

Four terminal packages ship with the installation profiles through the public
API described in [the reference](REFERENCE.md#terminal-identity-rich-lines-picker-and-selection):
[`omd_logo`](first-party/omd_logo/index.ts) draws the Oh My Diff wordmark and
launch status from the read-only identity and is active in both profiles;
[`omd_model_picker`](first-party/omd_model_picker/index.ts) selects the compact
native `/model` and reasoning layout and is active in Full OMD;
[`omd_selection_copy`](first-party/omd_selection_copy/index.ts) sets the
copy-on-highlight policy and shows its last result; and
[`omd_git`](first-party/omd_git/index.ts) adds a left Git sidebar with a commit
graph, changed files, diffs, stage, unstage, confirmed commit, discard and
branch switch over the [`git` operations](REFERENCE.md#git-operations). The last
two are installed inactive in Full OMD; enable them explicitly.

`omd_typed_tasks` is a separately installed, inactive Full OMD candidate. It
uses the public task tool and host operations to run up to four typed siblings,
validate each final result and its cited sources before consumption, and
request host-owned isolated integration for edit workers. Its generic host
operations are described in [the API reference](REFERENCE.md#typed-worker-and-workspace-operations).

[PREVIEW.md](PREVIEW.md) is the first-use and customization guide;
`scripts/private_lean_v1.py preview install` provisions them from pinned
sources into an external store.

```sh
pnpm --dir mods install --frozen-lockfile
pnpm --dir mods check
pnpm --dir mods test
```

A manifest has package schema 1, an ID of at most 24 lowercase ASCII letters/digits/
underscores, a package version label, a supported API version, a positive
independent `state_version`, declared capabilities, and an optional `requires`
list of up to four other mod IDs. Optional `compatibility` metadata declares
exact OMD `releases`, `required_features`, and `optional_features`; missing
required features reject before activation while unavailable optional features
remain visible in status. `hook_budget_ms` optionally narrows each JavaScript hook to
25–2000 ms (1000 by default); it bounds every single evaluation, while the whole
callback including host-call replays is bounded by a separate 5 s host total. `environment` may request only the host-provided
`crypto` global; filesystem, process, network, DOM, Node, and package globals are
not admitted. `services.exports` and `services.imports` declare versioned service
contracts before activation. Exports use semantic versions and an explicit
`stable`, `deprecated`, or `experimental` label; imports use an exact version or
a compatible caret range. Activation registers callbacks and
must not write state or call host operations. Settings are read-only JSON.
Modules have fresh globals on every invocation. Persist data through
`api.state.get/set`; never store secrets there.

`api.host.call` is a bounded synchronous effect operation, available inside a
native tool callback. Rust suspends and replays the callback with validated
receipts. Already completed operations execute once within that invocation.
Keep computations deterministic, avoid random/time-dependent control flow, and
let suspension propagate. If catching native errors, rethrow non-Error values:

```ts
try {
  return api.host.call('task.status', null);
} catch (error) {
  if (!(error instanceof Error)) throw error;
  return { error: error.message };
}
```

Callbacks may use `async`/`await`, but parallel host calls and swallowed suspension
are rejected. State commits only after the final successful callback. Executed
native effects survive later callback failure; they are never described as rolled
back. Retrying a failed invocation is a new operation, not exactly-once recovery
across crashes. Native accounting and checkpoint evidence remain authoritative.

## Native operations and composition

[COVERAGE.md](COVERAGE.md) is the public coverage and composition contract: every
decision, its observe/alter/replace support, timing, ownership and limits, what it
adds over the native plugins and hooks, and the executable case that proves each
row. It is generated from [conformance/contract.json](conformance/contract.json)
and checked against the host source by `python3 scripts/mod_conformance.py`, so an
undocumented capability, event, replacement point or host operation fails. Unknown
APIs, capabilities, imports, events, adapters, and host operations fail explicitly.
First-party and external packages use identical capabilities.

API `0.1.0-experimental.7` adds terminal components and composable render sites
without making a stable API
commitment. `api.fieldPolicies` gives the authoritative per-field classification
for every admitted request/response, prompt, session, agent, tool, and host-operation
event: `observe_only`, `alterable`, or `replaceable`. `api.middleware` registers
composable observers for those events. Only `model_request` may select a different
host-authorized preset, and only unprotected `response_stream.text` may be
transformed. All other middleware results are ignored unless a separately declared
exclusive replacement point owns that decision.

Each model request records its main-thread or subagent scope, original and effective
preset, and ordered mod ID/version/hash/trust-tier provenance. A mod sees only the
host's authorized provider/model/reasoning tuples; it cannot synthesize one. Stream
middleware sees a digest, raw usage, and whether opaque reasoning or another
protected event is present. Usage, signed or opaque reasoning, permissions,
accounting, cancellation, transcript/evidence records, workflow checks, tool results,
completed actions, and assurance receipts stay native. A failing stream transformer
is disabled and the unchanged event continues with a source-located fallback record.

The finite support matrix, stability/deprecation rules, feature negotiation,
upgrade/rollback procedure, and explicit interchange limits are published in
[COMPATIBILITY.md](COMPATIBILITY.md).

Inter-mod services are host-routed rather than shared-memory calls. A provider uses
`api.provide`; a consumer calls `api.services.call` for a name in its manifest's
imports. Names contain at least two lowercase namespace segments, versions match
the declared exact or caret-compatible requirement, methods declare JSON input/output kinds, and calls carry caller/provider
provenance. Missing required providers, incompatible versions, dependency cycles,
and colliding providers are rejected before activation; an absent optional import
remains callable only as an explicit `optional_service_unavailable` error. The host
generates `installed-contracts.d.ts` from the activated providers.

Before activation, the host derives each package's source-use manifest for registered
events and replacements, literal host operations and service calls, and environment
access. Undeclared use is rejected. `omd-mod status` publishes that manifest alongside
unused capability/environment grants so approval can be tightened. This check is in
addition to runtime capability checks and the existing hash trust decision; it does
not copy the source-validation trust model used by Claude Code Mods.

`api.on` and `api.middleware` compose; `api.replace` is exclusive and fail-closed.
Mods run in one deterministic order: declared dependencies and service providers
first, then mod ID ascending. `omd-mod status`
publishes that `order`, each selection's `scope`, and any `rejected` selection
with its reason.

Everything that can stop a mod is resolved before it is activated, and each
outcome disables only the mods involved:

| Situation | Result |
| --- | --- |
| Two mods claim one replacement point, workflow contract ID, service contract or namespaced tool name | every claimant is disabled and named; the rest keep running |
| `requires` names a mod that is absent, disabled or itself failed | the dependent chain is disabled |
| `requires` forms a cycle | every mod in the cycle is disabled |
| One ID is enabled twice in the same scope | both selections are rejected |
| One ID is enabled in both scopes | the project-scoped selection wins; the user-scoped one is recorded as shadowed and never activated; the two scopes never share mod state |
| A package throws while activating, loses a capability, or fails the store | that package alone is disabled with a source-located error |

`omd-mod trust STORE PACKAGE SHA256 CAPABILITIES_CSV [user|project]` records the
scope; it defaults to `user`. Discovery reports project packages shadowing user
packages by ID, and never grants trust. The initial load isolates each selection;
a later reload is transactional, so a broken edit keeps the previous working set
loaded and shows the reason once.

`api.on` observes lifecycle or contributes context. `api.replace` exclusively
claims `routing`, `worker_context`, `compaction`, `context`, `tool_before`,
`terminal`, or `input`.
Duplicate replacement claims fail before activation. Other callbacks run in
lexicographic mod-ID order. Multiple tool argument replacements fail closed;
denial wins over execution. Replacement tools pass through ordinary native
routing, hooks, permissions, and lifecycle accounting.

Delegation, scheduling, coordination, review cadence, and recovery can be
implemented with native agent handles and by replacing the corresponding tool
entrypoints. `review.run`, `review.complete`, `delegation.contribute`, and
`recovery.escalate` call the original native handlers, including their operation
locks, one-shot limits, evidence capture, and authorization checks. Replacing a
tool response does not satisfy the native completion gate. The selected contract
cannot be silently weakened.

Agents are task-owned, read-only native threads. Writable reviewed integration
uses `delegation.contribute`. Each spawned role has a unique native worker ID,
objective claim, inherited project instructions, intersected permissions,
configured route, deadline, and shared usage attribution. Handles are private to
the owning mod and generation. `agents.wait` waits at most 30 seconds and can
return `running`; inspect it before reporting success. Consume completed results
explicitly. Cancellation, turn completion, disable/reload boundaries, and shutdown
release workers; unused completed results are recorded as discarded and replay as such on resume. Callback failure immediately releases the failed mod's agents and services.

Routing selects among the host's Sol/Astra presets when creating/resuming a lead
thread; a task-entry selection must exactly match the configured model, provider and
reasoning effort. `worker_context` selects one configured bounded delegated-worker
policy and refreshes at turn-boundary reload. Invalid or failed decisions keep the
native manifest fallback. Agents select a preset on each spawn. Each preset includes
its provider, model, and reasoning setting. Compaction
replacement returns a threshold or `{threshold, prompt}` at thread creation. The
threshold stays bounded by the host's configured threshold/window. The prompt
replaces the native summarization prompt only when the final route uses native
local compaction; routes with provider-side remote compaction (for example OpenAI
Responses) keep native behavior and show a
`compaction_prompt_unsupported_for_remote_compaction` diagnostic. These
configuration decisions require a new/resumed thread to affect an existing
session; other hooks reload at the next turn.

The `input` capability observes every submitted lead prompt (TUI and `codex exec`)
before native `UserPromptSubmit` hooks and history recording. Handlers receive
`{text, attachments}` (the number of non-text items). Any mod may return `{deny: reason}`; the prompt is rejected with
a visible notice naming the mod and no model request is made. Only the exclusive
`api.replace('input')` owner may return `{text}`; the rewritten text replaces the
text items (attachments are kept), all native checks then run on it, and a
visible warning names the mod and shows what the model received. A failing input
handler rejects the prompt and disables that mod until reload.

Legacy lifecycle events are lead-only observers: `start`, `resume`, `idle`, `stop`,
`tool_result`, `turn_start` (`turn_id`), `turn_end` (`outcome` completed,
aborted, or error), `compaction_start`/`compaction_end` (`trigger` manual or
auto), and `agent_end` for the owning mod's agent handles (`role`, `status`).
`agent_end` is delivered after the agent finishes and after any running callback
of that mod releases the runtime; it cannot run host operations.

The fine-grained `session`, `prompt`, `agent`, `tool_call`, `tool_result`, and
`host_operation` middleware events cover both admitted lead and subagent paths where
the native host owns them. Their fields remain observe-only in middleware. Exclusive
`input` and `tool_before` replacements retain their existing native permission,
transcript, and workflow boundaries.

## Workflow contracts

The host enforces one explicitly selected, versioned workflow contract per task.
A contract states which second-party calls the task may make and what final
review and completion it requires. Two contracts ship:

| Contract | Delegation, child agents, opposite-lead, escalation | Milestone review | Final review | Completion | Assurance |
| --- | --- | --- | --- | --- | --- |
| `reviewed_omd@1` (bundled default) | allowed | required | separate reviewer | separate adversarial verifier | `independently-verified` |
| `solo_evidence@1` | denied | none | the lead's own final self-review | self-verified against the immutable contract | `self-reviewed` |

The assurance label is derived from the requirements, never asserted. A
`solo_evidence` completion receipt records `self_reviewed` with
`independent_review: false`, and the host rejects any receipt that claims more
assurance than the active contract provided. A legacy manifest that reduces the
old capability booleans activates a `legacy_capabilities@1` contract whose
requirements and label match exactly what those booleans meant.

Selection is native. `omd-contract list` shows the catalog, `omd-contract plan`
prints the before/after requirement changes and the confirmation token for a
weaker choice, `omd-contract select` records a user default, and
`omd-contract require` records a project assurance floor. An explicit task
selection outranks a user default, which outranks a project recommendation,
which outranks the bundled default. A choice weaker than the bundled default
does not activate without its exact confirmation token, and a choice weaker than
a project floor fails closed with both sides named. Activation and migration
failures retain the prior contract; nothing downgrades silently.

With the `workflow` capability a mod may:

- **observe** — register the `workflow` event and call `workflow.status` for the
  active contract, its provenance, denied operations, and restrictions;
- **alter** — call `workflow.restrict` with `delegate`, `spawn_child_agent`,
  `opposite_lead_advice`, or `escalate` and a reason. Restrictions only remove
  authority. Requesting a review, checkpoint, final-review, or completion
  restriction fails, because removing recorded evidence would weaken the
  contract;
- **replace** — call `api.contract(definition)` during activation to register a
  complete contract. Registration is exclusive: two mods registering the same
  contract ID conflict before activation, and a registered contract may not
  redefine or shadow a bundled one. A mod cannot select its own contract; only
  the native surface activates it.

`omd_status` reports the active contract, its assurance label and description,
its requirements, and every denial and restriction recorded so far.

## Terminal extension points

The exclusive `terminal` owner returns a bounded base view (see `TerminalView`
in [api.d.ts](api.d.ts)). On `.7`, terminal observers may return bounded
`TerminalPatch` values in dependency order. Site replacement conflicts fail the
later patch without leaking partial changes; wrappers contain exactly one slot.
Native input, modal controls, cancellation, transcript storage and recovery remain
native.

- Layout: the `sidebar`, `header`, `above_composer`, and `dialog` render sites
  accept bounded trees of box, text, button, input, select, Markdown, code, pane,
  dialog, and wrapper-slot components. Legacy text panels remain supported. The
  sidebar hides below 80 columns, the header below 16 rows, and dialogs fall back
  on narrow terminals. These require the fullscreen terminal except the
  above-composer text fallback.
- Status: up to four segments of 40 characters appended to the native status line.
- Theme: `accent`, `user_message_background`, `success`/`attention`/`failure`,
  `diff_added`/`diff_removed`, and `muted` accept a 256-color index or `#rrggbb`
  mapped to the terminal's color depth. `border`, `density`, and `icons` select
  bounded presentation variants, while `syntax` selects an installed Codex syntax theme. An
  unknown syntax theme keeps the configured theme and shows a warning; removing it
  restores the configured theme.
- Keybindings: `F2`–`F12`, `Ctrl+<letter>` (except c, d, h, i, j, m, z) and
  `Alt+<letter>`. A string or `{insert}` inserts a draft, `{submit}` sends a user
  message, `{command, args}` runs a mod command or Pi prompt, `{focus}` moves to
  a declared component, and `{copy, label}` uses the native clipboard path. A key
  that is bound in the active native keymap or starts a native chord keeps its
  native action; the mod binding is ignored with a visible notice.
- Interaction: the native TUI owns focus, scrolling, redraw, pointer and keyboard
  dispatch, resize fallbacks, accessibility labels, clipboard authorization, and
  cancellation. Component IDs and labels are required and bounded. Raw terminal
  escapes and transcript mutation are rejected.
- Rendering: message/tool presentation templates keep `{text}` exactly once.
  `completed_tools: compact` groups only successful completed agent tool output;
  active work, failures, user shell commands, prompts, evidence, and the full
  transcript stay visible through native surfaces.

Theme, keybindings and status segments apply in inline and fullscreen modes when
the OMD terminal capability is enabled. While a mod tool runs, a sidebar progress
panel shows its label (`ToolSpec.label`) and latest `api.progress(text)` update;
each completed or failed mod tool call adds a transcript line such as
`• Ran Counter (mod_counter_count)`. `api.progress` is available only inside a
tool callback (32 updates of 1 KiB); updates emitted before a suspending host
call are shown before that call runs. Non-fatal host diagnostics (for example an
unsupported compaction prompt or a failed `agent_end`) appear in a sidebar panel.

## Host-approved services and opaque secrets

The host manifest may declare `mod_services` and `mod_secret_refs`. A mod supplies
only a service ID to `sidecars.start` or `providers.register`. It cannot choose
an executable, arguments, filesystem/network grants, pricing, URL, or secret path.
For example, a host-owned declaration can contain:

```json
{
  "mod_services": [{
    "id": "helper",
    "mod_id": "my_mod",
    "program": "/absolute/approved/helper",
    "program_sha256": "EXACT_EXECUTABLE_SHA256",
    "arguments": [],
    "read_paths": [],
    "network": false,
    "secrets": {"HELPER_TOKEN": "helper-account"}
  }],
  "mod_secret_refs": {"helper-account": "/absolute/private/token"}
}
```

Executables must be canonical and outside the repository. Services use the native
controlled process executor, a read-only filesystem intersection, explicit read
paths, no inherited shell environment, and native task/worker deadlines. Network
access requires both the service declaration and the parent's existing grant.
Secret bytes are supplied only to the approved process environment; callback
receipts expose opaque reference names. Native permissions deny the mod trust/state
store and referenced secret files to lead and worker tools, including commands
redirected by interception. Mod-enabled sessions use the existing narrow native
process sandbox so platform scratch-directory allowances cannot reopen those
paths. Service stdout/stderr are not returned to mods.
Approved services must remain in their owned process group and must not daemonize
or detach descendants. Services stop at turn end, interruption, reload/disable
boundaries, or shutdown. The bundled Codex CLI supervisor also bounds service lifetime and
kills its process group after abrupt host death; they are not global daemons.
`sidecars.status` reports process liveness, not successful application work.

A provider service adds a `route` matching the native route schema (provider,
model, reasoning_effort, responses_url, rates). The provider ID must already be
configured, and the URL must be explicit loopback HTTP with a port. Registration
waits for `GET /_omd/ready` to return a body ending exactly in
`OMD_READY:<OMD_READY_TOKEN>`; the host injects the per-launch token. An unrelated
listener cannot satisfy readiness by echoing the request. A registered service
ID becomes an agent route alias; unregistering removes it.

This adapter ABI supports the native Responses transport and the two admitted
lead model IDs. It does not promise arbitrary provider/model compatibility.
Approved provider processes are trusted transport adapters: they must report
usage faithfully and must not make autonomous model requests or hidden retries.
Native requests through their registered route retain admission, bounded
exposure, deadlines, and accounting. The host does not certify arbitrary
third-party executable behavior.

## State, reload, and failure recovery

State writes use atomic replacement and compare-before-write conflict detection.
Each invocation reads the current state first, so the TUI, CLI and native host
can use the same mod in turn; a write racing another write during a callback
still fails instead of losing an update. A lost race fails that call with
`state_conflict` and leaves the mod enabled, so the next invocation reads the
current state and proceeds. To change its version,
register `api.on('migrate', ({from,to}) => ...)` and set the migrated value with
`api.state.set`. Trust the updated package while disabled, then run:

```sh
omd-mod migrate /absolute/external/mod-store /absolute/package
omd-mod enable /absolute/external/mod-store /absolute/package
```

Migration checks the exact approved source and capabilities, runs without native
task effects, retains a content-addressed backup, and atomically replaces the
state. Failed migration leaves prior state intact. Source/settings are retained.
Rollback is explicit while the trusted package is disabled:

```sh
omd-mod rollback /absolute/external/mod-store /absolute/package /absolute/external/mod-store/state-PACKAGE.json-backup-SHA256
```

The host verifies that the backup belongs to the package and scope, retains the
current state as a forward-recovery copy, and atomically restores the backup. It
does not rewrite package source or settings; restore a package release that
understands the restored state before enabling it. Arbitrary state/session
version interchange is not claimed.

Reload stages the entire enabled set. Broken new code retains eligible previous
code, while explicit removals and capability revocations still take effect.
Generation checks reject stale tools. An in-flight callback uses frozen source;
queued edits do not change it. Runtime failures other than `state_conflict`
disable the affected mod until explicit reload. A mod that throws while
activating at session start is disabled on its own with its source-located
error, so one broken package never prevents the host from starting or stops the
others; the same failure during a reload keeps the previous working code
instead. `mod-status.json` is a current native status snapshot, including
source hashes, registrations, and bounded source-located failures.

Each evaluation uses a fresh deny-by-default Seatbelt process, an empty inherited
environment, no ambient Node APIs, a 64 MiB V8 old-space limit, the manifest's
per-hook synchronous budget, and a budget-plus-250-ms process deadline. The heap
setting is not a total RSS limit. A callback has at most 32 host operations and 6
seconds of cumulative JavaScript evaluation; native effects retain their own task
deadlines. Input is
512 KiB, source/output 64 KiB, receipts 128 KiB, and each context fragment 1 KiB.
At most 16 mods, 16 tools/commands per mod, and eight managed services are admitted.

## Optional Pi adapter

Set `"adapter":"pi-0.74-tools-commands-v1"` in a package manifest to pass the
Pi subset to its default export. The named subset matches the
[Pi v0.74.0 extension types](https://github.com/earendil-works/pi/blob/v0.74.0/packages/coding-agent/src/core/extensions/types.ts):
`registerTool` with name/label/description/parameters/execute and text-content
results, `registerCommand` with description/handler and string arguments, and
`sendUserMessage(text)` without options inside a command handler. These map to
the same native API: `label` becomes `ToolSpec.label`, `onUpdate` partial text
results call `api.progress` and the last one is returned as `last_update`, the
command description is shown in the `/` popup, and `sendUserMessage` becomes the
command's `submit` result. The virtual `typebox` import provides String, Number,
Integer, Boolean, Literal, Array, Union, Optional, and Object schema constructors.

`omd-mod pi-discover USER_PI_AGENT_DIRECTORY PROJECT_ROOT` discovers Markdown
skills/prompts in the user directory and project `.pi` directory without
executing anything. Skills follow Pi v0.74 traversal: a directory containing
`SKILL.md` is a skill root, root-level `.md` files are skills, subdirectories are
searched (skipping dot entries and `node_modules`), and `.gitignore`, `.ignore`
and `.fdignore` rules apply with Pi's path prefixing. YAML frontmatter supplies
skill `name`/`description` (skills without a description are omitted with a
diagnostic) and prompt `description`/`argument-hint`; prompts without a
description use their first non-empty line. Results include paths, hashes and
diagnostics. Symlinked files and directories are rejected, and native discovery
omits protected secret/store resources with a visible diagnostic.
`pi.discover` exposes the same operation to mods with `pi_resources`, after the
host sets `mod_pi_user` to the approved user directory.

`pi.expand {name, args}` and the TUI expand a discovered prompt with Pi's
argument rules (`$1`…, `$@`, `$ARGUMENTS`, `${@:N}`, `${@:N:L}`, quote-aware
argument splitting and JavaScript replacement semantics). Discovered prompts
appear in the `/` popup as `/pi:<name>` (plus a bare alias under the same rules
as mod commands); invoking one submits the expanded prompt.

Compatibility gaps: no Pi agent-loop/TUI emulation, runtime package imports,
provider registry/auth implementation, abort signals, custom renderers
(`renderCall`/`renderResult`), `registerShortcut`, UI context (`ctx.ui`),
session/context mutation, `sendUserMessage` delivery options or images,
`getArgumentCompletions`, arbitrary TypeBox operators, symlinked resources,
explicit resource paths/package resources, or Pi skill name validation warnings.
Context APIs other than `hasUI:false` fail visibly. Ignore-file matching uses the
Rust `ignore` crate's gitignore semantics, which may differ from Pi's `ignore`
package in edge cases. The tests exercise the pinned interface subset against
Pi's own argument-expansion code; they do not claim execution of the complete Pi
distribution or its ecosystem.

## Validation

The kernel is informed by the current
[Claude Code Mods README](https://github.com/anthropics/claude-code/blob/main/mods/README.md)
and its [generated early-access declarations](https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts),
currently generated by Claude Code 2.1.277. Those are competitive references only,
not OMD acceptance evidence. This release deliberately excludes desktop, VS Code,
mobile, audio, arbitrary Node/DOM access, and unrestricted filesystem/network/process
authority.

From the reproduced upstream checkout:

```sh
OMD_TEST_NODE=/absolute/node/bin/node just test -p codex-omd -p codex-omd-extension
```

From this repository:

```sh
python3 -m benchmarks.controlled_fixture /absolute/codex /new/fixture --scenario success --mod-node /absolute/node/bin/node --mod-profile full
python3 -m benchmarks.controlled_fixture /absolute/codex /new/provider-fixture --scenario success --mod-node /absolute/node/bin/node --mod-profile provider
python3 -m benchmarks.controlled_fixture /absolute/codex /new/cancel-fixture --scenario success --mod-node /absolute/node/bin/node --mod-profile cancel
python3 -m benchmarks.controlled_fixture /absolute/codex /new/failure-fixture --scenario success --mod-node /absolute/node/bin/node --mod-profile failure
python3 -m benchmarks.controlled_fixture /absolute/codex /new/resume-fixture --scenario client-loss-resume --mod-node /absolute/node/bin/node --mod-profile provider
python3 -m benchmarks.controlled_fixture /absolute/codex /new/review-fixture --scenario completion --mod-node /absolute/node/bin/node --mod-profile policy
python3 -m benchmarks.controlled_fixture /absolute/codex /new/recovery-fixture --scenario escalation --mod-node /absolute/node/bin/node --mod-profile policy
python3 -m benchmarks.controlled_fixture /absolute/codex /new/opaque-fixture --scenario direct --mod-node /absolute/node/bin/node --mod-profile opaque
python3 -m benchmarks.controlled_fixture /absolute/codex /new/routing-fixture --scenario direct --lead-policy task_entry --mod-node /absolute/node/bin/node --mod-profile routing
python3 -m benchmarks.controlled_fixture /absolute/codex /new/lifecycle-fixture --scenario direct --mod-node /absolute/node/bin/node --mod-profile lifecycle
python3 -m benchmarks.controlled_fixture /absolute/codex /new/deny-fixture --scenario direct --mod-node /absolute/node/bin/node --mod-profile deny
python3 -m benchmarks.controlled_fixture /absolute/codex /new/preview-fixture --scenario success --lead-policy task_entry --mod-node /absolute/node/bin/node --mod-profile preview
python3 -m benchmarks.controlled_fixture /absolute/codex /new/preview-denied --scenario direct --lead-policy task_entry --mod-node /absolute/node/bin/node --mod-profile preview-denied
python3 -m benchmarks.controlled_fixture /absolute/codex /new/preview-broken --scenario success --lead-policy task_entry --mod-node /absolute/node/bin/node --mod-profile preview-broken
python3 -m benchmarks.controlled_fixture /absolute/codex /new/exercise-fixture --scenario success --lead-policy task_entry --mod-node /absolute/node/bin/node --mod-profile exercise
python3 -m benchmarks.mod_terminal_fixture /absolute/codex /absolute/node/bin/node
python3 -m benchmarks.controlled_fixture /absolute/codex /new/off-fixture --scenario omd-off --mod-node /absolute/node/bin/node
```

Fixtures use local synthetic providers. They establish native wiring and bounded
behavior, not paid-provider compatibility, independent author feedback, physical
terminal acceptance, comparative cost/quality, or release readiness.
