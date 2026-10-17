# Agent instructions

Oh My Diff (OMD) patches Codex `0.162.1` with a host for TypeScript mods.

## Building a mod

Follow [docs/AGENT_MOD_GUIDE.md](docs/AGENT_MOD_GUIDE.md). A mod lives in its own folder or repository, not in
this one.

## Changing this repository

- New features are mods, plugins, skills or hooks. The patched Codex code (`runtime/`) only gets general building
  blocks that several unrelated mods can use, never one feature.
- Set up and check changes as described in [CONTRIBUTING.md](CONTRIBUTING.md). Run only the checks for what you
  changed; the full suite runs nightly.
- Edit the patch in a scratch tree (`mise run batch setup NAME`), never by hand. `python3 scripts/batch_tree.py
  sync NAME` writes it back.
- Use `pnpm`, never `npm` or `npx`. Tool versions come from `mise.toml`.
- No compatibility shims: OMD is pre-1.0, so change or delete code and update every caller.
- Write no code comments except one line on genuinely abstract code.
- Pull request titles use Conventional Commits; see CONTRIBUTING.
- Don't commit secrets, credentials or personal paths.
