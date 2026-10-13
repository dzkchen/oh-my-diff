# token_weather

A weather forecast of the context window, one line above the prompt.

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

After each main-thread turn the mod keeps one reading: the context of the turn's last model response from `api.usage.summarize` (input plus output tokens of that response, over the model's context window). The chart shows the last 12 readings scaled to the largest, and the delta is what the last turn added. Below 60 columns only the forecast, percent and tokens are shown.

## Limits of this port

- The band appears after the first finished turn; upstream drew a 0% reading at session start.
- Readings come from the main thread's responses only. Worker and subagent responses are skipped.
- The percentage is of the full context window, not of the auto-compact point.

## Capabilities

- `model`: `model_response`, to read the context of each response.
- `lifecycle`: `turn_end`, to record one reading per turn.
- `terminal`: the above-composer line.
- `store`: the last 12 readings, in thread-scoped state, so they fork and resume with the thread.

No timers, commands, host calls or network.

## Credit

Reimplemented over the Oh My Diff mod API from the Claude Code mod
[`token-weather` 0.1.0](https://github.com/anthropics/claude-code-playground/tree/e9ab132d4575390ecbadfc54649712432b1a3351/claude-code/mods/token-weather)
by Claude Code DevRel (Anthropic PBC), commit `e9ab132d4575390ecbadfc54649712432b1a3351`, licensed Apache-2.0.
The forecast bands, symbols, number format and chart follow upstream; readings use OMD's `model_response` usage instead of `$.session.usage()`.
