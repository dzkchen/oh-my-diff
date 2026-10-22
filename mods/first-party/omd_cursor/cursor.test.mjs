import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { pendingSettlements, usageReport } from './index.ts';
import { Router, planHeaders } from './transport.mjs';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));

function modEvent(event, payload, state, answer, name) {
  const calls = [];
  const output = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, settings: {},
    package: { id: manifest.id }, state, event, payload, name }, call => {
    calls.push(call);
    return answer(call);
  });
  assert.equal(output.error, undefined, output.error);
  return { state: output.state, calls, value: output.value };
}
const notices = calls => calls.filter(call => call.operation === 'terminal.notice').map(call => call.arguments.text);

test('Cursor applies delayed charges and drains billing batches after its polling window', () => {
  for (const count of [1, 217]) {
    let state = { data: '/cursor' };
    let elapsed = 0;
    let delay = null;
    const applied = [];
    const log = Array.from({ length: count }, (_, index) => JSON.stringify({
      kind: 'settlement', status: 'settled', thread: 't', request_id: `r${index}`,
      cost: { charged_cents: 2.5 }, source: 'cursor_sdk.getUsage',
    })).join('\n');
    assert.ok(Buffer.byteLength(log) <= 32_768);
    const host = call => {
      if (call.operation === 'session.info') return { thread_id: 't', provider: 'omd_cursor' };
      if (call.operation === 'exec.run') return { exit_code: 0, stdout: elapsed >= 345_000 ? log : '' };
      if (call.operation === 'ledger.settle') { applied.push(call.arguments); return { settled: true }; }
      if (call.operation === 'events.schedule') { delay = call.arguments.delay_ms; return { scheduled: true }; }
      throw new Error(`unexpected ${call.operation}`);
    };
    for (let poll = 0; poll < 60; poll++) {
      delay = null;
      const result = modEvent(poll ? 'timer' : 'turn_end', poll ? { key: 'settle' } : null, state, host);
      state = result.state;
      if (delay === null) break;
      elapsed += delay;
    }
    assert.deepEqual(applied.map(row => row.request_id), Array.from({ length: count }, (_, index) => `r${index}`));
    assert.ok(applied.every(row => row.microusd === 25_000));
    assert.ok(elapsed >= 360_000);
    assert.equal(delay, null);
  }
});

test('Cursor reads its usage log through a sandboxed tail and settles nothing outside a Cursor session', () => {
  const tail = modEvent('command', 'usage', { data: '/data/omd-cursor' }, () => ({ exit_code: 0, stdout: '' }), 'cursor');
  assert.deepEqual(tail.calls.map(call => [call.operation, call.arguments.program, call.arguments.argv, call.arguments.sandbox]),
    [['exec.run', '/usr/bin/tail', ['-c', '32768', '/data/omd-cursor/usage.jsonl'], undefined]]);
  assert.match(tail.value.display, /No Cursor usage recorded yet/);
  const other = modEvent('turn_end', null, { data: '/data/omd-cursor' }, () => ({ thread_id: 't', provider: 'openai' }));
  assert.deepEqual(other.calls.map(call => call.operation), ['session.info']);
  assert.match(modEvent('command', '', null, () => null, 'cursor').value.display, /not set up; run \/cursor setup/);
});

test('/cursor setup runs the installed setup script in the background, says the sign-in link once and publishes the models', () => {
  const hop = modEvent('command', 'setup', null, () => ({ delivered: 1, dropped: 0 }), 'cursor');
  assert.deepEqual(hop.calls[0].arguments, { channel: 'setup', data: { account: 'default' } });
  const named = modEvent('command', 'setup work', null, () => ({ delivered: 1, dropped: 0 }), 'cursor');
  assert.deepEqual(named.calls[0].arguments, { channel: 'setup', data: { account: 'work' } });
  for (const bad of ['setup Work', 'setup 1']) assert.match(modEvent('command', bad, null, () => ({ delivered: 1 }), 'cursor').value.display, /^Account names start with a letter/, bad);
  assert.ok(manifest.subscriptions.channels.includes('omd_cursor/setup'));
  const started = modEvent('channel', { channel: 'omd_cursor/setup', data: {} }, null, call => ({
    'packages.list': { packages: [{ id: 'omd_cursor', path: '/store/sources/omd_cursor' }] },
    'process.which': { found: [{ name: 'node', path: '/bin/node', sha256: 'a' }] },
    'process.stop': { stopped: false }, 'process.start': { session: 'cursor_setup', running: true } })[call.operation]);
  assert.deepEqual(started.calls.at(-1).arguments, { session: 'cursor_setup', name: 'node', path: '/bin/node', sha256: 'a',
    arguments: ['/store/sources/omd_cursor/setup.mjs', 'default'], sandbox: 'none', framing: 'raw', notify: ['output', 'exit'] });
  const link = 'https://cursor.com/loginDeepControl?fixture';
  const event = (kind, data, state) => {
    let reads = 0;
    return modEvent('process_event', { session: 'cursor_setup', kind, bytes: 1 }, state, call => ({
      'process.exchange': { messages: reads++ || !data ? [] : [{ stream: 'stdout', data }], running: true },
      'sidecars.status': { running: false }, 'credentials.list': [{ id: 'p7', kind: 'secret', label: 'cursor', status: 'ready' }],
      'providers.register': {}, 'providers.models': { provider: 'omd_cursor', models: 2 } })[call.operation] ?? {});
  };
  const shown = event('output', `installing\nOMD_CURSOR_LINK ${link}\n`, started.state);
  assert.deepEqual(notices(shown.calls), ['Approve Oh My Diff in your browser to enroll Cursor; if it does not open, open this link:', link]);
  assert.deepEqual(notices(event('output', 'waiting\n', shown.state).calls), []);
  const models = [{ slug: 'cursor-auto', display: 'Cursor Auto', context_window: 200000, efforts: [] }];
  const accounts = [{ name: 'default', account: 'dev@example.com', expires: 9e12, default: 'cursor-auto', route: 'cursor', secret: 'p7', models: 1 }];
  const done = { sdk: '1.0.35', data: '/data/omd-cursor', accounts, models };
  const finished = event('exit', `OMD_CURSOR_RESULT ${JSON.stringify(done)}\n`, shown.state);
  assert.deepEqual(finished.calls.map(call => call.operation), ['process.exchange', 'process.exchange', 'process.stop',
    'sidecars.status', 'providers.unregister', 'credentials.list', 'providers.register', 'providers.models', 'terminal.notice']);
  assert.deepEqual(finished.calls.find(call => call.operation === 'providers.register').arguments, { id: 'cursor', secrets: ['p7'] });
  assert.deepEqual(finished.calls.find(call => call.operation === 'providers.models').arguments, { provider: 'omd_cursor', name: 'Cursor', models });
  assert.deepEqual(notices(finished.calls), ['Cursor account default is ready for dev@example.com; pick its models with /model or switch with /profile']);
  assert.deepEqual([finished.state.setup, finished.state.published, finished.state.data, finished.state.models, finished.state.accounts], [null, true, '/data/omd-cursor', models, accounts]);
  const doctor = modEvent('command', '', finished.state, () => null, 'cursor').value.display;
  assert.match(doctor, /\naccount default: dev@example\.com; key expires [^\n]+; default cursor-auto\n/);
  assert.equal(started.state.mod, '/store/sources/omd_cursor');
  const emptied = { sdk: '1.0.35', data: '/data/omd-cursor', accounts: [], models: [] };
  const remover = run => call => call.operation === 'exec.run' ? run : call.operation === 'events.publish' ? { delivered: 1 } : { status: 'completed' };
  const state = { ...finished.state, mod: '/store/sources/omd_cursor' };
  const failed = modEvent('command', 'remove default', state, remover({ exit_code: 1, stdout: 'OMD_CURSOR_ERROR host_json_unreadable\n', stderr: '' }), 'cursor');
  assert.deepEqual([failed.value.display, failed.calls.map(call => call.operation)], ['Cursor account default was not removed: host_json_unreadable', ['exec.run']]);
  const removing = modEvent('command', 'remove default', state, remover({ exit_code: 0, stdout: `OMD_CURSOR_RESULT ${JSON.stringify(emptied)}\n`, stderr: '' }), 'cursor');
  assert.deepEqual(removing.calls.map(call => [call.operation, call.arguments.argv ?? call.arguments]), [['exec.run', ['/store/sources/omd_cursor/setup.mjs', 'default', '--remove']],
    ['events.publish', { channel: 'removed', data: { result: emptied } }], ['credentials.request', { action: 'remove', profile: 'p7' }]]);
  assert.equal(removing.value.display, 'Removed Cursor account default and OMD\'s copy of its key; the key stays valid at Cursor until you revoke "Oh My Diff" under API keys in your Cursor dashboard');
  const applied = modEvent('channel', { channel: 'omd_cursor/removed', data: { result: emptied } }, state, () => ({}));
  assert.deepEqual([applied.state.accounts, applied.state.published, applied.calls.map(call => call.operation)], [[], false, ['providers.unregister']]);
  assert.equal(modEvent('command', 'remove work', finished.state, () => null, 'cursor').value.display, 'Unknown Cursor account work');
  const declined = event('exit', 'OMD_CURSOR_ERROR cursor_enrollment_declined: login denied\n', shown.state);
  assert.deepEqual(notices(declined.calls), ['Cursor setup failed: cursor_enrollment_declined: login denied']);
  assert.ok(!declined.calls.some(call => call.operation === 'providers.register'));
  assert.equal(declined.state.models, undefined);
});

test('stored Cursor models reach /model at start and the sidecar restarts only for Cursor turns', () => {
  const models = [{ slug: 'cursor-auto', display: 'Cursor Auto', context_window: 200000, efforts: [] }];
  const answer = provider => call => ({ 'sidecars.status': { running: false }, 'credentials.list': [], 'session.info': { thread_id: 't', provider } })[call.operation] ?? {};
  const started = modEvent('start', null, { models, data: '/d' }, answer('openai'));
  assert.deepEqual(started.calls.map(call => call.operation), ['sidecars.status', 'providers.unregister', 'credentials.list', 'providers.register', 'providers.models']);
  assert.equal(started.state.published, true);
  assert.deepEqual(modEvent('turn_start', null, started.state, answer('openai')).calls.map(call => call.operation), ['session.info']);
  assert.equal(modEvent('turn_start', null, started.state, answer('omd_cursor')).calls[1].operation, 'sidecars.status');
  assert.equal(modEvent('start', null, null, answer('openai')).state.published, false);
});

const model = 'cursor-auto';
const token = 'local-fixture-token-without-account-access';
const fixtures = new WeakMap();
const sdk = `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const log = new URL('calls.jsonl', import.meta.url);
const registry = new URL('agents.json', import.meta.url);
const record = row => appendFileSync(log, JSON.stringify(row) + '\\n');
const known = () => existsSync(registry) ? JSON.parse(readFileSync(registry, 'utf8')) : [];
const usage = { inputTokens: 10, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 2, reasoningTokens: 1 };
const charges = new URL('charged.json', import.meta.url);
export class JsonlLocalAgentStore { constructor(root) { this.root = root; } }
class FakeAgent {
  constructor(agentId) { this.agentId = agentId; }
  async send(message, options) {
    const tools = options.local.customTools;
    record({ op: 'send', agentId: this.agentId, text: message.text, images: message.images, model: options.model, tools: Object.keys(tools) });
    const emit = update => options.onDelta({ update });
    let stop;
    const stopped = new Promise(resolve => { stop = resolve; });
    const call = (name, args) => tools[name].execute(args, {}).catch(error => 'error:' + error.message);
    const work = (async () => {
      emit({ type: 'thinking-delta', text: 'Thinking.' });
      if (message.text.includes('LIMIT')) return { id: 'run', status: 'error', error: { message: 'usage limit exceeded', code: 'resource_exhausted' } };
      if (message.text.endsWith('HANG')) { await stopped; return { id: 'run', status: 'cancelled' }; }
      if (message.text.includes('CHARGE')) writeFileSync(charges, '2.5');
      let answer = 'Answer.';
      if (message.text.includes('TOOL')) answer = 'tool:' + JSON.stringify(await call('exec_command', { cmd: 'pwd' }));
      if (message.text.includes('PARALLEL')) answer = 'both:' + (await Promise.all([call('exec_command', { cmd: 'a' }), call('exec_command', { cmd: 'b' })])).join(',');
      if (message.text.includes('LATE')) {
        const first = call('exec_command', { cmd: 'a' });
        await new Promise(resolve => setTimeout(resolve, 150));
        answer = 'late:' + (await Promise.all([first, call('exec_command', { cmd: 'b' })])).join(',');
      }
      if (message.text.includes('SEARCH')) {
        const found = await call('tool_search', { query: 'notes' });
        answer = found.includes('notes__add') + ':' + await call('omd_call', { name: 'notes__add', arguments: { text: 'x' } });
      }
      emit({ type: 'text-delta', text: answer });
      emit({ type: 'turn-ended', usage });
      return { id: 'run', status: 'finished', result: answer, usage: { ...usage, totalTokens: 19 } };
    })();
    return { id: 'run-' + this.agentId, requestId: 'req-1', wait: () => work, cancel: async () => { record({ op: 'cancel', agentId: this.agentId }); stop(); } };
  }
  async getUsage() { return { usage, cost: { rawCostCents: 1.25, chargedCents: existsSync(charges) ? Number(readFileSync(charges, 'utf8')) : 0 }, runs: [] }; }
}
const clean = options => ({ ...options, local: { ...options.local, store: options.local.store instanceof JsonlLocalAgentStore } });
export const Agent = {
  async create(options) {
    const id = 'agent-' + (known().length + 1);
    writeFileSync(registry, JSON.stringify([...known(), id]));
    record({ op: 'create', id, options: clean(options) });
    return new FakeAgent(id);
  },
  async resume(id, options) {
    if (!known().includes(id)) throw new Error('agent_not_found');
    record({ op: 'resume', id, options: clean(options) });
    return new FakeAgent(id);
  },
};
export const Cursor = {
  models: { list: async ({ apiKey }) => { record({ op: 'models', apiKey }); return [
    { id: 'auto', displayName: 'Auto', parameters: [] },
    { id: 'gpt-6', displayName: 'GPT-6', parameters: [{ id: 'reasoning', values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] }] },
    { id: 'bad id!', displayName: 'Ignored' }]; } },
  auth: {
    status: async ({ store }) => (await store.load()) ? { status: 'logged-in', apiKeyExpiresAtMs: Date.now() + 9e9 } : { status: 'logged-out' },
    login: async ({ store, onLoginUrl }) => {
      onLoginUrl('https://cursor.com/loginDeepControl?fixture');
      if (process.env.FIXTURE_DENY) throw new Error('login denied');
      await store.save({ version: 1, backendUrl: 'https://api2.cursor.sh', apiKey: 'crsr_fixture', apiKeyExpiresAtMs: Date.now() + 9e9, email: 'dev@example.com', createdAtMs: Date.now() });
      return { apiKey: 'crsr_fixture' };
    },
  },
};
`;

const defaultAccount = { name: 'default', secret_profile: 'p1', backend_url: 'http://127.0.0.1:9', default: model,
  models: [{ slug: model, id: 'auto', effort: { id: 'reasoning', values: ['low', 'high'] } }] };

async function fixture(t, { secrets = [{ id: 'p1', label: 'cursor', origin: 'https://api2.cursor.sh', value: 'crsr_fixture' }], route = {}, account = {}, accounts = [{ ...defaultAccount, ...account }], root } = {}) {
  let cleanup = fixtures.get(t);
  if (!cleanup) {
    cleanup = { children: [], roots: [] };
    fixtures.set(t, cleanup);
    t.after(async () => {
      for (const child of cleanup.children) if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGKILL');
        await exited;
      }
      for (const path of cleanup.roots) await rm(path, { recursive: true, force: true });
    });
  }
  if (!root) {
    root = await mkdtemp(join(tmpdir(), 'omd-cursor-'));
    cleanup.roots.push(root);
    await writeFile(join(root, 'sdk.mjs'), sdk);
  }
  const reserve = createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const routePath = join(root, 'route.json');
  await writeFile(routePath, JSON.stringify({ port, sdk: '/sdk.mjs', data: join(root, 'data'), accounts, ...route }));
  const child = spawn(process.execPath, [new URL('./transport.mjs', import.meta.url).pathname, 'serve', routePath],
    { cwd: root, env: { PATH: '/usr/bin:/bin', OMD_SERVICE_ROOT: root, OMD_CURSOR_LOCAL_TOKEN: token, OMD_READY_TOKEN: 'ready',
      OMD_SECRETS: JSON.stringify(secrets) }, stdio: 'ignore' });
  cleanup.children.push(child);
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/_omd/ready`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const call = async (input, { tools = exec, thread = 't1', signal, reasoning, request = 'req-0', slug = model, headers } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', signal,
      headers: { authorization: `Bearer ${token}`, 'thread-id': thread, 'x-omd-request-id': request }, body: JSON.stringify({ model: slug, stream: true, input, tools, reasoning }) });
    if (headers) Object.assign(headers, Object.fromEntries(response.headers));
    return (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  };
  const calls = async () => (await readFile(join(root, 'calls.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { call, calls, root, child };
}

const user = text => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const assistant = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const exec = [{ type: 'function', name: 'exec_command', description: 'Run a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }];
const text = events => events.filter(event => event.type === 'response.output_text.delta').map(event => event.delta).join('');
const items = (events, type) => events.filter(event => event.type === 'response.output_item.done' && event.item.type === type).map(event => event.item);
const output = (item, value) => ({ type: 'function_call_output', call_id: item.call_id, output: value });

test('Cursor retains billing baselines until every settlement finishes', async t => {
  const data = await mkdtemp(join(tmpdir(), 'omd-cursor-settlement-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', callback => { timers.push(callback); return { unref() {} }; });
  const router = new Router({ data }, 'fixture');
  router.refreshPlan = async () => {};
  let report = { runs: [{ runId: 'r', usage: {} }] };
  router.agents.set('a', { getUsage: async () => report });
  router.state.agents.a = { at: 1 };
  router.settle('a', 'auto', { thread: 't', request_id: 'A' });
  await timers[0]();
  delete router.state.agents.a;
  router.settle('a', 'auto', { thread: 't', request_id: 'B' });
  report = { runs: [{ runId: 'r', usage: {}, cost: { rawCostCents: 2.5, chargedCents: 2.5 } }],
    cost: { rawCostCents: 2.5, chargedCents: 2.5 } };
  await timers[4]();
  assert.ok(router.agents.has('a'));
  assert.ok(router.charged.has('a'));
  await timers[1]();
  const rows = (await readFile(join(data, 'usage.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.reduce((sum, row) => sum + (row.cost?.charged_cents ?? 0), 0), 2.5);
  for (const cache of [router.agents, router.charged, router.seen]) assert.equal(cache.has('a'), false);
});

test('Cursor releases settled agents evicted from its resume inventory', async t => {
  const data = await mkdtemp(join(tmpdir(), 'omd-cursor-eviction-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  t.mock.method(globalThis, 'setTimeout', () => ({ unref() {} }));
  const router = new Router({ data }, 'fixture');
  for (let index = 0; index < 200; index++) router.state.agents[`a${index}`] = { at: index };
  for (const cache of [router.agents, router.charged, router.seen]) {
    cache.set('a0', {});
    cache.set('a199', {});
  }
  router.agents.set('new', { getUsage: async () => ({}) });
  await router.finish('new', { agentId: 'new', messages: [], text: '', thread: 't', model: 'auto', abandon() {} }, true);
  assert.equal(Object.keys(router.state.agents).length, 200);
  for (const cache of [router.agents, router.charged, router.seen]) {
    assert.equal(cache.has('a0'), false);
    assert.ok(cache.has('a199'));
  }
});

test('Cursor settles and releases an agent when starting its run fails', async t => {
  const data = await mkdtemp(join(tmpdir(), 'omd-cursor-send-failure-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  const timers = [];
  t.mock.method(globalThis, 'setTimeout', callback => { timers.push(callback); return { unref() {} }; });
  const router = new Router({ data }, 'fixture');
  router.ready = async () => {};
  router.refreshPlan = async () => {};
  const agent = { agentId: 'failed', send: async () => { throw new Error('send_failed'); },
    getUsage: async () => ({ cost: { rawCostCents: 0, chargedCents: 0 }, runs: [] }) };
  router.agents.set(agent.agentId, agent);
  router.agent = async messages => ({ agent, input: messages, fresh: true });
  await assert.rejects(router.start({ input: [user('hello')] }, { id: 'auto', slug: model }, 't'), /send_failed/);
  assert.equal(router.turns.size, 0);
  assert.ok(timers.length);
  await timers[0]();
  for (const cache of [router.agents, router.charged, router.seen]) assert.equal(cache.has(agent.agentId), false);
});

test('Cursor lead runs only OMD tools through Codex, reports usage and continues its agent', async t => {
  const { call, calls } = await fixture(t);
  const opening = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'please TOOL' },
    { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' }] };
  const context = { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'sandbox: workspace-write' }] };
  const first = await call([context, opening], { reasoning: { effort: 'high' } });
  assert.ok(first.filter(event => /^response\.output_(item|text)/.test(event.type)).every(event => Number.isInteger(event.output_index)));
  const [request] = items(first, 'function_call');
  assert.equal(request.name, 'exec_command');
  assert.deepEqual(JSON.parse(request.arguments), { cmd: 'pwd' });
  assert.match(request.call_id, /^omd_cursor_[0-9a-f]{24}$/);
  assert.equal(first.at(-1).type, 'response.completed');
  const history = [context, opening, request, output(request, '/repo')];
  const second = await call(history);
  assert.equal(text(second), 'tool:"/repo"');
  assert.equal(first.find(event => event.type === 'response.reasoning_summary_text.delta').delta, 'Thinking.');
  const { usage } = second.at(-1).response;
  assert.deepEqual([usage.input_tokens, usage.input_tokens_details, usage.output_tokens, usage.output_tokens_details.reasoning_tokens],
    [16, { cached_tokens: 4, cache_write_tokens: 2 }, 3, 1]);
  assert.equal(usage.omd_cursor.agent_id, 'agent-1');
  assert.equal(usage.omd_cursor.cost, 'pending');
  assert.equal(text(await call([...history, assistant('tool:"/repo"'), user('next')])), 'Answer.');
  const log = await calls();
  const created = log.filter(row => row.op === 'create');
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].options.tools, ['mcp']);
  assert.deepEqual(created[0].options.mcpServers, {});
  assert.equal(created[0].options.apiKey, 'crsr_fixture');
  assert.deepEqual(created[0].options.local.settingSources, []);
  assert.equal(created[0].options.local.store, true);
  assert.ok(created[0].options.local.cwd.endsWith('/data/workspace'));
  const sends = log.filter(row => row.op === 'send');
  assert.deepEqual(sends[0].model, { id: 'auto', params: [{ id: 'reasoning', value: 'high' }] });
  assert.deepEqual(sends[0].tools, ['exec_command']);
  assert.match(sends[0].text, /no built-in Cursor tools[\s\S]*sandbox: workspace-write[\s\S]*please TOOL/);
  assert.deepEqual(sends[0].images, [{ data: 'iVBORw0KGgo=', mimeType: 'image/png' }]);
  assert.equal(sends[1].text, 'next');
  assert.deepEqual(sends[1].model, { id: 'auto' });
});

test('Cursor parallel calls and tool search reach Codex as host tool calls', async t => {
  const { call } = await fixture(t);
  const ask = user('PARALLEL');
  const pair = items(await call([ask]), 'function_call');
  assert.deepEqual(pair.map(item => JSON.parse(item.arguments).cmd), ['a', 'b']);
  assert.equal(text(await call([ask, ...pair, output(pair[0], 'A'), output(pair[1], 'B')])), 'both:A,B');
  const late = user('LATE');
  const [a] = items(await call([late], { thread: 't3' }), 'function_call');
  await new Promise(resolve => setTimeout(resolve, 300));
  const [b] = items(await call([late, a, output(a, 'A')], { thread: 't3' }), 'function_call');
  assert.equal(JSON.parse(b.arguments).cmd, 'b', 'a call started after the response reaches the next one');
  assert.equal(text(await call([late, a, output(a, 'A'), b, output(b, 'B')], { thread: 't3' })), 'late:A,B');
  const search = [{ type: 'tool_search', description: 'Find tools', parameters: { type: 'object', properties: { query: { type: 'string' } } } }];
  const find = user('SEARCH');
  const [lookup] = items(await call([find], { tools: search, thread: 't2' }), 'tool_search_call');
  assert.deepEqual(lookup.arguments, { query: 'notes' });
  const loaded = { type: 'tool_search_output', call_id: lookup.call_id, tools: [{ type: 'namespace', name: 'notes',
    tools: [{ type: 'function', name: 'add', description: 'Add a note', parameters: { type: 'object', properties: { text: { type: 'string' } } } }] }] };
  const [dispatched] = items(await call([find, lookup, loaded], { tools: search, thread: 't2' }), 'function_call');
  assert.deepEqual([dispatched.namespace, dispatched.name, JSON.parse(dispatched.arguments)], ['notes', 'add', { text: 'x' }]);
  assert.equal(text(await call([find, lookup, loaded, dispatched, output(dispatched, 'ok')], { tools: search, thread: 't2' })), 'true:ok');
});

test('Cursor cancellation, plan limits, forks, enrollment and restart recovery fail closed', async t => {
  const dashboard = createServer((request, response) => {
    const ok = request.url === '/aiserver.v1.DashboardService/GetCurrentPeriodUsage' && request.headers.authorization === 'Bearer crsr_fixture';
    response.writeHead(ok ? 200 : 403, { 'content-type': 'application/json' }).end(JSON.stringify({ billingCycleStart: '1759276800000',
      planUsage: { totalSpend: 1250, includedSpend: 2000 }, spendLimitUsage: { individualLimit: 0 }, autoBucketModels: ['composer-2.5'] }));
  });
  await new Promise(resolve => dashboard.listen(0, '127.0.0.1', resolve));
  t.after(() => dashboard.close());
  const { call, calls, root, child } = await fixture(t, { account: { backend_url: `http://127.0.0.1:${dashboard.address().port}` } });
  assert.equal(text(await call([user('one')], { thread: 'h' })), 'Answer.');
  const controller = new AbortController();
  const hung = [user('one'), assistant('Answer.'), user('HANG')];
  const pending = call(hung, { thread: 'h', signal: controller.signal }).catch(error => error.name);
  await new Promise(resolve => setTimeout(resolve, 300));
  controller.abort();
  assert.equal(await pending, 'AbortError');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok((await calls()).some(row => row.op === 'cancel'));
  assert.equal(text(await call([...hung, user('two')], { thread: 'h' })), 'Answer.');
  const retried = await calls();
  assert.equal(retried.filter(row => row.op === 'create').length, 2);
  assert.match(retried.filter(row => row.op === 'send').at(-1).text, /## User\nHANG[\s\S]*## User\ntwo/);
  const limited = (await call([user('LIMIT')])).at(-1);
  assert.equal(limited.type, 'response.failed');
  assert.equal(limited.response.error.code, 'rate_limit_exceeded');
  assert.match(limited.response.error.message, /does not fall back/);
  const base = [user('hello'), assistant('Answer.')];
  assert.equal(text(await call([user('hello')], { thread: 'a' })), 'Answer.');
  assert.equal(text(await call([...base, user('in fork')], { thread: 'b' })), 'Answer.');
  const forked = (await calls()).filter(row => row.op === 'send').at(-1);
  assert.match(forked.text, /Conversation so far:[\s\S]*## User\nhello[\s\S]*## Assistant\nAnswer\.[\s\S]*## User\nin fork/);
  assert.equal(text(await call([...base, user('CHARGE')], { thread: 'a', request: 'req-7' })), 'Answer.');
  await new Promise(resolve => setTimeout(resolve, 300));
  const elsewhere = await call([user('elsewhere')], { thread: 'd' });
  assert.ok(!elsewhere.some(event => event.type === 'response.reasoning_summary_text.delta' && /charged/.test(event.delta)));
  const notice = await call([...base, user('CHARGE'), assistant('Answer.'), user('again')], { thread: 'a' });
  assert.match(notice.find(event => event.type === 'response.reasoning_summary_text.delta').delta, /charged 2\.50¢ beyond included usage/);
  const report = usageReport(await readFile(join(root, 'data/usage.jsonl'), 'utf8'));
  assert.match(report, /undocumented Cursor dashboard RPC[\s\S]*plan_usage\.totalSpend: 1250[\s\S]*auto_bucket_models: composer-2\.5/);
  assert.match(report, /req-7  cursor-auto[\s\S]*charged 2\.50¢[\s\S]*does not say which pool/);
  const log = await readFile(join(root, 'data/usage.jsonl'), 'utf8');
  assert.deepEqual(pendingSettlements(log, 'a', []).filter(row => row.microusd > 0),
    [{ request_id: 'req-7', microusd: 25000, source: 'cursor_sdk.getUsage' }]);
  assert.deepEqual(pendingSettlements(log, 'a', ['req-0', 'req-7']), []);
  assert.ok(pendingSettlements(log, 'b', []).every(row => row.microusd === 0));
  assert.equal(notice.at(-1).response.usage.omd_cursor.plan.plan_usage.includedSpend, 2000);
  child.kill('SIGKILL');
  const restarted = await fixture(t, { root });
  assert.equal(text(await restarted.call([...base, user('CHARGE'), assistant('Answer.'), user('again'), assistant('Answer.'), user('after restart')], { thread: 'a', request: 'req-9' })), 'Answer.');
  assert.equal((await calls()).filter(row => row.op === 'resume').length, 1);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(pendingSettlements(await readFile(join(root, 'data/usage.jsonl'), 'utf8'), 'a', ['req-0', 'req-7']), [{ request_id: 'req-9', microusd: 0, source: 'cursor_sdk.getUsage' }]);
  const lost = { type: 'function_call', call_id: 'omd_cursor_000000000000000000000000', name: 'exec_command', arguments: '{"cmd":"ls"}' };
  assert.equal(text(await restarted.call([user('list'), lost, output(lost, 'a.txt')], { thread: 'c' })), 'Answer.');
  assert.match((await calls()).filter(row => row.op === 'send').at(-1).text, /## User\nlist\n\[called exec_command \{"cmd":"ls"\}\]\n\[result a\.txt\][\s\S]*continue from the tool results/);
  const missing = await fixture(t, { secrets: [] });
  assert.equal((await missing.call([user('hi')])).at(-1).response.error.code, 'cursor_not_enrolled');
  const expired = await fixture(t, { account: { credential_expires_at_ms: 1 } });
  assert.equal((await expired.call([user('hi')])).at(-1).response.error.code, 'cursor_credential_expired');
});

test('each Cursor account runs on its own key and reports its plan usage as a rate-limit family', async t => {
  const dashboard = createServer((request, response) => {
    const ok = request.headers.authorization === 'Bearer crsr_work';
    response.writeHead(ok ? 200 : 403, { 'content-type': 'application/json' }).end(JSON.stringify({ billingCycleStart: '1759276800000',
      billingCycleEnd: '1761868800000', planUsage: { totalSpend: 1250, includedSpend: 2000 } }));
  });
  await new Promise(resolve => dashboard.listen(0, '127.0.0.1', resolve));
  t.after(() => dashboard.close());
  const backend = `http://127.0.0.1:${dashboard.address().port}`;
  const work = { ...defaultAccount, name: 'work', secret_profile: 'p2', backend_url: backend, default: `${model}.work`,
    models: [{ ...defaultAccount.models[0], slug: `${model}.work` }] };
  const { call, calls } = await fixture(t, { accounts: [{ ...defaultAccount, backend_url: backend }, work], secrets: [{ id: 'p1', value: 'crsr_fixture' }, { id: 'p2', value: 'crsr_work' }] });
  assert.equal(text(await call([user('hi')], { thread: 'w', slug: `${model}.work` })), 'Answer.');
  assert.equal(text(await call([user('hi')], { thread: 'd' })), 'Answer.');
  assert.deepEqual((await calls()).filter(row => row.op === 'create').map(row => [row.options.apiKey, row.options.model.id]), [['crsr_work', 'auto'], ['crsr_fixture', 'auto']]);
  await new Promise(resolve => setTimeout(resolve, 300));
  const headers = {};
  await call([user('again')], { thread: 'w2', slug: `${model}.work`, headers });
  assert.deepEqual([headers['x-cursor-limit-name'], headers['x-cursor-primary-used-percent'], headers['x-cursor-primary-window-minutes'], headers['x-cursor-primary-reset-at']],
    ['Cursor', '62.5', '43200', '1761868800']);
  const other = {};
  await call([user('again')], { thread: 'd2', headers: other });
  assert.equal(other['x-cursor-primary-used-percent'], undefined);
  assert.deepEqual(planHeaders({ unavailable: 'http_403' }), {});
});

test('Cursor transport survives aborted uploads and yields the port to a transport with a new key or route', async t => {
  const { call, child, root } = await fixture(t);
  const route = JSON.parse(await readFile(join(root, 'route.json'), 'utf8'));
  const port = route.port;
  const socket = connect(port, '127.0.0.1');
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write(`POST /v1/responses HTTP/1.1\r\nhost: 127.0.0.1\r\nauthorization: Bearer ${token}\r\ncontent-length: 100000\r\n\r\n{"model"`);
  await new Promise(resolve => setTimeout(resolve, 100));
  socket.destroy();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(child.exitCode, null);
  assert.equal(text(await call([user('hi')])), 'Answer.');
  const exited = new Promise(resolve => child.once('exit', resolve));
  assert.equal((await fetch(`http://127.0.0.1:${port}/_omd/nonce`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: 'next other-identity' })).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${port}/_omd/nonce`, { method: 'POST', body: 'x'.repeat(1 << 20) }).then(reply => reply.status, () => 413)), 413);
  assert.equal(child.exitCode, null);
  await writeFile(join(root, 'next.json'), JSON.stringify({ ...route, accounts: [{ ...route.accounts[0], backend_url: 'http://127.0.0.1:8' }] }));
  const next = spawn(process.execPath, [new URL('./transport.mjs', import.meta.url).pathname, 'serve', join(root, 'next.json')],
    { cwd: root, env: { PATH: '/usr/bin:/bin', OMD_SERVICE_ROOT: root, OMD_CURSOR_LOCAL_TOKEN: token, OMD_READY_TOKEN: 'next' }, stdio: 'ignore' });
  t.after(() => next.kill('SIGKILL'));
  assert.equal(await exited, 0);
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await fetch(`http://127.0.0.1:${port}/_omd/ready`).then(reply => reply.text(), () => '') === 'OMD_READY:next') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await fetch(`http://127.0.0.1:${port}/_omd/ready`).then(reply => reply.text()), 'OMD_READY:next');
});

test('the Cursor transport shows a foreign holder of its port neither the local token nor the readiness nonce', async t => {
  const seen = [];
  const squatter = createServer(async (incoming, response) => {
    let body = '';
    for await (const chunk of incoming) body += chunk;
    seen.push(JSON.stringify(incoming.headers) + body);
    response.end('OMD_READY:other');
  });
  await new Promise(resolve => squatter.listen(0, '127.0.0.1', resolve));
  t.after(() => { squatter.closeAllConnections(); squatter.close(); });
  const { child } = await fixture(t, { route: { port: squatter.address().port } });
  const code = child.exitCode ?? await new Promise(resolve => child.once('exit', resolve));
  assert.notEqual(code, 0);
  assert.ok(seen.length);
  assert.ok(!seen.some(entry => entry.includes(token) || entry.includes('ready')));
});

test('Cursor setup enrolls through the SDK login, hands the key to the broker and refuses a denied enrollment', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'omd-cursor-setup-')));
  const store = join(root, 'store');
  try {
    await mkdir(join(store, 'sources'), { recursive: true });
    await cp(new URL('.', import.meta.url).pathname, join(store, 'sources/omd_cursor'), { recursive: true });
    const sdkRoot = join(root, 'sdk');
    const packageRoot = join(sdkRoot, 'node_modules/.pnpm/@cursor+sdk@1.0.35/node_modules/@cursor/sdk');
    const dependency = join(sdkRoot, 'node_modules/.pnpm/fixture-dependency@1/node_modules/fixture-dependency');
    const dependencyLink = join(packageRoot, '../../fixture-dependency');
    const sdkEntry = join(packageRoot, 'dist/esm/index.js');
    await mkdir(dirname(sdkEntry), { recursive: true });
    await mkdir(dependency, { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), '{"type":"module"}');
    await writeFile(join(dependency, 'package.json'), '{"type":"module","main":"index.js"}');
    await writeFile(join(dependency, 'index.js'), 'export const pinned = true;');
    await symlink(relative(dirname(dependencyLink), dependency), dependencyLink);
    await writeFile(sdkEntry, `import { pinned } from 'fixture-dependency';\nif (!pinned) throw new Error('dependency not pinned');\n${sdk}`);
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'omd-mod'), `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync('${root}/secrets.jsonl', JSON.stringify({ argv: process.argv.slice(2), value: readFileSync(0, 'utf8') }) + '\\n');
console.log(JSON.stringify({ id: process.argv.at(-2) === 'cursor' ? 'p7' : 'p8', label: process.argv.at(-2), kind: 'secret', origin: process.argv.at(-1), status: 'ready' }));
`, { mode: 0o755 });
    const setup = (env, name = 'default') => spawnSync(process.execPath, [join(store, 'sources/omd_cursor/setup.mjs'), name, sdkEntry],
      { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env } });
    const marked = (run, marker) => run.stdout.split('\n').find(line => line.startsWith(`${marker} `))?.slice(marker.length + 1);
    const absent = setup({ PATH: '/usr/bin:/bin' });
    assert.equal(absent.status, 1);
    assert.equal(marked(absent, 'OMD_CURSOR_ERROR'), 'omd_mod_unavailable: omd-mod is not on PATH');
    assert.equal(marked(absent, 'OMD_CURSOR_LINK'), undefined);
    const denied = setup({ FIXTURE_DENY: '1' });
    assert.equal(denied.status, 1);
    assert.equal(marked(denied, 'OMD_CURSOR_LINK'), 'https://cursor.com/loginDeepControl?fixture');
    assert.equal(marked(denied, 'OMD_CURSOR_ERROR'), 'cursor_enrollment_declined: login denied');
    await assert.rejects(stat(join(store, 'host.json')));
    await assert.rejects(stat(join(root, 'secrets.jsonl')));
    const done = setup({});
    assert.equal(done.status, 0, done.stderr);
    const result = JSON.parse(marked(done, 'OMD_CURSOR_RESULT'));
    assert.deepEqual(result.models, [{ slug: 'cursor-auto', display: 'Cursor Auto', context_window: 200000, efforts: [] },
      { slug: 'cursor-gpt-6', display: 'Cursor GPT-6', context_window: 200000, efforts: ['low', 'medium', 'high'], default_effort: 'medium' }]);
    assert.deepEqual([result.accounts[0].default, result.accounts[0].account, result.sdk], ['cursor-auto', 'dev@example.com', '1.0.35']);
    const host = JSON.parse(await readFile(join(store, 'host.json'), 'utf8'));
    const grant = host.services.find(service => service.id === 'cursor');
    assert.deepEqual(grant.secrets, { OMD_CURSOR_LOCAL_TOKEN: 'cursor_local_token' });
    assert.deepEqual([grant.route.rates.provider_billed, grant.route.rates.included_subscription, grant.route.rates.reservation_microusd], [true, false, 0]);
    assert.deepEqual(Object.keys(host.secret_refs), ['cursor_local_token']);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'secrets.jsonl'), 'utf8')),
      { argv: ['credentials', store, 'add-secret', 'omd_cursor', 'cursor', 'https://api2.cursor.sh'], value: 'crsr_fixture' });
    const routePath = join(store, 'routes/cursor/route.json');
    const route = JSON.parse(await readFile(routePath, 'utf8'));
    assert.equal(route.accounts[0].secret_profile, 'p7');
    assert.ok(!JSON.stringify(route).includes('crsr_fixture'));
    assert.ok(!`${done.stdout}${done.stderr}`.includes('crsr_fixture'));
    for (const entry of await readdir(store, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && !entry.parentPath.startsWith(join(store, 'sources'))) assert.ok(!(await readFile(join(entry.parentPath, entry.name), 'utf8')).includes('crsr_fixture'), entry.name);
    }
    assert.deepEqual(route.accounts[0].models[1], { slug: 'cursor-gpt-6', id: 'gpt-6', effort: { id: 'reasoning', values: ['low', 'medium', 'high'] }, display: 'Cursor GPT-6' });
    assert.deepEqual(grant.arguments, [join(store, 'sources/omd_cursor/transport.mjs'), 'serve', routePath]);
    const before = await readFile(join(store, 'host.json'), 'utf8');
    assert.equal(setup({ FIXTURE_DENY: '1' }).status, 1);
    assert.equal(await readFile(join(store, 'host.json'), 'utf8'), before);
    assert.equal(setup({}).status, 0);
    assert.equal(JSON.parse(await readFile(join(store, 'host.json'), 'utf8')).services.filter(service => service.id === 'cursor').length, 1);
    const work = setup({}, 'work');
    assert.equal(work.status, 0, work.stdout);
    const both = JSON.parse(marked(work, 'OMD_CURSOR_RESULT'));
    assert.deepEqual(both.models.map(entry => entry.slug), ['cursor-auto', 'cursor-gpt-6', 'cursor-auto.work', 'cursor-gpt-6.work']);
    assert.equal(both.models[2].display, 'Cursor Auto · work');
    assert.deepEqual(both.accounts.map(entry => [entry.name, entry.route, entry.secret]), [['default', 'cursor', 'p7'], ['work', 'cursor-work', 'p8']]);
    assert.deepEqual(JSON.parse((await readFile(join(root, 'secrets.jsonl'), 'utf8')).trim().split('\n').at(-1)).argv.slice(3), ['omd_cursor', 'cursor-work', 'https://api2.cursor.sh']);
    const routed = JSON.parse(await readFile(join(store, 'host.json'), 'utf8'));
    assert.deepEqual(routed.routes.map(entry => [entry.name, entry.provider, entry.model, entry.rates.provider_billed]),
      [['cursor', 'omd_cursor', 'cursor-auto', true], ['cursor-work', 'omd_cursor', 'cursor-auto.work', true]]);
    await writeFile(join(store, 'host.json'), JSON.stringify({ ...routed, routes: [...routed.routes, { ...routed.routes[0], name: 'cursor-spare', provider: 'omd_profiles' }] }));
    assert.equal(marked(setup({}, 'spare'), 'OMD_CURSOR_ERROR'), 'cursor_route_name_taken: another route is named cursor-spare');
    await writeFile(join(store, 'host.json'), JSON.stringify(routed));
    const dropped = spawnSync(process.execPath, [join(store, 'sources/omd_cursor/setup.mjs'), 'work', '--remove'], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(marked(dropped, 'OMD_CURSOR_RESULT')).accounts.map(entry => entry.name), ['default']);
    assert.deepEqual(JSON.parse(await readFile(join(store, 'host.json'), 'utf8')).routes.map(entry => entry.name), ['cursor']);
    const snapshot = join(root, 'snapshot');
    for (const path of Object.keys(grant.code_roots)) {
      const destination = `${snapshot}${path}`;
      await mkdir(dirname(destination), { recursive: true });
      await cp(path, destination, { recursive: true, verbatimSymlinks: true });
    }
    await rm(sdkRoot, { recursive: true, force: true });
    const previous = process.env.OMD_SERVICE_ROOT;
    process.env.OMD_SERVICE_ROOT = snapshot;
    try { await new Router({ ...route, data: join(root, 'data') }, route.accounts[0], 'fixture').ready(); }
    finally {
      if (previous === undefined) delete process.env.OMD_SERVICE_ROOT;
      else process.env.OMD_SERVICE_ROOT = previous;
    }
    assert.match(grant.code_roots[sdkRoot], /^[a-f0-9]{64}$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
