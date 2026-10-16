import type { FileStat, Json, ModAPI } from '../../api.d.ts';
import { ADAPTERS, ORDER, adapterFor, doc, fail, fileUri, languageId, number, object, ok, OBSERVED_REPOSITORY_KEY, pathFromUri, serializedBytes, size, state, string, uri } from './protocol.ts';
import type { Message, Result, State } from './protocol.ts';

const CALL_BUDGET = 28;
const BYTE_BUDGET = 96_000;
const SILENT_WAITS = 10;
const READ_BYTES = 24_000;
const SKIPPED_LIMIT = 32;

type Source = { text: string; sha256: string } | null;

export function createClient(api: ModAPI) {
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
  const stopServer = (s: State) => api.host.tryCall('process.stop', { session: s.adapter });
  const readFiles = (paths: string[]) => budget({ paths }, a => api.host.tryCall('workspace.read', a));
  // Reads only documents whose hash differs from the tracked one, in batches that fit the receipt room twice (read, then sent to the server).
  // A file over the batch size is read alone, or refused with a reason when it cannot fit. A file that is not UTF-8 reads as absent and is
  // remembered by hash, so it is not read again until it changes.
  const readDocuments = (paths: string[], stats: Record<string, FileStat | null>, s: State): Result<Record<string, Source>> => {
    const files: Record<string, Source> = {};
    const total = (list: string[]) => list.reduce((sum, path) => sum + (stats[path]?.size ?? 0), 0);
    const read = (batch: string[]): Result<true> => {
      if (spent + 2 * total(batch) > BYTE_BUDGET) return fail('callback_budget');
      const result = readFiles(batch);
      if (result.ok) { Object.assign(files, result.value.files); return ok(true); }
      if (!result.error.includes('workspace_text_not_utf8')) return result;
      if (batch.length === 1) {
        files[batch[0]] = null;
        const hash = stats[batch[0]]?.sha256;
        if (hash) s.skipped = Object.fromEntries([...Object.entries(s.skipped), [batch[0], hash]].slice(-SKIPPED_LIMIT));
        return ok(true);
      }
      const half = batch.length >> 1;
      const first = read(batch.slice(0, half));
      return first.ok ? read(batch.slice(half)) : first;
    };
    let batch: string[] = [];
    let bytes = 0;
    for (const path of paths) {
      const stat = stats[path];
      if (stat?.kind !== 'file') files[path] = null;
      else if (stat.sha256 && stat.sha256 === s.documents[path]?.sha256) files[path] = { text: '', sha256: stat.sha256 };
      else if (stat.sha256 && stat.sha256 === s.skipped[path]) files[path] = null;
      else if (stat.size > READ_BYTES) {
        if (spent + 2 * stat.size > BYTE_BUDGET) return fail('document_too_large');
        const done = read([path]);
        if (!done.ok) return done;
      } else {
        if (bytes + stat.size > READ_BYTES) {
          const done = read(batch);
          if (!done.ok) return done;
          batch = [];
          bytes = 0;
        }
        batch.push(path);
        bytes += stat.size;
      }
    }
    const last = batch.length ? read(batch) : ok(true);
    return last.ok ? ok(files) : last;
  };
  let dirty = false;
  const save = (s: State) => {
    const prior = object(object(api.state.get())?.servers ?? null) ?? {};
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
    const messages = result.value.messages.map(object);
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
        if (text && (item?.severity ?? 1) === 1 && errors.size < 50) errors.add(`${Number(start?.line ?? 0) + 1}:${Number(start?.character ?? 0) + 1} ${[...text.replace(/\s+/g, ' ')].slice(0, 200).join('')}`);
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
        return 'error' in found ? fail(`server_error:${[...JSON.stringify(found.error)].slice(0, 160).join('')}`) : ok(found.result ?? null);
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
    const stat = budget({ paths: selected, hash: true }, a => api.host.tryCall('workspace.stat', a));
    if (!stat.ok) return stat;
    let changed = false;
    for (let index = 0; index < selected.length; index += 16) {
      const chunk = selected.slice(index, index + 16);
      if (spent > BYTE_BUDGET / 2) return fail('callback_budget');
      const read = readDocuments(chunk, stat.value.files, s);
      if (!read.ok) return read;
      const tracked = new Set(Object.keys(s.documents));
      for (const path of chunk) {
        if (read.value[path]) tracked.add(path);
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
        const file = read.value[path];
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
      if (!batch.ok && batch.error === 'callback_budget') {
        s.documents = priorDocuments;
        s.diagnostics = priorDiagnostics;
        return batch;
      }
      const settled = batch.ok ? settle(s, handle(s, batch.value)) : batch;
      if (!settled.ok) {
        stopServer(s);
        s.running = false;
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
    const info = budget(null, a => api.host.tryCall('session.info', a));
    if (!info.ok) return info;
    return info.value.thread_id ? ok(info.value.thread_id) : fail('thread_identity_unavailable');
  };
  return { budget, stopServer, readFiles, save, announce, exchange, settle, handle, request, initialize, synchronize, observedRepository, currentThread };
}
export type Client = ReturnType<typeof createClient>;
