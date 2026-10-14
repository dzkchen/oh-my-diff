# Extension types

<!-- Generated from mods/extension-types.json by scripts/mod_extension_types.py --write. -->

Use a skill for instructed procedures, a hook for lifecycle reactions, a plugin for tools or services, and a mod only for live engine or terminal replacement.

A conformance fixture is retained source and executable coverage, not a package offered
to users. The author SDK packs only author examples. The current private-preview bundle
contains only the packages labeled `bundled` below.

## Bundled packages

| Package | Extension type | Source | Why a mod is required for this behavior |
| --- | --- | --- | --- |
| `omd_workflow@0.2.0-preview.2` | `mod` | `mods/first-party/omd_workflow` | Owns live workflow selection, contract gates, candidate checks, and task decisions through generic host services and bounded receipts. |

## Unqualified first-party candidates

| Package | Extension type | Source | Why a mod is required for this behavior |
| --- | --- | --- | --- |
| `omd_claude_cli@0.2.0-preview.3` | `mod` | `mods/first-party/omd_claude_cli` | Owns the Claude CLI model catalog, request translation and ask_claude delegation over a host-approved provider service while the native host executes every tool and keeps permissions, accounting and cancellation. |
| `omd_inspector@0.2.0-preview.1` | `mod` | `mods/first-party/omd_inspector` | Replaces the live terminal inspector dialog and refresh actions while reading generic task, contract, ledger, and install identity state. |
| `omd_logo@0.2.0-preview.1` | `mod` | `mods/first-party/omd_logo` | Draws the Oh My Diff wordmark and launch status into the terminal header from the read-only launch identity. |
| `omd_model_picker@0.3.0-preview.2` | `mod` | `mods/first-party/omd_model_picker` | Selects the compact native model and reasoning picker presentation while native keeps rows, warnings and persistence. |
| `omd_statusline@0.1.0-preview.1` | `mod` | `mods/first-party/omd_statusline` | Draws a configurable status line in the generic below- or above-composer site from public telemetry, exec and HTTP grants; it turns off the native status row through built-in controls only while active; active by default in OMD+. |
| `omd_tool_lines@0.1.0-preview.1` | `mod` | `mods/first-party/omd_tool_lines` | Owns a render hook on the generic tool_call site that draws one line per agent tool call; the host keeps the native row, its expansion and copy; active by default in OMD+. |
| `omd_lsp_sync@0.5.0-preview.1` | `mod` | `mods/first-party/omd_lsp_sync` | Owns live language-server synchronization, post-edit diagnostic feedback and rename/edit planning through generic host process, workspace and tool-output operations; exports the omd.lsp query service for the code-intelligence view. |
| `omd_advisor@0.4.0-preview.1` | `mod` | `mods/first-party/omd_advisor` | Owns on-demand, triggered and completed-turn advice, the opt-in important-output observer, independent review prompts, typed result and citation validation, deduplication and selected-context presentation through public accounted review primitives. |
| `omd_plan_removal@0.1.0-preview.1` | `mod` | `mods/first-party/omd_plan_removal` | Owns the plan-mode removal policy through public builtins controls (hidden /plan, disabled plan mode, turn-start clamp); enabled by default in OMD+. |
| `omd_preview@0.2.0-preview.1` | `mod` | `mods/first-party/omd_preview` | Owns the user-typed /preview command, its packaged Markdown renderer, file watches, the inline preview dialog, inline Mermaid drawings of assistant messages and draft image thumbnails above the composer; installed inactive in OMD+. |
| `omd_mods@0.1.0-preview.1` | `mod` | `mods/first-party/omd_mods` | Owns the /mods screen, its actions and the first-run card over public package controls and terminal sites; native code keeps trust, confirmation, package authority and /omd recovery; enabled by default in both profiles. |
| `omd_update@0.1.0-preview.1` | `mod` | `mods/first-party/omd_update` | Owns the update notice, the /update dialog, snooze and skip state and the update policy settings (checks, channel, cadence, pin, automatic updates); the installer reads those settings and does the network check and installation; active in OMD Core and OMD+. |
| `omd_privacy@0.1.0-preview.1` | `mod` | `mods/first-party/omd_privacy` | Owns secret and PII detection, sensitive-path rules, reviewed exemptions and salted placeholders as a required model_send policy and approval middleware over the generic final-request stage; installed inactive in OMD+. |
| `omd_usage@0.1.0-preview.1` | `mod` | `mods/first-party/omd_usage` | Owns the provider usage HUD: a per-thread request ledger from model_response, cache, cost and quota classification, the usage and workers row above the composer, the usage dialog and the summary the theme draws; installed inactive in OMD+. |
| `omd_lsp_view@0.2.0-preview.1` | `mod` | `mods/first-party/omd_lsp_view` | Owns the user-invoked code-intelligence view, its request hop, result navigation over the omd.lsp service, file-view diagnostics and the on-demand language-server pane; installed inactive in OMD+. |
| `omd_frecency@0.1.0-preview.2` | `mod` | `mods/first-party/omd_frecency` | Owns @ mention ranking through the exclusive completion replacement, queues paths from submitted input and learns them at turn start into repository storage and serves the omd.frecency ranking service; installed inactive in OMD+. |
| `omd_profiles@0.1.0-preview.2` | `mod` | `mods/first-party/omd_profiles` | Owns profile selection, setup guidance, paid-route consent and status over host credential flows and routes.select, plus the loopback router that adapts Chat Completions and Anthropic Messages providers; installed inactive in OMD+. |

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
| `render_hooks@1.0.0` | `mod` | `mods/examples/render_hooks` | Redraws native terminal components: a custom spinner, framed tool calls, annotated assistant messages and a wrapped question. |
| `reactive_dashboard@1.0.0` | `mod` | `mods/examples/reactive_dashboard` | Keeps a form, a streamed status and a derived summary on keyed reactive state. |

## Conformance fixtures

| Package | Extension type | Source | Why a mod is required for this behavior |
| --- | --- | --- | --- |
| `os_tools@1.0.0` | `mod` | `mods/examples/os_tools` | Runs a granted program outside the session sandbox with host-supervised lifecycle and revocation. |
| `context@2.0.0` | `mod` | `mods/examples/context` | Exercises the bounded context observer API only; user-facing guidance belongs in a skill or lifecycle hook. |
| `counter@2.0.0` | `mod` | `mods/examples/counter` | Exercises tool, command, progress, and durable-state conformance only; a user-facing counter would be a plugin tool. |
| `guard@2.0.0` | `mod` | `mods/examples/guard` | Exercises input and lifecycle replacement conformance only; a user-facing deterministic guard would be a hook. |
| `interception@2.0.0` | `mod` | `mods/examples/interception` | Exercises simple tool interception conformance only; user-facing tool policy belongs in a hook or plugin. |
| `service_consumer@2.0.0` | `mod` | `mods/examples/service-consumer` | Exercises a host-routed service import only; a user-facing service consumer belongs in a plugin. |
| `service_provider@2.0.0` | `mod` | `mods/examples/service-provider` | Exercises a host-routed service export only; a user-facing service belongs in a plugin. |
| `approval_guard@1.0.0` | `mod` | `mods/examples/approval_guard` | Tightens live native approval decisions before hooks and automatic review, which hooks cannot force. |
| `ghost_history@1.0.0` | `mod` | `mods/examples/ghost_history` | Suggests the rest of a recent prompt as revision-bound ghost text from draft change events, which skills and hooks cannot draw. |
| `paste_tidy@1.0.0` | `mod` | `mods/examples/paste_tidy` | Rewrites or refuses pasted draft text through the composer_edit interceptor chain before it reaches the draft. |
| `key_remap@1.0.0` | `mod` | `mods/examples/key_remap` | Rewrites matched keystrokes through the composer_key interceptor chain before the prompt box applies them. |
| `input_guard@1.0.0` | `mod` | `mods/examples/input_guard` | Drops matched keystrokes through the composer_key interceptor chain before the prompt box applies them. |
| `shortcodes@1.0.0` | `mod` | `mods/examples/shortcodes` | Supplies composer completion rows for its own token triggers, which skills and hooks cannot add to the prompt box. |
| `mention_guard@1.0.0` | `mod` | `mods/examples/mention_guard` | Redirects or refuses the host's read of @-mentioned files through the mention interceptor chain. |
| `approval_delegate@1.0.0` | `mod` | `mods/examples/approval_delegate` | Approves routine check commands inside a user-delegated native approval grant, which hooks and skills cannot hold. |
| `admission_guard@1.0.0` | `mod` | `mods/examples/admission_guard` | Refuses or restricts other mods at load and guards host requests under a user-granted policy, which hooks and skills cannot do. |
| `command_curator@1.0.0` | `mod` | `mods/examples/command_curator` | Rewrites slash-command and settings metadata, arguments and writes through host continuations that hooks and skills cannot reach. |
| `channel_pair@1.0.0` | `mod` | `mods/examples/channel_pair` | Publishes and receives namespaced in-process channel events between live mods. |
| `confirm_note@1.0.0` | `mod` | `mods/examples/confirm_note` | Asks the user through native text and confirmation prompts from a live command. |
| `context_fold@1.0.0` | `mod` | `mods/examples/context_fold` | Replaces the model-bound request history at each request without changing the transcript. |
| `edit_diagnostics@1.0.0` | `mod` | `mods/examples/edit_diagnostics` | Appends composable feedback to live tool output before it reaches the model. |
| `frecency_rank@1.0.0` | `mod` | `mods/examples/frecency_rank` | Replaces live composer mention ranking inside the terminal. |
| `goal_store@1.0.0` | `mod` | `mods/examples/goal_store` | Keeps thread-scoped state that forks and deletes with the live thread. |
| `command_help@1.0.0` | `mod` | `mods/examples/command_help` | Lists the session's built-in and mod slash commands from the live terminal inventory. |
| `port_list@1.0.0` | `mod` | `mods/examples/port_list` | Lists the TCP listeners of the current session's background terminals from the live host. |
| `checkout_board@1.0.0` | `mod` | `mods/examples/checkout_board` | Keeps one state per Git checkout that every OMD session working there shares. |
| `readme_answers@1.0.0` | `mod` | `mods/examples/readme_answers` | Answers questions from the README through one-shot completions whose README prefix is marked for the provider's prompt cache. |
| `quiet_inline@1.0.0` | `mod` | `mods/examples/quiet_inline` | Keeps inline scrollback free of every mod sidebar and header for screen readers and plain terminals. |
| `image_preview@1.0.0` | `mod` | `mods/examples/image_preview` | Renders an imported image inside a live terminal render site and opens links after native confirmation. |
| `history_redact@1.0.0` | `mod` | `mods/examples/history_redact` | Redacts credentials from history text in the host's persistence path before the rollout is written. |
| `layout_explorer@1.0.0` | `mod` | `mods/examples/layout_explorer` | Replaces the live terminal layout with splits, tabs, documents and diffs. |
| `frame_stream@1.0.0` | `mod` | `mods/examples/frame_stream` | Streams managed-process raw or PNG frames into a full-pane raster and demonstrates optional child-owned mouse look. |
| `raster_canvas@1.0.0` | `mod` | `mods/examples/raster_canvas` | Draws an animated raster with pointer hover, drag and an anchored overlay. |
| `game_input@1.0.0` | `mod` | `mods/examples/game_input` | Runs a keyboard and pointer game in a component module on the frame clock and posts scores to its hooks. |
| `client_tag@1.0.0` | `mod` | `mods/examples/client_tag` | Ports Claude Code's Tag Client example to a component module that posts pointer clicks to its hooks. |
| `box_model@1.0.0` | `mod` | `mods/examples/box_model` | Draws bordered cards, flat filled panels, flex rows, hover and focus accents and a gapped split layout with the box model. |
| `external_client@1.0.0` | `mod` | `mods/examples/external_client` | Shows the attached-client roster and launches its own text renderer process that joins the session over the client protocol. |
| `live_output@1.0.0` | `mod` | `mods/examples/live_output` | Streams a sandboxed command's raw stdout and stderr above the composer as they are written. |
| `approval_desk@1.0.0` | `mod` | `mods/examples/approval_desk` | Keeps a filterable approval desk beside other sidebars, with a client adapter that answers approvals over the client protocol. |
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
| `tool_guide@1.0.0` | `mod` | `mods/examples/tool_guide` | Defers and re-describes model-visible tool specs per route through the composable tool_specs chain. |
| `tool_history@1.0.0` | `mod` | `mods/examples/tool_history` | Pages the latest repository session's tool calls and results through the host's scoped session reader. |
| `tool_workflows@1.0.0` | `mod` | `mods/examples/tool_workflows` | Caches, confirms and retries live tool calls through the continuation chain and the turn's tool executor. |
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
