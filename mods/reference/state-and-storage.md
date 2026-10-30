# State and storage

Use it when a mod keeps data: `store.*` records, evidence and binary evidence, `api.state` and where it lives,
state migration and the reactive helpers over `api.state`. Session UI state (`api.uiState`) is in
[Terminal UI](terminal-ui.md#experimental-session-ui-state).

## Durable data: `store.*` and evidence

This section covers `store.*` operations, evidence, SVG assets, `api.state` compare-and-swap, `state_scope` and
`state_version` migration.

### `store.*` operations

`store.get/put/delete/list/export/reset` operate on a per-mod namespace with `repository` (default), `user` or `thread`
scope (see [Thread-scoped store and `resume`](threads-and-sessions-store.md#thread-scoped-store-and-resume)).

- `list`, `export` and `reset` are experimental.
- `put` and `delete` require the current `expected_revision` (`null` to create); a stale revision fails.
- `reset` needs the current generation.
- `list` pages 256 keys.
- `export {scope?, cursor?}` pages entries in at most 64 KiB, returning `{schema, owner, scope, generation,
  entries, cursor}`.
- Every record carries host-attested provenance `{mod, source_sha256, thread_id, origin, at}` (`at` is milliseconds
  since the Unix epoch).

| Limit | Value |
| --- | --- |
| Key | at most 256 bytes |
| Value | at most 64 KiB |
| Scope | at most 16 MiB and 4,096 keys |

Outside a session, `omd store export|reset --mod ID [--repo PATH] [--store PATH] [--scope repository|user]` exports
the complete namespace or resets it without running any mod code.

### `evidence.write` and `evidence.read`

`evidence.write {media_type, content, label?}` stores content-addressed evidence and returns a `ResourceRef`;
`evidence.read {reference, cursor?, max_bytes?}` reads it back in pages of at most 64 KiB (`max_bytes` 1 to 65,536, by
default the maximum).

### `evidence.write` and binary evidence (`binary_evidence_v1`)

```ts
evidence.write {media_type: 'image/png' | 'image/jpeg' | 'image/svg+xml' | 'application/octet-stream', base64}
```

It accepts PNG and JPEG up to 8 MiB, SVG up to 1 MiB, and `application/octet-stream` and text up to 16 MiB
(`binary_evidence_v1`). PNG and JPEG references can be attached through `composer.write` and
image-capable app methods.

### SVG assets (`svg_assets_v1`)

SVG (`svg_assets_v1`) is UTF-8 XML of at most 1 MiB whose root element is `svg`, after an optional XML declaration
and comments. Every element must be in the SVG namespace (an unprefixed element without a default namespace counts
as SVG).

The check refuses:

- a DOCTYPE and other processing instructions;
- `script`, `foreignObject`, `iframe`, `object`, `embed`, `audio` and `video` elements;
- `animate*`/`set` targeting `href` or an `on*` attribute;
- `on*`, `src`, `srcset`, `data`, `action`, `formaction` and `ping` attributes;
- `href`/`xlink:href` other than `#fragment` or a base64 PNG/JPEG `data:` URI;
- in any attribute or `<style>` text (case-insensitive, after resolving references) a `url(` other than
  `url(#...)`, `image-set(` (including `-webkit-image-set(`), `src(`, `@import`, `@font-face` or a backslash
  escape.

A refusal fails with `evidence_record_invalid: svg_<reason>`.

- `terminal.import_file` labels SVG text `image/svg+xml`, so it passes the same check.
- External renderers draw SVG natively.
- The terminal shows an `image` component's alt text, refuses SVG in `terminal.image_sample` and never attaches it
  to the composer.

### `api.state` compare-and-swap

`api.state` is re-read before every callback and written back with a compare-and-swap. If another process wrote it
meanwhile, the host runs the callback again against the fresh state, within the callback's 5 s budget, answering
its host calls from the results already recorded, so no operation runs twice (the clock stays at the first
attempt's start, so `Date.now()` in arguments replays).

If a retry asks for a different host call, it runs again fresh when every recorded call was read-only; otherwise it
fails with the transient `state_conflict`, because an operation that already ran is never repeated.

Each commit of `api.state` (and of thread and checkout state) is ordered by a write barrier rather than a full fsync:
state survives a crash or quit in order, but the last commits can be lost on a power failure. `store.*` data and
evidence are fully synced.

### `state_scope` (`state_scopes_v1`)

The location of `api.state` follows the manifest's `state_scope` (`state_scopes_v1`).

- `"store"` (the default) keeps one state of at most 512 KiB in the mod store, shared by every OMD process that
  uses that store.
- `"thread"` keeps one state per session thread and selection scope, so a project copy cannot inherit a same-ID
  user copy's state. It forks with the thread and is removed when the thread is deleted. Routing and compaction
  decisions made while a thread is set up see that thread's state (a fork's copy is made first), and registration
  reads the state of the thread whose callback reloaded the mods (none at process start).
- `"checkout"` keeps one state per checkout, shared by every OMD process working there whatever its mod store: in
  `<git-dir>/omd/state/<mod>.json` for a Git checkout (a linked worktree has its own), read-only to agent commands
  as Codex keeps `.git`. Outside Git, a projectless session, checkout state is unavailable
  (`state_checkout_unavailable`) and nothing is written to the directory.

Mods never run with the home directory or filesystem root as the session directory: the host stays off with a
notice in `/omd`. `omd-mod command STORE MOD NAME JSON [THREAD]` and `omd-mod test STORE SCENARIO [THREAD]` use the
given thread and the checkout of their working directory. A `thread` mod run from `omd-mod command` without `THREAD`
fails with `state_thread_unavailable`; in the TUI, a slash command typed before the session's thread exists runs once
it does. A callback result, including its state, stays within 1 MiB.

### `state_version` migration of thread and checkout state

The `omd-mod migrate` and `rollback` commands act on `"store"` state only.

`omd-mod migrate STORE MOD_ID_OR_PACKAGE` and `omd-mod rollback STORE MOD_ID_OR_PACKAGE BACKUP` take a mod id or a
package folder. A bare name (no `/`) is a mod id resolved among the store's selected mods (watched folder or installed);
`.`, `..` and anything with a `/` are package folders. An id that matches copies in more than one scope fails with
`mod_ambiguous` (pass the folder), and a mod without saved store state fails with `migration_requires_saved_state`.

- Thread and checkout state stored at another `state_version` migrates before the mod's next callback in that thread or
  checkout: the host runs the mod's `migrate` handler (an experimental event that needs `store`) on it and keeps the
  previous file beside it as `<file>-backup-<sha256>`; until then registration and render reads see `null`.
- A package update that changes the `state_version` of a thread- or checkout-scoped mod with `store` is refused
  (`migration_handler_required`) unless the new version registers `migrate`; an adapter-wrapped package is not
  checked.
- The preview runs no new code: it marks such a package `state_version.handler_required`, and the confirmed apply
  loads it to check.
- Migration handlers can import declared package assets by relative path.

## Reactive state (`reactive_state_v1`)

Reactive state gives a mod typed handles on `api.state` keys and a way to react to their changes.

| Helper | What it is |
| --- | --- |
| `api.atom(key, fallback)` | A typed handle on one top-level key of an object `api.state` (`get`, `set`, `update`). |
| `api.member(key, id, fallback)` | One member of a map-valued key. |
| `api.derive(() => value)` | A memoized selector that recomputes when a key it read changes. |
| `api.subscribe(target, (value, previous) => …)` | Registers during activation and runs once per changed target after the handler that changed it, still inside that callback. |

- Writes go through the same compare-and-swap as `api.state.set`, so a concurrent writer reruns the callback rather
  than losing an update.
- A subscription's host calls and writes commit or rerun with the callback. A cascade stops after 8 rounds, and at
  most 64 subscriptions exist per mod.
- Subscriptions belong to the activation generation, so a reload or disable drops them.
- Render hooks report the keys they read; the host redraws a hooked component only when one of those keys, the
  mod's settings or its source changes, so several wrappers can watch the same state without redrawing the whole
  view on every key.
