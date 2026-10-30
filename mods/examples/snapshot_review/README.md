# snapshot_review

Captures a frozen copy of the workspace, checks it in a sandbox, has a separate read-only agent inspect it, and
keeps the contract receipts across a restart. It's an example for mod authors. It isn't in the bundled collection or
the curated directory.

It's an independent-author API `1.0.0` mod that loads no first-party mod and defines its own schema-2 contract,
`snapshot_review@1`. It shows:

- The check reads frozen source, can't read the parent source by absolute path, and writes only inside its
  disposable workspace. The host-recorded result backs a receipt.
- A read-only agent gets preserved tool history and the selected snapshot.
- A scoped restriction blocks writable agents but allows inspection.

## Install it

From a checkout of this repository:

```sh
omd install ./mods/examples/snapshot_review
omd mods enable snapshot_review
```

Grant `agents`, `contracts`, `exec`, `fs.read`, `fs.write`, `lifecycle`, `sessions`, `sessions_tools`, `store` and
`tools`. See [Manage mods](https://github.com/dzkchen/oh-my-diff/blob/main/docs/manage-mods.md) for the other ways to install mods, and
[Trust and permissions](https://github.com/dzkchen/oh-my-diff/blob/main/docs/trust-and-permissions.md) for what a grant allows.

## Use it

1. Select the `snapshot_review@1` contract.
2. Set `denied_source` (see below).
3. Add a model route named `inspector` to `host.json`.
4. In an `OMD_MODE=omd` session with no first-party mods turned on, have the agent call its tools:
   - `capture`: snapshot the workspace, run the check, submit a command receipt and restrict writable agents.
   - `start` and `finish`: run the read-only inspection, then submit its receipt.
   - `fail`, `failed` and `failure_event`: start an agent on a fixture route that returns a transport error, then
     verify the structured failure through `agents.wait` and `agent_end`.
   - `complete`: after a restart, verify the saved receipts, restriction and allowance, then request completion.

### Test it

`mod.test.json` runs offline and checks that `start` before `capture` fails with `capture_first`.

```sh
python3 scripts/mod_host_check.py --omd-mod OMD_MOD --no-commands --scenarios snapshot_review
```

`OMD_MOD` is the path to an `omd-mod` built from the applied runtime patch. Without `--omd-mod`, the check uses
the `omd-mod` on your `PATH`.

## Settings

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
