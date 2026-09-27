import type { Json, ModAPI } from '../../api.d.ts';

type Document = { sha256: string; version: number };
type Diagnostic = { count: number; version: number | null };
type State = {
  repository: string;
  running: boolean;
  next_id: number;
  capabilities: Json;
  documents: Record<string, Document>;
  diagnostics: Record<string, Diagnostic>;
  status: 'idle' | 'synced' | 'fallback' | 'stale';
  reason: string;
};
type Message = Record<string, Json>;
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const session = 'python';
const supported = (path: string) => path.length <= 240 && /\.pyi?$/.test(path);
const object = (value: Json): Record<string, Json> | null => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const string = (value: Json): string | null => typeof value === 'string' ? value : null;
const number = (value: Json): number | null => typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
const message = (value: Json): Message | null => object(value);
const fileUri = (path: string) => `file://${path.split('/').map(encodeURIComponent).join('/')}`;
const uri = (repository: string, path: string) => fileUri(`${repository}/${path}`);
const pathFromUri = (repository: string, value: string): string | null => {
  if (!value.startsWith('file://')) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(value.slice(7)); } catch { return null; }
  const prefix = `${repository}/`;
  if (!decoded.startsWith(prefix)) return null;
  const path = decoded.slice(prefix.length);
  return path && !path.split('/').some(part => !part || part === '.' || part === '..' || part === '.git') ? path : null;
};

function offset(text: string, lines: number[], position: Json): number | null {
  const point = object(position);
  const line = number(point?.line ?? null);
  const character = number(point?.character ?? null);
  if (line === null || character === null || line < 0 || character < 0 || line >= lines.length) return null;
  const start = lines[line];
  const end = line + 1 < lines.length ? lines[line + 1] - 1 : text.length;
  const width = end - start;
  if (character > width) return null;
  const index = start + character;
  if (index > start && index < text.length) {
    const previous = text.charCodeAt(index - 1);
    const following = text.charCodeAt(index);
    if (previous >= 0xd800 && previous <= 0xdbff && following >= 0xdc00 && following <= 0xdfff) return null;
  }
  return index;
}

function rewrite(text: string, edits: Json[]): string | null {
  const ranges: { start: number; end: number; value: string }[] = [];
  const lines = [0];
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) lines.push(index + 1);
  for (const entry of edits) {
    const edit = object(entry);
    const range = object(edit?.range ?? null);
    const start = offset(text, lines, range?.start ?? null);
    const end = offset(text, lines, range?.end ?? null);
    const value = string(edit?.newText ?? null);
    if (start === null || end === null || start > end || value === null) return null;
    ranges.push({ start, end, value });
  }
  ranges.sort((a, b) => b.start - a.start || b.end - a.end);
  for (let index = 1; index < ranges.length; index++) if (ranges[index].end > ranges[index - 1].start || ranges[index].start === ranges[index - 1].start) return null;
  let result = text;
  for (const range of ranges) result = result.slice(0, range.start) + range.value + result.slice(range.end);
  return result;
}

function renameEdit(repository: string, old: string, next: string, response: Json): Result<Record<string, { version: number | null; edits: Json[] }>> {
  if (response === null) return { ok: true, value: {} };
  const edit = object(response);
  if (!edit || (edit.changeAnnotations !== undefined && Object.keys(object(edit.changeAnnotations) ?? {}).length)) return { ok: false, error: 'server_rename_edit_unsupported' };
  const grouped: Record<string, { version: number | null; edits: Json[] }> = {};
  if (edit.changes !== undefined) {
    const changes = object(edit.changes);
    if (!changes) return { ok: false, error: 'server_rename_changes_invalid' };
    for (const [name, edits] of Object.entries(changes)) {
      const path = pathFromUri(repository, name);
      if (!path || !Array.isArray(edits) || grouped[path]) return { ok: false, error: 'server_rename_scope_invalid' };
      grouped[path] = { version: null, edits };
    }
  }
  if (edit.documentChanges !== undefined) {
    if (!Array.isArray(edit.documentChanges) || edit.changes !== undefined) return { ok: false, error: 'server_rename_changes_conflict' };
    for (const entry of edit.documentChanges) {
      const change = object(entry);
      if (!change) return { ok: false, error: 'server_rename_change_invalid' };
      if (change.kind === 'rename') {
        if (change.oldUri !== uri(repository, old) || change.newUri !== uri(repository, next)) return { ok: false, error: 'server_rename_extra_file_operation' };
        continue;
      }
      if (change.kind !== undefined) return { ok: false, error: 'server_rename_extra_file_operation' };
      const target = object(change.textDocument ?? null);
      const path = target && string(target.uri) ? pathFromUri(repository, String(target.uri)) : null;
      const version = number(target?.version ?? null);
      if (!path || !Array.isArray(change.edits) || grouped[path] || (target?.version !== null && target?.version !== undefined && version === null)) return { ok: false, error: 'server_rename_document_invalid' };
      grouped[path] = { version, edits: change.edits };
    }
  }
  if (edit.changes === undefined && edit.documentChanges === undefined) return { ok: false, error: 'server_rename_edit_missing' };
  return { ok: true, value: grouped };
}

function state(value: Json): State {
  const saved = object(value) ?? {};
  const documents: Record<string, Document> = {};
  for (const [path, entry] of Object.entries(object(saved.documents ?? null) ?? {})) {
    const data = object(entry);
    if (data && string(data.sha256) && number(data.version) !== null) documents[path] = { sha256: String(data.sha256), version: Number(data.version) };
  }
  const diagnostics: Record<string, Diagnostic> = {};
  for (const [path, entry] of Object.entries(object(saved.diagnostics ?? null) ?? {})) {
    const data = object(entry);
    if (data && number(data.count) !== null) diagnostics[path] = { count: Number(data.count), version: number(data.version) };
  }
  return {
    repository: string(saved.repository ?? null) ?? '',
    running: saved.running === true,
    next_id: number(saved.next_id ?? null) ?? 1,
    capabilities: saved.capabilities ?? null,
    documents,
    diagnostics,
    status: saved.status === 'synced' || saved.status === 'stale' || saved.status === 'fallback' ? saved.status : 'idle',
    reason: string(saved.reason ?? null) ?? '',
  };
}

function failure(s: State, reason: string, stale = false): void {
  s.status = stale ? 'stale' : 'fallback';
  s.reason = reason.slice(0, 256);
}

const CALL_BUDGET = 28;
const BYTE_BUDGET = 96_000;
const SILENT_WAITS = 10;
const IDLE_STOP_MS = 15 * 60_000;
const size = (value: unknown) => {
  const text = JSON.stringify(value) ?? '';
  let bytes = 96;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdfff ? 2 : 3;
  }
  return bytes;
};

export default function activate(api: ModAPI) {
  let calls = 0;
  let spent = 0;
  const budget = <A, T>(argument: A, call: (argument: A) => Result<T>): Result<T> => {
    const cost = size(argument);
    if (calls >= CALL_BUDGET || spent + cost > BYTE_BUDGET) return { ok: false, error: 'callback_budget' };
    calls++;
    const result = call(argument);
    spent += cost + size(result);
    return result;
  };
  const stopServer = () => budget({ session }, argument => api.host.tryCall('process.stop', argument));
  const save = (s: State) => api.state.set(s as unknown as Json);
  const exchange = (outgoing: Json[], wait_ms: number): Result<Message[]> => {
    const result = budget({ session, send: outgoing, wait_ms }, argument => api.host.tryCall('process.exchange', argument));
    if (!result.ok) return result;
    const messages = result.value.messages.map(message);
    return messages.every(Boolean) ? { ok: true, value: messages as Message[] } : { ok: false, error: 'invalid_server_message' };
  };
  const replies = (messages: Message[]): Message[] => messages.flatMap(item => {
    if (!('id' in item) || typeof item.method !== 'string') return [];
    const result: Json = item.method === 'workspace/configuration'
      ? Array.isArray(object(item.params ?? null)?.items) ? (object(item.params ?? null)?.items as Json[]).map(() => null) : []
      : item.method === 'workspace/applyEdit' ? { applied: false } : null;
    return [{ jsonrpc: '2.0', id: item.id, result }];
  });
  const diagnostics = (s: State, messages: Message[]) => {
    for (const item of messages) {
      if (item.method !== 'textDocument/publishDiagnostics') continue;
      const params = object(item.params ?? null);
      const path = params && string(params.uri) ? pathFromUri(s.repository, String(params.uri)) : null;
      if (!path || !s.documents[path]) continue;
      const version = number(params?.version ?? null);
      if (version !== null && version !== s.documents[path].version) continue;
      const entries = params?.diagnostics;
      if (Array.isArray(entries)) s.diagnostics[path] = { count: entries.length, version };
    }
  };
  const handle = (s: State, messages: Message[]): Message[] => {
    diagnostics(s, messages);
    return replies(messages);
  };
  const settle = (s: State, pending: Json[]): Result<true> => {
    let outgoing: Json[] = pending;
    while (outgoing.length) {
      const answered = exchange(outgoing, 0);
      if (!answered.ok) return answered;
      outgoing = handle(s, answered.value);
    }
    return { ok: true, value: true };
  };
  const request = (s: State, method: string, params: Json): Result<Json> => {
    const id = s.next_id++;
    let outgoing: Json[] = [{ jsonrpc: '2.0', id, method, params }];
    for (let silent = 0; silent < SILENT_WAITS;) {
      const batch = exchange(outgoing, 1000);
      if (!batch.ok) return batch;
      if (!batch.value.length) silent++;
      outgoing = handle(s, batch.value);
      const found = batch.value.find(item => item.id === id && !('method' in item));
      if (found) {
        const settled = settle(s, outgoing);
        if (!settled.ok) return settled;
        return 'error' in found ? { ok: false, error: `server_error:${JSON.stringify(found.error).slice(0, 160)}` } : { ok: true, value: found.result ?? null };
      }
    }
    return { ok: false, error: 'server_request_timeout' };
  };
  const initialize = (s: State, repository: string): Result<boolean> => {
    if (s.running && s.repository === repository) {
      const status = budget({ session }, argument => api.host.tryCall('process.status', argument));
      if (status.ok && status.value.running) return { ok: true, value: false };
    }
    s.running = false;
    s.repository = repository;
    s.documents = {};
    s.diagnostics = {};
    s.next_id = 1;
    const found = budget({ names: ['pylsp'] }, argument => api.host.tryCall('process.which', argument));
    if (!found.ok) return found;
    const server = found.value.found[0];
    if (!server) return { ok: false, error: 'python_server_absent' };
    const started = budget({ session, name: server.name, path: server.path, sha256: server.sha256, arguments: [] }, argument => api.host.tryCall('process.start', argument));
    if (!started.ok) return started;
    s.running = true;
    const rootUri = fileUri(repository);
    const init = request(s, 'initialize', {
      processId: null,
      clientInfo: { name: 'oh-my-diff-lsp-mod', version: '0.1.0' },
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: repository.split('/').at(-1) ?? 'workspace' }],
      capabilities: {
        textDocument: { publishDiagnostics: { versionSupport: true } },
        workspace: { workspaceEdit: { documentChanges: true, resourceOperations: ['rename'] }, fileOperations: { willRename: true, didRename: true } },
      },
    });
    if (!init.ok) {
      stopServer();
      s.running = false;
      return init;
    }
    s.capabilities = object(init.value)?.capabilities ?? null;
    const ready = exchange([{ jsonrpc: '2.0', method: 'initialized', params: {} }], 0);
    if (!ready.ok) {
      stopServer();
      s.running = false;
      return ready;
    }
    const settled = settle(s, handle(s, ready.value));
    if (!settled.ok) {
      stopServer();
      s.running = false;
      return settled;
    }
    return { ok: true, value: true };
  };
  const synchronize = (s: State, paths: string[]): Result<boolean> => {
    const selected = [...new Set(paths)].filter(supported);
    if (!selected.length) return { ok: true, value: false };
    if (selected.length > 128) return { ok: false, error: 'document_batch_limit' };
    let changed = false;
    for (let index = 0; index < selected.length; index += 16) {
      const chunk = selected.slice(index, index + 16);
      if (spent > BYTE_BUDGET / 2) return { ok: false, error: 'callback_budget' };
      const read = budget({ paths: chunk }, argument => api.host.tryCall('workspace.read', argument));
      if (!read.ok) return read;
      const tracked = new Set(Object.keys(s.documents));
      for (const path of chunk) {
        if (read.value.files[path]) tracked.add(path);
        else tracked.delete(path);
      }
      if (tracked.size > 128) return { ok: false, error: 'document_limit' };
      const priorDocuments = { ...s.documents };
      const priorDiagnostics = { ...s.diagnostics };
      const outbound: Json[] = [];
      for (const path of chunk) {
        const file = read.value.files[path];
        const previous = s.documents[path];
        if (!file) {
          if (previous) outbound.push({ jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri: uri(s.repository, path) } } });
          delete s.documents[path];
          delete s.diagnostics[path];
        } else if (!previous) {
          s.documents[path] = { sha256: file.sha256, version: 1 };
          outbound.push({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: uri(s.repository, path), languageId: 'python', version: 1, text: file.text } } });
        } else if (previous.sha256 !== file.sha256) {
          const version = previous.version + 1;
          s.documents[path] = { sha256: file.sha256, version };
          delete s.diagnostics[path];
          outbound.push({ jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri: uri(s.repository, path), version }, contentChanges: [{ text: file.text }] } });
        }
      }
      if (!outbound.length) continue;
      const batch = exchange(outbound, 150);
      const settled = batch.ok ? settle(s, handle(s, batch.value)) : batch;
      if (!settled.ok) {
        s.documents = priorDocuments;
        s.diagnostics = priorDiagnostics;
        if (settled.error !== 'callback_budget') {
          stopServer();
          s.running = false;
        }
        return settled;
      }
      changed = true;
    }
    return { ok: true, value: changed };
  };
  api.on('workspace_write', event => {
    const s = state(api.state.get());
    if (event.status === 'unavailable') { failure(s, event.reason ?? 'workspace_index_unavailable', true); save(s); return; }
    const paths = event.changes.map(change => change.path).filter(supported);
    const unsupported = event.changes.some(change => /\.(?:rs|ts|tsx|js|jsx|java)$/.test(change.path) || (change.path.length > 240 && /\.pyi?$/.test(change.path)));
    if (!paths.length && unsupported) { failure(s, 'unsupported_language_or_path'); save(s); return; }
    if (!paths.length) return;
    const previous = Object.keys(s.documents);
    const started = initialize(s, event.repository);
    if (!started.ok) { failure(s, started.error); save(s); return; }
    const synced = synchronize(s, started.value ? [...previous, ...paths] : paths);
    if (!synced.ok) failure(s, synced.error, true);
    else if (unsupported) failure(s, 'unsupported_language_or_path');
    else { s.status = 'synced'; s.reason = ''; }
    save(s);
  });
  api.on('workspace_pre_rename', event => {
    const fallback = (reason: string) => ({ status: 'fallback' as const, reason });
    if (!supported(event.old) || !supported(event.new)) return fallback('unsupported_language');
    const s = state(api.state.get());
    const started = initialize(s, event.repository);
    if (!started.ok) { failure(s, started.error); save(s); return fallback(started.error); }
    const synchronized = synchronize(s, [event.old]);
    if (!synchronized.ok) { failure(s, synchronized.error, true); save(s); return fallback(synchronized.error); }
    const provider = object(object(s.capabilities)?.workspace ?? null);
    const operations = object(provider?.fileOperations ?? null);
    if (!operations?.willRename) { save(s); return fallback('server_will_rename_unsupported'); }
    const before = budget({ paths: [event.old, event.new] }, argument => api.host.tryCall('workspace.read', argument));
    if (!before.ok) { failure(s, before.error, true); save(s); return fallback(before.error); }
    if (before.value.files[event.old]?.sha256 !== event.expected[event.old] || before.value.files[event.new] !== null) { failure(s, 'rename_input_stale', true); save(s); return fallback('rename_input_stale'); }
    const response = request(s, 'workspace/willRenameFiles', { files: [{ oldUri: uri(s.repository, event.old), newUri: uri(s.repository, event.new) }] });
    if (!response.ok) { failure(s, response.error, true); save(s); return fallback(response.error); }
    const parsed = renameEdit(s.repository, event.old, event.new, response.value);
    if (!parsed.ok) { failure(s, parsed.error); save(s); return fallback(parsed.error); }
    const paths = Object.keys(parsed.value);
    if (paths.length > 126 || paths.includes(event.new)) { save(s); return fallback('server_rename_scope_invalid'); }
    const read = paths.length ? budget({ paths }, argument => api.host.tryCall('workspace.read', argument)) : null;
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
  api.on('turn_start', () => {
    const s = state(api.state.get());
    const paths = Object.keys(s.documents);
    if (!paths.length || !s.repository) return;
    const started = initialize(s, s.repository);
    if (!started.ok) { failure(s, started.error); save(s); return; }
    const synced = synchronize(s, paths);
    if (!synced.ok) failure(s, synced.error, true);
    else {
      const pending = exchange([], 150);
      const settled = pending.ok ? settle(s, handle(s, pending.value)) : pending;
      if (!settled.ok) failure(s, settled.error, true);
      else if (synced.value || started.value) { s.status = 'synced'; s.reason = 'external_change_resynchronized'; }
    }
    save(s);
  });
  api.on('idle', () => {
    const s = state(api.state.get());
    if (!s.running) return;
    const status = budget({ session }, argument => api.host.tryCall('process.status', argument));
    if (status.ok && status.value.idle_ms < IDLE_STOP_MS) return;
    if (status.ok) stopServer();
    s.running = false;
    s.status = 'idle';
    save(s);
  });
  api.on('stop', () => {
    const s = state(api.state.get());
    if (s.running) stopServer();
  });
  api.tool({
    name: 'status',
    description: 'Show the opt-in Python language server synchronization status and explicit fallback reason.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  }, () => {
    const s = state(api.state.get());
    return { status: s.status, reason: s.reason, repository: s.repository, documents: Object.keys(s.documents).length, diagnostics: s.diagnostics, server: s.running ? 'pylsp' : null };
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
