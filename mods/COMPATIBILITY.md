# Mod compatibility

Which hosts a mod runs on. The source is [compatibility.json](compatibility.json); `python3 scripts/mod_compatibility.py`
checks it against the host.

The launch API is frozen at `0.2.0-experimental.5` through `2027-03-20` for entries marked frozen in
[the conformance registry](conformance/contract.json). Experimental entries are outside the freeze, and the host
and SDK are still pre-release.

## Supported versions

| Codex | OMD host | Package schema | Mod API | Label | Service imports | Installed-contract types | Supported through |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.163.0 | 0.1.0 | 1 | 0.2.0-experimental.5 | experimental | exact `x.y.z` or `^x.y.z` | 1 | 2027-03-20 |

Only the current API loads. Until `1.0.0`, every API change drops the previous version.

## What the host checks

Before a mod turns on, the host checks its package schema, API version, required host features, permissions,
dependencies and service imports.

A mod can also list `compatibility.releases`, `required_features` and `optional_features` in `mod.json`:

- A missing required feature stops the mod and says which side must change.
- A missing optional feature is only reported.
- `omd-mod status STORE` shows what each mod negotiated.

### Features to require

These reject older hosts before activation, even when the API version matches.

| If you use | Require |
| --- | --- |
| `turns.abort` | `turn_abort_v1` |
| `terminal.selection` | `terminal_selection_v1` |
| `terminal.copy` | `terminal_copy_v1` |
| `environment.set` | `environment_overrides_v1` |
| Timers of 16-999 ms | `timers_16ms_v1` |
| Declared assets | `package_text_assets_v1` |
| Relative asset imports | `package_imports_v1` |
| `api.component` | `component_modules_v1` |

`mise run mods:check` checks the last three.

## Services

Service contracts use `x.y.z` versions. A consumer asks for an exact version or a caret range.

- `^1.2.0` accepts later 1.x providers, not 2.x.
- For 0.x contracts, the range stays within the minor version.

## State changes

The host never rewrites a mod's code or settings.

- When `state_version` changes, a mod with `"store"` state stays off until its `migrate` handler runs.
- Thread and checkout state migrates through the same handler before the mod's next callback there. An update
  that changes their `state_version` needs one.
- Migration backs up the old state first. To restore it while the mod is off:

  ```sh
  omd-mod rollback STORE PACKAGE BACKUP
  ```

## Tested and not tested

Tested: Apple Silicon macOS with Codex 0.163.0, the OMD+ and OMD Core collections, and the shipped plugins together.

Not tested:

- Linux or Intel macOS.
- Third-party mods combined with the OMD+ collection.
- Upgrading from an earlier OMD release (there is none yet).
- Artifact reading and code execution together in one live task.
- Every combination of mods, plugins and options.
