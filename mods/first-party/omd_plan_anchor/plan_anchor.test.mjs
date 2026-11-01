import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { callback } from '../../../tests/mod_runner.mjs';

const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const request = { source: readFileSync(new URL('./index.ts', import.meta.url), 'utf8'), filename: fileURLToPath(new URL('./index.ts', import.meta.url)), entrypoint: 'index.ts',
  api: manifest.api, capabilities: manifest.capabilities, settings: { every: 3 }, hook_budget_ms: 10_000 };

function call(state, tool, args, caller = 'model', thread = 't1') {
  const input = { tool, arguments: args, call_id: 'c', thread_id: thread, agent_id: null, schema: null, raw_arguments: JSON.stringify(args), batch: null };
  const output = callback({ ...request, state, event: 'intercept', name: '0', payload: { surface: 'tool', input, original: input, origin: { caller, thread_id: thread } } }, ({ operation }) => {
    assert.equal(operation, 'continuation.next');
    return { result: { output: 'ok', success: true, truncated: false, bytes: 2 }, trace: [] };
  });
  assert.equal(output.error, undefined);
  return { state: output.state, output: output.value?.result?.output ?? 'ok' };
}

test('open plan steps are appended to every third model tool result after the plan was last shown', () => {
  let { state } = call(null, 'update_plan', { plan: [{ step: 'Read the test', status: 'completed' }, { step: 'Fix the parser', status: 'in_progress' }, { step: 'Run the suite', status: 'pending' }] });
  const outputs = [];
  for (let index = 0; index < 6; index++) ({ state, output: outputs[index] } = call(state, 'exec_command', { cmd: 'ls' }));
  assert.deepEqual(outputs.map(output => output !== 'ok'), [false, false, true, false, false, true]);
  assert.equal(outputs[2], 'ok\n\n[omd_plan_anchor: current plan, 1/3 done; call update_plan when it changes]\n- [>] Fix the parser\n- [ ] Run the suite');
  assert.equal(call(state, 'exec_command', { cmd: 'ls' }, 'code_mode').output, 'ok');
  assert.equal(call(state, 'exec_command', { cmd: 'ls' }, 'model', 't2').output, 'ok', 'plans are per thread');
  ({ state } = call(state, 'update_plan', { plan: [{ step: 'Fix the parser', status: 'completed' }] }));
  for (let index = 0; index < 4; index++) assert.equal(call(state, 'exec_command', { cmd: 'ls' }).output, 'ok', 'a finished plan is not repeated');
});
