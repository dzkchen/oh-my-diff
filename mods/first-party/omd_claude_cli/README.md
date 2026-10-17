# omd_claude_cli

Lets a session use Claude models through the official Claude CLI and your Claude Pro or Max subscription.

## Turn it on

It comes with OMD+ but starts off. It needs Claude CLI `2.1.285`, signed in to Pro or Max. Setup checks both and turns the mod on:

```sh
omd-package claude --setup
```

## Use it

| Command | What it does |
| --- | --- |
| `omd-package claude` | Start an interactive session on the default model (Opus). |
| `omd-package claude --model sonnet` | Start on a model family or an exact model name. |
| `omd-package claude --model haiku exec 'Your task'` | Run one task and exit. |
| `/claude_route` | Show how to set up and launch the route. |

Subscription limits (5-hour and 7-day windows) appear in `/status`. Rerun setup after upgrading the Claude CLI.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `ask_claude` | `false` | Give other models an `ask_claude` tool that runs Claude as a child agent. It is read-only unless asked to write, and it writes only in an isolated worktree within your own write permissions. |

Write mode needs `web_search = "disabled"` in the session. Claude sessions don't get the tool.

## Needs and limits

- No API-key fallback: setup refuses inherited API-key and cloud settings.
- Models are the ones your plan offers. Setup reads them from the installed CLI.
- Subscription usage is account-metered, so no charge is shown. Cost figures are the CLI's list-price estimate, not a bill.
- Each request starts a fresh CLI process, which adds a fraction of a second.
- Earlier reasoning is not sent back to Claude. Images in prompts and tool output are forwarded.
- A prompt over the model's context window is refused with `context_length_exceeded`.

Credit: based on [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) by Eli Dickinson (MIT); reimplemented over the OMD mod API. See [THIRD_PARTY_NOTICES.md](../../../THIRD_PARTY_NOTICES.md).
