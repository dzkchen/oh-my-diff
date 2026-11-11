# How CI checks a change

Pull requests run selected checks; nightly and release workflows run the full suite. The tables below list each
workflow and job. For local test commands, see [tests/README.md](../../tests/README.md).

## Workflows

| Workflow | Trigger | Does |
| --- | --- | --- |
| `pr.yml` | Pull requests, the merge queue and pushes to `main` | Portable checks, selected native compilation and one `PR gate` status |
| `validate.yml` | Called by the two below | Tests, lints, builds and packages on `macos-15` |
| `nightly.yml` | Daily at 07:17 UTC, or **Run workflow** | Validates; on `main` publishes a nightly prerelease |
| `release.yml` | A `vX.Y.Z` or `vX.Y.Z-rc.N` tag; **Run workflow** is a dry run | Checks versions, validates or reuses a passing dry run for the same commit, then publishes |
| `issue-triage.yml` | An issue is opened or edited | Adds the `area:` label for the form's Area field |

## Pull requests

Every pull request runs the portable checks on Linux: mod type and static checks (`mise run mods:check`), native
ownership, first-party mod and plugin lock freshness, a selected set of host-free Python tests and workflow linting.
A newer push cancels the older run. Pushes to `main` use the same native selection and warm the shared compile
cache when native inputs change. A documentation-only push does not rebuild Rust.

There is no workflow-level path filter, so documentation pull requests also report `PR gate`. The gate requires
successful selection and portable checks, and successful native checks when they're selected. Only an
intentionally unselected or exactly reused native job may be skipped. `main` requires `PR gate` with an up-to-date branch.

### When native checks run

`scripts/pr_ci.py` selects the native job. A pull request skips it only when every change is in Markdown, `docs/`,
mod examples, first-party packages, plugins, or the Python and Node `tests/`. Anything else selects it, including
unknown paths, API definitions, dependency locks, shared scripts and workflow changes. Every `runtime/` change
selects it, Markdown copies included, to detect patch drift.

For a pull request, the selection compares the merge commit with its first parent. A main push compares against the
commit before the push, including every pushed commit. The merge queue supplies its base commit. The selection examines
both paths of a rename. A new push to a pull request selects checks from the entire merged diff again. Before starting
native work, CI looks for a successful validation with exactly the same native inputs. A hit skips native work; portable
checks and a fresh `PR gate` still run. Updating a branch with unrelated main changes can therefore reuse its previous
native validation while keeping the up-to-date branch requirement.

The native job runs on macOS. It replays the patch and fails on drift, runs Rustfmt, and compiles `codex-cli`,
`codex-exec` and all crates tested by the nightly, including their test targets. Native tests run only in the nightly
and release workflows, together with full validation.

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
one process per test with one retry. Doc tests run under `cargo test`. Helper builds and nextest commands name the
same `-p` packages, the suite's crates plus the helper packages, and narrow the test run with a nextest filter.
Doctests currently select only the suite crates, so their dependency features can differ. Helper setup selects
the required host and MCP fixture binaries explicitly; release builds select only the seven binaries in the
package, avoiding extra diagnostic binaries. Jobs work under `/Users/runner/omd` rather than `/tmp`, because sandboxed
commands may write to `/tmp`.

The `package` artifact (7 days) contains the archive, `omd-release.json`, `provenance.json`, `install.sh`, a source
tarball and `SHA256SUMS`. Each job's logs are in `validation-report-JOB` (14 days). The `package` report contains
`profile-acceptance.json`.

The nightly also runs the tests that `mise run mods:test` lists but leaves to other runners:
`python3 -m unittest discover -s tests`, Cargo in the patched scratch tree and
`python3 scripts/mod_host_check.py --scenarios`.

Upstream Codex acceptance binaries are pinned in `upstream-binaries.lock.json`. When advancing Codex, retain pins
needed by the previous release and add the GitHub release asset SHA-256 for the new tag. CI checks it before extraction.

## Nightly builds

Only passing runs on `main` publish. The version is `NEXT-nightly.UTC_TIMESTAMP.RUN_ID.ATTEMPT`, where `NEXT` is the
version in `runtime/release.lock.json`, or its next patch if that is a stable release. A nightly is always a
prerelease and never marked latest.

For a release tag, CI can download the package from a passing release dry run for that exact commit and version.
The tag run checks the dry run's workflow, jobs and artifact identity, then verifies the downloaded package and
signs it before publishing. If no eligible package remains, CI runs full validation. Nightly compiler caches do
not qualify a package for this reuse. See [Cut a release](release.md).

Releases and first-party mod bundles (the manual Mods workflow) are in [Cut a release](release.md).

## Repository settings

`.github/settings.json` records the labels, merge settings, `main` protection and the `release` environment that
holds the signing key. The maintainer applies it.
Dependabot (`.github/dependabot.yml`) opens one grouped pull request a month for GitHub Actions updates. There are
no dependency license or scheduled vulnerability checks.

## See also

- [CI caching](ci-caching.md): the download and compile caches, for maintainers changing the workflows
- [Change the patched Codex code](runtime.md)
- [tests/README.md](../../tests/README.md): how tests are discovered and which runner runs each kind
