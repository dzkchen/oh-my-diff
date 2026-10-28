# Commands, configuration and composer

How mods list, describe and run commands, read and write Codex configuration, and take part in the composer: `@`
completion, drafts, suggestions, key interception and file mentions. Read it when a mod adds slash commands, wraps
settings writes or edits what the user is typing.

## Commands and configuration (`command_config_middleware_v1`)

### Command listing and description

`commands.list` (`terminal`) returns `{commands: [row]}` for every built-in, service-tier and mod command the
composer can offer. `commands.describe {command}` returns one row.

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

`config.describe` (`config`) returns `{rows: [row]}`: each enabled mod's settings as `mods.<id>.<name>` rows, then
the host-writable Codex keys present in the effective config.

A row is `{key, label, value, source, version, scope, editable, managed, secret, hidden}` plus `type` and `enum`
for mod settings:

| Field | Meaning |
| --- | --- |
| `source` | The config layer (`user`, `project`, `system`, `mdm`, ...). |
| `version` | The layer version. |
| `managed` | Marks managed layers. |

Secret keys and secret-bearing tables (headers, environment, tokens) show `<redacted>` and are never editable.

### `config.set`

`config.set {key, value, expected?}` (`config.write`, user contexts) writes an `editable` row:

- Codex keys are written after a native confirmation through `config/value/write` with the described layer version.
- Mod settings are written through the same validation as `settings.write` (another mod's settings after a native
  confirmation).
- `expected` refuses the write (`config_stale`) when the value changed since it was read.
- A concurrent Codex write fails with the server's version conflict.

Every successful `config.set` and `settings.write` change raises `config_change {key, original, effective, source,
scope, caller}` for the other mods registered for it.

### Command and configuration interceptor surfaces

Four
[continuation](tools-and-middleware.md#continuation-middleware-continuation_middleware_v1-tool_continuation_v2)
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

## Codex configuration (`codex_config_v1`)

A manifest's `codex_config` turns on Codex features the package depends on, for every lead thread the session
starts, resumes or forks while the package is active: `{"codex_config": {"tools.update_plan.enabled": true}}`.

- Keys come from a closed host allowlist (`tools.update_plan.enabled`, `tool_output_token_limit.raise`) and must be `true`.
- `tool_output_token_limit.raise` sets the thread's `tool_output_token_limit` to at least 65,536 tokens (about 256 KiB),
  keeping a larger configured value. `exec_command` and `write_stdin` still default to 10,000 tokens unless the call
  sets a larger `max_output_tokens`, which a `tool` interceptor can do. It makes no output smaller or safer: the
  package must budget model-visible outputs itself, or every long output reaches the model whole.
- The package must list `codex_config_v1` in `required_features`.
- Anything else fails inspection with `invalid_codex_config`.

The host recomputes the keys whenever it reloads the active packages (at the next turn boundary after a change), so
a package enabled mid-session applies to lead threads started after that reload; threads that already exist keep
their configuration. It overrides an explicit `false` in the user's config for those threads and writes nothing to
`config.toml`.

Install, update and trust previews and `omd-mod status` list a package's `codex_config` with its other authority.

## Composer completion (`completion_v1`)

### `@` mention completion

`replace('completion')` receives each `@` mention query with up to 200 upstream candidates and returns
`{items: [{path}]}` in the order to show. Paths must be workspace-relative. Without an owner upstream ranking is
used; stale results are dropped.

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

`api.intercept('composer_edit', …)` sees every mod write and native fill before it reaches the draft: `{source:
'mod' | 'paste' | 'history' | 'completion', caller, revision, edit}`. Handlers may change only `edit.text` or
answer `{deny}`, which leaves the draft unchanged and tells the user. They run while the terminal applies the edit,
so they get no host operations. The whole chain, including any wait for a runtime busy with another callback, gets
50 ms; when that runs out a native fill applies unmodified with a status notice and a mod write is refused with
`mod_runtime_busy`. While a required interceptor selects `composer_edit`, a native fill is refused the same way.

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

### `component_change` interceptor

`api.intercept('component_change', …)` (capability `terminal`, `ui_controls_v1`) runs before a user's focus or
scroll change is reported, and only for the mod that owns the component being left or entered: `{kind: 'focus', id,
from, to, origin: 'user'}` or `{kind: 'scroll', id, from, to, origin}`.

Handlers answer:

- `{deny}` to keep the previous focus or offset;
- `{focus: id}` to move focus to another of their own components (or `null` to release it);
- `{scroll: n}` to clamp the offset.

They run while the terminal handles the gesture, so they get no host operations. The whole chain, including any wait
for a runtime busy with another callback, gets 50 ms; when that runs out the change applies unchanged.

### Submitted drafts and `prompt_expanded`

The `input` interceptors also receive the submitted draft's `revision`, `attachments` (`{kind, source}`) and
placeholder `elements` (`{kind: 'paste' | 'mention' | 'skill' | 'image', start?, end?, name?, source}`).

After skills and mentions are expanded, `prompt_expanded` (capability `middleware`) lists them by name, path and
SHA-256 only (`{kind: 'skill' | 'mention' | 'paste' | 'image', …}`), never their content, and the `prompt` event's
`effective` is the text the model receives.

## `@` file mentions (`mention_read_v1`)

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
