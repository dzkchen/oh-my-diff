# Plugins

OMD+ comes with one Codex plugin, `omd-anchored-edit`, which edits files by line anchor. OMD+ puts it on disk but
doesn't install it, so you add it yourself. This page shows how to add, use and remove a plugin and how to turn on a
plugin's mod component. OMD Core includes none.

| Plugin | What it does |
| --- | --- |
| [`omd-anchored-edit`](bundled/oh-my-diff/plugins/omd-anchored-edit/README.md) | Edits files by `LINE#HASH` line anchors |

## Experimental plugins

These haven't been tested fully yet, so no install profile stages them. They're in
[`plugins/experimental`](experimental) of the OMD repository. To add one, register that folder from a checkout as a
marketplace with `codex plugin marketplace add PATH/plugins/experimental/oh-my-diff-experimental`, then
`codex plugin add PLUGIN@oh-my-diff-experimental`. In the component and removal commands on this page, use
`oh-my-diff-experimental` in place of the marketplace name `oh-my-diff`.

| Plugin | What it does |
| --- | --- |
| [`omd-artifact-reading`](experimental/oh-my-diff-experimental/plugins/omd-artifact-reading/README.md) | Reads URLs, GitHub issues and pull requests, PDFs and Jupyter notebooks, and cites the source |
| [`omd-code-execution`](experimental/oh-my-diff-experimental/plugins/omd-code-execution/README.md) | Guides the model to run JavaScript cells with session storage, and persistent Python and Bun cells, in Codex code mode |
| [`omd-output-budget`](experimental/oh-my-diff-experimental/plugins/omd-output-budget/README.md) | Keeps large shell and tool results out of the context, with paged reads, search and doc fetch |
| [`omd-monitor`](experimental/oh-my-diff-experimental/plugins/omd-monitor/README.md) | Guides the agent to subscribe to builds, files and CI, continue other work and handle the result |

## Add a plugin

1. Register the plugin marketplace with Codex. `omd-package` manages your install profile and the mods it came with.
   Run this once per OMD install:

   ```sh
   omd-package plugins
   ```

2. Add the plugin:

   ```sh
   codex plugin add omd-anchored-edit@oh-my-diff
   ```

3. If the plugin has a mod component, [turn on the component](#turn-on-a-component).

## Turn on a component

`omd-anchored-edit`, `omd-artifact-reading` and `omd-output-budget` contain a `mod/` folder. That folder is a mod
component: an ordinary mod that the plugin contains. Adding the plugin doesn't run it. You review it, trust it with
the capabilities it asks for, and turn it on in your mod store, like any other mod you install. Each plugin's README
lists its component's capabilities.

In a session, open `/mods`: an added plugin's component is listed there, and turning it on reviews, trusts and
enables it under one confirmation. From a shell, run instead:

```sh
omd-package plugin-mod enable omd-anchored-edit
```

The command finds the added plugin's installed folder, checks its component against the digest (a SHA-256 hash of
the component's package) that the plugin declares, and runs `omd install` and `omd mods enable` on it. Each shows the
component's source, digest and capabilities and asks before it changes anything; nothing is trusted if you answer
no, and it refuses without a terminal. For an experimental plugin, name its marketplace:
`omd-package plugin-mod enable omd-artifact-reading@oh-my-diff-experimental`. A changed component, for example after
a plugin update, must be reviewed again with the same command. The component runs from your next message.

A component you trust can do what its capabilities allow. See
[Trust and permissions](../docs/trust-and-permissions.md) before you grant them.

## Use a plugin

To use a plugin, name one of its skills in your prompt as `$PLUGIN:SKILL`, for example:

```text
$omd-artifact-reading:omd-artifact-reading
```

Some plugins need more setup. Code execution needs code mode turned on, and its Python and Bun cells need kernel
entries in your Codex config. See [`omd-code-execution`](experimental/oh-my-diff-experimental/plugins/omd-code-execution/README.md).

## Remove a plugin

1. If you turned on the plugin's component, turn it off first. Removing the plugin doesn't turn off a component you
   trusted:

   ```sh
   omd-package plugin-mod disable omd-anchored-edit
   ```

2. Remove the plugin:

   ```sh
   codex plugin remove omd-anchored-edit@oh-my-diff
   ```

3. To remove the marketplace once no plugin from it is left:

   ```sh
   codex plugin marketplace remove oh-my-diff
   ```

## Needs and limits

- Plugins come with OMD+ only. OMD Core includes none, and `omd-package plugins` refuses on OMD Core.
- PDF reading needs Ghostscript (`gs`).
- Python and Bun cells need `python3` and `bun`. OMD+ doesn't bundle them.
- Language server mods aren't plugins. See [`omd_lsp_sync`](../mods/first-party/omd_lsp_sync/README.md) and
  [`omd_lsp_view`](../mods/first-party/omd_lsp_view/README.md).

## See also

- [Included mods](../docs/collection.md)
- [Manage mods](../docs/manage-mods.md)
- [Plugin components reference](../mods/reference/plugin-components.md)
