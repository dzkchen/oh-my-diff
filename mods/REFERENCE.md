# Mod API reference

This reference is version-matched to `@oh-my-diff/mod-api` and host API
`0.1.0-experimental.6` on OMD `0.1.0` and Codex `0.155.1`. The package's
[`api.d.ts`](api.d.ts) is the complete typed surface. A store also generates
`active-host.d.ts` and `installed-contracts.d.ts`; those files identify the
running host and the exact service contracts available to consumers.

## Author commands

| Command | Result |
| --- | --- |
| `omd-mod-author create DIR ID` | Minimal typed package with pnpm scripts and offline tests |
| `omd-mod-author examples DIR` | Routing, coordination, context, recovery, service, tool, and terminal examples |
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
| `omd-mod package-disable STORE ID` | Disable a managed package without deleting source, state, or cache |
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
a mounted key. A step can carry `expect`, `expect_error`, or `cancelled`.
Additional trusted packages are listed in `packages`, enabling provider/consumer
and conflict fixtures without shared globals or ambient authority.

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
