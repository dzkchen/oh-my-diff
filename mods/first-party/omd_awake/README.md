# omd_awake

Keeps the Mac awake while a turn, a subagent (a helper agent the main agent starts) or an automation run is working,
also with the lid closed, and lets it sleep a short while after they finish. It's experimental, and neither OMD+ nor OMD
Core installs it.

## Turn it on

Install it from the Available group in `/mods`, or run:

```sh
omd install omd_awake
omd mods enable omd_awake
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to install and turn on a mod.

It asks for the `power` grant (keep the Mac awake) and the `os` grant (check the network and rejoin Wi-Fi with
`route` and `networksetup`).

For the Mac to keep working with the lid closed, install the authority broker once. It's OMD's protected macOS
service for grants and credentials (see
[Trust and permissions](../../../docs/trust-and-permissions.md#protect-credentials-with-the-authority-broker)).
Installing it needs `sudo`:

```sh
omd-package broker install
```

A broker installed before this mod existed needs that command again. Without the broker, the mod says so once and
keeps the Mac awake only while the lid is open.

## Use it

`/awake` replaces Codex's experimental "Prevent sleep while running". While the mod is on, that feature is gone from
the session: no `/experimental` row, no `codex features list` entry, and `prevent_idle_sleep` in `config.toml` has no
effect. Turning the mod off brings it back as you left it.

With the broker deployed it keeps a closed MacBook running on battery: the screen is off, the agents keep working and
streaming, and macOS keeps managing the fans. When the work finishes with the lid still closed, the Mac goes to
sleep. Without the broker it only prevents idle sleep while the lid is open (like `caffeinate -i`), and the display
can still turn off.

While it keeps the Mac awake, the mod has a hold on sleep. The commands and status line call that holding.

| Command | What it does |
| --- | --- |
| `/awake` | Show whether it's holding now, and the settings |
| `/awake on`, `/awake off` | Turn keeping awake on or off without turning off the mod. It starts on. |
| `/awake lid on\|off` | Keep running with the lid closed, or not |
| `/awake hotspot NETWORK\|off` | Set or clear the Personal Hotspot network |
| `/awake grace SECONDS` | Grace period, 0 to 3600 |
| `/awake battery PERCENT` | Battery floor, 0 to 100 |
| `/awake hours HOURS` | Maximum hours, 1 to 24 |

For example, `/awake battery 40` stops holding at 40% battery. A change applies within a second.

- The status line shows `awake · lid can close` (or `awake` without the broker) while it holds, `awake: winding down`
  during the grace period, and `awake off: <reason>` after a safeguard stopped it.
- Every hold ends when the agents finish and the grace period passes, when you turn off the mod, when the session
  ends and when OMD exits or crashes. The broker then puts the previous sleep setting back and, if the lid is closed,
  puts the Mac to sleep.
- It checks every 15 seconds with a lid-closed hold and once a minute otherwise, and renews the hold each time, so a
  restarted broker or a broker deployed later takes effect within a check. A safeguard releases the hold, shows a
  toast and sends a desktop notification. The Mac then sleeps normally until the agents go idle, and the next turn
  after that holds again.

### Safeguards

- Battery at or below `battery_floor` while on battery (`pmset -g batt`).
- Low Power Mode on, or heavy thermal pressure (macOS's `thermalpressurelevel` and `lowpowermode` notifications).
- `max_hours` of continuous holding. A hold also expires at the host after that time, even if the mod stops running.

### Network

While a lid-closed hold is active and the lid is closed, it checks the network every 15 seconds. When the Mac loses its
network connection (the default route disappears), it turns Wi-Fi off and on so macOS rejoins known networks. Without
`hotspot_ssid` it repeats that on every other check. With `hotspot_ssid` set it toggles Wi-Fi once, then joins that
network with `networksetup` on every following check. It stops after 20 tries (about 5 minutes) and says so, and starts
over once the network is back. With the lid open it never touches the network.

The hotspot password comes from the Keychain, where macOS stored it when you first joined. It is never in the
settings. If `hotspot_ssid` isn't a saved network when a lid-closed hold starts, the mod tells you to join it once
from the menu bar.

This is best effort. The iPhone must be awake with Personal Hotspot on and discoverable. Instant Hotspot has no API,
and macOS may refuse to join a network without the screen unlocked.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Stay awake while agents work (`/awake on`/`off`) |
| `lid_closed` | `true` | Keep running with the lid closed (needs the broker) |
| `grace_seconds` | `120` | Stay awake this long after the last turn or subagent finishes (0 to 3600) |
| `battery_floor` | `20` | Stop at or below this battery percent while on battery (0 to 100) |
| `max_hours` | `4` | Stop after this many hours of continuous work (1 to 24) |
| `hotspot_ssid` | empty | Personal Hotspot network to join when Wi-Fi drops with the lid closed |

Change settings in `/mods` or with the `/awake` commands above.

## Needs and limits

- macOS only. Fans aren't controlled: Apple Silicon has no supported fan API, and a MacBook Air (no fan) throttles
  sooner with the lid closed. Never run lid-closed in a bag.
- A subagent that is still running when a turn ends keeps the hold. One that a mod starts while no turn runs is held
  from the next turn.
- If you turn the mod off, its hold ends at the next event in that session, or at its maximum duration.
- Automation runs count when they run as turns in a session.

## More

- [Included mods](../../../docs/collection.md)
- [Power holds](../../reference/sessions-and-turns.md#power-holds-power_hold_v1) in the mod API reference
- [Protected authority](../../reference/protected-authority.md), the broker that lid-closed wake needs
