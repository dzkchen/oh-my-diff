import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const INSTRUCTION = 'Resume the interrupted task. First check the workspace, conversation and running processes to find the last completed step, partial edits and side effects. Continue from the first unfinished step without redoing or reverting finished work, then run the relevant verification.';

function command(turns, text = '') {
  const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state: null, settings: {},
    event: 'command', name: 'continue', payload: text, hook_budget_ms: 2000 };
  const output = callback(request, call => {
    assert.deepEqual(call, { operation: 'turns.activity', arguments: { last: 1 } });
    if (typeof turns === 'string') throw new Error(turns);
    return { turns, recording: true };
  });
  if (output.error) throw new Error(output.error);
  return output.value;
}

const turn = (outcome, extra = {}) => ({ turn_id: 't', started_at: 'a', ended_at: null, outcome, reason: null, error: null, unrecorded_end: false,
  tool_calls: [], processes: [], files: [], truncated: false, ...extra });

test('continue submits the fixed instruction with only host-observed interruption facts', () => {
  assert.equal(command('unsupported_host_operation: turns.activity').display, '/continue is unavailable: unsupported_host_operation: turns.activity');
  assert.match(command([turn('running')]).display, /^A turn is running/);
  for (const turns of [[], [turn('completed')]]) assert.match(command(turns).display, /^No interrupted or failed turn/);
  assert.deepEqual(command([turn('completed')], ' check the build '), { submit: `${INSTRUCTION}\n\nNote: check the build` });
  assert.equal(command([turn('interrupted', { unrecorded_end: true })]).submit, `${INSTRUCTION}\n\nHost-observed interruption summary:\n- Last turn: interrupted`);
  const failed = turn('error', { error: { category: 'transport', code: 'server_overloaded', message: 'Selected model is at capacity.' } });
  assert.equal(command([failed]).submit, `${INSTRUCTION}\n\nHost-observed interruption summary:\n- Last turn: error (transport: Selected model is at capacity.)`);
  const aborted = turn('aborted', {
    reason: 'interrupted',
    tool_calls: [{ call_id: 'a', tool: 'apply_patch', started_at: 'a', finished_at: 'b', outcome: 'succeeded' }, { call_id: 'b', tool: 'exec_command', started_at: 'a', finished_at: null, outcome: null },
      ...['c', 'd', 'e'].map(call_id => ({ call_id, tool: 'exec_command', started_at: 'a', finished_at: 'b', outcome: 'aborted' }))],
    processes: [{ id: 'b', kind: 'exec', command: `sleep   30 ${'x'.repeat(110)}🙂 tail`, running: true, exit_code: null }, { id: 'c', kind: 'exec', command: 'make', running: null, exit_code: null }],
    files: ['a', 'a', ...'bcdefghij'].map(path => ({ path, before: null, after: 'x', source: 'tool' })), truncated: true,
  });
  assert.equal(command([aborted], 'tests first').submit, `${INSTRUCTION}\n\nNote: tests first\n\nHost-observed interruption summary:\n`
    + '- Last turn: aborted (interrupted)\n- Unfinished tool calls: exec_command (no recorded result), exec_command (aborted) ×3\n'
    + `- Still running: exec sleep 30 ${'x'.repeat(110)}🙂\n`
    + '- Files changed in that turn: a, b, c, d, e, f, g, h (+2 more)\n- The host activity record for that turn is truncated.');
});
