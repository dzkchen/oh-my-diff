import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { callback } from '../../../tests/mod_runner.mjs';
import { translateRequest, responseEvents } from './index.ts';
import { CLI_VERSION, Capture, Relay, checkCli, cliEnv, extraUsageAllowed, runClaude, upstreamFailure, withoutCliContext } from './transport.mjs';

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

test('history from another provider carries over: opaque reasoning dropped, hosted calls kept as text', () => {
  const carried = translateRequest({ ...prompt, input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Find the docs.' }] },
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' },
    { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'codex docs' } },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Found them.' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Summarize.' }] }] }, model);
  assert.deepEqual(carried.frames.map(frame => frame.message.content.map(block => block.text)), [
    ['Find the docs.'], ['[searched the web {"type":"search","query":"codex docs"}]', 'Found them.'], ['Summarize.']]);
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
  const root = await fakeCli('#!/bin/sh\ntouch "$(dirname "$0")/launched"\n');
  const before = new Set(await scratch());
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

test('an expired login and a missing entitlement tell the user to run /claude login', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omd-claude-expired-'));
  const fake = join(root, 'claude');
  try {
    await writeFile(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${CLI_VERSION}"; else echo '{"loggedIn":false}'; fi\n`);
    await chmod(fake, 0o700);
    assert.throws(() => checkCli(fake), /claude_ai_subscription_login_required: run `\/claude login`/);
    assert.throws(() => checkCli(fake, 'api'), /claude_console_api_key_login_required: run `\/claude login api`/);
  } finally { await rm(root, { recursive: true, force: true }); }
  const expired = upstreamFailure(401, {}, '{"error":{"type":"authentication_error"}}');
  assert.equal(expired.code, 'claude_login_expired');
  assert.match(expired.message, /run `\/claude login` and retry/);
  assert.equal(upstreamFailure(403, {}, 'OAuth token has been revoked').code, 'claude_login_expired');
  assert.match(upstreamFailure(401, {}, '', 'api').message, /run `\/claude login api` and retry/);
  const entitlement = upstreamFailure(403, {}, '{"error":{"message":"your account cannot use this model"}}');
  assert.equal(entitlement.code, 'claude_model_not_entitled');
  assert.match(entitlement.message, /\/model.*`\/claude login`/);
  assert.match(upstreamFailure(404, {}, 'model not found', 'api').message, /`\/claude login api`/);
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


test('the transport shows a foreign holder of its port neither the local token nor the readiness nonce', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omd-claude-port-'));
  const token = 'local-token-'.repeat(4);
  const seen = [];
  const squatter = createServer(async (incoming, response) => {
    let body = '';
    for await (const chunk of incoming) body += chunk;
    seen.push(JSON.stringify(incoming.headers) + body);
    response.end('OMD_READY:other');
  });
  await new Promise(resolve => squatter.listen(0, '127.0.0.1', resolve));
  const claude = join(directory, 'claude');
  await writeFile(claude, `#!/bin/sh\nif [ "$1" = --version ]; then echo '${CLI_VERSION}'; else echo '{"loggedIn":true,"apiProvider":"firstParty","authMethod":"claude.ai","subscriptionType":"pro"}'; fi\n`);
  await chmod(claude, 0o755);
  const routePath = join(directory, 'route.json');
  await writeFile(routePath, JSON.stringify({ port: squatter.address().port, claude, billing: 'subscription', models: [] }));
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./transport.mjs', import.meta.url)), 'serve', routePath, directory, 'user'],
      { env: { OMD_CLAUDE_LOCAL_TOKEN: token, OMD_READY_TOKEN: 'nonce-a' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let output = '';
    child.stderr.on('data', chunk => { output += chunk; });
    assert.notEqual(await new Promise(resolve => child.on('exit', resolve)), 0);
    assert.match(output, /provider_port_in_use/);
    assert.ok(seen.length);
    assert.ok(!seen.some(entry => entry.includes(token) || entry.includes('nonce-a')));
  } finally {
    squatter.closeAllConnections();
    squatter.close();
    await rm(directory, { recursive: true, force: true });
  }
});

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));

function modEvent(event, payload, state, answer, name) {
  const calls = [];
  const output = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, settings: {}, package: { id: manifest.id }, state, event, payload, name }, call => {
    calls.push(call);
    return answer(call);
  });
  assert.equal(output.error, undefined, output.error);
  return { state: output.state, calls, value: output.value };
}
const notices = calls => calls.filter(call => call.operation === 'terminal.notice').map(call => call.arguments.text);

test('login runs as a background process that says the sign-in link once and reports through setup', () => {
  const started = modEvent('channel', { channel: 'omd_claude_cli/login', data: { billing: 'api' } }, null, call => ({
    'process.which': { found: [{ name: 'node', path: '/bin/node', sha256: 'a' }] }, 'process.start': { session: 'claude_login', running: true } })[call.operation]);
  assert.deepEqual(started.calls[0].arguments, { names: ['node'], sandbox: 'none' });
  const { arguments: argv, ...start } = started.calls[1].arguments;
  assert.deepEqual(start, { session: 'claude_login', name: 'node', path: '/bin/node', sha256: 'a', sandbox: 'none', framing: 'raw', notify: ['output', 'exit'] });
  assert.deepEqual([argv[0], argv[1], JSON.parse(argv[3])], ['--input-type=module', '-e', ['auth', 'login', '--console']]);
  const link = 'https://claude.ai/oauth/authorize?code=true&state=x';
  const process = (kind, data) => {
    let reads = 0;
    return state => modEvent('process_event', { session: 'claude_login', kind, bytes: 1 }, state, call => call.operation === 'process.exchange'
      ? { messages: reads++ || !data ? [] : [{ stream: 'stdout', data }], running: true }
      : call.operation === 'packages.list' ? { packages: [] } : {});
  };
  const output = process('output', `\u001b[1mOpening browser\u001b[0m\nVisit: ${link}\n`)(started.state);
  assert.deepEqual(notices(output.calls), ['Your browser should open; if not, open this link:', link, 'If the page shows a code, run /claude code CODE']);
  const code = state => modEvent('channel', { channel: 'omd_claude_cli/code', data: { code: 'abc' } }, state, () => ({ messages: [], running: true }));
  assert.ok(manifest.subscriptions.channels.includes('omd_claude_cli/code'));
  assert.deepEqual(code(output.state).calls[0].arguments, { session: 'claude_login', wait_ms: 0, send: ['abc\n'] });
  assert.deepEqual(notices(code(null).calls), ['No Claude login is waiting for a code; run /claude login']);
  const exited = process('exit', 'Login failed\n')(output.state);
  assert.deepEqual(notices(exited.calls), ['Claude setup could not find the installed mod; enable it in /mods and run /claude login again']);
  assert.equal(exited.state.login, null);
});

test('the status probe names a host error instead of reporting a missing CLI', () => {
  const status = answer => modEvent('command', '', null, answer, 'claude').value.display;
  assert.match(status(() => { throw new Error('exec_program_too_large'); }), /^CLI: check failed: exec_program_too_large/);
  assert.match(status(() => ({ exit_code: 0, stdout: '{"version":null,"auth":null}', stderr: '' })), /^CLI: not found on PATH/);
});
