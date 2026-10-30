# Host model

Use it when you need the rules every host operation and callback follows: one host per process, callback
admission, budgets and contexts, composition order, registration limits, the fault limit and the runner
environment. For when to write a mod instead of a skill, hook or plugin, see
[How OMD works](https://github.com/dzkchen/oh-my-diff/blob/main/docs/how-omd-works.md).
Every limit on this page is also in [Limits](limits.md).

## What mods can't replace or bypass

A mod runs inside the host, asks for only the permissions it needs, and composes with other mods by the
[composition rules](#composition-order). A mod can never replace or bypass:

- Workflow-contract enforcement, permissions, spending grants, cancellation, provider credentials, workspace
  integrity, evidence and final acceptance.
- History beyond the documented rewrite points, reasoning or call/output pairs, the compaction engine, or prompts for
  provider-side compaction.
- Raw terminal escapes, arbitrary widgets or DOM/canvas access, approval key bindings, the transcript, or clipboard
  authorization.
- Arbitrary providers, runtime imports other than adapter-declared aliases, or a second scheduler.
- Other mods: `requires` declares presence and order only; mods never call each other or share state.

## Host lifetime and callback authority

Which host owns the process, how runtimes differ, and when a callback's completion is accepted.

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

### Independent examples

Independent examples live in [`examples/virtual_reader`](../examples/virtual_reader),
[`examples/scoped_data`](../examples/scoped_data), [`examples/review_probe`](../examples/review_probe), and
[`examples/workspace`](../examples/workspace). They demonstrate shared interfaces, not production
implementations.

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

## Callback budgets and the clock

The host answers each host call, including `next` and `time.sleep`, inside the running callback, so a callback runs
once and makes at most 512 host calls. Offline runners without an interactive host replay the callback once per
host call instead.

`Date.now()` and `new Date()` return the callback's start time, advanced only by each `time.sleep`'s `slept_ms`,
including in a state-conflict retry.

- `hook_budget_ms` bounds the callback's own JavaScript time.
- A separate 5 s total bounds the callback's JavaScript time plus its waits on terminal operations that need no
  user answer. Exceeding it fails the callback with `callback_execution_budget`.
- Confirmations and prompts may wait longer, and other host operations keep their own timeouts.

## Callback lifetime

- General callbacks get a fresh VM context and activation.
- A package's later callbacks may reuse its sandboxed runner process and a bounded
  bytecode cache; runners are never shared between packages.
- Work a callback leaves running settles before its result is returned, and a host call from it after the callback
  returned fails that callback.
- Persist state through `api.state`; module globals do not survive general callbacks.
- Render hooks retain activation under their existing matching-input rules.

## Callback contexts

`terminal` renders and `render` hooks get no host operations; draw from `api.state`.

Slash commands, buttons and keybindings run in the terminal as user actions and reach only:

- `exec.*`
- `workspace.read/list/stat/check_access/transaction/backup/restore`
- `store.*`
- the terminal operations (`app.request`, `credentials.*`, `terminal.*`, `composer.*`, `builtins.invoke`,
  `packages.*`, `routes.add`, `routes.write`, `contract.select`, `sessions.ports`, `settings.write`)
- `app.routes`
- `turns.activity`
- `events.publish`

A service call works only while its provider needs no other host operation.

Component input callbacks run there too but not as user actions, so `terminal.selection`, `terminal.copy`,
`terminal.panel`, `credentials.request`, `terminal.import_file`, `builtins.invoke`, `commands.invoke`, `config.set`,
`packages.apply`, `routes.add`, `routes.write`, `contract.select` and `settings.write` are refused.

Anything else (`task.*`, `contract.*`, other `routes.*`, `evidence.*`, `workspace.snapshot/fingerprint`, `process.*`,
`agents.*`) goes through `events.publish` to the mod's own `channel` handler, which runs with the session.

## Runtime waits and hook skips

The mod runtime is single-threaded and never runs re-entrantly. Request and stream hooks wait up to 2 s while
another request or stream hook holds the runtime.

When a non-hook callback holds it, such as a tool waiting for the agent it spawned, a mod-spawned agent's request
and every response stream proceed at once without hooks; other requests wait up to 2 s first.

- Each skip is recorded as `intercept_skipped` with the surface and reason (`mod_callback_in_flight` or
  `mod_runtime_busy`).
- A skipped or unsubscribed stream runs without stream hooks for the rest of that response.
- The middleware log records only selections, transformations and fallbacks, and stops growing at 8 MiB.
- These skips apply to `api.middleware` hooks. Interceptors hold the runtime only while a handler starts or
  settles, never while `next` waits, and follow the required/optional waits of [continuation
  middleware](interceptors.md#continuation-middleware-continuation_middleware_v1-tool_continuation_v2).

## Service dispatch (`service_dispatch_v1`)

`service_dispatch_v1` keeps a service provider's own capability grants, source identity, storage namespace and
host-operation provenance when a consumer calls it.

- A nested call shares the initiating callback's cancellation, 512-call and 5 s execution budgets.
- Recursive providers and chains beyond eight callback frames fail closed.
- Standalone invocations without a provider-aware host dispatcher refuse that provider's host operation.
- Offline `host_calls` records the actual mod caller for every mocked operation.

## Composition order

Dependencies run before consumers and remaining mods use lexical ID order. Managed scope shadows project scope,
which shadows user scope, without inheriting its state or grants. Observers compose in that order; interceptors
follow the [interceptor order](interceptors.md#interceptor-order).

Exclusive replacements, contract IDs, service providers, and namespaced tools fail closed when contested. Native
permissions, credentials, accounting, cancellation, evidence, workflow enforcement, and provider authorization
remain outside the mod API.

## Registration limits

The host enforces these; `scripts/mod_host_check.py` (`mise run mods:host-check`) loads every first-party package
and example through the real host and reports any it refuses.

- At most 32 tools and 32 commands per mod.
- Commands are invoked as `/<id>:<name>`; the bare `/<name>` works only when no built-in command or other mod uses
  that name.
- Mod ids use `a-z`, `0-9` and `_` up to 24 bytes and never equal the host `origin.caller` labels `model`,
  `engine`, `code_mode` or `user`.
- Command and tool names use up to 32 bytes of `a-z`, `0-9` and `_`.

## Fault limit

Five consecutive failed callbacks (commands, tools, hooks and render hooks all count) in one host process turn a mod
off; any successful callback resets the count. These failures don't count: errors starting `state_conflict`,
`state_thread_unavailable`, `state_checkout_unavailable`, `callback_cancelled`, `host_receipt_limit`,
`host_result_limit`, `host_call_limit` or `callback_execution_budget`, and failures of `service` and `component`
events. The count lives in the process and is not persisted, so each `omd-mod command` starts at 0 and
`omd-mod status` shows `faults: 0` afterwards. The TUI says once in the transcript when a mod is turned off, and
`/omd` and `omd mods list` show why. A mod turned off in a running host comes back with `/omd` > Reload mods.

## Runner environment

Each runner process gives mod code the globals below and has the memory limits after them. The manifest
`environment` field that admits `crypto` is described in [Settings](settings.md#manifest-environment).

### Text encoding and `crypto`

Every context has the standard `TextEncoder`. Host limits count UTF-8 bytes:

- `new TextEncoder().encode(text).length` measures a string.
- `text.slice(0, encoder.encodeInto(text, new Uint8Array(limit)).read)` cuts it to `limit` bytes without splitting
  a character.
- `encode` feeds `crypto.subtle`.

The `crypto` environment provides `getRandomValues`, `randomUUID` and the `crypto.subtle` methods.

- `crypto.subtle` implements the Web Cryptography API's standard algorithms: SHA-1/256/384/512, HMAC, AES-GCM,
  AES-CBC, AES-CTR, AES-KW, PBKDF2, HKDF, ECDSA and ECDH (P-256, P-384, P-521), Ed25519, X25519,
  RSASSA-PKCS1-v1_5, RSA-PSS and RSA-OAEP, with `raw`, `spki`, `pkcs8` and `jwk` keys as each algorithm allows.
- Limits: AES-GCM takes a 96-bit `iv` and a 128-bit tag; AES-KW keys are 128 or 256 bits; ECDSA signs P-256 with
  SHA-256, P-384 with SHA-384 and P-521 with SHA-256, SHA-384 or SHA-512; RSA keys are 2048–8192 bits with exponent
  65537, and RSA-PSS `saltLength` equals the hash length. Anything else fails with `NotSupportedError`. Generated
  HMAC keys and derived bits are at most 8,388,608 bits (1 MiB) and PBKDF2 `iterations` at most 4,294,967,295;
  larger values fail with `OperationError`.
- Their results are copied into the mod's context.
- A `CryptoKey` is a frozen handle with `type`, `extractable`, `algorithm` and `usages`.
- Failures are plain `Error`s whose `name` is the Web Crypto error name.

There is no `TextDecoder`, `Buffer` or `structuredClone`, and no code is compiled from strings (`eval`, `new
Function`), in the mod's context or the runner process. The runner has no event loop, so `Atomics.waitAsync` is absent:
wait with `Atomics.wait` or the `time.sleep` operation.

A runner loads ICU data on its first `Intl` or `localeCompare` use, about 5 ms; compare ASCII ids and versions with
plain string and digit comparisons on hot paths.

### Runner memory limits

Each runner process has a 64 MiB V8 old-space limit, and the host kills a runner whose physical memory
(ArrayBuffers and other off-heap data included) passes 512 MiB. Either fails the callback with `mod_out_of_memory`.
