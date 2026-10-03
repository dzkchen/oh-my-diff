# Extension types

<!-- Generated from mods/extension-types.json by scripts/mod_extension_types.py --write. -->

Use a skill for instructed procedures, a hook for lifecycle reactions, a plugin for tools or services, and a mod only for live engine or terminal replacement.

A conformance fixture is retained source and executable coverage, not a package offered
to users. The author SDK packs only author examples. The current private-preview bundle
contains only the packages labeled `bundled` below.

## Bundled packages

| Package | Extension type | Source | Why a mod is required for this behavior |
| --- | --- | --- | --- |
| `omd_coordination@0.2.0-preview.1` | `mod` | `mods/first-party/omd_coordination` | Replaces live task-entry routing and context assembly, and exports bounded delegation preparation to the recovery policy. |
| `omd_recovery@0.2.0-preview.2` | `mod` | `mods/first-party/omd_recovery` | Replaces live escalation and delegation dispatch with failure classification, eligible-tool, advisory-route, and Contributor-outage choices. |
| `omd_workflow@0.2.0-preview.2` | `mod` | `mods/first-party/omd_workflow` | Owns live workflow selection, contract gates, candidate checks, and task decisions through generic host services and bounded receipts. |
| `omd_workspace@0.2.0-preview.4` | `mod` | `mods/first-party/omd_workspace` | Replaces the live terminal workspace, render sites, key actions, and streamed activity presentation. |

## Unqualified first-party candidates

| Package | Extension type | Source | Why a mod is required for this behavior |
| --- | --- | --- | --- |
| `omd_claude_cli@0.2.0-preview.2` | `mod` | `mods/first-party/omd_claude_cli` | Owns the Claude CLI model catalog, request translation and ask_claude delegation over a host-approved provider service while the native host executes every tool and keeps permissions, accounting and cancellation. |
| `omd_task_tools@0.2.0-preview.1` | `mod` | `mods/first-party/omd_task_tools` | Selects owned optional tools at the native per-request boundary from the current host checkpoint; a static skill or plugin cannot change that exposure for each task step. |
| `omd_checks@0.1.0-preview.1` | `mod` | `mods/first-party/omd_checks` | Selects bounded language-specific verification commands for the current candidate snapshot and relevant inputs during a live task. |
| `omd_repository_analysis@0.1.0-preview.2` | `mod` | `mods/first-party/omd_repository_analysis` | Builds a source-bound repository graph and compares approved dependency-boundary baselines during a live task through generic workspace and store operations. |
| `omd_guideline_governance@0.1.0-preview.1` | `mod` | `mods/first-party/omd_guideline_governance` | Keeps proposals inert until explicit command activation, then uses revision-checked store state and source evidence to manage a task-visible guideline selection. |
| `omd_source_knowledge@0.1.0-preview.3` | `mod` | `mods/first-party/omd_source_knowledge` | Refreshes source-bound repository facts against the current workspace and stores revision-checked evidence for live task reuse. |
| `omd_project_pi_prompts@0.1.0-preview.2` | `mod` | `mods/first-party/omd_project_pi_prompts` | Discovers and expands source-bound project prompts and skills against the current workspace during a live task. |
| `omd_graph_navigator@0.2.0-preview.2` | `mod` | `mods/first-party/omd_graph_navigator` | Presents version-bound repository graph neighbors and source-linked evidence in the live terminal through generic workspace and rendering operations. |
| `omd_inspector@0.2.0-preview.1` | `mod` | `mods/first-party/omd_inspector` | Replaces the live terminal inspector dialog and refresh actions while reading generic task, contract, ledger, and install identity state. |
| `omd_session_anchor@0.2.0-preview.1` | `mod` | `mods/first-party/omd_session_anchor` | Replaces the local compaction decision and injects bounded host checkpoint anchors during a live session. |
| `omd_typed_tasks@0.2.0-preview.1` | `mod` | `mods/first-party/omd_typed_tasks` | Owns the live typed task tool, bounded sibling dispatch and result-schema validation while using generic native worker and isolated integration operations. |
| `omd_verification_gate@0.2.0-preview.1` | `mod` | `mods/first-party/omd_verification_gate` | Registers an explicitly selected native workflow contract and asks the host to restrict delegation when an exact candidate enters final verification. |
| `omd_logo@0.2.0-preview.1` | `mod` | `mods/first-party/omd_logo` | Draws the Oh My Diff wordmark and launch status into the terminal header from the read-only launch identity. |
| `omd_model_picker@0.3.0-preview.1` | `mod` | `mods/first-party/omd_model_picker` | Selects the compact native model and reasoning picker presentation while native keeps rows, warnings and persistence. |
| `omd_git@0.2.0-preview.3` | `mod` | `mods/first-party/omd_git` | Adds a live Git sidebar with previews and confirmations over host-owned, fingerprint-checked Git operations. |
| `omd_lsp_sync@0.5.0-preview.1` | `mod` | `mods/first-party/omd_lsp_sync` | Owns live language-server synchronization, post-edit diagnostic feedback and rename/edit planning through generic host process, workspace and tool-output operations; exports the omd.lsp query service for the code-intelligence view. |
| `omd_advisor@0.3.0-preview.1` | `mod` | `mods/first-party/omd_advisor` | Owns on-demand, triggered and completed-turn advice, independent review prompts, typed result validation, deduplication and selected-context presentation through public accounted review primitives. |
| `omd_research@0.2.0-preview.1` | `mod` | `mods/first-party/omd_research` | Owns lead-requested broad-research admission, bounded briefing and evidence validation using an explicitly granted read-only host worker preset. |
| `omd_theme@0.4.0-candidate.2` | `mod` | `mods/first-party/omd_theme` | Composes live terminal palettes, backgrounds, composer appearance, greeting settings, a powerline status line from thread notifications and a composer-draft stash through public presentation, composer and app primitives; installed inactive in OMD+. |
| `omd_reactive_rules@0.1.0-preview.1` | `mod` | `mods/first-party/omd_reactive_rules` | Matches bounded explicit rules against completed response items and requests a stream stop and retry through response_stream middleware; installed inactive in OMD+. |
| `omd_programmable_context@0.1.0-preview.1` | `mod` | `mods/first-party/omd_programmable_context` | Owns the Python-facing context, child-agent and refinement API plus a versioned session harness in the model-bound request view; installed inactive in OMD+. |
| `omd_plan_removal@0.1.0-preview.1` | `mod` | `mods/first-party/omd_plan_removal` | Owns the plan-mode removal policy through public builtins controls (hidden /plan, disabled plan mode, turn-start clamp); installed inactive in OMD+. |
| `omd_continue@0.1.0-preview.1` | `mod` | `mods/first-party/omd_continue` | Owns the user-typed /continue recovery prompt and a bounded summary built only from the host turn-activity ledger; installed inactive in OMD+. |
| `omd_preview@0.1.0-preview.3` | `mod` | `mods/first-party/omd_preview` | Owns the user-typed /preview command, its packaged Markdown renderer, file watches and the inline preview dialog; installed inactive in OMD+. |
| `omd_mods@0.1.0-preview.1` | `mod` | `mods/first-party/omd_mods` | Owns the /mods screen, its actions and the first-run card over public package controls and terminal sites; native code keeps trust, confirmation, package authority and /omd recovery; enabled by default in both profiles. |
| `omd_muse@0.1.0-preview.1` | `mod` | `mods/first-party/omd_muse` | Owns the Muse MSP client, approval relay and research tool over a host-approved provider service; installed inactive in OMD+. |
| `omd_panes@0.1.0-preview.3` | `mod` | `mods/first-party/omd_panes` | Owns the pane layout, file tree, viewer and shell panes through public layout, terminal, PTY, workspace-transaction and thread-store primitives, ranking tree find through the optional omd.frecency service; installed inactive in OMD+. |
| `omd_layout@0.1.0-preview.1` | `mod` | `mods/first-party/omd_layout` | Composes the session list, find, quick open and palettes from app-server thread, model and skill inventory, the terminal command inventory and the optional omd.panes, omd.worktrees and omd.frecency services; installed inactive in OMD+. |
| `omd_worktree@0.1.0-preview.1` | `mod` | `mods/first-party/omd_worktree` | Creates, switches, integrates and removes task worktrees through fixed Git argument lists, guarded exec writes, native prompts and app-server thread starts bound to registered worktree roots; installed inactive in OMD+. |
| `omd_notes@0.1.0-preview.1` | `mod` | `mods/first-party/omd_notes` | Owns the notes vault view, wiki-link index, note commands, its own command-argument completion and opt-in agent tools; installed inactive in OMD+. |
| `omd_editor@0.1.0-preview.1` | `mod` | `mods/first-party/omd_editor` | Owns editable file buffers, their rendering, key handling, Git gutter and conflict recovery over public key documents, workspace transactions and watches, composing omd_panes, omd_git and omd_lsp_view through their commands; installed inactive in OMD+. |
| `omd_shared_checkout@0.1.0-preview.1` | `mod` | `mods/first-party/omd_shared_checkout` | Owns the shared-checkout registry, path reservations, handoffs and Git lease in mod state and enforces them for agent patches, Git commands and recognizable shell writes through approval middleware; installed inactive in OMD+. |
| `omd_mini@0.1.0-preview.1` | `mod` | `mods/first-party/omd_mini` | Owns the mini presentation of omd mini sessions: hidden inline sites, compact tool summaries, a short prompt, one status segment and the switch request read by the launcher; installed inactive in OMD+. |
| `omd_lsp_view@0.2.0-preview.1` | `mod` | `mods/first-party/omd_lsp_view` | Owns the user-invoked code-intelligence view, its request hop, result navigation over the omd.lsp service, file-view diagnostics and the language-server sidebar pane; installed inactive in OMD+. |
| `omd_frecency@0.1.0-preview.2` | `mod` | `mods/first-party/omd_frecency` | Owns @ mention ranking through the exclusive completion replacement, queues paths from submitted input and learns them at turn start into repository storage and serves the omd.frecency ranking service; installed inactive in OMD+. |
| `omd_plan_panel@0.1.0-preview.1` | `mod` | `mods/first-party/omd_plan_panel` | Pins Codex's update_plan steps above the composer from turn/plan/updated notifications in a wrapped above_composer site with a collapse key; installed inactive in OMD+. |
| `omd_profiles@0.1.0-preview.1` | `mod` | `mods/first-party/omd_profiles` | Owns profile selection, setup guidance, paid-route consent and status over host credential flows and routes.select, plus the loopback router that adapts Chat Completions and Anthropic Messages providers; installed inactive in OMD+. |
| `omd_herdr@0.1.0-preview.1` | `mod` | `mods/first-party/omd_herdr` | Maps native thread status notifications to Herdr pane reports with the session resume command and releases the pane on exit, through declared environment metadata, exec.run and a granted Unix socket; installed inactive in OMD+. |
| `omd_mcp@0.1.0-preview.1` | `mod` | `mods/first-party/omd_mcp` | Owns the MCP server sidebar from startup notifications, per-server status, failed tool calls, the redacted configuration and plugin inventory, confirmed enable/disable writes, reload and composer-drafted upstream codex mcp setup commands; installed inactive in OMD+. |

## Author examples

| Package | Extension type | Source | Why a mod is required for this behavior |
| --- | --- | --- | --- |
| `coordination@2.0.0` | `mod` | `mods/examples/coordination` | Drives live native agent spawning, waiting, result consumption, and lifecycle state inside the active task. |
| `kernel@2.0.0` | `mod` | `mods/examples/kernel` | Alters admitted model requests and the live response stream, which hooks and plugins cannot replace. |
| `recovery@2.0.0` | `mod` | `mods/examples/recovery` | Replaces live compaction and context recovery policy while reading host-owned checkpoint state. |
| `routing@2.0.0` | `mod` | `mods/examples/routing` | Replaces the model, provider, and reasoning preset selected at the live request boundary. |
| `terminal@2.0.0` | `mod` | `mods/examples/terminal` | Replaces live terminal layout, theme, render templates, and key handling. |
| `workflow@2.0.0` | `mod` | `mods/examples/workflow` | Registers and restricts a host-enforced workflow contract during a live task without owning native guarantees. |
| `workspace_author@2.0.0` | `mod` | `mods/examples/workspace` | Exercises reusable live workspace read, pre-rename events and host-authorized transactions. |
| `example_virtual_reader@2.0.0` | `plugin` | `mods/examples/virtual_reader` | Registers an independent virtual resource using the shared sandboxed extension bridge; the provider owns its resource grammar and content. |
| `example_scoped_data@2.0.0` | `mod` | `mods/examples/scoped_data` | Demonstrates scoped fact selection and frozen live context reuse, plus commands through the same public bridge. |
| `example_review_probe@2.0.0` | `hook` | `mods/examples/review_probe` | Owns a bounded completed-turn procedure and result interpretation through the shared accounted review interface. |
| `example_service_request@2.0.0` | `plugin` | `mods/examples/service_request` | Uses only a public tool export and a granted generic service request; no live engine replacement. |
| `release_check@1.0.0` | `mod` | `mods/examples/release_check` | An independent author package that uses only the 0.2 host primitives: a contract document, receipts, sandboxed commands, workspace listing, durable store and evidence, stream control, built-in controls and a list replacement. |
| `snapshot_review@1.0.0` | `mod` | `mods/examples/snapshot_review` | Demonstrates live frozen-workspace review, scoped restrictions, receipts, and resumable agent evidence using only the public mod API. |

## Conformance fixtures

| Package | Extension type | Source | Why a mod is required for this behavior |
| --- | --- | --- | --- |
| `context@2.0.0` | `mod` | `mods/examples/context` | Exercises the bounded context observer API only; user-facing guidance belongs in a skill or lifecycle hook. |
| `counter@2.0.0` | `mod` | `mods/examples/counter` | Exercises tool, command, progress, and durable-state conformance only; a user-facing counter would be a plugin tool. |
| `guard@2.0.0` | `mod` | `mods/examples/guard` | Exercises input and lifecycle replacement conformance only; a user-facing deterministic guard would be a hook. |
| `interception@2.0.0` | `mod` | `mods/examples/interception` | Exercises simple tool interception conformance only; user-facing tool policy belongs in a hook or plugin. |
| `service_consumer@2.0.0` | `mod` | `mods/examples/service-consumer` | Exercises a host-routed service import only; a user-facing service consumer belongs in a plugin. |
| `service_provider@2.0.0` | `mod` | `mods/examples/service-provider` | Exercises a host-routed service export only; a user-facing service belongs in a plugin. |
| `atlas_console@1.0.0` | `mod` | `mods/exercise/atlas_console/1.0.0` | Exercises an older supported API row for live terminal replacement and state migration. |
| `atlas_console@2.0.0` | `mod` | `mods/exercise/atlas_console/2.0.0` | Exercises current live terminal replacement, interaction, and migrated state. |
| `atlas_policy@1.0.0` | `mod` | `mods/exercise/atlas_policy/1.0.0` | Exercises an older supported API row for live routing policy and state migration. |
| `atlas_policy@2.0.0` | `mod` | `mods/exercise/atlas_policy/2.0.0` | Exercises current live routing, context, coordination, interception, and cross-mod service replacement. |
| `task_scope@1.0.0` | `mod` | `mods/exercise/task_scope` | Exercises task-scoped optional tool exposure at each native sampling step. |
| `session_anchor@1.0.0` | `mod` | `mods/exercise/session_anchor` | Exercises bounded live compaction and checkpoint-derived context across reload. |
| `approval_guard@1.0.0` | `mod` | `mods/examples/approval_guard` | Tightens live native approval decisions before hooks and automatic review, which hooks cannot force. |
| `channel_pair@1.0.0` | `mod` | `mods/examples/channel_pair` | Publishes and receives namespaced in-process channel events between live mods. |
| `confirm_note@1.0.0` | `mod` | `mods/examples/confirm_note` | Asks the user through native text and confirmation prompts from a live command. |
| `context_fold@1.0.0` | `mod` | `mods/examples/context_fold` | Replaces the model-bound request history at each request without changing the transcript. |
| `edit_diagnostics@1.0.0` | `mod` | `mods/examples/edit_diagnostics` | Appends composable feedback to live tool output before it reaches the model. |
| `frecency_rank@1.0.0` | `mod` | `mods/examples/frecency_rank` | Replaces live composer mention ranking inside the terminal. |
| `goal_store@1.0.0` | `mod` | `mods/examples/goal_store` | Keeps thread-scoped state that forks and deletes with the live thread. |
| `command_help@1.0.0` | `mod` | `mods/examples/command_help` | Lists the session's built-in and mod slash commands from the live terminal inventory. |
| `port_list@1.0.0` | `mod` | `mods/examples/port_list` | Lists the TCP listeners of the current session's background terminals from the live host. |
| `checkout_board@1.0.0` | `mod` | `mods/examples/checkout_board` | Keeps one state per Git checkout that every OMD session working there shares. |
| `quiet_inline@1.0.0` | `mod` | `mods/examples/quiet_inline` | Keeps inline scrollback free of every mod sidebar and header for screen readers and plain terminals. |
| `image_preview@1.0.0` | `mod` | `mods/examples/image_preview` | Renders an imported image inside a live terminal render site and opens links after native confirmation. |
| `layout_explorer@1.0.0` | `mod` | `mods/examples/layout_explorer` | Replaces the live terminal layout with splits, tabs, documents and diffs. |
| `notification_bridge@1.0.0` | `mod` | `mods/examples/notification_bridge` | Turns live app-server notifications into terminal notifications with focus state. |
| `output_budget@1.0.0` | `mod` | `mods/examples/output_budget` | Replaces model-visible tool output at the live tool boundary while the host keeps the original. |
| `package_panel@1.0.0` | `mod` | `mods/examples/package_panel` | Drives package controls behind native confirmation from a live terminal panel. |
| `profile_switcher@1.0.0` | `mod` | `mods/examples/profile_switcher` | Selects credential-bound routes at the live request boundary. |
| `read_batcher@1.0.0` | `mod` | `mods/examples/read_batcher` | Merges parallel-safe tool calls of one live response into a single call. |
| `screenshot_attach@1.0.0` | `mod` | `mods/examples/screenshot_attach` | Writes binary evidence and attaches it to the live composer. |
| `shell_pane@1.0.0` | `mod` | `mods/examples/shell_pane` | Runs a sandboxed interactive shell rendered inside a live terminal pane. |
| `status_tools@1.0.0` | `mod` | `mods/examples/status_tools` | Defines a model-visible tool at run time and refreshes its answer from a keyed timer. |
| `site_vault@1.0.0` | `mod` | `mods/examples/site_vault` | Enrolls origin-bound secrets through native prompts and hands them only to its sidecars. |
| `summarize_tool@1.0.0` | `mod` | `mods/examples/summarize_tool` | Runs one-shot completions on configured worker routes under live admission and the ledger. |
| `tool_guide@1.0.0` | `mod` | `mods/examples/tool_guide` | Re-describes model-visible tool specs per route when the live tool router is built. |
| `turn_recap@1.0.0` | `mod` | `mods/examples/turn_recap` | Reads the host turn-activity ledger for the live thread. |
| `watch_notify@1.0.0` | `mod` | `mods/examples/watch_notify` | Watches workspace paths and reports external changes through live terminal notifications. |
| `worktree_task@1.0.0` | `mod` | `mods/examples/worktree_task` | Starts a live thread bound to a permitted worktree root and shows it in the terminal. |

## Synthetic conformance fixtures

| Fixture | Extension type | Location | Boundary |
| --- | --- | --- | --- |
| `reader` | `mod` | `runtime/omd/tests/integration.rs` | Exercises bounded Pi resource discovery and command coexistence; a user-facing reader belongs in a plugin with skills. |
| `tool` | `mod` | `runtime/omd/tests/integration.rs` | Exercises duplicate tool slots, progress, and reload boundaries; a user-facing tool belongs in a plugin. |

The small context, counter, guard, interception, service, reader, and tool cases remain
available to repository conformance checks. They are not copied by `omd-mod-author examples`,
not packed as SDK examples, and not part of the private-preview bundle.
