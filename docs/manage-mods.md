# Install and manage mods

This page covers adding mods from other people and keeping them under control. For the mods that come with
OMD+, see [Mods included with OMD+](collection.md).

## Install a mod

The easiest way is `/mods` in `codex`: choose **Browse the directory**, pick a mod and review what it can do.

From a shell:

```sh
omd install npm:@author/some-mod@1.2.3
```

OMD shows where the mod comes from, its license and what it's allowed to do, then asks `Proceed? [y/N]`.

Installing doesn't turn a mod on. To turn it on:

```sh
omd mods enable some_mod
```

OMD shows what the mod can do again and asks before turning it on. It runs from your next message.

You can install from other places too:

```sh
omd install some_mod                                        # the curated directory
omd install 'git+https://github.com/author/repo#v1.2.3:mod' # a Git tag and folder
omd install ./my-mod                                        # a folder on your machine
```

## See and change your mods

```sh
omd mods list                  # installed mods and whether they're on
omd mods catalog QUERY         # search the curated directory
omd mods inspect REFERENCE     # preview a mod without installing it
omd mods update some_mod       # also: disable, remove, rollback
```

Mod settings are in `/mods`. A mod installed with `--scope project` applies only to that project and overrides
the same mod installed for you.

## When a mod misbehaves

These work from any shell, even when `codex` won't start:

```sh
omd mods disable some_mod                 # turn it off, keep its data
omd mods quarantine some_mod "reason"     # turn it off and block this version
omd-package mod disable omd_usage         # a mod that came with OMD+
```

Inside `codex`, `/omd` lists every mod with an on/off switch. It works even when `/mods` is broken.

To run plain Codex behavior with no mods at all:

```sh
omd-package activate direct
```

Return with `omd-package activate full` (or `platform` for OMD Core).

## What a mod can do to your machine

A mod asks for the permissions it needs, and you approve them when you turn it on. A mod that asks to run
programs outside the sandbox, use the network or approve actions for you gets that power for real. Reviews,
signatures and the directory don't make a mod safe, so only turn on mods you trust.

## For organizations

Administrators can restrict and deploy mods with a policy file, and can protect credentials with an
OS-separated broker. Both need `sudo`. See [administrator policy](../mods/REFERENCE.md#administrator-policy-and-managed-deployment)
and [protected authority](../mods/REFERENCE.md#protected-authority-macos). Uninstall OMD only after
`omd-package broker uninstall`.
