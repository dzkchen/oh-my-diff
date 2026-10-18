# Packages, limits and registration rules

Binary evidence and SVG assets, the package controls a mod can call, the host limits `host.json` can set and the
rules the host enforces on registration, views and callbacks. Use this page to check what a mod may register, draw
and run.

## Binary evidence and package controls

### `evidence.write` and binary evidence (`binary_evidence_v1`)

```ts
evidence.write {media_type: 'image/png' | 'image/jpeg' | 'image/svg+xml' | 'application/octet-stream', base64}
```

It accepts up to 8 MiB (`binary_evidence_v1`). PNG and JPEG references can be attached through `composer.write` and
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

### Package controls (`package_controls_v1`)

`packages.list`, `packages.index`, `packages.preview`, `packages.apply` and `packages.reload`
(`package_controls_v1`) install, update, remove, roll back, enable and disable packages from local directories, Git
repositories, curated index releases and npm packages (sources and references are listed under [Package
commands](packaging.md#package-commands)); `index` resolves dependencies. A request names its package with `source`
or with a `reference` string and an optional `version`.

### `packages.list`

`packages.list` reports every store selection: managed packages and trusted `omd-mod` selections (`source:
'selection'`, which enable, disable and `trust` but do not update).

- `source` is also `npm` for npm packages.
- `blocked` is the quarantine reason or `null`.
- `packages.list {fields}` keeps only the named keys of each package, so a listing view can skip schemas, settings
  and grants it does not show.
- `packages.list` reports each mod's `settings` and `settings_schema`.

### `packages.index`

`packages.index {index?, query?}` is read-only and returns:

```ts
{index, packages: [{id, latest, description, support, versions: [{version, blocked}], installed}]}
```

It reads the named index (the store's `package-index.json` by default), at most 200 packages matching `query`: its
letters in order in the id, ignoring spaces, or its text in the description. Ids starting with or containing `query`
come first, description matches last. It fails with
`package_index_unavailable` when no index exists.

### Package state fields

- `effective`, `pending: 'reload'` and `failed` describe the serving session, so a change shows as pending until
  that session's next safe boundary, and a removed mod stays listed with `installed: false` until it stops.
- `reload_error` names a rejected change while the previous mods keep running.

### `packages.apply`, `packages.preview` and `packages.reload`

`apply` and `reload` run from user contexts. The `trust` action re-approves an edited selection's current source and
capabilities and keeps it enabled.


- `apply` shows a native confirmation naming every new grant, dependencies as `id:capability`, and applies exactly
  the confirmed plan or refuses if the package, lock or selection changed.
- Installing never enables a package: an update keeps it on only if it was on and its grant, authority scopes and
  origin are unchanged, otherwise it stays off until enabled.
- The preview lists per package `authority {from, to}`, `grant {from, to}` and `renewed_approval`.
- Once a confirmed package mutation starts, it returns its definitive result even if its writes reload or disable
  the calling mod. Queued calls still reject cancellation, changed source, originating generation or client
  context.
- An update resolves dependencies through the index the package came from and previews the capabilities it adds.
- `packages.reload` makes every enabled selection revalidate at the next safe boundary, retrying failed mods.

### `settings.write`

`settings.write {id?, values}` saves schema-checked settings (`null` removes one) from user contexts and redraws at
once. Without `id` it writes the caller's own settings; with `id` it needs `packages`.

Callbacks receive explicit settings over the schema's `default` values.

`/omd` stays the native recovery path.

## Host limits

`host.json` may set `mod_limits`:

| Limit | Default | Maximum |
| --- | --- | --- |
| `watches_per_mod` | 16 | 64 |
| `paths_per_watch` | 32 | 256 |
| `timers_per_mod` | 16 | 64 |
| `pty_panes_per_mod` | 4 | 8 |
| `completion_items` | 200 | 1000 |

## Registration, view and callback rules

The host enforces these; `scripts/mod_host_check.py` (`mise run mods:host-check`) loads every first-party package
and example through the real host and reports any it refuses.

### Registration limits

- At most 16 tools and 16 commands per mod.
- Commands are invoked as `/<id>:<name>`; the bare `/<name>` works only when no built-in command or other mod uses
  that name.
- Mod ids use `a-z`, `0-9` and `_` up to 24 bytes and never equal the host `origin.caller` labels `model`,
  `engine`, `code_mode` or `user`.
- Command and tool names use up to 32.

### View limits

Keybindings:

- Each mod's view or patch has at most 12 keybindings.
- The view composed from every mod has at most 64, and a key bound by two mods rejects the later mod's patch.

Components:

- A view holds at most 64 components nested at most 6 deep.
- Component ids use `a-z`, `0-9` and `_`, up to 48 bytes, and are unique across the composed view.
- A `select` or `multiselect` has at most 16 options and a `list` at most 200 rows.
- A `wrap` site contains exactly one `slot`.

Links and hotkeys:

- A span `link` is an http(s) URL of at most 2,048 bytes on `line` and `list` spans (documents refuse it), drawn as
  an OSC 8 hyperlink, and `markdown` links become hyperlinks too.
- A control `hotkey` uses the keybinding names.

Text sizes:

- Row values, labels and spans are at most 256 bytes.
- `text`, `code`, `markdown`, `diff` and `document` are at most 49,152 bytes. The terminal keeps recent markdown
  renders, so a large `markdown` costs its parse, about 1 ms per KiB, only when its text or width changes; stream
  into `code` or `text`.
- A view or patch is at most 64 KiB of JSON and the composed view 256 KiB. Those JSON limits still apply to
  text-heavy views, and escaping can double a text (`\n`, `"` and `\` take two bytes), so clip long text on its
  `JSON.stringify` size rather than its 48 KiB length.
- Text fields refuse control characters except newlines where a field is multi-line.
- The status row holds at most 4 segments of 40 characters across all mods.

An invalid view is dropped with the failing field named and the mod's last valid view stays; `omd-mod status`
reports the composed view's diagnostics under `terminal`.

### Input and focus

- A dialog focuses its first item when it opens, or the control it `autofocus`es.
- Tab and Shift+Tab cycle focus. Up and Down move within a list, multiselect, document or scrolled pane and, at its
  first or last row (or on any other control), focus the previous or next control; a list keeps its highlighted
  row; key panes and terminals are reached only with Tab or a click. Left and Right change a `select`. A focused
  list, multiselect, select or pane keeps its arrows when there is no control to move to.
- While a dialog shows or a control has focus, held arrow, page, Home, End, Backspace, Delete and character keys
  repeat; Enter, Space, Tab and Esc act once per press, a held arrow stops at a control's edge, and a held key never
  fires a hotkey or view binding.
- In a dialog, typing that no binding takes goes to its `autofocus` input.
- Esc, Ctrl+] or a click outside releases focus and hides the dialog until a mod command runs, and Esc reaches the
  focused component's owner as `component_event {kind: 'input', events: [{key: 'Esc'}]}`.
- A shown dialog is modal: keys it does not bind never reach the composer behind it (Ctrl+C still interrupts).
- Space on a focused `list` row or `button` activates it like Enter; on a `select` it steps to the next option.
- On a focused `multiselect`, Space toggles the current option and Enter runs its action with the checked values as
  a JSON array argument.
- A `hotkey` on a button, input, select, multiselect or list focuses it (a button runs its action) unless a text
  input has focus. It obeys the keybinding collision rules, is checked before view `keybindings`, and when two
  controls share one the first wins.
- `autofocus` focuses the control when it first appears and nothing has focus, reported as a `focus` event with
  origin `mod`.
- An `input`, `select` or `multiselect` is controlled: the user's edits stay while the view repeats a value, an
  echo of one of the user's own recent values is ignored, and a new `value` from the mod resets the field.

### Callback lifetime

- General callbacks get a fresh VM context and activation.
- A package's later callbacks may reuse its sandboxed runner process and a bounded cache of stripped source and
  bytecode; runners are never shared between packages.
- Work a callback leaves running settles before its result is returned, and a host call from it after the callback
  returned fails that callback.
- Persist state through `api.state`; module globals do not survive general callbacks.
- Render hooks retain activation under their existing matching-input rules.

### Text encoding and `crypto`

Every context has the standard `TextEncoder`. Host limits count UTF-8 bytes:

- `new TextEncoder().encode(text).length` measures a string.
- `text.slice(0, encoder.encodeInto(text, new Uint8Array(limit)).read)` cuts it to `limit` bytes without splitting
  a character.
- `encode` feeds `crypto.subtle`.

The `crypto` environment provides `getRandomValues`, `randomUUID` and the `crypto.subtle` methods.

- Their results are copied into the mod's context.
- A `CryptoKey` is a frozen handle with `type`, `extractable`, `algorithm` and `usages`.
- Failures are plain `Error`s whose `name` is the Web Crypto error name.

There is no `TextDecoder`, `Buffer` or `structuredClone`, and no code is compiled from strings (`eval`, `new
Function`), in the mod's context or the runner process.

### Manifest `environment`

`"environment": ["crypto"]` in `mod.json` admits the `crypto` global above. It is the only environment a mod can
declare (another or repeated name fails with `unsupported_or_duplicate_environment_access`).

Source that uses `crypto.` or `crypto[` outside string literals without it is refused at load with
`undeclared_environment_use: crypto (crypto.)`, naming the matched text. The same error names these, which no
manifest admits:

- `network` (`fetch(`, `WebSocket(`)
- `process` (`process.`, `Deno.`, `Bun.`)
- `dom` (`document.`, `window.`)
- `filesystem` (`node:fs` or `require('fs`, matched inside literals too)

### Experimental session UI state

`api.uiState.get()` / `.set(value)` requires `terminal`.

- Values are bounded to 65,536 UTF-8 bytes of compact `JSON.stringify(value)` output, including quotes, keys and
  escapes.
- Strings and object keys must contain valid Unicode scalars (no lone surrogates).
- The host checks the original serialized bytes before parsing; number reformatting does not change the limit.
- Values are shared by host instances in the same process, store, repository, thread and package identity.
- Commands and component events may write; other callbacks may read.
- Writes commit only after successful validation and cancellation checks, with revision conflicts using the
  existing receipt-replay rules.
- Authority polling with unchanged configuration preserves UI state and command views.
- State is cleared on explicit reload, revocation, package changes and session teardown, and is never written to
  disk.
- A reload during a command or component event (such as one its own `packages.apply` caused) does not cancel it,
  and its `set` lands on the cleared state, even with the value it read; a change of repository during it cancels
  it.

Durable `api.state` is unchanged. Use UI state for open dialogs and filters, and durable state for preferences that
must survive a restart.

### Experimental command views

Return `{terminal: patch}` with a `TerminalPatch` to replace your complete terminal contribution, or `{terminal:
null}` to clear it.

- The host validates capability, ownership and generation, composes it with other owners' last valid contributions
  and displays it before asynchronously refreshing expired callbacks.
- Keep a `terminal` handler that reconstructs the same contribution from UI state for subsequent view updates.
- This opt-in path changes when other owners refresh; commands without `terminal` retain their synchronous preview
  behavior.
- Migration from durable dialog state consists of moving only transient presentation fields to `api.uiState` and
  returning the view from the command; persisted settings, replay and module lifetimes are unchanged.

### Callback contexts

`terminal` renders and `render` hooks get no host operations; draw from `api.state`.

Slash commands, buttons and keybindings run in the terminal as user actions and reach only:

- `exec.*`
- `workspace.read/list/stat/check_access/transaction/backup/restore`
- `store.*`
- the terminal operations (`app.request`, `credentials.*`, `terminal.*`, `composer.*`, `builtins.invoke`,
  `packages.*`, `contract.select`, `sessions.ports`, `settings.write`)
- `app.routes`
- `turns.activity`
- `events.publish`

A service call works only while its provider needs no other host operation.

Component input callbacks run there too but not as user actions, so `packages.apply`, `settings.write`,
`builtins.invoke`, `credentials.request` and `terminal.import_file` are refused.

Anything else (`task.*`, `contract.*`, `routes.*`, `evidence.*`, `workspace.snapshot/fingerprint`, `process.*`,
`agents.*`) goes through `events.publish` to the mod's own `channel` handler, which runs with the session.

### Settings defaults

Callbacks receive explicit settings over each `settings_schema` property's `default`; give every property a
default.

### Runner memory limits

Each runner process has a 64 MiB V8 old-space limit, and the host kills a runner whose physical memory
(ArrayBuffers and other off-heap data included) passes 512 MiB. Either fails the callback with `mod_out_of_memory`.
