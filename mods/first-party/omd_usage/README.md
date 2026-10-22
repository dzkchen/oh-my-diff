# omd_usage

Shows what your session is using in a Usage dialog: context, cache, cost, quota, tasks and workers, request by request. The status line below the prompt (`omd_statusline`) shows the summary.

## Turn it on

It comes with OMD+ but starts off. Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_usage
```

## Use it

| Command or key | What it does |
| --- | --- |
| `Alt+a` or `/omd_usage:hud` | Open or close the Usage dialog. Its expanded view lists recent requests. |
| `/omd_usage:budget 5` | Warn when spend reaches 80% and 100% of 5 USD: a notice appears once at each, and the dialog shows spend against the budget. `0` removes the budget. |
| `/omd_usage:categories on` | Split each request by role (system, context, user, tool output). `off` turns it back off. |

Changes apply from your next message.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `budget_usd` | `0` | Soft budget in USD. `0` means no budget. |
| `categories` | `false` | Show the request breakdown by role. It runs on every request, so it is off by default. |

## Needs and limits

- Costs come from what each provider reports. Requests on your ChatGPT plan count as included; Extra-usage credits spent past the plan's limit aren't reported per request. A cost the provider doesn't report shows as unknown, not zero.
- Totals cover the last 120 requests in the session, not lifetime spend. The budget also counts what older requests cost before they left that window.
- Quota windows belong to the signed-in Codex account, not to another provider you switch to.
- Cache expiry shows only when the provider reports how long its cache lasts.
- The budget is a warning. OMD's spending limits still decide what runs.
- Claude and OpenRouter usage need `omd_claude_cli` or `omd_profiles`.
