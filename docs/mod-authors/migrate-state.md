# Change a mod's saved state

How to change the shape of the data a mod saves with `api.state` without losing what users already saved. The host
never rewrites a mod's code, settings or state on its own: you bump `state_version` and register a `migrate` handler
that converts the old data.

The example moves the [notes mod](notes-mod.md) from a plain array (`["one", "two"]`) to an object
(`{ "notes": ["one", "two"] }`).

## Before you begin

You need the notes mod from [Build a notes mod](notes-mod.md), at `state_version` 1, installed or loaded into a mod
store that already has saved notes. A store with no saved notes has nothing to migrate.

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
the handler runs. After `omd mods update notes`, run the handler. `STORE` is the path of your mod store, listed under
[`omd-mod`](../commands.md#omd-mod) in Commands.

```sh
omd-mod migrate STORE notes
```

The second argument is a mod id from the store's selected mods, or a package folder (`.`, `..` or any path with a
`/`). The command fails with:

- `mod_ambiguous` when the id is installed in more than one scope. Pass the folder instead.
- `migration_requires_saved_state` when the mod has no saved store state.

On success it prints a JSON object with `"from": 1`, `"to": 2` and `backup`, the path of a copy of the old state.
Keep that path.
If `omd mods list` then shows the mod off, turn it on with `omd mods enable notes`.

In a scratch store, run `pnpm watch STORE --once` and then `omd-mod migrate STORE notes`.

[Thread and checkout state](../../mods/reference/state-and-storage.md#state_scope-state_scopes_v1) migrate through
the same handler, before the mod's next callback in that thread or checkout. An update that changes their
`state_version` needs a handler too.

## Check the migrated state

1. Save this scenario as `/tmp/notes-state.json`. It reads the mod's saved state from the store:

   ```json
   { "schema": 1, "steps": [{ "type": "state", "mod": "notes" }] }
   ```

2. Run it against the store:

   ```sh
   omd-mod test STORE /tmp/notes-state.json
   ```

In the output's `steps` list, the step's `value` has the new shape, such as `{ "notes": ["one", "two"] }`. The mod
must be on, or the step fails with `mod_disabled`.

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
- [Install, share and update a mod](publish-a-mod.md#update-and-roll-back): update and roll back a mod's code
