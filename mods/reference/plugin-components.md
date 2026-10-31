# Plugin components and shell commands

Use it when a plugin contains a mod component or when you run a mod's exported shell command with `omd COMMAND`.
To bundle a mod in a plugin step by step, see
[Bundle a mod in a plugin](https://github.com/dzkchen/oh-my-diff/blob/main/docs/mod-authors/bundle-in-a-plugin.md).

The descriptor and `omd COMMAND` run on Apple Silicon macOS.

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

## `omd COMMAND` shell dispatch

`omd COMMAND --repo PATH [--store STORE] [--home CODEX_HOME] [--sqlite-home DIR]` runs the command a mod exports with
the `cli` option of [`api.command`](sdk-helpers.md#other-api-members). That command can call only `evidence.*` and
`sessions.*`. Model and process operations aren't available. Protect the mod store from writes by agent processes.
When more than one mod exports `COMMAND`, `omd` refuses to run it (`plugin_command_collision`).
