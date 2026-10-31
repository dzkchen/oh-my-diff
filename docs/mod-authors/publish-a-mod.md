# Install, share and update a mod

How to install a mod you wrote, share it through Git or npm, update it and roll it back. The examples use a mod
`my_mod` in the folder `./my_mod`. For package sources, references and npm rules, see the
[packaging reference](../../mods/reference/packaging.md).

## Before you begin

You need:

- A mod whose `pnpm check` and `pnpm test` pass, such as the one from [Write your first mod](first-mod.md).
- To share it through Git, a repository others can clone. To publish it to npm, an npm account that `pnpm publish`
  can use.

## Install it from a folder

From the folder that contains `my_mod`:

```sh
omd install ./my_mod
omd mods enable my_mod
```

Each command shows the mod's permissions and asks `Proceed? [y/N]`. Installing never turns a mod on. Add
`--scope project` to `omd install` to install it for the current project only.

A folder install runs the folder itself, not the release copy in `dist/` (see
[Build a release copy](#build-a-release-copy)). After any edit, even whitespace, the mod stops until you review it
again with `omd mods update my_mod`. Meanwhile `omd-mod status STORE` lists it under `rejected` as `untrusted_source`,
where `STORE` is your mod store. To install a fixed version, use a Git tag or an npm package.

In a shell with no terminal, the prompt can't show and the command stops with `package_approval_required`. Pass
`--yes` only after you've read the permissions in `mod.json`.

## Build a release copy

```sh
pnpm --dir my_mod run package
```

This writes `my_mod/dist/my_mod-0.1.0/` and prints its path and `sha256`. The folder contains:

- the files the package digest covers: `mod.json`, the entrypoint, assets and lifecycle scripts
- a JavaScript build with a source map for each `.ts` file
- `package-report.json`, which records the digest

The digest is the same one `omd-mod inspect` reports for your source folder, so use the copy to check which files a
package of this version contains.

It fails with `package_target_exists` if that folder exists, so delete `dist/` or bump `version` before you build
again. It writes a folder, not a tarball. For npm, check the tarball `pnpm pack` makes (see
[Publish it to npm](#publish-it-to-npm)). Installing, Git and npm don't need this copy.

## Share it through Git

1. In `mod.json`, set `license`, and set `provenance.source` to the plain repository URL, such as
   `https://github.com/you/repo`, with no `git+` prefix, tag or folder.
2. Commit the mod and tag the commit.
3. Others install the tag:

   ```sh
   omd install 'git+https://github.com/you/repo#v0.1.0:my_mod'
   ```

   `:my_mod` names the folder inside the repository.

A `provenance.source` that doesn't match the repository fails with `repository_provenance_mismatch`. For a local
`git+file://` install, use the repository's absolute path with symlinks resolved. See
[`provenance.source` for Git installs](../../mods/reference/packaging.md#provenancesource-for-git-installs).

## Publish it to npm

1. In `package.json`, remove `"private": true`, set a scoped `name` such as `@you/my-mod`, and set `version` to the
   one in `mod.json`.
2. In `mod.json`, set `license` and `provenance`.
3. Keep `files` listing `mod.json` and the entrypoint (the scaffold starts it as `["mod.json", "index.ts"]`), and
   add every declared asset and lifecycle script.
4. Keep `dependencies` empty. Ship runtime code as the entrypoint and its assets. `@oh-my-diff/mod-api` stays a
   `devDependency` or `peerDependency`.
5. Check the package and the tarball:

   ```sh
   pnpm check && pnpm test && pnpm pack
   tar -tzf *.tgz
   ```

   The tarball must stay under 4 MiB and 1024 entries and contain only regular files.

6. Publish:

   ```sh
   pnpm publish --access public
   ```

Others install it with `omd install npm:@you/my-mod@0.1.0`, or paste `npm:@you/my-mod@0.1.0` into `/mods` under
**Add from source**. The mod doesn't need to be in the curated directory.

## Update and roll back

To pick up a new version, or to review a changed folder install:

```sh
omd mods update my_mod
```

An update keeps a mod on only if its permissions, authority and source are unchanged. Otherwise turn it on again with
`omd mods enable my_mod`. An update that changes `state_version` also needs its saved data converted; see
[Change a mod's saved state](migrate-state.md).

To go back to the previous version:

```sh
omd mods disable my_mod
omd mods rollback my_mod
omd mods enable my_mod
```

A rollback points the mod at the cached copy of the previous version. To edit it again, install the folder again.

## Let collaborators build without OMD

A project created with a release install of OMD depends on that release's `mod-api.tgz` asset on GitHub, so
collaborators can run `pnpm install` without OMD. Creating the project needs the network once, to lock that
dependency. A project created with a development build links the SDK from that build's install with a `file:` path
instead. To use another SDK source, set `OMD_MOD_SDK_SPEC` to a pnpm dependency spec before you run
`omd-mod-author create`.

## See also

- [Bundle a mod in a plugin](bundle-in-a-plugin.md)
- [Manage mods](../manage-mods.md): how users find, turn on and remove mods
- [Trust and permissions](../trust-and-permissions.md): what a user agrees to when installing your mod
