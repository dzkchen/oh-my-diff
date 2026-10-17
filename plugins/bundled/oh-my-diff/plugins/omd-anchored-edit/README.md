# OMD anchored edit

Edit files by line anchors. Each line is shown as `LINE#HASH|content`, and an edit cites the anchors it changes. If a cited line has changed, the edit is rejected and nothing is written.

The plugin adds guidance. The tools come from a `mod/` component that you trust and enable separately.

## Install

```sh
omd-package plugins
codex plugin add omd-anchored-edit@oh-my-diff
```

## Enable the component

Installing the plugin does not enable the tools. Use the mod store of the host you run:

```sh
omd-mod plugin-component PLUGIN_ROOT
omd-mod inspect COMPONENT_PATH
omd-mod trust STORE COMPONENT_PATH INSPECT_SHA256 tools,fs.read,fs.write,exec
omd-mod enable STORE COMPONENT_PATH
```

`plugin-component` reports the component path. `trust` takes the digest that `inspect` prints. See [manage mods](../../../../../docs/manage-mods.md) for the store.

## Use

The component adds three tools:

- `read` returns lines with anchors.
- `search` runs `rg` read-only and returns matches with anchors.
- `edit` replaces, deletes or inserts lines by anchor, across up to 8 files and 32 edits per call.

If the component is off, the normal patch tool still works. Calls are limited to 96 KB of files. Multi-file edits are not crash-safe.

## Remove

```sh
omd-mod disable STORE COMPONENT_PATH
codex plugin remove omd-anchored-edit@oh-my-diff
```

## Credit

Ported from [`@d3ara1n/pi-hashline-edit`](https://pi.dev/packages/@d3ara1n/pi-hashline-edit) and [`pi-hashline-edit-pro`](https://pi.dev/packages/pi-hashline-edit-pro) (MIT). See `THIRD_PARTY_NOTICES.md`.
