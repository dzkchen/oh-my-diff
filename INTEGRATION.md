# Integration coverage

<!-- Generated from integration/matrix.json by scripts/integration_matrix.py --write. -->

Accumulated integration coverage for the rust-v0.159.1 pinned runtime as of
2026-09-29. Each component names its owner, version, retained fixtures, limits,
and removal path. Fixture references are cumulative; this source check does not rerun
them or qualify the full release candidate. The matrix is checked against the
shipped sources by `scripts/integration_matrix.py`: a version, capability, hook, language
or evidence reference that disagrees with the runtime fails the check.

**Qualification:** Development pin: the 0.159.1 patch, fresh replay, second-apply no-op and scoped checks are recorded in .docs/audits/upstream-pin-0159-20260929.md; API 0.2.0-experimental.5 appearance and identity work is recorded in .docs/audits/batch3aa-appearance-identity-20260929.md. The current OMD Core/OMD+ source selection is checked below. Final current-package installation, header/recovery and terminal evidence are separate from this source check; public delivery, archive compatibility and release candidate qualification remain open.

Combinations below are representative, not exhaustive. Exercising every possible
combination of mods, adapters and optional integrations is not promised; the untested
section names what is deliberately out of scope.

## Release

| Field | Value |
| --- | --- |
| codex | `0.159.1` |
| omd | `0.1.0` |
| mod api | `0.2.0-experimental.5` |
| package schema | `1` |
| upstream tag | `rust-v0.159.1` |
| upstream commit | `8e68a98ef03cdde76d2e6800791ebdf1b3b95b24` |
| target | `aarch64-apple-darwin` |
| node | `24.18.0` |

## Selected source inventory

This is the current package source selection, not proof of an installed or active session.
Opt-in mods remain disabled; plugin sources and their nested skills/hooks require separate installation and activation.

| Profile | Selector | Installed mod sources | Fresh-install default selection | Inactive plugin sources |
| --- | --- | --- | --- | --- |
| OMD Core | `platform` | omd_logo, omd_mods | omd_logo, omd_mods | none |
| OMD+ | `full` | omd_advisor, omd_checks, omd_claude_cli, omd_continue, omd_coordination, omd_frecency, omd_git, omd_graph_navigator, omd_guideline_governance, omd_herdr, omd_inspector, omd_layout, omd_logo, omd_lsp_sync, omd_lsp_view, omd_mcp, omd_model_picker, omd_mods, omd_muse, omd_notes, omd_panes, omd_plan_panel, omd_plan_removal, omd_preview, omd_profiles, omd_programmable_context, omd_project_pi_prompts, omd_reactive_rules, omd_recovery, omd_repository_analysis, omd_research, omd_source_knowledge, omd_task_tools, omd_theme, omd_typed_tasks, omd_workflow, omd_workspace, omd_worktree | omd_inspector, omd_logo, omd_model_picker, omd_mods, omd_workspace | omd-anchored-edit, omd-application-bridges, omd-artifact-reading, omd-browser, omd-curated-memory, omd-debugger, omd-guidance-hooks, omd-procedures, omd-review-policy, omd-session-review |

| Selected mod | Version | Source |
| --- | --- | --- |
| `omd_advisor` | 0.3.0-preview.1 | `mods/first-party/omd_advisor` |
| `omd_checks` | 0.1.0-preview.1 | `mods/first-party/omd_checks` |
| `omd_claude_cli` | 0.2.0-preview.2 | `mods/first-party/omd_claude_cli` |
| `omd_continue` | 0.1.0-preview.1 | `mods/first-party/omd_continue` |
| `omd_coordination` | 0.2.0-preview.1 | `mods/first-party/omd_coordination` |
| `omd_frecency` | 0.1.0-preview.1 | `mods/first-party/omd_frecency` |
| `omd_git` | 0.2.0-preview.2 | `mods/first-party/omd_git` |
| `omd_graph_navigator` | 0.2.0-preview.2 | `mods/first-party/omd_graph_navigator` |
| `omd_guideline_governance` | 0.1.0-preview.1 | `mods/first-party/omd_guideline_governance` |
| `omd_herdr` | 0.1.0-preview.1 | `mods/first-party/omd_herdr` |
| `omd_inspector` | 0.2.0-preview.1 | `mods/first-party/omd_inspector` |
| `omd_layout` | 0.1.0-preview.1 | `mods/first-party/omd_layout` |
| `omd_logo` | 0.2.0-preview.1 | `mods/first-party/omd_logo` |
| `omd_lsp_sync` | 0.5.0-preview.1 | `mods/first-party/omd_lsp_sync` |
| `omd_lsp_view` | 0.2.0-preview.1 | `mods/first-party/omd_lsp_view` |
| `omd_mcp` | 0.1.0-preview.1 | `mods/first-party/omd_mcp` |
| `omd_model_picker` | 0.3.0-preview.1 | `mods/first-party/omd_model_picker` |
| `omd_mods` | 0.1.0-preview.1 | `mods/first-party/omd_mods` |
| `omd_muse` | 0.1.0-preview.1 | `mods/first-party/omd_muse` |
| `omd_notes` | 0.1.0-preview.1 | `mods/first-party/omd_notes` |
| `omd_panes` | 0.1.0-preview.2 | `mods/first-party/omd_panes` |
| `omd_plan_panel` | 0.1.0-preview.1 | `mods/first-party/omd_plan_panel` |
| `omd_plan_removal` | 0.1.0-preview.1 | `mods/first-party/omd_plan_removal` |
| `omd_preview` | 0.1.0-preview.3 | `mods/first-party/omd_preview` |
| `omd_profiles` | 0.1.0-preview.1 | `mods/first-party/omd_profiles` |
| `omd_programmable_context` | 0.1.0-preview.1 | `mods/first-party/omd_programmable_context` |
| `omd_project_pi_prompts` | 0.1.0-preview.2 | `mods/first-party/omd_project_pi_prompts` |
| `omd_reactive_rules` | 0.1.0-preview.1 | `mods/first-party/omd_reactive_rules` |
| `omd_recovery` | 0.2.0-preview.1 | `mods/first-party/omd_recovery` |
| `omd_repository_analysis` | 0.1.0-preview.2 | `mods/first-party/omd_repository_analysis` |
| `omd_research` | 0.2.0-preview.1 | `mods/first-party/omd_research` |
| `omd_source_knowledge` | 0.1.0-preview.3 | `mods/first-party/omd_source_knowledge` |
| `omd_task_tools` | 0.2.0-preview.1 | `mods/first-party/omd_task_tools` |
| `omd_theme` | 0.4.0-candidate.1 | `mods/first-party/omd_theme` |
| `omd_typed_tasks` | 0.2.0-preview.1 | `mods/first-party/omd_typed_tasks` |
| `omd_workflow` | 0.2.0-preview.1 | `mods/first-party/omd_workflow` |
| `omd_workspace` | 0.2.0-preview.3 | `mods/first-party/omd_workspace` |
| `omd_worktree` | 0.1.0-preview.1 | `mods/first-party/omd_worktree` |

## Host and public API

| Component | Owner | Version | Status | Fixtures | Limitations | Removal or migration |
| --- | --- | --- | --- | --- | --- | --- |
| **OMD host runtime** | OMD runtime (runtime/omd, runtime/native) | 0.1.0 on Codex 0.159.1 — features: author_diagnostics_v1, author_offline_runner_v1, author_tooling_v1, installed_contract_types_v1, package_manager_v1, service_contracts_v1, service_dispatch_v1, integration_receipts_v1, tool_result_fingerprints_v1, source_use_v1, state_migration_v1, terminal_components_v1, terminal_identity_v1, terminal_render_sites_v1, terminal_welcome_v1, terminal_rich_line_v1, transactional_reload_v1, task_tool_exposure_v1, virtual_reads_v1, scoped_data_v1, plugin_dispatch_v1, turn_evidence_v1, service_requests_v1, exec_v1, exec_output_artifacts_v1, guarded_exec_v1, package_text_assets_v1, workspace_access_v1, workspace_fs_v1, workspace_snapshots_v1, workspace_fingerprint_v1, snapshot_exec_v1, agent_parent_history_v1, agent_failures_v1, task_resume_v1, contract_scoped_restrictions_v1, store_v1, routes_v1, stream_control_v1, builtins_v1, contracts_v2, framed_process_v1, kernels_v1, terminal_lists_v1, adapters_v1, app_v1, approval_v1, tool_output_v1, tool_batch_v1, tool_specs_v1, events_v1, store_thread_v1, turn_activity_v1, binary_evidence_v1, package_controls_v1, terminal_surface_v1, credentials_v1, completion_v1, tool_feedback_v1, terminal_media_v1, terminal_surface_paint_v1, terminal_backdrop_transform_v1, terminal_image_sample_v1, terminal_import_lifetime_v1, secrets_v1, terminal_prompt_v1, model_complete_v1, history_v1, terminal_pty_v1, dynamic_tools_v1, timers_v1, terminal_input_v1, terminal_style_v1, completion_arguments_v1, terminal_editor_v1, pty_programs_v1, route_reload_v1, terminal_commands_v1, terminal_tabs_v1, session_ports_v1, builtins_mod_commands_v1 — schemas: package 1, state_storage 1, installed_contract_types 1 | supported | `rust:omd/tests/mods.rs::host_versions_and_storage_schemas_are_reported_independently` · `rust:omd/tests/integration.rs::mods_share_the_event_pipeline_and_the_store_without_crossing_boundaries` · `script:scripts/mod_compatibility.py` | Pinned Apple Silicon development host. The host is feature-agnostic and features are TypeScript mods; evidence is local and offline, and release qualification remains open. | Select or reinstall the retained upstream executable; `OMD_MODE=upstream_direct` disables OMD task behaviour inside the custom binary. |
| **Public TypeScript mod API** | OMD mod host (runtime/omd/src/mods.rs) | 0.2.0-experimental.5 — supported versions: 0.2.0-experimental.5 — terminal operations: terminal.notify, terminal.show_thread, terminal.commands, terminal.import_file, terminal.image_sample, composer.read, composer.write, builtins.invoke, terminal.open, terminal.prompt, terminal.pty — sites: sidebar, header, above_composer, dialog, welcome | supported | `script:scripts/mod_conformance.py` · `rust:omd/tests/mods.rs::exclusive_decisions_require_a_replacement_registration_while_observers_compose` · `node:typed module context callback` | API 0.2 is experimental. API 0.1 admission and SDK declarations are retired in this development host; historical compatibility fixtures do not establish current support. | Breaking stable changes need an API major with one stable OMD release of deprecation notice; each row has a finite support window in mods/COMPATIBILITY.md. |
| **Mod package install, update and rollback** | OMD package manager (runtime/omd/src/mods/package_manager.rs) | package schema 1 | supported | `rust:omd/tests/packages.rs::local_updates_preview_preserve_edits_settings_and_rollback` · `rust:omd/tests/packages.rs::stale_plans_and_interrupted_transactions_preserve_the_previous_lock` · `rust:omd/tests/packages.rs::repository_revision_is_immutable_and_cached_for_offline_reuse` | Local sources, immutable repository revisions and versioned packages only; there is no external registry publication or install path. | `omd-mod` disable and uninstall restore the previous lock, preserve edited sources and explicit settings, and leave no activated state. |

## First-party mods

| Component | Owner | Version | Status | Fixtures | Limitations | Removal or migration |
| --- | --- | --- | --- | --- | --- | --- |
| **omd_coordination** | OMD first-party bundle (mods/first-party/omd_coordination) | 0.2.0-preview.1 — extension type: mod — capabilities: agents, commands, context, fs.read, lifecycle, model, services, sessions, store, tools | supported | `python:test_first_party_mods_use_only_the_published_api` | API 0.2 service and command own delegation choices. The generic host enforces route, permission, snapshot and ledger boundaries; reviewed workflow parity remains under qualification. | Disable the mod to remove its delegation policy; the generic host does not supply a hidden replacement policy. |
| **omd_recovery** | OMD first-party bundle (mods/first-party/omd_recovery) | 0.2.0-preview.1 — extension type: mod — capabilities: agents, commands, fs.read, interception, lifecycle, middleware, model, services, sessions, store, tools | supported | `python:test_first_party_mods_use_only_the_published_api` | API 0.2 mod chooses bounded escalation and outage fallback from structured host results. Live provider quality and full resume parity remain open. | Disable the mod to remove its recovery policy; generic host limits and contract restrictions remain. |
| **omd_workspace** | OMD first-party bundle (mods/first-party/omd_workspace) | 0.2.0-preview.3 — extension type: mod — capabilities: commands, lifecycle, store, terminal | supported | `python:test_first_party_mods_use_only_the_published_api` | API 0.2 mod supplies terminal components. Native terminal parity and feature-code retirement remain open. | Disable the mod to remove its layout; generic terminal controls remain. |
| **omd_workflow** | OMD first-party bundle (mods/first-party/omd_workflow) | 0.2.0-preview.1 — extension type: mod — capabilities: agents, commands, context, contracts, exec, fs.read, fs.write, interception, lifecycle, middleware, model, services, sessions, store, tools | default off | `script:tests/workflow_mod.test.mjs` · `rust:omd/tests/generic_host.rs::contract_documents_gate_on_bound_receipts_and_detect_weaker_selections` | Reviewed and solo schema-2 documents and policy use generic host gates. Evidence uses local scripted providers; live provider qualification remains open. | Disable the mod; the host retains only explicitly selected generic contract enforcement. |

## Native Codex plugins, hooks and resources

| Component | Owner | Version | Status | Fixtures | Limitations | Removal or migration |
| --- | --- | --- | --- | --- | --- | --- |
| **Codex plugins (plugin.json)** | upstream Codex | 0.159.1 | supported | `patch:namespaced_commands_always_exist_and_bare_aliases_only_when_unique` · `rust:omd/tests/mods.rs::pi_and_native_discovery_preserve_project_precedence_without_trust` | Plugin discovery, MCP servers and hook execution stay upstream-owned and unmodified; OMD adds no plugin transport and does not sandbox plugin hooks. | Remove the plugin from the Codex plugin directory; no OMD state refers to it. |
| **Codex hooks** | upstream Codex | 0.159.1 — hooks: pre_tool_use, permission_request, post_tool_use, pre_compact, post_compact, session_start, session_end, user_prompt_submit, subagent_start, subagent_stop, stop, interrupt | supported | `script:scripts/integration_matrix.py` · `script:scripts/mod_conformance.py` | Hook dispatch is upstream-owned: competing pre_tool_use rewrites are still resolved by whichever hook finishes last. OMD's command-hook fixtures are synthetic and make no provider or full-session performance claim. | Remove the hook file from the Codex configuration; mod interception is registered separately and is unaffected. |
| **OMD guidance and hooks plugin** | OMD bundled Codex marketplace (plugins/bundled/oh-my-diff) | 0.1.0 — extension type: plugin, skill, hook | opt in | `python:test_lead_success_writes_exact_hook_marker` · `python:test_incomplete_structured_report_blocks_completion` · `python:test_plain_worker_mode_does_not_validate_report` · `rust:native/src/lib.rs::exact_lead_and_worker_markers_are_accepted` · `python:test_pinned_bundle_matches_plugin_sources` | Explicitly installed and hash-trusted; skill selection is not a release default. PostToolUse records successful host results only. Its API 0.2 migration has local tests; live cadence and parity qualification remain open. | Remove omd-guidance-hooks from Codex and the marketplace. Generic host contracts enforce only a document the user selected. |
| **OMD review policy plugin** | OMD bundled Codex marketplace (plugins/bundled/oh-my-diff) | 0.1.0+codex.20260927022545 — extension type: plugin, skill, hook | opt in | `python:test_review_skills_cover_all_cadences_and_retain_native_authority` · `python:test_every_turn_stop_blocks_until_native_review_succeeds` · `python:test_other_tools_and_unselected_policy_do_not_satisfy_or_enforce_cadence` · `python:test_pinned_bundle_matches_plugin_sources` · `python:test_advisor_owns_completed_turn_cadence_without_manual_stop_guard` | Explicitly installed and hash-trusted. Skills select prompts and cadence; hooks require a mod-owned review receipt when selected. Generic contracts enforce selected receipts and completion gates. Live review parity remains open. | Remove omd-review-policy from Codex; unselected review prompts and hook cadence stop, while any user-selected generic contract remains enforced. |
| **OMD application bridges plugin** | OMD bundled Codex marketplace (plugins/bundled/oh-my-diff) | 0.1.0 — extension type: plugin, mcp, hook | opt in | `python:test_manifest_registers_prompt_gated_managed_mcp` · `python:test_launcher_requires_exact_enabled_external_policy` · `python:test_plugin_surface_scopes_each_adapter_and_keeps_control_separate` · `python:test_pinned_bundle_matches_plugin_sources` | Explicitly installed, hash-trusted and default-off. Adapter tools use generic host permissions and explicit service grants; full API 0.2 provider acceptance remains open. | Remove omd-application-bridges from Codex and disable application_bridge. The managed browser bundle and dormant adapter sources remain until the private OMD installation is removed. |
| **OMD artifact reading plugin** | OMD bundled Codex marketplace (plugins/bundled/oh-my-diff) | 0.1.0+codex.20260927032203 — extension type: plugin, skill | opt in | `python:test_notebook_cell_and_figure_are_versioned_without_execution` · `python:test_pdf_page_text_and_figure_keep_page_and_digest` · `python:test_pinned_bundle_matches_plugin_sources` · `python:test_comments_and_reviews_are_separate_and_keep_exact_anchors` · `script:scripts/github_read_acceptance.py` | URL and GitHub reads use approved host web or shell tools; local PDF text and page images require installed Ghostscript. The helper bounds local files and outputs, never executes notebook cells, and cannot grant external content instruction authority. Optional current-API component registers github://; plugin-owned sandboxed helper supplies bounded reads. Real public source passed; private-account support remains unqualified. | Remove omd-artifact-reading from Codex. Existing host web, shell and image tools remain available. |
| **OMD code execution plugin** | OMD bundled Codex marketplace (plugins/bundled/oh-my-diff) | 0.2.0 — extension type: plugin, skill | opt in | `python:test_pinned_v8_assets_reject_changed_inputs` · `rust:codex-code-mode-host/tests/stdio.rs` | Experimental code mode requires explicit user configuration. JavaScript tool calls and optional managed Python stay under native permission, sandbox, process, output, cancellation and accounting controls. Python has no separate direct Codex tool API. | Remove omd-code-execution from Codex; disable features.code_mode to hide the native JavaScript tool. |
| **Pi resource adapter** | OMD mod host | pi-0.74-resources-v2 | removed |  | The API 0.1 pi.discover/pi.expand host bridge and its parser are deleted; Pi prompts and skills are served by the omd_project_pi_prompts mod. | No active API 0.2 Pi resource bridge remains to disable. |

## Bundled browser tooling

| Component | Owner | Version | Status | Fixtures | Limitations | Removal or migration |
| --- | --- | --- | --- | --- | --- | --- |
| **Bundled browser tooling** | OMD browser bundle (scripts/browser_bundle.py) | Playwright MCP with a pinned Chromium — versions: node 24.21.0, pnpm 11.14.0, @playwright/mcp 0.0.81, playwright 1.64.0-alpha-2026-09-14, chromium 154.0.8037.0 | supported | `python:test_launcher_selects_the_bundled_browser_and_keeps_its_sandbox` · `python:test_prebuilt_archive_installs_the_same_verified_tree` · `python:test_failed_post_swap_update_restores_the_verified_bundle` | Apple Silicon macOS only, injected into OMD alone, prompt-gated by default; browser and MCP network effects are outside the shell sandbox. | `scripts/browser_bundle.py` removes the managed tree atomically; Codex and OMD keep working without it. |

## Language server adapters

| Component | Owner | Version | Status | Fixtures | Limitations | Removal or migration |
| --- | --- | --- | --- | --- | --- | --- |
| **Rust language server adapter** | omd_lsp_sync mod over process.* and workspace primitives | rust-analyzer | opt in | `python:test_symbol_rename_and_code_action_apply_exact_text_scopes` · `python:test_failed_semantic_sync_restores_exact_backup` · `python:test_fake_server_requests_rename_changes_and_idle` | The mod detects servers through process.which and never installs one; an absent server is a visible non-success fallback, and edits stay repository-scoped, hash-bound and backed up. | Disable omd_lsp_sync; ordinary host editing is unaffected. |
| **TypeScript language server adapter** | omd_lsp_sync mod over process.* and workspace primitives | typescript-language-server, vtsls | opt in | `python:test_semantic_reads_are_scoped_and_actions_are_discovery_only` · `python:test_failed_semantic_sync_restores_exact_backup` · `python:test_fake_server_requests_rename_changes_and_idle` | The mod detects servers through process.which and never installs one; an absent server is a visible non-success fallback, and edits stay repository-scoped, hash-bound and backed up. | Disable omd_lsp_sync; ordinary host editing is unaffected. |
| **JavaScript language server adapter** | omd_lsp_sync mod over process.* and workspace primitives | typescript-language-server, vtsls | opt in | `python:test_semantic_request_rejects_untracked_target_and_foreign_store` · `python:test_failed_semantic_sync_restores_exact_backup` · `python:test_fake_server_requests_rename_changes_and_idle` | The mod detects servers through process.which and never installs one; an absent server is a visible non-success fallback, and edits stay repository-scoped, hash-bound and backed up. | Disable omd_lsp_sync; ordinary host editing is unaffected. |
| **Python language server adapter** | omd_lsp_sync mod over process.* and workspace primitives | pyright-langserver, pylsp, jedi-language-server | opt in | `python:test_installed_python_server_synchronizes_open_change_close` · `python:test_failed_semantic_sync_restores_exact_backup` · `python:test_fake_server_requests_rename_changes_and_idle` | The mod detects servers through process.which and never installs one; an absent server is a visible non-success fallback, and edits stay repository-scoped, hash-bound and backed up. | Disable omd_lsp_sync; ordinary host editing is unaffected. |
| **Java language server adapter** | omd_lsp_sync mod over process.* and workspace primitives | jdtls | opt in | `python:test_code_action_apply_requires_exact_preview_and_rejects_deferred_edit` · `python:test_failed_semantic_sync_restores_exact_backup` · `python:test_fake_server_requests_rename_changes_and_idle` | The mod detects servers through process.which and never installs one; an absent server is a visible non-success fallback, and edits stay repository-scoped, hash-bound and backed up. | Disable omd_lsp_sync; ordinary host editing is unaffected. |

## Application bridge adapters

| Component | Owner | Version | Status | Fixtures | Limitations | Removal or migration |
| --- | --- | --- | --- | --- | --- | --- |
| **Browser bridge adapter** | OMD application bridge plugin over bridge/client.mjs | policy schema 1, fetch client | default off | `python:test_all_five_adapters_exchange_events_and_exposed_state` · `python:test_client_sources_compile_and_javascript_executes` | Console and window-error capture is explicit; only policy-allowlisted origins and state names are served and no DOM or expression access exists. | Stop calling `connect`; host teardown rotates the token and removes the connection file. |
| **Node bridge adapter** | OMD application bridge plugin over bridge/node-client.mjs | policy schema 1, Node file and process hooks | default off | `python:test_all_five_adapters_exchange_events_and_exposed_state` · `python:test_authorization_version_redaction_bounds_state_and_teardown` | Process-error hooks are opt-in and installed by the application, not by the adapter. | Close the client during application shutdown; the host teardown clears retained evidence. |
| **Python bridge adapter** | OMD application bridge plugin over bridge/python/omd_bridge.py | policy schema 1, standard library only | default off | `python:test_all_five_adapters_exchange_events_and_exposed_state` · `python:test_authorization_version_redaction_bounds_state_and_teardown` | Owns only its optional daemon polling thread; it installs no logging or exception handler. | Close the client; teardown rejects pending state requests and clears in-memory evidence. |
| **Rust bridge adapter** | OMD application bridge plugin over bridge/rust | policy schema 1, blocking loopback client | default off | `python:test_all_five_adapters_exchange_events_and_exposed_state` · `python:test_client_sources_compile_and_javascript_executes` | Serde is pinned and no async runtime is required or taken over; the caller starts any polling thread. | Drop the client; the host removes the connection file on teardown. |
| **Java bridge adapter** | OMD application bridge plugin over bridge/java | policy schema 1, JDK 11 or newer | default off | `python:test_all_five_adapters_exchange_events_and_exposed_state` · `python:test_authorization_version_redaction_bounds_state_and_teardown` | Uses `HttpClient` with an optional daemon polling thread; no logging framework or uncaught-exception handler is installed. | Close the client during shutdown; teardown is identical for every adapter. |

## Optional integrations

| Component | Owner | Version | Status | Fixtures | Limitations | Removal or migration |
| --- | --- | --- | --- | --- | --- | --- |
| **Application bridge capability** | OMD host (runtime/native) | policy schema 1, external SHA-256 bound policy | default off | `python:test_authorization_version_redaction_bounds_state_and_teardown` · `python:test_bridge_launcher_uses_the_managed_node_runtime` | Development-only and off by default. Host configuration and plugin startup fail closed if the external policy is missing or changed; API 0.2 parity is under qualification. | Remove omd-application-bridges and disable `application_bridge`; the wrapper never injects a replacement MCP server. |
| **Approved provider routes and local sidecars** | OMD host operations (runtime/native/src/mods) | host-approved service IDs only — operations: providers.register, providers.unregister, sidecars.start, sidecars.status, sidecars.stop | opt in | `rust:omd/tests/mods.rs::native_host_bridge_preserves_once_only_effects_and_rust_capability_checks` · `node:typed middleware and services register without ambient authority` | Only pre-approved executables and service IDs; secrets stay opaque references, the route and process group die with the task, and unapproved IDs are refused. | Revoke the `providers`/`sidecars` capability grants; the host unregisters routes and terminates the process group. |
| **Remote control** | upstream Codex | 0.159.1 native | removed |  | The OMD-specific wrapper was reverted on 2026-09-16; no OMD account, pairing or compatibility claim is retained. | Already removed from the runtime patch and private build; use the native Codex remote-control workflow supported by the installed version. |

## Shared resource and event boundaries

| Boundary | What it covers | Shared resource or event |
| --- | --- | --- |
| **duplicate_tools** | Two packages claiming one tool or command slot | the namespaced tool registry and the slash-command namespace |
| **duplicate_keybindings** | Competing terminal owners, keys and cross-mod key targets | the exclusive terminal replacement and the native keymap |
| **disabled_dependencies** | A disabled or absent dependency or service provider | the dependency graph, the service registry and the generated installed-contract types |
| **upstream_plugin_coexistence** | OMD extensions beside upstream plugins, hooks and skills | plugin skill discovery, lifecycle hooks, Pi resources, project precedence and the slash-command namespace |
| **streaming_reload** | Reload and disable during streamed work | the mod generation, in-flight callbacks and stream middleware |
| **host_upgrade** | Mixed API rows, host release pinning and state upgrades | API negotiation, host features and the package state store |
| **shared_context_budget** | Several mods contributing to one context assembly | the context event pipeline and its per-fragment and aggregate budget |
| **shared_state_store** | Several mods writing into one store | the store lock, per-mod state files and scope separation |
| **optional_integration_isolation** | Optional integrations start, serve and tear down cleanly | loopback listeners, managed processes and detected external servers |

## Exercised combinations

| Combination | Components | Boundaries | Result | Executable evidence |
| --- | --- | --- | --- | --- |
| **colliding_tool_and_terminal_slots** | omd_host, mod_api | duplicate_tools, duplicate_keybindings | Both claimants of one `mod_<id>_<name>` slot and both terminal claimants fail closed before activation; the remaining mod keeps its tool and command and no keybinding surface is published. | `rust:omd/tests/integration.rs::colliding_tool_slots_and_contested_terminal_owners_disable_only_the_claimants` · `rust:omd/tests/mods.rs::contested_exclusive_replacement_disables_every_claimant_and_keeps_the_rest` |
| **cross_mod_keybindings** | omd_host, mod_api | duplicate_keybindings | One owner publishes the key surface; its bindings may target another mod's command, and a view that claims a reserved native key is rejected by the host before the terminal sees it. | `rust:omd/tests/integration.rs::the_single_terminal_owner_binds_keys_that_may_target_another_mods_command` · `rust:omd/tests/mods.rs::terminal_validation_rejects_control_sequences_reserved_keys_and_unbounded_views` · `patch:native_escape_and_cancel_keys_cannot_be_intercepted` |
| **first_party_pair_with_contenders** | omd_coordination, omd_recovery, omd_workspace, mod_api | duplicate_keybindings, shared_context_budget | The bundled mods run with a contending terminal mod, a broken mod and a user/project duplicate: the contenders fail closed with source-located errors, coordination supplies bounded delegation preparation to recovery, and the remaining first-party behavior keeps working. | `python:test_first_party_mods_use_only_the_published_api` |
| **disabled_service_provider** | omd_host, mod_api, mod_package_lifecycle | disabled_dependencies | Disabling a provider refuses the transactional reload, and the next session disables only the required consumer; the optional consumer catches the absence, unrelated mods keep composing and the generated installed-contract types follow the active set. | `rust:omd/tests/integration.rs::disabling_a_shared_service_provider_stops_only_its_required_consumer` · `rust:omd/tests/mods.rs::an_unavailable_dependency_disables_only_the_dependent_chain` · `rust:omd/tests/mods.rs::missing_incompatible_optional_cyclic_and_colliding_services_fail_independently` |
| **streamed_work_with_reload** | omd_host, mod_api, omd_workspace | streaming_reload | An edited mod is swapped only at the next generation: the in-flight tool call keeps its source and forwards each progress update once, the stream middleware keeps its old transform until reload, stale generations are rejected and the terminal owner is unchanged. | `rust:omd/tests/integration.rs::reloading_during_streamed_work_keeps_the_inflight_generation_and_swaps_the_next_one` · `rust:omd/tests/mods.rs::disabling_during_native_work_preserves_inflight_source_and_revokes_next_generation` |
| **host_upgrade_negotiation** | omd_host, mod_api, mod_package_lifecycle | host_upgrade | Packages on the supported API row activate with per-package stability and feature negotiation; a package pinned to another host release or API is refused before activation, and a bumped state version keeps only that package inactive until its explicit migration runs. | `rust:omd/tests/mods.rs::migration_is_explicit_bounded_and_preserves_previous_state` · `rust:omd/tests/mods.rs::incompatible_host_schema_api_and_features_are_rejected_before_activation` · `script:scripts/mod_compatibility.py` |
| **guidance_hooks_with_native_guards** | omd_guidance_hooks, upstream_hooks, omd_host | upstream_plugin_coexistence | The optional plugin exposes three separately selected skills and validates structured subagent output only when selected. The native reactive-guard marker projection was removed with the controlled host on 2026-09-27; the hooks run again in the default OMD session in Batch 2.55. | `python:test_lead_success_writes_exact_hook_marker` · `python:test_plain_worker_mode_does_not_validate_report` · `python:test_incomplete_structured_report_blocks_completion` |
| **review_policy_with_native_ledger** | omd_review_policy, upstream_hooks, omd_host | upstream_plugin_coexistence | Explicit skills select review prompts; the selected hook requires a successful mod-owned review receipt. Generic contract gates still enforce their selected document independently. | `python:test_review_skills_cover_all_cadences_and_retain_native_authority` · `python:test_every_turn_stop_blocks_until_mod_review_receipt_succeeds` · `python:test_other_tools_and_unselected_policy_do_not_satisfy_or_enforce_cadence` |
| **shared_event_and_store_boundaries** | omd_host, mod_api | shared_context_budget, shared_state_store | Context observers run in activation order under the per-fragment limit; an observer that throws or exceeds its fragment is isolated and dropped for the runtime, and each package keeps a separate state file that a failing neighbour never creates or touches. | `rust:omd/tests/integration.rs::mods_share_the_event_pipeline_and_the_store_without_crossing_boundaries` · `rust:omd/tests/mods.rs::project_scope_takes_precedence_over_user_scope_without_sharing_state` · `rust:omd/tests/mods.rs::mod_state_refreshes_per_call_and_racing_writers_fail_without_lost_updates` |
| **browser_with_host** | browser_bundle, omd_host | optional_integration_isolation | The managed bundle is injected into OMD alone, launches the exact bundled executable with its own profile, and a failed post-swap update restores the verified tree with no stray process. | `python:test_launcher_selects_the_bundled_browser_and_keeps_its_sandbox` · `python:test_failed_post_swap_update_restores_the_verified_bundle` · `python:test_verify_detects_changes_but_ignores_bounded_artifacts` |
| **five_bridge_adapters_on_one_session** | application_bridge, omd_application_bridges, bridge_browser, bridge_node, bridge_python, bridge_rust, bridge_java | optional_integration_isolation | The plugin exposes five prompt-approved adapter-scoped tools over one managed session. All adapters exchange events and exposed state; cross-adapter requests, unauthorized applications, oversized payloads and stale versions are refused, and teardown rotates the token, clears evidence and removes the connection file. | `python:test_plugin_surface_scopes_each_adapter_and_keeps_control_separate` · `python:test_launcher_requires_exact_enabled_external_policy` · `python:test_all_five_adapters_exchange_events_and_exposed_state` · `python:test_authorization_version_redaction_bounds_state_and_teardown` · `python:test_client_sources_compile_and_javascript_executes` |
| **five_language_lsp_with_host** | lsp_rust, lsp_typescript, lsp_javascript, lsp_python, lsp_java, omd_host | optional_integration_isolation | One TypeScript mod manages separate Python, TypeScript/JavaScript, Rust and Java server sessions over process.*. Semantic reads are scope-checked, edits are exact-scope and hash-bound with a host backup, an absent server is a visible non-success fallback, and a failed post-edit synchronisation restores the backup. | `python:test_symbol_rename_and_code_action_apply_exact_text_scopes` · `python:test_semantic_reads_are_scoped_and_actions_are_discovery_only` · `python:test_semantic_request_rejects_untracked_target_and_foreign_store` · `python:test_installed_python_server_synchronizes_open_change_close` · `python:test_code_action_apply_requires_exact_preview_and_rejects_deferred_edit` · `python:test_failed_semantic_sync_restores_exact_backup` · `python:test_fake_server_requests_rename_changes_and_idle` |
| **reading_and_code_execution_skill_packages** | upstream_plugins, omd_artifact_reading, omd_code_execution | upstream_plugin_coexistence, optional_integration_isolation | Both opt-in skill plugins are pinned in the same marketplace and install into an isolated Codex home without claiming a tool namespace. The artifact helper does not execute notebook cells; code execution uses the separate native host. Combined live task use remains untested. | `python:test_pinned_bundle_matches_plugin_sources` · `python:test_notebook_cell_and_figure_are_versioned_without_execution` |
| **mod_interception_beside_native_handlers** | upstream_hooks, mod_api, omd_host | upstream_plugin_coexistence, duplicate_tools | A mod observes, denies or retargets a tool call before the native handler, permission check and hook chain run; it cannot forge the native outcome, and upstream hook dispatch itself stays unmodified. | `patch:mod_interception_denies_or_routes_through_registered_native_handler` · `rust:omd/tests/mods.rs::input_rewrite_requires_exclusive_replacement_while_observers_may_deny` |
| **approved_sidecar_with_mods** | provider_sidecars, mod_api, omd_host | optional_integration_isolation, streaming_reload | An approved sidecar and provider route start, serve and are torn down inside the owning task and generation; unapproved service IDs are refused, secrets stay opaque references and nothing survives task completion. | `rust:omd/tests/mods.rs::native_host_bridge_preserves_once_only_effects_and_rust_capability_checks` · `node:typed middleware and services register without ambient authority` |
| **outside_author_packages_with_examples** | omd_host, mod_api, mod_package_lifecycle | duplicate_keybindings, disabled_dependencies, host_upgrade | Two outside-author packages that replace coordination, context and the terminal run in one live session beside two repository-only conformance fixtures; the terminal's cross-mod keys reach both other packages, the context replacement drops evidence outside the declared scope before the worker sees it, and the same four packages install, upgrade from mod API `.5` to `.6` with a state migration, roll back and re-upgrade through the package manager. | `script:scripts/mod_full_api_exercise.py` |
| **reviewed_workflow_with_coordination** | omd_workflow, omd_coordination, omd_host | shared_context_budget, shared_state_store | The workflow and coordination mods compose through generic host services, checked integration and completion with local scripted providers; live provider qualification remains open. | `script:tests/workflow_mod.test.mjs` · `script:tests/coordination_mod.test.mjs` · `rust:omd/tests/generic_host.rs::finding_receipt_replay_requires_explicit_independent_resolution` |

## Retained regression cases

| Case | Retained for | What stays covered | Executable evidence |
| --- | --- | --- | --- |
| **current_api_composition** | 0.2.0-experimental.5 | Composition, precedence and conflict handling on the current API 0.2 row: declared order, cycles, contested replacements and scope shadowing. | `rust:omd/tests/mods.rs::composition_order_is_declared_dependencies_first_then_mod_id` · `rust:omd/tests/mods.rs::a_dependency_cycle_is_rejected_before_activation_and_isolated` · `script:scripts/mod_conformance.py` |
| **state_migration_and_rollback** | 0.1.0 | Package-owned state survives a host upgrade only through an explicit migration, with a content-addressed backup and an interrupted-migration rollback. | `rust:omd/tests/mods.rs::migration_is_explicit_bounded_and_preserves_previous_state` · `rust:omd/tests/mods.rs::interrupted_migration_and_explicit_rollback_preserve_source_settings_and_state` |
| **pinned_codex_baseline** | 0.159.1 | The shipped runtime patch still applies byte-for-byte to the pinned upstream commit and stays compatible with the recorded upstream surfaces. | `script:scripts/apply_runtime_patch.py` · `script:scripts/verify_codex_compat.py` · `script:scripts/normalize_upstream_lock.py` |
| **pinned_node_runtime** | 24.18.0 | Mods keep loading under the pinned Node erasable-TypeScript loader with no ambient process, fetch or code generation. | `node:no ambient process, fetch, or code generation` · `node:typed module context callback` · `script:scripts/mod_author_acceptance.py` |

## Tested versus untested

Tested: 17 combinations across 9 shared boundaries and 29 maintained components, plus 4 regression cases retained across versions.

Untested and not claimed:

- **Artifact reading and code-mode execution in one live model-driven task** — isolated Codex installation and separate host fixtures establish package coexistence and runtime controls; a live provider task has not been authorized or run.
- **A mod driving the bundled browser inside a live task** — browser tooling is prompt-gated MCP tooling outside the mod capability surface; no fixture runs a mod and the browser together.
- **Application-bridge adapters and mods in one enabled session** — the bridge is development-only and default-off, and its evidence is host-level; mod capabilities are not exercised against it.
- **Semantic LSP edits requested from a mod** — language-server access is not a published mod capability; LSP coverage stays native-only.
- **Independently authored mods combined with the first-party bundle** — no independent-author trial has run; Phase 12 retains the participant requirement, so no third-party composition is claimed.
- **Upgrading from an earlier published OMD release** — no earlier public OMD mod release exists; only synthetic host, API and state transitions are covered.
- **Any combination on Linux or Intel macOS** — only aarch64-apple-darwin on the pinned toolchain is verified; other platforms remain evaluation scope.
- **The Kiro gateway connector beside the mod set** — not implemented; it remains a separate Phase 10 checkbox with its own acceptance.
- **Every possible combination of mods, adapters and optional integrations** — the space is combinatorially unbounded; this matrix maintains representative combinations and names what is not covered instead.

## Reproducing the evidence

`rust:` a test in the pinned runtime crates · `patch:` a test added by the shipped runtime
patch · `node:` `mods/runner.test.mjs` · `python:` `tests/` · `script:` a repository checker.

```sh
python3 scripts/integration_matrix.py
python3 scripts/mod_conformance.py
python3 scripts/mod_compatibility.py
python3 -m unittest discover -s tests
OMD_TEST_NODE=/absolute/node-24.18.0/bin/node cargo +1.95.0 test --locked -p codex-omd
pnpm --dir mods test
```
