# Overview

When to write a mod instead of a skill, hook or plugin, what a mod can never replace, and the rules every host call
follows.

## Mods, plugins and hooks

| Use | For |
| --- | --- |
| A skill | A procedure the model follows |
| A hook | A reaction to a lifecycle event |
| A plugin | Tools or services |
| A mod | Only to change how `codex` itself behaves or looks |

### Codex plugins and hooks

Codex 0.164.0 plugins bundle skills, prompts, MCP servers and hook files. Its hooks are external commands or MCP tools
that return a decision: block a call, add context, or rewrite a tool's input. The hooks are `pre_model_request`,
`post_model_request`, `pre_tool_use`, `permission_request`, `post_tool_use`, `pre_compact`, `post_compact`,
`session_start`, `session_end`, `user_prompt_submit`, `subagent_start`, `subagent_stop`, `stop` and `interrupt`.

A hook can't hold state, stream, draw on screen, route a model or run an agent. When two `pre_tool_use` hooks rewrite
the same call, the last one to finish wins.

A mod runs inside the host, asks for only the permissions it needs, and composes with other mods by the
[composition rules](safety.md#composition-and-safety).

### What mods can't replace or bypass

- Workflow-contract enforcement, permissions, spending grants, cancellation, provider credentials, workspace
  integrity, evidence and final acceptance.
- History beyond the documented rewrite points, reasoning or call/output pairs, the compaction engine, or prompts for
  provider-side compaction.
- Raw terminal escapes, arbitrary widgets or DOM/canvas access, approval key bindings, the transcript, or clipboard
  authorization.
- Arbitrary providers, runtime imports other than adapter-declared aliases, or a second scheduler.
- Other mods: `requires` declares presence and order only; mods never call each other or share state.

## Host lifetime and callback authority

### One host per process

One native host owns the process-wide session dispatcher and client bridge at a time. A second live installation is
rejected. Stopping the owner releases its registrations; teardown from an older registration cannot remove a newer
one.

### Runtimes

Main, input and persistence runtimes may have different idle snapshots, local generation numbers, telemetry and
callback failure state.

- Numeric generations are local to a runtime, not a cross-runtime authority token.
- Each callback uses its executing runtime's selected source and grants.
- Persistence refreshes its own runtime and uses that runtime's required-interceptor decision, including failure
  fallback. Required persistence failure withholds text; dropping persistence work cancels the callback.

### Callback admission and completion

Callback admission and completion validate current source and authority. Cancellation, disablement, revocation,
source replacement or a changed executing generation rejects completion before callback state or results are
accepted.

**Effects already performed by a host call are not rolled back.** Authors must not rely on a disabled or replaced
callback committing state after its host call finishes. Failed-reload transactional restoration is a separate
contract; retaining an older runtime does not authorize stale callbacks.

### Failure categories

Raster producers distinguish retryable, revoked and fatal failures by explicit categories, independently of
diagnostic wording. Thread-store destination conflicts use the native `AlreadyExists` category.

## Host primitives

The host is feature-agnostic: every operation, event and capability in this reference is available to any trusted mod
on equal terms, and none of them names a product feature. The [`release_check` example](../examples/release_check) is
an independent author package that uses only this surface.

Each primitive advertises a host feature a package can require (API `1.0.0`). With no mod registered
for a primitive the host allocates nothing for it and changes no decision.

### `OMD_MODE`

| Value | Runs |
| --- | --- |
| `OMD_MODE=omd` | The mod host in the default session |
| `OMD_MODE=upstream_direct` (or no `OMD_MODE`) | Pinned upstream behavior without mods |

Any other `OMD_MODE` value is rejected.

### Host call transport budget

Host call arguments and results share a 1 MiB transport budget per callback.

- A result that would exceed the remaining budget becomes a `host_result_limit` error the mod can catch; the
  operation has still run.
- Primitive limits in this reference keep single results inside that budget; page or use artifacts for larger data.
