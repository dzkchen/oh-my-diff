# Frozen snapshot review example

This independent-author API `0.2.0-experimental.1` fixture demonstrates reusable snapshot capture, sandboxed commands, full visible parent history, selected tool-history evidence, structured agent failures, argument-scoped restrictions and durable contract receipts and allowance. It loads no first-party mod and defines its own schema-2 contract.

Install it with `omd-mod`, grant its declared capabilities and a schema-2 contract selection, then invoke its command in an `OMD_MODE=omd` session with no first-party mods enabled. `failure` surfaces an HTTP 503 through both `agents.wait` and `agent_end`; `resume` restarts the session and completes from saved receipts, restrictions and consumed requests; `snapshot` runs the same inspection without a restart.

The captured command reads frozen source, rejects reading the parent source by absolute path, and writes generated output only inside its disposable workspace. Its host-recorded result attests a receipt. A read-only agent receives preserved tool history and the selected snapshot. A scoped restriction blocks writable agents while allowing inspection. These are local protocol and isolation checks, not model-quality, real-provider or release qualification.
