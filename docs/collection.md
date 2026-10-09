# Mods included with OMD+

OMD+ installs the mods below. Some are on from the start. The rest are installed but do nothing until you turn
them on.

To turn a mod on or off, type `/mods` in `codex`, or run:

```sh
omd-package mod enable omd_usage
omd-package mod disable omd_usage
```

Changes apply at your next message. No restart needed.

## On by default

| Mod | What it does |
| --- | --- |
| `omd_mods` | The `/mods` screen and a short welcome card |
| `omd_update` | Update notices and the `/update` screen |
| `omd_logo` | The OMD mark in the session header |
| `omd_inspector` | `/inspect`: the session's mode, profile and active mods |
| `omd_model_picker` | A compact `/model` and reasoning-effort picker |
| `omd_tool_lines` | One short line per tool call; open it for the full output |
| `omd_plan_removal` | Removes `/plan` and plan mode |

OMD Core includes only the first three.

## Off by default

| Mod | What it does | What it needs |
| --- | --- | --- |
| `omd_preview` | Previews HTML and files, draws Mermaid diagrams | |
| `omd_frecency` | Ranks `@` file mentions by fuzzy match and how often you use them | |
| `omd_privacy` | Hides secrets and chosen personal data from what's sent to the model; `/privacy` | |
| `omd_usage` | A usage display: context, cache, cost and quota (Alt+a) | |
| `omd_lsp_sync` | Shows the errors each edit introduces; go to definition, references, rename | A language server on your `PATH`, such as `pyright-langserver`, `typescript-language-server` or `rust-analyzer` |
| `omd_lsp_view` | Hover, symbols, code actions and formatting in `/lsp` | `omd_lsp_sync` turned on |
| `omd_claude_cli` | Claude models in `codex`, using your Claude subscription | Claude CLI `2.1.285`, signed in to Pro or Max. Set up below. |
| `omd_profiles` | Switch between ChatGPT accounts, API keys and compatible providers | A profile. Set up below. |
| `omd_workflow` | Workflow checkpoints and completion checks | A contract: `omd-package contract select ID@VERSION` |
| `omd_advisor` | A second model reviews plans and claimed completion | Its own model allowance; see its README |

Each mod's README in [`mods/first-party`](../mods/first-party) explains its settings and limits.

## Use Claude or another provider

To use Claude through the Claude CLI:

```sh
omd-package claude --setup
omd-package claude --model sonnet
```

The first command checks the Claude CLI and turns on `omd_claude_cli`. The second starts a session on Claude.

To add an API key or another provider:

```sh
omd-package profiles --setup --add NAME --credential NAME --protocol responses --url URL --upstream-model MODEL
omd-package profiles --model NAME
```

Replace the capitalized values with your provider's details. See the
[`omd_profiles` README](../mods/first-party/omd_profiles/README.md).

## Plugins

OMD+ also includes three Codex plugins: anchored edit, artifact reading and code execution. They aren't added to
Codex until you add them; see [plugins/README.md](../plugins/README.md).

## Not in this release

These come back in later updates:

- First update after `1.0.0`: source knowledge, mini, plan panel, cursor, programmable context, continue, and an
  account switcher and usage meter for `omd_profiles`.
- Later: the other first-party mods and plugins, the browser and the bridge.

OMD has no desktop app, VS Code extension, Linux build or hosted service.
