# Claude CLI route

`omd_claude_cli` lets an OMD+ session use Claude models through the official Claude CLI and your logged-in Pro or Max `claude.ai` subscription. It is installed inactive in OMD+ and can be installed explicitly in OMD Core.

```sh
omd-package claude --setup            # checks the CLI and login, writes the catalog and store grant, enables the mod
omd-package claude                    # interactive session on the default model (Opus)
omd-package claude --model sonnet     # family shortcut or exact slug
omd-package claude --model haiku exec 'Your task'
```

Setup requires official Claude CLI `2.1.285`, refuses inherited API-key and cloud overrides, and has no API-key fallback. It reads the model catalog from the installed CLI (Fable, Opus, Sonnet and Haiku as your plan offers them) and measures each model's served context window by running the CLI against a local stand-in for the Messages API, so discovery makes no account request. `/status` therefore shows the right context window from the first request; the transport rechecks the window the CLI reports on every response and asks you to rerun setup if it changes. Setup adds a `claude_cli` service grant, a local token and a 16 MiB request ceiling to the store's `host.json`, raises the service lifetime to a day, and makes the managed `codex` launcher define the provider. Other host settings are kept. Concurrent sessions share the store's loopback port; a later session takes the port over when the first one ends.

What crosses the route:

- Codex tools are presented to the CLI through an inert MCP inventory; only the OMD host executes them. Each model call admits exactly one upstream request, with no session persistence and no Agent SDK.
- Codex tool search is offered too, so a Claude lead can load and call the deferred tools that OMD+ mods register.
- Images in prompts and tool output are forwarded. Thinking streams as reasoning summaries. Effort maps up to the CLI's highest level (`max`). The CLI drops replayed thinking from its history input, so earlier reasoning is not sent back.
- The subscription's 5-hour and 7-day windows appear as `/status` limits. A rejected request names the limit and its reset time; a prompt over the window reports `context_length_exceeded`.
- Each request starts a fresh CLI process. Offline measurement put the spawn and history replay at 0.2–0.4 s per request; live requests still hit the prompt cache. A warm session was not adopted because it would save little and weaken per-request admission.

Set `ask_claude: true` to give other leads an `ask_claude` tool. It runs Claude as an OMD child agent on the same route: read-only by default with read and search tools only, or `mode: "write"` in an isolated worktree that is integrated only within your own write permissions. `isolated: true` starts without the conversation; otherwise the frozen parent history is shared. The host refuses delegated requests that declare hosted web search, so write mode needs `web_search = "disabled"` in the session. Claude leads do not see the tool.

Subscription usage is account-metered; the route reports no charge. Usage carries the served model, cache reads and writes, the cache TTL and the CLI's own list-price figure (`total_cost_usd`) as a list-equivalent estimate (`omd_reported_cost`), not a bill. Disable the mod, or rerun setup after upgrading the CLI.

## Credits

Ports the usability of [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) 0.9.0 by Eli Dickinson (MIT): the CLI model catalog with family shortcuts, measured context windows, streamed thinking, effort levels, named rate limits and the AskClaude delegation tool. Reimplemented over the OMD mod API; see [THIRD_PARTY_NOTICES.md](../../../THIRD_PARTY_NOTICES.md).
