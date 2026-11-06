# How CI checks a change

What the GitHub workflows run on a pull request, every night and for a release, and why a pull request runs only
part of it. For the test commands you run locally, see [tests/README.md](../../tests/README.md).

## Workflows

| Workflow | Trigger | Does |
| --- | --- | --- |
| `pr.yml` | Pull requests, the merge queue and pushes to `main` | Portable checks, selected native compilation, one `PR gate` status; main pushes warm the compile cache |
| `validate.yml` | Called by the two below | Tests, lints, builds and packages on `macos-15` |
| `nightly.yml` | Daily at 07:17 UTC, or **Run workflow** | Validates; on `main` publishes a nightly prerelease |
| `release.yml` | A `vX.Y.Z` or `vX.Y.Z-rc.N` tag; **Run workflow** is a dry run | Checks versions, validates, publishes the release |
| `issue-triage.yml` | An issue is opened or edited | Adds the `area:` label for the form's Area field |

## Pull requests

Every pull request runs the portable checks on Linux: mod type and static checks (`mise run mods:check`), native
ownership, first-party mod and plugin lock freshness, a selected set of host-free Python tests and workflow linting.
A newer push cancels the older run. Pushes to `main` also run these checks, always including native compilation,
to seed the shared compile cache for new PRs.

There is no workflow-level path filter, so documentation pull requests also report `PR gate`. The gate requires
successful selection and portable checks, and successful native checks when they're selected. Only an
intentionally unselected native job may be skipped. `main` requires `PR gate` with an up-to-date branch.

### When native checks run

`scripts/pr_ci.py` selects the native job. A pull request skips it only when every change is in Markdown, `docs/`,
mod examples, first-party packages, plugins, or the Python and Node `tests/`. Anything else selects it, including
unknown paths, API definitions, dependency locks, shared scripts and workflow changes. Every `runtime/` change
selects it, Markdown copies included, to detect patch drift.

The selection compares the merge commit with its first parent and examines both paths of a rename.

The native job runs on macOS. It replays the patch and fails on drift, runs Rustfmt, and compiles `codex-cli`,
`codex-exec` and every crate the nightly tests, including their tests. Native tests run only in the nightly and release
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
one process per test with one retry. Doc tests run under `cargo test`. Helper builds and nextest commands name the
same `-p` packages, the suite's crates plus the helper packages, and narrow the test run with a nextest filter.
Doctests currently select only the suite crates, so their dependency features can differ. Helper setup selects
the required host and MCP fixture binaries explicitly; release builds select only the seven binaries in the
package, avoiding extra diagnostic binaries. Jobs work under `/Users/runner/omd`, not `/tmp`, which a sandboxed
command may write.

The `package` artifact (7 days) contains the archive, `omd-release.json`, `provenance.json`, `install.sh`, a source
tarball and `SHA256SUMS`. Each job's logs are in `validation-report-JOB` (14 days). The `package` report contains
`profile-acceptance.json`.

The nightly also runs the tests that `mise run mods:test` lists but leaves to other runners:
`python3 -m unittest discover -s tests`, Cargo in the patched scratch tree and
`python3 scripts/mod_host_check.py --scenarios`.

## Nightly builds

Only passing runs on `main` publish. The version is `NEXT-nightly.UTC_TIMESTAMP.RUN_ID.ATTEMPT`, where `NEXT` is the
version in `runtime/release.lock.json`, or its next patch if that is a stable release. A nightly is always a
prerelease and never marked latest.

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

Upstream Codex acceptance binaries are pinned in `upstream-binaries.lock.json`. When advancing Codex, retain pins
needed by the previous release and add the GitHub release asset SHA-256 for the new tag. CI checks it before extraction.
