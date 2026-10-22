# omd_profiles

Switches one session between ChatGPT accounts, API keys and compatible providers such as OpenRouter, without restarting.

## Turn it on

It comes with OMD+ but starts off. Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_profiles
```

You also need a first profile, set up once from a terminal:

1. In a session, add its credential: `/profile add chatgpt work`.
2. Run the setup command it prints, for example:

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

After that, add and remove accounts in the session. Each change asks you to confirm the routes it writes to `host.json`.

## Use it

A line above the prompt shows the thread's profile and, for ChatGPT accounts, the five-hour and weekly limits the
account last reported, with how long ago:

```text
● work · 5h ▓▓░░░ 42% · wk ▓░░░░ 13% · 3m ago · Alt+s next · /profile
```

| Command | What it does |
| --- | --- |
| `/profile` | Open the profile picker: every account with its last-seen limits, plus add and remove. Enter switches. |
| Alt+s or `/profile next` | Switch to the next available profile. Paid profiles ask first. |
| `/profile use NAME` | Switch this thread at its next turn. Paid profiles ask first. |
| `/profile list` | Print the profiles. |
| `/profile add chatgpt\|api_key NAME` | Sign in to another ChatGPT account (on the current account's model) or enter an OpenAI API key, and add it as a profile. |
| `/profile add provider NAME HTTPS_URL` | Enter a key for another provider's endpoint and add it. |
| `/profile remove NAME` | Remove a profile and, if no other profile uses it, its sign-in. |
| `/profile refresh NAME` | Refresh a credential's sign-in. |

## Needs and limits

- Launch with `omd-package profiles [--model NAME]`. If the mod is disabled or broken, requests fail until you re-enable it.
- Setup and the profile router run on Node.js 22.18 or later: the Node.js given to the installer's `--node`, else `node` on PATH.
- Switching keeps the thread, attachments and tool history. Earlier reasoning is not sent to another account, even if you switch back.
- Limits are what each ChatGPT account reported on its last request in any thread; nothing probes an idle account. A window whose reset time has passed shows `reset`.
- Alt+s needs Option-as-Alt in Kitty (`macos_option_as_alt`) and Ghostty (`macos-option-as-alt`) on macOS; `/profile next` works everywhere.
- The selected model appears in the footer and `/status`. A failed or unsettled switch blocks requests and shows its reason above the prompt; each turn restarts a stopped router.
- Paid profiles bill per request against the allowance you set, which all profiles in a thread share. ChatGPT profiles report no charge.
- Adding a paid profile in the session needs an allowance set by setup (`--allowance USD`).
- Chat Completions and Anthropic profiles get no hosted tools (web search, tool search).
- A thread larger than a profile's context window is refused before the provider is called.
- Profiles set up with OMD 1.0.1 or earlier are not carried over: run setup with `--add` again.
- Claude models come from `omd_claude_cli` (`/claude login`), not from a profile.

Credit: inspired by [Crush](https://github.com/charmbracelet/crush) provider setup and model switching; no code copied.
