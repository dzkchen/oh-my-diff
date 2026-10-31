# omd_profiles

Switches one session between your accounts without restarting: ChatGPT accounts, API keys, compatible providers such
as OpenRouter, and the Claude and Cursor accounts you sign in to with `omd_claude_cli` and `omd_cursor`. It's off by
default in OMD+. OMD Core doesn't include it.

## Turn it on

Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_profiles
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

Turning it on asks for two grants. `os` lets it run `node` outside the sandbox for its setup script, which writes the
profile router into your mod store's `host.json`. `builtins` lets it run other mods' commands, so it can start a Claude
or Cursor sign-in.
[Trust and permissions](../../../docs/trust-and-permissions.md) explains what these grants allow.

## Use it

To add ChatGPT accounts, API keys, other providers and Claude or Cursor accounts, follow
[Use other providers](../../../docs/use-other-providers.md).

A line above the prompt shows the thread's account and the limits it last reported, with how long ago: the five-hour
and weekly windows for ChatGPT and Claude accounts, and plan usage for Cursor accounts:

```text
● work · 5h ▓▓░░░ 42% · wk ▓░░░░ 13% · 3m ago · Alt+s next · /profile
```

Each account you add becomes a profile.

| Command | What it does |
| --- | --- |
| `/profile` | Open the profile picker: every profile from every provider with its last-seen limits, plus add and remove. `Enter` switches. |
| `Alt+s` or `/profile next` | Switch to the next available profile. Paid and provider-billed profiles ask first. |
| `/profile use NAME` | Switch this thread at its next turn. Paid profiles ask first. |
| `/profile list` | Print the profiles. |
| `/profile add` | Pick an account kind and sign in or enter its key (see [Add an account](#add-an-account)). |
| `/profile remove NAME` | Remove a profile and, if no other profile uses it, its sign-in. Claude and Cursor profiles are removed with `/claude remove` and `/cursor remove`. |
| `/profile refresh NAME` | Refresh a credential's sign-in. `NAME` is its label or id and may contain spaces. |

### Add an account

Run `/profile add` (or pick **+ Add an account…** in `/profile`) and choose what to add:

| Choice | What happens |
| --- | --- |
| ChatGPT account | Asks a name, then the ChatGPT sign-in runs in the session. The first ChatGPT profile also asks its model. |
| Claude account | Asks a name and plan or Console API credits, then runs `omd_claude_cli`'s sign-in (`/claude login`). |
| Cursor account | Asks a name, then runs `omd_cursor`'s setup (`/cursor setup`). |
| OpenAI API key | Asks a name, model and price, then the key. The context window is asked only for a model Codex's catalog doesn't list. |
| Anthropic API key | The same, for `api.anthropic.com`. |
| Other provider (URL) | The same, plus the endpoint URL and its protocol. |

Shortcuts: `/profile add chatgpt|claude|cursor|api_key|anthropic NAME` and `/profile add provider NAME HTTPS_URL`.

- Everything happens in the session, the first profile included.
- Paid keys ask for an allowance (USD, `20` or `$20`) the first time.
- OMD asks you to confirm before it runs another mod's command and before any credential, route or allowance change.
- If you cancel an add or it fails, its sign-in is reused when you add the same name again.
- Account names start with a lowercase letter, then lowercase letters, digits, `_` or `-`, at most 24 characters.
- Claude and Cursor accounts appear once their sign-in finishes.

To start a session on a profile from a terminal, run `omd-package profiles --setup` or
`omd-package profiles --model NAME` (see `omd-package profiles --help`).

## Settings

It has no settings. Profiles are managed with `/profile`.

## Needs and limits

- It asks to add `/profile` with its picker and meter, run `node` outside the sandbox for setup, request and store
  account credentials, add and select model routes, move threads between providers, follow requests to track limits,
  run other mods' sign-in commands and keep its state. The capabilities are `commands`, `terminal`, `exec`, `os`,
  `credentials`, `packages`, `model`, `threads`, `middleware`, `lifecycle`, `events`, `inventory`, `builtins` and
  `store` (see [Trust and permissions](../../../docs/trust-and-permissions.md#what-a-mod-can-do)).
- Claude and Cursor accounts need `omd_claude_cli` or `omd_cursor` turned on. Claude subscription accounts come from
  `omd_claude_cli` (`/claude login NAME`) and Cursor accounts from `omd_cursor` (`/cursor setup NAME`). Each of those
  mods manages its own accounts and routes. `omd_profiles` only lists them and switches between them.
- Setup and the profile router run on Node.js 22.18 or later: the Node.js given to the installer's `--node`, else
  `node` on `PATH`. Without `node`, adding a profile says what to install.
- A thread on a profile fails its requests while the mod is turned off or broken, until you turn it back on.
- Switching keeps the thread, attachments and tool history. Earlier reasoning isn't sent to another account, even if
  you switch back.
- Limits are what each account reported on its last request in any thread. Nothing probes an idle account. A window
  whose reset time has passed shows `reset`. API-key profiles report none.
- The meter shows on threads that use one of your profiles: threads started with `omd-package profiles`, or threads
  on a Claude or Cursor model. `/profile` switches from any thread.
- Switching to a Claude or Cursor account moves the thread to that provider and the account's default model. Its other
  models are in `/model`.
- On macOS, `Alt+s` needs Option-as-Alt turned on in Kitty (`macos_option_as_alt`) or Ghostty (`macos-option-as-alt`).
  `/profile next` works everywhere.
- The selected model appears in the footer and `/status`. A failed switch blocks the thread's own requests and shows
  its reason above the prompt. Each turn restarts a stopped router.
- Paid profiles bill per request against one allowance (USD) that all profiles in a thread share, asked the first time
  you add one. ChatGPT profiles report no charge.
- `/model` lists at most 16 profiles. Adding a 17th is refused until you remove one.
- Profiles that use the Chat Completions or Anthropic protocol get no hosted tools (web search, tool search).
- A thread larger than a profile's context window is refused before the provider is called.

## More

- [Use other providers](../../../docs/use-other-providers.md)
- [`omd_claude_cli`](../omd_claude_cli/README.md), [`omd_cursor`](../omd_cursor/README.md) and
  [`omd_model_picker`](../omd_model_picker/README.md)
- [Included mods](../../../docs/collection.md)
- Credit: inspired by [Crush](https://github.com/charmbracelet/crush) provider setup and model switching; no code
  copied.
