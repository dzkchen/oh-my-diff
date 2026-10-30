# Run and debug a mod

How to run a mod you're writing in a scratch store, reload it as you edit, find out why it fails, and measure what
it costs. For the full command list, see the [authoring reference](../../mods/reference/authoring.md).

## Run it in a scratch store

A scratch store is an empty mod store you create for testing, so your real mods and their data aren't touched.

1. Create the store:

   ```sh
   omd-mod init /tmp/my-store
   ```

2. From the mod's folder, load the mod and reload it on every save:

   ```sh
   pnpm watch /tmp/my-store
   ```

   `watch` inspects the folder, trusts its current version in the store, turns it on, queues a reload of any
   `codex` running on that store, and copies the store's type declarations into `.omd/`. A saved file reloads it
   again after 100 ms. Add `--once` to load it once and exit, for example in a build step.

3. In a second terminal, start `codex` on the store:

   ```sh
   OMD_MODE=omd OMD_MOD_STORE=/tmp/my-store ~/.local/share/oh-my-diff/current/prefix/artifacts/codex
   ```

   To skip signing in when you only try commands and views, add
   `-c model_provider=offline -c 'model_providers.offline={name="offline",base_url="http://127.0.0.1:9/v1",wire_api="responses"}'`.

A running `codex` picks up a reload at the next turn boundary. `/omd` > **Reload mods** reloads at once while no
turn is running.

Point `watch` only at a scratch store, and only at code you wrote or reviewed: it trusts whatever it watches. To try
the mod in your real store, [install it](publish-a-mod.md#install-it-from-a-folder) and review its permissions.

## Run commands without `codex`

`omd-mod` can call a command and run a test scenario against the store directly. With the scaffold's `/hello`:

```sh
omd-mod command /tmp/my-store my_mod hello '"you"'
omd-mod test /tmp/my-store mod.test.json
```

The first prints `{"display": "Hello you"}`: the last argument is the command's input as JSON.

Against a store, `omd-mod test` uses the store's settings and saved state instead of the scenario's `settings`. Set
the mod's settings in the store first, with the mod's folder and a JSON object, here for the
[notes mod](notes-mod.md):

```sh
omd-mod settings /tmp/my-store "$PWD" '{"max_notes":2}'
```

A mod with `state_scope: "thread"` needs a thread ID, or the call fails with `state_thread_unavailable`. Pass it
last: `omd-mod command STORE MOD NAME JSON THREAD`. `omd-mod test` takes a thread ID the same way.

## Find out why a mod fails

Inside `codex`, a failing mod shows in the **Mod errors** card above the prompt and in `/omd`. From a shell:

```sh
omd-mod status /tmp/my-store
omd mods list --store /tmp/my-store
omd-mod-author report /tmp/my-store
omd-mod-author events /tmp/my-store
```

- `omd-mod status` shows each mod's state, fault count and the host features it negotiated.
- `omd mods list` also says why a mod failed in the last session.
- `omd-mod-author report` compares the permissions `mod.json` declares with the ones the code uses.
- `omd-mod-author events` shows the order mods run in, the events each handles, and conflicts.

To explain a denial, pass its text to `explain`:

```sh
omd-mod-author explain 'capability_denied: exec'
```

It prints the cause, the fix and what tooling can't do for you.

Errors you may see while writing a mod:

| Error | Cause |
| --- | --- |
| `capability_denied` | The code used a permission missing from `capabilities` in `mod.json` |
| `conflict: NAME` | `activate` registered the same command, handler, timer or component name twice |
| `undeclared_environment_use: process` | The source contains `process.` outside a string, or `window.` or `document.` anywhere |
| `unsupported_import` | An import other than types from `@oh-my-diff/mod-api` or a declared asset |
| `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` | `enum`, a namespace with values or a constructor parameter property; `pnpm check` reports them first |

Five failed callbacks in a row in one host process turn a mod off. `/omd` > **Reload mods** brings it back. See the
[fault limit](../../mods/reference/host-model.md#fault-limit).

## Share a bug report

`diagnostics` writes a JSON bundle you can attach to an issue. It removes paths, settings, environment values and
credentials:

```sh
omd-mod-author diagnostics /tmp/my-store /tmp/my-mod-diagnostics.json
```

## Measure what a mod costs

`cost` installs the package alone in a new scratch store and measures it in the real host. From the mod's folder:

```sh
omd-mod-author cost . hello '"you"' --runs 10
```

The command name and its JSON input are optional; without them, only activation and the first render are timed.
The output reports `activation_ms`, `first_render_ms`, `fresh_callback_ms`, `reused_callback_ms`, `runners` and
`runner_peak_footprint_bytes`. Each timing has `first`, `p50` and `p95`. Compare `p50` between versions: `first`
includes a cold code cache. See the [cost report reference](../../mods/reference/authoring.md#cost-report) for what
each field measures.

## Run the author tools from a source checkout

Without an OMD install, run `omd-mod-author` from a checkout of this repository and point it at an `omd-mod` binary
from a release archive. Run these in the shell you work in:

```sh
pnpm --dir mods install
export OMD_MOD_BIN=/absolute/path/to/omd-mod
omd-mod-author() { node /absolute/path/to/checkout/mods/author/cli.mjs "$@"; }
```

Use the `omd` and `codex` binaries from the same archive. Node prints an `ExperimentalWarning` for
`stripTypeScriptTypes` on each command. It's harmless.

## See also

- [Test a mod](test-a-mod.md)
- [Troubleshooting](../troubleshooting.md) for problems with an installed mod
- [Commands](../commands.md): which of `omd`, `omd-package`, `omd-mod` and `omd-mod-author` to use
