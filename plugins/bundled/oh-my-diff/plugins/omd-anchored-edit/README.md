# omd-anchored-edit

Edits files by line anchors. Each line shows as `LINE#HASH|content`, and an edit cites the anchors it changes. If a
cited line has changed, the edit is rejected and nothing is written.

The plugin adds guidance for the model. The tools come from its mod component, `omd_anchored_edit`.

## Turn it on

Add the plugin, then enable its component with these capabilities:

```text
tools,fs.read,fs.write,exec
```

[Plugins](../../../../README.md) has the steps to add a plugin and enable a component.

## Use it

The component adds three tools:

- `read` returns lines with anchors.
- `search` runs `rg` read-only and returns matches with anchors.
- `edit` replaces, deletes or inserts lines by anchor, across up to 8 files and 32 edits per call.

If the component is off, the normal patch tool still works.

## Needs and limits

- A call handles up to 96 KB of files.
- An edit too large for the host's callback budget returns `edit_too_large` or `files_too_large` and writes
  nothing. Use the normal patch tool instead.
- Multi-file edits aren't crash-safe.

## More

- [Remove a plugin](../../../../README.md#remove-a-plugin)
- Credit: reimplemented from [`@d3ara1n/pi-hashline-edit`](https://pi.dev/packages/@d3ara1n/pi-hashline-edit) and
  [`pi-hashline-edit-pro`](https://pi.dev/packages/pi-hashline-edit-pro) (MIT). See
  [`THIRD_PARTY_NOTICES.md`](../../../../../THIRD_PARTY_NOTICES.md).
