# omd_profiles

Switches one session between ChatGPT accounts, API keys and compatible providers such as OpenRouter, without restarting.

## Turn it on

It comes with OMD+ but starts off. Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_profiles
```

You also need a profile:

1. In a session, add its credential: `/profile add chatgpt work`.
2. Run the command `/profile add` prints, for example:

```sh
omd-package profiles --setup --add work --credential work --protocol responses \
  --url https://chatgpt.com/backend-api/codex/responses --upstream-model gpt-6.1-sol
omd-package profiles --model work
```

Setup options:

- Paid API key or provider: `--paid INPUT_USD:OUTPUT_USD` (per million tokens) and `--allowance USD` are required.
- `--window TOKENS`: for a model that isn't in the Codex catalog.
- `--max-output TOKENS` and `--reasoning`: optional.
- `--text-only`: the model can't take images, so Codex sends a text note instead of each image.
- `--cache-control`: for Chat Completions providers that accept cache marks, such as OpenRouter. Off by default because strict servers reject the extra field. Anthropic profiles always get cache marks.
- `--setup --remove NAME`: drop a profile.

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
- Claude models come from `omd_claude_cli` (`/claude login`), not from a profile.

Credit: inspired by [Crush](https://github.com/charmbracelet/crush) provider setup and model switching; no code copied.
