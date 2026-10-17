<p align="center">
  <img src="docs/banner.png" alt="Oh My Diff. Keep Codex. Mod everything." width="100%">
</p>

<h1 align="center">Oh My Diff</h1>

<p align="center">
  <a href="https://github.com/dzkchen/oh-my-diff/releases"><img src="https://img.shields.io/github/v/release/dzkchen/oh-my-diff?include_prereleases&label=release&color=2f9e5a" alt="Latest release"></a>
  <a href="https://github.com/dzkchen/oh-my-diff/actions/workflows/nightly.yml"><img src="https://img.shields.io/github/actions/workflow/status/dzkchen/oh-my-diff/nightly.yml?branch=main&label=nightly" alt="Nightly build"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2f9e5a" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/macOS-Apple%20Silicon-16181d?logo=apple" alt="macOS on Apple Silicon">
</p>

<p align="center"><b>Codex CLI, extended with TypeScript mods.</b></p>

<p align="center">
  <a href="docs/install.md">Install</a> ·
  <a href="docs/collection.md">Included mods</a> ·
  <a href="docs/write-a-mod.md">Write a mod</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

Oh My Diff (OMD) is [Codex CLI](https://github.com/openai/codex) with TypeScript mods: new commands, tools, context
and screens. You still run `codex`, with your settings, sign-in and sessions.

## Quickstart

Needs an Apple Silicon Mac, Codex `0.163.x`, Node 24 and Python 3.12+ ([details](docs/install.md#before-you-begin)).

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/dzkchen/oh-my-diff/releases/latest/download/install.sh | sh -s -- --profile full
codex
```

Type `/mods` to see and turn on mods. Still plain Codex? Add the `export PATH=...` line the installer printed to
your shell profile.

## Docs

- [Install, update, remove](docs/install.md)
- [Included mods](docs/collection.md) · [Manage mods](docs/manage-mods.md)
- [Write a mod](docs/write-a-mod.md) · [API reference](mods/REFERENCE.md) · [Agent mod guide](docs/AGENT_MOD_GUIDE.md)

## Status

**Beta:** not every planned feature is here yet; it isn't unstable. More mods are coming
([planned](docs/collection.md#not-in-this-release)).

**Codex versions:** OMD tracks the latest stable Codex, one version line per release (now `0.163.x`). Turn off
automatic Codex updates, and update Codex only after `omd update` supports the new version.

**Help:** OMD is a personal tool, not tested widely.

- Bug: [open an issue](https://github.com/dzkchen/oh-my-diff/issues/new/choose)
- Security problem: [report privately](SECURITY.md)
- Missing API for a mod: [request it](https://github.com/dzkchen/oh-my-diff/issues/new?template=mod-api.yml) or
  [send a PR](CONTRIBUTING.md)
- Want to help maintain it? Get in touch.

Oh My Diff is not affiliated with or endorsed by OpenAI.

[Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) ·
[MIT License](LICENSE) ([Codex patch notice](NOTICE)) ·
[Third-party notices](THIRD_PARTY_NOTICES.md)
