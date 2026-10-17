# Approval desk example

Shares approval history between the terminal and attached external clients over the client protocol (`omd-client/1`). An independent-author API `0.2.0-experimental.5` mod plus a client adapter. It's unrelated to `external_client` and can run beside it.

## What it shows

- **Middleware:** `approval` records every request (command, files or host) and returns null, so the native decision is unchanged. `approval_result` records the decision and its source, with a `terminal.notice` toast.
- **Wrapped sidebar:** the `terminal` handler wraps the sidebar (`mode: 'wrap'` with a `slot`), so another mod's sidebar stays below it. It holds:
  - a `multiselect` of approval kinds (`Alt+k` focuses it, Space toggles, Enter applies)
  - a controlled `input` note
  - a `list` of requests and decisions (Enter inspects one)
  - a line with an OSC 8 link, and the inspected request's details
- **Client adapter:** `client.mjs` connects with a GUI-shaped renderer (`svg`, `png`, `cells`, pixel pointer) and resumes every loaded thread. It answers `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` with `APPROVAL_DESK_DECISION` (`decline` by default), and prints one JSON line per view, approval and unsupported component.

## Try it

1. Grant `terminal`, `commands`, `approvals`, `middleware` and `store`.
2. Start a host: `codex app-server --listen unix:///abs/omd.sock` or `codex --listen unix:///abs/omd.sock`.
3. Run the client:

```sh
APPROVAL_DESK_URL=unix:///abs/omd.sock node client.mjs
```

## Test it

`mod.test.json` runs offline: two approval requests, one decision, a kinds filter, a note and an inspect.

```sh
python3 scripts/mod_host_check.py --omd-mod <omd-mod> --no-commands --scenarios approval_desk
```

`scripts/client_acceptance.py` runs the client against real hosts.
