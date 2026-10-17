# Contributing

Thanks for helping. One person maintains OMD, mostly for critical fixes, so small, focused changes land fastest.
For anything large, open an issue first.

## Where your change belongs

- **A new feature:** write it as a mod, plugin, skill or hook. Your mod doesn't need to live in this repository;
  start with [Write your first mod](docs/write-a-mod.md).
- **Something a mod can't do yet:** open a [mod or API request](https://github.com/dzkchen/oh-my-diff/issues/new?template=mod-api.yml).
  The patched Codex code in `runtime/` only gets general building blocks that many mods can use, never a single
  feature.
- **A bug or docs fix:** send a pull request.

## Set up

You need an Apple Silicon Mac with [mise](https://mise.jdx.dev) and [pnpm](https://pnpm.io).

```sh
git clone https://github.com/dzkchen/oh-my-diff
cd oh-my-diff
mise install
pnpm --dir mods install
```

## Check your change

| You changed | Run |
| --- | --- |
| A mod or the SDK | `mise run mods:check`, then that mod's tests: `node --test mods/first-party/ID/*.test.mjs` |
| A Python script or the installer | `python3 -m unittest tests.test_NAME` |
| Docs or the changelog | `mise run release:check` |

Add a test only for behavior nothing else covers. The full test suite runs every night on GitHub, not on each
change.

### Changing the patched Codex code

The patch is applied to a fresh copy of upstream Codex in a scratch folder. Edit there, then save the patch back:

```sh
python3 .github/scripts/build.py setup my-change    # creates /private/tmp/omd-bmy-change/codex
python3 .github/scripts/build.py cargo my-change /private/tmp/omd-bmy-change/test.log test -p codex-omd FILTER
python3 .github/scripts/build.py sync my-change     # writes runtime/patches and checks it applies
python3 .github/scripts/build.py locks              # updates the generated lock files
```

## Open a pull request

1. Branch from `main`.
2. Pull requests are squash-merged, so the title becomes the commit and its changelog line. A
   [Conventional Commits](https://www.conventionalcommits.org) prefix sorts it: `feat` under New, `fix` under Fixed,
   `test`, `build`, `ci` and `chore` aren't listed, and anything else goes under Changed.
3. Describe what changed and how you checked it.

Don't commit secrets, credentials or personal paths.

## Releases

The maintainer runs `mise run release -- VERSION --summary "One sentence."`, merges the pull request it opens,
then runs the same command again to tag the release. [.github/WORKFLOWS.md](.github/WORKFLOWS.md) has the details.

## License

Your contributions are licensed under the [MIT License](LICENSE). Changes under `runtime/patches`, `runtime/omd`
and `runtime/native` are Apache-2.0, like the Codex code they patch ([NOTICE](NOTICE)).
