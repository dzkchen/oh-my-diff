# codex-omd

Feature-agnostic host primitives linked by the pinned Codex patch. The native
extension in [`runtime/native`](../native) registers them; feature behavior
lives in TypeScript mods under [`mods/`](../../mods). See
[the runtime overview](../README.md).

| Module | Owns |
| --- | --- |
| `mode` | `OMD_MODE=omd` and `upstream_direct`; retired modes fail closed |
| `mods` | Mod host, package manager, runner bridge, terminal view model and source-use analysis |
| `host` | Generic `exec.*`, `workspace.*` and backup operations with permission, cancellation and size checks |
| `admission` | Task ledger: request/exposure admission, reservations, explicit resume |
| `contract_document` | Schema-2 contract documents, digest-pinned selections, receipts and finding ledgers |
| `data_store`, `resource_data`, `scoped_data` | Namespaced `store.*`, immutable evidence resources and `evidence.*`/`sessions.*` scoping |
| `sessions`, `session_policy` | Read-only, repository-scoped session listing and paging |
| `workspace` | Snapshots, fingerprints and transactional writes |
| `builtins`, `owner`, `turn_evidence`, `plugin_component` | Built-in command/mode controls, policy ownership, turn evidence packets and plugin component inspection |

Binaries:

- `omd-mod` — install, trust, enable, test and inspect mod packages.
- `omd-contract` — select or inspect a schema-2 contract document.
- `omd` — run an enabled extension's CLI export outside a session, or `omd store export|reset --mod ID` to recover one mod's store without running mod code.

`omd-mod` with no arguments prints its commands. With no
first-party mods installed the host runs as modded Codex with no feature
behavior; `scripts/check_native_ownership.py` fails if a native operation,
event, capability or host configuration field names a feature.
