# omd_update

Tells you when a newer Oh My Diff release is out and lets you control how OMD updates. It's on by default in OMD+
and OMD Core.

## Turn it off

`/mods` can't turn it off, because OMD requires it. Turn it off from a shell:

```sh
omd mods disable omd_update
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

## Use it

| Command | What it does |
| --- | --- |
| `/update` | Show the installed and newest versions and the release notes. Change the update settings. |
| **Update now** (in `/update`) | Queue the update for the next start. |
| `omd update` | Install the newest release from a shell. |
| `omd update rollback` | Undo the last update from a shell. |

A fresh session mentions a newer release once a day until you pick **Remind me in a week** or **Skip this version**.

## Settings

Change settings in `/update`, or with `omd update` in a shell (see the [install guide](../../../docs/install.md)).

| Setting | Default | What it does |
| --- | --- | --- |
| `checks` | `on` | Check for new releases (`on` or `off`). |
| `auto` | `off` | Install updates automatically (`on` or `off`). |
| `channel` | `stable` | `stable`, `prerelease` or `nightly`. |
| `cadence` | `daily` | Check `daily` or `weekly`. |
| `pin` | empty | Stay on an exact version. Empty follows the channel. |

## Needs and limits

- It asks to add `/update`, check for update news when a session starts, read the update status OMD passes in its
  environment, keep its state and draw its notice and panel. The capabilities are `commands`, `lifecycle`, `exec`,
  `store` and `terminal` (see [Trust and permissions](../../../docs/trust-and-permissions.md#what-a-mod-can-do)).
- A running session is never replaced. Updates install when OMD next starts with no other session open.
- Automatic updates skip mods you installed yourself.
- An update that fails once isn't retried automatically.
- Nightly is opt-in. Stable and prerelease never offer it.
- Inline sessions (started with `--no-alt-screen`) don't show the update notice. `/update` still works.

## More

- [Included mods](../../../docs/collection.md)
- The [install guide](../../../docs/install.md), which covers `omd update`
