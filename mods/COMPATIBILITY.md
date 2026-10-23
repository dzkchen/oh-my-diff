# Mod compatibility

Which hosts a mod runs on. The source is [compatibility.json](compatibility.json); `python3 scripts/mod_compatibility.py`
checks it against the host.

API `1.0.0` is stable and supported through `2027-10-19`. Entries marked frozen in
[the conformance registry](conformance/contract.json) keep their shape until then; a breaking change needs a
major version and a migration note in [the reference](REFERENCE.md). Experimental entries (including the raster
surfaces `terminal.blit` and `process_raster_v1`), and the `experimental_fields` of frozen entries, may change in any
release.

## Supported versions

| Codex | OMD host | Package schema | Mod API | Label | Service imports | Installed-contract types | Supported through |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.164.0 | 1.0.0 to 1.1.0 | 1 | 1.0.0 | stable | exact `x.y.z` or `^x.y.z` | 1 | 2027-10-19 |

Only the current API loads.

Upstream lag on 2026-10-23: none. Codex 0.164.0 is the latest stable Codex release. A newer Codex is supported once an
OMD release lists it here. Update and roll back OMD with `omd update` and `omd update rollback`
([install](../docs/install.md#update)).

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
| `packages.index` `cursor`/`limit` | `package_index_paging_v1` |
| `routes.write` | `route_write_v1` |
| `success_per_call` on a `tool_batch` merge | `tool_batch_success_v1` |
| `value` in code-mode `tool` results and answers | `code_mode_values_v1` |
| `workspace.watch`/`workspace.unwatch` `key` | `workspace_watch_key_v1` |
| Declared assets | `package_text_assets_v1` |
| Relative asset imports | `package_imports_v1` |
| `api.component` | `component_modules_v1` |

`mise run mods:check` checks the last three.

## Terminals

Supported terminals: Kitty, Ghostty, WezTerm and Orca's terminal. Images use Kitty graphics in
Kitty and Ghostty, and inline images in Orca and WezTerm. Other terminals aren't tested; the host falls back to half-block cells or text.

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
  omd-mod rollback STORE MOD_ID_OR_PACKAGE BACKUP
  ```

  `omd-mod migrate STORE MOD_ID_OR_PACKAGE` runs the handler by hand. A bare name is a mod id among the store's
  selected mods; anything with a `/` is a package folder. An id present in more than one scope fails with
  `mod_ambiguous` (pass the folder), and a mod without saved store state fails with `migration_requires_saved_state`.

## Tested and not tested

Tested: Apple Silicon macOS with Codex 0.164.0, the OMD+ and OMD Core collections, and the bundled plugins.

Not tested:

- Linux or Intel macOS.
- Terminals other than those above.
- Third-party mods combined with the OMD+ collection.
- Upgrading from an earlier OMD release.
- Artifact reading and code execution together in one live task.
- Every combination of mods, plugins and options.
