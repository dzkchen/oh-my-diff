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
