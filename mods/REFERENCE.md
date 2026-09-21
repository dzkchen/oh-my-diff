# Mod API reference

This reference is version-matched to `@oh-my-diff/mod-api` and host API
`0.1.0-experimental.6` on OMD `0.1.0` and Codex `0.154.0`. The package's
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

## Offline scenarios

A `mod.test.json` file uses schema 1. `virtual_time_ms` fixes `Date.now()` and
zero-argument `new Date()` inside every callback. `host_operations` supplies an
ordered result/error queue for each approved host operation. Any unmocked call
fails before external work, and every result records `paid_requests: 0`.

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

Dependencies run before consumers and remaining mods use lexical ID order.
Project scope shadows user scope without inheriting its state or grants.
Observers compose in that order; exclusive replacements, contract IDs, service
providers, and namespaced tools fail closed when contested. Native permissions,
credentials, accounting, cancellation, evidence, workflow enforcement, and
provider authorization remain outside the mod API.
