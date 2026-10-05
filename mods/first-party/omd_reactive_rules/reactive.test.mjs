import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const surface = { events: { start: 'lifecycle', resume: 'lifecycle', turn_start: 'lifecycle', tool_result: 'lifecycle', context: 'context' }, replacements: [], middleware: [], intercept: { response_stream: 'middleware' }, state: 'store', contracts: 'contracts' };
const rule = { id: 'placeholder', pattern: '\\bTODO: implement\\b', reminder: 'Write the implementation instead of a placeholder.' };

function session(rules) {
  let state = null;
  return (event, payload = {}, extra = {}) => {
    const request = { source, filename: 'omd_reactive_rules.ts', api: '0.2.0-experimental.5', capabilities: ['context', 'lifecycle', 'middleware', 'store'],
      state, settings: { rules }, event, payload, surface, hook_budget_ms: 2000, ...extra };
    const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner], { input: JSON.stringify(request), encoding: 'utf8', timeout: 5000 });
    const output = JSON.parse(result.stdout);
    if (output.error) throw new Error(output.error);
    if (!output.host_call) state = output.state;
    return output;
  };
}
const item = text => ({ kind: 'message', index: 0, item_id: 'm', text, protected: false });
function stream(run, input) {
  const payload = { surface: 'response_stream', input, original: input, origin: { caller: 'engine' } };
  const first = run('intercept', payload, { name: '0' });
  if (first.value?.unmatched) return null;
  const receipts = [{ call: first.host_call, value: { result: { chunks: [input] }, trace: [] } }];
  const { result } = run('intercept', payload, { name: '0', receipts }).value;
  return result.chunks ? null : result;
}

test('rejects unbounded, empty-matching, ambiguous and oversized rules at load', () => {
  for (const [rules, error] of [
    [[{ ...rule, pattern: 'TODO.*' }], 'rule_pattern_unbounded'],
    [[{ ...rule, pattern: 'x{2,}' }], 'rule_pattern_unbounded'],
    [[{ ...rule, pattern: '(a)\\1' }], 'rule_pattern_unbounded'],
    [[{ ...rule, pattern: '^(a|aa){64}b$' }], 'rule_pattern_unbounded'],
    [[{ ...rule, pattern: '(a|a){1,64}b' }], 'rule_pattern_unbounded'],
    [[{ ...rule, pattern: 'a{0,64}a{0,64}a{0,64}b' }], 'rule_pattern_unbounded'],
    [[{ ...rule, pattern: 'a{65}' }], 'rule_pattern_unbounded'],
    [Array.from({ length: 4 }, (_, index) => ({ ...rule, id: `r${index}`, pattern: `${index}[^\\n]{0,64}implement` })), 'rule_pattern_unbounded: r3'],
    [[{ ...rule, pattern: 'a?' }], 'rule_pattern_ambiguous'],
    [[rule, { ...rule, id: 'again' }], 'rule_pattern_ambiguous'],
    [[{ ...rule, max_activations: 3 }], 'rule_max_activations_invalid'],
    [[{ ...rule, reminder: 'two\nlines' }], 'rule_reminder_invalid'],
  ]) assert.throws(() => session(rules)('turn_start'), new RegExp(error));
  assert.deepEqual(session([])('turn_start').registrations.events, []);
});

test('stops only completed matching items, once per rule, and restates activated rules', () => {
  const run = session([rule, { id: 'apology', pattern: 'as an ai', flags: 'i', reminder: 'Answer directly.', max_activations: 2 }]);
  run('start');
  run('turn_start', { turn_id: 'one' });
  assert.equal(stream(run, { kind: 'text', index: 0, item_id: 'm', text: 'TODO: implement', protected: false }), null);
  assert.equal(stream(run, item('TODO: implementation notes')), null);
  assert.equal(stream(run, item('As an AI, TODO: implement')), null);
  assert.equal(run('context', { thread_id: 'one' }).value, null);
  run('tool_result', { outcome: 'succeeded' });
  assert.deepEqual(stream(run, item('fn main() {}\n// TODO: implement\n')), { stop: { reason: 'reactive rule placeholder' },
    retry: { inject: 'Reactive rule placeholder: Write the implementation instead of a placeholder. Tool calls that completed earlier in this turn remain in effect; they were not undone.' } });
  assert.equal(stream(run, item('// TODO: implement')), null);
  assert.deepEqual(stream(run, item('As an AI model')).stop, { reason: 'reactive rule apology' });
  assert.equal(stream(run, item('As an AI model')), null, 'the per-turn stop bound lets the output stand');
  run('turn_start', { turn_id: 'two' });
  assert.equal(stream(run, item('// TODO: implement')).retry.inject, 'Reactive rule placeholder: Write the implementation instead of a placeholder.');
  const restated = 'Reactive rules activated earlier in this session:\n- placeholder: Write the implementation instead of a placeholder.\n- apology: Answer directly.';
  assert.equal(run('context', { thread_id: 'one' }).value.text, restated);
  run('resume', { thread_id: 'one', last_turn: null, restarted: true });
  assert.equal(run('context', { thread_id: 'one' }).value.text, restated);
  run('resume', { thread_id: 'other', last_turn: null, restarted: true });
  assert.equal(run('context', { thread_id: 'other' }).value, null);
});
