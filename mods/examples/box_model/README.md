# Box model example

Draws bordered cards and flat filled panels with the terminal box model (`terminal_box_model_v1`). It's an independent-author API `0.2.0-experimental.5` mod and uses no first-party mod.

## What it shows

The sidebar holds two panes.

- **Bordered card:** an unstyled pane, drawn as a card in the theme border with its title in the top edge.
  - A `direction: 'row'` box lays out two rounded metric boxes with `flex` 1 and 2 and a one-cell `gap`.
  - Each metric turns to a thick accent border on hover, without pointer events, and drops out below its 10-column `min_width`.
- **Flat panel:** `border: 'none'` and a filled `background` that lightens while it or a descendant has focus.
  - Its `box_model_status` box takes `pointer: true`, so entering it sends `component_event {kind: 'pointer', action: 'enter'}`, which the mod counts in `api.state`.
  - Its hover accent fills it with the accent tone.

Also:

- `sidebar_style: {gap: 1}` separates the panes. The view sets its own `sidebar_side` and 40-column `sidebar_width`.
- **Move left/right** (`/box_model:box side`) swaps the side.
- `/box_model:box split` switches to a `layout` with a one-cell `gap`, where the `site:box_model/cards` leaf draws as a padded double-bordered frame.

## Try it

Install it with `omd-mod`, grant `terminal`, `commands` and `store`, and run it in an `OMD_MODE=omd` session.

## Test it

`mod.test.json` runs offline and checks the sidebar view, a counted pointer entry and the split layout.

```sh
python3 scripts/mod_host_check.py --omd-mod <omd-mod> --no-commands --scenarios box_model
```
