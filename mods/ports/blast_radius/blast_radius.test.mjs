import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { assertShortCircuit, assertWrapped, calls, coreValue, hostOperations, intercept, runScenario } from '@oh-my-diff/mod-api/testing';

const skip = !process.env.OMD_MOD_BIN && 'needs the omd-mod engine in OMD_MOD_BIN';
const directory = fileURLToPath(new URL('.', import.meta.url));
const ran = { output: 'ran', success: true };
const exec = (stdout, exit_code = 0, stderr = '') => ({ result: { exit_code, signal: null, timed_out: false, stdout, stderr, stdout_sha256: '', stdout_bytes: 0, output_artifact: null,
  stdout_truncated: false, stdout_preview_truncated: false, stderr_truncated: false, stderr_preview_truncated: false, duration_ms: 1, program: { path: '/bin/sh', sha256: '' }, guards_verified: 0 } });
const root = exec('/work/repo\n');
const accepted = { result: { status: 'accepted', values: ['proceed'] } };
const declined = { result: { status: 'accepted', values: ['cancel'] } };

function guard(cmd, operations, workdir) {
  const arguments_ = workdir ? { cmd, workdir } : { cmd };
  const input = { tool: 'exec_command', arguments: arguments_, call_id: 'call-1', thread_id: 'fixture', agent_id: null, schema: null, raw_arguments: JSON.stringify(arguments_), batch: null };
  const trace = runScenario(directory, hostOperations(operations), { steps: [intercept('tool', input, { core: [coreValue(ran)] })] });
  return { trace, chain: trace.steps[0].value, prompt: calls(trace, 'terminal.prompt')[0]?.arguments, execs: calls(trace, 'exec.run').map(call => call.arguments) };
}

test('rm -rf is measured and holds until the user accepts', { skip }, () => {
  const { trace, chain, prompt, execs } = guard('rm -rf build', {
    'exec.run': [root, exec('3 24 1\n./build/a.o\n./build/b.o\n./build/c.o\n')],
    'terminal.prompt': [accepted],
    'terminal.notice': [{ result: { shown: true } }],
  });
  assertWrapped(chain, 'blast_radius');
  assert.deepEqual(execs.map(call => call.program), ['pwd', 'bash']);
  assert.deepEqual(execs[1].argv.slice(-2), ['blast-radius', 'build']);
  assert.equal(prompt.kind, 'choice');
  assert.match(prompt.message, /rm -rf build.*3 files.*build\/a\.o/);
  assert.deepEqual(trace.unused_mock_replies, []);
});

test('declining denies the call with the measured summary and never reaches the tool', { skip }, () => {
  const { chain } = guard('rm -rf build', { 'exec.run': [root, exec('3 24 1\n./build/a.o\n')], 'terminal.prompt': [declined] });
  assertShortCircuit(chain, 'blast_radius');
  assert.equal(typeof chain.result.deny, 'string');
});

test('a prompt that cannot be asked denies', { skip }, () => {
  const { chain } = guard('git clean -fd', { 'exec.run': [root, exec('')], 'terminal.prompt': [{ error: 'client_surface_unavailable' }] });
  assertShortCircuit(chain, 'blast_radius');
});

test('git clean is dry-run with the user flags but never -f', { skip }, () => {
  const { prompt, execs } = guard('git clean -fdx -e keep', {
    'exec.run': [root, exec('Would remove tmp/\nWould remove out.log\n')],
    'terminal.prompt': [declined],
  });
  assert.deepEqual(execs[1].argv.slice(-6), ['clean', '-n', '-dx', '-e', 'keep', '--']);
  assert.deepEqual([execs[1].program, ...execs[1].argv.slice(0, 2)], ['env', 'LC_ALL=C', 'git'], 'git output is parsed in the C locale');
  assert.match(prompt.message, /tmp\/, out\.log/);
});

test('a refspec source cannot become a git option', { skip }, () => {
  const { prompt, execs } = guard('git push origin +--output=x:main', { 'exec.run': [root], 'terminal.prompt': [declined] });
  assert.ok(execs.every(call => !call.argv.some(word => word.startsWith('--output'))), JSON.stringify(execs));
  assert.ok(prompt);
});

