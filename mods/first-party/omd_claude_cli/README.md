# omd_claude_cli

Lets a session use Claude models through the official Claude CLI and your Claude plan (Pro, Max, Team or Enterprise), or through your Anthropic Console login.

## Turn it on

It comes with OMD+ but starts off. It needs Claude CLI `2.1.307` or a newer 2.x release on your `PATH` (install:
`curl -fsSL https://claude.ai/install.sh | bash`) and Node on your `PATH` (`brew install node`). `/claude login`
checks both before it opens the browser and says what to install.

1. Enable `omd_claude_cli` in `/mods` and approve its trust dialog. It asks to run `claude` and `node` outside the sandbox (`os`): `claude auth login` and the setup script need your real home directory and network.
2. Run `/claude login` for your plan (Pro, Max, Team or Enterprise), or `/claude login api` for Console API credits. The official `claude auth login` (`--console` for API) runs in the background and its progress shows in the transcript: the sign-in link appears there (the CLI also opens your browser), so finish signing in in the browser. If the page shows a code instead (for example over SSH), run `/claude code CODE`.
3. When the login exits, the mod rechecks `claude auth status`, discovers the models, registers the provider and adds them to `/model` beside the OpenAI models.

OMD never switches between plan limits and API credits on its own. The choice is stored and changes only when you run `/claude login` or `/claude login api` again. Later sessions publish the models at start with no step from you; run `/claude login` again after upgrading the Claude CLI. Claude Code's auto-update can stay on: every 2.x release from `2.1.307` is accepted, and each request still checks the sign-in, billing source, model and context window and is refused, with what to run, if one changed.

## Use it

| Command | What it does |
| --- | --- |
| `/claude login [NAME]` | Sign in with your Claude plan; `NAME` (starting with a letter) adds another account |
| `/claude login api [NAME]` | Sign in with Console API credits |
| `/claude remove NAME` | Drop an account's models and route; a named account is also signed out |
| `/claude code CODE` | Send the code the sign-in page shows to a running login |
| `/claude` (or `/claude status`) | Show the CLI version, each account's login and billing, and whether models are published. If the CLI is missing or older than `2.1.307`, it says so and what to run |
| `/model` | Pick a Claude model; the thread switches provider from its next turn and keeps its history |

`/status` shows the plan's 5-hour and weekly limits with reset times, and which billing source is in use. An expired login or a model your account lacks is refused with a message naming `/claude login`.

## Several accounts

`/claude login` without a name uses your normal Claude Code login (`~/.claude`). `/claude login work` signs another
account in under its own Claude CLI config directory (`<store>/routes/claude/accounts/work`, `CLAUDE_CONFIG_DIR`), so
each account keeps its own login and Keychain item and none needs signing in again. Each account gets a route
(`claude`, `claude-work`) and its own models in `/model` (`claude-opus-5-5.work`); requests run under the account
that owns the model. `omd_profiles` lists the accounts in `/profile`, switches between them with Alt+s and shows each
account's last-seen 5-hour and weekly limits. At most 16 models are listed across accounts, each account's default
first. A model other than an account's default is accounted on the provider's shared rate (plan, or provider-billed if
any account uses Console API credits), since the host keeps one route per account.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `extra_usage` | `true` | Keep working on paid extra usage when the plan limit is reached, if your account allows it. `false` stops as soon as a response reports extra usage, which may still be billed. |
| `ask_claude` | `false` | Give other models an `ask_claude` tool that runs Claude as a child agent. It is read-only unless asked to write, and writes only in an isolated worktree within your own write permissions. |

Write mode needs `web_search = "disabled"` in the session. Claude sessions don't get the tool.

## Needs and limits

- Models are the ones your plan offers, read from the installed CLI at login; at most 16 are listed.
- Plan usage shows no charge. Console usage is billed by Anthropic; each request's cost (the CLI's list-price figure) counts against your OMD budget and allowance alerts.
- A request for a model other than the selected one is refused.
- Each request starts a fresh CLI process, adding a fraction of a second.
- Earlier reasoning isn't sent back to Claude. Images are forwarded.
- After a switch to Claude, an OpenAI compaction summary is first rewritten as plain text by OpenAI (one OpenAI request; if it fails, Claude continues without that summary and a warning shows); OpenAI's encrypted reasoning isn't sent.
- A prompt over the model's context window is refused (`context_length_exceeded`).

Credit: based on [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) by Eli Dickinson (MIT); reimplemented over the OMD mod API. See [THIRD_PARTY_NOTICES.md](../../../THIRD_PARTY_NOTICES.md).
