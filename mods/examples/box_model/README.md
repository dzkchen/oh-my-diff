# box_model

Draws bordered cards and flat filled panels with the terminal box model (`terminal_box_model_v1`). It's an example
for mod authors. OMD+ and OMD Core don't install it, and it isn't in the curated directory.

Read it if you're building a mod that draws with the
[box model](../../reference/layout-and-styling.md#box-model-terminal_box_model_v1).

It's an API `1.0.0` mod that uses only the public mod API, like any outside author's mod
([host primitives](../../reference/host-model.md#host-primitives)), and it uses no first-party mod. The sidebar contains
two panes. It shows:

- Bordered card: an unstyled pane, drawn as a card in the theme border with its title in the top edge.
  - A `direction: 'row'` box lays out two rounded metric boxes with `flex` 1 and 2 and a one-cell `gap`.
  - Each metric turns to a thick accent border on hover, without pointer events, and drops out below its 10-column
    `min_width`.
- Flat panel: `border: 'none'` and a filled `background` that lightens while it or a descendant has focus.
  - Its `box_model_status` box takes `pointer: true`, so entering it sends
    `component_event {kind: 'pointer', action: 'enter'}`, which the mod counts in `api.state`.
  - Its hover accent fills it with the accent tone.
- `sidebar_style: {gap: 1}` separates the panes. The view sets its own `sidebar_side` and 40-column `sidebar_width`.

## Install it

From a checkout of this repository:

```sh
omd install ./mods/examples/box_model
omd mods enable box_model
```

Grant `terminal`, `commands` and `store`. See [Manage mods](../../../docs/manage-mods.md) for the other ways to
install mods, and [Trust and permissions](../../../docs/trust-and-permissions.md) for what a grant allows.

## Use it

Run it in an [`OMD_MODE=omd`](../../reference/host-model.md#omd_mode) session.

| Command | What it does |
| --- | --- |
| `/box_model:box side` (**Move left/right**) | Swap the sidebar side |
| `/box_model:box split` | Toggle a `layout` with a one-cell `gap`, where the `site:box_model/cards` leaf draws as a padded double-bordered frame. In split mode `side` has no effect. |

### Test it

`mod.test.json` runs offline and checks the sidebar view, a counted pointer entry and the split layout.

```sh
python3 scripts/mod_host_check.py --no-commands --scenarios box_model
```

It uses the `omd-mod` on your `PATH`. [Tests](../../../tests/README.md) covers the other test runners.

## Settings

It has no settings.

## Needs and limits

- It needs a host with `terminal_box_model_v1`.
- It demonstrates layout and styling only. It isn't a tool you'd keep on.

## More

- [Terminal UI reference](../../reference/terminal-ui.md)
