# omd_profiles

Manage ChatGPT, Claude and Cursor accounts, API keys, compatible providers and local Ollama. Select an account for
new threads; existing and resumed threads keep their account. This mod is experimental and installed separately.

## Turn it on

In OMD+, run `omd-package profiles --setup`, then open `/profile`.

Setup asks for permission to run Node outside the sandbox and write the profile router into the mod store.
The mod can also open other mods' login flows and offer to enable an installed provider mod.
[Trust and permissions](../../../docs/trust-and-permissions.md) describes these grants.

## Use it

1. Open `/profile` and choose **+ Add an account…**.
2. Choose the account type, give it a name and sign in or enter its key.
3. Open the account and choose **Use for new threads (/new)**, then run `/new`.

An account's menu also has **Sign in again / replace key** and **Remove account**. Claude and Cursor accounts are
managed through their provider mods from the same menu. An account in use by the current thread or selected for
new threads cannot be removed until you select another account and start a new thread.

The picker marks **this thread** and **next /new** separately. Alt+s cycles the selection for new threads;
it never moves the current conversation. A paid or provider-billed account asks for confirmation first.
The selection lasts for this running OMD session. Starting another OMD process uses that process's launch settings.

The meter shows the current thread's account and its last reported usage:

```text
● work · 5h ▓▓░░░ 42% · wk ▓░░░░ 13% · 3m ago · Alt+s next · /profile
```

When another account is selected, the meter shows `/new → NAME`. A failed selection leaves the current thread usable.

| Command | What it does |
| --- | --- |
| `/profile` | Open account management: select, reconnect, remove or add an account |
| `Alt+s` or `/profile next` | Select the next available account for new threads |
| `/profile use NAME` | Select an account, then run `/new` to use it |
| `/profile list` | Print accounts and their last reported usage |
| `/profile add` | Choose an account type and add it |
| `/profile refresh NAME` | Reconnect an account or replace its key; credential labels can contain spaces |
| `/profile remove NAME` | Remove an unused account and its unused sign-in |
| `/profile window [PROFILE\|MODEL]` | Advanced: change the context window used before compaction; catalog defaults and maxima are shown |

### Add an account

| Choice | Setup |
| --- | --- |
| ChatGPT | Name and browser sign-in. Model, context window and reasoning defaults come from the Codex catalog; no model name, pricing or allowance prompt |
| Claude | Name, Claude plan or Console API credits, then the official Claude Code CLI login through `omd_claude_cli` |
| Cursor | Name and browser approval through `omd_cursor`; its SDK is installed with pnpm |
| OpenAI API key | Name and masked key entry, then model, context window, token prices and a spending allowance |
| Anthropic API key | The same, for the Anthropic Messages endpoint |
| Other provider | Name, HTTPS endpoint, masked key, model, context window, token prices and protocol |
| Local Ollama | Name, local address, model and context window; no key, price or allowance |

Shortcuts: `/profile add chatgpt|claude|cursor|api_key|anthropic|ollama NAME`,
`/profile add ollama NAME URL`, and `/profile add provider NAME HTTPS_URL`.

Sign-ins survive a cancelled or failed route setup. Repeating the add reuses a ready sign-in or resumes an
unfinished one. Another provider's sign-in with the same name is refused with a request to choose another name.
Credentials stay in the host's credential store; the mod never receives their token material.

For Ollama, use `localhost`, `127.0.0.1` or `[::1]`. Set `OLLAMA_CONTEXT_LENGTH` to the window you choose:
Ollama can otherwise silently truncate prompts. Only local HTTP addresses are supported.

To launch a session on a profile from the shell, use `omd-package profiles --model NAME`.

## Needs and limits

- Node.js 22.18 or later is required for setup and the profile router. Missing Node produces installation guidance.
- Claude and Cursor use their own provider mods, account stores and discovered model catalogs. Cursor may bill
  beyond included usage. Live account entitlement and provider availability still depend on the provider.
- ChatGPT uses the current native Codex model when available, otherwise a catalog model. Subscription setup never
  asks you to supply a model identifier or context size.
- API prices are per million input/output tokens. Paid profiles share a per-thread allowance, asked on first setup.
- Up to 16 profiles can be published in `/model`. Profile routes disable hosted web search; Chat Completions and
  Anthropic profiles receive no hosted tools.
- Limits are the last values each account reported; idle accounts are not probed. Expired windows show `reset`.
- Each turn restarts a stopped profile router. Turning off a provider mod makes its account unavailable.
- Alt+s needs Option-as-Alt in Kitty or Ghostty; `/profile next` works in every terminal.
- Capabilities: `commands`, `terminal`, `exec`, `os`, `credentials`, `packages`, `model`, `threads`, `lifecycle`,
  `events`, `inventory`, `builtins` and `store`.

## More

- [Use other providers](../../../docs/use-other-providers.md)
- [`omd_claude_cli`](../omd_claude_cli/README.md) and [`omd_cursor`](../omd_cursor/README.md)
- [Included mods](../../../docs/collection.md)
- Credit: inspired by [Crush](https://github.com/charmbracelet/crush) provider setup and model switching; no code copied.
