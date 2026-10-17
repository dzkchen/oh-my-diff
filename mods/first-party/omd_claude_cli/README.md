# omd_claude_cli

Lets a session use Claude models through the official Claude CLI and your Claude plan (Pro, Max, Team or Enterprise),
or, as a separately chosen route, your Anthropic Console login.

## Turn it on

It comes with OMD+ but starts off. It needs Claude CLI `2.1.296`. Setup checks the CLI and its login and turns the mod on:

```sh
omd-package claude --setup                 # your plan; needs `claude auth login`
omd-package claude --setup --billing api   # Console API credits; needs `claude auth login --console`
```

OMD never falls back from plan limits to API credits or back. Rerunning setup without `--billing` keeps the current
choice.

## Use it

| Command | What it does |
| --- | --- |
| `omd-package claude` | Start an interactive session on the default model (Opus). |
| `omd-package claude --model sonnet` | Start on a model family or an exact model name. |
| `omd-package claude --model haiku exec 'Your task'` | Run one task and exit. |
| `/claude_route` | Show how to set up and launch the route. |

`/status` shows the plan's 5-hour and weekly limits with their reset times, and which billing source is in use. Rerun
setup after upgrading the Claude CLI.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `extra_usage` | `true` | Keep working on paid extra usage when the plan limit is reached and your account allows it. `false` stops the turn as soon as a response reports extra usage; that response may still be billed. |
| `ask_claude` | `false` | Give other models an `ask_claude` tool that runs Claude as a child agent. It is read-only unless asked to write, and it writes only in an isolated worktree within your own write permissions. |

Write mode needs `web_search = "disabled"` in the session. Claude sessions don't get the tool.

## Needs and limits

- The CLI never sees inherited `ANTHROPIC_*` variables or credential and cloud overrides.
- Models are the ones your plan offers. Setup reads them from the installed CLI.
- Plan usage is account-metered, so no charge is shown; Console usage is billed by Anthropic. Cost figures are the
  CLI's list-price estimate, not a bill.
- A request for a model other than the selected one is refused before it is sent.
- Each request starts a fresh CLI process, which adds a fraction of a second.
- Earlier reasoning is not sent back to Claude. Images in prompts and tool output are forwarded.
- A prompt over the model's context window is refused with `context_length_exceeded`.

Credit: based on [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) by Eli Dickinson (MIT); reimplemented over the OMD mod API. See [THIRD_PARTY_NOTICES.md](../../../THIRD_PARTY_NOTICES.md).
