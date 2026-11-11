<!-- The title becomes the changelog line; see CONTRIBUTING.md. -->

## What and why

<!-- One plain-language sentence first, then what changed and the problem it solves. Describe the before and after as a
user sees it, and the mechanism you changed, not only the symptom. -->

## Linked issue

<!-- Required for outside contributors except small bug and docs fixes: link an issue, ideally one labeled
`status: accepted`. "Refs" alone is not enough. -->

Fixes #

## How it was checked

<!-- List commands and results from CONTRIBUTING.md "Check your change", including anything you could not run.
For a terminal change, include before and after screenshots or a recording, the terminal, viewport size and
settings. Otherwise write "N/A" and why. Scenario traces do not prove rendering or keyboard delivery. -->

- [ ] `mise run check:changed` after the last edit, plus related tests and any native or terminal checks (list them)
- [ ] A new test catches behavior existing tests miss, or existing coverage is sufficient (explain briefly)
- [ ] Docs updated for any user-facing change (`docs/`, the mod's README or `mods/reference/`)
- [ ] New features are mods, plugins, skills or hooks; `runtime/` only gets general building blocks that several
  unrelated mods can use

## Risk

<!-- What could break and for whom, the riskiest part, and how to back it out (a plain revert, or what a revert won't
undo: a mod store, settings, installed files). -->

**Level:** <!-- Low, Medium or High -->

## AI use

<!-- Outside contributors: which AI tools wrote or reviewed this change, if any. You are responsible for every line. -->
