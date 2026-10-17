# Hosted nightly

`nightly.yml` runs through **Run workflow**; the daily schedule is enabled once the repository is public. It validates
the selected checkout on standard `macos-15` (Apple Silicon) and `ubuntu-24.04`. Only runs on this repository's `main`
publish or report to GitHub; branch dispatches validate without publication. Stable tag-triggered publishing is a
separate workflow.

The validation replays the exact upstream pin, verifies V8 artifacts against the upstream-tracked checksum manifest,
checks fresh/second apply and tree parity, and runs native unit/integration/doc tests, Clippy on patched paths,
Rustfmt, ownership, mods types/tests, Python, generated lock/document drift, offline host scenarios and scripted
client acceptance. Core tests use an empty test home and exclude the recorded upstream
`filtered_host_additional_permissions` baseline. Provider credentials and administrator broker deployment are not used.

Hosted builds use a shallow upstream checkout, two Cargo workers, no incremental artifacts and no debug information.
Rust test targets run serially and each finished test executable is removed. No Cargo target cache is restored.

The macOS job builds hardened signed release binaries once, removes the Cargo target, packages one archive for OMD
Core and OMD+, exercises both profiles' install/reinstall/uninstall from the unpacked archive and recovery, and checks
the installer's archive size limit. Both hosted jobs must pass before the publication job receives a write token. It
verifies provenance and checksums, uploads all assets to a draft, then exposes the prerelease. Versions are
`BASE-nightly.UTC_TIMESTAMP.RUN_ID.ATTEMPT` and tags are `vVERSION`; these builds never become GitHub's latest stable
release. Assets are the Apple Silicon archive, `omd-release.json`, `nightly-provenance.json` and `SHA256SUMS`. Linux
validation does not publish Linux packages.

Download `nightly-report-*` from the Actions run for the step report and raw logs (14-day retention). A failed run
opens one issue with its job/step names, report tails and log link. Reruns update the same issue; a successful rerun
closes it. Package artifacts have seven-day Actions retention; published prereleases keep their own assets.

Hosted orchestration lives in `.github/scripts/` and uses only tracked build inputs.
