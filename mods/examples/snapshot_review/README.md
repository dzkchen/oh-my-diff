# Frozen snapshot review example

Demonstrates snapshot capture, sandboxed commands, agent failures, scoped restrictions and saved contract receipts. It's an independent-author API `0.2.0-experimental.5` example that loads no first-party mod and defines its own schema-2 contract.

## Try it

1. Install it with `omd-mod`.
2. Grant its declared capabilities and a schema-2 contract selection.
3. In an `OMD_MODE=omd` session with no first-party mods enabled, run its command:
   - `failure` surfaces an HTTP 503 through both `agents.wait` and `agent_end`.
   - `resume` restarts the session and completes from saved receipts, restrictions and consumed requests.
   - `snapshot` runs the same inspection without a restart.

## What it shows

- The captured command reads frozen source, rejects reading the parent source by absolute path, and writes output only inside its disposable workspace. The host-recorded result attests a receipt.
- A read-only agent gets preserved tool history and the selected snapshot.
- A scoped restriction blocks writable agents but allows inspection.

It's a local demonstration, not a model-quality or real-provider check.
