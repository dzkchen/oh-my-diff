# TypeScript mods

API `0.1.0-experimental.3` runs on the pinned Codex 0.154.0 OMD host,
Apple Silicon macOS, and Node 24.18.0. Mods are editable, hash-approved TypeScript
packages. The API remains experimental; this delivery does not freeze the API,
complete independent preview feedback, or introduce the separately planned solo
workflow contract.

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
OMD-off never loads mods. An invalid initial selection fails visibly; disabling
it or starting in native direct mode restores access.

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
packages with the same ID is an activation conflict, never a silent privilege
transfer. Immutable registry/repository fetching and dependency resolution belong
to the separately queued package-manager task.

## Write a mod

Use [api.d.ts](api.d.ts) and the examples:

| Example | Working capability |
| --- | --- |
| [counter](examples/counter/index.ts) | Labeled native tool with progress, slash commands with display/submit results, durable state |
| [routing](examples/routing/index.ts) | Select a host-approved model/provider/reasoning preset |
| [coordination](examples/coordination/index.ts) | Two native roles, parallel work, bounded waits, result consumption, `agent_end` |
| [recovery](examples/recovery/index.ts) | Checkpoint context, checkpoint inspection, compaction threshold and prompt |
| [interception](examples/interception/index.ts) | Replace a built-in tool with a registered mod tool |
| [terminal](examples/terminal/index.ts) | Left sidebar, header/footer, status segment, native theme, key actions, templates |
| [guard](examples/guard/index.ts) | Input rewrite/denial and turn lifecycle events |
| [context](examples/context/index.ts) | Bounded context contribution |

```sh
pnpm --dir mods install --frozen-lockfile
pnpm --dir mods check
pnpm --dir mods test
```

A manifest has schema 1, an ID of at most 24 lowercase ASCII letters/digits/
underscores, a package version label, the exact API version, a positive
`state_version`, and declared capabilities. Activation registers callbacks and
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

See [coverage and limits](COVERAGE.md) for every extension point. Unknown APIs,
capabilities, imports, events, adapters, and host operations fail explicitly.
First-party and external packages use identical capabilities.

`api.on` observes lifecycle or contributes context. `api.replace` exclusively
claims `routing`, `compaction`, `context`, `tool_before`, `terminal`, or `input`.
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
thread; a fixed host selection takes precedence. Agents select a preset on each
spawn. Each preset includes its provider, model, and reasoning setting. Compaction
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

Lifecycle events are lead-only observers: `start`, `resume`, `idle`, `stop`,
`tool_result`, `turn_start` (`turn_id`), `turn_end` (`outcome` completed,
aborted, or error), `compaction_start`/`compaction_end` (`trigger` manual or
auto), and `agent_end` for the owning mod's agent handles (`role`, `status`).
`agent_end` is delivered after the agent finishes and after any running callback
of that mod releases the runtime; it cannot run host operations.

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

The exclusive `terminal` owner returns a bounded view (see `TerminalView` in
[api.d.ts](api.d.ts)). Native input, modal controls, cancellation, transcript
storage and recovery remain native.

- Layout: up to eight text panels in a left or right sidebar (hidden below 80
  columns), an optional header panel above the transcript (hidden below 16 rows),
  and an optional footer panel above the composer. These require the fullscreen
  (alternate-screen) terminal.
- Status: up to four segments of 40 characters appended to the native status line.
- Theme: `accent`, `user_message_background`, and `success`/`attention`/`failure`
  status tones accept a 256-color index or `#rrggbb` (mapped to the terminal's
  color depth), and `syntax` selects an installed Codex syntax theme by name. An
  unknown syntax theme keeps the configured theme and shows a warning; removing it
  restores the configured theme.
- Keybindings: `F2`–`F12`, `Ctrl+<letter>` (except c, d, h, i, j, m, z) and
  `Alt+<letter>`. A string or `{insert}` inserts a draft, `{submit}` sends a user
  message, and `{command, args}` runs a mod command or Pi prompt by name. A key
  that is bound in the active native keymap or starts a native chord keeps its
  native action; the mod binding is ignored with a visible notice.
- Rendering: message/tool presentation templates (fullscreen) keep `{text}` exactly
  once.

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
can use the same mod in turn; a write racing another process's write during a
callback still fails instead of losing an update. To change its version,
register `api.on('migrate', ({from,to}) => ...)` and set the migrated value with
`api.state.set`. Trust the updated package while disabled, then run:

```sh
omd-mod migrate /absolute/external/mod-store /absolute/package
omd-mod enable /absolute/external/mod-store /absolute/package
```

Migration checks the exact approved source and capabilities, runs without native
task effects, retains a content-addressed backup, and atomically replaces the
state. Failed migration leaves prior state intact. Source/settings are retained.
Rollback requires an explicitly trusted package and reverse migration; arbitrary
state/session version interchange is not claimed.

Reload stages the entire enabled set. Broken new code retains eligible previous
code, while explicit removals and capability revocations still take effect.
Generation checks reject stale tools. An in-flight callback uses frozen source;
queued edits do not change it. Runtime failures disable the affected mod until
explicit reload. `mod-status.json` is a current native status snapshot, including
source hashes, registrations, and bounded source-located failures.

Each evaluation uses a fresh deny-by-default Seatbelt process, an empty inherited
environment, no ambient Node APIs, a 64 MiB V8 old-space limit, a 1-second
synchronous limit and 3-second process deadline. The heap setting is not a total
RSS limit. A callback has at most 32 host operations and 6 seconds of cumulative
JavaScript evaluation; native effects retain their own task deadlines. Input is
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
python3 -m benchmarks.mod_terminal_fixture /absolute/codex /absolute/node/bin/node
python3 -m benchmarks.controlled_fixture /absolute/codex /new/off-fixture --scenario omd-off --mod-node /absolute/node/bin/node
```

Fixtures use local synthetic providers. They establish native wiring and bounded
behavior, not paid-provider compatibility, independent author feedback, physical
terminal acceptance, comparative cost/quality, or release readiness.
