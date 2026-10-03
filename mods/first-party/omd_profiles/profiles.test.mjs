import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const router = fileURLToPath(new URL('./router.mjs', import.meta.url));
const sse = events => events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('router adapts Responses requests to each protocol and keeps credentials and reasoning bounded', async () => {
  const seen = {};
  const upstream = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    seen[request.url] = { body: JSON.parse(text), headers: request.headers };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (request.url === '/chat') response.end(sse([
      { choices: [{ delta: { reasoning: 'think' } }] }, { choices: [{ delta: { content: 'Hel' } }] }, { choices: [{ delta: { content: 'lo' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'exec_command', arguments: '{"cmd":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, prompt_tokens_details: { cached_tokens: 2 } } }, '[DONE]']));
    else if (request.url === '/anthropic') response.end(sse([
      { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 3, output_tokens: 1 } } },
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
  const port = await listen(upstream);
  const directory = mkdtempSync(join(tmpdir(), 'omd-profiles-'));
  const probe = createServer();
  const free = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const profile = (name, protocol, path) => ({ name, protocol, url: `${base}${path}`, model: 'up-model', credential: name, max_output: 4096, reasoning: true });
  writeFileSync(join(directory, 'route.json'), JSON.stringify({ port: free, profiles: { 'a/up': profile('a', 'responses', '/responses'), 'b/up': profile('b', 'responses', '/responses'),
    'c/up': profile('c', 'chat', '/chat'), 'd/up': profile('d', 'anthropic', '/anthropic') } }));
  const token = 'local-token-'.repeat(4);
  const child = spawn(process.execPath, [router, 'serve', join(directory, 'route.json')], { env: { OMD_PROFILES_LOCAL_TOKEN: token, OMD_READY_TOKEN: 'ready' }, stdio: 'ignore' });
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
    const ask = async (model, authorization = 'Bearer sk-test', history = input) => {
      const reply = await fetch(`http://127.0.0.1:${free}/v1/responses`, { method: 'POST', headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ model, instructions: 'sys', input: history, tools, reasoning: { effort: 'high' }, stream: true, prompt_cache_key: 'conversation' }) });
      const text = await reply.text();
      return { status: reply.status, events: text.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.replace(/^data: /, ''))) };
    };
    assert.equal((await ask('a/up', `Bearer ${token}`)).status, 401);
    assert.equal((await ask('missing/up')).status, 400);
    await ask('a/up');
    assert.equal(seen['/responses'].body.model, 'up-model');
    assert.equal(seen['/responses'].headers.authorization, 'Bearer sk-test');
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
    assert.deepEqual(chat.events.at(-1).response.usage, { input_tokens: 12, input_tokens_details: { cached_tokens: 2 }, output_tokens: 4, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 16 });

    const anthropic = await ask('d/up');
    assert.equal(seen['/anthropic'].headers['x-api-key'], 'sk-test');
    assert.equal(seen['/anthropic'].headers.authorization, undefined);
    assert.equal(seen['/anthropic'].body.system, 'sys\n\nrules');
    assert.deepEqual(seen['/anthropic'].body.messages.map(message => message.content.map(block => block.type)), [['text'], ['tool_use'], ['tool_result']]);
    assert.deepEqual(seen['/anthropic'].body.thinking, { type: 'enabled', budget_tokens: 3072 });
    const calls = anthropic.events.filter(event => event.type === 'response.output_item.done').map(event => event.item);
    assert.deepEqual(calls.at(-1), { type: 'custom_tool_call', id: 't1', call_id: 't1', name: 'apply_patch', input: '*** Begin Patch' });
    assert.equal(anthropic.events.at(-1).response.usage.input_tokens, 13);
    assert.equal(anthropic.events.at(-1).response.usage.output_tokens, 5);
    const thought = calls.find(item => item.type === 'reasoning');
    assert.match(thought.encrypted_content, /^omd-thinking:d:/);
    await ask('d/up', 'Bearer sk-test', [input[1], thought, { type: 'custom_tool_call', call_id: 't1', name: 'apply_patch', input: '*** Begin Patch' }, { type: 'custom_tool_call_output', call_id: 't1', output: 'ok' }]);
    assert.deepEqual(seen['/anthropic'].body.messages[1].content.slice(0, 2), [{ type: 'thinking', thinking: 'plan', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'apply_patch', input: { input: '*** Begin Patch' } }]);
  } finally {
    child.kill();
    upstream.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
