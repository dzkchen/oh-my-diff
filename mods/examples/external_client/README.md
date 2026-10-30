# external_client

Shows a mod that owns its client adapter: a text renderer process that joins the session over the client protocol
(`omd-client/1`) with the SDK in `@oh-my-diff/mod-api/client`. It's an example for mod authors. It isn't in the
bundled collection or the curated directory.

It's an independent-author API `1.0.0` mod. It shows:

- Roster view: the `terminal` handler lists attached clients from `input.clients` in the `external_clients` list.
  `Space` or `Enter` on a row, or `omd/action` from a client, runs `external_client:pick` with that client's id.
- Rich components: a status text, an 8×1 `raster` drawn once by a timer with `terminal.blit` (experimental), and
  an SVG `image` written with `evidence.write` on `start`. The terminal shows the image's alt text.
- Pointer source: a press on the badge records `component_event.client`, so the status text names the client
  that clicked.
- Launching a process: slash commands can't start processes, so `launch` hops through `events.publish` to the
  mod's `channel` handler. It finds `node` with `process.which` and starts `node <client_path>` with
  `process.start {sandbox: 'none'}` under the `os` grant (`os_access.programs: ['node']`, network on for `ws://`).
  The URL and token file path arrive as `EXTERNAL_CLIENT_URL` and `EXTERNAL_CLIENT_AUTH_FILE` (both in
  `exec_environment`), so the mod never sees the token.
- The client: `client.mjs` connects with `kind: 'text'` and prints to stderr, since a process the mod starts
  uses stdout for framed messages. It prints each `omd/view/updated` snapshot as text (components it can't show
  become the SDK's `unsupported()` error plus fallback text), sends one action on its own roster row, and prints the
  result. The SDK re-attaches after a disconnect.

## Install it

From a checkout of this repository:

```sh
omd install ./mods/examples/external_client
omd mods enable external_client
```

Grant `terminal`, `commands`, `lifecycle`, `events`, `store`, `exec` and `os`. See
[Manage mods](../../../docs/manage-mods.md) for the other ways to install mods, and
[Trust and permissions](../../../docs/trust-and-permissions.md) for what a grant allows.

## Use it

1. Start a host with a listener:
   - TUI co-attach: `codex --listen ws://127.0.0.1:4500 --ws-auth capability-token --ws-token-file /abs/token`
   - Headless: `codex app-server --listen unix:///abs/omd.sock`
2. Set the mod's settings (see below).
3. Run its `launch` command.

Or run the client directly from this folder:

```sh
EXTERNAL_CLIENT_URL=unix:///abs/omd.sock node client.mjs
```

### Test it

`mod.test.json` runs offline: `start` writes the badge, `launch` publishes the hop, the channel handler starts the
process, a pick and a pointer press update state, and the view lists one attached text client.

```sh
python3 scripts/mod_host_check.py --omd-mod OMD_MOD --no-commands --scenarios external_client
```

`OMD_MOD` is the path to an `omd-mod` built from the applied runtime patch. Without `--omd-mod`, the check uses
the `omd-mod` on your `PATH`.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `listen_url` | empty | The host's listener URL, for example `ws://127.0.0.1:4500` or `unix:///abs/omd.sock`. |
| `token_file` | empty | The capability token file. Leave it empty for `unix://`. |
| `client_path` | empty | Absolute path of this `client.mjs`, inside a project that depends on `@oh-my-diff/mod-api`. |

## Needs and limits

- The client needs `node` on `PATH`. The mod starts it outside the sandbox under the `os` grant.
- The terminal shows the SVG badge as alt text only.
- `terminal.blit` is experimental.

## More

- [External clients reference](../../reference/external-clients.md)
- [Managed processes reference](../../reference/managed-processes.md)
- [`omd-client/1` protocol reference](../../reference/omd-client-protocol.md)
- [Terminal UI reference](../../reference/terminal-ui.md)
