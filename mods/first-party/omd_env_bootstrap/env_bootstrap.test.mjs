import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { callback } from '../../../tests/mod_runner.mjs';
import SNAPSHOT from './snapshot.ts';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const manifest = JSON.parse(read('./mod.json'));
const request = { source: read('./index.ts'), filename: fileURLToPath(new URL('./index.ts', import.meta.url)), entrypoint: 'index.ts', api: manifest.api,
  capabilities: manifest.capabilities, assets: { 'snapshot.ts': { text: read('./snapshot.ts'), sha256: '0'.repeat(64) } }, settings: {}, hook_budget_ms: 10_000 };
const section = (id, role, group) => ({ id, kind: id, role, group, protected: false, text: id, bytes: id.length, truncated: false });
const sections = [section('instructions', 'system', 'instructions'), section('agents_md.instructions', 'user', '1'), section('environments.environment_context', 'user', '1'), section('skill:x', 'user', '3')];

function send(state, exec) {
  const calls = [];
  let sent = null;
  const input = { request_id: 'r', attempt: 1, scope: { thread_id: 't1', agent_id: null, kind: 'main' }, routes: [], original: {}, route: 'lead', model: 'm', provider: 'p', effort: null, sections, tools: [] };
  const output = callback({ ...request, state, event: 'intercept', name: '0', payload: { surface: 'model_request', input, original: input, origin: { caller: 'engine' } } }, ({ operation, arguments: args }) => {
    calls.push(operation);
    if (operation === 'exec.run') return exec(args);
    if (operation === 'continuation.next') { sent = args.input.sections; return { result: { route: 'lead', effort: null, cache: { from: null } }, trace: [] }; }
    assert.fail(`unexpected ${operation}`);
  });
  assert.equal(output.error, undefined);
  return { state: output.state, sent, calls };
}

test('the snapshot runs once per thread and is inserted unchanged after the environment context on every request', () => {
  const stdout = `os: Linux x86_64\nfiles (2): src/ pyproject.toml\nlanguages: \nnoise line\ntest: pytest\n${'tools: rg jq\n'.repeat(200)}`;
  const first = send(null, args => {
    assert.deepEqual([args.program, args.argv, args.timeout_ms, args.write, args.network], ['sh', ['-s'], 3000, undefined, undefined]);
    assert.equal(args.stdin, SNAPSHOT);
    return { exit_code: 0, stdout, timed_out: false };
  });
  const inserted = first.sent[3];
  assert.deepEqual(first.sent.map(item => item.id), ['instructions', 'agents_md.instructions', 'environments.environment_context', 'mod:omd_env_bootstrap', 'skill:x']);
  assert.match(inserted.text, /\nos: Linux x86_64\nfiles \(2\): src\/ pyproject.toml\ntest: pytest\ntools: rg jq\n/);
  assert.doesNotMatch(inserted.text, /noise|languages/);
  assert.ok(Buffer.byteLength(inserted.text) <= 1536 && inserted.text.endsWith('\n'));
  const later = send(first.state, () => assert.fail('the snapshot is never retaken'));
  assert.deepEqual(later.sent, first.sent);
});

test('a failed or empty snapshot saves nothing, so the next request tries again; a timed-out one keeps its lines', () => {
  const failed = send(null, () => { throw new Error('exec_program_unavailable'); });
  assert.deepEqual([failed.sent, failed.state], [sections, null]);
  assert.deepEqual(send(null, () => ({ exit_code: null, stdout: '', timed_out: true })).state, null);
  assert.match(send(null, () => ({ exit_code: null, stdout: 'os: Linux\ncwd: /a\n', timed_out: true })).state, /\nos: Linux\ncwd: \/a\n$/);
  assert.equal(send(failed.state, () => ({ exit_code: 0, stdout: 'os: Linux\n', timed_out: false })).sent[3].id, 'mod:omd_env_bootstrap');
});
