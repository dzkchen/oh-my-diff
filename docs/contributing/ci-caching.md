# CI caching

How the GitHub workflows cache Cargo downloads, the V8 prebuilt and compiled crates, for maintainers changing the
workflows. For what each workflow runs, see [How CI checks a change](ci.md).

## Download caches

PR, nightly and release jobs use the same Cargo download-cache and V8 prebuilt-cache keys.

- PR runs only restore. A patch edit falls back to the newest cache for the same platform and upstream pin.
- Only nightly and release runs save, because a cache saved by a PR is visible to that PR alone.
- PR checks set `OMD_WORK_ROOT` to the path validation uses, so the V8 cache is restored where validation saved it.
- `build.py v8` reuses a cached V8 file only when it matches the pinned checksum, and retries a failed download.
- PR jobs never save the mise cache (`cache_save: false`).

## Compile cache

Nightly jobs set `OMD_SCCACHE=1`, which makes `build.py` set `RUSTC_WRAPPER=sccache` (pinned in `mise.toml`) over a
local 2 GB `SCCACHE_DIR`, not the GitHub backend. Each job restores that directory with `actions/cache/restore` and
saves it with `if: always()` as `sccache-JOB-OS-HASH-RUN_ID-ATTEMPT`, where `HASH` covers `upstream.lock.json` and
`runtime/patches/manifest.json`. Because the job always saves, a failed run still keeps what it compiled. Restore
falls back to the newest cache for the job. `sccache --show-stats` ends every job.

PR `native` restores `sccache-lint-*`, which the nightly `lint` job fills with the same check. For the keys to match,
PR `native` uses the nightly work root and tree name (`/Users/runner/omd/omd-bnightly`), the same `CARGO_*` values
and the same `build.py check` package set, because a cache key includes the compile directory and every `CARGO_*`
variable.

Tagged releases leave `OMD_SCCACHE` empty and compile uncached. `scripts/build_provenance.py` accepts
`RUSTC_WRAPPER=sccache` only for a build without `OMD_RELEASE_VERSION` and records the wrapper and its version.
`CARGO_BUILD_JOBS` is set once in `validate.yml` and once in `pr.yml`.

## See also

- [How CI checks a change](ci.md)
- [Change the patched Codex code](runtime.md)
