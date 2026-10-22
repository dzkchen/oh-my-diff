# omd_profiles

Switches one session between ChatGPT accounts, API keys, compatible providers such as OpenRouter, and the Claude and
Cursor accounts that `omd_claude_cli` and `omd_cursor` hold, without restarting.

## Turn it on

It comes with OMD+ but starts off. Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_profiles
```

It asks to run `node` outside the sandbox (`os`) for its setup script, which writes the profile router into the
store's `host.json`, and to run other mods' commands (`builtins`) so it can start a Claude or Cursor sign-in.

## Add an account

Run `/profile add` (or pick **+ Add an account…** in `/profile`) and choose what to add:

| Choice | What happens |
| --- | --- |
| ChatGPT account | Asks a name, then the ChatGPT sign-in runs in the session. The first ChatGPT profile also asks its model. |
| Claude account | Asks a name and plan or Console API credits, then runs `omd_claude_cli`'s sign-in (`/claude login`). |
| Cursor account | Asks a name, then runs `omd_cursor`'s setup (`/cursor setup`). |
| OpenAI API key | Asks a name, model and price, then the key. The context window is asked only for a model Codex's catalog doesn't list. |
| Anthropic API key | The same, for `api.anthropic.com`. |
| Other provider (URL) | The same, plus the endpoint URL and its protocol. |

Everything happens in the session, the first profile included; paid keys also ask for an allowance (USD, `20` or
`$20`) the first time. Running another mod's command and every credential, route or allowance change ask you to
confirm. A sign-in from an add you cancelled or that failed is reused when you add the same name again. Account names
start with a letter. Claude and Cursor accounts need `omd_claude_cli` or `omd_cursor` turned on and appear once their
sign-in finishes.

Shortcuts: `/profile add chatgpt|claude|cursor|api_key|anthropic NAME` and `/profile add provider NAME HTTPS_URL`.

To start a session on a profile, `omd-package profiles --setup` and `omd-package profiles --model NAME` still work
from a terminal (see `omd-package profiles --help`).

## Use it

A line above the prompt shows the thread's account and the limits it last reported, with how long ago: the five-hour
and weekly windows for ChatGPT and Claude accounts, and plan usage for Cursor accounts:

```text
● work · 5h ▓▓░░░ 42% · wk ▓░░░░ 13% · 3m ago · Alt+s next · /profile
```

| Command | What it does |
| --- | --- |
| `/profile` | Open the profile picker: every account from every provider with its last-seen limits, plus add and remove. Enter switches. |
| Alt+s or `/profile next` | Switch to the next available account. Paid and provider-billed accounts ask first. |
| `/profile use NAME` | Switch this thread at its next turn. Paid profiles ask first. |
| `/profile list` | Print the profiles. |
| `/profile add` | Pick an account kind and sign in or enter its key (see above). |
| `/profile remove NAME` | Remove a profile and, if no other profile uses it, its sign-in. Claude and Cursor accounts are removed with `/claude remove` and `/cursor remove`. |
| `/profile refresh NAME` | Refresh a credential's sign-in. |

## Needs and limits

- A thread on a profile fails its requests while the mod is disabled or broken, until you re-enable it.
- Setup and the profile router run on Node.js 22.18 or later: the Node.js given to the installer's `--node`, else `node` on PATH. Without `node`, adding a profile says what to install.
- Switching keeps the thread, attachments and tool history. Earlier reasoning is not sent to another account, even if you switch back.
- Limits are what each account reported on its last request in any thread; nothing probes an idle account. A window whose reset time has passed shows `reset`. API-key profiles report none.
- The meter shows on threads whose provider holds a listed account: started with `omd-package profiles`, or on a Claude or Cursor model. `/profile` switches from any thread.
- Switching to a Claude or Cursor account moves the thread to that provider and the account's default model; its other models are in `/model`.
- Alt+s needs Option-as-Alt in Kitty (`macos_option_as_alt`) and Ghostty (`macos-option-as-alt`) on macOS; `/profile next` works everywhere.
- The selected model appears in the footer and `/status`. A failed or unsettled switch blocks requests and shows its reason above the prompt; each turn restarts a stopped router.
- Paid profiles bill per request against one allowance (USD) that all profiles in a thread share, asked the first time you add one. ChatGPT profiles report no charge.
- Chat Completions and Anthropic profiles get no hosted tools (web search, tool search).
- A thread larger than a profile's context window is refused before the provider is called.
- Claude subscription accounts come from `omd_claude_cli` (`/claude login NAME`) and Cursor accounts from `omd_cursor` (`/cursor setup NAME`); each mod owns its accounts and routes, and `omd_profiles` only lists and switches them.

Credit: inspired by [Crush](https://github.com/charmbracelet/crush) provider setup and model switching; no code copied.
