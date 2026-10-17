# Tests

`mise run mods:test` (`pnpm --dir mods test`; `node scripts/mod_test_suite.mjs --list` prints the inventory without running):

- Runs every Git-tracked or untracked-but-not-ignored `*.test.{mjs,cjs,js}` and `*.spec.*` file under `mods/`,
  `tests/` and `plugins/`. New tests join automatically.
- Fails discovery for test files in other locations or with other extensions. A test that should not run by default
  needs its exact path and a reason under `optional` in `suites.json`; it is reported as not executed.
- Assigns, but does not run: `tests/test_*.py` (Python unittest), Rust test files under `runtime/omd` and
  `runtime/native` (Cargo), and `mods/{examples,first-party}/<package>/mod.test.json` (mod-host scenarios).

The nightly runs the rest: `python3 -m unittest discover -s tests`, Cargo in the patched scratch tree and
`python3 scripts/mod_host_check.py --scenarios`.

`mise run mods:check` type-checks `mods/tsconfig.json` (declarations, examples, first-party mods, ports and bundled
plugins) and `mods/tsconfig.author.json` (the public `mods/author/*.mjs` files), then checks that every shipped
source is covered. `node scripts/mod_typecheck_inventory.mjs --list` prints each source and how it is checked;
hooks, sidecars, browser examples and the Bun execution kernel are syntax-checked only.
