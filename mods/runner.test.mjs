import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
function run(source, extra = {}) {
  const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner], {
    input: JSON.stringify({ source, filename: 'fixture.ts', capabilities: [], state: null, settings: {}, event: 'inspect', ...extra }),
    encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  return JSON.parse(result.stdout);
}
test('typed module context callback', () => {
  const reply = run('export default (api: any) => api.on("context", () => ({text:"hello"}))', { capabilities: ['context'], event: 'context' });
  assert.deepEqual(reply.value, { text: 'hello' });
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
  const reply = run(source, { capabilities: ['tools','state'], state: 9, event: 'tool', name: 'count' });
  assert.equal(reply.state, 10);
  assert.equal(reply.value, 10);
});
test('infinite loops interrupted and oversized output rejected', () => {
  assert.match(run('export default () => { while(true) {} }').error, /timed out/);
  assert.match(run('export default api => api.command("large", () => "x".repeat(70000))', {capabilities:['commands'],event:'command',name:'large'}).error, /output_limit/);
});
test('Pi 0.74 tools/commands subset uses the same registration and denial path', () => {
  const adapter = 'pi-0.74-tools-commands-v1';
  const source = `import {Type} from 'typebox'; export default pi => {
    pi.registerTool({name:'echo',label:'Echo',description:'Echo text',parameters:Type.Object({text:Type.String(),count:Type.Optional(Type.Integer())}),execute:async (id,args,signal,update,ctx)=>({content:[{type:'text',text:args.text}],details:{hasUI:ctx.hasUI}})});
    pi.registerCommand('hello',{description:'Hello',handler:async args=>({text:args})});
  }`;
  const reply = run(source, {adapter,capabilities:['tools','commands'],event:'tool',name:'echo',payload:{text:'hello'}});
  assert.deepEqual(reply.value,{content:[{type:'text',text:'hello'}],details:{hasUI:false}});
  assert.deepEqual(reply.registrations.tools[0].parameters.required,['text']);
  assert.deepEqual(run(source,{adapter,capabilities:['tools','commands'],event:'command',name:'hello',payload:'world'}).value,{text:'world'});
  assert.match(run('export default pi => pi.registerShortcut("ctrl+x",{})',{adapter}).error,/unsupported_pi_operation/);
  assert.match(run(source,{adapter}).error,/capability_denied/);
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
test('Pi labels, command descriptions, onUpdate and sendUserMessage map onto the native API', () => {
  const adapter = 'pi-0.74-tools-commands-v1';
  const source = `import {Type} from 'typebox'; export default pi => {
    pi.registerTool({name:'echo',label:'Echo',description:'Echo text',parameters:Type.Object({text:Type.String()}),execute:async (id,args,signal,update)=>{ update({content:[{type:'text',text:'working'}]}); update({content:[{type:'text',text:'almost'}]}); return {content:[{type:'text',text:args.text}],details:{}}; }});
    pi.registerCommand('ask',{description:'Ask the agent',handler:async args=>{ pi.sendUserMessage('Please ' + args); }});
    pi.registerCommand('twice',{handler:async ()=>{ pi.sendUserMessage('a'); pi.sendUserMessage('b'); }});
    pi.registerCommand('steer',{handler:async ()=>{ pi.sendUserMessage('a',{deliverAs:'steer'}); }});
  }`;
  const capabilities = ['tools', 'commands'];
  const inspect = run(source, { adapter, capabilities });
  assert.equal(inspect.registrations.tools[0].label, 'Echo');
  assert.deepEqual(inspect.registrations.commands[0], { name: 'ask', description: 'Ask the agent' });
  const tool = run(source, { adapter, capabilities, event: 'tool', name: 'echo', payload: { text: 'hello' } });
  assert.deepEqual(tool.updates, ['working', 'almost']);
  assert.deepEqual(tool.value, { content: [{ type: 'text', text: 'hello' }], details: {}, last_update: 'almost' });
  assert.deepEqual(run(source, { adapter, capabilities, event: 'command', name: 'ask', payload: 'review' }).value, { submit: 'Please review' });
  assert.match(run(source, { adapter, capabilities, event: 'command', name: 'twice', payload: '' }).error, /multiple_user_messages/);
  assert.match(run(source, { adapter, capabilities, event: 'command', name: 'steer', payload: '' }).error, /sendUserMessage.options/);
  assert.match(run('export default pi => pi.sendUserMessage("x")', { adapter }).error, /sendUserMessage outside command/);
});

test('typed middleware and services register without ambient authority', () => {
  const contract = { name: 'fixture.echo', version: '1.0.0', methods: { echo: { input: 'string', output: 'string' } } };
  const source = `export default api => {
    api.middleware('model_request', event => ({preset:event.authorized_presets[0].name}));
    api.middleware('response_stream', event => event.protected ? null : ({text:String(event.text).toUpperCase()}));
    api.middleware('tool_result', () => undefined);
    api.provide(${JSON.stringify(contract)}, {echo: input => input});
    api.command('call', () => api.services.call('fixture.echo','echo','hello'));
  }`;
  const inspect = run(source, { capabilities: ['middleware', 'services', 'commands'] });
  assert.deepEqual(inspect.registrations.services, [contract]);
  assert.deepEqual(inspect.registrations.events, ['model_request', 'response_stream', 'tool_result']);
  const request = run(source, { capabilities: ['middleware', 'services', 'commands'], event: 'model_request', payload: {authorized_presets:[{name:'sol'}]} });
  assert.deepEqual(request.value, {preset:'sol'});
  const stream = run(source, { capabilities: ['middleware', 'services', 'commands'], event: 'response_stream', payload: {protected:false,text:'hi'} });
  assert.deepEqual(stream.value, {text:'HI'});
  assert.equal(run(source, { capabilities: ['middleware', 'services', 'commands'], event: 'tool_result', payload: {} }).value, null);
  const service = run(source, { capabilities: ['middleware', 'services', 'commands'], event: 'service', name: 'fixture.echo.echo', payload: 'hello' });
  assert.equal(service.value, 'hello');
  assert.match(run(source, { capabilities: ['middleware', 'commands'], event: 'inspect' }).error, /capability_denied: services/);
});
test('independent workspace mod uses public read and transaction calls', () => {
  const source = readFileSync(new URL('./examples/workspace/index.ts', import.meta.url), 'utf8');
  const capabilities = ['workspace', 'tools', 'state'];
  const payload = { old_path: 'src/old.ts', new_path: 'src/new.ts', rewrites: { 'src/index.ts': "export * from './new';\n" } };
  const first = run(source, { capabilities, event: 'tool', name: 'move', payload });
  assert.deepEqual(first.host_call, { operation: 'workspace.read', arguments: { paths: ['src/old.ts', 'src/new.ts', 'src/index.ts'] } });
  const read = { files: {
    'src/old.ts': { text: 'export const value = 1;\n', sha256: 'old-sha' },
    'src/new.ts': null,
    'src/index.ts': { text: "export * from './old';\n", sha256: 'index-sha' },
  } };
  const receipts = [{ call: first.host_call, value: read }];
  const second = run(source, { capabilities, event: 'tool', name: 'move', payload, receipts });
  assert.deepEqual(second.host_call, { operation: 'workspace.transaction', arguments: {
    expected: { 'src/old.ts': 'old-sha', 'src/new.ts': null, 'src/index.ts': 'index-sha' },
    writes: payload.rewrites, renames: [{ old: 'src/old.ts', new: 'src/new.ts' }],
  } });
  const result = { files: { 'src/old.ts': null, 'src/new.ts': 'old-sha', 'src/index.ts': 'updated-sha' } };
  const final = run(source, { capabilities, event: 'tool', name: 'move', payload, receipts: [...receipts, { call: second.host_call, value: result }] });
  assert.deepEqual(final.value, result);
  const observed = run(source, { capabilities, event: 'workspace_write', payload: { status: 'observed', changes: [{ path: 'src/index.ts', before: 'index-sha', after: 'updated-sha' }] } });
  assert.equal(observed.state.last_write.status, 'observed');
  const renameEvent = { repository: '/tmp/project', old: 'src/old.ts', new: 'src/new.ts', expected: { 'src/old.ts': 'old-sha', 'src/new.ts': null } };
  const proposed = run(source, { capabilities, event: 'workspace_pre_rename', payload: renameEvent, settings: { companions: ['src/index.ts'] }, receipts: [{ call: { operation: 'workspace.read', arguments: { paths: ['src/old.ts', 'src/new.ts', 'src/index.ts'] } }, value: read }] });
  assert.deepEqual(proposed.value, { status: 'ready', expected: { 'src/old.ts': 'old-sha', 'src/new.ts': null, 'src/index.ts': 'index-sha' }, writes: { 'src/index.ts': "export * from './new';\n" } });
  const requested = run(source, { capabilities, event: 'tool', name: 'request_rename', payload: { old: 'src/old.ts', new: 'src/new.ts' } });
  assert.deepEqual(requested.host_call, { operation: 'workspace.request_rename', arguments: { old: 'src/old.ts', new: 'src/new.ts' } });
  assert.match(run(source, { capabilities: ['tools', 'state'] }).error, /capability_denied: workspace/);
});
test('LSP mod synchronizes writes and applies versioned rename edits through public host calls', () => {
  const source = readFileSync(new URL('./first-party/omd_lsp_sync/index.ts', import.meta.url), 'utf8');
  const capabilities = ['lifecycle', 'process', 'state', 'tools', 'workspace'];
  const repository = '/tmp/project';
  const files = {
    'pkg/old.py': { text: 'value = 1\n', sha256: 'old-hash' },
    'pkg/new.py': null,
    'pkg/__init__.py': { text: 'from .old import value as alias\n', sha256: 'barrel-hash' },
    'pkg/use.py': { text: 'from pkg.old import value as local\n', sha256: 'alias-hash' },
  };
  const uri = path => `file://${repository}/${path}`;
  let running = false;
  let rename = null;
  const server = call => {
    switch (call.operation) {
      case 'process.which': return { found: [{ name: 'pylsp', path: '/bin/pylsp', sha256: 'server-hash' }] };
      case 'process.start': running = true; return { session: 'python', running: true };
      case 'process.status': return { session: 'python', running, idle_ms: 0 };
      case 'process.stop': running = false; return { stopped: true };
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
      const output = run(source, { capabilities, event, payload, state, receipts, hook_budget_ms: 500 });
      assert.equal(output.error, undefined, output.error);
      if (!output.host_call) return output;
      receipts.push({ call: output.host_call, value: server(output.host_call) });
    }
    assert.fail('mod did not finish');
  };
  const write = replay('workspace_write', { repository, call_id: 'write-1', tool: 'apply_patch', outcome: 'success', status: 'observed', changes: [{ path: 'pkg/old.py', before: null, after: 'old-hash' }] });
  assert.equal(write.state.status, 'synced');
  assert.equal(write.state.documents['pkg/old.py'].version, 1);
  assert.equal(write.state.diagnostics['pkg/old.py'].count, 1);
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
  assert.equal(idle.state.status, 'idle');
  assert.equal(running, false);
});
test('LSP mod reports an absent server and leaves the write event recoverable', () => {
  const source = readFileSync(new URL('./first-party/omd_lsp_sync/index.ts', import.meta.url), 'utf8');
  const capabilities = ['lifecycle', 'process', 'state', 'tools', 'workspace'];
  const payload = { repository: '/tmp/project', call_id: 'write-1', tool: 'apply_patch', outcome: 'success', status: 'observed', changes: [{ path: 'sample.py', before: null, after: 'sha' }] };
  const first = run(source, { capabilities, event: 'workspace_write', payload });
  assert.deepEqual(first.host_call, { operation: 'process.which', arguments: { names: ['pylsp'] } });
  const absent = run(source, { capabilities, event: 'workspace_write', payload, receipts: [{ call: first.host_call, value: { found: [] } }] });
  assert.equal(absent.error, undefined);
  assert.equal(absent.state.status, 'fallback');
  assert.equal(absent.state.reason, 'python_server_absent');
  const broken = run('export default api => { api.on("workspace_write", () => { throw new Error("broken") }); }', { capabilities: ['workspace'], event: 'workspace_write', payload });
  assert.match(broken.error, /broken/);
});
test('workspace layout accepts bare toggles and dialog select values', () => {
  const source = readFileSync(new URL('./first-party/omd_workspace/index.ts', import.meta.url), 'utf8');
  const layout = (payload, state = null) => run(source, { capabilities: ['terminal', 'commands', 'lifecycle', 'state'], event: 'command', name: 'layout', payload, state });
  for (const [payload, key, value] of [['density compact', 'density', 'compact'], ['density full', 'density', 'full'], ['side right', 'side', 'right'], ['side left', 'side', 'left'], ['compact', 'density', 'compact'], ['right', 'side', 'right']]) {
    assert.equal(layout(payload).state[key], value, payload);
  }
  assert.equal(layout('density', { density: 'compact' }).state.density, 'full');
  assert.equal(layout('side', { side: 'right' }).state.side, 'left');
  for (const payload of ['density wide', 'side up', 'compact extra']) {
    assert.match(layout(payload).value.display, /^usage:/, payload);
  }
});
