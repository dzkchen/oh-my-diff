import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runnerSync } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const surface = { events: { turn_start: 'lifecycle', tool_result: 'lifecycle', tool_exposure: 'tools', context: 'context' }, replacements: [], middleware: [], state: 'store', contracts: 'contracts' };
const capabilities = ['tools', 'context', 'exec', 'fs.write', 'lifecycle', 'services', 'agents', 'store'];

function run(event, payload, state = null, receipts = [], settings = {}, name = '') {
  const request = { source, filename: 'omd_task_tools.ts', api: '0.2.0-experimental.5', capabilities, state, settings,
    event, name, payload, receipts, surface, hook_budget_ms: 1000 };
  const result = runnerSync(request);
  assert.ifError(result.error);
  return JSON.parse(result.stdout);
}

function replay(event, payload, state, work, settings = {}, name = '', failure = false) {
  const receipts = [];
  const calls = [];
  for (let index = 0; index < 8; index++) {
    const output = run(event, payload, state, receipts, settings, name);
    if (!output.host_call) return { output: output.value?.status === 'refused' ? { ...output, error: output.value.reason } : output, calls };
    const call = output.host_call;
    calls.push(call);
    if (call.operation === 'task.status') receipts.push({ call, value: { ledger: { thread_id: 'one', cost: null }, limits: {}, worker_limits: {} } });
    else if (call.operation === 'mods.service') {
      assert.deepEqual(call.arguments, { name: 'omd.workflow', method: 'status', input: null });
      receipts.push(failure ? { call, error: 'workflow_unavailable' } : { call, value: { schema: 1, remaining_work: work } });
    } else if (call.operation === 'exec.run') receipts.push({ call, value: { exit_code: 0, stdout: 'passed', stderr: '', timed_out: false,
      signal: null, stdout_truncated: false, stderr_truncated: false, duration_ms: 1, program: { path: '/bin/check', sha256: 'a'.repeat(64) } } });
    else assert.fail(`unexpected operation ${call.operation}`);
  }
  assert.fail('mod did not finish');
}

test('refreshes task-scoped exposure from workflow status and rechecks before executing', () => {
  const initial = replay('turn_start', { turn_id: 'a' }, null, ['fix src/main.py']);
  assert.equal(initial.output.error, undefined, initial.output.error);
  assert.deepEqual(initial.output.state, { one: ['python'] });
  const python = run('tool_exposure', { thread_id: 'one', available: ['check_python', 'check_typescript', 'check_rust'] }, initial.output.state);
  assert.deepEqual(python.value, { enable: ['check_python'] });
  const check = replay('tool', {}, initial.output.state, ['fix src/main.py'], { python_command: ['python3', '-m', 'py_compile', 'solution.py'] }, 'check_python');
  assert.equal(check.output.value.exit_code, 0);
  assert.deepEqual(check.calls.at(-1), { operation: 'exec.run', arguments: { program: 'python3', argv: ['-m', 'py_compile', 'solution.py'], write: true, timeout_ms: 120000, max_output_bytes: 65_536 } });
  const changed = replay('tool_result', { call_id: 'a', tool: 'mod_omd_workflow_checkpoint', outcome: 'succeeded' }, initial.output.state, ['fix src/view.ts']);
  assert.deepEqual(changed.output.state, { one: ['typescript'] });
  assert.deepEqual(run('tool_exposure', { thread_id: 'one', available: ['check_python', 'check_typescript', 'check_rust'] }, changed.output.state).value, { enable: ['check_typescript'] });
  assert.deepEqual(run('tool_exposure', { thread_id: 'other', available: ['check_python', 'check_typescript', 'check_rust'] }, changed.output.state).value, { enable: [] });
});

test('missing workflow clears exposure and stale selected tools refuse execution', () => {
  const prior = { one: ['python'] };
  const unavailable = replay('tool_result', { call_id: 'a', tool: 'mod_omd_workflow_checkpoint', outcome: 'succeeded' }, prior, [], {}, '', true);
  assert.deepEqual(unavailable.output.state, {});
  assert.deepEqual(run('tool_exposure', { thread_id: 'one', available: ['check_python'] }, unavailable.output.state).value, { enable: [] });
  const stale = replay('tool', {}, prior, ['write README'], {}, 'check_python');
  assert.match(stale.output.error, /check_not_selected_for_current_workflow/);
  assert.equal(stale.calls.some(call => call.operation === 'exec.run'), false);
});

test('invalid command override fails closed and ordinary defaults remain available', () => {
  const invalid = replay('tool', {}, { one: ['rust'] }, ['fix src/lib.rs'], { rust_command: ['cargo', 'test\0bad'] }, 'check_rust');
  assert.match(invalid.output.error, /check_command_invalid/);
  assert.equal(invalid.calls.some(call => call.operation === 'exec.run'), false);
  const normal = replay('tool', {}, { one: ['rust'] }, ['fix src/lib.rs'], {}, 'check_rust');
  assert.deepEqual(normal.calls.at(-1).arguments.argv, ['test', '--locked']);
});
