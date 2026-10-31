# Handle keys in a terminal view

How to edit text from key input in a terminal view, save it from a key, and bind keys that work on macOS terminals.
It assumes a mod that already draws a view, as in [Build a notes mod](notes-mod.md).

## Before you begin

- The mod declares the `commands` and `terminal` capabilities, plus `store` for `api.state`, `events` for the channel
  and timer, and `fs.read` and `fs.write` for a workspace save.
- The exact input rules are in [Terminal input](../../mods/reference/terminal-input.md).

## Take key and paste input

1. Draw a `document` or `pane` with `keys: true` in your `terminal` handler. It forwards keys and pastes while it
   has focus.
2. Handle `component_event` with `kind: 'input'`. Each entry of `events` is `{key, text}` or `{paste, truncated?}`.
3. Keep the buffer, cursor and selection in `api.state` and draw them as spans. The view redraws as soon as the
   callback changes the state.

The [`layout_explorer`](../../mods/examples/layout_explorer/index.ts) example is a complete small editor built this
way.

## Save from a key

Input callbacks, slash commands and key bindings run in the terminal process, which can only read the workspace. A
`channel` callback runs with the session's access. So to save from a key, publish an event with `events.publish`
and write the file from the `channel` callback.

`events.publish` takes the bare channel name, and the mod receives it as `<mod id>/NAME`. In this example the mod id
is `notes`, so the mod publishes `save` and receives `notes/save`. The mod receives only the channels its `mod.json`
subscribes to:

```json
"subscriptions": { "channels": ["notes/save"] }
```

The event can arrive before the terminal callback's own `api.state` write is stored. Keep the request in state, and
when the `channel` callback doesn't find it yet, retry from a short `events.schedule` timer:

```ts
type Notes = { lines: string[]; saving?: boolean };
const notes = (): Notes => (api.state.get() as Notes | null) ?? { lines: [''] };
const save = () => {
  const current = notes();
  if (!current.saving) {
    api.host.tryCall('events.schedule', { key: 'save', delay_ms: 100 });
    return;
  }
  const read = api.host.call('workspace.read', { paths: ['NOTES.md'] });
  api.host.call('workspace.transaction', {
    expected: { 'NOTES.md': read.files['NOTES.md']?.sha256 ?? null },
    writes: { 'NOTES.md': current.lines.join('\n') },
  });
  api.state.set({ ...current, saving: false });
};
api.command('save', () => {
  api.state.set({ ...notes(), saving: true });
  api.host.tryCall('events.publish', { channel: 'save', data: null });
  return null;
});
api.on('channel', ({ channel }) => { if (channel === 'notes/save') save(); });
api.on('timer', ({ key }) => { if (key === 'save') save(); });
```

Bind the command in the view with `keybindings: { 'Ctrl+s': { command: 'notes:save' } }`. A real mod also stops
retrying after a few timer rounds.

## Bind Alt keys that work on macOS

Kitty and Ghostty on macOS send Option+letter as a composed character (`π` for Option+p) unless Option-as-Alt is
enabled (`macos_option_as_alt` in Kitty, `macos-option-as-alt` in Ghostty), so the `Alt+` binding never fires there.

- Don't make an `Alt+` binding the only way to use a control.
- Name the slash command next to the key in the hint, for example `Alt+p or /notes save`.
- Prefer `Ctrl+` or function keys for actions users repeat.

## See also

- [Terminal input](../../mods/reference/terminal-input.md): focus, key contexts and `component_event`.
- [Events and lifecycle](../../mods/reference/events-and-lifecycle.md#eventspublish): `events.publish` and channels.
- [Workspace files](../../mods/reference/workspace-files.md#workspace-reads-and-transactions): reads and
  transactions.
