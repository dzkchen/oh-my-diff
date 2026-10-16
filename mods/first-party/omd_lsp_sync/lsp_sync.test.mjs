import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { closeSync, constants, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callback, runnerSync } from '../../../tests/mod_runner.mjs';

const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const base = {
  source, api: manifest.api, capabilities: manifest.capabilities, settings: {}, state: null,
  filename: fileURLToPath(new URL('./index.ts', import.meta.url)),
  entrypoint: 'index.ts',
  assets: Object.fromEntries(manifest.assets.map(name => [name, { text: readFileSync(new URL(name, import.meta.url), 'utf8'), sha256: '0'.repeat(64) }])),
};

function replay(host, extra) {
  const output = callback({ ...base, hook_budget_ms: 500, ...extra }, host);
  assert.equal(output.error, undefined, output.error);
  return output;
}

const script = steps => call => {
  const [operation, args, value] = steps.shift() ?? [];
  assert.equal(call.operation, operation);
  if (args) assert.deepEqual(call.arguments, args);
  return value;
};

const observed = { key: 'lsp.observed_repository', scope: 'repository' };
const sizes = (files, paths) => ({ files: Object.fromEntries(paths.map(path => [path, files[path] ? { kind: 'file', size: files[path].text.length, mtime_ms: 0, sha256: files[path].sha256 } : null])) });

test('LSP mod synchronizes writes and applies versioned rename edits through public host calls', () => {
  const repository = '/tmp/project';
  const files = {
    'pkg/old.py': { text: 'value = 1\n', sha256: 'old-hash' },
    'pkg/new.py': null,
    'pkg/__init__.py': { text: 'from .old import value as alias\n', sha256: 'barrel-hash' },
    'pkg/use.py': { text: 'from pkg.old import value as local\n', sha256: 'alias-hash' },
  };
  const uri = path => `file://${repository}/${path}`;
  let running = false;
  let idleMs = 0;
  let rename = null;
  let observedRepository = null;
  const server = call => {
    switch (call.operation) {
      case 'store.get':
        assert.deepEqual(call.arguments, observed);
        return observedRepository;
      case 'store.put':
        assert.deepEqual(call.arguments, { ...observed, expected_revision: null, value: { repository } });
        observedRepository = { revision: 1, value: call.arguments.value };
        return { revision: 1 };
      case 'process.which': return { found: [{ name: 'pylsp', path: '/bin/pylsp', sha256: 'server-hash' }] };
      case 'process.start': running = true; return { session: 'python', running: true };
      case 'process.status': return { session: 'python', running, idle_ms: idleMs };
      case 'process.stop': running = false; return { stopped: true };
      case 'events.publish': return { delivered: 0, dropped: 0 };
      case 'workspace.stat': return sizes(files, call.arguments.paths);
      case 'workspace.read': return { files: Object.fromEntries(call.arguments.paths.map(path => [path, files[path] ?? null])) };
      case 'process.exchange': {
        const request = call.arguments.send?.find(message => message.method === 'initialize' || message.method === 'workspace/willRenameFiles');
        if (!request) {
          const opened = call.arguments.send?.find(message => message.method === 'textDocument/didOpen');
          return { session: 'python', running: true, messages: opened ? [{ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: uri('pkg/old.py'), version: 1, diagnostics: [{ message: 'example' }] } }] : [] };
        }
        const result = request.method === 'initialize' ? { capabilities: { workspace: { fileOperations: { willRename: { filters: [] } } } } } : rename;
        return { session: 'python', running: true, messages: [{ jsonrpc: '2.0', id: request.id, result }] };
      }
      default: throw new Error(`unexpected operation ${call.operation}`);
    }
  };
  const sync = (event, payload, state = null) => replay(server, { event, payload, state });
  const write = sync('workspace_change', { repository, call_id: 'write-1', source: 'tool', status: 'observed', changes: [{ path: 'pkg/old.py', before: null, after: 'old-hash' }] });
  assert.equal(write.state.servers.python.status, 'synced');
  assert.equal(write.state.servers.python.documents['pkg/old.py'].version, 1);
  assert.equal(write.state.servers.python.diagnostics['pkg/old.py'].count, 1);
  rename = { documentChanges: [
    { textDocument: { uri: uri('pkg/__init__.py'), version: null }, edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, newText: 'new' }] },
    { textDocument: { uri: uri('pkg/use.py'), version: null }, edits: [{ range: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } }, newText: 'new' }] },
  ] };
  const requested = sync('workspace_pre_rename', { repository, old: 'pkg/old.py', new: 'pkg/new.py', expected: { 'pkg/old.py': 'old-hash', 'pkg/new.py': null } }, write.state);
  assert.deepEqual(requested.value, { status: 'ready', expected: { 'pkg/old.py': 'old-hash', 'pkg/new.py': null, 'pkg/__init__.py': 'barrel-hash', 'pkg/use.py': 'alias-hash' }, writes: { 'pkg/__init__.py': 'from .new import value as alias\n', 'pkg/use.py': 'from pkg.new import value as local\n' } });
  rename.documentChanges[0].textDocument.version = 9;
  const stale = sync('workspace_pre_rename', { repository, old: 'pkg/old.py', new: 'pkg/new.py', expected: { 'pkg/old.py': 'old-hash', 'pkg/new.py': null } }, write.state);
  assert.deepEqual(stale.value, { status: 'fallback', reason: 'server_rename_document_stale' });
  const idle = sync('idle', {}, requested.state);
  assert.equal(idle.state.servers.python.running, true);
  assert.equal(running, true);
  idleMs = 16 * 60_000;
  const expired = sync('idle', {}, requested.state);
  assert.equal(expired.state.servers.python.status, 'idle');
  assert.equal(running, false);
});

test('LSP mod reports an absent server and leaves the write event recoverable', () => {
  const payload = { repository: '/tmp/project', call_id: 'write-1', source: 'tool', status: 'observed', changes: [{ path: 'sample.py', before: null, after: 'sha' }] };
  const steps = [
    ['store.get', observed, null],
    ['store.put', { ...observed, expected_revision: null, value: { repository: payload.repository } }, { revision: 1 }],
    ['process.which', { names: ['pyright-langserver', 'pylsp', 'jedi-language-server'] }, { found: [] }],
    ['events.publish', undefined, { delivered: 0, dropped: 0 }],
  ];
  const absent = replay(script(steps), { event: 'workspace_change', payload });
  assert.equal(steps.length, 0);
  assert.equal(absent.state.servers.python.status, 'fallback');
  assert.equal(absent.state.servers.python.reason, 'python_server_absent');
  const broken = runnerSync({ source: 'export default api => { api.on("workspace_change", () => { throw new Error("broken") }); }', filename: 'fixture.ts', api: manifest.api,
    capabilities: ['fs.read'], state: null, settings: {}, event: 'workspace_change', payload });
  assert.match(broken.error, /broken/);
});

test('LSP mod starts separate TypeScript, Rust, and Java adapters for mixed writes', () => {
  const repository = '/tmp/project';
  const files = {
    'src/app.ts': { text: 'export const value = 1;\n', sha256: 'ts-sha' },
    'src/helper.js': { text: 'export const helper = 1;\n', sha256: 'js-sha' },
    'src/main.rs': { text: 'fn main() {}\n', sha256: 'rs-sha' },
    'src/Main.java': { text: 'class Main {}\n', sha256: 'java-sha' },
  };
  const started = [];
  const opened = [];
  let observedRepository = null;
  const server = call => {
    if (call.operation === 'store.get') {
      assert.deepEqual(call.arguments, observed);
      return observedRepository;
    }
    if (call.operation === 'store.put') {
      assert.deepEqual(call.arguments, { ...observed, expected_revision: null, value: { repository } });
      observedRepository = { revision: 1, value: call.arguments.value };
      return { revision: 1 };
    }
    if (call.operation === 'process.which') return { found: call.arguments.names.filter(name => ['typescript-language-server', 'rust-analyzer', 'jdtls'].includes(name)).map(name => ({ name, path: `/bin/${name}`, sha256: `${name}-sha` })) };
    if (call.operation === 'process.start') { started.push(call.arguments); return { session: call.arguments.session, running: true }; }
    if (call.operation === 'process.stop') return { stopped: false };
    if (call.operation === 'events.publish') return { delivered: 0, dropped: 0 };
    if (call.operation === 'workspace.stat') return sizes(files, call.arguments.paths);
    if (call.operation === 'workspace.read') return { files: Object.fromEntries(call.arguments.paths.map(path => [path, files[path] ?? null])) };
    if (call.operation === 'process.exchange') {
      const request = call.arguments.send?.find(message => message.method === 'initialize');
      if (request) return { session: call.arguments.session, running: true, messages: [{ jsonrpc: '2.0', id: request.id, result: { capabilities: { workspace: { fileOperations: { willRename: {} } } } } }] };
      opened.push(...(call.arguments.send ?? []).filter(message => message.method === 'textDocument/didOpen').map(message => [call.arguments.session, message.params.textDocument.languageId, message.params.textDocument.uri]));
      return { session: call.arguments.session, running: true, messages: [] };
    }
    throw new Error(`unexpected operation ${call.operation}`);
  };
  const payload = { repository, source: 'tool', call_id: 'mixed', status: 'observed', changes: Object.keys(files).map(path => ({ path, before: null, after: files[path].sha256 })) };
  const result = replay(server, { event: 'workspace_change', payload });
  assert.deepEqual(started.map(item => [item.session, item.name, item.arguments]), [
    ['typescript', 'typescript-language-server', ['--stdio']], ['rust', 'rust-analyzer', []], ['java', 'jdtls', ['--jvm-arg=-Duser.home={process.home}']],
  ]);
  assert.deepEqual(opened.map(item => item.slice(0, 2)), [['typescript', 'typescript'], ['typescript', 'javascript'], ['rust', 'rust'], ['java', 'java']]);
  assert.equal(result.state.servers.typescript.documents['src/helper.js'].version, 1);
  assert.equal(result.state.servers.rust.documents['src/main.rs'].version, 1);
  assert.equal(result.state.servers.java.documents['src/Main.java'].version, 1);
  const cross = runnerSync({ ...base, event: 'workspace_pre_rename', payload: { repository, old: 'src/app.ts', new: 'src/main.rs', expected: {} }, state: result.state });
  assert.deepEqual(cross.value, { status: 'fallback', reason: 'unsupported_language' });
});

const digest = text => typeof text === 'string' ? createHash('sha256').update(text).digest('hex') : null;
const failure = message => new Error(message);
const harness = message => Object.assign(new Error(message), { crash: true });
const notice = (method, params) => ({ jsonrpc: '2.0', method, params });
const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
const span = (line, start, end) => ({ start: { line, character: start }, end: { line, character: end } });
const sibling = (uri, name) => uri.slice(0, uri.lastIndexOf('/') + 1) + name;
const published = (uri, version, diagnostics) => notice('textDocument/publishDiagnostics', { uri, version, diagnostics });

function actionServer() {
  let actionRequests = 0;
  return ({ method, params, id }) => {
    const uri = params?.textDocument?.uri;
    switch (method) {
      case 'initialize': return [
        ...Array.from({ length: 20 }, (_, index) => notice('window/logMessage', { type: 4, message: String(index) })),
        { jsonrpc: '2.0', id: 1, method: 'workspace/configuration', params: { items: [{}] } },
        reply(id, { capabilities: { definitionProvider: true, referencesProvider: true, codeActionProvider: true, renameProvider: { prepareProvider: true }, workspace: { fileOperations: { willRename: {} } } } }),
      ];
      case 'textDocument/didOpen': return [published(uri, params.textDocument.version, [{}])];
      case 'workspace/willRenameFiles': return [
        notice('window/logMessage', { type: 4, message: 'renaming' }),
        reply(id, { changes: { [sibling(params.files[0].oldUri, 'user.py')]: [{ range: span(0, 5, 8), newText: 'new' }] } }),
      ];
      case 'textDocument/definition':
      case 'textDocument/references': return [reply(id, [{ uri: sibling(uri, uri.endsWith('/longtarget.py') ? `${'x'.repeat(4000)}.py` : 'old.py'), range: span(0, 0, 5) }])];
      case 'textDocument/prepareRename': return [reply(id, { range: span(0, 0, 5) })];
      case 'textDocument/rename': {
        const user = sibling(uri, 'user.py');
        const { newName } = params;
        if (newName === 'resource') return [reply(id, { documentChanges: [{ kind: 'rename', oldUri: uri, newUri: user }] })];
        const version = newName === 'stale' ? 9 : 1;
        return [reply(id, { documentChanges: [
          { textDocument: { uri, version }, edits: [{ range: span(0, 0, 5), newText: newName }] },
          { textDocument: { uri: user, version: 1 }, edits: [{ range: span(0, 16, 21), newText: newName }] },
        ] })];
      }
      case 'textDocument/codeAction': {
        if (uri.endsWith('/longkind.py')) return [reply(id, [{ title: 'Oversized', kind: 'x'.repeat(70_000) }])];
        if (uri.endsWith('/longtitle.py')) return [reply(id, Array.from({ length: 32 }, () => ({ title: 'é'.repeat(512), kind: 'quickfix' })))];
        if (uri.endsWith('/deferred.py')) return [reply(id, [{ title: 'Deferred', kind: 'quickfix', data: { token: 'fixture' } }])];
        actionRequests++;
        const newText = uri.endsWith('/unstable.py') && actionRequests > 1 ? 'other' : 'new';
        const edit = { changes: { [sibling(uri, 'user.py')]: [{ range: span(0, 5, 8), newText }] } };
        return [reply(id, [{ title: 'Update import', kind: 'quickfix', edit }, { title: 'Run tool', command: 'unsafe.command' }])];
      }
      default: return [];
    }
  };
}

function diagnosticServer() {
  const documents = new Map();
  const publish = () => {
    const exported = [...documents].some(([uri, [, text]]) => uri.endsWith('/old.py') && text.includes('value'));
    return [...documents].map(([uri, [version, text]]) => {
      const errors = text.split('\n').flatMap((line, index) => line.includes('ERR ') ? [[index, line.split('ERR ')[1]]] : []);
      if (uri.endsWith('/user.py') && !exported) errors.push([0, 'value is undefined']);
      return published(uri, version, [...errors.map(([line, message]) => ({ range: span(line, 0, 1), severity: 1, message })), { severity: 2, message: 'style' }]);
    });
  };
  return ({ method, params, id }) => {
    switch (method) {
      case 'initialize': return [reply(id, { capabilities: {} })];
      case 'textDocument/didOpen':
        documents.set(params.textDocument.uri, [params.textDocument.version, params.textDocument.text]);
        return publish();
      case 'textDocument/didChange': {
        const text = params.contentChanges[0].text;
        documents.set(params.textDocument.uri, [params.textDocument.version, text]);
        return [...text.includes('ASK') ? [{ jsonrpc: '2.0', id: 99, method: 'workspace/configuration', params: { items: Array(14_000).fill({}) } }] : [], ...publish()];
      }
      default: return [];
    }
  };
}

function viewServer() {
  return ({ method, params, id }) => {
    const uri = params?.textDocument?.uri;
    switch (method) {
      case 'initialize': return [reply(id, { capabilities: { hoverProvider: true, documentSymbolProvider: true, documentFormattingProvider: true, codeActionProvider: true } })];
      case 'textDocument/didOpen':
        return uri.endsWith('/quiet.py') ? [] : [published(uri, params.textDocument.version, uri.endsWith('/clean.py') ? [] : [{ range: span(2, 4, 8), severity: 1, message: 'size is unused' }])];
      case 'textDocument/hover': return [reply(id, { contents: [{ language: 'python', value: 'value: int' }, 'Module constant'] })];
      case 'textDocument/documentSymbol': return [reply(id, [{ name: 'Box', kind: 5, range: span(1, 0, 9), selectionRange: span(1, 6, 9), children: [{ name: 'size', kind: 8, range: span(2, 4, 12), selectionRange: span(2, 4, 8) }] }])];
      case 'textDocument/formatting': return [reply(id, [{ range: span(0, 0, 7), newText: 'value = 1' }])];
      case 'textDocument/codeAction': return [reply(id, [{ title: 'Rename Box', kind: 'quickfix', edit: { changes: { [uri]: [{ range: span(1, 6, 9), newText: 'Crate' }] } } }])];
      default: return [];
    }
  };
}

// Within `patience` of a request, waits block until a message arrives so a slow server still answers in the mod's loop.
function spawnServer(command, cwd, patience = 30_000) {
  const directory = mkdtempSync(join(tmpdir(), 'omd-lsp-'));
  const [input, output] = [join(directory, 'in'), join(directory, 'out')];
  execFileSync('mkfifo', [input, output]);
  const child = spawn('sh', ['-c', 'exec "$0" < "$1" > "$2" 2>/dev/null', command, input, output], { cwd, stdio: 'ignore' });
  const writer = openSync(input, 'w');
  const reader = openSync(output, constants.O_RDWR | constants.O_NONBLOCK);
  let buffer = Buffer.alloc(0);
  const pending = new Map();
  const frame = () => {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return null;
    const length = Number(/content-length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())?.[1]);
    if (!(buffer.length >= end + 4 + length)) return null;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length));
    buffer = buffer.subarray(end + 4 + length);
    return message;
  };
  return {
    exchange(send, wait) {
      for (const message of send) {
        if ('id' in message && 'method' in message) pending.set(message.id, Date.now() + patience);
        const body = JSON.stringify(message);
        writeSync(writer, `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      }
      const messages = [];
      const deadline = Math.max(Date.now() + wait, ...pending.values());
      for (;;) {
        for (let next = frame(); next; next = frame()) {
          if (!('method' in next)) pending.delete(next.id);
          messages.push(next);
        }
        const chunk = Buffer.alloc(65_536);
        let read = 0;
        try { read = readSync(reader, chunk); } catch (error) { if (error.code !== 'EAGAIN') throw error; }
        if (read) { buffer = Buffer.concat([buffer, chunk.subarray(0, read)]); continue; }
        if (messages.length || Date.now() >= deadline) return messages;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    },
    close() {
      child.kill();
      closeSync(writer);
      closeSync(reader);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function createHost({ files = {}, server = null, repository = '/repo', binary = { path: '/bin/pylsp', sha256: digest('pylsp') } } = {}) {
  const host = {
    repository, files: { ...files }, server, thread: 'thread-a', store: {}, backups: {}, operations: [], sent: [], published: [],
    budget: 1000, session: null, startError: null, failOpen: null, failSync: false, intercept: null,
    count: operation => host.operations.filter(name => name === operation).length,
    observe: () => { host.store[observed.key] = { revision: 1, value: { repository }, provenance: { thread_id: host.thread } }; },
    call: call => {
      const { operation, arguments: args } = call;
      host.operations.push(operation);
      const early = host.intercept?.(call);
      if (early !== undefined) return early;
      const read = name => host.files[name] ?? null;
      switch (operation) {
        case 'session.info': return { thread_id: host.thread, root: host.repository, cwd: host.repository };
        case 'store.get': return host.store[args.key] ?? null;
        case 'store.put': {
          const current = host.store[args.key];
          if ((current?.revision ?? null) !== args.expected_revision) throw harness('store revision mismatch');
          const revision = (current?.revision ?? 0) + 1;
          host.store[args.key] = { revision, value: args.value, provenance: { thread_id: host.thread } };
          return { revision };
        }
        case 'process.which': return { found: host.server ? [{ name: 'pylsp', ...binary }] : [] };
        case 'process.start':
          if (host.startError) throw failure(host.startError);
          if (host.session) throw failure('process_session_limit_or_duplicate: python');
          host.session = host.server();
          return { session: 'python', running: true };
        case 'process.status':
          if (!host.session) throw harness('server is unavailable');
          return { session: 'python', running: true, idle_ms: 0 };
        case 'process.exchange': {
          const send = args.send ?? [];
          if (host.failOpen && send.some(message => message.method === 'textDocument/didOpen')) throw failure(host.failOpen);
          if (host.failSync && send.some(message => message.method === 'textDocument/didChange')) throw failure('synthetic_sync_failure');
          if (!host.session) throw harness('server stopped before replying');
          host.sent.push(...send);
          return { session: 'python', running: true, messages: host.session.exchange?.(send, args.wait_ms ?? 0) ?? send.flatMap(host.session) };
        }
        case 'process.stop': host.session?.close?.(); host.session = null; return { stopped: true };
        case 'workspace.stat':
          if (args.paths.length > 128) throw failure('workspace_path_limit');
          return { files: Object.fromEntries(args.paths.map(name => [name, read(name) === null ? null : { kind: 'file', size: Buffer.byteLength(read(name)), mtime_ms: 0, sha256: digest(read(name)) }])) };
        case 'workspace.read': return { files: Object.fromEntries(args.paths.map(name => [name, read(name) === null ? null : { text: read(name), sha256: digest(read(name)) }])) };
        case 'workspace.backup': {
          for (const [name, expected] of Object.entries(args.expected)) if (digest(read(name)) !== expected) throw failure('stale_backup_input');
          const backup = Object.fromEntries(Object.keys(args.expected).map(name => [name, read(name)]));
          const reference = digest(JSON.stringify(backup));
          host.backups[reference] = backup;
          return { backup: { reference, sha256: reference } };
        }
        case 'workspace.transaction':
          if (Object.keys(args.expected).sort().join() !== Object.keys(args.writes).sort().join()) throw failure('transaction_scope_invalid');
          for (const [name, expected] of Object.entries(args.expected)) if (digest(read(name)) !== expected) throw failure('stale_transaction_input');
          Object.assign(host.files, args.writes);
          return { files: Object.fromEntries(Object.keys(args.writes).map(name => [name, digest(read(name))])), backup: null };
        case 'workspace.restore': {
          const backup = host.backups[args.backup.reference];
          if (Object.keys(backup).sort().join() !== Object.keys(args.expected).sort().join()) throw failure('restore_scope_invalid');
          for (const [name, expected] of Object.entries(args.expected)) if (digest(read(name)) !== expected) throw failure('restore_conflict');
          for (const [name, text] of Object.entries(backup)) text === null ? delete host.files[name] : host.files[name] = text;
          return { files: Object.fromEntries(Object.entries(backup).map(([name, text]) => [name, digest(text)])) };
        }
        case 'terminal.prompt': return { status: 'accepted' };
        case 'events.publish': host.published.push(args); return { delivered: 1, dropped: 0 };
        case 'exec.run': return { exit_code: 0, stdout: `${repository}\n`, stderr: '', stdout_sha256: digest(`${repository}\n`) };
        default: throw harness(`unexpected host operation ${operation}`);
      }
    },
  };
  return host;
}

function drive(host, event, payload, state = null, name = null) {
  const output = callback({ ...base, event, name, payload, state, hook_budget_ms: host.budget }, host.call);
  assert.equal(output.error, undefined, output.error);
  return output;
}

const hashes = (host, names) => Object.fromEntries(names.map(name => [name, digest(host.files[name])]));
const change = (host, names, call_id = '1') => ({ repository: host.repository, source: 'tool', call_id, status: 'observed', changes: names.map(path => ({ path, before: null, after: digest(host.files[path]) })) });
const output = (args, tool = 'apply_patch') => ({ call_id: 'c', tool, arguments: args, success: true, text: '', tail: null, bytes: 0, original: null });
const area = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } };
const pair = { 'old.py': 'value = 1\n', 'user.py': 'from old import value\n' };

test('LSP mod batches feedback across languages and reports incomplete checks', () => {
  const build = (prefix = '') => {
    const files = {};
    const servers = {};
    for (const [adapter, extension, count] of [['python', 'py', 65], ['typescript', 'ts', 64]]) {
      const documents = {};
      for (let index = 0; index < count; index++) {
        const name = `${prefix}f${String(index).padStart(3, '0')}.${extension}`;
        files[name] = 'x=1\n';
        documents[name] = { sha256: digest('x=1\n'), version: 1 };
      }
      servers[adapter] = { repository: '/repo', running: true, status: 'synced', documents };
      files[`${prefix}f000.${extension}`] = 'x=2\n';
    }
    return { files, state: { servers } };
  };
  const feedback = (files, refusal) => {
    const host = createHost({ files });
    host.batches = [];
    host.intercept = ({ operation, arguments: args }) => {
      if (operation === 'workspace.stat') {
        host.batches.push(args.paths);
        if (refusal === 'stat' && host.batches.length === 2) throw failure('stat_unavailable');
      }
      if (operation !== 'process.exchange') return undefined;
      if (refusal === 'sync') throw failure('sync_unavailable');
      return { session: args.session, running: true, messages: args.send.filter(message => message.method === 'textDocument/didChange').map(({ params }) =>
        published(params.textDocument.uri, params.textDocument.version, [{ severity: 1, message: 'new error', range: { start: { line: 0, character: 0 } } }])) };
    };
    return host;
  };
  const event = { tool: 'apply_patch', arguments: '', success: true };
  const { files, state } = build();
  const host = feedback(files);
  const result = drive(host, 'tool_output', event, state);
  assert.deepEqual(host.batches.slice(0, 2).map(batch => batch.length), [128, 1]);
  for (const extension of ['py', 'ts']) assert.match(result.value.append, new RegExp(`f000\\.${extension}: 1 new, 0 resolved`));
  for (const refusal of ['stat', 'sync']) {
    const refused = drive(feedback(files, refusal), 'tool_output', event, state);
    assert.match(refused.value.append, /feedback incomplete/);
    for (const adapter of Object.keys(state.servers)) assert.equal(refused.state.servers[adapter].status, 'stale');
  }
  const long = build('a'.repeat(180));
  const budget = drive(feedback(long.files), 'tool_output', event, long.state);
  assert.match(budget.value.append, /feedback incomplete: callback_budget/);
  for (const adapter of Object.keys(long.state.servers)) assert.equal(budget.state.servers[adapter].status, 'stale');
});

test('LSP service answers through the running server and confirms edits', () => {
  const host = createHost({ files: { 'box.py': 'value=1\nclass Box:\n    size = 2\n' }, server: viewServer });
  let state = null;
  const query = request => {
    const answered = drive(host, 'service', request, state, 'omd.lsp.query');
    state = answered.state;
    return answered.value;
  };
  assert.equal(query({ op: 'hover', path: 'box.py', line: 1, character: 1 }).text, '```python\nvalue: int\n```\n\nModule constant');
  assert.deepEqual(query({ op: 'symbols', path: 'box.py' }).items, [{ label: 'class Box · 2', value: 'box.py:2' }, { label: '  field size · 3', value: 'box.py:3' }]);
  assert.deepEqual(query({ op: 'diagnostics', path: 'box.py' }).items, [{ label: 'box.py:3:5 size is unused', value: 'box.py:3' }]);
  assert.equal(query({ op: 'format', path: 'box.py' }).text, 'Formatted box.py');
  assert.equal(host.files['box.py'], 'value = 1\nclass Box:\n    size = 2\n');
  const actions = query({ op: 'actions', path: 'box.py', line: 2, character: 1 });
  assert.deepEqual([actions.action, actions.items], ['apply', [{ label: 'Rename Box', value: '0:box.py' }]]);
  assert.equal(query({ op: 'apply', path: 'box.py', index: 0 }).text, 'Applied: Rename Box');
  assert.equal(host.files['box.py'], 'value = 1\nclass Crate:\n    size = 2\n');
  assert.equal(query({ op: 'hover', path: '../box.py', line: 1, character: 1 }).status, 'error');
  assert.equal(host.count('process.start'), 1);
  for (let n = 0; n < 20; n++) state.servers.python.diagnostics[`f${n}.py`] = { count: 50, version: null, errors: Array.from({ length: 50 }, (_, line) => `${line}:1 ${'x'.repeat(200)}`) };
  query({ op: 'hover', path: 'box.py', line: 1, character: 1 });
  assert.ok(Buffer.byteLength(JSON.stringify(state)) <= 65_536);
});

test('LSP diagnostics query separates failure, pending and published empty', () => {
  const files = { 'quiet.py': 'value = 1\n', 'clean.py': 'value = 1\n' };
  const pending = 'diagnostics pending: the language server has not published diagnostics for this file yet; try again';
  for (const [lost, name, expected] of [[true, 'quiet.py', ['error', 'process not found: python']], [false, 'quiet.py', ['error', pending]], [false, 'clean.py', ['ready', 'No results']]]) {
    const host = createHost({ files, server: viewServer });
    if (lost) host.intercept = ({ operation, arguments: args }) => { if (operation === 'process.exchange' && args.wait_ms === 250) throw failure('process_not_found: python'); };
    const answer = drive(host, 'service', { op: 'diagnostics', path: name }, null, 'omd.lsp.query').value;
    assert.deepEqual([answer.status, answer.message, answer.items], [...expected, []], `${name} lost=${lost}`);
  }
});

test('LSP budget failure after didChange restarts the server instead of rolling back', () => {
  const host = createHost({ files: { 'a.py': 'value = 1\n' }, server: diagnosticServer });
  let state = drive(host, 'workspace_change', change(host, ['a.py']), null).state;
  host.files['a.py'] = 'value = 2  # ASK\n';
  state = drive(host, 'workspace_change', change(host, ['a.py']), state).state;
  const python = state.servers.python;
  assert.deepEqual(host.sent.filter(message => message.method === 'textDocument/didChange').map(message => message.params.textDocument.version), [2]);
  assert.deepEqual([python.running, python.status, python.reason], [false, 'stale', 'callback_budget']);
  assert.equal(host.session, null);
  host.files['a.py'] = 'value = 3\n';
  const restarted = drive(host, 'workspace_change', change(host, ['a.py']), state).state.servers.python;
  assert.deepEqual([restarted.running, restarted.status, restarted.documents['a.py'].version], [true, 'synced', 1]);
  assert.equal(host.count('process.start'), 2);
});

test('LSP resync reads documents within the receipt room, reads an oversize file alone and skips files the host cannot return as text', () => {
  const files = { 'bad.py': 'x', 'huge.py': 'h'.repeat(30_000) };
  for (let index = 0; index < 2; index++) files[`doc${index}.py`] = `# ${index}\n`.padEnd(5_000, 'v');
  const host = createHost({ files, server: diagnosticServer });
  const batches = [];
  host.intercept = ({ operation, arguments: args }) => {
    if (operation !== 'workspace.read') return undefined;
    batches.push(args.paths);
    if (args.paths.includes('bad.py')) throw failure('workspace_text_not_utf8');
    return undefined;
  };
  const synced = drive(host, 'workspace_change', change(host, Object.keys(files)), null);
  const python = synced.state.servers.python;
  assert.deepEqual(Object.keys(python.documents).sort(), ['doc0.py', 'doc1.py', 'huge.py']);
  assert.equal(python.status, 'synced');
  for (const batch of batches.filter(batch => !batch.includes('huge.py'))) assert.ok(batch.reduce((total, path) => total + files[path].length, 0) <= 24_000, batch.join());
  assert.deepEqual(batches.filter(batch => batch.includes('bad.py')), [['bad.py', 'doc0.py', 'doc1.py'], ['bad.py']], 'a failing batch is split in halves');
  assert.deepEqual(batches.filter(batch => batch.includes('huge.py')), [['huge.py']]);
  const reads = batches.length;
  drive(host, 'turn_start', {}, synced.state);
  assert.equal(batches.length, reads, 'unchanged documents are not read again');
  drive(host, 'workspace_change', change(host, ['bad.py']), synced.state);
  assert.equal(batches.length, reads, 'a file that is not UTF-8 is not read again while its hash is unchanged');
  const large = createHost({ files: { 'big.py': 'b'.repeat(50_000) }, server: diagnosticServer });
  const refused = drive(large, 'workspace_change', change(large, ['big.py']), null).state.servers.python;
  assert.deepEqual([refused.status, refused.reason], ['stale', 'document_too_large']);
});

test('LSP path mentions in a huge unbroken argument are scanned in linear time', () => {
  const host = createHost({ files: {}, server: diagnosticServer });
  const started = Date.now();
  assert.equal(drive(host, 'tool_output', output('a'.repeat(100_000))).value, null);
  assert.ok(Date.now() - started < 2000);
});

test('LSP post-edit feedback reports only introduced and resolved errors', () => {
  const host = createHost({ files: { 'old.py': 'value = 1\n', 'user.py': 'from old import value\n' }, server: diagnosticServer });
  const prefix = 'Language-server errors after this call:\n';
  const state = drive(host, 'workspace_change', change(host, ['old.py', 'user.py']), null).state;
  host.files['old.py'] = 'val = 1\nERR broken syntax\n';
  const broken = drive(host, 'tool_output', output('*** Update File: old.py'), state);
  assert.equal(broken.value.append, `${prefix}old.py: 1 new, 0 resolved\n  + 2:1 broken syntax\nuser.py (dependent): 1 new, 0 resolved\n  + 1:1 value is undefined`);
  host.files['old.py'] = 'value = 1\n';
  const fixed = drive(host, 'tool_output', output('/repo/old.py'), broken.state);
  assert.match(fixed.value.append, /old\.py: 0 new, 1 resolved\n {2}- 2:1 broken syntax/);
  assert.match(fixed.value.append, /user\.py \(dependent\): 0 new, 1 resolved/);
  assert.equal(drive(host, 'tool_output', output('cat old.py'), fixed.state).value, null);
  host.files['new.py'] = 'ERR preexisting\n';
  const read = drive(host, 'tool_output', output({ cmd: 'sed -n 1p new.py' }, 'exec_command'), fixed.state);
  assert.equal(read.value.append, `${prefix}new.py: 1 existing (v1)\n  1:1 preexisting`);
  assert.deepEqual(host.published.at(-1).data[0].errors, ['new.py:1:1 preexisting']);
  const opened = drive(host, 'tool_output', output('*** Add File: new.py'), fixed.state);
  assert.equal(opened.value, null);
  assert.ok('new.py' in opened.state.servers.python.documents);
  host.files['new.py'] = 'ERR preexisting\nERR added\n';
  host.files['old.py'] = 'value = 1\nERR also\n';
  const edited = drive(host, 'tool_output', output(null), opened.state);
  assert.equal(edited.value.append, `${prefix}old.py: 1 new, 0 resolved\n  + 2:1 also\nnew.py: 1 new, 0 resolved\n  + 2:1 added`);
  assert.equal(host.count('process.start'), 1);
});

test('LSP explicit reads start only the viewed server, set the edit baseline and never write', () => {
  const files = { 'old.py': 'value = 1\nERR before\n' };
  const read = command => output({ cmd: command }, 'exec_command');
  const denied = createHost({ files, server: diagnosticServer });
  denied.startError = 'managed_process_requires_native_sandbox';
  for (const [host, unavailable] of [[createHost({ files, server: diagnosticServer }), null], [createHost({ files }), 'python_server_absent'], [denied, denied.startError]]) {
    host.observe();
    assert.equal(drive(host, 'tool_output', read('rg -n value old.py')).value, null);
    assert.equal(drive(host, 'tool_output', read('cat README.md')).value, null);
    assert.ok(!host.operations.includes('process.which'));
    const first = drive(host, 'tool_output', read('cat old.py'));
    assert.ok(!['workspace.transaction', 'workspace.backup', 'workspace.restore'].some(operation => host.operations.includes(operation)));
    if (unavailable) {
      assert.equal(first.value.append, `Language-server errors after this call:\npython language server unavailable: ${unavailable}`);
      assert.equal(drive(host, 'tool_output', read('cat old.py'), first.state).value, null);
      continue;
    }
    assert.equal(first.value.append, 'Language-server errors after this call:\nold.py: 1 existing (v1)\n  2:1 before');
    assert.equal(drive(host, 'tool_output', read('nl -ba old.py'), first.state).value, null);
    host.files['old.py'] = 'value = 1\nERR before\nERR after\n';
    const edited = drive(host, 'tool_output', output('*** Update File: old.py'), first.state);
    assert.equal(edited.value.append, 'Language-server errors after this call:\nold.py: 1 new, 0 resolved\n  + 3:1 after');
    assert.equal(host.count('process.start'), 1);
  }
});

test('LSP cancelled reads recover without orphaned servers', () => {
  const host = createHost({ files: { 'old.py': 'ERR before\n' }, server: diagnosticServer });
  const read = output({ cmd: 'cat old.py' }, 'exec_command');
  const reported = 'Language-server errors after this call:\nold.py: 1 existing (v1)\n  1:1 before';
  host.observe();
  host.failOpen = 'process_cancelled';
  const cancelled = drive(host, 'tool_output', read);
  host.failOpen = null;
  assert.match(cancelled.value.append, /feedback incomplete: process_cancelled/);
  assert.equal(cancelled.state.servers.python.status, 'stale');
  assert.equal(cancelled.state.servers.python.running, false);
  assert.equal(host.session, null);
  assert.equal(drive(host, 'tool_output', read, cancelled.state).value.append, reported);
  assert.equal(drive(host, 'tool_output', read, cancelled.state).value.append, reported);
  assert.equal(host.count('process.start'), 4);
});

test('LSP symbol rename and code action apply exact text scopes', () => {
  const host = createHost({ files: pair, server: actionServer });
  const expected = hashes(host, ['old.py', 'user.py']);
  const opened = drive(host, 'workspace_change', change(host, ['old.py', 'user.py']));
  const target = { path: 'old.py', source_sha256: expected['old.py'], line: 0, character: 1, scope: ['old.py', 'user.py'], expected };
  const rename = (extra, state = opened.state) => drive(host, 'tool', { ...target, ...extra }, state, 'rename_symbol').value;
  assert.equal(rename({ new_name: 'stale' }).reason, 'server_edit_stale');
  assert.equal(rename({ new_name: 'resource' }).reason, 'server_edit_invalid');
  assert.equal(rename({ new_name: 'renamed', scope: ['old.py'], expected: { 'old.py': expected['old.py'] } }).reason, 'server_edit_scope_mismatch');
  assert.ok(!host.operations.includes('workspace.transaction'));
  const renamed = drive(host, 'tool', { ...target, new_name: 'renamed' }, opened.state, 'rename_symbol');
  assert.equal(renamed.value.status, 'applied', JSON.stringify(renamed.value));
  assert.equal(host.files['old.py'], 'renamed = 1\n');
  assert.equal(host.files['user.py'], 'from old import renamed\n');
  assert.equal(renamed.state.servers.python.documents['old.py'].version, 2);
  assert.ok(host.operations.includes('workspace.backup') && host.operations.includes('workspace.transaction'));
  assert.ok(!host.operations.includes('workspace.restore'));

  const actions = createHost({ files: pair, server: actionServer });
  const shas = hashes(actions, ['old.py', 'user.py']);
  const start = drive(actions, 'workspace_change', change(actions, ['old.py', 'user.py']));
  const apply = { path: 'old.py', source_sha256: shas['old.py'], range: area, scope: ['user.py'], expected: { 'user.py': shas['user.py'] } };
  const preview = drive(actions, 'tool', { path: 'old.py', range: area }, start.state, 'code_actions');
  assert.equal(preview.value.application, 'exact_scope_text_edits_only');
  const command = drive(actions, 'tool', { ...apply, action_index: 1, title: 'Run tool' }, preview.state, 'apply_code_action');
  assert.equal(command.value.reason, 'server_code_action_unsupported');
  const applied = drive(actions, 'tool', { ...apply, action_index: 0, title: 'Update import' }, command.state, 'apply_code_action');
  assert.equal(applied.value.status, 'applied', JSON.stringify(applied.value));
  assert.equal(actions.files['user.py'], 'from new import value\n');
  assert.ok(!actions.operations.includes('workspace.restore'));
});

test('LSP failed semantic sync restores the exact backup', () => {
  const host = createHost({ files: pair, server: actionServer });
  const expected = hashes(host, ['old.py', 'user.py']);
  const opened = drive(host, 'workspace_change', change(host, ['old.py', 'user.py']));
  host.failSync = true;
  const failed = drive(host, 'tool', { path: 'old.py', source_sha256: expected['old.py'], line: 0, character: 1, new_name: 'renamed', scope: ['old.py', 'user.py'], expected }, opened.state, 'rename_symbol');
  assert.equal(failed.value.reason, 'sync_failed_rolled_back');
  assert.deepEqual(hashes(host, ['old.py', 'user.py']), expected);
  assert.ok(host.operations.includes('workspace.transaction') && host.operations.includes('workspace.restore'));
  assert.equal(failed.state.servers.python.running, false);
});

test('LSP code action apply requires an exact preview and rejects a deferred edit', () => {
  const host = createHost({ files: { 'unstable.py': 'value = 1\n', 'deferred.py': 'value = 1\n', 'user.py': 'from old import value\n' }, server: actionServer });
  const expected = hashes(host, ['unstable.py', 'deferred.py', 'user.py']);
  const opened = drive(host, 'workspace_change', change(host, ['unstable.py', 'deferred.py', 'user.py']));
  const apply = (path, title, state) => drive(host, 'tool', { path, source_sha256: expected[path], range: area, action_index: 0, title, scope: ['user.py'], expected: { 'user.py': expected['user.py'] } }, state, 'apply_code_action');
  const preview = drive(host, 'tool', { path: 'unstable.py', range: area }, opened.state, 'code_actions');
  assert.equal(preview.value.actions[0].title, 'Update import');
  host.thread = 'thread-b';
  const foreign = apply('unstable.py', 'Update import', preview.state);
  assert.equal(foreign.value.reason, 'code_action_preview_thread_mismatch');
  host.thread = 'thread-a';
  const changed = apply('unstable.py', 'Update import', foreign.state);
  assert.equal(changed.value.reason, 'code_action_preview_stale');
  const deferredPreview = drive(host, 'tool', { path: 'deferred.py', range: area }, changed.state, 'code_actions');
  assert.equal(apply('deferred.py', 'Deferred', deferredPreview.state).value.reason, 'server_code_action_deferred_unsupported');
  assert.ok(!host.operations.includes('workspace.backup') && !host.operations.includes('workspace.transaction'));
  assert.equal(host.files['user.py'], 'from old import value\n');
});

test('LSP semantic reads are scoped and actions are discovery only', () => {
  const host = createHost({ files: { 'old.py': 'value = 1\n' }, server: actionServer });
  const opened = drive(host, 'workspace_change', change(host, ['old.py']));
  const query = (path, tool, extra, state) => drive(host, 'tool', { path, ...extra }, state, tool);
  const point = { line: 0, character: 1 };
  const definition = query('old.py', 'definition', point, opened.state);
  assert.equal(definition.value.status, 'ready');
  assert.equal(definition.value.locations[0].path, 'old.py');
  assert.equal(definition.value.locations[0].sha256, digest('value = 1\n'));
  const references = query('old.py', 'references', { ...point, include_declaration: true }, definition.state);
  assert.equal(references.value.status, 'ready');
  assert.ok(host.sent.some(message => message.method === 'textDocument/references' && message.params.context.includeDeclaration));
  const actions = query('old.py', 'code_actions', { range: area }, references.state);
  assert.equal(actions.value.application, 'exact_scope_text_edits_only');
  assert.deepEqual(actions.value.actions.map(item => item.has_command), [false, true]);
  const without = structuredClone(actions.state);
  without.servers.python.capabilities.codeActionProvider = false;
  assert.equal(query('old.py', 'code_actions', { range: area }, without).value.reason, 'server_code_actions_unsupported');
  assert.equal(query('../old.py', 'definition', point, actions.state).value.reason, 'unsupported_or_invalid_path');
  host.files['old.py'] = 'x\n';
  assert.equal(query('old.py', 'definition', { line: 0, character: 0 }, actions.state).value.reason, 'server_location_stale_or_invalid');
  let state = actions.state;
  for (const [name, tool, extra, reason] of [
    ['longkind.py', 'code_actions', { range: area }, 'server_code_actions_invalid'],
    ['longtitle.py', 'code_actions', { range: area }, 'server_code_actions_output_limit'],
    ['longtarget.py', 'definition', point, 'server_location_invalid'],
  ]) {
    host.files[name] = 'value = 1\n';
    state = drive(host, 'workspace_change', change(host, [name], name), state).state;
    const answer = query(name, tool, extra, state);
    assert.equal(answer.value.reason, reason);
    state = answer.state;
  }
  assert.ok(!host.sent.some(message => message.method === 'workspace/applyEdit'));
});

test('LSP semantic request rejects an untracked target and a foreign store', () => {
  const host = createHost({ files: { 'old.py': 'value = 1\n', 'user.py': 'from old import value\n' }, server: actionServer });
  const foreign = createHost({ repository: '/other', server: actionServer });
  const opened = drive(host, 'workspace_change', change(host, ['user.py']));
  const location = drive(host, 'tool', { path: 'user.py', line: 0, character: 5 }, opened.state, 'definition');
  assert.equal(location.value.reason, 'server_location_unobserved_or_stale');
  foreign.store[observed.key] = { revision: 1, value: { repository: '/other' } };
  const bound = drive(foreign, 'tool', { path: 'user.py', line: 0, character: 5 }, opened.state, 'definition');
  assert.equal(bound.value.reason, 'repository_binding_mismatch');
  assert.ok(!foreign.operations.includes('process.start') && !foreign.operations.includes('workspace.read'));
});

test('LSP server requests are answered and rename changes resolve to exact writes', () => {
  const host = createHost({ files: pair, server: actionServer });
  const first = drive(host, 'workspace_change', change(host, ['old.py', 'user.py']));
  assert.equal(first.state.servers.python.status, 'synced');
  assert.equal(first.state.servers.python.diagnostics['old.py'].count, 1);
  assert.ok(host.sent.some(message => message.id === 1 && !message.method && message.result?.[0] === null));
  const rename = drive(host, 'workspace_pre_rename', { repository: '/repo', old: 'old.py', new: 'new.py', expected: hashes(host, ['old.py']) }, first.state);
  assert.equal(rename.value.status, 'ready', JSON.stringify(rename.value));
  assert.deepEqual(rename.value.writes, { 'user.py': 'from new import value\n' });
  assert.equal(host.count('process.start'), 1);
});

const pylsp = spawnSync('sh', ['-c', 'command -v pylsp'], { encoding: 'utf8' }).stdout.trim();
test('LSP installed Python server synchronizes document open, change and close', { skip: !pylsp }, () => {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), 'omd-lsp-repo-')));
  const host = createHost({ repository, files: { 'sample.py': 'value = 1\n' }, binary: { path: pylsp, sha256: digest(readFileSync(pylsp)) }, server: () => spawnServer(pylsp, repository) });
  const methods = () => host.sent.map(message => message.method);
  host.budget = 15_000;
  try {
    const first = drive(host, 'workspace_change', change(host, ['sample.py']));
    assert.equal(first.state.servers.python.status, 'synced');
    assert.ok(methods().includes('textDocument/didOpen'));
    const before = first.state.servers.python.documents['sample.py'].sha256;
    host.files['sample.py'] = 'value = 2\n';
    const second = drive(host, 'workspace_change', { ...change(host, ['sample.py'], '2'), changes: [{ path: 'sample.py', before, after: digest('value = 2\n') }] }, first.state);
    assert.equal(second.state.servers.python.documents['sample.py'].version, 2);
    assert.ok(methods().includes('textDocument/didChange'));
    delete host.files['sample.py'];
    const third = drive(host, 'workspace_change', { ...change(host, [], '3'), changes: [{ path: 'sample.py', before: second.state.servers.python.documents['sample.py'].sha256, after: null }] }, second.state);
    assert.deepEqual(third.state.servers.python.documents, {});
    assert.ok(methods().includes('textDocument/didClose'));
  } finally {
    host.session?.close?.();
    rmSync(repository, { recursive: true, force: true });
  }
});
