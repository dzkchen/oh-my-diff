import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerSync } from './mod_runner.mjs';

const dir = new URL('../mods/first-party/omd_statusline/', import.meta.url);
const read = name => readFileSync(new URL(name, dir), 'utf8');
const manifest = JSON.parse(read('mod.json'));
const source = read('index.ts');
const assets = Object.fromEntries(manifest.assets.map(name => [name, { text: read(name), sha256: '0'.repeat(64) }]));
const surface = {
  events: { terminal: 'terminal', channel: 'events', timer: 'events', start: 'lifecycle', resume: 'lifecycle', idle: 'lifecycle', thread_settings: 'lifecycle', turn_end: 'lifecycle', tool_result: 'lifecycle',
    compaction_end: 'lifecycle', model_response: 'model', agent: 'middleware', tool_call: 'middleware', app_notification: 'threads', component_event: 'terminal' },
  intercept: { render: 'terminal' }, replacements: [], middleware: [], state: 'store', contracts: 'contracts',
};
const NOW = 1_800_000_000_000;
const GIT = '/repo/.git/worktrees/line\n/repo/.git\n/work/line\n@@\ngit@github.com:dzkchen/oh-my-diff.git\n@@\n 3 files changed, 12 insertions(+), 4 deletions(-)\n@@\n'
  + ['# branch.oid 0123456789abcdef', '# branch.head feat/line', '# branch.ab +2 -1', '1 M. N... 100644 100644 100644 a b src/a.ts', '1 .M N... 100644 100644 100644 a b src/b.ts',
    '2 R. N... 100644 100644 100644 a b R100 new.ts', 'old.ts', '? scratch.txt', ''].join('\0');
const GRAPHQL = JSON.stringify({ data: { repository: {
  pullRequests: { nodes: [{ number: 51, title: 'Fork branch of the same name', url: 'https://github.com/dzkchen/oh-my-diff/pull/51', state: 'OPEN', isDraft: false, isCrossRepository: true },
    { number: 44, title: 'Status line', url: 'https://github.com/dzkchen/oh-my-diff/pull/44', state: 'OPEN', isDraft: false, isCrossRepository: false, reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN',
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }, { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
      { __typename: 'StatusContext', state: 'PENDING' }] } } } }] } }] },
  ref: null } } });

const host = (overrides = {}) => ({ operation, arguments: args }) => {
  if (operation in overrides) return overrides[operation](args);
  if (operation === 'session.info') return { thread_id: 'lead', root: '/repo', cwd: '/repo', codex_version: '0.162.1', model: 'gpt-6.1-sol', provider: 'openai', route: null, turns_started: 0 };
  if (operation === 'app.request' && args.method === 'config/read') return { config: { model_reasoning_effort: 'high', model_context_window: 272_000 } };
  if (operation === 'app.request' && args.method === 'account/rateLimits/read') {
    return { rateLimits: { primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: (NOW + 7_200_000) / 1000 }, secondary: { usedPercent: 93, windowDurationMins: 10_080, resetsAt: (NOW + 86_400_000) / 1000 } } };
  }
  if (operation === 'exec.run') return { exit_code: 0, timed_out: false, stdout: GIT, stderr: '' };
  if (operation === 'credentials.list') return [];
  if (['events.publish', 'events.schedule', 'events.cancel'].includes(operation)) return { delivered: 1, dropped: 0 };
  if (operation === 'settings.write') return { settings: args.values };
  throw new Error(`unexpected host call ${operation}`);
};

const run = (input, receipts) => JSON.parse(runnerSync({ source, filename: fileURLToPath(new URL('index.ts', dir)), entrypoint: 'index.ts', assets, api: manifest.api, surface,
  capabilities: manifest.capabilities, settings: {}, state: null, virtual_time_ms: NOW, hook_budget_ms: 10_000, ...input, receipts }).stdout);
function call(input, answer = host()) {
  const receipts = [];
  const calls = [];
  for (;;) {
    const output = run(input, receipts);
    assert.equal(output.error, undefined, output.error);
    if (!output.host_call) return { ...output, calls, ui: output.ui_state === undefined ? null : JSON.parse(output.ui_state) };
    calls.push(output.host_call);
    const value = (() => { try { return answer(output.host_call); } catch (error) { return error; } })();
    receipts.push(value instanceof Error ? { call: output.host_call, error: value.message } : { call: output.host_call, value });
  }
}
const feed = (state, events, answer) => events.reduce((current, [event, payload, extra = {}]) => call({ event, payload, state: current, ...extra }, answer).state, state);
const response = (id, patch = {}) => ({
  request_id: id, attempt: 1, ledger_request: null, scope: { thread_id: 'lead', agent_id: null, kind: 'main' }, route: 'codex', provider: 'openai', credential: 'chatgpt',
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

test('registers the native status-row removal and the /statusline route', () => {
  const { registrations, state } = call({ event: 'terminal', payload: { event: 'startup', ledger: null, client: { kind: 'terminal', columns: 120, rows: 40 } } });
  assert.deepEqual(registrations.builtins, [{ surfaces: { disable: ['status_line'] }, commands: { replace: { statusline: 'edit' } } }]);
  assert.equal(state, null, 'the threadless startup view writes no thread-scoped state');
  assert.deepEqual(registrations.commands.map(command => command.name), ['edit']);
});

test('session telemetry is request-idempotent, separates workers from the lead context and marks stale context', () => {
  let state = started();
  state = feed(state, [
    ['model_response', response('r1', { cost: { microusd: null, basis: 'unsettled' } })],
    ['model_response', response('r1')],
    ['model_response', response('w1', { scope: { thread_id: 'child', agent_id: 'agent-1', kind: 'subagent' }, served_model: 'gpt-mini', usage: { input_tokens: 9_000, output_tokens: 10 } })],
  ]);
  assert.equal(state.tokens.requests, 2);
  assert.equal(state.tokens.input, 109_000);
  assert.deepEqual(state.cost, { billed: 0, estimate: 2.5, included: 0, pending: 0, unknown: 0 });
  assert.equal(state.context.used, 102_000);
  assert.equal(state.model.served, 'gpt-6.1-sol');
  const [compact] = lines(view(state));
  assert.equal(compact, 'gpt-6.1-sol · ███░░░░░ 38% 170k left · 7d 93% ↻24h00m · ~$2.50 est. · ⎇ feat/line* ↑2↓1 wt:line');
  const detailed = lines(view(state, { preset: 'detailed' }));
  assert.match(detailed[0], /high · openai API est\. · .*↑109k ↓2\.0k r500 c80k · cache 80% · ~\$2\.50 est\. · 5h 42% ↻2h00m 7d 93% ↻24h00m/);
  assert.equal(detailed[1], '⎇ feat/line* ↑2↓1 wt:line · +12 -4 4f · PR: /statusline github · lead 0m');
  const ledger = cost => lines(view(state, {}, { ledger: { thread_id: 'lead', cwd: '/repo', cost } }))[0];
  assert.match(ledger({ settled_task_charge_microusd: 2_500_000 }), / ~\$2\.50 est\. /, 'the session ledger covers the same settled requests');
  assert.match(ledger({ settled_task_charge_microusd: 4_000_000 }), / ~\$4\.00 est\. /, 'settled charges this mod did not see still count');
  const switched = feed(state, [['app_notification', { method: 'thread/settings/updated', params: { threadId: 'lead', threadSettings: { model: 'gpt-6.2', modelProvider: 'openai' } }, thread_id: 'lead', coalesced: 0, dropped: 0 }]]);
  assert.match(lines(view(switched))[0], /^gpt-6\.2 · .*~38%/);
  assert.doesNotMatch(lines(view(state, { preset: 'custom', layout: 'model limits' }))[0], /5h/, 'a one-line layout shows the tightest window whatever its preset');
  const compacted = feed(state, [['compaction_end', { turn_id: 't', trigger: 'auto', outcome: 'compacted', by: null, provider_call: true }, { virtual_time_ms: NOW + 1000 }]]);
  assert.match(lines(view(compacted))[0], /~38% 170k left ⟳1/);
  assert.deepEqual(lines(view(null)), []);
  const health = call({ event: 'terminal', payload: { event: 'idle', ledger: { thread_id: 'lead' }, client: { kind: 'terminal', columns: 160, rows: 40 },
    identity: { codex_version: '0.162.1', install_profile: 'full', mode: 'omd', mods: { installed: 21, enabled: 8, active: 7, failed: 1 } } }, state });
  assert.match(lines(health.value)[0], / · 7 mods on 1 failed · \/omd$/);
  assert.deepEqual(health.state.mods, { installed: 21, enabled: 8, active: 7, failed: 1 });
  const again = call({ event: 'terminal', payload: { event: 'idle', ledger: { thread_id: 'lead' }, client: { kind: 'terminal', columns: 160, rows: 40 },
    identity: { codex_version: '0.162.1', install_profile: 'full', mode: 'omd', mods: { installed: 21, enabled: 8, active: 7, failed: 1 } } }, state: health.state });
  assert.deepEqual(again.state, health.state, 'an unchanged draw writes no state');
  assert.deepEqual(health.state.viewport, { columns: 160, rows: 40 });
  const narrow = call({ event: 'terminal', payload: { event: 'idle', ledger: { thread_id: 'lead' }, client: { kind: 'terminal', columns: 50, rows: 20 } }, state: health.state }).state;
  const command = call({ event: 'command', name: 'edit', payload: '', state: narrow });
  assert.ok(lines(command.value.terminal).every(text => [...text].length <= 46), 'a command view fits the real width');
});

test('narrow terminals drop trailing segments, ASCII glyphs replace symbols and lines stay within the span limit', () => {
  const state = feed(started(), [['model_response', response('r1')]]);
  const narrow = lines(view(state, {}, { client: { kind: 'terminal', columns: 40, rows: 20 } }));
  assert.ok(narrow[0].length <= 40);
  assert.match(narrow[0], /^gpt-6\.1-sol · /);
  const ascii = view(state, { glyphs: 'ascii', preset: 'detailed' });
  assert.ok(lines(ascii).every(text => !/[↑↓↻⎇█░·]/.test(text)));
  for (const item of rows(ascii)) assert.ok(item.spans.length <= 12);
  const wide = { ...state, git: { ...state.git, branch: '機能'.repeat(12) } };
  const cells = text => [...text].reduce((sum, char) => sum + (/[　-鿿]/.test(char) ? 2 : 1), 0);
  assert.ok(lines(view(wide, { preset: 'custom', layout: 'git' }, { client: { kind: 'terminal', columns: 30, rows: 20 } })).every(text => cells(text) <= 26), 'wide characters count two cells');
  const above = view(state, { placement: 'above' });
  assert.deepEqual(Object.keys(above.sites), ['above_composer']);
  assert.equal(above.sites.above_composer.components[0].type, 'slot');
  assert.equal(view(state).sites.below_composer.components.at(-1).type, 'slot');
});

test('git results from another checkout are discarded and a non-repository hides Git segments', () => {
  const state = started();
  assert.equal(state.git.branch, 'feat/line');
  assert.deepEqual(state.git.remote, { owner: 'dzkchen', repo: 'oh-my-diff' });
  assert.deepEqual(call({ event: 'timer', payload: { key: 'time:git' }, state, virtual_time_ms: NOW + 60_000 }).state, state, 'an unchanged checkout writes no state');
  const quiet = { ...state, limits: [] };
  assert.deepEqual(call({ event: 'timer', payload: { key: 'time:tick' }, state: quiet, virtual_time_ms: NOW + 60_000 }).state, quiet, 'a minute passing writes nothing when no shown text depends on it');
  assert.notDeepEqual(call({ event: 'timer', payload: { key: 'time:tick' }, state, virtual_time_ms: NOW + 60_000 }).state, state, 'a reset countdown redraws');
  const moved = { ...state, cwd: '/elsewhere' };
  const raced = call({ event: 'timer', payload: { key: 'time:git' }, state: moved }, host({ 'exec.run': () => ({ exit_code: 0, timed_out: false, stdout: GIT, stderr: '' }) })).state;
  assert.equal(raced.git.key, '/elsewhere');
  const timer = { event: 'timer', payload: { key: 'time:git' }, state };
  const recorded = call(timer).calls.map(item => ({ call: item, value: host()(item) }));
  assert.match(run({ ...timer, state: moved }, recorded).error ?? '', /replay_diverged/, 'a state-conflict retry after a directory change reruns Git');
  assert.doesNotMatch(lines(view(state, {}, { ledger: { thread_id: 'lead', cwd: '/other', cost: null } }))[0], /feat\/line/);
  const outside = settled(host({ 'exec.run': () => ({ exit_code: 3, timed_out: false, stdout: '', stderr: 'fatal: not a git repository' }) }));
  assert.equal(outside.git.error, 'not a repository');
  assert.doesNotMatch(lines(view(outside))[0], /⎇/);
});

test('turn ends, idles and directory changes refresh outside the turn through events the host serves', () => {
  const state = started();
  const ended = call({ event: 'turn_end', payload: { turn_id: 't', outcome: 'completed' }, state });
  assert.ok(!ended.calls.some(item => item.operation === 'exec.run' || item.operation === 'http.request'), 'a turn end runs no subprocess or network work');
  assert.ok(ended.calls.some(item => item.operation === 'events.schedule' && item.arguments.key === 'time:refresh_soon'));
  assert.ok(call({ event: 'idle', payload: { cause: 'TurnComplete' }, state: { ...state, beat: NOW - 200_000 } }).calls.some(item => item.operation === 'events.schedule'), 'idle re-arms stale timers');
  const notified = call({ event: 'app_notification', payload: { method: 'thread/settings/updated', params: { threadId: 'lead', threadSettings: { cwd: '/wt' } }, thread_id: 'lead', coalesced: 0, dropped: 0 }, state });
  assert.ok(!notified.calls.some(item => item.operation === 'exec.run' || item.operation === 'http.request'), 'the terminal-side notification refreshes nothing');
  const moved = call({ event: 'thread_settings', payload: { cwd: { before: '/repo', after: '/wt' }, roots: { added: [], removed: [] }, model: { before: null, after: null } }, state });
  assert.deepEqual([moved.state.cwd, moved.state.git.key], ['/wt', '/wt']);
});

test('a status listing over the output cap keeps the branch, remote and diff summary', () => {
  const repo = mkdtempSync(join(tmpdir(), 'omd-statusline-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  git('init', '-q', '-b', 'feat/big');
  git('remote', 'add', 'origin', 'https://github.com/dzkchen/oh-my-diff.git');
  for (let index = 0; index < 1600; index += 1) writeFileSync(join(repo, `untracked-file-with-a-long-name-${String(index).padStart(5, '0')}.txt`), '');
  const exec = args => {
    const run = spawnSync(args.program, args.argv, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    assert.ok(run.stdout.length > args.max_output_bytes);
    return { exit_code: run.status, timed_out: false, stdout: run.stdout.slice(0, args.max_output_bytes), stderr: '', stdout_truncated: true };
  };
  try {
    const state = settled(host({ 'exec.run': exec }));
    assert.deepEqual([state.git.error, state.git.branch, state.git.remote, state.git.worktree], [null, 'feat/big', { owner: 'dzkchen', repo: 'oh-my-diff' }, null]);
    assert.ok(state.git.untracked > 1000);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('pull request and CI status cover auth, success, rate limits, offline backoff and checkout races', () => {
  const state = started();
  const auth = call({ event: 'timer', payload: { key: 'time:github' }, state }).state;
  assert.equal(auth.github.status, 'auth');
  assert.match(lines(view(auth, { preset: 'detailed' }))[1], /PR: \/statusline github/);
  assert.deepEqual(call({ event: 'timer', payload: { key: 'time:github' }, state: auth, virtual_time_ms: NOW + 120_000 }).state, auth, 'a missing token is rechecked without rewriting state');
  const profile = { 'credentials.list': () => [{ id: 's1', label: 'GitHub', kind: 'secret', provider: null, origin: 'https://api.github.com', status: 'ready', default: false }] };
  const requests = [];
  const ok = call({ event: 'timer', payload: { key: 'time:github' }, state: { ...auth, github: { ...auth.github, next: 0 } } }, host({ ...profile,
    'http.request': args => { requests.push(args); return { status: 200, url: args.url, headers: {}, redirects: [], body: GRAPHQL, truncated: false, bytes: GRAPHQL.length }; } })).state;
  assert.equal(requests.length, 1);
  assert.equal(requests[0].credential, 's1');
  assert.deepEqual(JSON.parse(requests[0].body).variables, { owner: 'dzkchen', name: 'oh-my-diff', branch: 'feat/line', ref: 'refs/heads/feat/line' });
  assert.equal(ok.github.next, NOW + 60_000);
  const patch = view(ok, { preset: 'detailed' });
  assert.match(lines(patch)[1], /PR #44 open ✓ approved · CI ✗ 1/);
  const spans = rows(patch)[1].spans;
  assert.equal(spans.find(span => span.text.startsWith('PR #44')).link, 'https://github.com/dzkchen/oh-my-diff/pull/44');
  assert.equal(spans.find(span => span.text.startsWith('CI')).link, 'https://github.com/dzkchen/oh-my-diff/pull/44/checks');
  assert.equal(call({ event: 'timer', payload: { key: 'time:github' }, state: ok }, host({ ...profile, 'http.request': () => assert.fail('polled before due') })).state.github.status, 'ok');
  const due = { ...ok, github: { ...ok.github, next: 0 } };
  const limited = call({ event: 'timer', payload: { key: 'time:github' }, state: due }, host({ ...profile,
    'http.request': args => ({ status: 403, url: args.url, headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String((NOW + 600_000) / 1000) }, redirects: [], body: '{}', truncated: false, bytes: 2 }) })).state;
  assert.deepEqual([limited.github.status, limited.github.next, limited.github.pr.number], ['rate_limited', NOW + 600_000, 44]);
  const refresh = { event: 'channel', payload: { publisher: 'omd_statusline', channel: 'omd_statusline/refresh', data: null, correlation: null, sequence: 1, dropped: 0 }, state: limited };
  assert.equal(call(refresh, host({ ...profile, 'http.request': () => assert.fail('a forced refresh ignored the rate-limit reset') })).state.github.status, 'rate_limited');
  const offline = call({ event: 'timer', payload: { key: 'time:github' }, state: due }, host({ ...profile, 'http.request': () => { throw new Error('http_timeout'); } })).state;
  assert.deepEqual([offline.github.status, offline.github.next, offline.github.failures], ['offline', NOW + 60_000, 1]);
  const again = call({ event: 'timer', payload: { key: 'time:github' }, state: { ...offline, github: { ...offline.github, next: 0 } } }, host({ ...profile, 'http.request': () => { throw new Error('http_timeout'); } })).state;
  assert.equal(again.github.next, NOW + 120_000);
  const rejected = call({ event: 'timer', payload: { key: 'time:github' }, state: due }, host({ ...profile,
    'http.request': args => ({ status: 401, url: args.url, headers: {}, redirects: [], body: '', truncated: false, bytes: 0 }) })).state;
  assert.equal(rejected.github.status, 'auth');
  const switched = { ...due, git: { ...due.git, branch: 'main' } };
  assert.equal(call({ event: 'timer', payload: { key: 'time:github' }, state: switched }, host({ ...profile,
    'http.request': args => ({ status: 200, url: args.url, headers: {}, redirects: [], body: GRAPHQL, truncated: false, bytes: 1 }) })).state.github.key, 'dzkchen/oh-my-diff#main');
  const off = { github: false, preset: 'detailed' };
  assert.doesNotMatch(lines(view(ok, off))[1], /PR|CI/, 'turning GitHub off hides the last result');
  const armed = call({ event: 'start', payload: {}, settings: off }).calls.filter(item => item.operation === 'events.schedule').map(item => item.arguments.key);
  assert.ok(armed.includes('time:git') && !armed.includes('time:github'), 'turning GitHub off stops its poll');
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
  const hostile = '\x1b[31mrain\x1b[0m \x1b]8;;https://example.com/w\x07forecast\x1b]8;;\x07 \x1b]8;;javascript:alert(1)\x07bad\x1b]8;;\x07\x1b[2J\x1b]0;title\x07‮evil\n2nd line';
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
  assert.match(lines(view(timedOut, settings))[0], /weather: timed out/);
  const crashed = call({ event: 'timer', payload: { key: 'time:script_weather' }, state: viewed, settings }, host({ 'exec.run': run(() => ({ exit_code: 139, timed_out: false, stdout: 'partial', stderr: 'segfault' })) })).state;
  assert.match(lines(view(crashed, settings))[0], /weather: failed/);
  const edited = { ...settings, scripts: JSON.stringify([{ id: 'weather', command: ['sh', 'other.sh'] }]) };
  assert.doesNotMatch(lines(view(done, edited))[0], /rain/);
  assert.match(lines(view(started(), { scripts: 'not json', preset: 'custom', layout: 'model' }))[0] ?? '', /^gpt-6\.1-sol$/);
});

test('the editor previews drafts live, applies only changes and cancels without writing', () => {
  const state = feed(started(), [['model_response', response('r1')]]);
  const command = (text, ui = null, settings = {}) => call({ event: 'command', name: 'edit', payload: text, state, ui_state: ui, settings });
  const opened = command('');
  assert.equal(opened.ui.open, true);
  const dialog = view(state, {}, {});
  assert.equal(dialog.sites.dialog, undefined);
  const withEditor = call({ event: 'terminal', payload: { event: 'idle', ledger: null, client: { kind: 'terminal', columns: 120, rows: 30 } }, state, ui_state: opened.ui }).value;
  const children = withEditor.sites.dialog.components[1].children;
  const ids = nodes => nodes.flatMap(node => [node.id, ...ids(node.children ?? [])]).filter(Boolean);
  assert.ok(ids(withEditor.sites.dialog.components).every(id => /^[a-z0-9_]{1,48}$/.test(id)), ids(withEditor.sites.dialog.components).join(' '));
  assert.match(children.find(item => item.id === 'omd_statusline_preview_label').text, /below the composer/);
  const changed = call({ event: 'component_event', payload: { component: 'omd_statusline_placement', kind: 'change', value: 'above' }, state, ui_state: opened.ui }).ui;
  assert.equal(changed.draft.placement, 'above');
  const toggled = command('toggle cost', changed).ui;
  assert.equal(toggled.draft.preset, 'custom');
  assert.equal(toggled.draft.layout, 'model context limits git omd');
  const moved = command('move git up', toggled).ui;
  assert.equal(moved.draft.layout, 'model context git limits omd');
  assert.equal(command('move up', command('pick limits', moved).ui).ui.draft.layout, 'model context limits git omd');
  const split = command('line git', moved).ui;
  assert.equal(split.draft.layout, 'model context limits omd; git');
  const preview = call({ event: 'terminal', payload: { event: 'idle', ledger: null }, state, ui_state: split }).value.sites.dialog.components[1].children.find(item => item.id === 'omd_statusline_preview').lines.map(spans => spans.map(span => span.text).join(''));
  assert.equal(preview.length, 2);
  assert.match(preview[1], /^⎇ feat\/line/);
  const applied = command('apply', split);
  const write = applied.calls.find(item => item.operation === 'settings.write');
  assert.deepEqual(write.arguments.values, { placement: 'above', preset: 'custom', layout: 'model context limits omd; git' });
  assert.equal(applied.ui.open, false);
  assert.deepEqual(applied.state, state, 'apply writes no durable state beside the settings');
  const published = applied.calls.findIndex(item => item.operation === 'events.publish');
  assert.ok(published >= 0 && published < applied.calls.indexOf(write), 'the apply is announced before the settings write');
  const announcement = call({ event: 'channel', payload: { publisher: 'omd_statusline', channel: 'omd_statusline/refresh', data: applied.calls[published].arguments.data, correlation: null, sequence: 1, dropped: 0 }, state });
  assert.deepEqual(announcement.calls, [], 'recording an apply refreshes nothing');
  const recorded = announcement.state;
  const written = { placement: 'above', preset: 'custom', layout: 'model context limits omd; git' };
  assert.deepEqual(Object.keys(view(recorded, {}).sites), ['above_composer'], 'a host still on the superseded settings draws the applied ones');
  assert.deepEqual(Object.keys(view(recorded, written).sites), ['above_composer']);
  assert.deepEqual(Object.keys(view(recorded, { preset: 'detailed' }).sites), ['below_composer'], 'settings changed elsewhere afterwards win');
  const once = call({ event: 'turn_end', payload: { turn_id: 't', outcome: 'completed' }, state: recorded, settings: {} }).state;
  assert.notEqual(once.pending, null);
  assert.equal(call({ event: 'turn_end', payload: { turn_id: 't2', outcome: 'completed' }, state: once, settings: {} }).state.pending, null, 'the next turn runs with the settings the host has, however they changed');
  assert.equal(call({ event: 'turn_end', payload: { turn_id: 't', outcome: 'completed' }, state: recorded, settings: written }).state.pending, null);
  const second = call({ event: 'command', name: 'edit', payload: 'apply', state: recorded, ui_state: { open: true, draft: { ...written, preset: 'detailed' } }, settings: written });
  const announced = second.calls.find(item => item.operation === 'events.publish').arguments.data.pending;
  assert.equal(announced.from.length, 2, 'a second apply before the next turn keeps the settings the session may still run');
  assert.equal(announced.to.preset, 'detailed');
  const cancelled = command('cancel', split);
  assert.equal(cancelled.calls.length, 0);
  assert.equal(cancelled.ui.open, false);
  const escaped = call({ event: 'component_event', payload: { component: 'omd_statusline_dialog', kind: 'close', origin: 'user' }, state, ui_state: split }).ui;
  assert.equal(escaped.open, false, 'any user dismissal closes the editor');
  assert.equal(command('reset', split).ui.draft.preset, 'compact');
  const kept = command('reset', { ...split, draft: { ...split.draft, github: false, scripts: '[]', refresh_s: 60, tones: 'git=accent' } }).ui.draft;
  assert.deepEqual([kept.preset, kept.github, kept.scripts, kept.refresh_s, kept.tones], ['compact', false, '[]', 60, 'git=accent'], 'reset restores only what the editor shows');
  assert.equal(command('set placement Above', changed).ui.draft.placement, 'above', 'an invalid value keeps the current one');
  assert.equal(command('apply', opened.ui).calls.some(item => item.operation === 'settings.write'), false);
  const stale = command('apply', escaped);
  assert.equal(stale.calls.length, 0);
  assert.match(stale.value.display, /not open/);
  const refusal = call({ event: 'command', name: 'edit', payload: 'apply', state, ui_state: split }, host({ 'settings.write': () => { throw new Error('mod_not_enabled: omd_statusline'); } }));
  const refused = refusal.ui;
  assert.match(refused.notice, /Not saved/);
  assert.equal(refused.open, true);
  const [announce, withdraw] = refusal.calls.filter(item => item.operation === 'events.publish').map(item => item.arguments.data);
  const channel = (data, current) => call({ event: 'channel', payload: { publisher: 'omd_statusline', channel: 'omd_statusline/refresh', data, correlation: null, sequence: 1, dropped: 0 }, state: current }).state;
  assert.deepEqual(Object.keys(view(channel(withdraw ?? {}, channel(announce, state)), {}).sites), ['below_composer'], 'a refused apply withdraws its announcement');
  const dialogIds = ui => {
    const ids = nodes => nodes.flatMap(node => [node.id, ...ids(node.children ?? [])]).filter(Boolean);
    return ids(call({ event: 'terminal', payload: { event: 'idle', ledger: null, client: { kind: 'terminal', columns: 120, rows: 30 } }, state, ui_state: ui }).value.sites.dialog.components);
  };
  assert.deepEqual(dialogIds(refused), dialogIds(split), 'a notice keeps the dialog identity and so its focus');
});

test('/statusline github rotates the existing token instead of enrolling a duplicate', () => {
  const requests = [];
  const answer = owned => host({ 'credentials.list': () => owned, 'credentials.request': args => { requests.push(args); return { status: 'completed', profile: null }; } });
  call({ event: 'command', name: 'edit', payload: 'github' }, answer([]));
  call({ event: 'command', name: 'edit', payload: 'github' }, answer([{ id: 'p7', label: 'GitHub (status line)', kind: 'secret', provider: null, origin: 'https://api.github.com', status: 'ready', default: false }]));
  assert.deepEqual(requests, [{ action: 'enroll', kind: 'secret', label: 'GitHub (status line)', origin: 'https://api.github.com' }, { action: 'refresh', profile: 'p7' }]);
  const declined = call({ event: 'command', name: 'edit', payload: 'github' }, host({ 'credentials.list': () => [], 'credentials.request': () => ({ status: 'cancelled', profile: null }) }));
  assert.ok(!declined.calls.some(item => item.operation === 'events.publish'), 'a declined token refreshes nothing');
});
