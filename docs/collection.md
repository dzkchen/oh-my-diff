# Included mods

Every first-party mod and port, which install profile installs it, and whether it starts on. To turn a mod on or
off, see [Manage mods](manage-mods.md).

The status words on this page:

- On by default: the install profile installs the mod and turns it on.
- Off by default: the install profile installs the mod, and you turn it on.
- Experimental: no install profile installs the mod, and it may change or go away.
- Port: a mod adapted from a Claude Code mod. You install it from the curated directory.

## On by default

| Mod | Install profiles | What it does |
| --- | --- | --- |
| [`omd_mods`](../mods/first-party/omd_mods/README.md) | OMD Core, OMD+ | The `/mods` screen and a short welcome card |
| [`omd_update`](../mods/first-party/omd_update/README.md) | OMD Core, OMD+ | Update notices and the `/update` screen |
| [`omd_logo`](../mods/first-party/omd_logo/README.md) | OMD Core, OMD+ | The OMD logo in the session header |
| [`omd_inspector`](../mods/first-party/omd_inspector/README.md) | OMD+ | `/inspect`: the session's mode, profile and active mods |
| [`omd_model_picker`](../mods/first-party/omd_model_picker/README.md) | OMD+ | A compact `/model` and reasoning-effort picker |
| [`omd_tool_lines`](../mods/first-party/omd_tool_lines/README.md) | OMD+ | One short line per tool call; open it for the full output |
| [`omd_plan_removal`](../mods/first-party/omd_plan_removal/README.md) | OMD+ | Removes `/plan` and plan mode |
| [`omd_plan_panel`](../mods/first-party/omd_plan_panel/README.md) | OMD+ | Pins Codex's current plan above the prompt |
| [`omd_statusline`](../mods/first-party/omd_statusline/README.md) | OMD+ | A configurable status line; `/statusline` edits it |
| [`omd_idle_compact`](../mods/first-party/omd_idle_compact/README.md) | OMD+ | Replaces a large idle conversation with a shorter summary just before the provider's prompt cache expires |
| [`omd_auto_continue`](../mods/first-party/omd_auto_continue/README.md) | OMD+ | When an approval or a question gets no answer within the wait you set (two minutes by default), declines the approval or answers the question so the turn continues |

## Off by default

All of these come with OMD+ only. [Support](support.md#versions) lists the Node versions.

| Mod | What it does | What it needs |
| --- | --- | --- |
| [`omd_preview`](../mods/first-party/omd_preview/README.md) | Previews HTML and files, draws Mermaid diagrams | Node on your `PATH` |
| [`omd_frecency`](../mods/first-party/omd_frecency/README.md) | Ranks `@` file mentions by fuzzy match and how often you use them | |
| [`omd_privacy`](../mods/first-party/omd_privacy/README.md) | Hides secrets and chosen personal data from what's sent to the model; `/privacy` | |
| [`omd_usage`](../mods/first-party/omd_usage/README.md) | A usage dialog: context, cache, cost and quota by request (Alt+a) | |
| [`omd_continue`](../mods/first-party/omd_continue/README.md) | `/continue [note]` resumes interrupted work in the current session | |
| [`omd_lsp_sync`](../mods/first-party/omd_lsp_sync/README.md) | Tells the agent about the errors each of its edits introduces; also go to definition, references and rename | A language server on your `PATH`, such as `pyright-langserver`, `typescript-language-server` or `rust-analyzer` |
| [`omd_lsp_view`](../mods/first-party/omd_lsp_view/README.md) | Hover, symbols, code actions and formatting in `/lsp` | `omd_lsp_sync` turned on |
| [`omd_claude_cli`](../mods/first-party/omd_claude_cli/README.md) | Claude models in `/model`, using your Claude plan or API credits | Claude CLI 2.1.307 or later and Node; see [use other providers](use-other-providers.md#use-claude) |
| [`omd_profiles`](../mods/first-party/omd_profiles/README.md) | Switch between ChatGPT accounts, API keys and compatible providers | Node; see [use other providers](use-other-providers.md#use-an-api-key-or-another-provider) |
| [`omd_cursor`](../mods/first-party/omd_cursor/README.md) | Cursor models in `/model`, using your Cursor account; `/cursor` | A Cursor account, Node and `pnpm`; see [use other providers](use-other-providers.md#use-cursor) |
| [`omd_workflow`](../mods/first-party/omd_workflow/README.md) | Workflow checkpoints and completion checks | A contract: turn the mod on, then `omd-package contract list` and `omd-package contract select ID@VERSION` |
| [`omd_advisor`](../mods/first-party/omd_advisor/README.md) | A second model reviews plans and claimed completion | Its own model allowance; see its README |
| [`omd_source_knowledge`](../mods/first-party/omd_source_knowledge/README.md) | Keeps file-backed facts, test evidence and approved lessons for later tasks in this repository | |
| [`omd_programmable_context`](../mods/first-party/omd_programmable_context/README.md) | A Python workspace that lasts through the session, where the model loads files, keeps results and hands work to child agents, and a session harness of notes, memories, skills and agent specs it can propose changes to; `/refine` | The `omd-code-execution` plugin's Python kernel |
| [`omd_mini`](../mods/first-party/omd_mini/README.md) | `omd mini`: a minimal session that prints into your terminal's scrollback, with a bare prompt and one status line; `/omd_mini:switch` | A terminal |
| [`omd_tool_absorb`](../mods/first-party/omd_tool_absorb/README.md) | When the model repeats a read in one response, runs it once. In [code mode](../mods/reference/glossary.md#sessions-and-models), also reuses unchanged file reads; `/absorb` | |
| [`omd_subagent_router`](../mods/first-party/omd_subagent_router/README.md) | Runs subagents on the model your prompt names ("use sonnet 5.5 as subagents to research") or per-role settings, including another provider's; `delegate_task` runs background workers | The other provider set up, such as `omd_claude_cli` |
| [`omd_tool_fix`](../mods/first-party/omd_tool_fix/README.md) | Fixes clear-cut malformed tool arguments before they fail and records each fix; `/toolfix` | |
| [`omd_workspace`](../mods/first-party/omd_workspace/README.md) | Arranges the chat with Git changes, a shell, your own terminal panels and other mods' panels: presets such as a tabbed dock or a corner layout, moves, drag, resize and focus keys; `/workspace` | `git` on your `PATH` for the Changes panel |
| [`omd_lazygit`](../mods/first-party/omd_lazygit/README.md) | Runs lazygit in the session, full screen or as a workspace panel; its edits open in your editor or become `@path` mentions; `/lazygit` | `lazygit` on your `PATH`, allowed to run outside the sandbox; uses the experimental terminal pane API |
| [`omd_yazi`](../mods/first-party/omd_yazi/README.md) | Runs the yazi file manager in the session; the files you pick become `@path` mentions; `/yazi` | `yazi` on your `PATH`, allowed to run outside the sandbox; uses the experimental terminal pane API |
| [`omd_git`](../mods/first-party/omd_git/README.md) | A lazygit-style Git panel in the workspace dock: stage files and hunks, branches, commits, stash, push and pull; `/git` | `omd_workspace` turned on and `git` on your `PATH` |
| [`omd_files`](../mods/first-party/omd_files/README.md) | A yazi-style file manager in the workspace dock: Miller columns, tabs, find, frecency jump, previews and file operations; `/files` | `omd_workspace` turned on; `omd_frecency` for the jump list |
| [`omd_theme`](../mods/first-party/omd_theme/README.md) | Living scenes drawn in character tiles behind the whole screen, prompt box and menus; `/theme` picks a scene and prints terminal background steps | |

Each mod's README in [`mods/first-party`](../mods/first-party) lists its settings and limits.

## Experimental

No install profile installs these. Install one with `omd install ID`, then turn it on with `omd mods enable ID`.

On a 43-task benchmark (30 SWE-bench Verified tasks and 13 terminal tasks, two attempts each, gpt-6.1-sol at medium
effort, Codex 0.166 in `codex exec`), OMD+ with `omd_observation_mask`, `omd_verify_stop`, `omd_edit_guard`,
`omd_env_bootstrap` and the `omd-output-budget` component cost 25% less than Codex, used 29% fewer input tokens and
took 8% less time, with the same or a higher pass rate. `omd_plan_anchor` and `omd_plan_removal` were off.

| Mod | What it does | What it needs |
| --- | --- | --- |
| [`omd_awake`](../mods/first-party/omd_awake/README.md) | `/awake` replaces Codex's Prevent sleep while running: keeps the Mac awake while turns or subagents run, also with the lid closed, and lets it sleep once they finish | macOS; lid-closed needs the authority broker (`omd-package broker install`) |
| [`omd_monitor`](../mods/first-party/omd_monitor/README.md) | Monitors a background command, file change or GitHub run or deployment and sends one message when it finishes, fails or times out, so the agent doesn't poll; `/monitor` | GitHub monitors need `gh`, logged in, and `/monitor allow owner/repo` |
| [`omd_observation_mask`](../mods/first-party/omd_observation_mask/README.md) | Hides older large tool outputs from model requests in cache-friendly batches; the model reads one back with a recall tool; `/mask` | Can't be on with `omd_programmable_context` |
| [`omd_verify_stop`](../mods/first-party/omd_verify_stop/README.md) | When the agent stops after editing code without a passing test or check, asks it once to verify, and once more to fix a failed check | The autonomous grant |
| [`omd_edit_guard`](../mods/first-party/omd_edit_guard/README.md) | Syntax-checks each file an edit changes and tells the model at once when the edit broke it (Python, JSON, JavaScript, shell, Ruby, PHP, Go) | The checker on your `PATH` |
| [`omd_env_bootstrap`](../mods/first-party/omd_env_bootstrap/README.md) | Snapshots the workspace once per thread (OS, files, languages, toolchains, test commands, git) and keeps it in the cached prompt prefix | |
| [`omd_plan_anchor`](../mods/first-party/omd_plan_anchor/README.md) | Repeats the open plan steps at the end of a tool result every few calls | Adds `update_plan` to the tool list, which costs a new thread's first prompt-cache hit |

## Ports

No install profile installs these. Install one with `omd install ID`, then turn it on with `omd mods enable ID`. Their
READMEs are in [`mods/ports`](../mods/ports).

| Mod | What it does |
| --- | --- |
| [`burn_meter`](../mods/ports/burn_meter/README.md) | Shows your session spend as a burning fuse above the prompt, with plan-limit bars and threshold toasts |
| [`token_weather`](../mods/ports/token_weather/README.md) | Shows a weather forecast of your context window in one line above the prompt |
| [`blast_radius`](../mods/ports/blast_radius/README.md) | Holds a risky shell command, such as `rm -rf` or `git reset --hard`, until you have seen what it would change |

## Plugins

OMD+ also puts four Codex plugins on disk, and you add the ones you want. The [plugins page](../plugins/README.md)
lists them. OMD Core includes none.

## Not included

OMD has no desktop app, VS Code extension, Linux build or hosted service.
