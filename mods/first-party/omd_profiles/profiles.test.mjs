import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callback } from '../../../tests/mod_runner.mjs';
import { toolTable, chatRequest, anthropicRequest, breakpoint, Emitter, chatEvents, anthropicEvents } from './router.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const request = { source, filename: fileURLToPath(new URL('./index.ts', import.meta.url)), entrypoint: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, settings: {}, hook_budget_ms: 10000,
  assets: Object.fromEntries(manifest.assets.map(name => [name, { text: readFileSync(new URL(name, import.meta.url), 'utf8'), sha256: '0'.repeat(64) }])) };
const profileData = (name, paid) => ({ name, protocol: 'responses', url: paid ? 'https://api.openai.com/v1/responses' : 'https://chatgpt.com/backend-api/codex/responses', model: 'up',
  credential: `cred-${name}`, kind: paid ? 'api_key' : 'chatgpt', window: 1000, reasoning: false, cache_control: false, text_only: false, max_output: 100, paid: paid ? [1, 2] : null,
  effort: 'high', efforts: ['low', 'high'], router: 'http://127.0.0.1:9/v1' });
const route = (name, billing) => ({ name, model: name, provider: 'omd_profiles', reasoning: 'high', roles: ['lead'], billing, tools: [], available: true, credential: null,
  data: profileData(name, billing !== 'included_subscription') });
const router = fileURLToPath(new URL('./router.mjs', import.meta.url));
const sse = events => events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const hostFile = (directory, profiles) => {
  writeFileSync(join(directory, 'host.json'), JSON.stringify({ routes: profiles.map(data => ({ name: data.name, model: data.name, provider: 'omd_profiles', data })) }));
  return join(directory, 'host.json');
};

test('provider tool aliases preserve colliding names and round-trip their original identities', () => {
  const namespace = 'mcp_namespace_'.repeat(6);
  const specs = [
    { type: 'function', namespace, name: 'first' }, { type: 'custom', namespace, name: 'second' },
    { type: 'function', name: 'a.b' }, { type: 'function', name: 'a_b' },
    { type: 'function', name: 'constructor' }, { type: 'function', name: '__proto__' },
  ];
  const body = { tools: specs, input: specs.map((spec, index) => ({ type: spec.type === 'custom' ? 'custom_tool_call' : 'function_call',
    namespace: spec.namespace, name: spec.name, call_id: `c${index}`, arguments: '{}', input: 'patch' })) };
  const table = toolTable(body);
  assert.equal(table.tools.length, specs.length);
  assert.equal(new Set(table.tools.map(tool => tool.name)).size, specs.length);
  assert.ok(table.tools.every(tool => /^[A-Za-z0-9_-]{1,64}$/.test(tool.name)));
  for (const request of [chatRequest(body, {}), anthropicRequest(body, {})]) {
    const names = request.tools.map(tool => tool.function?.name ?? tool.name);
    assert.deepEqual(names, table.tools.map(tool => tool.name));
    const calls = request.messages.flatMap(message => message.tool_calls?.map(call => call.function.name)
      ?? (Array.isArray(message.content) ? message.content.filter(part => part.type === 'tool_use').map(part => part.name) : []));
    assert.deepEqual(calls, names);
  }
  const events = [];
  const emitter = new Emitter(event => events.push(event), table.reverse, 'response');
  table.tools.forEach((tool, index) => emitter.call(index, { id: `c${index}`, name: tool.name, args: specs[index].type === 'custom' ? '{"input":"patch"}' : '{}' }));
  emitter.finish({});
  const calls = events.filter(event => event.type === 'response.output_item.done').map(event => event.item);
  assert.deepEqual(calls.map(call => [call.namespace ?? '', call.name, call.type]),
    specs.map(spec => [spec.namespace ?? '', spec.name, spec.type === 'custom' ? 'custom_tool_call' : 'function_call']));
});

test('router adapts Responses requests to each protocol through the credential gateway and keeps reasoning bounded', async () => {
  const seen = {};
  const gateway = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const [, key, credential, ...rest] = request.url.split('/');
    const path = `/${rest.join('/')}`;
    seen[path] = { body: JSON.parse(text), headers: request.headers, key, credential };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (path === '/chat') response.end(sse([
      { choices: [{ delta: { reasoning: 'think' } }] }, { choices: [{ delta: { content: 'Hel' } }] }, { choices: [{ delta: { content: 'lo' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'exec_command', arguments: '{"cmd":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }] },
      { model: 'vendor/model-a', choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, cost: 0.0012, prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 } } }, '[DONE]']));
    else if (path === '/anthropic') response.end(sse([
      { type: 'message_start', message: { model: 'claude-served-1', usage: { input_tokens: 10, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 0 }, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Done' } },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 't1', name: 'apply_patch', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"input":"*** Begin Patch"}' } },
      { type: 'message_delta', usage: { output_tokens: 5 } }, { type: 'message_stop' }]));
    else response.end(sse(['{',{ type: 'response.output_item.done', item: { type: 'reasoning', id: `rs-${credential}`, summary: [], encrypted_content: `enc-${credential}` } },
      { type: 'response.completed', response: { id: 'r', usage: {} } }]));
  });
  const port = await listen(gateway);
  const directory = mkdtempSync(join(tmpdir(), 'omd-profiles-'));
  const probe = createServer();
  const free = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  const profile = (name, protocol, path) => ({ name, protocol, url: `https://up.example${path}`, model: 'up-model', credential: name, max_output: 4096, reasoning: true });
  const hostPath = hostFile(directory, [profile('a', 'responses', '/responses'), profile('b', 'responses', '/responses'), profile('c', 'chat', '/chat'), profile('d', 'anthropic', '/anthropic')]);
  const token = 'local-token-'.repeat(4);
  const child = spawn(process.execPath, [router, 'serve', hostPath, String(free)], { env: { OMD_PROFILES_LOCAL_TOKEN: token, OMD_READY_TOKEN: 'ready', OMD_CREDENTIAL_GATEWAY: `http://127.0.0.1:${port}/key` }, stdio: 'ignore' });
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await fetch(`http://127.0.0.1:${free}/_omd/ready`).then(reply => reply.ok, () => false)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const input = [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'reasoning', id: 'rs', summary: [], encrypted_content: 'sealed' },
      { type: 'function_call', call_id: 'old', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
      { type: 'function_call_output', call_id: 'old', output: '/repo' },
    ];
    const tools = [{ type: 'function', name: 'exec_command', description: 'run', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }, { type: 'custom', name: 'apply_patch', description: 'patch' }];
    const ask = async (model, authorization = `Bearer ${token}`, history = input, headers = {}) => {
      const reply = await fetch(`http://127.0.0.1:${free}/v1/responses`, { method: 'POST', headers: { authorization, 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ model, instructions: 'sys', input: history, tools, reasoning: { effort: 'high' }, stream: true, prompt_cache_key: 'conversation' }) });
      const text = await reply.text();
      return { status: reply.status, events: text.split('\n\n').filter(frame => frame && frame !== 'data: {').map(frame => JSON.parse(frame.replace(/^data: /, ''))) };
    };
    assert.equal((await ask('a', 'Bearer sk-test')).status, 401);
    const unauthorized = await fetch(`http://127.0.0.1:${free}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer sk-test' }, body: 'not json' });
    assert.equal(unauthorized.status, 401);
    assert.equal((await ask('missing')).status, 400);
    await ask('a');
    assert.equal(seen['/responses'].body.model, 'up-model');
    assert.deepEqual([seen['/responses'].key, seen['/responses'].credential, seen['/responses'].headers.authorization], ['key', 'a', undefined]);
    assert.ok(seen['/responses'].body.input.some(item => item.type === 'reasoning'));
    await ask('b');
    assert.ok(!seen['/responses'].body.input.some(item => item.type === 'reasoning'));
    await ask('b');
    assert.ok(!seen['/responses'].body.input.some(item => item.type === 'reasoning'));
    await ask('a', `Bearer ${token}`, input, { 'x-omd-cache-breakpoint': '1:0' });
    assert.deepEqual(seen['/responses'].body.input, input);
    const message = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
    const reasoning = id => ({ type: 'reasoning', id, summary: [], encrypted_content: `enc-${id.slice(3)}` });
    await ask('b', `Bearer ${token}`, [input[0], reasoning('rs-a'), message('earlier'), reasoning('rs-b'), input[1]], { 'x-omd-cache-breakpoint': '4:0' });
    assert.deepEqual(seen['/responses'].body.input.map(item => item.id ?? item.role), ['developer', 'assistant', 'rs-b', 'user']);
    assert.equal(seen['/responses'].headers['x-omd-cache-breakpoint'], '3:0');

    const chat = await ask('c');
    assert.deepEqual(seen['/chat'].body.messages, [
      { role: 'system', content: 'sys\n\nrules' }, { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'old', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' } }] },
      { role: 'tool', tool_call_id: 'old', content: '/repo' }]);
    assert.deepEqual(seen['/chat'].body.tools.map(tool => tool.function.name), ['exec_command', 'apply_patch']);
    assert.equal(seen['/chat'].body.reasoning_effort, 'high');
    const done = chat.events.filter(event => event.type === 'response.output_item.done').map(event => event.item);
    assert.deepEqual(done.map(item => item.type), ['reasoning', 'message', 'function_call']);
    assert.equal(done[1].content[0].text, 'Hello');
    assert.deepEqual(done[2], { type: 'function_call', id: 'c1', call_id: 'c1', name: 'exec_command', arguments: '{"cmd":"ls"}' });
    const { omd_native_usage: raw, ...normalized } = chat.events.at(-1).response.usage;
    assert.deepEqual(normalized, { input_tokens: 12, input_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 }, output_tokens: 4, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 16, omd_reported_cost: { usd: 0.0012, basis: 'provider_billed' } });
    assert.equal(raw.cost, 0.0012);
    assert.equal(chat.events.at(-1).response.model, 'vendor/model-a');

    const anthropic = await ask('d');
    assert.equal(seen['/anthropic'].headers['x-omd-credential-header'], 'x-api-key');
    assert.equal(seen['/anthropic'].headers.authorization, undefined);
    assert.equal(seen['/anthropic'].body.system, 'sys\n\nrules');
    assert.deepEqual(seen['/anthropic'].body.messages.map(message => message.content.map(block => block.type)), [['text'], ['tool_use'], ['tool_result']]);
    assert.equal(seen['/anthropic'].body.thinking, undefined);
    const calls = anthropic.events.filter(event => event.type === 'response.output_item.done').map(event => event.item);
    assert.deepEqual(calls.at(-1), { type: 'custom_tool_call', id: 't1', call_id: 't1', name: 'apply_patch', input: '*** Begin Patch' });
    assert.equal(anthropic.events.at(-1).response.usage.input_tokens, 15);
    assert.deepEqual(anthropic.events.at(-1).response.usage.input_tokens_details, { cached_tokens: 3, cache_write_tokens: 2 });
    assert.equal(anthropic.events.at(-1).response.usage.omd_cache_ttl_seconds, 300);
    assert.equal(anthropic.events.at(-1).response.model, 'claude-served-1');
    assert.equal(anthropic.events.at(-1).response.usage.output_tokens, 5);
    const thought = calls.find(item => item.type === 'reasoning');
    assert.match(thought.encrypted_content, /^omd-thinking:[0-9a-f]{16}:/);
    await ask('d', `Bearer ${token}`, [input[1], thought, { type: 'custom_tool_call', call_id: 't1', name: 'apply_patch', input: '*** Begin Patch' }, { type: 'custom_tool_call_output', call_id: 't1', output: 'ok' }]);
    assert.deepEqual(seen['/anthropic'].body.messages[1].content.slice(0, 2), [{ type: 'thinking', thinking: 'plan', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'apply_patch', input: { input: '*** Begin Patch' } }]);
    assert.deepEqual(seen['/anthropic'].body.thinking, { type: 'enabled', budget_tokens: 3072 });
  } finally {
    child.kill();
    gateway.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

const replay = (make, events, tools = [{ type: 'function', name: 'exec_command' }, { type: 'custom', name: 'apply_patch' }]) => {
  const sent = [];
  const emitter = new Emitter(event => sent.push(event), toolTable({ tools }).reverse, 'response');
  const feed = make(emitter);
  events.forEach(feed);
  return { emitter, sent, types: () => sent.map(event => event.type) };
};
const chatCall = (index, id, name, args) => ({ choices: [{ delta: { tool_calls: [{ index, id, function: { name, arguments: args } }] } }] });
const anthropicCall = (index, id, name, json) => [{ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name } },
  { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json } }];

test('output cut off at the limit ends incomplete and never emits a tool call', () => {
  const chat = replay(chatEvents, [{ choices: [{ delta: { content: 'part' } }] }, chatCall(0, 'c1', 'apply_patch', '{"input":"rm .'), { choices: [{ finish_reason: 'length' }] }]);
  const anthropic = replay(anthropicEvents, [...anthropicCall(0, 't1', 'exec_command', '{"cmd":"rm'), { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, { type: 'message_stop' }]);
  for (const run of [chat, anthropic]) {
    run.emitter.finish({});
    assert.ok(!run.types().includes('response.completed'));
    assert.ok(!run.sent.some(event => event.item?.name));
    assert.deepEqual(run.sent.at(-1).response.incomplete_details, { reason: 'max_output_tokens' });
    assert.equal(run.sent.at(-1).type, 'response.incomplete');
  }
  assert.equal(chat.sent.find(event => event.item?.type === 'message' && event.type === 'response.output_item.done').item.content[0].text, 'part');
});

test('a batch with any unparseable tool arguments fails before any call is emitted', () => {
  const chat = replay(chatEvents, [chatCall(0, 'c1', 'exec_command', '{"cmd":"ls"}'), chatCall(1, 'c2', 'apply_patch', '{"input":"rm .'), { choices: [{ finish_reason: 'tool_calls' }] }]);
  const anthropic = replay(anthropicEvents, [...anthropicCall(0, 't1', 'exec_command', '{"cmd":"ls"}'), ...anthropicCall(1, 't2', 'exec_command', '{"cmd":'),
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }]);
  for (const run of [chat, anthropic]) {
    assert.throws(() => run.emitter.finish({}), { code: 'invalid_tool_arguments' });
    assert.deepEqual(run.types(), ['response.created']);
  }
});

test('reasoning from a credential replaced under the same profile name is not sent to the new account', async () => {
  const seen = [];
  const gateway = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const [, , credential, ...rest] = request.url.split('/');
    seen.push({ body: JSON.parse(text), credential });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sse(rest[0] === 'anthropic' ? [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_stop', index: 0 }, { type: 'message_stop' }]
      : [{ type: 'response.output_item.done', item: { type: 'reasoning', id: `rs-${credential}`, summary: [], encrypted_content: `enc-${credential}` } },
        { type: 'response.completed', response: { id: 'r', usage: {} } }]));
  });
  const gatewayPort = await listen(gateway);
  const directory = mkdtempSync(join(tmpdir(), 'omd-profiles-'));
  const probe = createServer();
  const port = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  const table = credential => [{ name: 'a', protocol: 'responses', url: 'https://up.example/responses', model: 'up-model', credential, max_output: 4096 },
    { name: 'd', protocol: 'anthropic', url: 'https://up.example/anthropic', model: 'up-model', credential, max_output: 4096, reasoning: true }];
  const hostPath = hostFile(directory, table('cred-1'));
  const token = 'local-token-'.repeat(4);
  const child = spawn(process.execPath, [router, 'serve', hostPath, String(port)], { env: { OMD_PROFILES_LOCAL_TOKEN: token, OMD_READY_TOKEN: 'ready', OMD_CREDENTIAL_GATEWAY: `http://127.0.0.1:${gatewayPort}/key` }, stdio: 'ignore' });
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await fetch(`http://127.0.0.1:${port}/_omd/ready`).then(reply => reply.ok, () => false)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const ask = async (model, input, headers = {}) => {
      const reply = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ model, input, stream: true, prompt_cache_key: model }) });
      return { events: (await reply.text()).split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.replace(/^data: /, ''))), body: seen.at(-1).body };
    };
    const user = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] };
    const thinking = body => body.messages.flatMap(message => message.content).filter(block => block.type === 'thinking');
    const reasoning = (await ask('a', [user])).events.find(event => event.type === 'response.output_item.done').item;
    const thought = (await ask('d', [user])).events.find(event => event.type === 'response.output_item.done' && event.item.type === 'reasoning').item;
    assert.equal(thinking((await ask('d', [user, thought])).body).length, 1);
    assert.ok((await ask('a', [user, reasoning], { 'x-omd-cache-breakpoint': '0:0' })).body.input.some(item => item.type === 'reasoning'));
    hostFile(directory, table('cred-2'));
    assert.ok(!(await ask('a', [user, reasoning], { 'x-omd-cache-breakpoint': '0:0' })).body.input.some(item => item.type === 'reasoning'));
    assert.ok(!(await ask('a', [user, reasoning])).body.input.some(item => item.type === 'reasoning'));
    assert.equal(thinking((await ask('d', [user, thought])).body).length, 0);
  } finally {
    child.kill();
    gateway.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('setup adds profiles as host routes carrying their data and removing the last drops its route and service grant', () => {
  const store = mkdtempSync(join(tmpdir(), 'omd-profiles-setup-'));
  try {
    const mod = fileURLToPath(new URL('.', import.meta.url));
    mkdirSync(join(store, 'sources'));
    symlinkSync(mod, join(store, 'sources', 'omd_profiles'));
    mkdirSync(join(store, 'routes', 'profiles'), { recursive: true });
    const binary = join(store, 'codex');
    writeFileSync(binary, '#!/bin/sh\necho \'{"models":[]}\'\n', { mode: 0o755 });
    const record = join(store, 'install.json');
    writeFileSync(record, JSON.stringify({ profile: 'full', packages: { omd_profiles: {} }, store, binary: { installed_path: binary }, author: { node: process.execPath } }));
    writeFileSync(join(store, 'routes', 'profiles', 'route.json'), JSON.stringify({ port: 49152, default: 'work' }));
    writeFileSync(join(store, 'host.json'), JSON.stringify({ schema: 1, routes: [{ provider: 'omd_profiles', name: 'work', data: { name: 'work', model: 'up' } }, { provider: 'other', name: 'keep' }],
      services: [{ id: 'omd_profiles' }, { id: 'other' }] }));
    const run = options => spawnSync(process.execPath, [join(mod, 'setup.mjs'), 'setup', record, JSON.stringify(options)], { encoding: 'utf8' });
    const manager = join(store, 'omd-mod');
    writeFileSync(manager, `#!/bin/sh\necho '${JSON.stringify([{ id: 'p7', label: 'home', kind: 'chatgpt', origin: 'https://chatgpt.com' }])}'\n`, { mode: 0o755 });
    writeFileSync(binary, `#!/bin/sh\necho '${JSON.stringify({ models: [{ slug: 'up', context_window: 5000, default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] }] })}'\n`, { mode: 0o755 });
    writeFileSync(record, JSON.stringify({ profile: 'full', packages: { omd_profiles: {} }, store, binary: { installed_path: binary }, manager: { installed_path: manager }, author: { node: process.execPath } }));
    const added = run({ remove: 'work', add: { name: 'home', credential: 'home', protocol: 'responses', url: 'https://chatgpt.com/backend-api/codex/responses', model: 'up' } });
    assert.equal(added.status, 0, added.stderr);
    const routes = JSON.parse(readFileSync(join(store, 'host.json'), 'utf8')).routes;
    assert.deepEqual(routes.map(route => [route.name, route.model, route.reasoning_effort, route.responses_url]),
      [['keep', undefined, undefined, undefined], ['home', 'home', 'high', 'http://127.0.0.1:49152/v1/responses']]);
    assert.deepEqual([routes[1].data.credential, routes[1].data.window, routes[1].data.efforts], ['p7', 5000, ['low', 'high']]);
    const grant = JSON.parse(readFileSync(join(store, 'host.json'), 'utf8')).services.find(item => item.id === 'omd_profiles');
    assert.deepEqual([grant.arguments.slice(1), grant.credentials, grant.route.name], [['serve', join(realpathSync(store), 'host.json'), '49152'], ['p7'], 'home']);
    assert.deepEqual(JSON.parse(readFileSync(join(store, 'routes', 'profiles', 'route.json'), 'utf8')).models, [{ slug: 'home', family: 'home' }]);
    const done = run({ remove: 'home' });
    assert.equal(done.status, 0, done.stderr);
    const host = JSON.parse(readFileSync(join(store, 'host.json'), 'utf8'));
    assert.deepEqual([host.routes.map(route => route.name), host.services.map(grant => grant.id)], [['keep'], ['other']]);
    assert.deepEqual(JSON.parse(readFileSync(join(store, 'routes', 'profiles', 'route.json'), 'utf8')).models, []);
    assert.match(run({ remove: 'home' }).stderr, /^no_profiles/);
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

test('profile switches stay on the thread, ask before paid routes and report refusals', () => {
  const calls = [];
  let answer = 'accepted';
  let updateError = null;
  let selected = { route: route('paid', 'explicit_paid_api_grant'), effective_at: 'next_request' };
  const invoke = (state, event, payload, name) => callback({ ...request, state, event, name, payload }, ({ operation, arguments: args }) => {
    calls.push({ operation, args });
    if (operation === 'routes.select') {
      if (typeof selected === 'string') throw new Error(selected);
      return selected;
    }
    if (operation === 'app.request' && updateError) throw new Error(updateError);
    return { 'routes.list': [route('work', 'included_subscription'), route('paid', 'explicit_paid_api_grant'), { ...route('other', 'included_subscription'), provider: 'openai' }],
      'terminal.prompt': { status: answer }, 'events.publish': { delivered: 1, dropped: 0 }, 'sidecars.status': { running: true }, 'store.get': null,
      'session.info': { thread_id: 'thread-1' }, 'app.request': {} }[operation];
  });
  let state = invoke(null, 'routing', { routes: [route('work', 'included_subscription'), route('paid', 'explicit_paid_api_grant')], model: 'paid', provider: 'omd_profiles', reasoning: 'high' }).state;
  assert.equal(state.current, 'paid');
  assert.deepEqual(invoke(state, 'routing', { routes: [], model: 'gpt', provider: 'openai', reasoning: null }).value, null);
  state = invoke(state, 'start', {}).state;
  assert.deepEqual(state.profiles.map(profile => profile.name), ['work', 'paid']);
  assert.match(invoke(state, 'command', 'list', 'profile').value.display, /^○ work · ChatGPT · up · quota not seen yet\n● paid · OpenAI API · up · paid API, per request$/);
  answer = 'declined';
  assert.equal(invoke(state, 'command', 'use paid', 'profile').value.display, 'Kept the current profile.');
  answer = 'accepted';
  state = invoke(state, 'command', 'use paid', 'profile').state;
  assert.equal(state.pending, 'paid');
  state = invoke(state, 'command', 'use work', 'profile').state;
  assert.deepEqual(calls.filter(call => call.operation === 'app.request').at(-1).args,
    { method: 'thread/settings/update', params: { threadId: 'thread-1', model: 'work', effort: 'high' } });
  assert.match(invoke({ ...state, ours: false }, 'command', 'use work', 'profile').value.display, /Start this thread/);
  updateError = 'app_route_denied';
  assert.equal(invoke({ ...state, pending: null }, 'command', 'use work', 'profile').value.display, 'Profile switch failed: app_route_denied');
  updateError = null;
  assert.equal(calls.filter(call => call.operation === 'terminal.prompt').length, 2);
  state = invoke({ ...state, pending: 'paid' }, 'turn_start', { turn_id: 't1' }).state;
  assert.ok(calls.some(call => call.operation === 'routes.select' && call.args.route === 'paid' && call.args.scope === 'thread'));
  const meter = state => invoke(state, 'terminal', { event: 'redraw', ledger: null }).value.sites.above_composer.components[1].spans.map(span => span.text).join('');
  assert.equal(meter(state), '● paid · paid API · Alt+s next · /profile');
  selected = 'route_unavailable_for_thread: work';
  state = invoke({ ...state, pending: 'work' }, 'turn_start', { turn_id: 't2' }).state;
  assert.equal(meter(state), '● paid · switch failed: work: route_unavailable_for_thread: work · Alt+s next · /profile');
  assert.match(invoke(state, 'command', 'list', 'profile').value.display, /^Last switch failed: work: route_unavailable_for_thread: work\n/);
  assert.deepEqual(invoke(state, 'intercept', { surface: 'model_request', input: {}, original: {}, origin: { caller: 'model' } }, '0').value.result, { deny: 'work: route_unavailable_for_thread: work' });
});

test('the switcher meters the active account, cycles with Alt+s and adds or removes accounts in the session', () => {
  const calls = [];
  const kv = {};
  let written = { routes: [], services: [] };
  const replies = { 'events.publish': { delivered: 1, dropped: 0 }, 'session.info': { thread_id: 'thread-1' }, 'app.request': {}, 'terminal.panel': { shown: true },
    'terminal.prompt': { status: 'accepted', value: 'home' }, 'credentials.request': { status: 'completed', profile: { id: 'cred-home', label: 'home', kind: 'chatgpt', origin: 'https://chatgpt.com' } } };
  const invoke = (state, event, payload, name) => callback({ ...request, state, event, name, payload, virtual_time_ms: 1_000_000 }, ({ operation, arguments: args }) => {
    calls.push({ operation, args });
    if (operation === 'store.get') return kv[args.key] ?? null;
    if (operation === 'store.put') {
      kv[args.key] = { value: args.value, revision: (kv[args.key]?.revision ?? 0) + 1 };
      return { revision: kv[args.key].revision };
    }
    if (operation === 'routes.write') return written;
    return replies[operation];
  });
  const rows = ['work', 'spare'].map(name => ({ ...profileData(name, false), billing: 'included_subscription', available: true }));
  let state = { profiles: rows, current: 'work', ours: true };
  state = invoke(state, 'app_notification', { method: 'account/rateLimits/updated', params: { rateLimits: {
    primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 2_000 }, secondary: { usedPercent: 93, windowDurationMins: 10080, resetsAt: 9_000 } } } }).state;
  assert.deepEqual(kv.quota.value.work.windows, [{ minutes: 300, used: 42, resets: 2_000_000 }, { minutes: 10080, used: 93, resets: 9_000_000 }]);
  const view = invoke(state, 'terminal', { event: 'redraw', ledger: null }).value;
  assert.deepEqual(view.keybindings, { 'Alt+s': { command: 'omd_profiles:profile', args: 'next' } });
  const spans = view.sites.above_composer.components[1].spans;
  assert.equal(spans.map(span => span.text).join(''), '● work · 5h ▓▓░░░ 42% · wk ▓▓▓▓▓ 93% · just now · Alt+s next · /profile');
  assert.equal(spans.find(span => span.text.startsWith('wk')).tone, 'attention');
  state = invoke(state, 'command', 'next', 'profile').state;
  assert.equal(state.pending, 'spare');
  assert.deepEqual(calls.filter(call => call.operation === 'app.request').at(-1).args.params.model, 'spare');
  state = { ...state, pending: null };
  invoke(state, 'command', '', 'profile');
  const panel = calls.filter(call => call.operation === 'terminal.panel').at(-1).args;
  assert.deepEqual(panel.items.slice(0, 2).map(item => [item.label, item.description]),
    [['● work', 'ChatGPT · up · 5h 42% · wk 93% · seen just now'], ['○ spare', 'ChatGPT · up · quota not seen yet']]);
  assert.deepEqual(panel.action, { command: 'omd_profiles:profile', args: 'panel' });
  written = { routes: ['work', 'spare', 'home'], services: ['omd_profiles'] };
  const added = invoke(state, 'command', 'panel add:chatgpt', 'profile');
  assert.equal(added.value, null);
  assert.match(calls.filter(call => call.operation === 'terminal.panel').at(-1).args.subtitle, /^Added home\./);
  const write = calls.filter(call => call.operation === 'routes.write').at(-1).args;
  assert.deepEqual(write.routes.map(route => [route.name, route.model, route.data.credential, route.responses_url]),
    [['work', 'work', 'cred-work', 'http://127.0.0.1:9/v1/responses'], ['spare', 'spare', 'cred-spare', 'http://127.0.0.1:9/v1/responses'], ['home', 'home', 'cred-home', 'http://127.0.0.1:9/v1/responses']]);
  assert.deepEqual(write.services, [{ id: 'omd_profiles', credentials: ['cred-work', 'cred-spare', 'cred-home'], route: (({ data, ...route }) => route)(write.routes[0]) }]);
  assert.ok(write.routes.every(route => !('billing' in route.data) && !('available' in route.data)));
  state = added.state;
  assert.equal(kv.changed.value, 1_000_000);
  replies['routes.list'] = ['work', 'spare', 'home'].map(name => route(name, 'included_subscription'));
  const restarted = invoke(state, 'turn_start', { turn_id: 't1' }).state;
  assert.equal(restarted.applied, 1_000_000);
  assert.deepEqual(calls.filter(call => call.operation.startsWith('providers.')).map(call => call.operation), ['providers.unregister', 'providers.register', 'providers.models']);
  assert.deepEqual(calls.findLast(call => call.operation === 'providers.models').args.models.map(model => [model.slug, model.context_window, model.default_effort]),
    [['work', 1000, 'high'], ['spare', 1000, 'high'], ['home', 1000, 'high']]);
  assert.equal(invoke(state, 'command', 'remove work', 'profile').value.display, "work is this thread's profile; switch to another one first.");
  written = { status: 'declined' };
  assert.equal(invoke(state, 'command', 'remove spare', 'profile').value.display, 'Profiles unchanged.');
  written = { routes: ['work', 'home'], services: ['omd_profiles'] };
  const removed = invoke(state, 'command', 'remove spare', 'profile');
  assert.equal(removed.value.display, 'Removed spare and its sign-in.');
  assert.deepEqual(removed.state.profiles.map(profile => profile.name), ['work', 'home']);
  assert.deepEqual(calls.filter(call => call.operation === 'credentials.request').at(-1).args, { action: 'remove', profile: 'cred-spare' });
  assert.match(invoke({ ...removed.state, current: null, profiles: removed.state.profiles.slice(0, 1) }, 'command', 'remove work', 'profile').value.display, /^work is the last profile/);
});

test('the port hand-off shows a foreign holder neither the local token nor the readiness nonce', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'omd-profiles-'));
  const token = 'local-token-'.repeat(4);
  const seen = [];
  const squatter = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    seen.push(JSON.stringify(request.headers) + body);
    response.end('OMD_READY:other');
  });
  const port = await listen(squatter);
  const hostPath = hostFile(directory, []);
  const children = [];
  const serve = ready => {
    const child = spawn(process.execPath, [router, 'serve', hostPath, String(port)], { env: { OMD_PROFILES_LOCAL_TOKEN: token, OMD_READY_TOKEN: ready }, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.setEncoding('utf8');
    child.output = '';
    child.stderr.on('data', chunk => { child.output += chunk; });
    children.push(child);
    return child;
  };
  const served = async expected => {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await fetch(`http://127.0.0.1:${port}/_omd/ready`).then(reply => reply.text(), () => '') === `OMD_READY:${expected}`) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail(`${expected} was never served`);
  };
  try {
    const refused = serve('nonce-a');
    const code = await new Promise(resolve => refused.on('exit', resolve));
    assert.notEqual(code, 0);
    assert.match(refused.output, /provider_port_in_use/);
    assert.ok(seen.length);
    assert.ok(!seen.some(request => request.includes(token) || request.includes('nonce-a')));
    squatter.closeAllConnections();
    await new Promise(resolve => squatter.close(resolve));
    const owner = serve('nonce-a');
    await served('nonce-a');
    const later = serve('nonce-b');
    await served('nonce-b');
    owner.kill();
    await new Promise(resolve => owner.on('exit', resolve));
    await served('nonce-b');
    assert.equal(later.exitCode, null);
  } finally {
    for (const child of children) child.kill();
    rmSync(directory, { recursive: true, force: true });
  }
});
