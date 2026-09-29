# TypeScript mods

The current pinned Codex `0.157.0` OMD host exposes API
`0.2.0-experimental.3` on Apple Silicon macOS and Node `24.18.0`. Mods are
editable, hash-approved TypeScript packages. The API remains experimental;
local author and host fixtures do not complete independent preview feedback or
release qualification.

Install the exact `@oh-my-diff/mod-api@0.2.0-experimental.3` author package
with pnpm. It exports the typed SDK and `omd-mod-author` CLI. See
[REFERENCE.md](REFERENCE.md#api-02-host-primitives) for current generic API
operations and command documentation. The current host accepts `OMD_MODE=omd`
or `OMD_MODE=upstream_direct`; it rejects `OMD_MODE=enabled`,
`OMD_MODE=platform`, and `OMD_CONTROLLED_MANIFEST`. Point the mod host at an
external store with `OMD_MOD_STORE=/absolute/external/mod-store`. Trusting and
enabling a package does not grant a provider, select a workflow contract, or
authorize spending.
The quickest local flow is:

```sh
pnpm exec omd-mod-author create ./my_mod my_mod
cd my_mod
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm run run
pnpm debug
pnpm run package
```

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
patched `codex` with `OMD_MODE=omd` and `OMD_MOD_STORE=STORE`. The Full profile
installer in [LEAN_PROFILES.md](../LEAN_PROFILES.md) stages candidate packages
inactive except its three explicitly selected presentation packages. Its
`omd_workflow` package implements task controls through mod-owned schema-2
contracts selected separately by `omd-contract`.

## Pi extensions

Pi Markdown prompts and skills are handled by the
[`omd_project_pi_prompts`](first-party/omd_project_pi_prompts/README.md) mod,
not the host. It follows Pi v0.74 discovery, frontmatter and argument
expansion, reads an explicitly configured user directory through sandboxed
`exec.run`, and submits an expanded prompt through its `/pi` command.

Pi TypeScript extensions have no built-in shim; wrap one with an adapter package
named by the manifest `adapter` field. The prompts mod does not emulate Pi's
agent loop, TUI, provider registry, symlinked resources, explicit or package
resource paths, or skill-name validation warnings. Ignore-file matching uses the
Rust `ignore` crate's gitignore semantics, which may differ from Pi's `ignore`
package in edge cases. The tests exercise Pi's own argument-expansion code; they
do not claim execution of the complete Pi distribution or its ecosystem.

## Validation

From the reproduced upstream checkout:

```sh
OMD_TEST_NODE=/absolute/node/bin/node just test -p codex-omd -p codex-omd-extension
```

From this repository:

```sh
mise run mods:check
mise run mods:test
python3 scripts/mod_conformance.py
python3 scripts/check_native_ownership.py
```

These establish native wiring and bounded local behavior, not paid-provider
compatibility, independent author feedback, physical terminal acceptance, or
release readiness.

Shared interfaces and their independent author fixtures are documented in [REFERENCE.md](REFERENCE.md#composition-and-safety). Feature behavior belongs in extension source; the host owns permission, accounting, provenance and transaction checks.
