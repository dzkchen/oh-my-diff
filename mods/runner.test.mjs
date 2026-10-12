import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { callback, runnerSync } from '../tests/mod_runner.mjs';
const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const host = readFileSync(new URL('../runtime/omd/src/mods.rs', import.meta.url), 'utf8');
const table = name => host.match(new RegExp(`pub const ${name}: &\\[[^\\]]*\\] = &\\[([\\s\\S]*?)\\];`))[1];
const currentSurface = {
  events: Object.fromEntries([...table('MOD_EVENTS').matchAll(/\("([a-z_]+)", "([a-z_.]+)"\)/g)].map(match => [match[1], match[2]])),
  replacements: [...table('MOD_REPLACEMENT_POINTS').matchAll(/"([a-z_]+)"/g)].map(match => match[1]),
  middleware: [...table('MOD_MIDDLEWARE_EVENTS').matchAll(/"([a-z_]+)"/g)].map(match => match[1]),
  intercept: Object.fromEntries([...table('MOD_INTERCEPT_SURFACES').matchAll(/\("([a-z_]+)", "([a-z_.]+)"\)/g)].map(match => [match[1], match[2]])),
  state: 'store', contracts: 'contracts',
};
const lspDirectory = new URL('./first-party/omd_lsp_sync/', import.meta.url);
const lspManifest = JSON.parse(readFileSync(new URL('mod.json', lspDirectory), 'utf8'));
const lsp = {
  source: readFileSync(new URL('index.ts', lspDirectory), 'utf8'),
  capabilities: lspManifest.capabilities,
  package: {
    filename: fileURLToPath(new URL('index.ts', lspDirectory)),
    entrypoint: 'index.ts',
    assets: Object.fromEntries(lspManifest.assets.map(name => [name, { text: readFileSync(new URL(name, lspDirectory), 'utf8'), sha256: '0'.repeat(64) }])),
  },
};
function run(source, extra = {}) {
  const result = runnerSync({ source, filename: 'fixture.ts', capabilities: [], state: null, settings: {}, event: 'inspect', surface: currentSurface, ...extra });
  assert.ifError(result.error);
  return JSON.parse(result.stdout);
}

test('UI state requires terminal authority and refuses activation and render writes', () => {
  const read = 'export default api => api.command("read", () => api.uiState.get())';
  assert.match(run(read, { capabilities: ['commands'], event: 'command', name: 'read' }).error, /capability/);
  const source = 'export default api => { api.uiState.set(1); }';
  assert.match(run(source, { capabilities: ['terminal'] }).error, /ui_state_write_unavailable/);
  const write = 'export default api => api.on("terminal", () => api.uiState.set(1))';
  assert.match(run(write, { capabilities: ['terminal'], event: 'terminal' }).error, /ui_state_write_unavailable/);
  const reply = run(read, { capabilities: ['commands', 'terminal'], event: 'command', name: 'read', ui_state: { open: true } });
  assert.deepEqual(reply.value, { open: true });
  assert.equal(reply.ui_read, true);
  assert.equal(reply.state, null);
});

test('render callbacks cannot mutate activation registrations', () => {
  const input = { component: 'tool_call' };
  for (const mutation of ["api.on('terminal', () => {})", "api.middleware('approval', () => {})", "api.replace('completion', () => {})", "api.tool({name:'late'}, () => {})", "api.command('late', () => {})"]) {
    const reply = run(`export default api => api.intercept('render', () => { ${mutation}; return {}; });`, {
      capabilities: ['terminal', 'middleware', 'approvals', 'tools', 'commands'], event: 'intercept', name: '0',
      payload: { surface: 'render', input, original: input, origin: { caller: 'engine' } },
    });
    assert.match(reply.error ?? '', /registration_outside_activation/, mutation);
  }
});

test('classic hooks cannot register handlers during callbacks', () => {
  const reply = run(`export default api => api.hook('PostToolUse', () => {
    api.hook('PostToolUse', () => api.state.set({ late: true }));
  });`, { capabilities: ['lifecycle', 'store'], event: 'tool_result', payload: { tool: 'read_file', outcome: 'succeeded' } });
  assert.match(reply.error ?? '', /hook_registration_outside_activation/);
});

test('warm renders and continuation replays restore post-activation atoms', () => {
  const input = { component: 'tool_call' };
  const request = { source: `export default api => { const value = api.atom('value', 0); value.set(value.get() + 1);
    api.intercept('render', (e, next) => e.replay ? next({ ...e, value: value.get() }) : { value: value.get() }); };`,
    filename: 'fixture.ts', capabilities: ['terminal', 'store'], state: { value: 0 }, settings: {}, surface: currentSurface,
    event: 'intercept', name: '0', serve: true, payload: { surface: 'render', input, original: input, origin: { caller: 'engine' } } };
  const suspended = { ...request, payload: { ...request.payload, input: { ...input, replay: true } } };
  const receipt = { call: { operation: 'continuation.next', arguments: { input: { ...input, replay: true, value: 1 } } }, value: { result: { value: 1 }, trace: [] } };
  const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner], {
    input: [request, request, suspended, { ...suspended, receipts: [receipt] }].map(value => JSON.stringify(value) + '\n').join(''), encoding: 'utf8', timeout: 5000,
  });
  const replies = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(replies.length, 4);
  assert.equal(replies[0].value.result.value, 1);
  assert.equal(replies[1].value.result.value, 1);
  assert.deepEqual(replies[2].host_call, receipt.call);
  assert.equal(replies[3].value.result.value, 1);
  for (const reply of replies) assert.deepEqual(reply.state, { value: 0 });
  assert.equal(result.status, 0, result.stderr);
});
test('typed module context callback', () => {
  const reply = run('export default (api: any) => api.on("context", () => ({text:"hello"}))', { capabilities: ['context'], event: 'context' });
  assert.deepEqual(reply.value, { text: 'hello' });
});
test('the test harness kills an interactive callback that never returns', () => {
  const request = { source: 'export default (api: any) => api.on("context", () => { for (;;) {} })', filename: 'fixture.ts', capabilities: ['context'], state: null, settings: {}, event: 'context', surface: currentSurface, hook_budget_ms: 50 };
  assert.throws(() => callback(request, () => null, []), /runner_timed_out/);
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
test('component module steps deliver input, ticks and one post without host authority', () => {
  const source = `export default api => api.component('dots', {
    init: props => ({ n: props.start, keys: '' }),
    key: (state, event, ui) => { if (event.key === 'Enter') ui.post({ n: state.n }); return { ...state, keys: state.keys + (event.text ?? '') }; },
    pointer: (state, event) => ({ ...state, n: state.n + (event.action === 'down' ? 10 : 0) }),
    every: { ms: 50, tick: state => ({ ...state, n: state.n + 1 }) },
    view: (state, ui) => ({ type: 'text', id: 't', label: 'dots', text: state.n + ':' + state.keys + ':' + ui.columns }),
  })`;
  const step = frame => run(source, { capabilities: ['terminal'], event: 'component', name: 'dots', payload: { instance: 'a', props: { start: 1 }, columns: 20, rows: 2, ...frame } });
  const first = step({ now: 1000, events: [{ kind: 'key', key: null, text: 'x' }, { kind: 'pointer', action: 'down', column: 0, row: 0 }, { kind: 'key', key: 'Enter', text: null }] });
  assert.deepEqual(first.value, { tree: [{ type: 'text', id: 't', label: 'dots', text: '11:x:20' }], post: { data: { n: 11 } }, next_ms: 50 });
  assert.deepEqual(first.registrations.components, ['dots']);
  assert.match(run(source, { capabilities: ['commands'] }).error, /capability_denied: terminal/);
  const writer = 'export default api => api.component("w", { view: () => { api.state.set(1); return []; } })';
  assert.match(run(writer, { capabilities: ['terminal', 'store'], event: 'component', name: 'w', payload: { now: 0, events: [] } }).error, /render_side_effect_refused/);
  const slow = 'export default api => api.component("s", { view: () => { const end = Date.now(); for (let i = 0; i < 3e7; i += 1) {} return []; } })';
  assert.match(run(slow, { capabilities: ['terminal'], event: 'component', name: 's', payload: { now: 0, events: [] } }).error, /component_overrun: s/);
  assert.match(run('export default api => api.component("x", { view: 1 })', { capabilities: ['terminal'] }).error, /handler_required: x/);
  const paused = start => `export default api => api.component("p", { init: () => ${start}, every: { ms: n => n ? null : 20, tick: n => n + 1 }, view: n => [{ type: "text", id: "n", label: "N", text: String(n) }] })`;
  const pausedStep = start => run(paused(start), { capabilities: ['terminal'], event: 'component', name: 'p', payload: { now: 100, events: [] } }).value.next_ms;
  assert.deepEqual([pausedStep(0), pausedStep(1)], [20, null]);
});
test('entrypoints import declared assets by relative path and report them', () => {
  const asset = text => ({ text, sha256: 'a'.repeat(64) });
  const assets = {
    'lib/draw.ts': asset('import { shared } from "../shared.mjs"; import table from "./table.json"; export const draw = (n: number): string => shared.mark + table.name + n;'),
    'shared.mjs': asset('export const shared = { mark: "#" };'),
    'lib/table.json': asset('{"name": "t"}'),
    'worker.mjs': asset('process.exit(0)'),
  };
  const source = 'import { draw } from "./lib/draw.ts"; import { shared } from "./shared.mjs"; export default api => api.command("draw", () => { shared.mark = "!"; return draw(1); })';
  const extra = { filename: '/pkg/index.ts', entrypoint: 'index.ts', capabilities: ['commands'], assets };
  const reply = run(source, { ...extra, event: 'command', name: 'draw' });
  assert.equal(reply.value, '!t1');
  assert.deepEqual(reply.registrations.modules.sort(), ['lib/draw.ts', 'lib/table.json', 'shared.mjs']);
  assert.match(run('import "./missing.ts"; export default () => {}', extra).error, /unsupported_import: \.\/missing\.ts/);
  assert.match(run('import "../outside.ts"; export default () => {}', extra).error, /unsupported_import/);
  const thrown = run('import { fail } from "./lib/fail.ts"; export default api => api.command("fail", fail)',
    { ...extra, assets: { 'lib/fail.ts': asset('export const fail = (): never => {\n  throw new Error("boom");\n};') }, event: 'command', name: 'fail' });
  assert.match(thrown.error, /boom[\s\S]*pkg\/lib\/fail\.ts:2:9/);
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
test('lifecycle events and interceptors require their capabilities', () => {
  const events = ['turn_start', 'turn_end', 'compaction_start', 'compaction_end', 'agent_end'];
  const lifecycle = run(`export default api => { for (const e of ${JSON.stringify(events)}) api.on(e, () => null); }`, { capabilities: ['lifecycle'] });
  assert.deepEqual(lifecycle.registrations.events, events);
  const source = 'export default api => api.intercept("*", {match: {text: /^h/}}, (e, next) => next({...e, text: e.text + "!"}))';
  assert.match(run(source, { capabilities: ['lifecycle'] }).error, /unsupported_intercept_pattern_or_capability: \*/);
  const payload = { surface: 'input', input: { text: 'hi', attachments: 0 }, origin: { caller: 'user' } };
  const extra = { capabilities: ['input'], event: 'intercept', name: '0', payload };
  const suspended = run(source, extra);
  assert.deepEqual(suspended.host_call, { operation: 'continuation.next', arguments: { input: { text: 'hi!', attachments: 0 } } });
  assert.deepEqual(suspended.registrations.interceptors, [{ pattern: '*', match: { text: { $regex: '^h', $flags: '' } }, required: false,
    before: [], after: [], catch: false, location: 'fixture.ts:1:27' }]);
  const replayed = run(source, { ...extra, receipts: [{ call: suspended.host_call, value: { result: { text: 'hi!' }, trace: [] } }] });
  assert.deepEqual(replayed.value, { result: { text: 'hi!' } });
  assert.deepEqual(run(source, { ...extra, payload: { ...payload, input: { text: 'yo', attachments: 0 } } }).value, { unmatched: true });
});
test('classic hooks map onto native events and interceptors with glob and negated matchers', () => {
  const source = `export default api => {
    api.hook('PostToolUseFailure', { match: api.match.not(api.match.glob('mcp__*')) }, e => api.state.set({ failed: e.subject, hook: e.hook, delivery: e.delivery }));
    api.hook('PostToolUse', { match: [/^read/, 'write'] }, e => api.state.set({ ok: e.subject }));
    api.hook('PreToolUse', { match: api.match.glob('exec_*'), required: true }, e => e.subject === 'exec_rm' ? { deny: 'no rm from ' + e.origin.caller } : undefined);
  }`;
  const caps = { capabilities: ['lifecycle', 'interception', 'store'] };
  const inspect = run(source, caps);
  assert.deepEqual(inspect.registrations.events, ['tool_result']);
  assert.equal(inspect.registrations.interceptors[0].required, true);
  const result = (tool, outcome) => run(source, { ...caps, event: 'tool_result', payload: { tool, outcome, thread_id: 't' } }).state;
  assert.deepEqual(result('exec_command', 'failed'), { failed: 'exec_command', hook: 'PostToolUseFailure', delivery: 'optional' });
  assert.equal(result('mcp__docs__search', 'failed'), null);
  assert.deepEqual(result('read_file', 'succeeded'), { ok: 'read_file' });
  assert.equal(result('list', 'succeeded'), null);
  const tool = name => run(source, { ...caps, event: 'intercept', name: '0',
    payload: { surface: 'tool', input: { tool: name, arguments: {} }, origin: { caller: 'model', thread_id: 't' } } });
  assert.deepEqual(tool('exec_rm').value, { result: { deny: 'no rm from model' } });
  assert.equal(tool('exec_ls').host_call.operation, 'continuation.next');
  assert.equal(tool('read_file').host_call.operation, 'continuation.next');
  assert.match(run('export default api => api.hook("Nope", () => {})', caps).error, /unsupported_classic_hook: Nope/);
  assert.match(run('export default api => api.hook("PostToolUse", { required: true }, () => {})', caps).error, /classic_hook_delivery_optional/);
  const negated = run('export default api => api.intercept("input", { match: { text: api.match.not(api.match.glob("/*")) } }, (e, next) => next(e))', { capabilities: ['input'] });
  assert.deepEqual(negated.registrations.interceptors[0].match, { text: { $not: { $glob: '/*' } } });
});

test('reactive atoms track reads, recompute derived values and run keyed subscriptions once per change', () => {
  const source = `export default api => {
    const query = api.atom('query', '');
    const total = api.member('hits', 'total', 0);
    const summary = api.derive(() => query.get() + ':' + total.get());
    api.subscribe(query, () => total.update(count => count + 1));
    api.command('search', text => { query.set(String(text)); return summary.get(); });
    api.intercept('render', { match: { component: 'spinner' } }, () => ({ tree: [{ type: 'text', id: 'q', label: 'Query', text: summary.get() }] }));
    api.intercept('render', { match: { component: 'notice' } }, () => { query.set('x'); return { tree: [] }; });
  }`;
  const capabilities = ['commands', 'store', 'terminal'];
  const searched = run(source, { capabilities, event: 'command', name: 'search', payload: 'abc' });
  assert.equal(searched.value, 'abc:0');
  assert.deepEqual(searched.state, { query: 'abc', hits: { total: 1 } });
  const repeated = run(source, { capabilities, event: 'command', name: 'search', payload: 'abc', state: searched.state });
  assert.deepEqual(repeated.state, searched.state);
  const render = (component, index, code = source) => {
    const input = { component, id: 'main', surface: 'inline', viewport: { columns: 80, rows: 24 }, lifecycle: 'live', owner: null, props: {} };
    return run(code, { capabilities, state: searched.state, event: 'intercept', name: String(index), payload: { surface: 'render', input, original: input, origin: { caller: 'engine' } } });
  };
  const drawn = render('spinner', 0);
  assert.equal(drawn.value.result.tree[0].text, 'abc:1');
  assert.deepEqual(drawn.value.reads.sort(), ['hits', 'query']);
  assert.match(render('notice', 1).error, /render_side_effect_refused/);
  const seeded = render('spinner', 0, `export default api => { const seen = api.atom('seen', 0); seen.set(1);
    api.intercept('render', () => ({ tree: [{ type: 'text', id: 's', label: 'Seen', text: String(seen.get()) }] })); }`);
  assert.equal(seeded.value.result.tree[0].text, '1');
  assert.deepEqual(seeded.state, searched.state);
  assert.match(run(source, { capabilities, state: 5, event: 'command', name: 'search', payload: 'a' }).error, /state_not_keyed/);
  assert.match(run('export default api => api.command("late", () => api.subscribe(api.atom("a", 0), () => {}))',
    { capabilities: ['commands', 'store'], event: 'command', name: 'late' }).error, /subscription_outside_activation/);
  const edge = run(`export default api => {
    const name = api.member('notes', 'constructor', 'none');
    const missing = api.derive(() => [1, 2].find(item => item === 3));
    const proto = api.atom('__proto__', 0);
    api.command('edge', () => { proto.set(7); return { name: name.get(), missing: missing.get() ?? null, proto: proto.get() }; });
  }`, { capabilities: ['commands', 'store'], event: 'command', name: 'edge', state: { notes: {} } });
  assert.deepEqual(edge.value, { name: 'none', missing: null, proto: 7 });
});

test('repeating timers stop when cancelled inside their handler and keep running after a throw', () => {
  const source = `export default api => {
    const poll = api.time.every('poll', 100, () => { if (api.state.get()?.stop) poll.cancel(); if (api.state.get()?.boom) throw new Error('boom'); });
  }`;
  const tick = (state, receipts = []) => run(source, { capabilities: ['events', 'store'], event: 'timer', payload: { key: 'time:poll' }, state, receipts });
  const stopping = tick({ stop: true });
  assert.equal(stopping.host_call.operation, 'events.cancel');
  const stopped = tick({ stop: true }, [{ call: stopping.host_call, value: null }]);
  assert.equal(stopped.host_call, null);
  assert.deepEqual(stopped.calls.map(call => call.operation), ['events.cancel']);
  const failing = tick({ boom: true });
  assert.equal(failing.host_call.operation, 'events.schedule');
  assert.equal(failing.host_call.arguments.delay_ms, 100);
  assert.match(run(source.replace("'poll', 100,", "'poll', 15,"), { capabilities: ['events', 'store'] }).error, /invalid_timer_interval/);
  assert.match(tick({ boom: true }, [{ call: failing.host_call, value: null }]).error, /boom/);
});

test('typed middleware and services register without ambient authority', () => {
  const contract = { name: 'fixture.echo', version: '1.0.0', methods: { echo: { input: 'string', output: 'string' } } };
  const source = `export default api => {
    api.middleware('tool_result', () => undefined);
    api.provide(${JSON.stringify(contract)}, {echo: input => input});
    api.command('call', () => api.services.call('fixture.echo','echo','hello'));
  }`;
  const inspect = run(source, { capabilities: ['middleware', 'services', 'commands'] });
  assert.deepEqual(inspect.registrations.services, [contract]);
  assert.deepEqual(inspect.registrations.events, ['tool_result']);
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
  const { source, capabilities } = lsp;
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
      const output = run(source, { ...lsp.package, api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event, payload, state, receipts, hook_budget_ms: 500 });
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
  const { source, capabilities } = lsp;
  const payload = { repository: '/tmp/project', call_id: 'write-1', source: 'tool', status: 'observed', changes: [{ path: 'sample.py', before: null, after: 'sha' }] };
  const first = run(source, { ...lsp.package, api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'workspace_change', payload });
  assert.deepEqual(first.host_call, { operation: 'store.get', arguments: { key: 'lsp.observed_repository', scope: 'repository' } });
  const receipts = [{ call: first.host_call, value: null }];
  const marker = run(source, { ...lsp.package, api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'workspace_change', payload, receipts });
  assert.deepEqual(marker.host_call, { operation: 'store.put', arguments: { key: 'lsp.observed_repository', scope: 'repository', expected_revision: null, value: { repository: payload.repository } } });
  receipts.push({ call: marker.host_call, value: { revision: 1 } });
  const discovery = run(source, { ...lsp.package, api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'workspace_change', payload, receipts });
  assert.deepEqual(discovery.host_call, { operation: 'process.which', arguments: { names: ['pyright-langserver', 'pylsp', 'jedi-language-server'] } });
  receipts.push({ call: discovery.host_call, value: { found: [] } });
  const published = run(source, { ...lsp.package, api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'workspace_change', payload, receipts });
  assert.equal(published.host_call.operation, 'events.publish');
  const absent = run(source, { ...lsp.package, api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'workspace_change', payload, receipts: [...receipts, { call: published.host_call, value: { delivered: 0, dropped: 0 } }] });
  assert.equal(absent.error, undefined);
  assert.equal(absent.state.servers.python.status, 'fallback');
  assert.equal(absent.state.servers.python.reason, 'python_server_absent');
  const broken = run('export default api => { api.on("workspace_change", () => { throw new Error("broken") }); }', { api: '0.2.0-experimental.5', surface: currentSurface, capabilities: ['fs.read'], event: 'workspace_change', payload });
  assert.match(broken.error, /broken/);
});
test('LSP mod retains pre-0.2 Python state when another adapter is first to update', () => {
  const { source, capabilities } = lsp;
  const state = { repository: '/tmp/project', running: true, next_id: 4, capabilities: {}, documents: { 'sample.py': { sha256: 'old-sha', version: 2 } }, diagnostics: {}, status: 'synced', reason: '' };
  const payload = { repository: '/tmp/project', call_id: 'ts-write', source: 'tool', status: 'observed', changes: [{ path: 'sample.ts', before: null, after: 'new-sha' }] };
  const first = run(source, { ...lsp.package, api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'workspace_change', payload, state });
  assert.deepEqual(first.host_call, { operation: 'store.get', arguments: { key: 'lsp.observed_repository', scope: 'repository' } });
  const receipts = [{ call: first.host_call, value: null }];
  const marker = run(source, { ...lsp.package, api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'workspace_change', payload, state, receipts });
  assert.deepEqual(marker.host_call, { operation: 'store.put', arguments: { key: 'lsp.observed_repository', scope: 'repository', expected_revision: null, value: { repository: payload.repository } } });
  receipts.push({ call: marker.host_call, value: { revision: 1 } });
  const discovery = run(source, { ...lsp.package, api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'workspace_change', payload, state, receipts });
  assert.deepEqual(discovery.host_call, { operation: 'process.which', arguments: { names: ['typescript-language-server', 'vtsls'] } });
  receipts.push({ call: discovery.host_call, value: { found: [] } });
  const published = run(source, { ...lsp.package, api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'workspace_change', payload, state, receipts });
  const absent = run(source, { ...lsp.package, api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'workspace_change', payload, state,
    receipts: [...receipts, { call: published.host_call, value: { delivered: 0, dropped: 0 } }] });
  assert.equal(absent.state.servers.python.documents['sample.py'].version, 2);
  assert.equal(absent.state.servers.python.server, 'pylsp');
  assert.equal(absent.state.servers.typescript.reason, 'typescript_server_absent');
});
test('LSP mod starts separate TypeScript, Rust, and Java adapters for mixed writes', () => {
  const { source, capabilities } = lsp;
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
    result = run(source, { ...lsp.package, api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'workspace_change', payload, receipts, hook_budget_ms: 500 });
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
  const cross = run(source, { ...lsp.package, api: '0.2.0-experimental.5', surface: currentSurface, capabilities, event: 'workspace_pre_rename',
    payload: { repository, old: 'src/app.ts', new: 'src/main.rs', expected: {} }, state: result.state });
  assert.deepEqual(cross.value, { status: 'fallback', reason: 'unsupported_language' });
});
