# Private foundation operator guide

This is the minimum maintainer path for the frozen Codex `0.155.1` Oh My Diff
private foundation. Run these commands from a clean checkout of source commit
`eb5eeed5189550f4107e9c8efa609aefab221bc1`, which retains the matching
`0.155.1` active pin and source hashes. The current development worktree has
advanced to `0.157.0`; its patch builds locally, but it has no new frozen
private installer or public package. This guide's frozen path is supported only
on Apple Silicon macOS and is not a prebuilt package or a public release.

## Prerequisites

- The frozen Oh My Diff source checkout, including `runtime/lean-v1.lock.json`.
- The supported upstream `codex-cli 0.155.1` executable on `PATH`.
- Rust `1.95.0` available through rustup.
- Standalone pnpm `11.14.0` for source browser provisioning.
- A new install prefix and a new launcher directory outside `CODEX_HOME` and
  `CODEX_SQLITE_HOME`.

The launcher directory must be earlier on `PATH` than the upstream executable.
The manager does not edit shell profiles, credentials, configuration, or session
databases.

## Install

From the frozen source checkout:

```sh
OMD_PREFIX="$HOME/.local/share/oh-my-diff/private-build"
OMD_BIN_DIR="$HOME/.local/share/oh-my-diff/bin"
UPSTREAM_CODEX="$(command -v codex)"

python3 scripts/private_lean_v1.py \
  --prefix "$OMD_PREFIX" \
  --bin-dir "$OMD_BIN_DIR" \
  install \
  --upstream "$UPSTREAM_CODEX"

export PATH="$OMD_BIN_DIR:$PATH"
codex --version
```

The manager clones the exact upstream commit, normalizes the recorded lockfile,
verifies and applies the recorded patch, builds an arm64 release, retains exact
upstream and OMD executables, and initially selects upstream-style direct mode.
Use `--repository /absolute/local/codex-mirror` for an offline local mirror. An
optional external `--target-dir` build cache is not owned or removed by
uninstall. The same install provisions the pinned browser bundle from source so
it is ready when OMD mode is selected. To use a previously packaged browser
bundle instead, pass both `--browser-archive /absolute/browser.tar.xz` and
`--browser-archive-sha256 HASH`. Source provisioning can avoid a Node download
with the matching `--browser-node-archive` input.

## Inspect and choose a mode

Set the same two variables in each shell, or replace them with the absolute paths
chosen above:

```sh
python3 scripts/private_lean_v1.py \
  --prefix "$OMD_PREFIX" \
  --bin-dir "$OMD_BIN_DIR" \
  status
```

Inside the OMD binary, `/omd` shows the effective mode and settings.
The managed OMD launcher reports the current private-foundation install
profile separately from its effective mode; this private package is neither
public Full OMD nor Modding platform only. `/status` shows the same profile
and mode. The retained upstream launcher has its original Codex welcome line.

Upstream-style direct mode keeps the custom binary but disables OMD task hooks:

```sh
python3 scripts/private_lean_v1.py \
  --prefix "$OMD_PREFIX" \
  --bin-dir "$OMD_BIN_DIR" \
  activate omd --mode upstream_direct
```

Enabled mode requires a canonical controlled-manifest file:

```sh
python3 scripts/private_lean_v1.py \
  --prefix "$OMD_PREFIX" \
  --bin-dir "$OMD_BIN_DIR" \
  activate omd --mode enabled --manifest /absolute/path/manifest.json
```

The manifest binds one repository, an external evidence directory, an external
revocable authorization file and its SHA256, exact Sol/Astra/Contributor routes,
shared and worker limits, permissions, checks, recovery, context policy, and all
thirteen capability switches. Start with every switch explicit. The optional
`application_bridge` switch is default-off and also requires the external,
hash-bound `bridge` policy described in [`bridge/README.md`](bridge/README.md).
For OMD direct
work set `delegation`, `checkpoints`, `unified_review`, and `completion_gate` to
`false`. Delegation requires `unified_review`; `completion_gate` requires both
`unified_review` and `checkpoints`. Omit inactive guideline, knowledge, LSP, and
reactive-rule material. The complete accepted field construction is in
`benchmarks/controlled_fixture.py`; the validation contract is in
`runtime/native/src/lib.rs`. The fixture routes are local synthetic test routes,
not production provider configuration.

To run the retained exact upstream executable through the managed launcher:

```sh
python3 scripts/private_lean_v1.py \
  --prefix "$OMD_PREFIX" \
  --bin-dir "$OMD_BIN_DIR" \
  activate upstream
```

Selecting `upstream` or `upstream_direct` is reversible. Only uninstall restores
normal `PATH` resolution to the separately installed upstream executable.

OMD selection registers `omd_browser` from the managed prefix with a fresh
in-memory browser profile and per-tool approval prompts. Retained upstream
selection does not inject the server. Browser downloads, profiles, or arbitrary
system Chrome installations are never selected at session start. See
[`browser/README.md`](browser/README.md) for packaging, verification, update,
artifact, and sandbox details.

The launcher no longer injects an application-bridge MCP server. Install the
bundled `omd-application-bridges` plugin when an enabled manifest selects
`application_bridge`. Its prompt-gated launcher reads the same canonical
controlled manifest, verifies the external policy hash, and starts only the
managed bridge binary from the private prefix. It fails closed in retained
upstream, upstream-direct, disabled, stale-policy, or changed-bundle states. The
bridge remains loopback-only and development-only; instrumentation is added
explicitly to the selected application and removed during managed teardown.

## Bundled plugins

The install retains a hash-pinned local Codex marketplace at
`$OMD_PREFIX/plugins/oh-my-diff`. It does not install the plugins or edit shared
Codex state. After reviewing the bundle, an operator can install any plugin
explicitly:

```sh
codex plugin marketplace add "$OMD_PREFIX/plugins/oh-my-diff"
codex plugin add omd-guidance-hooks@oh-my-diff
codex plugin add omd-repository-tools@oh-my-diff
codex plugin add omd-lsp-adapters@oh-my-diff
codex plugin add omd-review-policy@oh-my-diff
codex plugin add omd-application-bridges@oh-my-diff
codex plugin add omd-artifact-reading@oh-my-diff
codex plugin add omd-code-execution@oh-my-diff
```

The plugin supplies versioned simplicity guidance, independent lead-update and
worker-report skills, deterministic structured-report validation, and a
manifest-gated successful `PostToolUse` projection for reactive rules. Review
and trust the hook hashes when Codex prompts; do not bypass hook trust. The
existing native runtime remains authoritative for promotion, rollback,
instruction priority, report admission, permissions, accounting, child
isolation, context rebuilds, and lifecycle outcomes for which Codex emits no
`PostToolUse` event. See [`plugins/README.md`](plugins/README.md) for exact skill
selection and removal commands.

The repository-tools plugin supplies prompt-approved local graph and health MCP
tools plus the focused health skill. The private build installs hash-recorded
`omd-graph` and `omd-health` binaries and managed `PATH` launchers for the plugin;
`status` verifies both binaries and launchers, and uninstall removes the
launchers without touching shared Codex data. Artifact paths are confined to the
selected repository, and the health tools write evidence but never edit source.
The native `/graph` view remains available for optional live navigation, so no
additional terminal mod is installed.

The LSP-adapters plugin supplies one prompt-approved MCP tool for each supported
language and requires the managed `omd-lsp` binary and launcher installed by the
private build. The plugin handles command schemas and fallback presentation;
native Rust retains repository opt-in, installed-server admission, process and
workspace bounds, synchronization, exact-scope/hash validation, atomic edits,
rollback, permissions, and cleanup. No language server is installed.

## Mod preview

The install also retains the `omd-mod` manager and can provision the two
first-party preview packages into an external store:

```sh
OMD_STORE="$HOME/.local/share/oh-my-diff/mods"

python3 scripts/private_lean_v1.py \
  --prefix "$OMD_PREFIX" \
  --bin-dir "$OMD_BIN_DIR" \
  preview install --store "$OMD_STORE" --node /absolute/node-24.18.0/bin/node
```

Provisioning verifies the pinned source hashes, checks that the installed host
and the packages agree on the exact mod API version, and refuses a store inside
this repository, the install prefix, the launcher or Codex state. Add the
printed `"mods"` line to the controlled manifest to load them. `preview status`,
`preview disable [--id ID]`, `preview enable` and `preview uninstall` manage the
store afterwards; uninstall refuses to delete locally edited sources without
`--force` and never touches the build, Codex state or manifests.

[`mods/PREVIEW.md`](mods/PREVIEW.md) is the first-use and customization guide.

## Limitations

- Live provider access, account eligibility, repository-data authorization,
  quotas, prices, model availability, and route behavior must be checked in the
  current environment. Synthetic fixtures do not verify them.
- The private build carries the two first-party preview mods described above; the
  bundled plugin sources described above; and no curated mod catalog,
  external registry/repository package installation, Kiro, or later breadth
  features. It builds the matching experimental code-mode host from the pinned
  Codex source with SHA256-pinned OpenAI V8 assets. Use `--v8-asset-dir DIR`
  with those exact archive and binding files for an offline build.
- Browser automation is headless Chromium on Apple Silicon macOS. Browser and
  MCP network or remote side effects are outside the shell filesystem sandbox;
  every browser tool defaults to an explicit Codex approval prompt.
- Language servers are detected but never installed. Unsupported or unavailable
  semantic operations fall back explicitly.
- The supported validation surface excludes the voice host and V8 cloud-task
  hosts recorded in `runtime/lean-v1.lock.json`.
- Linux remains a benchmark-evaluator target, not a private runtime installation
  target.
- There is no quality, cost, latency, or savings claim, and no held-out result.

## Update

Do not use `codex update` for this source layout; it cannot identify the private
installation method and fails closed. Update by returning to supported upstream,
uninstalling, updating this repository's reviewed pin and patch through the
normal maintenance process, and running a fresh install. Never apply a moving
upstream revision to the old patch or overwrite the managed prefix in place.
The standalone browser manager supports separately reviewed atomic source or
prebuilt-archive updates with rollback; its exact commands are in
[`browser/README.md`](browser/README.md).

## Uninstall

First select upstream and verify it, then uninstall:

```sh
python3 scripts/private_lean_v1.py \
  --prefix "$OMD_PREFIX" \
  --bin-dir "$OMD_BIN_DIR" \
  activate upstream

codex --version

python3 scripts/private_lean_v1.py \
  --prefix "$OMD_PREFIX" \
  --bin-dir "$OMD_BIN_DIR" \
  uninstall

rehash
command -v codex
codex --version
```

Uninstall fails closed unless the launcher and retained artifacts still match and
the exact supported upstream executable will resolve without the managed launcher.
It removes only the managed launcher and install prefix. It does not log out,
delete shared Codex state, remove an external build cache, or uninstall upstream.
The browser runtime, browser binary, MCP package, and bounded browser artifacts
live under that managed prefix and are removed with it.
