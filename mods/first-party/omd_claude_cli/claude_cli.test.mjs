import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeSync, constants, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { callback } from '../../../tests/mod_runner.mjs';
import { CLI_MINIMUM, cliSupported, translateRequest, responseEvents } from './index.ts';
import { publishable } from './setup.mjs';
import { Capture, Relay, accountLogins, checkCli, cliEnv, extraUsageAllowed, runClaude, upstreamFailure, withoutCliContext } from './transport.mjs';

const CLI_VERSION = `${CLI_MINIMUM} (Claude Code)`;

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
  assert.deepEqual([credits.omd_reported_cost, credits.cost_microusd], [{ usd: 0.001, basis: 'client_list_estimate' }, 1000]);
  assert.equal('cost_microusd' in response.at(-1).response.usage, false);
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

const entry = { slug: model, model, cli: model, efforts: [], thinking: false, window: 200000 };
const run = (claude, signal = new AbortController().signal, translated = null) => runClaude(prompt, entry, claude, signal, () => {}, { translated }).then(() => null, error => error);

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

test('large whitespace blocks and repeated reminder headers are stripped in linear time', () => {
  const blank = ' '.repeat(80 * 1024);
  const header = '<system-reminder>\nAs you answer the user\'s questions, you can use the following context:\n';
  const flood = header.repeat(8000);
  const closing = 'Claude Code attached this context automatically;\n</system-reminder>';
  const started = performance.now();
  const body = withoutCliContext({ model, messages: [
    { role: 'user', content: [{ type: 'text', text: blank }, { type: 'tool_result', tool_use_id: 'call_1', content: `${blank}\n` }] },
    { role: 'user', content: blank }, { role: 'user', content: flood }, { role: 'user', content: `ok ${flood}${closing} \n` }] });
  assert.ok(performance.now() - started < 200, `took ${performance.now() - started} ms`);
  assert.equal(body.messages[0].content[0].text, blank);
  assert.deepEqual(body.messages.slice(2).map(message => message.content), [flood, 'ok']);
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

test('each Claude account signs in and runs through its own config directory, and a missing login fails only that account', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omd-claude-accounts-'));
  const fake = join(root, 'claude');
  const account = (name, config_dir) => ({ name, billing: 'subscription', config_dir, models: [] });
  process.env.CLAUDE_CONFIG_DIR = '/inherited';
  try {
    await writeFile(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${CLI_VERSION}"; elif [ "$1" = "auth" ] && { [ -z "$CLAUDE_CONFIG_DIR" ] || [ "$CLAUDE_CONFIG_DIR" = /accounts/work ]; }; then echo '{"loggedIn":true,"apiProvider":"firstParty","authMethod":"claude.ai","subscriptionType":"max"}'; elif [ "$1" = "auth" ]; then echo '{"loggedIn":false}'; else echo "$CLAUDE_CONFIG_DIR" > "$(dirname "$0")/dir"; fi\n`);
    await chmod(fake, 0o700);
    const logins = accountLogins({ claude: fake, accounts: [account('default', null), account('work', '/accounts/work'), account('spare', '/accounts/spare')] });
    assert.deepEqual([...logins], [['default', { plan: 'max' }], ['work', { plan: 'max' }], ['spare', { error: 'claude_ai_subscription_login_required: run `/claude login spare`' }]]);
    assert.throws(() => accountLogins({ claude: fake, accounts: [account('spare', '/accounts/spare')] }), /run `\/claude login spare`/);
    await runClaude(prompt, entry, fake, new AbortController().signal, () => {}, { account: account('work', '/accounts/work') }).catch(() => {});
    assert.equal((await readFile(join(root, 'dir'), 'utf8')).trim(), '/accounts/work');
    assert.match(upstreamFailure(401, {}, '', 'api', account('work', '/accounts/work')).message, /run `\/claude login api work`/);
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    await rm(root, { recursive: true, force: true });
  }
});

test('the 16-model list keeps every account\'s default model and account order', () => {
  const accounts = ['a', 'b', 'c'].map(name => ({ name, models: Array.from({ length: 8 }, (_, index) => `${name}${index}`) }));
  const listed = publishable(accounts);
  assert.equal(listed.length, 16);
  assert.deepEqual(listed.filter(slug => slug.endsWith('0')), ['a0', 'b0', 'c0']);
  assert.deepEqual(listed.slice(0, 8), accounts[0].models);
  assert.equal(listed.indexOf('b0') < listed.indexOf('c0'), true);
});

test('setup adds each signed-in account with its own route and suffixed models, refuses taken route names and removes an account', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'omd-claude-setup-')));
  const store = join(root, 'store');
  const bin = join(root, 'bin');
  try {
    await mkdir(join(store, 'sources'), { recursive: true });
    await cp(new URL('.', import.meta.url).pathname, join(store, 'sources/omd_claude_cli'), { recursive: true });
    await mkdir(bin);
    await writeFile(join(bin, 'claude'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const argv = process.argv.slice(2);
const dir = process.env.CLAUDE_CONFIG_DIR ?? '';
if (argv[0] === '--version') console.log('${CLI_VERSION}');
else if (argv[0] === 'auth') {
  appendFileSync('${root}/auth.log', argv[1] + ' ' + dir + '\\n');
  console.log(JSON.stringify({ loggedIn: true, apiProvider: 'firstParty', ...dir ? { authMethod: 'api_key', apiKeySource: '/login managed key', email: 'work@example.com' } : { authMethod: 'claude.ai', subscriptionType: 'max', email: 'me@example.com' } }));
} else for await (const line of createInterface({ input: process.stdin })) {
  const row = JSON.parse(line);
  if (row.type === 'control_request') console.log(JSON.stringify({ type: 'control_response', response: { response: { models: [
    { value: 'default', resolvedModel: 'claude-opus-5' }, { value: 'sonnet', resolvedModel: 'claude-sonnet-5', description: 'Sonnet 5 · fast', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
    { value: 'opus', resolvedModel: 'claude-opus-5', description: 'Opus 5', supportsEffort: true, supportedEffortLevels: ['high'] }] } } }));
  else console.log(JSON.stringify({ type: 'result', modelUsage: { [argv[argv.indexOf('--model') + 1]]: { contextWindow: 200000 } } }));
}
`, { mode: 0o755 });
    const setup = (...args) => spawnSync(process.execPath, [join(store, 'sources/omd_claude_cli/setup.mjs'), ...args],
      { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_CONFIG_DIR: '/inherited' } });
    const host = async () => JSON.parse(await readFile(join(store, 'host.json'), 'utf8'));
    const first = setup('default', 'subscription');
    assert.equal(first.status, 0, first.stderr);
    const added = setup('work', 'api', join(store, 'routes/claude/accounts/work'));
    assert.equal(added.status, 0, added.stderr);
    const result = JSON.parse(added.stdout);
    const dir = await realpath(join(store, 'routes/claude/accounts/work'));
    assert.deepEqual(result.accounts.map(account => [account.name, account.billing, account.email, account.config_dir, account.route]),
      [['default', 'subscription', 'me@example.com', null, 'claude'], ['work', 'api', 'work@example.com', dir, 'claude-work']]);
    assert.deepEqual(result.models.map(model => [model.slug, model.display]), [['claude-opus-5', 'Claude Opus 5'], ['claude-sonnet-5', 'Claude Sonnet 5'],
      ['claude-opus-5.work', 'Claude Opus 5 · work'], ['claude-sonnet-5.work', 'Claude Sonnet 5 · work']]);
    const written = await host();
    assert.deepEqual(written.routes.map(route => [route.name, route.provider, route.model, route.rates.included_subscription, route.rates.provider_billed]),
      [['claude', 'omd_claude_cli', 'claude-opus-5', true, undefined], ['claude-work', 'omd_claude_cli', 'claude-opus-5.work', undefined, true]]);
    const grant = written.services.find(service => service.id === 'claude_cli');
    assert.ok(grant.read_paths.includes(dir));
    assert.equal(grant.route.rates.provider_billed, true);
    const route = JSON.parse(await readFile(join(store, 'routes/claude/route.json'), 'utf8'));
    assert.deepEqual(route.accounts[1].models[0], { slug: 'claude-opus-5.work', model: 'claude-opus-5', cli: 'claude-opus-5', family: 'opus', name: 'Claude Opus 5 · work',
      description: 'Opus 5', efforts: ['high'], thinking: false, window: 200000 });
    await writeFile(join(store, 'host.json'), JSON.stringify({ ...written, routes: [...written.routes, { ...written.routes[0], name: 'claude-spare', provider: 'omd_profiles' }] }));
    assert.match(setup('spare', 'api').stderr, /claude_route_name_taken: another route is named claude-spare/);
    await writeFile(join(store, 'host.json'), JSON.stringify(written));
    assert.match(setup('Work', 'subscription').stderr, /claude_account_name_invalid/);
    assert.match(setup('1work', 'subscription').stderr, /claude_account_name_invalid/);
    const failed = setup('team', 'subscription', join(store, 'routes/claude/accounts/team'));
    assert.match(failed.stderr, /claude_ai_subscription_login_required/);
    await assert.rejects(stat(join(store, 'routes/claude/accounts/team')));
    assert.match(await readFile(join(root, 'auth.log'), 'utf8'), new RegExp(`logout ${join(store, 'routes/claude/accounts/team')}\n$`));
    const held = openSync(join(store, 'store.lock'), constants.O_WRONLY | constants.O_CREAT | 0x20);
    const locked = setup('crew', 'api', join(store, 'routes/claude/accounts/crew'));
    closeSync(held);
    assert.match(locked.stderr, /host_config_locked/);
    await assert.rejects(stat(join(store, 'routes/claude/accounts/crew')));
    assert.match(await readFile(join(root, 'auth.log'), 'utf8'), new RegExp(`logout ${join(store, 'routes/claude/accounts/crew')}\n$`));
    assert.deepEqual(JSON.parse(await readFile(join(store, 'routes/claude/route.json'), 'utf8')).accounts.map(account => account.name), ['default', 'work']);
    assert.match(setup('stray', 'api', join(root, 'elsewhere')).stderr, /claude_account_directory_outside_store/);
    await assert.rejects(stat(join(store, 'routes/claude/accounts/stray')));
    const removed = setup('work', 'remove');
    assert.equal(removed.status, 0, removed.stderr);
    assert.deepEqual((await host()).routes.map(route => route.name), ['claude']);
    await assert.rejects(stat(dir));
    assert.match(await readFile(join(root, 'auth.log'), 'utf8'), new RegExp(`logout ${dir}\n$`));
    const logouts = (await readFile(join(root, 'auth.log'), 'utf8')).match(/^logout/gm).length;
    const kept = setup('default', 'remove');
    assert.equal(JSON.parse(kept.stdout).signed_out, null);
    assert.equal((await readFile(join(root, 'auth.log'), 'utf8')).match(/^logout/gm).length, logouts);
    const empty = await host();
    assert.deepEqual([empty.routes, empty.services.filter(service => service.id === 'claude_cli')], [[], []]);
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
  await writeFile(routePath, JSON.stringify({ port: squatter.address().port, claude, accounts: [{ name: 'default', billing: 'subscription', config_dir: null, models: [] }] }));
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

const clock = 1_800_000_000_000;

function modEvent(event, payload, state, answer, name) {
  const calls = [];
  const output = callback({ virtual_time_ms: clock, source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, settings: {}, package: { id: manifest.id }, state, event, payload, name }, call => {
    calls.push(call);
    return answer(call);
  });
  assert.equal(output.error, undefined, output.error);
  return { state: output.state, calls, value: output.value };
}
const notices = calls => calls.filter(call => call.operation === 'terminal.notice').map(call => call.arguments.text);

test('login runs as a background process that says the sign-in link once and reports through setup', () => {
  const mod = [{ id: 'omd_claude_cli', path: '/store/sources/omd_claude_cli' }];
  const answer = (data = '', alive = true, process = '4242-1700000000000', packages = mod) => call => {
    if (call.operation === 'process.status' && !alive) throw new Error('process_not_found');
    return { 'process.which': { found: [{ name: 'node', path: '/bin/node', sha256: 'a' }] }, 'process.exchange': { messages: data ? [{ stream: 'stdout', data }] : [], running: true },
      'session.info': { process_id: process }, 'packages.list': { packages }, 'exec.run': { exit_code: 0, stdout: JSON.stringify({ version: '2.1.420 (Claude Code)', auth: [] }), stderr: '' } }[call.operation] ?? {};
  };
  const channel = (name, data, state, alive, process) => modEvent('channel', { channel: `omd_claude_cli/${name}`, data }, state, answer('', alive, process));
  const started = channel('login', { billing: 'api', account: 'work' }, null);
  assert.deepEqual(started.calls.find(call => call.operation === 'process.which').arguments, { names: ['node'], sandbox: 'none' });
  const { arguments: argv, session, ...start } = started.calls.find(call => call.operation === 'process.start').arguments;
  assert.equal(session, `claude_login_4242-1700000000000_${clock}`);
  assert.equal(channel('login', { billing: 'api', account: 'work' }, null).calls.find(call => call.operation === 'process.start').arguments.session, session);
  assert.deepEqual(start, { name: 'node', path: '/bin/node', sha256: 'a', sandbox: 'none', framing: 'raw', notify: ['output', 'exit'] });
  assert.deepEqual([argv[0], argv[1], JSON.parse(argv[3]), argv[4]], ['--input-type=module', '-e', ['auth', 'login', '--console'], '/store/routes/claude/accounts/work']);
  const root = mkdtempSync(join(tmpdir(), 'omd-claude-login-'));
  try {
    writeFileSync(join(root, 'claude'), '#!/bin/sh\necho "$1|$ANTHROPIC_API_KEY|$CLAUDE_SECURESTORAGE_CONFIG_DIR|$CLAUDE_CODE_OAUTH_TOKEN|$CLAUDE_CONFIG_DIR|$KEEP"\n', { mode: 0o755 });
    const env = { PATH: `${root}:/usr/bin:/bin`, ANTHROPIC_API_KEY: 'k', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/elsewhere', CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_CONFIG_DIR: '/inherited', KEEP: 'kept' };
    const login = spawnSync(process.execPath, [argv[0], argv[1], argv[2], JSON.stringify(['auth']), '/store/routes/claude/accounts/work'], { encoding: 'utf8', env });
    assert.equal(login.stdout, 'auth||||/store/routes/claude/accounts/work|kept\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
  const refused = (version, error) => modEvent('channel', { channel: 'omd_claude_cli/login', data: { billing: 'subscription', account: 'default' } }, null, call =>
    call.operation === 'exec.run' ? (error ? (() => { throw new Error(error); })() : { exit_code: 0, stdout: JSON.stringify({ version, auth: [] }), stderr: '' }) : answer()(call));
  for (const [version, error, text] of [[null, null, /the Claude CLI was not found on PATH; install it with curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash$/],
    ['2.1.306 (Claude Code)', null, /Claude CLI 2\.1\.306 \(Claude Code\) is installed, but omd_claude_cli needs 2\.1\.307 or a newer 2\.x; update it with claude update/],
    [null, 'exec_program_unavailable', /Node\.js was not found on PATH\. Install it \(brew install node/]]) {
    const run = refused(version, error);
    assert.equal(run.calls.some(call => call.operation === 'process.start'), false);
    assert.match(notices(run.calls).at(-1), text);
  }
  const link = 'https://claude.ai/oauth/authorize?code=true&state=x';
  const event = (kind, data, state) => modEvent('process_event', { session, kind, bytes: 1 }, state, answer(data));
  const output = event('output', `\u001b[1mOpening browser\u001b[0m\nVisit: ${link}\n`, started.state);
  assert.deepEqual(notices(output.calls), ['Your browser should open; if not, open this link:', link, 'If the page shows a code, run /claude code CODE']);
  assert.ok(manifest.subscriptions.channels.includes('omd_claude_cli/code'));
  const code = (state, alive) => channel('code', { code: 'abc' }, state, alive);
  assert.deepEqual(code(output.state).calls.find(call => call.operation === 'process.exchange').arguments, { session, wait_ms: 0, send: ['abc\n'] });
  const none = ['No Claude login is waiting for a code; run /claude login'];
  assert.deepEqual([notices(code(null).calls), notices(code(output.state, false).calls)], [none, none]);
  assert.deepEqual(notices(channel('login', { billing: 'api' }, output.state).calls), ['A Claude login is already running; finish it or wait for it to end']);
  const entry = started => ({ billing: 'api', out: '', shown: false, started });
  const crashed = { claude_login_1_old: entry(clock - 31 * 60_000), claude_login_2_other: entry(clock) };
  const second = channel('login', { billing: 'subscription', account: 'default' }, { login: { ...output.state.login, ...crashed } }, false, '77-1700000000001');
  assert.equal(second.calls.find(call => call.operation === 'process.start').arguments.arguments[4], '');
  assert.equal(second.calls.some(call => call.operation === 'packages.list'), false);
  const ids = Object.keys(second.state.login);
  assert.equal(ids.length, 3);
  assert.deepEqual(ids.filter(id => id.includes('_old')), []);
  assert.deepEqual(second.calls.filter(call => call.operation === 'process.stop').map(call => call.arguments.session), ['claude_login_1_old']);
  const exit = (state, setup) => modEvent('process_event', { session, kind: 'exit', bytes: 1 }, state, call =>
    call.operation === 'exec.run' ? setup : answer('', true, undefined, setup ? mod : [])(call));
  const exited = exit(second.state);
  assert.deepEqual(notices(exited.calls), ['Claude setup could not find the installed mod; enable it in /mods and run /claude login api work again']);
  assert.deepEqual(Object.keys(exited.state.login), ids.filter(id => id !== session));
  const models = [{ slug: 'claude-opus-5.work', display: 'Claude Opus 5 · work', context_window: 1000000, efforts: ['high'] }];
  const accounts = [{ name: 'work', billing: 'api', email: 'work@example.com', config_dir: '/store/routes/claude/accounts/work', route: 'claude-work', models: 1 }];
  const ready = exit(second.state, { exit_code: 0, stdout: JSON.stringify({ accounts, models }), stderr: '' });
  assert.deepEqual(ready.calls.find(call => call.operation === 'exec.run').arguments.argv, ['/store/sources/omd_claude_cli/setup.mjs', 'work', 'api', '/store/routes/claude/accounts/work']);
  assert.deepEqual(ready.calls.find(call => call.operation === 'providers.models').arguments, { provider: 'omd_claude_cli', name: 'Claude', models });
  assert.deepEqual([ready.state.accounts, ready.state.models], [accounts, models]);
  assert.match(notices(ready.calls).at(-1), /^Claude account work \(work@example\.com\) is ready on Console API credits/);
  const removed = modEvent('channel', { channel: 'omd_claude_cli/remove', data: { account: 'work' } }, ready.state, call =>
    call.operation === 'exec.run' ? { exit_code: 0, stdout: JSON.stringify({ accounts: [], models: [], signed_out: true }), stderr: '' } : answer()(call));
  assert.deepEqual(removed.calls.find(call => call.operation === 'exec.run').arguments.argv, ['/store/sources/omd_claude_cli/setup.mjs', 'work', 'remove']);
  assert.deepEqual([removed.state.accounts, removed.state.published, notices(removed.calls)], [[], false, ['Removed Claude account work and signed it out']]);
  assert.ok(removed.calls.some(call => call.operation === 'providers.unregister') && !removed.calls.some(call => call.operation === 'providers.register'));
});

test('/claude and /claude status name a host error, a missing CLI and a CLI version the mod does not accept', () => {
  const status = (answer, args = '') => modEvent('command', args, null, answer, 'claude').value.display;
  const probe = version => () => ({ exit_code: 0, stdout: JSON.stringify({ version, auth: null }), stderr: '' });
  assert.match(status(() => { throw new Error('exec_program_too_large'); }), /^CLI: check failed: exec_program_too_large/);
  assert.match(status(probe(null), 'status'), /^CLI: the Claude CLI was not found on PATH; install it with /);
  assert.match(status(probe(null), 'bogus'), /^Usage:/);
  assert.ok(status(probe('2.1.999 (Claude Code)')).startsWith('CLI: 2.1.999 (Claude Code)\nAccounts: none'));
  assert.match(status(probe('3.0.0 (Claude Code)')), /^CLI: Claude CLI 3\.0\.0 \(Claude Code\) is installed, but omd_claude_cli needs 2\.1\.307 or a newer 2\.x.*refused until then/);
  assert.deepEqual(['2.1.307 (Claude Code)', '2.2.0 (Claude Code)', '2.1.306 (Claude Code)', '1.9.999 (Claude Code)', '2.1.307', null].map(cliSupported), [true, true, false, false, false, false]);
  assert.ok(status(probe(CLI_VERSION)).startsWith(`CLI: ${CLI_VERSION}\nAccounts: none`));
  const accounts = [{ name: 'default', billing: 'subscription', config_dir: null, models: 3 }, { name: 'work', billing: 'api', config_dir: '/accounts/work', models: 2 }];
  const signedIn = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'me@example.com' });
  const listed = modEvent('command', '', { accounts, models: [], published: true }, call => {
    assert.deepEqual(JSON.parse(call.arguments.argv[2]), ['', '/accounts/work']);
    return { exit_code: 0, stdout: JSON.stringify({ version: CLI_VERSION, auth: [signedIn, null] }), stderr: '' };
  }, 'claude').value.display;
  assert.match(listed, /\nAccount default: claude\.ai \(max\) me@example\.com · subscription · 3 models\nAccount work: not signed in · Console API credits · 2 models\n/);
  const login = (args, state = null) => modEvent('command', args, state, () => ({ delivered: 1 }), 'claude');
  assert.deepEqual(login('login api work').calls[0].arguments, { channel: 'login', data: { billing: 'api', account: 'work' } });
  assert.deepEqual(login('login').calls[0].arguments, { channel: 'login', data: { billing: 'subscription', account: 'default' } });
  for (const bad of ['login Work', 'login api work extra', 'login work extra', 'login 1']) assert.match(login(bad).value.display, /^Account names start with a letter/, bad);
  assert.equal(login('remove work').value.display, 'Unknown Claude account work');
  assert.deepEqual(login('remove work', { accounts }).calls[0].arguments, { channel: 'remove', data: { account: 'work' } });
});
