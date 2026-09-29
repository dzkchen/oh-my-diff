import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { translateRequest, responseEvents } from '../mods/first-party/omd_claude_cli/index.ts';
import { Capture, Relay, checkCli } from '../mods/first-party/omd_claude_cli/transport.mjs';

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
  const response = responseEvents({ id: 'msg_1', usage: { input_tokens: 10, output_tokens: 5,
    cache_read_input_tokens: 4, cache_creation_input_tokens: 2 },
  content: [{ type: 'text', text: 'Working.' }, { type: 'tool_use', id: 'call_2',
    name: 'mcp__omd__apply_patch', input: { input: '*** Begin Patch' } }] },
  { upstream_requests: 1 }, model, first.reverse);
  assert.equal(response.find(event => event.type === 'response.output_item.done' &&
    event.item.type === 'custom_tool_call').item.input, '*** Begin Patch');
  assert.equal(response.at(-1).response.usage.input_tokens, 16);
  assert.equal(response.at(-1).response.usage.omd_subscription_charge, 'unknown');
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

test('Claude mod rejects route drift and unmapped tools', () => {
  assert.throws(() => translateRequest({ ...prompt, model: 'other' }, model));
  assert.throws(() => translateRequest({ ...prompt, input: [...prompt.input,
    { type: 'function_call', name: 'unknown', call_id: 'bad', arguments: '{}' }] }, model));
  assert.throws(() => responseEvents({ id: 'msg_1', usage: { input_tokens: 1,
    output_tokens: 1 }, content: [{ type: 'tool_use', name: 'mcp__omd__unknown' }] },
  {}, model, {}));
});

test('Claude stream capture preserves usage and tool arguments', () => {
  const capture = new Capture();
  const events = [
    { type: 'message_start', message: { id: 'msg_1', content: [], usage: { input_tokens: 2 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'x', name: 't', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"cmd":' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"pwd"}' } },
    { type: 'content_block_stop', index: 0 },
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
  assert.deepEqual(capture.message.content[0].input, { cmd: 'pwd' });
  assert.equal(capture.message.usage.output_tokens, 5);
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
    const outgoing = request(target, { method: 'POST' }, response => {
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
        const outgoing = request(new URL(`${relay.url}/v1/messages`), { method: 'POST' }, response => {
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

test('missing subscription login and inherited API override fail before routing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omd-claude-auth-'));
  const fake = join(root, 'claude');
  try {
    await writeFile(fake, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.281 (Claude Code)"; else echo \'{"loggedIn":false}\'; fi\n');
    await chmod(fake, 0o700);
    assert.throws(() => checkCli(fake), /claude_ai_pro_or_max_login_required/);
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'fixture';
    try { assert.throws(() => checkCli(fake), /conflicting_api_or_cloud_overrides/); }
    finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('official CLI auth probe uses the approved user identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omd-claude-home-'));
  const fake = join(root, 'claude');
  try {
    await writeFile(fake, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.281 (Claude Code)"; elif [ "$HOME" = "/opt/fixture-home" ] && [ "$USER" = "fixture" ] && [ "$LOGNAME" = "fixture" ]; then echo \'{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"pro"}\'; else echo \'{"loggedIn":false}\'; fi\n');
    await chmod(fake, 0o700);
    assert.throws(() => checkCli(fake, root), /claude_ai_pro_or_max_login_required/);
    assert.doesNotThrow(() => checkCli(fake, '/opt/fixture-home', 'fixture'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('subscription sidecar retains failed attempts in its task request limit', { timeout: 15000 }, async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const root = await mkdtemp(join(tmpdir(), 'omd-claude-bound-'));
  const fake = join(root, 'claude');
  const reserve = createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  await writeFile(fake, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.281 (Claude Code)"; elif [ "$1" = "auth" ]; then echo \'{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"pro"}\'; else exit 1; fi\n', { mode: 0o700 });
  const token = 'local-fixture-token-without-account-access';
  const child = spawn(process.execPath, [new URL('../mods/first-party/omd_claude_cli/transport.mjs', import.meta.url).pathname,
    'serve', String(port), model, fake, root, 'fixture', '2'], { env: { PATH: '/usr/bin:/bin', HOME: root, USER: 'fixture',
      OMD_CLAUDE_LOCAL_TOKEN: token, OMD_READY_TOKEN: 'ready-fixture' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  const exit = once(child, 'exit');
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50 && !ready; attempt++) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/_omd/ready`)).ok; } catch {}
      if (!ready) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, stderr);
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST',
        headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(prompt) });
      const text = await response.text();
      assert.equal(response.status, attempt < 2 ? 200 : 429, text);
      assert.match(text, attempt < 2 ? /response.failed/ : /claude_task_request_limit/);
    }
  } finally {
    child.kill('SIGTERM');
    await exit;
    await rm(root, { recursive: true, force: true });
  }
});
