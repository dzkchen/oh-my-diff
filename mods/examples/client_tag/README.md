# Client tag

A port of the `Tag` `ClientModule` example from Claude Code's mod type
declarations (`mods/types/claude-code.d.ts` in
[anthropics/claude-code](https://github.com/anthropics/claude-code), read
2026-10-12): a component module that draws the text its node's props carry.
Like the declarations' pointer example, a click posts its cell to the mod's
hooks; here `component_post` stores it and the view shows the last click.

| Claude Code `Client` | OMD component module |
| --- | --- |
| `Client({module, key, props})` | `{type: 'module', id, module, props}` |
| `(props, surface) => tree` | `view(state, ui)` with `ui.props` |
| `surface.setState` / `surface.state` | handlers return the next state |
| `surface.every(ms, fn)` | `every: {ms, tick}` |
| `surface.onKey` / `surface.onPointer` | `key` / `pointer` |
| `surface.post` → `ui.message` | `ui.post` → `component_post` |
