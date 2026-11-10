import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));

const refuse = message => { throw new Error(message); };

function session({ lifetime = 0, putFails = 0, limits = null } = {}) {
  const box = { state: null, uiState: null, stored: { value: lifetime, revision: 'r0' }, putFails, notices: [], puts: [] };
  const host = ({ operation, arguments: args }) => {
    if (operation === 'terminal.notice') return box.notices.push(args), { shown: true };
    if (operation === 'store.get') return box.stored;
    if (operation === 'store.put') {
      box.puts.push(args);
      if (box.putFails > 0) { box.putFails -= 1; refuse('revision_conflict'); }
      box.stored = { value: args.value, revision: `r${box.puts.length}` };
      return { revision: box.stored.revision };
    }
    if (operation === 'app.request') return limits ?? refuse('rate_limits_unavailable');
    assert.fail(`unexpected host call ${operation}`);
  };
  const run = (event, payload, name) => {
    const output = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, settings: {}, state: box.state, ui_state: box.uiState, event, name, payload }, host);
    assert.equal(output.error, undefined, output.error);
    box.state = output.state ?? box.state;
    return output.value;
  };
  const response = (request_id, microusd, basis = 'settled', extra = {}) => run('model_response', { request_id, attempt: 1, synthetic: false, cost: { microusd, basis }, ...extra });
  return { box, run, response };
}

test('only settled or provider-reported costs are priced; included and unpriced responses are counted apart', () => {
  const s = session();
  s.response('a', 2_000_000, 'provider_reported');
  s.response('b', null, 'included_subscription');
  s.response('c', 5_000_000, 'estimated');
  s.response('d', null, 'unknown');
  assert.deepEqual(s.box.state.spend, { micro: 2_000_000, priced: 1, included: 1, unknown: 2 });
  assert.equal(s.run('command', 'lifetime', 'burn').display, 'Lifetime burn: $2.00 = 0.18 burritos.');
});

test('a retried delivery, a synthetic response and an earlier attempt of the same request are counted once', () => {
  const s = session();
  s.response('a', 1_000_000);
  s.response('a', 1_000_000);
  s.response('s', 9_000_000, 'settled', { synthetic: true });
  s.run('model_response', { request_id: 'a', attempt: 2, synthetic: false, cost: { microusd: 500_000, basis: 'settled' } });
  assert.equal(s.box.state.spend.micro, 1_500_000);
  assert.deepEqual(s.box.state.seen, ['a#1', 'a#2']);
});

test('each spend threshold toasts once, a jump over several toasts the highest, and the lifetime total is saved', () => {
  const s = session({ lifetime: 100 });
  s.response('a', 600_000);
  assert.deepEqual(s.box.notices, []);
  s.response('b', 600_000);
  s.response('c', 100_000);
  s.response('d', 6_000_000);
  assert.deepEqual(s.box.notices.map(notice => notice.text.split(' burned')[0]), ['$1.00', '$5.00']);
  assert.equal(s.box.state.lifetime, 100 + 600_000 + 600_000 + 100_000 + 6_000_000);
  assert.deepEqual(s.box.state.fired, [1, 5]);
});

test('the lifetime total retries once after a lost revision race and is skipped, not guessed, when the store fails twice', () => {
  const retried = session({ lifetime: 10, putFails: 1 });
  retried.response('a', 200_000);
  assert.deepEqual(retried.box.puts.map(put => put.value), [200_010, 200_010]);
  assert.equal(retried.box.state.lifetime, 200_010);
  const lost = session({ lifetime: 10, putFails: 2 });
  lost.response('a', 200_000);
  assert.equal(lost.box.state.lifetime, 0);
  assert.equal(lost.box.state.spend.micro, 200_000);
});

test('a finished turn records what it spent, flags unpriced turns and reads the plan limits', () => {
  const s = session({ limits: { rateLimits: { secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 2_000_000_000 }, primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: null } } } });
  s.run('turn_start', { turn_id: 't1' });
  s.response('a', 300_000);
  s.run('turn_end', { turn_id: 't1', outcome: 'completed' });
  s.run('turn_start', { turn_id: 't2' });
  s.response('b', null, 'unknown');
  s.run('turn_end', { turn_id: 't2', outcome: 'completed' });
  assert.deepEqual(s.box.state.turns, [{ usd: 0.3, note: '' }, { usd: 0, note: 'unknown' }]);
  assert.deepEqual(s.box.state.limits.map(limit => [limit.name, limit.used, limit.resets]), [['5h', 42, null], ['wk', 10, 2_000_000_000_000]]);
});

test('/burn summarizes the session, and hide and show toggle the band without a message when quiet', () => {
  const s = session();
  assert.equal(s.run('command', '', 'burn').display, 'This session: no model turns yet. 5h --, week --. Lifetime: $0.00.');
  s.response('a', 4_000_000, 'settled');
  assert.match(s.run('command', 'panel', 'burn').display, /^This session: \$4\.00 = 0\.36 burritos\. 5h --, week --\. Lifetime: \$4\.00\.\nModels: model 0 in 0 out$/);
  const band = () => s.run('terminal', { client: { columns: 100 } }).sites.above_composer;
  assert.equal(band().components[1].id, 'burn_band');
  assert.equal(s.run('command', 'hide quiet', 'burn'), null);
  assert.equal(s.run('terminal', { client: { columns: 100 } }).sites.above_composer, undefined);
  assert.match(s.run('command', 'hide', 'burn').display, /hidden/);
  assert.equal(s.run('command', 'show quiet', 'burn'), null);
  assert.ok(band());
});
