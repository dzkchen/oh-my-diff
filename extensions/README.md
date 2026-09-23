# OMD extension index

[`index.json`](index.json) is the repository-backed index of reviewed release
candidates. [`development.json`](development.json) keeps experiments and author
exercises separate. As of September 22, 2026, no entry has passed the full
Phase 11/12 release support gates, so none is labeled `supported`. The nine
reviewed entries are candidates, not an active bundle, a public compatibility
promise, or evidence of independent community adoption. The Full OMD installed
collection may grow with every qualified package; only a measured low-overhead
subset may activate by default. Installation never implies activation.

| Reviewed candidate | Type | Capability | Intended placement |
| --- | --- | --- | --- |
| `omd_coordination` | mod | Live task routing and worker context | Full OMD, inactive candidate |
| `omd_recovery` | mod | Failure-aware recovery choices | Full OMD, inactive candidate |
| `omd_workspace` | mod | Live terminal task workspace | Full OMD, possible small default after qualification |
| `omd-guidance-hooks` | plugin with skills and hooks | Selected guidance and lifecycle reactions | Full OMD, inactive candidate |
| `omd-review-policy` | plugin with skills and hook | Review cadence and final review prompts | Full OMD, inactive candidate |
| `omd-application-bridges` | plugin with hook | Application diagnostics | On demand candidate |
| `omd-repository-tools` | plugin with skill | Graph and code health evidence | On demand candidate |
| `omd-lsp-adapters` | plugin | Five-language semantic operations | On demand candidate |
| `omd-artifact-reading` | plugin with skill | Source-anchored artifact reading | On demand candidate |

Each reviewed row records an extension type, capability, exact tested host
versions and compatibility conditions, source, license, maintainer, evidence,
and support status. A plugin may contain skills or hooks; its `components` list
names those types without suggesting they can be installed independently.
`undeclared` and `UNLICENSED` report the current source truth. They are
release blockers for distribution or transfer until the owner publishes an
appropriate license. Check the latest lock and manifest at installation time;
the index is descriptive and never grants trust or overrides native checks.

## Install without the index

Mods can be installed from an absolute local source directory or a Git
repository at a full 40-hex commit using the native `omd-mod` manager. This
works even if these JSON files are unavailable. `omd-mod inspect PACKAGE`
shows the exact manifest and digest. For a managed package, use
`omd-mod package-plan STORE REQUEST_JSON` with a `local` or `repository` source,
review every dependency, capability, license, lifecycle action, setting and
activation change, then use `omd-mod package-apply STORE REQUEST_JSON CONFIRMATION`
with the printed confirmation. The manager checks package schema, host/API
compatibility, integrity, service contracts, dependency graph and individual
trust grants before changing the lock. Choose `"activate":false` for a new
package unless its specific use is intended now. A source may also be installed
from an exact entry in a local schema-1 package index; such an index is a
convenience, not a required service. See [mod commands](../mods/REFERENCE.md)
and [compatibility](../mods/COMPATIBILITY.md).

The bundled Codex plugins use the local, pinned
`plugins/bundled/oh-my-diff` marketplace. After the private installer places
it under `$OMD_PREFIX/plugins/oh-my-diff`, add it with
`codex plugin marketplace add "$OMD_PREFIX/plugins/oh-my-diff"`, then select
one plugin with `codex plugin add NAME@oh-my-diff`. Review hook hashes at the
Codex trust prompt. A plugin's skills are invoked explicitly; its hooks run
only at their declared lifecycle events and matching controlled settings.
The marketplace remains local and works without this index or a hosted catalog.
External skills and hooks follow Codex's native skill/plugin installation and
trust rules. The mod manager does not install or authorize them.

An immutable repository revision is a source identity, not an endorsement.
Inspect the pinned source and license before trust. A local editable source is
never overwritten by managed update or uninstall. `omd-mod package-lock`
shows exact installed versions and whether each mod is enabled; disabled
packages retain source and state. Use `package-disable`, `package-rollback-plan`
and `package-rollback`, or `package-uninstall-plan` and `package-uninstall` for
the matching package. Uninstall refuses an installed dependent. A changed API,
missing host feature, conflicting registration or trust grant produces an
explicit refusal rather than an automatic fallback to more authority.
Project-scope selections take precedence over the same user-scope ID and expose
the shadowed path; distinct mods that claim one exclusive route, terminal
owner, key or tool slot must be resolved or disabled. Native direct mode remains
the recovery path if a mod fails.

## Contribute and maintain an entry

1. **Submit.** Open a repository change with source or a full immutable Git
   revision, manifest and exact license, maintainer contact or issue route,
   capability and dependency declarations, tested Codex/OMD/API versions,
   setup/disable/removal steps, and one concrete task where the extension
   improves on configured Codex. Supply a local test or replay fixture and
   measured startup, callback, context, dependency and package costs where
   applicable. Choose a skill for procedure, hook for lifecycle reaction,
   plugin for tools or services, or mod for live engine/terminal replacement.
2. **Review.** The OMD maintainer checks provenance and license, source and
   dependency integrity, native authority boundaries, permission/credential
   claims, compatibility and conflicts, package trust and update behavior,
   task benefit, maintenance owner, and safe disable/recovery. Review a
   third-party package by the same gates as first-party code. Tests of OMD's
   own packages prove API use, not independent author adoption. Reject or keep
   an experimental entry in `development.json` with a specific reason; never
   mark it supported because its source exists.
3. **Release.** Pin an exact source revision and digest, publish the tested
   host/API and package versions, support window, known limits, dependencies,
   conflict notes, rollback path and evidence. Move an entry to `supported`
   only after the applicable Phase 11 functional/package checks and Phase 12
   per-package value and no-material-regression gates. Add `release_evidence`
   to the index; the checker refuses unsupported promotion. The maintainer
   verifies both install paths before packaging Full OMD. No hosted registry
   or marketplace account is required.
4. **Report issues.** File a repository issue with package ID/version and
   source digest, host/API versions, install scope, sanitized plan or lock,
   reproduction steps, expected/observed behavior, and whether disable or
   direct mode restores use. Do not include credentials, private repository
   contents or raw task transcripts. Security reports use the repository's
   private security contact when published; until then, do not post a live
   secret in a public issue.
5. **Transfer ownership.** Current and proposed maintainers agree in a
   reviewed repository change. Verify the new source, license and release
   authority, rerun compatibility and update/rollback checks, then publish a
   new pinned entry and transfer date. Never silently rewrite an existing
   immutable source or repoint a lock. If no maintainer accepts responsibility,
   move the package to deprecated status.
6. **Deprecate and remove.** Mark deprecation with reason, affected versions,
   replacement, migration steps and support-through date. Keep existing pinned
   source and rollback information through the stated window. Removal from the
   index needs an issue/evidence link and user recovery path; it must not
   uninstall local sources or delete state. A security exception may shorten
   the window only with an advisory and mitigation. Stable API deprecation
   follows [the compatibility policy](../mods/COMPATIBILITY.md).

Run `python3 scripts/extension_index.py` from the repository root before
submitting metadata. It checks every indexed source and evidence link, exact
manifest identity/license/version, plugin components, release pins, and
candidate/development separation. To replay the index-free mod lifecycle,
build `omd-mod` with
`cargo +1.95.0 build --locked --manifest-path runtime/omd/Cargo.toml -p codex-omd --bin omd-mod`,
then run `python3 scripts/extension_index_smoke.py`. The smoke uses an isolated
temporary store and makes no provider request.

## Workflow gap routing

The pinned Phase 10 OMP/Claude/OMD author matrix and capability slate inform
this queue. [The review register](REVIEWS.md) retains the selected decisions in
this repository. A catalog gap is a task to test, not a reason to activate new
code by default.

| Gap or need | Smallest current route | Catalog decision |
| --- | --- | --- |
| Task instructions and reusable procedure | Native instructions or skill | Guidance skills are reviewed candidates; promote new procedures only after reuse evidence |
| Tool-result or stop lifecycle reaction | Native Codex hook | Reviewed guidance/review hooks stay selected and host-gated |
| Repository graph, health, semantic navigation, artifact reading, application diagnostics | Existing native operations plus optional plugin tools | Reviewed on-demand plugin candidates, with separate dependency and task gates |
| Task-sensitive optional tool/context exposure | Public `.8` mod API | Internal `task_scope` author exercise; first-party task value remains open |
| Live route, recovery or terminal replacement | Public mod API with native authority | Three reviewed first-party candidates; no default promotion yet |
| Long-session policy or stage-dependent workflow | Native checkpoints/contract or skill first, then mod only for a proven live gap | `session_anchor` remains development-only; Phase 11 package trial is separate |
| Structural edit, debugger, patch recovery, subagent guidance | Configured tools, plugin, skill or hook trial | No supported package until each selected slate gate passes |
| Provider credentials, broad always-on services, embedded shell replacement | Existing native/configured surface | No catalog package selected |
