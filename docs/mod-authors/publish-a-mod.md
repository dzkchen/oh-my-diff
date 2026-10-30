# Publish a mod

How to install a mod you wrote, share it through Git or npm, update it and roll it back. The examples use a mod
`my_mod` in the folder `./my_mod`. For package sources, references and npm rules, see the
[packaging reference](../../mods/reference/packaging.md).

## Install it from a folder

From the folder that contains `my_mod`:

```sh
omd install ./my_mod
omd mods enable my_mod
```

Each command shows the mod's permissions and asks `Proceed? [y/N]`. Installing never turns a mod on. Add
`--scope project` to `omd install` to install it for the current project only.

A folder install runs the folder itself, not `dist/`. After any edit, even whitespace, the mod stops until you
review it again with `omd mods update my_mod`. Meanwhile `omd-mod status STORE` lists it under `rejected` as
`untrusted_source`, where `STORE` is your mod store. To install a fixed version, use a Git tag or an npm package.

In a shell with no terminal, the prompt can't show and the command stops with `package_approval_required`. Pass
`--yes` only after you've read the permissions in `mod.json`.

## Build a release copy

```sh
pnpm --dir my_mod run package
```

This writes `my_mod/dist/my_mod-0.1.0/` with the checked source, a JavaScript build, a source map and a digest
report. It fails with `package_target_exists` if that folder exists, so delete `dist/` or bump `version` before you
build again. It writes a folder, not a tarball; for npm, check the tarball `pnpm pack` makes (see
[Publish it to npm](#publish-it-to-npm)). You don't need this copy to install the mod.

## Share it through Git

1. In `mod.json`, set `license`, and set `provenance.source` to the repository URL without `git+`, the tag or the
   folder, such as `https://github.com/you/repo`.
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

A project created by a release install of OMD depends on that release's `mod-api.tgz` asset on GitHub, so
collaborators can run `pnpm install` without OMD. Creating the project needs the network once to lock it. A
development build links the SDK from its install with a `file:` path instead. Set `OMD_MOD_SDK_SPEC` before
`omd-mod-author create` to use another spec.

## See also

- [Bundle a mod in a plugin](bundle-in-a-plugin.md)
- [Manage mods](../manage-mods.md): how users find, turn on and remove mods
- [Trust and permissions](../trust-and-permissions.md): what a user agrees to when installing your mod
