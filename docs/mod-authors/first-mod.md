# Write your first mod

This tutorial builds a mod with a `/hello` command, tests it offline, runs it in `codex` and installs it. It's for
anyone who has OMD installed and knows a little TypeScript.

A mod is a small TypeScript package that runs inside OMD. It can add commands and tools, change what the model sees,
and draw on screen.

## Before you begin

You need:

- OMD [installed](../install.md), either OMD+ or OMD Core.
- Node 24.18 or a later 24.x. Only `omd-mod-author` uses Node; mods run in OMD's own runtime.
- [pnpm](https://pnpm.io) 11.14 or later.

[Support](../support.md) lists the supported versions of each tool.

Check them:

```sh
command -v omd-mod-author omd-mod omd
node --version
pnpm --version
```

The first command prints three paths. If it prints fewer, OMD isn't installed.

## 1. Create the mod

```sh
omd-mod-author create ./my_mod my_mod
cd my_mod
```

The second argument is the mod's ID: lowercase letters, digits and `_`, up to 24 characters. You get a folder with:

- `index.ts`: the code. It registers a `/hello` command that prints `Hello` and its argument, or `Hello world`
  without one.
- `mod.json`: the mod's ID, version, API version and the permissions it asks for.
- `mod.test.json`: an offline test that runs `/hello` with the argument `author`.
- `debug.test.json`: a test that fails on purpose, so you can see how errors look.
- `package.json` and `tsconfig.json`: the `pnpm` scripts and TypeScript settings.

## 2. Turn on type checking

Add TypeScript to the project once. `omd-mod-author` asks for 5.9.3, the version the SDK pins:

```sh
pnpm add -D typescript@5.9.3
pnpm check
```

`pnpm check` prints `check: ok`.

## 3. Test it

```sh
pnpm test
```

The test runs offline and never calls a model. It prints a long JSON report and exits with status 0. Near the top
you see the command's result:

```json
"value": {
  "display": "Hello author"
}
```

The test passed `author` as the argument, so the command printed `Hello author`. `pnpm test` also runs the type
check, so a type error fails it.

To see how a failure looks, run `pnpm debug`. It runs `debug.test.json`, which expects a deliberate error, and
prints the error mapped to its line in `index.ts`.

## 4. Try it in `codex`

Try the mod in a scratch store, so your real mods aren't touched. A mod store is the folder where OMD keeps
installed mods, the permissions you granted them, their settings and their saved data. Your install has one. A
scratch store is an empty one you create for testing and delete afterwards.

1. Create a scratch store and load the mod into it:

   ```sh
   omd-mod init /tmp/my-store
   pnpm watch /tmp/my-store
   ```

   `pnpm watch` trusts and turns on your mod in that store, then reloads it each time you save. Leave it running.

2. In a second terminal, start `codex` on the scratch store:

   ```sh
   OMD_MODE=omd OMD_MOD_STORE=/tmp/my-store ~/.local/share/oh-my-diff/current/prefix/artifacts/codex
   ```

   `OMD_MODE=omd` turns on the mod host and `OMD_MOD_STORE` names the store it reads. The `codex` command OMD
   installs always sets both to your real store, so this step starts the binary directly.

   On a fresh Codex home, `codex` asks you to sign in. A mod's commands need no model, so you can skip signing in
   by pointing `codex` at a local address that never answers:

   ```sh
   OMD_MODE=omd OMD_MOD_STORE=/tmp/my-store ~/.local/share/oh-my-diff/current/prefix/artifacts/codex \
     -c model_provider=offline \
     -c 'model_providers.offline={name="offline",base_url="http://127.0.0.1:9/v1",wire_api="responses"}'
   ```

3. Type `/hello`. You see `Hello world`.

   `/my_mod:hello` always works too. The command popup shows that form instead when another mod or a built-in
   command uses the name `hello`.

4. In `index.ts`, change `Hello` to `Hi` and save. In `codex`, open `/omd` and choose **Reload mods**, then type
   `/hello` again. You see `Hi world`. In `mod.test.json`, change `Hello author` to `Hi author` so `pnpm test`
   passes again.

When you're done, stop `pnpm watch` and `codex`.

## 5. Install it

Install the mod in your real store. From the `my_mod` folder, go up one level and install it:

```sh
cd ..
omd install ./my_mod
omd mods enable my_mod
```

Each command shows what the mod can do and asks `Proceed? [y/N]`. The mod runs from your next message in `codex`.

A folder install runs the folder itself. After any edit to it, even whitespace, the mod stops until you review it
again:

```sh
omd mods update my_mod
```

Until then, `omd-mod status STORE` lists the mod under `rejected` as `untrusted_source`. `STORE` is your mod store,
`~/.local/share/oh-my-diff/stores/full` for OMD+ or `~/.local/share/oh-my-diff/stores/platform` for OMD Core. To install a fixed version
instead, publish the mod and install that.

## If something goes wrong

| Problem | Fix |
| --- | --- |
| A test or command fails | The error names the line in `index.ts`. `omd mods list` shows why a mod failed in the last session. |
| `capability_denied` | The mod used a permission it didn't ask for. Add it to `capabilities` in `mod.json`, or run `omd-mod-author explain 'capability_denied: exec'` for the cause. |
| The mod breaks `codex` | Run `omd mods disable my_mod` from any shell. |

More fixes are in [Troubleshooting](../troubleshooting.md).

## Next steps

- [Build a notes mod](notes-mod.md): a second tutorial with tools, saved state and a line on screen.
- [Run and debug a mod](run-and-debug.md) and [test a mod](test-a-mod.md).
- [Publish a mod](publish-a-mod.md) so others can install it.
- Read working examples: `omd-mod-author examples ./examples` copies the 15 that ship with the author tools. The
  rest are in [`mods/examples`](https://github.com/dzkchen/oh-my-diff/tree/main/mods/examples) on GitHub. Six have a
  README, and only `snapshot_review` ships with the tools: [`approval_desk`](../../mods/examples/approval_desk/README.md), [`box_model`](../../mods/examples/box_model/README.md),
  [`client_tag`](../../mods/examples/client_tag/README.md),
  [`external_client`](../../mods/examples/external_client/README.md),
  [`raster_wave`](../../mods/examples/raster_wave/README.md) and
  [`snapshot_review`](../../mods/examples/snapshot_review/README.md).
- The [mod API reference](../../mods/reference/README.md) lists every operation, event, view field and layout component.
