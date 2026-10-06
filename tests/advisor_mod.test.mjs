import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from './mod_runner.mjs';

const root = new URL('../mods/first-party/omd_advisor/', import.meta.url);
const source = readFileSync(new URL('index.ts', root), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('mod.json', root), 'utf8'));

test('every-turn advisor suppresses the same model unless explicitly enabled', () => {
  for (const skip of [true, false]) {
    const calls = [];
    const result = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities,
      settings: { every_turn: true, skip_same_model: skip }, state: null, environment: manifest.environment,
      surface: { events: { start: 'lifecycle', resume: 'lifecycle', turn_start: 'lifecycle', workspace_change: 'fs.read', turn_end: 'lifecycle', agent_end: 'agents', context: 'context', terminal: 'terminal' }, replacements: [], middleware: [], state: 'store', contracts: 'contracts' },
      event: 'turn_end', payload: { outcome: 'completed', turn_id: 'turn', evidence: { sha256: 'a'.repeat(64) } },
    }, ({ operation }) => {
      calls.push(operation);
      if (operation === 'routes.list') return [{ name: 'astra', model: 'same' }];
      if (operation === 'task.status') return { ledger: { thread_id: 'thread' } };
      if (operation === 'app.request') return { thread: { model: 'same' } };
      if (operation === 'evidence.read') throw new Error('fixture_stop_after_suppression');
      throw new Error(`unexpected ${operation}`);
    }, []);
    assert.equal(result.error, undefined);
    assert.equal(calls.includes('evidence.read'), !skip);
    assert.equal(calls.includes('workspace.snapshot'), false);
    assert.equal(calls.includes('agents.spawn'), false);
  }
});
