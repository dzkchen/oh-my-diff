# Mod compatibility

Which OMD host runs which Codex and mod API versions, which host features a mod can require, and what is tested.
The source is [compatibility.json](compatibility.json); `python3 scripts/mod_compatibility.py` checks it against the
host. The support policy, platforms and terminals are in [Support](../../docs/support.md).

## Supported versions

| Codex | OMD host | Package schema | Mod API | Label | Service imports | Installed-contract types | Supported through |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.165.0 | unreleased (`main`, host crate version `1.2.0`, not the released 1.2.0) | 1 | 1.0.0 | stable | exact `x.y.z` or `^x.y.z` | 1 | 2027-10-19 |
| 0.164.0 | 1.2.0 | 1 | 1.0.0 | stable | exact `x.y.z` or `^x.y.z` | 1 | 2027-10-19 |
| 0.163.0 | 1.0.0 to 1.1.1 | 1 | 1.0.0 | stable | exact `x.y.z` or `^x.y.z` | 1 | 2027-10-19 |

Only the current API loads.

The `host` object in [compatibility.json](compatibility.json) describes `main`: Codex 0.165.0 with the host crate
version `1.2.0` from `runtime/omd/Cargo.toml`. The released OMD 1.2.0 runs Codex 0.164.0, as the table shows.

On the matrix's `as_of` date, OMD didn't lag upstream. Codex 0.165.0 was the newest stable Codex release then.

## What the host checks

Before a mod turns on, the host checks its package schema, API version, required host features, permissions,
dependencies and service imports.

A mod can also list `compatibility.releases`, `required_features` and `optional_features` in `mod.json`:

- A missing required feature stops the mod and says which side must change.
- A missing optional feature is only reported.
- `omd-mod status STORE` shows what each mod negotiated.

### Features to require

Listing one of these features in `required_features` makes an older host refuse the mod before it turns on, even when
the API version matches.

| If you use | Require |
| --- | --- |
| `turns.abort` | `turn_abort_v1` |
| `terminal.selection` | `terminal_selection_v1` |
| `terminal.copy` | `terminal_copy_v1` |
| `environment.set` | `environment_overrides_v1` |
| Timers of 16-999 ms | `timers_16ms_v1` |
| `packages.index` `cursor`/`limit` | `package_index_paging_v1` |
| `routes.write` | `route_write_v1` |
| `api.settingsFile` | `settings_file_v1` |
| `key_contexts`, `region` and `help` key actions, `keys: 'all'`, layout leaf `style.focus` | `terminal_focus_v1` |
| Layout leaf `title` | `terminal_layout_title_v1` |
| The `dock` `component_event` | `terminal_layout_dock_v1` |
| `power.hold`/`power.release` | `power_hold_v1` |
| `tools.original` | `tool_original_v1` |
| `api.builtins` `features.remove` | `builtins_features_v1` |
| `success_per_call` on a `tool_batch` merge | `tool_batch_success_v1` |
| `value` in code-mode `tool` results and answers | `code_mode_values_v1` |
| `workspace.watch`/`workspace.unwatch` `key` | `workspace_watch_key_v1` |
| `workspace.watch` `git` | `workspace_watch_git_v1` |
| `mods_changed` event | `mods_changed_v1` |
| `terminal` event `client.sites` | `terminal_site_area_v1` |
| `code` component `start` and `language` highlighting | `terminal_code_highlight_v1` |
| Declared assets | `package_text_assets_v1` |
| Relative asset imports | `package_imports_v1` |
| `api.component` | `component_modules_v1` |
| `terminal` event `client.welcome` | `terminal_welcome_area_v1` |
| `terminal` event `client.chat` | `terminal_chat_area_v1` |
| `terminal` event `client.colors` | `terminal_colors_v1` |
| `terminal.panel` `group`, `keywords`, `detail`, `query`, `selected`, `close_args` | `terminal_panel_navigation_v1` |
| View `underlay` | `terminal_underlay_v1` |
| View `welcome: {hidden}` | `terminal_welcome_hidden_v1` |
| `terminal.blit` `packed` | `terminal_raster_packed_v1` |
| `terminal` component `autofocus`, `terminal.pty` `files`, and the `exit`, `title`, `bell`, `notify` events | `terminal_pty_v2` |

`mise run mods:check` checks declared assets, relative asset imports and `api.component`.

## Service version ranges

Service contracts use `x.y.z` versions. A consumer asks for an exact version or a caret range.

- `^1.2.0` accepts later 1.x providers, not 2.x.
- For 0.x contracts, the range stays within the minor version.

## State changes

When a mod changes `state_version`, its saved state must be migrated before it runs. The steps are in
[Change a mod's saved state](../../docs/mod-authors/migrate-state.md).

## Tested and not tested

OMD is tested on Apple Silicon macOS with Codex 0.165.0, the OMD+ and OMD Core install profiles, and the bundled
plugins.

Linux and Intel macOS are unsupported, and the installer refuses them.

Not tested:

- Terminals not listed in [Support](../../docs/support.md).
- Third-party mods combined with the mods OMD+ includes.
- Upgrading from an earlier OMD release.
- Artifact reading and code execution together in one live task.
- Every combination of mods, plugins and options.
