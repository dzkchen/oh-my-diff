# Host model

Use it when you need the rules every host operation and callback follows: one host per process, callback
admission, budgets and contexts, composition order, registration limits, the fault limit and the runner
environment. For when to write a mod instead of a skill, hook or plugin, see
[How OMD works](https://github.com/dzkchen/oh-my-diff/blob/main/docs/how-omd-works.md).
Every limit on this page is also in [Limits](limits.md).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](stability-and-migration.md#experimental-entries-in-the-registry)). Runs on Apple Silicon macOS.

## `OMD_MODE`

The `OMD_MODE` environment variable sets whether `codex` starts the mod host.

| Value | Runs |
| --- | --- |
| `OMD_MODE=omd` | The mod host in the default session |
| `OMD_MODE=upstream_direct` (or no `OMD_MODE`) | Pinned upstream behavior without mods |

Any other `OMD_MODE` value is rejected.

## What mods can't replace or bypass

A mod runs inside the host, asks for only the capabilities it needs, and composes with other mods by the
[composition rules](#composition-order). A mod can never replace or bypass:

| Area | Reserved to the host |
| --- | --- |
| Authority and acceptance | Workflow-contract enforcement, permissions, spending grants, accounting, cancellation, provider credentials, provider authorization, workspace integrity, evidence and final acceptance |
| History | History beyond the documented rewrite points, reasoning or call/output pairs, the compaction engine, and prompts for provider-side compaction |
| Terminal | Raw terminal escapes, arbitrary widgets or DOM/canvas access, approval key bindings, the transcript and clipboard authorization |
| Runtime | Arbitrary providers, runtime imports other than adapter-declared aliases, and a second scheduler |
| Other mods | `requires` declares presence and order only; mods never call each other or share state |

## Host lifetime and callback authority

Which host runs in a process, how its runtimes differ, when a callback's completion is accepted and which failures
report a category.

### One host per process

One native host runs the process-wide session dispatcher and client bridge at a time. A second live installation is
rejected. Stopping that host releases its registrations, and teardown from an older registration cannot remove a
newer one.

### Runtimes

The host runs mod code in a main, an input and a persistence runtime. The input runtime runs `input` and `mention`
interceptors and `workspace_pre_rename` handlers, the persistence runtime runs `history_persist` interceptors, and the
main runtime runs other callbacks. Each runtime may have its own idle snapshot, generation numbers, telemetry and
callback failure state.

- Generation numbers are local to each runtime. Don't use one as an authority token in another runtime.
- Each callback uses the selected source and grants of the runtime that runs it.
- The persistence runtime refreshes itself and applies its own required-interceptor decision, including the failure
  fallback. When required persistence work fails, the host withholds the text. When the host drops persistence work,
  it cancels the callback.

### Callback admission and completion

The host checks the mod's current source and authority when it admits a callback and again when the callback
completes. It rejects the completion, and accepts none of the callback's state or results, when the callback was
cancelled, the mod was disabled or revoked, its source was replaced or the executing generation changed.

**Effects already performed by a host call are not rolled back.** Don't rely on a disabled or replaced callback
committing state after its host call finishes. Restoring the previous mods after a failed reload follows separate
rules. A runtime the host keeps from before a reload doesn't authorize stale callbacks.

### Failure categories

Some failures report a category you can branch on instead of parsing the message. Raster producers report a failure
as retryable, revoked or fatal, whatever the diagnostic wording. A thread-store destination conflict reports the
native `AlreadyExists` category.

## Host primitives

The host is feature-agnostic: every operation, event and capability in this reference is available to any trusted mod
on equal terms, and none of them names a product feature. The [`release_check` example](../examples/release_check) is
an independent author package that uses only this surface. Other independent examples are
[`virtual_reader`](../examples/virtual_reader), [`scoped_data`](../examples/scoped_data),
[`review_probe`](../examples/review_probe) and [`workspace`](../examples/workspace). They show the shared interfaces
and aren't production implementations.

Each primitive (an operation, event or capability) advertises a [host feature](glossary.md#mods-and-the-host) that a
package can list in `required_features` (Mod API `1.0.0`). With no mod registered for a primitive the host allocates
nothing for it and changes no decision.

## Callback budgets and the clock

The host answers each host call, including `next` and `time.sleep`, inside the running callback, so the callback runs
once. A callback makes at most 512 host calls. Offline runners without an interactive host instead replay the
callback once per host call.

`Date.now()` and `new Date()` return the callback's start time. Only `time.sleep` advances it, by its `slept_ms`. This
also applies in a state-conflict retry.

- `hook_budget_ms` bounds the callback's own JavaScript time.
- A separate 5 s total bounds the callback's JavaScript time plus its waits on
  [user-action operations](#callback-contexts) that need no user answer. Exceeding it fails the callback with
  `callback_execution_budget`.
- Confirmations and prompts may wait longer, and other host operations keep their own timeouts.

### Host call transport budget

Host call arguments and results share a 1 MiB transport budget per callback.

- A result that would exceed the remaining budget becomes a `host_result_limit` error the mod can catch. The
  operation has still run.
- Each operation's own limits keep a single result inside that budget. For larger data, read it in pages or use an
  output artifact.

## Callback lifetime

What a callback keeps from earlier runs, and when its work ends.

- Every callback except a render hook gets a fresh VM context and activation. Render hooks keep their activation
  while the package revision, settings and persisted state stay unchanged
  ([Render callback runtime](render-hooks.md#render-callback-runtime)).
- A package's later callbacks may reuse its sandboxed runner process and a bounded bytecode cache. Runners are never
  shared between packages.
- Before the host returns a callback's result, it waits for work the callback left running to settle. If that work
  makes a host call after the callback returned, the callback fails.
- Persist state through `api.state`. Module globals don't survive from one callback to the next.

## Callback contexts

The context a callback runs in sets which host operations it can call. `terminal` renders and `render` hooks get no host
operations, so draw from `api.state`.

Slash commands, buttons and keybindings run in the terminal as user actions. Reference pages call these callbacks
user contexts. A user context can call only:

- `exec.*`
- `workspace.read/list/stat/check_access/transaction/backup/restore`
- `store.*`
- the user-action operations (`app.request`, `credentials.*`, `terminal.*`, `composer.*`, `builtins.invoke`,
  `packages.*`, `routes.add`, `routes.write`, `contract.select`, `sessions.ports`, `settings.write`)
- `app.routes`
- `turns.activity`
- `events.publish`

A service call from a user context works only when its provider needs no other host operation.

Component input callbacks also run in the terminal, but not as user actions. They can't call `terminal.selection`,
`terminal.copy`, `terminal.panel`, `credentials.request`, `terminal.import_file`, `builtins.invoke`,
`commands.invoke`, `config.set`, `packages.apply`, `routes.add`, `routes.write`, `contract.select` or
`settings.write`.

To run any other operation (`task.*`, `contract.*`, other `routes.*`, `evidence.*`,
`workspace.snapshot/fingerprint`, `process.*`, `agents.*`), publish an event with `events.publish` and do the work in
the mod's own `channel` handler, which runs with the session.

## Runtime waits and hook skips

These waits and skips apply to `api.middleware` hooks. The mod runtime is single-threaded and never runs
re-entrantly. While one request or stream hook is using the runtime, another waits up to 2 s.

A non-hook callback can also occupy the runtime, for example a tool waiting for the agent it spawned. A mod-spawned
agent's request and every response stream then go ahead at once without hooks. Other requests wait up to 2 s first.

- Each skip is recorded as `intercept_skipped` with the surface and reason (`mod_callback_in_flight` or
  `mod_runtime_busy`).
- A skipped or unsubscribed stream runs without stream hooks for the rest of that response.
- The middleware log records only selections, transformations and fallbacks, and stops growing at 8 MiB.
- Interceptors occupy the runtime only while a handler starts or settles, never while `next` waits. They follow the
  [required and optional interceptor waits](interceptors.md#handler-failures-and-skipped-interceptors).

## Service dispatch (`service_dispatch_v1`)

A service is a set of handlers one mod registers with `api.provide` and another calls with `api.services.call`. When
a consumer calls a provider, the provider runs with its own capability grants, source identity, storage namespace and
host-operation provenance.

- A nested call shares the initiating callback's cancellation, 512-call and 5 s execution budgets.
- Recursive providers and chains beyond eight callback frames fail closed.
- Standalone invocations without a provider-aware host dispatcher refuse that provider's host operation.
- Offline `host_calls` records the actual mod caller for every mocked operation.

## Composition order

Dependencies run before consumers, and remaining mods use lexical id order. Managed scope shadows project scope, which
shadows user scope. A selection doesn't inherit state or grants from the selection it shadows. Observers compose in
that order. Interceptors follow the [interceptor order](interceptors.md#interceptor-order).

Exclusive replacements, contract ids, service providers and namespaced tools fail closed when contested. Native
permissions, credentials, accounting, cancellation, evidence, workflow enforcement and provider authorization stay
outside the Mod API.

## Registration limits

The host refuses a registration past these limits. `mise run mods:host-check` (`scripts/mod_host_check.py`) loads
every first-party package and example through the real host and reports any it refuses.

- At most 32 tools and 32 commands per mod.
- Commands are invoked as `/<id>:<name>`; the bare `/<name>` works only when no built-in command or other mod uses
  that name.
- Mod ids use `a-z`, `0-9` and `_` up to 24 bytes and never equal the host `origin.caller` labels `model`,
  `engine`, `code_mode` or `user`.
- Command and tool names use up to 32 bytes of `a-z`, `0-9` and `_`.

## Fault limit

Five consecutive failed callbacks in one host process turn a mod off. Commands, tools, hooks and render hooks all
count, and any successful callback resets the count.

These failures don't count:

- errors starting `state_conflict`, `state_thread_unavailable`, `state_checkout_unavailable`, `callback_cancelled`,
  `host_receipt_limit`, `host_result_limit`, `host_call_limit` or `callback_execution_budget`;
- failures of `service` and `component` events.

The count is kept in process memory and is not persisted, so each `omd-mod command` starts at 0 and `omd-mod status`
shows `faults: 0` afterwards.

When a mod is turned off, the TUI says so once in the transcript, and `/omd` and `omd mods list` show why. A mod
turned off in a running host comes back with `/omd` > Reload mods.

## Runner environment

Each runner process gives mod code the globals below and has the memory limits after them. The manifest
`environment` field that allows `crypto` is described in [Settings](settings.md#manifest-environment).

### Text encoding and `crypto`

Every context has the standard `TextEncoder`. Host limits count UTF-8 bytes:

- `new TextEncoder().encode(text).length` measures a string.
- `text.slice(0, encoder.encodeInto(text, new Uint8Array(limit)).read)` cuts it to `limit` bytes without splitting
  a character.
- Pass the bytes from `encode` to `crypto.subtle`.

The `crypto` environment provides `getRandomValues`, `randomUUID` and the `crypto.subtle` methods.

- `crypto.subtle` implements the Web Cryptography API's standard algorithms: SHA-1/256/384/512, HMAC, AES-GCM,
  AES-CBC, AES-CTR, AES-KW, PBKDF2, HKDF, ECDSA and ECDH (P-256, P-384, P-521), Ed25519, X25519,
  RSASSA-PKCS1-v1_5, RSA-PSS and RSA-OAEP, with `raw`, `spki`, `pkcs8` and `jwk` keys as each algorithm allows.
- These inputs are supported. Anything else fails with `NotSupportedError`.
  - AES-GCM takes a 96-bit `iv` and a 128-bit tag.
  - AES-KW keys are 128 or 256 bits.
  - ECDSA signs P-256 with SHA-256, P-384 with SHA-384 and P-521 with SHA-256, SHA-384 or SHA-512.
  - RSA keys are 2048–8192 bits with exponent 65537.
  - RSA-PSS `saltLength` equals the hash length.
- Generated HMAC keys and derived bits are at most 8,388,608 bits (1 MiB), and PBKDF2 `iterations` are at most
  4,294,967,295. Larger values fail with `OperationError`.
- `crypto.subtle` results are copied into the mod's context.
- A `CryptoKey` is a frozen handle with `type`, `extractable`, `algorithm` and `usages`.
- Failures are plain `Error`s whose `name` is the Web Crypto error name.

There is no `TextDecoder`, `Buffer` or `structuredClone`, and no code is compiled from strings (`eval`, `new
Function`), in the mod's context or the runner process. The runner has no event loop, so `Atomics.waitAsync` is
absent. Wait with `Atomics.wait` or the `time.sleep` operation.

A runner loads ICU data on its first `Intl` or `localeCompare` use, which takes about 5 ms. On hot paths, compare ASCII
ids and versions with plain string and digit comparisons.

### Runner memory limits

Each runner process has a 64 MiB V8 old-space limit, and the host kills a runner whose physical memory
(ArrayBuffers and other off-heap data included) passes 512 MiB. Either fails the callback with `mod_out_of_memory`.
