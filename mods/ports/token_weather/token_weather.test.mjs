import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callback } from '../../../tests/mod_runner.mjs';

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./mod.json', import.meta.url), 'utf8'));

function session() {
  const box = { state: null };
  const run = (event, payload) => {
    const output = callback({ source, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, settings: {}, state: box.state, event, payload },
      call => assert.fail(`unexpected host call ${call.operation}`));
    assert.equal(output.error, undefined, output.error);
    box.state = output.state ?? box.state;
    return output.value;
  };
  const notify = (params, method = 'thread/tokenUsage/updated') => run('app_notification', { method, params });
  const usage = (inputTokens, modelContextWindow = 200_000) => notify({ tokenUsage: { last: { inputTokens }, modelContextWindow } });
  const turn = (inputTokens, modelContextWindow) => (usage(inputTokens, modelContextWindow), run('turn_end', { turn_id: 't', outcome: 'completed' }));
  const band = columns => run('terminal', { client: { columns } });
  return { box, notify, usage, turn, band };
}
const spans = view => view.sites.above_composer.components[1].children[0].spans;
const text = view => spans(view).map(span => span.text).join('');

test('nothing shows until a turn ends, and a reading counts only once its turn has ended', () => {
  const s = session();
  assert.equal(s.band(100), null);
  s.usage(50_000);
  assert.equal(s.band(100), null);
  s.turn(50_000);
  assert.match(text(s.band(100)), /Cloudy {2}25% of context/);
});

test('the forecast word follows the share of the window and the chart shows the turn-to-turn change', () => {
  const s = session();
  s.turn(40_000);
  assert.match(text(s.band(100)), /Clear {2}20% of context {2}40k \/ 200k/);
  s.turn(120_000);
  const wide = text(s.band(100));
  assert.match(wide, /Showers {2}60% of context/);
  assert.match(wide, /last turns ▃█ {2}▲ \+80k last turn/);
  s.turn(190_000);
  assert.match(text(s.band(100)), /Compact soon {2}95% of context/);
  s.turn(190_000);
  assert.match(text(s.band(100)), /steady/);
  assert.doesNotMatch(text(s.band(59)), /last turns/);
});

test('notifications for other methods, an empty window or a missing count leave the readings alone', () => {
  const s = session();
  s.turn(100_000);
  const readings = JSON.stringify(s.box.state.readings);
  s.usage(10, 0);
  s.notify({ tokenUsage: { last: {}, modelContextWindow: 100 } });
  s.notify({ tokenUsage: { last: { inputTokens: 10 }, modelContextWindow: 100 } }, 'account/rateLimits/updated');
  assert.equal(s.box.state.pending, null);
  assert.equal(JSON.stringify(s.box.state.readings), readings);
});

test('only the latest twelve turns are kept', () => {
  const s = session();
  for (let index = 1; index <= 14; index += 1) s.turn(index * 1000);
  assert.deepEqual(s.box.state.readings.map(reading => reading.tokens), Array.from({ length: 12 }, (_, index) => (index + 3) * 1000));
});
