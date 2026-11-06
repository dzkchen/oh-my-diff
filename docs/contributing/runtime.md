# Change the patched Codex code

How to change the Rust code in `runtime/`: set up a scratch tree, fetch V8, build and test with cargo, check the
change and write it back. For what `runtime/` contains, see [runtime/README.md](../../runtime/README.md).

## Before you start

- The setup in [CONTRIBUTING.md](../../CONTRIBUTING.md#set-up): an Apple Silicon Mac with mise, pnpm and Python 3.12 or later.
- [rustup](https://rustup.rs). The scratch tree's `rust-toolchain.toml` installs the pinned Rust (`rust_toolchain` in
  `upstream.lock.json`) on first use.
- 15–20 GB of disk for each build target. A first test build takes a few minutes.

## Never edit the patch by hand

OMD is one patch on upstream Codex. These files are generated, so never edit them directly:

- `runtime/patches/omd-0.166.0.patch` and `runtime/patches/manifest.json`
- `runtime/omd` and `runtime/native`, copies of the `codex-rs/omd` and `codex-rs/ext/omd` crates the patch adds
- `runtime/native/src/request_observer.rs`, a copy of the patched `codex-rs/codex-api/src/request_observer.rs`
- `runtime/crate-notices.txt`

Edit Rust in a scratch tree, a copy of upstream Codex at the pinned version with the patch applied, then write the
change back with `build.py sync`.

## Set up a scratch tree

`NAME` is a label made of letters, numbers, hyphens or underscores, starting with a letter or number:

```sh
python3 .github/scripts/build.py setup NAME
```

`setup` prints the patch result and then the tree's path, `/private/tmp/omd-bNAME/codex`. Running it again on an
existing tree only prints the path.

Reuse the same name for repeated edits: Cargo keeps that tree's incremental output. `setup` does not refresh an
existing tree after you switch branches, change the upstream pin or pull a new patch. Finish and `sync` your native
edits first, then use a new name for different sources. Keep each tree and target exclusive to one active build.

- The build target is `/private/tmp/omd-bNAME/target`. Set `OMD_WORK_ROOT` to use another directory instead of
  `/private/tmp`.
- The tree's `mods/` is a link to your checkout, so edits to mods there are ordinary edits.
- The tree's `normalized<version>` tag is the pinned upstream source without the patch. On Codex `0.166.0` it is
  `normalized1660`. List it with `git -C TREE tag -l 'normalized*'` and compare a path with
  `git -C TREE diff normalized1660 -- codex-rs/PATH`.

The [runtime README](../../runtime/README.md#crates) lists the crates the patch adds. Rust tests are beside the code
in `*_tests.rs` files.

## Fetch the V8 prebuilt

`omd-runner` and `codex-cli` link a V8 prebuilt. Fetch it once:

```sh
python3 .github/scripts/build.py v8 NAME
```

It downloads the prebuilt that matches the tree's `Cargo.lock`, checks it against the pinned checksum and reuses a
cached file that matches. It does nothing when `V8_FROM_SOURCE` or `RUSTY_V8_ARCHIVE` is set.

## Build and test with cargo

After `setup`, check one crate without compiling tests or build the runnable debug app:

```sh
mise run dev:check NAME codex-tui
mise run dev:build NAME
```

`dev:check` takes one or more Cargo package names and does not compile tests. `dev:build` requires V8 and builds
`codex`, `omd-runner` and `codex-code-mode-host` together in `/private/tmp/omd-bNAME/target/debug`.
Both tasks print the log path, a summary and the exit status. Logs are `logs/dev-check.log` and
`logs/dev-build.log` under the scratch tree and are overwritten on each run.

For other Cargo commands, use `build.py cargo`. It sets the same target and environment. For `test` and `nextest`
it first builds `omd-runner` and links it beside the test binaries, where hosts look for it. `LOG` is a log file
path: the full output goes there and a summary goes to the terminal.

```sh
python3 .github/scripts/build.py cargo NAME LOG test --locked -p CRATE FILTER
```

Build `codex`, `omd-mod` and `omd-runner` together, because a host started from the target looks for `omd-runner`
beside itself. `mise run mods:test` then finds them without `OMD_TEST_RUNNER` or `OMD_MOD_BIN`:

```sh
python3 .github/scripts/build.py cargo NAME LOG build --locked -p codex-cli -p codex-omd-extension -p codex-omd-runner --bins
```

Incremental compilation is the default for repeated edits in one tree. To try sccache across targets, use
`OMD_SCCACHE=1` and a common `SCCACHE_DIR`:

```sh
OMD_SCCACHE=1 SCCACHE_DIR="$HOME/.cache/omd-sccache" mise run dev:check NAME codex-tui
mise exec -- sccache --show-stats
```

With sccache, `build.py` defaults `CARGO_INCREMENTAL` to `0` and rejects explicit incremental compilation or
conflicting compiler wrappers. Leave these settings to `build.py` rather than overriding them through Cargo config.
Cross-tree cache hits depend on source paths, compiler versions, flags and features; measure hits and elapsed time
for your crate set before adopting it. To return to the default, unset `OMD_SCCACHE` and any explicit `RUSTC_WRAPPER`.

## Build storage

```sh
mise run dev:storage
mise run dev:clean NAME OTHER_NAME
```

`dev:storage` lists target paths and disk usage in MiB. Stop builds and tests before running `dev:clean`, which
deletes only the named targets and refuses symlinked trees or targets. Sources, logs, artifacts and download
caches are preserved; the next build starts with an empty target.

## Check your change

Start narrow, then broaden according to the change. Mods, plugins, SDK, docs and Python-only changes do not need
a Rust build; use the checks in [CONTRIBUTING.md](../../CONTRIBUTING.md#check-your-change). For Rust, run these
commands from the repository root; the wrapper runs Cargo in your scratch tree:

1. `mise run dev:check NAME CRATE`, then the regression test for your fix.
2. The crate's tests:

   ```sh
   python3 .github/scripts/build.py cargo NAME LOG nextest run --locked -p CRATE
   ```

3. Before integration, Clippy and Rustfmt for the touched crates. The `omd` crates use the workspace lints
   (`[lints] workspace = true`), so unwrap and expect are denied outside tests:

   ```sh
   python3 .github/scripts/build.py cargo NAME LOG clippy --locked -p CRATE --tests
   python3 .github/scripts/build.py cargo NAME LOG fmt -p CRATE -- --check
   ```

4. For cross-crate changes or before integration, the compile check a pull request runs, `cargo check --tests`
   of the crates it compiles. Its log is
   `/private/tmp/omd-bNAME/logs/check.log`:

   ```sh
   python3 .github/scripts/build.py check NAME
   ```

5. The native ownership check, which fails if native code names a feature or a first-party mod. Run it from the
   repository root:

   ```sh
   mise run native:ownership
   ```

Use broader tests for changes to shared host contracts, dependency features, the upstream pin or build tooling.
The full native suite runs nightly; it is not part of every edit/build cycle.

## Write the change back

```sh
python3 .github/scripts/build.py sync NAME
```

`sync` regenerates the patch, the manifest, the `runtime/omd` and `runtime/native` copies and
`runtime/crate-notices.txt` (with `scripts/crate_notices.py TREE`). Then it replays the patch on a fresh copy of the
pinned source and compares every file. It must print `"tree_parity": true`.

Before you commit, confirm the result replays: `setup` and `sync` on a fresh `NAME` must leave `git diff` unchanged.
The pull request's native check runs the same replay and fails on any difference, including stale crate notices.

`runtime/release.lock.json` is rebuilt from signed binaries at release time, so a native change leaves it as is.

## Apply the patch to your own Codex checkout

`build.py setup` is the recommended path. To apply the patch to your own exact pinned Codex checkout instead, run the
same two scripts that `setup` runs:

```sh
python3 scripts/normalize_upstream_lock.py /path/to/codex
python3 scripts/apply_runtime_patch.py /path/to/codex
```

`runtime/patches/manifest.json` records every file's hash before and after the patch. Applying twice does nothing,
and a file that matches neither hash is refused.

## Build on Linux

`docker/Dockerfile` gives a Debian environment with the pinned Rust, Node, Python and pnpm, for building and testing
without a Mac. OMD itself supports only Apple Silicon macOS, and the mod host runs mods only there. Build the image
from a clone, not a linked worktree: a worktree's `.git` file points outside the image, so Git-backed checks fail.

```sh
docker build -f docker/Dockerfile -t oh-my-diff .
docker run --rm -it -v omd-work:/home/omd/work oh-my-diff
```

Inside the container, run the `build.py` commands on this page. The work root is `/home/omd/work`, kept in the
`omd-work` volume. Rebuild the image after you change the checkout. The binaries build, and the Python,
`mods:check` and most `mods:test` checks pass there. Tests that start a mod runner or the authority broker fail by
design.

## build.py commands

| Command | Does |
| --- | --- |
| `setup NAME` | Creates the scratch tree at the pin, tags the normalized source as `normalized<version>` and applies the patch |
| `v8 NAME` | Downloads and verifies the V8 prebuilt |
| `cargo NAME LOG ARGS` | Runs cargo in the tree, full log to `LOG` |
| `cargo --skip-runner NAME LOG ARGS` | Skips runner preparation for host-independent tests |
| `dev-check NAME CRATE [CRATE...]` | Checks selected crates without test targets; `logs/dev-check.log` |
| `dev-build NAME` | Builds the debug app, runner and code-mode host; `logs/dev-build.log` |
| `storage` | Lists each scratch tree's target disk usage |
| `clean NAME [NAME...]` | Deletes only the selected targets; preserves sources and logs |
| `check NAME` | Runs `cargo check --tests` of the crates a pull request compiles |
| `sync NAME` | Writes the patch, manifest, copies and crate notices back and verifies the replay |
| `locks` | Regenerates the source locks |
| `artifacts NAME` | Builds, signs and packs the release binaries (used by CI) |

## See also

- [How CI checks a change](ci.md)
- [Cut a release](release.md), including how to set the crate versions for a release
