import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const runner = readFileSync(new URL('../../../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const surface = { events: {}, replacements: [], middleware: [], state: 'store', contracts: 'contracts' };
const INSTRUCTION = 'Resume the interrupted task. First check the workspace, conversation and running processes to find the last completed step, partial edits and side effects. Continue from the first unfinished step without redoing or reverting finished work, then run the relevant verification.';

function command(turns, text = '') {
  const receipts = [];
  for (;;) {
    const request = { source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state: null, settings: {},
      event: 'command', name: 'continue', payload: text, receipts, surface, hook_budget_ms: 2000 };
    const output = JSON.parse(spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner],
      { input: JSON.stringify(request), encoding: 'utf8', timeout: 5000 }).stdout);
    if (output.error) throw new Error(output.error);
    if (!output.host_call) return output.value;
    assert.deepEqual(output.host_call, { operation: 'turns.activity', arguments: { last: 1 } });
    receipts.push(typeof turns === 'string' ? { call: output.host_call, error: turns } : { call: output.host_call, value: { turns, recording: true } });
  }
}

const turn = (outcome, extra = {}) => ({ turn_id: 't', started_at: 'a', ended_at: null, outcome, reason: null, unrecorded_end: false,
  tool_calls: [], processes: [], files: [], truncated: false, ...extra });

test('continue submits the fixed instruction with only host-observed interruption facts', () => {
  assert.equal(command('unsupported_host_operation: turns.activity').display, '/continue is unavailable: unsupported_host_operation: turns.activity');
  assert.match(command([turn('running')]).display, /^A turn is running/);
  for (const turns of [[], [turn('completed')]]) assert.match(command(turns).display, /^No interrupted or failed turn/);
  assert.deepEqual(command([turn('completed')], ' check the build '), { submit: `${INSTRUCTION}\n\nNote: check the build` });
  assert.equal(command([turn('interrupted', { unrecorded_end: true })]).submit, `${INSTRUCTION}\n\nHost-observed interruption summary:\n- Last turn: interrupted`);
  const aborted = turn('aborted', {
    reason: 'interrupted',
    tool_calls: [{ call_id: 'a', tool: 'apply_patch', started_at: 'a', finished_at: 'b', outcome: 'succeeded' }, { call_id: 'b', tool: 'exec_command', started_at: 'a', finished_at: null, outcome: null },
      { call_id: 'c', tool: 'exec_command', started_at: 'a', finished_at: 'b', outcome: 'aborted' }],
    processes: [{ id: 'b', kind: 'exec', command: 'sleep   30', running: true, exit_code: null }, { id: 'c', kind: 'exec', command: 'make', running: null, exit_code: null }],
    files: ['a', 'a', ...'bcdefghij'].map(path => ({ path, before: null, after: 'x', source: 'tool' })), truncated: true,
  });
  assert.equal(command([aborted], 'tests first').submit, `${INSTRUCTION}\n\nNote: tests first\n\nHost-observed interruption summary:\n`
    + '- Last turn: aborted (interrupted)\n- Unfinished tool calls: exec_command (no recorded result), exec_command (aborted)\n- Still running: exec sleep 30\n'
    + '- Files changed in that turn: a, b, c, d, e, f, g, h (+2 more)\n- The host activity record for that turn is truncated.');
});
