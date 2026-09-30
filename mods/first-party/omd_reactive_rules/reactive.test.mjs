import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const surface = { events: { start: 'lifecycle', resume: 'lifecycle', turn_start: 'lifecycle', tool_result: 'lifecycle', context: 'context' }, replacements: [], middleware: ['response_stream'], state: 'store', contracts: 'contracts' };
const rule = { id: 'placeholder', pattern: '\\bTODO: implement\\b', reminder: 'Write the implementation instead of a placeholder.' };

function session(rules) {
  let state = null;
  return (event, payload = {}) => {
    const request = { source, filename: 'omd_reactive_rules.ts', api: '0.2.0-experimental.5', capabilities: ['context', 'lifecycle', 'middleware', 'store'],
      state, settings: { rules }, event, payload, surface, hook_budget_ms: 2000 };
    const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '--eval', runner], { input: JSON.stringify(request), encoding: 'utf8', timeout: 5000 });
    const output = JSON.parse(result.stdout);
    if (output.error) throw new Error(output.error);
    state = output.state;
    return output;
  };
}
const item = text => ({ kind: 'response.output_item.done', text, boundary: true, protected: true });

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
  assert.equal(run('response_stream', { kind: 'response.output_text.delta', text: 'TODO: implement', boundary: false, protected: false }).value, null);
  assert.equal(run('response_stream', item('TODO: implementation notes')).value, null);
  assert.equal(run('response_stream', item('As an AI, TODO: implement')).value, null);
  assert.equal(run('context', { thread_id: 'one' }).value, null);
  run('tool_result', { outcome: 'succeeded' });
  assert.deepEqual(run('response_stream', item('fn main() {}\n// TODO: implement\n')).value, { stop: { reason: 'reactive rule placeholder' },
    retry: { inject: 'Reactive rule placeholder: Write the implementation instead of a placeholder. Tool calls that completed earlier in this turn remain in effect; they were not undone.' } });
  assert.equal(run('response_stream', item('// TODO: implement')).value, null);
  assert.deepEqual(run('response_stream', item('As an AI model')).value.stop, { reason: 'reactive rule apology' });
  assert.equal(run('response_stream', item('As an AI model')).value, null, 'the per-turn stop bound lets the output stand');
  run('turn_start', { turn_id: 'two' });
  assert.equal(run('response_stream', item('// TODO: implement')).value.retry.inject, 'Reactive rule placeholder: Write the implementation instead of a placeholder.');
  const restated = 'Reactive rules activated earlier in this session:\n- placeholder: Write the implementation instead of a placeholder.\n- apology: Answer directly.';
  assert.equal(run('context', { thread_id: 'one' }).value.text, restated);
  run('resume', { thread_id: 'one', last_turn: null, restarted: true });
  assert.equal(run('context', { thread_id: 'one' }).value.text, restated);
  run('resume', { thread_id: 'other', last_turn: null, restarted: true });
  assert.equal(run('context', { thread_id: 'other' }).value, null);
});
