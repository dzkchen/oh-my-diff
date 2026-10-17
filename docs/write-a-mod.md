# Write your first mod

Build a `/hello` command, test it, run it in `codex` and share it. About ten minutes.

A **mod** is a small TypeScript package that runs inside OMD. It can add commands and tools, change what the model
sees, and draw on screen.

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
- `mod.test.json`: an offline test that runs `/hello`.

## 2. Test it

```sh
pnpm test
```

It runs offline and prints a long JSON report. Exit 0 means it passed; look for `"display": "Hello author"` near
the top.

Tests never call a real model. For mocks and helpers, see
[Offline scenarios](../mods/REFERENCE.md#offline-scenarios) and
[TypeScript tests](../mods/REFERENCE.md#typescript-tests).

To type-check too, add TypeScript once, then run `pnpm check`:

```sh
pnpm add -D typescript@5.9.3
```

## 3. Try it in `codex`

Use a practice mod store so experiments don't touch your real one:

```sh
omd-mod init /tmp/my-store "$(mise which node)"
pnpm watch /tmp/my-store
```

`pnpm watch` loads your mod and reloads it on every save. Leave it running.

In a second terminal, start `codex` on that store:

```sh
OMD_MODE=omd OMD_MOD_STORE=/tmp/my-store OMD_NODE="$(mise which node)" ~/.local/share/oh-my-diff/current/prefix/artifacts/codex
```

Type `/hello`. You should see `Hello world`.

Edit the message in `index.ts` and save. Send any message, then `/hello` again.

## 4. Install it for real

```sh
cd ..
omd install ./my_mod
omd mods enable my_mod
```

Each command shows what the mod can do and asks first. After later code changes, run `omd mods update my_mod`.

## 5. Share it

Build a release copy:

```sh
pnpm run package
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

Git works too: `omd install 'git+https://github.com/you/repo#v0.1.0:my_mod'`.

## If something goes wrong

| Problem | Fix |
| --- | --- |
| A test or command fails | Run `pnpm debug`. Stack traces point at your own lines. |
| `capability_denied` | The mod used something it didn't ask for. Add the permission to `mod.json`, or run `omd-mod-author explain 'capability_denied: exec'`. |
| The mod breaks `codex` | Run `omd mods disable my_mod` from any shell. |

## Next steps

- Read bigger working examples: `omd-mod-author examples ./examples`.
- [Mod API reference](../mods/REFERENCE.md): every operation, event and screen surface.
- [Agent mod guide](AGENT_MOD_GUIDE.md): hand it to a coding agent. It also helps you
  [choose between a mod, plugin, skill or hook](AGENT_MOD_GUIDE.md#1-pick-the-right-kind-of-extension).
- [Permissions](../mods/REFERENCE.md#capabilities) and [how mods combine](../mods/REFERENCE.md#composition-and-safety).
- [Publishing rules](../mods/REFERENCE.md#publish-a-mod-to-npm) and [compatibility](../mods/COMPATIBILITY.md).
