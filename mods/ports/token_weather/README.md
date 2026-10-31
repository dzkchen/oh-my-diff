# token_weather

Shows a weather forecast of your context window in one line above the prompt. It's a port of the Claude Code mod
`token-weather`. It's in the curated directory, but OMD+ and OMD Core don't install it.

## Install it

Pick it under Available in `/mods`, or run:

```sh
omd install token_weather
omd mods enable token_weather
```

It asks to draw the line above the prompt, read the thread's token usage, follow turns and keep its readings. The
capabilities are `terminal`, `threads`, `lifecycle` and `store`. See [Manage mods](../../../docs/manage-mods.md) for the
other ways to install and turn on a mod, and
[Trust and permissions](../../../docs/trust-and-permissions.md#what-a-mod-can-do) for what a capability allows.

## Use it

It has no commands. After each turn the line shows:

```text
☂  Showers  67% of context  134.4k / 200k   last turns ▁▂▃▅▆▇█  ▲ +4.4k last turn
```

| Used | Forecast |
| --- | --- |
| under 25% | ☀ Clear |
| 25–49% | ☁ Cloudy |
| 50–74% | ☂ Showers |
| 75–89% | ☇ Storm |
| 90% up | ↯ Compact soon |

After each turn the mod records the input tokens out of the model's context window, the same figures as Codex's
status line. The chart shows the last 12 readings. The delta is what the last turn added.

Below 60 columns you see only the forecast, percent and tokens.

## Settings

It has no settings.

## Needs and limits

- The line appears after the first finished turn, not when the thread starts.
- Readings are per thread. Usage of subagents (helper agents the main agent starts) isn't in the main thread's line.
- The percentage is of the full context window, not the auto-compact point.
- It uses no timers or network.

### Differences from upstream

The forecast bands, symbols, number format and chart follow upstream.

- Readings use the thread's token usage notification instead of `$.session.usage()`.

## More

- [Terminal UI reference](../../reference/terminal-ui.md) for the line above the prompt.
- Credit: reimplemented over the Oh My Diff mod API from the Claude Code mod
  [`token-weather` 0.1.0](https://github.com/anthropics/claude-code-playground/tree/e9ab132d4575390ecbadfc54649712432b1a3351/claude-code/mods/token-weather)
  by Claude Code DevRel (Anthropic PBC), commit `e9ab132d4575390ecbadfc54649712432b1a3351`, licensed Apache-2.0.
