# Mods included with OMD+

What ships with OMD+, and which mods are on.

- **Installed:** the mod is on disk and listed in `/mods`.
- **Active (on):** the mod is running. OMD+ installs every mod below and turns on only the first group.
- **Beta:** OMD `1.0.0` is labeled beta: not every planned capability is included yet. Mod API surfaces marked
  experimental can change between releases.
- **Unsupported:** Linux, Intel Macs, and mods from other sources. OMD shows their permissions and asks before you
  turn them on; it does not review them.

## Turn a mod on or off

Type `/mods` in `codex`, or run:

```sh
omd-package mod enable omd_usage
omd-package mod disable omd_usage
```

It applies at your next message. `omd mods list` shows the result.

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
| `omd_plan_panel` | Pins Codex's current plan above the prompt |
| `omd_statusline` | A configurable status line; `/statusline` edits it |
| `omd_idle_compact` | Compacts a large idle conversation just before the prompt cache expires |
| `omd_auto_continue` | Safely declines or answers a prompt nobody answers within two minutes, so the turn continues |

OMD Core includes only the first three.

## Off by default

| Mod | What it does | What it needs |
| --- | --- | --- |
| `omd_preview` | Previews HTML and files, draws Mermaid diagrams | |
| `omd_frecency` | Ranks `@` file mentions by fuzzy match and how often you use them | |
| `omd_privacy` | Hides secrets and chosen personal data from what's sent to the model; `/privacy` | |
| `omd_usage` | A usage display: context, cache, cost and quota (Alt+a) | |
| `omd_continue` | `/continue [note]` resumes interrupted work in the current session | |
| `omd_lsp_sync` | Reports the errors each edit introduces to the agent; go to definition, references, rename | A language server on your `PATH`, such as `pyright-langserver`, `typescript-language-server` or `rust-analyzer` |
| `omd_lsp_view` | Hover, symbols, code actions and formatting in `/lsp` | `omd_lsp_sync` turned on |
| `omd_claude_cli` | Claude models in `/model`, using your Claude plan or API credits | Claude CLI `2.1.302`. See [Claude](#claude). |
| `omd_profiles` | Switch between ChatGPT accounts, API keys and compatible providers | A profile. See [An API key or another provider](#an-api-key-or-another-provider). |
| `omd_workflow` | Workflow checkpoints and completion checks | A contract: turn the mod on, then `omd-package contract list` and `omd-package contract select ID@VERSION` |
| `omd_advisor` | A second model reviews plans and claimed completion | Its own model allowance; see its README |

Each mod's README in [`mods/first-party`](../mods/first-party) lists its settings and limits.

## What mods cost

Measured once on one Apple Silicon Mac with the `1.0.0` release candidate and a scripted model, October 2026. Your
numbers will differ.

- Codex alone was ready to type in about 0.5 s and used about 30 MB of memory. OMD+ as installed was ready in about
  0.85 s and used about 430 MB.
- Most of that memory is the Node processes that run mods, about 43 MB each. OMD+ as installed runs nine.
- Turning on `omd_preview`, `omd_usage`, `omd_lsp_view`, `omd_claude_cli`, `omd_profiles` or `omd_advisor` adds one
  such process each. The other off-by-default mods added no measurable memory or startup time.

## Use Claude or another provider

### Claude

In a session, turn on `omd_claude_cli` in `/mods` and approve its trust dialog, then run `/claude login` for your
Claude plan or `/claude login api` for Console API credits. Claude models then appear in `/model`. The
[`omd_claude_cli` README](../mods/first-party/omd_claude_cli/README.md) has the details.

### An API key or another provider

1. In a `codex` session, add the credential with `/profile add api_key NAME` (or `chatgpt`, or `provider`).
2. It prints a setup command like this one. Run it with your provider's details in place of the capitalized values:

   ```sh
   omd-package profiles --setup --add NAME --credential NAME --protocol responses --url URL --upstream-model MODEL
   omd-package profiles --model NAME
   ```

More in the [`omd_profiles` README](../mods/first-party/omd_profiles/README.md).

## Plugins

OMD+ stages three Codex plugins: `omd-anchored-edit`, `omd-artifact-reading` and `omd-code-execution`. They are
installed on disk but inert until you add them with `codex plugin add`; see [plugins/README.md](../plugins/README.md).
OMD Core stages none.

## Not included

Further first-party mods and plugins are planned. After release the creator expects to focus mainly on critical
fixes, so treat plans as intentions, not commitments.

OMD has no desktop app, VS Code extension, Linux build or hosted service.
