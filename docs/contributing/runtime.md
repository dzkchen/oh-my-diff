# Change the patched Codex code

How to change the Rust code in `runtime/`: set up a scratch tree, fetch V8, build and test with cargo, check the
change and write it back. For what `runtime/` contains, see [runtime/README.md](../../runtime/README.md).

## Before you start

- The setup in [CONTRIBUTING.md](../../CONTRIBUTING.md#set-up): an Apple Silicon Mac with mise and pnpm.
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

`NAME` is any label for your tree:

```sh
python3 .github/scripts/build.py setup NAME
```

`setup` prints the patch result and then the tree's path, `/private/tmp/omd-bNAME/codex`. Running it again on an
existing tree only prints the path.

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

Always run cargo through `build.py cargo`. It sets the target, and for `test` and `nextest` it first builds
`omd-runner` and links it beside the test binaries, where hosts look for it. `LOG` is a log file path: the full
output goes there and a summary goes to the terminal.

```sh
python3 .github/scripts/build.py cargo NAME LOG test --locked -p CRATE FILTER
```

Build both binaries, because a host started from the target looks for `omd-runner` beside itself:

```sh
python3 .github/scripts/build.py cargo NAME LOG build --locked -p codex-cli -p codex-omd-runner
```

## Check your change

Run these in the scratch tree:

1. The regression test for your fix.
2. The crate's tests:

   ```sh
   python3 .github/scripts/build.py cargo NAME LOG nextest run --locked -p CRATE
   ```

3. Clippy and Rustfmt:

   ```sh
   python3 .github/scripts/build.py cargo NAME LOG clippy --locked -p CRATE --tests
   python3 .github/scripts/build.py cargo NAME LOG fmt -p CRATE -- --check
   ```

4. The compile check a pull request runs, `cargo check --tests` of the crates it compiles. Its log is
   `/private/tmp/omd-bNAME/logs/check.log`:

   ```sh
   python3 .github/scripts/build.py check NAME
   ```

5. The native ownership check, which fails if native code names a feature or a first-party mod. Run it from the
   repository root:

   ```sh
   mise run native:ownership
   ```

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
| `check NAME` | Runs `cargo check --tests` of the crates a pull request compiles |
| `sync NAME` | Writes the patch, manifest, copies and crate notices back and verifies the replay |
| `locks` | Regenerates the source locks |
| `artifacts NAME` | Builds, signs and packs the release binaries (used by CI) |

## See also

- [How CI checks a change](ci.md)
- [Cut a release](release.md), including how to set the crate versions for a release
