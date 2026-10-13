import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolTable, chatRequest, anthropicRequest, breakpoint, Emitter, chatEvents, anthropicEvents } from './router.mjs';
import { profileEntry, catalogEntry } from './setup.mjs';

const router = fileURLToPath(new URL('./router.mjs', import.meta.url));
const sse = events => events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

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

test('host cache breakpoints become cache_control on the marked system or context block', () => {
  const body = { instructions: 'base', input: [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'mod system' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'context one' }, { type: 'input_text', text: 'context two' }, { type: 'input_text', text: 'prompt' }] },
  ] };
  const ephemeral = { type: 'ephemeral' };
  assert.deepEqual(breakpoint('1:1'), [1, 1]);
  assert.equal(breakpoint('x'), null);
  const anthropic = anthropicRequest(body, {}, breakpoint('1:1'));
  assert.equal(anthropic.system, 'base\n\nmod system');
  assert.deepEqual(anthropic.messages[0].content.map(part => part.cache_control ?? null), [null, ephemeral, null]);
  assert.deepEqual(anthropicRequest(body, {}, [0, 0]).system, [{ type: 'text', text: 'base\n\nmod system', cache_control: ephemeral }]);
  const chat = chatRequest(body, { cache_control: true }, [1, 0]);
  assert.deepEqual(chat.messages[1].content[0], { type: 'text', text: 'context one', cache_control: ephemeral });
  assert.deepEqual(chatRequest(body, {}, [1, 0]).messages.map(message => typeof message.content), ['string', 'string']);
  const forked = { instructions: 'base', input: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'earlier answer' }] }, body.input[1]] };
  assert.deepEqual(chatRequest(forked, { cache_control: true }, [0, 0]).messages[1].content, [{ type: 'text', text: 'earlier answer', cache_control: ephemeral }]);
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
  writeFileSync(join(directory, 'route.json'), JSON.stringify({ port: free, profiles: { 'a/up': profile('a', 'responses', '/responses'), 'b/up': profile('b', 'responses', '/responses'),
    'c/up': profile('c', 'chat', '/chat'), 'd/up': profile('d', 'anthropic', '/anthropic') } }));
  const token = 'local-token-'.repeat(4);
  const child = spawn(process.execPath, [router, 'serve', join(directory, 'route.json')], { env: { OMD_PROFILES_LOCAL_TOKEN: token, OMD_READY_TOKEN: 'ready', OMD_CREDENTIAL_GATEWAY: `http://127.0.0.1:${port}/key` }, stdio: 'ignore' });
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
    assert.equal((await ask('a/up', 'Bearer sk-test')).status, 401);
    const unauthorized = await fetch(`http://127.0.0.1:${free}/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer sk-test' }, body: 'not json' });
    assert.equal(unauthorized.status, 401);
    assert.equal((await ask('missing/up')).status, 400);
    await ask('a/up');
    assert.equal(seen['/responses'].body.model, 'up-model');
    assert.deepEqual([seen['/responses'].key, seen['/responses'].credential, seen['/responses'].headers.authorization], ['key', 'a', undefined]);
    assert.ok(seen['/responses'].body.input.some(item => item.type === 'reasoning'));
    await ask('b/up');
    assert.ok(!seen['/responses'].body.input.some(item => item.type === 'reasoning'));
    await ask('b/up');
    assert.ok(!seen['/responses'].body.input.some(item => item.type === 'reasoning'));
    await ask('a/up', `Bearer ${token}`, input, { 'x-omd-cache-breakpoint': '1:0' });
    assert.deepEqual(seen['/responses'].body.input, input);
    const message = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
    const reasoning = id => ({ type: 'reasoning', id, summary: [], encrypted_content: `enc-${id.slice(3)}` });
    await ask('b/up', `Bearer ${token}`, [input[0], reasoning('rs-a'), message('earlier'), reasoning('rs-b'), input[1]], { 'x-omd-cache-breakpoint': '4:0' });
    assert.deepEqual(seen['/responses'].body.input.map(item => item.id ?? item.role), ['developer', 'assistant', 'rs-b', 'user']);
    assert.equal(seen['/responses'].headers['x-omd-cache-breakpoint'], '3:0');

    const chat = await ask('c/up');
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

    const anthropic = await ask('d/up');
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
    await ask('d/up', `Bearer ${token}`, [input[1], thought, { type: 'custom_tool_call', call_id: 't1', name: 'apply_patch', input: '*** Begin Patch' }, { type: 'custom_tool_call_output', call_id: 't1', output: 'ok' }]);
    assert.deepEqual(seen['/anthropic'].body.messages[1].content.slice(0, 2), [{ type: 'thinking', thinking: 'plan', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'apply_patch', input: { input: '*** Begin Patch' } }]);
    assert.deepEqual(seen['/anthropic'].body.thinking, { type: 'enabled', budget_tokens: 3072 });
  } finally {
    child.kill();
    gateway.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('chat and anthropic requests carry the smaller of the caller and profile output limits', () => {
  const limits = (body, max_output) => [chatRequest(body, { max_output }).max_tokens, anthropicRequest(body, { max_output }).max_tokens];
  assert.deepEqual(limits({ max_output_tokens: 17 }, 4096), [17, 17]);
  assert.deepEqual(limits({ max_output_tokens: 9000 }, 4096), [4096, 4096]);
  assert.deepEqual(limits({}, 4096), [4096, 4096]);
  assert.equal('max_tokens' in chatRequest({}, {}), false);
  for (const url of ['https://api.openai.com/v1/chat/completions', 'https://team.openai.azure.com/openai/deployments/o4/chat/completions']) {
    const request = chatRequest({}, { url, max_output: 4096 });
    assert.equal(request.max_completion_tokens, 4096);
    assert.equal('max_tokens' in request, false);
  }
});

test('a tool loop whose last call carries no thinking of this account is continued without thinking', () => {
  const profile = { name: 'd', credential: 'p1', url: 'https://up.example/anthropic', reasoning: true, max_output: 32000 };
  const call = { type: 'function_call', call_id: 't1', name: 'exec_command', arguments: '{}' };
  const result = { type: 'function_call_output', call_id: 't1', output: 'ok' };
  const user = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] };
  const body = input => ({ input, reasoning: { effort: 'high' } });
  assert.equal(anthropicRequest(body([user, call, result]), profile).thinking, undefined);
  assert.equal(anthropicRequest(body([user, call, result, user]), profile).thinking.type, 'enabled');
  assert.equal(anthropicRequest(body([user]), profile).thinking.type, 'enabled');
});

test('chat tool-result images follow the tool messages as image messages while user images stay in place', () => {
  const png = 'data:image/png;base64,AAAA';
  const call = id => ({ type: 'function_call', call_id: id, name: 'view', arguments: '{}' });
  const body = { input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: png }] },
    call('a'), call('b'),
    { type: 'function_call_output', call_id: 'a', output: [{ type: 'input_text', text: 'shot' }, { type: 'input_image', image_url: png }] },
    { type: 'function_call_output', call_id: 'b', output: 'plain' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'seen' }] },
  ] };
  const { messages } = chatRequest(body, {});
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'tool', 'tool', 'user', 'assistant']);
  assert.deepEqual(messages[0].content, [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: png } }]);
  assert.match(messages[2].content, /^shot\n/);
  assert.equal(messages[3].content, 'plain');
  assert.deepEqual(messages[4].content, [{ type: 'text', text: 'Image output of tool call a:' }, { type: 'image_url', image_url: { url: png } }]);
  assert.ok(!JSON.stringify(messages).includes('[image]'));
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
  const routePath = join(directory, 'route.json');
  const table = credential => ({ port, profiles: {
    'a/up': { name: 'a', protocol: 'responses', url: 'https://up.example/responses', model: 'up-model', credential, max_output: 4096 },
    'd/up': { name: 'd', protocol: 'anthropic', url: 'https://up.example/anthropic', model: 'up-model', credential, max_output: 4096, reasoning: true } } });
  writeFileSync(routePath, JSON.stringify(table('cred-1')));
  const token = 'local-token-'.repeat(4);
  const child = spawn(process.execPath, [router, 'serve', routePath], { env: { OMD_PROFILES_LOCAL_TOKEN: token, OMD_READY_TOKEN: 'ready', OMD_CREDENTIAL_GATEWAY: `http://127.0.0.1:${gatewayPort}/key` }, stdio: 'ignore' });
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
    const reasoning = (await ask('a/up', [user])).events.find(event => event.type === 'response.output_item.done').item;
    const thought = (await ask('d/up', [user])).events.find(event => event.type === 'response.output_item.done' && event.item.type === 'reasoning').item;
    assert.equal(thinking((await ask('d/up', [user, thought])).body).length, 1);
    assert.ok((await ask('a/up', [user, reasoning], { 'x-omd-cache-breakpoint': '0:0' })).body.input.some(item => item.type === 'reasoning'));
    writeFileSync(routePath, JSON.stringify(table('cred-2')));
    assert.ok(!(await ask('a/up', [user, reasoning], { 'x-omd-cache-breakpoint': '0:0' })).body.input.some(item => item.type === 'reasoning'));
    assert.ok(!(await ask('a/up', [user, reasoning])).body.input.some(item => item.type === 'reasoning'));
    assert.equal(thinking((await ask('d/up', [user, thought])).body).length, 0);
  } finally {
    child.kill();
    gateway.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a text-only profile declares text input so Codex strips images before they reach the provider', () => {
  const credentials = [{ id: 'p1', label: 'router', origin: 'https://up.example', kind: 'api_key' }];
  const bundled = [{ slug: 'native', context_window: 1000, input_modalities: ['text', 'image'] }];
  const entry = text_only => catalogEntry('router/up', profileEntry({ name: 'router', credential: 'router', protocol: 'chat',
    url: 'https://up.example/v1/chat/completions', model: 'up', window: 1000, paid: '1:1', text_only }, credentials), bundled, 0);
  assert.deepEqual(entry(true).input_modalities, ['text']);
  assert.deepEqual(entry(false).input_modalities, ['text', 'image']);
});

test('setup removing the last profile drops its route and service grant', () => {
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
    writeFileSync(join(store, 'routes', 'profiles', 'route.json'), JSON.stringify({ port: 49152, default: 'work/up', profiles: { 'work/up': { name: 'work', model: 'up' } } }));
    writeFileSync(join(store, 'host.json'), JSON.stringify({ schema: 1, routes: [{ provider: 'omd_profiles', name: 'work' }, { provider: 'other', name: 'keep' }],
      services: [{ id: 'omd_profiles' }, { id: 'other' }] }));
    const run = options => spawnSync(process.execPath, [join(mod, 'setup.mjs'), 'setup', record, JSON.stringify(options)], { encoding: 'utf8' });
    const done = run({ remove: 'work' });
    assert.equal(done.status, 0, done.stderr);
    const host = JSON.parse(readFileSync(join(store, 'host.json'), 'utf8'));
    assert.deepEqual([host.routes.map(route => route.name), host.services.map(grant => grant.id)], [['keep'], ['other']]);
    assert.deepEqual(JSON.parse(readFileSync(join(store, 'routes', 'profiles', 'route.json'), 'utf8')).profiles, {});
    assert.match(run({ remove: 'work' }).stderr, /^no_profiles/);
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});
