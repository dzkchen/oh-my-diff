<p align="center">
  <img src="docs/banner.gif" alt="Oh My Diff. Keep Codex. Mod everything." width="100%">
</p>

<h1 align="center">Oh My Diff</h1>

<p align="center">
  <a href="https://github.com/dzkchen/oh-my-diff/releases"><img src="https://img.shields.io/github/v/release/dzkchen/oh-my-diff?label=release&color=2f9e5a" alt="Latest release"></a>
  <a href="https://github.com/dzkchen/oh-my-diff/actions/workflows/nightly.yml"><img src="https://img.shields.io/github/actions/workflow/status/dzkchen/oh-my-diff/nightly.yml?branch=main&label=nightly" alt="Nightly build"></a>
  <a href="https://github.com/dzkchen/oh-my-diff"><img src="https://img.shields.io/github/stars/dzkchen/oh-my-diff?style=flat&label=%E2%98%85&color=2f9e5a" alt="GitHub stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2f9e5a" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/macOS-Apple%20Silicon-16181d?logo=apple" alt="macOS on Apple Silicon">
  <img src="https://img.shields.io/badge/Rust-16181d?logo=rust" alt="Rust">
</p>

<p align="center">
  <strong>Keep Codex. Mod everything.</strong><br/>
  <a href="https://github.com/openai/codex">Codex CLI</a> with a host for TypeScript mods: add commands, tools, context and screens without leaving <code>codex</code>.
</p>

<h3 align="center"><a href="#install"><ins>Install Oh My Diff</ins></a></h3>

<p align="center">
  <a href="https://www.ohmydiff.me">Website</a> ·
  <a href="docs/README.md">Docs</a> ·
  <a href="docs/collection.md">Mods</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

You still run `codex`, with your settings, sign-in and sessions, and you can go back to plain Codex at any time with
nothing to migrate. OMD is in beta and runs only on Apple Silicon macOS.

## What a mod can do

A mod is a small TypeScript program. It can add a slash command, give the model a new tool, add context to a request,
draw a status line, panel or dialog, or react when the agent runs a tool. Before a mod runs, OMD shows its source,
license and the permissions it asks for. You control which mods run, subject to any administrator policy.

[How OMD works](docs/how-omd-works.md) · [Trust and permissions](docs/trust-and-permissions.md) ·
[Write your first mod](docs/mod-authors/first-mod.md)

## Included mods

OMD+ comes with these, among others:

- **[Grouped tool lines](mods/first-party/omd_tool_lines/README.md)**: adjacent shell commands collapse into one row; open it for the full output.
- **[Status line](mods/first-party/omd_statusline/README.md)**: configurable, edited with `/statusline`.
- **[Privacy](mods/first-party/omd_privacy/README.md)**: redacts text that matches its secret and personal-data rules in requests sent to the model. Web search, transcripts and logs aren't covered (off; turn on in `/mods`).
- **[Usage](mods/first-party/omd_usage/README.md)**: context, cache, cost and quota by request (off; turn on in `/mods`).
- **[Auto-continue](mods/first-party/omd_auto_continue/README.md)**: off until you turn it on; an unanswered approval or question no longer stalls the turn.

Experimental mods add other providers, a workspace dock, `/undo` and language-server feedback. The
[included mods](docs/collection.md) page lists every one and says which are on by default and which are experimental.

## Works with

<p>
  <a href="https://github.com/openai/codex"><kbd>Codex CLI</kbd></a> &nbsp;
  <a href="docs/use-other-providers.md#use-claude"><kbd>Claude (experimental)</kbd></a> &nbsp;
  <a href="docs/use-other-providers.md#use-cursor"><kbd>Cursor (experimental)</kbd></a> &nbsp;
  <a href="docs/use-other-providers.md#use-an-api-key-or-another-provider"><kbd>OpenAI and Anthropic API keys (experimental)</kbd></a> &nbsp;
  <a href="docs/use-with-t3-code.md"><kbd>T3 Code (experimental)</kbd></a> &nbsp;
  <kbd>+ any app that runs <code>codex app-server</code></kbd>
</p>

## Install

You need an Apple Silicon Mac, Codex 0.167 (`npm install -g @openai/codex@0.167`, which needs Node, or Homebrew's
Codex while it's on 0.167.x) and Python 3.12 or later. The [install guide](docs/install.md) lists every requirement.

### OMD+ (recommended)

The mod host plus the [included mods](docs/collection.md).

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/dzkchen/oh-my-diff/releases/latest/download/install.sh | sh -s -- --profile full
```

### OMD Core

Only the mod host: the `/mods` screen, update notices and the OMD logo. Codex otherwise looks and behaves as it
always has. Choose it to add only mods you pick yourself, or to write your own.

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/dzkchen/oh-my-diff/releases/latest/download/install.sh | sh -s -- --profile platform
```

You can switch later by running the other command.

### First run

```sh
codex
```

Run it in any folder. Codex asks you to sign in if you haven't before, then shows the OMD logo. Type `/mods` to see which mods are on and
to turn others on or off; Esc closes it. Outside
`codex`, run `omd` for a short summary of the commands that install, update and manage mods. If `codex` still starts
plain Codex, see [troubleshooting](docs/troubleshooting.md).

## Status

OMD is in beta; expect bugs. Mod API `1.0.0` is stable, while entries marked experimental can change
([support policy](docs/support.md)). Experimental mods need more testing and fixes; contributions are welcome.

## Community and support

- **Missing a capability?** The API is young: [request it](https://github.com/dzkchen/oh-my-diff/issues/new?template=mod-api.yml). New features are best written as mods.
- **Bugs and docs problems:** [open an issue](https://github.com/dzkchen/oh-my-diff/issues/new/choose), or see [troubleshooting](docs/troubleshooting.md) first.
- **Security:** [report it privately](SECURITY.md), not in a public issue.
- **Core contributor:** open an issue and say so.
- **Show support:** [star](https://github.com/dzkchen/oh-my-diff) the repo to follow along.

## Developing

See [CONTRIBUTING.md](CONTRIBUTING.md) to run OMD locally or send a change, the [mod API reference](mods/reference/README.md)
for the full API, and the [agent mod guide](docs/AGENT_MOD_GUIDE.md) for coding agents writing mods.

OMD is upstream Codex plus [one patch](runtime/patches) pinned to a single Codex release. The patch adds a mod host
that has no features of its own; every feature is a TypeScript mod running in its own sandboxed runner process.

```mermaid
flowchart LR
  subgraph codex["codex process (Codex + OMD patch)"]
    direction TB
    upstream["Codex CLI<br/>threads, turns, tools, TUI"]
    ext["codex-omd-extension<br/>runtime/native"]
    host["codex-omd mod host<br/>runtime/omd"]
    upstream <--> ext <--> host
  end
  subgraph runners["omd-runner processes (embedded V8, macOS sandbox)"]
    direction TB
    a["mod package A"]
    b["mod package B"]
  end
  host <-->|"callbacks / host calls<br/>checked against granted permissions"| a
  host <--> b
  mods["TypeScript mods<br/>mods/first-party, your own"] -. loaded into .-> runners
```

[How OMD works](docs/how-omd-works.md) explains the design and
[contributing to the patched runtime](docs/contributing/runtime.md) covers changing the Rust.

<a href="https://github.com/dzkchen/oh-my-diff/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=dzkchen/oh-my-diff" alt="Oh My Diff contributors" />
</a>

## License

Oh My Diff is free and open source under the [MIT License](LICENSE) ([Codex patch notice](NOTICE),
[third-party notices](THIRD_PARTY_NOTICES.md)). It is not affiliated with or endorsed by OpenAI.
