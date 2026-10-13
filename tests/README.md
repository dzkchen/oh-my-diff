# Test suites

`mise run mods:test` discovers Git-tracked and nonignored untracked `*.test.mjs`,
`*.test.cjs`, `*.test.js` (and `*.spec.*`) files recursively under `mods/`,
`tests/`, and `plugins/`. New colocated tests join the gate automatically.
Tracked files deleted from the working tree leave the inventory immediately.
`pnpm --dir mods test --list` prints the inventory without executing tests.

Test files using other extensions or locations fail discovery. A genuinely
optional or manual test must have its exact path and a nonempty reason
in `tests/suites.json` under `optional`. Such tests are reported as not executed;
stale entries fail discovery. There are currently no exceptions.

The inventory also assigns direct `tests/test_*.py` files to Python unittest,
`runtime/{omd,native}/src/**/*_tests.rs` or `tests.rs` and direct integration tests under
`runtime/{omd,native}/tests/` to Cargo, and `mod.test.json` files directly inside
`mods/{examples,first-party}/<package>/` to mod-host scenarios. Recognized test
filenames outside those suites fail discovery, including nested Python test
files that the current unittest invocation might not discover.

The nightly separately runs Python through `python3 -m unittest discover -s tests`,
Rust through Cargo in the patched scratch tree, and scenarios through
`scripts/mod_host_check.py --scenarios`. `mods:test` reports those suites as not
executed by this command. This is a filename inventory, not a check that a Rust
module is enabled or an inline test executes; listing a file does not establish
executed coverage.
