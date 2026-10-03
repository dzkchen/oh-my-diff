# omd_workspace

Default-active in OMD+. It owns the terminal layout: an Activity sidebar for the
current session (turns started, completed, interrupted or failed, tools run,
agents and compactions), a Ready/Working header and, when a paid API or
subscription cost is recorded, a Session cost line. State is per session thread.

| Key | Action |
| --- | --- |
| F6 | insert the review prompt into the composer |
| F7 | open workspace settings |

`/omd_workspace:layout full|compact|left|right|dialog|close|review TEXT` changes
the sidebar size, side and review prompt; changes are saved as the mod's
settings (`density`, `side`, `review_prompt`). `/omd_workspace:activity` prints
the session's activity.

Capabilities: `terminal` (replaces the terminal view), `commands`, `lifecycle`, `store`.
