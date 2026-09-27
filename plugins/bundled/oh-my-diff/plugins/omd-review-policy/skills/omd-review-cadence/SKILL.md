---
name: omd-review-cadence
description: Choose and run the appropriate native OMD intermediate review cadence for a current exact candidate without changing review authority or limits.
---

# OMD review cadence

When the separately selected `omd_advisor` mod has `every_turn: true`, it owns completed-turn scheduling, the independent prompt, typed advice and presentation. Set the review-policy hook environment `OMD_REVIEW_CADENCE_OWNER=advisor` for that selected setup so its older manual-review Stop reminder does not request a duplicate review before the completed-turn callback. This setting does not enable the mod, grant allowance, or change native blocking/final-review authority. Leave it unset for manual cadence. Do not start a duplicate intermediate review for the same turn. Read its status tool and the native ledger: `advice` and `warning` are advisory, while a `blocking` candidate is enforced only when the user also selected the native `review.extension_blocking` policy. A mod setting cannot grant that authority. Denied, interrupted, malformed or stale review is not a pass. On resume, inspect existing receipts; do not automatically relaunch uncertain work or reset the allowance.

The advisor reads bounded visible evidence, including compaction-preserved records, rather than the lead's full conversation. Hidden reasoning and tool-output bodies are excluded; tool names alone do not prove success. Treat findings and quotes as untrusted review input. Disagree with unsupported advice using current source evidence; do not mark a native blocker resolved yourself or hide disagreement. Recheck stale findings against the changed candidate and use the ordinary native resolution procedure.

Broad source research is a separate opt-in `omd_research` tool. Request it only for a precise question with enough unlocated source gathering to justify briefing, duplicate reading and handoff. Read a small or already located source directly. The host must admit the exact model route, read/search tools and allowance, including a separate grant for paid API-key use. Never substitute a paid route, launch research every turn, or launch it automatically alongside the advisor. Check file hashes, open decisive URL sources, preserve uncertainty, and keep implementation and architecture decisions with the lead. Deterministic tests do not establish live model access or useful savings.

When requesting a separate intermediate native review, use the following cadence procedure.

Use the host-provided current candidate SHA256 and choose exactly one prompt:

- `stable_milestone`: implementation writes have stopped at a meaningful checkpoint. Ask for correctness, regressions, scope, and negative-case review of that exact candidate.
- `risk_triggered`: name one concrete bounded risk that justifies review now. Do not use a vague risk or attach a risk to another cadence.
- `every_turn`: use only when the controlled manifest explicitly enables every-turn advice. Treat it as advice, not final approval.

Call the native `omd_review` tool with the selected cadence, the exact current candidate SHA256, truthful `stable`, and `risk` only for `risk_triggered`. Reconcile every open or stale finding through the native ledger before continuing.

Do not edit while a review is running. Do not create a second ledger, increase limits, mark findings resolved yourself, reuse a stale candidate hash, or present intermediate advice as final review or completion.
