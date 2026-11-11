import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOOT } from './index.ts';

const adapter = new URL('./github.mjs', import.meta.url).pathname;
const text = readFileSync(adapter, 'utf8');

function fakeGh(responses, { fail = false, delay = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omd-monitor-gh-'));
  writeFileSync(join(dir, 'responses.json'), JSON.stringify(Array.isArray(responses) ? { '*': responses } : responses));
  writeFileSync(join(dir, 'gh'), `#!${process.execPath}
const { appendFileSync, readFileSync, mkdirSync, existsSync } = require('node:fs');
const { createHash } = require('node:crypto');
const dir = ${JSON.stringify(dir)};
const responses = JSON.parse(readFileSync(dir + '/responses.json', 'utf8'));
const path = process.argv.at(-1);
const key = value => createHash('sha256').update(value).digest('hex');
let occurrence = 1;
for (;; occurrence++) {
  try { mkdirSync(dir + '/' + key(path) + '-' + occurrence); break; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
const log = phase => appendFileSync(dir + '/events', JSON.stringify({ path, occurrence, phase, argv: process.argv.slice(2).join(' ') }) + '\\n');
log('start');
const queue = responses[path] ?? responses['*'];
const row = queue?.[Math.min(occurrence - 1, queue.length - 1)];
const settings = row?.fixture ?? {};
(async () => {
  for (const [other, number] of settings.waitFor ?? []) {
    const deadline = Date.now() + 2000;
    while (!existsSync(dir + '/' + key(other) + '-' + number)) {
      if (Date.now() >= deadline) throw new Error('concurrent request did not start');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  await new Promise(resolve => setTimeout(resolve, settings.delayMs ?? ${delay ? 2000 : 0}));
  if (${fail} || settings.error || !queue?.length) throw new Error(settings.error ?? 'HTTP 404: Not Found');
  log('finish');
  process.stdout.write(JSON.stringify(row?.fixture ? row.body : row));
})().catch(error => { log('finish'); console.error(error.message); process.exitCode = 1; });
`);
  chmodSync(join(dir, 'gh'), 0o755);
  const events = () => existsSync(join(dir, 'events')) ? readFileSync(join(dir, 'events'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  const calls = () => events().filter(event => event.phase === 'start').map(event => event.argv);
  return { dir, events, calls, count: () => calls().length, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const prPath = 'repos/acme/app/pulls/9';
const commitPath = (sha, endpoint) => `repos/acme/app/commits/${sha}/${endpoint}?per_page=100`;
function prGh(pr, { prs = [pr], suites = [], checks = [], statuses = [], mergeSuites = [], mergeStatuses = [] } = {}) {
  const responses = { [prPath]: prs };
  const add = (sha, field, pages) => {
    for (const round of pages) {
      for (const [index, row] of (Array.isArray(round) ? round : [round]).entries()) {
        const path = commitPath(sha, field) + (index ? `&page=${index + 1}` : '');
        (responses[path] ??= []).push(row);
      }
    }
  };
  add(pr.head.sha, 'check-suites', suites);
  add(pr.head.sha, 'check-runs', checks);
  responses[commitPath(pr.head.sha, 'status')] = statuses;
  if (pr.merge_commit_sha) {
    add(pr.merge_commit_sha, 'check-suites', mergeSuites);
    responses[commitPath(pr.merge_commit_sha, 'status')] = mergeStatuses;
  }
  return fakeGh(responses);
}

function adapt(gh, args, { bootstrap = false } = {}) {
  return new Promise(resolve => {
    const argv = bootstrap ? ['--input-type=module', '-e', BOOT, 'adapter', ...args] : [adapter, ...args];
    const child = spawn(process.execPath, argv, { env: { PATH: `${gh.dir}:/usr/bin:/bin`, HOME: gh.dir }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    if (bootstrap) child.stdin.write(`${JSON.stringify({ src: text })}\n`);
    else child.stdin.end();
    child.on('close', code => resolve({ code, lines: out.trim() ? out.trim().split('\n').map(line => JSON.parse(line)) : [] }));
  });
}

const run = (state, conclusion = null) => ({ status: state, conclusion, html_url: 'https://github.com/acme/app/actions/runs/9' });
const soon = ms => String(Date.now() + ms);

test('the adapter polls an Actions run with GET only, emits changes and stops at the terminal state', async () => {
  const gh = fakeGh([run('in_progress'), run('in_progress'), run('completed', 'success')]);
  const result = await adapt(gh, ['run', 'acme/app', '9', '1', '10', soon(60_000)]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.lines.map(line => [line.seq, line.state, line.conclusion, line.terminal ?? false]),
    [[1, 'in_progress', undefined, false], [2, 'completed', 'success', true]]);
  assert.equal(result.lines[1].url, 'https://github.com/acme/app/actions/runs/9');
  assert.ok(result.lines.every(line => !Number.isNaN(Date.parse(line.observed_at))));
  assert.equal(gh.count(), 3);
  assert.deepEqual(gh.calls(), Array(3).fill('api --method GET repos/acme/app/actions/runs/9'));
  gh.done();
});

test('a deployment is read from its newest status and success is terminal', async () => {
  const gh = fakeGh([[], [{ state: 'success', log_url: 'https://example.test/log' }]]);
  const result = await adapt(gh, ['deployment', 'acme/app', '5', '1', '10', soon(60_000)]);
  assert.deepEqual(result.lines.map(line => [line.state, line.terminal ?? false]), [['pending', false], ['success', true]]);
  assert.equal(result.lines[1].conclusion, 'success');
  assert.deepEqual([...new Set(gh.calls())], ['api --method GET repos/acme/app/deployments/5/statuses?per_page=1']);
  gh.done();
});

test('polling is bounded by the poll count and by the deadline', async () => {
  const counted = fakeGh([run('in_progress')]);
  const limit = await adapt(counted, ['run', 'acme/app', '9', '1', '2', soon(60_000)]);
  assert.deepEqual(limit.lines.map(line => [line.seq, line.state, line.reason]), [[1, 'in_progress', undefined], [2, 'stopped', 'poll limit']]);
  assert.equal(counted.count(), 2);
  counted.done();
  const timed = fakeGh([run('in_progress')]);
  const late = await adapt(timed, ['run', 'acme/app', '9', '1', '100', soon(300)]);
  assert.equal(late.lines.at(-1).reason, 'timeout');
  assert.ok(timed.count() <= 2);
  timed.done();
});

test('repeated gh failures stop the adapter with the first error line, and bad arguments never reach gh', async () => {
  const broken = fakeGh([], { fail: true });
  const failed = await adapt(broken, ['run', 'acme/app', '9', '1', '10', soon(60_000)]);
  assert.deepEqual(failed.lines.map(line => [line.state, line.reason]), [['stopped', 'gh failed: HTTP 404: Not Found']]);
  assert.equal(broken.count(), 3);
  broken.done();
  const none = fakeGh([run('completed', 'success')]);
  for (const args of [['run', '../app', '9', '1', '5', soon(9000)], ['run', 'acme/..', '9', '1', '5', soon(9000)], ['run', 'acme/app;rm', '9', '1', '5', soon(9000)], ['run', 'acme/app', '9/../1', '1', '5', soon(9000)], ['other', 'acme/app', '9', '1', '5', soon(9000)], ['run', 'acme/app', '9', '1', '0', soon(9000)]]) {
    const refused = await adapt(none, args);
    assert.deepEqual(refused.lines.map(line => [line.state, line.reason]), [['stopped', 'invalid arguments']], args.join(' '));
  }
  assert.equal(none.count(), 0);
  none.done();
});

test('the bootstrap runs the adapter from a stdin message, which is how the host starts it', async () => {
  const gh = fakeGh([run('completed', 'failure')]);
  const result = await adapt(gh, ['run', 'acme/app', '9', '1', '10', soon(60_000)], { bootstrap: true });
  assert.equal(result.code, 0);
  assert.deepEqual(result.lines.map(line => [line.seq, line.state, line.conclusion, line.terminal]), [[1, 'completed', 'failure', true]]);
  gh.done();
});

test('PR monitoring waits for reported checks and reports their result', async () => {
  const sha = 'a'.repeat(40);
  const pr = { state: 'open', mergeable_state: 'clean', head: { sha }, html_url: 'https://github.com/acme/app/pull/9' };
  const checks = conclusion => ({ total_count: 1, check_runs: [{ status: conclusion ? 'completed' : 'in_progress', conclusion }] });
  const status = { state: 'success', total_count: 0, statuses: [] };
  const gh = prGh(pr, { suites: [{ total_count: 1 }], checks: [checks(null), checks('success')], statuses: [status] });
  const result = await adapt(gh, ['pr', 'acme/app', '9', '1', '10', soon(60000)]);
  assert.deepEqual(result.lines.map(line => [line.state, line.conclusion]), [['pending', undefined], ['completed', 'success']]);
  gh.done();
});

test('PR monitoring fails closed when check results are truncated', async () => {
  const sha = 'a'.repeat(40);
  const pr = { state: 'open', mergeable_state: 'clean', head: { sha } };
  const gh = prGh(pr, { suites: [{ total_count: 1 }], checks: [{ total_count: 101, check_runs: [] }], statuses: [{ state: 'success', total_count: 0, statuses: [] }] });
  const result = await adapt(gh, ['pr', 'acme/app', '9', '1', '1', soon(60000)]);
  assert.equal(result.lines.at(-1).reason, 'poll limit');
  gh.done();
});

test('completed PR checks report success while merge readiness is blocked', async () => {
  const sha = 'a'.repeat(40);
  const pr = { state: 'open', mergeable_state: 'blocked', head: { sha } };
  const suites = { total_count: 1 };
  const checks = { total_count: 1, check_runs: [{ status: 'completed', conclusion: 'success' }] };
  const status = { state: 'success', total_count: 0 };
  const gh = prGh(pr, { suites: [suites], checks: [checks], statuses: [status] });
  const result = await adapt(gh, ['pr', 'acme/app', '9', '1', '1', soon(60000)]);
  assert.deepEqual(result.lines.map(line => [line.state, line.conclusion]), [['completed', 'success']]);
  gh.done();
});

test('a resumed PR watcher detects a changed head', async () => {
  const gh = fakeGh([{ state: 'open', head: { sha: 'b'.repeat(40) } }]);
  const result = await adapt(gh, ['pr', 'acme/app', '9', '1', '1', soon(60000), 'a'.repeat(40)]);
  assert.equal(result.lines[0].state, 'head changed');
  assert.equal(result.lines[0].conclusion, 'failure');
  gh.done();
});

test('PR check runs are paginated beyond 1000', async () => {
  const sha = 'a'.repeat(40);
  const pr = { state: 'open', mergeable_state: 'clean', head: { sha } };
  const run = { status: 'completed', conclusion: 'success' };
  const pages = Array.from({ length: 11 }, (_, page) => ({ total_count: 1001, check_runs: Array.from({ length: page === 10 ? 1 : 100 }, (_, i) => ({ ...run, id: page * 100 + i })) }));
  const gh = prGh(pr, { suites: [{ total_count: 1 }], checks: [pages, pages], statuses: [{ state: 'success', total_count: 0 }] });
  const result = await adapt(gh, ['pr', 'acme/app', '9', '1', '1', soon(60000)]);
  assert.equal(result.lines[0].conclusion, 'success');
  assert.ok(gh.calls().some(call => call.endsWith('&page=11')));
  gh.done();
});

test('too many check suites cannot report a false success', async () => {
  const sha = 'a'.repeat(40);
  const pr = { state: 'open', mergeable_state: 'clean', head: { sha } };
  const gh = prGh(pr, { suites: [{ total_count: 1001 }], statuses: [{ state: 'success', total_count: 0 }] });
  const result = await adapt(gh, ['pr', 'acme/app', '9', '1', '1', soon(60000)]);
  assert.equal(result.lines.at(-1).reason, 'poll limit');
  gh.done();
});

test('suite fallback handles success, pending, failure and rejects duplicate pages', async () => {
  const pr = { state: 'open', mergeable_state: 'clean', head: { sha: 'a'.repeat(40) } };
  for (const outcome of ['success', 'failure', null, 'duplicate', 'changed']) {
    const suites = Array.from({ length: 1001 }, (_, id) => ({ id, status: 'completed', conclusion: 'success' }));
    if (outcome === null) suites[1000].status = 'in_progress';
    if (outcome === 'failure') suites[1000].conclusion = 'failure';
    if (outcome === 'duplicate') suites[1000].id = 0;
    const pages = Array.from({ length: 11 }, (_, i) => ({ total_count: 1001, check_suites: suites.slice(i * 100, i * 100 + 100) }));
    const verify = structuredClone(pages);
    if (outcome === 'changed') verify[0].check_suites[0].status = 'in_progress';
    const gh = prGh(pr, { suites: [pages, verify], statuses: [{ state: 'success', total_count: 0 }] });
    try {
      const result = await adapt(gh, ['pr', 'acme/app', '9', '1', '1', soon(60000)]);
      assert.equal(result.lines.some(line => line.conclusion === 'success'), outcome === 'success', outcome);
      if (outcome === 'failure') assert.equal(result.lines[0].conclusion, 'failure');
    } finally { gh.done(); }
  }
});

test('a PR with only check runs can succeed when the empty legacy status is pending', async () => {
  const pr = { state: 'open', mergeable_state: 'clean', head: { sha: 'a'.repeat(40) } };
  const suites = { total_count: 1 };
  const checks = { total_count: 1, check_runs: [{ id: 1, status: 'completed', conclusion: 'success' }] };
  const status = { state: 'pending', total_count: 0 };
  const gh = prGh(pr, { suites: [suites], checks: [checks], statuses: [status] });
  try {
    const result = await adapt(gh, ['pr', 'acme/app', '9', '1', '1', soon(60000)]);
    assert.equal(result.lines[0].conclusion, 'success');
  } finally { gh.done(); }
});

test('success verification rejects changing counts, reruns, closed PRs and a replaced head', async () => {
  const pr = { state: 'open', mergeable_state: 'clean', head: { sha: 'a'.repeat(40) } };
  const suites = { total_count: 1 };
  const checks = { total_count: 1, check_runs: [{ id: 1, status: 'completed', conclusion: 'success' }] };
  const status = { state: 'success', total_count: 1 };
  for (const verify of [
    [{ total_count: 2 }],
    [suites, { total_count: 1, check_runs: [{ id: 2, status: 'in_progress' }] }],
    [suites, checks, { state: 'pending', total_count: 1 }, pr],
    [suites, checks, status, { ...pr, state: 'closed' }],
    [suites, checks, status, { ...pr, head: { sha: 'b'.repeat(40) } }],
  ]) {
    const gh = prGh(pr, { suites: [suites, verify[0]], checks: [checks, verify[1] ?? checks], statuses: [status, verify[2] ?? status], prs: [pr, pr, verify[3] ?? pr] });
    try {
      const result = await adapt(gh, ['pr', 'acme/app', '9', '1', '1', soon(60000)]);
      assert.equal(result.lines.some(line => line.conclusion === 'success'), false);
      assert.equal(result.lines[0].head, pr.head.sha);
    } finally { gh.done(); }
  }
});


test('a slow GitHub request is bounded by the monitor deadline', async () => {
  const gh = fakeGh([run('completed', 'success')], { delay: true });
  try {
    const started = Date.now();
    const result = await adapt(gh, ['run', 'acme/app', '9', '1', '3', soon(300)]);
    assert.equal(result.lines.at(-1).reason, 'timeout');
    assert.equal(result.lines.some(line => line.terminal), false);
    assert.ok(Date.now() - started < 1800);
  } finally { gh.done(); }
});


test('PR checks select the test merge commit and report its identity', async () => {
  const sha = 'a'.repeat(40), merge = 'b'.repeat(40);
  const pr = { state: 'open', head: { sha }, merge_commit_sha: merge };
  const suites = { total_count: 1 };
  const checks = { total_count: 1, check_runs: [{ id: 1, status: 'completed', conclusion: 'success' }] };
  const status = { state: 'pending', total_count: 0 };
  const gh = fakeGh({ [prPath]: [pr], [commitPath(merge, 'check-suites')]: [suites], [commitPath(merge, 'check-runs')]: [checks], [commitPath(merge, 'status')]: [status] });
  try {
    const result = await adapt(gh, ['pr', 'acme/app', '9', '1', '1', soon(60000)]);
    assert.equal(result.lines[0].conclusion, 'success');
    assert.equal(result.lines[0].check_sha, merge);
    assert.ok(gh.calls().filter(call => call.includes('/commits/')).every(call => call.includes(merge)));
  } finally { gh.done(); }
});


test('test merge statuses select the merge commit, while an empty merge falls back to head checks', async () => {
  const sha = 'a'.repeat(40), merge = 'b'.repeat(40);
  const pr = { state: 'open', head: { sha }, merge_commit_sha: merge };
  const empty = { total_count: 0 };
  const emptyStatus = { state: 'pending', total_count: 0 };
  const checks = { total_count: 1, check_runs: [{ id: 1, status: 'completed', conclusion: 'success' }] };
  const goodStatus = { state: 'success', total_count: 1 };
  for (const hasStatus of [true, false]) {
    const gh = hasStatus ? fakeGh({
      [prPath]: [pr], [commitPath(merge, 'check-suites')]: [empty],
      [commitPath(merge, 'check-runs')]: [{ ...empty, check_runs: [] }], [commitPath(merge, 'status')]: [goodStatus],
    }) : prGh(pr, { mergeSuites: [empty], mergeStatuses: [emptyStatus], suites: [{ total_count: 1 }], checks: [checks], statuses: [emptyStatus] });
    try {
      const result = await adapt(gh, ['pr', 'acme/app', '9', '1', '1', soon(60000)]);
      assert.equal(result.lines[0].conclusion, 'success');
      assert.equal(result.lines[0].check_sha, hasStatus ? merge : sha);
    } finally { gh.done(); }
  }
});

test('a resumed PR watcher rejects a replaced test merge check source', async () => {
  const sha = 'a'.repeat(40), merge = 'b'.repeat(40);
  const gh = prGh({ state: 'open', head: { sha }, merge_commit_sha: merge }, { mergeSuites: [{ total_count: 1 }] });
  try {
    const result = await adapt(gh, ['pr', 'acme/app', '9', '1', '1', soon(60000), sha, 'c'.repeat(40)]);
    assert.equal(result.lines[0].state, 'check source changed');
    assert.equal(result.lines[0].conclusion, 'failure');
    assert.ok(gh.calls().every(call => !call.includes('/check-runs')));
  } finally { gh.done(); }
});

test('a PR with no checks yet can discover merge checks on the next poll', async () => {
  const sha = 'a'.repeat(40), merge = 'b'.repeat(40);
  const pr = { state: 'open', head: { sha }, merge_commit_sha: merge };
  const empty = { total_count: 0 }, status = { state: 'pending', total_count: 0 };
  const suites = { total_count: 1 };
  const checks = { total_count: 1, check_runs: [{ id: 1, status: 'completed', conclusion: 'success' }] };
  const gh = fakeGh({ [prPath]: [pr], [commitPath(merge, 'check-suites')]: [empty, suites], [commitPath(merge, 'check-runs')]: [checks], [commitPath(merge, 'status')]: [status], [commitPath(sha, 'check-suites')]: [empty], [commitPath(sha, 'check-runs')]: [{ ...empty, check_runs: [] }], [commitPath(sha, 'status')]: [status] });
  try {
    const result = await adapt(gh, ['pr', 'acme/app', '9', '1', '2', soon(60000)]);
    assert.deepEqual(result.lines.map(line => [line.state, line.check_sha]), [['pending', undefined], ['completed', merge]]);
  } finally { gh.done(); }
});

test('head success is withheld when merge checks appear during verification', async () => {
  const sha = 'a'.repeat(40), merge = 'b'.repeat(40);
  const pr = { state: 'open', head: { sha }, merge_commit_sha: merge };
  const empty = { total_count: 0 }, status = { state: 'pending', total_count: 0 };
  const suites = { total_count: 1 };
  const checks = { total_count: 1, check_runs: [{ id: 1, status: 'completed', conclusion: 'success' }] };
  const gh = prGh(pr, { mergeSuites: [empty, suites], mergeStatuses: [status], suites: [suites], checks: [checks], statuses: [status] });
  try {
    const result = await adapt(gh, ['pr', 'acme/app', '9', '1', '1', soon(60000)]);
    assert.ok(result.lines.every(line => line.conclusion !== 'success'));
    assert.equal(result.lines.at(-1).reason, 'poll limit');
  } finally { gh.done(); }
});

test('PR check and status reads overlap while both PR freshness barriers wait for completion', async () => {
  const sha = 'a'.repeat(40);
  const pr = { state: 'open', head: { sha } };
  const checksPath = commitPath(sha, 'check-runs');
  const statusPath = commitPath(sha, 'status');
  const checks = { total_count: 1, check_runs: [{ id: 1, status: 'completed', conclusion: 'success' }] };
  const status = { state: 'success', total_count: 1 };
  const gh = prGh(pr, {
    suites: [{ total_count: 1 }],
    checks: [{ body: checks, fixture: { waitFor: [[statusPath, 1]], delayMs: 100 } }, checks],
    statuses: [{ body: status, fixture: { waitFor: [[checksPath, 1]] } }, status],
  });
  try {
    const result = await adapt(gh, ['pr', 'acme/app', '9', '1', '1', soon(60000)]);
    assert.equal(result.lines[0].conclusion, 'success');
    const events = gh.events();
    const at = (path, occurrence, phase) => events.findIndex(event => event.path === path && event.occurrence === occurrence && event.phase === phase);
    for (const occurrence of [1, 2]) {
      if (occurrence === 1) {
        assert.ok(at(checksPath, occurrence, 'start') < at(statusPath, occurrence, 'finish'));
        assert.ok(at(statusPath, occurrence, 'start') < at(checksPath, occurrence, 'finish'));
      } else assert.ok(at(statusPath, occurrence, 'start') > at(checksPath, occurrence, 'finish'));
      assert.ok(at(prPath, occurrence + 1, 'start') > at(checksPath, occurrence, 'finish'));
      assert.ok(at(prPath, occurrence + 1, 'start') > at(statusPath, occurrence, 'finish'));
    }
  } finally { gh.done(); }
});

test('failed PR observations settle their sibling before another poll starts', async () => {
  const sha = 'a'.repeat(40);
  const pr = { state: 'open', head: { sha } };
  const checksPath = commitPath(sha, 'check-runs');
  const statusPath = commitPath(sha, 'status');
  const checks = { total_count: 1, check_runs: [{ id: 1, status: 'completed', conclusion: 'success' }] };
  const status = { state: 'success', total_count: 1 };
  for (const failedPath of [checksPath, statusPath]) {
    const sibling = failedPath === checksPath ? statusPath : checksPath;
    const failed = { fixture: { error: 'checks unavailable', waitFor: [[sibling, 1]] } };
    const slow = body => ({ body, fixture: { delayMs: 1300 } });
    const gh = prGh(pr, {
      suites: [{ total_count: 1 }],
      checks: [failedPath === checksPath ? failed : slow(checks)],
      statuses: [failedPath === statusPath ? failed : slow(status)],
    });
    try {
      const result = await adapt(gh, ['pr', 'acme/app', '9', '1', '2', soon(60000)]);
      assert.ok(result.lines.every(line => line.conclusion !== 'success'));
      const events = gh.events();
      const finished = events.findIndex(event => event.path === sibling && event.occurrence === 1 && event.phase === 'finish');
      const nextPoll = events.findIndex(event => event.path === prPath && event.occurrence === 2 && event.phase === 'start');
      assert.ok(finished >= 0 && nextPoll > finished, `${failedPath} must settle its sibling before retry`);
    } finally { gh.done(); }
  }
});

test('concurrent PR observations still stop at the monitor deadline', { timeout: 15000 }, async () => {
  const sha = 'a'.repeat(40);
  const pr = { state: 'open', head: { sha } };
  const checks = { total_count: 1, check_runs: [{ id: 1, status: 'completed', conclusion: 'success' }] };
  const gh = prGh(pr, {
    suites: [{ total_count: 1 }],
    checks: [{ body: checks, fixture: { delayMs: 10000 } }],
    statuses: [{ body: { state: 'success', total_count: 1 }, fixture: { delayMs: 10000 } }],
  });
  try {
    const result = await adapt(gh, ['pr', 'acme/app', '9', '1', '3', soon(6000)]);
    assert.equal(result.lines.at(-1).reason, 'timeout');
    assert.ok(result.lines.every(line => line.conclusion !== 'success'));
    assert.equal(gh.events().filter(event => event.path === prPath && event.phase === 'start').length, 1);
    const observed = gh.events().filter(event => event.phase === 'start').map(event => event.path);
    assert.ok(observed.includes(commitPath(sha, 'check-runs')));
    assert.ok(observed.includes(commitPath(sha, 'status')));
  } finally { gh.done(); }
});
