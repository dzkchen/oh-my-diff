import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { once } from 'node:events';
import activate, { translateRequest, responseEvents, reasoningItem } from './index.ts';
import { CLI_VERSION, Capture, Relay, checkCli, cliEnv, extraUsageAllowed, extraUsageStop, limitHeaders, providerNote, runClaude, stoppedForExtraUsage, upstreamFailure, usingOverage, withoutCliContext } from './transport.mjs';

const pkg = fileURLToPath(new URL('./', import.meta.url));
const model = 'claude-sonnet-5';
const prompt = {
  model, stream: true, instructions: 'Follow user instructions.',
  tools: [{ type: 'function', name: 'exec_command', description: 'Run command',
    parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } },
    { type: 'custom', name: 'apply_patch', description: 'Patch files' }],
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'List files.' }] }],
};

test('Claude mod translates host requests and replays host tool results', () => {
  const first = translateRequest(prompt, model);
  assert.deepEqual(first.frames.at(-1).message.content, [{ type: 'text', text: 'List files.' }]);
  assert.equal(first.extra.tools[0].name, 'mcp__omd__exec_command');
  const next = translateRequest({ ...prompt, input: [...prompt.input,
    { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: '{"cmd":"pwd"}' },
    { type: 'function_call_output', call_id: 'call_1', output: '/repo' }] }, model);
  assert.deepEqual(next.frames.at(-1).message.content, [
    { type: 'tool_result', tool_use_id: 'call_1', content: '/repo', is_error: false },
  ]);
  assert.equal(next.frames.at(-2).message.content[0].name, 'mcp__omd__exec_command');
  const response = responseEvents({ id: 'msg_1', model: 'claude-opus-5-5-20261001', usage: { input_tokens: 10, output_tokens: 5,
    cache_read_input_tokens: 4, cache_creation_input_tokens: 2, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2 } },
  content: [{ type: 'text', text: 'Working.' }, { type: 'tool_use', id: 'call_2',
    name: 'mcp__omd__apply_patch', input: { input: '*** Begin Patch' } }] },
  { upstream_requests: 1 }, model, first.reverse, false, 0.042);
  assert.equal(response.find(event => event.type === 'response.output_item.done' &&
    event.item.type === 'custom_tool_call').item.input, '*** Begin Patch');
  assert.equal(response.at(-1).response.usage.input_tokens, 16);
  assert.equal(response.at(-1).response.usage.omd_subscription_charge, 'unknown');
  assert.equal(response.at(-1).response.model, 'claude-opus-5-5-20261001');
  assert.equal(response.at(-1).response.usage.omd_cache_ttl_seconds, 3600);
  assert.deepEqual(response.at(-1).response.usage.omd_reported_cost, { usd: 0.042, basis: 'client_list_estimate' });
  const credits = responseEvents({ id: 'msg_api', usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
    {}, model, first.reverse, false, 0.001, 'api').at(-1).response.usage;
  assert.equal('omd_subscription_charge' in credits, false);
  assert.deepEqual(credits.omd_reported_cost, { usd: 0.001, basis: 'client_list_estimate' });
  const names = ['constructor', 'toString', '__proto__'];
  const prototypeTools = translateRequest({ ...prompt, tools: names.map(name => ({ type: 'function', name })) }, model);
  assert.deepEqual(prototypeTools.manifest.map(tool => tool.name), names);
  const returned = responseEvents({ id: 'names', model, usage: { input_tokens: 1, output_tokens: 1 }, content: names.map((name, index) => ({ type: 'tool_use', id: `name-${index}`, name: `mcp__omd__${name}`, input: {} })) }, {}, model, prototypeTools.reverse);
  assert.deepEqual(returned.filter(event => event.type === 'response.output_item.done').map(event => event.item.name), names);
});

test('Claude mod folds mid-conversation developer messages into user frames', () => {
  const developer = text => ({ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] });
  const translated = translateRequest({ ...prompt, input: [...prompt.input,
    { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: '{"cmd":"pwd"}' },
    developer('Approvals changed.'),
    { type: 'function_call_output', call_id: 'call_1', output: '/repo' },
    developer('Model switched.'),
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue.' }] }] }, model);
  assert.equal(translated.system, 'Follow user instructions.');
  assert.deepEqual(translated.frames.map(frame => frame.type), ['user', 'assistant', 'user']);
  assert.deepEqual(translated.frames.at(-1).message.content, [
    { type: 'tool_result', tool_use_id: 'call_1', content: '/repo', is_error: false },
    { type: 'text', text: '<developer_message>\nApprovals changed.\n</developer_message>' },
    { type: 'text', text: '<developer_message>\nModel switched.\n</developer_message>' },
    { type: 'text', text: 'Continue.' },
  ]);
});

test('Claude mod forwards images, skips reasoning items and hides ask_claude from Claude leads', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const translated = translateRequest({ ...prompt,
    tools: [...prompt.tools, { type: 'function', name: 'mod_omd_claude_cli_ask_claude', parameters: { type: 'object', properties: {} } }],
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Look.' }, { type: 'input_image', image_url: png }] },
      reasoningItem({ type: 'thinking', thinking: 'Plan.', signature: 'sig' }, 'r1'),
      { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: '{"cmd":"shot"}' },
      { type: 'function_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: 'saved' }, { type: 'input_image', image_url: png }] }] }, model);
  assert.deepEqual(translated.frames[0].message.content[1],
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } });
  assert.deepEqual(translated.frames[1].message.content.map(block => block.type), ['tool_use']);
  assert.deepEqual(translated.frames[2].message.content[0].content.map(block => block.type), ['text', 'image']);
  assert.equal(translated.manifest.some(tool => tool.name.includes('ask_claude')), false);
  assert.throws(() => translateRequest({ ...prompt, input: [{ type: 'message', role: 'user',
    content: [{ type: 'input_image', image_url: 'https://example.com/a.png' }] }] }, model), /unsupported_image_input/);
});

test('Claude mod routes Codex tool search so a Claude lead can load deferred mod tools', () => {
  const research = { type: 'function', name: 'mod_omd_advisor_consult', description: 'Research', parameters: { type: 'object', properties: {} } };
  const translated = translateRequest({ ...prompt, tools: [...prompt.tools, { type: 'tool_search', execution: 'client', description: 'Find tools',
    parameters: { type: 'object', properties: { query: { type: 'string' } } } }],
  input: [...prompt.input, { type: 'tool_search_call', call_id: 's1', execution: 'client', arguments: { query: 'muse' } },
    { type: 'tool_search_output', call_id: 's1', status: 'completed', execution: 'client', tools: [{ type: 'namespace', name: 'functions', tools: [research] }] }] }, model);
  assert.ok(translated.reverse.mod_omd_advisor_consult);
  assert.deepEqual(translated.frames[1].message.content, [{ type: 'tool_use', id: 's1', name: 'mcp__omd__tool_search', input: { query: 'muse' } }]);
  assert.equal(translated.frames[2].message.content[0].content, 'Loaded tools: mcp__omd__mod_omd_advisor_consult');
  const events = responseEvents({ id: 'msg_s', usage: { input_tokens: 1, output_tokens: 1 }, content: [
    { type: 'tool_use', id: 's2', name: 'mcp__omd__tool_search', input: { query: 'git' } },
    { type: 'tool_use', id: 'c1', name: 'mcp__omd__mod_omd_advisor_consult', input: { question: 'q' } }] }, {}, model, translated.reverse);
  const items = events.filter(event => event.type === 'response.output_item.done').map(event => event.item);
  assert.deepEqual(items[0], { type: 'tool_search_call', id: 's2', call_id: 's2', execution: 'client', arguments: { query: 'git' } });
  assert.equal(items[1].name, 'mod_omd_advisor_consult');
});

test('ask_claude consumes waits so write results integrate and refuses prompts over the host byte limit', () => {
  const calls = [];
  let ask;
  activate({ on() {}, command() {}, settings: { ask_claude: true }, state: { set() {}, get: () => false },
    tool: (_, handler) => { ask = handler; },
    host: { tryCall: (operation, input) => {
      calls.push([operation, input]);
      if (operation === 'sidecars.status') return { ok: true, value: { running: true } };
      if (operation === 'agents.spawn') return { ok: true, value: { handle: 'h1' } };
      if (operation === 'agents.wait') return { ok: true, value: { status: 'completed', text: 'done', changed_paths: ['a'] } };
      return { ok: true, value: { status: 'integrated' } };
    } } });
  assert.equal(ask({ prompt: 'é'.repeat(4097) }).reason, 'prompt_over_8192_bytes');
  assert.equal(calls.some(([operation]) => operation === 'agents.spawn'), false);
  assert.equal(ask({ prompt: 'é'.repeat(4096), mode: 'write' }).integration.status, 'integrated');
  assert.deepEqual(calls.filter(([operation]) => operation === 'agents.wait'), [['agents.wait', { handle: 'h1', consume: true }]]);
});

test('Claude mod rejects route drift and carries calls to tools no longer offered as text', () => {
  assert.throws(() => translateRequest({ ...prompt, model: 'other' }, model));
  const compacting = translateRequest({ ...prompt, tools: [], input: [...prompt.input,
    { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: '{"cmd":"pwd"}' },
    { type: 'function_call_output', call_id: 'c1', output: '/repo' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Summarize.' }] }] }, model);
  assert.deepEqual(compacting.frames.map(frame => frame.message.content.map(block => block.text)),
    [['List files.'], ['[called exec_command {"cmd":"pwd"}]'], ['[result of c1]', '/repo', 'Summarize.']]);
  assert.throws(() => responseEvents({ id: 'msg_1', usage: { input_tokens: 1,
    output_tokens: 1 }, content: [{ type: 'tool_use', name: 'mcp__omd__unknown' }] },
  {}, model, {}));
});

test('Claude stream capture streams thinking as reasoning and preserves tool arguments', () => {
  const emitted = [];
  const capture = new Capture(event => emitted.push(event));
  const events = [
    { type: 'message_start', message: { id: 'msg_1', content: [], usage: { input_tokens: 2 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Check pwd.' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'x', name: 't', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"cmd":' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"pwd"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  for (const event of events) {
    const wire = Buffer.from(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    const cut = Math.floor(wire.length / 2);
    capture.feed(wire.subarray(0, cut));
    capture.feed(wire.subarray(cut));
  }
  assert.equal(capture.complete, true);
  assert.deepEqual(capture.message.content[1].input, { cmd: 'pwd' });
  assert.equal(capture.message.usage.output_tokens, 5);
  assert.equal(emitted.find(event => event.type === 'response.reasoning_summary_text.delta').delta, 'Check pwd.');
  const reasoning = emitted.find(event => event.type === 'response.output_item.done').item;
  assert.deepEqual(reasoning.summary, [{ type: 'summary_text', text: 'Check pwd.' }]);
});

test('subscription windows, resets and billing source reach /status headers; failures name their cause', () => {
  const headers = { 'anthropic-ratelimit-unified-5h-utilization': '0.42', 'anthropic-ratelimit-unified-5h-reset': '1790000000',
    'anthropic-ratelimit-unified-7d-utilization': '0.071', 'anthropic-ratelimit-unified-7d-reset': '1790500000' };
  assert.deepEqual(limitHeaders(headers, 'note'), { 'x-claude-limit-name': 'Claude', 'x-omd-provider-note': 'note',
    'x-claude-primary-used-percent': '42', 'x-claude-primary-window-minutes': '300', 'x-claude-primary-reset-at': '1790000000',
    'x-claude-secondary-used-percent': '7.1', 'x-claude-secondary-window-minutes': '10080', 'x-claude-secondary-reset-at': '1790500000' });
  assert.deepEqual(limitHeaders({}, 'note'), { 'x-claude-limit-name': 'Claude', 'x-omd-provider-note': 'note' });
  const overage = { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-overage-status': 'allowed' };
  assert.equal(providerNote('subscription', 'team', headers), 'Claude Team plan limits; extra usage unknown; claude.ai/settings/usage');
  assert.equal(providerNote('subscription', 'max', { 'anthropic-ratelimit-unified-overage-status': 'allowed_warning' }, false),
    'Claude Max plan limits; extra usage on, OMD stops at it; claude.ai/settings/usage');
  assert.equal(providerNote('subscription', 'enterprise', overage), 'Claude Enterprise plan limits; extra usage in use; claude.ai/settings/usage');
  assert.equal(providerNote('subscription', 'pro', { 'anthropic-ratelimit-unified-overage-status': 'rejected' }), 'Claude Pro plan limits; extra usage off; claude.ai/settings/usage');
  assert.match(providerNote('api', null, headers), /^Anthropic API credits \(Console\); no plan limits/);
  for (const note of [providerNote('subscription', 'enterprise', overage, false), providerNote('api')]) assert.ok(Buffer.byteLength(note) <= 120);
  assert.equal(usingOverage(overage), true);
  assert.equal(usingOverage({ 'anthropic-ratelimit-unified-overage-in-use': 'true' }), true);
  assert.equal(usingOverage({ 'anthropic-ratelimit-unified-overage-status': 'allowed' }), false);
  assert.equal(stoppedForExtraUsage({ ...overage, 'anthropic-ratelimit-unified-reset': '2000' }, 1_000_000), true);
  assert.equal(stoppedForExtraUsage({ ...overage, 'anthropic-ratelimit-unified-reset': '2000' }, 3_000_000), false);
  assert.equal(stoppedForExtraUsage(headers), false);
  const both = { ...overage, 'anthropic-ratelimit-unified-5h-reset': '2000', 'anthropic-ratelimit-unified-reset': '9000' };
  assert.equal(stoppedForExtraUsage(both, 3_000_000), false);
  assert.match(extraUsageStop(both).message, new RegExp(new Date(2_000_000).toISOString()));
  assert.equal(upstreamFailure(200, { ...headers, ...overage }, ''), null);
  const limited = upstreamFailure(429, { ...headers, 'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-representative-claim': 'seven_day', 'anthropic-ratelimit-unified-overage-status': 'rejected',
    'anthropic-ratelimit-unified-overage-disabled-reason': 'out_of_credits' }, '');
  assert.deepEqual(limited, { code: 'rate_limit_exceeded',
    message: `Claude seven_day limit reached; resets ${new Date(1790500000 * 1000).toISOString()}; extra usage unavailable (out_of_credits)` });
  assert.equal(upstreamFailure(400, {}, '{"error":{"message":"prompt is too long: 1000001 tokens"}}').code, 'context_length_exceeded');
  assert.equal(upstreamFailure(400, {}, '{"error":{"message":"Your credit balance is too low"}}', 'api').code, 'claude_api_credits_exhausted');
  assert.equal(upstreamFailure(400, {}, '{"error":{"message":"Your credit balance is too low"}}'), null);
  assert.match(upstreamFailure(401, {}, '{"error":{"type":"authentication_error"}}').message, /claude auth login/);
  assert.match(upstreamFailure(401, {}, '', 'api').message, /--console/);
  assert.equal(upstreamFailure(403, {}, '{"error":{"message":"OAuth token has been revoked"}}').code, 'claude_login_expired');
  assert.equal(upstreamFailure(403, {}, '{"error":{"type":"permission_error","message":"Your workspace cannot use this API"}}'), null);
  assert.equal(upstreamFailure(404, {}, '{"error":{"type":"not_found_error","message":"model: claude-x"}}').code, 'claude_model_not_entitled');
  assert.match(upstreamFailure(403, {}, '{"error":{"message":"no access to model claude-x"}}', 'api').message, /Console workspace/);
  assert.equal(upstreamFailure(200, headers, ''), null);
});

test('reported extra usage keeps stopping requests when the reset is missing or malformed and says how it clears', () => {
  const overage = { 'anthropic-ratelimit-unified-overage-in-use': 'true' };
  const reset = value => ({ ...overage, 'anthropic-ratelimit-unified-reset': value });
  assert.equal(stoppedForExtraUsage(overage, 5_000_000), true);
  for (const bad of ['', 'soon', '0', '-5', 'NaN']) assert.equal(stoppedForExtraUsage(reset(bad), 5_000_000), true, bad);
  assert.equal(stoppedForExtraUsage(reset('9000'), 5_000_000), true);
  assert.equal(stoppedForExtraUsage(reset('2000'), 5_000_000), false);
  assert.match(extraUsageStop(overage).message, /until the provider restarts or extra_usage is on/);
  assert.doesNotMatch(extraUsageStop(overage).message, /resets/);
  assert.match(extraUsageStop(reset('9000')).message, /resets 1970-01-01T02:30:00\.000Z.*until that reset/);
});

async function fakeCli(script) {
  const root = await mkdtemp(join(tmpdir(), 'omd-claude-run-'));
  await writeFile(join(root, 'claude'), script, { mode: 0o700 });
  return root;
}

const run = (claude, signal = new AbortController().signal, translated = null) => runClaude(prompt, { slug: model, cli: model,
  efforts: [], thinking: false, window: 200000 }, claude, signal, () => {}, { translated }).then(() => null, error => error);

test('cancelling at any point before the CLI starts never launches it and leaves nothing behind', async () => {
  const scratch = async () => (await readdir('/private/tmp')).filter(name => name.startsWith('omd-claude-'));
  const before = new Set(await scratch());
  const root = await fakeCli('#!/bin/sh\ntouch "$(dirname "$0")/launched"\n');
  try {
    for (const abortAt of [1, 2, 3, 4]) {
      let reads = 0;
      const signal = { get aborted() { return ++reads >= abortAt; }, addEventListener() {}, removeEventListener() {} };
      assert.equal((await run(join(root, 'claude'), signal))?.message, 'claude_request_cancelled', `abort at check ${abortAt}`);
      await assert.rejects(stat(join(root, 'launched')), { code: 'ENOENT' }, `abort at check ${abortAt}`);
    }
    for (let attempt = 0; attempt < 50 && (await scratch()).some(name => !before.has(name)); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.deepEqual((await scratch()).filter(name => !before.has(name)), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a missing CLI fails the request instead of crashing the process', async () => {
  assert.equal((await run('/nonexistent/omd-claude'))?.code, 'ENOENT');
});

test('a CLI that exits during history replay fails the request instead of crashing the process', async () => {
  const root = await fakeCli('#!/bin/sh\nexec 0<&-\nsleep 0.3\n');
  try {
    const frames = Array.from({ length: 4 }, () => ({ type: 'user', message: { role: 'user', content: 'x'.repeat(4 * 1024 * 1024) } }));
    const outcome = await run(join(root, 'claude'), undefined, { manifest: [], extra: {}, system: '', frames, reverse: new Map() });
    assert.equal(outcome?.message, 'claude_history_replay_exited');
    await new Promise(resolve => setTimeout(resolve, 200));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Claude stream capture preserves UTF-8 across network chunks', () => {
  const capture = new Capture();
  const events = [
    { type: 'message_start', message: { id: 'msg_utf8', content: [], usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'café 🌎' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ];
  for (const event of events) {
    const wire = Buffer.from(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    for (const byte of wire) capture.feed(Buffer.from([byte]));
  }
  assert.equal(capture.complete, true);
  assert.equal(capture.message.content[0].text, 'café 🌎');
});

test('one upstream request is admitted and a second is refused', async () => {
  const upstream = createServer((incoming, response) => {
    incoming.resume();
    incoming.on('end', () => response.writeHead(429, { 'content-type': 'application/json' })
      .end('{"error":{"type":"rate_limit_error"}}'));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const relay = new Relay(`http://127.0.0.1:${upstream.address().port}`, []);
  await relay.listen();
  const send = () => new Promise((resolve, reject) => {
    const target = new URL(`${relay.url}/v1/messages`);
    const outgoing = request(target, { method: 'POST', headers: { authorization: 'Bearer fixture' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    outgoing.on('error', reject);
    outgoing.end('{}');
  });
  try {
    assert.equal(await send(), 429);
    assert.equal(await send(), 400);
    assert.equal(relay.used, 1);
    assert.equal(relay.denied, 1);
  } finally {
    relay.abort();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('the relay sends nothing upstream for the wrong credential or model and stops at opted-out extra usage', async () => {
  let forwarded = 0;
  let served = {};
  const upstream = createServer((incoming, response) => {
    forwarded++;
    incoming.resume();
    incoming.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream', ...served });
      response.end('event: ping\ndata: {"type":"ping"}\n\n');
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const attempt = async (policy, headers, body = { model }) => {
    const relay = new Relay(base, () => {}, () => {}, { model, ...policy });
    await relay.listen();
    try {
      await new Promise(resolve => {
        const outgoing = request(new URL(`${relay.url}/v1/messages`), { method: 'POST', headers }, response => {
          response.resume();
          response.on('close', resolve);
        });
        outgoing.on('error', resolve);
        outgoing.end(JSON.stringify(body));
      });
      return relay;
    } finally { relay.abort(); }
  };
  try {
    assert.equal((await attempt({}, { 'x-api-key': 'fixture' })).refusal.code, 'claude_billing_route_mismatch');
    assert.equal((await attempt({ billing: 'api' }, { authorization: 'Bearer fixture' })).refusal.code, 'claude_billing_route_mismatch');
    assert.equal((await attempt({}, { authorization: 'Bearer fixture' }, { model: 'claude-other' })).refusal.code, 'claude_model_mismatch');
    assert.equal(forwarded, 0);
    served = { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-overage-status': 'allowed' };
    assert.equal((await attempt({ billing: 'api' }, { 'x-api-key': 'fixture' })).refusal, null);
    const stopped = await attempt({ extraUsage: false }, { authorization: 'Bearer fixture' });
    assert.equal(stopped.refusal.code, 'claude_extra_usage_blocked');
    assert.match(stopped.refusal.message, /may still bill this one request/);
    assert.equal(forwarded, 2);
  } finally {
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('CLI-added environment and account context never reach the model', () => {
  const reminder = '\n\n<system-reminder>\nAs you answer the user\'s questions, you can use the following context:\n# userEmail\nThe user\'s email address is user@example.com.\n\nClaude Code attached this context automatically; it isn\'t part of the user\'s message.\n</system-reminder>';
  const omd = 'tool output that quotes <system-reminder>keep me</system-reminder>';
  const body = withoutCliContext({ model, messages: [
    { role: 'user', content: [{ type: 'text', text: reminder.trim() }, { type: 'text', text: 'Run pwd.' }] },
    { role: 'system', content: '# Environment\nYou have been invoked in the following environment: \n - Primary working directory: /private/tmp/omd-claude-x' },
    { role: 'system', content: [{ type: 'text', text: '# Environment\nYou have been invoked in the following environment: ' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'mcp__omd__exec_command', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: `/repo${reminder}` },
      { type: 'text', text: `${omd}${reminder}` }] },
    { role: 'system', content: [{ type: 'text', text: 'Today\'s date is 2026-10-13.' }] },
    { role: 'user', content: [{ type: 'text', text: reminder.trim() }] },
    { role: 'user', content: reminder }] });
  assert.deepEqual(body.messages.map(message => message.role), ['user', 'assistant', 'user', 'system']);
  assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'Run pwd.' }]);
  assert.equal(body.messages[2].content[0].content, '/repo');
  assert.equal(body.messages[2].content[1].text, omd);
  assert.equal(JSON.stringify(body).includes('user@example.com'), false);
});

test('the extra-usage opt-out is read from the store per request and fails safe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omd-claude-settings-'));
  const store = join(root, 'mods.json');
  const allowed = () => extraUsageAllowed(join(root, 'routes/claude/route.json'), '/real/omd_claude_cli');
  try {
    assert.equal(await allowed(), false);
    await writeFile(store, JSON.stringify({ mods: [{ path: `${root}/sources/omd_claude_cli/`, settings: {} }] }));
    assert.equal(await allowed(), true);
    await writeFile(store, JSON.stringify({ mods: [{ path: '/real/omd_claude_cli', settings: { extra_usage: false } }] }));
    assert.equal(await allowed(), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a malformed upstream stream ends the relayed response instead of hanging', async () => {
  const upstream = createServer((incoming, response) => {
    incoming.resume();
    incoming.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('event: message_start\ndata: {not json}\n\n');
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const relay = new Relay(`http://127.0.0.1:${upstream.address().port}`);
  await relay.listen();
  try {
    const outcome = await Promise.race([
      new Promise(resolve => {
        const outgoing = request(new URL(`${relay.url}/v1/messages`), { method: 'POST', headers: { authorization: 'Bearer fixture' } }, response => {
          response.resume();
          response.on('error', () => resolve('closed'));
          response.on('close', () => resolve('closed'));
        });
        outgoing.on('error', () => resolve('closed'));
        outgoing.end('{}');
      }),
      new Promise(resolve => setTimeout(() => resolve('hung'), 3000)),
    ]);
    assert.equal(outcome, 'closed');
    assert.equal(relay.failure, 'Error');
  } finally {
    relay.abort();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('missing subscription login fails before routing and inherited API overrides never reach the CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omd-claude-auth-'));
  const fake = join(root, 'claude');
  const names = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_USE_MANTLE', 'ANTHROPIC_PROFILE', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS'];
  try {
    await writeFile(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${CLI_VERSION}"; elif [ -n "$ANTHROPIC_API_KEY" ]; then echo '{"loggedIn":true,"apiProvider":"firstParty","authMethod":"claude.ai","subscriptionType":"max"}'; else echo '{"loggedIn":false}'; fi\n`);
    await chmod(fake, 0o700);
    for (const name of names) process.env[name] = 'fixture';
    assert.throws(() => checkCli(fake), /claude_ai_subscription_login_required/);
    assert.deepEqual(names.filter(name => name in cliEnv({ ANTHROPIC_BASE_URL: 'relay' })), ['CLAUDE_CODE_MAX_OUTPUT_TOKENS']);
    assert.equal(cliEnv({ ANTHROPIC_BASE_URL: 'relay' }).ANTHROPIC_BASE_URL, 'relay');
  } finally {
    for (const name of names) delete process.env[name];
    await rm(root, { recursive: true, force: true });
  }
});

test('eligibility follows the official auth status for each billing route', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omd-claude-eligibility-'));
  const fake = join(root, 'claude');
  const status = join(root, 'status.json');
  const login = value => writeFile(status, JSON.stringify({ loggedIn: true, apiProvider: 'firstParty', ...value }));
  try {
    await writeFile(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${CLI_VERSION}"; else cat "${status}"; fi\n`, { mode: 0o700 });
    for (const plan of ['pro', 'max', 'team', 'enterprise']) {
      await login({ authMethod: 'claude.ai', subscriptionType: plan });
      assert.equal(checkCli(fake).subscriptionType, plan);
      assert.throws(() => checkCli(fake, 'api'), /claude_console_api_key_login_required/);
    }
    for (const value of [{ authMethod: 'claude.ai', subscriptionType: null }, { authMethod: 'claude.ai', subscriptionType: 'pro', apiProvider: 'bedrock' },
      { authMethod: 'api_key', apiKeySource: '/login managed key' }, { authMethod: 'oauth_token' }]) {
      await login(value);
      assert.throws(() => checkCli(fake), /claude_ai_subscription_login_required/);
    }
    await login({ authMethod: 'api_key', apiKeySource: '/login managed key' });
    assert.doesNotThrow(() => checkCli(fake, 'api'));
    await login({ authMethod: 'api_key', apiKeySource: 'apiKeyHelper' });
    assert.throws(() => checkCli(fake, 'api'), /claude_console_api_key_login_required/);
    await writeFile(fake, '#!/bin/sh\necho "2.1.285 (Claude Code)"\n', { mode: 0o700 });
    assert.throws(() => checkCli(fake), new RegExp(`claude_cli_${CLI_VERSION.split(' ')[0]}_required`));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('official CLI auth probe uses the approved user identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omd-claude-home-'));
  const fake = join(root, 'claude');
  try {
    await writeFile(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${CLI_VERSION}"; elif [ "$HOME" = "/opt/fixture-home" ] && [ "$USER" = "fixture" ] && [ "$LOGNAME" = "fixture" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"pro"}'; else echo '{"loggedIn":false}'; fi\n`);
    await chmod(fake, 0o700);
    assert.throws(() => checkCli(fake, 'subscription', root), /claude_ai_subscription_login_required/);
    assert.doesNotThrow(() => checkCli(fake, 'subscription', '/opt/fixture-home', 'fixture'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('provider answers readiness, rejects unknown models and hands its shared port to a later session', { timeout: 20000 }, async () => {
  const { spawn } = await import('node:child_process');
  const root = await mkdtemp(join(tmpdir(), 'omd-claude-serve-'));
  const fake = join(root, 'claude');
  await writeFile(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${CLI_VERSION}"; elif [ "$1" = "auth" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"pro"}'; else exit 1; fi\n`, { mode: 0o700 });
  const reserve = createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const route = join(root, 'route.json');
  await writeFile(route, JSON.stringify({ port, claude: fake, default: model,
    models: [{ slug: model, cli: model, family: 'sonnet', efforts: [], thinking: false, window: 200000 }] }));
  const token = 'local-fixture-token-without-account-access';
  const start = ready => spawn(process.execPath, [new URL('./transport.mjs', import.meta.url).pathname,
    'serve', route, root, 'fixture'], { env: { PATH: '/usr/bin:/bin', OMD_CLAUDE_LOCAL_TOKEN: token, OMD_READY_TOKEN: ready }, stdio: 'ignore' });
  const ready = async expected => {
    for (let attempt = 0; attempt < 60; attempt++) {
      try { if (await (await fetch(`http://127.0.0.1:${port}/_omd/ready`)).text() === `OMD_READY:${expected}`) return true; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  };
  const call = body => fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST',
    headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const first = start('first');
  let second;
  try {
    assert.ok(await ready('first'));
    assert.equal((await call({ ...prompt, model: 'claude-unknown' })).status, 400);
    assert.match(await (await call(prompt)).text(), /response\.failed/);
    second = start('second');
    assert.ok(await ready('second'));
    first.kill('SIGTERM');
    await once(first, 'exit');
    assert.ok(await ready('second'));
    assert.match(await (await call(prompt)).text(), /response\.failed/);
  } finally {
    first.kill('SIGKILL');
    second?.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});
