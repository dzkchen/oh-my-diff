# Local lean candidate profiles

These are local Apple Silicon candidate profiles for the active Codex `0.156.1`
patch. They are not a public release or a qualified default. Build the patched
`codex`, `omd-mod`, `omd-graph`, `omd-health`, and `omd-lsp` executables from
`upstream.lock.json` and `runtime/patches/manifest.json`. Pack the typed author
SDK with `mise exec -- pnpm --dir mods pack --pack-destination /path/to/release`
and copy that archive to `/path/to/release/mod-api.tgz`. Use Node `24.18.0` from
`mise which node`. The platform profile installs the host, mod manager, author
SDK/CLI, and a local package-control command. It does not change
`CODEX_HOME`, `CODEX_SQLITE_HOME`, the selected Codex account, or project files.
The historical `0.155.1` candidate and private build remain frozen. Verify the
current six package artifacts with
`python3 -m scripts.lean_release_lock --artifact-dir /path/to/release`.

To create a checksum-bound prebuilt archive and install either profile locally:

```sh
python3 -m scripts.lean_package pack --artifact-dir /path/to/release --output /path/to/omd-package.tar.xz
python3 -m scripts.lean_package install --archive /path/to/omd-package.tar.xz --sha256 PRINTED_SHA256 \
  --upstream /path/to/upstream/codex --profile platform --prefix /path/to/omd-candidate \
  --bin-dir /path/to/omd-bin --store /path/to/omd-mod-store --node "$(mise which node)"
```

Use `--profile full` for the provisional Full collection. The archive is
verified before installation. For an automated patch-and-build install:

```sh
python3 -m scripts.lean_package source-install \
  --repository /absolute/local/codex-mirror --author-archive /path/to/release/mod-api.tgz \
  --output-archive /path/to/source-built-omd-package.tar.xz \
  --upstream /path/to/upstream/codex --profile platform --prefix /path/to/omd-candidate \
  --bin-dir /path/to/omd-bin --store /path/to/omd-mod-store --node "$(mise which node)"
```

Use `--profile full` for the Full candidate. An
optional `--target-dir` retains a separate Cargo build cache. The source route
verifies the upstream commit, normalizes the lock, applies the hash-checked
patch, and builds the matching binaries. It requires Rust 1.95.0 and the pinned
Cargo dependencies.
The source package records its own exact binary hashes. Compiler build paths
can make those hashes differ from the prebuilt archive; the installer checks
the same source, patch, profile inventory, package contents, and pinned host
version before activation. Omit `--output-archive` to discard the source-built
archive after installation.

Run these commands from this checkout, replacing the paths with the local
patched build and separate writable installation directories:

```sh
NODE_PATH="$(mise which node)"
python3 -m scripts.lean_profiles --prefix /path/to/omd-candidate --bin-dir /path/to/omd-bin install \
  --profile platform --binary /path/to/patched/codex --manager /path/to/patched/omd-mod \
  --author-archive /path/to/release/mod-api.tgz \
  --node "$NODE_PATH" --store /path/to/omd-mod-store
```

`--profile platform` creates an empty first-party store and launches patched
Codex with `OMD_MODE=platform`. User-selected, trusted mods can run without the
controlled OMD task policy. For `--profile full`, use the same command with
`--omd-graph`, `--omd-health`, and `--omd-lsp` pointing to matching patched
executables. Full installs four current first-party candidate mods. Only
`omd_workspace` is enabled in a fresh Full store. Claude, coordination, and
recovery are installed but disabled. Six curated plugin source packages are available in
`/path/to/omd-candidate/bundles/oh-my-diff`; none is installed into Codex or
started. Full includes inert `omd-graph`, `omd-health`, and `omd-lsp` launchers
for the matching opt-in plugins. The deferred code-execution plugin, browser,
bridge service, external language servers, code-mode host, and sidecars are
absent from the installed base profile.

Inspect and switch the effective profile:

```sh
/path/to/omd-bin/omd-package status
/path/to/omd-bin/omd-package activate direct
/path/to/omd-bin/omd-package activate full
```

Use `activate platform` for a platform installation. `direct` immediately
selects upstream-style behavior inside the patched binary. `status` reports
the installed profile, host mode, installed versus enabled mods, source hashes,
mod errors, and staged plugins. The TUI `/omd` inspector shows the live mode
and mod state. To disable a broken first-party Full mod:

```sh
/path/to/omd-bin/omd-package mod disable omd_workspace
```

Full OMD can explicitly select the controlled task contract with
`activate controlled --manifest /path/to/task-manifest.json`. That manifest must
name this installation's mod store and satisfy the native task authorization,
limits, provider, repository, and evidence requirements. Coordination and
recovery mods remain disabled until individually selected. Switching to
`direct` or `full` clears the controlled manifest from the launcher.
The current Meta Contributor worker needs standard Responses function-tool
formatting (`use_responses_lite=false` and no custom patch tool in its model
catalog entry). Declare any required read-only system toolchain paths in the
task manifest. The bounded live task reached an `unverified` native completion
receipt because the verifier could not inspect host-owned evidence. The local
candidate now grants only the read-only completion verifier that evidence
access, but this repair has not had a paid provider recheck. Controlled mode
remains a development candidate.

The Full profile includes an inactive `omd_claude_cli` mod. To use the official
Claude CLI's logged-in `claude.ai` subscription for one controlled task, enable
the mod and launch through its package command:

```sh
/path/to/omd-bin/omd-package mod enable omd_claude_cli
/path/to/omd-bin/omd-package claude --repository /absolute/repository \
  --model claude-sonnet-5 --max-requests 2 --prompt 'Your task'
```

The `--model` choice also accepts `claude-haiku-4-5-20251001`. The optional
`--max-requests` lowers the task limit from eight to one through eight. The mod requires
official Claude CLI `2.1.281` with a first-party Pro or Max login and Node
`24.18.0`. The command rejects inherited API-key and cloud overrides; it has
no API-key fallback. The mod package owns the model catalog, task setup,
request translation, and CLI transport in `index.ts`, `setup.mjs`, and
`transport.mjs`. Its signed assets are checked by the installed mod manager.
The command explicitly selects OMD's solo-evidence workflow with self-review
and self-verification; it does not claim independent review.
The native host retains route admission, process authority, host tool execution,
approvals, task limits, and usage accounting. Local task evidence is written
under the installation prefix's `tasks` directory. Move or retain that evidence
before uninstalling; uninstall refuses to remove an installation containing
task files. Modding platform only includes no Claude route or assets.

For a user mod in the platform profile, inspect its `mod.json` and source,
then use the installed `artifacts/omd-mod` binary to inspect, trust its exact
digest and declared capabilities, enable it in the store, and reload. The
authoring and recovery details are in [mods/README.md](mods/README.md) and
[mods/PREVIEW.md](mods/PREVIEW.md). A mod's `error` in status is a failure to
repair or disable, not evidence that its behavior ran successfully.

An existing compatible store can be attached with `--attach-store` during a
new installation. Full attach requires the same three package source digests
and preserves each existing enabled or disabled choice. Use a separate prefix
and launcher directory for a side-by-side candidate upgrade. Removal deletes
only the managed launcher and installation prefix:

```sh
/path/to/omd-bin/omd-package uninstall
```

The mod store and Codex state remain. The installer refuses removal if its
launcher or pinned upstream fallback changed or the prefix contains a user file.
If you explicitly added the
staged plugin marketplace to Codex, remove its plugins and run
`codex plugin marketplace remove oh-my-diff` before uninstall; the installer
refuses to leave a marketplace pointing at a removed directory. Local candidate qualification
and package limits are recorded in `.docs/ROADMAP.md` and
`runtime/lean-release-selection.json`.
