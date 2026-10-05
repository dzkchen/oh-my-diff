# omd_workspace

Default-active in OMD+. It owns the terminal layout: a Session status panel
(model and reasoning, context use with attention from 70% and failure from 90%,
and the settled paid API or subscription cost when recorded), an Activity panel
for the current session (turns started, completed, interrupted or failed, tools
run, agents and compactions) and a one-line header with Ready/Working and the
shortcut hints. State is per session thread; model and context come from the
session's own `thread/settings/updated` and `thread/tokenUsage/updated`
notifications (a sub-agent thread never replaces them), with `config/read` at
start and resume.

The sidebar is the composed status sidebar: `omd_git`, `omd_lsp_view` and
`omd_mcp` add their Changes, Language servers and MCP servers panels below the
Session panel, and the opt-in `omd_usage` adds Usage (cache, quota, spend,
paid allowance bar) and Workers (plan progress, sub-agents, running tools). Every panel folds: Tab reaches a panel title and Enter or a click
folds or unfolds it. The host hides the sidebar below 80 columns.

| Key | Action |
| --- | --- |
| F6 | insert the review prompt into the composer |
| F7 | open workspace settings |

`/omd_workspace:layout full|compact|left|right|dialog|close|review TEXT` changes
the sidebar size, side and review prompt; changes are saved as the mod's
settings (`density`, `side`, `review_prompt`). `/omd_workspace:activity` prints
the session's activity.

Capabilities: `terminal` (replaces the terminal view), `commands`, `lifecycle`, `store`, `threads` and `config` (session notifications and `config/read`).
