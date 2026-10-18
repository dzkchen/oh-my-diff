# omd_claude_cli

Lets a session use Claude models through the official Claude CLI and your Claude plan (Pro, Max, Team or Enterprise), or through your Anthropic Console login.

## Turn it on

It comes with OMD+ but starts off. It needs Claude CLI `2.1.296`. Setup checks the CLI and its login, then turns the mod on:

```sh
omd-package claude --setup                 # your plan; needs `claude auth login`
omd-package claude --setup --billing api   # Console API credits; needs `claude auth login --console`
```

OMD never switches between plan limits and API credits on its own. Rerunning setup without `--billing` keeps your choice.

## Use it

| Command | What it does |
| --- | --- |
| `omd-package claude` | Start an interactive session on the default model (Opus) |
| `omd-package claude --model sonnet` | Start on a model family or an exact model name |
| `omd-package claude --model haiku exec 'Your task'` | Run one task and exit |
| `/claude_route` | Show how to set up and launch the route |

`/status` shows the plan's 5-hour and weekly limits with reset times, and which billing source is in use. Rerun setup after upgrading the Claude CLI.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `extra_usage` | `true` | Keep working on paid extra usage when the plan limit is reached, if your account allows it. `false` stops as soon as a response reports extra usage, which may still be billed. |
| `ask_claude` | `false` | Give other models an `ask_claude` tool that runs Claude as a child agent. It is read-only unless asked to write, and writes only in an isolated worktree within your own write permissions. |

Write mode needs `web_search = "disabled"` in the session. Claude sessions don't get the tool.

## Needs and limits

- Models are the ones your plan offers, read from the installed CLI.
- Plan usage shows no charge. Console usage is billed by Anthropic. Costs shown are the CLI's list-price estimate, not a bill.
- A request for a model other than the selected one is refused.
- Each request starts a fresh CLI process, adding a fraction of a second.
- Earlier reasoning isn't sent back to Claude. Images are forwarded.
- A prompt over the model's context window is refused (`context_length_exceeded`).

Credit: based on [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) by Eli Dickinson (MIT); reimplemented over the OMD mod API. See [THIRD_PARTY_NOTICES.md](../../../THIRD_PARTY_NOTICES.md).
