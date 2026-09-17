# Experimental TypeScript mod host

This is the first working API slice, `0.1.0-experimental.1`, for the pinned
Codex 0.154.0 OMD runtime on Apple Silicon macOS and Node 24.18.0. It implements
bounded context contributions, pure custom tools, CLI commands, lifecycle
observation, settings, and persistent mod state. **The broad Phase 10 mod-system
checkbox is incomplete.** This is not the private-preview deliverable or a stable
API freeze. The coverage table below lists the remaining implementation.

## Run and edit a mod

Build the patched runtime using the repository's normalized upstream and patch
procedure, then build the manager in that upstream checkout:

```sh
cargo +1.95.0 build --locked -p codex-cli --bin codex -p codex-omd --bin omd-mod
```

Use that build's `omd-mod` executable for the commands below. Node is selected
explicitly; it is never downloaded or provisioned by mod activation. pnpm remains
the package manager and the Node installation may be managed by mise.

```sh
omd-mod init /absolute/external/mod-store /absolute/node-24.18.0/bin/node
omd-mod inspect /absolute/oh-my-diff/mods/examples/counter
```

Read the source and manifest. Copy the displayed SHA256 into the explicit trust
operation, then enable the mod:

```sh
omd-mod trust /absolute/external/mod-store /absolute/oh-my-diff/mods/examples/counter SHA256 tools,commands,state
omd-mod enable /absolute/external/mod-store /absolute/oh-my-diff/mods/examples/counter
omd-mod status /absolute/external/mod-store
```

Add `"mods": "/absolute/external/mod-store"` to your existing enabled OMD
controlled manifest. Keep the trust/state store outside the repository. The
manifest, task permissions, workflow contract, and spending authorization remain
host configuration. There is no model-callable trust or permission-grant tool.

The example registers the deferred native tool `mod_counter_count`. Discover it
with normal tool search. Each invocation increments a durable counter. Run its
command from a separate terminal:

```sh
omd-mod command /absolute/external/mod-store counter reset null
```

Commands currently use this CLI surface; slash-command registration is unsupported.
A concurrently running session detects conflicting state writes and requires a
reload rather than overwriting the other writer.

Edit `examples/counter/index.ts`, inspect it again, trust the new digest, and enable it.
Trusting an update preserves settings but leaves it disabled until explicitly
enabled. The running host applies changes at the next native turn start. It
retains the admitted source bytes throughout the current turn; editing disk does
not replace an in-flight callback. An explicit reload also recovers a failed mod:

```sh
omd-mod reload /absolute/external/mod-store
omd-mod disable /absolute/external/mod-store /absolute/oh-my-diff/mods/examples/counter
```

Disabling preserves source, settings, and state. It applies at the next turn
boundary. Exit or native interruption remains available while a callback runs.
No process survives the callback; the host kills and reaps timed-out/cancelled
callbacks. The original native direct mode remains the recovery path if initial
mod activation fails. OMD-off mode never starts the loader.

## Package and API contract

A package is a canonical directory containing `mod.json` and one self-contained
`index.ts` with a default activation function. See [types](api.d.ts) and
[context example](examples/context/index.ts). Runtime imports, Node APIs, timers,
networking, arbitrary file access, native modules, and package lifecycle scripts
are not exposed. Type-only imports are erased. This loader accepts the erasable
TypeScript subset supported by the pinned Node runtime.

`mod.json` requires schema 1, an ID of up to 24 lower-case ASCII letters, digits,
or underscores, an exact package version label, the exact API version,
`state_version: 1`, and explicit capabilities. The admitted SHA256 covers the
manifest bytes, a NUL delimiter, and the entry source bytes. Runtime dependencies
are unsupported, so there are no unhashed transitive executable files.

Activation only registers callbacks. It must not write state. It runs afresh for
every invocation; module globals are ephemeral. Use `api.state.get/set` for
persistent JSON and `api.settings` for configured JSON settings. The host owns
state writes, atomic replacement, and compare-before-write conflict detection.
State schema mismatch fails visibly and preserves the prior file; migrations
across state versions are **not implemented**. Never put secrets in mod settings
or state. Native credentials are not passed into the callback process.

The external store's ordered selections are explicit user choices. Duplicate
mod IDs and colliding fully qualified tool names fail before activation. Mod
callbacks execute in lexicographic mod-ID order. Each mod may register one
handler per lifecycle event, 16 tools, and 16 commands. Context is additive;
built-in context and instruction authority cannot be replaced in this slice.
Automatic user/project discovery and precedence are not implemented. Both local
and shared directories work through exact explicit selection; registry/archive
installation and updates are separate unfinished package-lifecycle work.

Reload stages and validates the desired enabled set before replacing it. Invalid
new code retains previously admitted eligible code; explicit removals/disables
are honored even when another package's activation fails. Runtime callback
errors disable the failing mod until reload and leave healthy mods usable. A
stale tool registration is rejected by generation, with a retry-on-next-turn
message. Errors and source locations are bounded; native evidence includes
`mod-status.json` with versions, hashes, registrations, and failures. Context
errors also appear in the model-visible diagnostic context.

Each callback gets a new Node process inside a deny-by-default macOS Seatbelt
policy, an empty inherited environment, a VM context with no ambient Node API,
a 64 MiB V8 old-space limit, a 3-second host deadline, and a 1-second synchronous
VM evaluation limit. The heap flag is not a hard total-process RSS limit.
Input is capped at 512 KiB, source and response at 64 KiB, and a context
contribution at 1 KiB, with a native aggregate context budget and visible overflow notice. Up to 16 mods may be enabled. No model/provider request or
workspace effect can be dispatched from this API, so these callbacks cannot
create unaccounted agent work. Native tools retain normal accounting/lifecycle
observation. Successful callback state writes are durable before their result
is returned; as with native tools, a crash between those events may leave an
unknown outcome and must not be described as rolled back.

## Coverage

| Decision or operation | This version | Timing / ownership |
| --- | --- | --- |
| Context, prompt additions | Alter additively | Native context assembly, bounded, subordinate to instructions |
| Checkpoint/session state | Observe checkpoint and thread/turn IDs | Context callback; native state cannot be mutated |
| Lifecycle | Observe start/resume/idle/stop and tool outcome metadata | Native lead thread only; callback process discarded afterward |
| Pure custom tools | Register | Native deferred tool registry; namespaced; no direct I/O |
| Commands | Register CLI handlers | `omd-mod command`; no slash bindings |
| Settings and mod state | Read settings, persist JSON state | Host validates/commits; explicit reload after conflicts |
| Configured model/provider/reasoning selection | Unsupported | Requires a native route-selection capability with admission/accounting binding |
| Provider adapters, sidecars, opaque secrets | Unsupported | Requires generic native admission and managed-resource API |
| Roles, spawn/message/cancel/result | Unsupported | Requires native agent operation handles and shared allowance enforcement |
| Delegation, coordination, scheduling, review/recovery replacement | Unsupported | Existing reviewed behavior retained; workflow-contract implementation is a separate prerequisite for weakening/replacement |
| Context replacement, compaction, checkpoint mutation | Unsupported | Requires explicit native decisions and integrity contracts |
| Tool interception / calling other host tools | Unsupported | No hidden host transport or tool re-entry |
| Themes, panels, widgets, layouts, input, keybindings, rendering | Unsupported | Base native terminal retained; public UI seams remain to implement |
| Pi discovery and tool/command adapter | Unsupported | No Pi compatibility claim in this API slice |
| State migrations and stable compatibility window | Unsupported | Exact experimental API/state only; preview feedback precedes stable freeze |

Unknown capabilities/events/imports fail activation. `api.unsupported(name)`
provides an explicit unsupported-operation error; it never returns a fabricated
success. First-party and outside mods have identical authority.

## Validation

```sh
pnpm --dir mods install --frozen-lockfile
pnpm --dir mods check
pnpm --dir mods test
```

From the reproduced upstream `codex-rs` checkout, with Node 24.18.0 and permission
to start a Seatbelt sandbox:

```sh
OMD_TEST_NODE=/absolute/node/bin/node just test -p codex-omd -p codex-omd-extension
```

The native integration fixture is:

```sh
python3 -m benchmarks.controlled_fixture /absolute/patched/codex /new/external/fixture --scenario direct --mod-node /absolute/node/bin/node
```

Repeat with `--scenario omd-off` to check that a configured mod never activates
in upstream-style direct mode. These are synthetic local checks; they do not
establish provider compatibility, comparative quality/cost, full API coverage,
independent author feedback, or release readiness.
