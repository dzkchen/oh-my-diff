# Contributing

OMD welcomes focused bug fixes, docs improvements and mod contributions. Two maintainers review changes, with
critical fixes taking priority after release. For a large change, open an issue first.

Start with setup below, then read the [code conventions](docs/contributing/code-style.md). For terminal views, use
the [UI style guide](docs/STYLEGUIDE.md); for regression coverage, read [Tests](tests/README.md#write-a-useful-test).

## Where your change belongs

- A new feature: write it as a mod, plugin, skill or hook. It doesn't have to be in this repository. Start with
  [Write your first mod](docs/mod-authors/first-mod.md).
- Something a mod can't do yet: open a
  [mod or API request](https://github.com/dzkchen/oh-my-diff/issues/new?template=mod-api.yml). The patched Codex
  code in `runtime/` only gets general building blocks that several unrelated mods can use, never one feature.
- A bug or docs fix: send a pull request.
- Anything else: open an issue first and wait for `status: accepted`. Pull requests from outside contributors
  without a linked issue may be closed. Issues labeled `good first issue` or `help wanted` are open for you to take.
- A security problem: report it privately as described in [SECURITY.md](SECURITY.md).

## Find your way around

| Path | Contains |
| --- | --- |
| `runtime/` | The Codex patch, the OMD host crates and the release locks ([runtime/README.md](runtime/README.md)) |
| `mods/` | The SDK (types, `author/` tooling and the reference), conformance data in `conformance/`, and mod packages in `first-party/`, `examples/` and `ports/` |
| `plugins/` | Bundled plugins |
| `extensions/` | The curated directory (`index.json`) |
| `scripts/`, `tests/`, `install.sh` | Build, install and check tooling |
| `docs/` | User, author and contributor guides |
| `release/` | The changelog source and its `git-cliff` config |
| `docker/` | The Linux build container |

## Set up

You need an Apple Silicon Mac with [mise](https://mise.jdx.dev), [pnpm](https://pnpm.io) 11.14 or later and Python 3.12 or later (macOS ships 3.9).

```sh
git clone https://github.com/dzkchen/oh-my-diff
cd oh-my-diff
mise install
pnpm --dir mods install --frozen-lockfile
```

Use `pnpm`, never `npm` or `npx`. Runtime versions come from `mise.toml`; pnpm is specified in `mods/package.json`. Python is not pinned; use 3.12 or later. To build without a Mac, use the
[Linux container](docs/contributing/runtime.md#build-on-linux).

Run commands on this page from the repository root. Dependencies live in `mods/`; there is no root pnpm package.
The [runtime guide](docs/contributing/runtime.md) covers Rust tools, scratch trees and building a runnable app.
Docs and host-free tests do not require an installed OMD or a Rust build. Tests that run mods need `omd-runner`.
For native work, `mise run dev:setup NAME` prepares source and V8. Use `mise run dev:mods NAME` when you need only
the mod engine and runner, or `mise run dev:build NAME` for the terminal app. Reuse the same scratch tree while
editing to retain incremental builds. The runtime guide explains when to create a fresh one after source changes.

## Check your change

Start with the checks selected from your diff:

```sh
mise run check:changed -- --list
mise run check:changed
```

`--list` prints the changed files and commands without running them. The command compares your branch with the
merge base of `origin/main`, including staged, unstaged and untracked files. Fetch `origin/main` before using it if
your local ref is stale. For a stacked branch, pass `--base REF`, for example
`mise run check:changed -- --base origin/my-base-branch`. A missing base fails rather than silently narrowing the
comparison. Renames include both the old and new path.

Markdown-only changes outside `runtime/`, `mods/` and `plugins/` run whitespace and release/docs checks. Other
changes also run the portable mod, native ownership and source-lock checks, since package docs can be shipped
assets. Changed Node and Python test files run directly; optional tests in
`tests/suites.json` remain manual. Workflow changes also run Actionlint. The command checks files without rewriting
them and stops at the first failure. It does not compile Rust or find tests through imports, fixtures or subprocess
inputs. Select related tests and any native or terminal checks from the table too:

| You changed | Run |
| --- | --- |
| A mod or the SDK | `mise run mods:check`, then a related test file with `mise exec -- node --test PATH` |
| A first-party mod or plugin | The checks for a mod, then `python3 .github/scripts/build.py locks` to regenerate the source locks; commit the result |
| The patched Codex code (`runtime/`) | The steps in [Change the patched Codex code](docs/contributing/runtime.md) |
| A Python script or the installer | The related module, such as `python3 -m unittest tests.test_install_updates`; see [Tests](tests/README.md) |
| Docs or the changelog | `mise run release:check` |

Mod, SDK, plugin, Python and documentation edits do not need Rust compilation unless they also change the native
host. For Rust edits, reuse a scratch tree and start with `mise run dev:check NAME CRATE`; use
`mise run dev:build NAME` when you need a runnable debug app. See the
[runtime workflow](docs/contributing/runtime.md#build-and-test-with-cargo) for logs, resource and cache settings,
focused tests and build storage cleanup.

Tests are in `tests/` and beside the code. [tests/README.md](tests/README.md) explains how they're found and which
runner runs each kind. Tests that run mods start the `omd-runner` named in `OMD_TEST_RUNNER`, else the installed one
beside `omd-mod`, else the newest one built in a scratch tree (see
[Change the patched Codex code](docs/contributing/runtime.md)).

Add a test only for behavior nothing else covers. [Write a useful test](tests/README.md#write-a-useful-test) explains
how to reproduce a bug, choose its layer and avoid brittle assertions. Rerun affected checks after your last edit or
rebase, and report anything you could not verify. A pull request runs a subset of checks, and the full suite runs
nightly on GitHub. [How CI checks a change](docs/contributing/ci.md) says what runs when.

## Open a pull request

1. Branch from `main`.
2. Title it with a [Conventional Commits](https://www.conventionalcommits.org) prefix, from the table below.
3. Fill in the [pull request template](.github/pull_request_template.md): what changed and why, the linked issue,
   how you checked it, with a before and after screenshot or recording for anything visible in the terminal, and
   the risk.

Keep the diff to one problem. Start the description with the problem and resulting behavior, then explain the
mechanism and validation. List the actual commands and results, including skipped checks. For terminal changes,
record the terminal, viewport size and settings with the before and after evidence. A scenario trace is not a
rendered UI check. Leave release version changes, tags and publication to the maintainer unless asked.

| Prefix | Changelog section |
| --- | --- |
| `feat` | New |
| `fix` | Fixed |
| `test`, `build`, `ci`, `chore` | Not listed |
| Anything else | Changed |

With a squash merge or a merge commit, the title is the pull request's one changelog line, and the branch's own
commits aren't listed. A rebase merge lists each commit, so give each one a prefix too. Merged branches are kept.

Follow the [code conventions](docs/contributing/code-style.md), including generated files and comments. Don't
commit secrets, credentials or personal paths.

AI-assisted changes are welcome. Say which tools you used in the template's AI section, review the result yourself
and run the checks; you are responsible for every line.

## Issues and labels

Issue forms label each issue with a `type:`, `status: triage` and, from the form's Area field, an `area:` label.
The maintainer then sets a status: `accepted`, `blocked`, `needs-info`, `needs-repro` or `upstream`. Closed issues
may get `resolution: duplicate` or `resolution: wontfix`. The labels are listed in
[.github/settings.json](.github/settings.json).

## Releases

The maintainer cuts releases. The runbook is [Cut a release](docs/contributing/release.md).

## License

Your contributions are under the [MIT License](LICENSE). Changes under `runtime/patches`, `runtime/omd` and
`runtime/native` are Apache-2.0, like the Codex code they patch, and so are changes to the `token_weather` and
`blast_radius` ports in `mods/ports` ([NOTICE](NOTICE)).
