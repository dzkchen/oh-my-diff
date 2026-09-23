---
name: omd-final-review
description: Run OMD's native exact-candidate final review and report its real assurance without bypassing checks, reviewer separation, findings, or completion.
---

# OMD final review

Use the host-provided current candidate SHA256 only after implementation writes have stopped. Call the native `omd_review` tool with cadence `final`, the exact candidate SHA256, `stable: true`, and no risk.

The native host runs configured executable checks and the reviewer required by the selected workflow contract. It owns candidate capture, the findings ledger, shared limits, repair accounting, reviewer identity, drift invalidation, evidence, and approval. A separate reviewer is mandatory for `reviewed OMD v1`; `solo evidence v1` is visibly self-reviewed and never independent.

If checks fail, findings remain, evidence is stale, limits are exhausted, or the workspace changes, report the refusal and repair within authorized scope. Never relabel a self-review, suppress a finding, substitute an ordinary response for `omd_review`, or claim completion before the native completion gate accepts the same candidate.
