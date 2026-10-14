# Integration coverage

<!-- Generated from integration/matrix.json by python3 -m scripts.integration_matrix --write. -->

Accumulated integration coverage for the rust-v0.162.1 pinned runtime as of
2026-10-10. Each component names its owner, version, retained fixtures, limits,
and removal path. Fixture references are cumulative; this source check does not rerun
them or verify test discovery, execution, assertions, or the full release candidate.
Release qualification requires `--release --executed-evidence RECEIPT` for all
combination and regression evidence at the clean validated revision; see `integration/EVIDENCE.md`.
The matrix is checked against the
shipped sources by `scripts/integration_matrix.py`: a version, capability, hook, language
or evidence reference that disagrees with the runtime fails the check.

**Qualification:** Development pin: the 0.162.1 patch passes fresh replay, a second-apply no-op and scoped checks; the host serves API 0.2.0-experimental.5. The current OMD Core/OMD+ source selection is checked below. Final current-package installation, header/recovery and terminal evidence are separate from this source check; public delivery, archive compatibility and release candidate qualification remain open.

Combinations below are representative, not exhaustive. Exercising every possible
combination of mods, adapters and optional integrations is not promised; the untested
section names what is deliberately out of scope.

## Release

| Field | Value |
| --- | --- |
| codex | `0.162.1` |
| omd | `0.1.0` |
| mod api | `0.2.0-experimental.5` |
| package schema | `1` |
| upstream tag | `rust-v0.162.1` |
| upstream commit | `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d` |
| target | `aarch64-apple-darwin` |
| node | `24.18.0` |

## Selected source inventory

This is the current package source selection, not proof of an installed or active session.
Opt-in mods remain disabled; plugin sources and their nested skills/hooks require separate installation and activation.

| Profile | Selector | Installed mod sources | Fresh-install default selection | Inactive plugin sources |
| --- | --- | --- | --- | --- |
| OMD Core | `platform` | omd_logo, omd_mods, omd_update | omd_logo, omd_mods, omd_update | none |
| OMD+ | `full` | omd_advisor, omd_claude_cli, omd_continue, omd_frecency, omd_inspector, omd_logo, omd_lsp_sync, omd_lsp_view, omd_model_picker, omd_mods, omd_plan_panel, omd_plan_removal, omd_preview, omd_privacy, omd_profiles, omd_statusline, omd_tool_lines, omd_update, omd_usage, omd_workflow | omd_inspector, omd_logo, omd_model_picker, omd_mods, omd_plan_panel, omd_plan_removal, omd_statusline, omd_tool_lines, omd_update | omd-anchored-edit, omd-artifact-reading, omd-code-execution |

| Selected mod | Version | Source |
| --- | --- | --- |
| `omd_advisor` | 0.4.0-preview.1 | `mods/first-party/omd_advisor` |
| `omd_claude_cli` | 0.2.0-preview.3 | `mods/first-party/omd_claude_cli` |
| `omd_continue` | 0.1.0-preview.1 | `mods/first-party/omd_continue` |
| `omd_frecency` | 0.1.0-preview.2 | `mods/first-party/omd_frecency` |
| `omd_inspector` | 0.2.0-preview.1 | `mods/first-party/omd_inspector` |
| `omd_logo` | 0.2.0-preview.1 | `mods/first-party/omd_logo` |
| `omd_lsp_sync` | 0.5.0-preview.1 | `mods/first-party/omd_lsp_sync` |
| `omd_lsp_view` | 0.2.0-preview.1 | `mods/first-party/omd_lsp_view` |
| `omd_model_picker` | 0.3.0-preview.2 | `mods/first-party/omd_model_picker` |
| `omd_mods` | 0.1.0-preview.1 | `mods/first-party/omd_mods` |
| `omd_plan_panel` | 0.1.0-preview.1 | `mods/first-party/omd_plan_panel` |
| `omd_plan_removal` | 0.1.0-preview.1 | `mods/first-party/omd_plan_removal` |
| `omd_preview` | 0.2.0-preview.1 | `mods/first-party/omd_preview` |
| `omd_privacy` | 0.1.0-preview.1 | `mods/first-party/omd_privacy` |
| `omd_profiles` | 0.1.0-preview.2 | `mods/first-party/omd_profiles` |
| `omd_statusline` | 0.1.0-preview.1 | `mods/first-party/omd_statusline` |
| `omd_tool_lines` | 0.1.0-preview.1 | `mods/first-party/omd_tool_lines` |
| `omd_update` | 0.1.0-preview.1 | `mods/first-party/omd_update` |
| `omd_usage` | 0.1.0-preview.1 | `mods/first-party/omd_usage` |
| `omd_workflow` | 0.2.0-preview.2 | `mods/first-party/omd_workflow` |

## Launch collection

| Package | Kind | Tier | Profiles | Path |
| --- | --- | --- | --- | --- |
| `omd_logo` | mod | default-active | OMD Core + OMD+ | `mods/first-party/omd_logo` |
| `omd_mods` | mod | default-active | OMD Core + OMD+ | `mods/first-party/omd_mods` |
| `omd_update` | mod | default-active | OMD Core + OMD+ | `mods/first-party/omd_update` |
| `omd_inspector` | mod | default-active | OMD+ | `mods/first-party/omd_inspector` |
| `omd_model_picker` | mod | default-active | OMD+ | `mods/first-party/omd_model_picker` |
| `omd_plan_removal` | mod | default-active | OMD+ | `mods/first-party/omd_plan_removal` |
| `omd_plan_panel` | mod | default-active | OMD+ | `mods/first-party/omd_plan_panel` |
| `omd_statusline` | mod | default-active | OMD+ | `mods/first-party/omd_statusline` |
| `omd_continue` | mod | opt-in | OMD+ | `mods/first-party/omd_continue` |
| `omd_tool_lines` | mod | default-active | OMD+ | `mods/first-party/omd_tool_lines` |
| `omd_preview` | mod | opt-in | OMD+ | `mods/first-party/omd_preview` |
| `omd_lsp_sync` | mod | opt-in | OMD+ | `mods/first-party/omd_lsp_sync` |
| `omd_lsp_view` | mod | opt-in | OMD+ | `mods/first-party/omd_lsp_view` |
| `omd_claude_cli` | mod | opt-in | OMD+ | `mods/first-party/omd_claude_cli` |
| `omd_profiles` | mod | opt-in | OMD+ | `mods/first-party/omd_profiles` |
| `omd_workflow` | mod | opt-in | OMD+ | `mods/first-party/omd_workflow` |
| `omd_frecency` | mod | opt-in | OMD+ | `mods/first-party/omd_frecency` |
| `omd_privacy` | mod | opt-in | OMD+ | `mods/first-party/omd_privacy` |
| `omd_usage` | mod | opt-in | OMD+ | `mods/first-party/omd_usage` |
| `omd_advisor` | mod | opt-in | OMD+ | `mods/first-party/omd_advisor` |
| `omd-anchored-edit` | plugin | staged | OMD+ | `plugins/bundled/oh-my-diff/plugins/omd-anchored-edit` |
| `omd-artifact-reading` | plugin | staged | OMD+ | `plugins/bundled/oh-my-diff/plugins/omd-artifact-reading` |
| `omd-code-execution` | plugin | staged | OMD+ | `plugins/bundled/oh-my-diff/plugins/omd-code-execution` |

## Host and public API

| Component | Owner | Version | Status | Fixtures | Limitations | Removal or migration |
| --- | --- | --- | --- | --- | --- | --- |
| **OMD host runtime** | OMD runtime (runtime/omd, runtime/native) | 0.1.0 on Codex 0.162.1 — features: turn_abort_v1, terminal_selection_v1, terminal_copy_v1, environment_overrides_v1, timers_16ms_v1, author_diagnostics_v1, author_offline_runner_v1, author_tooling_v1, installed_contract_types_v1, package_manager_v1, service_contracts_v1, service_dispatch_v1, integration_receipts_v1, tool_result_fingerprints_v1, source_use_v1, state_migration_v1, terminal_components_v1, terminal_identity_v1, terminal_render_sites_v1, terminal_welcome_v1, terminal_rich_line_v1, terminal_box_model_v1, transactional_reload_v1, task_tool_exposure_v1, virtual_reads_v1, scoped_data_v1, plugin_dispatch_v1, turn_evidence_v1, service_requests_v1, exec_v1, exec_output_artifacts_v1, guarded_exec_v1, package_text_assets_v1, package_imports_v1, workspace_access_v1, workspace_fs_v1, workspace_snapshots_v1, workspace_fingerprint_v1, snapshot_exec_v1, agent_parent_history_v1, agent_failures_v1, task_resume_v1, contract_scoped_restrictions_v1, store_v1, routes_v1, model_turn_interception_v1, final_request_policy_v1, continuation_middleware_v1, builtins_v1, contracts_v2, framed_process_v1, process_streams_v1, process_raster_v1, raster_pixels_v1, kernels_v1, terminal_lists_v1, adapters_v1, app_v1, approval_v1, unrestricted_process_v1, delegated_approval_v1, tool_batch_v1, tool_continuation_v2, events_v1, store_thread_v1, state_scopes_v1, turn_activity_v1, binary_evidence_v1, package_controls_v1, terminal_surface_v1, credentials_v1, completion_v1, tool_feedback_v1, terminal_media_v1, terminal_surface_paint_v1, codex_config_v1, terminal_image_sample_v1, terminal_import_lifetime_v1, secrets_v1, terminal_prompt_v1, model_complete_v2, sdk_helpers_v1, history_v1, history_rewrite_v1, terminal_pty_v1, dynamic_tools_v1, timers_v1, terminal_input_v1, terminal_style_v1, completion_arguments_v1, terminal_editor_v1, pty_programs_v1, route_reload_v1, terminal_tabs_v1, terminal_inline_sites_v1, render_hooks_v1, component_modules_v1, ui_composition_v1, ui_controls_v1, reactive_state_v1, session_ports_v1, structured_access_v1, command_config_middleware_v1, admission_api_policy_v1, agent_lifecycle_v1, peer_sessions_v1, autonomous_turns_v1, provider_billing_v1, compaction_intercept_v1, composer_v2, lifecycle_events_v1, user_submissions_v1, terminal_raster_v1, svg_assets_v1, history_persist_v1, model_cache_v1, composer_key_v1, completion_tokens_v1, mention_read_v1 — schemas: package 1, state_storage 1, installed_contract_types 1 | supported | `rust:omd/tests/mods.rs::host_versions_and_storage_schemas_are_reported_independently` · `rust:omd/tests/integration.rs::mods_share_the_event_pipeline_and_the_store_without_crossing_boundaries` · `script:scripts/mod_compatibility.py` | Pinned Apple Silicon development host. The host is feature-agnostic and features are TypeScript mods; evidence is local and offline, and release qualification remains open. | Select or reinstall the retained upstream executable; `OMD_MODE=upstream_direct` disables OMD task behaviour inside the custom binary. |
| **Public TypeScript mod API** | OMD mod host (runtime/omd/src/mods.rs) | 0.2.0-experimental.5 — supported versions: 0.2.0-experimental.5 — terminal operations: terminal.notify, terminal.show_thread, terminal.import_file, terminal.image_sample, composer.read, composer.write, composer.suggest, builtins.invoke, terminal.open, terminal.prompt, terminal.pane, terminal.panes, terminal.notice, terminal.selection, terminal.copy, terminal.blit, terminal.pty — sites: sidebar, header, above_composer, below_composer, dialog, welcome | supported | `script:scripts/mod_conformance.py` · `rust:omd/tests/mods.rs::exclusive_decisions_require_a_replacement_registration_while_observers_compose` · `node:typed module context callback` | API 0.2 is experimental. API 0.1 admission and SDK declarations are retired; API 0.1 packages no longer load. | Breaking stable changes need an API major with one stable OMD release of deprecation notice; each row has a finite support window in mods/COMPATIBILITY.md. |
| **Mod package install, update and rollback** | OMD package manager (runtime/omd/src/mods/package_manager.rs) | package schema 1 | supported | `rust:omd/tests/packages.rs::local_updates_preview_preserve_edits_settings_and_rollback` · `rust:omd/tests/packages.rs::stale_plans_and_interrupted_transactions_preserve_the_previous_lock` · `rust:omd/tests/packages.rs::repository_revision_is_immutable_and_cached_for_offline_reuse` | Local folders, Git repositories (a branch or tag locks to its commit), curated-index releases and npm packages from public or npmrc-configured private registries (sha512-verified, no runtime dependencies, npm install scripts never run). Installing never enables a mod, and granted permissions still run with that authority. | `omd-mod` disable, uninstall, revoke and package-quarantine work without any control mod; disable and uninstall restore the previous lock and preserve edited sources and explicit settings, and quarantine blocks the installed version while keeping its data. |
| **Administrator policy and managed deployment** | OMD mod host (runtime/omd/src/mods/policy.rs, package_manager.rs) | policy schema 1 | supported | `rust:omd/tests/managed.rs::managed_tiers_wrap_user_mods_and_required_guards_cannot_be_skipped` · `rust:omd/tests/managed.rs::administrator_controls_override_user_and_project_selections_with_provenance` · `rust:omd/tests/managed.rs::tampered_policy_fails_closed_and_stale_or_revoked_managed_content_never_loads` · `rust:omd/tests/managed.rs::managed_collections_deploy_per_user_through_mirrors_offline_and_roll_back_cleanly` · `rust:omd/tests/managed.rs::managed_sync_refuses_tampered_unavailable_or_scripted_content_and_keeps_the_generation` · `rust:omd/tests/managed.rs::managed_policy_refuses_user_installs_outside_allowed_sources_and_versions` | Policy comes from the broker or a root-owned file on the machine; per-user isolation and policy files are exercised with fixture stores and a fixture owner, and a deployed broker or root-owned policy only by the maintainer-run `scripts/lean_profile_acceptance.py --managed-policy`. No vendor remote disable and no hosted fleet service. | An administrator clears or rolls back the policy (`omd-mod policy clear\|rollback`, `omd-package policy remove\|rollback`); users recover their own mods with `/omd` or `omd-mod reset STORE mods.json` while managed packages keep running. |

## First-party mods

| Component | Owner | Version | Status | Fixtures | Limitations | Removal or migration |
| --- | --- | --- | --- | --- | --- | --- |
| **omd_workflow** | OMD first-party bundle (mods/first-party/omd_workflow) | 0.2.0-preview.2 — extension type: mod — capabilities: agents, commands, context, contracts, exec, fs.read, fs.write, interception, lifecycle, middleware, model, services, store, tools | default off | `script:tests/workflow_mod.test.mjs` · `rust:omd/tests/generic_host.rs::contract_documents_gate_on_bound_receipts_and_detect_weaker_selections` | Reviewed and solo schema-2 documents and policy use generic host gates. Evidence uses local scripted providers; live provider qualification remains open. | Disable the mod; the host retains only explicitly selected generic contract enforcement. |

## Native Codex plugins, hooks and resources

| Component | Owner | Version | Status | Fixtures | Limitations | Removal or migration |
| --- | --- | --- | --- | --- | --- | --- |
| **Codex plugins (plugin.json)** | upstream Codex | 0.162.1 | supported | `patch:namespaced_commands_always_exist_and_bare_aliases_only_when_unique` · `rust:omd/tests/mods.rs::native_discovery_prefers_project_packages_without_trust` | Plugin discovery, MCP servers and hook execution stay upstream-owned and unmodified; OMD adds no plugin transport and does not sandbox plugin hooks. | Remove the plugin from the Codex plugin directory; no OMD state refers to it. |
| **Codex hooks** | upstream Codex | 0.162.1 — hooks: pre_tool_use, permission_request, post_tool_use, pre_compact, post_compact, session_start, session_end, user_prompt_submit, subagent_start, subagent_stop, stop, interrupt | supported | `script:scripts/integration_matrix.py` · `script:scripts/mod_conformance.py` | Hook dispatch is upstream-owned: competing pre_tool_use rewrites are still resolved by whichever hook finishes last. OMD's command-hook fixtures are synthetic and make no provider or full-session performance claim. | Remove the hook file from the Codex configuration; mod interception is registered separately and is unaffected. |
| **OMD anchored edit plugin** | OMD bundled Codex marketplace (plugins/bundled/oh-my-diff) | 0.2.0-preview.1 — extension type: plugin, skill | opt in | `python:test_pinned_bundle_matches_plugin_sources` · `node:hashline edits apply atomically across files with byte fidelity and fresh anchors` · `node:denied, oversized, missing, generated and malformed edits never write` · `script:scripts/lean_profile_acceptance.py` | Staged in OMD+ as inert plugin files and guidance. The TypeScript component (tools, fs.read, fs.write, exec) stays disabled until the user trusts and enables it; the ordinary patch tool is unaffected. Offline runner tests cover anchored reads, edits, search and refusals; live-session parity and edit quality remain unqualified. | Remove omd-anchored-edit from Codex and disable its trusted component separately; plugin removal alone does not disable the component. |
| **OMD artifact reading plugin** | OMD bundled Codex marketplace (plugins/bundled/oh-my-diff) | 0.1.0+codex.20260927032203 — extension type: plugin, skill | opt in | `python:test_notebook_cell_and_figure_are_versioned_without_execution` · `python:test_pdf_page_text_and_figure_keep_page_and_digest` · `python:test_pinned_bundle_matches_plugin_sources` · `python:test_comments_and_reviews_are_separate_and_keep_exact_anchors` · `script:scripts/github_read_acceptance.py` | URL and GitHub reads use approved host web or shell tools; local PDF text and page images require installed Ghostscript. The helper bounds local files and outputs, never executes notebook cells, and cannot grant external content instruction authority. Optional current-API component registers github://; plugin-owned sandboxed helper supplies bounded reads. Real public source passed; private-account support remains unqualified. | Remove omd-artifact-reading from Codex. Existing host web, shell and image tools remain available. |
| **OMD code execution plugin** | OMD bundled Codex marketplace (plugins/bundled/oh-my-diff) | 0.2.0 — extension type: plugin, skill | opt in | `python:test_pinned_bundle_matches_plugin_sources` · `script:tests/code_kernel.test.mjs` | Experimental code mode requires explicit user configuration. JavaScript tool calls and optional managed Python stay under native permission, sandbox, process, output, cancellation and accounting controls. Python has no separate direct Codex tool API. | Remove omd-code-execution from Codex; disable features.code_mode to hide the native JavaScript tool. |
| **Pi resource adapter** | OMD mod host | pi-0.74-resources-v2 | removed |  | The API 0.1 pi.discover/pi.expand host bridge and its parser are deleted; no Pi prompt or skill resource ships in the launch collection. | No active API 0.2 Pi resource bridge remains to disable. |

## Language server adapters

| Component | Owner | Version | Status | Fixtures | Limitations | Removal or migration |
| --- | --- | --- | --- | --- | --- | --- |
| **Rust language server adapter** | omd_lsp_sync mod over process.* and workspace primitives | rust-analyzer | opt in | `python:test_symbol_rename_and_code_action_apply_exact_text_scopes` · `python:test_failed_semantic_sync_restores_exact_backup` · `python:test_fake_server_requests_rename_changes_and_idle` | The mod detects servers through process.which and never installs one; an absent server is a visible non-success fallback, and edits stay repository-scoped, hash-bound and backed up. | Disable omd_lsp_sync; ordinary host editing is unaffected. |
| **TypeScript language server adapter** | omd_lsp_sync mod over process.* and workspace primitives | typescript-language-server, vtsls | opt in | `python:test_semantic_reads_are_scoped_and_actions_are_discovery_only` · `python:test_failed_semantic_sync_restores_exact_backup` · `python:test_fake_server_requests_rename_changes_and_idle` | The mod detects servers through process.which and never installs one; an absent server is a visible non-success fallback, and edits stay repository-scoped, hash-bound and backed up. | Disable omd_lsp_sync; ordinary host editing is unaffected. |
| **JavaScript language server adapter** | omd_lsp_sync mod over process.* and workspace primitives | typescript-language-server, vtsls | opt in | `python:test_semantic_request_rejects_untracked_target_and_foreign_store` · `python:test_failed_semantic_sync_restores_exact_backup` · `python:test_fake_server_requests_rename_changes_and_idle` | The mod detects servers through process.which and never installs one; an absent server is a visible non-success fallback, and edits stay repository-scoped, hash-bound and backed up. | Disable omd_lsp_sync; ordinary host editing is unaffected. |
| **Python language server adapter** | omd_lsp_sync mod over process.* and workspace primitives | pyright-langserver, pylsp, jedi-language-server | opt in | `python:test_installed_python_server_synchronizes_open_change_close` · `python:test_failed_semantic_sync_restores_exact_backup` · `python:test_fake_server_requests_rename_changes_and_idle` | The mod detects servers through process.which and never installs one; an absent server is a visible non-success fallback, and edits stay repository-scoped, hash-bound and backed up. | Disable omd_lsp_sync; ordinary host editing is unaffected. |
| **Java language server adapter** | omd_lsp_sync mod over process.* and workspace primitives | jdtls | opt in | `python:test_code_action_apply_requires_exact_preview_and_rejects_deferred_edit` · `python:test_failed_semantic_sync_restores_exact_backup` · `python:test_fake_server_requests_rename_changes_and_idle` | The mod detects servers through process.which and never installs one; an absent server is a visible non-success fallback, and edits stay repository-scoped, hash-bound and backed up. | Disable omd_lsp_sync; ordinary host editing is unaffected. |

## Optional integrations

| Component | Owner | Version | Status | Fixtures | Limitations | Removal or migration |
| --- | --- | --- | --- | --- | --- | --- |
| **Approved provider routes and local sidecars** | OMD host operations (runtime/native/src/mods) | host-approved service IDs only — operations: providers.register, providers.unregister, sidecars.start, sidecars.status, sidecars.stop | opt in | `rust:omd/tests/mods.rs::native_host_bridge_preserves_once_only_effects_and_rust_capability_checks` · `node:typed middleware and services register without ambient authority` | Only pre-approved executables and service IDs; secrets stay opaque references, the route and process group die with the task, and unapproved IDs are refused. | Revoke the `providers`/`sidecars` capability grants; the host unregisters routes and terminates the process group. |
| **Remote control** | upstream Codex | 0.162.1 native | removed |  | The OMD-specific wrapper was reverted on 2026-09-16; no OMD account, pairing or compatibility claim is retained. | Already removed from the runtime patch and private build; use the native Codex remote-control workflow supported by the installed version. |

## Shared resource and event boundaries

| Boundary | What it covers | Shared resource or event |
| --- | --- | --- |
| **duplicate_tools** | Two packages claiming one tool or command slot | the namespaced tool registry and the slash-command namespace |
| **duplicate_keybindings** | Competing terminal patches, keys and cross-mod key targets | exclusive fields of the composed terminal view and the native keymap |
| **disabled_dependencies** | A disabled or absent dependency or service provider | the dependency graph, the service registry and the generated installed-contract types |
| **upstream_plugin_coexistence** | OMD extensions beside upstream plugins, hooks and skills | plugin skill discovery, lifecycle hooks, Pi resources, project precedence and the slash-command namespace |
| **streaming_reload** | Reload and disable during streamed work | the mod generation, in-flight callbacks and stream middleware |
| **host_upgrade** | Mixed API rows, host release pinning and state upgrades | API negotiation, host features and the package state store |
| **shared_context_budget** | Several mods contributing to one context assembly | the context event pipeline and its per-fragment and aggregate budget |
| **shared_state_store** | Several mods writing into one store | the store lock, per-mod state files and scope separation |
| **optional_integration_isolation** | Optional integrations start, serve and tear down cleanly | loopback listeners, managed processes and detected external servers |

## Combination evidence inventory

| Combination | Components | Boundaries | Recorded result (not verified here) | Source evidence inventory |
| --- | --- | --- | --- | --- |
| **first_party_mods_on_the_published_api** | omd_workflow, mod_api |  | Every bundled mod declares the current API, requests only capabilities the host publishes, imports only the published type surface, touches no host-private symbol and is not named in host source. | `python:test_first_party_mods_use_only_the_published_api` |
| **colliding_tool_and_terminal_slots** | omd_host, mod_api | duplicate_tools, duplicate_keybindings | Both claimants of one `mod_<id>_<name>` slot and both claimants of one exclusive replacement point fail closed before activation; the remaining mod keeps its tool and command. | `rust:omd/tests/integration.rs::colliding_tool_slots_and_contested_replacements_disable_only_the_claimants` · `rust:omd/tests/mods.rs::contested_exclusive_replacement_disables_every_claimant_and_keeps_the_rest` |
| **cross_mod_keybindings** | omd_host, mod_api | duplicate_keybindings | The first mod in composition order owns each key and later claims are reported as conflicts; bindings may target another mod's command, and a patch that claims a reserved native key is rejected by the host before the terminal sees it. | `rust:omd/tests/integration.rs::terminal_patches_bind_keys_that_may_target_another_mods_command` · `rust:omd/tests/mods.rs::terminal_validation_rejects_control_sequences_reserved_keys_and_unbounded_views` · `patch:native_escape_and_cancel_keys_cannot_be_intercepted` |
| **disabled_service_provider** | omd_host, mod_api, mod_package_lifecycle | disabled_dependencies | Disabling a provider refuses the transactional reload, and the next session disables only the required consumer; the optional consumer catches the absence, unrelated mods keep composing and the generated installed-contract types follow the active set. | `rust:omd/tests/integration.rs::disabling_a_shared_service_provider_stops_only_its_required_consumer` · `rust:omd/tests/mods.rs::an_unavailable_dependency_disables_only_the_dependent_chain` · `rust:omd/tests/mods.rs::missing_incompatible_optional_cyclic_and_colliding_services_fail_independently` |
| **streamed_work_with_reload** | omd_host, mod_api | streaming_reload | Unchanged in-flight tool sources may complete and forward progress once. Changed or disabled sources cannot commit callback results or state; the next boundary activates the new source, stale local generations are rejected and the replacement owner is unchanged. | `rust:omd/tests/integration.rs::reloading_during_streamed_work_rejects_changed_sources_and_swaps_the_next_generation` · `rust:omd/tests/mods.rs::disabling_during_native_work_rejects_completion_and_next_generation` |
| **host_upgrade_negotiation** | omd_host, mod_api, mod_package_lifecycle | host_upgrade | Packages on the supported API row activate with per-package stability and feature negotiation; a package pinned to another host release or API is refused before activation, and a bumped state version keeps only that package inactive until its explicit migration runs. | `rust:omd/tests/mods.rs::migration_is_explicit_bounded_and_preserves_previous_state` · `rust:omd/tests/mods.rs::incompatible_host_schema_api_and_features_are_rejected_before_activation` · `script:scripts/mod_compatibility.py` |
| **shared_event_and_store_boundaries** | omd_host, mod_api | shared_context_budget, shared_state_store | Context observers run in activation order under the per-fragment limit; an observer that throws or exceeds its fragment is isolated and dropped for the runtime, and each package keeps a separate state file that a failing neighbour never creates or touches. | `rust:omd/tests/integration.rs::mods_share_the_event_pipeline_and_the_store_without_crossing_boundaries` · `rust:omd/tests/mods.rs::project_scope_takes_precedence_over_user_scope_without_sharing_state` · `rust:omd/tests/mods.rs::mod_state_refreshes_per_call_and_racing_writers_retry_without_lost_updates` |
| **five_language_lsp_with_host** | lsp_rust, lsp_typescript, lsp_javascript, lsp_python, lsp_java, omd_host | optional_integration_isolation | One TypeScript mod manages separate Python, TypeScript/JavaScript, Rust and Java server sessions over process.*. Semantic reads are scope-checked, edits are exact-scope and hash-bound with a host backup, an absent server is a visible non-success fallback, and a failed post-edit synchronisation restores the backup. | `python:test_symbol_rename_and_code_action_apply_exact_text_scopes` · `python:test_semantic_reads_are_scoped_and_actions_are_discovery_only` · `python:test_semantic_request_rejects_untracked_target_and_foreign_store` · `python:test_installed_python_server_synchronizes_open_change_close` · `python:test_code_action_apply_requires_exact_preview_and_rejects_deferred_edit` · `python:test_failed_semantic_sync_restores_exact_backup` · `python:test_fake_server_requests_rename_changes_and_idle` |
| **bundled_skill_plugins** | upstream_plugins, omd_anchored_edit, omd_artifact_reading, omd_code_execution | upstream_plugin_coexistence, optional_integration_isolation | The three bundled plugins are pinned in one marketplace and install into an isolated Codex home as inert files without claiming a tool namespace. The anchored-edit and artifact-reading components stay disabled until separately trusted; the artifact helper does not execute notebook cells and code execution uses the separate native host. Combined live task use remains untested. | `python:test_pinned_bundle_matches_plugin_sources` · `python:test_notebook_cell_and_figure_are_versioned_without_execution` |
| **mod_interception_beside_native_handlers** | upstream_hooks, mod_api, omd_host | upstream_plugin_coexistence, duplicate_tools | Mod interceptors compose around a tool call: they rewrite, retarget, deny or answer it before the native handler, permission check and hook chain run, and inspect its result after; an answer is recorded as the mod's and cannot forge the native outcome, and upstream hook dispatch itself stays unmodified. | `patch:mod_interception_denies_answers_or_routes_through_registered_native_handler` · `rust:omd/tests/mods.rs::continuations_compose_transforms_inspect_results_and_short_circuit` |
| **approved_sidecar_with_mods** | provider_sidecars, mod_api, omd_host | optional_integration_isolation, streaming_reload | An approved sidecar and provider route start, serve and are torn down inside the owning task and generation; unapproved service IDs are refused, secrets stay opaque references and nothing survives task completion. | `rust:omd/tests/mods.rs::native_host_bridge_preserves_once_only_effects_and_rust_capability_checks` · `node:typed middleware and services register without ambient authority` |
| **reviewed_workflow_with_host** | omd_workflow, omd_host | shared_context_budget, shared_state_store | The workflow mod uses generic host services for checked integration and completion with local scripted providers; live provider qualification remains open. | `script:tests/workflow_mod.test.mjs` · `rust:omd/tests/generic_host.rs::finding_receipt_replay_requires_explicit_independent_resolution` |
| **example_packages_with_host_features** | omd_host, mod_api, mod_package_lifecycle | host_upgrade | The repository example packages load, inspect and register together against the published host features, and their events, operations and capabilities stay inside the published API. | `rust:omd/tests/examples.rs::host_feature_examples_load_and_register_together` · `script:tests/examples_api.test.mjs` |
| **managed_packages_beside_user_mods** | managed_policy, mod_package_lifecycle, omd_host | duplicate_tools, shared_state_store | Administrator-managed packages deployed per account run beside user and project mods: a same-ID user or project copy is shadowed, refused user mods unload at once, user answers cannot skip a managed required guard, and resetting user mods leaves managed packages running. | `rust:omd/tests/managed.rs::managed_tiers_wrap_user_mods_and_required_guards_cannot_be_skipped` · `rust:omd/tests/managed.rs::administrator_controls_override_user_and_project_selections_with_provenance` |

## Retained regression cases

| Case | Retained for | Claimed behavior | Source evidence inventory |
| --- | --- | --- | --- |
| **current_api_composition** | 0.2.0-experimental.5 | Composition, precedence and conflict handling on the current API 0.2 row: declared order, cycles, contested replacements and scope shadowing. | `rust:omd/tests/mods.rs::composition_order_is_declared_dependencies_first_then_mod_id` · `rust:omd/tests/mods.rs::a_dependency_cycle_is_rejected_before_activation_and_isolated` · `script:scripts/mod_conformance.py` |
| **state_migration_and_rollback** | 0.1.0 | Package-owned state survives a host upgrade only through an explicit migration, with a content-addressed backup and an interrupted-migration rollback. | `rust:omd/tests/mods.rs::migration_is_explicit_bounded_and_preserves_previous_state` · `rust:omd/tests/mods.rs::interrupted_migration_and_explicit_rollback_preserve_source_settings_and_state` |
| **pinned_codex_baseline** | 0.162.1 | The shipped runtime patch still applies byte-for-byte to the pinned upstream commit and stays compatible with the recorded upstream surfaces. | `script:scripts/apply_runtime_patch.py` · `script:scripts/verify_codex_compat.py` · `script:scripts/normalize_upstream_lock.py` |
| **pinned_node_runtime** | 24.18.0 | Mods keep loading under the pinned Node erasable-TypeScript loader with no ambient process, fetch or code generation. | `node:no ambient process, fetch, or code generation` · `node:typed module context callback` · `script:scripts/mod_author_acceptance.py` |

## Inventoried versus untested

Inventoried: 14 combinations across 9 shared boundaries and 18 maintained components, plus 4 regression cases retained across versions.

Untested and not claimed:

- **Artifact reading and code-mode execution in one live model-driven task** — isolated Codex installation and separate host fixtures establish package coexistence and runtime controls; a live provider task has not been authorized or run.
- **Semantic LSP edits requested from a mod** — language-server access is not a published mod capability; LSP coverage stays native-only.
- **Independently authored mods combined with the first-party bundle** — no independent-author trial has run; the human author trial is now W1c, so no third-party composition is claimed.
- **Upgrading from an earlier published OMD release** — no earlier public OMD mod release exists; only synthetic host, API and state transitions are covered.
- **Any combination on Linux or Intel macOS** — only aarch64-apple-darwin on the pinned toolchain is verified; other platforms remain evaluation scope.
- **The Kiro gateway connector beside the mod set** — not implemented.
- **Every possible combination of mods, plugins and optional integrations** — the space is combinatorially unbounded; this matrix maintains representative combinations and names what is not covered instead.

## Reproducing the evidence

`rust:` a test in the pinned runtime crates · `patch:` a test added by the shipped runtime
patch · `node:` `mods/runner.test.mjs` · `python:` `tests/` · `script:` a repository checker.

```sh
python3 -m scripts.integration_matrix
python3 -m scripts.mod_conformance
python3 scripts/mod_compatibility.py
python3 -m unittest discover -s tests
OMD_TEST_NODE=/absolute/node-24.18.0/bin/node cargo +1.95.0 test --locked -p codex-omd
pnpm --dir mods test
```
