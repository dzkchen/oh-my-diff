# Upstream pin and shared-state feasibility

Checked September 12, 2026 on Apple Silicon macOS. Scope: the first Phase 1 checkbox only. A locally compiled `codex` works with synthetic shared state and the tested upstream releases. This is not a CAI policy implementation, provider acceptance test, or release-package certification.

## Selected inputs

- Upstream: [`rust-v0.154.0`](https://github.com/openai/codex/releases/tag/rust-v0.154.0), commit [`6b9826e3aa83b1a5947db50f4332cb9c65f1b340`](https://github.com/openai/codex/tree/6b9826e3aa83b1a5947db50f4332cb9c65f1b340). The annotated tag object and peeled commit were verified with `git ls-remote` against `https://github.com/openai/codex.git`.
- Reason: a release checkpoint matching the installed `codex-cli 0.154.0`, with native extension, agent, persistence, and writer-lock seams. This choice does not assert it is the latest release.
- Machine-readable inputs and lock hashes: [`upstream.lock.json`](../upstream.lock.json).
- Build outcome, tool versions, final script hashes, and review record: [build-and-review.json](evidence/build-and-review.json).
- Rust: `1.95.0-aarch64-apple-darwin`, `rustc 1.95.0 (59807616e 2026-04-14)`, with `clippy`, `rustfmt`, `rust-src`, matching upstream's toolchain file. Installed with user authorization; existing `stable` remains the default.
- Custom executable: `/private/tmp/cai-codex-v0.154.0-build-20260912/codex-rs/target/debug/codex`. This is a development build of the selected source, with no CAI runtime feature patch. It is not installed on PATH.

The first `cargo build --locked -p codex-cli --bin codex` failed because the tag's manifest version is `0.154.0` while 150 workspace packages in its lockfile still say `0.0.0`. Minimal Cargo reconciliation changed exactly those 150 version lines; external versions, sources, checksums, and dependencies did not change. A broad lockfile regeneration was investigated only in a disposable copy and discarded.

[`normalize_upstream_lock.py`](../scripts/normalize_upstream_lock.py) reproduces the minimal correction, requiring the exact commit and before/after hashes. It refuses unknown lockfiles and is idempotent. After normalization, the locked build exited 0: `Finished dev profile [unoptimized + debuginfo] target(s) in 2m 54s`. Original source checkout remains clean. No dependency change or Bazel build was made; release/Bazel packaging remains a later gate.

## Targeted Rust patch boundary

Paths below are relative to `codex-rs/` at the selected commit. This selects where later authorized work belongs; it does not start those roadmap tasks.

| Responsibility | Selected boundary and constraints |
| --- | --- |
| CAI policy and observations | Add a focused `ext/cai` crate following [`ext/extension-api`](https://github.com/openai/codex/tree/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/ext/extension-api); register through [`app-server/src/extensions.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/app-server/src/extensions.rs). Reuse configuration, thread/turn/tool lifecycle, context, and token-usage contributors. Keep host registration small. This uses Codex's native runtime, not a separate production controller. |
| Hard admission, recursive work, recovery | Focus any missing enforcement on `core/src/agent/control/spawn.rs`, agent role/control seams, and `core/src/rollout_budget.rs`. Observer callbacks do not by themselves prove pre-request spending enforcement. Preserve native permission intersection, writer ownership, and cancellation; do not replace the agent tree. |
| Provider adaptation | Begin with `model-provider-info` and `codex-api` configuration/transport. Only introduce a focused Rust adapter if the separately authorized Contributor feasibility task proves it necessary. No protocol compatibility or account access is inferred here. |
| Configuration and TUI | Namespaced additive configuration in `config`, with small core resolution changes where needed. Later presentation work stays in `tui`; retain inline operation and session identity. User-reviewed layout/default choices remain pending. |
| Persistent compatibility | Reuse `thread-store`/`state` contracts. Do not change upstream auth formats, keyring namespaces, known migration checksums, or require CAI-only rollout variants. `ExtensionData` is in-memory typed state, **not persistence**; durable CAI metadata needs a later reviewed, versioned design and round-trip tests. |
| Distribution and update dispatch | Keep the executable named `codex`, but identify the patch revision in build provenance. Audit `cli/src/main.rs` update dispatch and `tui/src/update_action.rs`/`updates.rs` before shipping a custom update channel. Activation-off and replacing the executable remain distinct. |

This boundary favors existing extension APIs over growth in the core crate, consistent with upstream `AGENTS.md`. Existing configured agent roles, instructions, and tools remain the baseline; their existence does not justify a CAI patch.

## Executed compatibility evidence

[`verify_codex_compat.py`](../scripts/verify_codex_compat.py) starts a local Responses SSE fixture, uses a new temporary `CODEX_HOME` and `CODEX_SQLITE_HOME`, and supplies only synthetic credentials. It preserves `HOME`, scrubs inherited provider variables, bounds project discovery with a fixture repository root, disables shell snapshots and analytics, and never asks a real provider to infer. The fixture returns fixed assistant messages; it checks request construction and persistence, not model obedience.

| Executed check | Evidence and result |
| --- | --- |
| Installed upstream 0.154.0 → custom 0.154.0 → installed upstream 0.154.0 | [Full result](evidence/codex-0.154.0-compat.json): same thread ID; all prior user/assistant markers preserved; configured model, both instruction sources, and synthetic bearer credential present in requests; three completed turns. Config and file credential bytes unchanged. |
| Upstream 0.153.0 → custom 0.154.0 → upstream 0.153.0 | [Upgrade/return result](evidence/codex-0.153.0-upgrade-return.json): the same checks passed. 0.153.0 was downloaded from its official GitHub release, extracted only into temporary storage; executable hashes are in the result. |
| Concurrent consumers, both tested pairs | While one executable held the session writer, the other was rejected with `active writer` before a competing request reached the mock. A separate session completed against the same state home. The original writer then completed. |
| File credentials | Both binaries loaded the same synthetic API-key file; the local request carried the expected dummy bearer. Both also parsed a synthetic OAuth-shaped file via `login status`, without changing it. |
| macOS keyring, same-tag pair | Upstream created one dummy credential under a fresh home-derived namespace; upstream and custom build both read it with no `auth.json` fallback. Upstream logout removed it; both reported `Not logged in` afterward. No live credential entry was used or removed. |
| Reproducible lock correction | Fresh local source copy normalized to the recorded SHA-256 and exactly 150 version-only replacements. Running the normalizer again reported already applied. |

Native source supports the observed boundaries:

- [`utils/home-dir/src/lib.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/utils/home-dir/src/lib.rs) resolves `CODEX_HOME`; explicit homes are canonicalized. `core/src/config/mod.rs` reads the shared configuration and honors `CODEX_SQLITE_HOME`.
- [`login/src/auth/storage.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/login/src/auth/storage.rs) retains `auth.json`; direct keyring storage uses service `Codex Auth` and a key derived from canonical home, not executable name. Keep both storage mode and namespace consistent. [Official authentication documentation](https://learn.chatgpt.com/docs/auth) also describes shared cached auth and file/keyring storage.
- [`core/src/agents_md.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/agents_md.rs) preserves trusted-project discovery and instruction ordering. The fixture verifies global and project instruction inclusion, not every precedence/override case.
- [`thread-store/src/local/writer_lock.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/thread-store/src/local/writer_lock.rs) rejects competing owners. [`state/src/migrations.rs`](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/state/src/migrations.rs) tolerates unknown newer migrations while validating known checksums. Neither mechanism guarantees arbitrary-version or arbitrary-schema interchange.

## Supported direction and limits

The feasibility baseline supports the tested same-tag switch and the 0.153.0 ↔ custom 0.154.0 synthetic-session path on this Mac. This does not certify every historical session shape, future CAI metadata, every configured plugin, or desktop interoperability. Actual ChatGPT OAuth issuance/refresh and authenticated provider requests remain the **next Phase 1 checkbox**, requiring its agreed spending allowance. No paid provider call or benchmark ran here. Cross-version keyring, encrypted-keyring backend variants, and Linux behavior were not exercised.

Use the same canonical state home, SQLite-home override, auth storage mode, project directory, instructions, and configuration when switching supported binaries. End a session's existing writer before resuming it elsewhere. Separate sessions may share the home; the test does not establish simultaneous config edits or OAuth-refresh-race safety.

For an upstream checkpoint update: select and record the new tag, independently build upstream and the retained patches, then run the state round trips on synthetic fixtures and a quiescent copied state snapshot before touching live state. Preserve a consistent pre-update backup of the state home and any separately configured SQLite home with writers stopped; do not copy only a live SQLite main file while omitting its WAL. Keyring backup/recovery is separate from filesystem backup; never log out as an uninstall step. Future versions become supported only after their checks pass.

Return to the retained upstream executable by changing only the selected binary/path; preserve shared user data. Test rollback on a copied home first when schemas differ. Restoring an old backup is a recovery operation that loses later state, not a session-preserving downgrade. No user's PATH, Homebrew installation, configuration, or real sessions were changed in this audit.

The tagged custom build is **not automatically updater-safe**: `updates.rs` skips source-update checks only for version `0.0.0`, while this build reports `0.154.0`. Native update dispatch selects the installation's upstream updater. A shipping CAI package must gate/replace its own update action and preserve a known upstream return executable; setting `check_for_update_on_startup=false` only disables startup checks, not explicit update commands. Installer/activation/browser delivery remains Phase 10 scope. Do not advertise those unbuilt paths as validated.

## Reproduce

Use Python 3.11+ for the lock normalizer. Commands below create a fresh temporary source checkout; they do not install a replacement CLI. Rust 1.95.0 and its declared components must already be installed.

```sh
CAI_AUDIT_SOURCE=$(mktemp -d /private/tmp/cai-upstream.XXXXXX)
git clone --branch rust-v0.154.0 --depth 1 https://github.com/openai/codex.git "$CAI_AUDIT_SOURCE"
python3 scripts/normalize_upstream_lock.py "$CAI_AUDIT_SOURCE"
cd "$CAI_AUDIT_SOURCE/codex-rs"
cargo build --locked -p codex-cli --bin codex
```

From the CAI repository, substitute the new source checkout's absolute binary path:

```sh
python3 scripts/verify_codex_compat.py /opt/homebrew/bin/codex /absolute/source/codex-rs/target/debug/codex --keyring --output /private/tmp/cai-same-tag.json
python3 scripts/verify_codex_compat.py /absolute/upstream-0.153.0/codex-aarch64-apple-darwin /absolute/source/codex-rs/target/debug/codex --output /private/tmp/cai-upgrade-return.json
```

`--keyring` creates and removes one synthetic OS-keyring entry in a temporary namespace; omit it for file-only checks. The harness requires localhost binding and normal process execution. Results record binary hashes and individual checks. No full upstream Rust suite was run; executable integration fixtures are the validation for this feasibility task.

Separate read-only code review caught and resolved shell-snapshot isolation, optimized-Python false passes, and held-writer timeout cleanup. The final fixture was rerun after repairs. This completes only the selected feasibility checkbox; provider and integration feasibility still gate the rest of Phase 1.
