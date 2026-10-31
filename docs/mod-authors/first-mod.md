# Write your first mod

This tutorial builds a mod with a `/hello` command, tests it offline, runs it in `codex` and installs it. It's for
anyone who has OMD installed and knows a little TypeScript.

A mod is a small TypeScript package that runs inside OMD. It can add commands and tools, change what the model sees,
and draw on screen.

## Before you begin

You need:

- OMD [installed](../install.md), either OMD+ or OMD Core.
- Node 24.18 or a later 24.x. Only `omd-mod-author`, the author tool OMD installs, uses Node. Mods run in OMD's own
  runtime.
- [pnpm](https://pnpm.io) 11.14 or later.

[Support](../support.md) lists the supported versions of each tool.

Check them:

```sh
command -v omd-mod-author omd-mod omd
node --version
pnpm --version
```

The first command prints three paths. If it prints fewer, OMD isn't installed. `omd-mod-author` creates and tests
mods, `omd-mod` works on a mod store directly, and `omd` installs mods and turns them on.

## 1. Create the mod

```sh
omd-mod-author create ./my_mod my_mod
cd my_mod
```

The second argument is the mod's id: lowercase letters, digits and `_`, up to 24 characters. `create` prints nothing
when it succeeds. It also runs `pnpm install`, so the folder has `node_modules` and `pnpm-lock.yaml` next to these
files:

- `index.ts`: the code.
- `mod.json`: the mod's id, version, API version and the permissions it asks for, which OMD calls
  [capabilities](../../mods/reference/glossary.md#trust-and-authority). The scaffold asks only for `commands`.
- `mod.test.json`: an offline test that runs `/hello` with the argument `author`.
- `debug.test.json`: a test that expects an error, so you can see how errors look.
- `package.json` and `tsconfig.json`: the `pnpm` scripts and TypeScript settings.

`index.ts` registers a `/hello` command:

```ts
import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.command('hello', input => {
    if (input === 'fail') throw new Error('INTENTIONAL_AUTHOR_FAILURE');
    return { display: `Hello ${String(input || 'world')}` };
  }, { description: 'Confirm the scaffold is running' });
}
```

`/hello` prints `Hello` and its argument, or `Hello world` without one. With the argument `fail`, it throws an error
for `debug.test.json` to catch.

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

The test runs offline and never calls a model. It prints a long JSON report and exits with status 0. The report
contains `"paid_requests": 0`, and in its `steps` list the first step's `value` is the command's result:

```json
"value": {
  "display": "Hello author"
}
```

The test passed `author` as the argument, so the command printed `Hello author`. `pnpm test` also runs the type
check, so a type error fails it.

To see how a failure looks, run `pnpm debug`. It runs `debug.test.json`, which passes `fail` to `/hello` and expects
the error. It exits with status 0, and the step's `error` field contains `INTENTIONAL_AUTHOR_FAILURE` and where it was
thrown: `index.ts`, line 5, and a column.

## 4. Try it in `codex`

A mod store is the folder where OMD keeps installed mods, the permissions you granted them, their settings and their
saved data. Your install has one. A scratch store is an empty one you create for testing and delete afterwards. Try
the mod in a scratch store, so your real mods aren't touched.

1. Create a scratch store and load the mod into it:

   ```sh
   omd-mod init /tmp/my-store
   pnpm watch /tmp/my-store
   ```

   `pnpm watch` trusts and turns on your mod in that store, then reloads it each time you save. Each load prints a
   line that starts with `{"reloaded":`. Leave it running.

2. In a second terminal, start `codex` on the scratch store:

   ```sh
   OMD_MODE=omd OMD_MOD_STORE=/tmp/my-store ~/.local/share/oh-my-diff/current/prefix/artifacts/codex
   ```

   [`OMD_MODE=omd`](../../mods/reference/host-model.md#omd_mode) turns on the mod host and `OMD_MOD_STORE` names
   the store it reads. The `codex` command that OMD installs always turns on the mod host with your real store, so
   this step starts the OMD `codex` binary directly.

   If you have never signed in to Codex, `codex` asks you to sign in. Sign in, or skip it: a mod's commands need no
   model, so you can use the offline flags in [Run it in a scratch store](run-and-debug.md#run-it-in-a-scratch-store).

3. Type `/hello`. You see `Hello world`.

   `/my_mod:hello` always works too. The command popup shows that form instead when another mod or a built-in
   command uses the name `hello`.

4. In `index.ts`, change `Hello` to `Hi` and save. `pnpm watch` reloads the mod, and a running `codex` picks up the
   reload between turns. To see it now, open `/omd` in `codex` and choose **Reload mods**, then type `/hello` again.
   You see `Hi world`. In `mod.test.json`, change `Hello author` to `Hi author` so `pnpm test` passes again.

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

Until then, `omd-mod status STORE` lists the mod under `rejected` as `untrusted_source`. `STORE` is the path of your
mod store, listed under [`omd-mod`](../commands.md#omd-mod) in Commands. To install a fixed version instead, share
the mod through Git or npm and install that.

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
- [Install, share and update a mod](publish-a-mod.md) so others can install it.
- Read working examples. `omd-mod-author examples ./examples` copies the 15 examples that ship with the author
  tools. The rest are in [`mods/examples`](https://github.com/dzkchen/oh-my-diff/tree/main/mods/examples) on
  GitHub. Six examples have a README:
  [`approval_desk`](../../mods/examples/approval_desk/README.md),
  [`box_model`](../../mods/examples/box_model/README.md),
  [`client_tag`](../../mods/examples/client_tag/README.md),
  [`external_client`](../../mods/examples/external_client/README.md),
  [`raster_wave`](../../mods/examples/raster_wave/README.md) and
  [`snapshot_review`](../../mods/examples/snapshot_review/README.md). Of those six, only `snapshot_review` ships
  with the author tools.
- The [mod API reference](../../mods/reference/README.md) lists every operation, event, view field and layout
  component.
