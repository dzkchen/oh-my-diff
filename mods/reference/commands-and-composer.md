# Commands, configuration and composer

Use it when a mod adds or wraps slash commands, reads or writes configuration, removes built-in controls, or takes
part in the composer: `@` completion, drafts, suggestions, key interception and file mentions. `api.command`
itself is listed in [SDK helpers](sdk-helpers.md#other-api-members) and its registration limits in
[Host model](host-model.md#registration-limits).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](stability-and-migration.md#experimental-entries-in-the-registry)). Composer and command operations
act on the OMD terminal session.

## Commands and configuration (`command_config_middleware_v1`)

A mod lists, describes and invokes slash commands, and reads and sets Codex configuration.

### Command listing and description

```text
commands.list → {commands: CommandRow[]}
commands.describe {command} → CommandRow
```

Both need `terminal`. `commands.list` returns every built-in, service-tier and mod command the composer can offer;
`commands.describe` (experimental) returns the row for one `command`.

A `CommandRow` is `{command, description, owner, hidden, args_hint, immediate, protected}`:

| Field | Meaning |
| --- | --- |
| `command` | The command name. |
| `description` | The description shown in the popup. |
| `owner` | Names the mod, or is `null`. |
| `hidden` | Whether the command is hidden. |
| `args_hint` | Comes from `api.command(name, handler, {args_hint})` and shows beside the description in the popup. |
| `immediate` | Whether the command may run during a turn. |
| `protected` | Whether the row is protected (list below). |

- A mod command registered with `api.command(..., {immediate: false})` is refused while a turn runs
  (`command_unavailable_during_turn`). Built-ins report the engine's own rule.
- Protected rows (`/omd`, `/quit`, `/exit`, `/approvals`, `/permissions`, `/status`, `/logout`) keep recovery and
  authority reachable.

```ts
const commands = api.host.call('commands.list', null).commands.filter(item => !item.hidden);
```

That line is from [`command_help`](../examples/command_help/index.ts).

### `commands.invoke`

```text
commands.invoke {command, args?} → {command, result} | {status: 'declined'}
```

It needs `builtins` and runs from [user contexts](host-model.md#callback-contexts). It runs a built-in or any mod
command.

| Argument | Meaning |
| --- | --- |
| `command` | The command name, with or without its leading `/` |
| `args` | The argument text |

`result` is a mod command's returned value, or `{invoked: true}` for a built-in, which the terminal dispatches with
the effective arguments. `{status: 'declined'}` means the user declined the confirmation.

- Another mod's command runs only after a native confirmation, since its handler runs with that mod's grants.
- A mod command's display, insert and submit outcomes still apply.

| Error | When |
| --- | --- |
| `command_unknown: NAME` | No command has that name |
| `command_invoke_refused: NAME` | The permissions, sandbox elevation, logout, quit, exit, feedback and test-approval built-ins |
| `command_recursion_limit` | Runs nest more than four deep |
| `command_unavailable_during_turn` | An `immediate: false` mod command while a turn runs |

```ts
api.host.tryCall('commands.invoke', { command: 'theme' });
```

That call is from [`omd_theme`](../first-party/omd_theme/index.ts).

### Command views

Command views are experimental. A command may return `{terminal: patch}` with a `TerminalPatch` to replace its mod's
complete terminal contribution, or `{terminal: null}` to clear it.

- The host checks capability, ownership and generation. It composes the patch with other owners' last valid
  contributions and displays it, then refreshes expired callbacks asynchronously.
- The result stands for at most one second, under
  [Reuse of `terminal` patches](terminal-ui.md#reuse-of-terminal-patches). After that the mod's `terminal` handler
  draws the view, so it needs to rebuild the same contribution, for example from
  [`api.uiState`](state-and-storage.md#session-ui-state-apiuistate).
- Other owners refresh at different times when a command returns a view. Commands without `terminal` keep their
  synchronous preview behavior.
- Moving a dialog from durable state to a command view moves only its transient presentation fields to
  `api.uiState`; persisted settings, replay and module lifetimes are unchanged.

### `config.describe`

```text
config.describe → {rows: ConfigRow[]}
```

It needs `config` and is experimental. It returns each enabled mod's settings as `mods.<id>.<name>` rows, then the
host-writable Codex keys present in the effective config.

A `ConfigRow` is `{key, label, value, source, version, scope, editable, managed, secret, hidden}` plus `type` and
`enum` for mod settings:

| Field | Meaning |
| --- | --- |
| `source` | The config layer (`user`, `project`, `system`, `mdm`, ...). |
| `version` | The layer version. |
| `managed` | Marks managed layers. |

Secret keys and secret-bearing tables (headers, environment, tokens) show `<redacted>` and are never editable.

### `config.set`

```text
config.set {key, value, expected?} → {key, effective} | {status: 'declined'}
```

It needs `config.write`, runs from user contexts and is experimental. It writes an `editable` row.

| Argument | Meaning |
| --- | --- |
| `key` | A `config.describe` row key |
| `value` | The new value |
| `expected` | The value read earlier; the write is refused if it changed |

It returns the key and its `effective` value, or `{status: 'declined'}` when the user declines the confirmation.

- Codex keys are written after a native confirmation through `config/value/write` with the described layer version,
  under the [config write rules](app-bridge-and-approvals.md#config-writes).
- Mod settings are written through the same validation as [`settings.write`](settings.md#settingswrite) (another mod's
  settings after a native confirmation).
- A concurrent Codex write fails with the server's version conflict.

| Error | When |
| --- | --- |
| `config_key_required`, `config_value_required` | `key` or `value` is missing |
| `config_key_unknown: KEY` | No row has that key |
| `config_not_editable: KEY` | The row isn't `editable` |
| `config_stale: KEY changed since it was read` | `expected` no longer matches |
| `config_set_denied: REASON` | A [`config_set` interceptor](#command-and-configuration-interceptor-surfaces) denied it |

Every successful `config.set` and `settings.write` change raises the experimental
`config_change {key, original, effective, source, scope, caller}` for the other mods registered for it.

### Command and configuration interceptor surfaces

Four [interceptor](interceptors.md#registration-chain-and-failure-rules) surfaces wrap the operations on this page:

- `command_list` (`commands`) and `config_list` (`config`) compose rows without host operations. A handler may hide,
  relabel (`description`, `label`) or hint (`args_hint`) ordinary rows, and a dropped ordinary row becomes hidden.
- On those two surfaces, protected, managed and secret rows can't change or be dropped, and no row can be added or
  renamed. A failing list chain keeps the native rows. Hidden commands leave the popup and the typed-command lookup.
- `command` (`commands`) wraps typed, popup and `commands.invoke` runs of built-in and mod commands: rewrite
  `args`, transform `{result}`, answer with `{result}` or refuse with `{deny}` (`command_denied: reason`).
  Protected built-ins never pass through it, so a broken required interceptor cannot lock out `/omd`.
- `config_set` (`config.write`) wraps `config.set` and `settings.write` per key: change `value` or `{deny}`
  (`config_set_denied: reason`); the host re-checks editability, managed floors and the writable-key allowlist
  after the chain.

Interceptors of these surfaces skip their own mod's calls like every other surface, which bounds recursion through
`commands.invoke` and `settings.write`.

## Built-in controls

`api.builtins({commands: {hide}, modes: {disable}, surfaces: {disable}, features: {remove}})` removes slash commands,
collaboration modes, native surfaces and Codex features. Call it during activation. The removal starts at the next idle
boundary and lasts until the mod is disabled, unloaded or fails. Controls apply to the directory OMD was launched in and
cover every thread of that session, including threads in its worktrees.

- `surfaces: {disable: ['status_line']}` turns off the upstream `/statusline` row at its source: its configured
  items are neither computed nor polled and reserve no height, the user's `tui.status_line` setting is untouched,
  and the row still draws when other mods publish `status` segments.
- `features: {remove: ['prevent_idle_sleep']}` (`builtins_features_v1`) takes Codex features out of the session:
  they read as off everywhere, whatever `config.toml` or `-c` sets, and they leave `/experimental`, the app-server's
  experimental feature list, `codex features list` and tips. Removing `code_mode` also removes `code_mode_only`.
  Nothing is written to `config.toml`; disabling the mod brings back the rows and the saved values. A feature that
  managed requirements pin on stays on. Keys must be Codex feature keys (`invalid_builtins` otherwise).
- `/quit`, `/exit`, `/approvals`, `/permissions`, `/status`, `/logout` and the default mode cannot be removed.
- A disabled mode is absent from `collaborationMode/list`. A thread that requests a disabled mode (`turn/start`,
  `thread/settings/update` or a recovered turn), or is still in one, is reported in the default mode. Its next turn
  runs in the default mode with the disabled mode's instructions cleared and a warning (a `warning` notification for
  app-server clients). This applies to the turn at whose boundary the mod loads too.
- The tool list is unchanged, so a thread's prompt prefix stays cacheable; a tool call allowed only in a disabled mode
  is refused (`request_user_input` without plan mode, unless the default mode may ask).

### `builtins.invoke`, key bindings and command routing

`builtins.invoke {action}` (experimental) runs a key action from user contexts. It is refused (`builtins_view_active`)
while a dialog, popup, overlay or focused mod component would take the key, and `list.*` and the permission-mode actions
are never invoked (`keymap_action_refused`).

`api.builtins({keys, commands: {replace}})` overlays key bindings (never `approval.*`) and routes a built-in
command to a mod command; the slash popup lists the built-in with that command's description and arguments.

## Composer completion (`completion_v1`)

A mod can supply the completions for `@` mentions, command arguments and tokens.

### `@` mention completion

`replace('completion')` receives each `@` mention query with up to 200 upstream candidates by default
(`completion_items` in [Host limits](limits.md#host-limits)) and returns `{items: [{path}]}` in the order to show. Paths
must be workspace-relative. When no mod registers `replace('completion')`, the upstream ranking is used. Stale
results are dropped.

### Command argument completion

While the user types arguments to a mod command (`completion_arguments_v1`), the mod that registered the command
receives `{kind: 'argument', command, query, line}` if it handles `completion` (with `api.on` or `replace`). Otherwise
the mod that registered `replace('completion')` receives it. The handler returns `{items: [{insert}]}` and the list
opens only when it has items.

Accepting an argument choice advances past a separator and keeps completion closed until the draft or cursor changes, so
the next Enter submits the command.

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

`composer.read`, `composer.write` and `composer.suggest` need `composer`.

### `composer.read`

```text
composer.read → {text, cursor, selection, revision, attachments, suggestion}
```

`cursor` and `selection` (`{start, end}` or null) are byte offsets. `revision` advances whenever the draft's text or
attachments change, whoever changed them. `suggestion` is the shown suggestion's `{owner, id}`, or null.

Each attachment has:

- a stable `id`;
- its placeholder `label`;
- its `owner` (`user` or the mod that attached it);
- an image `resource` for PNG and JPEG images up to 8 MiB, otherwise `null`. The resource is immutable, bound to the
  reading mod, its source hash and the repository, and lasts as long as the package, across configuration revisions
  and thread forks;
- the image's `width` and `height` in pixels when its header decodes.

### `composer.write`

```text
composer.write {revision, edit?, cursor?, selection?, attach?, detach?} → {text, cursor, revision}
```

| Argument | Meaning |
| --- | --- |
| `revision` | The draft revision the write applies to |
| `edit` | `{kind: 'fill' \| 'insert' \| 'append', text}` or `{kind: 'splice', start, end, text}`; `fill` replaces the draft, `insert` inserts at the cursor, and `splice` takes byte offsets on character boundaries |
| `cursor`, `selection` | Place the cursor or select `{start, end}` in the edited draft |
| `attach` | Image resources to add, as `[{image}]` |
| `detach` | Attachments to remove, by placeholder |

It returns the new draft text, cursor and revision. The complete edit, positions and detach list are validated
before the draft changes; rejected writes leave its content and attachments intact.

- Queued client calls stay bound to the thread they were accepted for, their source generation and their active
  authority, including after a confirmation.
- A write never submits.
- Images a mod attached leave the draft when that mod is unloaded, reloaded or disabled.

| Error | When |
| --- | --- |
| `stale_revision` | The draft has a newer revision |
| `composer_edit_invalid` | Another `edit.kind` |
| `composer_range_invalid` | A `splice` range is reversed or off a character boundary |
| `composer_cursor_invalid`, `composer_selection_invalid` | A position outside the edited draft or off a character boundary |
| `composer_detach_invalid` | A `detach` entry names no attachment |

```ts
const { revision } = api.host.call('composer.read', null);
api.host.call('composer.write', { revision, edit: { kind: 'insert', text: `${mention(path)} ` } });
```

That pair is from [`omd_lazygit`](../first-party/omd_lazygit/index.ts).

### `composer.suggest`

```text
composer.suggest {revision, id, text} → {shown: true}
composer.suggest {clear: true} → {cleared: true}
```

It shows one dimmed suggestion after the cursor while the cursor is at the end of that revision; a newer suggestion
replaces an older one. `id` is 1–128 bytes and `text` 1–4,096 bytes, of which the first line shows.

- The user accepts it with the move-right key at the end of the draft (so a remapped `editor.move_right` applies)
  or by clicking it, and dismisses it with Esc.
- Any draft change, a turn start, an open dialog or the owner's reload clears it.
- `{clear: true}` withdraws the caller's own.

| Error | When |
| --- | --- |
| `composer_suggest_arguments_invalid` | A missing field, or `id` or `text` outside its size |
| `composer_unavailable: a dialog is open` | A dialog, popup or other view replaces the composer |

```ts
api.host.tryCall('composer.suggest', {
  revision: draft.revision, id: `h${draft.revision}`, text: match.slice(draft.text.length),
});
```

That call is from [`ghost_history`](../examples/ghost_history/index.ts).

### `composer` event

The `composer` event (capability `composer`) reports two kinds of payload:

- `{kind: 'change', revision, attachments_revision, origin}` to every subscriber (`attachments_revision` advances
  only when the attached images change), debounced to 250 ms.
- `{kind: 'suggestion', id, status: 'accepted' | 'dismissed' | 'cleared', reason?}` to the suggestion's owner.

### `composer_edit` interceptor

A policy or redaction `composer_edit` interceptor must be `required`, because a busy optional one lets a paste or fill
through unmodified.

`api.intercept('composer_edit', …)` sees every mod write and native fill before it reaches the draft:
`{source: 'mod' | 'paste' | 'history' | 'completion', caller, revision, edit}`.

- Handlers may change only `edit.text`, or answer `{deny}`, which leaves the draft unchanged and tells the user.
- Handlers run while the terminal applies the edit, so they get no host operations and run under the
  [terminal chain budget](interceptors.md#terminal-chain-budget).
- When the budget runs out, a native fill applies unmodified with a status notice, and a mod write is refused with
  `mod_runtime_busy`.
- While a required interceptor selects `composer_edit`, a native fill is refused the same way.

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
- Each keystroke gets the [terminal chain budget](interceptors.md#terminal-chain-budget) and no host operations.
  When it runs out, or the result is invalid, the original key applies and a status notice shows.
- Use `match` on `key` so other keystrokes never start a callback.

### Submitted drafts and `prompt_expanded`

The `input` interceptors also receive the submitted draft's `revision`, `attachments` (`{kind, source}`) and
placeholder `elements` (`{kind: 'paste' | 'mention' | 'skill' | 'image', start?, end?, name?, source}`).

After skills and mentions are expanded, the experimental `prompt_expanded` event (capability `middleware`) lists them by
name, path and SHA-256 only (`{kind: 'skill' | 'mention' | 'paste' | 'image', …}`), never their content, and the
`prompt` event's `effective` is the text the model receives.

## `@` file mentions (`mention_read_v1`)

The host reads the files a prompt mentions with `@` and a mod can intercept each read.

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

Reads use the `workspace.read` checks:

- paths are repository-relative, without `..`, `.git`, backslashes or symlink components;
- the read must be allowed by both the selected turn environment's filesystem permissions and the thread's
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
