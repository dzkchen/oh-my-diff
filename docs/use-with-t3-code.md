# Use OMD with T3 Code

How to run Oh My Diff (OMD) under [T3 Code](https://github.com/pingdotgg/t3code), a desktop app for coding agents
that runs Codex for you. T3 Code stays the app you work in, and OMD adds the mods that change what Codex sends to the
model and does with its tools. Your T3 Code threads, Codex settings and sign-in stay as they are.

## Point T3 Code at OMD's `codex`

T3 Code starts Codex with `codex app-server`. The installer puts OMD's `codex` in `~/.local/bin`, but an app opened
from the Dock or Finder may not have that folder on its `PATH` and would start another Codex. Set the path yourself:

1. Find the full path:

   ```sh
   echo ~/.local/bin/codex
   ```

2. In T3 Code, open Settings, then Providers, then Codex, and paste it into Binary path.
3. Start a new thread.

T3 Code runs `codex --version` before it uses a Codex binary. OMD's `codex` prints the same `codex-cli X.Y.Z` line as
Codex. If T3 Code doesn't support that Codex version, it uses its own copy of Codex instead, without OMD.

## What works in T3 Code

Mods that work on model requests, tools and turns run in T3 Code sessions as they do in `codex`, such as the
experimental harness mods in [included mods](collection.md#experimental).

Mods that draw in the terminal don't appear in T3 Code: the status line, panels, dialogs and mod slash commands such
as `/mods`. Manage mods from a terminal instead:

```sh
omd mods list
omd mods enable omd_privacy
```

A change applies from the next turn in T3 Code.

## What OMD leaves alone

- OMD+ keeps Codex's plan mode, so T3 Code's Plan mode works. If you turn on `omd_plan_removal`, T3 Code's plan
  turns run in the default mode and show a warning.
- `omd_auto_continue` etc runs only in the terminal interface. In T3 Code, an approval waits for you.
- Starting `codex app-server`, `codex exec` or `codex --version` never installs an OMD update, so T3 Code never
  waits on one. A staged update installs the next time you run `codex` in a terminal.

## Go back to plain Codex in T3 Code

Set Binary path to another Codex, such as `/opt/homebrew/bin/codex`, and start a new thread. Nothing
else changes: OMD and T3 Code share the same Codex settings and sessions. To stop OMD's mods everywhere instead, see
[troubleshooting](troubleshooting.md).

## Limits

OMD is tested against the requests T3 Code sends at startup and for a plan turn, not in the T3 Code app itself.
