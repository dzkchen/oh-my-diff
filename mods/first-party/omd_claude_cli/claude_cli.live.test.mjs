import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as nodeTest } from 'node:test';
import { translateRequest, responseEvents } from './index.ts';
import { runClaude } from './transport.mjs';

// Every test drives a real Claude CLI; without OMD_TEST_CLAUDE a glob that picks this file up skips it.
const test = process.env.OMD_TEST_CLAUDE ? nodeTest : nodeTest.skip;

const pkg = fileURLToPath(new URL('./', import.meta.url));
const opus = 'claude-opus-5-5';
const opusEntry = { slug: opus, cli: opus, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], thinking: true, window: 1000000 };
const opusRequest = { model: opus, stream: true, reasoning: { effort: 'max' }, input: [{ type: 'message', role: 'user',
  content: [{ type: 'input_text', text: 'Reply OK.' }] }] };

function sse(response, blocks, stopReason = 'end_turn') {
  const events = [{ type: 'message_start', message: { id: 'msg_omd_fixture', type: 'message',
    role: 'assistant', model: opus, content: [], usage: { input_tokens: 12, output_tokens: 2,
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
  { timeout: 30000 }, async () => {
    const captured = [];
    const server = createServer(async (incoming, response) => {
      let body = '';
      for await (const chunk of incoming) body += chunk;
      captured.push(JSON.parse(body));
      sse(response, [{ type: 'text', text: 'OK' }]);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const streamed = [];
    const priorTmp = process.env.TMPDIR;
    process.env.TMPDIR = '/private/tmp/omd-claude-missing-fixture';
    try {
      const result = await runClaude(opusRequest, opusEntry, process.env.OMD_TEST_CLAUDE,
        new AbortController().signal, event => streamed.push(event),
        { upstream: `http://127.0.0.1:${server.address().port}` });
      assert.equal(captured.length, 1);
      assert.equal(captured[0].model, opus);
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
  { timeout: 30000 }, async () => {
    const captured = [];
    const server = createServer(async (incoming, response) => {
      let body = '';
      for await (const chunk of incoming) body += chunk;
      captured.push(JSON.parse(body));
      if (captured.length === 1) sse(response, [{ type: 'thinking', thinking: 'Need pwd.' }, { type: 'tool_use', id: 'toolu_1',
        name: 'mcp__omd__exec_command', input: { cmd: 'pwd' } }], 'tool_use');
      else sse(response, [{ type: 'text', text: 'Done' }]);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const upstream = `http://127.0.0.1:${server.address().port}`;
    const withTools = { ...opusRequest, tools: [{ type: 'function', name: 'exec_command',
      description: 'Run command', parameters: { type: 'object', properties: {
        cmd: { type: 'string' } }, required: ['cmd'] } }] };
    try {
      const streamed = [];
      const first = await runClaude(withTools, opusEntry, process.env.OMD_TEST_CLAUDE,
        new AbortController().signal, event => streamed.push(event), { upstream });
      const tool = first.find(event => event.type === 'response.output_item.done' &&
        event.item.type === 'function_call')?.item;
      assert.equal(tool?.name, 'exec_command');
      assert.equal(streamed.find(event => event.type === 'response.reasoning_summary_text.delta')?.delta, 'Need pwd.');
      const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const second = await runClaude({ ...withTools, input: [...withTools.input,
        tool, { type: 'function_call_output', call_id: tool.call_id, output: [{ type: 'input_text', text: '/repo' },
          { type: 'input_image', image_url: png }] }] },
      opusEntry, process.env.OMD_TEST_CLAUDE, new AbortController().signal, () => {}, { upstream });
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
  { timeout: 30000 }, async () => {
    let admitted;
    const firstAdmitted = new Promise(resolve => { admitted = resolve; });
    let count = 0;
    const server = createServer(async (incoming, response) => {
      for await (const _ of incoming) {}
      count++;
      if (count === 1) { admitted(); return; }
      sse(response, [{ type: 'text', text: 'Restarted' }]);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const upstream = `http://127.0.0.1:${server.address().port}`;
    try {
      const controller = new AbortController();
      const pending = runClaude(opusRequest, opusEntry, process.env.OMD_TEST_CLAUDE,
        controller.signal, () => {}, { upstream });
      await firstAdmitted;
      controller.abort();
      await assert.rejects(pending);
      const result = await runClaude(opusRequest, opusEntry, process.env.OMD_TEST_CLAUDE,
        new AbortController().signal, () => {}, { upstream });
      assert.equal(result.at(-1).type, 'response.completed');
      assert.equal(count, 2);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });

(process.env.OMD_TEST_CODEX ? test : nodeTest.skip)('pinned Codex executes a mod-mapped host tool and returns its result',
  { timeout: 30000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'omd-claude-host-'));
    await mkdir(join(root, 'codex-home'));
    const catalog = join(pkg, 'models.json');
    const calls = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      calls.push(payload);
      const translated = translateRequest(payload, 'claude-opus-5-5');
      const tool = Object.entries(translated.reverse).find(([, item]) => item.name === 'exec_command');
      assert.ok(tool);
      const first = calls.length === 1;
      const content = first ? [{ type: 'tool_use', id: 'call_omd_fixture',
        name: `mcp__omd__${tool[0]}`, input: { cmd: 'pwd' } }] :
        [{ type: 'text', text: 'OK' }];
      const events = responseEvents({ id: `msg_${calls.length}`, content,
        usage: { input_tokens: 20, output_tokens: 5 } }, { upstream_requests: 1 },
      'claude-opus-5-5', translated.reverse);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const settings = [`model="claude-opus-5-5"`, 'model_provider="omd_claude_cli"',
      'model_reasoning_effort="medium"', 'web_search="disabled"',
      `model_catalog_json=${JSON.stringify(catalog)}`,
      `model_providers.omd_claude_cli.base_url="http://127.0.0.1:${port}/v1"`,
      'model_providers.omd_claude_cli.name="OMD Claude CLI"',
      'model_providers.omd_claude_cli.wire_api="responses"',
      'model_providers.omd_claude_cli.env_key="OMD_CLAUDE_LOCAL_TOKEN"',
      'model_providers.omd_claude_cli.request_max_retries=0',
      'model_providers.omd_claude_cli.stream_max_retries=0',
      'model_providers.omd_claude_cli.supports_websockets=false'];
    const argv = settings.flatMap(value => ['-c', value]);
    argv.push('exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
      '--sandbox', 'workspace-write', '-C', root, 'Use the available command tool, then say OK.');
    try {
      const child = spawn(process.env.OMD_TEST_CODEX, argv, { env: { ...process.env,
        CODEX_HOME: join(root, 'codex-home'), OMD_CLAUDE_LOCAL_TOKEN: 'x'.repeat(40),
        OMD_MODE: process.env.OMD_TEST_MOD_STORE ? 'omd' : 'upstream_direct',
        ...(process.env.OMD_TEST_MOD_STORE ? { OMD_MOD_STORE: process.env.OMD_TEST_MOD_STORE } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let error = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { error += chunk; });
      const exit = await new Promise(resolve => child.once('close', resolve));
      assert.equal(exit, 0, error.slice(-2000));
      assert.equal(calls.length, 2);
      const types = [];
      const visit = value => {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') {
          if (typeof value.type === 'string' && ['web_search', 'web_search_preview',
            'file_search', 'computer', 'computer_use_preview', 'code_interpreter',
            'image_generation', 'mcp', 'input_image', 'input_file', 'input_audio'].includes(value.type))
            types.push(value.type);
          Object.values(value).forEach(visit);
        }
      };
      visit(calls[0]);
      assert.deepEqual(types, []);
      assert.equal(calls[0].input.some(item => JSON.stringify(item).includes('input_image')), false);
      assert.equal(calls[1].input.some(item => item.type === 'function_call_output' &&
        item.call_id === 'call_omd_fixture'), true);
      assert.match(output, /OK/);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  });

