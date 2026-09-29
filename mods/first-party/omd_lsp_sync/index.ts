import type { Json, ModAPI } from '../../api.d.ts';

type Adapter = 'python' | 'typescript' | 'rust' | 'java';
type Document = { sha256: string; version: number };
type Diagnostic = { count: number; version: number | null };
type State = {
  adapter: Adapter;
  server: string | null;
  repository: string;
  running: boolean;
  next_id: number;
  capabilities: Json;
  documents: Record<string, Document>;
  diagnostics: Record<string, Diagnostic>;
  preview: { path: string; source_sha256: string; source_version: number; thread_id: string; range: Json; actions: string[] } | null;
  status: 'idle' | 'synced' | 'fallback' | 'stale';
  reason: string;
};
type Message = Record<string, Json>;
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const ADAPTERS: Record<Adapter, { candidates: { name: string; arguments: string[] }[] }> = {
  python: { candidates: [{ name: 'pyright-langserver', arguments: ['--stdio'] }, { name: 'pylsp', arguments: [] }, { name: 'jedi-language-server', arguments: [] }] },
  typescript: { candidates: [{ name: 'typescript-language-server', arguments: ['--stdio'] }, { name: 'vtsls', arguments: ['--stdio'] }] },
  rust: { candidates: [{ name: 'rust-analyzer', arguments: [] }] },
  java: { candidates: [{ name: 'jdtls', arguments: ['--jvm-arg=-Duser.home={process.home}'] }] },
};
const ORDER: Adapter[] = ['python', 'typescript', 'rust', 'java'];
const adapterFor = (path: string): Adapter | null => path.length > 240 ? null
  : /\.pyi?$/.test(path) ? 'python'
    : /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(path) ? 'typescript'
      : path.endsWith('.rs') ? 'rust'
        : path.endsWith('.java') ? 'java' : null;
const languageId = (path: string) => /\.(?:js|jsx|mjs|cjs)$/.test(path) ? 'javascript' : adapterFor(path);
const object = (value: Json): Record<string, Json> | null => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const string = (value: Json): string | null => typeof value === 'string' ? value : null;
const number = (value: Json): number | null => typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
const message = (value: Json): Message | null => object(value);
const linesOf = (text: string): number[] => {
  const lines = [0];
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) lines.push(index + 1);
  return lines;
};
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
  const lines = linesOf(text);
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

function checkedRange(text: string, value: Json): { start: { line: number; character: number }; end: { line: number; character: number } } | null {
  const range = object(value);
  const start = object(range?.start ?? null);
  const end = object(range?.end ?? null);
  const first = offset(text, linesOf(text), start);
  const last = offset(text, linesOf(text), end);
  if (first === null || last === null || first > last) return null;
  return { start: { line: Number(start?.line), character: Number(start?.character) }, end: { line: Number(end?.line), character: Number(end?.character) } };
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

function textWorkspaceEdit(repository: string, response: Json): Result<Record<string, { version: number | null; edits: Json[] }>> {
  const edit = object(response);
  if (!edit || edit.changeAnnotations !== undefined || (edit.changes !== undefined && edit.documentChanges !== undefined)) return { ok: false, error: 'server_edit_unsupported' };
  const grouped: Record<string, { version: number | null; edits: Json[] }> = {};
  const add = (name: Json, version: Json, edits: Json): boolean => {
    const path = string(name);
    const relative = path && pathFromUri(repository, path);
    if (!relative || relative.length > 240 || grouped[relative] || !Array.isArray(edits) || edits.length > 1024) return false;
    if (version !== null && (number(version) === null || Number(version) < 0)) return false;
    if (edits.some(entry => !object(entry) || object(entry)?.annotationId !== undefined)) return false;
    grouped[relative] = { version: number(version), edits };
    return true;
  };
  if (edit.changes !== undefined) {
    const changes = object(edit.changes);
    if (!changes) return { ok: false, error: 'server_edit_invalid' };
    for (const [name, edits] of Object.entries(changes)) if (!add(name, null, edits)) return { ok: false, error: 'server_edit_invalid' };
  } else if (edit.documentChanges !== undefined) {
    if (!Array.isArray(edit.documentChanges)) return { ok: false, error: 'server_edit_invalid' };
    for (const entry of edit.documentChanges) {
      const change = object(entry);
      const targetDocument = object(change?.textDocument ?? null);
      if (!change || change.kind !== undefined || !targetDocument || !add(targetDocument.uri ?? null, targetDocument.version ?? null, change.edits ?? null)) return { ok: false, error: 'server_edit_invalid' };
    }
  } else return { ok: false, error: 'server_edit_missing' };
  if (!Object.keys(grouped).length || Object.values(grouped).reduce((count, target) => count + target.edits.length, 0) > 1024) return { ok: false, error: 'server_edit_empty_or_large' };
  return { ok: true, value: grouped };
}

function state(value: Json, adapter: Adapter): State {
  const root = object(value) ?? {};
  const saved = object(object(root.servers ?? null)?.[adapter] ?? null) ?? (adapter === 'python' ? root : {});
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
  const savedPreview = object(saved.preview ?? null);
  const previewActions = savedPreview?.actions;
  const preview = string(savedPreview?.path ?? null) && string(savedPreview?.source_sha256 ?? null) && number(savedPreview?.source_version ?? null) !== null && string(savedPreview?.thread_id ?? null) && object(savedPreview?.range ?? null) && Array.isArray(previewActions) && previewActions.length <= 32 && previewActions.every(item => typeof item === 'string') && serializedBytes(previewActions) <= 16_384
    ? { path: String(savedPreview?.path), source_sha256: String(savedPreview?.source_sha256), source_version: Number(savedPreview?.source_version), thread_id: String(savedPreview?.thread_id), range: savedPreview?.range ?? null, actions: previewActions as string[] }
    : null;
  return {
    adapter,
    server: string(saved.server ?? null) ?? (adapter === 'python' && saved.running === true ? 'pylsp' : null),
    repository: string(saved.repository ?? null) ?? '',
    running: saved.running === true,
    next_id: number(saved.next_id ?? null) ?? 1,
    capabilities: saved.capabilities ?? null,
    documents,
    diagnostics,
    preview,
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
const OBSERVED_REPOSITORY_KEY = 'lsp.observed_repository';
const serializedBytes = (value: unknown) => {
  const text = JSON.stringify(value) ?? '';
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
    else bytes += 3;
  }
  return bytes;
};
const size = (value: unknown) => serializedBytes(value) + 96;

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
  const stopServer = (s: State) => budget({ session: s.adapter }, argument => api.host.tryCall('process.stop', argument));
  const save = (s: State) => {
    const root = object(api.state.get()) ?? {};
    const existing = object(root.servers ?? null);
    const prior = existing ?? (string(root.repository ?? null) ? { python: state(api.state.get(), 'python') as unknown as Json } : {});
    api.state.set({ servers: { ...prior, [s.adapter]: s as unknown as Json } });
  };
  const exchange = (s: State, outgoing: Json[], wait_ms: number): Result<Message[]> => {
    const result = budget({ session: s.adapter, send: outgoing, wait_ms }, argument => api.host.tryCall('process.exchange', argument));
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
      const answered = exchange(s, outgoing, 0);
      if (!answered.ok) return answered;
      outgoing = handle(s, answered.value);
    }
    return { ok: true, value: true };
  };
  const request = (s: State, method: string, params: Json): Result<Json> => {
    const id = s.next_id++;
    let outgoing: Json[] = [{ jsonrpc: '2.0', id, method, params }];
    for (let silent = 0; silent < SILENT_WAITS;) {
      const batch = exchange(s, outgoing, 1000);
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
      const status = budget({ session: s.adapter }, argument => api.host.tryCall('process.status', argument));
      if (status.ok && status.value.running) return { ok: true, value: false };
    }
    s.running = false;
    s.server = null;
    s.repository = repository;
    s.documents = {};
    s.diagnostics = {};
    s.preview = null;
    s.next_id = 1;
    const candidates = ADAPTERS[s.adapter].candidates;
    const found = budget({ names: [...candidates.map(candidate => candidate.name), ...(s.adapter === 'rust' ? ['cargo'] : [])] }, argument => api.host.tryCall('process.which', argument));
    if (!found.ok) return found;
    const chosen = candidates.find(candidate => found.value.found.some(server => server.name === candidate.name));
    const server = chosen && found.value.found.find(server => server.name === chosen.name);
    if (!chosen || !server) return { ok: false, error: `${s.adapter}_server_absent` };
    const cargo = found.value.found.find(item => item.name === 'cargo');
    const rustup = s.adapter === 'rust' && cargo ? /^(.*)\/\.cargo\/bin\/rustup$/.exec(cargo.path) : null;
    const environment: Record<string, string> = rustup ? { RUSTUP_HOME: `${rustup[1]}/.rustup` } : {};
    const started = budget({ session: s.adapter, name: server.name, path: server.path, sha256: server.sha256, arguments: chosen.arguments, environment }, argument => api.host.tryCall('process.start', argument));
    if (!started.ok) return started;
    s.running = true;
    s.server = server.name;
    const rootUri = fileUri(repository);
    const init = request(s, 'initialize', {
      processId: null,
      clientInfo: { name: 'oh-my-diff-lsp-mod', version: '0.2.0' },
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: repository.split('/').at(-1) ?? 'workspace' }],
      capabilities: {
        textDocument: { publishDiagnostics: { versionSupport: true } },
        workspace: { workspaceEdit: { documentChanges: true, resourceOperations: ['rename'] }, fileOperations: { willRename: true, didRename: true } },
      },
    });
    if (!init.ok) {
      stopServer(s);
      s.running = false;
      return init;
    }
    s.capabilities = object(init.value)?.capabilities ?? null;
    const ready = exchange(s, [{ jsonrpc: '2.0', method: 'initialized', params: {} }], 0);
    if (!ready.ok) {
      stopServer(s);
      s.running = false;
      return ready;
    }
    const settled = settle(s, handle(s, ready.value));
    if (!settled.ok) {
      stopServer(s);
      s.running = false;
      return settled;
    }
    return { ok: true, value: true };
  };
  const synchronize = (s: State, paths: string[]): Result<boolean> => {
    const selected = [...new Set(paths)].filter(path => adapterFor(path) === s.adapter);
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
          outbound.push({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: uri(s.repository, path), languageId: languageId(path), version: 1, text: file.text } } });
        } else if (previous.sha256 !== file.sha256) {
          const version = previous.version + 1;
          s.documents[path] = { sha256: file.sha256, version };
          delete s.diagnostics[path];
          outbound.push({ jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri: uri(s.repository, path), version }, contentChanges: [{ text: file.text }] } });
        }
      }
      if (!outbound.length) continue;
      const batch = exchange(s, outbound, 150);
      const settled = batch.ok ? settle(s, handle(s, batch.value)) : batch;
      if (!settled.ok) {
        s.documents = priorDocuments;
        s.diagnostics = priorDiagnostics;
        if (settled.error !== 'callback_budget') {
          stopServer(s);
          s.running = false;
        }
        return settled;
      }
      changed = true;
    }
    return { ok: true, value: changed };
  };
  const observedRepository = (repository: string, record: boolean): Result<boolean> => {
    const current = budget({ key: OBSERVED_REPOSITORY_KEY, scope: 'repository' as const }, argument => api.host.tryCall('store.get', argument));
    if (!current.ok) return current;
    const value = object(current.value?.value ?? null);
    if (current.value) return { ok: true, value: value?.repository === repository };
    if (!record) return { ok: true, value: false };
    const saved = budget({ key: OBSERVED_REPOSITORY_KEY, scope: 'repository' as const, expected_revision: null, value: { repository } }, argument => api.host.tryCall('store.put', argument));
    return saved.ok ? { ok: true, value: true } : saved;
  };
  const currentThread = (): Result<string> => {
    const key = 'lsp.thread_probe';
    const before = budget({ key, scope: 'repository' as const }, argument => api.host.tryCall('store.get', argument));
    if (!before.ok) return before;
    const put = budget({ key, scope: 'repository' as const, expected_revision: before.value?.revision ?? null, value: { revision: (before.value?.revision ?? 0) + 1 } }, argument => api.host.tryCall('store.put', argument));
    if (!put.ok) return put;
    const after = budget({ key, scope: 'repository' as const }, argument => api.host.tryCall('store.get', argument));
    if (!after.ok) return after;
    const thread = after.value?.provenance.thread_id;
    return after.value?.revision === put.value.revision && thread ? { ok: true, value: thread } : { ok: false, error: 'thread_identity_unavailable' };
  };
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
  });
  api.on('idle', () => {
    for (const adapter of ORDER) {
      const s = state(api.state.get(), adapter);
      if (!s.running) continue;
      const status = budget({ session: s.adapter }, argument => api.host.tryCall('process.status', argument));
      if (status.ok && status.value.idle_ms < IDLE_STOP_MS) continue;
      if (status.ok) stopServer(s);
      s.running = false;
      s.status = 'idle';
      save(s);
    }
  });
  api.on('stop', () => {
    for (const adapter of ORDER) {
      const s = state(api.state.get(), adapter);
      if (s.running) stopServer(s);
    }
  });
  const applyTextEdit = (s: State, scope: string[], expected: Record<string, string>, response: Json): Json => {
    const fallback = (reason: string, stale = false): Json => {
      failure(s, reason, stale); save(s);
      return { status: 'fallback', reason, adapter: s.adapter };
    };
    const parsed = textWorkspaceEdit(s.repository, response);
    if (!parsed.ok) return fallback(parsed.error);
    const paths = Object.keys(parsed.value);
    if (paths.length !== scope.length || paths.some(path => !scope.includes(path))) return fallback('server_edit_scope_mismatch');
    const read = budget({ paths: scope }, argument => api.host.tryCall('workspace.read', argument));
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
    const backup = budget({ expected }, argument => api.host.tryCall('workspace.backup', argument));
    if (!backup.ok) return fallback(backup.error, true);
    const applied = budget({ expected, writes }, argument => api.host.tryCall('workspace.transaction', argument));
    if (!applied.ok) return fallback(applied.error, true);
    const after = applied.value.files;
    if (Object.keys(after).length !== scope.length || scope.some(path => !after[path])) {
      const restored = api.host.tryCall('workspace.restore', { backup: backup.value.backup, expected: after });
      api.host.tryCall('process.stop', { session: s.adapter });
      s.running = false; s.documents = {}; s.diagnostics = {};
      return fallback(restored.ok ? 'transaction_result_invalid_rolled_back' : `rollback_failed:${restored.error}`, true);
    }
    const synced = synchronize(s, scope);
    if (!synced.ok) {
      const restored = api.host.tryCall('workspace.restore', { backup: backup.value.backup, expected: after });
      api.host.tryCall('process.stop', { session: s.adapter });
      s.running = false; s.documents = {}; s.diagnostics = {};
      return fallback(restored.ok ? 'sync_failed_rolled_back' : `rollback_failed:${restored.error}`, true);
    }
    s.preview = null;
    s.status = 'synced'; s.reason = '';
    save(s);
    return { status: 'applied', adapter: s.adapter, files: after };
  };
  const semanticEdit = (kind: 'rename_symbol' | 'apply_code_action', value: Json): Json => {
    const input = object(value);
    const path = string(input?.path ?? null);
    const adapter = path && adapterFor(path);
    if (!path || !adapter || !pathFromUri('/repository', uri('/repository', path))) return { status: 'fallback', reason: 'unsupported_or_invalid_path' };
    const s = state(api.state.get(), adapter);
    const fallback = (reason: string, stale = false): Json => {
      failure(s, reason, stale); save(s);
      return { status: 'fallback', reason, adapter };
    };
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
    const source = budget({ paths: [path] }, argument => api.host.tryCall('workspace.read', argument));
    if (!source.ok) return fallback(source.error, true);
    const file = source.value.files[path];
    if (!file || file.sha256 !== s.documents[path]?.sha256 || file.sha256 !== input?.source_sha256) return fallback('source_stale', true);
    if (kind === 'rename_symbol') {
      const name = string(input?.new_name ?? null);
      const position = { line: number(input?.line ?? null), character: number(input?.character ?? null) };
      if (!name || name.length > 512 || offset(file.text, linesOf(file.text), position as Json) === null) return fallback('rename_input_invalid');
      const capability = object(s.capabilities)?.renameProvider;
      if (capability !== true && !object(capability ?? null)) return fallback('server_rename_symbol_unsupported');
      const params = { textDocument: { uri: uri(s.repository, path) }, position };
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
    const actions = request(s, 'textDocument/codeAction', { textDocument: { uri: uri(s.repository, path) }, range, context: { diagnostics: [] } });
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
    const fallback = (reason: string, stale = false): Json => {
      failure(s, reason, stale);
      save(s);
      return { status: 'fallback', reason, adapter };
    };
    if (!s.repository) return fallback('repository_unobserved');
    const observed = observedRepository(s.repository, false);
    if (!observed.ok || !observed.value) return fallback(observed.ok ? 'repository_binding_mismatch' : observed.error, true);
    const started = initialize(s, s.repository);
    if (!started.ok) return fallback(started.error);
    const synced = synchronize(s, [path]);
    if (!synced.ok) return fallback(synced.error, true);
    const capability = object(s.capabilities)?.[kind === 'definition' ? 'definitionProvider' : kind === 'references' ? 'referencesProvider' : 'codeActionProvider'];
    if (capability !== true && !object(capability ?? null)) return fallback(`server_${kind}_unsupported`);
    const before = budget({ paths: [path] }, argument => api.host.tryCall('workspace.read', argument));
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
      ? { textDocument: { uri: uri(s.repository, path) }, range, context: { diagnostics: [] } }
      : kind === 'references'
        ? { textDocument: { uri: uri(s.repository, path) }, position, context: { includeDeclaration: input?.include_declaration === true } }
        : { textDocument: { uri: uri(s.repository, path) }, position };
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
      const after = budget({ paths: [path] }, argument => api.host.tryCall('workspace.read', argument));
      if (!after.ok || after.value.files[path]?.sha256 !== source.sha256) return fallback('source_stale', true);
      const result = { status: 'ready', adapter, path, source_sha256: source.sha256, source_version: s.documents[path].version, actions: listed, application: 'exact_scope_text_edits_only' };
      if (serializedBytes(result) > 32_768) return fallback('server_code_actions_output_limit');
      const previewActions = actions.map(item => JSON.stringify(item));
      const thread = previewActions.length && serializedBytes(previewActions) <= 16_384 ? currentThread() : null;
      if (thread && !thread.ok) return fallback(thread.error, true);
      s.preview = previewActions.length > 0 && serializedBytes(previewActions) <= 16_384 && thread?.ok
        ? { path, source_sha256: source.sha256, source_version: s.documents[path].version, thread_id: thread?.ok ? thread.value : '', range, actions: previewActions }
        : null;
      s.status = 'synced'; s.reason = ''; save(s);
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
      const read = budget({ paths: names.slice(index, index + 16) }, argument => api.host.tryCall('workspace.read', argument));
      if (!read.ok) return fallback(read.error, true);
      Object.assign(files, read.value.files);
    }
    if (files[path]?.sha256 !== source.sha256) return fallback('source_stale', true);
    const locations: { path: string; range: ReturnType<typeof checkedRange>; sha256: string }[] = [];
    for (const target of targets) {
      const file = files[target.path];
      const selected = file && checkedRange(file.text, target.range);
      if (!file || !selected) return fallback('server_location_stale_or_invalid', true);
      if (!s.documents[target.path] || s.documents[target.path].sha256 !== file.sha256) return fallback('server_location_unobserved_or_stale', true);
      locations.push({ path: target.path, range: selected, sha256: file.sha256 });
    }
    s.status = 'synced'; s.reason = ''; save(s);
    const result = { status: 'ready', adapter, path, source_sha256: source.sha256, source_version: s.documents[path].version, locations };
    return serializedBytes(result) > 32_768 ? fallback('server_locations_output_limit') : result;
  };
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
