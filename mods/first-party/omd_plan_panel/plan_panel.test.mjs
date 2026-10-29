import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runnerSync } from '../../../tests/mod_runner.mjs';

const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const request = { source: readFileSync(new URL('./index.ts', import.meta.url), 'utf8'), filename: fileURLToPath(new URL('./index.ts', import.meta.url)), entrypoint: 'index.ts',
  api: manifest.api, capabilities: manifest.capabilities, settings: { rows: 8 }, hook_budget_ms: 10000 };

test('retained plans stay inside the host state limit by serialized UTF-8 bytes', () => {
  let state = null;
  for (let index = 0; index < 12; index++) {
    const reply = runnerSync({ ...request, state, event: 'app_notification', payload: { method: 'turn/plan/updated', thread_id: `thread-${index}`,
      params: { plan: Array.from({ length: 40 }, () => ({ step: '🧪'.repeat(120), status: 'pending' })) } } });
    assert.equal(reply.error, undefined);
    state = reply.state;
    assert.ok(Buffer.byteLength(JSON.stringify({ schema: 1, version: 1, value: state })) <= 196608, `thread ${index}`);
    assert.ok(state.plans[`thread-${index}`]);
  }
  assert.ok(!state.plans['thread-0'] && Object.keys(state.plans).length > 1);
});
