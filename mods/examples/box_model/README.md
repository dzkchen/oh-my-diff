# Box model example

An independent-author API `0.2.0-experimental.5` mod that draws bordered cards and flat filled panels with the terminal box model (`terminal_box_model_v1`), using no first-party mod.

- The sidebar holds two panes. **Bordered card** is an unstyled pane, so it draws as a card in the theme border with its title in the top edge; inside it a `direction: 'row'` box lays out two rounded metric boxes with `flex` 1 and 2 and a one-cell `gap`. Each metric restyles to a thick accent border while hovered, without pointer events, and drops out below its 10-column `min_width`.
- **Flat panel** sets `border: 'none'` and a filled `background`, which turns lighter while it or a descendant has focus. Its `box_model_status` box takes `pointer: true`, so entering it sends `component_event {kind: 'pointer', action: 'enter'}`, which the mod counts in `api.state`; its hover accent fills it with the accent tone.
- `sidebar_style: {gap: 1}` separates the panes, and the view declares its own `sidebar_side` and 40-column `sidebar_width`. **Move left/right** (`/box_model:box side`) swaps the side.
- `/box_model:box split` switches to a `layout` whose split has a one-cell `gap` and whose `site:box_model/cards` leaf draws as a padded double-bordered frame.

`mod.test.json` runs offline and checks the sidebar view, a counted pointer entry and the split layout. Run it with `python3 scripts/mod_host_check.py --omd-mod <omd-mod> --no-commands --scenarios box_model`. Install it with `omd-mod`, grant `terminal`, `commands` and `store`, and run it in an `OMD_MODE=omd` session.
