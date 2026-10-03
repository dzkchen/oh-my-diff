# omd_mods

Default-active in both profiles. `/mods` lists installed mods in Failed, On and
Off sections with a status glyph (◆ on, ◇ starting or stopping, ○ off, ✕
failed), a friendly name and a one-line description.

- ↑↓ move, Space or Enter turns the highlighted mod on or off, Tab reaches the
  filter, the settings picker and the install field, Esc closes the screen.
- Turning a mod on asks the host's own approval, which lists any new
  permissions in plain words. Its slash commands work at once; its hooks start
  with your next message.
- The settings picker opens a mod's page: toggles and fields for every
  `settings_schema` property (saved with `settings.write`), plus Update, Roll
  back and Remove for managed packages.
- `/mods ACTION MOD` (`enable`, `disable`, `update`, `rollback`, `remove`,
  `trust`) and `/mods reload` work without opening the screen; reviewed actions
  wait for `/mods apply` or `/mods cancel`.

On a fresh session it adds a short getting-started card with the mod counts.
`/omd` stays the native recovery path when this mod is broken.

Capabilities: `commands`, `packages`, `store`, `terminal`.
