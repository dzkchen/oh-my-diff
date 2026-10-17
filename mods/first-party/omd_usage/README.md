# omd_usage

Shows what your session is using: context, cache, cost and quota, in a row above the prompt and a Usage dialog.

## Turn it on

It comes with OMD+ but starts off. Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_usage
```

## Use it

| Command or key | What it does |
| --- | --- |
| `Alt+a` or `/omd_usage:hud` | Open or close the Usage dialog. Its expanded view lists recent requests. |
| `/omd_usage:budget 5` | Warn when spend reaches 80% and 100% of 5 USD. `0` removes the budget. |
| `/omd_usage:categories on` | Split each request by role (system, context, user, tool output). `off` turns it back off. |

Changes apply from your next message.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `budget_usd` | `0` | Soft budget in USD. `0` means no budget. |
| `categories` | `false` | Show the request breakdown by role. It runs on every request, so it is off by default. |

## Needs and limits

- Costs come from what each provider reports. A cost the provider doesn't report shows as unknown, not zero.
- Totals cover the last 120 requests in the session, not lifetime spend.
- Quota windows belong to the signed-in Codex account, not to another provider you switch to.
- Cache expiry shows only when the provider reports how long its cache lasts.
- The budget is a warning. OMD's spending limits still decide what runs.
- Claude and OpenRouter usage need `omd_claude_cli` or `omd_profiles`.
