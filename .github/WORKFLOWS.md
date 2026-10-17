# Workflows

| Workflow | Trigger | Does |
| --- | --- | --- |
| `validate.yml` | called by nightly and release | Full validation and the Apple Silicon package (`macos-15`) |
| `nightly.yml` | **Run workflow** (daily once public) | Validates; on `main` publishes a nightly prerelease |
| `release.yml` | `vX.Y.Z` / `vX.Y.Z-rc.N` tags; **Run workflow** = dry run | Checks versions, validates, publishes the release |

## Validation

`.github/scripts/nightly_ci.py validate` replays the upstream pin (V8 checksums, fresh and second apply, tree
parity), then runs native tests, Clippy on patched paths, Rustfmt, ownership, mod types and tests, Python, lock
drift, host scenarios and client acceptance. It skips the recorded upstream `filtered_host_additional_permissions`
baseline and uses no provider credentials or broker. Builds start clean (no Cargo cache).

Then it builds signed release binaries, packages one archive for both profiles, and tests install, reinstall,
uninstall and recovery. The `package` artifact holds the archive, `omd-release.json`, `provenance.json`,
`install.sh`, a source tarball and `SHA256SUMS`; logs are in `validation-report` (14 days).

## Nightly

Only passing runs on `main` publish. Version: `NEXT-nightly.UTC_TIMESTAMP.RUN_ID.ATTEMPT`, where `NEXT` is the
committed release version (next patch once it's released). Always a prerelease, never latest. GitHub emails you
when a run fails.

## Releases

The version lives in `runtime/release.lock.json`; release notes and `CHANGELOG.md` come from `changelog.json`.

1. `mise run release -- 1.2.0 --summary "One sentence."` opens a `chore(release): 1.2.0` PR with the version and a
   changelog entry from commits since the last one. Edit the entry if needed, then `python3 scripts/release.py render`.
2. Optional dry run: `gh workflow run release.yml --ref release/v1.2.0 -f version=1.2.0` (validates, packages,
   signs, prints the publish commands).
3. Squash-merge, then run `mise run release -- 1.2.0` again to tag `main`.
4. The tag runs `release.yml`: tag on `main`, versions and changelog agree, validate, then publish as a draft and
   flip it live (moves the installer and `omd update`). `-rc.N` releases are prereleases on the beta channel.

**Signing:** publication signs `omd-release.json` (`ssh-keygen -Y sign`, namespace `oh-my-diff-release`) with the
`OMD_RELEASE_SIGNING_KEY` secret and checks it against the key pinned in `install.sh` and
`scripts/authority_broker.py`. To rotate, change both pins and the secret together.

**Withdraw:** `python3 scripts/release.py rollback 1.2.0` returns it to draft and re-marks the previous stable as
latest. Users who updated run `omd update rollback`.

**Versioning:** a new required Codex minor → minor release; a mod API major → major; a security fix → patch.

## Repository settings

`.github/settings.json` records the labels, merge settings and `main` protection. The maintainer applies it.
