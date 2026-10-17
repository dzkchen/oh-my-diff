# Test suites

`mise run mods:test` (`pnpm --dir mods test`; `--list` prints the inventory without running):

- Runs every Git-tracked or nonignored `*.test.{mjs,cjs,js}` and `*.spec.*` under `mods/`, `tests/` and `plugins/`.
  New colocated tests join automatically; deleted ones leave immediately.
- Other extensions or locations fail discovery. Optional/manual tests need an exact path and nonempty reason under
  `optional` in `tests/suites.json` (reported as not executed; stale entries fail). Current entries: the live Claude
  CLI check and a copied example's intentional-failure scenario.
- Also assigns, but doesn't run: `tests/test_*.py` → Python unittest; `runtime/{omd,native}/src/**/*_tests.rs` or
  `tests.rs` and `runtime/{omd,native}/tests/*` → Cargo; `mods/{examples,first-party}/<package>/mod.test.json` →
  mod-host scenarios. Recognized test filenames outside these fail discovery (including nested Python tests).
- It is a filename inventory, not proof a Rust module is enabled or a test executes.

The nightly runs the other suites: `python3 -m unittest discover -s tests`, Cargo in the patched scratch tree, and
`scripts/mod_host_check.py --scenarios`.

`mise run mods:check` type-checks:

- `mods/tsconfig.json`: mod declarations, example, first-party, port and bundled-plugin TypeScript (including TSX).
- `mods/tsconfig.author.json`: every public `mods/author/*.mjs` with `checkJs`, Node types and declaration-linked
  JSDoc on the client, testing and JSX exports (`noImplicitAny: false` for internal parameters).
- `node scripts/mod_typecheck_inventory.mjs --list` prints each shipped source and its check; newly uncovered source
  fails. Browser examples, first-party hooks/sidecars and the Bun execution kernel are syntax-only entries checked
  with Node. Test files belong to the suites above.
