# Contributing

How to send a change to OMD: where it belongs, how to set up and check it, and how to open the pull request. One
person maintains OMD and, after release, expects to focus mainly on critical fixes, so small, focused changes fit
best. For anything large, open an issue first.

## Where your change belongs

- A new feature: write it as a mod, plugin, skill or hook. It doesn't have to be in this repository. Start with
  [Write your first mod](docs/mod-authors/first-mod.md).
- Something a mod can't do yet: open a
  [mod or API request](https://github.com/dzkchen/oh-my-diff/issues/new?template=mod-api.yml). The patched Codex
  code in `runtime/` only gets general building blocks that many mods can use, never a single feature.
- A bug or docs fix: send a pull request.
- A security problem: report it privately as described in [SECURITY.md](SECURITY.md).

## Find your way around

| Path | Contains |
| --- | --- |
| `runtime/` | The Codex patch, the OMD host crates and the release locks ([runtime/README.md](runtime/README.md)) |
| `mods/` | The published SDK at its top level (the `.d.ts` types, `author/` tooling, `REFERENCE.md` and `reference/` docs), checked data in `conformance/`, and packages in `first-party/`, `examples/` and `ports/` |
| `plugins/`, `extensions/` | Bundled plugins and the curated directory |
| `scripts/`, `tests/`, `install.sh` | Build, install and check tooling |
| `docs/` | User, author and contributor guides |
| `release/` | The changelog source and its `git-cliff` config |
| `docker/` | The Linux build container |

## Set up

You need an Apple Silicon Mac with [mise](https://mise.jdx.dev) and [pnpm](https://pnpm.io) 11.14 or later.

```sh
git clone https://github.com/dzkchen/oh-my-diff
cd oh-my-diff
mise install
pnpm --dir mods install
```

Use `pnpm`, never `npm` or `npx`. Tool versions come from `mise.toml`. To build without a Mac, use the
[Linux container](docs/contributing/runtime.md#build-on-linux).

## Check your change

Run only the checks for what you changed:

| You changed | Run |
| --- | --- |
| A mod or the SDK | `mise run mods:check`, then a related test file with `mise exec -- node --test PATH` |
| The patched Codex code (`runtime/`) | The steps in [Change the patched Codex code](docs/contributing/runtime.md) |
| A Python script or the installer | `python3 -m unittest tests.test_NAME` |
| Docs or the changelog | `mise run release:check` |

Tests are in `tests/` and beside the code. [tests/README.md](tests/README.md) explains how they're found and which
runner runs each kind. Tests that run mods start the installed `omd-runner` beside `omd-mod`, or the one in
`OMD_TEST_RUNNER`.

Add a test only for behavior nothing else covers. A pull request runs a subset of checks, and the full suite runs
nightly on GitHub. [How CI checks a change](docs/contributing/ci.md) says what runs when.

## Open a pull request

1. Branch from `main`.
2. Title it with a [Conventional Commits](https://www.conventionalcommits.org) prefix. With a squash merge or a merge
   commit, the title is the pull request's one changelog line and the branch's own commits aren't listed. A rebase
   merge lists each commit, so give each one a prefix too. Merged branches are kept.
3. Fill in the [pull request template](.github/pull_request_template.md): what changed and how you checked it.

| Prefix | Changelog section |
| --- | --- |
| `feat` | New |
| `fix` | Fixed |
| `test`, `build`, `ci`, `chore` | Not listed |
| Anything else | Changed |

Write no code comments except one line on genuinely abstract code. Don't commit secrets, credentials or personal
paths.

## Releases

The maintainer cuts releases. The runbook is [Cut a release](docs/contributing/release.md).

## License

Your contributions are under the [MIT License](LICENSE). Changes under `runtime/patches`, `runtime/omd` and
`runtime/native` are Apache-2.0, like the Codex code they patch, and so are changes to the `token_weather` and
`blast_radius` ports in `mods/ports` ([NOTICE](NOTICE)).
