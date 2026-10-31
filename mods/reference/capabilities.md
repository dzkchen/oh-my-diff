# Capabilities

Use it when you choose a mod's `capabilities` or review what a trusted mod can do. The tables list what each
manifest capability allows, and [Capability by operation](#capability-by-operation) lists the capability each host
operation needs. How the authority grants are scoped and ended is in [Authority grants](authority-grants.md).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](stability-and-migration.md#experimental-entries-in-the-registry)). Runs on Apple Silicon macOS.

A capability is a name in `mod.json` `capabilities` that allows a class of host operations, events and
registrations. User-facing pages call capabilities permissions. A call or registration outside the package's trusted
capabilities fails with `capability_denied: NAME` before any native work.

## Process, workspace, model and data capabilities

These capabilities allow processes, workspace files, models, agents, stored data, sessions and contracts, plus the
`history` replacement and `tool_output` observers.

| Capability | Allows |
| --- | --- |
| `exec` | `exec.run`, `exec.output_page`, `environment.read`, `environment.set`, `process.*`, `sidecars.*`, the `process_event` event; `app.request mcpServer/tool/call` |
| `pty` | `terminal.pty` (a writable pane also needs `fs.write`; `network: "loopback"` also needs `network`) |
| `history` | the `history` replacement |
| `outputs` | `tool_output` observers |
| `fs.read` | `workspace.read`, `workspace.list`, `workspace.stat`, read-only `workspace.check_access`, `workspace.snapshot`, `workspace.fingerprint`, `workspace.watch`, the `workspace_change` event; `app.request fuzzyFileSearch*` |
| `fs.write` | write-mode `workspace.check_access`, `workspace.transaction`, `workspace.backup`, `workspace.restore`, `workspace.request_rename`, the `workspace_pre_rename` event, `exec.run` with `write: true` |
| `network` | `exec.run`, `process.start` and `terminal.pty` with `network: "loopback"` |
| `unix_sockets` (experimental) | `exec.run` `unix_sockets` |
| `model` | `routes.list`, `routes.select`, `models.context_window`, `providers.*`, `ledger.settle`, the `routing` and `model_response` events |
| `agents` | `agents.*` (including `agents.inventory`), `api.agent`, `agent_offers` and `agent_spawn` interceptors, `model.complete`, `model.fork` (also needs `sessions` and `sessions_tools`), `task.status`, `workspace.integrate` |
| `store` | `store.*`, `evidence.write`, `evidence.read`, `api.state` |
| `sessions` | `sessions.list`, `sessions.read`, `sessions.snapshot`, `sessions.ports`, `turns.activity`, turn evidence on `turn_end` |
| `sessions_tools` | tool arguments and outputs in `sessions.read` records, `sessions.snapshot`, `model.fork` and `agents.spawn {parent_history}` (also needs `sessions`) |
| `contracts` | `api.contract`, `receipts.submit`, `task.complete`, `contract.status`, `contract.restrict`, `contract.select`, the `contract` event |
| `builtins` | `api.builtins`, `builtins.invoke`, `commands.invoke` |

## Terminal, thread and registration capabilities

These capabilities allow terminal, composer, thread, config, credential and package operations, and the registrations
a mod makes: tools, commands, interceptors, replacements, lifecycle events and services.

| Capability | Allows |
| --- | --- |
| `terminal` | the `terminal` event and `render` interceptors; `component_event`, `view`, `focus`; `terminal.notify`, `terminal.show_thread`, `commands.list`, `commands.describe`, `terminal.import_file`, `terminal.open`, `terminal.prompt`, `terminal.pane`, `terminal.panes`, `terminal.panel`, `terminal.notice`, `terminal.selection`, `terminal.copy`, `terminal.blit`, `terminal.image_sample`; the `component_change` interceptor |
| `threads` | `app.request` for the `threads` methods, the `app_notification` event, `turns.abort` |
| `config` | `app.request` for the `config` methods, `config.describe`, `config_list` interceptors, the `config_change` event |
| `config.write` | `app.request` for the `config.write` methods, `config.set`, `config_set` interceptors |
| `inventory` | `app.request` for the `inventory` methods, `app.routes`, `session.info`, `tools.list` |
| `account` | `app.request` for the `account` methods; lists ChatGPT workspaces (`accountSession/list`) and, from user actions only, switches them (`accountSession/switch`, confirmed natively on every call; browser sign-in stays native) |
| `approvals` | the `approval` middleware (which also needs `middleware`) and `approval_result`; `app_server_request` and `app.respond`; the `elicitation` interceptor and `elicitation_result` |
| `events` | `events.publish`, `events.schedule`, `events.cancel`, `time.sleep`, the `channel` and `timer` events |
| `credentials` | `credentials.list`, `credentials.request` |
| `composer` | `composer.read`, `composer.write`, `composer.suggest`, `prompts.*`, the `composer` event, the `composer_edit` and `composer_key` interceptors, `api.completion` and the `completion` replacement |
| `packages` | `packages.list`, `packages.index`, `packages.preview`, `packages.apply`, `packages.reload`, `routes.add`, `routes.write`, `settings.write` for another mod |
| `tools` | `api.tool`, `api.dynamicTools`, `tools.define`, `tools.undefine`, `tool_specs` interceptors |
| `interception` | `tool` interceptors, `tools.invoke`, `tools.check`, `tools.original` (`tool_original_v1`) and the `tool_batch` replacement |
| `input` | `input` and `mention` interceptors |
| `middleware` | `host_operation`, `model_request`, `response_stream` and `model_send` interceptors and the middleware events |
| `commands` | `api.command`, `command_list` and `command` interceptors, `settings.write` for the mod itself |
| `context` | the `context` replacement and the `context` event |
| `lifecycle` | the lifecycle events: `start`, `idle`, `stop`, `resume`, `tool_result`, `turn_start`, `turn_end`, `compaction_start`, `compaction_end`, `agent_end`, `tool_batch_end`, `instructions_loaded`, `thread_settings`, `worktree`, `mods_changed` |
| `compaction` | the `compaction` replacement, the `compaction` event and the `compaction` interceptor |
| `services` | `api.provide` and `api.services.call` |
| `virtual_reads` | `api.virtualRead` |

## Authority grant capabilities

Every capability in this table except `request_policy` is an authority grant. The manifest declares each grant's
scope. [Unrestricted processes and delegated approvals](authority-grants.md#unrestricted-processes-and-delegated-approvals)
and [Structured access](authority-grants.md#structured-access-structured_access_v1) describe how the grants are bound
and ended.

| Capability | Allows |
| --- | --- |
| `os` | `sandbox: "none"` on `exec.run`, `process.start` and `terminal.pty` start (`unrestricted_process_v1`) |
| `approve` | `{approve}` from the `approval` middleware inside the manifest's `approves` scope (`delegated_approval_v1`) |
| `approve.override` (experimental) | delegated approval of commands the user's own execpolicy rules forbid |
| `http` | `http.request`, `http.open`, `http.read`, `http.close` to the manifest's `http_access` origins (`structured_access_v1`) |
| `fs.external` (experimental) | `root` on `workspace.read`, `workspace.list`, `workspace.stat` and `workspace.transaction` for the manifest's `fs_access` roots |
| `mcp` (experimental) | `mcp.connect`, `mcp.disconnect` for the manifest's `mcp_servers` |
| `policy` | `admission` interceptors and namespace withholding inside the manifest's `policy.namespaces` (`admission_api_policy_v1`) |
| `request_policy` | a declared [final-request policy](final-request-policy.md#declared-policies-request_policy) (needs `middleware`; `final_request_policy_v1`) |
| `peers` (experimental) | `peers.list`, `peers.send`, `peer_send` and `peer_receive` interceptors, the `peer_message` and `peer_receipt` events, within the manifest's `peer_access` (`peer_sessions_v1`) |
| `power` (experimental) | `power.hold` and `power.release`; lid-closed holds need the deployed [authority broker](protected-authority.md) (`power_hold_v1`) |
| `autonomous` (experimental) | `turns.queue`, `turns.queued`, `turns.dequeue`, `turn_stop` interceptors and the `turn_queue` event, within the manifest's `autonomy` limits (`autonomous_turns_v1`) |
| `history_write` (experimental) | [`app.request thread/rewrite`](history.md#durable-transcript-rewriting-history_rewrite_v1) on the current thread and threads the mod started (`history_rewrite_v1`) |
| `history_persist` | [`history_persist` interceptors](history.md#store-time-history-rewriting-history_persist_v1), which see and may replace every stored history text (`history_persist_v1`) |

With `request_policy`, the host refuses every model request except web search unless the mod's required `model_send`
interceptor serves it. The grant exposure text shows `request_policy`, but it isn't an authority grant and doesn't
expire.

### Who can issue or widen a grant

Two parties can issue a grant or widen its capabilities or scope:

- The user, by trusting the package's exact content and scope. The user trusts in the TUI trust dialog, with
  `omd-mod trust` or `trust-all`, or through the [`trust` entry](packaging.md#package-requests) of an install or
  update they confirm. With the [authority broker](protected-authority.md#authenticating-changes) deployed, the
  broker authenticates each change.
- An administrator, through a [managed `packages` entry](administrator-policy.md#managed-packages-entries): the policy
  is the grant.

A package's install scripts, rendering, services, dependencies and model text can't issue or widen a grant.

### Authority errors

| Error | When |
| --- | --- |
| `capability_denied: NAME` | A call or registration needs a capability the package wasn't trusted with. |
| `grant_expired: NAME` | An authority grant passed its `--expires` time or was revoked. |
| `capability_withheld: NAMESPACE` | An [admission policy](admission-and-interception.md#admission-and-api-policy-admission_api_policy_v1) withheld the namespace. |
| `managed_capability_denied` | An [administrator policy](administrator-policy.md#policy-controls-and-refusals) `capabilities` list withholds the capability. |
| `grant_not_brokered` | The broker doesn't store the same grant for the selection ([Protected authority](protected-authority.md#what-the-broker-protects)). |
| `invalid_os_access`, `invalid_approves`, `invalid_http_access`, `invalid_fs_access`, `invalid_mcp_servers` | The manifest declares an authority grant without its scope field or prerequisites ([Authority grants](authority-grants.md)). |

## Capability by operation

This table lists every host operation in the
[conformance registry](https://github.com/dzkchen/oh-my-diff/blob/main/mods/conformance/contract.json), the capability
it needs and its registry status. An operation marked experimental may change in any release; see
[Stability and migration](stability-and-migration.md).

| Operation | Capability | Status |
| --- | --- | --- |
| `agents.cancel` | `agents` | frozen |
| `agents.inventory` | `agents` | frozen; experimental fields: `provider`, `model`, `billing` |
| `agents.list` | `agents` | experimental |
| `agents.message` | `agents` | experimental |
| `agents.result` | `agents` | frozen |
| `agents.spawn` | `agents`; `parent_history` also needs `sessions` and `sessions_tools` | frozen; experimental fields: `model` |
| `agents.wait` | `agents` | frozen |
| `app.request` | `threads`, `config`, `config.write`, `inventory` or `account` by method class; `exec` for `mcpServer/tool/call`; `fs.read` for `fuzzyFileSearch*`; `history_write` for `thread/rewrite` | frozen |
| `app.respond` | `approvals` | frozen |
| `app.routes` | `inventory` | experimental |
| `builtins.invoke` | `builtins` | experimental |
| `commands.describe` | `terminal` | experimental |
| `commands.invoke` | `builtins` | frozen |
| `commands.list` | `terminal` | frozen |
| `composer.read` | `composer` | frozen |
| `composer.suggest` | `composer` | frozen |
| `composer.write` | `composer` | frozen |
| `config.describe` | `config` | experimental |
| `config.set` | `config.write` | experimental |
| `contract.restrict` | `contracts` | frozen |
| `contract.select` | `contracts` | frozen |
| `contract.status` | `contracts` | frozen |
| `credentials.list` | `credentials` | frozen |
| `credentials.request` | `credentials` | frozen |
| `environment.read` | `exec` | experimental |
| `environment.set` | `exec` | frozen |
| `events.cancel` | `events` | frozen |
| `events.publish` | `events` | frozen |
| `events.schedule` | `events` | frozen |
| `evidence.read` | `store` | frozen |
| `evidence.write` | `store` | frozen |
| `exec.output_page` | `exec` | experimental |
| `exec.run` | `exec`; `fs.write` for `write: true`; `network` for `network: "loopback"`; `unix_sockets` for `unix_sockets`; `os` for `sandbox: "none"` | frozen |
| `http.close` | `http` | experimental |
| `http.open` | `http` | experimental |
| `http.read` | `http` | experimental |
| `http.request` | `http` | frozen |
| `ledger.settle` | `model` | experimental |
| `mcp.connect` | `mcp` | experimental |
| `mcp.disconnect` | `mcp` | experimental |
| `model.complete` | `agents` | frozen |
| `model.fork` | `agents`, `sessions` and `sessions_tools` | experimental |
| `models.context_window` | `model` | experimental |
| `mods.service` | `services` (internal service transport; mods use `api.services.call`) | experimental |
| `packages.apply` | `packages` | frozen |
| `packages.index` | `packages` | frozen |
| `packages.list` | `packages` | frozen |
| `packages.preview` | `packages` | frozen |
| `packages.reload` | `packages` | frozen |
| `peers.list` | `peers` | experimental |
| `peers.send` | `peers` | experimental |
| `power.hold` | `power` | experimental |
| `power.release` | `power` | experimental |
| `process.exchange` | `exec` | frozen |
| `process.start` | `exec`; `network` for `network: "loopback"`; `os` for `sandbox: "none"` | frozen |
| `process.status` | `exec` | frozen |
| `process.stop` | `exec` | frozen |
| `process.which` | `exec` | frozen |
| `prompts.consent` | `composer` | experimental |
| `prompts.revoke` | `composer` | experimental |
| `prompts.status` | `composer` | experimental |
| `prompts.submit` | `composer` | experimental |
| `providers.models` | `model` | frozen |
| `providers.register` | `model` | frozen |
| `providers.unregister` | `model` | frozen |
| `receipts.submit` | `contracts` | frozen |
| `routes.add` | `packages` | frozen |
| `routes.list` | `model` | frozen; experimental fields: `data` |
| `routes.select` | `model` | frozen |
| `routes.write` | `packages` | experimental |
| `session.info` | `inventory` | frozen; experimental fields: `process_id`, `omd_version` |
| `sessions.list` | `sessions` | frozen |
| `sessions.ports` | `sessions` | frozen |
| `sessions.read` | `sessions`; tool arguments and outputs need `sessions_tools` | frozen |
| `sessions.snapshot` | `sessions` and `sessions_tools` | frozen |
| `settings.write` | `commands` for the mod itself; `packages` for another mod | frozen |
| `sidecars.invoke` | `exec` | frozen |
| `sidecars.start` | `exec` | frozen |
| `sidecars.status` | `exec` | frozen; experimental fields: `started_at_ms` |
| `sidecars.stop` | `exec` | experimental |
| `store.delete` | `store` | frozen |
| `store.export` | `store` | experimental |
| `store.get` | `store` | frozen |
| `store.list` | `store` | experimental |
| `store.put` | `store` | frozen |
| `store.reset` | `store` | experimental |
| `task.complete` | `contracts` | frozen |
| `task.status` | `agents` | frozen |
| `terminal.blit` | `terminal` | experimental |
| `terminal.copy` | `terminal` | frozen |
| `terminal.image_sample` | `terminal` | experimental |
| `terminal.import_file` | `terminal` | frozen |
| `terminal.notice` | `terminal` | frozen |
| `terminal.notify` | `terminal` | frozen |
| `terminal.open` | `terminal` | frozen |
| `terminal.pane` | `terminal` | frozen |
| `terminal.panel` | `terminal` | frozen; experimental fields: `group`, `keywords`, `detail`, `query`, `selected`, `close_args` |
| `terminal.panes` | `terminal` | experimental |
| `terminal.prompt` | `terminal` | frozen |
| `terminal.pty` | `pty` (a writable pane also needs `fs.write`; `network: "loopback"` also needs `network`); `os` for `sandbox: "none"` | frozen |
| `terminal.selection` | `terminal` | frozen |
| `terminal.show_thread` | `terminal` | frozen |
| `time.sleep` | `events` | experimental |
| `tools.check` | `interception` | frozen |
| `tools.define` | `tools` | frozen |
| `tools.invoke` | `interception` | experimental |
| `tools.list` | `inventory` | experimental |
| `tools.original` | `interception` | experimental |
| `tools.undefine` | `tools` | experimental |
| `turns.abort` | `threads` | frozen |
| `turns.activity` | `sessions` | frozen |
| `turns.dequeue` | `autonomous` | experimental |
| `turns.queue` | `autonomous` | experimental |
| `turns.queued` | `autonomous` | experimental |
| `workspace.backup` | `fs.write` | frozen |
| `workspace.check_access` | `fs.read` (read-only); `fs.write` (write mode) | experimental |
| `workspace.fingerprint` | `fs.read` | frozen |
| `workspace.integrate` | `agents` | frozen |
| `workspace.list` | `fs.read`; `fs.external` for `root` | frozen |
| `workspace.read` | `fs.read`; `fs.external` for `root` | frozen |
| `workspace.request_rename` | `fs.write` | frozen |
| `workspace.restore` | `fs.write` | frozen |
| `workspace.snapshot` | `fs.read` | frozen |
| `workspace.stat` | `fs.read`; `fs.external` for `root` | frozen |
| `workspace.transaction` | `fs.write`; `fs.external` for `root` | frozen |
| `workspace.unwatch` | `fs.read` | experimental |
| `workspace.watch` | `fs.read` | frozen; experimental fields: `key`, `git` |
