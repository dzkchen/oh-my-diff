# Mod compatibility

This is the experimental compatibility contract as of October 10, 2026. The
machine-readable source is [compatibility.json](compatibility.json), checked
against the Rust host by `python3 scripts/mod_compatibility.py`.

## Supported matrix

| Codex | OMD host | Package schema | Mod API | API label | Service imports | Generated installed-contract types | Support through |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.162.1 | 0.1.0, experimental | 1 | 0.2.0-experimental.5 | experimental | exact `x.y.z` or compatible `^x.y.z` | 1 | 2027-03-20 |

API 0.1 packages and declarations are retired from this development host. The
earlier 0.1 support-window rows described pre-release builds and are historical
evidence, not current executable compatibility. API 0.2 provides generic host
operations for execution, workspace access, snapshots, agents, contracts, evidence,
store, processes, terminal rendering and services. Until the first public
release the host supports only the current API: every API bump drops earlier
versions, and in-repository packages move to the new version with it. The rows are not a promise
that every intervening or future version works. Before activation the host checks the
package schema, API row, optional exact host-release list, required host features,
declared authority, dependencies, and service imports. `omd-mod status` reports
the host matrix and each mod's negotiated required, available optional, and
unavailable optional features.

The exact host feature list is published in [compatibility.json](compatibility.json)
and checked against the runtime source. A package may omit
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

The retained cross-release cases are historical synthetic version fixtures: old `.4` through
`.7` mods on the `.8` host, deliberate host/API/schema/feature incompatibility,
compatible and incompatible provider/consumer versions, interrupted migration,
and state rollback with source/settings/state preservation. No earlier public
stable OMD mod release exists, so there is no real supported release transition
to execute yet. That gate remains mandatory for the first supported successor
release and may not be replaced with these fixtures.

Only the exact accumulated host/session fixtures and explicit package migration
pairs are supported. OMD does not claim arbitrary-version session interchange,
automatic state downgrade, or arbitrary-version state interchange.
