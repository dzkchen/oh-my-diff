import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { translateRequest, responseEvents } from '../mods/first-party/omd_claude_cli/index.ts';

test('pinned Codex executes a mod-mapped host tool and returns its result',
  { skip: !process.env.OMD_TEST_CODEX, timeout: 30000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'omd-claude-host-'));
    await mkdir(join(root, 'codex-home'));
    const catalog = resolve('mods/first-party/omd_claude_cli/models.json');
    const calls = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      calls.push(payload);
      const translated = translateRequest(payload, 'claude-sonnet-5');
      const tool = Object.entries(translated.reverse).find(([, item]) => item.name === 'exec_command');
      assert.ok(tool);
      const first = calls.length === 1;
      const content = first ? [{ type: 'tool_use', id: 'call_omd_fixture',
        name: `mcp__omd__${tool[0]}`, input: { cmd: 'pwd' } }] :
        [{ type: 'text', text: 'OK' }];
      const events = responseEvents({ id: `msg_${calls.length}`, content,
        usage: { input_tokens: 20, output_tokens: 5 } }, { upstream_requests: 1 },
      'claude-sonnet-5', translated.reverse);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const settings = [`model="claude-sonnet-5"`, 'model_provider="omd_claude_cli"',
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
      const fields = [];
      const visit = value => {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') {
          for (const key of ['image_url', 'file_id', 'file_data', 'audio'])
            if (key in value) fields.push(key);
          if (typeof value.type === 'string' && ['web_search', 'web_search_preview',
            'file_search', 'computer', 'computer_use_preview', 'code_interpreter',
            'image_generation', 'mcp', 'input_image', 'input_file', 'input_audio'].includes(value.type))
            types.push(value.type);
          Object.values(value).forEach(visit);
        }
      };
      visit(calls[0]);
      assert.deepEqual(types, []);
      assert.ok(fields.includes('image_url'));
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
