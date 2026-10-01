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
| `omd_muse` | Batch 3e: `muse serve` provider and research tool validated against a fake MSP host; the installed Muse Code 0.2.1 has no MSP host; installed inactive in OMD+ | Experimental until a live run on a Muse build with `muse serve` under a current allowance |
| `omd_coordination` | Public `.7` API implements live route, context and delegation preparation; exact source is in `mods/first-party` | Declare distributable license/provenance; task-matched route value and isolated overhead |
| `omd_recovery` | Public `.7` API implements bounded recovery choices while native host retains failure and permission authority | Task-matched failure recovery value, repeat-call and overhead checks |
| `omd_workspace` | Public `.7` terminal API supplies live workspace; measured cold/callback cost is material | Declare distributable license/provenance; terminal responsiveness, accessibility and task benefit |
| `omd_typed_tasks` | Public `.8` task tool and generic host operations pass offline and synthetic host siblings, edit/review/integration, conflict, failure, resume, and broken/disabled fallback; inactive in OMD+ | Real-model task quality, route compatibility, cost, and broader release support remain unverified |
| `omd_logo` | Public terminal patch renders the approved OMD wordmark from the read-only launch `identity`; active in both profiles, absent in upstream-style direct mode; offline scenario and physical-PTY rendering, narrow, ASCII, disabled and broken fallbacks pass | Real-terminal accessibility review and Phase 12 overhead decision |
| `omd_model_picker` | Sets only `TerminalTheme.picker`; native keeps rows, labels, warnings, keys and persistence; active in OMD+ only; native picker in OMD Core, direct and broken-mod paths | Phase 12 usefulness and responsiveness decision |
| `omd_git` | Git sidebar over capability-scoped `git.*` host operations with fingerprint-checked writes, confirmation dialogs and discard backups; installed inactive in OMD+ | Phase 12 usefulness, overhead and recovery decision on real repositories |
| `omd_reactive_rules` | Batch 3a runner tests and offline host acceptance: bounded rule parsing, boundary-only stop/retry, per-turn limits and compaction restatement; installed inactive in OMD+ | Per-event callback latency and Phase 12 usefulness decision |
| `omd_programmable_context` | Batch 3a runner tests and offline host acceptance of kernel bootstrap, provenance, kept variables, child agents, refinement, restart and zero disabled cost; installed inactive in OMD+ | Live-model value, exclusive history replacement conflicts and Phase 12 decision |
| `omd_plan_removal` | Batch 3b simulated terminal and app-server acceptance: `/plan`, Shift+Tab, resumed threads and app-server turns stay in the default mode; disable and broken-copy restore; no callbacks; installed inactive in OMD+ | Phase 12 default-activation decision |
| `omd_continue` | Batch 3b simulated terminal acceptance after Ctrl-C mid-command, mid-edit and at a patch approval, error, resume and crash restart, from the host turn-activity ledger; installed inactive in OMD+ | Phase 12 default-active candidate decision |
| `omd_preview` | Batch 3f runner-harness test with a real renderer run (responses, files, watch re-render, inline dialog) and a headless Chromium render of highlighting, KaTeX and Mermaid under the page policy; installed inactive in OMD+ | Live TUI `/preview`, browser opening and watch refresh in a real session |
| `omd_panes` | Batch 3g runner tests: split, focus, move, keyboard and mouse resize, cell and depth limits, per-thread persistence and resume, Git-coloured tree, find, viewer, confirmed create/rename/delete/undo transactions; host fill-height, resize-event and loopback PTY changes with focused Rust tests; installed inactive in OMD+ | Live TUI keyboard and mouse use, render cost on large repositories and Phase 12 usefulness decision |
| `omd_notes` | Batch 3g runner test with real `grep`/`cat`/`tee`: wiki links, missing links, backlinks, tags, tasks, search, external-edit conflict and reload, rename with link updates, personal vault, completion and confirmed agent writes; installed inactive in OMD+ | Live TUI use, large vaults and Phase 12 usefulness decision |
| `omd_editor` | Batch 4cg runner tests against real files and Git: typing, paste-free input batches, selection, undo/redo, smart-case find, Git markers that refresh after a commit, composer quotes, CRLF/final-newline preservation through an expected-hash transaction, clean-buffer reload, dirty-buffer conflict with refused save, keep, reviewed and confirmed overwrite that rejects a race, save denial, binary and size refusal, multiple buffers parked in the thread store with a deferred load when two large buffers meet, multi-line comment and template colors, saved-file line mapping for code intelligence and `/edit PATH:LINE` on unsaved buffers, close choices and restart recovery; installed inactive in OMD+ | Local PTY run on the rebuilt host covered typing, Ctrl+s, conflict review and reload, parking and buffer switching in the popup; pane-site use with `omd_panes`, live typing latency and the Phase 12 usefulness decision remain |
| `omd_shared_checkout` | Batch 4cg runner tests of two sessions and an agent thread sharing one checkout: read-only denial of patches and Git writes, disjoint writes, overlapping reservations that ask first, patches into another reservation or outside the assignment paused for approval, the Git lease with release on an aborted tool result and expiry, Git writes behind wrappers and `sh -c`, recognizable shell writes checked against reservations, reserved-path watches including ignored files and whole-checkout reservations that warn about changes outside the session's own patches, commands and mod writes, handoff accept, stale detection, confirmed release, day-old expiry and stop cleanup; installed inactive in OMD+ | Local two-terminal PTY run covered registration across mod stores, the read-only shell-write prompt and outside-change warnings; `/worktree` handoff, measured gate latency per tool call and the Phase 12 usefulness decision remain |
| `omd_lsp_view` | Batch 3g runner test of the command, channel hop, `omd.lsp` service call, result list, excerpt, pane mode and missing provider; the provider's `query` is tested against a fake server for hover, symbols, diagnostics, confirmed formatting and code actions; installed inactive in OMD+ | Live TUI use and Phase 12 usefulness decision (all five languages answered through the service outside the TUI) |
| `omd_frecency` | Batch 3h runner tests of fuzzy tiers, smart case, one-typo-per-four-characters matches, frecency and Git boosts, renamed-file pruning, the `omd.frecency` service and prompt learning (queued on `input`, learned at `turn_start`) that skips ignored files; host routes each mod command's argument completion to its own mod so `omd_notes` keeps `/note` completion; installed inactive in OMD+ | Live TUI `@` popup latency on a large repository and Phase 12 usefulness decision |
| `omd_plan_panel` | Batch 3h runner test of per-thread plans, sub-agent isolation, completed-first overflow with `+N more`, collapse, every-step toggle and clearing a finished plan at the next turn; installed inactive in OMD+ | Live TUI rendering beside other `above_composer` contributors and Phase 12 usefulness decision |
| `omd_layout` | Batch 4ce runner tests of project-grouped sessions with status, unread, worktree issue, context and loopback-probed ports, the nested command palette with composer restore and mod-command runs, jump to sessions/worktrees/tabs with per-session drafts, quick open (tracked first, ignored second), transcript/pane find and status shared between OMD processes; host `terminal.commands`, `sessions.ports` and mod-command `builtins.invoke`; installed inactive in OMD+ | Live TUI use, Ctrl+Shift key delivery per terminal, multi-terminal status in practice and Phase 12 usefulness decision |
| `omd_worktree` | Batch 4ce runner tests against real Git: base/branch/issue naming, opt-in symlink and consented copy setup, session launch, reuse refusal, reviewed integration (including a confirmed commit of uncommitted task work) with stale-state rejection, conflict abort, dirty/unmerged preservation and pruning of externally deleted worktrees; installed inactive in OMD+ | Live use under a permission profile that grants `.git` and the worktree root, concurrent sessions and Phase 12 usefulness decision |
| `omd_mods` | Batch 4a: runner tests, native package-control tests, and one isolated PTY session per profile covering /mods transitions, /omd recovery with the screen mod disabled, and the first-run card; enabled by default in both profiles | Phase 12 newcomer walkthrough and responsiveness decision |
| `omd-guidance-hooks` | Local plugin packages three selected skills and controlled hooks with host-gated reactions | Useful report/task result without instruction priority drift or excessive context |
| `omd-review-policy` | Local plugin packages review skills and a selected every-turn hook; native ledger remains authoritative | Incremental findings beyond native final review at acceptable cost |
| `omd-application-bridges` | Local plugin exposes prompt-approved managed bridge tools and session hooks | Real application task, exact dependency/teardown and disclosure checks |
| `omd-artifact-reading` | Local plugin packages one source-anchored reading skill | Per-source task value, parser/source drift and missing-dependency checks |

Every plugin currently declares `UNLICENSED`; the first-party coordination and
workspace mod manifests omit a license. Those exact labels appear in the
index. Distribution or ownership transfer needs a reviewed license decision.
Installed source is separate from activation, and none of these entries is a
supported release package yet.

| Development entry | Reason it stays out of the reviewed candidate index |
| --- | --- |
| `omd-code-execution` | Pinned Python and Bun workers pass local native bridge, one-cell composition, sandbox, disable, and cleanup checks; OMD+ profile installation and real-task value are not established |
| `omd_theme` and `omd_focus_flow` | Separate opt-in latency keep gates failed; neither enters the active default |
| `task_scope` | Internal `.8` author exercise works offline, but per-step callback cost and real task value are unresolved |
| `session_anchor` | Internal checkpoint/compaction exercise works offline, but independent long-session benefit is unresolved |
| `atlas_policy` and `atlas_console` | Substantial externally styled conformance fixtures, not independent community packages or release candidates |

The reviewed gap routing is recorded in [the index guide](README.md#workflow-gap-routing).
Structural editing, debugger inspection, mechanical patch recovery and
subagent guidance have selected trials. The typed-task candidate is separately
installed and locally functional but has not passed the later release support
gate. Native/configured Codex remains the current path until that gate passes.

The 2026-09-26 Batch 2 updates keep `omd-review-policy` and `omd-artifact-reading` as reviewed development candidates: advisor procedure/cadence selection and plugin-owned GitHub virtual reads have local fixture evidence, while public support remains unqualified. The optional `omd-curated-memory` package is local-only under the maintainer decision; `omd-anchored-edit` and `omd-session-review` are separately installed public-API components. On 2026-09-27 the maintainer accepted advisor/research on local evidence without real-model qualification, completing Batch 2; both mods remain inactive development candidates with live access, quality and savings unverified. See the [package audit](../.docs/audits/batch2-packages-20260926.md) for exact scope and limits.
