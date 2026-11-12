# Cut a release

The maintainer prepares a release pull request, merges it, then pushes a tag to publish. The tag workflow can reuse
a successful release dry run on the same commit. Nightly prereleases publish automatically; see
[How CI checks a change](ci.md#nightly-builds). To try unreleased changes, don't cut a release:
[run your checkout](runtime.md#run-your-checkout).

## Before you start

- The `codex-omd` and `codex-omd-runner` crate versions equal the release version on `main`. The host reports its
  crate version as the OMD release, and `mise run release` and `release.yml` refuse a mismatch. To set them, change
  both in a scratch tree, run `build.py sync` and merge that first (see
  [Change the patched Codex code](runtime.md)).

## Publish a release

The release version is in `runtime/release.lock.json`. Release notes and `CHANGELOG.md` come from
`release/changelog.json`. `VERSION` below is the release version without the `v`, such as `1.3.0`.

For one full validation, skip the optional dry run and let the tag validate and publish. If you want to check the
package before publishing, dry-run after the squash merge so the tag can reuse that exact commit's result.

1. Open the release pull request:

   ```sh
   mise run release -- VERSION --summary "One sentence."
   ```

   It opens a `chore(release): VERSION` pull request with the version and a changelog entry with one line per pull
   request or direct commit merged to `main` since the last release. Edit the entry if needed, then run:

   ```sh
   python3 scripts/release.py render
   ```

2. If more pull requests merged to `main` since, run `mise run release -- VERSION` again. It merges `main` into the
   release branch and adds their lines to the entry. Edit and render again.
3. Squash merge the pull request. Keep its `chore(release): VERSION` title: the tagging command finds that commit on
   `main`.
4. Optional: dry-run the merged release before publishing:

   ```sh
   gh workflow run release.yml --ref main -f version=VERSION
   gh run list --workflow release.yml --branch main --event workflow_dispatch --limit 3
   gh run watch RUN_ID --exit-status
   ```

   Use the ID for the run you just started. It validates, builds and tests the package, then prints the publish
   commands without signing or publishing. Running this after the squash merge lets the tag reuse its checks and
   package. A dry run on the release branch can help before review, but its commit differs after a squash merge,
   so the tag must validate again. If `main` has advanced past the release commit, its dry run also cannot qualify.

5. Tag the release with the command below. Run it only when you mean to publish. As soon as
   `runtime/release.lock.json` on `main` has VERSION, the command pushes the `vVERSION` tag, and the tag publishes the
   release. It tags the release pull request's merge commit, even if newer changes have landed on `main`.

   ```sh
   mise run release -- VERSION
   ```

6. The tag runs `release.yml`. It checks that the tag is on `main` and that versions and changelog agree, reuses a
   qualifying dry run or validates from scratch, then signs and publishes a draft release and makes it live.
   The installer and `omd update` read the live release. An
   `-rc.N` tag is a prerelease, offered on the prerelease channel.
7. Check that the release is live:

   ```sh
   gh release view vVERSION
   ```

## Validation time

A tag reuses a release dry run only when GitHub reports success for `check`, all six validation jobs and `publish`
in one completed attempt on `main` at the exact tagged commit. The dry run must still have one unexpired `package`
artifact. The tag pins that artifact's ID, checks the downloaded package's commit, version and checksums, then
signs and publishes it. The `release` environment supplies the signing key only during publication.

This removes the second full build and test run after a qualifying dry run. Without one, the tag runs all checks.
An unavailable GitHub API, a missing or expired artifact, a different commit, or an incomplete dry run falls back
to full validation. If an artifact disappears after selection, the download fails; rerun the tag workflow so it
can select a retained artifact or validate again. Successful nightlies do not qualify: release binaries require
an uncached build with the release version.

For a full validation, native, core and lint jobs reuse compiler caches seeded by nightly validation. The shipped
binaries compile cleanly in the `build` job and undergo provenance, packaging and acceptance checks. Release builds
select only the seven shipped binaries; test setup selects only the required host and MCP fixture binaries. Runner
queues and fresh compilation still affect elapsed time; the reuse path needs a hosted run to measure its savings.

## Publish first-party mod updates

Fixes to `mods/first-party` reach users of the current release without a new release. The Mods workflow builds
a bundle from `main` and publishes it as the GitHub release `mods-VERSION-N`, where VERSION is `release_pin.omd` in
`extensions/index.json` and N counts up. The bundle holds every mod that differs from the `vVERSION` tag or that an
earlier bundle changed, plus mods added since the release, which arrive in the catalog turned off. It also
carries the curated directory's entries for other publishers' mods. Installs of exactly that VERSION take the mods
that differ from what they have.

Every push to `main` that changes `mods/first-party` or `runtime/mods.lock.json` runs the workflow with `--auto`. It
leaves out each changed or added mod the release can't run and publishes the rest. A mod is left out when it needs host
features the release lacks (`needs_host`), uses a `mod.json` field, list-item field or capability, state scope or app
subscription value that no first-party manifest at the tag used (`needs_manifest`), calls a host operation whose
schema changed since the tag, directly or through an SDK helper such as `api.session()` (`needs_api`), or changed in
a commit or merged pull request that also changed `runtime/` or `mods/api.d.ts` (`needs_runtime`). Those mods wait for the
next release. The run publishes nothing, and still passes, when no mod is new, the release isn't tagged yet, `main` hosts a different mod API, or `mods/api.d.ts` changed
since the tag (run it by hand with `api_reviewed` once you have checked no bundled mod uses the change). When a mod an
earlier bundle shipped can no longer be shipped, the run fails: cut a release.

To publish by hand, for example to exclude a mod:

1. Check what would ship:

   ```sh
   python3 -m scripts.mods_bundle plan
   ```

   `bundle` lists the mods it would ship, `new` the ones that changed since the last bundle (the build refuses when
   it is empty), `added` the bundled mods the release didn't have, `needs_host`, `needs_manifest` and `needs_api` the
   mods the release can't run (the build refuses them), `needs_runtime` the mods that changed together with host code
   (the build refuses them unless you pass `--api-reviewed`) and `needs_release` new mods it skips because they need
   a newer host. `api_changed` lists the host operations whose arguments or results
   changed, and `mods/api.d.ts` when it changed; the build refuses a changed API unless you pass `--api-reviewed`
   after leaving out every mod that depends on the change with `--exclude ID...` (`plan` takes `--exclude` too).
2. Optional: dry-run it. It checks, builds and signs, then prints the publish command:

   ```sh
   gh workflow run mods.yml --ref main -f dry_run=true
   ```

   With a changed API, add `-f exclude="ID ID" -f api_reviewed=true` to both workflow runs.

3. Publish:

   ```sh
   gh workflow run mods.yml --ref main
   ```

To withdraw a bad bundle, revert the fix on `main` and publish again: the higher N ships the reverted mod and
replaces it. Never delete a bundle release; a ruleset keeps its tag. Users who already updated can also run
`omd update rollback`.

## How releases are signed

Publication signs `omd-release.json` (`ssh-keygen -Y sign`, namespace `oh-my-diff-release`) with the
`OMD_RELEASE_SIGNING_KEY` secret. Mod bundles sign `omd-mods.json` with the same key in the namespace
`oh-my-diff-mods`, so neither manifest passes for the other. The installer (`install.sh`) and
`scripts/authority_broker.py` verify both against a pinned public key. To rotate the key, change both pins and the
secret together.

The secret lives only in the `release` environment, which only `main` and `v*` tags can deploy to (recorded in
`.github/settings.json`). The nightly, release and Mods publish jobs use that environment, so code on any other
branch never sees the key. Keep no repository-level copy of the secret. Tag rulesets let only admins create `v*`
tags and keep `mods-*` tags from being moved or deleted.

## Withdraw a release

```sh
python3 scripts/release.py rollback VERSION --dry-run
python3 scripts/release.py rollback VERSION
```

The first command prints the edits without making them. The second returns the release to draft and marks the
previous stable release as latest again. Users who already updated run `omd update rollback`.

## See also

- [How CI checks a change](ci.md)
- [Change the patched Codex code](runtime.md)
- [Support](../support.md)
