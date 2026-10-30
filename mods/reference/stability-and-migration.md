# Stability and migration

Use it when you need to know which API entries keep their shape, which may change in any release, and what changed
after `1.0.0`. The conformance registry, `mods/conformance/contract.json`, is the source of truth for every status
on this page.

## Stability

API `1.0.0` is stable.
[The conformance registry](https://github.com/dzkchen/oh-my-diff/blob/main/mods/conformance/contract.json) marks each
public operation, event, capability, interceptor, component, render site, view field, classic hook and author command as
frozen or experimental:

- Frozen entries keep their shape through `2027-10-19`; a breaking change needs a major version and a migration note.
- Experimental ones may change in any release.
- A frozen entry's `experimental_fields` (fields added after 1.0.0, such as the `workspace.watch` `key`) are
  experimental too.

Version and support rules are in
[COMPATIBILITY.md](https://github.com/dzkchen/oh-my-diff/blob/main/mods/conformance/COMPATIBILITY.md).

### Experimental surfaces

Examples of experimental surfaces (the conformance registry, `mods/conformance/contract.json`, is authoritative):

- Raster frame streaming: `terminal.blit`, the `raster` component, `process_raster_v1` and `raster_pixels_v1`.
- Raw process streams: `framing: "raw"` on `process.start` (`process_streams_v1`).
- The `composer_key`, `mention` and `component_change` interceptors and `completion_tokens_v1`.
- HTTP streams (`http.open`, `http.read`, `http.close`); `http.request` is frozen.
- `api.uiState` and command views.
- `routes.write` (`route_write_v1`), added after 1.0.0.
- `api.settingsFile` and the settings file (`settings_file_v1`).
- Focus regions, `key_contexts`, the `region` and `help` key actions, `keys: 'all'` and a layout leaf's `style.focus`
  (`terminal_focus_v1`).
- Layout leaf `title` (`terminal_layout_title_v1`).
- Dragging a layout pane to dock it: the `content`, `target` and `edge` fields of the `dock` component event
  (`terminal_layout_dock_v1`).
- Power holds: the `power` grant, `power.hold` and `power.release` (`power_hold_v1`), added after 1.0.0.
- `tools.original` (`tool_original_v1`), added after 1.0.0.
- The `omd-mod-author cost` report, added after 1.0.0.

### Experimental entries in the registry

The registry marks these entries experimental in Mod API `1.0.0`:

| Kind | Experimental entries |
| --- | --- |
| Capabilities | `approve.override`, `autonomous`, `fs.external`, `history_write`, `mcp`, `peers`, `power`, `unix_sockets` |
| Events | `config_change`, `contract`, `elicitation_result`, `focus`, `host_operation`, `instructions_loaded`, `migrate`, `mods_changed`, `peer_message`, `peer_receipt`, `prompt`, `prompt_expanded`, `session`, `tool_batch_end`, `tool_exposure`, `turn_queue`, `view`, `worktree` |
| Interceptors | `agent_offers`, `agent_spawn`, `compaction`, `component_change`, `composer_key`, `elicitation`, `mention`, `peer_receive`, `peer_send`, `turn_stop` |
| Operations | `agents.list`, `agents.message`, `app.routes`, `builtins.invoke`, `commands.describe`, `config.describe`, `config.set`, `environment.read`, `exec.output_page`, `http.close`, `http.open`, `http.read`, `ledger.settle`, `mcp.connect`, `mcp.disconnect`, `model.fork`, `mods.service`, `peers.list`, `peers.send`, `power.hold`, `power.release`, `prompts.consent`, `prompts.revoke`, `prompts.status`, `prompts.submit`, `routes.write`, `sidecars.stop`, `store.export`, `store.list`, `store.reset`, `terminal.blit`, `terminal.image_sample`, `terminal.panes`, `time.sleep`, `tools.invoke`, `tools.list`, `tools.original`, `tools.undefine`, `turns.dequeue`, `turns.queue`, `turns.queued`, `workspace.check_access`, `workspace.unwatch` |
| Components | `raster` |
| Render sites | `composer_hint`, `notice`, `session_mode`, `tool_result`, `turn_duration`, `user_message` |
| View fields | `background`, `footer`, `foreground`, `header`, `key_contexts`, `panels`, `placeholder`, `surface_styles`, `underlay` |
| View sites | `header` |
| Classic hooks | `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `Elicitation`, `ElicitationResult`, `FileChanged`, `InstructionsLoaded`, `MessageDisplay`, `Notification`, `PermissionDenied`, `PermissionRequest`, `PostCompact`, `PostModelSwitch`, `PostToolBatch`, `PostToolUse`, `PostToolUseFailure`, `PreCompact`, `PreModelSwitch`, `PreToolUse`, `SessionEnd`, `SessionStart`, `Setup`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `TaskCompleted`, `TaskCreated`, `TeammateIdle`, `UserPromptExpansion`, `UserPromptSubmit`, `WorktreeCreate`, `WorktreeRemove` |
| Author commands | `cost` |

`api.uiState` and command views have no registry entry; the list above marks them experimental.

These frozen entries have experimental fields:

| Frozen entry | Experimental fields |
| --- | --- |
| `events:agent` | `provider`, `model`, `billing` |
| `events:component_event` | `content`, `target`, `edge` |
| `events:terminal` | `omd_version`, `sites` |
| `replacements:tool_batch` | `success_per_call` |
| `intercepts:tool` | `value`, `bytes` |
| `operations:agents.inventory` | `provider`, `model`, `billing` |
| `operations:agents.spawn` | `model` |
| `operations:routes.list` | `data` |
| `operations:session.info` | `process_id`, `omd_version` |
| `operations:sidecars.status` | `started_at_ms` |
| `operations:terminal.panel` | `group`, `keywords`, `detail`, `query`, `selected`, `close_args` |
| `operations:workspace.watch` | `key`, `git` |
| `components:code` | `start` |
| `view_fields:keybindings` | `region`, `help` |
| `view_fields:layout` | `title`, `focus` |

### Not provided

Not provided: closure-based client modules, vendor kill switches, raw secret access, hosted mobile or desktop clients,
rich children inside buttons (a button uses its typed `text`), audio, telemetry and floating panes.

## Migration notes

- A site named `owner/name` is replaced or wrapped only by mod `owner`; a patch from any other mod is now refused and
  reported under `terminal.conflicts`. This is a safety fix to the frozen `ui_composition_v1` (Mod API `1.0.0`): before,
  any mod could wrap or replace another mod's site. A mod that composes into a site it does not own must ask its
  owner for a native slot or its own site. Native sites (no `/`) compose as before.
- A layout may nest 6 levels instead of 4. The raise is additive: every layout valid before stays valid.
- Host calls per callback rise from 128 to 512 (`budget.hostCalls` starts at 512). The raise is additive: a mod that
  counted calls or stayed under 128 keeps working. The other limits raised with it (the callback transport budget,
  `process.exchange` and tool interceptor output, `api.state`, package files, view JSON, evidence pages and
  registrations per mod) only admit more than before, with two visible changes: `evidence.read` without `max_bytes`
  returns pages of up to 64 KiB instead of 16 KiB, and a `tool` replacement the model cannot take (over 64 KiB and
  longer than the original, which for a retried call is the latest attempt's output) is dropped with a diagnostic
  after the chain instead of being refused inside it. Either way the original output stands.
- `exec.run` children now start in their own session without a controlling terminal: a program that prompted on
  `/dev/tty` (git credentials, ssh passphrases, `sudo`) fails instead of drawing over the TUI and waiting. Pass input
  through `stdin` or the program's non-interactive flags. Runs with `sandbox: "none"` also receive `SSH_AUTH_SOCK`,
  so programs under an `os` grant can sign in through the user's SSH agent.
