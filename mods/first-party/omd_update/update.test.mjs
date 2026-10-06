import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runnerSync } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const surface = { events: { start: 'lifecycle', resume: 'lifecycle', terminal: 'terminal', component_event: 'terminal' }, replacements: [], middleware: [], state: 'store', contracts: 'contracts' };
const settings = { checks: 'on', auto: 'off', channel: 'stable', cadence: 'daily', pin: '' };
const DAY = 86_400_000;

function run(input, host) {
  const receipts = [];
  for (;;) {
    const request = { source, filename: 'index.ts', api: '0.2.0-experimental.5', capabilities: ['commands', 'exec', 'lifecycle', 'store', 'terminal'],
      settings, state: null, surface, hook_budget_ms: 2000, receipts, virtual_time_ms: 1_000_000, ...input };
    const output = JSON.parse(runnerSync(request).stdout);
    if (output.error) throw new Error(output.error);
    if (!output.host_call) return output;
    receipts.push({ call: output.host_call, value: host(output.host_call) });
  }
}

const release = { version: '0.2.0', prerelease: false, notes: 'Faster startup.\nNew /update screen.', page: 'https://github.com/dzkchen/oh-my-diff/releases/tag/v0.2.0',
  user_mods: ['my_mod'], manifest: { mod_api: '0.3.0' } };
const environment = info => ({ exit_code: 0, stdout: `PATH=/usr/bin\nOH_MY_DIFF_UPDATE=${JSON.stringify(info)}\nTERM=dumb\n` });

function session(info, state, calls = [], time = 1_000_000, event = 'start') {
  const host = call => {
    calls.push(call);
    if (call.operation === 'exec.run') return environment(info);
    if (call.operation === 'store.get') return { value: { id: '0.2.0#1', version: '0.2.0' }, revision: 3 };
    return { deleted: true };
  };
  return run({ event, payload: null, state, virtual_time_ms: time }, host).state;
}
const show = (state, surface = 'fullscreen') => {
  const output = run({ event: 'terminal', state, payload: { event: 'startup', ledger: null, presentation: { thread_id: null, phase: 'fresh', surface } } }, () => { throw new Error('no host'); });
  return [output.value?.sites?.welcome?.components.slice(1).map(component => component.text) ?? [], output.state ?? state];
};
const welcome = state => show(state)[0];

test('a fresh session announces a newer release once a day until it is snoozed or skipped', () => {
  const info = { installed: '0.1.0', checked_at: 900, available: release, error: null };
  let state = session(info, null);
  assert.equal(run({ event: 'terminal', state, payload: { event: 'idle', ledger: null, presentation: { thread_id: 't', phase: 'resumed' } } }).value, null);
  let texts;
  [texts, state] = show(state);
  assert.deepEqual(texts, ['Oh My Diff 0.2.0 is out; you have 0.1.0. Run omd update\nin a shell, or /update for the notes.']);
  state = session(info, state, [], 1_000_000 + DAY / 2);
  assert.deepEqual(welcome(state), []);
  state = session(info, state, [], 1_000_000 + DAY + 1);
  assert.equal(welcome(state).length, 1);

  const command = (payload, current, host = () => { throw new Error('no host'); }) => run({ event: 'command', name: 'update', payload, state: current }, host).state;
  state = command('later', state);
  assert.equal(state.snoozed.version, '0.2.0');
  assert.deepEqual(welcome(session(info, state, [], 1_000_000 + 3 * DAY)), []);
  state = command('skip', session(info, state, [], 1_000_000 + 9 * DAY));
  assert.deepEqual(welcome(session(info, state, [], 1_000_000 + 20 * DAY)), []);
  assert.deepEqual(welcome(session({ ...info, available: { ...release, version: '0.3.0' } }, state, [], 1_000_000 + 20 * DAY)).length, 1);
  assert.deepEqual(welcome(session(info, state, [], 1_000_000 + 30 * DAY)), []);
  const off = run({ event: 'start', payload: null, state: null, settings: { ...settings, checks: 'off' } }, call => call.operation === 'exec.run' ? environment(info) : null).state;
  assert.deepEqual(welcome(off), []);
});

test('update results are announced once and a handled request is cleared', () => {
  const calls = [];
  const info = { installed: '0.2.0', checked_at: 950, available: null, last: { from: '0.1.0', to: '0.2.0', at: 960 }, request_done: '0.2.0#1' };
  let state = session(info, null, calls, 1_000_000, 'resume');
  assert.deepEqual(calls.find(call => call.operation === 'store.delete').arguments, { key: 'request', expected_revision: 3, scope: 'user' });
  let texts;
  [texts, state] = show(session(info, state), 'inline');
  assert.deepEqual(texts, []);
  [texts, state] = show(session(info, state));
  assert.deepEqual(texts, ['Oh My Diff was updated from 0.1.0 to 0.2.0.']);
  state = session(info, state);
  assert.deepEqual(welcome(state), []);
  state = session({ ...info, failed: { version: '0.3.0', error: 'SHA-256 mismatch', at: 970 } }, state);
  assert.deepEqual(welcome(state), ['The update to Oh My Diff 0.3.0 failed and nothing\nchanged. /update shows why.']);
});

test('/update shows the command, notes and incompatible mods, queues the next start and writes settings', () => {
  const calls = [];
  const host = call => {
    calls.push(call);
    if (call.operation === 'store.get') return null;
    if (call.operation === 'store.put') return { revision: 1 };
    return { settings: call.arguments.values };
  };
  const command = (payload, current) => run({ event: 'command', name: 'update', payload, state: current }, host).state;
  const view = current => run({ event: 'terminal', state: current, payload: { event: 'idle', ledger: null } }).value.sites.dialog.components[1].children;
  let state = session({ installed: '0.1.0', checked_at: 900, available: release }, null);
  state = command('', state);
  const children = view(state);
  assert.deepEqual(children.find(child => child.type === 'code'), { type: 'code', id: 'omd_update_command', label: 'Update command', text: 'omd update', language: 'sh' });
  assert.match(children.find(child => child.id === 'omd_update_notes').text, /^Faster startup\.\nNew \/update screen\.$/);
  assert.match(children.find(child => child.id === 'omd_update_user_mods').text, /my_mod/);
  assert.ok(children.some(child => child.id === 'omd_update_request'));

  state = command('request', state);
  assert.deepEqual(calls.find(call => call.operation === 'store.put').arguments,
    { key: 'request', value: { id: '0.2.0#1', version: '0.2.0' }, expected_revision: null, scope: 'user' });
  assert.match(state.notice, /installs the next time OMD starts/);

  state = command('auto on', state);
  assert.deepEqual(calls.find(call => call.operation === 'settings.write').arguments, { values: { auto: 'on' } });
  assert.ok(view(state).some(child => child.id === 'omd_update_auto_off'));
  const resumed = run({ event: 'resume', payload: null, state }, call => call.operation === 'exec.run' ? environment({ installed: '0.1.0', available: release }) : null).state;
  assert.deepEqual(resumed.overrides, { auto: 'on' });
  assert.ok(view(command('', resumed)).some(child => child.id === 'omd_update_auto_off'));
  const quiet = run({ event: 'resume', payload: null, state: command('checks off', resumed) }, call => call.operation === 'exec.run' ? environment({ installed: '0.1.0', available: release }) : null).state;
  assert.deepEqual(quiet.banner, []);
  assert.deepEqual(run({ event: 'start', payload: null, state: quiet, settings: { ...settings, auto: 'on', checks: 'off' } },
    call => call.operation === 'exec.run' ? environment({ installed: '0.1.0', available: release }) : null).state.overrides, {});
  state = command('channel nightly', state);
  assert.equal(state.notice, 'channel takes stable or beta');
  assert.equal(calls.filter(call => call.operation === 'settings.write').length, 2);
  assert.equal(command('close', state).open, false);

  const pending = command('', session({ installed: '0.1.0', checked_at: 900, available: release, pending: { version: '0.2.0' } }, null));
  assert.ok(!view(pending).some(child => child.id === 'omd_update_request'));
  const held = command('', session({ installed: '0.1.0', checked_at: 900, available: release, held: { version: '0.2.0' } }, null));
  assert.match(view(held).find(child => child.id === 'omd_update_held').text, /rolled back from 0\.2\.0; automatic updates skip it/);
  const unmanaged = command('', run({ event: 'start', payload: null, state: null }, call => call.operation === 'exec.run' ? { exit_code: 0, stdout: 'PATH=/usr/bin\n' } : null).state);
  assert.match(view(unmanaged).find(child => child.id === 'omd_update_unmanaged').text, /not installed by the OMD installer/);
});
