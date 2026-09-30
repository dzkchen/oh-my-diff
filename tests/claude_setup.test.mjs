import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('Claude setup adds its provider grant to the OMD+ store without disturbing other host settings',
  { skip: !process.env.OMD_TEST_CLAUDE, timeout: 120000 }, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'omd-claude-setup-')));
    const prefix = join(root, 'prefix');
    const store = join(root, 'store');
    try {
      await mkdir(prefix);
      await mkdir(join(store, 'sources'), { recursive: true });
      await cp(resolve('mods/first-party/omd_claude_cli'), join(store, 'sources/omd_claude_cli'), { recursive: true });
      const other = { name: 'worker', provider: 'fixture', model: 'fixture', reasoning_effort: 'low', responses_url: 'http://127.0.0.1:9/v1/responses',
        roles: ['lead'], rates: { input_microusd_per_million: 1, cached_microusd_per_million: 1, output_microusd_per_million: 1,
          reservation_microusd: 1, max_output_tokens: 1, input_token_ceiling: 1, included_subscription: false } };
      await writeFile(join(store, 'host.json'), JSON.stringify({ schema: 1, routes: [other], max_request_bytes: 33554432,
        worker_limits: { requests: 5, exposure_microusd: 7, seconds: 60 } }));
      const recordPath = join(prefix, 'install.json');
      await writeFile(recordPath, JSON.stringify({ profile: 'full', prefix, store, packages: { omd_claude_cli: {} },
        author: { node: process.execPath } }));
      const setup = () => {
        const result = spawnSync(process.execPath, [join(store, 'sources/omd_claude_cli/setup.mjs'), 'setup', recordPath,
          process.env.OMD_TEST_CLAUDE], { encoding: 'utf8', timeout: 90000 });
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
    } finally { await rm(root, { recursive: true, force: true }); }
  });
