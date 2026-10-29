import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { closeSync, constants, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callback } from '../../../tests/mod_runner.mjs';

const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const base = {
  source, api: manifest.api, capabilities: manifest.capabilities, settings: {}, state: null,
  filename: fileURLToPath(new URL('./index.ts', import.meta.url)),
  entrypoint: 'index.ts',
  assets: Object.fromEntries(manifest.assets.map(name => [name, { text: readFileSync(new URL(name, import.meta.url), 'utf8'), sha256: '0'.repeat(64) }])),
};

const observed = { key: 'lsp.observed_repository', scope: 'repository' };

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

test('LSP cancelled reads recover without orphaned servers', () => {
  const host = createHost({ files: { 'old.py': 'ERR before\n' }, server: diagnosticServer });
  const read = output({ cmd: 'cat old.py' }, 'exec_command');
  const reported = /old\.py.*before/s;
  host.observe();
  host.failOpen = 'process_cancelled';
  const cancelled = drive(host, 'tool_output', read);
  host.failOpen = null;
  assert.match(cancelled.value.append, /process_cancelled/);
  assert.equal(cancelled.state.servers.python.status, 'stale');
  assert.equal(cancelled.state.servers.python.running, false);
  assert.equal(host.session, null);
  assert.match(drive(host, 'tool_output', read, cancelled.state).value.append, reported);
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
  assert.ok(!host.operations.includes('workspace.restore'));

  const actions = createHost({ files: pair, server: actionServer });
  const shas = hashes(actions, ['old.py', 'user.py']);
  const start = drive(actions, 'workspace_change', change(actions, ['old.py', 'user.py']));
  const apply = { path: 'old.py', source_sha256: shas['old.py'], range: area, scope: ['user.py'], expected: { 'user.py': shas['user.py'] } };
  const preview = drive(actions, 'tool', { path: 'old.py', range: area }, start.state, 'code_actions');
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
  const actions = query('old.py', 'code_actions', { range: area }, definition.state);
  assert.deepEqual(actions.value.actions.map(item => item.has_command), [false, true]);
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

test('LSP semantic request opens a permitted unopened target and rejects a stale or foreign one', () => {
  const host = createHost({ files: { 'old.py': 'value = 1\n', 'user.py': 'from old import value\n' }, server: actionServer });
  const foreign = createHost({ repository: '/other', server: actionServer });
  const opened = drive(host, 'workspace_change', change(host, ['user.py']));
  const opens = () => host.sent.filter(message => message.method === 'textDocument/didOpen').map(message => message.params.textDocument.uri.split('/').at(-1));
  assert.deepEqual(opens(), ['user.py']);
  const location = drive(host, 'tool', { path: 'user.py', line: 0, character: 5 }, opened.state, 'definition');
  assert.equal(location.value.status, 'ready', JSON.stringify(location.value));
  assert.deepEqual(location.value.locations.map(item => [item.path, item.sha256]), [['old.py', digest('value = 1\n')]]);
  assert.deepEqual(opens(), ['user.py', 'old.py']);
  assert.deepEqual(Object.keys(location.state.servers.python.documents).sort(), ['old.py', 'user.py']);
  assert.equal(location.state.servers.python.status, 'synced');
  host.files['old.py'] = 'value = 2\n';
  const stale = drive(host, 'tool', { path: 'user.py', line: 0, character: 5 }, location.state, 'definition');
  assert.equal(stale.value.reason, 'server_location_unobserved_or_stale');
  assert.equal(stale.state.servers.python.status, 'stale');
  foreign.store[observed.key] = { revision: 1, value: { repository: '/other' } };
  const bound = drive(foreign, 'tool', { path: 'user.py', line: 0, character: 5 }, opened.state, 'definition');
  assert.equal(bound.value.reason, 'repository_binding_mismatch');
  assert.ok(!foreign.operations.includes('process.start') && !foreign.operations.includes('workspace.read'));
});

test('LSP the first apply_patch in a language starts the server and reports its errors in the same output', () => {
  const host = createHost({ files: { 'a.py': 'ERR boom\nok = 1\n' }, server: diagnosticServer });
  host.observe();
  const first = drive(host, 'tool_output', output({ input: '*** Update File: a.py' }));
  assert.match(first.value.append, /a\.py: 1 new, 0 resolved\n  \+ 1:1 boom/);
  assert.deepEqual([first.state.servers.python.running, first.state.servers.python.status], [true, 'synced']);
  host.files['a.py'] = 'ok = 1\n';
  const fixed = drive(host, 'tool_output', output({ input: '*** Update File: a.py' }), first.state);
  assert.match(fixed.value.append, /a\.py: 0 new, 1 resolved\n  - 1:1 boom/);
  const idle = createHost({ files: { 'a.py': 'ERR boom\n' }, server: diagnosticServer });
  idle.observe();
  assert.equal(drive(idle, 'tool_output', { ...output({ input: '*** Update File: a.py' }), success: false }).value, null);
  assert.ok(!idle.operations.includes('process.start'));
});

test('LSP an unavailable workspace index resynchronizes open documents and records a degraded reason', () => {
  const reason = 'workspace index exceeds bounds';
  const host = createHost({ files: { 'a.py': 'value = 1\n', 'b.py': 'other = 1\n' }, server: diagnosticServer });
  const opened = drive(host, 'workspace_change', change(host, ['a.py', 'b.py']));
  const unavailable = { repository: host.repository, source: 'rescan', call_id: null, status: 'unavailable', reason, changes: [] };
  const changes = () => host.sent.filter(message => message.method === 'textDocument/didChange').map(message => [message.params.textDocument.uri.split('/').at(-1), message.params.textDocument.version]);
  host.files['a.py'] = 'value = 2\n';
  const degraded = drive(host, 'workspace_change', unavailable, opened.state).state.servers.python;
  assert.deepEqual(changes(), [['a.py', 2]]);
  assert.deepEqual([degraded.running, degraded.status, degraded.reason], [true, 'synced', `degraded: ${reason}`]);
  assert.deepEqual(Object.fromEntries(Object.entries(degraded.documents).map(([name, entry]) => [name, entry.version])), { 'a.py': 2, 'b.py': 1 });
  host.failSync = true;
  host.files['a.py'] = 'value = 3\n';
  const failed = drive(host, 'workspace_change', unavailable, opened.state).state.servers.python;
  assert.deepEqual([failed.running, failed.status, failed.reason], [false, 'stale', 'synthetic_sync_failure']);
  const empty = drive(createHost({ server: diagnosticServer }), 'workspace_change', unavailable, null).state;
  assert.equal(empty?.servers?.python?.status ?? 'idle', 'idle');
});

test('LSP an unavailable event for other causes resyncs neutrally, keeps its reason until the next observed change and honors the repository binding', () => {
  const host = createHost({ files: { 'a.py': 'value = 1\n', 'b.py': 'other = 1\n' }, server: diagnosticServer });
  const opened = drive(host, 'workspace_change', change(host, ['a.py', 'b.py']));
  const unavailable = reason => ({ repository: host.repository, source: 'rescan', call_id: null, status: 'unavailable', reason, changes: [] });
  host.files['a.py'] = 'value = 2\n';
  const resynced = drive(host, 'workspace_change', unavailable('workspace_change_batch_limit'), opened.state);
  assert.equal(resynced.state.servers.python.reason, 'resynced: workspace_change_batch_limit');
  host.files['a.py'] = 'value = 3\n';
  const fed = drive(host, 'tool_output', output({ input: '*** Update File: a.py' }), resynced.state);
  assert.equal(fed.state.servers.python.reason, 'resynced: workspace_change_batch_limit');
  host.files['b.py'] = 'other = 2\n';
  const turn = drive(host, 'turn_start', null, fed.state);
  assert.equal(turn.state.servers.python.reason, 'resynced: workspace_change_batch_limit');
  host.files['a.py'] = 'value = 4\n';
  const cleared = drive(host, 'workspace_change', change(host, ['a.py']), turn.state);
  assert.deepEqual([cleared.state.servers.python.status, cleared.state.servers.python.reason], ['synced', '']);
  const foreign = createHost({ repository: '/other', server: diagnosticServer });
  foreign.store[observed.key] = { revision: 1, value: { repository: '/other' } };
  const bound = drive(foreign, 'workspace_change', unavailable('workspace_change_batch_limit'), opened.state).state.servers.python;
  assert.equal(bound.reason, 'repository_binding_mismatch');
  assert.ok(!foreign.operations.includes('process.start') && !foreign.operations.includes('workspace.read'));
});

test('LSP definition keeps its source document open while many targets open near the document cap', () => {
  const many = () => {
    const inner = actionServer();
    return message => message.method === 'textDocument/definition'
      ? [reply(message.id, Array.from({ length: 20 }, (_, index) => ({ uri: sibling(message.params.textDocument.uri, `t${index}.py`), range: span(0, 0, 1) })))]
      : inner(message);
  };
  const files = Object.fromEntries(['src.py', ...Array.from({ length: 90 }, (_, index) => `f${index}.py`), ...Array.from({ length: 20 }, (_, index) => `t${index}.py`)].map(name => [name, `${name.split('.')[0]} = 1\n`]));
  const host = createHost({ files, server: many });
  let opened = null;
  for (let start = 0; start < 90; start += 30) opened = drive(host, 'workspace_change', change(host, [...start ? [] : ['src.py'], ...Array.from({ length: 30 }, (_, index) => `f${start + index}.py`)]), opened?.state ?? null);
  assert.equal(Object.keys(opened.state.servers.python.documents).length, 91);
  const found = drive(host, 'tool', { path: 'src.py', line: 0, character: 0 }, opened.state, 'definition');
  assert.equal(found.value.status, 'ready', JSON.stringify(found.value));
  assert.equal(found.value.locations.length, 20);
  const documents = Object.keys(found.state.servers.python.documents);
  assert.ok(documents.includes('src.py') && documents.length <= 96);
});

test('LSP an apply_patch that only deletes files starts no server', () => {
  const host = createHost({ files: { 'a.py': 'ok = 1\n' }, server: diagnosticServer });
  host.observe();
  const deleted = drive(host, 'tool_output', output({ input: '*** Begin Patch\n*** Delete File: gone.py\n*** End Patch' }));
  assert.equal(deleted.value, null);
  assert.ok(!host.operations.includes('process.start'));
  const mixed = drive(host, 'tool_output', output({ input: '*** Begin Patch\n*** Delete File: gone.py\n*** Update File: a.py\n*** End Patch' }));
  assert.equal(mixed.state.servers.python.running, true);
});

test('LSP server requests are answered and rename changes resolve to exact writes', () => {
  const host = createHost({ files: pair, server: actionServer });
  const first = drive(host, 'workspace_change', change(host, ['old.py', 'user.py']));
  assert.equal(first.state.servers.python.status, 'synced');
  assert.ok(host.sent.some(message => message.id === 1 && !message.method && message.result?.[0] === null));
  const rename = drive(host, 'workspace_pre_rename', { repository: '/repo', old: 'old.py', new: 'new.py', expected: hashes(host, ['old.py']) }, first.state);
  assert.equal(rename.value.status, 'ready', JSON.stringify(rename.value));
  assert.deepEqual(rename.value.writes, { 'user.py': 'from new import value\n' });
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
