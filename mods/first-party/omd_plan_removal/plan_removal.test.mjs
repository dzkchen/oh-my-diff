import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));

test('activation hides /plan and disables plan mode, nothing else', () => {
  const result = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, settings: {}, state: null, event: 'start', payload: null },
    call => assert.fail(`unexpected host call ${call.operation}`));
  assert.equal(result.error, undefined, result.error);
  assert.deepEqual(result.registrations.builtins, [{ commands: { hide: ['plan'] }, modes: { disable: ['plan'] } }]);
});
