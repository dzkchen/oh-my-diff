# Game input

A component module game in the spirit of [intermission](https://github.com/jarrodwatts/intermission):
a catch board above the composer that steps on the frame clock, takes `a`/`d`
(or the arrow keys) after a click gives it focus, follows the pointer, and posts
each final score to the mod's `component_post` hook, which keeps the best score
in `api.state` for the pane title.

The board's state lives in the component module's runner between frames; the
module has no host authority, so the hook is the only place that writes state.

`mod.test.json` plays the board offline with `component` steps: a key moves the
paddle, `advance_time` drives the ticks, and the last step ends the game and
checks the score the module posts.
