# Snapshot review example

Captures a frozen copy of the workspace, checks it in a sandbox, has a separate read-only agent inspect it, and keeps the contract receipts across a restart. It's an independent-author API `1.0.0` mod that loads no first-party mod and defines its own schema-2 contract, `snapshot_review@1`.

## Try it

1. Install it with `omd-mod` and grant its declared capabilities.
2. Select the `snapshot_review@1` contract.
3. Set `denied_source` to an absolute path outside the workspace. The check must fail to read it.
4. Add a model route named `inspector` to `host.json`.
5. In an `OMD_MODE=omd` session with no first-party mods enabled, have the agent call its tools:
   - `capture`: snapshot the workspace, run the check, submit a command receipt and restrict writable agents.
   - `start` and `finish`: run the read-only inspection, then submit its receipt.
   - `fail`, `failed` and `failure_event`: start an agent on a fixture route that returns a transport error, then verify the structured failure through `agents.wait` and `agent_end`.
   - `complete`: after a restart, verify the saved receipts, restriction and allowance, then request completion.

## What it shows

- The check reads frozen source, can't read the parent source by absolute path, and writes only inside its disposable workspace. The host-recorded result backs a receipt.
- A read-only agent gets preserved tool history and the selected snapshot.
- A scoped restriction blocks writable agents but allows inspection.

It's a local demonstration, not a check of model quality or a real provider.
