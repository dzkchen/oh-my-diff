# omd_update

Tells you when a newer Oh My Diff release is out and lets you control how OMD updates.

## Turn it off

It is on by default in OMD+ and OMD Core. Turn it off in `/mods`, or run:

```sh
omd-package mod disable omd_update
```

## Use it

| Command | What it does |
| --- | --- |
| `/update` | Show the installed and newest versions and the release notes. Change the update settings. |
| **Update now** (in `/update`) | Queue the update for the next start. |
| `omd update` | Install the newest release from a shell. |

A fresh session mentions a newer release once a day until you pick **Remind me in a week** or **Skip this version**.

## Settings

Also available from `omd update` in a shell. See [Update](../../../docs/install.md#update).

| Setting | Default | What it does |
| --- | --- | --- |
| `checks` | `on` | Check for new releases (`on` or `off`). |
| `auto` | `off` | Install updates automatically (`on` or `off`). |
| `channel` | `stable` | `stable`, `prerelease` or `nightly`. |
| `cadence` | `daily` | Check `daily` or `weekly`. |
| `pin` | empty | Stay on an exact version. |

## Needs and limits

- A running session is never replaced. Updates install when OMD next starts with no other session open.
- Automatic updates skip mods you installed yourself.
- An update that fails once isn't retried automatically.
- Nightly is opt-in. Stable and prerelease never offer it.
- `--no-alt-screen` sessions show no welcome notice. `/update` still works.
