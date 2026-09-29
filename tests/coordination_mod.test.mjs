import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const source = readFileSync(new URL('../mods/first-party/omd_coordination/index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../mods/first-party/omd_coordination/mod.json', import.meta.url), 'utf8'));
const native = readFileSync(new URL('../runtime/omd/src/mods.rs', import.meta.url), 'utf8');
const events = native.match(/pub const MOD_EVENTS:[\s\S]*?= &\[([\s\S]*?)\];/)[1];
const surface = { events: Object.fromEntries([...events.matchAll(/\("([a-z_]+)", "([a-z_.]+)"\)/g)].map(match => [match[1], match[2]])),
  replacements: ['routing', 'context'], middleware: [], state: 'store' };

function prepare(brief, maximum) {
  const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities,
    state: null, settings: { worker_context: 'focused_brief', worker_context_max_bytes: maximum }, surface,
    event: 'service', name: 'omd.coordination.prepare_delegation', payload: { brief }, receipts: [] };
  const child = spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner],
    { input: JSON.stringify(request), encoding: 'utf8', timeout: 5000 });
  assert.ifError(child.error);
  assert.ok(child.status === 0 || child.status === 1, child.stdout + child.stderr);
  return JSON.parse(child.stdout);
}

test('migrated worker context limit counts encoded bytes', () => {
  const accepted = prepare('a'.repeat(80), 300);
  assert.equal(accepted.value.parent_history, false);
  const refused = prepare('🧪'.repeat(80), 300);
  assert.match(refused.error, /worker_context_limit/);
});
