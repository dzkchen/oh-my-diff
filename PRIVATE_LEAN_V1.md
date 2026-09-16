# Private lean-v1 operator guide

This is the minimum maintainer path for the pinned Oh My Diff private lean v1.
It is supported only on Apple Silicon macOS and is not a prebuilt package or a
public release.

## Prerequisites

- This Oh My Diff checkout, including `runtime/lean-v1.lock.json`.
- The supported upstream `codex-cli 0.154.0` executable on `PATH`.
- Rust `1.95.0` available through rustup.
- A new install prefix and a new launcher directory outside `CODEX_HOME` and
  `CODEX_SQLITE_HOME`.

The launcher directory must be earlier on `PATH` than the upstream executable.
The manager does not edit shell profiles, credentials, configuration, or session
databases.

## Install

From this repository:

```sh
OMD_PREFIX="$HOME/.local/share/oh-my-diff/private-lean-v1"
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
uninstall.

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
twelve capability switches. Start with every switch explicit. For OMD direct
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

## Limitations

- Live provider access, account eligibility, repository-data authorization,
  quotas, prices, model availability, and route behavior must be checked in the
  current environment. Synthetic fixtures do not verify them.
- The private build does not bundle browser tooling, TypeScript mods, Kiro, a
  code-mode host, or the later breadth features.
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
