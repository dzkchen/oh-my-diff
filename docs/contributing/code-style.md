# Code conventions

Follow the surrounding code and keep the change focused. OMD has Rust host crates, TypeScript mods, Node author
tools and Python build scripts; each has a different job. Read [How OMD works](../how-omd-works.md) before changing
how they communicate.

## Choose the owner

- Put features in mods, plugins, skills or hooks. Add native code only for a general capability that several
  unrelated mods can use. `mise run native:ownership` checks the native crate boundaries and feature names.
- Extend an existing API or implementation before adding another way to do the same thing. Use concrete names
  such as `mod_test_suite` or `release_artifacts`; avoid catch-all `utils` or `helpers` modules.
- Keep public Mod API `1.0.0` entries compatible. Add fields or operations rather than changing frozen meanings.
  Follow [stability and migration](../../mods/reference/stability-and-migration.md) for a breaking change.
  Elsewhere, update every caller rather than adding compatibility shims.
- Keep callbacks that draw views small. Use the existing background and managed-process APIs for long work, and
  release resources when their owner stops. Don't add file scans, processes or network requests on every redraw.
- Request only the capabilities a mod needs. Let the host enforce permissions; a successful mock call does not
  prove that a real host will allow it.

## Language conventions

| Code | Convention and check |
| --- | --- |
| TypeScript mods | Two-space indentation, single quotes, semicolons and `import type` for types. Keep strict checking on; use the types in `mods/api.d.ts`. Run `mise run mods:check`. |
| Node tools and tests | ES modules in `.mjs`, `node:` imports for built-ins, two spaces, single quotes and semicolons. Use the built-in test runner and `node:assert/strict`. |
| Python scripts | Four spaces, `snake_case` functions and `pathlib.Path` for paths. Use argument lists with `subprocess`, check exit status and avoid shell interpolation. Tests use `unittest`. |
| Rust | Follow the scratch tree's Rustfmt and workspace Clippy lints. The OMD crates deny `unwrap` and `expect` outside tests. Use the [runtime workflow](runtime.md) to edit, check and sync. |

OMD has no repository-wide JavaScript formatter or Python linter. Type checks and static host checks do not enforce
formatting. Match the file you edit and avoid unrelated formatting changes. Write no code comments except one line
on genuinely abstract code; put contributor explanations in docs.

Mod entrypoints run inside `omd-runner`, not Node. Use type-only imports from the SDK and host APIs for system work;
Node globals and packages are unavailable. Relative runtime imports must name declared package assets and require
`package_imports_v1`. See the [agent mod guide](../AGENT_MOD_GUIDE.md#traps) and
[packaging](../../mods/reference/packaging.md). Node author tools and tests can use Node modules.

## Generated files

Edit the source, run its generator, and include the generated diff in the same pull request.

| Generated output | Source and command |
| --- | --- |
| `runtime/patches/`, `runtime/omd/`, `runtime/native/`, `runtime/crate-notices.txt` | Edit a scratch Codex tree, then `python3 .github/scripts/build.py sync NAME`; require `tree_parity: true`. |
| `runtime/mods.lock.json` and `runtime/plugins.lock.json` | Edit the package or shipped guide, then `python3 .github/scripts/build.py locks`. Review both generated locks. |
| `CHANGELOG.md` | Edit `release/changelog.json`, then `python3 scripts/release.py render`. Release preparation belongs to the maintainer. |
| `runtime/release.lock.json` | The release process generates this from signed binaries. Leave it to the maintainer. |

The source locks hash shipped files: mod manifests, entrypoints and declared assets, plus the files listed in
`plugins/release-files.json` and the plugin guide. Update a plugin's component digest before generating locks if
you changed its mod; see [Bundle a mod in a plugin](../mod-authors/bundle-in-a-plugin.md).

## Before review

Read your diff for unrelated edits, secrets, local paths and stale generated files. Check the behavior at the
[layer that owns it](../../tests/README.md#write-a-useful-test). For visible changes, follow the
[terminal UI style guide](../STYLEGUIDE.md). Update the guide, mod README or API reference that a user will read,
and write the problem, action and result in concrete terms. Preserve exact commands, defaults and limits; say what
your checks proved and what remains unverified.
