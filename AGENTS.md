# Agent instructions

Oh My Diff (OMD) patches Codex `0.166.0` with a host for TypeScript mods.

## Build a mod

Follow [docs/AGENT_MOD_GUIDE.md](docs/AGENT_MOD_GUIDE.md). A mod lives in its own folder or repository, not in
this one.

## Change this repo

- New features are mods, plugins, skills or hooks. The patched Codex code (`runtime/`) only gets general building
  blocks that several unrelated mods can use, never one feature.
- Set up and check changes as described in [CONTRIBUTING.md](CONTRIBUTING.md). Run only the checks for what you
  changed; the full suite runs nightly.
- Edit the patch in a scratch tree (`python3 .github/scripts/build.py setup NAME`), never by hand.
  `python3 .github/scripts/build.py sync NAME` writes it back. The steps are in
  [docs/contributing/runtime.md](docs/contributing/runtime.md).
- Use `pnpm`, never `npm` or `npx`. Tool versions come from `mise.toml`.
- Mod API `1.0.0` is stable: frozen entries change only additively (a breaking change needs a major version and a
  migration note in `mods/reference/stability-and-migration.md`). Elsewhere add no compatibility shims: change or
  delete code and update every caller.
- Write no code comments except one line on genuinely abstract code.
- Pull request titles become changelog lines; prefer Conventional Commits (see CONTRIBUTING).
- Don't commit secrets, credentials or personal paths.
