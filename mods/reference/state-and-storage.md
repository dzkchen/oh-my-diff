# State and storage

Use it when a mod keeps data: `store.*` records, evidence and binary evidence, `api.state` and where it lives,
state migration, session UI state and the reactive helpers over `api.state`.

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](stability-and-migration.md#experimental-entries-in-the-registry)). Every operation here needs the
`store` capability except `api.uiState`, which needs `terminal`.

## Durable data: `store.*` and evidence

A mod stores durable values with `store.*` and larger records, including images and SVG assets, with `evidence.*`.

### `store.*` operations

```text
store.get {key, scope?} → {value, revision, provenance} | null
store.put {key, value, expected_revision, scope?} → {revision}
store.delete {key, expected_revision, scope?} → {deleted}
store.list {prefix?, cursor?, limit?, scope?} → {keys, cursor, generation}
store.export {scope?, cursor?} → {schema, owner, scope, generation, entries, cursor}
store.reset {expected_generation, scope?} → {generation}
```

They operate on a per-mod namespace. `store.list`, `store.export` and `store.reset` are experimental.

| Argument | Meaning |
| --- | --- |
| `key` | 1–256 printable ASCII characters, no spaces or `\` |
| `scope` | `repository` (the default), `user` or `thread` (see [Thread-scoped store and `resume`](threads-and-sessions-store.md#thread-scoped-store-and-resume)) |
| `value` | Any JSON except null, at most 64 KiB |
| `expected_revision` | The record's current revision, or `null` to create it; required on `put` and `delete` |
| `expected_generation` | The scope's current generation; required on `reset` |
| `prefix`, `limit` | Filter and page size for `list`; a page contains at most 256 keys |
| `cursor` | The cursor of the previous page |

Results:

- `provenance` is host-attested `{mod, source_sha256, thread_id, origin, at}` (`at` is milliseconds since the Unix
  epoch); every record has it.
- `list` returns `keys` as `{key, revision, bytes, provenance}`.
- `export` returns pages of at most 64 KiB; `entries` maps each key to `{value, revision, provenance}`.
- `cursor` is null on the last page.

A scope stores at most 16 MiB and 4,096 keys.

| Error | When |
| --- | --- |
| `store_key_invalid` | The key is missing or breaks the `key` rule |
| `store_scope_invalid` | Another scope |
| `store_value_required`, `store_value_limit` | `put` without a value, or with one over 64 KiB |
| `store_expected_revision_required` | `put` or `delete` without `expected_revision` |
| `store_revision_conflict` | The revision is stale; on `put` the message names the current one |
| `store_expected_generation_required`, `store_generation_conflict` | `reset` without the generation, or with a stale one |
| `store_quota` | The write would pass the scope's 16 MiB or 4,096 keys |
| `store_thread_unavailable` | `thread` scope before the session has a thread |

```ts
const current = api.host.call('store.get', { key: 'goal', scope: 'thread' });
api.host.call('store.put', {
  key: 'goal', value: String(text), expected_revision: current?.revision ?? null, scope: 'thread',
});
```

That example is from [`goal_store`](../examples/goal_store/index.ts).

To export or reset a store namespace outside a session, without running any mod code, use
`omd store export|reset --mod ID [--repo PATH] [--store PATH] [--scope repository|user]`. Export writes the complete
namespace.

### `evidence.write` and `evidence.read`

```text
evidence.write {media_type: 'application/json' | 'text/plain', content, label?} → ResourceRef
evidence.write {media_type: 'image/png' | 'image/jpeg' | 'image/svg+xml' | 'application/octet-stream', base64, label?} → ResourceRef
evidence.read {reference, cursor?, max_bytes?} → {reference, text, cursor, bytes}
```

`evidence.write` stores content-addressed evidence and returns a `ResourceRef` `{reference, sha256}`. The `base64`
form is binary evidence (`binary_evidence_v1`).

| Media type | Size |
| --- | --- |
| `image/png`, `image/jpeg` | At most 8 MiB |
| `image/svg+xml` | At most 1 MiB, checked as under [SVG assets](#svg-assets-svg_assets_v1) |
| `application/octet-stream`, text | At most 16 MiB |

`evidence.read` reads evidence back in pages: `max_bytes` is 1 to 65,536 and defaults to 65,536, and `cursor` is
null after the last page. PNG and JPEG references can be attached through `composer.write` and image-capable app
methods.

```ts
api.host.call('evidence.write', { media_type: 'image/svg+xml', base64: BADGE, label: 'external client badge' })
```

That call is from [`external_client`](../examples/external_client/index.ts).

### SVG assets (`svg_assets_v1`)

The host accepts an SVG asset in `evidence.write` and `terminal.import_file` only if it is UTF-8 XML of at most 1 MiB
whose root element is `svg`, after an optional XML declaration and comments. Every element must be in the SVG namespace
(an unprefixed element without a default namespace counts as SVG).

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

## `api.state`

`api.state` is a mod's state object. The manifest's [`state_scope`](#state_scope-state_scopes_v1) sets whether there
is one per mod store, per thread or per checkout.

### `api.state` compare-and-swap

`api.state` is re-read before every callback and written back with a compare-and-swap. If another process wrote it
meanwhile, the host runs the callback again against the fresh state, within the callback's 5 s budget.

- The rerun's host calls get the results already recorded, so no operation runs twice.
- The clock stays at the first attempt's start, so `Date.now()` in arguments replays.
- If the rerun asks for a different host call, the host runs the callback fresh when every recorded call was
  read-only. Otherwise the callback fails with the transient `state_conflict`, because an operation that already ran
  is never repeated.

### Durability of state and store writes

Commits of `api.state` in every scope and of `store.*` data use a write barrier, not a full fsync. They survive a
crash or quit in order, but the last commits can be lost on a power failure. Evidence is fully synced.

### `state_scope` (`state_scopes_v1`)

The location of `api.state` follows the manifest's `state_scope` (`state_scopes_v1`).

- `"store"` (the default) stores one state of at most 512 KiB in the mod store, shared by every OMD process that
  uses that store.
- `"thread"` stores one state per session thread and selection scope, so a project copy can't inherit a same-id
  user copy's state. The state forks with the thread and is removed when the thread is deleted.
  - Routing and compaction decisions made while a thread is set up see that thread's state. For a fork, the host
    makes the fork's copy first.
  - Registration reads the state of the thread whose callback reloaded the mods. At process start there is no such
    thread.
- `"checkout"` stores one state per checkout, shared by every OMD process working there whatever its mod store: in
  `<git-dir>/omd/state/<mod>.json` for a Git checkout (a linked worktree has its own), read-only to agent commands
  as Codex keeps `.git` read-only. Outside a Git checkout, as in a projectless session, checkout state is unavailable
  (`state_checkout_unavailable`) and nothing is written to the directory.

These rules apply in every scope:

- Mods never run with the home directory or the filesystem root as the session directory. The host stays off with a
  notice in `/omd`.
- `omd-mod command STORE MOD NAME JSON [THREAD]` and `omd-mod test STORE SCENARIO [THREAD]` use the given THREAD and
  the checkout of their working directory. A `thread` mod run from `omd-mod command` without THREAD fails with
  `state_thread_unavailable`.
- In the TUI, a slash command typed before the session's thread exists runs once the thread exists.
- A callback result, including its state, is at most 1 MiB.

### State migration (`state_version`)

A mod raises the manifest's `state_version` when its saved state changes shape. Thread and checkout state migrate
inside a session. Mod store state migrates with `omd-mod migrate`.

- Thread and checkout state stored at another `state_version` migrates before the mod's next callback in that thread or
  checkout: the host runs the mod's `migrate` handler (an experimental event that needs `store`) on it and keeps the
  previous file beside it as `<file>-backup-<sha256>`; until then registration and render reads see `null`.
- A package update that changes the `state_version` of a thread- or checkout-scoped mod with `store` is refused
  (`migration_handler_required`) unless the new version registers `migrate`; an adapter-wrapped package is not
  checked.
- The package update preview runs no new code: it marks such a package `state_version.handler_required`, and the
  confirmed apply loads it to check.
- Migration handlers can import declared package assets by relative path.

The `omd-mod migrate` and `rollback` commands act on `"store"` state only.

`omd-mod migrate STORE MOD_ID_OR_PACKAGE` and `omd-mod rollback STORE MOD_ID_OR_PACKAGE BACKUP` take a mod id or a
package folder. A bare name (no `/`) is a mod id resolved among the store's selected mods (watched folder or installed);
`.`, `..` and anything with a `/` are package folders. An id that matches copies in more than one scope fails with
`mod_ambiguous` (pass the folder), and a mod without saved store state fails with `migration_requires_saved_state`.

## Session UI state (`api.uiState`)

`api.uiState.get()` / `.set(value)` (experimental) stores session-only state, such as open dialogs and filters, and
requires `terminal`. Saved `api.state` is unchanged by it.

- Values are bounded to 65,536 UTF-8 bytes of compact `JSON.stringify(value)` output, including quotes, keys and
  escapes.
- Strings and object keys must contain valid Unicode scalars (no lone surrogates).
- The host checks the original serialized bytes before parsing; number reformatting does not change the limit.
- Values are shared by host instances in the same process, store, repository, thread and package identity.
- Commands and component events may write; other callbacks may read.
- Writes commit only after successful validation and cancellation checks. A revision conflict reruns the callback
  under the same replay rules as [`api.state` compare-and-swap](#apistate-compare-and-swap).
- Authority polling with unchanged configuration preserves UI state and
  [command views](commands-and-composer.md#command-views).
- State is cleared on explicit reload, revocation, package changes and session teardown, and is never written to
  disk.
- A reload during a command or component event (such as one its own `packages.apply` caused) does not cancel it.
  Its `set` writes to the cleared state, even if the value came from a read before the reload. A change of repository
  during the callback cancels it.

Preferences that must survive a restart belong in `api.state` or `store.*`, under the power-failure rule in
[Durability of state and store writes](#durability-of-state-and-store-writes).

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
