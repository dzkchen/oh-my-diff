# Settings

Use it when a mod declares, reads or writes settings, when a user sets them in a settings file, or when you check
what the manifest `environment` field admits. `packages.list` reports each mod's settings; see
[Packaging](packaging.md#packageslist).

## `settings.write`

`settings.write {id?, values}` saves schema-checked settings (`null` removes one) from user contexts and redraws at
once. Without `id` it writes the caller's own settings; with `id` it needs `packages`.

Callbacks receive explicit settings over the schema's `default` values. A callback reads them as `api.settings`
(`Readonly<Record<string, Json>>`).

`/omd` stays the native recovery path.

## Settings defaults

Callbacks receive explicit settings over each `settings_schema` property's `default`; give every property a
default. With `additionalProperties: false`, a stored setting the package no longer declares is ignored and dropped
at the next settings write or update, so a release can remove a setting; a write naming an undeclared setting is
still refused (`unknown_setting`).

A property may also carry a `title` (up to 64 bytes) and a `description` (up to 300 bytes), which `/mods` shows
instead of the raw name, and `choices: "routes"` on a string property without `enum`: `packages.list` then fills its
`enum` with the names of the `host.json` worker routes open to that mod.

## Settings file (`settings_file_v1`)

Experimental. A user can set a mod's settings in a file instead of through `settings.write`:
`settings/<mod_id>.json`, `.yaml` or `.yml` in the mod store, the directory that holds `mods.json`.

- At most one of the three files may exist (more than one is invalid), at most 64 KiB, and its top level must be an
  object whose keys are the mod's setting names.
- Its keys override the saved settings (and the schema `default` values) in every callback, render and chain
  digest. The file is validated like `settings.write`: a key outside a schema with `additionalProperties: false`,
  a wrongly typed value and a missing `required` setting are invalid.
- Administrator-managed selections ignore the file (status `ignored`).
- The saved settings must be valid on their own, so a `required` setting without a `default` is saved through
  `settings.write` or `/omd`; the file then overrides it.
- An unreadable, oversize, unparsable or invalid file is skipped whole: the saved settings apply, the mod stays on and
  its view diagnostics carry `settings_file_invalid: <reason>`.
- Creating, editing or deleting the file applies at the refresh points of a `mods.json` change.
- `api.settingsFile` is `{path, status: 'missing' | 'loaded' | 'invalid' | 'ignored', error: string | null}`. `path` is
  the absolute file to tell the user to edit (the `.json` one while none exists); `error` is the reason when `invalid`.
- `settings.write` of a key the file sets fails with `setting_set_by_file: <key>`. `omd-mod selection-status` lists
  such keys with origin `file` and the file under `settings_file`.

Require `settings_file_v1` to use it.

## Manifest `environment`

`"environment": ["crypto"]` in `mod.json` admits the `crypto` global above. It is the only environment a mod can
declare (another or repeated name fails with `unsupported_or_duplicate_environment_access`).

Source that uses `crypto.` or `crypto[` outside string literals without it is refused at load with
`undeclared_environment_use: crypto (crypto.)`, naming the matched text. The same error names these, which no
manifest admits:

- `network` (`fetch(`, `WebSocket(`)
- `process` (`process.`, `Deno.`, `Bun.`)
- `dom` (`document.`, `window.`)
- `filesystem` (`node:fs` or `require('fs`, matched inside literals too)
