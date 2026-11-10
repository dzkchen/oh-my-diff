# Plugin components and shell commands

Use it when a plugin contains a mod component or when you run a mod's exported shell command with `omd COMMAND`.
To bundle a mod in a plugin step by step, see
[Bundle a mod in a plugin](https://github.com/dzkchen/oh-my-diff/blob/main/docs/mod-authors/bundle-in-a-plugin.md).

Mod API `1.0.0`: the descriptor and `omd COMMAND` are experimental (see
[Stability and migration](stability-and-migration.md#experimental-features-without-a-registry-entry)). Platform:
Apple Silicon macOS.

## Plugin component descriptor

A plugin names its [mod component](glossary.md#mods-and-the-host) in `.codex-plugin/omd.json`:

```json
{"schema":1,"component":"mod","sha256":"<inspected package digest>"}
```

`component` names the component's folder in the plugin, and `sha256` is the package digest that
`omd-mod plugin-component` reports for it. The folder is an ordinary public-API package with `mod.json` and
`index.ts`.

- Inspect it with `omd-mod plugin-component PLUGIN_ROOT`; the inspector rejects traversal, symlinks and digest
  changes.
- Trust and enable the inspected component the same way as any other package ([Packaging](packaging.md)). The
  descriptor does not activate it.

## Installing from `/mods`

Experimental (`plugin_components_v1`). `plugins.components` (capability `packages`, user contexts only) lists the
mod components of the Codex plugins installed for this user:

```text
plugins.components → {components: [{plugin, marketplace, version, id, description, sha256, error, installed, enabled}]}
```

- It reads `CODEX_HOME/config.toml` `[plugins."PLUGIN@MARKETPLACE"]` entries and each plugin's active version under
  `CODEX_HOME/plugins/cache/MARKETPLACE/PLUGIN/VERSION`, the way Codex picks it, and lists the plugins that have
  `.codex-plugin/omd.json`.
- `sha256` is the verified descriptor digest. `error` says why the component can't be installed (for example
  `plugin_component_hash_mismatch`), and then `id`, `description` and `sha256` are `null`.
- `installed` and `enabled` say whether a mod with the component's id is installed and turned on in the store.

The `plugin` package source `{kind: 'plugin', plugin, marketplace?}` installs that component through
`packages.preview` and `packages.apply` like a `local` source, after the same checks as `omd-mod plugin-component`.
`marketplace` is needed only when two installed marketplaces have the plugin. Add `enable: true` to turn it on under
the same confirmation:

```ts
api.host.tryCall('packages.apply', { action: 'install', source: { kind: 'plugin', plugin: 'omd-anchored-edit' }, enable: true, expected_generation: generation });
```

## `omd COMMAND` shell dispatch

`omd COMMAND --repo PATH [--store STORE] [--home CODEX_HOME] [--sqlite-home DIR]` runs the command a mod exports with
the `cli` option of [`api.command`](sdk-helpers.md#other-api-members). That command can call only `evidence.*` and
`sessions.*`. Model and process operations aren't available. Protect the mod store from writes by agent processes.
When more than one mod exports `COMMAND`, `omd` refuses to run it (`plugin_command_collision`). When no enabled mod
exports it, or `--repo` is missing, `omd` fails with `unknown command: COMMAND`.
