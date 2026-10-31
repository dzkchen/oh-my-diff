# Runtime: the Codex patch and host crates

The patch that turns Codex into OMD, and the host crates it adds. To change anything here, follow
[Change the patched Codex code](../docs/contributing/runtime.md). Never edit these files by hand.

## What's here

OMD is one patch on Codex `rust-v0.165.0` (pinned in `upstream.lock.json`): [`patches/omd-0.165.0.patch`](patches).

| Path | Contains |
| --- | --- |
| [`patches/`](patches) | The patch and `manifest.json`, which records every patched file's hash before and after |
| [`omd/`](omd) | A copy of the `codex-rs/omd` crate (`codex-omd`, the mod host) and `omd/runner` (`codex-omd-runner`) |
| [`native/`](native) | A copy of the `codex-rs/ext/omd` crate (`codex-omd-extension`) |
| `native/src/request_observer.rs` | A copy of the patched `codex-rs/codex-api/src/request_observer.rs` |
| `crate-notices.txt` | Licenses of the crates the build uses |
| `*.lock.json` | The release lock and the generated source locks |

`build.py sync` writes the patch, the copies and the crate notices.

## Crates

Most of the patch is new code in three crates:

| Directory | Crate | Contains |
| --- | --- | --- |
| [`omd/`](omd) | `codex-omd` | The mod host, which loads mods, checks their permissions and runs their callbacks |
| [`omd/runner/`](omd/runner) | `codex-omd-runner` | The `omd-runner` binary, which runs mod code on embedded V8 |
| [`native/`](native) | `codex-omd-extension` | The native extension, which connects the host to Codex threads, turns, tools and the terminal UI |

Rust tests are beside the code in `*_tests.rs` files.

## Modes

| `OMD_MODE` | What runs |
| --- | --- |
| `omd` | The mod host |
| `upstream_direct`, or unset | Plain upstream Codex behavior |

Any other value fails to start. The `direct` recovery state (`omd-package activate direct`) sets
`OMD_MODE=upstream_direct`.

## The host has no features

Every feature is a TypeScript mod in [`mods/first-party`](../mods/first-party) over the
[public API](../mods/reference/README.md). With no mods on, `codex` behaves like upstream.

`mise run native:ownership` fails if native code names a feature or a first-party mod. It also keeps crate
dependencies pointing one way:

| Crate | Must not depend on |
| --- | --- |
| `codex-omd` | `codex-omd-extension`, `codex-core`, `codex-tui`, `codex-app-server` |
| `codex-omd-extension` | `codex-tui`, `codex-app-server` |

## See also

- [Change the patched Codex code](../docs/contributing/runtime.md)
- [How OMD works](../docs/how-omd-works.md)
