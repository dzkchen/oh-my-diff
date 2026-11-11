# Install Oh My Diff

Install Oh My Diff (OMD) with the command below, then run `codex`. This guide also covers updates, install profiles
and removal. For errors, see [troubleshooting](troubleshooting.md).

## Before you begin

- An Apple Silicon Mac. Other platforms are unsupported, and the installer refuses them.
- Codex 0.167 (any 0.167.x). Don't update Codex until OMD supports the new version.
- Python 3.12 or later. macOS ships 3.9.

If Codex is missing or on another version, the installer stops before installing anything (it leaves only an empty
`~/.local/share/oh-my-diff/.install.lock`) and prints the command that installs the right one. Installing Codex with npm needs Node and npm:

```sh
npm install -g @openai/codex@0.167
```

Homebrew's Codex (`brew install --cask codex`) works too while its version is 0.167.x.

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

The installer checks the release signature and checksum and puts commands in `~/.local/bin`. Updates check the same
signature and checksum. Both preserve your Codex sign-in, sessions and settings.

If you run `omd-package plugins`, it adds a `[marketplaces.oh-my-diff]` table to `~/.codex/config.toml`.
`omd uninstall` removes that table.

OMD adds two kinds of extension to Codex. Mods change the `codex` interface and behavior, and you manage them with
`/mods` and `omd`. Plugins are ordinary Codex plugins of skills and tools that you add with `codex plugin add`; OMD+
ships one ([plugins](../plugins/README.md)).

If OMD's `codex` isn't the first one on your `PATH`, the installer asks once whether to put `~/.local/bin` first in
your shell's startup file (`~/.zshrc`, `~/.bash_profile` or `~/.config/fish/config.fish`). It adds a block between
`# >>> oh my diff >>>` and `# <<< oh my diff <<<`, which `omd uninstall` removes. Answer `n`, or install without a
terminal, and it prints the line to add instead.

To check it worked, run:

```sh
omd update status
```

It prints one summary line like this one (`--json` prints the details as JSON instead):

```text
Oh My Diff VERSION (OMD+), stable channel, daily checks: not checked yet
```

The line names the installed version, the install profile, the release channel and the check cadence. It ends with
`up to date`, `not checked yet`, `the last check failed: ERROR`, `first-party mod updates are available`,
`VERSION can't be installed: REASON`, `rolled back from VERSION`, `update checks off`, or the version you can update
to. A pinned install adds `, pinned to VERSION`. If the installed
release was withdrawn, it adds `VERSION was withdrawn` and, when one helps, the command to run: `omd update` or `omd update rollback`.

Then open a new terminal, run `codex` in any folder and type `/mods`. The `/mods` screen lists your installed mods and
which ones are on. Esc closes it; if you typed a search, the first Esc clears the search.

## Update

```sh
omd update            # install the newest release, or the newest first-party mod updates
omd update rollback   # undo the last update
omd update enable     # install updates automatically
```

While other OMD sessions are open, the update waits for your next `codex` start. It keeps your mods, settings and
sign-in. After the update, `omd update`, the next `codex` start and `/update` report retired mods, new defaults left
off for your install, and permissions that first-party mods gained.

If an enabled mod doesn't support the new mod API, `omd update` asks before updating. Pass `--yes` to update anyway.
If the release can't be installed, for example because your Codex version differs or its executable fails,
`omd update` exits with an error that names the reason.

`omd update`, `omd uninstall` and the installer's `status` print text; add `--json` for JSON.

When an OMD+ release moves a mod it came with to experimental, the update turns that mod off once and leaves it
installed. Turn it back on in `/mods` if you want it; later updates leave it as you set it. Mods you installed
yourself are never turned off.

A release or a first-party mod update also updates the first-party mods you installed from the catalog, with
`omd install ID` or from the Available group in `/mods`, and leaves each on or off as it was. A mod that asks for a
new permission or changes how it stores its data isn't updated. The update names it, and `omd mods update ID` shows
what changes before you approve it.

Between releases, OMD can publish first-party mod fixes separately. These updates keep your OMD version and leave
each mod on or off as it was. `omd update` installs them when no newer release is out; `/update` also offers them.
Automatic updates download them in the background and apply them when no other OMD session is open.

A version pin disables these mod updates. `omd update rollback` undoes the last update. A first-party mod that needs
a newer OMD waits for the next release.

To change how updates work, such as the release channel, the check cadence or a version pin, use `/update` in
`codex` or the [`omd update` commands](commands.md#omd-itself).

## Switch install profile

Rerun the install command with the other `--profile`. Each install profile keeps its own mod choices. A profile you
install for the first time starts with your update settings (checks, cadence, channel, pin and automatic updates).
`omd-package activate` doesn't switch profiles; it only turns the installed profile's mods back on after `direct`.

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

To remove an administrator policy and its rollback copy too, run `omd-package broker uninstall --purge` instead.
This needs `sudo` and also works after the broker itself has been removed. A complete purge below requires this
step whenever those policy files remain.

Then remove OMD:

```sh
omd uninstall
```

This removes OMD, its release and catalog caches, its Codex plugins and the `PATH` block it added, and puts
back any command in `~/.local/bin` that the installer renamed to `NAME.before-omd`. Codex settings, accounts and
sessions stay.
OMD mod settings, data and saved sign-ins stay in `~/.local/share/oh-my-diff/stores` by default.

To remove OMD's mod data and saved sign-ins too, use this instead:

```sh
omd uninstall --purge
```

This removes both install profiles' stores. Shared Codex data and mods' source folders outside the install root
stay. OMD's named Claude accounts are signed out with `claude auth logout` before their directories and Keychain
items are removed; your shared/default Claude Code login stays. Keep the Claude CLI installed until this finishes.
If sign-out fails, purge stops and keeps the account directories for retry. Cursor's private agent data and cache
under `/private/tmp/omd-cursor-UID` are removed too.

An empty `releases` folder and the installer coordination lock can remain; keeping the lock prevents an
already waiting installer from racing another installation. Remove the authority broker first if deployed.

If the `omd` command is gone, run OMD's management script directly. It also takes `status` and `rollback`:

```sh
sh ~/.local/share/oh-my-diff/current/prefix/management/install.sh uninstall
```

To build OMD from source, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Next steps

- See what's in OMD+: [included mods](collection.md).
- Install and turn on more mods: [Manage mods](manage-mods.md).
- Use Claude, Cursor or an API key: [use other providers](use-other-providers.md).
- Use OMD's mods in T3 Code: [use OMD with T3 Code](use-with-t3-code.md).
