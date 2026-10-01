# MCP server management

`omd_mcp` shows the session's MCP servers in the sidebar and manages them through Codex's own MCP configuration and commands. It is installed inactive in OMD+ and can be installed explicitly in OMD Core.

```text
/mcps                      # toggle transports, plugins and tool names in the sidebar
/mcps reload               # restart MCP servers from the current configuration
/mcps disable docs         # natively confirmed write of mcp_servers.docs.enabled = false
/mcps enable docs
/mcps add docs --url https://mcp.example/v1 --bearer-token-env-var DOCS_TOKEN
/mcps add fs --env ROOT=/tmp/work -- npx -y @scope/fs-server
/mcps remove docs | login docs | logout docs
```

How it works:

- Status comes from the session itself: every `mcpServer/startupStatus/updated` notification updates the server's state and error, and a finished startup asks `mcpServerStatus/list` for that one server on that thread, which reuses the thread's connection instead of starting the server again. The first update for a thread (and the first after a reload) also reads `config/read`, whose secret values the host redacts, and the MCP server names of up to 8 installed, enabled plugins (`plugin/installed`, `plugin/read`), so configured and plugin servers appear as `starting` or `disabled` before or without a startup. Updates go through the mod's own event channel so the sidebar redraws without waiting for a turn. The sidebar shows each server of the current thread: tool count, `starting`, `failed` with its error, `login required` with the `/mcps login` hint (OAuth servers; a bearer-token server needs `--bearer-token-env-var`), `failed` with `connection closed` when a started server's connection drops (the mod checks up to three servers of each thread every 10 s through `mcpServerStatus/list`, whose connection status comes from the live client), `last call failed` with the error of the most recent failed tool call to that server (the next successful call or startup clears it), or `disabled`; `/mcps` adds the transport (stdio or Streamable HTTP origin), the providing plugin and up to 16 tool names.
- `enable`/`disable` write `mcp_servers.<name>.enabled` (servers in your user `config.toml`) or `plugins.<plugin>.mcp_servers.<name>.enabled` (plugin servers) through `config/value/write`. The host shows the exact key and value in a native confirmation; every other `mcp_servers` key (command, URL, environment, headers, OAuth) stays protected. Then the mod reloads the servers; a reload restarts them right away, and the first startup update afterwards drops servers that no longer start (removed ones) while keeping those the mod disabled.
- `add`, `remove`, `login` and `logout` draft the matching upstream `codex mcp …` command into the composer as a `!` shell command, quoted for the shell. You review it and press Enter; it runs with your own permissions and writes `config.toml` exactly as the upstream CLI does, then `/mcps reload` starts the change. Adding an existing name replaces it and resets its per-tool policies; `--env` values are stored in plain text.
- MCP execution, OAuth, per-call approvals and network/secret settings stay with Codex.

Transports: stdio and Streamable HTTP. Legacy SSE servers are unsupported (Codex has no SSE client); the mod refuses `--sse`.

Limitations: the inventory covers the four most recently active threads, 24 servers each. Servers configured only in a project `.codex/config.toml` cannot be switched here (the write goes to the user config). A crash shows within about 10 s per three servers on the thread. Codex sent no `cancelled` update for a startup interrupted by a reload; the server shows `starting` until its new startup finishes. Codex's built-in `codex_apps` server is listed like any other.

Inspired by [Crush](https://github.com/charmbracelet/crush/blob/main/internal/agent/tools/mcp/init.go) MCP status handling; no code copied.
