# approval_desk

Shares approval history between the terminal and attached external clients over the client protocol
(`omd-client/1`). It's an example for mod authors. It isn't in the bundled collection or the curated directory.

It's an independent-author API `1.0.0` mod plus a client adapter, unrelated to `external_client`, and can run beside
it. It shows:

- Middleware: `approval` records every request (command, files or host) and returns null, so the native decision
  is unchanged. `approval_result` records the decision and its source, with a `terminal.notice` toast.
- Wrapped sidebar: the `terminal` handler wraps the sidebar (`mode: 'wrap'` with a `slot`), so another mod's
  sidebar stays below it. It holds:
  - a `multiselect` of approval kinds (`Alt+k` focuses it, `Space` toggles, `Enter` applies)
  - a controlled `input` note
  - a `list` of requests and decisions (`Enter` inspects one)
  - a line with an OSC 8 link, and the inspected request's details
- Client adapter: `client.mjs` connects with a GUI-shaped renderer (`svg`, `png`, `cells`, pixel pointer) and
  resumes every loaded thread. It answers `item/commandExecution/requestApproval` and
  `item/fileChange/requestApproval` with `APPROVAL_DESK_DECISION` (`decline` by default). It prints one JSON line per
  event: `ready`, `roster`, `desk` (one per view), `approval`, `mirrored`, `resolved`, `unsupported` (one per
  component it can't draw) and `error`.

## Install it

From a checkout of this repository:

```sh
omd install ./mods/examples/approval_desk
omd mods enable approval_desk
```

Grant `terminal`, `commands`, `approvals`, `middleware` and `store`. See [Manage mods](../../../docs/manage-mods.md)
for the other ways to install mods, and [Trust and permissions](../../../docs/trust-and-permissions.md) for what a
grant allows.

## Use it

1. Start a host: `codex app-server --listen unix:///abs/omd.sock` or `codex --listen unix:///abs/omd.sock`.
2. Run the client from this folder:

   ```sh
   APPROVAL_DESK_URL=unix:///abs/omd.sock node client.mjs
   ```

### Test it

`mod.test.json` runs offline: two approval requests, one decision, a kinds filter, a note and an inspect.

```sh
python3 scripts/mod_host_check.py --omd-mod OMD_MOD --no-commands --scenarios approval_desk
```

`OMD_MOD` is the path to an `omd-mod` built from the applied runtime patch. Without `--omd-mod`, the check uses
the `omd-mod` on your `PATH`.

`scripts/client_acceptance.py` runs the client against real hosts.

## Settings

It has no settings.

## Needs and limits

- The client needs Node and a project that depends on `@oh-my-diff/mod-api`.
- It's a demonstration of the client protocol, not a production approval tool.

## More

- [External clients reference](../../reference/external-clients.md)
- [App bridge and approvals reference](../../reference/app-bridge-and-approvals.md)
- [`omd-client/1` protocol reference](../../reference/omd-client-protocol.md)
- [Terminal UI reference](../../reference/terminal-ui.md)
