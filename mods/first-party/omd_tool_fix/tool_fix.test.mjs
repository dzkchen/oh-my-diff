import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));
const exec = {
  type: 'object',
  properties: {
    cmd: { type: 'string' }, workdir: { type: 'string' }, max_output_tokens: { type: 'integer' }, yield_time_ms: { type: 'number' },
    tty: { type: 'boolean' }, paths: { type: 'array', items: { type: 'string' } }, options: { type: 'object', properties: { depth: { type: 'integer' } } },
    mode: { type: 'string', enum: ['fast', 'full'] },
  },
  required: ['cmd'],
  additionalProperties: false,
};

function run(event, name, payload, { state = null, inner = { output: 'ok', success: true } } = {}) {
  const calls = [];
  const output = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, state, settings: {}, event, name, payload }, call => {
    calls.push(call);
    if (call.operation === 'continuation.next') return event === 'intercept' && name === '0' ? { result: { chunks: [call.arguments.input] }, trace: [] } : { result: inner, trace: [] };
    if (call.operation === 'evidence.write') return { reference: `evidence:${calls.length}`, sha256: '0'.repeat(64) };
    assert.fail(`unexpected ${call.operation}`);
  });
  if (output.error) throw new Error(output.error);
  const next = calls.find(call => call.operation === 'continuation.next');
  return { value: output.value, state: output.state, next: next?.arguments.input ?? null, evidence: calls.filter(call => call.operation === 'evidence.write').map(call => call.arguments.content) };
}

function call(arguments_, { schema = exec, tool = 'exec_command', state, inner } = {}) {
  const input = { tool, arguments: arguments_, call_id: 'call-1', thread_id: 'thread', agent_id: null, schema, raw_arguments: JSON.stringify(arguments_), batch: null };
  return run('intercept', '1', { surface: 'tool', input, original: input, origin: { caller: 'model' } }, { state, inner });
}

function stream(arguments_) {
  const input = { kind: 'tool_done', request_id: 'r', scope: { thread_id: 'thread', agent_id: null, kind: 'main' }, synthetic: null, protected: false,
    index: 0, item_id: null, call_id: 'call-1', tool: 'exec_command', format: 'json', arguments: arguments_ };
  return run('intercept', '0', { surface: 'response_stream', input, original: input, origin: { caller: 'engine' } });
}

test('a valid call passes through untouched and records nothing', () => {
  const args = { cmd: 'ls', max_output_tokens: 200, paths: ['a'] };
  const { next, state, evidence } = call(args);
  assert.deepEqual(next.arguments, args);
  assert.equal(state, null);
  assert.deepEqual(evidence, []);
});

test('representation errors are repaired against the schema and recorded with the original', () => {
  const { next, state, evidence } = call({ cmd: 'ls', maxOutputTokens: '200', tty: 'false', yield_time_ms: '2.5e3', paths: '["a","b c"]', options: '{"depth":"2"}', mode: 'FAST' });
  assert.deepEqual(next.arguments, { cmd: 'ls', max_output_tokens: 200, tty: false, yield_time_ms: 2500, paths: ['a', 'b c'], options: { depth: 2 }, mode: 'fast' });
  assert.deepEqual(evidence[0].original.maxOutputTokens, '200');
  assert.deepEqual(evidence[0].changes.map(change => change.rule).sort(),
    ['boolean_string', 'enum_case', 'integer_string', 'integer_string', 'json_string', 'json_string', 'key_name', 'number_string']);
  assert.equal(state.corrected, 1);
  assert.equal(state.ran, 1);
  assert.equal(state.recent[0].evidence, 'evidence:2', 'evidence is written after the call ran');
  const again = call(next.arguments, { state });
  assert.deepEqual(again.next.arguments, next.arguments, 'a corrected call needs no further correction');
  assert.deepEqual(again.state, state);
});

test('unsafe coercions are refused and the call reaches the tool unchanged', () => {
  for (const args of [
    { cmd: 'ls', max_output_tokens: '5.0' }, { cmd: 'ls', max_output_tokens: '05' }, { cmd: 'ls', max_output_tokens: ' 5' }, { cmd: 'ls', max_output_tokens: '+5' },
    { cmd: 'ls', max_output_tokens: 5.5 }, { cmd: 'ls', max_output_tokens: '9007199254740993' }, { cmd: 'ls', yield_time_ms: '9007199254740993' }, { cmd: 5 }, { cmd: ['ls'] }, { cmd: 'ls', paths: 'a' },
    { cmd: 'ls', tty: '1' }, { cmd: 'ls', tty: 'yes' }, { cmd: 'ls', mode: 'quick' }, { cmd: null }, { cmd: 'ls', workdir: null }, { cmd: 'ls', extra: true },
  ]) {
    const { next, state, evidence } = call(args);
    assert.deepEqual(next.arguments, args, JSON.stringify(args));
    assert.deepEqual(evidence, []);
    assert.equal(state.unrepaired, 1);
  }
});

test('ambiguous repairs are sent back as a precise correction request without running', () => {
  const twoCases = { ...exec, properties: { ...exec.properties, mode: { type: 'string', enum: ['fast', 'FAST', 'full'] } } };
  const enumCase = call({ cmd: 'ls', mode: 'Fast' }, { schema: twoCases });
  assert.equal(enumCase.next, null);
  assert.equal(enumCase.value.result.success, false);
  assert.match(enumCase.value.result.output, /^exec_command was not run: .*\/mode: "Fast" could be "fast" or "FAST"\. Send the call again with exact values\.$/);
  const conflict = call({ cmd: 'ls', Cmd: 'rm -rf /' });
  assert.equal(conflict.next, null);
  assert.match(conflict.value.result.output, /\/Cmd: conflicts with cmd, which is also set/);
  const either = { type: 'object', properties: { limit: { anyOf: [{ type: 'integer' }, { type: 'boolean' }, { type: 'array' }] }, n: { anyOf: [{ type: 'integer' }, { type: 'number' }] } } };
  assert.match(call({ limit: 'true' }, { schema: { ...either, properties: { limit: { anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['TRUE'] }] } } } }).value.result.output, /fits 2 anyOf variants/);
  assert.deepEqual(call({ limit: '[1]', n: '3' }, { schema: either }).next.arguments, { limit: [1], n: 3 });
});

test('a __proto__ key survives a repair and oversized arguments keep only the change list', () => {
  const open = { type: 'object', properties: { n: { type: 'integer' } } };
  const { next } = call(JSON.parse('{"n":"1","__proto__":{"x":1}}'), { schema: open, tool: 'lookup' });
  assert.equal(JSON.stringify(next.arguments), '{"n":1,"__proto__":{"x":1}}');
  const big = { cmd: 'x'.repeat(40_000), tty: 'true' };
  const { next: ran, evidence } = call(big);
  assert.equal(ran.arguments.tty, true);
  assert.equal(evidence[0].original, '(too large to keep)');
  assert.deepEqual(evidence[0].changes, [{ path: '/tty', rule: 'boolean_string' }]);
});

test('freeform, schemaless and unknown tools are never touched', () => {
  for (const [tool, args, schema] of [['apply_patch', '*** Begin Patch', null], ['mcp__x__y', { a: '1' }, null], ['unknown', { a: '1' }, null]]) {
    const { next, state } = call(args, { tool, schema });
    assert.deepEqual(next.arguments, args);
    assert.equal(state, null);
  }
});

test('each call is checked against the schema it arrives with, never a remembered one', () => {
  const v1 = { type: 'object', properties: { limit: { type: 'integer' } } };
  const v2 = { type: 'object', properties: { limit: { type: 'string' } } };
  const first = call({ limit: '5' }, { schema: v1, tool: 'lookup' });
  assert.deepEqual(first.next.arguments, { limit: 5 });
  const second = call({ limit: '5' }, { schema: v2, tool: 'lookup', state: first.state });
  assert.deepEqual(second.next.arguments, { limit: '5' });
  assert.equal(second.state.corrected, 1);
});

test('a repeated ambiguous or host-rejected call stops being corrected after two tries', () => {
  const schema = { ...exec, properties: { ...exec.properties, mode: { type: 'string', enum: ['fast', 'FAST'] } } };
  let state = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = call({ cmd: 'ls', mode: 'Fast' }, { schema, state });
    assert.equal(result.next, null);
    state = result.state;
  }
  const released = call({ cmd: 'ls', mode: 'Fast' }, { schema, state });
  assert.deepEqual(released.next.arguments, { cmd: 'ls', mode: 'Fast' });
  assert.equal(released.state.released, 1);

  const rejected = { output: 'tool_arguments_invalid: exec_command: /tty: expected boolean', success: false };
  let host = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = call({ cmd: 'ls', tty: 'true' }, { state: host, inner: rejected });
    assert.deepEqual(result.next.arguments, { cmd: 'ls', tty: true });
    host = result.state;
  }
  assert.equal(host.rejected, 2);
  assert.deepEqual(call({ cmd: 'ls', tty: 'true' }, { state: host }).next.arguments, { cmd: 'ls', tty: 'true' });
});

test('broken JSON is repaired only for trailing commas and a code fence', () => {
  const comma = stream('{"cmd": "echo a,}", "paths": ["x",],}');
  assert.equal(comma.next.arguments, '{"cmd": "echo a,}", "paths": ["x"]}');
  assert.deepEqual(comma.evidence[0].rules, ['trailing_comma']);
  assert.equal(comma.state.json, 1);
  assert.equal(stream('```json\n{"cmd":"ls"}\n```').next.arguments, '{"cmd":"ls"}');
  for (const text of ['{"cmd":"ls"}', "{cmd: 'ls'}", '{"cmd": "ls"', '["ls",]', '']) {
    const { next, state } = stream(text);
    assert.equal(next.arguments, text, text);
    assert.equal(state, null);
  }
});

test('/toolfix reports counts and recent changes', () => {
  const { state } = call({ cmd: 'ls', tty: 'true' });
  const { value } = run('command', 'toolfix', null, { state });
  assert.match(value.display, /^Tool-call correction: 1 corrected \(1 ran, 0 failed in the tool, 0 rejected by the host\)/);
  assert.match(value.display, /\ncorrected exec_command call-1: \/tty boolean_string → ran · evidence:2$/);
});
