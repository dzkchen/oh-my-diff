# Mods included with OMD+

What ships with OMD+, and which mods are on.

- **Installed:** the mod is on disk and listed in `/mods`.
- **Active (on):** the mod is running. OMD+ installs every mod below and turns on only the first group.
- **Experimental:** mod API surfaces marked experimental can change between releases. There may be missing API capabilities, just open an issue for it to be added!
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
| `omd_preview` | Previews HTML and files, draws Mermaid diagrams | Node on your `PATH` |
| `omd_frecency` | Ranks `@` file mentions by fuzzy match and how often you use them | |
| `omd_privacy` | Hides secrets and chosen personal data from what's sent to the model; `/privacy` | |
| `omd_usage` | A usage dialog: context, cache, cost and quota by request (Alt+a) | |
| `omd_continue` | `/continue [note]` resumes interrupted work in the current session | |
| `omd_lsp_sync` | Reports the errors each edit introduces to the agent; go to definition, references, rename | A language server on your `PATH`, such as `pyright-langserver`, `typescript-language-server` or `rust-analyzer` |
| `omd_lsp_view` | Hover, symbols, code actions and formatting in `/lsp` | `omd_lsp_sync` turned on |
| `omd_claude_cli` | Claude models in `/model`, using your Claude plan or API credits | Claude CLI 2.1.307 or newer and Node 22.18+. See [Claude](#claude). |
| `omd_profiles` | Switch between ChatGPT accounts, API keys and compatible providers | Node 22.18+ and a profile. See [An API key or another provider](#an-api-key-or-another-provider). |
| `omd_workflow` | Workflow checkpoints and completion checks | A contract: turn the mod on, then `omd-package contract list` and `omd-package contract select ID@VERSION` |
| `omd_advisor` | A second model reviews plans and claimed completion | Its own model allowance; see its README |
| `omd_source_knowledge` | Keeps file-backed facts, test evidence and approved lessons for later tasks in this repository | |
| `omd_programmable_context` | Python helpers for kept context, child agents and a session harness; `/refine` | The `omd-code-execution` plugin's Python kernel |
| `omd_mini` | `omd mini`: a scrollback-first session with a short prompt and one status segment; `/omd_mini:switch` | A terminal |
| `omd_cursor` | Cursor models in `/model`, using your Cursor account; `/cursor` | A Cursor account, Node 22.18+ and `pnpm`; not yet verified on a live account |
| `omd_tool_absorb` | Runs a read the model repeats in one response once, and reuses unchanged file reads in code mode; `/absorb` | |
| `omd_subagent_router` | Runs subagents on the model your prompt names ("use sonnet 5.5 as subagents to research") or per-role settings, including another provider's | The other provider set up, such as `omd_claude_cli` |
| `omd_tool_fix` | Fixes clear-cut malformed tool arguments before they fail and records each fix; `/toolfix` | |

Each mod's README in [`mods/first-party`](../mods/first-party) lists its settings and limits.

## What mods cost

Measured on one Apple M5 Mac with a scripted model and a 1.1.0 pre-release build, October 2026. Memory is the macOS
memory footprint (the figure Activity Monitor shows), 10 seconds after start. Your numbers will differ.

- Codex alone and OMD+ were both ready to type in about 0.3 s.
- Codex alone used about 30 MB. OMD+ as installed used about 100 MB: about 40 MB for the Codex process, plus seven
  `omd-runner` processes of 6–13 MB each that run the mods.
- Turning on `omd_preview`, `omd_profiles`, `omd_usage`, `omd_mini` or `omd_advisor` adds one more such process,
  about 8–19 MB. Each of the other off-by-default mods added under 5 MB at idle. Programs a mod starts, such as
  `omd_lsp_sync`'s language servers, use their own memory while they run.

## Use Claude or another provider

### Claude

In a session, turn on `omd_claude_cli` in `/mods` and approve its trust dialog, then run `/claude login` for your
Claude plan or `/claude login api` for Console API credits; `/claude login NAME` adds another account. Claude models
then appear in `/model`, and with `omd_profiles` on, `/profile` and Alt+s switch between accounts. The
[`omd_claude_cli` README](../mods/first-party/omd_claude_cli/README.md) has the details.

### An API key or another provider

Turn on `omd_profiles` in `/mods`, then run `/profile add` and pick a ChatGPT, Claude or Cursor account, an OpenAI or
Anthropic API key, or another provider by URL. Sign-in and key entry happen in the session.

More in the [`omd_profiles` README](../mods/first-party/omd_profiles/README.md).

## Plugins

OMD+ stages three Codex plugins: `omd-anchored-edit`, `omd-artifact-reading` and `omd-code-execution`. They are
installed on disk but inert until you add them with `codex plugin add`; see [plugins/README.md](../plugins/README.md).
OMD Core stages none.

## Not included

Further first-party mods and plugins are planned; treat plans as intentions, not commitments.

OMD has no desktop app, VS Code extension, Linux build or hosted service.
