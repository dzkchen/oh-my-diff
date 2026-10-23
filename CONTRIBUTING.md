# Contributing

How to send a change to OMD. One person maintains it and, after release, expects to focus mainly on critical fixes, so
small, focused changes fit best. For anything large, open an issue first.

## Where your change belongs

- **A new feature:** write it as a mod, plugin, skill or hook. It doesn't have to live in this repository. Start
  with [Write your first mod](docs/write-a-mod.md).
- **Something a mod can't do yet:** open a
  [mod or API request](https://github.com/dzkchen/oh-my-diff/issues/new?template=mod-api.yml). The patched Codex
  code in `runtime/` only gets general building blocks that many mods can use, never a single feature.
- **A bug or docs fix:** send a pull request.

## Set up

You need an Apple Silicon Mac with [mise](https://mise.jdx.dev) and [pnpm](https://pnpm.io) 11.14 or later.

```sh
git clone https://github.com/dzkchen/oh-my-diff
cd oh-my-diff
mise install
pnpm --dir mods install
```

## Check your change

Run only the checks for what you changed:

| You changed | Run |
| --- | --- |
| A mod or the SDK | `mise run mods:check`, then a related test file: `mise exec -- node --test PATH` (tests live in `tests/` and beside the code; see [tests/README.md](tests/README.md)). Tests that run mods start the installed `omd-runner` beside `omd-mod`, or the one in `OMD_TEST_RUNNER` |
| The patched Codex code (`runtime/`) | See [Change the patched Codex code](#change-the-patched-codex-code) |
| A Python script or the installer | `python3 -m unittest tests.test_NAME` |
| Docs or the changelog | `mise run release:check` |

Add a test only for behavior nothing else covers. The full suite runs nightly on GitHub, not on each change.

### Change the patched Codex code

You also need [rustup](https://rustup.rs); the scratch tree's `rust-toolchain.toml` installs the pinned Rust (see
`upstream.lock.json`) on first use. A first test build takes a few minutes and a target needs 15–20 GB.

Edit Rust in a scratch copy of upstream Codex at the pinned version, never `runtime/` itself, then save it back.
`NAME` is any label for your scratch tree:

```sh
python3 .github/scripts/build.py setup NAME                                  # prints the scratch tree path
python3 .github/scripts/build.py cargo NAME LOG test --locked -p CRATE FILTER # cargo in the tree; LOG is a log file path
python3 .github/scripts/build.py sync NAME                                   # writes runtime/ and crate notices back, checks it replays
python3 .github/scripts/build.py locks                                       # regenerates the source locks
```

- **Crates:** `runtime/omd` is `codex-omd`, `runtime/omd/runner` is `codex-omd-runner` (the `omd-runner` binary that
  runs mods on embedded V8) and `runtime/native` is `codex-omd-extension`. Rust tests sit beside the code in
  `*_tests.rs` files. Always run cargo through `build.py cargo`: it sets the target, and for `test` it builds
  `omd-runner` and links it beside the test binaries, where hosts look for it.
- **Layout:** the tree is `/private/tmp/omd-bNAME/codex` and its target `/private/tmp/omd-bNAME/target`; `OMD_WORK_ROOT`
  replaces `/private/tmp`. The pinned upstream source, without the patch, is the tree's `normalized<version>` tag
  (`git -C TREE diff normalized1640 -- codex-rs/PATH`).
- **Crate notices:** `sync` regenerates `runtime/crate-notices.txt` with `scripts/crate_notices.py TREE`; the patch sync
  check in CI fails when it is stale.
- **Mods:** the tree's `mods/` links to your checkout, so mod edits are ordinary edits there. Run `build.py locks` after
  changing `mods/first-party/` or `plugins/` and commit the result.
- **V8:** `omd-runner` and `codex-cli` link a V8 prebuilt: fetch it once with `python3 .github/scripts/build.py v8 NAME`.
  A host started from the target finds `omd-runner` beside itself, so build both (`-p codex-cli -p codex-omd-runner`).
- **Check:** the regression test for your fix, the crate's tests (`-- --test-threads=1`),
  `cargo NAME LOG clippy --locked -p CRATE --tests`, `rustfmt` on the files you changed and `mise run native:ownership`.
  `sync` must report `"tree_parity": true`; `setup` and `sync` on a fresh `NAME` must leave `git diff` unchanged.
  `runtime/release.lock.json` is rebuilt from signed binaries at release time, so a native change leaves it as is.

### Linux container

The `Dockerfile` gives a Debian environment with the pinned Rust, Node, Python and pnpm, for building and testing
without a Mac. OMD itself supports only Apple Silicon macOS, and the mod host runs mods only there.

```sh
docker build -t oh-my-diff .
docker run --rm -it -v omd-work:/home/omd/work oh-my-diff   # then the build.py commands above
```

The work root is `/home/omd/work`, kept in the `omd-work` volume; rebuild the image after changing the checkout.
The binaries build and the Python, `mods:check` and most `mods:test` checks pass there. Tests that start a mod
runner or the authority broker fail by design.

## Open a pull request

1. Branch from `main`.
2. Title it with a [Conventional Commits](https://www.conventionalcommits.org) prefix. With a squash merge or a merge
   commit the title is the pull request's one changelog line and the branch's own commits aren't listed; a rebase
   merge lists each commit, so give each one a prefix too. Merged branches are kept.
3. Say what changed and how you checked it.

| Prefix | Changelog |
| --- | --- |
| `feat` | New |
| `fix` | Fixed |
| `test`, `build`, `ci`, `chore` | Not listed |
| Anything else | Changed |

Don't commit secrets, credentials or personal paths.

## Releases

The maintainer cuts releases; the process is in [.github/WORKFLOWS.md](.github/WORKFLOWS.md).

## License

Your contributions are under the [MIT License](LICENSE). Changes under `runtime/patches`, `runtime/omd` and
`runtime/native` are Apache-2.0, like the Codex code they patch ([NOTICE](NOTICE)).
