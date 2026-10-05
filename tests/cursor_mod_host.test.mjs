import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const sdk = `import { appendFileSync } from 'node:fs';
export class JsonlLocalAgentStore {}
class FakeAgent {
  agentId = 'agent-host';
  async send(message, options) {
    const tools = options.local.customTools;
    const work = (async () => {
      const result = await tools.exec_command.execute({ cmd: 'pwd' }, {});
      appendFileSync(new URL('result.json', import.meta.url), JSON.stringify({ tools: Object.keys(tools), result }));
      options.onDelta({ update: { type: 'text-delta', text: 'OK' } });
      return { status: 'finished', usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    })();
    return { id: 'run', wait: () => work, cancel: async () => {} };
  }
  async getUsage() { return { usage: {}, runs: [] }; }
}
export const Agent = { create: async () => new FakeAgent() };
`;

test('pinned Codex executes an OMD tool that a Cursor run called through the transport',
  { skip: !process.env.OMD_TEST_CODEX, timeout: 60000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'omd-cursor-host-'));
    await mkdir(join(root, 'codex-home'));
    await writeFile(join(root, 'sdk.mjs'), sdk);
    const reserve = createServer();
    await new Promise(done => reserve.listen(0, '127.0.0.1', done));
    const port = reserve.address().port;
    await new Promise(done => reserve.close(done));
    await writeFile(join(root, 'route.json'), JSON.stringify({ port, sdk: join(root, 'sdk.mjs'), data: join(root, 'data'),
      models: [{ slug: 'cursor-auto', id: 'auto' }], secret_profile: 'p1', backend_url: 'http://127.0.0.1:9' }));
    const token = 'x'.repeat(40);
    const transport = spawn(process.execPath, [new URL('../mods/first-party/omd_cursor/transport.mjs', import.meta.url).pathname, 'serve', join(root, 'route.json')],
      { env: { PATH: '/usr/bin:/bin', OMD_CURSOR_LOCAL_TOKEN: token, OMD_READY_TOKEN: 'ready', OMD_SECRETS: '[{"id":"p1","value":"crsr_fixture"}]' }, stdio: 'ignore' });
    try {
      for (let attempt = 0; attempt < 50; attempt++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/_omd/ready`)).ok) break; } catch {}
        await new Promise(done => setTimeout(done, 50));
      }
      const settings = ['model="cursor-auto"', 'model_provider="omd_cursor"', 'web_search="disabled"',
        `model_catalog_json=${JSON.stringify(new URL('../mods/first-party/omd_cursor/models.json', import.meta.url).pathname)}`,
        `model_providers.omd_cursor.base_url="http://127.0.0.1:${port}/v1"`, 'model_providers.omd_cursor.name="OMD Cursor"',
        'model_providers.omd_cursor.wire_api="responses"', 'model_providers.omd_cursor.env_key="OMD_CURSOR_LOCAL_TOKEN"',
        'model_providers.omd_cursor.request_max_retries=0', 'model_providers.omd_cursor.stream_max_retries=0',
        'model_providers.omd_cursor.supports_websockets=false'];
      const argv = [...settings.flatMap(value => ['-c', value]), 'exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
        '--sandbox', 'workspace-write', '-C', root, 'Use the available command tool, then say OK.'];
      const child = spawn(process.env.OMD_TEST_CODEX, argv, { env: { ...process.env, CODEX_HOME: join(root, 'codex-home'),
        OMD_CURSOR_LOCAL_TOKEN: token, OMD_MODE: 'upstream_direct' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let error = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { error += chunk; });
      assert.equal(await new Promise(done => child.once('close', done)), 0, error.slice(-2000));
      const relayed = JSON.parse(await readFile(join(root, 'result.json'), 'utf8'));
      assert.ok(relayed.tools.includes('exec_command'));
      assert.match(JSON.stringify(relayed.result), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/^\/private/, '')));
      assert.match(output, /OK/);
    } finally {
      transport.kill('SIGKILL');
      await rm(root, { recursive: true, force: true });
    }
  });
