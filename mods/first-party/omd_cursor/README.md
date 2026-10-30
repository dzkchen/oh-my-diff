# omd_cursor

Lets a session use Cursor models through your Cursor account and the official
[Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript). It's off by default in OMD+, and it isn't yet
verified on a live Cursor account. OMD Core doesn't include it.

## Turn it on

Turn it on in `/mods` and approve its trust dialog, or run:

```sh
omd-package mod enable omd_cursor
```

It asks to run `node` outside the sandbox (`os`), because setup installs the SDK, reaches the network and writes the
mod store. Then run `/cursor setup` in a session.
[Use Claude or another provider](../../../docs/use-other-providers.md) walks through enrollment, the API key and
several accounts. [Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or
off.

## Use it

| Command | What it does |
| --- | --- |
| `/cursor setup [NAME]` | Install the SDK, enroll in the browser, list models and publish them to `/model` (`/cursor login` is the same); `NAME` adds another account |
| `/cursor remove NAME` | Drop an account's models and route, and ask to remove OMD's copy of its key. The key itself stays valid at Cursor until you revoke "Oh My Diff" under API keys in your Cursor dashboard |
| `/cursor` | Show the SDK version, each account and its key expiry, published models and posture |
| `/cursor usage` | Show each recent run's raw list cost and charged cost, runs still unsettled, and the plan snapshot |
| `/model` | Pick a Cursor model; the thread switches provider from its next turn and keeps its history |

An account `NAME` starts with a lowercase letter, then lowercase letters, digits, `_` or `-`, at most 24 characters.
For example, `/cursor setup work` enrolls a second account, whose models appear in `/model` as `cursor-auto.work`.

Run `/cursor setup` again when the key expires or after changing the SDK dependencies. Each run is a fresh enrollment
that replaces the stored key. A denied, abandoned or timed-out login leaves any existing enrollment untouched.

Setup gives up after 30 minutes overall, 2 minutes for the `pnpm` install and 10 minutes for handing the key to
`omd-mod` (which can wait for your authorization). Each timeout says to run `/cursor setup` again.

## Settings

It has no settings.

## Needs and limits

- Node 22.18 or later and `pnpm` on your `PATH`, and `omd-mod` (the installer links it into `~/.local/bin`). The SDK
  isn't bundled: setup installs `@cursor/sdk@1.0.35`, and Cursor's license applies.
- The API key is held by the authority broker for `omd_cursor`. It never touches disk, and the mod and the model never
  receive it.
- The SDK dependency tree is pinned in the service grant and launched from a private snapshot. A custom SDK
  entrypoint (`node setup.mjs SDK_ENTRY`, for tests) must live in a dedicated directory separate from the mod store;
  setup refuses one that contains the store.
- Admitted requests count toward `host.json` `limits.requests`. The route is provider-billed, so the host reserves no
  exposure for them.
- The SDK runs locally, with no cloud agent and no repository upload. Cursor's built-in tools, `.cursor` settings,
  rules and MCP servers are off, so the agent reaches your repository only through OMD tools, under OMD's sandbox,
  approvals and mods. Hosted web search isn't offered.
- Cursor keeps its own system prompt and context; Codex's base instructions aren't sent. Pending tool calls expire
  after ten minutes. Interrupting Codex, or sending a new message while tools are pending, cancels the Cursor run.
- At most 16 models are listed across accounts, each account's default first. The catalog assumes a 200K-token
  context window.
- Cursor settles billed cost minutes after a run ends. The charge then appears in `/status`. A zero charge can mean
  plan-included, BYOK or credit-grant usage; the SDK doesn't say which.
- Plan usage, shown beside the account in `omd_profiles`, is read at most once a minute after a run, so it can be a
  run behind. It comes from an undocumented Cursor dashboard call that may break with any SDK update.
- When Cursor refuses a request for plan usage or rate limits, the turn fails as `rate_limit_exceeded`. OMD never
  falls back to another route or a paid API key.
- With the mod off, nothing runs. On, in a session on another provider, it only republishes the models at start. In
  a Cursor session it also reads the usage log after each turn, then once a minute for six minutes.

## More

- [Use Claude or another provider](../../../docs/use-other-providers.md)
- [Included mods](../../../docs/collection.md)
- [`omd_profiles`](../omd_profiles/README.md) switches between accounts
- [Routes](../../reference/routes.md) and [credentials](../../reference/credentials.md) in the mod API
  reference
