# Write your first mod

This tutorial builds a mod that adds a `/hello` command, tests it, runs it in `codex` and shares it. It takes about
ten minutes.

A **mod** is a small TypeScript package that runs inside OMD. It can add commands and tools, change what's sent to
the model, and draw on the screen.

## Before you begin

You need OMD [installed](install.md) and [pnpm](https://pnpm.io).

## 1. Create the mod

```sh
omd-mod-author create ./my_mod my_mod
cd my_mod
```

This makes a folder with:

- `index.ts`: the code. It adds a `/hello` command.
- `mod.json`: the mod's name, version and the permissions it asks for.
- `mod.test.json`: an offline test that runs `/hello`.

## 2. Test it

```sh
pnpm test
```

The test runs your mod offline, without calling a model, and prints each step. You should see
`"display": "Hello author"`.

To check types as well, add TypeScript once with `pnpm add -D typescript@5.9.3`, then run `pnpm check`.

`pnpm test` also runs any `*.test.ts` or `*.test.mjs` file next to `mod.test.json`. Use the helpers in
`@oh-my-diff/mod-api/testing` there; see [TypeScript tests](../mods/REFERENCE.md#typed-tool-declarations).
Tests never call a real model: a host call you didn't mock fails the test.

The real host loads the package, runs its callbacks, validates views and advances virtual time. The test helpers
can seed and read state, invoke commands and tools, mount views, inspect host calls and step component modules
with key and pointer events. See [Offline scenarios](../mods/REFERENCE.md#offline-scenarios) for the helpers and
examples.

## 3. Try it in `codex`

Set up a practice mod store, so experiments don't touch your real one:

```sh
omd-mod init /tmp/my-store "$(mise which node)"
pnpm watch /tmp/my-store
```

`pnpm watch` loads your mod into that store and reloads it each time you save. Leave it running. It also copies
type declarations into `.omd/`. Use `pnpm watch /tmp/my-store --once` to load once and exit.

In a second terminal, start `codex` on the practice store:

```sh
OMD_MODE=omd OMD_MOD_STORE=/tmp/my-store OMD_NODE="$(mise which node)" ~/.local/share/oh-my-diff/current/prefix/artifacts/codex
```

Type `/hello`. You should see `Hello world`.

Now edit the message in `index.ts` and save. Send another message in `codex`, then type `/hello` again to see
your change.

## 4. Install it for real

```sh
omd install ./my_mod
omd mods enable my_mod
```

Each command shows what the mod can do and asks before going ahead. After you change the code later, run
`omd mods update my_mod`.

## 5. Share it

Build a release copy:

```sh
pnpm run package
```

To publish on npm:

1. In `package.json`, remove `"private": true`, give it a scoped name such as `@you/my-mod`, and use the same
   version as `mod.json`.
2. In `mod.json`, set `license` and `provenance`.
3. Run `pnpm check && pnpm test && pnpm publish --access public`.

Others install it with:

```sh
omd install npm:@you/my-mod@0.1.0
```

You can also share it from Git: `omd install 'git+https://github.com/you/repo#v0.1.0:my_mod'`.

## If something goes wrong

- **A test or command fails:** run `pnpm debug` to see how errors look. Stack traces point at your own lines.
- **`capability_denied`:** the mod used something it didn't ask for. Add the permission to `mod.json`; run
  `omd-mod-author explain 'capability_denied: exec'` for help.
- **The mod breaks `codex`:** run `omd mods disable my_mod` from any shell.

## Next steps

- Copy bigger working examples to read and adapt: `omd-mod-author examples ./examples`.
- [Mod API reference](../mods/REFERENCE.md): every operation, event and screen surface.
- [Agent mod guide](AGENT_MOD_GUIDE.md): hand this to a coding agent to build a bigger mod.
- [Permissions](../mods/REFERENCE.md#capabilities) and [how mods combine](../mods/REFERENCE.md#composition-and-safety).
- [Publishing rules](../mods/REFERENCE.md#publish-a-mod-to-npm) and [compatibility](../mods/COMPATIBILITY.md).

### Mod, plugin, skill or hook?

| You want to | Use |
| --- | --- |
| Give the model a procedure to follow | A skill |
| React to an event, such as a finished turn | A hook |
| Add tools or services Codex can call | A plugin |
| Change how `codex` itself behaves or looks | A mod |

A plugin can also include a mod. For an example, see
[`omd-artifact-reading`](../plugins/bundled/oh-my-diff/plugins/omd-artifact-reading).
