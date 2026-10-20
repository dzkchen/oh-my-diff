# Write your first mod

Build a `/hello` command, test it, run it in `codex` and share it.

A **mod** is a small TypeScript package that runs inside OMD. It can add commands and tools, change what the model
sees, and draw on screen. Mod API `1.0.0` is stable, but only the current API loads and its experimental surfaces can change, so a mod may
need changes after an update ([compatibility](../mods/COMPATIBILITY.md)).

## Before you begin

You need OMD [installed](install.md) and [pnpm](https://pnpm.io).

## 1. Create the mod

```sh
omd-mod-author create ./my_mod my_mod
cd my_mod
```

You get a folder with:

- `index.ts`: the code, with a `/hello` command.
- `mod.json`: the mod's name, version and requested permissions.
- `mod.test.json` and `debug.test.json`: offline scenarios that run `/hello`.
- `package.json` and `tsconfig.json`: the `pnpm` scripts (`check`, `test`, `run`, `debug`, `package`, `watch`) and
  TypeScript settings.

## 2. Test it

```sh
pnpm test
```

It runs offline and prints a long JSON report. Exit 0 means it passed; look for `"display": "Hello author"` near
the top. Once TypeScript is added (below), `pnpm test` also type-checks, after the scenario passes and before its
report prints, so a type error fails the run.

Tests never call a real model. For mocks and helpers, see
[Offline scenarios](../mods/reference/packaging.md#offline-scenarios) and
[TypeScript tests](../mods/reference/authoring.md#typescript-tests).

To type-check too, add TypeScript once, then run `pnpm check` (it prints `check: ok` when it passes):

```sh
pnpm add -D typescript@5.9.3
```

## 3. Try it in `codex`

Use a practice mod store so experiments don't touch your real one. `omd-mod init` records the Node binary the store
runs mods with; give it a real `node` path, not a version-manager shim:

```sh
omd-mod init /tmp/my-store "$(mise which node 2>/dev/null || command -v node)"
pnpm watch /tmp/my-store
```

`pnpm watch` loads your mod and reloads it on every save. Leave it running.

In a second terminal, start `codex` on that store:

```sh
OMD_MODE=omd OMD_MOD_STORE=/tmp/my-store ~/.local/share/oh-my-diff/current/prefix/artifacts/codex
```

Type `/hello`. You should see `Hello world`. The popup also lists it as `/my_mod:hello`; that form always works,
and you need it when another mod or a built-in uses the same name.

Edit the message in `index.ts` and save. Send any message, then `/hello` again.

`codex` asks you to sign in on a fresh home. A mod's commands and views need no model turn, so to try them without
an account, point `codex` at a local address that never answers by adding
`-c model_provider=offline -c 'model_providers.offline={name="offline",base_url="http://127.0.0.1:9/v1",wire_api="responses"}'`.

## 4. Install it for real

```sh
cd ..
omd install ./my_mod
omd mods enable my_mod
```

Each command shows what the mod can do and asks first. A folder install runs the folder itself, not `dist/`: after
any edit, even whitespace, the mod stops until you review it again with `omd mods update my_mod` (`omd-mod status`
lists it under `rejected` as `untrusted_source` meanwhile). To freeze a version, install a Git tag or a package
instead.

## 5. Share it

Build a release copy:

```sh
pnpm --dir my_mod run package
```

To rebuild, delete `dist/` first or bump `version`.

To publish on npm:

1. In `package.json`, remove `"private": true`, use a scoped name such as `@you/my-mod`, and match the version in
   `mod.json`.
2. In `mod.json`, set `license` and `provenance`.
3. Run:

   ```sh
   pnpm check && pnpm test && pnpm publish --access public
   ```

Others install it with:

```sh
omd install npm:@you/my-mod@0.1.0
```

Git works too: commit the mod, tag it, and install `omd install 'git+https://github.com/you/repo#v0.1.0:my_mod'`.
`provenance.source` in the committed `mod.json` must name that repository exactly: `https://github.com/you/repo`, or
for a local `git+file:///path/repo#…` install the repository's absolute path `/path/repo` (symlinks resolved).
Anything else is refused with `repository_provenance_mismatch`
([details](../mods/reference/packaging.md#provenancesource-for-git-installs)).

A release install of OMD scaffolds `@oh-my-diff/mod-api` as that release's `mod-api.tgz` GitHub asset, so
collaborators run `pnpm install` without OMD. (Scaffolding needs the network once to lock it.)
A dev build links the SDK from its install with a `file:` path under your home directory instead; set
`OMD_MOD_SDK_SPEC` to use another spec.

## If something goes wrong

| Problem | Fix |
| --- | --- |
| A test or command fails | The error names your `index.ts` line. `omd mods list` shows why a mod failed in the last session. |
| `capability_denied` | The mod used something it didn't ask for. Add the permission to `mod.json`, or run `omd-mod-author explain 'capability_denied: exec'`. |
| The mod breaks `codex` | Run `omd mods disable my_mod` from any shell. |

## Next steps

- Read bigger working examples: `omd-mod-author examples ./examples`.
- [Mod API reference](../mods/reference/README.md): every operation, event and screen surface.
- [Agent mod guide](AGENT_MOD_GUIDE.md): hand it to a coding agent. It also helps you
  [choose between a mod, plugin, skill or hook](AGENT_MOD_GUIDE.md#1-pick-the-right-kind-of-extension).
- [Permissions](../mods/reference/capabilities.md#capabilities) and [how mods combine](../mods/reference/safety.md).
- [Publishing rules](../mods/reference/packaging.md#publish-a-mod-to-npm) and [compatibility](../mods/COMPATIBILITY.md).
