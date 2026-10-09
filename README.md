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

Oh My Diff (OMD) is a patched [Codex CLI](https://github.com/openai/codex). Mods can change its commands, tools,
context and screen. OMD ships with a small set of mods, and you can write your own. You still start it with
`codex`, and it keeps your Codex settings, sign-in and sessions.

## Quickstart

You need an Apple Silicon Mac with Codex `0.162.x`, Node 24.18+ and Python 3.12+ installed.

1. Install OMD with its mod collection:

   ```sh
   curl --proto '=https' --tlsv1.2 -fsSL https://github.com/dzkchen/oh-my-diff/releases/latest/download/install.sh | sh -s -- --profile full
   ```

2. Start it:

   ```sh
   codex
   ```

3. Type `/mods` to see which mods are on and to turn others on.

For the minimal install, other options, updates and removal, see [Install Oh My Diff](docs/install.md).

## Learn more

- [Mods included with OMD+](docs/collection.md)
- [Install and manage mods](docs/manage-mods.md)
- [Write your first mod](docs/write-a-mod.md)
- [Mod API reference](mods/REFERENCE.md)

## Project status

OMD is a personal developer tool. It hasn't been tested across many machines or workflows, so expect rough edges.
If something breaks, please [open an issue](https://github.com/dzkchen/oh-my-diff/issues/new/choose).

OMD exists because small, everyday workflow improvements get less attention than bigger AI-lab priorities. After
release, the maintainer plans to focus mainly on critical fixes. If you'd like to take over maintenance, get in
touch.

Oh My Diff is not affiliated with or endorsed by OpenAI.

[Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) ·
[Code of conduct](CODE_OF_CONDUCT.md) · [MIT License](LICENSE) ([Codex patch notice](NOTICE)) ·
[Third-party notices](THIRD_PARTY_NOTICES.md)
