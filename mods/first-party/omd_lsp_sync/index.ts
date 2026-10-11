import type { FileStat, Json, ModAPI } from '../../api.d.ts';

type Adapter = 'python' | 'typescript' | 'rust' | 'java';
type Document = { sha256: string; version: number };
type Diagnostic = { count: number; version: number | null; errors: string[] };
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
type Item = { label: string; value: string };
type Answer = { status: 'ready' | 'error'; message: string; items: Item[]; text: string | null; action: 'open' | 'apply' };
type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string) => ({ ok: false as const, error });
const ok = <T>(value: T) => ({ ok: true as const, value });

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
const doc = (s: { repository: string }, path: string) => ({ textDocument: { uri: uri(s.repository, path) } });
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
  if (response === null) return ok({});
  const edit = object(response);
  if (!edit || (edit.changeAnnotations !== undefined && Object.keys(object(edit.changeAnnotations) ?? {}).length)) return fail('server_rename_edit_unsupported');
  const grouped: Record<string, { version: number | null; edits: Json[] }> = {};
  if (edit.changes !== undefined) {
    const changes = object(edit.changes);
    if (!changes) return fail('server_rename_changes_invalid');
    for (const [name, edits] of Object.entries(changes)) {
      const path = pathFromUri(repository, name);
      if (!path || !Array.isArray(edits) || grouped[path]) return fail('server_rename_scope_invalid');
      grouped[path] = { version: null, edits };
    }
  }
  if (edit.documentChanges !== undefined) {
    if (!Array.isArray(edit.documentChanges) || edit.changes !== undefined) return fail('server_rename_changes_conflict');
    for (const entry of edit.documentChanges) {
      const change = object(entry);
      if (!change) return fail('server_rename_change_invalid');
      if (change.kind === 'rename') {
        if (change.oldUri !== uri(repository, old) || change.newUri !== uri(repository, next)) return fail('server_rename_extra_file_operation');
        continue;
      }
      if (change.kind !== undefined) return fail('server_rename_extra_file_operation');
      const target = object(change.textDocument ?? null);
      const path = target && string(target.uri) ? pathFromUri(repository, String(target.uri)) : null;
      const version = number(target?.version ?? null);
      if (!path || !Array.isArray(change.edits) || grouped[path] || (target?.version !== null && target?.version !== undefined && version === null)) return fail('server_rename_document_invalid');
      grouped[path] = { version, edits: change.edits };
    }
  }
  if (edit.changes === undefined && edit.documentChanges === undefined) return fail('server_rename_edit_missing');
  return ok(grouped);
}

function textWorkspaceEdit(repository: string, response: Json): Result<Record<string, { version: number | null; edits: Json[] }>> {
  const edit = object(response);
  if (!edit || edit.changeAnnotations !== undefined || (edit.changes !== undefined && edit.documentChanges !== undefined)) return fail('server_edit_unsupported');
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
    if (!changes) return fail('server_edit_invalid');
    for (const [name, edits] of Object.entries(changes)) if (!add(name, null, edits)) return fail('server_edit_invalid');
  } else if (edit.documentChanges !== undefined) {
    if (!Array.isArray(edit.documentChanges)) return fail('server_edit_invalid');
    for (const entry of edit.documentChanges) {
      const change = object(entry);
      const targetDocument = object(change?.textDocument ?? null);
      if (!change || change.kind !== undefined || !targetDocument || !add(targetDocument.uri ?? null, targetDocument.version ?? null, change.edits ?? null)) return fail('server_edit_invalid');
    }
  } else return fail('server_edit_missing');
  if (!Object.keys(grouped).length || Object.values(grouped).reduce((count, target) => count + target.edits.length, 0) > 1024) return fail('server_edit_empty_or_large');
  return ok(grouped);
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
    if (data && number(data.count) !== null) diagnostics[path] = { count: Number(data.count), version: number(data.version), errors: Array.isArray(data.errors) ? data.errors.filter(item => typeof item === 'string').slice(0, 50) as string[] : [] };
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
const OBSERVED_REPOSITORY_KEY = 'lsp.observed_repository';
const SYMBOL_KINDS = ['file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enum member', 'struct', 'event', 'operator', 'type parameter'];
const ITEM_LIMIT = 64;
const hoverText = (value: Json): string => typeof value === 'string' ? value
  : Array.isArray(value) ? value.map(hoverText).filter(Boolean).join('\n\n')
    : object(value) && string(object(value)?.language ?? null) ? `\`\`\`${object(value)?.language}\n${string(object(value)?.value ?? null) ?? ''}\n\`\`\``
      : string(object(value)?.value ?? null) ?? '';
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
    if (calls >= CALL_BUDGET || spent + cost > BYTE_BUDGET) return fail('callback_budget');
    calls++;
    const result = call(argument);
    spent += cost + size(result);
    return result;
  };
  const stopServer = (s: State) => budget({ session: s.adapter }, a => api.host.tryCall('process.stop', a));
  const readFiles = (paths: string[]) => budget({ paths }, a => api.host.tryCall('workspace.read', a));
  let dirty = false;
  const save = (s: State) => {
    const root = object(api.state.get()) ?? {};
    const existing = object(root.servers ?? null);
    const prior = existing ?? (string(root.repository ?? null) ? { python: state(api.state.get(), 'python') as unknown as Json } : {});
    const stored = { ...s, diagnostics: { ...s.diagnostics } };
    const body = () => ({ servers: { ...prior, [s.adapter]: stored } }) as unknown as Json;
    for (const path in stored.diagnostics) {
      if (serializedBytes(body()) <= 60_000) break;
      stored.diagnostics[path] = { ...s.diagnostics[path], errors: [] };
    }
    api.state.set(body());
    dirty = true;
  };
  const announce = <T>(value: T): T => {
    if (!dirty) return value;
    dirty = false;
    const data = ORDER.map(adapter => state(api.state.get(), adapter)).filter(s => s.status !== 'idle' || s.running).map(s => ({ adapter: s.adapter, server: s.running ? s.server : null, status: s.status, reason: s.reason, documents: Object.keys(s.documents).length,
      count: Object.values(s.diagnostics).reduce((total, entry) => total + entry.count, 0), errors: Object.entries(s.diagnostics).flatMap(([path, entry]) => entry.errors.slice(0, 3).map(error => `${path}:${error}`)).slice(0, 6) }));
    budget({ channel: 'status', data }, a => api.host.tryCall('events.publish', a));
    return value;
  };
  const exchange = (s: State, outgoing: Json[], wait_ms: number): Result<Message[]> => {
    const result = budget({ session: s.adapter, send: outgoing, wait_ms }, a => api.host.tryCall('process.exchange', a));
    if (!result.ok) return result;
    const messages = result.value.messages.map(message);
    return messages.every(Boolean) ? ok(messages as Message[]) : fail('invalid_server_message');
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
      if (!Array.isArray(entries)) continue;
      const errors = new Set<string>();
      let count = 0;
      for (const entry of entries) {
        const item = object(entry);
        const start = object(object(item?.range ?? null)?.start ?? null);
        const text = string(item?.message ?? null);
        if ((item?.severity ?? 1) === 1) count++;
        if (text && (item?.severity ?? 1) === 1 && errors.size < 50) errors.add(`${Number(start?.line ?? 0) + 1}:${Number(start?.character ?? 0) + 1} ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
      }
      s.diagnostics[path] = { count, version, errors: [...errors] };
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
    return ok(true);
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
        return 'error' in found ? fail(`server_error:${JSON.stringify(found.error).slice(0, 160)}`) : ok(found.result ?? null);
      }
    }
    return fail('server_request_timeout');
  };
  const initialize = (s: State, repository: string): Result<boolean> => {
    if (s.running && s.repository === repository) {
      const status = budget({ session: s.adapter }, a => api.host.tryCall('process.status', a));
      if (status.ok && status.value.running) return ok(false);
    }
    if (s.running) stopServer(s);
    s.running = false;
    s.server = null;
    s.repository = repository;
    s.documents = {};
    s.diagnostics = {};
    s.preview = null;
    s.next_id = 1;
    const candidates = ADAPTERS[s.adapter].candidates;
    const found = budget({ names: [...candidates.map(candidate => candidate.name), ...(s.adapter === 'rust' ? ['cargo'] : [])] }, a => api.host.tryCall('process.which', a));
    if (!found.ok) return found;
    const chosen = candidates.find(candidate => found.value.found.some(server => server.name === candidate.name));
    const server = chosen && found.value.found.find(server => server.name === chosen.name);
    if (!chosen || !server) return fail(`${s.adapter}_server_absent`);
    const cargo = found.value.found.find(item => item.name === 'cargo');
    const rustup = s.adapter === 'rust' && cargo ? /^(.*)\/\.cargo\/bin\/rustup$/.exec(cargo.path) : null;
    const environment: Record<string, string> = rustup ? { RUSTUP_HOME: `${rustup[1]}/.rustup` } : {};
    const launch = { session: s.adapter, name: server.name, path: server.path, sha256: server.sha256, arguments: chosen.arguments, environment };
    let started = budget(launch, a => api.host.tryCall('process.start', a));
    if (!started.ok && started.error.startsWith('process_session_limit_or_duplicate')) {
      stopServer(s);
      started = budget(launch, a => api.host.tryCall('process.start', a));
    }
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
        textDocument: { publishDiagnostics: { versionSupport: true }, documentSymbol: { hierarchicalDocumentSymbolSupport: true } },
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
    return ok(true);
  };
  const synchronize = (s: State, paths: string[]): Result<boolean> => {
    const selected = [...new Set(paths)].filter(path => adapterFor(path) === s.adapter);
    if (!selected.length) return ok(false);
    if (selected.length > 128) return fail('document_batch_limit');
    let changed = false;
    for (let index = 0; index < selected.length; index += 16) {
      const chunk = selected.slice(index, index + 16);
      if (spent > BYTE_BUDGET / 2) return fail('callback_budget');
      const read = readFiles(chunk);
      if (!read.ok) return read;
      const tracked = new Set(Object.keys(s.documents));
      for (const path of chunk) {
        if (read.value.files[path]) tracked.add(path);
        else tracked.delete(path);
      }
      const priorDocuments = { ...s.documents };
      const priorDiagnostics = { ...s.diagnostics };
      const outbound: Json[] = [];
      for (const path of Object.keys(s.documents)) {
        if (tracked.size <= 96) break;
        if (chunk.includes(path)) continue;
        tracked.delete(path);
        outbound.push({ jsonrpc: '2.0', method: 'textDocument/didClose', params: doc(s, path) });
        delete s.documents[path];
        delete s.diagnostics[path];
      }
      for (const path of chunk) {
        const file = read.value.files[path];
        const previous = s.documents[path];
        if (!file) {
          if (previous) outbound.push({ jsonrpc: '2.0', method: 'textDocument/didClose', params: doc(s, path) });
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
    return ok(changed);
  };
  const observedRepository = (repository: string, record: boolean): Result<boolean> => {
    const current = budget({ key: OBSERVED_REPOSITORY_KEY, scope: 'repository' as const }, a => api.host.tryCall('store.get', a));
    if (!current.ok) return current;
    const value = object(current.value?.value ?? null);
    if (current.value) return ok(value?.repository === repository);
    if (!record) return ok(false);
    const saved = budget({ key: OBSERVED_REPOSITORY_KEY, scope: 'repository' as const, expected_revision: null, value: { repository } }, a => api.host.tryCall('store.put', a));
    return saved.ok ? ok(true) : saved;
  };
  const currentThread = (): Result<string> => {
    const key = 'lsp.thread_probe';
    const before = budget({ key, scope: 'repository' as const }, a => api.host.tryCall('store.get', a));
    if (!before.ok) return before;
    const put = budget({ key, scope: 'repository' as const, expected_revision: before.value?.revision ?? null, value: { revision: (before.value?.revision ?? 0) + 1 } }, a => api.host.tryCall('store.put', a));
    if (!put.ok) return put;
    const after = budget({ key, scope: 'repository' as const }, a => api.host.tryCall('store.get', a));
    if (!after.ok) return after;
    const thread = after.value?.provenance.thread_id;
    return after.value?.revision === put.value.revision && thread ? ok(thread) : fail('thread_identity_unavailable');
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
      const read = readFiles(names.slice(index, index + 16));
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
