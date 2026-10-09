# Extension review register

Review date: September 25, 2026. These are source and functional reviews of
release candidates on Codex 0.155.1 and 0.156.1 / OMD 0.1.0. A September 23 local package
smoke covered the current Codex 0.156.1 pin, the mod API, and staged plugin
installation and removal; it did not rerun each task-value gate. These reviews
do not qualify a public support promise, a OMD+ default, task value over
configured Codex, or
independent community use. Exact current identities and dependencies are in
[`index.json`](index.json); development-only sources are in
[`development.json`](development.json). Maintainer audit files under `.docs/`
retain detailed local evidence but are not required to read this register.

| Candidate | Review basis | Remaining support gate |
| --- | --- | --- |
| `omd_claude_cli` | Batch 3e: CLI model catalog, measured windows, images, thinking, effort, named limits and `ask_claude` with offline CLI checks and bounded live requests; installed but inactive in OMD+ | Release package and support matrix remain candidate scoped; subscription usage is not an exact billing measure |
| `omd_workspace` | Public `.7` terminal API supplies live workspace; measured cold/callback cost is material | Declare distributable license/provenance; terminal responsiveness, accessibility and task benefit |
| `omd_logo` | Public terminal patch renders the approved OMD wordmark from the read-only launch `identity`; active in both profiles, absent in upstream-style direct mode; offline scenario and physical-PTY rendering, narrow, ASCII, disabled and broken fallbacks pass | Real-terminal accessibility review and Phase 12 overhead decision |
| `omd_model_picker` | Sets only `TerminalTheme.picker`; native keeps rows, labels, warnings, keys and persistence; active in OMD+ only; native picker in OMD Core, direct and broken-mod paths | Phase 12 usefulness and responsiveness decision |
| `omd_tool_lines` | Offline runner tests for every tool kind and a Rust end-to-end hooked-row toggle test; the render hook only draws one line and the native row, expansion and copy stay with the host; active in OMD+ by default | Phase 12 usefulness and responsiveness decision |
| `omd_plan_removal` | Batch 3b simulated terminal and app-server acceptance: `/plan`, Shift+Tab, resumed threads and app-server turns stay in the default mode; disable and broken-copy restore; no callbacks; active by default in OMD+ | Phase 12 default-activation decision |
| `omd_preview` | Batch 3f runner-harness test with a real renderer run (responses, files, watch re-render, inline dialog) and a headless Chromium render of highlighting, KaTeX and Mermaid under the page policy; installed inactive in OMD+ | Live TUI `/preview`, browser opening and watch refresh in a real session |
| `omd_usage` | Batch 4cf runner tests (request-idempotent ledger, corrections, observation order, lead/worker/inherited separation, provider cost labels, cache TTL countdown, quota scoping and projection, stale context, category drilldown, and sidebar), real-host load and a mock-provider PTY run; installed inactive in OMD+ | Live provider usage, quota and cache readings on Claude and OpenRouter routes |
| `omd_privacy` | Batch 4fe runner tests (secret and PII rules, lookalikes, compressed IPv6, exact example-domain exemptions, pieces split across pages, collision-checked salted placeholders, protected-kind and malformed-page refusals, reviewed exemptions, worker/internal/retry scopes, sensitive-path approval, a full page within budget), the real-host scenario and an offline `codex exec` acceptance against a loopback fixture provider; installed inactive in OMD+ | Live provider requests and the Phase 12 usefulness decision remain |
| `omd_profiles` | Batch 4cd and 4db router tests of Responses, Chat Completions and Anthropic adaptation, thread-scoped switching at the next turn, Anthropic thinking round trips and reasoning dropped after a switch, plus setup validation; installed inactive in OMD+ | Live provider accounts beyond two ChatGPT subscription requests and the Phase 12 usefulness decision remain |
| `omd_lsp_sync` | Opt-in implementation qualified locally; public release and support remain separate gates; Batch 4db loaded it on the real host with the package check (registration, views, settings defaults and slash-command operations) | The Phase 12 usefulness decision remains |
| `omd_advisor` | Batch 2 local acceptance complete; opt-in and inactive. Real-model access and review quality remain unverified, outside the maintainer-approved completion scope; Batch 4db loaded it on the real host with the package check (registration, views, settings defaults and slash-command operations) | The Phase 12 usefulness decision remains |
| `omd_inspector` | API 0.2 offline inspector passes; missing public permission and rejected-mod fields block native parity; Batch 4db loaded it on the real host with the package check (registration, views, settings defaults and slash-command operations) | The Phase 12 usefulness decision remains |
| `omd_workflow` | Reviewed and solo schema-2 contracts pass local mock-provider fixtures; controlled workflow and native-retirement parity remain open; Batch 4db loaded it on the real host with the package check (registration, views, settings defaults and slash-command operations) | The Phase 12 usefulness decision remains |
| `omd_lsp_view` | Batch 3g runner test of the command, channel hop, `omd.lsp` service call, result list, excerpt, pane mode and missing provider; the provider's `query` is tested against a fake server for hover, symbols, diagnostics, confirmed formatting and code actions; installed inactive in OMD+ | Live TUI use and Phase 12 usefulness decision (all five languages answered through the service outside the TUI) |
| `omd_frecency` | Batch 3h runner tests of fuzzy tiers, smart case, one-typo-per-four-characters matches, frecency and Git boosts, renamed-file pruning, the `omd.frecency` service and prompt learning (queued on `input`, learned at `turn_start`) that skips ignored files; host routes each mod command's argument completion to its own mod; installed inactive in OMD+ | Live TUI `@` popup latency on a large repository and Phase 12 usefulness decision |
| `omd_mods` | Batch 4a: runner tests, native package-control tests, and one isolated PTY session per profile covering /mods transitions, /omd recovery with the screen mod disabled, and the first-run card; enabled by default in both profiles | Phase 12 newcomer walkthrough and responsiveness decision |
| `omd_update` | Runner tests of the update notice, /update dialog, snooze/skip state and policy settings with the installer owning the network check and installation; enabled by default in both profiles | Live release check and applied automatic update against a published release, and terminal rendering in practice |
| `omd-artifact-reading` | Local plugin packages one source-anchored reading skill | Per-source task value, parser/source drift and missing-dependency checks |

Every first-party plugin and mod declares `MIT`, and the index repeats it.
Installed source is separate from activation, and none of these entries is a
supported release package yet.

| Development entry | Reason it stays out of the reviewed candidate index |
| --- | --- |
| `omd-code-execution` | Pinned Python and Bun workers pass local native bridge, one-cell composition, sandbox, disable, and cleanup checks; real-task value is not established, and OMD+ stages the source inactive |
| `omd-anchored-edit` | Deterministic and sandboxed acceptance only; real-task value and public support are unqualified, and OMD+ stages the source inactive with a separately trusted mod component |

The reviewed gap routing is recorded in [the index guide](README.md#workflow-gap-routing).
Structural editing and mechanical patch recovery have selected trials. Native/configured
Codex remains the current path until a package passes the release support gate.

The 2026-09-26 Batch 2 updates keep `omd-artifact-reading` as a reviewed candidate: plugin-owned GitHub virtual reads have local fixture evidence, while public support remains unqualified. `omd-anchored-edit` is a separately installed public-API component. On 2026-09-27 the maintainer accepted the advisor mod on local evidence without real-model qualification; it remains an inactive candidate with live access, quality and savings unverified.