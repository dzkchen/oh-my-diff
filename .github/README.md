# Workflows

| Workflow | Trigger | Does |
| --- | --- | --- |
| `pull-request.yml` | pull requests | Conventional Commits title; changelog and Markdown link check |
| `validate.yml` | called by nightly and release | Full hosted validation and the verified Apple Silicon package |
| `nightly.yml` | **Run workflow** (daily once the repository is public) | Validates; on `main` publishes a nightly prerelease and reports failures |
| `release.yml` | `vX.Y.Z` / `vX.Y.Z-rc.N` tags, **Run workflow** (dry run) | Checks versions, validates, publishes the GitHub Release |

## Validation

`validate.yml` runs on standard `macos-15` (Apple Silicon) and `ubuntu-24.04`. It replays the exact upstream pin,
verifies V8 artifacts against the upstream-tracked checksum manifest, checks fresh/second apply and tree parity,
and runs native unit/integration/doc tests, Clippy on patched paths, Rustfmt, ownership, mods types/tests, Python,
generated lock/document drift, offline host scenarios and scripted client acceptance. Core tests use an empty test
home and exclude the recorded upstream `filtered_host_additional_permissions` baseline. Provider credentials and
administrator broker deployment are not used.

Hosted builds use a shallow upstream checkout, two Cargo workers, no incremental artifacts and no debug
information. Rust test targets run serially and finished test executables are removed. No Cargo cache is restored:
patch replay always starts clean.

The macOS job builds hardened signed release binaries once, removes the Cargo target, packages one archive for OMD
Core and OMD+, exercises both profiles' install, reinstall, uninstall and recovery from the unpacked archive, and
checks the installer's size limit. The `package` artifact holds
the archive, `omd-release.json`, `provenance.json`, `install.sh`, a `git archive` source tarball and `SHA256SUMS`.
Logs are in `validation-report-*` (14 days). Hosted orchestration lives in `.github/scripts/` and uses only
tracked build inputs.

## Nightly

Only successful runs on `main` publish; branch dispatches validate without publication. Versions are `NEXT-nightly.UTC_TIMESTAMP.RUN_ID.ATTEMPT`, where `NEXT` is the
committed release version (its next patch once that version is released); tags are `vVERSION`, always prereleases
and never GitHub's latest. A failed run opens one issue with its job/step names, report tails and log link; reruns
update it and a successful rerun closes it.

## Releases

The release version lives in `runtime/release.lock.json` and the entry in `changelog.json`; `CHANGELOG.md`
and the release notes are generated from it. One command runs the whole flow:

1. `mise run release -- 1.2.0 --summary "One sentence."` branches from `origin/main`, sets the version, adds a
   changelog entry from the Conventional Commits since the last entry (git-cliff), and opens a
   `chore(release): 1.2.0` pull request. Edit the entry there if needed, then `python3 scripts/release.py render`.
2. Optional dry run: `gh workflow run release.yml --ref release/v1.2.0 -f version=1.2.0` builds, validates and
   verifies everything and prints the publication commands without publishing.
3. Squash-merge the pull request, then run `mise run release -- 1.2.0` again. It tags the merged `main` commit
   and pushes the tag.
4. The tag runs `release.yml`: the tag must be on `main`, the lock, changelog and links must agree, then validation
   and packaging run. Publication uploads every asset to a draft and only then publishes it, which moves the
   installer and `omd update` to it. Release candidates (`-rc.N`) are prereleases on the beta channel.

Withdraw a bad release with `python3 scripts/release.py rollback 1.2.0`: it returns the release to draft, so the
installer and `omd update` stop offering it, and marks the previous stable release as latest. Users who already
updated run `omd update rollback`.

Versioning: a Codex pin advance that changes the required upstream minor is a minor release; a mod API major is a
major release; a security fix is a patch release on the current minor. Each release's `omd-release.json` and
`provenance.json` record its pinned Codex version.

## Repository settings

`.github/settings.json` holds labels, merge settings and `main` branch protection. Apply it with
`mise run github:settings -- all` (`--dry-run` previews).
