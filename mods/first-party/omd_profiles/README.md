# omd_profiles

Switches one session between ChatGPT accounts, API keys, compatible providers such as OpenRouter, and the Claude and
Cursor accounts that `omd_claude_cli` and `omd_cursor` hold, without restarting. It's off by default in OMD+. OMD Core
doesn't include it.

## Turn it on

Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_profiles
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn mods on and off.

It asks to run `node` outside the sandbox (`os`) for its setup script, which writes the profile router into the
store's `host.json`, and to run other mods' commands (`builtins`) so it can start a Claude or Cursor sign-in.
[Trust and permissions](../../../docs/trust-and-permissions.md) explains what these grants allow.

## Use it

To add ChatGPT accounts, API keys, other providers and Claude or Cursor accounts, follow
[Use other providers](../../../docs/use-other-providers.md). This section covers what's specific to this mod.

A line above the prompt shows the thread's account and the limits it last reported, with how long ago: the five-hour
and weekly windows for ChatGPT and Claude accounts, and plan usage for Cursor accounts:

```text
● work · 5h ▓▓░░░ 42% · wk ▓░░░░ 13% · 3m ago · Alt+s next · /profile
```

| Command | What it does |
| --- | --- |
| `/profile` | Open the profile picker: every account from every provider with its last-seen limits, plus add and remove. Enter switches. |
| `Alt+s` or `/profile next` | Switch to the next available account. Paid and provider-billed accounts ask first. |
| `/profile use NAME` | Switch this thread at its next turn. Paid profiles ask first. |
| `/profile list` | Print the profiles. |
| `/profile add` | Pick an account kind and sign in or enter its key (see [Add an account](#add-an-account)). |
| `/profile remove NAME` | Remove a profile and, if no other profile uses it, its sign-in. Claude and Cursor accounts are removed with `/claude remove` and `/cursor remove`. |
| `/profile refresh NAME` | Refresh a credential's sign-in; `NAME` is its label or id and may contain spaces. |

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

Everything happens in the session, the first profile included. Paid keys also ask for an allowance (USD, `20` or
`$20`) the first time. Running another mod's command and every credential, route or allowance change ask you to
confirm. A sign-in from an add you cancelled or that failed is reused when you add the same name again. Account names
start with a lowercase letter, then lowercase letters, digits, `_` or `-`, at most 24 characters. Claude and Cursor
accounts appear once their sign-in finishes.

To start a session on a profile from a terminal, run `omd-package profiles --setup` or
`omd-package profiles --model NAME` (see `omd-package profiles --help`).

## Settings

It has no settings. Profiles are managed with `/profile`.

## Needs and limits

- Claude and Cursor accounts need `omd_claude_cli` or `omd_cursor` turned on. Claude subscription accounts come from
  `omd_claude_cli` (`/claude login NAME`) and Cursor accounts from `omd_cursor` (`/cursor setup NAME`); each mod owns
  its accounts and routes, and `omd_profiles` only lists and switches them.
- Setup and the profile router run on Node.js 22.18 or later: the Node.js given to the installer's `--node`, else
  `node` on `PATH`. Without `node`, adding a profile says what to install.
- A thread on a profile fails its requests while the mod is disabled or broken, until you turn it back on.
- Switching keeps the thread, attachments and tool history. Earlier reasoning isn't sent to another account, even if
  you switch back.
- Limits are what each account reported on its last request in any thread; nothing probes an idle account. A window
  whose reset time has passed shows `reset`. API-key profiles report none.
- The meter shows on threads whose provider holds a listed account: started with `omd-package profiles`, or on a
  Claude or Cursor model. `/profile` switches from any thread.
- Switching to a Claude or Cursor account moves the thread to that provider and the account's default model; its other
  models are in `/model`.
- On macOS, `Alt+s` needs Option-as-Alt in Kitty (`macos_option_as_alt`) and Ghostty (`macos-option-as-alt`).
  `/profile next` works everywhere.
- The selected model appears in the footer and `/status`. A failed switch blocks the thread's own requests and shows
  its reason above the prompt; each turn restarts a stopped router.
- Paid profiles bill per request against one allowance (USD) that all profiles in a thread share, asked the first time
  you add one. ChatGPT profiles report no charge.
- `/model` lists at most 16 profiles; adding a 17th is refused until you remove one.
- Chat Completions and Anthropic profiles get no hosted tools (web search, tool search).
- A thread larger than a profile's context window is refused before the provider is called.

## More

- [Use other providers](../../../docs/use-other-providers.md)
- [`omd_claude_cli`](../omd_claude_cli/README.md), [`omd_cursor`](../omd_cursor/README.md) and
  [`omd_model_picker`](../omd_model_picker/README.md)
- [Included mods](../../../docs/collection.md)
- Credit: inspired by [Crush](https://github.com/charmbracelet/crush) provider setup and model switching; no code
  copied.
