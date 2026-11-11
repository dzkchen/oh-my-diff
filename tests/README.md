# Tests

`mise run mods:test` discovers and runs the Node tests. Python tests, Rust tests and mod-host scenarios use separate
runners, listed below. Choose checks for your change from
[CONTRIBUTING.md](../CONTRIBUTING.md#check-your-change). For CI jobs, see
[How CI checks a change](../docs/contributing/ci.md).

## Run the mod tests

```sh
mise run mods:test
```

This runs `pnpm --dir mods test`. To print the test inventory without running it:

```sh
node scripts/mod_test_suite.mjs --list
```

The suite:

- Runs every Git-tracked or untracked-but-not-ignored `*.test.{mjs,cjs,js}` and `*.spec.*` file under `mods/`,
  `tests/` and `plugins/`. New tests join automatically.
- Discovery fails if a test file is in another location or has another extension. A test that shouldn't run by default
  needs its exact path and a reason under `optional` in `tests/suites.json`. It's reported as not executed.
- Runs mods through `tests/mod_runner.mjs`, which selects `omd-runner` in this order:
  1. The path in `OMD_TEST_RUNNER`.
  2. The runner beside `omd-mod`, found through `OMD_MOD_BIN` or `PATH`.
  3. The newest runner in a scratch tree's `artifacts/`, `target/release/` or `target/debug/` under `OMD_WORK_ROOT`
     (default `/private/tmp`).

`mods:test` passes the selected runner to every test file. If `OMD_MOD_BIN` is unset, it also passes the
`omd-mod` beside that runner.

The suite assigns these files to other runners without running them:

| Files | Runner |
| --- | --- |
| `tests/test_*.py` | Python `unittest` |
| Rust test files under `runtime/omd` and `runtime/native` | Cargo, in the patched scratch tree |
| `mods/{examples,first-party}/<package>/mod.test.json` | Mod-host scenarios |

The nightly runs those three; see [How CI checks a change](../docs/contributing/ci.md).

## Run one test

Run a mod, SDK or plugin test file with Node, a Python test module with `unittest`, and a Rust test through
`build.py cargo` in a scratch tree:

```sh
mise exec -- node --test PATH
python3 -m unittest tests.test_NAME
python3 .github/scripts/build.py cargo NAME LOG test --locked -p CRATE FILTER
```

[Change the patched Codex code](../docs/contributing/runtime.md#build-and-test-with-cargo) explains `NAME`, `LOG` and
the scratch tree.

Run one package's `mod.test.json` scenario through the real host:

```sh
python3 scripts/mod_host_check.py --no-commands --scenarios NAME
```

`NAME` is the package's directory name or mod id. It uses the `omd-mod` on your `PATH`; pass `--omd-mod PATH` for one
built from the applied runtime patch.

## Type-check the mods

```sh
mise run mods:check
```

It type-checks with TypeScript 7 (`typescript7`): `mods/tsconfig.json` covers the declarations, examples,
first-party mods, ports and bundled plugins, and `mods/tsconfig.author.json` covers the public `mods/author/*.mjs`
files. Then it checks that every shipped source is covered, checks the operation schema and runs
`python3 scripts/mod_host_check.py --static`.

To print each source and how it's checked:

```sh
node scripts/mod_typecheck_inventory.mjs --list
```

Hooks, sidecars, browser examples and the Bun execution kernel are syntax-checked only.

## See also

- [Contributing](../CONTRIBUTING.md#check-your-change)
- [How CI checks a change](../docs/contributing/ci.md)
