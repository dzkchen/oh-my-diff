import type { FileStat, Json, ModAPI } from '../../api.d.ts';
import { ORDER, OBSERVED_REPOSITORY_KEY, adapterFor, doc, failure, number, object, pathFromUri, rewrite, renameEdit, serializedBytes, state, string, textWorkspaceEdit, uri, fail, ok } from './protocol.ts';
import type { Answer, Item, Result, State } from './protocol.ts';
import { createClient } from './client.ts';
import { createSemantic } from './semantic.ts';

const IDLE_STOP_MS = 15 * 60_000;
const DIAGNOSTIC_WAITS = 8;
const FEEDBACK_BYTES = 4000;
const VIEW = /^\s*(?:cat|nl|head|tail|bat|less|sed\s+-n)(?:\s|$)/;
const MENTION = /[\w@+.\/-]+\.(?:pyi?|[cm]?[jt]sx?|rs|java)\b/g;
const READ_ONLY_TOOLS = new Set(['update_plan', 'view_image', 'tool_search', 'request_user_input', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource', 'list_agents', 'get_context_remaining']);
const strings = (value: Json): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const errorText = (entry: string) => entry.slice(entry.indexOf(' ') + 1);
const difference = (from: string[], minus: string[]) => {
  const counts = new Map<string, number>();
  for (const entry of minus) counts.set(errorText(entry), (counts.get(errorText(entry)) ?? 0) + 1);
  return from.filter(entry => {
    const left = counts.get(errorText(entry)) ?? 0;
    counts.set(errorText(entry), left - 1);
    return left <= 0;
  });
};
const SYMBOL_KINDS = ['file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enum member', 'struct', 'event', 'operator', 'type parameter'];
const ITEM_LIMIT = 64;
const hoverText = (value: Json): string => typeof value === 'string' ? value
  : Array.isArray(value) ? value.map(hoverText).filter(Boolean).join('\n\n')
    : object(value) && string(object(value)?.language ?? null) ? `\`\`\`${object(value)?.language}\n${string(object(value)?.value ?? null) ?? ''}\n\`\`\``
      : string(object(value)?.value ?? null) ?? '';

export default function activate(api: ModAPI) {
  const client = createClient(api);
  const { budget, stopServer, readFiles, save, announce, exchange, settle, handle, request, initialize, synchronize, observedRepository } = client;
  const { applyTextEdit, semanticEdit, semantic } = createSemantic(api, client);
  api.on('workspace_change', event => {
    const observed = event.status === 'observed' ? observedRepository(event.repository, true) : { ok: true as const, value: true };
    for (const adapter of ORDER) {
      const s = state(api.state.get(), adapter);
      if (!observed.ok || !observed.value) {
        failure(s, observed.ok ? 'repository_binding_mismatch' : observed.error, true);
        save(s);
        continue;
      }
      if (event.status === 'unavailable') {
        if (s.running || Object.keys(s.documents).length) { failure(s, event.reason ?? 'workspace_index_unavailable', true); save(s); }
        continue;
      }
      const paths = event.changes.map(change => change.path).filter(path => adapterFor(path) === adapter);
      if (!paths.length) continue;
      const previous = Object.keys(s.documents);
      const started = initialize(s, event.repository);
      if (!started.ok) { failure(s, started.error); save(s); continue; }
      const synced = synchronize(s, started.value ? [...previous, ...paths] : paths);
      if (!synced.ok) failure(s, synced.error, true);
      else { s.status = 'synced'; s.reason = ''; }
      save(s);
    }
    announce(0);
  });
  api.on('workspace_pre_rename', event => {
    const fallback = (reason: string) => ({ status: 'fallback' as const, reason });
    const adapter = adapterFor(event.old);
    if (!adapter || adapterFor(event.new) !== adapter) return fallback('unsupported_language');
    const s = state(api.state.get(), adapter);
    const started = initialize(s, event.repository);
    if (!started.ok) { failure(s, started.error); save(s); return fallback(started.error); }
    const synchronized = synchronize(s, [event.old]);
    if (!synchronized.ok) { failure(s, synchronized.error, true); save(s); return fallback(synchronized.error); }
    const provider = object(object(s.capabilities)?.workspace ?? null);
    const operations = object(provider?.fileOperations ?? null);
    if (!operations?.willRename) { save(s); return fallback('server_will_rename_unsupported'); }
    const before = readFiles([event.old, event.new]);
    if (!before.ok) { failure(s, before.error, true); save(s); return fallback(before.error); }
    if (before.value.files[event.old]?.sha256 !== event.expected[event.old] || before.value.files[event.new] !== null) { failure(s, 'rename_input_stale', true); save(s); return fallback('rename_input_stale'); }
    const response = request(s, 'workspace/willRenameFiles', { files: [{ oldUri: uri(s.repository, event.old), newUri: uri(s.repository, event.new) }] });
    if (!response.ok) { failure(s, response.error, true); save(s); return fallback(response.error); }
    const parsed = renameEdit(s.repository, event.old, event.new, response.value);
    if (!parsed.ok) { failure(s, parsed.error); save(s); return fallback(parsed.error); }
    const paths = Object.keys(parsed.value);
    if (paths.length > 126 || paths.includes(event.new)) { save(s); return fallback('server_rename_scope_invalid'); }
    const read = paths.length ? readFiles(paths) : null;
    if (read && !read.ok) { failure(s, read.error, true); save(s); return fallback(read.error); }
    const expected: Record<string, string | null> = { [event.old]: event.expected[event.old], [event.new]: null };
    const writes: Record<string, string> = {};
    for (const path of paths) {
      const file = read?.ok ? read.value.files[path] : null;
      const entry = parsed.value[path];
      const tracked = s.documents[path];
      if (!file || (tracked && tracked.sha256 !== file.sha256) || (entry.version !== null && entry.version !== tracked?.version)) { failure(s, 'server_rename_document_stale', true); save(s); return fallback('server_rename_document_stale'); }
      const updated = rewrite(file.text, entry.edits);
      if (updated === null) { save(s); return fallback('server_rename_text_edit_invalid'); }
      expected[path] = file.sha256;
      writes[path] = updated;
    }
    s.status = 'synced';
    s.reason = '';
    save(s);
    return { status: 'ready' as const, expected, writes };
  });
  const appended = (report: string[]) => {
    if (!report.length) return null;
    let text = `Language-server errors after this call:\n${report.join('\n')}`;
    while (serializedBytes(text) > FEEDBACK_BYTES) text = text.slice(0, Math.floor(text.length * 0.9));
    return { append: text };
  };
  api.on('tool_output', event => announce(appended(feedback(event))));
  const feedback = (event: { tool: string; arguments: Json; success: boolean }): string[] => {
    const report: string[] = [];
    const incomplete = (s: State, reason: string) => {
      failure(s, reason, true);
      save(s);
      report.unshift(`${s.adapter} language-server feedback incomplete: ${s.reason}`);
    };
    if (READ_ONLY_TOOLS.has(event.tool)) return report;
    const texts = strings(event.arguments);
    const viewing = event.success && event.tool !== 'apply_patch' && texts.some(text => VIEW.test(text));
    const mentioned = event.tool === 'apply_patch' || viewing ? texts.join('\n').match(MENTION) ?? [] : [];
    let observed: string | undefined;
    const work = ORDER.flatMap(adapter => {
      const s = state(api.state.get(), adapter);
      const lazy = viewing && !s.running && mentioned.some(path => adapterFor(path) === adapter);
      if (lazy && !s.repository) {
        const read = observed === undefined ? budget({ key: OBSERVED_REPOSITORY_KEY, scope: 'repository' as const }, a => api.host.tryCall('store.get', a)) : null;
        if (read) observed = read.ok ? string(object(read.value?.value ?? null)?.repository ?? null) ?? '' : '';
        s.repository = observed ?? '';
      }
      const named = mentioned.map(path => path.startsWith(`${s.repository}/`) ? path.slice(s.repository.length + 1) : path.replace(/^\.\//, '')).filter(path => adapterFor(path) === adapter && pathFromUri(s.repository, uri(s.repository, path)));
      let previous: string[] = [];
      if (lazy && s.repository && named.length) {
        const reason = s.reason;
        previous = Object.keys(s.documents);
        const started = initialize(s, s.repository);
        if (!started.ok) failure(s, started.error);
        save(s);
        if (!started.ok && reason !== s.reason) report.push(`${adapter} language server unavailable: ${s.reason}`);
      }
      const candidates = [...new Set([...Object.keys(s.documents), ...named, ...previous])].slice(0, 128);
      return s.running && s.repository && candidates.length ? [{ adapter, candidates, named }] : [];
    });
    if (!work.length) return report;
    const paths = [...new Set(work.flatMap(item => item.candidates))];
    const files: Record<string, FileStat | null> = {};
    for (let index = 0; index < paths.length; index += 128) {
      const stat = budget({ paths: paths.slice(index, index + 128), hash: true }, a => api.host.tryCall('workspace.stat', a));
      if (!stat.ok) {
        for (const { adapter } of work) incomplete(state(api.state.get(), adapter), stat.error);
        return report;
      }
      Object.assign(files, stat.value.files);
    }
    for (const { adapter, candidates, named } of work) {
      const s = state(api.state.get(), adapter);
      const changed = candidates.filter(path => files[path]?.kind === 'file' ? files[path]?.sha256 !== s.documents[path]?.sha256 : Boolean(s.documents[path]));
      if (!changed.length) continue;
      const edited = changed.filter(path => s.documents[path] && files[path]);
      const opened = viewing ? changed.filter(path => !s.documents[path] && files[path] && named.includes(path)) : [];
      const pending = exchange(s, [], 0);
      const settled = pending.ok ? settle(s, handle(s, pending.value)) : pending;
      if (!settled.ok) { incomplete(s, settled.error); continue; }
      const before = Object.fromEntries(Object.entries(s.diagnostics).map(([path, entry]) => [path, entry.errors]));
      const synced = synchronize(s, changed);
      if (!synced.ok) { incomplete(s, synced.error); continue; }
      let reason = '';
      for (let wait = 0; wait < DIAGNOSTIC_WAITS && [...edited, ...opened].some(path => !s.diagnostics[path]); wait++) {
        const batch = exchange(s, [], 250);
        const settled = batch.ok ? settle(s, handle(s, batch.value)) : batch;
        if (!settled.ok) { reason = settled.error; break; }
      }
      for (const path of new Set([...edited, ...Object.keys(s.diagnostics)])) {
        const after = s.diagnostics[path]?.errors;
        const prior = before[path] ?? (edited.includes(path) ? [] : undefined);
        if (!after || !prior || after === prior) continue;
        const introduced = difference(after, prior);
        const resolved = difference(prior, after);
        if (!introduced.length && !resolved.length) continue;
        report.push(`${path}${edited.includes(path) ? '' : ' (dependent)'}: ${introduced.length} new, ${resolved.length} resolved`, ...introduced.slice(0, 8).map(entry => `  + ${entry}`), ...resolved.slice(0, 8).map(entry => `  - ${entry}`));
      }
      for (const path of opened) {
        const errors = s.diagnostics[path]?.errors;
        if (errors?.length) report.push(`${path}: ${errors.length} existing (v${s.documents[path].version})`, ...errors.slice(0, 8).map(entry => `  ${entry}`));
      }
      if (reason || [...edited, ...opened].some(path => !s.diagnostics[path])) {
        incomplete(s, reason || 'diagnostics_pending');
        continue;
      }
      s.status = 'synced';
      s.reason = '';
      save(s);
    }
    return report;
  };
  api.on('turn_start', () => {
    for (const adapter of ORDER) {
      const s = state(api.state.get(), adapter);
      const paths = Object.keys(s.documents);
      if (!paths.length || !s.repository) continue;
      const started = initialize(s, s.repository);
      if (!started.ok) { failure(s, started.error); save(s); continue; }
      const synced = synchronize(s, paths);
      if (!synced.ok) failure(s, synced.error, true);
      else {
        const pending = exchange(s, [], 150);
        const settled = pending.ok ? settle(s, handle(s, pending.value)) : pending;
        if (!settled.ok) failure(s, settled.error, true);
        else if (synced.value || started.value) { s.status = 'synced'; s.reason = 'external_change_resynchronized'; }
      }
      save(s);
    }
    announce(0);
  });
  api.on('idle', () => {
    for (const adapter of ORDER) {
      const s = state(api.state.get(), adapter);
      if (!s.running) continue;
      const status = budget({ session: s.adapter }, a => api.host.tryCall('process.status', a));
      if (status.ok && status.value.idle_ms < IDLE_STOP_MS) continue;
      if (status.ok) stopServer(s);
      s.running = false;
      s.status = 'idle';
      save(s);
    }
    announce(0);
  });
  api.on('stop', () => {
    for (const adapter of ORDER) {
      const s = state(api.state.get(), adapter);
      if (s.running) stopServer(s);
    }
  });
  const prepare = (s: State, path: string, provider: string | null): Result<{ text: string; sha256: string }> => {
    const started = initialize(s, s.repository);
    if (!started.ok) return started;
    const synced = synchronize(s, [path]);
    if (!synced.ok) return synced;
    const capability = provider && object(s.capabilities)?.[provider];
    if (provider && capability !== true && !object(capability ?? null)) return fail(`server_${provider}_unsupported`);
    const read = readFiles([path]);
    if (!read.ok) return read;
    const source = read.value.files[path];
    return source && source.sha256 === s.documents[path]?.sha256 ? ok(source) : fail('source_stale');
  };
  const confirm = (title: string, message: string) => {
    const answer = api.host.tryCall('terminal.prompt', { kind: 'confirm', title, message });
    return answer.ok && answer.value.status === 'accepted';
  };
  const errors = (s: State, first: string | null): Item[] => Object.entries(s.diagnostics)
    .sort(([a], [b]) => Number(b === first) - Number(a === first) || a.localeCompare(b))
    .flatMap(([path, entry]) => entry.errors.map(error => ({ label: `${path}:${error}`, value: `${path}:${error.split(':')[0]}` })));
  const run = (data: Record<string, Json>): Answer => {
    const op = string(data.op ?? null) ?? '';
    const path = string(data.path ?? null) ?? '';
    const position = { line: (number(data.line ?? null) ?? 1) - 1, character: (number(data.character ?? null) ?? 1) - 1 };
    const failed = (reason: string): Answer => ({ status: 'error', message: reason.replace(/_/g, ' '), items: [], text: null, action: 'open' });
    const done = (items: Item[], text: string | null = null, action: Answer['action'] = 'open'): Answer =>
      ({ status: 'ready', items: items.slice(0, ITEM_LIMIT), text, action, message: text || items.length ? '' : 'No results' });
    if (op === 'workspace' || (op === 'diagnostics' && !path)) {
      const items: Item[] = [];
      for (const adapter of ORDER) {
        const s = state(api.state.get(), adapter);
        if (op === 'diagnostics') items.push(...errors(s, null));
        else if (s.running && s.repository && initialize(s, s.repository).ok) {
          const found = request(s, 'workspace/symbol', { query: string(data.query ?? null) ?? '' });
          save(s);
          for (const entry of found.ok && Array.isArray(found.value) ? found.value : []) {
            const symbol = object(entry);
            const location = object(symbol?.location ?? null);
            const where = string(location?.uri ?? null) && pathFromUri(s.repository, String(location?.uri));
            const line = number(object(object(location?.range ?? null)?.start ?? null)?.line ?? null) ?? 0;
            if (where && string(symbol?.name ?? null)) items.push({ label: `${SYMBOL_KINDS[(number(symbol?.kind ?? null) ?? 1) - 1] ?? 'symbol'} ${symbol?.name} · ${where}:${line + 1}`, value: `${where}:${line + 1}` });
          }
        }
      }
      return op === 'workspace' && !ORDER.some(adapter => state(api.state.get(), adapter).running) ? failed('no language server is running yet; open or edit a supported file first') : done(items);
    }
    const adapter = adapterFor(path);
    if (!adapter || !pathFromUri('/repository', uri('/repository', path))) return failed(`${path || 'this file'} has no supported language server`);
    const s = state(api.state.get(), adapter);
    if (!s.repository) {
      const root = budget({ program: 'pwd', timeout_ms: 5_000 }, a => api.host.tryCall('exec.run', a));
      const repository = root.ok && root.value.exit_code === 0 ? root.value.stdout.trim() : '';
      const observed = repository ? observedRepository(repository, true) : { ok: false as const, error: 'repository_unavailable' };
      if (!observed.ok || !observed.value) return failed(observed.ok ? 'repository_binding_mismatch' : observed.error);
      s.repository = repository;
      save(s);
    }
    if (op === 'definition' || op === 'references') {
      const result = object(semantic(op, { path, ...position, include_declaration: true }));
      if (result?.status !== 'ready') return failed(string(result?.reason ?? null) ?? 'server_unavailable');
      return done((Array.isArray(result.locations) ? result.locations : []).map(entry => {
        const location = object(entry);
        const start = object(object(location?.range ?? null)?.start ?? null);
        const where = `${location?.path}:${Number(start?.line ?? 0) + 1}`;
        return { label: `${where}:${Number(start?.character ?? 0) + 1}`, value: where };
      }));
    }
    const provider = { hover: 'hoverProvider', symbols: 'documentSymbolProvider', format: 'documentFormattingProvider', actions: null, diagnostics: null, apply: null }[op];
    if (provider === undefined) return failed(`unknown request ${op}`);
    const source = prepare(s, path, provider);
    if (!source.ok) {
      failure(s, source.error, true);
      save(s);
      return failed(source.error);
    }
    const document = doc(s, path);
    if (op === 'hover') {
      const hover = request(s, 'textDocument/hover', { ...document, position });
      save(s);
      return hover.ok ? done([], hoverText(object(hover.value)?.contents ?? null).slice(0, 12_000) || 'No hover information here') : failed(hover.error);
    }
    if (op === 'symbols') {
      const listed = request(s, 'textDocument/documentSymbol', document);
      save(s);
      if (!listed.ok) return failed(listed.error);
      const items: Item[] = [];
      const walk = (entries: Json, depth: number) => {
        for (const entry of Array.isArray(entries) ? entries : []) {
          const symbol = object(entry);
          const range = object(symbol?.selectionRange ?? symbol?.range ?? object(symbol?.location ?? null)?.range ?? null);
          const line = (number(object(range?.start ?? null)?.line ?? null) ?? 0) + 1;
          if (symbol && items.length < ITEM_LIMIT) items.push({ label: `${'  '.repeat(depth)}${SYMBOL_KINDS[(number(symbol.kind ?? null) ?? 1) - 1] ?? 'symbol'} ${symbol.name} · ${line}`, value: `${path}:${line}` });
          walk(symbol?.children ?? null, depth + 1);
        }
      };
      walk(listed.value, 0);
      return done(items);
    }
    if (op === 'diagnostics') {
      for (let wait = 0; wait < 4 && !s.diagnostics[path]; wait++) {
        const batch = exchange(s, [], 250);
        if (!batch.ok || !settle(s, handle(s, batch.value)).ok) break;
      }
      save(s);
      return done(errors(s, path));
    }
    if (op === 'actions') {
      const text = source.value.text.split('\n')[position.line] ?? '';
      const result = object(semantic('code_actions', { path, range: { start: { line: position.line, character: 0 }, end: { line: position.line, character: text.length } } }));
      if (result?.status !== 'ready') return failed(string(result?.reason ?? null) ?? 'server_unavailable');
      const actions = (Array.isArray(result.actions) ? result.actions : []).map(item => object(item));
      return done(actions.map((action, index) => ({ label: `${action?.title}${action?.has_edit ? '' : ' (runs a server command; unsupported)'}`, value: `${index}:${path}` })), null, 'apply');
    }
    if (op === 'apply') {
      const index = number(data.index ?? null) ?? -1;
      const preview = s.preview;
      const action = preview?.path === path && preview.actions[index] ? object(JSON.parse(preview.actions[index]) as Json) : null;
      if (!action) return failed('list the code actions again');
      if (action.edit === undefined || action.command !== undefined) return failed('only actions that are plain text edits can be applied');
      const edit = textWorkspaceEdit(s.repository, action.edit);
      if (!edit.ok) return failed(edit.error);
      const scope = Object.keys(edit.value);
      const stat = budget({ paths: scope, hash: true }, a => api.host.tryCall('workspace.stat', a));
      if (!stat.ok) return failed(stat.error);
      const expected = Object.fromEntries(scope.map(name => [name, stat.value.files[name]?.sha256 ?? '']));
      if (!confirm('Apply code action', `${action.title}\nChanges ${scope.join(', ')}`)) return done([], 'Cancelled');
      const applied = object(semanticEdit('apply_code_action', { path, source_sha256: source.value.sha256, range: preview?.range ?? null, action_index: index, title: action.title ?? null, scope, expected }));
      return applied?.status === 'applied' ? done([], `Applied: ${action.title}`) : failed(string(applied?.reason ?? null) ?? 'apply_failed');
    }
    const formatted = request(s, 'textDocument/formatting', { ...document, options: { tabSize: adapter === 'typescript' ? 2 : 4, insertSpaces: true } });
    if (!formatted.ok) {
      save(s);
      return failed(formatted.error);
    }
    const edits = Array.isArray(formatted.value) ? formatted.value : [];
    if (!edits.length || rewrite(source.value.text, edits) === source.value.text) {
      save(s);
      return done([], `${path} is already formatted`);
    }
    if (!confirm('Format file', `Apply ${edits.length} formatting edits to ${path}`)) {
      save(s);
      return done([], 'Cancelled');
    }
    const applied = object(applyTextEdit(s, [path], { [path]: source.value.sha256 }, { changes: { [uri(s.repository, path)]: edits } }));
    return applied?.status === 'applied' ? done([], `Formatted ${path}`) : failed(string(applied?.reason ?? null) ?? 'format_failed');
  };
  api.provide({ name: 'omd.lsp', version: '1.0.0', methods: { query: { input: 'object', output: 'object' } } }, { query: input => announce(run(object(input) ?? {})) as unknown as Json });
  const pathProperty = { type: 'string' };
  const positionProperties = { path: pathProperty, line: { type: 'integer', minimum: 0 }, character: { type: 'integer', minimum: 0 } };
  const pointProperty = { type: 'object', properties: { line: { type: 'integer', minimum: 0 }, character: { type: 'integer', minimum: 0 } }, required: ['line', 'character'], additionalProperties: false };
  const rangeProperty = { type: 'object', properties: { start: pointProperty, end: pointProperty }, required: ['start', 'end'], additionalProperties: false };
  const editProperties = { path: pathProperty, source_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' }, scope: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 16 }, expected: { type: 'object', additionalProperties: { type: 'string', pattern: '^[0-9a-f]{64}$' } } };
  api.tool({ name: 'definition', description: 'Find a definition in an observed repository; return checked local locations or explicit fallback.', parameters: { type: 'object', properties: positionProperties, required: ['path', 'line', 'character'], additionalProperties: false } }, value => semantic('definition', value));
  api.tool({ name: 'references', description: 'Find references in an observed repository; return checked local locations or explicit fallback.', parameters: { type: 'object', properties: { ...positionProperties, include_declaration: { type: 'boolean' } }, required: ['path', 'line', 'character'], additionalProperties: false } }, value => semantic('references', value));
  api.tool({ name: 'code_actions', description: 'List server code actions for a checked range; commands remain unsupported.', parameters: { type: 'object', properties: { path: pathProperty, range: rangeProperty }, required: ['path', 'range'], additionalProperties: false } }, value => semantic('code_actions', value));
  api.tool({ name: 'rename_symbol', description: 'Apply an exact-scope server symbol rename with a backup and conditional rollback.', parameters: { type: 'object', properties: { ...editProperties, line: pointProperty.properties.line, character: pointProperty.properties.character, new_name: { type: 'string', minLength: 1, maxLength: 512 } }, required: ['path', 'source_sha256', 'line', 'character', 'new_name', 'scope', 'expected'], additionalProperties: false } }, value => semanticEdit('rename_symbol', value));
  api.tool({ name: 'apply_code_action', description: 'Requery and apply an exact-scope text-only code action with a backup and conditional rollback.', parameters: { type: 'object', properties: { ...editProperties, range: rangeProperty, action_index: { type: 'integer', minimum: 0, maximum: 31 }, title: { type: 'string' } }, required: ['path', 'source_sha256', 'range', 'action_index', 'title', 'scope', 'expected'], additionalProperties: false } }, value => semanticEdit('apply_code_action', value));
  api.tool({
    name: 'status',
    description: 'Show opt-in language server synchronization status and explicit fallback reasons.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  }, () => {
    return { adapters: Object.fromEntries(ORDER.map(adapter => {
      const s = state(api.state.get(), adapter);
      return [adapter, { status: s.status, reason: s.reason, repository: s.repository, documents: Object.keys(s.documents).length, diagnostics: s.diagnostics, server: s.running ? s.server : null }];
    })) };
  });
  api.tool({
    name: 'rename_file',
    description: 'Request an exact-scope file rename after the selected mod supplies any server edits.',
    parameters: { type: 'object', properties: { old: { type: 'string' }, new: { type: 'string' } }, required: ['old', 'new'], additionalProperties: false },
  }, value => {
    const input = object(value);
    const old = input && string(input.old);
    const next = input && string(input.new);
    if (!old || !next) throw new Error('rename_paths_required');
    return api.host.call('workspace.request_rename', { old, new: next });
  });
}
