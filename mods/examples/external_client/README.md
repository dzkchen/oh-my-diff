# External client example

Shows a mod that owns its client adapter: a text renderer process that joins the session over the client protocol (`omd-client/1`) with the SDK in `@oh-my-diff/mod-api/client`. An independent-author API `1.0.0` mod.

## What it shows

- **Roster view:** the `terminal` handler lists attached clients from `input.clients` in the `external_clients` list. Space or Enter on a row, or `omd/action` from a client, runs `external_client:pick` with that client's id.
- **Rich components:** a status line, an 8×1 `raster` drawn once by a timer with `terminal.blit` (experimental), and an SVG `image` written with `evidence.write` on `start`. The terminal shows the image's alt text.
- **Pointer source:** a press on the badge records `component_event.client`, so the status line names the client that clicked.
- **Launching a process:** slash commands can't start processes, so `launch` hops through `events.publish` to the mod's `channel` handler. It finds `node` with `process.which` and starts `node <client_path>` with `process.start {sandbox: 'none'}` under the `os` grant (`os_access.programs: ['node']`, network on for `ws://`). The URL and token file path arrive as `EXTERNAL_CLIENT_URL` and `EXTERNAL_CLIENT_AUTH_FILE` (both in `exec_environment`), so the mod never sees the token.
- **The client:** `client.mjs` connects with `kind: 'text'` and prints to stderr, since a process the mod starts uses stdout for framed messages. It prints each `omd/view/updated` snapshot as text (components it can't show become the SDK's `unsupported()` error plus fallback text), sends one action on its own roster row, and prints the result. The SDK re-attaches after a disconnect.

## Try it

1. Start a host with a listener:
   - TUI co-attach: `codex --listen ws://127.0.0.1:4500 --ws-auth capability-token --ws-token-file /abs/token`
   - Headless: `codex app-server --listen unix:///abs/omd.sock`
2. Set the mod's `listen_url`, `token_file` (empty for `unix://`) and `client_path` (the absolute path of this `client.mjs`, inside a project that depends on `@oh-my-diff/mod-api`).
3. Grant `terminal`, `commands`, `lifecycle`, `events`, `store`, `exec` and `os`.
4. Run its `launch` command.

Or run the client directly:

```sh
EXTERNAL_CLIENT_URL=unix:///abs/omd.sock node client.mjs
```

## Test it

`mod.test.json` runs offline: `start` writes the badge, `launch` publishes the hop, the channel handler starts the process, a pick and a pointer press update state, and the view lists one attached text client.

```sh
python3 scripts/mod_host_check.py --omd-mod <omd-mod> --no-commands --scenarios external_client
```
