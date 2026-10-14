# TypeScript mods

The current pinned Codex `0.162.1` OMD host exposes API
`0.2.0-experimental.5` on Apple Silicon macOS and Node `24.18.0`. Mods are
editable, hash-approved TypeScript packages; Node 24.18 or a later 24.x also works. The API remains experimental;
local author and host fixtures do not complete independent preview feedback or
release qualification.

An Oh My Diff install puts `omd-mod-author`, `omd-mod`, `omd-contract` and `omd`
on `PATH` and ships the `@oh-my-diff/mod-api@0.2.0-experimental.5` SDK with it;
the SDK is not published to npm. See
[REFERENCE.md](REFERENCE.md#api-02-host-primitives) for current generic API
operations and command documentation. The current host accepts `OMD_MODE=omd`
or `OMD_MODE=upstream_direct`; it rejects `OMD_MODE=enabled`,
`OMD_MODE=platform`, and `OMD_CONTROLLED_MANIFEST`. Point the mod host at an
external store with `OMD_MOD_STORE=/absolute/external/mod-store`. Trusting and
enabling a package does not grant a provider, select a workflow contract, or
authorize spending.
The quickest local flow is:

```sh
omd-mod-author create ./my_mod my_mod
cd my_mod
pnpm check
pnpm test
pnpm run run
pnpm debug
pnpm run package
```

`create` links the installed SDK as a local file dependency and writes the
lockfile offline. `pnpm check` validates syntax and, once TypeScript is added
(`pnpm add -D typescript@5.9.3`), types against the exact SDK.
`pnpm test` is owned by the OMD engine and refuses unmocked host operations, so
author checks do not make paid requests. `pnpm test` also runs any
`*.test.ts` or `*.test.mjs` file beside `mod.test.json` with `node --test`;
`@oh-my-diff/mod-api/testing` supplies scenario, mock, view-query and
interaction helpers for them, and the assertions are `node:assert`.
`pnpm watch -- /absolute/scratch-store` re-inspects an edited local source,
approves its digest in that store, queues a reload for the next turn boundary
(or `/omd` reload) and copies the store's declarations, including
`tool-types.d.ts` when that store's session has listed its tools, into `.omd/`.
Use a scratch store for it: code an agent wrote is never trusted automatically, and the
user approves it in a real store with `/omd` or `omd-mod trust`. `watch DIR
STORE --once` reloads once and exits, and `pnpm test` is the offline CI check.
See [Typed tool declarations, TypeScript tests and Watch and
reload](REFERENCE.md#typed-tool-declarations). The author package ships the executable
live-replacement examples with `omd-mod-author examples DIR`. Small
demonstrations remain repository-only conformance fixtures.
[EXTENSION_TYPES.md](EXTENSION_TYPES.md) records the checked classification and
rationale for every package.

## Installing a published mod

The curated index lists published mods by ID, each pinned to a Git commit and
to the package hash `omd-mod inspect` reports. One command installs one, from a
shell or inside a session:

```sh
omd mods catalog                 # browse the curated index
omd install token_weather        # resolve, review the grants, approve
omd mods enable token_weather    # installs start off
```

In a session, `/mods install token_weather` opens the same review; approve it,
then turn the mod on from its `/mods` row. A Git reference installs without the
index: `omd install 'git+https://github.com/author/repo#COMMIT:path/to/mod'`.
Either way the host locks the revision to its commit and refuses a package
whose hash differs from the index (`package_integrity_failure`) or whose `api`
it does not support (`incompatible_api`). The Claude Code ports in
[`ports/`](ports) (`burn_meter`, `token_weather` and `blast_radius`) are
published this way, written against this public API only.

## Testing a mod

`pnpm test` runs the mod in the real host offline: the `omd-mod` engine loads
and admits the package, runs each callback in the sandboxed runner, validates
the views it returns and serves virtual time, while every other host call
answers from your mocks. A test file beside `mod.test.json`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { find, invoke, mount, runScenario, state } from '@oh-my-diff/mod-api/testing';

test('count persists and draws', () => {
  const trace = runScenario('.', { steps: [
    state('my_mod', { value: 41 }),
    invoke('my_mod', 'tool', 'count', {}, { expect: { count: 42 } }),
    state('my_mod', { expect: 42 }),
    mount('my_mod'),
  ] });
  assert.ok(find(trace.steps[3].value, 'counter'));
});
```

Mock host calls with typed reply records, for example
`hostOperations({ 'store.get': [{ arguments: { key: 'theme' }, result: null }] })`.
Unexpected calls, mismatched arguments and unused replies fail the scenario.
Mark a reply `optional: true` only when its call is deliberately optional.
Normal replies validate operation shapes and shared pure request rules;
state, authority and external effects still need real-host boundary tests.
Use `unsafeHostOperations` with `unsafe: { result: true }` for a deliberately
malformed result, or `unsafeStep` for a malformed scenario step.

`state` seeds and then reads the mod's `api.state`; `invoke` runs a tool,
command or any other event; `mount` returns the terminal view after the host
has validated it; `calls` lists the host calls the mod made; `component` steps
a component module with key and pointer events at the scenario's virtual time
and returns its `{tree, post, next_ms}`. Steps also cover
interceptor chains, key, pointer and component interaction, clients, reloads
and virtual time; see [Offline scenarios](REFERENCE.md#offline-scenarios).

The terminal fixture copies the bounded selection and reports backend delivery;
the OS tools fixture's `/locale` with no argument restores the inherited locale.
Examples using the new controls declare their required host feature labels;
see [compatibility](COMPATIBILITY.md) when adopting those operations.

For a local host, initialize the external store with `omd-mod init STORE NODE`,
then inspect, trust, enable, and reload a package through `omd-mod`. Run the
patched `codex` with `OMD_MODE=omd` and `OMD_MOD_STORE=STORE`. The OMD+ profile
installer (`INSTALL.md` in the repository) stages first-party packages
inactive except nine default packages (`omd_inspector`, `omd_logo`,
`omd_model_picker`, `omd_mods`, `omd_plan_panel`, `omd_plan_removal`,
`omd_statusline`, `omd_tool_lines` and `omd_update`). Its `omd_workflow` package
implements task controls through mod-owned schema-2 contracts selected
separately with `/omd_workflow:contract ID@VERSION` or `omd-package contract select ID@VERSION`.

Packages outside the launch collection are not in this tree.

## Validation

From the reproduced upstream checkout:

```sh
OMD_TEST_NODE=/absolute/node/bin/node just test -p codex-omd -p codex-omd-extension
```

From this repository:

```sh
mise run mods:check
mise run mods:test
mise run mods:host-check   # needs an omd-mod built from the applied runtime patch on PATH or --omd-mod
python3 -m scripts.mod_conformance
python3 scripts/check_native_ownership.py
```

These establish native wiring and bounded local behavior, not paid-provider
compatibility, independent author feedback, physical terminal acceptance, or
release readiness.

Shared interfaces and their independent author fixtures are documented in [REFERENCE.md](REFERENCE.md#composition-and-safety). Feature behavior belongs in extension source; the host owns permission, accounting, provenance and transaction checks.
