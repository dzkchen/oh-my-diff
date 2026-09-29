# Independent turn advisor

`omd_advisor` is an opt-in API `0.2.0-experimental.1` mod. It owns cadence, evidence selection, reviewer prompts, typed findings, citation validation, duplicate suppression and presentation. Generic host operations own isolated agents, permissions, allowance, snapshots and contract receipts.

Full installs the package inactive. Enabling it leaves `every_turn: false`; select `every_turn: true` and an available, explicitly authorized worker `route` to review completed lead turns. No setting grants model access or allowance. Reviewers receive a bounded visible turn excerpt and a frozen candidate, with no tools or parent history. Hidden reasoning and tool-output bodies are excluded. The mod reads at most 48 KiB of evidence, selects a 6 KiB excerpt and accepts at most eight findings with exact supporting quotes.

`mode: advisory` converts blocking proposals to warnings. `mode: blocking` requires the user to select a contract whose completion gate requires a separate-agent `advisor_review` receipt and rejects blocking findings. The mod cannot select that contract or weaken its requirements. Findings are recorded through `receipts.submit`; generic receipt limits apply. Advice does not replace the workflow's independent final review or verification.

`turn_end` starts review and `agent_end` validates its result. The next completed turn cancels any superseded review. Candidate changes hide previous advice and prevent stale receipt submission or context reuse. Session exit can interrupt unfinished review; resume never automatically relaunches it. Invalid results, permission denials and cancellation remain explicit unreviewed outcomes.

Fullscreen presentation shows up to three notes above the composer; inline mode shows bounded status. The status tool rechecks evidence access before showing provenance. Context receives findings only for the same thread and unchanged candidate. With every-turn review off, there are no review lifecycle or context callbacks.

When using the review-policy plugin, `OMD_REVIEW_CADENCE_OWNER=advisor` selects advisor cadence rather than duplicate manual reminders. This does not bypass the selected contract. The historical Batch 2 acceptance used the previous host API; Batch 2.55 has ported six focused advisor runner cases. Native and installed-profile parity must be requalified before migration closes. Model access, review quality and real cost remain unverified.
