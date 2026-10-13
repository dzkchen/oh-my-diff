import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { emit, runScenario, state, text } from '@oh-my-diff/mod-api/testing';

const skip = !process.env.OMD_MOD_BIN && 'needs the omd-mod engine in OMD_MOD_BIN';
const directory = fileURLToPath(new URL('.', import.meta.url));
const thread = 'lead';
const usage = (tokens, window = 200_000) => emit('app_notification', {
  method: 'thread/tokenUsage/updated', thread_id: thread, coalesced: 0, dropped: 0,
  params: { threadId: thread, turnId: 't', tokenUsage: { total: { totalTokens: tokens }, last: { totalTokens: tokens }, modelContextWindow: window } },
});
const turn = (id, input) => [usage(input), emit('turn_end', { thread_id: thread })];
const draw = (columns = 100) => emit('terminal', { event: 'idle', ledger: { thread_id: thread }, client: { columns } });
const run = (...steps) => runScenario(directory, { steps }).steps.map(step => step.value);
const line = value => {
  const site = value[0].value?.sites?.above_composer;
  return site ? text(site.components) : null;
};

test('no band before the first finished turn, then one forecast line per turn', { skip }, () => {
  const values = run(draw(), usage(36_000), draw(), emit('turn_end', { thread_id: thread }), draw());
  assert.equal(line(values[0]), null);
  assert.equal(line(values[2]), null);
  assert.match(line(values[4]), /☀ {2}Clear {2}18% of context {2}36k \/ 200k {3}last turns █$/);
});

test('forecast bands, the 12-turn chart and the last-turn delta follow the readings', { skip }, () => {
  const inputs = [10_000, 20_000, 40_000, 60_000, 80_000, 90_000, 100_000, 110_000, 120_000, 130_000, 134_400, 150_000, 170_000, 185_000];
  const steps = inputs.flatMap((input, index) => [...turn(`r${index}`, input), draw()]);
  const lines = run(...steps).filter((_, index) => index % 3 === 2).map(line);
  assert.match(lines[2], /☀ {2}Clear {2}20%/);
  assert.match(lines[3], /☁ {2}Cloudy {2}30%/);
  assert.match(lines[10], /☂ {2}Showers {2}67% of context {2}134\.4k \/ 200k .* ▲ \+4\.4k last turn$/);
  assert.match(lines[11], /☇ {2}Storm {2}75%/);
  assert.match(lines[13], /↯ {2}Compact soon {2}93% of context {2}185k \/ 200k {3}last turns ([▁-█]{12}) {2}▲ \+15k last turn$/);
  const [, chart] = lines[13].match(/last turns (\S+)/);
  assert.equal(chart.length, 12);
  assert.equal(chart.at(-1), '█');
});

test('readings without a window are ignored, the history is capped and narrow terminals drop the chart', { skip }, () => {
  const steps = [];
  for (let index = 0; index < 15; index++) steps.push(...turn(`r${index}`, 40_000 + index * 1000));
  steps.push(usage(190_000, null), emit('turn_end', { thread_id: thread }));
  steps.push(draw(50), state('token_weather', { threadId: thread }));
  const values = run(...steps);
  assert.equal(line(values.at(-2)), '☁  Cloudy  27% of context  54k / 200k');
  assert.equal(values.at(-1).readings.length, 12);
});
