import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));

function run(event, name, payload, state, { settings = {}, markers = ['pyproject.toml'] } = {}) {
  let next = null;
  const output = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings, event, name, payload }, call => {
    if (call.operation === 'continuation.next') return { result: (next = { stop: true }), trace: [] };
    if (call.operation === 'workspace.stat') return { files: Object.fromEntries(call.arguments.paths.map(path => [path, markers.includes(path) ? { kind: 'file', size: 1, mtime_ms: 0 } : null])) };
    assert.fail(`unexpected ${call.operation}`);
  });
  assert.equal(output.error, undefined, output.error);
  return { value: output.value?.result, state: output.state, stopped: next !== null };
}

const patch = (body, success = true) => ({ call_id: 'p', tool: 'apply_patch', arguments: `*** Begin Patch\n${body}\n*** End Patch`, success, text: 'Success.', tail: null, bytes: 8 });
const shell = (cmd, text, success = true) => ({ call_id: 'c', tool: 'exec_command', arguments: { cmd }, success, text, tail: null, bytes: text.length });
const exited = (code, body = '') => `Chunk ID: 1\nWall time: 0.4 seconds\nProcess exited with code ${code}\nOriginal token count: 9\nOutput:\n${body}`;
const stop = (state, settings, outcome = 'completed') => {
  const input = { thread_id: 't', turn_id: 'u', outcome, error: null, message: 'Done.', continued: 0, limit: 4, provenance: null };
  return run('intercept', '0', { surface: 'turn_stop', input, original: input, origin: { caller: 'engine' } }, state, { settings });
};
const feed = (...outputs) => outputs.reduce((state, output) => run('tool_output', '', output, state).state, run('turn_start', '', { turn_id: 'u' }, null).state);

test('an unverified edit continues once with a runner hint and the created files, then stops', () => {
  const state = feed(patch('*** Update File: src/app.py\n@@\n-a\n+b\n*** Add File: repro.py\n+print(1)'));
  const first = stop(state);
  assert.match(first.value.continue, /edited src\/app\.py, repro\.py/);
  assert.match(first.value.continue, /Reproduce the issue first/);
  assert.match(first.value.continue, /likely: python -m pytest/);
  assert.match(first.value.continue, /created: repro\.py/);
  assert.equal(stop(first.state).stopped, true);
});

test('a passing check after the last edit, no edits, docs-only edits, errors and the off setting all stop', () => {
  const probed = shell('python repro.py', exited(1, 'AssertionError'));
  assert.equal(stop(feed(probed, patch('*** Update File: a.py'), shell('cd src && python -m pytest tests/test_a.py -q', exited(0, '3 passed')))).stopped, true);
  assert.equal(stop(feed(shell('ls', exited(0)))).stopped, true);
  assert.equal(stop(feed(patch('*** Update File: README.md'))).stopped, true);
  assert.equal(stop(feed(patch('*** Update File: a.py', false))).stopped, true);
  assert.equal(stop(feed(patch('*** Update File: a.py')), {}, 'error').stopped, true);
  assert.equal(stop(feed(patch('*** Update File: a.py')), { max_continuations: 0 }).stopped, true);
  const reproduced = stop(feed(probed, patch('*** Update File: a.py')));
  assert.doesNotMatch(reproduced.value.continue, /Reproduce/);
});

test('a check that failed after the last edit gets a second continuation with its summary', () => {
  const edited = feed(patch('*** Update File: a.py'));
  const first = stop(edited);
  const failing = run('tool_output', '', shell('pytest tests/test_a.py', exited(1, 'FAILED tests/test_a.py::test_x - assert 1 == 2')), first.state).state;
  const second = stop(failing);
  assert.match(second.value.continue, /FAILED tests\/test_a\.py::test_x - assert 1 == 2/);
  assert.doesNotMatch(second.value.continue, /Chunk ID|Wall time/);
  assert.equal(stop(second.state).stopped, true);
});

test('only commands in command position count, and a piped run is judged by its output', () => {
  const edited = () => feed(patch('*** Update File: a.py'));
  for (const cmd of ['rg -n pytest .', 'cat tsconfig.json', 'grep jest package.json']) assert.equal(stop(run('tool_output', '', shell(cmd, exited(0)), edited()).state).stopped, false, cmd);
  for (const cmd of ['bash -lc "cd src && PYTHONPATH=. python tests/runtests.py queries"', 'timeout 60 uv run pytest -x']) assert.equal(stop(run('tool_output', '', shell(cmd, exited(0)), edited()).state).stopped, true, cmd);
  const piped = run('tool_output', '', shell('python -m pytest tests -q 2>&1 | tail -5', exited(0, '1 failed, 3 passed in 0.2s')), edited()).state;
  assert.match(stop(piped).value.continue, /The last check failed:\n1 failed, 3 passed/);
});

test('a backgrounded check settles through write_stdin, and a later edit voids a pass', () => {
  const started = feed(patch('*** Update File: lib.rs'), shell('cargo test', 'Process running with session ID 7\nOutput:\n'));
  const done = run('tool_output', '', { call_id: 'w', tool: 'write_stdin', arguments: { session_id: 7, chars: '' }, success: true, text: exited(0, 'ok'), tail: null, bytes: 9 }, started).state;
  assert.equal(stop(done).stopped, true);
  assert.equal(stop(run('tool_output', '', shell("sed -i 's/a/b/' lib.rs", exited(0)), done).state).stopped, false);
});

test('a check the environment cannot run (missing module or command, no network) stops, unless a later check ran', () => {
  const missing = exited(1, "Traceback (most recent call last):\nModuleNotFoundError: No module named 'asgiref'");
  assert.equal(stop(feed(patch('*** Update File: a.py'), shell('python tests/runtests.py auth_tests', missing))).stopped, true);
  assert.equal(stop(feed(shell('pytest -q', exited(127, 'zsh: command not found: pytest')), patch('*** Update File: a.py'))).stopped, true);
  const later = feed(patch('*** Update File: a.py'), shell('python tests/runtests.py auth_tests', missing), shell('pytest tests/test_a.py', exited(1, 'FAILED tests/test_a.py::test_x')));
  assert.match(stop(later).value.continue, /The last check failed:\nFAILED tests\/test_a\.py::test_x/);
});

test('a > inside quoted code is not a redirect, and in-place edits of docs are not code edits', () => {
  for (const cmd of ['node -e "const f = x => x.toString()"', 'python -c "print(a > b.c)"', "sed -i 's/a/b/' README.md", "perl -pi -e 's/a/b/' docs/guide.rst"]) {
    assert.equal(stop(feed(shell(cmd, exited(0)))).stopped, true, cmd);
  }
  const written = stop(feed(shell('echo "x = 1" > scratch.py && cp a.py b.py', exited(0))));
  assert.match(written.value.continue, /edited scratch\.py, b\.py/);
  assert.match(written.value.continue, /created: scratch\.py\)/);
});

test('moving scratch files out after a passing check is not an edit, but an in-place edit through xargs or find is', () => {
  const passed = () => feed(patch('*** Update File: a.py'), shell('pytest -q', exited(0)));
  for (const cmd of ['mv repro.py /tmp/', 'cp coverage.json /tmp/cov.json', 'git diff > patch']) assert.equal(stop(run('tool_output', '', shell(cmd, exited(0)), passed()).state).stopped, true, cmd);
  for (const cmd of ['grep -rl foo src | xargs sed -i "s/foo/bar/"', 'find . -name "*.py" -exec sed -i s/a/b/ {} +', 'env FOO=1 sed -i s/a/b/ x.py']) assert.equal(stop(run('tool_output', '', shell(cmd, exited(0)), passed()).state).stopped, false, cmd);
});
