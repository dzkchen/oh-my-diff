# codex-omd

Feature-agnostic host primitives linked by the pinned Codex patch. The native extension in
[`runtime/native`](../native) registers them; features live in TypeScript mods under [`mods/`](../../mods). See the
[runtime overview](../README.md).

The crate covers the mod host and package manager, the host operations mods call (`exec.*`, `workspace.*`, data
stores, sessions, credentials, drafts and events), the task ledger and workflow contracts, and the terminal view model.
`src/lib.rs` lists the modules.

Binaries in this crate:

- `omd`: runs an enabled mod's CLI export outside a session; `omd install` and `omd mods` manage mod packages;
  `omd store export|reset --mod ID` recovers one mod's store without running mod code. The installed `omd` launcher
  also routes `omd update` to the installer.
- `omd-contract`: inspects, plans, selects, requires or clears a workflow contract.
- `omd-broker`: the helper for the OS-separated authority broker (see `omd-package broker`).

`omd-mod`, the package and store manager, is built from [`runtime/native`](../native). With no first-party mods
installed the host is modded Codex with no feature behavior; `scripts/check_native_ownership.py` fails if native
code names a feature.
