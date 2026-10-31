# Install Oh My Diff

How to install, update, switch install profile and uninstall Oh My Diff (OMD). If something fails, see
[troubleshooting](troubleshooting.md).

## Before you begin

- An Apple Silicon Mac. Other platforms are unsupported, and the installer refuses them.
- Codex `0.165.x`. Don't update Codex until OMD supports the new version.
- Python 3.12 or later. macOS ships 3.9.

Check your Codex version:

```sh
codex --version
```

If Codex is missing or on another version, install `0.165.x`:

```sh
npm install -g @openai/codex@0.165
```

If your Python is older than 3.12, install a newer one:

```sh
brew install python@3.12
```

Some mods and the mod author tools also need Node. [Support](support.md) lists which versions.

## Choose an install profile

An install profile sets which mods the installer adds. There are two:

- OMD+ (`--profile full`) is OMD plus the [included mods](collection.md). Some start on, and you turn on the rest
  with `/mods`.
- OMD Core (`--profile platform`) is only the mod host, the part of OMD that loads mods. You get the `/mods` screen,
  update notices and the OMD logo. Choose it to add only the mods you pick, or to write your own.

## Install

For OMD+:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/dzkchen/oh-my-diff/releases/latest/download/install.sh | sh -s -- --profile full
```

For OMD Core, use `--profile platform` instead. The [installer options](commands.md#installer-installsh) choose the
release channel, the install folders and the Codex executable.

Installs and updates check the release signature and checksum. Commands go in `~/.local/bin`. Your Codex settings,
sign-in and sessions aren't touched.

To check it worked, run:

```sh
omd update status
```

It prints details of your install as JSON, then a summary line like this one:

```text
Oh My Diff VERSION (OMD+), stable channel, daily checks: not checked yet
```

The line names the installed version, the install profile, the release channel and the check cadence. It ends with
`up to date`, `not checked yet`, `the last check failed: ERROR`, or the version you can update to.

Then run `codex` and type `/mods`. The `/mods` screen lists your installed mods and which ones are on.

## Update

```sh
omd update            # install the newest release
omd update rollback   # undo the last update
omd update enable     # install updates automatically
```

While other OMD sessions are open, the update waits for your next `codex` start. Mods, settings and sign-in are
kept. If a mod you turned on doesn't support the new mod API, `omd update` asks before it updates. Pass `--yes` to
update anyway.

To change how updates work, such as the release channel, the check cadence or a version pin, use `/update` in
`codex` or the [`omd update` commands](commands.md#omd-itself).

## Switch install profile

Rerun the install command with the other `--profile`. Each install profile keeps its own mod choices.

`direct` isn't an install profile. It's a recovery state in which `codex` behaves as plain Codex with no mods. If a
mod breaks `codex`, switch to it with `omd-package`, the tool that manages your install profile and the mods it came
with:

```sh
omd-package activate direct
```

[Troubleshooting](troubleshooting.md#a-mod-breaks-codex) lists the other ways to turn off a broken mod.

## Uninstall

If you installed the authority broker, an optional macOS service that protects credentials, remove it first.
[Trust and permissions](trust-and-permissions.md#protect-credentials-with-the-authority-broker) describes it.

```sh
omd-package broker uninstall
```

Then remove OMD:

```sh
omd uninstall
```

This removes OMD and its Codex plugins, and puts back any command in `~/.local/bin` that the installer renamed to
`NAME.before-omd`. Codex data stays. Mod settings stay in `~/.local/share/oh-my-diff/stores`. Delete that folder to
remove them.

If the `omd` command is gone, run OMD's management script directly. It also takes `status` and `rollback`:

```sh
sh ~/.local/share/oh-my-diff/current/prefix/management/install.sh uninstall
```

To build OMD from source, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Next steps

- See what's in OMD+: [included mods](collection.md).
- Install and turn on more mods: [Manage mods](manage-mods.md).
- Use Claude, Cursor or an API key: [use other providers](use-other-providers.md).
