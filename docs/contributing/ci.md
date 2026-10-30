# How CI checks a change

What the GitHub workflows run on a pull request, every night and for a release, and why a pull request runs only
part of it. For the test commands you run locally, see [tests/README.md](../../tests/README.md).

## Workflows

| Workflow | Trigger | Does |
| --- | --- | --- |
| `pr.yml` | Pull requests and the merge queue | Portable checks, selected native compilation, one `PR gate` status |
| `validate.yml` | Called by the two below | Tests, lints, builds and packages on `macos-15` |
| `nightly.yml` | Daily at 07:17 UTC, or **Run workflow** | Validates; on `main` publishes a nightly prerelease |
| `release.yml` | A `vX.Y.Z` or `vX.Y.Z-rc.N` tag; **Run workflow** is a dry run | Checks versions, validates, publishes the release |

## Pull requests

Every pull request runs the portable checks on Linux: mod type and static checks (`mise run mods:check`), native
ownership, first-party mod and plugin lock freshness, a selected set of host-free Python tests and workflow linting.
A newer push cancels the older run.

There is no workflow-level path filter, so documentation pull requests also report `PR gate`. The gate requires
successful selection and portable checks, and successful native checks when they're selected. Only an
intentionally unselected native job may be skipped. `main` requires `PR gate` with an up-to-date branch.

### When native checks run

`scripts/pr_ci.py` selects the native job. Changes outside Markdown, `docs/`, mod examples and first-party packages,
plugins and Python and Node `tests/` select it. This conservative default includes unknown paths, API definitions,
dependency locks, shared scripts and workflow changes. Every `runtime/` change selects it, Markdown copies included,
to detect patch drift. Other package-only and documentation-only changes avoid Rust builds.

The selection compares the merge commit with its first parent and examines both paths of a rename.

The native job runs on macOS. It replays the patch and fails on drift, runs Rustfmt, and compiles the crates nightly
tests plus `codex-cli` and `codex-exec`, tests included. Native tests run only in the nightly and release
workflows, together with full validation.

## Validation

`validate.yml` runs `.github/scripts/ci.py validate --job JOB` in five jobs, and a sixth job, `package`, runs `ci.py
package`. It uses no provider credentials. Four macOS jobs start together, and `acceptance` and `package` follow
`build`, so at most five run at once, the free-plan limit.

| Job | Runs |
| --- | --- |
| `native` | Sets up the pinned Codex tree and runs the native crate tests |
| `core` | `codex-core` unit tests and its `all` integration suite, advisory for a release and required for a nightly |
| `lint` | Applies and re-syncs the patch and fails if the result differs from the checkout, then Clippy on patched paths, a `cargo check --tests` of the crates a pull request compiles (to fill the PR compile cache), Rustfmt, native ownership, lock drift and mod type checks |
| `build` | Builds and signs the release host binaries |
| `acceptance` | Mod tests, Python tests, mod-host scenarios and client acceptance, on the `build` binaries |
| `package` | Packs one archive for both profiles from the `build` binaries and tests install, reinstall, uninstall and recovery |

One upstream test, `filtered_host_additional_permissions`, is excluded as a known baseline failure. Tests run in
parallel under `cargo nextest` with upstream's `.config/nextest.toml` and the overrides in `.github/nextest.toml`,
one process per test with one retry. Doc tests run under `cargo test`. Every cargo command in a job names the same
`-p` packages, the suite's crates plus the helper binaries, and narrows the run with a nextest filter, so features
unify once and dependencies compile once. Jobs work under `/Users/runner/omd`, not `/tmp`, which a sandboxed command
may write.

The `package` artifact (7 days) contains the archive, `omd-release.json`, `provenance.json`, `install.sh`, a source
tarball and `SHA256SUMS`. Each job's logs are in `validation-report-JOB` (14 days). The `package` report contains
`profile-acceptance.json`.

The nightly runs the tests that `mise run mods:test` only assigns: `python3 -m unittest discover -s tests`, Cargo in
the patched scratch tree and `python3 scripts/mod_host_check.py --scenarios`.

## Nightly builds

Only passing runs on `main` publish. The version is `NEXT-nightly.UTC_TIMESTAMP.RUN_ID.ATTEMPT`, where `NEXT` is the
version in `runtime/release.lock.json`, or its next patch if that is a stable release. A nightly is always a
prerelease and never marked latest.

Releases are in [Cut a release](release.md).

## Repository settings

`.github/settings.json` records the labels, merge settings and `main` protection. The maintainer applies it.
Dependabot (`.github/dependabot.yml`) opens one grouped pull request a month for GitHub Actions updates. There are
no dependency license or scheduled vulnerability checks.

## Caching

This section is for maintainers changing the workflows.

### Download caches

PR, nightly and release jobs use the same Cargo download-cache and V8 prebuilt-cache keys. PR runs only restore: a
patch edit falls back to the newest cache for the same platform and upstream pin. Only nightly and release runs
save, since a cache saved by a PR is visible to that PR alone. PR checks set `OMD_WORK_ROOT` to the path validation
uses, so the V8 cache is restored where validation saved it. `build.py v8` reuses a cached V8 file only when it
matches the pinned checksum and retries a failed download. PR jobs never save the mise cache (`cache_save: false`).

### Compile cache

Nightly jobs set `OMD_SCCACHE=1`, which makes `build.py` set `RUSTC_WRAPPER=sccache` (pinned in `mise.toml`) over a
local 2 GB `SCCACHE_DIR`, not the GitHub backend. Each job restores that directory with `actions/cache/restore` and
saves it with `if: always()` as `sccache-JOB-OS-HASH-RUN_ID-ATTEMPT`, where `HASH` covers `upstream.lock.json` and
`runtime/patches/manifest.json`, so a failed run still keeps what it compiled. Restore falls back to the newest
cache for the job. `sccache --show-stats` ends every job.

A cache key includes the compile directory and every `CARGO_*` variable. So PR `native` uses the nightly work root
and tree name (`/Users/runner/omd/omd-bnightly`), the same `CARGO_*` values and the same `build.py check` package
set, and restores `sccache-lint-*`, which the nightly `lint` job fills with that exact check.

Tagged releases leave `OMD_SCCACHE` empty and compile uncached. `scripts/build_provenance.py` accepts
`RUSTC_WRAPPER=sccache` only for a build without `OMD_RELEASE_VERSION` and records the wrapper and its version.
`CARGO_BUILD_JOBS` is set once in `validate.yml` and once in `pr.yml`.

## See also

- [Change the patched Codex code](runtime.md)
- [tests/README.md](../../tests/README.md): how tests are discovered and which runner runs each kind
