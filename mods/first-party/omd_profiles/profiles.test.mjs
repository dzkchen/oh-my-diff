import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolTable, chatRequest, anthropicRequest, Emitter } from './router.mjs';

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
    else response.end(sse([{ type: 'response.completed', response: { id: 'r', usage: {} } }]));
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
    const ask = async (model, authorization = `Bearer ${token}`, history = input) => {
      const reply = await fetch(`http://127.0.0.1:${free}/v1/responses`, { method: 'POST', headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ model, instructions: 'sys', input: history, tools, reasoning: { effort: 'high' }, stream: true, prompt_cache_key: 'conversation' }) });
      const text = await reply.text();
      return { status: reply.status, events: text.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.replace(/^data: /, ''))) };
    };
    assert.equal((await ask('a/up', 'Bearer sk-test')).status, 401);
    assert.equal((await ask('missing/up')).status, 400);
    await ask('a/up');
    assert.equal(seen['/responses'].body.model, 'up-model');
    assert.deepEqual([seen['/responses'].key, seen['/responses'].credential, seen['/responses'].headers.authorization], ['key', 'a', undefined]);
    assert.ok(seen['/responses'].body.input.some(item => item.type === 'reasoning'));
    await ask('b/up');
    assert.ok(!seen['/responses'].body.input.some(item => item.type === 'reasoning'));
    await ask('b/up');
    assert.ok(!seen['/responses'].body.input.some(item => item.type === 'reasoning'));

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
    assert.deepEqual(seen['/anthropic'].body.thinking, { type: 'enabled', budget_tokens: 3072 });
    const calls = anthropic.events.filter(event => event.type === 'response.output_item.done').map(event => event.item);
    assert.deepEqual(calls.at(-1), { type: 'custom_tool_call', id: 't1', call_id: 't1', name: 'apply_patch', input: '*** Begin Patch' });
    assert.equal(anthropic.events.at(-1).response.usage.input_tokens, 15);
    assert.deepEqual(anthropic.events.at(-1).response.usage.input_tokens_details, { cached_tokens: 3, cache_write_tokens: 2 });
    assert.equal(anthropic.events.at(-1).response.usage.omd_cache_ttl_seconds, 300);
    assert.equal(anthropic.events.at(-1).response.model, 'claude-served-1');
    assert.equal(anthropic.events.at(-1).response.usage.output_tokens, 5);
    const thought = calls.find(item => item.type === 'reasoning');
    assert.match(thought.encrypted_content, /^omd-thinking:d:/);
    await ask('d/up', `Bearer ${token}`, [input[1], thought, { type: 'custom_tool_call', call_id: 't1', name: 'apply_patch', input: '*** Begin Patch' }, { type: 'custom_tool_call_output', call_id: 't1', output: 'ok' }]);
    assert.deepEqual(seen['/anthropic'].body.messages[1].content.slice(0, 2), [{ type: 'thinking', thinking: 'plan', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'apply_patch', input: { input: '*** Begin Patch' } }]);
  } finally {
    child.kill();
    gateway.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
