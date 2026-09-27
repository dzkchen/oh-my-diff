# Mod compatibility

This is the supported compatibility contract as of September 26, 2026. The
machine-readable source is [compatibility.json](compatibility.json), checked
against the Rust host by `python3 scripts/mod_compatibility.py`.

## Supported matrix

| Codex | OMD host | Package schema | Mod API | API label | Service imports | Generated installed-contract types | Support through |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.157.0 | 0.1.0, experimental | 1 | 0.1.0-experimental.4 | deprecated | exact `x.y.z` or compatible `^x.y.z` | 1 | 2027-03-20 |
| 0.157.0 | 0.1.0, experimental | 1 | 0.1.0-experimental.5 | experimental | exact `x.y.z` or compatible `^x.y.z` | 1 | 2027-03-20 |
| 0.157.0 | 0.1.0, experimental | 1 | 0.1.0-experimental.6 | experimental | exact `x.y.z` or compatible `^x.y.z` | 1 | 2027-03-20 |
| 0.157.0 | 0.1.0, experimental | 1 | 0.1.0-experimental.7 | experimental | exact `x.y.z` or compatible `^x.y.z` | 1 | 2027-03-20 |
| 0.157.0 | 0.1.0, experimental | 1 | 0.1.0-experimental.8 | experimental | exact `x.y.z` or compatible `^x.y.z` | 1 | 2027-03-20 |
| 0.157.0 | 0.1.0, experimental | 1 | 0.1.0-experimental.9 | experimental | exact `x.y.z` or compatible `^x.y.z` | 1 | 2027-03-20 |

The current authoring API is `.9`. `.4` remains executable but is deprecated;
`.5` through `.8` are older experimental APIs. `.9` adds opt-in shared evidence/review, scoped data, virtual reads, service requests, constrained worker presets, and plugin CLI exports; each declares its required host features. `.7` adds bounded terminal components,
render sites, and composable terminal observer patches. Older APIs keep their
published exclusive-terminal behavior. `.8` adds task-scoped exposure of a mod's
own optional tools at each sampling step; older packages retain their prior
whole-generation tool registration behavior. These are explicit rows, not a promise that
every intervening or future version works. Before activation the host checks the
package schema, API row, optional exact host-release list, required host features,
declared authority, dependencies, and service imports. `omd-mod status` reports
the host matrix and each mod's negotiated required, available optional, and
unavailable optional features.

Host features in this release are `author_tooling_v1`,
`author_offline_runner_v1`, `author_diagnostics_v1`,
`installed_contract_types_v1`, `service_contracts_v1`, `source_use_v1`,
`package_manager_v1`, `state_migration_v1`, `terminal_components_v1`,
`terminal_identity_v1`, `terminal_picker_theme_v1`, `terminal_render_sites_v1`,
`terminal_rich_line_v1`, `terminal_selection_v1`, `git_operations_v1`,
`transactional_reload_v1`, and `task_tool_exposure_v1`. A package may omit
compatibility metadata and rely on its supported API row, or declare `compatibility.releases`,
`required_features`, and `optional_features`. A missing required feature or an
excluded host release rejects the package before activation and tells the user
which host/package side must change. Missing optional features are reported but
do not disable the mod.

## Stability and change rules

- `stable` means additions preserve the published contract. A breaking stable
  API or service-contract change requires a new major version, migration
  guidance, and deprecation notice in at least one stable OMD release before
  removal.
- `deprecated` remains supported through its published finite window. Stable
  deprecations name the notice release and replacement when one exists.
- `experimental` is pre-1.0 and may change, but only the rows and dates above are
  supported. It must never be described as stable compatibility.
- An urgent security fix may shorten the notice period only with a documented
  advisory naming the affected versions, reason, mitigation, and replacement.

Service providers publish semantic `x.y.z` contracts and a stability label.
Stable contracts start at major 1. Consumers may require an exact version or a
caret-compatible range; `^1.2.0` accepts later 1.x providers but rejects 2.x.
For 0.x contracts, caret compatibility stays within the minor version. A
deprecated export must declare `deprecated_since`; a breaking stable contract
shape needs a new major. The generated `installed-contracts.d.ts` independently
declares its format version, host release, current API, and exact activated
service versions.

## Upgrade, migration, and rollback

Package code and settings are never rewritten by host compatibility checks.
State is package-owned and separately versioned. A changed `state_version`
keeps the mod inactive until its disabled, trusted package runs an explicit
`migrate` handler. Migration writes a content-addressed backup before the atomic
state replacement. `omd-mod rollback STORE PACKAGE BACKUP` is also disabled-only,
checks package scope and trust, saves the current state as a forward-recovery
copy, and atomically restores the selected backup. The package source must then
be rolled back or upgraded to a release that understands the restored state.

The retained cross-release cases are synthetic version fixtures: old `.4` through
`.7` mods on the `.8` host, deliberate host/API/schema/feature incompatibility,
compatible and incompatible provider/consumer versions, interrupted migration,
and state rollback with source/settings/state preservation. No earlier public
stable OMD mod release exists, so there is no real supported release transition
to execute yet. That gate remains mandatory for the first supported successor
release and may not be replaced with these fixtures.

Only the exact accumulated host/session fixtures and explicit package migration
pairs are supported. OMD does not claim arbitrary-version session interchange,
automatic state downgrade, or arbitrary-version state interchange.
