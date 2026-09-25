# Mod API reference

This reference is version-matched to `@oh-my-diff/mod-api` and host API
`0.1.0-experimental.8` on OMD `0.1.0` and Codex `0.156.1`. The package's
[`api.d.ts`](api.d.ts) is the complete typed surface. A store also generates
`active-host.d.ts` and `installed-contracts.d.ts`; those files identify the
running host and the exact service contracts available to consumers.

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
scaffold emits both with placeholders to change. Package rollback repoints the
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
Before each sampling step, the event receives the host checkpoint, thread ID,
and only the current mod's optional tool names. It returns `{enable: [...]}`
for a subset of those names. A missing or failed decision exposes none of that
mod's optional tools; an invalid or foreign name disables the mod with a visible
error. Ordinary registered tools and every native tool keep their existing
exposure. The checkpoint is capped at 16 KiB; a larger record appears as `null`
and selects no checkpoint-dependent tools. A tool still executes through native
permission, cancellation, accounting, and workflow gates. Context contributors
can attach a bounded subordinate fragment for the same task without replacing
base instructions. In an offline scenario, `{"type":"tool_exposure", "payload":
{...checkpoint...}}` records the exact names registered for that step.

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
the Python server choice and language protocol; it is installed inactive with
Full OMD and can also be installed explicitly in a platform-only store. It
never installs a language server. Absent or unsupported servers report fallback.
`api.host.tryCall` returns `{ok:true,value}` or `{ok:false,error}` for an
expected unavailable operation, so a mod can report fallback without treating
server absence as a callback failure. Both `call` and `tryCall` remain subject
to the same declared capability and host permission checks.

`process.start` accepts `transport: "stdio"` by default. Its DAP transports
are `"stdio_dap"` for `lldb-dap` or `python3 -m debugpy.adapter`, and
`"unix_dap"` for `dlv dap`. The host creates Delve's private Unix socket,
frames DAP messages, and allows local loopback binding required by debug
adapters while keeping external network access restricted. It owns process
group termination and socket removal. It starts adapters with a cleared host
environment and an owner-only scratch directory. The opt-in debugger package
in `plugins/optional/omd-debugger` exposes **Python launch only**; LLDB,
Delve, and attach remain unqualified transport experiments. Its mod requires
separate review, trust, and enablement. Plugin installation does not activate
the mod or install Python or debugpy. The local on-demand marketplace is not
part of either release installation profile.

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

The mod runtime is single-threaded and never runs re-entrantly. A request a mod
causes from inside its own in-flight callback — a spawned agent, or a native
contribution — is sent on the route already authorized for it, without that
runtime's request, stream or thread-configuration hooks. Requests a mod did not
cause from inside a callback still run every registered hook.

`hook_budget_ms` bounds each JavaScript evaluation, not their sum. A callback
that makes host calls is replayed once per call, so the host re-runs the module
and that replay cost is the host's, not the mod's. The callback as a whole,
including every replay, is bounded by a separate 5 s host total; exceeding
either bound fails the callback with `callback_execution_budget`.

Dependencies run before consumers and remaining mods use lexical ID order.
Project scope shadows user scope without inheriting its state or grants.
Observers compose in that order; exclusive replacements, contract IDs, service
providers, and namespaced tools fail closed when contested. Native permissions,
credentials, accounting, cancellation, evidence, workflow enforcement, and
provider authorization remain outside the mod API.
