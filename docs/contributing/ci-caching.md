# CI caching

How the GitHub workflows cache Cargo downloads, the V8 prebuilt and compiled crates. For the checks themselves,
see [How CI checks a change](ci.md).

## Download caches

PR, main-branch, nightly and release jobs share Cargo download and V8 cache keys.

- Cargo downloads are keyed by OS, architecture and upstream pin, independently of the patch. Cargo fetches any
  missing patched dependencies itself. Restore also accepts earlier patch-specific snapshots for the same pin.
  This avoids another multi-gigabyte download snapshot for every patch edit without discarding existing downloads.
- V8 keys also include the patch manifest, falling back to the same platform and upstream pin. `build.py v8`
  verifies cached files against the pinned checksum before reuse.
- Only nightly and release jobs save these download caches; PR and main-branch checks restore them.
- PR and main-branch jobs never save the mise cache (`cache_save: false`).

## Compile cache

PR native checks, main-branch native checks, nightly jobs and release test/lint jobs use sccache 0.19.0 from
`mise.toml`. This version
[caches metadata-only Rust compilation](https://github.com/mozilla/sccache/blob/v0.19.0/src/compiler/rust.rs),
including library checks under `cargo check`. Setting `OMD_SCCACHE=1` makes `build.py` set `RUSTC_WRAPPER=sccache`.
Linked binaries and procedural macros still require compilation.

Native checks on every push to `main` save the shared lint cache, making it available to new PRs without waiting
for a passing nightly. PRs also save caches for later pushes to the same PR. GitHub scopes those caches to the PR;
other PRs and main-branch jobs cannot restore them. All existing patch replay, drift, formatting and compile checks
still run. Newer pushes cancel superseded checks.

Each job uses a local `SCCACHE_DIR`, restored and saved through `actions/cache`, rather than sccache's GitHub backend.
The lint/PR cache is capped at 1 GB, native and build at 2 GB each, and core at 3 GB. Keys include job, OS,
architecture, upstream pin, mise and build configuration, and commit. Restore prefers the same configuration,
then falls back to the newest cache for that job and OS; sccache validates individual compiler inputs itself.
A commit-specific key lets new commits save added compiler output instead of freezing a patch-keyed snapshot.
GitHub evicts older snapshots under the repository cache budget.

PR native and nightly lint use the same work root and tree name (`/Users/runner/omd/omd-bnightly`), matching `CARGO_*`
settings and the same `build.py check` package set. Both stop the sccache server before saving. PR/main checks save
on success; nightly compile jobs also save after failed validation, but cancelled jobs do not save. Every compile
job reports sccache hit/miss statistics.

For release dry runs and tagged releases, `native`, `core` and `lint` restore compiler caches but do not save
release-specific copies. The `build` job leaves `OMD_SCCACHE` empty and compiles the shipped binaries uncached.
`scripts/build_provenance.py` still refuses a compiler wrapper for release artifacts; its checks are unchanged.
Nightly artifact builds may use sccache and record its version in provenance.

## See also

- [How CI checks a change](ci.md)
- [Change the patched Codex code](runtime.md)
