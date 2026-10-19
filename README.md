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
  <a href="docs/collection.md">Included mods</a> ·
  <a href="docs/write-a-mod.md">Write a mod</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

Oh My Diff (OMD) is [Codex CLI](https://github.com/openai/codex) with a host for TypeScript mods: new commands,
tools, context and screens. You still run `codex`, with your settings, sign-in and sessions.

## Install

Needs an Apple Silicon Mac, Codex `0.163.x`, Node 24 and Python 3.12+ ([details](docs/install.md#before-you-begin)).

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/dzkchen/oh-my-diff/releases/latest/download/install.sh | sh -s -- --profile full
```

`--profile full` is OMD+ (OMD plus the [mod collection](docs/collection.md)); `--profile platform` is OMD Core.
[Update, switch profile and uninstall](docs/install.md).

## First run

```sh
codex
```

Type `/mods` to see which mods are on and turn others on or off. If `codex` is still plain Codex, add the
`export PATH=...` line the installer printed to your shell profile and open a new shell. To check the install, run
`omd update status`.

## Status

**Personal tool.** OMD is built for the creator's own workflow and has not been pressure-tested across other
devices or workflows. If something breaks, [open an issue](https://github.com/dzkchen/oh-my-diff/issues/new/choose).

**Why it exists.** Small, everyday improvements to a developer's workflow get less attention than the larger priorities
of frontier labs. OMD is a place for them.

**Maintenance.** After release the creator expects to focus mainly on critical fixes. Anyone prepared to take over
responsible maintenance is welcome to get in touch (open an issue).

**Beta.** `1.0.0` is labeled beta: not every planned capability is included yet. The label does not mean unstable.
Mod API `1.0.0` is stable; surfaces marked experimental can change ([compatibility](mods/COMPATIBILITY.md)).

**Codex versions.** OMD follows the latest stable Codex; each release supports one version line, now `0.163.x`. Turn off automatic Codex updates,
and update Codex only after `omd update` supports the new version.

## Help and contributing

- Bug or docs problem: [open an issue](https://github.com/dzkchen/oh-my-diff/issues/new/choose).
- Security problem: [report it privately](SECURITY.md), not in a public issue.
- Missing API for a mod: [request it](https://github.com/dzkchen/oh-my-diff/issues/new?template=mod-api.yml).
- Code or docs change: see [CONTRIBUTING.md](CONTRIBUTING.md). New features are best written as mods.

## Docs

- [Install, update, remove](docs/install.md)
- [Included mods](docs/collection.md) and [manage mods](docs/manage-mods.md)
- [Write a mod](docs/write-a-mod.md), [API reference](mods/reference/README.md) and [agent mod guide](docs/AGENT_MOD_GUIDE.md)

Oh My Diff is not affiliated with or endorsed by OpenAI.

[Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) ·
[MIT License](LICENSE) ([Codex patch notice](NOTICE)) · [Third-party notices](THIRD_PARTY_NOTICES.md)
