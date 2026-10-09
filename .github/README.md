# Hosted nightly

`nightly.yml` runs daily at 07:17 UTC and through **Run workflow**. It validates the selected checkout on standard
`macos-15` (Apple Silicon) and `ubuntu-24.04`. Only successful runs on this repository's `main` publish or report
to GitHub; branch dispatches validate without publication. Stable tag-triggered publishing is a separate workflow.

The validation replays the exact upstream pin, verifies V8 artifacts against the upstream-tracked checksum manifest,
checks fresh/second apply and tree parity, and runs native unit/integration/doc tests, Clippy on patched paths,
Rustfmt, ownership, mods types/tests, Python, generated lock/document drift, offline host scenarios and scripted
client acceptance. Core tests use an empty test home and exclude the recorded upstream
`filtered_host_additional_permissions` baseline. Provider credentials and administrator broker deployment are not used.

Hosted builds use two Cargo workers, no incremental artifacts and no debug information. Rust test targets run
serially; Cargo identifies completed test executables for removal while ordinary binaries and dependency libraries remain. A shallow upstream checkout
avoids downloading its entire history. The debug target is removed before the release build, so both profiles do
not occupy runner disk together. No Cargo target cache is restored: patch replay always starts clean.

The macOS job builds hardened signed release binaries, packages the same archive for OMD Core and OMD+, exercises
both profiles' install/reinstall/uninstall from the unpacked archive and recovery, and checks the installer's archive size limit. Both hosted
jobs must pass before the publication job receives a write token. It verifies provenance and checksums, uploads all
assets to a draft, then exposes the prerelease. Versions are `BASE-nightly.UTC_TIMESTAMP.RUN_ID.ATTEMPT` and tags are
`vVERSION`; these builds never become GitHub's latest stable release. Assets are the Apple Silicon archive,
`omd-release.json`, `nightly-provenance.json` and `SHA256SUMS`. Linux validation does not publish Linux packages.

Download `nightly-report-*` from the Actions run for the step report and raw logs (14-day retention). A failed run
opens one issue with its job/step names, report tails and log link. Reruns update the same issue; a successful rerun
closes it. Package artifacts have seven-day Actions retention; published prereleases keep their own assets.

Enable GitHub Actions and issue creation with `GITHUB_TOKEN`, merge the workflow and sources into `main`, then
dispatch a main run. The first successful hosted run is still needed to qualify runner disk use and published
installer metadata. Local fixture tests and workflow lint do not establish that evidence.
