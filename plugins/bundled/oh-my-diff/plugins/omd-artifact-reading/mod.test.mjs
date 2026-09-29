import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const runner = readFileSync(new URL('../../../../../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const source = readFileSync(new URL('./mod/index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod/mod.json', import.meta.url), 'utf8'));
const request = { uri: 'github://owner/repo/issues/1', max_bytes: 1024 };
const response = { canonical_uri: request.uri, canonical_url: 'https://github.com/owner/repo/issues/1', identity: 'owner/repo', revision: 'rev', text: 'issue', anchors: ['issue:1'], cursor: null, truncated: false };

function invoke(receipts = []) {
  const input = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, surface: { events: {}, middleware: [], replacements: [], state: 'store' }, state: null, settings: {}, event: 'virtual_read', name: 'github', payload: request, receipts };
  const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner], { input: JSON.stringify(input), encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  if (result.status !== 0 && !result.stdout) return { error: result.stderr };
  return JSON.parse(result.stdout);
}

test('GitHub virtual read uses the generic sidecar operation and preserves bounded untrusted response', () => {
  assert.equal(manifest.api, '0.2.0-experimental.1');
  assert.deepEqual(manifest.capabilities, ['virtual_reads', 'exec']);
  const first = invoke();
  assert.deepEqual(first.registrations.virtual_reads, [{ scheme: 'github', version: '1.0.0' }]);
  assert.deepEqual(first.host_call, { operation: 'sidecars.invoke', arguments: { id: 'omd_github_read', input: request } });
  const done = invoke([{ call: first.host_call, value: { provider: 'omd_github_read', program_sha256: 'a'.repeat(64), source_hashes: {}, result: response, untrusted: true } }]);
  assert.deepEqual(done.value, response);
});

test('GitHub virtual read fails closed when sidecar authority or response is unavailable', () => {
  const first = invoke();
  const denied = invoke([{ call: first.host_call, error: 'sidecar_not_authorized' }]);
  assert.match(denied.error, /sidecar_not_authorized/);
  const malformed = invoke([{ call: first.host_call, value: { result: { error: 'upstream_unavailable' } } }]);
  assert.match(malformed.error, /upstream_unavailable/);
});
