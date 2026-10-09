# Runtime

The patched `rust-v0.162.0` host accepts `OMD_MODE=omd` for the generic mod host
and `OMD_MODE=upstream_direct` for the pinned upstream task flow; with no mode
selected it runs upstream-style direct. `OMD_MODE=enabled`, `OMD_MODE=platform`
and `OMD_CONTROLLED_MANIFEST` fail closed. The single artifact is
`patches/omd-0.162.0.patch`; `runtime/omd` and `runtime/native` mirror its
`codex-rs/omd` and `codex-rs/ext/omd` crates byte for byte, and
`runtime/native/src/request_observer.rs` mirrors the patched
`codex-rs/codex-api/src/request_observer.rs`.

The host is feature-agnostic. Workflow, analysis, knowledge, guidance, Pi
resources, Git and terminal presentation are TypeScript mods in
[`mods/first-party`](../mods/first-party) over the public API in
[`mods/REFERENCE.md`](../mods/REFERENCE.md). With zero first-party mods the host
runs as modded Codex with no feature behavior. `mise run native:ownership`
fails when a native operation, event, capability, host configuration field,
production string literal or runner name names a feature, or when native code
mentions a first-party package ID.

`omd_workflow` owns the reviewed and solo-evidence workflows; the host enforces
only an explicitly selected schema-2 contract, route grants, permissions and
receipts. `omd-contract` selects a contract; enabling the package alone selects
none and authorizes no provider. Installation is described in
[`LEAN_PROFILES.md`](../LEAN_PROFILES.md).

Apply the patch to an exact pinned checkout after lock normalization:

```sh
python3 scripts/normalize_upstream_lock.py /path/to/codex
python3 scripts/apply_runtime_patch.py /path/to/codex
```

For development, `scripts/batch_tree.py` creates a patched scratch tree and
regenerates the patch, manifest and these mirrors; see [`AGENTS.md`](../AGENTS.md).

`patches/manifest.json` binds every before/after file hash. Application is
idempotent, rejects modified destinations, and leaves unrelated files and the
index alone. External dependency versions are unchanged.
