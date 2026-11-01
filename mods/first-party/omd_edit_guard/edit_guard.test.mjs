import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const ROOT = '/repo';

function run(tool, state = null, exits = {}, caller = 'model') {
  const runs = [];
  const input = { tool: tool.tool, arguments: tool.arguments, call_id: tool.call_id, thread_id: 't', agent_id: null, schema: null, raw_arguments: '', batch: null };
  const payload = { surface: 'tool', input, original: input, origin: { caller } };
  const output = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: {}, event: 'intercept', name: '0', payload }, call => {
    if (call.operation === 'session.info') return { thread_id: 't', root: ROOT, cwd: ROOT };
    if (call.operation === 'continuation.next') return { result: { output: 'Success.', success: tool.success }, trace: [] };
    assert.equal(call.operation, 'exec.run');
    const [, , , path, extension, known, ...checker] = call.arguments.argv;
    runs.push({ path, extension, known, checker, timeout: call.arguments.timeout_ms });
    const [exit_code, stdout] = exits[path] ?? [0, ''];
    return { exit_code, stdout, stderr: '', timed_out: false };
  });
  assert.equal(output.error, undefined, output.error);
  const text = output.value?.result?.output ?? 'Success.';
  return { append: text === 'Success.' ? null : text.replace('Success.\n\n', ''), state: output.state, runs };
}

const patch = (body, success = true) => ({ call_id: 'p', tool: 'apply_patch', arguments: `*** Begin Patch\n${body}\n*** End Patch`, success, text: 'Success.', tail: null, bytes: 8 });

test('each checkable file of a patch runs its checker once; a new or moved file is trusted, an update is compared with HEAD', () => {
  const { runs, append } = run(patch(`*** Add File: new.py\n+x\n*** Update File: ${ROOT}/src/app.mjs\n*** Move to: src/moved.js\n*** Update File: notes.md\n*** Update File: ../out.py`));
  assert.equal(append, null);
  assert.deepEqual(runs.map(({ path, extension, known, checker }) => [path, extension, known, checker[0]]), [['new.py', '.py', '1', 'python3'], ['src/app.mjs', '.mjs', '0', 'node'], ['src/moved.js', '.js', '1', 'node']]);
  assert.ok(runs.every(entry => entry.timeout === 3000));
  assert.equal(run(patch('*** Update File: a.py', false)).runs.length, 0);
});

test('a reported error is appended without host noise and the file stays trusted until it parses again', () => {
  const node = `${ROOT}/a.js:2\nlet = ;\n^^^\n\nSyntaxError: Unexpected token '='\n    at checkSyntax (node:internal/main/check_syntax:84:5)\n\nNode.js v24.22.1`;
  const broken = run(patch('*** Update File: a.js'), null, { 'a.js': [3, node] });
  assert.equal(broken.append, "[omd_edit_guard] This edit introduced a syntax error. Fix it now, before anything else:\na.js:2\nlet = ;\n^^^\nSyntaxError: Unexpected token '='");
  const again = run(patch('*** Update File: a.js'), broken.state, { 'a.js': [3, node] });
  assert.equal(again.runs[0].known, '1');
  const unchecked = run(patch('*** Update File: a.js'), again.state, { 'a.js': [4, ''] });
  assert.equal(run(patch('*** Update File: a.js'), unchecked.state).runs[0].known, '0');
});

test('mod edit tools are checked by their path arguments', () => {
  const edit = { call_id: 'e', tool: 'mod_omd_anchored_edit_edit', arguments: { files: [{ path: 'a.rb', edits: [] }, { path: 'b.go', edits: [] }] }, success: true, text: '', tail: null, bytes: 0 };
  assert.deepEqual(run(edit).runs.map(entry => [entry.path, entry.checker[0]]), [['a.rb', 'ruby'], ['b.go', 'gofmt']]);
  assert.equal(run({ ...edit, tool: 'exec_command', arguments: { cmd: 'cat a.py' } }).runs.length, 0);
});

test('errors from a code-mode cell\'s edits are held and appended to the cell\'s own output', () => {
  const nested = run(patch('*** Add File: a.py'), null, { 'a.py': [3, 'a.py:1:7: SyntaxError: invalid syntax'] }, 'code_mode');
  assert.equal(nested.append, null);
  const cell = { call_id: 'x', tool: 'exec', arguments: 'await tools.apply_patch(...)', success: true };
  assert.equal(run(cell, nested.state).append, '[omd_edit_guard] This edit introduced a syntax error. Fix it now, before anything else:\na.py:1:7: SyntaxError: invalid syntax');
  assert.equal(run(cell, run(cell, nested.state).state).append, null);
});
