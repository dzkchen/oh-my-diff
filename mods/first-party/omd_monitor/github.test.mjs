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
  responses.forEach((body, index) => writeFileSync(join(dir, `r${index + 1}.json`), JSON.stringify(body)));
  writeFileSync(join(dir, 'gh'), `#!/bin/sh
echo "$@" >> "${dir}/argv"
n=$(cat "${dir}/count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${dir}/count"
${delay ? 'sleep 2' : ''}\n${fail ? 'echo "HTTP 404: Not Found" >&2; exit 1' : `f="${dir}/r$n.json"; [ -f "$f" ] || f="${dir}/r${responses.length}.json"; cat "$f"`}
`);
  chmodSync(join(dir, 'gh'), 0o755);
  const read = name => existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8').trim().split('\n') : [];
  return { dir, calls: () => read('argv'), count: () => Number(read('count')[0] ?? 0), done: () => rmSync(dir, { recursive: true, force: true }) };
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
  const gh = fakeGh([pr, { total_count: 1 }, checks(null), status, pr, pr, { total_count: 1 }, checks('success'), status, pr, { total_count: 1 }, checks('success'), status, pr]);
  const result = await adapt(gh, ['pr', 'acme/app', '9', '1', '10', soon(60000)]);
  assert.deepEqual(result.lines.map(line => [line.state, line.conclusion]), [['pending', undefined], ['completed', 'success']]);
  gh.done();
});

test('PR monitoring fails closed when check results are truncated', async () => {
  const sha = 'a'.repeat(40);
  const pr = { state: 'open', mergeable_state: 'clean', head: { sha } };
  const gh = fakeGh([pr, { total_count: 1 }, { total_count: 101, check_runs: [] }, { state: 'success', total_count: 0, statuses: [] }, pr]);
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
  const gh = fakeGh([pr, suites, checks, status, pr, suites, checks, status, pr]);
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
  const gh = fakeGh([pr, { total_count: 1 }, ...pages, { state: 'success', total_count: 0 }, pr, { total_count: 1 }, ...pages, { state: 'success', total_count: 0 }, pr]);
  const result = await adapt(gh, ['pr', 'acme/app', '9', '1', '1', soon(60000)]);
  assert.equal(result.lines[0].conclusion, 'success');
  assert.ok(gh.calls().some(call => call.endsWith('&page=11')));
  gh.done();
});

test('too many check suites cannot report a false success', async () => {
  const sha = 'a'.repeat(40);
  const pr = { state: 'open', mergeable_state: 'clean', head: { sha } };
  const gh = fakeGh([pr, { total_count: 1001 }]);
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
    const gh = fakeGh([pr, ...pages, { state: 'success', total_count: 0 }, pr, ...verify, { state: 'success', total_count: 0 }, pr]);
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
  const gh = fakeGh([pr, suites, checks, status, pr, suites, checks, status, pr]);
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
    const gh = fakeGh([pr, suites, checks, status, pr, ...verify]);
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
  const gh = fakeGh([pr, suites, checks, status, pr, suites, checks, status, pr]);
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
    const gh = fakeGh(hasStatus
      ? [pr, empty, goodStatus, { ...empty, check_runs: [] }, goodStatus, pr, empty, { ...empty, check_runs: [] }, goodStatus, pr]
      : [pr, empty, emptyStatus, { total_count: 1 }, checks, emptyStatus, pr, { total_count: 1 }, checks, emptyStatus, pr, empty, emptyStatus]);
    try {
      const result = await adapt(gh, ['pr', 'acme/app', '9', '1', '1', soon(60000)]);
      assert.equal(result.lines[0].conclusion, 'success');
      assert.equal(result.lines[0].check_sha, hasStatus ? merge : sha);
    } finally { gh.done(); }
  }
});

test('a resumed PR watcher rejects a replaced test merge check source', async () => {
  const sha = 'a'.repeat(40), merge = 'b'.repeat(40);
  const gh = fakeGh([{ state: 'open', head: { sha }, merge_commit_sha: merge }, { total_count: 1 }]);
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
  const gh = fakeGh([pr, empty, status, empty, { ...empty, check_runs: [] }, status, pr,
    pr, suites, checks, status, pr, suites, checks, status, pr]);
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
  const gh = fakeGh([pr, empty, status, suites, checks, status, pr, suites, checks, status, pr, suites]);
  try {
    const result = await adapt(gh, ['pr', 'acme/app', '9', '1', '1', soon(60000)]);
    assert.ok(result.lines.every(line => line.conclusion !== 'success'));
    assert.equal(result.lines.at(-1).reason, 'poll limit');
  } finally { gh.done(); }
});
