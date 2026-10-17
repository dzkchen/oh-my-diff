import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { callback, runnerSync, surface } from '../tests/mod_runner.mjs';
const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
function run(source, extra = {}) {
  return runnerSync({ source, filename: 'fixture.ts', capabilities: [], state: null, settings: {}, event: 'inspect', ...extra });
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

test('mod contexts encode UTF-8 with a TextEncoder of their own realm', () => {
  const source = `export default api => api.command('encode', text => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(text);
    const fitted = encoder.encodeInto(text, new Uint8Array(4));
    const lone = encoder.encodeInto('\\uD800x', new Uint8Array(3));
    const realm = probe => { try { probe(); return 'none'; } catch (error) { return error.constructor.constructor === Function ? 'local' : 'outer'; } };
    const disguised = new Proxy({}, { getPrototypeOf: () => Uint8Array.prototype });
    const whole = encoder.encode(text.repeat(110_000));
    const chunk = new Uint8Array(64);
    let rest = text.repeat(110_000), offset = 0, same = true;
    while (rest) {
      const step = encoder.encodeInto(rest, chunk);
      for (let index = 0; index < step.written; index++) same &&= chunk[index] === whole[offset + index];
      offset += step.written;
      rest = rest.slice(step.read);
    }
    return { bytes: Array.from(bytes), local: bytes instanceof Uint8Array, fitted, cut: text.slice(0, fitted.read), lone,
      errors: [realm(() => encoder.encodeInto('a', disguised)), realm(() => encoder.encodeInto('a', {}))], streamed: same && offset === whole.length };
  })`;
  const reply = run(source, { capabilities: ['commands'], event: 'command', name: 'encode', payload: 'a€😀' });
  assert.deepEqual(reply.value, { bytes: [0x61, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80], local: true, fitted: { read: 2, written: 4 }, cut: 'a€',
    lone: { read: 1, written: 3 }, errors: ['local', 'local'], streamed: true }, 'no outer-realm error reaches mod code');
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

test('warm renders and continuation replays restore post-activation atoms', () => {
  const input = { component: 'tool_call' };
  const request = { source: `export default api => { const value = api.atom('value', 0); value.set(value.get() + 1);
    api.intercept('render', (e, next) => e.replay ? next({ ...e, value: value.get() }) : { value: value.get() }); };`,
    filename: 'fixture.ts', capabilities: ['terminal', 'store'], state: { value: 0 }, settings: {}, surface,
    event: 'intercept', name: '0', serve: true, payload: { surface: 'render', input, original: input, origin: { caller: 'engine' } } };
  const suspended = { ...request, payload: { ...request.payload, input: { ...input, replay: true } } };
  const receipt = { call: { operation: 'continuation.next', arguments: { input: { ...input, replay: true, value: 1 } } }, value: { result: { value: 1 }, trace: [] } };
  const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--disallow-code-generation-from-strings', '--input-type=module', '--eval', runner], {
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
  const request = { source, filename: 'fixture.ts', capabilities: ['commands', 'inventory'], state: null, settings: {}, event: 'command', name: 'wait', virtual_time_ms: 1000 };
  const reply = callback(request, call => call.operation === 'time.sleep' ? { slept_ms: call.arguments.ms, cancelled: false } : {});
  assert.deepEqual(reply.value, [0, 40, 40]);
});
test('Date() and Intl date formatting read the callback clock', () => {
  const source = `export default api => api.command("now", () => {
    const format = new Intl.DateTimeFormat('en', { timeZone: 'UTC', dateStyle: 'full', timeStyle: 'long' });
    return [Date() === new Date().toString(), format.format() === format.format(new Date()), Intl.DateTimeFormat('en', { timeZone: 'UTC', timeStyle: 'long' }).formatToParts().length > 0, new Date().getTime(), [new Date(0)].map(format.format)[0] === format.format(new Date(0)), (({ format: unbound }) => unbound())(format) === format.format(new Date()), format.format === format.format];
  })`;
  assert.deepEqual(run(source, { capabilities: ['commands'], event: 'command', name: 'now', virtual_time_ms: 1000 }).value, [true, true, true, 1000, true, true, true]);
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
    filename: 'fixture.ts', capabilities: ['terminal'], state: null, settings: {}, surface, event: 'component', name: 's', serve: true, payload: { instance: 's', now: 0, events: [] } };
  const slowSteps = spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--disallow-code-generation-from-strings', '--input-type=module', '--eval', runner], {
    input: Array(4).fill(JSON.stringify(slow) + '\n').join(''), encoding: 'utf8', timeout: 5000,
  }).stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(slowSteps.map(reply => reply.error ?? null), [null, null, null, 'Error: component_overrun: s']);
});
test('a pinned component runner reads the state and UI state of the step it serves', () => {
  const probe = { source: 'export default api => api.component("c", { view: () => [{ type: "text", id: "t", label: "c", text: JSON.stringify([api.state.get(), api.uiState.get()]) }] })',
    filename: 'fixture.ts', capabilities: ['terminal', 'store'], state: { n: 1 }, ui_state: { open: 1 }, settings: {}, surface, event: 'component', name: 'c', serve: true, payload: { instance: 'c', now: 0, events: [] } };
  const serve = (state, uiState) => JSON.stringify({ name: 'c', payload: probe.payload, receipts: [], state, ui_state: uiState });
  const texts = spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--disallow-code-generation-from-strings', '--input-type=module', '--eval', runner], {
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
test('errors, crypto results and JSON assets stay in the mod realm', () => {
  const source = `import data from './data.json';
  const reach = value => { try { return typeof value.constructor.constructor('return process')(); } catch { return 'contained'; } };
  const caught = async run => { try { await run(); return 'no error'; } catch (error) { return reach(error); } };
  export default api => api.command('probe', async () => {
    const key = await crypto.subtle.importKey('raw', new Uint8Array(8), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signed = await crypto.subtle.sign('HMAC', key, new Uint8Array(1));
    return [
      await caught(() => import('x')),
      await caught(() => new TextEncoder().encodeInto('a', new Proxy(new Uint8Array(4), {}))),
      await caught(() => crypto.subtle.digest('none', new Uint8Array(1))),
      ...[crypto, crypto.subtle, crypto.subtle.digest('SHA-256', new Uint8Array(1)), key, key.algorithm, signed, data].map(reach),
      signed.byteLength,
    ];
  })`;
  const reply = run(source, { filename: '/pkg/index.ts', entrypoint: 'index.ts', capabilities: ['commands'], environment: ['crypto'],
    assets: { 'data.json': { text: '{"a": 1}', sha256: 'a'.repeat(64) } }, event: 'command', name: 'probe' });
  assert.deepEqual(reply.value, [...Array(10).fill('contained'), 32], reply.error);
});
test('patched intrinsics never receive host values from TextEncoder, crypto or registrations', () => {
  const source = `import './a.ts';
  const reach = value => { try { return typeof value.constructor.constructor('return process')(); } catch { return 'contained'; } };
  export default api => api.command('probe', async () => {
    const seen = [];
    const spy = (owner, name) => {
      const original = owner[name];
      owner[name] = function (...args) { seen.push(this, ...args); return Reflect.apply(original, this, args); };
      return () => { owner[name] = original; };
    };
    const Bytes = Uint8Array;
    globalThis.Uint8Array = function (...args) { seen.push(...args); return new Bytes(...args); };
    globalThis.Uint8Array.prototype = Bytes.prototype;
    const restore = [[Object.prototype, 'toString'], [Object, 'entries'], [Object, 'fromEntries'], [Object, 'freeze'], [Array, 'from'],
      [Array.prototype, 'map'], [WeakMap.prototype, 'set'], [WeakMap.prototype, 'get'], [Promise.prototype, 'then'], [globalThis, 'String'],
      [JSON, 'parse'], [ArrayBuffer, 'isView']].map(([owner, name]) => spy(owner, name));
    try {
      new TextEncoder().encode('a');
      new TextEncoder().encodeInto('a', new Bytes(4));
      crypto.getRandomValues(new Bytes(4));
      const subtle = crypto.subtle;
      const key = await subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, true, ['sign']);
      await subtle.sign('HMAC', key, new Bytes(1));
      await subtle.exportKey('jwk', key);
      await subtle.digest('SHA-256', new Bytes(1));
    } finally {
      restore.forEach(undo => undo());
      globalThis.Uint8Array = Bytes;
    }
    return [seen.map(reach).filter(reached => reached !== 'contained'), reach(globalThis.__omd.registrations.modules)];
  })`;
  const reply = run(source, { filename: '/pkg/index.ts', entrypoint: 'index.ts', capabilities: ['commands'], environment: ['crypto'],
    assets: { 'a.ts': { text: 'export {}', sha256: 'a'.repeat(64) } }, event: 'command', name: 'probe' });
  assert.deepEqual(reply.value, [[], 'contained'], reply.error);
});
test('host errors from stack overflow can neither compile code nor patch the host realm', () => {
  const source = `const reach = value => { try { return typeof value.constructor.constructor('return process')(); } catch { return 'contained'; } };
  const patch = (value, write) => { try { write(value); return 'patched'; } catch { return 'frozen'; } };
  export default api => api.command('probe', async () => {
    const errors = [];
    const note = error => { errors.push(error); };
    const pending = [];
    for (const probe of [() => { pending.push(import('x').catch(note)); }, () => new Error('x').stack]) {
      let attempts = 0;
      const recurse = () => { try { recurse(); } catch { if (attempts++ < 3000) { try { probe(); } catch (error) { note(error); } } } };
      recurse();
    }
    await Promise.all(pending);
    const found = new Set(errors.map(reach));
    const host = new Set(errors.filter(error => !(error instanceof Error)).flatMap(error => [
      patch(error, value => { Object.getPrototypeOf(Object.getPrototypeOf(Object.getPrototypeOf(value))).omdProbe = 1; }),
      patch(error, value => { Object.getPrototypeOf(value.constructor).prepareStackTrace = () => 'x'; }),
    ]));
    return { found: [...found], host: [...host] };
  })`;
  const reply = run(source, { capabilities: ['commands'], event: 'command', name: 'probe' });
  assert.deepEqual(reply.value?.found, ['contained'], reply.error);
  assert.ok(!reply.value.host.includes('patched'), JSON.stringify(reply.value));
});
test('infinite loops interrupted and oversized output rejected', () => {
  assert.match(run('export default () => { while(true) {} }').error, /timed out/);
  assert.match(run('export default api => api.command("large", () => "x".repeat(270000))', {capabilities:['commands'],event:'command',name:'large'}).error, /output_limit/);
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
test('classic middleware hooks answer only PermissionRequest', () => {
  const source = `export default api => {
    api.hook('SessionStart', () => ({ ignored: true }));
    api.hook('PermissionRequest', () => ({ decision: 'deny' }));
  }`;
  const caps = { capabilities: ['middleware', 'approvals'] };
  assert.equal(run(source, { ...caps, event: 'session', payload: { phase: 'start', thread_id: 't' } }).value ?? null, null);
  assert.deepEqual(run(source, { ...caps, event: 'approval', payload: { kind: 'exec', thread_id: 't' } }).value, { decision: 'deny' });
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