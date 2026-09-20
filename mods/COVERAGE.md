# API coverage and composition

All operations are experimental API `0.1.0-experimental.3`. Missing capabilities
fail before native dispatch. This contract describes implemented boundaries;
arbitrary Rust internals are not exposed.

| Surface | Observe / alter / replace | Timing and ownership |
| --- | --- | --- |
| Model/provider/reasoning | List configured presets; replace lead preset; select agent preset or registered adapter alias | Lead creation/resume, each agent spawn; fixed host selection and native admission win |
| Provider adapters | Register/unregister an explicitly host-approved local service route | Owning mod/generation/turn; exact executable and host rates; existing Responses transport |
| Sidecars/secrets | Start/status/stop an approved service ID; opaque references | Native sandbox intersection, process-group cancellation, bounded task lifetime; no callback secret access |
| Agent roles | Spawn read-only roles; message, list, cancel, wait, consume | Native threads/worker ledger; private handles; task and worker allowance/deadline |
| Delegation/scheduling/coordination | Sequence native operations; replace built-in tool entrypoints with registered mod tools | Pre-dispatch, exclusive replacement; native recursion, isolation and accounting remain |
| Review/recovery | Replace tool choice/cadence; invoke original native review/completion/contribution/escalation | Existing handlers preserve evidence and selected contract; no implicit downgrade |
| Workflow contracts | Observe the active contract and provenance; restrict delegation, child-agent, opposite-lead or escalation authority; register a complete contract for native selection | Task-bound and versioned; restrictions only remove authority; registration is exclusive and cannot shadow, select or weaken a host contract |
| Prompts/context | Add bounded fragments; exclusively select a mod context assembler; construct worker prompts | Each native context assembly; user/project instructions and native mandatory context retained |
| Input | Observe or deny submitted prompts; exclusively rewrite prompt text | Before native prompt hooks, skill/mention resolution and history for TUI and exec; visible rewrite/denial notice; attachments retained |
| Compaction | Replace automatic token threshold and the local summarization prompt | Thread creation/resume, bounded by host threshold/window; prompt only for native local compaction, remote-compaction routes keep native behavior with a visible diagnostic |
| Session/checkpoints | Observe IDs and checkpoint; submit evidence-backed updates | Native checkpoint validation and integrity checks; no arbitrary history rewriting |
| Lifecycle | Start/resume/idle/stop/tool outcome, turn start/end, compaction start/end, owned agent end | Lead only; observers cannot run host operations; native cancellation/turn cleanup cannot be intercepted |
| Tools | Register deferred tools with labels; stream bounded progress; call native exec and task operations | Native executor, permissions, deadlines, accounting and tool lifecycle; transcript activity line and live progress panel |
| Interception | Observe/deny; exclusively rewrite arguments or select another registered function tool | Before normal hooks and permission checks; replacement cannot forge native completion evidence |
| Commands | Register described commands; invoke from the CLI, `/` popup (`/<id>:<name>` plus conflict-free bare alias) or keybindings; display, insert or submit results | Outside native tasks; submitted text uses the native submission path without shell escape |
| Settings/state | Read configured JSON; host CLI edits; atomic state refreshed per call; explicit migration | Turn-boundary settings/reload; state CAS and migration backup |
| Terminal theme | Native accent, user-message background, success/attention/failure tones, installed syntax theme; panel colors | Inline and fullscreen; 256-color index or `#rrggbb` mapped to the terminal color depth; configured theme restored when removed |
| Panels/widgets/layout | Left/right sidebar panels, header and footer panels, status-line segments, progress and diagnostics panels | Panels need fullscreen with size fallbacks; status segments inline and fullscreen; native composer/recovery controls retained |
| Input/keybindings | F2–F12, Ctrl+letter, Alt+letter: insert draft, submit message, or run a command | Inline and fullscreen; active native keymap bindings and chords win with a visible notice; Escape, Ctrl+C/D/Z/H/I/J/M and modal input retained |
| Tool/message rendering | Replace presentation templates, retaining `{text}` exactly once; mod tool activity lines | Rich assistant and exec cells; raw transcript, stored messages and evidence remain native |
| Pi | Named v0.74.0 tool/command subset (labels, descriptions, `onUpdate`, `sendUserMessage`), nested skill and prompt discovery with ignore rules and frontmatter, prompt expansion as `pi.expand` and `/pi:<name>` | Optional adapter over the same registry and host operations; gaps in README |

Exclusive replacements conflict before activation. Context observers compose in
mod-ID order under the aggregate limit; `replace('context')` reserves the mod
assembler slot. Multiple non-null routing/compaction/terminal decisions fail
visibly. Runtime effects cannot run in policy/lifecycle/standalone-command
callbacks. A native tool callback can call the documented effect operations.

Native workflow-contract enforcement, permissions, spending grants, cancellation,
provider credentials, workspace integrity, durable evidence, and final acceptance
are not replaceable. Raw history rewriting, custom prompts for provider-side
remote compaction, arbitrary compaction engines, raw terminal escape sequences,
clipboard authorization bypass, unrestricted UI components, overriding native
key bindings, and arbitrary provider compatibility remain unsupported. These are
visible API limits, not silent successful no-ops.

Executable coverage lives in `runtime/omd/tests/mods.rs`, `mods/runner.test.mjs`,
the patched native tool-registry and terminal tests (`mod_ui_tests.rs`,
`mod_runtime_tests.rs`), `benchmarks/mod_fixture.py` and
`benchmarks/mod_terminal_fixture.py`. The maintained cross-release/cross-mod matrix,
independent preview and first-party migrations remain separate roadmap tasks.
