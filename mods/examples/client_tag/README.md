# client_tag

A component module (`component_modules_v1`) that draws the text its node's props carry, above the composer. It's an
example for mod authors. It isn't in the bundled collection or the curated directory.

A click posts its cell to the mod. `component_post` stores it and the view shows the last click. It ports the `Tag`
`ClientModule` example from Claude Code's mod type declarations (`mods/types/claude-code.d.ts` in
[anthropics/claude-code](https://github.com/anthropics/claude-code)). It shows how the Claude Code `Client` API maps
to an OMD component module:

| Claude Code `Client` | OMD component module |
| --- | --- |
| `Client({module, key, props})` | `{type: 'module', id, module, props}` |
| `(props, surface) => tree` | `view(state, ui)` with `ui.props` |
| `surface.setState` / `surface.state` | handlers return the next state |
| `surface.every(ms, fn)` | `every: {ms, tick}` |
| `surface.onKey` / `surface.onPointer` | `key` / `pointer` |
| `surface.post` → `ui.message` | `ui.post` → `component_post` |

## Install it

From a checkout of this repository:

```sh
omd install ./mods/examples/client_tag
omd mods enable client_tag
```

Grant `terminal` and `store`. See [Manage mods](../../../docs/manage-mods.md) for the other ways to install mods,
and [Trust and permissions](../../../docs/trust-and-permissions.md) for what a grant allows.

## Use it

Click the tag above the composer. The line below it shows the column and row of the last click.

`scripts/client_acceptance.py` loads it alongside `external_client` and `approval_desk` against real hosts.

## Settings

It has no settings.

## Needs and limits

- It needs a host with `component_modules_v1`.
- It has no offline `mod.test.json` scenario.

## More

- [Terminal UI reference](../../reference/terminal-ui.md)
