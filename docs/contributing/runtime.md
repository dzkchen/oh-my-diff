# Change the patched Codex code

Edit Rust in a scratch Codex tree, then use `build.py sync` to regenerate `runtime/`. Don't edit the patch or crate
copies by hand. For the directory contents, see [runtime/README.md](../../runtime/README.md).

## Before you start

- The setup in [CONTRIBUTING.md](../../CONTRIBUTING.md#set-up): an Apple Silicon Mac with mise, pnpm and Python 3.12 or later.
- [rustup](https://rustup.rs). The scratch tree's `rust-toolchain.toml` installs the pinned Rust (`rust_toolchain` in
  `upstream.lock.json`) on first use.
- 15–20 GB of disk for each build target. A first test build takes a few minutes.

## Never edit the patch by hand

OMD is one patch on upstream Codex. These files are generated, so never edit them directly:

- `runtime/patches/omd-0.167.2.patch` and `runtime/patches/manifest.json`
- `runtime/omd` and `runtime/native`, copies of the `codex-rs/omd` and `codex-rs/ext/omd` crates the patch adds
- `runtime/native/src/request_observer.rs`, a copy of the patched `codex-rs/codex-api/src/request_observer.rs`
- `runtime/crate-notices.txt`

Edit Rust in a scratch tree, a copy of upstream Codex at the pinned version with the patch applied, then write the
change back with `build.py sync`.

## Set up a scratch tree

`NAME` is a label made of letters, numbers, hyphens or underscores, starting with a letter or number:

```sh
mise run dev:setup NAME
```

`dev:setup` creates `/private/tmp/omd-bNAME/codex`, applies the patch and fetches its verified V8 prebuilt. Running
it again preserves the existing tree and reuses downloads whose checksums match. If you only need the source,
use `python3 .github/scripts/build.py setup NAME` to skip the V8 download.

Reuse the same name for repeated edits: Cargo keeps that tree's incremental output. `setup` does not refresh an
existing tree after you switch branches or pull a new patch. `mise run dev:refresh NAME` does: it replaces the
tree's patch with your checkout's in place, so the next build recompiles only the crates whose files changed. It
leaves a tree alone when the tree has native edits that are in no patch, so `sync` your edits first. After a change
to the upstream pin, use a new name. Keep each tree and target exclusive to one active build.

- The build target is `/private/tmp/omd-bNAME/target`. Set `OMD_WORK_ROOT` to use another directory instead of
  `/private/tmp`.
- The tree's `mods/` is a link to your checkout, so edits to mods there are ordinary edits.
- The tree's `normalized<version>` tag is the pinned upstream source without the patch. On Codex `0.167.2` it is
  `normalized1672`. List it with `git -C TREE tag -l 'normalized*'` and compare a path with
  `git -C TREE diff normalized1672 -- codex-rs/PATH`.

The [runtime README](../../runtime/README.md#crates) lists the crates the patch adds. Rust tests are beside the code
in `*_tests.rs` files.

## Fetch the V8 prebuilt

`omd-runner` and `codex-cli` link a V8 prebuilt. `dev:setup` fetches it; fetch it separately after a source-only
setup with:

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
`codex`, `omd-runner`, `codex-code-mode-host` and `omd-mod` together in `/private/tmp/omd-bNAME/target/debug`.
Both tasks print the log path, elapsed time, a summary and the exit status. Logs are `logs/dev-check.log` and
`logs/dev-build.log` under the scratch tree and are overwritten on each run. Cargo also writes an HTML timing
report to `target/cargo-timings/cargo-timing.html`; the log records its path. Compare repeated builds in the
same tree before changing compiler flags or cache settings.

## Run your checkout

To try a branch, a pull request or `main` in a real session, run it from your checkout. You don't need a release
or an installed OMD at that version:

```sh
mise run dev:run NAME
mise run dev:run NAME --enable omd_claude_cli -- --model gpt-6.1-terra
```

`dev:run` sets up the tree if it's missing, refreshes its patch as `dev:refresh` does, builds what changed and
starts that `codex` on the first-party mods in your checkout. Arguments after `--` go to `codex`. The first build
of a tree compiles everything; later runs take seconds unless Rust changed.

- The session uses its own mod store, `/private/tmp/omd-bNAME/store`, so your installed OMD and its mods are
  untouched. It shares your Codex sign-in, `CODEX_HOME` and state database.
- The store holds a copy of each first-party mod's shipped files in `sources/`, as an installation does. Every
  mod is trusted. The profile's default mods except `omd_update` start on; turn others on with `--enable ID` or in
  `/mods`. Your choices persist between runs, and a mod your checkout no longer has is removed from the store.
- Save a mod file and the session loads it at the next turn, without a restart. A `mod.json` error or a missing file
  keeps the last copy, with the reason in `/private/tmp/omd-bNAME/logs/dev-run-mods.log`; other load errors, such as
  a TypeScript error, show in the session.
- A native edit in the tree needs a restart: quit and run `dev:run` again.

To test someone's pull request, check it out in a separate worktree, so your own branch and uncommitted work stay
put, and run it there:

```sh
git worktree add ../omd-pr-NUMBER && cd ../omd-pr-NUMBER && gh pr checkout NUMBER
mise run dev:run NAME
```

`dev:run` runs the pull request's `build.py`, `mise.toml` and build scripts, and trusts every first-party mod with
every capability it declares, in a session that uses your Codex sign-in. Run only pull requests whose `scripts/`,
`.github/scripts/`, `mise.toml` and mods you have read. For one that changes the state database, set `CODEX_HOME` to
a separate folder with your `auth.json` linked in, so a migration doesn't reach your everyday Codex state.

For mod and SDK tests, build just the mod engine and runner:

```sh
mise run dev:mods NAME
OMD_TEST_RUNNER=/private/tmp/omd-bNAME/target/debug/omd-runner \
OMD_MOD_BIN=/private/tmp/omd-bNAME/target/debug/omd-mod mise run mods:test
```

`dev:mods` builds `omd-mod` and `omd-runner` together and writes `logs/dev-mods.log` and a timing report. It skips
the terminal app and code-mode host. The two environment variables select these binaries even if another version
is installed or another scratch tree was built more recently. Replace `/private/tmp` with `OMD_WORK_ROOT` if you
set it. To run the host integration check with this build, use
`python3 scripts/mod_host_check.py --omd-mod /private/tmp/omd-bNAME/target/debug/omd-mod`.

For other Cargo commands, use `build.py cargo`. It sets the same target and environment. For `test` and `nextest`
it first builds `omd-runner` and links it beside the test binaries, where hosts look for it. `LOG` is a log file
path: the full output goes there and a summary goes to the terminal.

```sh
python3 .github/scripts/build.py cargo NAME LOG test --locked -p CRATE FILTER
```

For tests that do not start a mod host, add `--skip-runner` before `NAME` to avoid building `omd-runner`:

```sh
python3 .github/scripts/build.py cargo --skip-runner NAME LOG test --locked -p CRATE FILTER
```

The wrapper sets development debug information to `0`. Use `CARGO_PROFILE_DEV_DEBUG=line-tables-only` for file
and line numbers in backtraces, or `full` when you need local variables in a debugger. Each setting gives Cargo a
different build configuration, so switching it can rebuild dependencies. On machines that run out of memory or
swap heavily, try `OMD_LOW_RESOURCE=1 mise run dev:build NAME` to limit Cargo to three build jobs. An explicit
`CARGO_BUILD_JOBS` or Cargo `--jobs` flag takes precedence.

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
| `dev-setup NAME` | Creates the scratch tree and fetches its verified V8 prebuilt |
| `v8 NAME` | Downloads and verifies the V8 prebuilt |
| `cargo NAME LOG ARGS` | Runs cargo in the tree, full log to `LOG` |
| `cargo --skip-runner NAME LOG ARGS` | Skips runner preparation for host-independent tests |
| `dev-check NAME CRATE [CRATE...]` | Checks selected crates without test targets; log and timing report |
| `dev-build NAME` | Builds the debug app, runner, code-mode host and mod engine; log and timing report |
| `dev-refresh NAME` | Replaces an unedited tree's patch with the checkout's, in place |
| `dev-run NAME [--enable ID] [-- ARGS]` | Refreshes and builds the tree, then runs it on the checkout's first-party mods and reloads them as they change |
| `dev-mods NAME` | Builds only the debug mod engine and runner; log and timing report |
| `storage` | Lists each scratch tree's target disk usage |
| `clean NAME [NAME...]` | Deletes only the selected targets; preserves sources and logs |
| `check NAME` | Runs `cargo check --tests` of the crates a pull request compiles |
| `sync NAME` | Writes the patch, manifest, copies and crate notices back and verifies the replay |
| `locks` | Regenerates the source locks |
| `artifacts NAME` | Builds, signs and packs the release binaries (used by CI) |

## See also

- [How CI checks a change](ci.md)
- [Cut a release](release.md), including how to set the crate versions for a release
