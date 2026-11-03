import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runner, runnerSync, surface } from './mod_runner.mjs';

test('session activation keeps variables while refreshing event, state and clock', () => {
  const request = {
    source: `let count = 0;
      export default api => {
        api.command('count', () => ({count: ++count, state: api.state.get(), now: Date.now()}));
        api.on('timer', ({data}) => { api.state.set(data); });
      };`,
    filename: '/fixture/session/index.ts', entrypoint: 'index.ts',
    api: '1.0.0', capabilities: ['commands', 'store', 'events'],
    surface: {events: {timer: 'events'}, replacements: [], middleware: [], state: 'store', contracts: 'contracts'},
    state: null, settings: {}, event: 'command', name: 'count',
    interactive: true, serve: true, session_activation: true, hook_budget_ms: 1000,
    virtual_time_ms: 10, payload: null,
  };
  const input = [request,
    {...request, state: {fresh: true}, virtual_time_ms: 20},
    {...request, event: 'timer', payload: {key: 'k', data: {from_timer: true}}},
  ].map(value => JSON.stringify(value)).join('\n') + '\n';
  const result = spawnSync(runner, [], {input, encoding: 'utf8', timeout: 10000});
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const frames = result.stdout.trim().split('\n').map(line => JSON.parse(line)).filter(value => !value.ready);
  assert.equal(frames.length, 3, result.stdout);
  assert.deepEqual(frames[0].value, {count: 1, state: null, now: 10});
  assert.deepEqual(frames[1].value, {count: 2, state: {fresh: true}, now: 20});
  assert.deepEqual(frames[2].state, {from_timer: true});
});


test('background jobs require session lifetime and thread-scoped state', () => {
  const request = {
    source: "export default api => { api.background('refresh', input => input); };",
    filename: '/fixture/jobs/index.ts', entrypoint: 'index.ts', api: '1.0.0',
    capabilities: ['store', 'events'], surface, event: 'inspect', state: null, settings: {},
    session_model: true, state_scope: 'thread',
  };
  const valid = runnerSync(request);
  assert.equal(valid.error, undefined);
  assert.ok(valid.registrations.events.includes('timer'));
  assert.match(runnerSync({...request, session_model: false}).error, /background_requires_session_activation/);
  assert.match(runnerSync({...request, state_scope: 'store'}).error, /background_requires_thread_state/);
});
