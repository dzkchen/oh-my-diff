import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
function run(source, extra = {}) {
  const result = runnerSync({ source, filename: 'fixture.ts', capabilities: [], state: null, settings: {}, event: 'inspect', surface: currentSurface, ...extra });
  assert.ifError(result.error);
  return JSON.parse(result.stdout);
}

test('UI state serialized boundaries agree with the native validator', () => {
  const cases = JSON.parse(readFileSync(new URL('../runtime/omd/tests/fixtures/ui_state.json', import.meta.url)));
  for (const entry of cases) {
    const encoded = entry.prefix + entry.unit.repeat(entry.repeat) + entry.suffix;
    const reply = run('export default api => api.command("write", value => api.uiState.set(JSON.parse(value)))',
      { capabilities: ['terminal', 'commands'], event: 'command', name: 'write', payload: encoded });
    assert.equal(!reply.error, entry.valid, `${entry.name}: ${reply.error}`);
  }
});

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
test('a callback clock stands still except across its own sleeps', () => {
  const source = 'export default api => api.command("wait", async () => { const start = Date.now(); api.host.call("session.info", null); const mid = Date.now(); await api.time.sleep(40); return [mid - start, Date.now() - start, new Date().getTime() - start]; })';
  const request = { source, filename: 'fixture.ts', capabilities: ['commands', 'inventory'], state: null, settings: {}, surface: currentSurface, event: 'command', name: 'wait', virtual_time_ms: 1000 };
  const reply = callback(request, call => call.operation === 'time.sleep' ? { slept_ms: call.arguments.ms, cancelled: false } : {}, []);
  assert.deepEqual(reply.value, [0, 40, 40]);
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
  const slow = { source: 'export default api => api.component("s", { view: () => { for (let i = 0; i < 3e7; i += 1) {} return []; } })',
    filename: 'fixture.ts', capabilities: ['terminal'], state: null, settings: {}, surface: currentSurface, event: 'component', name: 's', serve: true, payload: { instance: 's', now: 0, events: [] } };
  const slowSteps = spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner], {
    input: Array(4).fill(JSON.stringify(slow) + '\n').join(''), encoding: 'utf8', timeout: 5000,
  }).stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(slowSteps.map(reply => reply.error ?? null), [null, null, null, 'Error: component_overrun: s']);
  assert.match(run('export default api => api.component("x", { view: 1 })', { capabilities: ['terminal'] }).error, /handler_required: x/);
  const paused = start => `export default api => api.component("p", { init: () => ${start}, every: { ms: n => n ? null : 20, tick: n => n + 1 }, view: n => [{ type: "text", id: "n", label: "N", text: String(n) }] })`;
  const pausedStep = start => run(paused(start), { capabilities: ['terminal'], event: 'component', name: 'p', payload: { now: 100, events: [] } }).value.next_ms;
  assert.deepEqual([pausedStep(0), pausedStep(1)], [20, null]);
  const asynchronous = handler => run(`export default api => api.component("a", { ${handler}, view: s => [{ type: "text", id: "t", label: "a", text: JSON.stringify(s) }] })`,
    { capabilities: ['terminal'], event: 'component', name: 'a', payload: { now: 0, events: [{ kind: 'key', key: 'x', text: null }] } });
  assert.match(asynchronous('init: () => 0, key: async s => s + 1').error, /component_handlers_must_be_synchronous/);
  assert.match(asynchronous('init: async () => 0, key: s => s').error, /component_handlers_must_be_synchronous/);
});
test('a pinned component runner reads the state and UI state of the step it serves', () => {
  const probe = { source: 'export default api => api.component("c", { view: () => [{ type: "text", id: "t", label: "c", text: JSON.stringify([api.state.get(), api.uiState.get()]) }] })',
    filename: 'fixture.ts', capabilities: ['terminal', 'store'], state: { n: 1 }, ui_state: { open: 1 }, settings: {}, surface: currentSurface, event: 'component', name: 'c', serve: true, payload: { instance: 'c', now: 0, events: [] } };
  const serve = (state, uiState) => JSON.stringify({ name: 'c', payload: probe.payload, receipts: [], state, ui_state: uiState });
  const texts = spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner], {
    input: [JSON.stringify(probe), serve({ n: 2 }, { open: 2 }), serve(null, null)].join('\n') + '\n', encoding: 'utf8', timeout: 5000,
  }).stdout.trim().split('\n').map(line => JSON.parse(line).value.tree[0].text);
  assert.deepEqual(texts, ['[{"n":1},{"open":1}]', '[{"n":2},{"open":2}]', '[null,null]']);
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
