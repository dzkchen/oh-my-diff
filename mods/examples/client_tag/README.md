# Client tag

A component module (experimental, `component_modules_v1`) that draws the text its node's props carry. A click
posts its cell to the mod; `component_post` stores it and the view shows the last click.

It ports the `Tag` `ClientModule` example from Claude Code's mod type declarations
(`mods/types/claude-code.d.ts` in [anthropics/claude-code](https://github.com/anthropics/claude-code)).

| Claude Code `Client` | OMD component module |
| --- | --- |
| `Client({module, key, props})` | `{type: 'module', id, module, props}` |
| `(props, surface) => tree` | `view(state, ui)` with `ui.props` |
| `surface.setState` / `surface.state` | handlers return the next state |
| `surface.every(ms, fn)` | `every: {ms, tick}` |
| `surface.onKey` / `surface.onPointer` | `key` / `pointer` |
| `surface.post` → `ui.message` | `ui.post` → `component_post` |
