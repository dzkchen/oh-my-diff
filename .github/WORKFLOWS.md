# Workflows

How CI, nightly builds and releases work.

| Workflow | Trigger | Does |
| --- | --- | --- |
| `pull-request.yml` | pull requests | Changelog and Markdown link check |
| `validate.yml` | called by nightly and release | Full hosted validation and the verified Apple Silicon package |
| `nightly.yml` | **Run workflow** (daily once the repository is public) | Validates; on `main` publishes a nightly prerelease and reports failures |
| `release.yml` | `vX.Y.Z` / `vX.Y.Z-rc.N` tags, **Run workflow** (dry run) | Checks versions, validates, publishes the GitHub Release |

## Releases

The version lives in `runtime/release.lock.json` and the entry in `changelog.json`. `CHANGELOG.md` and the release
notes are generated from them.

1. Start the release:

   ```sh
   mise run release -- 1.2.0 --summary "One sentence."
   ```

   This branches from `origin/main`, sets the version, adds a changelog entry from the Conventional Commits since
   the last one (git-cliff), and opens a `chore(release): 1.2.0` pull request. To edit the entry, change it there,
   then run `python3 scripts/release.py render`.
2. Optional dry run. It builds, validates and verifies everything, and prints the publication commands without
   publishing:

   ```sh
   gh workflow run release.yml --ref release/v1.2.0 -f version=1.2.0
   ```

3. Squash-merge the pull request, then run `mise run release -- 1.2.0` again. It tags the merged `main` commit and
   pushes the tag.
4. The tag runs `release.yml`. The tag must be on `main`, and the lock, changelog and links must agree. Then it
   validates and packages, uploads every asset to a draft, and publishes it. Publishing moves the installer and
   `omd update` to the new release.

Release candidates (`-rc.N`) are prereleases on the beta channel.

### Withdraw a bad release

```sh
python3 scripts/release.py rollback 1.2.0
```

This returns the release to draft, so the installer and `omd update` stop offering it, and marks the previous
stable release as latest. Users who already updated run `omd update rollback`.

### Versioning

- A Codex pin advance that changes the required upstream minor: minor release.
- A mod API major: major release.
- A security fix: patch release on the current minor.

Each release's `omd-release.json` and `provenance.json` record its pinned Codex version.

### Signing

Publication (nightly, release and dry run) signs `omd-release.json` as `omd-release.json.sig` with `ssh-keygen -Y
sign` (namespace `oh-my-diff-release`) and the `OMD_RELEASE_SIGNING_KEY` repository secret. The result is checked
against the public key pinned in `install.sh` and `scripts/authority_broker.py`.

Installs, updates and broker deployment accept only manifests that verify. To rotate the key, change both pinned
copies and the secret together.

## Nightly

Only successful runs on `main` publish. Branch dispatches validate without publishing.

- Version: `NEXT-nightly.UTC_TIMESTAMP.RUN_ID.ATTEMPT`. `NEXT` is the committed release version, or its next patch
  once that's released.
- Tag: `vVERSION`. Always a prerelease, never GitHub's latest.
- A failed run opens one issue with job and step names, report tails and a log link. A successful rerun closes it.

## Validation

`validate.yml` runs on `macos-15` (Apple Silicon) and `ubuntu-24.04`. It replays the exact upstream pin, then runs
native tests, Clippy, Rustfmt, ownership checks, mods types and tests, Python tests, lock-drift checks, offline host
scenarios and scripted client acceptance.

Core tests use an empty test home and skip the recorded upstream `filtered_host_additional_permissions` baseline.
No provider credentials or broker deployment are used.

Hosted builds are lean: shallow upstream checkout, two Cargo workers, no incremental artifacts or debug
information, serial Rust tests and no Cargo cache.

### The macOS package

The macOS job builds hardened signed release binaries once and packages one archive for OMD Core and OMD+. From
the unpacked archive it tests install, reinstall, uninstall and recovery for both profiles, and the installer's
size limit.

The `package` artifact holds the archive, `omd-release.json`, `provenance.json`, `install.sh`, a `git archive`
source tarball and `SHA256SUMS`. Logs are in `validation-report-*` (14 days). Orchestration lives in
`.github/scripts/`.

## Repository settings

`.github/settings.json` holds labels, merge settings and `main` branch protection. Apply it with:

```sh
mise run github:settings -- all
```

Add `--dry-run` to preview.
