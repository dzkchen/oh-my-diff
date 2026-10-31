# Cut a release

How the maintainer publishes, signs and withdraws an OMD release. Nightly prereleases publish on their own; see
[How CI checks a change](ci.md#nightly-builds).

## Before you start

- The `codex-omd` and `codex-omd-runner` crate versions equal the release version on `main`. The host reports its
  crate version as the OMD release, and `mise run release` and `release.yml` refuse a mismatch. To set them, change
  both in a scratch tree, run `build.py sync` and merge that first (see
  [Change the patched Codex code](runtime.md)).

## Publish a release

The release version is in `runtime/release.lock.json`. Release notes and `CHANGELOG.md` come from
`release/changelog.json`. `VERSION` below is the release version without the `v`, such as `1.3.0`.

1. Open the release pull request:

   ```sh
   mise run release -- VERSION --summary "One sentence."
   ```

   It opens a `chore(release): VERSION` pull request with the version and a changelog entry with one line per pull
   request or direct commit merged to `main` since the last release. Edit the entry if needed, then run:

   ```sh
   python3 scripts/release.py render
   ```

2. Optional: dry-run the release workflow. It validates, packages, signs and prints the publish commands:

   ```sh
   gh workflow run release.yml --ref release/vVERSION -f version=VERSION
   ```

3. If more pull requests merged to `main` since, run `mise run release -- VERSION` again. It merges `main` into the
   release branch and adds their lines to the entry. Edit and render again.
4. Merge the pull request, then tag `main` with the command below. Run it only when you mean to publish. As soon as
   `runtime/release.lock.json` on `main` has VERSION, the command pushes the `vVERSION` tag, and the tag publishes the
   release.

   ```sh
   mise run release -- VERSION
   ```

5. The tag runs `release.yml`. It checks that the tag is on `main` and that versions and changelog agree, validates,
   then publishes a draft release and makes it live. The installer and `omd update` read the live release. An
   `-rc.N` tag is a prerelease, offered on the prerelease channel.
6. Check that the release is live:

   ```sh
   gh release view vVERSION
   ```

## How releases are signed

Publication signs `omd-release.json` (`ssh-keygen -Y sign`, namespace `oh-my-diff-release`) with the
`OMD_RELEASE_SIGNING_KEY` secret. The installer (`install.sh`) and `scripts/authority_broker.py` verify it against a
pinned public key. To rotate the key, change both pins and the secret together.

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
