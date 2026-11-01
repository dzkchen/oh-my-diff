import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));

function run(state, args, output, success, { tool = 'exec_command', caller = 'model' } = {}) {
  const input = { tool, arguments: args, call_id: 'c', thread_id: 't', agent_id: null, schema: null, raw_arguments: '', batch: null };
  const payload = { surface: 'tool', input, original: input, origin: { caller } };
  const result = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: {}, event: 'intercept', name: '0', payload }, call => {
    assert.equal(call.operation, 'continuation.next');
    return { result: { output, success }, trace: [] };
  });
  assert.equal(result.error, undefined, result.error);
  const text = result.value?.result?.output ?? output;
  return { note: text === output ? null : text.slice(output.length + 2), state: result.state };
}

const repeat = (times, args, output, success, options) => {
  let state = null;
  const notes = [];
  for (let index = 0; index < times; index += 1) ({ note: notes[index], state } = run(state, args, output, success, options));
  return { notes, state };
};

test('the third identical failure and the fourth identical success get one note; timings do not count as changes', () => {
  const failed = repeat(4, { cmd: 'make  test' }, 'Wall time: 0.4 seconds\nerror: no rule', false);
  assert.deepEqual(failed.notes.map(Boolean), [false, false, true, false]);
  assert.equal(failed.notes[2], '[omd_loop_guard] `make test` has now returned the same error 3 times. Repeating it will not change the result: change the command or the approach.');
  const timed = repeat(2, { cmd: 'make' }, 'Wall time: 0.4 seconds\nerror: no rule', false).state;
  assert.ok(run(timed, { cmd: 'make' }, 'Wall time: 12.25 seconds\nerror: no rule', false).note);
  let budget = null;
  for (const [index, id] of ['out_aaaaaaaaaaaa', 'out_bbbbbbbbbbbb', 'out_cccccccccccc'].entries()) {
    const excerpt = `${'x'.repeat(2000)}${'y'.repeat(index * 50)}\n${'z'.repeat(600)}\n[omd_output_budget: ${index}; full output ${id}]`;
    ({ state: budget } = run(budget, { cmd: 'cat big.log' }, excerpt, false));
  }
  assert.equal(budget.calls[Object.keys(budget.calls)[0]].count, 3);
  assert.deepEqual(repeat(4, { cmd: 'ls' }, 'a', true).notes.map(Boolean), [false, false, false, true]);
  let { state } = repeat(2, { cmd: 'make' }, 'error 1', false);
  ({ state } = run(state, { cmd: 'make' }, 'error 2', false));
  assert.equal(run(state, { cmd: 'make' }, 'error 2', false).note, null);
});

test('an edit restarts the count, and polling tools are ignored', () => {
  let { state } = repeat(2, { cmd: 'pytest' }, 'FAILED', false);
  ({ state } = run(state, '*** Begin Patch\n*** Update File: a.py\n*** End Patch', 'Success.', true, { tool: 'apply_patch' }));
  assert.equal(run(state, { cmd: 'pytest' }, 'FAILED', false).note, null);
  ({ state } = repeat(2, { cmd: 'pytest' }, 'FAILED', false));
  ({ state } = run(state, { cmd: 'echo x > a.py' }, '', true));
  assert.equal(run(state, { cmd: 'pytest' }, 'FAILED', false).note, null);
  ({ state } = repeat(2, { cmd: 'pytest 2>&1' }, 'FAILED', false));
  ({ state } = run(state, { cmd: 'ls 2>/dev/null' }, '', true));
  assert.ok(run(state, { cmd: 'pytest 2>&1' }, 'FAILED', false).note);
  assert.deepEqual(repeat(5, { session_id: 1, chars: '' }, 'same', true, { tool: 'write_stdin' }).notes.map(Boolean), [false, false, false, false, false]);
});

test('a note from inside a code-mode cell is appended to the next result the model sees', () => {
  const { notes, state } = repeat(3, { cmd: 'cargo build' }, 'error[E0432]', false, { caller: 'code_mode' });
  assert.deepEqual(notes, [null, null, null]);
  const cell = run(state, 'await tools.exec_command({cmd: "cargo build"})', 'Script completed', true, { tool: 'exec' });
  assert.match(cell.note, /^\[omd_loop_guard\] `cargo build` has now returned the same error 3 times/);
  assert.equal(run(cell.state, 'text(1)', 'Script completed', true, { tool: 'exec' }).note, null);
  const waited = run(state, { cell_id: '1' }, 'Script completed', true, { tool: 'wait' });
  assert.match(waited.note, /^\[omd_loop_guard\] `cargo build`/);
  assert.deepEqual(waited.state.held, []);
});

test('a call keeps counting after 64 other calls were tracked, whatever its hash looks like', () => {
  let state = null;
  for (let index = 0; index < 70; index += 1) ({ state } = run(state, { cmd: `ls ${index}` }, 'x', false));
  const notes = [];
  for (let index = 0; index < 3; index += 1) ({ note: notes[index], state } = run(state, { cmd: 'ls 3' }, 'x', false));
  assert.deepEqual(notes.map(Boolean), [false, false, true]);
  assert.equal(Object.keys(state.calls).length, 64);
  assert.ok(Object.keys(state.calls).every(key => key.startsWith('k')));
});
