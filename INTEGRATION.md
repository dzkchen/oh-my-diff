# Integration coverage

<!-- Generated from integration/matrix.json by scripts/integration_matrix.py --write. -->

Accumulated integration coverage for the rust-v0.154.0 pinned runtime as of
2026-09-21. Every component below is maintained with this release: it names its
owner, the exact version it is supported against, the fixtures that exercise it, what it
does not cover, and how it is removed or migrated. The matrix is checked against the
shipped sources by `scripts/integration_matrix.py`: a version, capability, hook, language
or evidence reference that disagrees with the runtime fails the check.

Combinations below are representative, not exhaustive. Exercising every possible
combination of mods, adapters and optional integrations is not promised; the untested
section names what is deliberately out of scope.

## Release

| Field | Value |
| --- | --- |
| codex | `0.154.0` |
| omd | `0.1.0` |
| mod api | `0.1.0-experimental.6` |
| package schema | `1` |
| upstream tag | `rust-v0.154.0` |
| upstream commit | `6b9826e3aa83b1a5947db50f4332cb9c65f1b340` |
| target | `aarch64-apple-darwin` |
| node | `24.18.0` |

## Host and public API

| Component | Owner | Version | Status | Fixtures | Limitations | Removal or migration |
| --- | --- | --- | --- | --- | --- | --- |
| **OMD host runtime** | OMD runtime (runtime/omd, runtime/native) | 0.1.0 on Codex 0.154.0 — features: author_diagnostics_v1, author_offline_runner_v1, author_tooling_v1, installed_contract_types_v1, package_manager_v1, service_contracts_v1, source_use_v1, state_migration_v1, transactional_reload_v1 | supported | `rust:omd/tests/mods.rs::host_versions_and_storage_schemas_are_reported_independently` · `rust:omd/tests/integration.rs::mods_share_the_event_pipeline_and_the_store_without_crossing_boundaries` · `script:scripts/mod_compatibility.py` | Apple Silicon macOS on the pinned commit; the host reports its own release, package schema and state schema independently and does not qualify the full upstream workspace. | Select or reinstall the retained upstream executable; `OMD_MODE=upstream_direct` disables OMD task behaviour inside the custom binary. |
| **Public TypeScript mod API** | OMD mod host (runtime/omd/src/mods.rs) | 0.1.0-experimental.6 — supported versions: 0.1.0-experimental.4, 0.1.0-experimental.5, 0.1.0-experimental.6 | supported | `script:scripts/mod_conformance.py` · `rust:omd/tests/mods.rs::exclusive_decisions_require_a_replacement_registration_while_observers_compose` · `node:typed module context callback` | Experimental and pre-1.0. Only the published rows are supported; `.4` is deprecated and no intervening or future version is promised. | Breaking stable changes need an API major with one stable OMD release of deprecation notice; each row has a finite support window in mods/COMPATIBILITY.md. |
| **Mod package install, update and rollback** | OMD package manager (runtime/omd/src/mods/package_manager.rs) | package schema 1 | supported | `rust:omd/tests/packages.rs::local_updates_preview_preserve_edits_settings_and_rollback` · `rust:omd/tests/packages.rs::stale_plans_and_interrupted_transactions_preserve_the_previous_lock` · `rust:omd/tests/packages.rs::repository_revision_is_immutable_and_cached_for_offline_reuse` | Local sources, immutable repository revisions and versioned packages only; there is no external registry publication or install path. | `omd-mod` disable and uninstall restore the previous lock, preserve edited sources and explicit settings, and leave no activated state. |

## First-party mods

| Component | Owner | Version | Status | Fixtures | Limitations | Removal or migration |
| --- | --- | --- | --- | --- | --- | --- |
| **omd_coordination** | OMD first-party bundle (mods/first-party/omd_coordination) | 0.1.0-preview.1 — capabilities: agents, commands, context, interception, lifecycle, recovery, routing, state, task, tools | supported | `python:test_first_party_mods_use_only_the_published_api` · `fixture:preview/success` · `fixture:conformance/success` | Preview package on the published API only; it does not replace the native coordination, review or completion policy, which stays authoritative. | Disable it in the mod store; the native policy continues unchanged and no state migration is required. |
| **omd_workspace** | OMD first-party bundle (mods/first-party/omd_workspace) | 0.1.0-preview.1 — capabilities: commands, lifecycle, state, terminal | supported | `python:test_first_party_mods_use_only_the_published_api` · `fixture:preview/success` · `fixture:preview-broken/success` | Owns the exclusive terminal replacement while enabled; a second terminal claimant disables both and the host falls back to its native recovery panel. | Disable it in the mod store; the configured native theme and layout are restored. |

## Native Codex plugins, hooks and resources

| Component | Owner | Version | Status | Fixtures | Limitations | Removal or migration |
| --- | --- | --- | --- | --- | --- | --- |
| **Codex plugins (plugin.json)** | upstream Codex | 0.154.0 | supported | `patch:namespaced_commands_always_exist_and_bare_aliases_only_when_unique` · `rust:omd/tests/mods.rs::pi_and_native_discovery_preserve_project_precedence_without_trust` | Plugin discovery, MCP servers and hook execution stay upstream-owned and unmodified; OMD adds no plugin transport and does not sandbox plugin hooks. | Remove the plugin from the Codex plugin directory; no OMD state refers to it. |
| **Codex hooks** | upstream Codex | 0.154.0 — hooks: pre_tool_use, permission_request, post_tool_use, pre_compact, post_compact, session_start, session_end, user_prompt_submit, subagent_start, subagent_stop, stop, interrupt | supported | `script:scripts/integration_matrix.py` · `script:scripts/mod_conformance.py` | Hook dispatch is upstream-owned: competing pre_tool_use rewrites are still resolved by whichever hook finishes last, and no repository fixture drives an external hook command. | Remove the hook file from the Codex configuration; mod interception is registered separately and is unaffected. |
| **Pi resource adapter** | OMD mod host (runtime/omd/src/mods/pi.rs) | pi-0.74-resources-v2 | opt in | `rust:omd/tests/mods.rs::pi_nested_skills_honor_ignore_rules_and_frontmatter` · `rust:omd/tests/mods.rs::pi_prompt_expansion_matches_pi_0_74_oracle` · `rust:omd/tests/integration.rs::mods_and_upstream_pi_resources_coexist_without_capturing_each_other` | Skills and prompts only, bounded by entry, depth and aggregate limits; symlinked or protected resources are refused and reported, never silently omitted. | Do not grant the `pi_resources` capability; discovery then fails closed for that package. |

## Bundled browser tooling

| Component | Owner | Version | Status | Fixtures | Limitations | Removal or migration |
| --- | --- | --- | --- | --- | --- | --- |
| **Bundled browser tooling** | OMD browser bundle (scripts/browser_bundle.py) | Playwright MCP with a pinned Chromium — versions: node 24.21.0, pnpm 11.14.0, @playwright/mcp 0.0.81, playwright 1.64.0-alpha-2026-09-14, chromium 154.0.8037.0 | supported | `python:test_launcher_selects_the_bundled_browser_and_keeps_its_sandbox` · `python:test_prebuilt_archive_installs_the_same_verified_tree` · `python:test_failed_post_swap_update_restores_the_verified_bundle` | Apple Silicon macOS only, injected into OMD alone, prompt-gated by default; browser and MCP network effects are outside the shell sandbox. | `scripts/browser_bundle.py` removes the managed tree atomically; Codex and OMD keep working without it. |

## Language server adapters

| Component | Owner | Version | Status | Fixtures | Limitations | Removal or migration |
| --- | --- | --- | --- | --- | --- | --- |
| **Rust language server adapter** | OMD semantic LSP (runtime/omd/src/lsp.rs) | rust-analyzer | opt in | `rust:omd/src/lsp.rs::five_language_protocol_matrix_is_version_and_scope_bound` · `rust:omd/src/lsp.rs::unavailable_server_has_an_explicit_non_success_fallback` | Detects installed servers, never installs them; an absent server is an explicit non-success fallback and edits stay repository-scoped and hash-bound. | Disable `semantic_lsp` in the manifest capabilities; native editing behaviour is unchanged. |
| **TypeScript language server adapter** | OMD semantic LSP (runtime/omd/src/lsp.rs) | typescript-language-server, vtsls | opt in | `rust:omd/src/lsp.rs::five_language_protocol_matrix_is_version_and_scope_bound` · `rust:omd/src/lsp.rs::edit_scope_and_expected_hashes_fail_closed` | First detected candidate wins; no server version is pinned or installed by OMD. | Disable `semantic_lsp` in the manifest capabilities. |
| **JavaScript language server adapter** | OMD semantic LSP (runtime/omd/src/lsp.rs) | typescript-language-server, vtsls | opt in | `rust:omd/src/lsp.rs::five_language_protocol_matrix_is_version_and_scope_bound` · `rust:omd/src/lsp.rs::file_uri_round_trip_stays_in_repository` | Shares the TypeScript server candidates; a document whose language does not match its server is refused. | Disable `semantic_lsp` in the manifest capabilities. |
| **Python language server adapter** | OMD semantic LSP (runtime/omd/src/lsp.rs) | pyright-langserver, pylsp, jedi-language-server | opt in | `rust:omd/src/lsp.rs::five_language_protocol_matrix_is_version_and_scope_bound` · `rust:omd/src/lsp.rs::failed_post_edit_synchronization_rolls_back_filesystem_change` | Candidate order is fixed and capability differences between the three servers are not normalised. | Disable `semantic_lsp` in the manifest capabilities. |
| **Java language server adapter** | OMD semantic LSP (runtime/omd/src/lsp.rs) | jdtls | opt in | `rust:omd/src/lsp.rs::five_language_protocol_matrix_is_version_and_scope_bound` · `rust:omd/src/lsp.rs::installed_server_smoke_when_requested` | The live smoke is opt-in and skipped when jdtls is absent; startup cost is bounded by the configured limits rather than tuned. | Disable `semantic_lsp` in the manifest capabilities. |

## Application bridge adapters

| Component | Owner | Version | Status | Fixtures | Limitations | Removal or migration |
| --- | --- | --- | --- | --- | --- | --- |
| **Browser bridge adapter** | OMD application bridge (bridge/client.mjs) | policy schema 1, fetch client | default off | `python:test_all_five_adapters_exchange_events_and_exposed_state` · `python:test_client_sources_compile_and_javascript_executes` | Console and window-error capture is explicit; only policy-allowlisted origins and state names are served and no DOM or expression access exists. | Stop calling `connect`; host teardown rotates the token and removes the connection file. |
| **Node bridge adapter** | OMD application bridge (bridge/node-client.mjs) | policy schema 1, Node file and process hooks | default off | `python:test_all_five_adapters_exchange_events_and_exposed_state` · `python:test_authorization_version_redaction_bounds_state_and_teardown` | Process-error hooks are opt-in and installed by the application, not by the adapter. | Close the client during application shutdown; the host teardown clears retained evidence. |
| **Python bridge adapter** | OMD application bridge (bridge/python/omd_bridge.py) | policy schema 1, standard library only | default off | `python:test_all_five_adapters_exchange_events_and_exposed_state` · `python:test_authorization_version_redaction_bounds_state_and_teardown` | Owns only its optional daemon polling thread; it installs no logging or exception handler. | Close the client; teardown rejects pending state requests and clears in-memory evidence. |
| **Rust bridge adapter** | OMD application bridge (bridge/rust) | policy schema 1, blocking loopback client | default off | `python:test_all_five_adapters_exchange_events_and_exposed_state` · `python:test_client_sources_compile_and_javascript_executes` | Serde is pinned and no async runtime is required or taken over; the caller starts any polling thread. | Drop the client; the host removes the connection file on teardown. |
| **Java bridge adapter** | OMD application bridge (bridge/java) | policy schema 1, JDK 11 or newer | default off | `python:test_all_five_adapters_exchange_events_and_exposed_state` · `python:test_authorization_version_redaction_bounds_state_and_teardown` | Uses `HttpClient` with an optional daemon polling thread; no logging framework or uncaught-exception handler is installed. | Close the client during shutdown; teardown is identical for every adapter. |

## Optional integrations

| Component | Owner | Version | Status | Fixtures | Limitations | Removal or migration |
| --- | --- | --- | --- | --- | --- | --- |
| **Application bridge capability** | OMD host (runtime/native) | policy schema 1, external SHA-256 bound policy | default off | `python:test_authorization_version_redaction_bounds_state_and_teardown` · `python:test_bridge_launcher_uses_the_managed_node_runtime` | Development-only and off by default; activation fails if the external policy is missing or changed, state is pull-only and evidence is memory-only. | Remove `application_bridge` from the manifest capabilities and the `bridge` reference; the MCP server is then never registered. |
| **Approved provider routes and local sidecars** | OMD host operations (runtime/native/src/mods) | host-approved service IDs only — operations: providers.register, providers.unregister, sidecars.start, sidecars.status, sidecars.stop | opt in | `fixture:provider/success` · `rust:omd/tests/mods.rs::native_host_bridge_preserves_once_only_effects_and_rust_capability_checks` · `node:typed middleware and services register without ambient authority` | Only pre-approved executables and service IDs; secrets stay opaque references, the route and process group die with the task, and unapproved IDs are refused. | Revoke the `providers`/`sidecars` capability grants; the host unregisters routes and terminates the process group. |
| **Remote control** | upstream Codex | 0.154.0 native | removed |  | The OMD-specific wrapper was reverted on 2026-09-16; no OMD account, pairing or compatibility claim is retained. | Already removed from the runtime patch and private build; use the native Codex remote-control workflow supported by the installed version. |

## Shared resource and event boundaries

| Boundary | What it covers | Shared resource or event |
| --- | --- | --- |
| **duplicate_tools** | Two packages claiming one tool or command slot | the namespaced tool registry and the slash-command namespace |
| **duplicate_keybindings** | Competing terminal owners, keys and cross-mod key targets | the exclusive terminal replacement and the native keymap |
| **disabled_dependencies** | A disabled or absent dependency or service provider | the dependency graph, the service registry and the generated installed-contract types |
| **upstream_plugin_coexistence** | Mods beside upstream plugins, prompts and skills | Pi resource discovery, project precedence and the slash-command namespace |
| **streaming_reload** | Reload and disable during streamed work | the mod generation, in-flight callbacks and stream middleware |
| **host_upgrade** | Mixed API rows, host release pinning and state upgrades | API negotiation, host features and the package state store |
| **shared_context_budget** | Several mods contributing to one context assembly | the context event pipeline and its per-fragment and aggregate budget |
| **shared_state_store** | Several mods writing into one store | the store lock, per-mod state files and scope separation |
| **optional_integration_isolation** | Optional integrations start, serve and tear down cleanly | loopback listeners, managed processes and detected external servers |

## Exercised combinations

| Combination | Components | Boundaries | Result | Executable evidence |
| --- | --- | --- | --- | --- |
| **colliding_tool_and_terminal_slots** | omd_host, mod_api | duplicate_tools, duplicate_keybindings | Both claimants of one `mod_<id>_<name>` slot and both terminal claimants fail closed before activation; the remaining mod keeps its tool and command and no keybinding surface is published. | `rust:omd/tests/integration.rs::colliding_tool_slots_and_contested_terminal_owners_disable_only_the_claimants` · `rust:omd/tests/mods.rs::contested_exclusive_replacement_disables_every_claimant_and_keeps_the_rest` · `fixture:conformance-conflict/success` |
| **cross_mod_keybindings** | omd_host, mod_api | duplicate_keybindings | One owner publishes the key surface; its bindings may target another mod's command, and a view that claims a reserved native key is rejected by the host before the terminal sees it. | `rust:omd/tests/integration.rs::the_single_terminal_owner_binds_keys_that_may_target_another_mods_command` · `rust:omd/tests/mods.rs::terminal_validation_rejects_control_sequences_reserved_keys_and_unbounded_views` · `patch:native_escape_and_cancel_keys_cannot_be_intercepted` |
| **first_party_pair_with_contenders** | omd_coordination, omd_workspace, mod_api | duplicate_keybindings, shared_context_budget | The bundled pair runs with a contending terminal mod, a broken mod and a user/project duplicate: the contenders fail closed with source-located errors, the first-party context assembler reports the replaced contributions, and the pair keeps working. | `fixture:conformance-conflict/success` · `fixture:conformance/success` · `python:test_first_party_mods_use_only_the_published_api` |
| **disabled_service_provider** | omd_host, mod_api, mod_package_lifecycle | disabled_dependencies | Disabling a provider refuses the transactional reload, and the next session disables only the required consumer; the optional consumer catches the absence, unrelated mods keep composing and the generated installed-contract types follow the active set. | `rust:omd/tests/integration.rs::disabling_a_shared_service_provider_stops_only_its_required_consumer` · `rust:omd/tests/mods.rs::an_unavailable_dependency_disables_only_the_dependent_chain` · `rust:omd/tests/mods.rs::missing_incompatible_optional_cyclic_and_colliding_services_fail_independently` |
| **streamed_work_with_reload** | omd_host, mod_api, omd_workspace | streaming_reload | An edited mod is swapped only at the next generation: the in-flight tool call keeps its source and forwards each progress update once, the stream middleware keeps its old transform until reload, stale generations are rejected and the terminal owner is unchanged. | `rust:omd/tests/integration.rs::reloading_during_streamed_work_keeps_the_inflight_generation_and_swaps_the_next_one` · `rust:omd/tests/mods.rs::disabling_during_native_work_preserves_inflight_source_and_revokes_next_generation` · `fixture:cancel/success` |
| **mixed_api_host_upgrade** | omd_host, mod_api, mod_package_lifecycle | host_upgrade | Packages on all three supported API rows activate together with per-package stability and feature negotiation; a package pinned to another host release is refused before activation, and a bumped state version keeps only that package inactive until its explicit migration runs. | `rust:omd/tests/integration.rs::mixed_api_mods_share_one_host_and_upgrade_independently` · `rust:omd/tests/mods.rs::incompatible_host_schema_api_and_features_are_rejected_before_activation` · `script:scripts/mod_compatibility.py` |
| **pi_resource_coexistence** | pi_resources, upstream_plugins, mod_api | upstream_plugin_coexistence, duplicate_tools | A mod reads upstream prompts and skills through the host without capturing them: project scope wins over user scope, mod commands stay namespaced, and a bare alias shared with a mod, a prompt or a built-in is withdrawn with a stated reason. | `rust:omd/tests/integration.rs::mods_and_upstream_pi_resources_coexist_without_capturing_each_other` · `rust:omd/tests/mods.rs::pi_and_native_discovery_preserve_project_precedence_without_trust` · `patch:namespaced_commands_always_exist_and_bare_aliases_only_when_unique` |
| **shared_event_and_store_boundaries** | omd_host, mod_api | shared_context_budget, shared_state_store | Context observers run in activation order under the per-fragment limit; an observer that throws or exceeds its fragment is isolated and dropped for the runtime, and each package keeps a separate state file that a failing neighbour never creates or touches. | `rust:omd/tests/integration.rs::mods_share_the_event_pipeline_and_the_store_without_crossing_boundaries` · `rust:omd/tests/mods.rs::project_scope_takes_precedence_over_user_scope_without_sharing_state` · `rust:omd/tests/mods.rs::mod_state_refreshes_per_call_and_racing_writers_fail_without_lost_updates` |
| **browser_with_host** | browser_bundle, omd_host | optional_integration_isolation | The managed bundle is injected into OMD alone, launches the exact bundled executable with its own profile, and a failed post-swap update restores the verified tree with no stray process. | `python:test_launcher_selects_the_bundled_browser_and_keeps_its_sandbox` · `python:test_failed_post_swap_update_restores_the_verified_bundle` · `python:test_verify_detects_changes_but_ignores_bounded_artifacts` |
| **five_bridge_adapters_on_one_session** | application_bridge, bridge_browser, bridge_node, bridge_python, bridge_rust, bridge_java | optional_integration_isolation | All five adapters exchange events and exposed state with one authorized session; unauthorized applications, oversized payloads and stale versions are refused, and teardown rotates the token, clears evidence and removes the connection file. | `python:test_all_five_adapters_exchange_events_and_exposed_state` · `python:test_authorization_version_redaction_bounds_state_and_teardown` · `python:test_client_sources_compile_and_javascript_executes` |
| **five_language_lsp_with_host** | lsp_rust, lsp_typescript, lsp_javascript, lsp_python, lsp_java, omd_host | optional_integration_isolation | The five-language protocol matrix stays version and scope bound, an absent server produces an explicit non-success fallback rather than a failure, and a failed post-edit synchronisation rolls the filesystem change back. | `rust:omd/src/lsp.rs::five_language_protocol_matrix_is_version_and_scope_bound` · `rust:omd/src/lsp.rs::unavailable_server_has_an_explicit_non_success_fallback` · `rust:omd/src/lsp.rs::failed_post_edit_synchronization_rolls_back_filesystem_change` |
| **mod_interception_beside_native_handlers** | upstream_hooks, mod_api, omd_host | upstream_plugin_coexistence, duplicate_tools | A mod observes, denies or retargets a tool call before the native handler, permission check and hook chain run; it cannot forge the native outcome, and upstream hook dispatch itself stays unmodified. | `patch:mod_interception_denies_or_routes_through_registered_native_handler` · `rust:omd/tests/mods.rs::input_rewrite_requires_exclusive_replacement_while_observers_may_deny` · `fixture:deny/success` |
| **approved_sidecar_with_mods** | provider_sidecars, mod_api, omd_host | optional_integration_isolation, streaming_reload | An approved sidecar and provider route start, serve and are torn down inside the owning task and generation; unapproved service IDs are refused, secrets stay opaque references and nothing survives task completion. | `fixture:provider/success` · `rust:omd/tests/mods.rs::native_host_bridge_preserves_once_only_effects_and_rust_capability_checks` · `node:typed middleware and services register without ambient authority` |

## Retained regression cases

| Case | Retained for | What stays covered | Executable evidence |
| --- | --- | --- | --- |
| **deprecated_api_row** | 0.1.0-experimental.4 | A package on the deprecated row activates only because that row is still published, and reports `deprecated` stability. | `rust:omd/tests/mods.rs::synthetic_deprecated_api_mod_activates_only_because_it_has_an_explicit_support_row` · `rust:omd/tests/integration.rs::mixed_api_mods_share_one_host_and_upgrade_independently` |
| **older_experimental_api** | 0.1.0-experimental.5 | A package built against the older experimental API keeps activating on the current host with negotiated required and optional features. | `rust:omd/tests/mods.rs::synthetic_old_api_mod_activates_on_a_compatible_new_host` · `rust:omd/tests/integration.rs::mixed_api_mods_share_one_host_and_upgrade_independently` |
| **current_api_composition** | 0.1.0-experimental.6 | Composition, precedence and conflict handling on the current row: declared order, cycles, contested replacements and scope shadowing. | `rust:omd/tests/mods.rs::composition_order_is_declared_dependencies_first_then_mod_id` · `rust:omd/tests/mods.rs::a_dependency_cycle_is_rejected_before_activation_and_isolated` · `script:scripts/mod_conformance.py` |
| **state_migration_and_rollback** | 0.1.0 | Package-owned state survives a host upgrade only through an explicit migration, with a content-addressed backup and an interrupted-migration rollback. | `rust:omd/tests/mods.rs::migration_is_explicit_bounded_and_preserves_previous_state` · `rust:omd/tests/mods.rs::interrupted_migration_and_explicit_rollback_preserve_source_settings_and_state` · `rust:omd/tests/integration.rs::mixed_api_mods_share_one_host_and_upgrade_independently` |
| **pinned_codex_baseline** | 0.154.0 | The shipped runtime patch still applies byte-for-byte to the pinned upstream commit and stays compatible with the recorded upstream surfaces. | `script:scripts/apply_runtime_patch.py` · `script:scripts/verify_codex_compat.py` · `script:scripts/normalize_upstream_lock.py` |
| **pinned_node_runtime** | 24.18.0 | Mods keep loading under the pinned Node erasable-TypeScript loader with no ambient process, fetch or code generation. | `node:no ambient process, fetch, or code generation` · `node:typed module context callback` · `script:scripts/mod_author_acceptance.py` |

## Tested versus untested

Tested: 13 combinations across 9 shared boundaries and 22 maintained components, plus 6 regression cases retained across versions.

Untested and not claimed:

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
patch · `node:` `mods/runner.test.mjs` · `python:` `tests/` · `fixture:` profile/scenario of
`benchmarks.controlled_fixture` · `script:` a repository checker.

```sh
python3 scripts/integration_matrix.py
python3 scripts/mod_conformance.py
python3 scripts/mod_compatibility.py
python3 -m unittest discover -s tests
OMD_TEST_NODE=/absolute/node-24.18.0/bin/node cargo +1.95.0 test --locked -p codex-omd
pnpm --dir mods test
```
