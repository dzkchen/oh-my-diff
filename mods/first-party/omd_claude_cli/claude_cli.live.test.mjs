import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { translateRequest, responseEvents } from './index.ts';
import { runClaude } from './transport.mjs';
import { discover } from './setup.mjs';

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

test('upstream rate limit fails without another admitted request',
  { timeout: 30000 }, async () => {
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
      await assert.rejects(runClaude(opusRequest, opusEntry, process.env.OMD_TEST_CLAUDE,
        new AbortController().signal, () => {},
        { upstream: `http://127.0.0.1:${server.address().port}` }), /Claude five_hour limit reached; resets/);
      assert.equal(count, 1);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });

test('setup reads the model catalog and served context windows from the installed CLI without account traffic',
  { timeout: 120000 }, async () => {
    const models = await discover(process.env.OMD_TEST_CLAUDE);
    const byFamily = Object.fromEntries(models.map(item => [item.family, item]));
    assert.deepEqual(Object.keys(byFamily).sort(), ['fable', 'haiku', 'opus', 'sonnet']);
    for (const item of models) assert.ok([200000, 1000000].includes(item.window), `${item.cli}: ${item.window}`);
    assert.equal(byFamily.opus.efforts.at(-1), 'max');
  });

test('pinned Codex executes a mod-mapped host tool and returns its result',
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

test('Claude setup adds its provider grant to the OMD+ store without disturbing other host settings',
  { timeout: 120000 }, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'omd-claude-setup-')));
    const prefix = join(root, 'prefix');
    const store = join(root, 'store');
    try {
      await mkdir(prefix);
      await mkdir(join(store, 'sources'), { recursive: true });
      await cp(pkg, join(store, 'sources/omd_claude_cli'), { recursive: true });
      const other = { name: 'worker', provider: 'fixture', model: 'fixture', reasoning_effort: 'low', responses_url: 'http://127.0.0.1:9/v1/responses',
        roles: ['lead'], rates: { input_microusd_per_million: 1, cached_microusd_per_million: 1, output_microusd_per_million: 1,
          reservation_microusd: 1, max_output_tokens: 1, input_token_ceiling: 1, included_subscription: false } };
      await writeFile(join(store, 'host.json'), JSON.stringify({ schema: 1, routes: [other], max_request_bytes: 33554432,
        worker_limits: { requests: 5, exposure_microusd: 7, seconds: 60 } }));
      const recordPath = join(prefix, 'install.json');
      await writeFile(recordPath, JSON.stringify({ profile: 'full', prefix, store, packages: { omd_claude_cli: {} },
        author: { node: process.execPath } }));
      const run = () => spawnSync(process.execPath, [join(store, 'sources/omd_claude_cli/setup.mjs'), 'setup', recordPath,
        process.env.OMD_TEST_CLAUDE], { encoding: 'utf8', timeout: 90000 });
      const setup = () => {
        const result = run();
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout);
      };
      const first = setup();
      const host = JSON.parse(await readFile(join(store, 'host.json'), 'utf8'));
      assert.deepEqual(host.routes, [other]);
      assert.equal(host.max_request_bytes, 33554432);
      assert.deepEqual(host.worker_limits, { requests: 5, exposure_microusd: 7, seconds: 86400 });
      const grant = host.services.find(service => service.id === 'claude_cli');
      assert.deepEqual(grant.arguments.slice(1, 3), ['serve', first.provider.route]);
      assert.equal(grant.route.rates.included_subscription, true);
      assert.equal(first.billing, 'subscription');
      const route = JSON.parse(await readFile(first.provider.route, 'utf8'));
      assert.equal(route.billing, 'subscription');
      assert.ok(grant.read_paths.length <= 16);
      assert.equal(host.secret_refs.claude_local_token, first.provider.token);
      assert.equal((await stat(first.provider.token)).mode & 0o777, 0o600);
      const catalog = JSON.parse(await readFile(first.provider.catalog, 'utf8')).models;
      assert.deepEqual(catalog.map(model => [model.slug, model.context_window]), first.models.map(model => [model.slug, model.window]));
      assert.ok(catalog.every(model => model.input_modalities.includes('image')));
      const token = await readFile(first.provider.token, 'utf8');
      const again = setup();
      assert.equal(again.provider.base_url, first.provider.base_url);
      assert.equal(await readFile(first.provider.token, 'utf8'), token);
      const rerun = JSON.parse(await readFile(join(store, 'host.json'), 'utf8'));
      assert.equal(rerun.services.filter(service => service.id === 'claude_cli').length, 1);
      await writeFile(first.provider.route, JSON.stringify({ ...route, billing: 'api' }));
      assert.match(run().stderr, /claude_console_api_key_login_required/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
