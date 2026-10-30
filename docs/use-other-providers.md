# Use other providers

How to use Claude, Cursor, an API key or another compatible provider in `codex`, and how to switch between
accounts. Each provider is a mod that's off by default in OMD+. Turn it on as [Manage mods](manage-mods.md)
describes.

| You want | Turn on | Needs |
| --- | --- | --- |
| Claude models on your Claude plan or Console API credits | `omd_claude_cli` | Claude CLI `2.1.307` or later and Node 22.18 or later on your `PATH` |
| Several ChatGPT accounts, an OpenAI or Anthropic API key, or another provider by URL | `omd_profiles` | Node 22.18 or later |
| Cursor models on your Cursor account | `omd_cursor` | Node 22.18 or later and `pnpm` on your `PATH`. Not yet verified on a live account |

[Support](support.md) lists the supported versions of each tool.

Each of these mods asks to run `node` (and `omd_claude_cli` also `claude`) outside the sandbox when you turn it on.
[Trust and permissions](trust-and-permissions.md) explains what that allows.

## Use Claude

1. In `codex`, turn on `omd_claude_cli` in `/mods` and approve its trust dialog.
2. Sign in. For your Claude plan (Pro, Max, Team or Enterprise):

   ```text
   /claude login
   ```

   For Console API credits, run `/claude login api` instead. Finish signing in in the browser. If the page shows a
   code, run `/claude code CODE`.
3. Pick a Claude model in `/model`. The thread switches provider from its next turn and keeps its history.

To add another Claude account, run `/claude login NAME`. `/claude` shows the CLI version, each account's sign-in
and whether its models are published. The [`omd_claude_cli` README](../mods/first-party/omd_claude_cli/README.md)
covers billing, several accounts and limits.

## Use an API key or another provider

1. Turn on `omd_profiles` in `/mods`.
2. Add an account:

   ```text
   /profile add
   ```

   Pick a ChatGPT account, a Claude or Cursor account, an OpenAI or Anthropic API key, or another provider by URL.
   Sign-in and key entry happen in the session. A paid key asks for an allowance in USD the first time.
3. Switch with `/profile`, `/profile use NAME`, or Alt+s for the next account.

Alt+s needs Option-as-Alt in Kitty and Ghostty; `/profile next` works in every terminal. To start a session on a
profile from a shell, use `omd-package profiles --setup` and `omd-package profiles --model NAME`. The
[`omd_profiles` README](../mods/first-party/omd_profiles/README.md) lists every command and limit.

## Use Cursor

1. Turn on `omd_cursor` in `/mods` and approve its trust dialog.
2. Run setup:

   ```text
   /cursor setup
   ```

   Setup installs the Cursor SDK with `pnpm`, then opens Cursor's browser sign-in. Approve "Oh My Diff" there.
3. Pick a Cursor model in `/model`.

Run `/cursor setup NAME` to add another account, and `/cursor setup` again when the key expires. The
[`omd_cursor` README](../mods/first-party/omd_cursor/README.md) explains how a turn runs and how Cursor bills it.

## Switch between accounts

With `omd_profiles` on, `/profile` lists every account from every provider, including the Claude and Cursor accounts
that `omd_claude_cli` and `omd_cursor` hold, with the limits each one last reported. Alt+s or `/profile next`
switches to the next one.

## Run subagents on another provider

Turn on `omd_subagent_router` and name the model in your prompt, for example "use sonnet 5.5 as subagents to
research". The provider must already be set up. The
[`omd_subagent_router` README](../mods/first-party/omd_subagent_router/README.md) covers per-role settings and
background workers.

## See also

- [Included mods](collection.md)
- [Troubleshooting](troubleshooting.md)
