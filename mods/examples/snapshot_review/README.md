# snapshot_review

Captures a frozen copy of the workspace, checks it in a sandbox, has a separate read-only agent inspect it, and
keeps the contract receipts across a restart. It's an example for mod authors. OMD+ and OMD Core don't install it,
and it isn't in the curated directory.

Read it if you're building a mod that uses [contracts](../../reference/contracts.md),
[receipts](../../reference/contracts.md#receiptssubmit) or read-only [agents](../../reference/agents.md).

It's an API `1.0.0` mod that uses only the public mod API, like any outside author's mod
([host primitives](../../reference/host-model.md#host-primitives)). It loads no first-party mod and defines its own
schema-2 contract, `snapshot_review@1`. It shows:

- The check reads frozen source, can't read the parent source by absolute path, and writes only inside its disposable
  workspace. The mod's receipt is based on the result the host recorded.
- A read-only agent gets preserved tool history and the selected snapshot.
- While the mod's scoped restriction is in place, agents that can write are blocked, and the read-only inspection still
  runs.

## Install it

From a checkout of this repository:

```sh
omd install ./mods/examples/snapshot_review
omd mods enable snapshot_review
```

Grant `agents`, `contracts`, `exec`, `fs.read`, `fs.write`, `lifecycle`, `sessions`, `sessions_tools`, `store` and
`tools`. See [Manage mods](https://github.com/dzkchen/oh-my-diff/blob/main/docs/manage-mods.md) for the other ways to
install mods, and [Trust and permissions](https://github.com/dzkchen/oh-my-diff/blob/main/docs/trust-and-permissions.md)
for what a grant allows.

## Use it

1. Select the `snapshot_review@1` contract.
2. Set `denied_source` (see below).
3. Add a model route named `inspector` to `host.json`.
4. In an [`OMD_MODE=omd`](../../reference/host-model.md#omd_mode) session with no first-party mods turned on, have
   the agent call its tools:
   - `capture`: snapshot the workspace, run the check, submit a command receipt and restrict writable agents.
   - `start` and `finish`: run the read-only inspection, then submit its receipt.
   - `fail`, `failed` and `failure_event`: start an agent on a fixture route that returns a transport error, then
     verify the structured failure through `agents.wait` and `agent_end`.
   - `complete`: after a restart, verify the saved receipts, restriction and allowance, then request completion.

### Test it

`mod.test.json` runs offline and checks that `start` before `capture` fails with `capture_first`.

```sh
python3 scripts/mod_host_check.py --no-commands --scenarios snapshot_review
```

It uses the `omd-mod` on your `PATH`. [Tests](../../../tests/README.md) covers the other test runners.

## Settings

Change settings in `/mods`.

| Setting | Default | What it does |
| --- | --- | --- |
| `denied_source` | empty | An absolute path outside the workspace. The check must fail to read it. |

## Needs and limits

- It needs a model route named `inspector`.
- It's a local demonstration, not a check of model quality or a real provider.

## More

- [Agents reference](../../reference/agents.md) and [contracts reference](../../reference/contracts.md)
- [Running commands reference](../../reference/running-commands.md) and
  [workspace files reference](../../reference/workspace-files.md)
