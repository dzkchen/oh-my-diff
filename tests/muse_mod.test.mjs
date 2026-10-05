import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { recovered } from '../mods/first-party/omd_muse/index.ts';

const model = 'muse-spark-1.3';
const token = 'local-fixture-token-without-account-access';
const host = `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const pending = new Map();
let sessions = 0;
const finish = (sessionId, turnId, text) => {
  send({ method: 'item/delta', params: { sessionId, field: 'summary.0', delta: 'Looking.' } });
  send({ method: 'item/delta', params: { sessionId, field: 'text', delta: text } });
  send({ method: 'turn/completed', params: { sessionId, turnId, terminal: 'completed', usage: { inputTokens: 10, cachedTokens: 4, cacheWriteTokens: 2, outputTokens: 3 } } });
};
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  appendFileSync(new URL("calls.jsonl", import.meta.url), JSON.stringify({ method, params }) + '\\n');
  if (method === 'initialize') send({ id, result: { schema: { fingerprint: 'fp1' } } });
  else if (method === 'session/start' || method === 'session/fork') send({ id, result: { session: { sessionId: '0190a000-0000-7000-8000-00000000000' + ++sessions } } });
  else if (method === 'session/resume') send({ id, result: { session: { sessionId: params.sessionId } } });
  else if (method === 'turn/start') {
    send({ id, result: { turnId: params.commandId } });
    const text = params.input[0].text;
    if (text.includes('CRASH')) process.exit(3);
    if (text.includes('APPROVE')) {
      pending.set(params.sessionId, params.commandId);
      send({ method: 'approval/requested', params: { sessionId: params.sessionId, approvalId: 'a1', currentRequirementId: 'r1', toolName: 'shell',
        summary: 'ls', availableChoices: [{ choiceId: 'yes', decision: 'approved' }, { choiceId: 'no', decision: 'denied' }] } });
    } else if (!text.includes('HANG')) finish(params.sessionId, params.commandId, 'Answer.');
    else pending.set(params.sessionId, params.commandId);
  } else if (method === 'approval/decide') {
    send({ id, result: {} });
    finish(params.sessionId, pending.get(params.sessionId), 'decided:' + params.choiceId);
  } else if (method === 'turn/interrupt') {
    send({ id, result: {} });
    send({ method: 'turn/completed', params: { sessionId: params.sessionId, turnId: params.turnId, terminal: 'cancelled' } });
  } else send({ id, result: {} });
}
`;

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'omd-muse-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = join(root, 'muse.mjs');
  await writeFile(fake, host, { mode: 0o700 });
  const reserve = createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const route = join(root, 'route.json');
  await writeFile(route, JSON.stringify({ port, muse: fake, fingerprint: 'fp1', data: join(root, 'data'), home: root, username: 'fixture',
    default: model, models: [{ slug: model, modelId: model, name: 'Muse Spark' }], ...overrides }));
  const log = join(root, 'calls.jsonl');
  const child = spawn(process.execPath, [new URL('../mods/first-party/omd_muse/transport.mjs', import.meta.url).pathname, 'serve', route],
    { cwd: root, env: { PATH: '/usr/bin:/bin', OMD_MUSE_LOCAL_TOKEN: token, OMD_READY_TOKEN: 'ready' }, stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/_omd/ready`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const call = async (input, { tools, thread = 't1', signal } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', signal,
      headers: { authorization: `Bearer ${token}`, 'thread-id': thread }, body: JSON.stringify({ model, stream: true, input, tools }) });
    return (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  };
  const calls = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { call, calls, root, port };
}

const user = text => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const assistant = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const relay = [{ type: 'function', name: 'mod_omd_muse_approval', parameters: { type: 'object', properties: {} } }];
const text = events => events.filter(event => event.type === 'response.output_text.delta').map(event => event.delta).join('');

test('Muse lead relays approvals through the OMD tool, streams usage and reuses its session', async t => {
  const { call, calls } = await fixture(t);
  const opening = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello APPROVE' },
    { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' }] };
  const first = await call([opening], { tools: relay });
  const approval = first.find(event => event.type === 'response.output_item.done' && event.item.type === 'function_call').item;
  assert.equal(approval.name, 'mod_omd_muse_approval');
  assert.deepEqual(JSON.parse(approval.arguments), { key: approval.call_id, tool: 'shell', summary: 'ls' });
  const history = [opening, approval, { type: 'function_call_output', call_id: approval.call_id, output: '{"approved":true}' }];
  const second = await call(history, { tools: relay });
  assert.equal(text(second), 'decided:yes');
  assert.equal(second.find(event => event.type === 'response.reasoning_summary_text.delta').delta, 'Looking.');
  assert.deepEqual(second.at(-1).response.usage.input_tokens_details, { cached_tokens: 4, cache_write_tokens: 2 });
  assert.equal(second.at(-1).response.usage.input_tokens, 16);
  assert.equal(text(await call([...history, assistant('decided:yes'), user('next')], { tools: relay })), 'Answer.');
  const log = await calls();
  assert.equal(log.filter(row => row.method === 'session/start').length, 1);
  assert.deepEqual(log.filter(row => row.method === 'approval/decide').map(row => row.params.choiceId), ['yes']);
  assert.deepEqual(log.filter(row => row.method === 'turn/start').at(-1).params.input, [{ type: 'text', text: 'next' }]);
  assert.deepEqual(log.find(row => row.method === 'turn/start').params.input[1], { type: 'image', mediaType: 'image/png', base64Data: 'iVBORw0KGgo=' });
});

test('Muse research denials, forks, cancellation and host crash recovery stay within the transport', async t => {
  const { call, calls } = await fixture(t);
  const asked = text(await call([user('check APPROVE')]));
  const detail = JSON.parse(/OMD_MUSE_APPROVAL (\{.*\})$/.exec(asked)[1]);
  assert.equal(text(await call([user(`OMD_MUSE_DECISION ${JSON.stringify({ key: detail.key, approved: false })}`)])), 'decided:no');
  assert.equal(text(await call([user('one')])), 'Answer.');
  assert.equal(text(await call([user('one'), assistant('Answer.'), user('two')], { thread: 't2' })), 'Answer.');
  assert.equal((await calls()).filter(row => row.method === 'session/fork').length, 1);
  const controller = new AbortController();
  const hanging = call([user('HANG')], { signal: controller.signal }).catch(error => error.name);
  await new Promise(resolve => setTimeout(resolve, 300));
  controller.abort();
  assert.equal(await hanging, 'AbortError');
  for (let attempt = 0; attempt < 40 && !(await calls()).some(row => row.method === 'turn/interrupt'); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok((await calls()).some(row => row.method === 'turn/interrupt'));
  const crashed = await call([user('one'), assistant('Answer.'), user('CRASH')]);
  assert.equal(crashed.at(-1).type, 'response.failed');
  assert.equal(text(await call([user('one'), assistant('Answer.'), user('after restart')])), 'Answer.');
  const log = await calls();
  assert.equal(log.filter(row => row.method === 'initialize').length, 2);
  assert.ok(log.some(row => row.method === 'session/resume'));
});

test('Muse refuses schema drift and reports a missing binary', async t => {
  const drifted = await fixture(t, { fingerprint: 'fp-old' });
  assert.match((await drifted.call([user('hi')])).at(-1).response.error.code, /^muse_schema_changed/);
  const missing = await fixture(t, { muse: '/nonexistent/muse' });
  assert.equal((await missing.call([user('hi')])).at(-1).type, 'response.failed');
});

test('durable-log recovery returns the newest answer of a completed run only', () => {
  const log = [
    { payload: { run_id: 'r1', event: { kind: 'assistant_message_committed', text: 'first' } } },
    { payload: { run_id: 'r1', event: { kind: 'terminal', terminal: 'completed' } } },
    { payload: { run_id: 'r2', event: { kind: 'assistant_message_committed', text: 'interrupted' } } },
    { payload: { run_id: 'r2', event: { kind: 'terminal', terminal: 'cancelled' } } },
  ].map(row => JSON.stringify(row)).join('\n');
  assert.equal(recovered(`partial line\n${log}`), 'first');
  assert.equal(recovered(''), null);
});
