# Workflows

| Workflow | Trigger | Does |
| --- | --- | --- |
| `pr.yml` | pull requests and merge queue | Portable checks, selected native compilation, one `PR gate` status |
| `validate.yml` | called by the two below | Tests, builds and packages on `macos-15` |
| `nightly.yml` | daily at 07:17 UTC, or **Run workflow** | Validates; on `main` publishes a nightly prerelease |
| `release.yml` | `vX.Y.Z` or `vX.Y.Z-rc.N` tag; **Run workflow** is a dry run | Checks versions, validates, publishes the release |

## Pull requests

Every PR runs mod type/static checks, native ownership, first-party mod and plugin lock freshness, selected
host-free Python tests and workflow linting on Linux. Superseded runs are cancelled. There is no workflow-level path
filter, so documentation PRs also report `PR gate`. The gate requires successful selection and portable checks, and
successful native checks when selected; only an intentionally unselected native job may be skipped.

Changes outside Markdown, `docs/`, mod examples/first-party packages, plugins and Python/Node `tests/` select macOS
patch replay, drift checking and compilation, tests included, of the crates nightly tests plus `codex-cli` and
`codex-exec`. This conservative default includes unknown paths, API definitions, dependency locks, shared scripts
and workflow changes. Pull requests compare the merge commit with its first parent. Renames examine both paths. All
`runtime/` changes, including Markdown mirrors, select native checks to detect patch drift. Other package-only and
documentation-only changes avoid Rust builds. Native tests are compiled here; their execution and full validation
remain in nightly and release workflows.

PR, nightly and release jobs use the same Cargo download-cache and V8 prebuilt-cache keys. PR runs only restore: a
patch edit falls back to the newest cache for the same platform and upstream pin. Only nightly and release runs save,
since a cache saved by a PR is visible to that PR alone. PR checks set `OMD_V8_DIR` to the path validation saves, and
`build.py v8` reuses a cached V8 file only when it matches the pinned checksum, retrying a failed download.

`main` requires **PR gate** with an up-to-date branch. Dependabot (`dependabot.yml`) opens one grouped pull request a
month for GitHub Actions updates. There are no dependency license or scheduled vulnerability checks yet.

## Validation

`validate.yml` runs `.github/scripts/ci.py validate --job JOB` in three jobs. No provider credentials are used.

- `test` sets up the pinned Codex tree, applies and re-syncs the patch, and fails if the result differs from the
  checkout. It then runs native tests, Clippy on patched paths, Rustfmt, native ownership, lock drift and mod type
  checks. One upstream test, `filtered_host_additional_permissions`, is excluded as a known baseline failure. The
  `codex-core` integration suite is advisory for a release and required for a nightly. Tests run in parallel under
  `cargo nextest` with upstream's `.config/nextest.toml` and the overrides in `.github/nextest.toml`, one process
  per test with one retry; doc tests run under `cargo test`. Jobs work under `/Users/runner/omd`, not `/tmp`, which a sandboxed command may write.
- `build` builds and signs the release host binaries in parallel with `test`.
- `package` takes those binaries, runs mod tests, Python tests, mod-host scenarios and client acceptance, then packs
  one archive for both profiles and tests install, reinstall, uninstall and recovery.

The `package` artifact (7 days) holds the archive, `omd-release.json`, `provenance.json`, `install.sh`, a source
tarball and `SHA256SUMS`. Each job's logs are in `validation-report-JOB` (14 days).

## Nightly

Only passing runs on `main` publish. The version is `NEXT-nightly.UTC_TIMESTAMP.RUN_ID.ATTEMPT`, where `NEXT` is the
version in `runtime/release.lock.json`, or its next patch if that is a stable release. A nightly is always a
prerelease and never marked latest.

## Releases

The version lives in `runtime/release.lock.json`; release notes and `CHANGELOG.md` come from `release/changelog.json`. The
host reports its crate version as the OMD release, so first set `codex-omd` and `codex-omd-runner` to the release
version in a scratch tree, `build.py sync` and merge that; `mise run release` and `release.yml` refuse a mismatch.

1. `mise run release -- 1.2.0 --summary "One sentence."` opens a `chore(release): 1.2.0` pull request with the version
   and a changelog entry with one line per pull request or direct commit merged to `main` since the last one. Edit the entry if needed, then run
   `python3 scripts/release.py render`.
2. Optional dry run: `gh workflow run release.yml --ref release/v1.2.0 -f version=1.2.0` validates, packages, signs
   and prints the publish commands.
3. If more pull requests merged to `main` since, run `mise run release -- 1.2.0` again: it merges `main` into the
   release branch and adds their lines to the entry. Edit and render again.
4. Merge it, then run `mise run release -- 1.2.0` once more to tag `main`.
5. The tag runs `release.yml`: it checks the tag is on `main` and that versions and changelog agree, validates,
   then publishes a draft release and makes it live (this is what the installer and `omd update` read). `-rc.N`
   tags are prereleases, offered on the prerelease channel.

**Signing:** publication signs `omd-release.json` (`ssh-keygen -Y sign`, namespace `oh-my-diff-release`) with the
`OMD_RELEASE_SIGNING_KEY` secret. The installer (`install.sh`) and `scripts/authority_broker.py` verify it against a
pinned public key; to rotate, change both pins and the secret together.

**Withdraw:** `python3 scripts/release.py rollback 1.2.0` returns it to draft and re-marks the previous stable release
as latest. Users who already updated run `omd update rollback`.

## Repository settings

`.github/settings.json` records the labels, merge settings and `main` protection. The maintainer applies it.
