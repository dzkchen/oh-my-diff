<p align="center">
  <img src="docs/banner.gif" alt="Oh My Diff. Keep Codex. Mod everything." width="100%">
</p>

<h1 align="center">Oh My Diff</h1>

<p align="center">
  <a href="https://github.com/dzkchen/oh-my-diff/releases"><img src="https://img.shields.io/github/v/release/dzkchen/oh-my-diff?label=release&color=2f9e5a" alt="Latest release"></a>
  <a href="https://github.com/dzkchen/oh-my-diff/actions/workflows/nightly.yml"><img src="https://img.shields.io/github/actions/workflow/status/dzkchen/oh-my-diff/nightly.yml?branch=main&label=nightly" alt="Nightly build"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2f9e5a" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/macOS-Apple%20Silicon-16181d?logo=apple" alt="macOS on Apple Silicon">
</p>

<p align="center"><b>Codex CLI, extended with TypeScript mods.</b></p>

<p align="center">
  <a href="https://www.ohmydiff.me">Website</a> ·
  <a href="docs/install.md">Install</a> ·
  <a href="docs/README.md">Docs</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

Oh My Diff (OMD) is [Codex CLI](https://github.com/openai/codex) with a host for TypeScript mods: new commands,
tools, context and screens. You still run `codex`, with your settings, sign-in and sessions, and you can go back to
plain Codex at any time with nothing to migrate.

A mod can add a slash command, give the model a new tool, add context to a request, draw a status line, a panel or a
dialog, or react when the agent runs a tool. Installing a mod doesn't turn it on, and OMD shows what a mod may do
before you allow it. [How OMD works](docs/how-omd-works.md) explains the design, and
[trust and permissions](docs/trust-and-permissions.md) explains what a mod can and can't do.

## Install

You need an Apple Silicon Mac, Codex `0.165.x` already installed, and Python 3.12 or later. The
[install guide](docs/install.md) lists every requirement.

There are two installs. Pick one; you can switch later by running the other command.

OMD+ (`--profile full`) is OMD plus the [included mods](docs/collection.md). A status line, compact tool output, a
pinned plan, a model picker and more are on from the start, and the rest are a click away in `/mods`. Most people
want this one.

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/dzkchen/oh-my-diff/releases/latest/download/install.sh | sh -s -- --profile full
```

OMD Core (`--profile platform`) is only the mod host: the `/mods` screen, update notices and the OMD mark. Codex
otherwise looks and behaves as it always has. Choose it to add only mods you pick yourself, or to write your own.

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/dzkchen/oh-my-diff/releases/latest/download/install.sh | sh -s -- --profile platform
```

## First run

```sh
codex
```

Type `/mods` to see which mods are on and to turn others on or off. Run `omd` in a shell for the commands you can use
outside `codex`. If `codex` still starts plain Codex, see [troubleshooting](docs/troubleshooting.md).

## Where to go next

Use OMD:

- [Install, update, switch profile or uninstall](docs/install.md)
- [Included mods](docs/collection.md) and [Manage mods](docs/manage-mods.md)
- [Use Claude, Cursor or an API key](docs/use-other-providers.md)
- [Troubleshooting](docs/troubleshooting.md)

Build a mod:

- [Write your first mod](docs/mod-authors/first-mod.md)
- [Agent mod guide](docs/AGENT_MOD_GUIDE.md), for coding agents
- [Mod API reference](mods/reference/README.md)

Contribute:

- [Contributing](CONTRIBUTING.md)
- [Report a security problem](SECURITY.md) privately, not in a public issue

The [docs index](docs/README.md) lists every page.

## Status

OMD is in beta, so expect bugs and rough edges. Mod API `1.0.0` is stable; surfaces marked experimental can change
([support policy](docs/support.md)). The API is young, so if a mod needs a capability that's missing,
[request it](https://github.com/dzkchen/oh-my-diff/issues/new?template=mod-api.yml). For bugs and docs problems,
[open an issue](https://github.com/dzkchen/oh-my-diff/issues/new/choose). If you want to become a core contributor,
open an issue and say so. New features are best written as mods.

Oh My Diff is not affiliated with or endorsed by OpenAI.

[Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) ·
[MIT License](LICENSE) ([Codex patch notice](NOTICE)) · [Third-party notices](THIRD_PARTY_NOTICES.md)
