# token_weather

Shows a weather forecast of your context window in one line above the prompt.

## Install it

From the curated directory:

```sh
omd install token_weather
omd mods enable token_weather
```

## What you see

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

After each turn the mod records the input tokens out of the model's context window, the same figures as Codex's status line. The chart shows the last 12 readings. The delta is what the last turn added.

Below 60 columns you see only the forecast, percent and tokens.

## Limits of this port

- The line appears after the first finished turn, not at session start.
- Readings are per thread. A subagent's usage isn't in the session's line.
- The percentage is of the full context window, not the auto-compact point.
- It needs no commands, timers or network.

## Credit

Reimplemented over the Oh My Diff mod API from the Claude Code mod
[`token-weather` 0.1.0](https://github.com/anthropics/claude-code-playground/tree/e9ab132d4575390ecbadfc54649712432b1a3351/claude-code/mods/token-weather)
by Claude Code DevRel (Anthropic PBC), commit `e9ab132d4575390ecbadfc54649712432b1a3351`, licensed Apache-2.0.
The forecast bands, symbols, number format and chart follow upstream; readings use the thread's token usage notification instead of `$.session.usage()`.
