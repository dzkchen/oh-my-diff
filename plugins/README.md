# Plugins

The Codex plugins that come with OMD+. They're staged on disk but not installed; you pick which to add.

| Plugin | What it does |
| --- | --- |
| `omd-artifact-reading` | Reads URLs, GitHub issues and pull requests, PDFs and Jupyter notebooks, and cites the source |
| `omd-code-execution` | Guides JavaScript cells with session storage and persistent Python and Bun cells in code mode |
| `omd-anchored-edit` | Edits files by `LINE#HASH` line anchors |
| `omd-output-budget` | Keeps large shell and tool results out of the context, with paged reads, search and doc fetch |

## Install

Register the plugin marketplace, then add the plugins you want:

```sh
omd-package plugins
codex plugin add omd-artifact-reading@oh-my-diff
codex plugin add omd-code-execution@oh-my-diff
codex plugin add omd-anchored-edit@oh-my-diff
codex plugin add omd-output-budget@oh-my-diff
```

`omd-artifact-reading`, `omd-anchored-edit` and `omd-output-budget` also have a `mod/` component. Adding the plugin doesn't run it; you
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
codex plugin remove omd-output-budget@oh-my-diff
codex plugin marketplace remove oh-my-diff
```

Removing a plugin doesn't disable a mod component you trusted. Disable that too.

## More

- [Included mods](../docs/collection.md)
- Language server mods aren't plugins. See [`mods/first-party`](../mods/first-party).
