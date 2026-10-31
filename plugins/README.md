# Plugins

OMD+ comes with four Codex plugins that let Codex read cited sources, run code cells, edit by line anchor and keep
large output out of the context. OMD+ puts them on disk but doesn't install them, so you pick which to add. This
page shows how to add, use and remove them and how to turn on a plugin's mod component. OMD Core includes none.

| Plugin | What it does |
| --- | --- |
| [`omd-artifact-reading`](bundled/oh-my-diff/plugins/omd-artifact-reading/README.md) | Reads URLs, GitHub issues and pull requests, PDFs and Jupyter notebooks, and cites the source |
| [`omd-code-execution`](bundled/oh-my-diff/plugins/omd-code-execution/README.md) | Guides the model to run JavaScript cells with session storage, and persistent Python and Bun cells, in Codex code mode |
| [`omd-anchored-edit`](bundled/oh-my-diff/plugins/omd-anchored-edit/README.md) | Edits files by `LINE#HASH` line anchors |
| [`omd-output-budget`](bundled/oh-my-diff/plugins/omd-output-budget/README.md) | Keeps large shell and tool results out of the context, with paged reads, search and doc fetch |

## Add a plugin

1. Register the plugin marketplace with Codex. `omd-package` manages your install profile and the mods it came with.
   Run this once per OMD install:

   ```sh
   omd-package plugins
   ```

2. Add the plugins you want:

   ```sh
   codex plugin add omd-artifact-reading@oh-my-diff
   codex plugin add omd-code-execution@oh-my-diff
   codex plugin add omd-anchored-edit@oh-my-diff
   codex plugin add omd-output-budget@oh-my-diff
   ```

3. If the plugin has a mod component, [turn on the component](#turn-on-a-component).

## Turn on a component

`omd-artifact-reading`, `omd-anchored-edit` and `omd-output-budget` contain a `mod/` folder. That folder is a mod
component: an ordinary mod that the plugin contains. Adding the plugin doesn't run it. You inspect it, trust it with
the capabilities it asks for, and turn it on in your mod store, like any other mod you trust. Each plugin's README
lists its component's capabilities.

These steps use `jq` and `omd-mod`, the low-level tool that works on a mod store directly. Set `PLUGIN` to the
plugin's name and `CAPABILITIES` to the list from its README. The store is `~/.local/share/oh-my-diff/stores/full`
for OMD+. The script finds `ROOT`, the installed version's folder, from `codex plugin list`. Run the block once for
each plugin, with its own `PLUGIN` and `CAPABILITIES`.

```sh
PLUGIN=omd-anchored-edit
CAPABILITIES=tools,fs.read,fs.write,exec
STORE=~/.local/share/oh-my-diff/stores/full
VERSION=$(codex plugin list --json --marketplace oh-my-diff | jq -r --arg id "$PLUGIN@oh-my-diff" '.installed[] | select(.pluginId == $id) | .version')
ROOT="${CODEX_HOME:-$HOME/.codex}/plugins/cache/oh-my-diff/$PLUGIN/$VERSION"
COMPONENT=$(omd-mod plugin-component "$ROOT" | jq -r .component)
SHA256=$(omd-mod inspect "$COMPONENT" | jq -r .sha256)
omd-mod trust "$STORE" "$COMPONENT" "$SHA256" "$CAPABILITIES"
omd-mod enable "$STORE" "$COMPONENT"
```

`plugin-component` checks the folder against the digest (a SHA-256 hash of the component's package) that the
plugin declares and prints the component's path. `trust` takes the digest that `inspect` prints, so a changed
component must be trusted again. The component runs from your next message.

A component you trust can do what its capabilities allow. See
[Trust and permissions](../docs/trust-and-permissions.md) before you grant them.

## Use a plugin

To use a plugin, name one of its skills in your prompt as `$PLUGIN:SKILL`, for example:

```text
$omd-artifact-reading:omd-artifact-reading
```

Some plugins need more setup. Code execution needs code mode turned on, and its Python and Bun cells need kernel
entries in your Codex config. See [`omd-code-execution`](bundled/oh-my-diff/plugins/omd-code-execution/README.md).

## Remove a plugin

1. If you turned on the plugin's component, turn it off first. Removing the plugin doesn't turn off a component you
   trusted. These commands find the component the same way as [Turn on a component](#turn-on-a-component):

   ```sh
   PLUGIN=omd-anchored-edit
   STORE=~/.local/share/oh-my-diff/stores/full
   VERSION=$(codex plugin list --json --marketplace oh-my-diff | jq -r --arg id "$PLUGIN@oh-my-diff" '.installed[] | select(.pluginId == $id) | .version')
   COMPONENT=$(omd-mod plugin-component "${CODEX_HOME:-$HOME/.codex}/plugins/cache/oh-my-diff/$PLUGIN/$VERSION" | jq -r .component)
   omd-mod disable "$STORE" "$COMPONENT"
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
