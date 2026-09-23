# Local lean candidate profiles

These are local Apple Silicon candidate profiles for the pinned Codex `0.155.1`
patch. They are not a public release or a qualified default. Build the patched
`codex` and `omd-mod` executables from `runtime/lean-v1.lock.json`, then use a
Node `24.18.0` executable from `mise which node`. The platform profile copies
only those two executables into its base artifact. It does not change
`CODEX_HOME`, `CODEX_SQLITE_HOME`, the selected Codex account, or project files.
The normalized patch-and-build steps are in [PRIVATE_BUILD.md](PRIVATE_BUILD.md).
Before installation, verify all five release binaries against the frozen
candidate lock with
`python3 -m scripts.lean_candidate_lock --artifact-dir /path/to/release`.

Run these commands from this checkout, replacing the paths with the local
patched build and separate writable installation directories:

```sh
NODE_PATH="$(mise which node)"
python3 -m scripts.lean_profiles --prefix /path/to/omd-candidate --bin-dir /path/to/omd-bin install \
  --profile platform --binary /path/to/patched/codex --manager /path/to/patched/omd-mod \
  --node "$NODE_PATH" --store /path/to/omd-mod-store
```

`--profile platform` creates an empty first-party store and launches patched
Codex with `OMD_MODE=platform`. User-selected, trusted mods can run without the
controlled OMD task policy. For `--profile full`, use the same command with
`--omd-graph`, `--omd-health`, and `--omd-lsp` pointing to matching patched
executables. Full installs the three current first-party candidate mods. Only
`omd_workspace` is enabled in a fresh Full store. Coordination and recovery are
installed but disabled. Six curated plugin source packages are available in
`/path/to/omd-candidate/bundles/oh-my-diff`; none is installed into Codex or
started. Full includes inert `omd-graph`, `omd-health`, and `omd-lsp` launchers
for the matching opt-in plugins. The deferred code-execution plugin, browser,
bridge service, external language servers, code-mode host, and sidecars are
absent from the base artifact.

Inspect and switch the effective profile:

```sh
python3 -m scripts.lean_profiles --prefix /path/to/omd-candidate --bin-dir /path/to/omd-bin status
python3 -m scripts.lean_profiles --prefix /path/to/omd-candidate --bin-dir /path/to/omd-bin activate direct
python3 -m scripts.lean_profiles --prefix /path/to/omd-candidate --bin-dir /path/to/omd-bin activate full
```

Use `activate platform` for a platform installation. `direct` immediately
selects upstream-style behavior inside the patched binary. `status` reports
the installed profile, host mode, installed versus enabled mods, source hashes,
mod errors, and staged plugins. The TUI `/omd` inspector shows the live mode
and mod state. To disable a broken first-party Full mod:

```sh
python3 -m scripts.lean_profiles --prefix /path/to/omd-candidate --bin-dir /path/to/omd-bin mod disable omd_workspace
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
python3 -m scripts.lean_profiles --prefix /path/to/omd-candidate --bin-dir /path/to/omd-bin uninstall
```

The mod store and Codex state remain. The installer refuses removal if its
launcher or pinned upstream fallback changed or the prefix contains a user file.
If you explicitly added the
staged plugin marketplace to Codex, remove its plugins and run
`codex plugin marketplace remove oh-my-diff` before uninstall; the installer
refuses to leave a marketplace pointing at a removed directory. Local candidate qualification
and package limits are recorded in `.docs/ROADMAP.md` and
`runtime/lean-release-selection.json`.
