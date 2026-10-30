# Agent mod guide

For coding agents that build an Oh My Diff (OMD) mod. It gives the rules, the order of work, where to look things up
and the mistakes agents make most. The steps themselves are in the [mod author guides](#guides-to-follow).

Everything here is for mod API `1.0.0`. Only that API version loads, so check `api` in a mod's `mod.json` before you
reuse older code. Platforms and tool versions are in [Support](support.md).

## Rules

- Use only what [`api.d.ts`](../mods/api.d.ts) and the [mod API reference](../mods/reference/README.md) document.
  Anything else isn't supported, including calling another mod directly.
- Never trust, enable or install a mod in the user's real mod store without asking. Work in a scratch store
  (`omd-mod init /tmp/NAME-store`).
- Tests are offline. Don't make paid model calls to test a mod.
- Publishing is public. Ask the user before you publish.
- Pass `--yes` to `omd install` or `omd mods` only after the user has seen and accepted the mod's permissions.
  Some grants, such as `os`, `http` and `approve`, run with the user's own authority; read
  [Authority grants](trust-and-permissions.md#authority-grants) before you declare them.

## Pick a mod, plugin, skill or hook

| The user wants | Build |
| --- | --- |
| A procedure the model follows | A skill (`SKILL.md`) |
| A reaction to an event, such as a finished turn | A Codex hook |
| Tools or services Codex can call | A plugin, optionally with an MCP server |
| To change how `codex` itself behaves or looks: commands, screens, requests, tool calls | A mod |
| Several of these together | A plugin that bundles skills and a mod component ([Bundle a mod in a plugin](mod-authors/bundle-in-a-plugin.md)) |

See [Mods, plugins, skills and hooks](how-omd-works.md#mods-plugins-skills-and-hooks) for how they differ, and
[What mods can't replace or bypass](../mods/reference/host-model.md#what-mods-cant-replace-or-bypass).

## Work in this order

1. Check the tools: `command -v omd-mod-author omd-mod omd`, `node --version` (24.18 or a later 24.x, needed only by
   `omd-mod-author`) and `pnpm --version` (11.14 or later). If `omd-mod-author` is missing, OMD isn't installed; tell the user and link
   [Install](install.md).
2. Create the project with `omd-mod-author create ./ID ID`, then `cd ID` and run `pnpm add -D typescript@5.9.3`. To
   start from a bigger mod, copy an example: `omd-mod-author example ./release_check release_check`, or
   `examples ./examples` for the ones that ship with the tools.
3. In `ID/`, write `index.ts` and list every capability it uses in `mod.json`.
4. In `ID/`, replace `mod.test.json`, delete `debug.test.json` once `/hello` is gone, then run `pnpm check` and
   `pnpm test`. When a step fails, read that step's error, which names the `index.ts` line. `pnpm debug` only replays
   `debug.test.json`.
5. In `ID/`, load it into a scratch store with `pnpm watch STORE --once` and try commands with `omd-mod command`.
6. Ask before installing into the user's store. From the folder that contains `ID/`, run `omd install ./ID` and
   `omd mods enable ID`.

## Guides to follow

| Task | Guide |
| --- | --- |
| A first mod, end to end | [Write your first mod](mod-authors/first-mod.md) |
| Tools, saved state, settings and a terminal line | [Build a notes mod](mod-authors/notes-mod.md) |
| Scratch store, watch, status, reports, cost | [Run and debug a mod](mod-authors/run-and-debug.md) |
| Scenario files, TypeScript tests, mocks | [Test a mod](mod-authors/test-a-mod.md) |
| Install, Git, npm, update, roll back | [Publish a mod](mod-authors/publish-a-mod.md) |
| Ship skills and a mod together | [Bundle a mod in a plugin](mod-authors/bundle-in-a-plugin.md) |
| Change the shape of saved state | [Change a mod's saved state](mod-authors/migrate-state.md) |
| Components in `.tsx` | [Write terminal components in JSX](mod-authors/jsx.md) |
| Repair a mod that breaks `codex` | [Troubleshooting](troubleshooting.md) |

## Where to look things up

Read the topic page, not the whole reference. [`mods/REFERENCE.md`](../mods/REFERENCE.md) is every topic page in one
file.

| To | Read |
| --- | --- |
| Pick capabilities | [Capabilities](../mods/reference/capabilities.md#capabilities) |
| Add commands and settings | [Commands and configuration](../mods/reference/commands-and-composer.md#commands-and-configuration-command_config_middleware_v1), [settings file](../mods/reference/settings.md#settings-file-settings_file_v1), [registration rules](../mods/reference/host-model.md#registration-limits) |
| Add tools | `ToolSpec` and `api.tool` in [`api.d.ts`](../mods/api.d.ts), [registration limits](../mods/reference/host-model.md#registration-limits) |
| Intercept tool calls and other surfaces | [`api.intercept`](../mods/reference/interceptors.md#apiintercept), [continuation middleware](../mods/reference/interceptors.md#continuation-middleware-continuation_middleware_v1-tool_continuation_v2) |
| Observe events | [Lifecycle events](../mods/reference/events-and-lifecycle.md#lifecycle-events-and-classic-hooks-lifecycle_events_v1) |
| Change model requests | [Model requests](../mods/reference/model-requests.md#model-requests-and-streams-model_turn_interception_v1) |
| Keep state | [Durable data](../mods/reference/state-and-storage.md#durable-data-store-and-evidence), [reactive state](../mods/reference/state-and-storage.md#reactive-state-reactive_state_v1) |
| Draw on screen | [Terminal UI](../mods/reference/terminal-ui.md), [render hooks](../mods/reference/render-hooks.md#render-hooks-render_hooks_v1) |
| Route models and run agents | [Routes](../mods/reference/routes.md#routes), [agents](../mods/reference/agents.md#agents), [one-shot model calls](../mods/reference/model-calls.md#one-shot-model-calls-and-forks-model_complete_v2) |
| Read and write files | [Workspace reads and transactions](../mods/reference/workspace-files.md#workspace-reads-transactions-and-write-observation) |
| Run persistent code cells | [Code-mode kernels](../mods/reference/managed-processes.md#code-mode-kernels) |
| Combine with other mods | [Composition order](../mods/reference/host-model.md#composition-order) |
| Stay within limits | [Host limits](../mods/reference/limits.md#host-limits) |
| Write tests | [Offline scenarios](../mods/reference/authoring.md#offline-scenarios), [TypeScript tests](../mods/reference/authoring.md#typescript-tests) |
| Package and publish | [Packaging](../mods/reference/packaging.md), [plugin components](../mods/reference/plugin-components.md) |
| Know what may change | [Stability and migration](../mods/reference/stability-and-migration.md) |

## Traps

- Import only types from `@oh-my-diff/mod-api`, and files declared in `mod.json` `assets` by relative path
  (`./x.ts`, `./x.mjs`, `./x.json`). At most 16 assets, 512 KiB per file, 1 MiB of entrypoint plus assets. Any other
  import fails with `unsupported_import`.
- Don't write `process.` outside a string, or `window.` or `document.` anywhere. Node and browser globals aren't
  there. The host scans the source when it loads the mod (`pnpm test`, `pnpm run run`, activation in `codex`) and
  refuses it with `undeclared_environment_use: process`. `omd mods update` and install don't scan.
- Name host operations literally: `api.host.call('store.get', …)`, not a variable.
- No `Date.now()` in host call arguments; the host replays callbacks.
- Return refusals as values, such as `{ error: '…' }`. Five failed callbacks in a row in one host process turn the
  mod off; any success resets the count
  ([fault limit](../mods/reference/host-model.md#fault-limit)).
- `enum`, namespaces with values and constructor parameter properties fail with
  `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Only erasable TypeScript loads.
- A `settings_schema` property may have only `type` (`boolean`, `number`, `string`, `array`, `object` or `null`),
  `enum`, `default`, `title`, `description` and `choices: "routes"`, which only a `string` property without `enum`
  may have. `integer`, `minimum` and similar keys are refused.
- `activate` registering the same command, handler, timer or component name twice fails with `conflict: NAME`.
- The scaffold's `debug.test.json` calls `/hello`. Delete it once you replace that command, or `pnpm debug` fails.
- `expect` in `mod.test.json` is deep equality of the whole value. Test interceptors in a `*.test.ts` file, because
  their results include source line numbers.
- Against a store, `omd-mod test` uses the store's settings and saved state, not the scenario's `settings`. Set them
  first with `omd-mod settings STORE "$PWD" JSON`.
- A mod with `state_scope: "thread"` needs a thread ID as the last argument of `omd-mod command` and `omd-mod test`,
  or the call fails with `state_thread_unavailable`.
- `pnpm watch` trusts whatever it watches. Point it only at a scratch store.
- Use a different scratch store to rehearse `omd install --store STORE`, because `watch` already turned the mod on
  in the first one.
- In a non-interactive shell, `omd install` and `omd mods enable`, `update`, `remove` and `rollback` stop with
  `package_approval_required`. Show the user the permissions in `mod.json` and pass `--yes` only after they agree.
  `omd mods disable` doesn't ask for approval, so it's safe without a terminal.
- `omd install --scope project` fails with `package_scope_conflict` if the same mod is installed for the user.
- A folder install stops after any edit, with `untrusted_source`, until `omd mods update ID`.
- A changed `state_version` keeps the mod off with `state_migration_required` until its `migrate` handler runs.
- The model finds mod tools through tool search, named `mod_<id>_<tool>`.
- A denial you don't understand: run `omd-mod-author explain 'DENIAL TEXT'`.

## Work from a source checkout

To run the author tools from a source checkout instead of an install, follow
[Run the author tools from a source checkout](mod-authors/run-and-debug.md#run-the-author-tools-from-a-source-checkout).
