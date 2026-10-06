import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runnerSync } from './mod_runner.mjs';

const source = readFileSync(new URL('../mods/first-party/omd_git/index.ts', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../mods/first-party/omd_git/mod.json', import.meta.url), 'utf8'));
const assets = Object.fromEntries((manifest.assets ?? []).map(name => [name, { text: readFileSync(new URL(`../mods/first-party/omd_git/${name}`, import.meta.url), 'utf8') }]));
const native = readFileSync(new URL('../runtime/omd/src/mods.rs', import.meta.url), 'utf8');
const events = native.match(/pub const MOD_EVENTS:[\s\S]*?= &\[([\s\S]*?)\];/)[1];
const surface = { events: Object.fromEntries([...events.matchAll(/\("([a-z_]+)", "([a-z_.]+)"\)/g)].map(match => [match[1], match[2]])), replacements: [], intercept: { render: 'terminal' }, middleware: [], state: 'store', contracts: 'contracts' };
const NOW = 1_800_000_000_000;
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

function invoke(host, event, payload, state, { name = null, settings = {}, time = NOW } = {}) {
  const receipts = [];
  for (let turn = 0; turn < 64; turn++) {
    const child = runnerSync({ source, assets, filename: 'index.ts', api: manifest.api, capabilities: manifest.capabilities, settings, surface,
      state, event, name, payload, receipts, hook_budget_ms: 5000, virtual_time_ms: time });
    assert.ifError(child.error);
    const reply = JSON.parse(child.stdout);
    if (reply.error) throw new Error(reply.error);
    if (!reply.host_call) return reply;
    try { receipts.push({ call: reply.host_call, value: host(reply.host_call) }); }
    catch (error) { receipts.push({ call: reply.host_call, error: error.message }); }
  }
  throw new Error('host_call_limit');
}

function nodes(count, { failing = [], pending = [], required = [], runs = 18 } = {}) {
  return Array.from({ length: count }, (_, index) => index === count - 1
    ? { __typename: 'StatusContext', context: 'legacy/status', state: 'SUCCESS', isRequired: false }
    : { __typename: 'CheckRun', databaseId: 1000 + index, name: `job ${index}`, status: pending.includes(index) ? 'IN_PROGRESS' : 'COMPLETED',
      conclusion: pending.includes(index) ? null : failing.includes(index) ? 'FAILURE' : 'SUCCESS', isRequired: required.includes(index),
      checkSuite: { workflowRun: { databaseId: 5000 + index % runs, workflow: { name: `workflow ${index % runs}` } } } });
}

function pull({ head = HEAD, state = 'OPEN', contexts = nodes(3), size = 50, cursor = null, review = 'APPROVED' } = {}) {
  const start = cursor === null ? 0 : Number(cursor);
  const slice = contexts.slice(start, start + size);
  const next = start + size < contexts.length;
  return { data: { repository: { pullRequest: { title: 'Add feature', state, isDraft: false, mergeStateStatus: 'BLOCKED', reviewDecision: review, updatedAt: '2027-01-15T08:00:00Z',
    headRefName: 'feature', headRefOid: head, baseRefName: 'main', commits: { nodes: [{ commit: { oid: head, statusCheckRollup: { contexts: {
      totalCount: contexts.length, pageInfo: { hasNextPage: next, endCursor: next ? String(start + size) : null }, nodes: slice } } } }] } } } } };
}

function github(respond, { token = 'p3', status = 'ready', exec = {} } = {}) {
  const world = { http: [], published: [], scheduled: [], notified: [], requests: [], calls: [] };
  world.host = call => {
    const args = call.arguments;
    world.calls.push(call.operation);
    switch (call.operation) {
      case 'credentials.list': return token ? [{ id: token, label: 'GitHub (omd_git)', kind: 'secret', provider: null, origin: 'https://api.github.com', status, default: false }] : [];
      case 'credentials.request': world.requests.push(args); return { status: 'completed', profile: null };
      case 'events.publish': world.published.push(args.data); return { delivered: 1, dropped: 0 };
      case 'events.schedule': world.scheduled.push(args); return args;
      case 'terminal.notify': world.notified.push(args); return { delivered: true, method: 'osc9' };
      case 'exec.run': {
        const stdout = exec[args.argv.slice(8).join(' ')];
        return { exit_code: stdout === undefined ? 1 : 0, signal: null, timed_out: false, stdout: stdout ?? '', stderr: '', stdout_sha256: '0'.repeat(64), stdout_truncated: false, stderr_truncated: false, duration_ms: 1, program: { path: '/usr/bin/git', sha256: '1'.repeat(64) }, guards_verified: 0 };
      }
      case 'http.request': {
        assert.equal(args.credential, token);
        assert.ok(args.url.startsWith('https://api.github.com/'));
        assert.ok(args.method === undefined || args.method === 'POST' && args.url.endsWith('/graphql') && !/mutation/i.test(args.body));
        const request = { url: args.url, ...(args.body ? JSON.parse(args.body) : {}) };
        world.http.push(request);
        const { status = 200, headers = {}, body } = respond(request);
        const text = typeof body === 'string' ? body : JSON.stringify(body);
        return { status, url: args.url, headers: { date: new Date(NOW).toUTCString(), ...headers }, redirects: [], truncated: false, bytes: text.length, body: text };
      }
      default: throw new Error(`unexpected_operation: ${call.operation}`);
    }
  };
  world.command = (state, name, payload = '') => invoke(world.host, 'command', payload, state, { name });
  world.cycle = (state, { key = 'github', settings, time } = {}) => {
    const before = world.published.length;
    const timer = invoke(world.host, 'timer', { key }, state, { settings, time });
    const message = world.published.slice(before).at(-1);
    if (!message) return timer.state ?? state;
    return invoke(world.host, 'channel', { publisher: 'omd_git', channel: 'omd_git/github', data: message, correlation: null, sequence: 1, dropped: 0 }, timer.state ?? state, { settings, time }).state;
  };
  return world;
}

const run = (id, { head = HEAD, attempt = 1, status = 'completed', conclusion = 'success' } = {}) => ({ id, name: `workflow ${id - 5000}`, run_attempt: attempt, status, conclusion, head_sha: head });

test('GitHub watch pages over 100 checks, binds required checks to the head and fetches more than 15 runs by identity', () => {
  const contexts = nodes(230, { failing: [7], required: [3, 7], pending: [12] });
  const world = github(request => request.query
    ? { body: pull({ contexts, cursor: request.variables.c }) }
    : { body: run(Number(/runs\/(\d+)/.exec(request.url)[1]), { attempt: request.url.includes('5007') ? 2 : 1, status: request.url.includes('5012') ? 'in_progress' : 'completed', conclusion: request.url.includes('5007') ? 'failure' : 'success', head: request.url.includes('5017') ? OTHER : HEAD }) });
  let state = world.command(null, 'github', 'watch octo/proj#42').state;
  assert.deepEqual(world.published, [{ poll: true }]);
  state = world.cycle(state);
  let [watch] = state.github.watches;
  assert.equal(watch.checks, null);
  assert.equal(watch.incomplete, 'checks 200/230 loaded');
  assert.equal(world.scheduled.at(-1).delay_ms, 1_000);
  assert.match(invoke(world.host, 'terminal', {}, state).value.sites.sidebar.components.at(-1).children[0].rows[0].label, /^octo\/proj#42 unknown .*incomplete$/);
  state = world.cycle(state, { time: NOW + 2_000 });
  [watch] = state.github.watches;
  assert.equal(watch.checks.total, 230);
  assert.deepEqual(watch.checks.req, [1, 1, 0]);
  assert.ok(watch.checks.failing[0].startsWith('required job 7 (check 1007)'));
  assert.match(watch.incomplete, /runs not yet fetched/);
  for (let index = 2; index < 12 && state.github.watches[0].incomplete; index++) state = world.cycle(state, { time: NOW + index * 2_000 });
  [watch] = state.github.watches;
  assert.equal(world.http.filter(request => request.query).length, 5);
  assert.equal(watch.incomplete, null);
  assert.equal(watch.runs.length, 17);
  assert.ok(watch.runs.every(item => item.verified));
  assert.ok(!watch.runs.some(item => item.id === 5017));
  assert.deepEqual(watch.runs.filter(item => item.id === 5007).map(item => [item.attempt, item.state]), [[2, 'fail']]);
  assert.equal(world.http.filter(request => request.url.includes('/runs/5003')).length, 1);
  assert.equal(world.scheduled.at(-1).delay_ms, 30_000);
  const details = invoke(world.host, 'terminal', {}, invoke(world.host, 'command', 'octo/proj#42', state, { name: 'inspect' }).state).value;
  const text = details.sites.dialog.components[0].children[0].children[0].text;
  assert.match(text, /required 1 pass, 1 fail, 0 pending/);
  assert.match(text, /workflow 7 run 5007 attempt 2/);
  assert.ok(Buffer.byteLength(text) <= 4096);
  const row = details.sites.sidebar.components.at(-1).children[0].rows[0];
  assert.equal(row.value, 'octo/proj#42');
  assert.match(row.label, /^octo\/proj#42 failing 228\/230 req 1\/2/);
});

test('A head change during pagination restarts on the new head instead of mixing results', () => {
  let head = HEAD;
  let next = OTHER;
  const world = github(request => {
    if (!request.query) return { body: run(5000, { head }) };
    if (request.variables.c) head = next;
    return { body: pull({ head, contexts: nodes(150, { runs: 1 }), cursor: request.variables.c }) };
  });
  let state = world.command(null, 'github', 'watch octo/proj#42').state;
  state = world.cycle(state);
  assert.equal(state.github.watches[0].page.head, OTHER);
  assert.equal(state.github.watches[0].page.checks.total, 100);
  state = world.cycle(state, { time: NOW + 2_000 });
  const [watch] = state.github.watches;
  assert.equal(watch.pr.head, OTHER);
  assert.equal(watch.checks.total, 150);
  assert.equal(watch.page, null);
  assert.deepEqual(watch.runs.map(item => [item.id, item.verified]), [[5000, true]]);
  next = 'c'.repeat(40);
  const [moved] = world.cycle(state, { time: NOW + 1_000_000 }).github.watches;
  assert.equal(moved.pr.head, next);
  assert.ok(moved.page && moved.checks === null && !moved.runs.length);
});

test('Rate limits back off with Retry-After, and revoked or missing tokens go quiet and stale', () => {
  let mode = 'limited';
  const world = github(() => mode === 'limited' ? { status: 429, headers: { 'retry-after': '120' }, body: '{}' } : (() => { throw new Error('credential_profile_unknown: p3'); })());
  let state = world.command(null, 'github', 'watch octo/proj#42').state;
  state = world.cycle(state);
  assert.equal(state.github.until, NOW + 120_000);
  assert.equal(world.scheduled.at(-1).delay_ms, 120_000);
  assert.match(state.github.watches[0].error, /rate limit/);
  const calls = world.http.length;
  world.cycle(state, { time: NOW + 60_000 });
  assert.equal(world.http.length, calls);
  mode = 'revoked';
  const scheduled = world.scheduled.length;
  state = world.cycle(state, { time: NOW + 121_000 });
  assert.equal(state.github.token, 'invalid');
  assert.equal(world.scheduled.length, scheduled);
  const view = invoke(world.host, 'terminal', {}, state).value;
  const pane = view.sites.sidebar.components.at(-1);
  assert.match(pane.children[0].rows[0].label, /unknown stale/);
  assert.match(pane.children[1].text, /token rejected/);
  world.command(state, 'github', 'token');
  assert.deepEqual(world.requests, [{ action: 'refresh', profile: 'p3' }]);
  const empty = github(() => assert.fail('no request'), { status: 'not_enrolled' });
  empty.command(null, 'github', 'token');
  assert.deepEqual(empty.requests, [{ action: 'refresh', profile: 'p3' }]);
  const denied = github(() => ({ status: 403, body: '{"message":"Resource not accessible by personal access token"}' }));
  state = denied.cycle(denied.command(null, 'github', 'watch octo/private#1').state);
  assert.match(state.github.watches[0].error, /not readable with this token/);
  assert.equal(state.github.watches[0].next, NOW + 900_000);
  assert.deepEqual(denied.scheduled, [{ key: 'github', delay_ms: 900_000 }]);
  denied.cycle(state, { key: 'github_turn', time: NOW + 60_000 });
  assert.equal(denied.http.length, 1);
  const missing = github(() => assert.fail('no request without a token'), { token: null });
  state = missing.cycle(missing.command(null, 'github', 'watch octo/proj#42').state);
  assert.equal(state.github.token, 'missing');
  assert.deepEqual(missing.scheduled, []);
});

test('Branch watches resolve the fork pull request by head repository, not by branch name', () => {
  const refs = 'for-each-ref --format=%(push:remotename) %(upstream:remotename) %(upstream:remoteref) refs/heads/feature';
  const exec = { 'symbolic-ref --short -q HEAD': 'feature\n', [refs]: 'origin origin refs/heads/feature\n', 'remote get-url origin': 'git@github.com:me/proj.git\n', 'remote get-url upstream': 'git@github.com:up/proj.git\n' };
  const triangular = github(() => assert.fail('no request'), { exec: { ...exec, [refs]: 'origin upstream refs/heads/main\n', 'config --get branch.feature.remote': 'upstream\n', 'config --get branch.feature.merge': 'refs/heads/main\n' } });
  assert.equal(triangular.command(null, 'github', 'watch').state.github.watches[0].key, 'me/proj:feature');
  const world = github(request => request.variables?.b
    ? { body: { data: { repository: { nameWithOwner: 'me/proj', pullRequests: { nodes: [] }, parent: { nameWithOwner: 'up/proj', pullRequests: { nodes: [{ number: 7, headRepository: { nameWithOwner: 'other/proj' } }, { number: 9, headRepository: { nameWithOwner: 'me/proj' } }] } } } } } }
    : request.query ? { body: pull({ contexts: [] }) } : assert.fail('no runs'), { exec });
  let state = world.command(null, 'github', 'watch').state;
  assert.equal(state.github.watches[0].key, 'me/proj:feature');
  state = world.cycle(state);
  assert.equal(state.github.watches[0].key, 'up/proj#9');
  assert.deepEqual(world.http[1].variables, { o: 'up', r: 'proj', n: 9, c: null });
  assert.equal(world.command(state, 'github', 'watch up/proj#9').value.display, 'already watching up/proj#9');
});

test('Merged pull requests stop polling, idle sessions make no host calls, and unwatch wins over an in-flight result', () => {
  let state = 'OPEN';
  const world = github(request => request.query ? { body: pull({ state, contexts: [] }) } : assert.fail('no runs'));
  let saved = world.command(null, 'github', 'watch octo/proj#42').state;
  saved = world.command(saved, 'github', 'watch octo/proj#43').state;
  assert.equal(world.command(saved, 'github', 'unwatch').value.display, 'usage: /omd_git:github unwatch KEY');
  for (const event of ['resume', 'turn_end']) saved = invoke(world.host, event, {}, saved).state ?? saved;
  assert.deepEqual(world.scheduled, [{ key: 'github', delay_ms: 1_000 }, { key: 'github_turn', delay_ms: 10_000 }]);
  const timer = invoke(world.host, 'timer', { key: 'github' }, saved);
  const result = world.published.at(-1);
  saved = world.command(timer.state ?? saved, 'github', 'unwatch OCTO/proj#43').state;
  saved = invoke(world.host, 'channel', { publisher: 'omd_git', channel: 'omd_git/github', data: result, correlation: null, sequence: 1, dropped: 0 }, saved).state;
  assert.deepEqual(saved.github.watches.map(item => item.key), ['octo/proj#42']);
  state = 'MERGED';
  const scheduled = world.scheduled.length;
  saved = world.cycle(saved, { time: NOW + 400_000 });
  assert.equal(saved.github.watches[0].final, true);
  assert.equal(world.scheduled.length, scheduled);
  const calls = world.calls.length;
  invoke(world.host, 'timer', { key: 'github' }, saved);
  invoke(world.host, 'timer', { key: 'github' }, null);
  assert.equal(world.calls.length, calls);
  saved = world.command(saved, 'github', 'unwatch').state;
  assert.deepEqual(saved.github.watches, []);
  assert.equal(invoke(world.host, 'terminal', {}, saved).value.sites.sidebar.components.some(component => component.id === 'omd_git_github'), false);
});

test('Opted-in notices fire on settled transitions and review changes, never on first load', () => {
  let failing = [];
  let review = 'REVIEW_REQUIRED';
  let count = 3;
  const world = github(request => request.query ? { body: pull({ contexts: nodes(count, { failing, required: [0, 1], runs: 1 }), review }) } : { body: run(5000, { conclusion: failing.length ? 'failure' : 'success' }) });
  const settings = { notices: true };
  let state = world.command(null, 'github', 'watch octo/proj#42').state;
  state = world.cycle(state, { settings });
  assert.deepEqual(world.notified, []);
  failing = [1];
  state = world.cycle(state, { settings, time: NOW + 400_000 });
  assert.deepEqual(world.notified, [{ title: 'octo/proj#42', body: 'failing: Add feature' }]);
  review = 'APPROVED';
  world.cycle(state, { time: NOW + 800_000 });
  assert.equal(world.notified.length, 1);
  state = world.cycle(state, { settings, time: NOW + 800_000 });
  assert.deepEqual(world.notified.at(-1), { title: 'octo/proj#42', body: 'failing, review approved: Add feature' });
  count = 0;
  world.cycle(state, { settings, time: NOW + 1_200_000 });
  assert.equal(world.notified.length, 2);
});
