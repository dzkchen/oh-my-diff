# omd_profiles

Switches one session between ChatGPT accounts, API keys and compatible providers such as OpenRouter, without restarting.

## Turn it on

It comes with OMD+ but starts off. Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_profiles
```

You also need a profile. In a session, add its credential (`/profile add chatgpt work`), then add the profile from a terminal. `/profile add` prints the command to run.

```sh
omd-package profiles --setup --add work --credential work --protocol responses \
  --url https://chatgpt.com/backend-api/codex/responses --upstream-model gpt-6.1-sol
omd-package profiles --model work
```

For a paid API key or provider, setup also needs `--paid INPUT_USD:OUTPUT_USD` (per million tokens) and `--allowance USD`. Add `--window TOKENS` if the model isn't in the Codex catalog. `--max-output TOKENS` and `--reasoning` are optional. `--setup --remove NAME` drops a profile.

For Chat Completions providers that accept cache marks, such as OpenRouter, add `--cache-control`. It is off by
default because strict servers reject that extra field. Anthropic profiles always receive cache marks.

## Use it

| Command | What it does |
| --- | --- |
| `/profile` | List profiles, their billing and the current one. |
| `/profile use NAME` | Switch this thread at its next turn. Paid profiles ask first. |
| `/profile add chatgpt\|api_key LABEL` | Sign in to, or enter a key for, a new credential. |
| `/profile add provider LABEL PROVIDER HTTPS_ORIGIN` | Enter a key for another provider. |
| `/profile refresh LABEL` | Refresh a credential's sign-in. |
| `/profile remove LABEL` | Remove a credential. Profiles using it stop working. |

## Needs and limits

- Launch with `omd-package profiles [--model NAME]`. If the mod is disabled or broken, requests fail until you re-enable it.
- Switching keeps the thread, attachments and tool history. Earlier reasoning is not sent to another account, even if you switch back.
- The selected model appears in the footer and `/status`. A failed or unsettled switch blocks requests and shows its reason in `/profile`; each turn restarts a stopped router.
- Paid profiles bill per request against the allowance you set. ChatGPT profiles report no charge.
- Chat Completions and Anthropic profiles get no hosted tools (web search, tool search).
- A thread larger than a profile's context window is refused before the provider is called.
- A thread cannot switch between providers. The Claude CLI route is separate: `omd-package claude`.

Credit: inspired by [Crush](https://github.com/charmbracelet/crush) provider setup and model switching; no code copied.
