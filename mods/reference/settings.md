# Settings

Use it when a mod declares, reads or writes settings, when a user sets them in a settings file, or when you check
what the manifest `environment` field allows. `packages.list` reports each mod's settings; see
[Packaging](packaging.md#packageslist).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](stability-and-migration.md#experimental-entries-in-the-registry)); the settings file is
experimental.

## `settings.write`

```text
settings.write {id?, values} → {settings}
```

`settings.write` checks settings against the schema, saves them and redraws at once. A `null` value removes a setting.
It runs only from [user contexts](host-model.md#callback-contexts). Without `id` it writes the caller's own settings.
With `id` it needs `packages`. `/omd` stays the native recovery path for settings.

Callbacks read the effective settings as `api.settings` (`Readonly<Record<string, Json>>`); see
[Settings defaults](#settings-defaults) and the [settings file](#settings-file-settings_file_v1).

## Settings defaults

Callbacks receive a setting's explicit value when one is set, else the `settings_schema` property's `default`. Give
every property a default. With `additionalProperties: false`, the host ignores a stored setting the package no longer
declares and drops it at the next settings write or update, so a release can remove a setting. A write that names an
undeclared setting is still refused with `unknown_setting`.

A property can also have a `title` (up to 64 bytes) and a `description` (up to 300 bytes), which `/mods` shows
instead of the raw name. A string property without `enum` can set `choices: "routes"`. `packages.list` then fills its
`enum` with the names of the `host.json` worker routes open to that mod.

## Settings file (`settings_file_v1`)

Experimental. A package that uses it lists `settings_file_v1` in `required_features`. A user can then set the mod's
settings in a file instead of through `settings.write`: `settings/<mod_id>.json`, `.yaml` or `.yml` in the mod store,
the directory that contains `mods.json`.

- Only one of the three files may exist. More than one is invalid.
- The file is at most 64 KiB, and its top level must be an object whose keys are the mod's setting names.
- Its keys override the saved settings (and the schema `default` values) in every callback, render and chain
  digest. The file is validated like `settings.write`: a key outside a schema with `additionalProperties: false`,
  a wrongly typed value and a missing `required` setting are invalid.
- Administrator-managed selections ignore the file (status `ignored`).
- The saved settings must be valid on their own. Save a `required` setting without a `default` through
  `settings.write` or `/omd`. The file can then override it.
- An unreadable, oversize, unparsable or invalid file is skipped whole: the saved settings apply, the mod stays on and
  its view diagnostics include `settings_file_invalid: <reason>`.
- Creating, editing or deleting the file applies at the refresh points of a `mods.json` change.
- `api.settingsFile` is `{path, status: 'missing' | 'loaded' | 'invalid' | 'ignored', error: string | null}`. `path` is
  the absolute file to tell the user to edit (the `.json` one while none exists); `error` is the reason when `invalid`.
- `settings.write` of a key the file sets fails with `setting_set_by_file: <key>`. `omd-mod selection-status` lists
  such keys with origin `file` and the file under `settings_file`.

## Manifest `environment`

`"environment": ["crypto"]` in `mod.json` allows the
[`crypto` global](host-model.md#text-encoding-and-crypto). It is the only environment a mod can
declare (another or repeated name fails with `unsupported_or_duplicate_environment_access`).

Without that declaration, the host refuses at load any source that uses `crypto.` or `crypto[` outside string
literals, with `undeclared_environment_use: crypto (crypto.)`. The error names the matched text. The same error
reports these environments, which no manifest can declare:

- `network` (`fetch(`, `WebSocket(`)
- `process` (`process.`, `Deno.`, `Bun.`)
- `dom` (`document.`, `window.`)
- `filesystem` (`node:fs` or `require('fs`, matched inside literals too)
