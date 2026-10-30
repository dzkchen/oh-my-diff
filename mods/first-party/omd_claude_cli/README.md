# omd_claude_cli

Lets a session use Claude models through the official Claude CLI and your Claude plan (Pro, Max, Team or
Enterprise), or through your Anthropic Console login. It's off by default in OMD+. OMD Core doesn't include it.

## Turn it on

Turn it on in `/mods` and approve its trust dialog, or run:

```sh
omd-package mod enable omd_claude_cli
```

It asks to run `claude` and `node` outside the sandbox (`os`), because `claude auth login` and the setup script need
your real home directory and network. Then run `/claude login` in a session.
[Use Claude or another provider](../../../docs/use-other-providers.md) walks through sign-in, billing and several
accounts. [Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

## Use it

| Command | What it does |
| --- | --- |
| `/claude login [NAME]` | Sign in with your Claude plan; `NAME` adds another account |
| `/claude login api [NAME]` | Sign in with Console API credits |
| `/claude remove NAME` | Drop an account's models and route; a named account is also signed out |
| `/claude code CODE` | Send the code the sign-in page shows to a running login |
| `/claude` (or `/claude status`) | Show the CLI version, each account's login and billing, and whether models are published. If the CLI is missing or older than `2.1.307`, it says so and what to run |
| `/model` | Pick a Claude model; the thread switches provider from its next turn and keeps its history |

An account `NAME` starts with a lowercase letter, then lowercase letters, digits, `_` or `-`, at most 24 characters.
For example, `/claude login work` signs in a second account, whose models appear in `/model` as
`claude-opus-5-5.work`.

Bare `/claude login` uses your normal Claude Code login (`~/.claude`). A named account signs in under its own Claude CLI
config directory, `<store>/routes/claude/accounts/NAME` (`CLAUDE_CONFIG_DIR`), with its own Keychain item, so it never
touches your normal login. Each account gets its own route (`claude`, `claude-NAME`), and a request runs under the
account that owns the model. A model other than an account's default is billed on the shared rate: the plan, or
provider billing if any account uses Console API credits.

`/status` shows the plan's 5-hour and weekly limits with reset times, and which billing source is in use. An expired
login or a model your account lacks is refused with a message naming `/claude login`.

OMD never switches between plan limits and API credits on its own. The choice is stored and changes only when you run
`/claude login` or `/claude login api` again.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `extra_usage` | `true` | Keep working on paid extra usage when the plan limit is reached, if your account allows it. `false` stops as soon as a response reports extra usage, which may still be billed. |

## Needs and limits

- Claude CLI `2.1.307` or later and Node 22.18 or later on your `PATH`. `/claude login` checks that both exist and
  says what to install, but it enforces only the CLI version and doesn't check the Node version. Every 2.x CLI
  release from `2.1.307` is accepted, so Claude Code's auto-update can stay on. Run `/claude login` again after
  upgrading the CLI.
- Models are the ones your plan offers, read from the installed CLI at login. At most 16 are listed across accounts.
- Plan usage shows no charge. Console usage is billed by Anthropic; each request's cost (the CLI's list-price figure)
  counts against your OMD budget and allowance alerts.
- A request for a model other than the selected one is refused.
- Each request starts a fresh CLI process, adding a fraction of a second. A CLI that has not finished 30 minutes after
  starting (for example one that never sends its request) is stopped with its child processes and the request fails
  with `claude_upstream_incomplete`. Retry it, and if it repeats, check `/claude` or update the CLI.
- Earlier reasoning isn't sent back to Claude. Images are forwarded.
- Setup raises the per-subagent limit in `host.json` `worker_limits` to at least 300 requests and a day, within the
  session's `limits`, keeping higher values you set. After upgrading, run `/claude login` again to apply them.
- After a switch to Claude, an OpenAI compaction summary is first rewritten as plain text by OpenAI (one OpenAI
  request; if it fails, Claude continues without that summary and a warning shows). OpenAI's encrypted reasoning
  isn't sent.
- A prompt over the model's context window is refused (`context_length_exceeded`).

## More

- [Use Claude or another provider](../../../docs/use-other-providers.md)
- [Included mods](../../../docs/collection.md)
- [`omd_profiles`](../omd_profiles/README.md) switches between accounts with `/profile` and Alt+s
- [`omd_subagent_router`](../omd_subagent_router/README.md) runs subagents on Claude while another model leads
- [Routes](../../reference/routes.md) and [credentials](../../reference/credentials.md) in the mod API
  reference

Credit: based on [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) by Eli Dickinson (MIT);
reimplemented over the OMD mod API. See [THIRD_PARTY_NOTICES.md](../../../THIRD_PARTY_NOTICES.md).
