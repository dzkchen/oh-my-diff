# Runtime

The patch that turns Codex into OMD.

OMD is one patch on Codex `rust-v0.166.0` (pinned in `upstream.lock.json`): [`patches/omd-0.166.0.patch`](patches).
[`runtime/omd`](omd) and [`runtime/native`](native) are copies of the `codex-rs/omd` and `codex-rs/ext/omd` crates it
adds, written back by `build.py sync`. `runtime/native/src/request_observer.rs` copies the patched
`codex-rs/codex-api/src/request_observer.rs`.

## Modes

| `OMD_MODE` | What runs |
| --- | --- |
| `omd` | The mod host |
| `upstream_direct`, or unset | Plain upstream Codex behavior |

Any other value fails to start.

## The host has no features

Every feature is a TypeScript mod in [`mods/first-party`](../mods/first-party) over the
[public API](../mods/reference/README.md). With no mods on, `codex` behaves like upstream.

`mise run native:ownership` fails if native code names a feature or a first-party mod. It also keeps crate
dependencies pointing one way:

| Crate | Must not depend on |
| --- | --- |
| `codex-omd` | `codex-omd-extension`, `codex-core`, `codex-tui`, `codex-app-server` |
| `codex-omd-extension` | `codex-tui`, `codex-app-server` |

## Apply the patch

On an exact pinned checkout:

```sh
python3 scripts/normalize_upstream_lock.py /path/to/codex
python3 scripts/apply_runtime_patch.py /path/to/codex
```

`patches/manifest.json` records every file's hash before and after. Applying twice does nothing; a changed file is
refused.

To build and test OMD, see [CONTRIBUTING.md](../CONTRIBUTING.md).
