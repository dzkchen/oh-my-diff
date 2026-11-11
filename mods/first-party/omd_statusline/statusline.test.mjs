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
  if (operation === 'session.info') return { thread_id: 'lead', root: '/repo', cwd: '/repo', codex_version: '0.167.0', model: 'gpt-6.1-sol', provider: 'openai', route: null, turns_started: 0 };
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
  return call({ event: 'timer', payload: { key: 'due' }, state: start.state, virtual_time_ms: NOW + 2000 }, answer).state;
};
const fire = (state, job, extra = {}, answer = host()) => call({ event: 'timer', payload: { key: 'due' }, state: { ...state, due: { ...state.due, [job]: NOW } }, ...extra }, answer);
const started = () => settled();

test('child tool results do not schedule refreshes without a session', () => {
  const state = started();
  const denied = host({ 'events.schedule': () => { throw new Error('host_operation_unavailable: no session'); } });
  const child = call({ event: 'tool_call', payload: { call_id: 'child-exec', agent_id: 'child', tool: 'exec_command', arguments: {} }, state }, denied);
  assert.deepEqual(child.state.tools, {});
  for (const scope of [{ agent_id: 'child', thread_id: 'child-thread' }, { agent_id: null, thread_id: 'other-thread' }]) {
    const done = call({ event: 'tool_result', payload: { call_id: 'child-exec', tool: 'exec_command', ...scope }, state }, denied);
    assert.ok(!done.calls.some(item => item.operation === 'events.schedule'));
  }
  const plan = call({ event: 'app_notification', payload: { method: 'turn/plan/updated', thread_id: 'lead', params: { plan: [{ step: 'Goal work', status: 'inProgress' }] } }, state }, denied);
  assert.deepEqual(plan.state.plan, { done: 0, total: 1, step: 'Goal work' });
  assert.deepEqual(plan.calls, []);
  const lead = call({ event: 'tool_result', payload: { call_id: 'lead-exec', tool: 'exec_command', agent_id: null, thread_id: 'lead' }, state });
  assert.ok(lead.calls.some(item => item.operation === 'events.schedule' && item.arguments.key === 'due' && item.arguments.delay_ms === 2000));
});

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
  const done = fire(viewed, 'script:weather', { settings }, host({ 'exec.run': run(hostile) })).state;
  const stdin = JSON.parse(runs[0].stdin);
  assert.deepEqual([runs[0].timeout_ms, stdin.schema, stdin.viewport, stdin.model.served, stdin.context.used, stdin.git.branch], [800, 1, { columns: 90, rows: 30 }, 'gpt-6.1-sol', 102_000, 'feat/line']);
  const spans = rows(view(done, settings))[0].spans;
  assert.deepEqual(spans.slice(-4), [{ text: 'rain', tone: 'failure' }, { text: ' ' }, { text: 'forecast', link: 'https://example.com/w' }, { text: ' badevil' }]);
  assert.equal(spans.map(span => span.text).join(''), 'gpt-6.1-sol · rain forecast badevil');
  assert.ok(spans.every(span => !span.link || span.link.startsWith('https://')));
  const late = fire(viewed, 'script:weather', { settings }, host({ 'exec.run': run(padded) })).state;
  assert.doesNotMatch(lines(view(late, settings))[0] ?? '', /\[/, 'escape sequences past the scanned prefix never reach the line');
  const timedOut = fire(viewed, 'script:weather', { settings }, host({ 'exec.run': run(() => ({ exit_code: null, timed_out: true, stdout: '', stderr: '' })) })).state;
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

test('/statusline github says when the layout or setting keeps pull request and CI hidden', () => {
  const answer = host({ 'credentials.request': () => ({ status: 'completed' }) });
  const saved = settings => call({ event: 'command', name: 'edit', payload: 'github', settings }, answer).value.display;
  assert.match(saved({}), /saved.*no pr or ci segment.*detailed preset/);
  assert.match(saved({ preset: 'detailed' }), /refresh now\.$/);
  assert.match(saved({ preset: 'custom', layout: 'model pr' }), /refresh now\.$/);
  assert.match(saved({ preset: 'detailed', github: false }), /setting is off.*\/mods/);
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

test('usage resets are refreshed while idle and empty snapshots clear old limits', () => {
  const start = call({ event: 'start', payload: null });
  const before = call({ event: 'timer', payload: { key: 'due' }, state: start.state, virtual_time_ms: NOW + 2000 }).state;
  assert.equal(before.limits[0].used, 42);
  const reset = host({ 'app.request': () => ({ rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: (NOW + 18_000_000) / 1000 } } }) });
  const after = fire(before, 'limits', { virtual_time_ms: NOW + 60_000 }, reset).state;
  assert.equal(after.limits[0].used, 0);
  const empty = fire(after, 'limits', {}, host({ 'app.request': () => ({ rateLimits: {} }) })).state;
  assert.deepEqual(empty.limits, []);
});

test('turn_end forgets tools still marked running and schedules a refresh', () => {
  const state = { ...started(), tools: { 'exec-1': NOW - 5_000, 'exec-2': NOW - 1_000 } };
  const ended = call({ event: 'turn_end', payload: { turn_id: 't1' }, state });
  assert.deepEqual(ended.state.tools, {});
  assert.ok(ended.calls.some(item => item.operation === 'events.schedule' && item.arguments.key === 'due' && item.arguments.delay_ms === 1000));
});

test('a pending settings apply outlives one turn_end and is dropped by the next', () => {
  const state = { ...started(), pending: { from: ['{}'], to: { preset: 'custom' }, turns: 0 } };
  const first = call({ event: 'turn_end', payload: { turn_id: 't1' }, state }).state;
  assert.deepEqual(first.pending, { from: ['{}'], to: { preset: 'custom' }, turns: 1 });
  assert.equal(call({ event: 'turn_end', payload: { turn_id: 't2' }, state: first }).state.pending, null);
});

test('compaction_end counts compacted and replaced outcomes only and stamps when the context last changed', () => {
  const end = (state, outcome, at = NOW) => call({ event: 'compaction_end', payload: { turn_id: 't1', trigger: 'auto', outcome }, state, virtual_time_ms: at }).state;
  const compacted = end(started(), 'compacted');
  assert.deepEqual([compacted.context.compactions, compacted.context.compacted], [1, NOW]);
  const replaced = end(compacted, 'replaced', NOW + 60_000);
  assert.deepEqual([replaced.context.compactions, replaced.context.compacted], [2, NOW + 60_000]);
  for (const outcome of ['skipped', 'deferred', 'failed']) {
    const ignored = end(replaced, outcome, NOW + 120_000);
    assert.deepEqual([ignored.context.compactions, ignored.context.compacted], [2, NOW + 60_000], outcome);
  }
});

test('a failed-mod alert survives any width that fits it and other segments drop first', () => {
  const state = feed(started(), [['model_response', response('r1', { cost: { microusd: null, basis: 'unpriced' } })]]);
  const identity = { codex_version: '0.167.0', omd_version: '1', install_profile: 'full', mode: 'omd', mods: { installed: 6, enabled: 5, active: 4, failed: 1 } };
  const narrow = columns => lines(view(state, { preset: 'custom', layout: 'model cost omd' }, { identity, client: { kind: 'terminal', columns, rows: 40 } }))[0];
  assert.match(narrow(160), /gpt-6\.1-sol · cost unknown · 1 failed · \/omd \(4 mods on\)/);
  assert.match(narrow(30), /^1 failed · \/omd/);
  assert.equal(narrow(20), '1 failed · /omd');
  const busy = rows(view(state, { preset: 'custom', layout: 'model git changes context limits cost tokens cache omd' }, { identity, client: { kind: 'terminal', columns: 400, rows: 40 } })).at(-1).spans;
  assert.deepEqual(busy.slice(-2), [{ text: '1 failed · /omd', tone: 'failure' }, { text: ' (4 mods on)', tone: 'muted' }], 'span packing keeps the alert last with its tone');
});

test('context reads tokens and percent left, like Codex, and replaces the stock indicator when shown', () => {
  const state = { ...started(), context: { ...started().context, used: 12_000, window: 272_000, at: NOW } };
  assert.equal(lines(view(state, { preset: 'custom', layout: 'context' }))[0], '████████ 260k left (100%)');
  const half = { ...state, context: { ...state.context, used: 142_000 } };
  assert.equal(lines(view(half, { preset: 'custom', layout: 'context', glyphs: 'ascii' }))[0], '[####----] 130k left (50%)');
  const disabled = settings => call({ event: 'start', payload: null, settings }).registrations.builtins[0].surfaces.disable;
  assert.deepEqual(disabled({}), ['status_line', 'context_indicator']);
  assert.deepEqual(disabled({ preset: 'custom', layout: 'model git' }), ['status_line']);
});

test('the editor keeps an unsaved draft on reopen, saves from both tabs, previews sample data and moves segments', () => {
  const answer = host({ 'terminal.panel': () => ({ shown: true }) });
  const panel = output => output.calls.findLast(item => item.operation === 'terminal.panel').arguments;
  const state = started();
  const edited = call({ event: 'command', name: 'edit', payload: 'panel glyphs ascii', state, ui_state: null }, answer);
  const reopened = call({ event: 'command', name: 'edit', payload: '', state, ui_state: edited.ui }, answer);
  assert.equal(reopened.ui.draft.glyphs, 'ascii');
  assert.match(panel(reopened).subtitle, /Unsaved changes/);
  assert.deepEqual(panel(reopened).items.filter(item => item.label.startsWith('Save')).map(item => [item.tab, item.label]),
    [['settings', 'Save (unsaved changes)'], ['segments', 'Save (unsaved changes)']]);
  const clean = call({ event: 'command', name: 'edit', payload: '', state, ui_state: null }, answer);
  assert.doesNotMatch(panel(clean).subtitle, /Unsaved/);
  assert.match(panel(clean).subtitle, /left \(\d+%\)/, 'context shows sample data before any response');
  assert.equal(panel(clean).items.find(item => item.id === 'segment:context').label, 'Context window left');
  const moved = call({ event: 'command', name: 'edit', payload: 'panel up:context', state, ui_state: clean.ui }, answer);
  assert.equal(moved.ui.draft.layout, 'model context tier limits cost cache git omd');
  const later = call({ event: 'command', name: 'edit', payload: 'panel down:omd', state, ui_state: moved.ui }, answer);
  assert.equal(later.ui.draft.layout, moved.ui.draft.layout);
  const saved = call({ event: 'command', name: 'edit', payload: 'panel save', state, ui_state: moved.ui }, answer);
  assert.deepEqual(saved.calls.find(item => item.operation === 'settings.write').arguments.values, { preset: 'custom', layout: 'model context tier limits cost cache git omd' });
});

test('git runs only for shown segments that need it, with only the commands they need', () => {
  const scripts = settings => {
    const runs = [];
    const answer = host({ 'exec.run': args => { runs.push(args.argv[1]); return { exit_code: 0, timed_out: false, stdout: GIT, stderr: '' }; } });
    const start = call({ event: 'start', payload: null, settings }, answer);
    const state = call({ event: 'timer', payload: { key: 'due' }, state: start.state, settings, virtual_time_ms: NOW + 2000 }, answer).state;
    call({ event: 'tool_result', payload: { call_id: 'c1', tool: 'apply_patch', agent_id: null, thread_id: 'lead' }, state, settings }, answer);
    return [runs, state.due];
  };
  const [none, due] = scripts({ preset: 'custom', layout: 'model context' });
  assert.deepEqual([none, 'git' in due], [[], false]);
  const [branch] = scripts({});
  assert.equal(branch.length, 1);
  assert.match(branch[0], /status --porcelain/);
  assert.doesNotMatch(branch[0], /remote get-url|diff --shortstat/);
  const [pr] = scripts({ preset: 'custom', layout: 'model pr' });
  assert.match(pr[0], /remote get-url/);
  assert.doesNotMatch(pr[0], /status --porcelain|diff --shortstat|rev-parse/);
});

test('one shared timer per thread, and an exhausted timer pool still leaves the line updating', () => {
  const settings = { scripts: JSON.stringify([{ id: 'weather', command: ['sh', 'w.sh'] }]) };
  const start = call({ event: 'start', payload: null, settings });
  assert.deepEqual([...new Set(start.calls.filter(item => item.operation === 'events.schedule').map(item => item.arguments.key))], ['due']);
  assert.deepEqual(Object.keys(start.state.due).sort(), ['git', 'github', 'limits', 'script:weather', 'settle', 'tick']);
  const full = host({ 'events.schedule': () => { throw new Error('timer_limit: 16 timers'); } });
  const state = feed(call({ event: 'start', payload: null }, full).state, [['model_response', response('r1')]], full);
  assert.equal(state.beat, null, 'a refused timer is retried by the next event');
  const armed = call({ event: 'resume', payload: null, state: { ...start.state, due: { limits: NOW - 1, settle: NOW - 1 } } });
  assert.deepEqual(armed.state.due, { settle: NOW + 2000, limits: NOW + 60_000, tick: NOW + 60_000, git: NOW + 60_000, github: NOW + 30_000 }, 'resume waits for settle instead of running overdue jobs');
  const edit = state => call({ event: 'tool_result', payload: { call_id: 'c1', tool: 'apply_patch', agent_id: null, thread_id: 'lead' }, state, virtual_time_ms: NOW + 500 });
  const first = edit(armed.state);
  assert.ok(!edit(first.state).calls.some(item => item.operation === 'events.schedule'), 'a pending earlier timer is not pushed back');
  assert.match(lines(view(state))[0], /gpt-6\.1-sol/);
});

test('the default layout follows the Codex tui.status_line until the layout is customized', () => {
  const answer = host({ 'app.request': args => args.method === 'config/read'
    ? { config: { tui: { status_line: ['model-with-reasoning', 'context-remaining', 'hostname', 'git-branch', 'constructor'] } } } : { data: [], nextCursor: null } });
  const state = call({ event: 'start', payload: null }, answer).state;
  assert.equal(state.seed, 'model effort tier context git omd');
  const plain = call({ event: 'start', payload: null }, host({ 'app.request': args => args.method === 'config/read' ? { config: { tui: { status_line: ['git-branch'] } } } : { data: [], nextCursor: null } }));
  assert.equal(plain.state.seed, 'git context omd', 'context is always kept because the stock indicator is hidden');
  assert.equal(lines(view({ ...state, context: { ...state.context, used: 12_000, window: 272_000, at: NOW } }))[0], 'gpt-6.1-sol · ████████ 260k left (100%)');
  assert.equal(lines(view({ ...state, context: { ...state.context, used: 12_000, window: 272_000, at: NOW } }, { preset: 'compact', glyphs: 'ascii', bars: false }))[0], 'gpt-6.1-sol | 260k left (100%)');
  const opened = call({ event: 'command', name: 'edit', payload: '', state, ui_state: null }, host({ 'terminal.panel': () => ({ shown: true }) }));
  assert.match(opened.calls.find(item => item.operation === 'terminal.panel').arguments.subtitle, /Layout from your Codex tui\.status_line/);
});

test('a config/read refused at start lands at settle', () => {
  let refused = true;
  const answer = host({ 'app.request': args => {
    if (args.method !== 'config/read') return { data: [], nextCursor: null };
    if (refused) throw new Error('client_context_changed');
    return { config: { model_reasoning_effort: 'low', tui: { status_line: ['model-with-reasoning', 'git-branch'] } } };
  } });
  const start = call({ event: 'start', payload: null }, answer);
  assert.deepEqual([start.state.seed, start.state.model.effort], [null, null]);
  refused = false;
  const state = call({ event: 'timer', payload: { key: 'due' }, state: start.state, virtual_time_ms: NOW + 2000 }, answer).state;
  assert.deepEqual([state.seed, state.model.effort], ['model effort tier git context omd', 'low']);
});

test('a 46-column viewport drops segments that fit at 100 columns', () => {
  const state = { ...feed(started(), [['model_response', response('r1')]]), seed: 'model effort git context omd' };
  const draw = columns => lines(view(state, {}, { client: { kind: 'terminal', columns, rows: 30 } }));
  assert.match(draw(100)[0], /feat\/line.*left/);
  assert.deepEqual(draw(46), ['gpt-6.1-sol · high']);
});

test('startup retries refused config reads on the shared timer until the client is ready', () => {
  const refused = host({ 'app.request': () => { throw new Error('client_context_changed'); } });
  const start = call({ event: 'start', payload: null }, refused);
  const retry = call({ event: 'timer', payload: { key: 'due' }, state: start.state, virtual_time_ms: NOW + 2000 }, refused);
  assert.equal(retry.state.seed, null);
  assert.equal(retry.state.due.settle, NOW + 32_000);
  assert.deepEqual(retry.calls.filter(item => item.operation === 'events.schedule').map(item => item.arguments), [{ key: 'due', delay_ms: 28_000 }]);
  assert.ok(!retry.calls.some(item => item.operation === 'exec.run'));
  const ready = host({ 'app.request': args => args.method === 'config/read'
    ? { config: { tui: { status_line: ['model-with-reasoning', 'git-branch'] } } }
    : args.method === 'model/list' ? { data: [] } : {} });
  const done = call({ event: 'timer', payload: { key: 'due' }, state: retry.state, virtual_time_ms: NOW + 32_000 }, ready);
  assert.equal(done.state.seed, 'model effort tier git context omd');
  assert.equal(done.state.due.settle, undefined);
  assert.ok(done.calls.some(item => item.operation === 'exec.run'));
});
