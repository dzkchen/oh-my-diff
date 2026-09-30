# Independent turn advisor

`omd_advisor` is an opt-in API `0.2.0-experimental.5` mod. It owns cadence, triggers, evidence selection, redaction, reviewer prompts, typed findings, citation validation, duplicate suppression and presentation. Generic host operations own isolated agents, one-shot completions, permissions, allowance, snapshots and contract receipts.

OMD+ installs the package inactive. No setting grants model access or allowance: every request uses the configured worker `route` (default `astra`) under the host's admission, allowance and ledger.

## Modes

- **On demand.** The lead can call `mod_omd_advisor_ask {question?, draft?, files?}` for a consequential decision, a stalled attempt or before declaring completion; the user can type `/advisor [focus]`, which asks the lead to call it. The tool runs one `model.complete` and returns the advice to the lead.
- **Triggers** (`triggers`, default none). `failure` consults the advisor after the same tool call (same tool and arguments) fails twice without succeeding in between. `loop` consults it after the same call returns the same output three times in a row; `Chunk ID`, `Wall time` and token-count lines are ignored, and polls of a still-running process never count. The advice is appended to the triggering tool output (at most 4 KiB) before the lead continues. `completion` runs the independent review below for completed turns that changed files.
- **Every turn** (`every_turn: true`) reviews every completed lead turn.

On-demand and triggered advice is always advisory. The prompt is at most 8 KB: the question, draft or triggering call, then the newest conversation history (`sessions.snapshot` tail), `git diff HEAD` and named files up to 24 KB each, in that order until the budget is used. `share` (default `conversation`, `diff`, `files`) limits which sources are sent; withheld sources are named in the prompt. Private keys, bearer tokens, credential assignments, URL credentials and AWS key ids are redacted before truncation; this is a pattern filter, not data classification. `skip_same_model` (default true) skips consultations and completion reviews when the advisor route's model equals the lead thread's model. The `status` tool reports the modes and the last consultation.

## Reviews

Every-turn and completion reviewers receive a bounded visible turn excerpt and a frozen candidate, with no tools or parent history. Hidden reasoning and tool-output bodies are excluded. The mod reads at most 48 KiB of evidence, selects a 6 KiB excerpt and accepts at most eight findings with exact supporting quotes.

`mode: advisory` converts blocking proposals to warnings. `mode: blocking` requires the user to select a contract whose completion gate requires a separate-agent `advisor_review` receipt and rejects blocking findings. The mod cannot select that contract or weaken its requirements. Findings are recorded through `receipts.submit`; generic receipt limits apply. Advice does not replace the workflow's independent final review or verification.

`turn_end` starts review and `agent_end` validates its result. The next completed turn cancels any superseded review. Candidate changes hide previous advice and prevent stale receipt submission or context reuse. Session exit can interrupt unfinished review; resume never automatically relaunches it. Invalid results, permission denials and cancellation remain explicit unreviewed outcomes.

Fullscreen presentation shows up to three notes above the composer; inline mode shows bounded status. The status tool rechecks evidence access before showing provenance. Context receives findings only for the same thread and unchanged candidate. Without every-turn or completion review there are no review lifecycle or context callbacks, and without `failure` or `loop` there is no tool-output callback.

When using the review-policy plugin, `OMD_REVIEW_CADENCE_OWNER=advisor` selects advisor cadence rather than duplicate manual reminders. This does not bypass the selected contract.

On-demand and trigger modes are ported from [`pi-advisor-flow`](https://pi.dev/packages/pi-advisor-flow) 0.9.0 (Philip Brembeck, MIT); see `THIRD_PARTY_NOTICES.md`. Image review, curated "scout" history and model whitelists are not ported. Local fixtures cover the prompt bounds, redaction, sharing limits, same-model skipping, trigger thresholds and the completion filter; real advice quality and cost remain unqualified.
