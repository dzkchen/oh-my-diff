import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOOT } from './index.ts';

const adapter = new URL('./github.mjs', import.meta.url).pathname;
const text = readFileSync(adapter, 'utf8');

function fakeGh(responses, { fail = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'omd-monitor-gh-'));
  responses.forEach((body, index) => writeFileSync(join(dir, `r${index + 1}.json`), JSON.stringify(body)));
  writeFileSync(join(dir, 'gh'), `#!/bin/sh
echo "$@" >> "${dir}/argv"
n=$(cat "${dir}/count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${dir}/count"
${fail ? 'echo "HTTP 404: Not Found" >&2; exit 1' : `f="${dir}/r$n.json"; [ -f "$f" ] || f="${dir}/r${responses.length}.json"; cat "$f"`}
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
  const gh = fakeGh([run('queued'), run('in_progress'), run('in_progress'), run('completed', 'success')]);
  const result = await adapt(gh, ['run', 'acme/app', '9', '1', '10', soon(60_000)]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.lines.map(line => [line.seq, line.state, line.conclusion, line.terminal ?? false]),
    [[1, 'queued', undefined, false], [2, 'in_progress', undefined, false], [3, 'completed', 'success', true]]);
  assert.equal(result.lines[2].url, 'https://github.com/acme/app/actions/runs/9');
  assert.ok(result.lines.every(line => !Number.isNaN(Date.parse(line.observed_at))));
  assert.equal(gh.count(), 4);
  assert.deepEqual(gh.calls(), Array(4).fill('api --method GET repos/acme/app/actions/runs/9'));
  gh.done();
});

test('a deployment is read from its newest status and success is terminal', async () => {
  const gh = fakeGh([[], [{ state: 'in_progress' }], [{ state: 'success', log_url: 'https://example.test/log' }]]);
  const result = await adapt(gh, ['deployment', 'acme/app', '5', '1', '10', soon(60_000)]);
  assert.deepEqual(result.lines.map(line => [line.state, line.terminal ?? false]), [['pending', false], ['in_progress', false], ['success', true]]);
  assert.equal(result.lines[2].conclusion, 'success');
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
  const late = await adapt(timed, ['run', 'acme/app', '9', '1', '100', soon(1500)]);
  assert.equal(late.lines.at(-1).reason, 'timeout');
  assert.ok(timed.count() <= 3);
  timed.done();
});

test('repeated gh failures stop the adapter with the first error line, and bad arguments never reach gh', async () => {
  const broken = fakeGh([], { fail: true });
  const failed = await adapt(broken, ['run', 'acme/app', '9', '1', '10', soon(60_000)]);
  assert.deepEqual(failed.lines.map(line => [line.state, line.reason]), [['stopped', 'gh failed: HTTP 404: Not Found']]);
  assert.equal(broken.count(), 3);
  broken.done();
  const none = fakeGh([run('completed', 'success')]);
  for (const args of [['run', '../app', '9', '1', '5', soon(9000)], ['run', 'acme/..', '9', '1', '5', soon(9000)], ['run', 'acme/app;rm', '9', '1', '5', soon(9000)], ['run', 'acme/app', '9/../1', '1', '5', soon(9000)], ['pull', 'acme/app', '9', '1', '5', soon(9000)], ['run', 'acme/app', '9', '1', '0', soon(9000)]]) {
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
  assert.ok(Buffer.byteLength(BOOT) < 400);
  gh.done();
});
