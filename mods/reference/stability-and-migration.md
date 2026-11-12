# Stability and migration

Use it when you need to know which API entries keep their shape, which may change in any release, and what changed
after `1.0.0`. The conformance registry, `mods/conformance/contract.json`, is the source of truth for every status
on this page.

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](#experimental-entries-in-the-registry)). Runs on Apple Silicon macOS.

## Stability

API `1.0.0` is stable.

Terminal configuration targeting (`target`, `reset`, settings `scope`, package `reset` and `save-defaults` actions) and package
inheritance metadata are experimental additions. Settings and enablement changes are saved for every terminal by default;
`target: "terminal"` opts in to a change for the current terminal only.
`PackageState.scope` now includes `managed`: `packages.list` already returned administrator-managed mods, and the type
was corrected to match.
[The conformance registry](https://github.com/dzkchen/oh-my-diff/blob/main/mods/conformance/contract.json) marks each
public operation, event, capability, interceptor, component, render site, view field, classic hook and author command as
frozen or experimental:

- Frozen entries keep their shape through `2027-10-19`. A breaking change to one needs a major version and a migration
  note.
- Experimental ones may change in any release.
- A frozen entry's `experimental_fields` (fields added after 1.0.0, such as the `workspace.watch` `key`) are
  experimental too.

Version and support rules are in
[COMPATIBILITY.md](https://github.com/dzkchen/oh-my-diff/blob/main/mods/conformance/COMPATIBILITY.md).

### Experimental entries in the registry

The registry marks these entries experimental in Mod API `1.0.0`:

| Kind | Experimental entries |
| --- | --- |
| Capabilities | `approve.override`, `autonomous`, `fs.external`, `history_write`, `mcp`, `peers`, `power`, `unix_sockets` |
| Events | `config_change`, `contract`, `elicitation_result`, `focus`, `host_operation`, `instructions_loaded`, `migrate`, `mods_changed`, `peer_message`, `peer_receipt`, `prompt`, `prompt_expanded`, `session`, `tool_batch_end`, `tool_exposure`, `turn_queue`, `view`, `worktree` |
| Interceptors | `agent_offers`, `agent_spawn`, `compaction`, `component_change`, `composer_key`, `elicitation`, `mention`, `peer_receive`, `peer_send`, `turn_stop` |
| Operations | `agents.list`, `agents.message`, `app.routes`, `builtins.invoke`, `commands.describe`, `config.describe`, `config.set`, `environment.read`, `exec.output_page`, `http.close`, `http.open`, `http.read`, `ledger.settle`, `mcp.connect`, `mcp.disconnect`, `model.fork`, `models.context_window`, `mods.service`, `peers.list`, `peers.send`, `plugins.components`, `power.hold`, `power.release`, `prompts.consent`, `prompts.revoke`, `prompts.status`, `prompts.submit`, `routes.models`, `routes.status`, `routes.write`, `sidecars.stop`, `store.export`, `store.list`, `store.reset`, `terminal.blit`, `terminal.image_sample`, `terminal.panes`, `time.sleep`, `tools.invoke`, `tools.list`, `tools.original`, `tools.undefine`, `turns.dequeue`, `turns.queue`, `turns.queued`, `workspace.check_access` |
| Components | `raster` |
| Render sites | `composer_hint`, `notice`, `session_mode`, `tool_result`, `turn_duration`, `user_message` |
| View fields | `background`, `footer`, `foreground`, `header`, `key_contexts`, `panels`, `placeholder`, `surface_styles`, `underlay` |
| View sites | `header` |
| Classic hooks | `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `Elicitation`, `ElicitationResult`, `FileChanged`, `InstructionsLoaded`, `MessageDisplay`, `Notification`, `PermissionDenied`, `PermissionRequest`, `PostCompact`, `PostModelSwitch`, `PostToolBatch`, `PostToolUse`, `PostToolUseFailure`, `PreCompact`, `PreModelSwitch`, `PreToolUse`, `SessionEnd`, `SessionStart`, `Setup`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `TaskCompleted`, `TaskCreated`, `TeammateIdle`, `UserPromptExpansion`, `UserPromptSubmit`, `WorktreeCreate`, `WorktreeRemove` |
| Author commands | `cost` |

### Experimental features without a registry entry

These experimental features have no registry entry of their own:

| Feature | Covers |
| --- | --- |
| `session_activation_v1`, `background_jobs_v1` | Retained session variables and typed background jobs |
| `assistant_message_identity_v1` | Assistant completion events and message IDs on render props |
| `api.uiState` and command views | [Session UI state](state-and-storage.md#session-ui-state-apiuistate) and [command views](commands-and-composer.md#command-views) |
| `process_streams_v1` | `framing: "raw"` on `process.start` |
| `process_raster_v1`, `raster_pixels_v1` | Processes that feed a raster frames or raw pixel buffers |
| `route_new_threads_v1` | `routes.select` with `scope: "new_threads"`, for future terminal threads |
| `completion_tokens_v1` | `api.completion` token triggers |
| `settings_file_v1` | `api.settingsFile` and the settings file |
| `terminal_focus_v1` | Focus regions, the `region` and `help` key actions, `keys: 'all'` and a layout leaf's `style.focus` |
| `terminal_pty_v2` | The terminal pane extension: keys, mouse, cursor, OSC signals, session directories, binary pins and `autofocus` |
| Plugin components | [The `.codex-plugin/omd.json` mod component descriptor and `omd COMMAND` shell dispatch](plugin-components.md) |
| `package_contributes_v1` | The manifest's [`contributes`](packaging.md#contributes) declaration |

### Frozen entries with experimental fields

These frozen entries have experimental fields:

| Frozen entry | Experimental fields | Host feature the registry names |
| --- | --- | --- |
| `events:agent` | `provider`, `model`, `billing` | none |
| `events:component_event` | `content`, `target`, `edge`, `columns`, `rows` | `terminal_layout_dock_v1` |
| `events:terminal` | `omd_version`, `welcome`, `chat`, `colors`, `sites` | `terminal_welcome_area_v1`, `terminal_chat_area_v1`, `terminal_colors_v1`, `terminal_site_area_v1` |
| `events:timer` | `data` | `timer_data_v1` |
| `render_sites:assistant_message` | `message_id` | `assistant_message_identity_v1` |
| `replacements:tool_batch` | `success_per_call` | `tool_batch_success_v1` |
| `intercepts:tool` | `value`, `bytes` | `code_mode_values_v1`, `tool_original_v1` |
| `operations:agents.inventory` | `provider`, `model`, `billing` | none |
| `operations:agents.spawn` | `model` | none |
| `operations:events.schedule` | `data` | `timer_data_v1` |
| `operations:packages.apply` | `enable` | `plugin_components_v1` |
| `operations:packages.list` | `needs_approval`, `maintainer`, `contributes` | `package_needs_approval_v1`, `package_contributes_v1` |
| `operations:packages.preview` | `enable` | `plugin_components_v1` |
| `operations:routes.add` | `model`, `effort` | `routes_add_model_v1` |
| `operations:routes.list` | `data`, `status` | `route_write_v1`, `route_status_v1` |
| `operations:session.info` | `process_id`, `omd_version` | none |
| `operations:sidecars.status` | `started_at_ms` | none |
| `operations:terminal.panel` | `group`, `keywords`, `detail`, `query`, `selected`, `close_args` | `terminal_panel_navigation_v1` |
| `operations:workspace.unwatch` | `key` | `workspace_watch_key_v1` |
| `operations:workspace.watch` | `key`, `git` | `workspace_watch_key_v1`, `workspace_watch_git_v1` |
| `components:code` | `start` | `terminal_code_highlight_v1` |
| `view_fields:keybindings` | `region`, `help` | `terminal_focus_v1` |
| `view_fields:layout` | `title`, `focus` | `terminal_layout_title_v1`, `terminal_focus_v1` |
| `view_fields:welcome` | `hidden` | `terminal_welcome_hidden_v1` |

### Features OMD doesn't provide

OMD doesn't provide closure-based client modules, vendor kill switches, raw secret access, hosted mobile or desktop
clients, rich children inside buttons (a button uses its typed `text`), audio, telemetry and floating panes.

## Migration notes

These changes ship in OMD 1.6.0.

- Mods run in any session directory, including the home directory and `/`; before, the host stayed off there.
- Programs and sockets the host runs or passes unsandboxed (`os_access` programs, `exec.run` sockets, managed
  processes and services, frozen in Mod API `1.0.0`) are refused anywhere the agent can write: the whole Git work tree
  around the session directory, or the session directory outside one. Before, only the session directory was
  checked, so a launch from a repository's subfolder allowed programs elsewhere in the work tree. This is a safety
  fix; a mod that runs such a program needs it installed outside the repository (or outside the session directory).
- `workspace.*` without `root` fails with `workspace_unavailable` when the session directory is `/`, the home
  directory or a directory above it and isn't in a Git work tree. Other directories behave as before.

These changes ship in OMD 1.4.0.

- A `builtins` mode disable (`capabilities:builtins`, frozen in Mod API `1.0.0`) no longer removes tools limited to
  the disabled mode from the tool list. The list stays as stock Codex sends it, so a new thread's first request keeps
  hitting the provider's shared prompt cache, and a call to such a tool is refused instead
  (`request_user_input` without plan mode, unless the default mode may ask). The model may now try the call and gets
  an error result. A mod that relied on the tool being absent needs no change; one that inspected the tool list
  sees the tool.
- `routes.add` without `mod` (frozen in Mod API `1.0.0`) gives the caller itself a plan route and needs only
  `agents`; naming a mod still needs `packages`. The change is additive: every call valid before stays valid. A mod
  that calls it without `mod` requires `routes_add_self_v1`, so an OMD 1.3.0 host refuses it before it turns on.

These changes ship in OMD 1.3.0.

- Only mod `owner` can replace or wrap a site named `owner/name`. The host refuses a patch to that site from any other
  mod and reports it under `terminal.conflicts`. Before this change, any mod could wrap or replace another mod's site.
  This is a safety fix to the frozen `ui_composition_v1` (Mod API `1.0.0`). A mod that composes into a site it
  doesn't own must ask its owner for a native slot or its own site. Native sites (names without `/`) compose as
  before.
- A layout may nest 6 levels instead of 4. The raise is additive, so every layout valid before stays valid.
- Host calls per callback rise from 128 to 512 (`budget.hostCalls` starts at 512). The raise is additive, so a mod
  that counted calls or stayed under 128 keeps working. Other limits rose with it and only allow more than before:
  the callback transport budget, `process.exchange` and tool interceptor output, `api.state`, package files, view
  JSON, evidence pages and registrations per mod. Two of these changes are visible to a mod:
  - `evidence.read` without `max_bytes` returns pages of up to 64 KiB instead of 16 KiB.
  - The host drops a `tool` replacement the model can't take with a diagnostic after the chain, instead of refusing
    it inside the chain. The model can't take a replacement over 64 KiB that is longer than the original output. For
    a retried call, the original is the latest attempt's output. Either way the original output stands.
- `exec.run` children start in their own session without a controlling terminal. A program that prompts on
  `/dev/tty` (git credentials, ssh passphrases, `sudo`) fails instead of drawing over the TUI and waiting. Pass input
  through `stdin` or the program's non-interactive flags. Runs with `sandbox: "none"` also receive `SSH_AUTH_SOCK`, so
  programs under an `os` grant can sign in through the user's SSH agent.

### Package trust digest framing

Package digests now prefix each manifest, path and file-content record with its eight-byte big-endian length.
Existing trust digests change: inspect and re-trust folder mods, and reinstall curated packages from the new release.
Do not copy old grants to a new digest. Mods with the same ID share storage and the right to use or manage
credentials owned by that ID. A project copy takes precedence over a user copy. Package previews report
`identity_warning` when the ID is installed in another scope.
