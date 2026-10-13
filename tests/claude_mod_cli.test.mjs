import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { runClaude } from '../mods/first-party/omd_claude_cli/transport.mjs';
import { discover } from '../mods/first-party/omd_claude_cli/setup.mjs';

const model = 'claude-opus-5-5';
const entry = { slug: model, cli: model, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], thinking: true, window: 1000000 };
const request = { model, stream: true, reasoning: { effort: 'max' }, input: [{ type: 'message', role: 'user',
  content: [{ type: 'input_text', text: 'Reply OK.' }] }] };

function stream(response, blocks, stopReason = 'end_turn') {
  const events = [{ type: 'message_start', message: { id: 'msg_omd_fixture', type: 'message',
    role: 'assistant', model, content: [], usage: { input_tokens: 12, output_tokens: 2,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }];
  for (const [index, block] of blocks.entries()) {
    events.push({ type: 'content_block_start', index,
      content_block: block.type === 'text' ? { ...block, text: '' } : block.type === 'thinking' ? { type: 'thinking', thinking: '' } : block });
    if (block.type === 'text') events.push({ type: 'content_block_delta', index,
      delta: { type: 'text_delta', text: block.text } });
    if (block.type === 'thinking') events.push({ type: 'content_block_delta', index,
      delta: { type: 'thinking_delta', thinking: block.thinking } });
    events.push({ type: 'content_block_stop', index });
  }
  events.push({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 2 } }, { type: 'message_stop' });
  response.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_omd_fixture' });
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

test('official CLI request passes through the mod relay once without account traffic',
  { skip: !process.env.OMD_TEST_CLAUDE, timeout: 30000 }, async () => {
    const captured = [];
    const server = createServer(async (incoming, response) => {
      let body = '';
      for await (const chunk of incoming) body += chunk;
      captured.push(JSON.parse(body));
      stream(response, [{ type: 'text', text: 'OK' }]);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const streamed = [];
    const priorTmp = process.env.TMPDIR;
    process.env.TMPDIR = '/private/tmp/omd-claude-missing-fixture';
    try {
      const result = await runClaude(request, entry, process.env.OMD_TEST_CLAUDE,
        new AbortController().signal, event => streamed.push(event),
        { upstream: `http://127.0.0.1:${server.address().port}` });
      assert.equal(captured.length, 1);
      assert.equal(captured[0].model, model);
      assert.equal(captured[0].output_config.effort, 'max');
      assert.equal(captured[0].thinking.display, 'summarized');
      assert.equal(streamed.some(event => event.type === 'response.output_text.delta' &&
        event.delta === 'OK'), true);
      assert.equal(result.at(-1).type, 'response.completed');
      assert.equal(result.at(-1).response.usage.omd_native_admission.upstream_requests, 1);
    } finally {
      if (priorTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = priorTmp;
      await new Promise(resolve => server.close(resolve));
    }
  });

test('official CLI replays a Codex tool result into one new upstream request',
  { skip: !process.env.OMD_TEST_CLAUDE, timeout: 30000 }, async () => {
    const captured = [];
    const server = createServer(async (incoming, response) => {
      let body = '';
      for await (const chunk of incoming) body += chunk;
      captured.push(JSON.parse(body));
      if (captured.length === 1) stream(response, [{ type: 'thinking', thinking: 'Need pwd.' }, { type: 'tool_use', id: 'toolu_1',
        name: 'mcp__omd__exec_command', input: { cmd: 'pwd' } }], 'tool_use');
      else stream(response, [{ type: 'text', text: 'Done' }]);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const upstream = `http://127.0.0.1:${server.address().port}`;
    const withTools = { ...request, tools: [{ type: 'function', name: 'exec_command',
      description: 'Run command', parameters: { type: 'object', properties: {
        cmd: { type: 'string' } }, required: ['cmd'] } }] };
    try {
      const streamed = [];
      const first = await runClaude(withTools, entry, process.env.OMD_TEST_CLAUDE,
        new AbortController().signal, event => streamed.push(event), { upstream });
      const tool = first.find(event => event.type === 'response.output_item.done' &&
        event.item.type === 'function_call')?.item;
      assert.equal(tool?.name, 'exec_command');
      assert.equal(streamed.find(event => event.type === 'response.reasoning_summary_text.delta')?.delta, 'Need pwd.');
      const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const second = await runClaude({ ...withTools, input: [...withTools.input,
        tool, { type: 'function_call_output', call_id: tool.call_id, output: [{ type: 'input_text', text: '/repo' },
          { type: 'input_image', image_url: png }] }] },
      entry, process.env.OMD_TEST_CLAUDE, new AbortController().signal, () => {}, { upstream });
      assert.equal(second.at(-1).type, 'response.completed');
      assert.equal(captured.length, 2);
      assert.equal(JSON.stringify(captured[1].messages).includes('tool_result'), true);
      assert.equal(JSON.stringify(captured[1].messages).includes('/repo'), true);
      assert.equal(JSON.stringify(captured[1].messages).includes('"type":"image"'), true);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

test('cancellation stops the owned CLI request and the next request starts cleanly',
  { skip: !process.env.OMD_TEST_CLAUDE, timeout: 30000 }, async () => {
    let admitted;
    const firstAdmitted = new Promise(resolve => { admitted = resolve; });
    let count = 0;
    const server = createServer(async (incoming, response) => {
      for await (const _ of incoming) {}
      count++;
      if (count === 1) { admitted(); return; }
      stream(response, [{ type: 'text', text: 'Restarted' }]);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const upstream = `http://127.0.0.1:${server.address().port}`;
    try {
      const controller = new AbortController();
      const pending = runClaude(request, entry, process.env.OMD_TEST_CLAUDE,
        controller.signal, () => {}, { upstream });
      await firstAdmitted;
      controller.abort();
      await assert.rejects(pending);
      const result = await runClaude(request, entry, process.env.OMD_TEST_CLAUDE,
        new AbortController().signal, () => {}, { upstream });
      assert.equal(result.at(-1).type, 'response.completed');
      assert.equal(count, 2);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });

test('upstream rate limit fails without another admitted request',
  { skip: !process.env.OMD_TEST_CLAUDE, timeout: 30000 }, async () => {
    let count = 0;
    const server = createServer(async (incoming, response) => {
      for await (const _ of incoming) {}
      count++;
      response.writeHead(429, { 'content-type': 'application/json', 'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-representative-claim': 'five_hour', 'anthropic-ratelimit-unified-5h-reset': '1790000000' })
        .end('{"type":"error","error":{"type":"rate_limit_error","message":"fixture"}}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      await assert.rejects(runClaude(request, entry, process.env.OMD_TEST_CLAUDE,
        new AbortController().signal, () => {},
        { upstream: `http://127.0.0.1:${server.address().port}` }), /Claude five_hour limit reached; resets/);
      assert.equal(count, 1);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });

test('setup reads the model catalog and served context windows from the installed CLI without account traffic',
  { skip: !process.env.OMD_TEST_CLAUDE, timeout: 120000 }, async () => {
    const models = await discover(process.env.OMD_TEST_CLAUDE);
    const byFamily = Object.fromEntries(models.map(item => [item.family, item]));
    assert.deepEqual(Object.keys(byFamily).sort(), ['fable', 'haiku', 'opus', 'sonnet']);
    for (const item of models) assert.ok([200000, 1000000].includes(item.window), `${item.cli}: ${item.window}`);
    assert.equal(byFamily.opus.efforts.at(-1), 'max');
  });
