---
name: omd-review-cadence
description: Choose and run OMD mod-owned intermediate review without changing selected contract authority or limits.
---

# OMD review cadence

When the separately selected `omd_advisor` mod has `every_turn: true`, it owns completed-turn scheduling and presentation. Select `OMD_REVIEW_CADENCE_OWNER=advisor` to suppress duplicate manual reminders. This does not activate a mod, grant allowance or change the selected contract. Advisory findings do not constitute final approval. Blocking advisor findings require a user-selected contract requiring `advisor_review` from a separate agent.

For manual cadence, choose a reason before requesting `mod_omd_workflow_review` with `kind: "milestone_review"`:

- `stable_milestone`: writes have stopped at a meaningful checkpoint.
- `risk_triggered`: one concrete risk justifies review now.
- `every_turn`: the plugin configuration explicitly selects every-turn review.

Call `mod_omd_workflow_advance` until the owned review produces a receipt or reports failure. Do not edit while review is running. Inspect the exact candidate, receipt and findings; failed, interrupted, malformed or stale reviews are not passes. The generic host owns evidence identity, the request ledger and limits; the workflow mod owns prompts and cadence. Candidate drift invalidates prior completion evidence.

The plugin runs in `OMD_MODE=omd`. Its optional configuration is `$OMD_MOD_STORE/plugin-config/omd-review-policy.json`, or the explicit `OMD_REVIEW_CONFIG` path. `capabilities.unified_review: true` and `review.every_turn_advice: true` select its Stop reminder; installation alone selects neither. The reminder observes successful workflow review receipts and does not replace the host contract gate. A broken or disabled workflow must be recovered explicitly; never fabricate a receipt to satisfy the reminder.

Broad research remains the separately invoked `omd_research` tool. Use it only when source gathering justifies briefing and handoff, preserve source references and uncertainty, and keep implementation decisions with the lead. No automatic research or paid fallback is authorized. On resume, inspect receipts and interrupted workers without resetting allowance or relaunching uncertain work.
