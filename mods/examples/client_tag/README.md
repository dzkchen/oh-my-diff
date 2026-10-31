# client_tag

Draws a clickable tag above the prompt from a component module (`component_modules_v1`). The tag shows the text passed
in its props. It's an example for mod authors. OMD+ and OMD Core don't install it, and it isn't in the curated
directory.

Read it if you're building a mod that uses
[component modules](../../reference/terminal-input.md#component-modules-component_modules_v1).

Clicking the tag sends the clicked cell's column and row to the mod. `component_post` stores them and the view shows the
last click. It ports the `Tag` `ClientModule` example from Claude Code's mod type declarations
(`mods/types/claude-code.d.ts` in [anthropics/claude-code](https://github.com/anthropics/claude-code)). It shows how the
Claude Code `Client` API maps to an OMD component module:

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

Click the tag above the prompt. The line below it shows the column and row of the last click.

`scripts/client_acceptance.py` loads it alongside `external_client` and `approval_desk` against real hosts.

## Settings

It has no settings.

## Needs and limits

- It needs a host with `component_modules_v1`.
- It has no offline `mod.test.json` scenario.

## More

- [Terminal UI reference](../../reference/terminal-ui.md)
