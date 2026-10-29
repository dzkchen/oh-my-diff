import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));

function run(event, name, payload, state, host = call => assert.fail(`unexpected ${call.operation}`)) {
  const output = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, settings: {},
    package: { id: manifest.id }, state, event, name, payload }, host);
  assert.equal(output.error, undefined, output.error);
  return output;
}
const walk = (node, found = []) => {
  if (node && typeof node === 'object') {
    if (typeof node.type === 'string') found.push(node);
    for (const child of Object.values(node)) walk(child, found);
  }
  return found;
};
const bytes = text => new TextEncoder().encode(text).length;

test('/lsp open clips a long excerpt path to the 128-byte label limit', () => {
  const path = `${'é'.repeat(100)}/${'n'.repeat(200)}.ts`;
  const opened = run('command', 'lsp', `open ${path}:5`, null, call => call.operation === 'exec.run' ? { exit_code: 0, stdout: 'one\ntwo\n' }
    : call.operation === 'events.publish' ? { delivered: 1, dropped: 0 } : assert.fail(call.operation));
  const view = run('terminal', undefined, { ledger: null }, opened.state).value;
  const document = walk(view).find(node => node.type === 'document');
  assert.ok(document.label.length > 0 && bytes(document.label) <= 128, `${bytes(document.label)} bytes`);
  assert.ok(path.startsWith(document.label));
});

test('the servers card shows why a running server is degraded', () => {
  const servers = [
    { adapter: 'python', server: 'pyright', status: 'synced', reason: 'degraded: workspace_index_unavailable', documents: 2, count: 0, errors: [] },
    { adapter: 'typescript', server: 'tsserver', status: 'synced', reason: '', documents: 1, count: 0, errors: [] },
  ];
  const published = run('channel', undefined, { channel: 'omd_lsp_sync/status', publisher: 'omd_lsp_sync', data: servers }, { open: true });
  const view = run('terminal', undefined, { ledger: null }, published.state).value;
  const lines = walk(view).filter(node => node.type === 'line').map(node => node.spans.map(span => span.text).join(''));
  assert.deepEqual(lines, ['python pyright · degraded: workspace index unavailable', 'typescript tsserver']);
});
