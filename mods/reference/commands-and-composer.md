# Commands, configuration and composer

Use it when a mod adds or wraps slash commands, reads or writes configuration, removes built-in controls, or takes
part in the composer: `@` completion, drafts, suggestions, key interception and file mentions. `api.command`
itself is listed in [SDK helpers](sdk-helpers.md#other-api-members) and its registration limits in
[Host model](host-model.md#registration-limits).

## Commands and configuration (`command_config_middleware_v1`)

This section covers command listing, `commands.invoke`, `config.describe`, `config.set` and the command and
configuration interceptor surfaces.

### Command listing and description

`commands.list` (`terminal`) returns `{commands: [row]}` for every built-in, service-tier and mod command the
composer can offer. `commands.describe {command}` (experimental) returns one row.

A row is `{command, description, owner, hidden, args_hint, immediate, protected}`:

| Field | Meaning |
| --- | --- |
| `command` | The command name. |
| `description` | The description shown in the popup. |
| `owner` | Names the mod, or is `null`. |
| `hidden` | Whether the command is hidden. |
| `args_hint` | Comes from `api.command(name, handler, {args_hint})` and shows beside the description in the popup. |
| `immediate` | `immediate: false` (`api.command(..., {immediate: false})`) refuses the mod command while a turn runs (`command_unavailable_during_turn`). Built-ins report the engine's own rule. |
| `protected` | `protected` rows (`/omd`, `/quit`, `/exit`, `/approvals`, `/permissions`, `/status`, `/logout`) keep recovery and authority reachable. |

### `commands.invoke`

`commands.invoke {command, args?}` (`builtins`, user contexts) runs a built-in or any mod command and resolves with
`{command, result}`. `result` is a mod command's returned value, or `{invoked: true}` for a built-in, which the
terminal dispatches with the effective arguments.

- Another mod's command runs only after a native confirmation, since its handler runs with that mod's grants.
- A mod command's display, insert and submit outcomes still apply.
- Runs nest at most four deep (`command_recursion_limit`).
- The permissions, sandbox elevation, logout, quit, exit, feedback and test-approval built-ins are refused.

### `config.describe`

`config.describe` (`config`, experimental) returns `{rows: [row]}`: each enabled mod's settings as `mods.<id>.<name>`
rows, then the host-writable Codex keys present in the effective config.

A row is `{key, label, value, source, version, scope, editable, managed, secret, hidden}` plus `type` and `enum`
for mod settings:

| Field | Meaning |
| --- | --- |
| `source` | The config layer (`user`, `project`, `system`, `mdm`, ...). |
| `version` | The layer version. |
| `managed` | Marks managed layers. |

Secret keys and secret-bearing tables (headers, environment, tokens) show `<redacted>` and are never editable.

### `config.set`

`config.set {key, value, expected?}` (`config.write`, user contexts, experimental) writes an `editable` row:

- Codex keys are written after a native confirmation through `config/value/write` with the described layer version,
  under the [config write rules](app-bridge-and-approvals.md#config-writes).
- Mod settings are written through the same validation as [`settings.write`](settings.md#settingswrite) (another mod's
  settings after a native confirmation).
- `expected` refuses the write (`config_stale`) when the value changed since it was read.
- A concurrent Codex write fails with the server's version conflict.

Every successful `config.set` and `settings.write` change raises the experimental
`config_change {key, original, effective, source, scope, caller}` for the other mods registered for it.

### Command and configuration interceptor surfaces

Four
[continuation](interceptors.md#continuation-middleware-continuation_middleware_v1-tool_continuation_v2)
surfaces wrap these:

- `command_list` (`commands`) and `config_list` (`config`) compose rows without host operations: hide, relabel
  (`description`, `label`) or hint (`args_hint`) ordinary rows; a dropped ordinary row becomes hidden. Protected,
  managed and secret rows cannot change or be dropped, nothing can be added or renamed, and a failing list chain
  keeps the native rows. Hidden commands leave the popup and the typed-command lookup.
- `command` (`commands`) wraps typed, popup and `commands.invoke` runs of built-in and mod commands: rewrite
  `args`, transform `{result}`, answer with `{result}` or refuse with `{deny}` (`command_denied: reason`).
  Protected built-ins never pass through it, so a broken required interceptor cannot lock out `/omd`.
- `config_set` (`config.write`) wraps `config.set` and `settings.write` per key: change `value` or `{deny}`
  (`config_set_denied: reason`); the host re-checks editability, managed floors and the writable-key allowlist
  after the chain.

Interceptors of these surfaces skip their own mod's calls like every other surface, which bounds recursion through
`commands.invoke` and `settings.write`.

## Built-in controls

`api.builtins({commands: {hide}, modes: {disable}, surfaces: {disable}, features: {remove}})`, registered during
activation, removes slash commands, collaboration modes, native surfaces and Codex features from the next idle boundary
until the mod is disabled, unloaded or fails. Controls belong to the directory OMD was launched in and cover every
thread of that session, including threads in its worktrees.

- `surfaces: {disable: ['status_line']}` turns off the upstream `/statusline` row at its source: its configured
  items are neither computed nor polled and reserve no height, the user's `tui.status_line` setting is untouched,
  and the row still draws when other mods publish `status` segments.
- `features: {remove: ['prevent_idle_sleep']}` (`builtins_features_v1`) takes Codex features out of the session:
  they read as off everywhere, whatever `config.toml` or `-c` sets, and they leave `/experimental`, the app-server's
  experimental feature list, `codex features list` and tips. Removing `code_mode` also removes `code_mode_only`.
  Nothing is written to `config.toml`; disabling the mod brings back the rows and the saved values. A feature that
  managed requirements pin on stays on. Keys must be Codex feature keys (`invalid_builtins` otherwise).
- `/quit`, `/exit`, `/approvals`, `/permissions`, `/status`, `/logout` and the default mode cannot be removed.
- A disabled mode is absent from `collaborationMode/list`. A thread that requests or still holds one is reported in
  the default mode and runs its next turn there with that mode's instructions cleared and a warning (a `warning`
  notification for app-server clients), including the turn at whose boundary the mod loads.
- Tools limited to collaboration modes lose the disabled ones and are not offered when none remain.

### `builtins.invoke` and `api.builtins`

`builtins.invoke {action}` (experimental) runs a key action from user contexts. It is refused (`builtins_view_active`)
while a dialog, popup, overlay or focused mod component would take the key, and `list.*` and the permission-mode actions
are never invoked (`keymap_action_refused`).

`api.builtins({keys, commands: {replace}})` overlays key bindings (never `approval.*`) and routes a built-in
command to a mod command; the slash popup lists the built-in with that command's description and arguments.

## Composer completion (`completion_v1`)

This section covers `@` mention, command argument and token completion.

### `@` mention completion

`replace('completion')` receives each `@` mention query with up to 200 upstream candidates by default
(`completion_items` in [Host limits](limits.md#host-limits)) and returns `{items: [{path}]}` in the order to show. Paths
must be workspace-relative. Without an owner upstream ranking is used; stale results are dropped.

### Command argument completion

While the user types arguments to a mod command (`completion_arguments_v1`), the mod that registered the command
receives `{kind: 'argument', command, query, line}` when it handles `completion` (`api.on` or `replace`), otherwise
the exclusive owner does. It returns `{items: [{insert}]}` and the list opens only when it has items.

A mod can therefore complete its own commands without owning `@` mention ranking. Accepting an argument choice
advances past a separator and keeps completion closed until the draft or cursor changes, so the next Enter submits
the command.

### Token completion

`api.completion({trigger}, handler)` (capability `composer`, `completion_tokens_v1`, experimental) completes
arbitrary tokens. `trigger` is one ASCII punctuation character other than `@`, `/` and `$`, and a mod registers at
most four during activation.

While the token before the cursor (from the last whitespace) starts with the trigger, the handler receives
`{kind: 'token', trigger, query, line}` (`query` without the trigger, `line` up to the cursor) and returns
`{items: [{insert}]}` with the same limits, debounce and stale-result dropping as argument completion.

The host shows the rows in the composer's completion list and, on Tab or Enter, replaces the whole token with the
selected `insert` and advances past a separator so the accepted token does not immediately reopen completion. When
two mods register the same trigger, the first loaded mod keeps it and the other gets a status notice.

## Composer drafts and suggestions (`composer_v2`)

This section covers `composer.read`, `composer.write`, `composer.suggest`, the `composer` event, the `composer_edit`
and `composer_key` interceptors, and submitted drafts.

### `composer.read`

`composer.read` returns `{text, cursor, selection, revision, attachments, suggestion}`. `revision` advances
whenever the draft's text or attachments change, whoever changed them.

Each attachment has:

- a stable `id`;
- its placeholder `label`;
- its `owner` (`user` or the mod that attached it);
- an immutable image `resource` bound to the reading mod, its source hash and repository, with package lifetime
  across configuration revisions and thread forks (PNG and JPEG up to 8 MiB; otherwise `null`);
- the image's `width` and `height` in pixels when its header decodes.

### `composer.write`

`composer.write {revision, edit?, cursor?, selection?, attach?, detach?}` applies only to that revision and fails
with `stale_revision` otherwise.

- `edit` is `{kind: 'fill' | 'insert' | 'append', text}` or `{kind: 'splice', start, end, text}` (byte offsets on
  character boundaries).
- `cursor` and `selection: {start, end}` place the cursor or select.
- `attach` adds image resources.
- `detach` removes attachments by placeholder.

The complete edit, positions and detach list are validated before the draft changes; rejected writes leave its
content and attachments intact. Queued client calls remain bound to their admitted thread, source generation and
active authority, including after confirmation. A write never submits. Images a mod attached leave the draft when
that mod is unloaded, reloaded or disabled.

### `composer.suggest`

`composer.suggest {revision, id, text}` shows one dimmed suggestion after the cursor while the cursor is at the end
of that revision (4 KiB, first line shown); a newer suggestion replaces an older one.

- The user accepts it with the move-right key at the end of the draft (so a remapped `editor.move_right` applies)
  or by clicking it, and dismisses it with Esc.
- Any draft change, a turn start, an open dialog or the owner's reload clears it.
- `{clear: true}` withdraws the caller's own.

### `composer` event

The `composer` event (capability `composer`) reports two kinds of payload:

- `{kind: 'change', revision, attachments_revision, origin}` to every subscriber (`attachments_revision` advances
  only when the attached images change), debounced to 250 ms.
- `{kind: 'suggestion', id, status: 'accepted' | 'dismissed' | 'cleared', reason?}` to the suggestion's owner.

### `composer_edit` interceptor

`api.intercept('composer_edit', …)` sees every mod write and native fill before it reaches the draft:
`{source: 'mod' | 'paste' | 'history' | 'completion', caller, revision, edit}`. Handlers may change only `edit.text` or
answer `{deny}`, which leaves the draft unchanged and tells the user. They run while the terminal applies the edit, so
they get no host operations. The whole chain, including any wait for a runtime busy with another callback, gets 50 ms;
when that runs out a native fill applies unmodified with a status notice and a mod write is refused with
`mod_runtime_busy`. While a required interceptor selects `composer_edit`, a native fill is refused the same way. A
policy or redaction interceptor must therefore be `required`: a busy optional one lets a paste or fill through
unmodified.

### `composer_key` interceptor

`api.intercept('composer_key', …)` (`composer_key_v1`, experimental) sees each key press or repeat that reaches the
prompt box, after mod key components, dialogs, chords and app key bindings and before popups and the editor keymap:
`{key, text, revision, cursor}`.

- A printable character without Ctrl or Alt is `key` and `text` as typed (`'a'`, `'#'`, `' '`).
- Any other key is its mod key name (`Ctrl+w`, `Enter`, `Shift+Tab`) with `text: null`.
- `text` is also `null` in vim normal mode, where characters are commands.

Handlers may set `key` to another character or to a key name valid in view `keybindings` or an unmodified named key
(`Left`, `Backspace`), which the composer then applies as if typed, or answer `{deny}` to drop the key silently.

- Paste bursts, bracketed paste and non-ASCII characters (IME) bypass the chain.
- The whole chain, including any wait for a runtime busy with another callback, gets 50 ms per keystroke and no
  host operations; when that runs out, or the result is invalid, the original key applies and a status notice
  shows.
- Use `match` on `key` so other keystrokes never start a callback.

### Submitted drafts and `prompt_expanded`

The `input` interceptors also receive the submitted draft's `revision`, `attachments` (`{kind, source}`) and
placeholder `elements` (`{kind: 'paste' | 'mention' | 'skill' | 'image', start?, end?, name?, source}`).

After skills and mentions are expanded, the experimental `prompt_expanded` event (capability `middleware`) lists them by
name, path and SHA-256 only (`{kind: 'skill' | 'mention' | 'paste' | 'image', …}`), never their content, and the
`prompt` event's `effective` is the text the model receives.

## `@` file mentions (`mention_read_v1`)

This section covers what the host reads for an `@` mention, the read checks and limits, and the `mention` interceptor.

### What the host reads

When a turn starts, the host reads each `@path` or `@"path with spaces"` of the submitted text that names an
existing workspace file, and gives the model its contents after the prompt as
`<mentioned_file><path>…</path>…</mentioned_file>`.

- At most 16 mentions are read per turn.
- A leading `./` and unquoted trailing punctuation are ignored.
- Quoted paths use JSON string escaping and preserve punctuation, quotes and backslashes. An `@` inside a quoted
  path is part of that path.
- Picking a file from the `@` list inserts it in this form, except in a slash command or shell command, which get
  the bare path.

### Read checks and limits

Reads use the `workspace.read` checks: repository-relative paths without `..`, `.git`, backslashes or symlink
components, and the intersection of the selected turn environment's filesystem permissions with the thread's
effective read permissions and deny rules.

- Expansion requires exactly one local environment at the thread's repository; other environments or working
  directories skip expansion.
- Each file is read once, in mention order, while the turn's mentioned files total at most 256 KiB of returned
  UTF-8 bytes, checked again after reading.
- A file that fails the checks, does not fit or is not UTF-8 is left to the model's own tools.

### `mention` interceptor

Before each read, `api.intercept('mention', …)` (capability `input`, experimental) receives `{thread_id, path}`.
Handlers may set `path` to another workspace file, which is read under the same checks, or answer `{deny}` to skip
the read. They run beside the session like `input` interceptors and may call host operations; a failing chain skips
the read, and interrupting the turn cancels the chain.
