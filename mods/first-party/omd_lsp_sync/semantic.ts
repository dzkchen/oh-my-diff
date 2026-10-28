import type { Json, ModAPI } from '../../api.d.ts';
import { adapterFor, checkedRange, doc, failure, linesOf, number, object, offset, pathFromUri, rewrite, serializedBytes, state, string, markSynced, textWorkspaceEdit, uri } from './protocol.ts';
import type { State } from './protocol.ts';
import type { Client } from './client.ts';

export function createSemantic(api: ModAPI, client: Client) {
  const { budget, readFiles, save, request, initialize, synchronize, observedRepository, currentThread } = client;
  const fallbackFor = (s: State) => (reason: string, stale = false): Json => {
    failure(s, reason, stale); save(s);
    return { status: 'fallback', reason, adapter: s.adapter };
  };
  const applyTextEdit = (s: State, scope: string[], expected: Record<string, string>, response: Json): Json => {
    const fallback = fallbackFor(s);
    const parsed = textWorkspaceEdit(s.repository, response);
    if (!parsed.ok) return fallback(parsed.error);
    const paths = Object.keys(parsed.value);
    if (paths.length !== scope.length || paths.some(path => !scope.includes(path))) return fallback('server_edit_scope_mismatch');
    const read = readFiles(scope);
    if (!read.ok) return fallback(read.error, true);
    const writes: Record<string, string> = {};
    for (const path of scope) {
      const file = read.value.files[path];
      const tracked = s.documents[path];
      const target = parsed.value[path];
      if (!file || file.sha256 !== expected[path] || tracked?.sha256 !== file.sha256 || (target.version !== null && target.version !== tracked.version)) return fallback('server_edit_stale', true);
      const updated = rewrite(file.text, target.edits);
      if (updated === null || updated === file.text) return fallback('server_edit_invalid_or_empty');
      writes[path] = updated;
    }
    if (serializedBytes({ expected, writes }) > 60_000) return fallback('server_edit_size_limit');
    const backup = budget({ expected }, a => api.host.tryCall('workspace.backup', a));
    if (!backup.ok) return fallback(backup.error, true);
    const applied = budget({ expected, writes }, a => api.host.tryCall('workspace.transaction', a));
    if (!applied.ok) return fallback(applied.error, true);
    const after = applied.value.files;
    const rollback = (reason: string) => {
      const restored = api.host.tryCall('workspace.restore', { backup: backup.value.backup, expected: after });
      api.host.tryCall('process.stop', { session: s.adapter });
      s.running = false; s.documents = {}; s.diagnostics = {};
      return fallback(restored.ok ? `${reason}_rolled_back` : `rollback_failed:${restored.error}`, true);
    };
    if (Object.keys(after).length !== scope.length || scope.some(path => !after[path])) return rollback('transaction_result_invalid');
    if (!synchronize(s, scope).ok) return rollback('sync_failed');
    s.preview = null;
    markSynced(s);
    save(s);
    return { status: 'applied', adapter: s.adapter, files: after };
  };
  const semanticEdit = (kind: 'rename_symbol' | 'apply_code_action', value: Json): Json => {
    const input = object(value);
    const path = string(input?.path ?? null);
    const adapter = path && adapterFor(path);
    if (!path || !adapter || !pathFromUri('/repository', uri('/repository', path))) return { status: 'fallback', reason: 'unsupported_or_invalid_path' };
    const s = state(api.state.get(), adapter);
    const fallback = fallbackFor(s);
    const rawScope = input?.scope;
    const declared = object(input?.expected ?? null);
    if (!Array.isArray(rawScope) || !rawScope.length || rawScope.length > 16 || !rawScope.every(item => typeof item === 'string') || !declared) return fallback('edit_scope_invalid');
    const scope = rawScope as string[];
    if (new Set(scope).size !== scope.length || Object.keys(declared).length !== scope.length || scope.some(name => adapterFor(name) !== adapter || !pathFromUri('/repository', uri('/repository', name)) || !/^[0-9a-f]{64}$/.test(string(declared[name] ?? null) ?? ''))) return fallback('edit_scope_invalid');
    const expected = declared as Record<string, string>;
    if (!s.repository) return fallback('repository_unobserved');
    const observed = observedRepository(s.repository, false);
    if (!observed.ok || !observed.value) return fallback(observed.ok ? 'repository_binding_mismatch' : observed.error, true);
    const started = initialize(s, s.repository);
    if (!started.ok) return fallback(started.error);
    const synced = synchronize(s, [...new Set([path, ...scope])]);
    if (!synced.ok) return fallback(synced.error, true);
    const source = readFiles([path]);
    if (!source.ok) return fallback(source.error, true);
    const file = source.value.files[path];
    if (!file || file.sha256 !== s.documents[path]?.sha256 || file.sha256 !== input?.source_sha256) return fallback('source_stale', true);
    if (kind === 'rename_symbol') {
      const name = string(input?.new_name ?? null);
      const position = { line: number(input?.line ?? null), character: number(input?.character ?? null) };
      if (!name || name.length > 512 || offset(file.text, linesOf(file.text), position as Json) === null) return fallback('rename_input_invalid');
      const capability = object(s.capabilities)?.renameProvider;
      if (capability !== true && !object(capability ?? null)) return fallback('server_rename_symbol_unsupported');
      const params = { ...doc(s, path), position };
      if (object(capability ?? null)?.prepareProvider === true) {
        const prepared = request(s, 'textDocument/prepareRename', params);
        if (!prepared.ok) return fallback(prepared.error, true);
        if (prepared.value === null) return fallback('server_rename_rejected');
      }
      const proposed = request(s, 'textDocument/rename', { ...params, newName: name });
      if (!proposed.ok) return fallback(proposed.error, true);
      return applyTextEdit(s, scope, expected, proposed.value);
    }
    const capability = object(s.capabilities)?.codeActionProvider;
    if (capability !== true && !object(capability ?? null)) return fallback('server_code_actions_unsupported');
    const range = checkedRange(file.text, input?.range ?? null);
    const index = number(input?.action_index ?? null);
    if (!range || index === null || index < 0 || index >= 32) return fallback('code_action_input_invalid');
    const preview = s.preview;
    if (!preview || preview.path !== path || preview.source_sha256 !== file.sha256 || preview.source_version !== s.documents[path].version || JSON.stringify(preview.range) !== JSON.stringify(range)) return fallback('code_action_preview_required');
    const thread = currentThread();
    if (!thread.ok) return fallback(thread.error, true);
    if (thread.value !== preview.thread_id) return fallback('code_action_preview_thread_mismatch');
    const actions = request(s, 'textDocument/codeAction', { ...doc(s, path), range, context: { diagnostics: [] } });
    if (!actions.ok) return fallback(actions.error, true);
    if (!Array.isArray(actions.value) || actions.value.length > 32 || index >= actions.value.length) return fallback('server_code_actions_invalid');
    if (preview.actions[index] !== JSON.stringify(actions.value[index])) return fallback('code_action_preview_stale');
    const action = object(actions.value[index]);
    if (!action || action.title !== input?.title || action.disabled !== undefined || action.command !== undefined) return fallback('server_code_action_unsupported');
    if (action.edit === undefined) return fallback('server_code_action_deferred_unsupported');
    return applyTextEdit(s, scope, expected, action.edit);
  };
  const semantic = (kind: 'definition' | 'references' | 'code_actions', value: Json): Json => {
    const input = object(value);
    const path = string(input?.path ?? null);
    const adapter = path && adapterFor(path);
    if (!path || !adapter || !pathFromUri('/repository', uri('/repository', path))) return { status: 'fallback', reason: 'unsupported_or_invalid_path' };
    const s = state(api.state.get(), adapter);
    const fallback = fallbackFor(s);
    if (!s.repository) return fallback('repository_unobserved');
    const observed = observedRepository(s.repository, false);
    if (!observed.ok || !observed.value) return fallback(observed.ok ? 'repository_binding_mismatch' : observed.error, true);
    const started = initialize(s, s.repository);
    if (!started.ok) return fallback(started.error);
    const synced = synchronize(s, [path]);
    if (!synced.ok) return fallback(synced.error, true);
    const capability = object(s.capabilities)?.[kind === 'definition' ? 'definitionProvider' : kind === 'references' ? 'referencesProvider' : 'codeActionProvider'];
    if (capability !== true && !object(capability ?? null)) return fallback(`server_${kind}_unsupported`);
    const before = readFiles([path]);
    if (!before.ok) return fallback(before.error, true);
    const source = before.value.files[path];
    if (!source || source.sha256 !== s.documents[path]?.sha256) return fallback('source_stale', true);
    const lines = linesOf(source.text);
    const position = { line: number(input?.line ?? null), character: number(input?.character ?? null) };
    let range: ReturnType<typeof checkedRange> = null;
    if (kind === 'code_actions') {
      range = checkedRange(source.text, input?.range ?? null);
      if (!range) return fallback('invalid_range');
    } else if (offset(source.text, lines, position as Json) === null) return fallback('invalid_position');
    const params: Json = kind === 'code_actions'
      ? { ...doc(s, path), range, context: { diagnostics: [] } }
      : kind === 'references'
        ? { ...doc(s, path), position, context: { includeDeclaration: input?.include_declaration === true } }
        : { ...doc(s, path), position };
    const method = kind === 'code_actions' ? 'textDocument/codeAction' : kind === 'references' ? 'textDocument/references' : 'textDocument/definition';
    const response = request(s, method, params);
    if (!response.ok) return fallback(response.error, true);
    if (kind === 'code_actions') {
      const actions = response.value === null ? [] : response.value;
      if (!Array.isArray(actions) || actions.length > 32) return fallback('server_code_actions_invalid');
      const listed: { title: string; kind: string | null; has_edit: boolean; has_command: boolean; disabled: boolean }[] = [];
      for (const item of actions) {
        const action = object(item);
        const title = string(action?.title ?? null);
        const actionKind = string(action?.kind ?? null);
        if (!title || title.length > 512 || (action?.kind !== undefined && (!actionKind || actionKind.length > 128))) return fallback('server_code_actions_invalid');
        listed.push({ title, kind: actionKind, has_edit: action?.edit !== undefined, has_command: action?.command !== undefined, disabled: action?.disabled !== undefined });
      }
      const after = readFiles([path]);
      if (!after.ok || after.value.files[path]?.sha256 !== source.sha256) return fallback('source_stale', true);
      const result = { status: 'ready', adapter, path, source_sha256: source.sha256, source_version: s.documents[path].version, actions: listed, application: 'exact_scope_text_edits_only' };
      if (serializedBytes(result) > 32_768) return fallback('server_code_actions_output_limit');
      const previewActions = actions.map(item => JSON.stringify(item));
      const thread = previewActions.length && serializedBytes(previewActions) <= 16_384 ? currentThread() : null;
      if (thread && !thread.ok) return fallback(thread.error, true);
      s.preview = previewActions.length > 0 && serializedBytes(previewActions) <= 16_384 && thread?.ok
        ? { path, source_sha256: source.sha256, source_version: s.documents[path].version, thread_id: thread?.ok ? thread.value : '', range, actions: previewActions }
        : null;
      markSynced(s); save(s);
      return { ...result, application: s.preview ? result.application : 'preview_too_large' };
    }
    const raw = response.value === null ? [] : Array.isArray(response.value) ? response.value : [response.value];
    if (raw.length > 32) return fallback('server_locations_limit');
    const targets: { path: string; range: Json }[] = [];
    for (const item of raw) {
      const location = object(item);
      const targetUri = string(location?.targetUri ?? location?.uri ?? null);
      const target = targetUri && pathFromUri(s.repository, targetUri);
      const targetRange = location?.targetSelectionRange ?? location?.range ?? null;
      if (!target || target.length > 240 || !object(targetRange ?? null)) return fallback('server_location_invalid');
      if (location?.targetRange !== undefined && !object(location.targetRange)) return fallback('server_location_invalid');
      targets.push({ path: target, range: targetRange });
    }
    const names = [...new Set([path, ...targets.map(target => target.path)])];
    const files: Record<string, { text: string; sha256: string } | null> = {};
    for (let index = 0; index < names.length; index += 16) {
      const read = readFiles(names.slice(index, index + 16));
      if (!read.ok) return fallback(read.error, true);
      Object.assign(files, read.value.files);
    }
    if (files[path]?.sha256 !== source.sha256) return fallback('source_stale', true);
    const unopened = names.filter(name => files[name] && !s.documents[name]);
    if (unopened.length) {
      const opened = synchronize(s, [path, ...unopened]);
      if (!opened.ok) return fallback(opened.error, true);
    }
    if (s.documents[path]?.sha256 !== source.sha256) return fallback('source_stale', true);
    const locations: { path: string; range: ReturnType<typeof checkedRange>; sha256: string }[] = [];
    for (const target of targets) {
      const file = files[target.path];
      const selected = file && checkedRange(file.text, target.range);
      if (!file || !selected) return fallback('server_location_stale_or_invalid', true);
      if (!s.documents[target.path] || s.documents[target.path].sha256 !== file.sha256) return fallback('server_location_unobserved_or_stale', true);
      locations.push({ path: target.path, range: selected, sha256: file.sha256 });
    }
    markSynced(s); save(s);
    const result = { status: 'ready', adapter, path, source_sha256: source.sha256, source_version: s.documents[path].version, locations };
    return serializedBytes(result) > 32_768 ? fallback('server_locations_output_limit') : result;
  };
  return { applyTextEdit, semanticEdit, semantic };
}
