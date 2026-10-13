# Claude CLI route

`omd_claude_cli` lets an OMD+ session use Claude models through the official Claude CLI and your logged-in `claude.ai` plan (Pro, Max, Team or Enterprise), or, as a separately chosen route, your Anthropic Console login. It is installed inactive in OMD+ and can be installed explicitly in OMD Core.

```sh
omd-package claude --setup                  # checks the CLI and login, writes the catalog and store grant, enables the mod
omd-package claude --setup --billing api    # the same route billed to Anthropic Console API credits
omd-package claude                          # interactive session on the default model (Opus)
omd-package claude --model sonnet           # family shortcut or exact slug
omd-package claude --model haiku exec 'Your task'
```

Setup requires official Claude CLI `2.1.296`. The CLI never sees inherited `ANTHROPIC_*` variables or Claude CLI credential and cloud-provider overrides; OMD removes them from its environment. Setup reads `claude auth status`: the default route needs a `claude.ai` login with a Pro, Max, Team or Enterprise plan (`claude auth login`); `--billing api` needs the CLI's Console login (`claude auth login --console`). Rerunning setup without `--billing` keeps the route's current billing source. Every request is checked against the chosen billing source before it leaves the machine, so OMD never falls back from plan limits to API credits or back. Setup reads the model catalog from the installed CLI (Fable, Opus, Sonnet and Haiku as your plan offers them) and measures each model's served context window by running the CLI against a local stand-in for the Messages API, so discovery makes no account request. `/status` therefore shows the right context window from the first request; the transport rechecks the window the CLI reports on every response and asks you to rerun setup if it changes. Setup adds a `claude_cli` service grant, a local token and a 16 MiB request ceiling to the store's `host.json`, raises the service lifetime to a day, and makes the managed `codex` launcher define the provider. Other host settings are kept. Concurrent sessions share the store's loopback port; a later session takes the port over when the first one ends.

Anthropic's June 2026 change kept plan usage available to the CLI's print mode; the October 2026 monthly API credits for Max and Team belong to a linked Console organization and are separate from plan limits. The default route spends plan limits only; Console credits are reached only through `--billing api`.

What crosses the route:

- Codex tools are presented to the CLI through an inert MCP inventory; only the OMD host executes them. Each model call admits exactly one upstream request, with no session persistence and no Agent SDK. A request for any model other than the selected one is refused before it is sent, and a response served by another model fails the turn.
- Codex tool search is offered too, so a Claude lead can load and call the deferred tools that OMD+ mods register.
- Valid tool names such as `constructor` and `__proto__` retain their identity in request and response translation.
- Images in prompts and tool output are forwarded. Thinking streams as reasoning summaries. Effort maps up to the CLI's highest level (`max`). The CLI drops replayed thinking from its history input, so earlier reasoning is not sent back.
- `/status` shows the plan's 5-hour and weekly windows as `Claude` limits with their reset times, refreshed by every response, and a provider note with the billing source, the account's extra-usage state and `claude.ai/settings/usage` for anything the provider does not report. The Console route has no plan limits and shows its billing page instead of a balance, which the provider does not report. A rejected request names the limit, its reset time and why extra usage could not cover it; a prompt over the window reports `context_length_exceeded`; an expired login, a refused model and exhausted API credits each name their fix.
- Each request starts a fresh CLI process. Offline measurement put the spawn and history replay at 0.2–0.4 s per request; live requests still hit the prompt cache. A warm session was not adopted because it would save little and weaken per-request admission.

Extra usage (paid overage on your Claude plan) is controlled by your account at `claude.ai/settings/usage`, not by OMD. With the default `extra_usage: true` the route keeps working when the plan limit is reached and the account allows extra usage, and `/status` says it is in use. Set `extra_usage: false` to make OMD stop the turn as soon as a response reports that it is served from extra usage. Anthropic only reports this on that response, so that request, and any started alongside it (the lead and `ask_claude` children), may still be billed; later turns fail before anything is sent until the reported reset, or are each stopped at their first response when no reset is reported.

Set `ask_claude: true` to give other leads an `ask_claude` tool. It runs Claude as an OMD child agent on the same route: read-only by default with read and search tools plus a sandboxed read-only shell, or `mode: "write"` in an isolated worktree that is integrated only within your own write permissions. `isolated: true` starts without the conversation; otherwise the frozen parent history is shared. The host refuses delegated requests that declare hosted web search, so write mode needs `web_search = "disabled"` in the session. Claude leads do not see the tool.

Plan usage is account-metered; that route reports no charge. Console usage is billed by Anthropic and recorded as provider-billed and unsettled. Either way usage carries the served model, cache reads and writes, the cache TTL and the CLI's own list-price figure (`total_cost_usd`) as a list-equivalent estimate (`omd_reported_cost`), not a bill. Disable the mod, or rerun setup after upgrading the CLI.

## Credits

Ports the usability of [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) 0.9.0 by Eli Dickinson (MIT): the CLI model catalog with family shortcuts, measured context windows, streamed thinking, effort levels, named rate limits and the AskClaude delegation tool. Reimplemented over the OMD mod API; see [THIRD_PARTY_NOTICES.md](../../../THIRD_PARTY_NOTICES.md).
