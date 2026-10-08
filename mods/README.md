# TypeScript mods

The current pinned Codex `0.161.0` OMD host exposes API
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
author checks do not make paid requests. `pnpm watch -- /absolute/mod-store`
re-inspects an edited local source, retains the exact declared capability set,
and queues a safe-boundary reload. The author package ships the executable
live-replacement examples with `omd-mod-author examples DIR`. Small
demonstrations remain repository-only conformance fixtures.
[EXTENSION_TYPES.md](EXTENSION_TYPES.md) records the checked classification and
rationale for every package.

For a local host, initialize the external store with `omd-mod init STORE NODE`,
then inspect, trust, enable, and reload a package through `omd-mod`. Run the
patched `codex` with `OMD_MODE=omd` and `OMD_MOD_STORE=STORE`. The OMD+ profile
installer in [LEAN_PROFILES.md](../LEAN_PROFILES.md) stages candidate packages
inactive except eight default packages (`omd_inspector`, `omd_logo`,
`omd_model_picker`, `omd_mods`, `omd_plan_removal`, `omd_tool_lines`, `omd_update` and
`omd_workspace`). Its `omd_workflow` package
implements task controls through mod-owned schema-2 contracts selected
separately with `/omd_workflow:contract ID@VERSION` or `omd-package contract select ID@VERSION`.

Packages deferred from the launch collection are not in this tree. They can be
restored from the `pre-launch-collection` Git tag and return in post-launch waves
([LEAN_PROFILES.md](../LEAN_PROFILES.md)).

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
python3 scripts/mod_conformance.py
python3 scripts/check_native_ownership.py
```

These establish native wiring and bounded local behavior, not paid-provider
compatibility, independent author feedback, physical terminal acceptance, or
release readiness.

Shared interfaces and their independent author fixtures are documented in [REFERENCE.md](REFERENCE.md#composition-and-safety). Feature behavior belongs in extension source; the host owns permission, accounting, provenance and transaction checks.
