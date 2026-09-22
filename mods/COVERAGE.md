# Public API coverage and composition contract

<!-- Generated from conformance/contract.json by scripts/mod_conformance.py --write. -->

Mod API `0.1.0-experimental.7`. Every decision a mod can reach through the published
API is listed below with the support it has, when it takes effect, who owns the
outcome, and its limits. Capabilities not granted to a package fail before native
dispatch. Arbitrary host internals are not exposed, and the table is checked
against the host source: an event, capability, replacement point or host
operation that is not documented here fails `scripts/mod_conformance.py`.

`observe` is middleware (`api.on`): several mods compose. `replace` is exclusive
(`api.replace`): one mod per point, claimed before activation.

## Coordination decisions

| Decision | Observe | Alter | Replace | Timing | Ownership | Limits |
| --- | --- | --- | --- | --- | --- | --- |
| **Lead model, provider and reasoning preset** | `routes.list` returns the host-configured presets | no partial edit; a preset is selected whole | `routing` | thread creation and resume, before the first request of the session | mod: fixed/task-entry choice; host: the preset table, exact task-entry match and native admission | only host-configured presets; an unauthorized name or task-entry mismatch retains the native fallback; arbitrary models, endpoints or credentials are never reachable |
| **Delegated worker context policy** | the configured modes and active native fallback | select one complete configured policy | `worker_context` | thread creation, resume and each turn-boundary reload | mod: focused-brief, shared-packet or parent-history choice; host: configuration and context assembly | only configured bounded policies; invalid, unavailable or broken decisions retain the native fallback; instruction priority, permissions and accounting remain native |
| **Read-only worker agents: spawn, message, cancel, wait, list, consume** | `agents.list`, `agents.result`, and the `agent_end` event | role, route and prompt of each spawn | no | inside a native tool callback, within the current task | host: worker threads, the worker ledger, permissions, deadlines and the shared allowance | read-only permissions; private handles owned by the spawning mod and generation; recursion, isolation and accounting stay native; handles die with the turn |
| **Delegated contribution: brief and evidence selection** | the request the model made | brief text and selected evidence before dispatch | `tool_before` (redirects `omd_contribute` to a mod tool) | pre-dispatch, inside the replacing mod tool | host: worker context assembly, review, integration and the recorded result | cannot widen evidence beyond what the host exposes, forge a contribution result, or bypass the native reviewed path |
| **Review cadence and final review invocation** | the active contract requirements | when review runs and on which candidate | `tool_before` (redirects `omd_complete`) | inside a native tool callback during the task | host: reviewer route, the candidate-bound findings ledger, shared limits and acceptance | no implicit downgrade of the selected contract; evidence and findings stay native; a stale candidate digest fails closed |
| **Escalation choice after a preserved failure** | preserved failure evidence through the checkpoint | failure classification, eligible-tool decision and advisory route while forwarding the summary and cited call IDs | `tool_before` (redirects `omd_escalate`) | inside a native tool callback during the task | host: exact failure evidence, class validation, permissions, bounded attempts, advice dispatch, return control and the retained evidence | advice only; the mod cannot forge evidence, move worker lifecycle into TypeScript, widen permissions or exceed native attempt bounds |
| **Contributor-outage reassessment and opposite-lead fallback choice** | the delegation request and configured outage policy | choose bounded opposite-lead fallback or pause after the host detects equivalent failures | `tool_before` (redirects `omd_contribute` to the recovery-aware delegation tool) | before reviewed delegation; the host reassesses only after its equivalent-failure threshold | host: attempts, equivalent-failure detection, snapshots, allowance, original-route review, conflict-safe integration, interruption, cleanup and resume | the mod cannot declare an outage, choose an unconfigured route, bypass review, reset allowance or integrate a stale candidate |
| **Workflow contract: registration, restriction and observation** | `workflow.status` reports the active contract and its provenance; the `workflow` event | `workflow.restrict` removes authority for the task | exclusive contract registration per contract ID, not a replacement point | registration at activation; restriction inside a task; selection stays native | host: contract selection, enforcement, the assurance floor and durable evidence | restrictions only remove authority; a registration cannot shadow, weaken or select a host contract; two mods claiming one contract ID both fail closed |
| **Provider adapter route registration** | registration status | register or unregister an explicitly host-approved local service route | no | within the owning mod, generation and task | host: the approved executable, its hashes, rates, credentials and the Responses transport | only pre-approved service IDs; no arbitrary endpoints, credentials or wire protocols; the route dies with the task |
| **Task status and effective settings observation** | `task.status` returns the effective settings, allowance and task state | not alterable | no | inside a native tool callback | host: all reported state | read-only; secrets, credentials and store digests are never included |
| **Typed middleware at request, stream, prompt, session, agent, tool and approved-operation boundaries** | field policy metadata marks request identity, scope, raw stream digest, opaque reasoning, raw usage, lifecycle identity, tool outcomes and host-operation receipts observe-only | each admitted request may select one complete authorized preset; bounded output-text deltas may be transformed in deterministic order with original/effective hashes and fallback provenance | no | before each main-thread or subagent request, on each Responses stream item, and at the named native lifecycle boundary | host: preset admission, raw response parsing, reasoning, usage, permission and tool outcomes, accounting, cancellation, transcript/evidence records and workflow enforcement | no arbitrary model/provider/reasoning tuple, endpoint, usage rewrite, reasoning rewrite, tool-result fabrication, completion action or assurance receipt; each hook has a declared wall-time budget and cancellation check; the mod runtime is single-threaded and never re-entrant, so a request a mod causes from inside its own in-flight callback is sent on its already-authorized native route without that runtime's request, stream or thread-configuration hooks |
| **Host-routed namespaced and versioned service contracts between mods** | installed contract types and status name provider, consumer, exact version, method, scope and generation | a consumer supplies only the declared bounded JSON input and receives a schema-kind-checked result | no | providers, consumers, versions, collisions and dependency order resolve before activation; calls run through the host during a callback | host: provider lookup, capability separation, input/output bounds, generation ownership, call provenance and unload cleanup | no shared globals, state, secrets, filesystem, network, process authority or inherited grants; optional absence is catchable while required absence, incompatibility, cycles and collisions fail before activation |

## Context and recovery decisions

| Decision | Observe | Alter | Replace | Timing | Ownership | Limits |
| --- | --- | --- | --- | --- | --- | --- |
| **Mod context block added to each native context assembly** | `on('context')` contributes a bounded fragment | fragments compose in activation order under one aggregate limit | `context` (the exclusive assembler; observer fragments are dropped with a visible notice) | every native turn-context assembly, lead thread only | host: user/project instructions, native mandatory context, ordering and the aggregate budget | 1 KiB per fragment, 6 KiB aggregate; mod context is always subordinate developer context and names its mod |
| **Submitted prompt: observe, deny or rewrite** | text and attachment count | deny with a reason (any observer may veto) | `input` (exclusive rewrite) | before native prompt hooks, skill/mention resolution and history, in TUI and exec | host: submission path, attachments, history and the visible notice | a rewrite or denial is always shown to the user; attachments are retained; two rewrites cannot compose |
| **Automatic compaction threshold and local summarization prompt** | the host token limit and context window | threshold within host bounds | `compaction` | thread creation and resume | host: the compaction engine, the window and remote-compaction behaviour | 256 tokens to the host ceiling; the prompt applies only to native local compaction, remote compaction keeps native behaviour with a visible diagnostic |
| **Durable task checkpoint: read and evidence-backed update** | `checkpoint.read` and the checkpoint passed to context and terminal events | `checkpoint.update` appends evidence-backed progress | no | inside a native tool callback | host: validation, workspace integrity, version markers and completed-evidence retention | cannot discard completed evidence, rewrite history or record a stale candidate digest |
| **Per-mod durable state and explicit migration** | `state.get` refreshed on every invocation | `state.set` with compare-and-set on write | no | any callback; migration only through the disabled-package manager command | host: the store, the lock, atomic writes, the backup and scope separation | 64 KiB; a lost race reports `state_conflict`; no writes during activation; user and project scopes never share a state file |
| **Session and turn lifecycle observation** | start, resume, idle, stop, tool_result, turn_start, turn_end, compaction_start, compaction_end, agent_end | not alterable | no | at each native lifecycle point, lead thread only | host: cancellation, turn cleanup and ordering | observers cannot run host operations, cannot delay the turn past their budget, and cannot intercept cancellation |
| **Pi skill and prompt discovery and expansion** | `pi.discover` lists eligible resources with diagnostics | `pi.expand` renders a named prompt with arguments | no | inside a native tool callback | host: the eligible directories, ignore rules, symlink rejection and protected-resource omission | protected or symlinked resources are refused and reported, never silently omitted |

## Tool decisions

| Decision | Observe | Alter | Replace | Timing | Ownership | Limits |
| --- | --- | --- | --- | --- | --- | --- |
| **Deferred mod tools offered to the model** | the model's arguments | the tool's own result | no | registered at activation; callable for the whole generation | host: the executor, permissions, deadlines, accounting and the tool lifecycle | 16 tools per mod, namespaced `mod_<id>_<name>`, 8 KiB schema validated by the native tool registry |
| **Tool call interception: observe, deny, rewrite arguments or retarget** | tool name, arguments and call ID | deny with a reason from any observer | `tool_before (exclusive argument rewrite or retarget)` | before native hooks and permission checks | host: permissions, the executor and completion evidence | a replacement cannot forge native completion evidence or escape the sandbox; only one rewrite may exist |
| **Slash commands and their results** | the argument text | display, insert or submit text | no | outside native tasks, from the CLI, the `/` popup or a keybinding | host: the submission path, queueing and command precedence | 16 per mod; namespaced `/<id>:<name>` always exists, a bare alias only when unique; submitted text uses the native path with no shell escape; host operations that need a task fail with `host_operation_unavailable` |
| **Bounded native command execution** | exit code and bounded output | the argument vector | no | inside a native tool callback | host: the sandbox, permission profile, deadlines and accounting | the same sandbox and permission profile as any native exec; the mod store and host secrets stay denied |
| **Approved local service lifecycle** | `sidecars.status` | start and stop an approved service ID | no | within the owning mod, generation and task | host: the executable hash, sandbox intersection, process group, secrets and cleanup | opaque secret references only; process-group cancellation and bounded task lifetime; unapproved IDs are refused |
| **Streamed progress and the transcript activity line** | not applicable | up to 32 bounded progress updates per tool call | no | during a mod tool call only | host: rendering, the live progress panel and the completed activity line | 1 KiB per update; forwarded once across host-call replay; refused outside a tool callback |

## Terminal decisions

| Decision | Observe | Alter | Replace | Timing | Ownership | Limits |
| --- | --- | --- | --- | --- | --- | --- |
| **Terminal base view and composable render-site patches** | the triggering event and checkpoint; current-API observers compose patches after the exclusive base owner | the owner returns the bounded base view; observers may wrap or replace declared sites and add non-conflicting presentation fields | `terminal (exclusive)` | every mod event, redrawn inline and fullscreen | host: driver, layout, modes, validation, native composer, recovery, input primitives and restoration | dependency order is deterministic; conflicting or invalid patches fail alone and transactionally; older API observers remain observe-only; recovery remains native |
| **Declarative components at sidebar, header, above-composer and dialog sites** | not applicable | bounded box, text, button, input, select, Markdown, code, pane and dialog trees; wrappers expose exactly one slot | `terminal` | fullscreen, with inline fallbacks | host: focus, scroll, redraw, pointer and keyboard dispatch, resize, accessibility labels, clipboard and the native inspector | 64 components per site, depth 6, unique bounded IDs and labels; narrow fallbacks apply; controls, raw escapes and arbitrary widgets are rejected |
| **Palettes, semantic diff/status tones, borders, density, icons and syntax theme** | not applicable | bounded named theme slots and presentation variants | `terminal` | inline and fullscreen | host: the terminal colour depth and the configured theme | 256-colour index or `#rrggbb` mapped to terminal depth; no-color drops custom colors, ASCII uses plain borders, there is no mod animation, and removal restores native presentation |
| **F2-F12, Ctrl/Alt actions and component interaction** | not applicable | insert, submit, run a command, focus a component, activate a control, or request native clipboard copy | `terminal` | inline and fullscreen while the mod view is active | host: native keymap, modal input, focus, pointer dispatch, clipboard authorization and cancellation keys | active native bindings and chords win with a visible notice; Escape, Ctrl+C/D/Z/H/I/J/M and cancellation remain native |
| **Assistant, tool and completed-activity presentation** | not applicable | a template that retains `{text}` exactly once, plus compact presentation for successful completed agent tool output | `terminal` | rich assistant and exec cells as they render | host: the raw transcript, stored messages and durable evidence | presentation only; active work, failures, user shell commands, prompts, transcript, stored messages and evidence remain native and visible |

## What this adds over the native plugins and hooks

Pinned Codex 0.155.1 ships plugins (`plugin.json`: skills, prompts, MCP servers,
hook files) and hooks for `pre_tool_use`, `permission_request`, `post_tool_use`,
`pre_compact`, `post_compact`, `session_start`, `session_end`,
`user_prompt_submit`, `subagent_start`, `subagent_stop`, `stop` and `interrupt`.
A hook is an external command or MCP tool that returns a decision document: it can
block a call, add context, or rewrite a tool's input. It cannot hold state, stream,
render, route a model, run an agent, or take part in delegation, review, recovery
or workflow enforcement, and competing `pre_tool_use` rewrites are resolved by
whichever hook finishes last. The mod API is in-process, capability-scoped,
deterministic and composable; the added control per decision is:

| Decision | Native plugins and hooks today | Added by the mod API |
| --- | --- | --- |
| Lead model, provider and reasoning preset | native plugins and hooks cannot change model, provider or reasoning effort at all | exclusive `routing` replacement; no partial edit; a preset is selected whole |
| Delegated worker context policy | native plugins and hooks can add context but cannot select the bounded delegated-worker context policy | exclusive `worker_context` replacement; select one complete configured policy |
| Read-only worker agents: spawn, message, cancel, wait, list, consume | native plugins cannot spawn or steer agents; `subagent_start`/`subagent_stop` hooks only observe | role, route and prompt of each spawn |
| Delegated contribution: brief and evidence selection | `pre_tool_use` can block a tool or rewrite its JSON input, but cannot route it to another implementation | exclusive `tool_before` replacement; brief text and selected evidence before dispatch |
| Review cadence and final review invocation | no native hook can run or replace a review | exclusive `tool_before` replacement; when review runs and on which candidate |
| Escalation choice after a preserved failure | no native hook participates in recovery | exclusive `tool_before` replacement; failure classification, eligible-tool decision and advisory route while forwarding the summary and cited call IDs |
| Contributor-outage reassessment and opposite-lead fallback choice | no native hook can replace the fallback choice while preserving the reviewed contribution lifecycle | exclusive `tool_before` replacement; choose bounded opposite-lead fallback or pause after the host detects equivalent failures |
| Workflow contract: registration, restriction and observation | native plugins have no workflow contract concept | `workflow.restrict` removes authority for the task |
| Provider adapter route registration | native plugins cannot add provider routes at runtime | register or unregister an explicitly host-approved local service route |
| Task status and effective settings observation | hooks receive only their own event payload | not alterable |
| Mod context block added to each native context assembly | `session_start`/`user_prompt_submit` hooks can inject additional context, but there is no exclusive assembler and no declared ordering | exclusive `context` replacement; fragments compose in activation order under one aggregate limit |
| Submitted prompt: observe, deny or rewrite | `user_prompt_submit` hooks can block a prompt or add context; competing rewrites are resolved by whichever hook finishes last | exclusive `input` replacement; deny with a reason (any observer may veto) |
| Automatic compaction threshold and local summarization prompt | `pre_compact`/`post_compact` hooks observe and can add context; they cannot set the threshold or the prompt | exclusive `compaction` replacement; threshold within host bounds |
| Durable task checkpoint: read and evidence-backed update | no native hook can read or write task state | `checkpoint.update` appends evidence-backed progress |
| Per-mod durable state and explicit migration | native hooks are stateless between runs | `state.set` with compare-and-set on write |
| Session and turn lifecycle observation | hooks cover session_start/end, stop, interrupt and subagent start/stop with comparable observation | not alterable |
| Pi skill and prompt discovery and expansion | native plugins ship skills and prompts but expose no discovery API to code | `pi.expand` renders a named prompt with arguments |
| Deferred mod tools offered to the model | native plugins add tools only through MCP servers, as a separate process with its own transport | the tool's own result |
| Tool call interception: observe, deny, rewrite arguments or retarget | `pre_tool_use` blocks or rewrites input; the last-finishing hook silently wins a contested rewrite and no hook can retarget the call | exclusive `tool_before (exclusive argument rewrite or retarget)` replacement; deny with a reason from any observer |
| Slash commands and their results | plugins contribute prompt-style slash commands, not code-backed commands with structured results | display, insert or submit text |
| Bounded native command execution | hooks run their own commands outside the agent sandbox contract | the argument vector |
| Approved local service lifecycle | native plugins declare MCP servers but have no in-task service lifecycle | start and stop an approved service ID |
| Streamed progress and the transcript activity line | hooks can show a status message; there is no streaming progress channel | up to 32 bounded progress updates per tool call |
| Terminal base view and composable render-site patches | native plugins cannot change the terminal at all | exclusive `terminal (exclusive)` replacement; the owner returns the bounded base view; observers may wrap or replace declared sites and add non-conflicting presentation fields |
| Declarative components at sidebar, header, above-composer and dialog sites | no equivalent | exclusive `terminal` replacement; bounded box, text, button, input, select, Markdown, code, pane and dialog trees; wrappers expose exactly one slot |
| Palettes, semantic diff/status tones, borders, density, icons and syntax theme | no equivalent | exclusive `terminal` replacement; bounded named theme slots and presentation variants |
| F2-F12, Ctrl/Alt actions and component interaction | no equivalent | exclusive `terminal` replacement; insert, submit, run a command, focus a component, activate a control, or request native clipboard copy |
| Assistant, tool and completed-activity presentation | no equivalent | exclusive `terminal` replacement; a template that retains `{text}` exactly once, plus compact presentation for successful completed agent tool output |
| Typed middleware at request, stream, prompt, session, agent, tool and approved-operation boundaries | upstream hooks expose selected lifecycle and tool boundaries but not this request/stream preset and provenance contract | each admitted request may select one complete authorized preset; bounded output-text deltas may be transformed in deterministic order with original/effective hashes and fallback provenance |
| Host-routed namespaced and versioned service contracts between mods | no equivalent typed inter-plugin service contract in configured Codex hooks | a consumer supplies only the declared bounded JSON input and receives a schema-kind-checked result |

## Composition rules

- **order** — Activation and dispatch order is deterministic: declared dependencies first, then mod ID ascending. The same order is used for every event, tool listing, command listing and contract listing, and is published in `omd-mod status` as `order`.

- **exclusive_versus_middleware** — `api.on` is middleware: observers compose, may veto (`deny`), contribute additive context, and on the current API contribute bounded terminal patches. `api.replace` is exclusive: one mod per replacement point, claimed at activation. A non-null `routing` or `compaction` decision without replacement fails visibly; older terminal observers also remain observe-only. A context replacer drops observer fragments with a notice naming both sides.

- **terminal_patch_composition** — Terminal patches apply after the exclusive base in dependency order. Wrappers contain one slot; one patch may replace a site or own completed-tool presentation; duplicate site, key, status-budget or completed-tool claims fail the later mod transactionally without leaking any of its earlier fields.

- **conflict_before_activation** — Contested exclusive claims — a replacement point, a workflow contract ID or a namespaced tool name — are detected before activation and disable every claimant with an error naming all of them. No claimant silently wins, and unrelated mods keep running.

- **dependencies_and_cycles** — `requires` lists up to four other mod IDs. A dependency that is absent, disabled or itself failed disables the dependent chain before activation; a cycle disables every mod in it. Both are reported per mod and neither stops the host.

- **user_project_precedence** — Discovery reports project packages shadowing user packages by ID. Trust and activation stay explicit and per path: each selection records its scope, a project-scoped selection takes precedence over a user-scoped one with the same ID, the shadowed selection is recorded and not activated, and the two scopes never share mod state. Two selections of one ID in the same scope both fail closed.

- **failed_mod_isolation** — A mod that throws while activating, loses a capability, or is rejected by the store is disabled alone with a source-located error. Every other mod keeps running, its owned agents and services are cleaned up, and a healthy mod keeps its terminal view with the error panel inserted above it. The failure is reported to the user through that panel, `omd-mod status` and the persisted `mod-status.json`; a failure inside a callback is additionally reported to the model for that turn.

- **reload** — Reload happens at a native turn boundary. The initial load isolates per selection; a later reload is transactional — if any enabled selection fails, the previous eligible set stays loaded and the reason is shown once. Stale generations are refused, in-flight work keeps the source it started with, and settings and state survive an edit.

- **cancellation** — Every callback is cancellable. Cancellation discards the callback's state write, cancels its owned agents and services, records the turn outcome, and leaves the terminal usable; an explicit reload recovers the mod.

- **streaming** — Mod tool progress streams into the live panel during the call and leaves one labelled activity line when it completes; replayed host calls never duplicate an update.

- **limits** — Registration, payload, context, progress, host-call and execution budgets are enforced by the host, not by the mod: 16 mods, 16 tools and 16 commands per mod, 1 KiB context fragments under a 6 KiB aggregate, 32 host calls and 32 progress updates per callback, a per-evaluation `hook_budget_ms` with a separate 5 s total for the whole callback including host-call replays, and 64 KiB state.

- **first_party_parity** — First-party mods use the published API only. `omd_coordination`, `omd_workspace`, and `omd_recovery` declare ordinary capabilities, carry no private symbol and no per-mod Rust patch, and run under the same package and conformance rules as outside packages.

## Not supported and not replaceable

- Native workflow-contract enforcement, permissions, spending grants, cancellation, provider credentials, workspace integrity, durable evidence and final acceptance.
- Raw history rewriting, arbitrary compaction engines, custom prompts for provider-side remote compaction.
- Raw terminal escape sequences, arbitrary widgets or DOM/canvas access, overriding native key bindings, transcript mutation, and clipboard authorization bypass.
- Arbitrary provider compatibility, runtime imports other than the documented Pi `typebox` shim, and any second scheduler or uncontrolled execution path.
- Mod-to-mod calls: `requires` declares presence and order only; mods never call each other or share state.

## Conformance evidence

`rust:` `runtime/omd/tests/mods.rs` · `patch:` patched native/TUI tests ·
`node:` `mods/runner.test.mjs` · `python:` `tests/` · `fixture:` profile/scenario of
`benchmarks.controlled_fixture` · `terminal:` check of `benchmarks.mod_terminal_fixture`.
Each reference is resolved by `scripts/mod_conformance.py`.

| Decision or rule | Executable evidence |
| --- | --- |
| coordination.lead_route | `rust:exclusive_decisions_require_a_replacement_registration_while_observers_compose` · `fixture:routing/success` · `fixture:conformance/success` |
| coordination.worker_context | `rust:worker_context_is_exclusive_typed_and_failure_isolated` · `fixture:coordination-focused/success` · `fixture:coordination-shared/success` · `fixture:coordination-parent/success` |
| coordination.agents | `fixture:full/success` · `fixture:cancel/success` · `rust:native_host_bridge_preserves_once_only_effects_and_rust_capability_checks` |
| coordination.delegation | `fixture:conformance/success` · `fixture:preview/success` · `fixture:preview-denied/direct` |
| coordination.review | `fixture:policy/completion` |
| coordination.recovery | `fixture:recovery/escalation` · `fixture:recovery-denied/escalation` · `fixture:recovery-broken/escalation` |
| coordination.outage_recovery | `fixture:recovery/outage-fallback` · `fixture:recovery-pause/outage-fallback` · `fixture:recovery/outage-drift` |
| coordination.workflow_contract | `rust:a_workflow_mod_registers_a_contract_it_cannot_select_or_weaken` · `rust:a_registered_contract_may_not_redefine_a_bundled_contract_or_skip_its_capability` · `rust:two_mods_may_not_own_the_same_workflow_contract` |
| coordination.providers | `fixture:provider/success` |
| coordination.task_status | `fixture:full/success` · `fixture:opaque/direct` |
| context.assembly | `rust:mod_context_is_bounded_and_callback_failure_is_isolated` · `rust:exclusive_decisions_require_a_replacement_registration_while_observers_compose` · `fixture:conformance/success` |
| context.input | `rust:input_rewrite_requires_exclusive_replacement_while_observers_may_deny` · `fixture:lifecycle/success` · `fixture:deny/success` |
| context.compaction | `fixture:lifecycle/success` |
| context.checkpoint | `fixture:full/success` |
| context.state | `rust:mod_state_refreshes_per_call_and_racing_writers_fail_without_lost_updates` · `rust:migration_is_explicit_bounded_and_preserves_previous_state` · `rust:project_scope_takes_precedence_over_user_scope_without_sharing_state` |
| context.lifecycle | `rust:command_descriptions_tool_labels_and_lifecycle_events_register` · `fixture:lifecycle/success` · `fixture:conformance/success` |
| context.pi_resources | `rust:pi_nested_skills_honor_ignore_rules_and_frontmatter` · `rust:pi_prompt_expansion_matches_pi_0_74_oracle` · `fixture:opaque/direct` |
| tool.registration | `rust:native_schema_validation_applies_to_reload_before_activation` · `rust:tool_progress_is_forwarded_once_across_host_call_replay` · `fixture:counter/success` |
| tool.interception | `rust:exclusive_replacement_conflicts_fail_before_activation` · `fixture:opaque/direct` · `fixture:conformance/success` |
| tool.commands | `rust:command_outcomes_and_input_decisions_are_validated` · `patch:namespaced_commands_always_exist_and_bare_aliases_only_when_unique` · `terminal:namespaced_command` |
| tool.execution | `fixture:full/success` · `fixture:opaque/direct` |
| tool.sidecars | `fixture:full/success` · `fixture:failure/success` |
| tool.progress | `rust:tool_progress_is_forwarded_once_across_host_call_replay` · `fixture:conformance/success` · `terminal:activity_line` |
| terminal.view | `patch:custom_panel_reserves_space_and_narrow_terminal_preserves_native_composer` · `rust:terminal_components_compose_in_dependency_order_and_old_observers_remain_observe_only` · `rust:contested_exclusive_replacement_disables_every_claimant_and_keeps_the_rest` · `fixture:conformance/success` · `fixture:conformance-conflict/success` |
| terminal.panels | `patch:left_sidebar_header_progress_and_diagnostics_share_the_layout` · `patch:components_preserve_focus_scroll_and_values_across_redraw_and_resize` · `terminal:task_panel` · `terminal:customized_panels` |
| terminal.theme | `patch:theme_slots_map_indexed_and_rgb_colors` · `terminal:accent_color` · `terminal:user_message_background` |
| terminal.keybindings | `patch:native_escape_and_cancel_keys_cannot_be_intercepted` · `rust:terminal_validation_rejects_control_sequences_reserved_keys_and_unbounded_views` · `terminal:key_submit` · `terminal:key_conflict_visible` |
| terminal.rendering | `rust:terminal_validation_rejects_control_sequences_reserved_keys_and_unbounded_views` · `patch:focus_flow_compacts_only_successful_agent_output` · `fixture:full/success` |
| kernel.request_stream_middleware | `rust:request_and_stream_middleware_preserve_authority_and_provenance` · `node:typed middleware and services register without ambient authority` |
| kernel.inter_mod_services | `rust:typed_services_are_host_routed_versioned_and_generate_installed_types` · `rust:missing_incompatible_optional_cyclic_and_colliding_services_fail_independently` · `node:typed middleware and services register without ambient authority` |
| order | `rust:composition_order_is_declared_dependencies_first_then_mod_id` · `fixture:conformance/success` |
| exclusive_versus_middleware | `rust:exclusive_decisions_require_a_replacement_registration_while_observers_compose` · `rust:input_rewrite_requires_exclusive_replacement_while_observers_may_deny` · `fixture:conformance/success` |
| terminal_patch_composition | `rust:terminal_components_compose_in_dependency_order_and_old_observers_remain_observe_only` · `rust:a_failed_terminal_patch_is_transactional` |
| conflict_before_activation | `rust:contested_exclusive_replacement_disables_every_claimant_and_keeps_the_rest` · `rust:two_mods_may_not_own_the_same_workflow_contract` · `fixture:conformance-conflict/success` |
| dependencies_and_cycles | `rust:a_dependency_cycle_is_rejected_before_activation_and_isolated` · `rust:an_unavailable_dependency_disables_only_the_dependent_chain` |
| user_project_precedence | `rust:project_scope_takes_precedence_over_user_scope_without_sharing_state` · `rust:two_selections_of_one_id_in_the_same_scope_both_fail_closed` · `rust:pi_and_native_discovery_preserve_project_precedence_without_trust` · `fixture:conformance-conflict/success` |
| failed_mod_isolation | `rust:a_mod_that_throws_while_activating_is_disabled_with_a_source_located_error` · `fixture:conformance/success` · `fixture:preview-denied/direct` · `terminal:mod_error_did_not_stop_the_host` |
| reload | `rust:mod_reload_is_transactional_and_stale_calls_are_rejected` · `rust:disabling_during_native_work_preserves_inflight_source_and_revokes_next_generation` · `terminal:reload_applies_the_edit` · `terminal:session_preserved_across_reload` |
| cancellation | `rust:mod_cancellation_discards_state_and_explicit_reload_recovers` · `rust:mod_pending_callback_has_a_host_deadline` · `fixture:cancel/success` · `terminal:cancelled_turn_recorded` |
| streaming | `rust:tool_progress_is_forwarded_once_across_host_call_replay` · `fixture:conformance/success` · `terminal:activity_line` |
| limits | `rust:host_call_replay_is_not_charged_against_the_per_evaluation_hook_budget` · `rust:mod_context_is_bounded_and_callback_failure_is_isolated` · `rust:mod_pending_callback_has_a_host_deadline` · `rust:terminal_validation_rejects_control_sequences_reserved_keys_and_unbounded_views` |
| first_party_parity | `python:test_first_party_mods_use_only_the_published_api` · `fixture:conformance/success` |
