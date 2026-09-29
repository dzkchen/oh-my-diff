# Curated project memory

This opt-in plugin owns memory tools, deterministic curation, the end-of-session report and live recall policy through API `0.2.0-experimental.3`. Repository-scoped `store.*` keeps records with revision checks and host provenance; `workspace.read` and `evidence.read` revalidate sources before reuse. The feature has no package-specific Rust route.

Install from the optional repository marketplace, inspect `omd-mod plugin-component PLUGIN_ROOT`, then inspect/trust/enable its component with the capabilities in `mod/mod.json`. Use the same external mod store for the host and `omd` CLI. Installation and selection are separate; neither install profile activates this package. `enabled:false` registers no tools or callbacks. The selected component's default supports on-demand local tools, with live recall, turn capture and curation hook all off.

Tools are `inspect`, `retain`, `learn`, `recall`, `curate` and `latest_evidence`, under the `mod_omd_curated_memory_` prefix. The CLI uses the same implementation:

```sh
omd memory --repo /absolute/project --store /external/store inspect
omd memory --repo /absolute/project --store /external/store retain '{"expected_revision":0,"id":"build-tool","label":"Declared package manager","source":{"path":"package.json","start_line":2,"end_line":4}}'
omd memory --repo /absolute/project --store /external/store recall '{"mode":"reuse","query":"package"}'
omd memory --repo /absolute/project --store /external/store curate
```

Read the actual revision each time. `retain` accepts one source anchor (up to 81 lines) or an accessible completed-turn evidence reference. `learn` takes `expected_revision`, `id`, `text` (up to 1,200 characters) and up to eight `evidence_ids`; it only proposes. `recall` returns at most eight current facts and approved lessons, excludes unavailable evidence and simple contradictory pairs, and performs no model calls. Contradiction detection is conservative lexical matching, not proof of consistency. `cold` returns without a host read. Local storage is private and outside the repository, scoped by canonical repository identity and component owner.

Approval/removal/reset are separate CLI command operations. First inspect the record and revision and ask the user to approve the exact action. An unconfirmed invocation returns a revision-bound `confirmation` string; after approval, repeat the same operation with that string in the JSON `confirm` field. `approve` requires `lesson_id`; `remove` requires `kind` (`fact`, `lesson` or `evidence`) and `id`; `reset` requires the revision. The mod refuses obvious opposing lessons until the user resolves them. It never manufactures approval. Concurrent changes require fresh inspection; there is no blind retry. API 0.2 has no native confirmation prompt for these generic store writes, so the command response reports `host_prompt:false`; only explicit operator invocation supplies the second confirmation step.

Set `live_recall:"reuse"` and `recall_ids:["build-tool"]` (at most eight IDs) to freeze selected eligible records in mod state on the first context callback. Reuse rechecks the repository-store revision, source hashes and evidence references before delivering those same records through compaction. Changed sources, deleted evidence or any store revision change withhold the frozen view; the mod does not silently refresh it. It retains at most 16 thread snapshots, then withholds new recalls until explicitly resetting mod state. API 0.2 does not supply the former host-bound `context.freeze/deliver` authority, so cross-session snapshot equivalence is not claimed.

Set `capture_turns:true` to retain only the latest accessible completed-turn reference in mod state. Separately set `retain_turns:true` to copy completed-turn evidence into local knowledge for later proposals, at most 16 retained evidence records. This has evidence-capture/storage cost and is off by default. No analysis or raw tool-output bodies are requested by this package.

The SessionEnd hook is also off. To select it, set `OMD_MEMORY_CURATION=1`, `OMD_MEMORY_COMMAND` to the canonical `omd` executable, `OMD_MOD_STORE` to the selected external store and `PLUGIN_DATA` to a private external directory. It runs `memory curate` with the event's explicit repository, takes at most eight seconds and 16 KiB, and atomically stores a private report named by project hash. It does not scan session history or call a model.

## Local-only scope

The maintainer selected local-only memory on 2026-09-26. Hindsight and Mnemopi connections are deferred and are not included in this package. No memory service, external database, network permission or backend dependency is required. The package has no sidecar or agent capability and cannot launch a model or network helper.

Historical API 0.1 acceptance exercised native knowledge and context authority on pinned Codex 0.157.0. Current API 0.2 offline fixtures exercise generic store revision checks, source/evidence validation, separate command confirmation and withheld stale recall. Native installed-profile, personal-memory and real-task usefulness checks remain open.
