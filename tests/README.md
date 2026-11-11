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

## Write a useful test

Add a test when it catches behavior that existing tests miss. For a bug fix, reproduce the failure before changing
the code, then run the same test after the fix. The assertion should fail if you revert the fix. A docs edit,
formatting change or straightforward refactor does not need a new test when existing coverage already checks the
behavior.

Choose the cheapest layer that owns the behavior:

| Behavior | Test and location |
| --- | --- |
| A mod's command, event handler or returned view | A colocated `*.test.mjs` using `tests/mod_runner.mjs`, or a `mod.test.json` scenario. See [`continue.test.mjs`](../mods/first-party/omd_continue/continue.test.mjs) for callback inputs and result assertions. |
| Node author tooling or a client | `*.test.mjs` beside the code or in `tests/`, using `node:test` and `node:assert/strict`. See [`mod_test_suite.test.mjs`](mod_test_suite.test.mjs). |
| Python build, release or install behavior | `tests/test_NAME.py`, using `unittest`. Use temporary files and repositories for filesystem and Git behavior; see [`test_build_scratch.py`](test_build_scratch.py). |
| Native host behavior, permission enforcement or callback lifetime | Rust tests in the scratch Codex tree, then `build.py sync`. Follow the [runtime workflow](../docs/contributing/runtime.md#check-your-change). |
| Packaging or behavior through the real mod host | A `mod.test.json` scenario, installer test or the relevant acceptance harness. Use binaries from the branch when it changes the host. |
| Wrapping, clipping, focus, keyboard delivery or colors | A real terminal session with a reproducible viewport and state; follow the [UI style guide](../docs/STYLEGUIDE.md#verify-what-the-user-sees). |

Name the test for the input and observable result, such as “an interrupted turn resumes with a single-line
summary.” Set up only what that case needs. Use literal expected values derived from the requirement, not the
production function being tested. Assert the returned value, saved file or delivered action rather than private
state or a count of internal calls. Check host-call arguments when the host operation itself is the contract.

Avoid tests that copy a manifest, pin incidental wording or versions, check source-code strings, or retest a library.
Don't add one test at every layer for the same rule. Keep a snapshot only when its complete output is useful to
review, and inspect its diff rather than accepting it automatically.

Use fixtures shaped like real inputs. Mock a host operation or external service at its boundary; don't put the
behavior under test into the mock. Exercise errors, cancellation or cleanup when the change affects them. Use
scenario virtual time or controlled events instead of sleeps, live networks or wall-clock timing assertions. Keep
credentials and personal data out of fixtures.

### Register and run it

Repository Node tests use `*.test.mjs`, `*.test.cjs`, `*.test.js` or the corresponding `*.spec.*` names under
`mods/`, `tests/` or `plugins/`. The repository suite does not run `*.test.ts`; those belong to the external mod
author workflow described in [Test a mod](../docs/mod-authors/test-a-mod.md). Python discovery expects
`tests/test_NAME.py`. Only opt out of default discovery through `tests/suites.json`, with a concrete reason and a
command to run the test manually.

Run your new or changed test directly, then the related tests that share the behavior. Confirm discovery with
`mise exec -- node scripts/mod_test_suite.mjs --list`. `mise run check:changed` runs changed Node and Python test
files, excluding optional tests; it does not find related tests through dependencies or run scenarios and Cargo
tests. A change to a shared fixture, subprocess script or host API can affect tests whose own files did not change.

### Use the right binaries

If the change depends on native code, point tests at matching `omd-runner` and `omd-mod` binaries. Automatic discovery
may choose an installed release or a newer scratch build from another branch. Set `OMD_TEST_RUNNER` and
`OMD_MOD_BIN` explicitly when that would change the result. `mise run dev:mods NAME` builds both without the
terminal app. The [runtime guide](../docs/contributing/runtime.md#build-and-test-with-cargo) shows how to select
those binaries for tests.

Report what the test proves. Mocked scenarios exercise callback logic, not real host permissions, persistence or
terminal rendering. Host-free tests can run without a Mac; runner and sandbox behavior requires supported macOS.
For checks you cannot run, state the missing environment and leave the result unverified.

## See also

- [Contributing](../CONTRIBUTING.md#check-your-change)
- [How CI checks a change](../docs/contributing/ci.md)
