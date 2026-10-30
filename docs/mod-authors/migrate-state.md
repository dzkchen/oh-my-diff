# Change a mod's saved state

How to change the shape of the data a mod saves with `api.state` without losing what users already saved. The host
never rewrites a mod's code, settings or state on its own: you bump `state_version` and register a `migrate` handler
that converts the old data.

The example moves the [notes mod](notes-mod.md) from a plain array (`["one", "two"]`) to an object
(`{ "notes": ["one", "two"] }`).

## Write the migration

1. In `mod.json`, raise `state_version`:

   ```json
   "state_version": 2
   ```

2. In `index.ts`, read and write the new shape:

   ```ts
   type Saved = { notes: Notes };

   const notes = (): Notes => (api.state.get() as Saved | null)?.notes ?? [];
   ```

   Every `api.state.set(next)` becomes `api.state.set({ notes: next })`.

3. In `activate`, register the handler that converts version 1 data:

   ```ts
   api.on('migrate', ({ from }) => {
     const saved = api.state.get();
     if (from === 1) api.state.set({ notes: Array.isArray(saved) ? saved : [] });
   });
   ```

   The handler gets `from` and `to`, the old and new `state_version`. The `migrate` event is experimental in mod API
   `1.0.0` ([Stability and migration](../../mods/reference/stability-and-migration.md)).

4. Run `pnpm check` and `pnpm test`.

## Apply it to a store

When a mod with store state gets a new `state_version`, the host keeps it off with `state_migration_required` until
the handler runs. After `omd mods update notes`, run the handler:

```sh
omd-mod migrate STORE notes
```

If `omd mods list` then shows the mod off, turn it on with `omd mods enable notes`.

`STORE` is your mod store: `~/.local/share/oh-my-diff/stores/full` for OMD+ or
`~/.local/share/oh-my-diff/stores/platform` for OMD Core. In a scratch store, run `pnpm watch STORE --once` and
then `omd-mod migrate STORE notes`.

`omd-mod migrate` prints the old and new versions and the path of a backup of the old state.

The second argument is a mod ID among the store's selected mods, or a package folder (`.`, `..` or any path with a
`/`). It fails with `mod_ambiguous` when the ID is installed in more than one scope (pass the folder instead), and with
`migration_requires_saved_state` when the mod has no saved store state.

Thread and checkout state migrate through the same handler, before the mod's next callback in that thread or
checkout. An update that changes their `state_version` needs a handler too.

## Restore the old state

Migration backs up the old state first. The installed code still declares `state_version` 2, so roll back the code
as well as the data, or `omd mods enable` stops with `state_migration_required`. Turn the mod off, roll back its code,
restore the state from the backup path that `omd-mod migrate` printed, then turn it on:

```sh
omd mods disable notes
omd mods rollback notes
omd-mod rollback STORE notes BACKUP
omd mods enable notes
```

## See also

- [State and storage reference](../../mods/reference/state-and-storage.md#durable-data-store-and-evidence)
- [Publish a mod](publish-a-mod.md#update-and-roll-back): update and roll back a mod's code
