---
name: omd-final-review
description: Complete OMD's mod-owned exact-candidate review and verification under the user-selected host-enforced contract.
---

# OMD final review

After implementation writes stop, run `mod_omd_workflow_check`. Under `reviewed_omd@1`, request `mod_omd_workflow_review` with `kind: "final_review"`, then advance it to a passing independent receipt. Repeat with `kind: "adversarial_verification"`. Under `solo_evidence@1`, use `mod_omd_workflow_self_verify` for evidence-backed self-review and self-verification; report its assurance as self-reviewed, never independent.

Record source-backed assessments for every immutable acceptance criterion with `mod_omd_workflow_acceptance`, then request `mod_omd_workflow_complete`. The host enforces the selected contract, candidate and acceptance digests, reviewer identity, evidence and shared ledger limits. The mod owns orchestration; it cannot silently weaken the contract.

A failed check, blocking finding, missing receipt, exhausted allowance or candidate drift requires explicit repair and current evidence. Do not substitute an ordinary response for accepted completion, hide disagreement, claim independent verification from self-review, or relaunch interrupted work automatically.
