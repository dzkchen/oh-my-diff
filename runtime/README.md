# Runtime

OMD is one patch on Codex `rust-v0.162.1`: [`patches/omd-0.162.1.patch`](patches). `runtime/omd` and
`runtime/native` are byte-for-byte copies of the `codex-rs/omd` and `codex-rs/ext/omd` crates it adds, and
`runtime/native/src/request_observer.rs` copies the patched `codex-rs/codex-api/src/request_observer.rs`.

## Modes

| `OMD_MODE` | What runs |
| --- | --- |
| `omd` | The mod host |
| `upstream_direct`, or unset | Plain upstream Codex behavior |

Any other value fails to start.

## The host has no features

Every feature is a TypeScript mod in [`mods/first-party`](../mods/first-party) over the
[public API](../mods/REFERENCE.md). With no mods on, `codex` behaves like upstream. `mise run native:ownership`
fails if native code names a feature or a first-party mod.

## Apply the patch

On an exact pinned checkout:

```sh
python3 scripts/normalize_upstream_lock.py /path/to/codex
python3 scripts/apply_runtime_patch.py /path/to/codex
```

`patches/manifest.json` records every file's hash before and after. Applying twice is a no-op; a changed file is
refused. To build and test OMD, see [CONTRIBUTING.md](../CONTRIBUTING.md).
