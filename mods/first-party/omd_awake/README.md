# omd_awake

Replaces Codex's experimental "Prevent sleep while running" with `/awake`. While the mod is on, that feature is gone
from the session: no `/experimental` row, no `codex features list` entry, and `prevent_idle_sleep` in `config.toml`
has no effect. Turning the mod off brings it back as you left it.

It keeps the Mac awake while a turn, a subagent or an automation run is working, and lets it sleep normally a short
while after they finish. With the authority broker deployed it keeps a closed MacBook running on battery: the screen
is off, the agents keep working and streaming, and macOS keeps managing the fans. When the work finishes with the lid
still closed, the Mac goes to sleep.

Without the broker it only prevents idle sleep while the lid is open (like `caffeinate -i`); the display can still
turn off.

## Turn it on

It is off by default in OMD+. Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_awake
```

It asks for the `power` grant (keep the Mac awake) and the `os` grant (check the network and rejoin Wi-Fi with
`route` and `networksetup`).

For lid-closed wake, deploy the authority broker once (sudo): `omd-package broker install`. A broker installed
before this mod existed needs that command again. Without the broker, the mod says so once and keeps the Mac awake
only while the lid is open.

## Use it

- `/awake` shows whether it is holding and the settings. `/awake on` and `/awake off` turn it on and off (it starts
  on). `/awake lid on|off`, `/awake hotspot <network>|off`, `/awake grace <seconds>`, `/awake battery <percent>` and
  `/awake hours <1-24>` change the settings; a change applies within a second.
- The status line shows `awake · lid can close` (or `awake` without the broker) while it holds, `awake: winding
  down` during the grace period, and `awake off: <reason>` after a safeguard stopped it.
- Every hold ends when the agents finish and the grace period passes, when you disable the mod, when the session
  ends and when OMD exits or crashes. The broker then puts the previous sleep setting back and, if the lid is closed,
  puts the Mac to sleep.
- It checks every 15 seconds with a lid-closed hold and once a minute otherwise, and renews the hold each time, so a
  restarted broker or a broker deployed later takes effect within a check. A safeguard releases the hold, shows a toast
  and sends a desktop notification. The Mac then sleeps normally until the agents go idle, and the next turn after that
  holds again.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Stay awake while agents work (`/awake on`/`off`) |
| `lid_closed` | `true` | Keep running with the lid closed (needs the broker) |
| `grace_seconds` | `120` | Stay awake this long after the last turn or subagent finishes |
| `battery_floor` | `20` | Stop at or below this battery percent while on battery |
| `max_hours` | `4` | Stop after this many hours of continuous work (1 to 24) |
| `hotspot_ssid` | empty | Personal Hotspot network to join when Wi-Fi drops with the lid closed |

Change settings in `/mods`, or from a shell (this replaces the mod's saved settings):

```sh
STORE=~/.local/share/oh-my-diff/stores/full
omd-mod settings "$STORE" "$STORE/sources/omd_awake" '{"hotspot_ssid": "My iPhone", "battery_floor": 30}'
```

## Safeguards

- Battery at or below `battery_floor` while on battery (`pmset -g batt`).
- Low Power Mode on, or heavy thermal pressure (macOS's `thermalpressurelevel` and `lowpowermode` notifications).
- `max_hours` of continuous holding. A hold also expires at the host after that time, even if the mod stops running.

## Network

While a lid-closed hold is active and the lid is closed, it checks the network every 15 seconds. When the default
route disappears it turns Wi-Fi off and on once (macOS rejoins known networks), then joins `hotspot_ssid` with
`networksetup` on every following check. It stops after 20 tries (about 5 minutes) and says so, and starts over once
the network is back. With the lid open it never touches the network.

The hotspot password comes from the Keychain, where macOS stored it when you first joined; it is never in the
settings. If `hotspot_ssid` isn't a saved network when a lid-closed hold starts, the mod tells you to join it once
from the menu bar.

This is best effort. The iPhone must be awake with Personal Hotspot on and discoverable. Instant Hotspot has no API,
and macOS may refuse to join a network without the screen unlocked.

## Needs and limits

- macOS only. Fans aren't controlled: Apple Silicon has no supported fan API, and a MacBook Air (no fan) throttles
  sooner with the lid closed. Never run lid-closed in a bag.
- A subagent that is still running when a turn ends keeps the hold. One that a mod starts while no turn runs is held
  from the next turn.
- A disabled mod's hold ends at the next host event in that session, or at its maximum duration.
- Automation runs count when they run as turns in a session.
