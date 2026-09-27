# Extension types

<!-- Generated from mods/extension-types.json by scripts/mod_extension_types.py --write. -->

Use a skill for instructed procedures, a hook for lifecycle reactions, a plugin for tools or services, and a mod only for live engine or terminal replacement.

A conformance fixture is retained source and executable coverage, not a package offered
to users. The author SDK packs only author examples. The current private-preview bundle
contains only the packages labeled `bundled` below.

## Bundled packages

| Package | Extension type | Source | Why a mod is required for this behavior |
| --- | --- | --- | --- |
| `omd_coordination@0.1.0-preview.4` | `mod` | `mods/first-party/omd_coordination` | Replaces live task-entry routing and context assembly, and exports bounded delegation preparation to the recovery policy. |
| `omd_recovery@0.1.0-preview.2` | `mod` | `mods/first-party/omd_recovery` | Replaces live escalation and delegation dispatch with failure classification, eligible-tool, advisory-route, and Contributor-outage choices. |
| `omd_workspace@0.2.0-preview.2` | `mod` | `mods/first-party/omd_workspace` | Replaces the live terminal workspace, render sites, key actions, and streamed activity presentation. |

## Unqualified first-party candidates

| Package | Extension type | Source | Why a mod is required for this behavior |
| --- | --- | --- | --- |
| `omd_claude_cli@0.1.0-preview.1` | `mod` | `mods/first-party/omd_claude_cli` | Translates live admitted model requests through the opt-in official Claude CLI route while the native host retains credentials, permissions, accounting, and cancellation. |
| `omd_task_tools@0.1.0-candidate.1` | `mod` | `mods/first-party/omd_task_tools` | Selects owned optional tools at the native per-request boundary from the current host checkpoint; a static skill or plugin cannot change that exposure for each task step. |
| `omd_session_anchor@0.1.0-candidate.1` | `mod` | `mods/first-party/omd_session_anchor` | Replaces the local compaction decision and injects bounded host checkpoint anchors during a live session. |
| `omd_typed_tasks@0.1.0-preview.1` | `mod` | `mods/first-party/omd_typed_tasks` | Owns the live typed task tool, bounded sibling dispatch and result-schema validation while using generic native worker and isolated integration operations. |
| `omd_verification_gate@0.1.0-candidate.1` | `mod` | `mods/first-party/omd_verification_gate` | Registers an explicitly selected native workflow contract and asks the host to restrict delegation when an exact candidate enters final verification. |
| `omd_logo@0.1.0-preview.1` | `mod` | `mods/first-party/omd_logo` | Draws the Oh My Diff wordmark and launch status into the terminal header from the read-only launch identity. |
| `omd_model_picker@0.1.0-preview.1` | `mod` | `mods/first-party/omd_model_picker` | Selects the compact native model and reasoning picker presentation while native keeps rows, warnings and persistence. |
| `omd_selection_copy@0.1.0-preview.1` | `mod` | `mods/first-party/omd_selection_copy` | Sets the live copy-on-highlight policy and reports each release result in the terminal status. |
| `omd_git@0.1.0-preview.1` | `mod` | `mods/first-party/omd_git` | Adds a live Git sidebar with previews and confirmations over host-owned, fingerprint-checked Git operations. |
| `omd_lsp_sync@0.1.0-preview.1` | `mod` | `mods/first-party/omd_lsp_sync` | Owns live language-server synchronization and rename/edit planning through generic host process and workspace operations. |
| `omd_advisor@0.1.0-preview.1` | `mod` | `mods/first-party/omd_advisor` | Owns completed-turn scheduling, independent review prompts, typed result validation, deduplication and selected-context presentation through public accounted review primitives. |
| `omd_research@0.1.0-preview.1` | `mod` | `mods/first-party/omd_research` | Owns lead-requested broad-research admission, bounded briefing and evidence validation using an explicitly granted read-only host worker preset. |

## Author examples

| Package | Extension type | Source | Why a mod is required for this behavior |
| --- | --- | --- | --- |
| `coordination@1.0.0` | `mod` | `mods/examples/coordination` | Drives live native agent spawning, waiting, result consumption, and lifecycle state inside the active task. |
| `kernel@1.0.0` | `mod` | `mods/examples/kernel` | Alters admitted model requests and the live response stream, which hooks and plugins cannot replace. |
| `recovery@1.0.0` | `mod` | `mods/examples/recovery` | Replaces live compaction and context recovery policy while reading host-owned checkpoint state. |
| `routing@1.0.0` | `mod` | `mods/examples/routing` | Replaces the model, provider, and reasoning preset selected at the live request boundary. |
| `terminal@1.0.0` | `mod` | `mods/examples/terminal` | Replaces live terminal layout, theme, render templates, and key handling. |
| `workflow@1.0.0` | `mod` | `mods/examples/workflow` | Registers and restricts a host-enforced workflow contract during a live task without owning native guarantees. |
| `workspace_author@1.0.0` | `mod` | `mods/examples/workspace` | Exercises reusable live workspace read, pre-rename events and host-authorized transactions. |
| `example_virtual_reader@1.0.0` | `plugin` | `mods/examples/virtual_reader` | Registers an independent virtual resource using the shared sandboxed extension bridge; the provider owns its resource grammar and content. |
| `example_scoped_data@1.0.0` | `mod` | `mods/examples/scoped_data` | Demonstrates scoped fact selection and frozen live context reuse, plus commands through the same public bridge. |
| `example_review_probe@1.0.0` | `hook` | `mods/examples/review_probe` | Owns a bounded completed-turn procedure and result interpretation through the shared accounted review interface. |
| `example_service_request@1.0.0` | `plugin` | `mods/examples/service_request` | Uses only a public tool export and a granted generic service request; no live engine replacement. |
| `release_check@1.0.0` | `mod` | `mods/examples/release_check` | An independent author package that uses only the 0.2 host primitives: a contract document, receipts, sandboxed commands, workspace listing, durable store and evidence, stream control, built-in controls and a list replacement. |

## Conformance fixtures

| Package | Extension type | Source | Why a mod is required for this behavior |
| --- | --- | --- | --- |
| `context@1.0.0` | `mod` | `mods/examples/context` | Exercises the bounded context observer API only; user-facing guidance belongs in a skill or lifecycle hook. |
| `counter@1.0.0` | `mod` | `mods/examples/counter` | Exercises tool, command, progress, and durable-state conformance only; a user-facing counter would be a plugin tool. |
| `guard@1.0.0` | `mod` | `mods/examples/guard` | Exercises input and lifecycle replacement conformance only; a user-facing deterministic guard would be a hook. |
| `interception@1.0.0` | `mod` | `mods/examples/interception` | Exercises simple tool interception conformance only; user-facing tool policy belongs in a hook or plugin. |
| `service_consumer@1.0.0` | `mod` | `mods/examples/service-consumer` | Exercises a host-routed service import only; a user-facing service consumer belongs in a plugin. |
| `service_provider@1.0.0` | `mod` | `mods/examples/service-provider` | Exercises a host-routed service export only; a user-facing service belongs in a plugin. |
| `atlas_console@1.0.0` | `mod` | `mods/exercise/atlas_console/1.0.0` | Exercises an older supported API row for live terminal replacement and state migration. |
| `atlas_console@2.0.0` | `mod` | `mods/exercise/atlas_console/2.0.0` | Exercises current live terminal replacement, interaction, and migrated state. |
| `atlas_policy@1.0.0` | `mod` | `mods/exercise/atlas_policy/1.0.0` | Exercises an older supported API row for live routing policy and state migration. |
| `atlas_policy@2.0.0` | `mod` | `mods/exercise/atlas_policy/2.0.0` | Exercises current live routing, context, coordination, interception, and cross-mod service replacement. |
| `task_scope@1.0.0` | `mod` | `mods/exercise/task_scope` | Exercises task-scoped optional tool exposure at each native sampling step. |
| `session_anchor@1.0.0` | `mod` | `mods/exercise/session_anchor` | Exercises bounded live compaction and checkpoint-derived context across reload. |

## Synthetic conformance fixtures

| Fixture | Extension type | Location | Boundary |
| --- | --- | --- | --- |
| `reader` | `mod` | `runtime/omd/tests/integration.rs` | Exercises bounded Pi resource discovery and command coexistence; a user-facing reader belongs in a plugin with skills. |
| `tool` | `mod` | `runtime/omd/tests/integration.rs` | Exercises duplicate tool slots, progress, and reload boundaries; a user-facing tool belongs in a plugin. |

The small context, counter, guard, interception, service, reader, and tool cases remain
available to repository conformance checks. They are not copied by `omd-mod-author examples`,
not packed as SDK examples, and not part of the private-preview bundle.
