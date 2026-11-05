<h1 align="center">Oh My Diff</h1>

<p align="center"><b>Keep Codex. Mod everything.</b></p>

<p align="center">
  <a href="https://github.com/dzkchen/oh-my-diff/releases"><img src="https://img.shields.io/github/v/release/dzkchen/oh-my-diff?label=release&color=2f9e5a" alt="Latest release"></a>
  <a href="https://github.com/dzkchen/oh-my-diff/actions/workflows/nightly.yml"><img src="https://img.shields.io/github/actions/workflow/status/dzkchen/oh-my-diff/nightly.yml?branch=main&label=nightly" alt="Nightly build"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2f9e5a" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/macOS-Apple%20Silicon-16181d?logo=apple" alt="macOS on Apple Silicon">
</p>

<p align="center">
  <a href="https://www.ohmydiff.me">Website</a> ·
  <a href="docs/install.md">Install</a> ·
  <a href="docs/collection.md">Mods</a> ·
  <a href="docs/mod-authors/first-mod.md">Write a mod</a> ·
  <a href="docs/README.md">Docs</a>
</p>

<p align="center">
  <img src="docs/demo.gif" alt="Codex starts with the OMD logo, /mods lists five mods, a force-push is blocked by a mod, and a /standup command from the same mod writes a standup from git log" width="100%">
</p>

Oh My Diff (OMD) is [Codex CLI](https://github.com/openai/codex) with a host for TypeScript mods. A mod is a small
program that changes how the agent works: it can add a slash command, give the model a new tool, block or rewrite a
tool call, add context to a request, or draw a status line, panel or dialog.

You still run `codex`, with your settings, sign-in and sessions. To go back to plain Codex, uninstall; there's
nothing to migrate.

## Install

You need an Apple Silicon Mac, Python 3.12 or later (`brew install python@3.12`) and the Codex version the
[latest release](https://github.com/dzkchen/oh-my-diff/releases/latest) is built on. The installer prints the
command that installs the right Codex if yours is different.

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/dzkchen/oh-my-diff/releases/latest/download/install.sh | sh -s -- --profile full
```

That installs OMD+, the mod host and the [included mods](docs/collection.md). For the mod host alone (OMD Core),
use `--profile platform`. The [install guide](docs/install.md) covers updating, switching and uninstalling.

Then run `codex` as usual, and type `/mods` to turn mods on and off.

## Write a mod

This is the mod in the demo. It blocks force-pushes and adds a `/standup` command:

```ts
import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.intercept('tool', { match: { tool: 'exec_command', arguments: { cmd: /\bgit\s+push\b.*\s(--force|-f)\b/ } } },
    () => ({ deny: 'Force-pushing is off in this repo. Push to a new branch instead.' }));

  api.command('standup', () => ({ submit: 'From git log since yesterday, write my standup as three short bullets.' }),
    { description: 'Ask the agent for a standup from recent commits' });
}
```

A `mod.json` next to it names the mod and asks for the `interception` and `commands` capabilities. The full example
is in [`mods/examples/repo_rules`](mods/examples/repo_rules). [Write your first mod](docs/mod-authors/first-mod.md)
takes you from `omd-mod-author create` to a tested, installed mod in about ten minutes, and the
[agent mod guide](docs/AGENT_MOD_GUIDE.md) lets Codex write one for you.

## Included mods

OMD+ turns these on:

| Mod | What it does |
| --- | --- |
| [Tool lines](mods/first-party/omd_tool_lines/README.md) | One line per tool call, with adjacent shell commands grouped; open a row for the full output |
| [Status line](mods/first-party/omd_statusline/README.md) | Model, context, usage limits, cost, Git branch and CI status under the prompt; `/statusline` edits it |
| [Mods](mods/first-party/omd_mods/README.md) | The `/mods` screen: turn mods on or off, change their settings, install new ones |
| [Update](mods/first-party/omd_update/README.md) | Update notices, `/update`, and signed mod fixes between releases |

OMD+ also installs these for you to turn on in `/mods`:

| Mod | What it does |
| --- | --- |
| [Observation mask](mods/first-party/omd_observation_mask/README.md) | Hides old, large tool outputs so long sessions stay cheap; the model can recall any of them |
| [Usage](mods/first-party/omd_usage/README.md) | Context, cache, cost and quota for each request (Alt+a) |
| [Privacy](mods/first-party/omd_privacy/README.md) | Keeps secrets and personal data you choose out of what's sent to the model |
| [Monitor](mods/first-party/omd_monitor/README.md) | Watches a command, file or GitHub run and messages the agent once it finishes, so it doesn't poll |
| [Frecency](mods/first-party/omd_frecency/README.md) | Ranks `@` file mentions by fuzzy match and how often you use them |
| [Tool fix](mods/first-party/omd_tool_fix/README.md) | Repairs clearly malformed tool arguments before they fail |

Experimental mods, which you install with `omd install ID`, include [`/undo` and `/redo`](mods/first-party/omd_checkpoint/README.md)
for the agent's file changes, [Claude](mods/first-party/omd_claude_cli/README.md) and
[Cursor](mods/first-party/omd_cursor/README.md) models in `/model`, a [workspace](mods/first-party/omd_workspace/README.md)
with Git, shell and file panels, and [language-server errors](mods/first-party/omd_lsp_sync/README.md) after each
edit. [Included mods](docs/collection.md) lists all of them.

In a [pilot benchmark](docs/benchmarks/harness-mods.md) of 43 tasks, four of the experimental mods cut Codex's cost
by an estimated 25% (95% CI 19% to 31%) with no measurable change in pass rate. It was one model and one run, so
read it as a direction, not a guarantee.

## Status

OMD is in beta and runs only on Apple Silicon macOS. Mod API `1.0.0` is stable; the parts marked experimental can
change ([support policy](docs/support.md)). Experimental mods have known rough edges, and fixes are welcome.

- Something broken? See [troubleshooting](docs/troubleshooting.md) or [open an issue](https://github.com/dzkchen/oh-my-diff/issues/new/choose).
- A mod needs something the API doesn't have? [Request it](https://github.com/dzkchen/oh-my-diff/issues/new?template=mod-api.yml).
- Want to help? Read [Contributing](CONTRIBUTING.md). New features are best written as mods.
- Found a security problem? [Report it privately](SECURITY.md), not in a public issue.

Oh My Diff is not affiliated with or endorsed by OpenAI.

[Changelog](CHANGELOG.md) · [MIT License](LICENSE) ([Codex patch notice](NOTICE)) ·
[Third-party notices](THIRD_PARTY_NOTICES.md)
