# Mod compatibility

Which hosts a mod runs on. The source is [compatibility.json](compatibility.json); `python3 scripts/mod_compatibility.py`
checks it against the host.

The launch API is frozen at `0.2.0-experimental.5` through `2027-03-20` for the entries marked frozen in
[the conformance registry](conformance/contract.json). Entries marked experimental stay outside the freeze;
the host and SDK remain pre-release.

## Supported versions

| Codex | OMD host | Package schema | Mod API | Label | Service imports | Installed-contract types | Supported through |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.162.1 | 0.1.0 | 1 | 0.2.0-experimental.5 | experimental | exact `x.y.z` or `^x.y.z` | 1 | 2027-03-20 |

Only the current API loads. Until `1.0.0`, every API change drops the previous version.

## What the host checks

Before a mod turns on, the host checks its package schema, API version, required host features, permissions,
dependencies and service imports. A mod can also list `compatibility.releases`, `required_features` and
`optional_features` in `mod.json`. A missing required feature stops the mod and says which side must change; a
missing optional one is only reported. `omd-mod status STORE` shows what each mod negotiated.

Require `turn_abort_v1` for `turns.abort`, `terminal_selection_v1` for `terminal.selection`, `terminal_copy_v1`
for `terminal.copy`, `environment_overrides_v1` for `environment.set`, and `timers_16ms_v1` for 16–999 ms
timers. These labels reject older hosts before activation even when their API version matches.

Declared assets require `package_text_assets_v1`, relative asset imports require `package_imports_v1`, and
`api.component` requires `component_modules_v1`. `mise run mods:check` checks all three.

## Services

Service contracts use `x.y.z` versions. A consumer asks for an exact version or a caret range: `^1.2.0` accepts
later 1.x providers but not 2.x, and for 0.x contracts the range stays within the minor version.

## State changes

The host never rewrites a mod's code or settings. When `state_version` changes, the mod stays off until its
`migrate` handler runs. Migration backs up the old state first; `omd-mod rollback STORE PACKAGE BACKUP` restores
it while the mod is off.

## Tested and not tested

Tested: Apple Silicon macOS with Codex 0.162.0, the OMD+ and OMD Core collections, and the shipped plugins
together. Not tested:

- Linux or Intel macOS.
- Third-party mods combined with the OMD+ collection.
- Upgrading from an earlier OMD release (there is none yet).
- Artifact reading and code execution together in one live task.
- Every possible combination of mods, plugins and options.
