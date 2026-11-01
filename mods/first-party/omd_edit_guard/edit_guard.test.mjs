import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const ROOT = '/repo';

const listing = entries => entries === null ? null : entries.length ? `${entries.map(([kind, path]) => `${kind} ${path}`).join('\n')}\n--\n${entries.map(([, , hash]) => hash).join('\n')}\n` : '';

function run(tool, state = null, exits = {}, caller = 'model', listings = [], cwd = ROOT) {
  const runs = [];
  const listed = [];
  const input = { tool: tool.tool, arguments: tool.arguments, call_id: tool.call_id, thread_id: 't', agent_id: null, schema: null, raw_arguments: '', batch: null };
  const payload = { surface: 'tool', input, original: input, origin: { caller } };
  const output = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: {}, event: 'intercept', name: '0', payload }, call => {
    if (call.operation === 'session.info') return { thread_id: 't', root: ROOT, cwd };
    if (call.operation === 'continuation.next') return { result: { output: 'Success.', success: tool.success }, trace: [] };
    assert.equal(call.operation, 'exec.run');
    if (call.arguments.argv.length === 2) {
      listed.push(call.arguments.argv[1]);
      const stdout = listing(listings.length ? listings.shift() : []);
      return stdout === null ? { exit_code: 4, stdout: '', stderr: '', timed_out: false } : { exit_code: 0, stdout, stderr: '', timed_out: false };
    }
    const [, , , path, extension, ...checker] = call.arguments.argv;
    runs.push({ path, extension, checker, timeout: call.arguments.timeout_ms });
    const [exit_code, stdout] = exits[path] ?? [0, ''];
    return { exit_code, stdout, stderr: '', timed_out: false };
  });
  assert.equal(output.error, undefined, output.error);
  const text = output.value?.result?.output ?? 'Success.';
  return { append: text === 'Success.' ? null : text.replace('Success.\n\n', ''), state: output.state === undefined ? state : output.state, runs, listed };
}

const patch = (body, success = true) => ({ call_id: 'p', tool: 'apply_patch', arguments: `*** Begin Patch\n${body}\n*** End Patch`, success });
const write = cmd => ({ call_id: 's', tool: 'exec_command', arguments: { cmd }, success: true });
const INTRODUCED = '[omd_edit_guard] This edit introduced a syntax error. Fix it now, before anything else:\n';
const NEW_FILE = "[omd_edit_guard] A new file fails its syntax check. Fix it if the error is real; leave it if the file uses syntax this checker doesn't accept (JSONC, JSX, a newer language version):\n";

test('each checkable file of a patch runs its checker once, with no state in its arguments', () => {
  const { runs, append } = run(patch(`*** Add File: new.py\n+x\n*** Update File: ${ROOT}/src/app.mjs\n*** Move to: src/moved.js\n*** Update File: notes.md\n*** Update File: ../out.py`));
  assert.equal(append, null);
  assert.deepEqual(runs.map(({ path, extension, checker }) => [path, extension, checker[0]]), [['new.py', '.py', 'python3'], ['src/app.mjs', '.mjs', 'node'], ['src/moved.js', '.js', 'node']]);
  assert.ok(runs.every(entry => entry.timeout === 3000));
  assert.equal(run(patch('*** Update File: a.py', false)).runs.length, 0);
});

test('the 8-file cap counts only files it can check', () => {
  const body = [...Array.from({ length: 9 }, (_, index) => `*** Update File: doc${index}.md`), '*** Update File: late.py'].join('\n');
  assert.deepEqual(run(patch(body)).runs.map(({ path }) => path), ['late.py']);
});

test('an error whose HEAD version parses is reported without host noise and stays reported until the file parses', () => {
  const node = `${ROOT}/a.js:2\nlet = ;\n^^^\n\nSyntaxError: Unexpected token '='\n    at checkSyntax (node:internal/main/check_syntax:84:5)\n\nNode.js v24.22.1`;
  const broken = run(patch('*** Update File: a.js'), null, { 'a.js': [3, node] });
  assert.equal(broken.append, `${INTRODUCED}a.js:2\nlet = ;\n^^^\nSyntaxError: Unexpected token '='`);
  const again = run(patch('*** Update File: a.js'), broken.state, { 'a.js': [5, 'a.js:3: SyntaxError'] });
  assert.equal(again.append, `${INTRODUCED}a.js:3: SyntaxError`);
  const fixed = run(patch('*** Update File: a.js'), again.state);
  assert.equal(run(patch('*** Update File: a.js'), fixed.state, { 'a.js': [5, 'a.js:4: SyntaxError'] }).append, `${INTRODUCED}a.js:4: SyntaxError`, 'it parsed before');
  assert.equal(run(patch('*** Update File: b.js'), null, { 'b.js': [5, 'b.js:1: SyntaxError'] }).append, null, 'broken at HEAD and never seen parsing');
});

test('a new file the checker rejects is reported once as possibly valid, not as an introduced error', () => {
  const added = run(patch('*** Add File: tsconfig.json\n+{ // c\n+}'), null, { 'tsconfig.json': [5, 'tsconfig.json: Expecting property name'] });
  assert.equal(added.append, `${NEW_FILE}tsconfig.json: Expecting property name`);
  assert.equal(run(patch('*** Update File: tsconfig.json'), added.state, { 'tsconfig.json': [5, 'tsconfig.json: Expecting property name'] }).append, null);
});

test('mod edit tools are checked by their path arguments', () => {
  const edit = { call_id: 'e', tool: 'mod_omd_anchored_edit_edit', arguments: { files: [{ path: 'a.rb', edits: [] }, { path: 'b.go', edits: [] }] }, success: true };
  assert.deepEqual(run(edit).runs.map(entry => [entry.path, entry.checker[0]]), [['a.rb', 'ruby'], ['b.go', 'gofmt']]);
  const read = run(write('cat a.py'));
  assert.deepEqual([read.runs.length, read.listed.length], [0, 0]);
});

test('files a write-like shell command changed are found by listing Git before and after it', () => {
  const first = run(write("python3 - <<'PY'\nopen('a.py','w').write(s)\nPY"), null, { 'a.py': [3, 'a.py:1:4: SyntaxError: x'], 'new dir/b.json': [5, 'b.json: bad'] }, 'model',
    [[['M', 'old.py', '1']], [['M', 'old.py', '1'], ['M', 'a.py', '2'], ['A', 'new dir/b.json', '3']]]);
  assert.equal(first.listed.length, 2);
  assert.deepEqual(first.runs.map(({ path }) => path), ['a.py', 'new dir/b.json']);
  assert.equal(first.append, `${INTRODUCED}a.py:1:4: SyntaxError: x\n\n${NEW_FILE}b.json: bad`);
  assert.equal(run(write('grep -rl foo src | xargs sed -i "s/foo/bar/"')).listed.length, 2, 'an in-place edit later in a pipeline');
  for (const cmd of ['pytest 2>&1 >/dev/null', 'node -e "const f = x => x.toString()"', 'python -c "print(a > b.c)"']) assert.deepEqual(run(write(cmd)).listed, [], cmd);
  const nested = run(write('echo > sub/a.py'), null, {}, 'model', [[], [['M', 'sub/a.py', '4']]], `${ROOT}/sub`);
  assert.deepEqual(nested.runs.map(({ path }) => path), ['sub/a.py']);
  assert.deepEqual(run(write('echo > a.py'), null, {}, 'model', [null]).listed.length, 1, 'outside a repository it lists once and checks nothing');
});

test('errors from a code-mode cell\'s edits are held and appended to the next model-visible output', () => {
  const nested = run(patch('*** Update File: a.py'), null, { 'a.py': [3, 'a.py:1:7: SyntaxError: invalid syntax'] }, 'code_mode');
  assert.equal(nested.append, null);
  const cell = { call_id: 'x', tool: 'exec', arguments: 'await tools.apply_patch(...)', success: true };
  assert.equal(run(cell, nested.state).append, `${INTRODUCED}a.py:1:7: SyntaxError: invalid syntax`);
  assert.equal(run(cell, run(cell, nested.state).state).append, null);
});
