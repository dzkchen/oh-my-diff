import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { callback } from '../../../tests/mod_runner.mjs';

const dir = new URL('./', import.meta.url);
const read = name => readFileSync(new URL(name, dir), 'utf8');
const manifest = JSON.parse(read('mod.json'));
const source = read('index.ts');
const assets = Object.fromEntries(manifest.assets.map(name => [name, { text: read(name), sha256: '0'.repeat(64) }]));
const NOW = 1_800_000_000_000;
const GIT = '/repo/.git/worktrees/line\n/repo/.git\n/work/line\n@@\ngit@github.com:dzkchen/oh-my-diff.git\n@@\n 3 files changed, 12 insertions(+), 4 deletions(-)\n@@\n'
  + ['# branch.oid 0123456789abcdef', '# branch.head feat/line', '# branch.ab +2 -1', '1 M. N... 100644 100644 100644 a b src/a.ts', '1 .M N... 100644 100644 100644 a b src/b.ts',
    '2 R. N... 100644 100644 100644 a b R100 new.ts', 'old.ts', '? scratch.txt', ''].join('\0');

const host = (overrides = {}) => ({ operation, arguments: args }) => {
  if (operation in overrides) return overrides[operation](args);
  if (operation === 'session.info') return { thread_id: 'lead', root: '/repo', cwd: '/repo', codex_version: '0.166.0', model: 'gpt-6.1-sol', provider: 'openai', route: null, turns_started: 0 };
  if (operation === 'app.request' && args.method === 'config/read') return { config: { model_reasoning_effort: 'high', model_context_window: 272_000 } };
  if (operation === 'app.request' && args.method === 'account/read') return { account: null, requiresOpenaiAuth: true };
  if (operation === 'app.request' && args.method === 'model/list') return { data: [], nextCursor: null };
  if (operation === 'app.request' && args.method === 'account/rateLimits/read') {
    return { rateLimits: { primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: (NOW + 7_200_000) / 1000 }, secondary: { usedPercent: 93, windowDurationMins: 10_080, resetsAt: (NOW + 86_400_000) / 1000 } } };
  }
  if (operation === 'exec.run') return { exit_code: 0, timed_out: false, stdout: GIT, stderr: '' };
  if (operation === 'credentials.list') return [];
  if (['events.publish', 'events.schedule', 'events.cancel'].includes(operation)) return { delivered: 1, dropped: 0 };
  if (operation === 'settings.write') return { settings: args.values };
  assert.fail(`unexpected host call ${operation}`);
};

const request = input => ({ source, filename: fileURLToPath(new URL('index.ts', dir)), entrypoint: 'index.ts', assets, api: manifest.api,
  capabilities: manifest.capabilities, settings: {}, state: null, virtual_time_ms: NOW, hook_budget_ms: 10_000, ...input });
function call(input, answer = host()) {
  const calls = [];
  const output = callback(request(input), operation => {
    calls.push(operation);
    return answer(operation);
  });
  assert.equal(output.error, undefined, output.error);
  return { ...output, calls, ui: output.ui_state === undefined ? null : JSON.parse(output.ui_state) };
}
const feed = (state, events, answer) => events.reduce((current, [event, payload, extra = {}]) => call({ event, payload, state: current, ...extra }, answer).state, state);
const response = (id, patch = {}) => ({
  request_id: id, attempt: 1, ledger_request: null, scope: { thread_id: 'lead', agent_id: null, kind: 'main' }, route: 'session', provider: 'openai', credential: 'chatgpt',
  requested_model: 'gpt-6.1-sol', served_model: 'gpt-6.1-sol', status: 'completed', stop_reason: 'end_turn', output: { text: '', tool_calls: [] },
  usage: { input_tokens: 100_000, input_tokens_details: { cached_tokens: 80_000 }, output_tokens: 2_000, output_tokens_details: { reasoning_tokens: 500 } },
  cache: { read_tokens: 80_000, write_tokens: null }, cost: { microusd: 1_250_000, basis: 'settled' }, context_window: 272_000,
  timing: { started_at_ms: NOW - 60_000, first_event_ms: 200, duration_ms: 1_000 }, synthetic: null, error: null, ...patch,
});
const view = (state, settings = {}, extra = {}) => call({ event: 'terminal', payload: { event: 'idle', ledger: { thread_id: 'lead', cwd: '/repo', cost: null }, client: { kind: 'terminal', columns: 160, rows: 40 }, ...extra }, state, settings }).value;
const rows = patch => Object.values(patch.sites).flatMap(site => site.components).flatMap(item => item.id === 'omd_statusline' ? item.children : [item]).filter(item => item.type === 'line');
const lines = patch => rows(patch).map(item => item.spans.map(span => span.text).join(''));
const settled = (answer = host()) => {
  const start = call({ event: 'start', payload: {} }, answer);
  assert.ok(!start.calls.some(item => item.operation === 'exec.run' || item.operation === 'http.request' || item.arguments?.method === 'account/rateLimits/read'), 'start runs no subprocess or network work');
  return call({ event: 'timer', payload: { key: 'time:settle' }, state: start.state }, answer).state;
};
const started = () => settled();

test('cost follows the ledger basis: included on the ChatGPT plan, unknown when unpriced', () => {
  const settings = { preset: 'custom', layout: 'provider cost' };
  const plan = host({ 'app.request': args => args.method === 'config/read' ? { config: {} } : { rateLimits: { planType: 'plus' } } });
  const included = [['model_response', response('r1', { cost: { microusd: 0, basis: 'included_subscription' } })]];
  const unpriced = [['model_response', response('r1', { cost: { microusd: null, basis: 'unpriced' } })]];
  assert.match(lines(view(feed(started(), included), settings))[0], /included/);
  assert.match(lines(view(feed(settled(plan), unpriced), settings))[0], /unknown/, 'a plan type does not make an unpriced request included');
});

test('user scripts get session JSON on stdin and only safe styled text reaches the view', () => {
  const settings = { preset: 'custom', layout: 'model script:weather', scripts: JSON.stringify([{ id: 'weather', command: ['sh', 'weather.sh'], interval_s: 60, timeout_ms: 800 }]) };
  const runs = [];
  const run = stdout => args => {
    if (args.program !== 'sh' || args.argv[0] !== 'weather.sh') return { exit_code: 0, timed_out: false, stdout: GIT, stderr: '' };
    runs.push(args);
    return typeof stdout === 'function' ? stdout() : { exit_code: 0, timed_out: false, stdout, stderr: '' };
  };
  const padded = '\x1b[0m'.repeat(1024) + 'late\x1b[31mred';
  const hostile = '\x1b[31mrain\x1b[0m \x1b]8;;https://example.com/w\x07forecast\x1b]8;;\x07 \x1b]8;;javascript:alert(1)\x07bad\x1b]8;;\x07\x1b[2J\x1b]0;title\x07\u202Eevil\n2nd line';
  const state = feed(started(), [['model_response', response('r1')]]);
  const viewed = call({ event: 'terminal', payload: { event: 'idle', ledger: { thread_id: 'lead' }, client: { kind: 'terminal', columns: 90, rows: 30 } }, state, settings }).state;
  const done = call({ event: 'timer', payload: { key: 'time:script_weather' }, state: viewed, settings }, host({ 'exec.run': run(hostile) })).state;
  const stdin = JSON.parse(runs[0].stdin);
  assert.deepEqual([runs[0].timeout_ms, stdin.schema, stdin.viewport, stdin.model.served, stdin.context.used, stdin.git.branch], [800, 1, { columns: 90, rows: 30 }, 'gpt-6.1-sol', 102_000, 'feat/line']);
  const spans = rows(view(done, settings))[0].spans;
  assert.deepEqual(spans.slice(-4), [{ text: 'rain', tone: 'failure' }, { text: ' ' }, { text: 'forecast', link: 'https://example.com/w' }, { text: ' badevil' }]);
  assert.equal(spans.map(span => span.text).join(''), 'gpt-6.1-sol · rain forecast badevil');
  assert.ok(spans.every(span => !span.link || span.link.startsWith('https://')));
  const late = call({ event: 'timer', payload: { key: 'time:script_weather' }, state: viewed, settings }, host({ 'exec.run': run(padded) })).state;
  assert.doesNotMatch(lines(view(late, settings))[0] ?? '', /\[/, 'escape sequences past the scanned prefix never reach the line');
  const timedOut = call({ event: 'timer', payload: { key: 'time:script_weather' }, state: viewed, settings }, host({ 'exec.run': run(() => ({ exit_code: null, timed_out: true, stdout: '', stderr: '' })) })).state;
  assert.match(lines(view(timedOut, settings))[0], /timed out/);
  const edited = { ...settings, scripts: JSON.stringify([{ id: 'weather', command: ['sh', 'other.sh'] }]) };
  assert.doesNotMatch(lines(view(done, edited))[0], /rain/);
  assert.match(lines(view(started(), { scripts: 'not json', preset: 'custom', layout: 'model' }))[0] ?? '', /^gpt-6\.1-sol$/);
});

test('a panel action after the UI state was cleared edits the saved settings and clips long text values', () => {
  const settings = { preset: 'custom', layout: 'model git', thresholds: `context=${'7'.repeat(2040)}` };
  const edited = call({ event: 'command', name: 'edit', payload: 'panel glyphs ascii', ui_state: null, settings }, host({ 'terminal.panel': () => ({ shown: true }) }));
  assert.deepEqual([edited.ui.draft.layout, edited.ui.draft.glyphs], ['model git', 'ascii']);
  const panel = edited.calls.findLast(item => item.operation === 'terminal.panel').arguments;
  assert.equal(panel.items.find(item => item.id === 'thresholds').value.length, 2000);
});

test('profile, tier and workspace segments follow the config layers, thread settings and account', () => {
  const settings = { preset: 'custom', layout: 'model tier profile workspace' };
  const answer = tier => host({ 'app.request': args => args.method === 'config/read'
    ? { config: { service_tier: tier }, layers: [{ name: { type: 'user', file: '/home/.codex/work.toml', profile: 'work' } }, { name: { type: 'user', file: '/home/.codex/config.toml', profile: null } }] }
    : args.method === 'model/list' ? { data: [{ model: 'gpt-6.1-sol', defaultServiceTier: 'priority', serviceTiers: [{ id: 'priority', name: 'Fast' }] }], nextCursor: null }
      : args.method === 'account/read' ? { account: { type: 'chatgpt', email: null, planType: 'plus', workspaceName: 'Acme' }, requiresOpenaiAuth: true }
        : { rateLimits: {} } });
  const text = state => lines(view(state, settings))[0];
  assert.equal(text(settled(answer('priority'))), 'gpt-6.1-sol · Fast · profile: work · workspace: Acme');
  assert.equal(text(settled(answer('flex'))), 'gpt-6.1-sol · Flex · profile: work · workspace: Acme', 'Flex needs no catalog entry');
  assert.equal(text(settled(answer('turbo'))), 'gpt-6.1-sol · profile: work · workspace: Acme', 'an unknown tier shows nothing');
  assert.equal(text(settled(answer(null))), 'gpt-6.1-sol · Fast · profile: work · workspace: Acme', 'no configured tier takes the catalog default');
  const notify = (state, threadSettings) => call({ event: 'app_notification', payload: { method: 'thread/settings/updated', params: { threadSettings }, thread_id: 'lead', coalesced: 0, dropped: 0 }, state }, answer('priority')).state;
  assert.equal(text(notify(settled(answer('priority')), { serviceTier: null })), 'gpt-6.1-sol · profile: work · workspace: Acme');
});
