# Optional Python debugger

`omd-debugger` is an opt-in Codex plugin skill and a separate `omd_debugger`
TypeScript mod. The plugin gives task guidance; its installation does not trust,
enable, or run the mod. The mod supports Python **launch** debugging through
`python3 -m debugpy.adapter`. C, Go, and attach are outside this package's
supported control surface. Neither OMD install profile activates it.

The local on-demand marketplace at this directory can install the plugin into
an explicitly selected Codex home:

```sh
codex plugin marketplace add /absolute/path/to/plugins/optional
codex plugin add omd-debugger@oh-my-diff-optional
```

Install `debugpy` separately into the `python3` selected by the effective
Codex `PATH`. From the same environment, check its version with
`python3 -c 'import debugpy; print(debugpy.__version__)'`. OMD does not
download Python or debugpy. Use the same external mod store as the OMD host's
`OMD_MOD_STORE`, a pinned OMD `omd-mod` binary, and the absolute mod path.
Inspect the source and grant its exact digest and capabilities before enabling
it:

```sh
omd-mod inspect /absolute/path/to/plugins/optional/omd-debugger/mod
omd-mod trust /absolute/external/mod-store /absolute/path/to/plugins/optional/omd-debugger/mod INSPECT_SHA256 tools,process,state,lifecycle
omd-mod enable /absolute/external/mod-store /absolute/path/to/plugins/optional/omd-debugger/mod
omd-mod selection-status /absolute/external/mod-store
```

Use the digest reported by the current `inspect` command. Source changes need
new inspection and trust. A selected mod still needs OMD mode, native host
permission for tool calls, and the adapter on the host's effective `PATH`.
Run the skill in a new Codex thread after plugin installation.

The local acceptance host was pinned Codex `rust-v0.156.1`, OMD `0.1.0`, mod
API `0.1.0-experimental.8`, Apple Silicon macOS Darwin `25.5.0`, Python
`3.14.6`, and debugpy `1.8.22`. The exact Python target remained in OMD's
restrictive read-only sandbox. [The acceptance audit](../../.docs/audits/debugger-20260925.md)
records the tests and limits. This is a local opt-in candidate; public release
and other platform/version support remain separate qualification work.

## Batch 2 local packages

The same optional marketplace offers [anchored edits](plugins/omd-anchored-edit/README.md), [past-session review](plugins/omd-session-review/README.md), and [local curated memory](plugins/omd-curated-memory/README.md). Each uses a separately inspected/trusted API .9 component. Installation does not activate a component. Local memory has no third-party backend connection.
