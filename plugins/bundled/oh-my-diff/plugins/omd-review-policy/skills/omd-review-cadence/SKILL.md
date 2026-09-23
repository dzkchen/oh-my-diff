---
name: omd-review-cadence
description: Choose and run the appropriate native OMD intermediate review cadence for a current exact candidate without changing review authority or limits.
---

# OMD review cadence

Use the host-provided current candidate SHA256 and choose exactly one prompt:

- `stable_milestone`: implementation writes have stopped at a meaningful checkpoint. Ask for correctness, regressions, scope, and negative-case review of that exact candidate.
- `risk_triggered`: name one concrete bounded risk that justifies review now. Do not use a vague risk or attach a risk to another cadence.
- `every_turn`: use only when the controlled manifest explicitly enables every-turn advice. Treat it as advice, not final approval.

Call the native `omd_review` tool with the selected cadence, the exact current candidate SHA256, truthful `stable`, and `risk` only for `risk_triggered`. Reconcile every open or stale finding through the native ledger before continuing.

Do not edit while a review is running. Do not create a second ledger, increase limits, mark findings resolved yourself, reuse a stale candidate hash, or present intermediate advice as final review or completion.
