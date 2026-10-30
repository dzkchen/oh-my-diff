# Included mods

Every first-party mod and port, which profile installs it, and whether it starts on. To turn a mod on or off, see
[Manage mods](manage-mods.md).

The terms on this page:

- Installed: the mod is on disk and listed in `/mods`.
- On by default: the profile installs the mod and turns it on. Off by default: the profile installs it, and you turn
  it on.
- OMD Core installs only `omd_mods`, `omd_update` and `omd_logo`. OMD+ installs every first-party mod except the two
  experimental ones.
- Experimental: OMD+ doesn't install the mod, and it may change or go away.
- Port: a mod adapted from a Claude Code mod. No profile installs ports; you install them from the curated directory.

First-party mods and ports are listed in the curated directory. Mods from other sources aren't reviewed: OMD shows
their permissions and asks before you turn them on.

## On by default

| Mod | Profiles | What it does |
| --- | --- | --- |
| [`omd_mods`](../mods/first-party/omd_mods/README.md) | OMD Core, OMD+ | The `/mods` screen and a short welcome card |
| [`omd_update`](../mods/first-party/omd_update/README.md) | OMD Core, OMD+ | Update notices and the `/update` screen |
| [`omd_logo`](../mods/first-party/omd_logo/README.md) | OMD Core, OMD+ | The OMD mark in the session header |
| [`omd_inspector`](../mods/first-party/omd_inspector/README.md) | OMD+ | `/inspect`: the session's mode, profile and active mods |
| [`omd_model_picker`](../mods/first-party/omd_model_picker/README.md) | OMD+ | A compact `/model` and reasoning-effort picker |
| [`omd_tool_lines`](../mods/first-party/omd_tool_lines/README.md) | OMD+ | One short line per tool call; open it for the full output |
| [`omd_plan_removal`](../mods/first-party/omd_plan_removal/README.md) | OMD+ | Removes `/plan` and plan mode |
| [`omd_plan_panel`](../mods/first-party/omd_plan_panel/README.md) | OMD+ | Pins Codex's current plan above the prompt |
| [`omd_statusline`](../mods/first-party/omd_statusline/README.md) | OMD+ | A configurable status line; `/statusline` edits it |
| [`omd_idle_compact`](../mods/first-party/omd_idle_compact/README.md) | OMD+ | Compacts a large idle conversation just before the prompt cache expires. The summary loses detail, and a pending approval or question is cancelled |
| [`omd_auto_continue`](../mods/first-party/omd_auto_continue/README.md) | OMD+ | Declines an approval, or answers a question, that nobody answers within the wait you set (two minutes by default), so the turn continues |

## Off by default

All of these come with OMD+ only.

| Mod | What it does | What it needs |
| --- | --- | --- |
| [`omd_preview`](../mods/first-party/omd_preview/README.md) | Previews HTML and files, draws Mermaid diagrams | Node on your `PATH` |
| [`omd_frecency`](../mods/first-party/omd_frecency/README.md) | Ranks `@` file mentions by fuzzy match and how often you use them | |
| [`omd_privacy`](../mods/first-party/omd_privacy/README.md) | Hides secrets and chosen personal data from what's sent to the model; `/privacy` | |
| [`omd_usage`](../mods/first-party/omd_usage/README.md) | A usage dialog: context, cache, cost and quota by request (Alt+a) | |
| [`omd_continue`](../mods/first-party/omd_continue/README.md) | `/continue [note]` resumes interrupted work in the current session | |
| [`omd_lsp_sync`](../mods/first-party/omd_lsp_sync/README.md) | Reports the errors each edit introduces to the agent; go to definition, references, rename | A language server on your `PATH`, such as `pyright-langserver`, `typescript-language-server` or `rust-analyzer` |
| [`omd_lsp_view`](../mods/first-party/omd_lsp_view/README.md) | Hover, symbols, code actions and formatting in `/lsp` | `omd_lsp_sync` turned on |
| [`omd_claude_cli`](../mods/first-party/omd_claude_cli/README.md) | Claude models in `/model`, using your Claude plan or API credits | Claude CLI 2.1.307 or later and Node 22.18 or later. See [use other providers](use-other-providers.md). |
| [`omd_profiles`](../mods/first-party/omd_profiles/README.md) | Switch between ChatGPT accounts, API keys and compatible providers | Node 22.18 or later. See [use other providers](use-other-providers.md). |
| [`omd_cursor`](../mods/first-party/omd_cursor/README.md) | Cursor models in `/model`, using your Cursor account; `/cursor`. Not yet verified on a live account | A Cursor account, Node 22.18 or later and `pnpm`. See [use other providers](use-other-providers.md). |
| [`omd_workflow`](../mods/first-party/omd_workflow/README.md) | Workflow checkpoints and completion checks | A contract: turn the mod on, then `omd-package contract list` and `omd-package contract select ID@VERSION` |
| [`omd_advisor`](../mods/first-party/omd_advisor/README.md) | A second model reviews plans and claimed completion | Its own model allowance; see its README |
| [`omd_source_knowledge`](../mods/first-party/omd_source_knowledge/README.md) | Keeps file-backed facts, test evidence and approved lessons for later tasks in this repository | |
| [`omd_programmable_context`](../mods/first-party/omd_programmable_context/README.md) | Python helpers for kept context, child agents and a session harness; `/refine` | The `omd-code-execution` plugin's Python kernel |
| [`omd_mini`](../mods/first-party/omd_mini/README.md) | `omd mini`: a scrollback-first session with a short prompt and one status segment; `/omd_mini:switch` | A terminal |
| [`omd_tool_absorb`](../mods/first-party/omd_tool_absorb/README.md) | Runs a read the model repeats in one response once, and reuses unchanged file reads in code mode; `/absorb` | |
| [`omd_subagent_router`](../mods/first-party/omd_subagent_router/README.md) | Runs subagents on the model your prompt names ("use sonnet 5.5 as subagents to research") or per-role settings, including another provider's; `delegate_task` runs background workers | The other provider set up, such as `omd_claude_cli` |
| [`omd_tool_fix`](../mods/first-party/omd_tool_fix/README.md) | Fixes clear-cut malformed tool arguments before they fail and records each fix; `/toolfix` | |
| [`omd_workspace`](../mods/first-party/omd_workspace/README.md) | Arranges the chat with Git changes, a shell, your own terminal panels and other mods' panels: presets such as a tabbed dock or a corner layout, moves, drag, resize and focus keys; `/workspace` | `git` on your `PATH` for the Changes panel |
| [`omd_git`](../mods/first-party/omd_git/README.md) | A lazygit-style Git panel in the workspace dock: stage files and hunks, branches, commits, stash, push and pull; `/git` | `omd_workspace` turned on and `git` on your `PATH` |
| [`omd_files`](../mods/first-party/omd_files/README.md) | A yazi-style file manager in the workspace dock: Miller columns, tabs, find, frecency jump, previews and file operations; `/files` | `omd_workspace` turned on; `omd_frecency` for the jump list |
| [`omd_theme`](../mods/first-party/omd_theme/README.md) | Living scenes drawn in character tiles behind the whole screen, prompt box and menus; `/theme` picks a scene and prints terminal background steps | |

Each mod's README in [`mods/first-party`](../mods/first-party) lists its settings and limits.

## Experimental

No profile installs these. Install one with `omd install ID`, then turn it on with `omd mods enable ID`.

| Mod | What it does | What it needs |
| --- | --- | --- |
| [`omd_awake`](../mods/first-party/omd_awake/README.md) | `/awake` replaces Codex's Prevent sleep while running: keeps the Mac awake while turns or subagents run, also with the lid closed, and lets it sleep once they finish | macOS; lid-closed needs the authority broker (`omd-package broker install`) |
| [`omd_monitor`](../mods/first-party/omd_monitor/README.md) | Monitors a background command, file change or GitHub run or deployment and sends one message when it finishes, fails or times out, so the agent doesn't poll; `/monitor` | GitHub monitors need `gh`, logged in, and `/monitor allow owner/repo` |

## Ports

No profile installs these. Install one with `omd install ID`, then turn it on with `omd mods enable ID`. Their
READMEs are in [`mods/ports`](../mods/ports).

| Mod | What it does |
| --- | --- |
| [`burn_meter`](../mods/ports/burn_meter/README.md) | Shows your session spend as a burning fuse above the prompt, with plan-limit bars and threshold toasts |
| [`token_weather`](../mods/ports/token_weather/README.md) | Shows a weather forecast of your context window in one line above the prompt |
| [`blast_radius`](../mods/ports/blast_radius/README.md) | Holds a risky shell command, such as `rm -rf` or `git reset --hard`, until you have seen what it would change |

## What mods cost

These figures are historical: measured on one Apple M5 Mac with a scripted model and a 1.1.0 pre-release build in
October 2026, before `omd_workspace`, `omd_git`, `omd_files` and `omd_theme` existed. They haven't been re-measured on
Codex `0.165.0`. Memory is the macOS memory footprint (the figure Activity Monitor shows), 10 seconds after start.
Your numbers will differ.

- Codex alone and OMD+ were both ready to type in about 0.3 s.
- Codex alone used about 30 MB. OMD+ as installed used about 100 MB: about 40 MB for the Codex process, plus seven
  `omd-runner` processes of 6–13 MB each that run the mods.
- Turning on `omd_preview`, `omd_profiles`, `omd_usage`, `omd_mini` or `omd_advisor` added one more such process,
  about 8–19 MB. Each of the other off-by-default mods added under 5 MB at idle. Programs a mod starts, such as
  `omd_lsp_sync`'s language servers, use their own memory while they run.

## Plugins

OMD+ stages four Codex plugins: `omd-anchored-edit`, `omd-artifact-reading`, `omd-code-execution` and
`omd-output-budget`. Staged means the files are on disk but Codex doesn't load them until you add them with
`codex plugin add`; see [plugins](../plugins/README.md). OMD Core stages none.

## Not included

OMD has no desktop app, VS Code extension, Linux build or hosted service.
