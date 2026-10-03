import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const host = readFileSync(new URL('../runtime/omd/src/mods.rs', import.meta.url), 'utf8');
const table = name => host.match(new RegExp(`pub const ${name}: &\\[[^\\]]*\\] = &\\[([\\s\\S]*?)\\];`))[1];
const currentSurface = {
  events: Object.fromEntries([...table('MOD_EVENTS').matchAll(/\("([a-z_]+)", "([a-z_.]+)"\)/g)].map(match => [match[1], match[2]])),
  replacements: [...table('MOD_REPLACEMENT_POINTS').matchAll(/"([a-z_]+)"/g)].map(match => match[1]),
  middleware: [...table('MOD_MIDDLEWARE_EVENTS').matchAll(/"([a-z_]+)"/g)].map(match => match[1]),
  state: 'store', contracts: 'contracts',
};
function run(source, extra = {}) {
  const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner], {
    input: JSON.stringify({ source, filename: 'fixture.ts', capabilities: [], state: null, settings: {}, event: 'inspect', surface: currentSurface, ...extra }),
    encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  return JSON.parse(result.stdout);
}
test('typed module context callback', () => {
  const reply = run('export default (api: any) => api.on("context", () => ({text:"hello"}))', { capabilities: ['context'], event: 'context' });
  assert.deepEqual(reply.value, { text: 'hello' });
});
test('package text assets are read only and limited to the selected package', () => {
  const source = 'export default api => api.command("asset", () => api.assets.read("worker.mjs"))';
  const assets = { 'worker.mjs': { text: 'export default 1', sha256: 'a'.repeat(64) } };
  const reply = run(source, { capabilities: ['commands'], assets, event: 'command', name: 'asset' });
  assert.deepEqual(reply.value, assets['worker.mjs']);
  assert.match(run(source, { capabilities: ['commands'], event: 'command', name: 'asset' }).error, /package_asset_unavailable/);
  const own = run('export default api => api.command("own", () => api.assets.read("index.ts"))',
    { capabilities: ['commands'], entrypoint: 'index.ts', entrypoint_sha256: 'b'.repeat(64), event: 'command', name: 'own' });
  assert.equal(own.value.sha256, 'b'.repeat(64));
  assert.match(own.value.text, /api\.assets\.read/);
});
test('capability and imports fail visibly', () => {
  assert.match(run('export default api => api.on("context", () => null)').error, /capability_denied/);
  assert.match(run('import fs from "node:fs"; export default () => {}').error, /unsupported_import/);
  assert.match(run('export default api => api.unsupported("provider.register")').error, /unsupported_operation/);
});
test('no ambient process, fetch, or code generation', () => {
  for (const expression of ['process.env', 'fetch("https://example.org")', 'Function("return process")()']) {
    assert.ok(run(`export default () => { ${expression} }`).error);
  }
});
test('duplicate registrations rejected', () => {
  assert.match(run('export default api => { api.command("a", () => null); api.command("a", () => null) }', { capabilities: ['commands'] }).error, /conflict/);
});
test('persistent state passed through tool invocation', () => {
  const source = 'export default api => api.tool({ name:"count", description:"count", parameters:{type:"object",properties:{}} }, () => { api.state.set(api.state.get()+1); return api.state.get(); })';
  const reply = run(source, { capabilities: ['tools','store'], state: 9, event: 'tool', name: 'count' });
  assert.equal(reply.state, 10);
  assert.equal(reply.value, 10);
});
test('infinite loops interrupted and oversized output rejected', () => {
  assert.match(run('export default () => { while(true) {} }').error, /timed out/);
  assert.match(run('export default api => api.command("large", () => "x".repeat(270000))', {capabilities:['commands'],event:'command',name:'large'}).error, /output_limit/);
});
test('commands carry descriptions and tools carry labels and bounded progress', () => {
  const source = `export default api => {
    api.command('reset', () => ({display:'done'}), {description:'Reset state'});
    api.tool({name:'work',label:'Work hard',description:'Work',parameters:{type:'object',properties:{}}}, () => { api.progress('half'); api.progress('all'); return 1; });
    api.command('bad', () => api.progress('no'));
  }`;
  const inspect = run(source, { capabilities: ['commands', 'tools'] });
  assert.deepEqual(inspect.registrations.commands, [{ name: 'reset', description: 'Reset state' }, { name: 'bad' }]);
  assert.equal(inspect.registrations.tools[0].label, 'Work hard');
  const tool = run(source, { capabilities: ['commands', 'tools'], event: 'tool', name: 'work', payload: {} });
  assert.deepEqual(tool.updates, ['half', 'all']);
  assert.match(run(source, { capabilities: ['commands', 'tools'], event: 'command', name: 'bad' }).error, /progress_outside_tool/);
  assert.match(run('export default api => api.command("x", () => null, {hidden:true})', { capabilities: ['commands'] }).error, /unsupported_command_option/);
});
test('input and lifecycle events require their capabilities', () => {
  const events = ['turn_start', 'turn_end', 'compaction_start', 'compaction_end', 'agent_end'];
  const lifecycle = run(`export default api => { for (const e of ${JSON.stringify(events)}) api.on(e, () => null); }`, { capabilities: ['lifecycle'] });
  assert.deepEqual(lifecycle.registrations.events, events);
  assert.match(run('export default api => api.replace("input", () => null)', { capabilities: ['lifecycle'] }).error, /capability_denied: input/);
  const input = run('export default api => api.replace("input", ({text}) => ({text: text + "!"}))', { capabilities: ['input'], event: 'input', payload: { text: 'hi', attachments: 0 } });
  assert.deepEqual(input.value, { text: 'hi!' });
  assert.deepEqual(input.registrations.replacements, ['input']);
});

test('typed middleware and services register without ambient authority', () => {
  const contract = { name: 'fixture.echo', version: '1.0.0', methods: { echo: { input: 'string', output: 'string' } } };
  const source = `export default api => {
    api.middleware('model_request', event => ({route:event.routes[0].name}));
    api.middleware('response_stream', event => event.protected ? null : ({text:String(event.text).toUpperCase()}));
    api.middleware('tool_result', () => undefined);
    api.provide(${JSON.stringify(contract)}, {echo: input => input});
    api.command('call', () => api.services.call('fixture.echo','echo','hello'));
  }`;
  const inspect = run(source, { capabilities: ['middleware', 'services', 'commands'] });
  assert.deepEqual(inspect.registrations.services, [contract]);
  assert.deepEqual(inspect.registrations.events, ['model_request', 'response_stream', 'tool_result']);
  const request = run(source, { capabilities: ['middleware', 'services', 'commands'], event: 'model_request', payload: {routes:[{name:'sol'}]} });
  assert.deepEqual(request.value, {route:'sol'});
  const stream = run(source, { capabilities: ['middleware', 'services', 'commands'], event: 'response_stream', payload: {protected:false,text:'hi'} });
  assert.deepEqual(stream.value, {text:'HI'});
  assert.equal(run(source, { capabilities: ['middleware', 'services', 'commands'], event: 'tool_result', payload: {} }).value, null);
  const service = run(source, { capabilities: ['middleware', 'services', 'commands'], event: 'service', name: 'fixture.echo.echo', payload: 'hello' });
  assert.equal(service.value, 'hello');
  assert.match(run(source, { capabilities: ['middleware', 'commands'], event: 'inspect' }).error, /capability_denied: services/);
});
test('independent workspace mod uses public read and transaction calls', () => {
  const source = readFileSync(new URL('./examples/workspace/index.ts', import.meta.url), 'utf8');
  const capabilities = ['fs.read', 'fs.write', 'tools', 'store'];
  const payload = { old_path: 'src/old.ts', new_path: 'src/new.ts', rewrites: { 'src/index.ts': "export * from './new';\n" } };
  const first = run(source, { api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'tool', name: 'move', payload });
  assert.deepEqual(first.host_call, { operation: 'workspace.read', arguments: { paths: ['src/old.ts', 'src/new.ts', 'src/index.ts'] } });
  const read = { files: {
    'src/old.ts': { text: 'export const value = 1;\n', sha256: 'old-sha' },
    'src/new.ts': null,
    'src/index.ts': { text: "export * from './old';\n", sha256: 'index-sha' },
  } };
  const receipts = [{ call: first.host_call, value: read }];
  const second = run(source, { api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'tool', name: 'move', payload, receipts });
  assert.deepEqual(second.host_call, { operation: 'workspace.transaction', arguments: {
    expected: { 'src/old.ts': 'old-sha', 'src/new.ts': null, 'src/index.ts': 'index-sha' },
    writes: payload.rewrites, renames: [{ old: 'src/old.ts', new: 'src/new.ts' }],
  } });
  const result = { files: { 'src/old.ts': null, 'src/new.ts': 'old-sha', 'src/index.ts': 'updated-sha' } };
  const final = run(source, { api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'tool', name: 'move', payload, receipts: [...receipts, { call: second.host_call, value: result }] });
  assert.deepEqual(final.value, result);
  const observed = run(source, { api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'workspace_change', payload: { status: 'observed', changes: [{ path: 'src/index.ts', before: 'index-sha', after: 'updated-sha' }] } });
  assert.equal(observed.state.last_write.status, 'observed');
  const renameEvent = { repository: '/tmp/project', old: 'src/old.ts', new: 'src/new.ts', expected: { 'src/old.ts': 'old-sha', 'src/new.ts': null } };
  const proposed = run(source, { api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'workspace_pre_rename', payload: renameEvent, settings: { companions: ['src/index.ts'] }, receipts: [{ call: { operation: 'workspace.read', arguments: { paths: ['src/old.ts', 'src/new.ts', 'src/index.ts'] } }, value: read }] });
  assert.deepEqual(proposed.value, { status: 'ready', expected: { 'src/old.ts': 'old-sha', 'src/new.ts': null, 'src/index.ts': 'index-sha' }, writes: { 'src/index.ts': "export * from './new';\n" } });
  const requested = run(source, { api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'tool', name: 'request_rename', payload: { old: 'src/old.ts', new: 'src/new.ts' } });
  assert.deepEqual(requested.host_call, { operation: 'workspace.request_rename', arguments: { old: 'src/old.ts', new: 'src/new.ts' } });
  assert.match(run(source, { api: '0.2.0-experimental.5', surface: currentSurface, capabilities: ['tools', 'store'] }).error, /capability_denied: fs.read/);
});
test('LSP mod synchronizes writes and applies versioned rename edits through public host calls', () => {
  const source = readFileSync(new URL('./first-party/omd_lsp_sync/index.ts', import.meta.url), 'utf8');
  const { capabilities } = JSON.parse(readFileSync(new URL('./first-party/omd_lsp_sync/mod.json', import.meta.url), 'utf8'));
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
        assert.deepEqual(call.arguments, { key: 'lsp.observed_repository', scope: 'repository' });
        return observedRepository;
      case 'store.put':
        assert.deepEqual(call.arguments, { key: 'lsp.observed_repository', scope: 'repository', expected_revision: null, value: { repository } });
        observedRepository = { revision: 1, value: call.arguments.value };
        return { revision: 1 };
      case 'process.which': return { found: [{ name: 'pylsp', path: '/bin/pylsp', sha256: 'server-hash' }] };
      case 'process.start': running = true; return { session: 'python', running: true };
      case 'process.status': return { session: 'python', running, idle_ms: idleMs };
      case 'process.stop': running = false; return { stopped: true };
      case 'events.publish': return { delivered: 0, dropped: 0 };
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
  const replay = (event, payload, state = null) => {
    const receipts = [];
    for (let index = 0; index < 24; index++) {
      const output = run(source, { api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event, payload, state, receipts, hook_budget_ms: 500 });
      assert.equal(output.error, undefined, output.error);
      if (!output.host_call) return output;
      receipts.push({ call: output.host_call, value: server(output.host_call) });
    }
    assert.fail('mod did not finish');
  };
  const write = replay('workspace_change', { repository, call_id: 'write-1', source: 'tool', status: 'observed', changes: [{ path: 'pkg/old.py', before: null, after: 'old-hash' }] });
  assert.equal(write.state.servers.python.status, 'synced');
  assert.equal(write.state.servers.python.documents['pkg/old.py'].version, 1);
  assert.equal(write.state.servers.python.diagnostics['pkg/old.py'].count, 1);
  rename = { documentChanges: [
    { textDocument: { uri: uri('pkg/__init__.py'), version: null }, edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, newText: 'new' }] },
    { textDocument: { uri: uri('pkg/use.py'), version: null }, edits: [{ range: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } }, newText: 'new' }] },
  ] };
  const requested = replay('workspace_pre_rename', { repository, old: 'pkg/old.py', new: 'pkg/new.py', expected: { 'pkg/old.py': 'old-hash', 'pkg/new.py': null } }, write.state);
  assert.deepEqual(requested.value, { status: 'ready', expected: { 'pkg/old.py': 'old-hash', 'pkg/new.py': null, 'pkg/__init__.py': 'barrel-hash', 'pkg/use.py': 'alias-hash' }, writes: { 'pkg/__init__.py': 'from .new import value as alias\n', 'pkg/use.py': 'from pkg.new import value as local\n' } });
  rename.documentChanges[0].textDocument.version = 9;
  const stale = replay('workspace_pre_rename', { repository, old: 'pkg/old.py', new: 'pkg/new.py', expected: { 'pkg/old.py': 'old-hash', 'pkg/new.py': null } }, write.state);
  assert.deepEqual(stale.value, { status: 'fallback', reason: 'server_rename_document_stale' });
  const idle = replay('idle', {}, requested.state);
  assert.equal(idle.state.servers.python.running, true);
  assert.equal(running, true);
  idleMs = 16 * 60_000;
  const expired = replay('idle', {}, requested.state);
  assert.equal(expired.state.servers.python.status, 'idle');
  assert.equal(running, false);
});
test('LSP mod reports an absent server and leaves the write event recoverable', () => {
  const source = readFileSync(new URL('./first-party/omd_lsp_sync/index.ts', import.meta.url), 'utf8');
  const { capabilities } = JSON.parse(readFileSync(new URL('./first-party/omd_lsp_sync/mod.json', import.meta.url), 'utf8'));
  const payload = { repository: '/tmp/project', call_id: 'write-1', source: 'tool', status: 'observed', changes: [{ path: 'sample.py', before: null, after: 'sha' }] };
  const first = run(source, { api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'workspace_change', payload });
  assert.deepEqual(first.host_call, { operation: 'store.get', arguments: { key: 'lsp.observed_repository', scope: 'repository' } });
  const receipts = [{ call: first.host_call, value: null }];
  const marker = run(source, { api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'workspace_change', payload, receipts });
  assert.deepEqual(marker.host_call, { operation: 'store.put', arguments: { key: 'lsp.observed_repository', scope: 'repository', expected_revision: null, value: { repository: payload.repository } } });
  receipts.push({ call: marker.host_call, value: { revision: 1 } });
  const discovery = run(source, { api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'workspace_change', payload, receipts });
  assert.deepEqual(discovery.host_call, { operation: 'process.which', arguments: { names: ['pyright-langserver', 'pylsp', 'jedi-language-server'] } });
  receipts.push({ call: discovery.host_call, value: { found: [] } });
  const published = run(source, { api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'workspace_change', payload, receipts });
  assert.equal(published.host_call.operation, 'events.publish');
  const absent = run(source, { api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'workspace_change', payload, receipts: [...receipts, { call: published.host_call, value: { delivered: 0, dropped: 0 } }] });
  assert.equal(absent.error, undefined);
  assert.equal(absent.state.servers.python.status, 'fallback');
  assert.equal(absent.state.servers.python.reason, 'python_server_absent');
  const broken = run('export default api => { api.on("workspace_change", () => { throw new Error("broken") }); }', { api: '0.2.0-experimental.5', surface: currentSurface, capabilities: ['fs.read'], event: 'workspace_change', payload });
  assert.match(broken.error, /broken/);
});
test('LSP mod retains pre-0.2 Python state when another adapter is first to update', () => {
  const source = readFileSync(new URL('./first-party/omd_lsp_sync/index.ts', import.meta.url), 'utf8');
  const { capabilities } = JSON.parse(readFileSync(new URL('./first-party/omd_lsp_sync/mod.json', import.meta.url), 'utf8'));
  const state = { repository: '/tmp/project', running: true, next_id: 4, capabilities: {}, documents: { 'sample.py': { sha256: 'old-sha', version: 2 } }, diagnostics: {}, status: 'synced', reason: '' };
  const payload = { repository: '/tmp/project', call_id: 'ts-write', source: 'tool', status: 'observed', changes: [{ path: 'sample.ts', before: null, after: 'new-sha' }] };
  const first = run(source, { api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'workspace_change', payload, state });
  assert.deepEqual(first.host_call, { operation: 'store.get', arguments: { key: 'lsp.observed_repository', scope: 'repository' } });
  const receipts = [{ call: first.host_call, value: null }];
  const marker = run(source, { api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'workspace_change', payload, state, receipts });
  assert.deepEqual(marker.host_call, { operation: 'store.put', arguments: { key: 'lsp.observed_repository', scope: 'repository', expected_revision: null, value: { repository: payload.repository } } });
  receipts.push({ call: marker.host_call, value: { revision: 1 } });
  const discovery = run(source, { api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'workspace_change', payload, state, receipts });
  assert.deepEqual(discovery.host_call, { operation: 'process.which', arguments: { names: ['typescript-language-server', 'vtsls'] } });
  receipts.push({ call: discovery.host_call, value: { found: [] } });
  const published = run(source, { api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'workspace_change', payload, state, receipts });
  const absent = run(source, { api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'workspace_change', payload, state,
    receipts: [...receipts, { call: published.host_call, value: { delivered: 0, dropped: 0 } }] });
  assert.equal(absent.state.servers.python.documents['sample.py'].version, 2);
  assert.equal(absent.state.servers.python.server, 'pylsp');
  assert.equal(absent.state.servers.typescript.reason, 'typescript_server_absent');
});
test('LSP mod starts separate TypeScript, Rust, and Java adapters for mixed writes', () => {
  const source = readFileSync(new URL('./first-party/omd_lsp_sync/index.ts', import.meta.url), 'utf8');
  const { capabilities } = JSON.parse(readFileSync(new URL('./first-party/omd_lsp_sync/mod.json', import.meta.url), 'utf8'));
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
      assert.deepEqual(call.arguments, { key: 'lsp.observed_repository', scope: 'repository' });
      return observedRepository;
    }
    if (call.operation === 'store.put') {
      assert.deepEqual(call.arguments, { key: 'lsp.observed_repository', scope: 'repository', expected_revision: null, value: { repository } });
      observedRepository = { revision: 1, value: call.arguments.value };
      return { revision: 1 };
    }
    if (call.operation === 'process.which') return { found: call.arguments.names.filter(name => ['typescript-language-server', 'rust-analyzer', 'jdtls'].includes(name)).map(name => ({ name, path: `/bin/${name}`, sha256: `${name}-sha` })) };
    if (call.operation === 'process.start') { started.push(call.arguments); return { session: call.arguments.session, running: true }; }
    if (call.operation === 'process.stop') return { stopped: false };
    if (call.operation === 'events.publish') return { delivered: 0, dropped: 0 };
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
  const receipts = [];
  let result;
  for (let index = 0; index < 32; index++) {
    result = run(source, { api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'workspace_change', payload, receipts, hook_budget_ms: 500 });
    assert.equal(result.error, undefined, result.error);
    if (!result.host_call) break;
    receipts.push({ call: result.host_call, value: server(result.host_call) });
  }
  assert.equal(result.host_call, null, 'mixed adapter run did not finish');
  assert.deepEqual(started.map(item => [item.session, item.name, item.arguments]), [
    ['typescript', 'typescript-language-server', ['--stdio']], ['rust', 'rust-analyzer', []], ['java', 'jdtls', ['--jvm-arg=-Duser.home={process.home}']],
  ]);
  assert.deepEqual(opened.map(item => item.slice(0, 2)), [['typescript', 'typescript'], ['typescript', 'javascript'], ['rust', 'rust'], ['java', 'java']]);
  assert.equal(result.state.servers.typescript.documents['src/helper.js'].version, 1);
  assert.equal(result.state.servers.rust.documents['src/main.rs'].version, 1);
  assert.equal(result.state.servers.java.documents['src/Main.java'].version, 1);
  const cross = run(source, { api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'workspace_pre_rename',
    payload: { repository, old: 'src/app.ts', new: 'src/main.rs', expected: {} }, state: result.state });
  assert.deepEqual(cross.value, { status: 'fallback', reason: 'unsupported_language' });
});
const debuggerSource = readFileSync(new URL('../plugins/optional/plugins/omd-debugger/mod/index.ts', import.meta.url), 'utf8');
const debugpyProbe = { exit_code: 0, stdout: '1.8.22\n', stderr: '' };
test('optional API 0.2 debugger: DAP control and inspection on managed process calls', () => {
  const source = debuggerSource;
  const capabilities = ['tools', 'exec', 'store', 'lifecycle', 'network'];
  const calls = [];
  const server = call => {
    calls.push(call);
    if (call.operation === 'process.which') return { found: [{ name: 'python3', path: '/usr/bin/python3', sha256: 'adapter-hash' }] };
    if (call.operation === 'exec.run') return debugpyProbe;
    if (call.operation === 'process.start') return { session: 'debug', running: true };
    if (call.operation === 'process.status') return { session: 'debug', running: true, idle_ms: 0 };
    if (call.operation === 'process.stop') return { stopped: true };
    if (call.operation === 'process.exchange') {
      const request = call.arguments.send?.[0];
      if (!request) return { session: 'debug', running: true, messages: [] };
      const body = request.command === 'setBreakpoints' ? { breakpoints: [{ verified: true, line: 4 }] }
        : request.command === 'stackTrace' ? { stackFrames: [{ id: 7, name: 'main', source: { path: '/tmp/project/bug.py' }, line: 4, column: 1 }], totalFrames: 1 }
          : request.command === 'scopes' ? { scopes: [{ name: 'Locals', variablesReference: 4, expensive: false }] }
            : request.command === 'variables' ? { variables: [{ name: 'denominator', value: '0', type: 'int', variablesReference: 0 }] }
              : request.command === 'evaluate' ? { result: '0', type: 'int', variablesReference: 0 } : {};
      const events = request.command === 'launch' ? [{ type: 'event', event: 'initialized' }]
        : request.command === 'configurationDone' || request.command === 'next' ? [{ type: 'event', event: 'stopped', body: { threadId: 3, reason: 'breakpoint' } }] : [];
      return { session: 'debug', running: true, messages: [{ type: 'response', request_seq: request.seq, success: true, body }, ...events] };
    }
    throw new Error(`unexpected ${call.operation}`);
  };
  const replay = (name, payload, state = null) => {
    const receipts = [];
    for (let index = 0; index < 20; index++) {
      const output = run(source, { capabilities, event: 'tool', name, payload, state, receipts, hook_budget_ms: 500 });
      assert.equal(output.error, undefined, output.error);
      if (!output.host_call) return output;
      receipts.push({ call: output.host_call, value: server(output.host_call) });
    }
    assert.fail('debugger mod did not finish');
  };
  const opened = replay('open', { adapter: 'debugpy' });
  assert.deepEqual(opened.value, { adapter: 'debugpy', status: 'initialized', python: '/usr/bin/python3', debugpy: '1.8.22' });
  const started = replay('start', { mode: 'launch', program: '/tmp/project/bug.py' }, opened.state);
  assert.equal(started.state.ready, true);
  const breakpoint = replay('breakpoints', { source: '/tmp/project/bug.py', lines: [4] }, started.state);
  assert.equal(breakpoint.value.result.breakpoints[0].verified, true);
  const configured = replay('configure', {}, breakpoint.state);
  assert.equal(configured.state.phase, 'stopped');
  const frames = replay('inspect', { command: 'stackTrace' }, configured.state);
  assert.equal(frames.value.result.frames[0].line, 4);
  const scopes = replay('inspect', { command: 'scopes', frame_id: 7 }, frames.state);
  assert.equal(scopes.value.result.scopes[0].variablesReference, 4);
  const variables = replay('inspect', { command: 'variables', variables_reference: 4 }, scopes.state);
  assert.equal(variables.value.result.variables[0].name, 'denominator');
  const evaluated = replay('inspect', { command: 'evaluate', frame_id: 7, expression: 'denominator' }, variables.state);
  assert.equal(evaluated.value.result.result, '0');
  const stepped = replay('control', { command: 'next' }, evaluated.state);
  assert.equal(stepped.state.phase, 'stopped');
  const detached = replay('detach', {}, stepped.state);
  assert.equal(detached.state.running, false);
  assert.equal(calls.find(call => call.operation === 'process.start').arguments.framing, 'content-length');
  assert.equal(calls.find(call => call.operation === 'process.start').arguments.network, 'loopback');
  assert.equal(calls.at(-1).operation, 'process.stop');
  assert.equal(calls.some(call => call.operation === 'process.exchange' && call.arguments.send?.[0]?.command === 'attach'), false);
  assert.deepEqual(run(source, { capabilities, event: 'tool', name: 'open', payload: { adapter: 'lldb' } }).value, { error: 'invalid_adapter' });
  assert.deepEqual(replay('start', { mode: 'attach', process_id: 42 }, opened.state).value, { error: 'invalid_mode' });
});
test('optional API 0.2 debugger: stop events after the control response', () => {
  const source = debuggerSource;
  const capabilities = ['tools', 'exec', 'store', 'lifecycle', 'network'];
  let queued = [];
  const server = call => {
    if (call.operation !== 'process.exchange') throw new Error(`unexpected ${call.operation}`);
    const request = call.arguments.send?.[0];
    if (!request) {
      const messages = queued;
      queued = [];
      return { session: 'debug', running: true, messages };
    }
    if (['configurationDone', 'next', 'continue'].includes(request.command)) {
      queued = [{ type: 'event', event: 'continued', body: { threadId: 3 } }, { type: 'event', event: 'stopped', body: { threadId: 3, reason: 'step' } }];
    }
    const body = request.command === 'stackTrace' ? { stackFrames: [{ id: 7, name: 'main', source: { path: '/tmp/bug.py' }, line: 5, column: 1 }], totalFrames: 1 } : {};
    return { session: 'debug', running: true, messages: [{ type: 'response', request_seq: request.seq, success: true, body }] };
  };
  const replay = (name, payload, state) => {
    const receipts = [];
    for (let index = 0; index < 24; index++) {
      const output = run(source, { capabilities, event: 'tool', name, payload, state, receipts, hook_budget_ms: 500 });
      assert.equal(output.error, undefined, output.error);
      if (!output.host_call) return output;
      receipts.push({ call: output.host_call, value: server(output.host_call) });
    }
    assert.fail('debugger mod did not finish');
  };
  const configuring = { adapter: 'debugpy', executable: '/usr/bin/python3', running: true, ready: true, mode: 'launch', phase: 'configuring', next_seq: 3, launch_seq: null, thread_id: null, reason: '' };
  const configured = replay('configure', {}, configuring);
  assert.equal(configured.state.phase, 'stopped');
  const stepped = replay('control', { command: 'next' }, configured.state);
  assert.equal(stepped.state.phase, 'stopped');
  assert.equal(stepped.state.reason, 'step');
  queued = [{ type: 'event', event: 'stopped', body: { threadId: 3, reason: 'breakpoint' } }];
  const running = { ...stepped.state, phase: 'active' };
  const frames = replay('inspect', { command: 'stackTrace' }, running);
  assert.equal(frames.value.result.frames[0].line, 5);
  assert.equal(frames.state.reason, 'breakpoint');
});
test('optional API 0.2 debugger: refused asynchronous launch', () => {
  const source = debuggerSource;
  const capabilities = ['tools', 'exec', 'store', 'lifecycle', 'network'];
  const initial = { adapter: 'debugpy', executable: '/usr/bin/python3', running: true, ready: false, mode: null, phase: 'initialized', next_seq: 2, launch_seq: null, thread_id: null, reason: '' };
  const sent = run(source, { capabilities, event: 'tool', name: 'start', payload: { mode: 'launch', program: '/repo/bug.py' }, state: initial,
    receipts: [{ call: { operation: 'process.exchange', arguments: { session: 'debug', send: [{ seq: 2, type: 'request', command: 'launch', arguments: { program: '/repo/bug.py', python: '/usr/bin/python3', args: [], stopOnEntry: true, justMyCode: false, redirectOutput: false } }], wait_ms: 0 } }, value: { session: 'debug', running: true, messages: [] } }] });
  assert.equal(sent.state.launch_seq, 2);
  assert.equal(sent.state.phase, 'configuring');
  const response = { type: 'response', request_seq: 2, command: 'launch', success: false, message: 'TOP_SECRET' };
  const first = run(source, { capabilities, event: 'tool', name: 'status', payload: {}, state: sent.state });
  assert.deepEqual(first.host_call, { operation: 'process.exchange', arguments: { session: 'debug', send: [], wait_ms: 250 } });
  const second = run(source, { capabilities, event: 'tool', name: 'status', payload: {}, state: sent.state, receipts: [{ call: first.host_call, value: { session: 'debug', running: true, messages: [response] } }] });
  assert.deepEqual(second.host_call, { operation: 'process.stop', arguments: { session: 'debug' } });
  const stopped = run(source, { capabilities, event: 'tool', name: 'status', payload: {}, state: sent.state, receipts: [
    { call: first.host_call, value: { session: 'debug', running: true, messages: [response] } },
    { call: second.host_call, value: { stopped: true } },
  ] });
  assert.equal(stopped.state.running, false);
  assert.equal(stopped.value.reason, 'adapter_launch_refused');
  assert.equal(JSON.stringify(stopped).includes('TOP_SECRET'), false);
  const receipts = [];
  let reopened;
  for (let attempt = 0; attempt < 8; attempt++) {
    reopened = run(source, { capabilities, event: 'tool', name: 'open', payload: { adapter: 'debugpy' }, state: stopped.state, receipts });
    if (!reopened.host_call) break;
    const call = reopened.host_call;
    const value = call.operation === 'process.which' ? { found: [{ name: 'python3', path: '/usr/bin/python3', sha256: 'adapter-hash' }] }
      : call.operation === 'exec.run' ? debugpyProbe
      : call.operation === 'process.start' ? { session: 'debug', running: true }
        : { session: 'debug', running: true, messages: [{ type: 'response', request_seq: 1, command: 'initialize', success: true, body: {} }] };
    receipts.push({ call, value });
  }
  assert.equal(reopened.value.status, 'initialized');
  assert.equal(reopened.state.running, true);
  assert.equal(reopened.state.reason, '');
  assert.deepEqual(receipts.map(receipt => receipt.call.operation), ['process.which', 'exec.run', 'process.start', 'process.exchange']);
});
test('optional API 0.2 debugger: setup, cancellation, turn end and resume', () => {
  const capabilities = ['tools', 'exec', 'store', 'lifecycle', 'network'];
  const which = { call: { operation: 'process.which', arguments: { names: ['python3'] } }, value: { found: [{ name: 'python3', path: '/usr/bin/python3', sha256: 'adapter-hash' }] } };
  const probe = run(debuggerSource, { capabilities, event: 'tool', name: 'open', payload: { adapter: 'debugpy' }, receipts: [which] }).host_call;
  const missing = run(debuggerSource, { capabilities, event: 'tool', name: 'open', payload: { adapter: 'debugpy' },
    receipts: [which, { call: probe, value: { exit_code: 1, stdout: '', stderr: "ModuleNotFoundError: No module named 'debugpy' TOP_SECRET" } }] });
  assert.deepEqual(missing.value, { error: 'adapter_dependency_absent', adapter: 'debugpy', dependency: 'debugpy', python: '/usr/bin/python3' });
  assert.ok(!missing.host_call);
  const live = { adapter: 'debugpy', executable: '/usr/bin/python3', debugpy: '1.8.22', running: true, ready: true, mode: 'launch', next_seq: 9, launch_seq: null, thread_id: 3 };
  const lifecycle = (event, payload, phase, messages = []) => {
    const state = { ...live, phase, reason: '' };
    const receipts = [];
    for (;;) {
      const output = run(debuggerSource, { capabilities, event, payload, state, receipts });
      if (!output.host_call) return output.state ?? state;
      const { operation } = output.host_call;
      receipts.push({ call: output.host_call, value: operation === 'process.exchange' ? { session: 'debug', running: true, messages } : { stopped: false } });
    }
  };
  assert.equal(lifecycle('idle', { cause: 'Completed' }, 'stopped').running, true);
  assert.equal(lifecycle('idle', { cause: 'Completed' }, 'active').reason, 'target_running_at_turn_end');
  assert.equal(lifecycle('idle', { cause: 'Completed' }, 'active', [{ type: 'event', event: 'stopped', body: { threadId: 3, reason: 'breakpoint' } }]).phase, 'stopped');
  assert.equal(lifecycle('idle', { cause: 'Interrupted' }, 'stopped').reason, 'cancelled');
  assert.equal(lifecycle('resume', { thread_id: 't', last_turn: null, restarted: true }, 'stopped').reason, 'session_resumed');
});
test('workspace layout writes bare toggles and dialog select values as settings', () => {
  const source = readFileSync(new URL('./first-party/omd_workspace/index.ts', import.meta.url), 'utf8');
  const layout = (payload, settings = {}) => run(source, { capabilities: ['terminal', 'commands', 'lifecycle', 'store', 'threads', 'config'], event: 'command', name: 'layout', payload, settings });
  for (const [payload, key, value] of [['density compact', 'density', 'compact'], ['density full', 'density', 'full'], ['side right', 'side', 'right'], ['side left', 'side', 'left'], ['compact', 'density', 'compact'], ['right', 'side', 'right']]) {
    assert.deepEqual(layout(payload).host_call, { operation: 'settings.write', arguments: { values: { [key]: value } } }, payload);
  }
  assert.deepEqual(layout('density', { density: 'compact' }).host_call.arguments, { values: { density: 'full' } });
  assert.deepEqual(layout('side', { side: 'right' }).host_call.arguments, { values: { side: 'left' } });
  for (const payload of ['density wide', 'side up', 'compact extra']) {
    assert.match(layout(payload).value.display, /^usage:/, payload);
  }
});
