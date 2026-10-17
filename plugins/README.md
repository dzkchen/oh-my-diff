# Plugins

The three Codex plugins that come with OMD+. They're staged on disk but not installed; you pick which to add.

| Plugin | What it does |
| --- | --- |
| `omd-artifact-reading` | Reads URLs, GitHub issues and pull requests, PDFs and Jupyter notebooks, and cites the source |
| `omd-code-execution` | Guides persistent JavaScript, Python and Bun cells in code mode |
| `omd-anchored-edit` | Edits files by `LINE#HASH` line anchors |

## Install

Register the plugin marketplace, then add the plugins you want:

```sh
omd-package plugins
codex plugin add omd-artifact-reading@oh-my-diff
codex plugin add omd-code-execution@oh-my-diff
codex plugin add omd-anchored-edit@oh-my-diff
```

`omd-artifact-reading` and `omd-anchored-edit` also have a `mod/` component. Adding the plugin doesn't run it; you
inspect, trust and enable it separately. Each plugin's README shows how.

## Use

Ask Codex to use a plugin by name:

```text
$omd-artifact-reading:omd-artifact-reading
$omd-code-execution:omd-code-execution
```

For code execution, turn on code mode when you start Codex:

```sh
codex -c features.code_mode.enabled=true
```

Python and Bun cells also need kernel entries in your Codex config. See the
[skill](bundled/oh-my-diff/plugins/omd-code-execution/skills/omd-code-execution/SKILL.md).

## Requirements

- PDF reading needs Ghostscript (`gs`).
- Python and Bun cells need `python3` and `bun`. OMD+ doesn't bundle them.

## Remove

```sh
codex plugin remove omd-anchored-edit@oh-my-diff
codex plugin remove omd-artifact-reading@oh-my-diff
codex plugin remove omd-code-execution@oh-my-diff
codex plugin marketplace remove oh-my-diff
```

Removing a plugin doesn't disable a mod component you trusted. Disable that too.

## More

- [Launch collection](../docs/collection.md)
- Language server mods aren't plugins. See [`mods/first-party`](../mods/first-party).
- Changing a plugin: `release-files.json` lists every file that ships. When you add or remove one, update it, then
  run `python3 -m scripts.plugin_lock --write`.
