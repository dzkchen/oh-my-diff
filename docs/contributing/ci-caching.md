# CI caching

GitHub workflows cache Cargo downloads, the V8 prebuilt and compiled crates. This page explains the cache keys,
which jobs save them and how restores work. For the checks, see [How CI checks a change](ci.md).

## Successful native validation

The PR workflow caches a small success marker only after patch replay, drift, Rustfmt and native compilation
pass. The lookup requires an exact key; there are no prefix fallback keys. Portable checks run every time.

The key hashes Git tree entries (paths, modes and content IDs) for all native-selected inputs, including the
native patch and mirrors, upstream pin, API, dependency locks, build scripts, tool configuration and workflows.
Unknown paths invalidate reuse. Documentation, first-party mod sources, examples, plugins and host-free tests
follow the selector's existing exclusions. The mod, plugin and release metadata locks are excluded from this
native fingerprint; portable checks validate them on every run. Changing any included input forces fresh native
validation, even if it arrived through a merge from main.

The marker is separate from the compiler cache and contains no binaries. GitHub's branch cache scope applies:
PRs can reuse their own markers or main's; unrelated PR caches are not shared. Missing or evicted markers cause
a fresh run. Existing green runs from before this mechanism do not have markers and cannot be reused. The
`macos-15` runner and workflow configuration are part of the key; hosted runner image updates are not pinned.
This reuse does not qualify release artifacts or replace nightly tests.

## Download caches

PR, main-branch, nightly and release jobs share Cargo download and V8 cache keys.

- Cargo downloads are keyed by OS, architecture and upstream pin, independently of the patch. Cargo fetches any
  missing patched dependencies itself. Restore also accepts earlier patch-specific snapshots for the same pin.
  A patch edit can therefore reuse the downloads for its upstream pin.
- V8 keys also include the patch manifest, falling back to the same platform and upstream pin. `build.py v8`
  verifies cached files against the pinned checksum before reuse.
- Only nightly and release jobs save these download caches; PR and main-branch checks restore them.
- PR and main-branch jobs never save the mise cache (`cache_save: false`).

## Compile cache

PR native checks, main-branch native checks, nightly jobs and release test/lint jobs use sccache 0.19.0 from
`mise.toml`. This version
[caches metadata-only Rust compilation](https://github.com/mozilla/sccache/blob/v0.19.0/src/compiler/rust.rs),
including library checks under `cargo check`. Setting `OMD_SCCACHE=1` makes `build.py` set `RUSTC_WRAPPER=sccache`.
It defaults `CARGO_INCREMENTAL` to `0` and refuses an explicit incremental setting of `1` or a conflicting compiler
wrapper. Linked binaries and procedural macros still require compilation.

Native checks on `main` save the shared lint cache when its key is absent, making it available to new PRs without
waiting for a passing nightly. PRs can save their own baseline for later pushes. GitHub scopes those caches to the
PR; other PRs and main-branch jobs cannot restore them. When there is no exact success marker, patch replay, drift, formatting and compile checks still
run. Newer pushes cancel superseded checks.

Each job uses a local `SCCACHE_DIR`, restored and saved through `actions/cache`, rather than sccache's GitHub backend.
The lint/PR cache is capped at 1 GB, native and build at 2 GB each, and core at 3 GB. Keys include job, OS,
architecture, upstream pin, mise and build configuration. Restore prefers the same configuration, including older
per-commit snapshots, then falls back to that job and platform; sccache validates individual compiler inputs.

Each key holds one immutable baseline. Source edits reuse that baseline instead of uploading another full copy
after every commit. This leaves room for the nightly native, core and build caches alongside the lint cache and
Cargo downloads. A changed patch can miss the baseline and recompile its changed crates; the next run may need
to compile those crates again. Changes to the upstream pin, tool versions or build wrapper create a new key.
GitHub can still evict caches under its storage and retention limits.

On November 10, 2026, [nightly run 42845598062](https://github.com/dzkchen/oh-my-diff/actions/runs/42845598062)
spent 7,814 seconds building the host with no restored compiler cache and zero cache hits. A subsequent cache
inspection found ten lint snapshots totaling 7.93 GiB, 2.56 GiB of Cargo downloads and no native, core or build
snapshot. [PR run 42926063515](https://github.com/dzkchen/oh-my-diff/actions/runs/42926063515) already had a 99.82%
compiler cache hit rate. The baseline policy reduces duplicate storage; its effect on hosted run times still needs
a cold and warm comparison after rollout.

PR native and nightly lint use the same work root and tree name (`/Users/runner/omd/omd-bnightly`), matching `CARGO_*`
settings and the same `build.py check` package set. Both stop the sccache server before saving. PR/main checks save
on success; nightly compile jobs also save after failed validation, but cancelled jobs do not save. Every compile
job reports sccache hit/miss statistics. A baseline that already exists is restored without another upload.

For release dry runs and tagged releases, `native`, `core` and `lint` restore compiler caches but do not save
release-specific copies. The `build` job leaves `OMD_SCCACHE` empty and compiles the shipped binaries uncached.
`scripts/build_provenance.py` still refuses a compiler wrapper for release artifacts; its checks are unchanged.
Nightly artifact builds may use sccache and record its version in provenance.

## See also

- [How CI checks a change](ci.md)
- [Change the patched Codex code](runtime.md)
