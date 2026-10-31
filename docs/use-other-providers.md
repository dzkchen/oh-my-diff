# Use other providers

How to use Claude, Cursor, an API key or another compatible provider in `codex`, and how to switch between
accounts. Each provider needs a mod, and these mods are off by default in OMD+. Turn one on as
[Manage mods](manage-mods.md) describes.

| You want | Turn on | Needs |
| --- | --- | --- |
| Claude models on your Claude plan or Console API credits | `omd_claude_cli` | Claude CLI `2.1.307` or later and Node on your `PATH` |
| Several ChatGPT accounts, an OpenAI or Anthropic API key, or another provider by URL | `omd_profiles` | Node on your `PATH` |
| Cursor models on your Cursor account | `omd_cursor` | Node and `pnpm` on your `PATH` |

[Support](support.md#versions) lists the Node version these mods need.

When you turn one of these mods on, it asks to run `node` outside the sandbox, and `omd_claude_cli` also asks to run
`claude`. [Trust and permissions](trust-and-permissions.md#authority-grants) explains what that allows.

## Use Claude

1. In `codex`, turn on `omd_claude_cli` in `/mods` and approve its trust dialog.
2. Sign in. For your Claude plan (Pro, Max, Team or Enterprise):

   ```text
   /claude login
   ```

   For Console API credits, run `/claude login api` instead. Finish signing in in the browser. If the page shows a
   code, run `/claude code CODE`. When sign-in finishes, the session prints a line like this one:

   ```text
   Claude account default (EMAIL) is ready on your subscription; pick its models with /model or switch with /profile
   ```

   With `api`, it says `Console API credits` instead of `your subscription`.
3. Pick a Claude model in `/model`. The conversation (thread) switches to Claude from your next message and keeps
   its history.

To add another Claude account, run `/claude login NAME`. `/claude` shows the CLI version, each account's sign-in
and whether its models are published. The [`omd_claude_cli` README](../mods/first-party/omd_claude_cli/README.md)
covers billing, several accounts and limits.

## Use an API key or another provider

1. Turn on `omd_profiles` in `/mods`.
2. Add an account:

   ```text
   /profile add
   ```

   Pick a ChatGPT account, a Claude or Cursor account, an OpenAI or Anthropic API key, a local Ollama (no key, no allowance; `http://localhost:11434/v1`), or another provider by URL.
   Sign-in and key entry happen in the session. The first time you add a paid key, the session asks for a spending
   allowance in USD. When the account is added, the session prints `Added NAME.` and how to switch to it.
3. Switch with `/profile`, `/profile use NAME`, or Alt+s for the next account.

Alt+s needs Option-as-Alt in Kitty and Ghostty; `/profile next` works in every terminal.

To start a session on an account profile from a shell, use `omd-package`, the tool that manages your install profile
and its mods. Run `omd-package profiles --setup` or `omd-package profiles --model NAME`. `omd-package profiles --help`
lists the other flags. The [`omd_profiles` README](../mods/first-party/omd_profiles/README.md) lists every command and
limit.

## Use Cursor

`omd_cursor` isn't yet verified on a live Cursor account.

1. Turn on `omd_cursor` in `/mods` and approve its trust dialog.
2. Run setup:

   ```text
   /cursor setup
   ```

   Setup installs the Cursor SDK with `pnpm`, then opens Cursor's browser sign-in. Approve "Oh My Diff" there.
   When setup finishes, the session prints `Cursor account NAME is ready` and how to pick its models.
3. Pick a Cursor model in `/model`.

Run `/cursor setup NAME` to add another account, and `/cursor setup` again when the key expires. The
[`omd_cursor` README](../mods/first-party/omd_cursor/README.md) explains how a turn runs and how Cursor bills it.

## Switch between accounts

With `omd_profiles` on, `/profile` lists every account from every provider, including the Claude and Cursor accounts
that `omd_claude_cli` and `omd_cursor` add, with the limits each one last reported. Alt+s or `/profile next`
switches to the next one.

## Run subagents on another provider

Subagents are helper agents the main agent starts for part of a task. Turn on `omd_subagent_router` and name the
model in your prompt, for example "use sonnet 5.5 as subagents to research". The provider must already be set up. The
[`omd_subagent_router` README](../mods/first-party/omd_subagent_router/README.md) covers per-role settings and
background workers.

## See also

- [Included mods](collection.md)
- [Troubleshooting](troubleshooting.md)
