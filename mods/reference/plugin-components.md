# Plugin components and shell commands

Use it when a plugin carries a mod component or when you dispatch a mod's exported CLI alias with `omd COMMAND`.
To bundle a mod in a plugin step by step, see [Bundle a mod in a plugin](https://github.com/dzkchen/oh-my-diff/blob/main/docs/mod-authors/bundle-in-a-plugin.md).

## Plugin component descriptor

A plugin can contain `.codex-plugin/omd.json` with:

```json
{"schema":1,"component":"component","sha256":"<inspected package digest>"}
```

The contained directory is an ordinary public-API package with `mod.json` and `index.ts`.

- Inspect it with `omd-mod plugin-component PLUGIN_ROOT`; the inspector rejects traversal, symlinks and digest
  changes.
- Trust and enable the inspected component through the existing mod-store workflow ([Packaging](packaging.md)). The
  descriptor does not activate it.

## `omd COMMAND` shell dispatch

`omd COMMAND --repo PATH [--store STORE] [--home CODEX_HOME] [--sqlite-home DIR]` dispatches an exported CLI alias. It
offers `evidence.*` and `sessions.*` only; model and process operations are unavailable. The mod store must be
protected from agent process writes. Ambiguous command ownership fails closed.
