import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [kind, repo, id, every, max, until, savedHead, savedCheck] = process.argv.slice(2);
const FINAL = new Set(['success', 'failure', 'error', 'inactive']);
const TIMEOUT_MS = 20_000;
const MAX_FAILURES = 3;
const endpoint = { run: `repos/${repo}/actions/runs/${id}`, deployment: `repos/${repo}/deployments/${id}/statuses?per_page=1`, pr: `repos/${repo}/pulls/${id}` }[kind];
let seq = 0;
const emit = line => console.log(JSON.stringify({ seq: ++seq, ...line, observed_at: new Date().toISOString() }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const gh = () => {
  const dirs = [...(process.env.PATH ?? '').split(':').filter(Boolean), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  return dirs.map(dir => join(dir, 'gh')).find(path => existsSync(path));
};

const read = (program, path = endpoint) => new Promise((resolve, reject) => {
  const env = { ...process.env, HOME: process.env.HOME ?? homedir(), GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
  const remaining = Number(until) - Date.now();
  if (remaining <= 0) return reject(new Error('timeout'));
  execFile(program, ['api', '--method', 'GET', path], { timeout: Math.min(TIMEOUT_MS, remaining), maxBuffer: 1 << 20, env }, (error, stdout, stderr) => {
    if (error) return reject(new Error((stderr || error.message).trim().split('\n')[0].slice(0, 160)));
    try { resolve(JSON.parse(stdout)); } catch { reject(new Error('gh returned unreadable JSON')); }
  });
});

const observe = body => {
  if (kind === 'run') return { state: body.status, conclusion: body.conclusion ?? undefined, url: body.html_url, terminal: body.status === 'completed' };
  const latest = Array.isArray(body) ? body[0] : undefined;
  return latest ? { state: latest.state, conclusion: latest.state, url: latest.log_url || latest.target_url || undefined, terminal: FINAL.has(latest.state) } : { state: 'pending', terminal: false };
};

let head = /^[a-f0-9]{40}$/i.test(savedHead ?? '') ? savedHead : undefined;
let checkSha = /^[a-f0-9]{40}$/i.test(savedCheck ?? '') ? savedCheck : undefined;
async function pull(program) {
  const pr = await read(program);
  const sha = pr.head?.sha;
  if (!/^[a-f0-9]{40}$/i.test(sha ?? '')) throw new Error('PR head is missing');
  if (head && head !== sha) return { state: 'head changed', conclusion: 'failure', terminal: true, head, url: pr.html_url };
  head = sha;
  if (pr.state !== 'open') return { state: 'closed', conclusion: 'failure', terminal: true, url: pr.html_url };
  const merge = pr.merge_commit_sha;
  const mergeChecks = async () => {
    if (!/^[a-f0-9]{40}$/i.test(merge ?? '') || merge === sha) return null;
    const base = `repos/${repo}/commits/${merge}`;
    const suites = await read(program, `${base}/check-suites?per_page=100`);
    if (!Number.isInteger(suites.total_count) || suites.total_count < 0) throw new Error('check results incomplete');
    if (suites.total_count > 0) return suites;
    const status = await read(program, `${base}/status?per_page=100`);
    if (!Number.isInteger(status.total_count) || status.total_count < 0 || !['success', 'failure', 'error', 'pending'].includes(status.state)) throw new Error('check results incomplete');
    return status.total_count > 0 ? suites : null;
  };
  let suites = await mergeChecks();
  const source = suites ? merge : sha;
  if (checkSha && checkSha !== source) return { state: 'check source changed', conclusion: 'failure', terminal: true, head, check_sha: checkSha, url: pr.html_url };
  const base = `repos/${repo}/commits/${source}`;
  suites ??= await read(program, `${base}/check-suites?per_page=100`);
  if (!Number.isInteger(suites.total_count) || suites.total_count < 0) throw new Error('check results incomplete');
  const field = suites.total_count > 1000 ? 'check_suites' : 'check_runs';
  const path = `${base}/${field.replace('_', '-')}?per_page=100`;
  const collect = async first => {
    if (!Array.isArray(first[field]) || !Number.isInteger(first.total_count) || first.total_count < 0) throw new Error('check results incomplete');
    const results = [...first[field]];
    for (let page = 2; results.length < first.total_count; page++) {
      const next = await read(program, `${path}&page=${page}`);
      if (!Array.isArray(next[field]) || !next[field].length || next.total_count !== first.total_count) throw new Error('check results incomplete');
      results.push(...next[field]);
    }
    if (results.length !== first.total_count || (first.total_count > 100 && (results.some(row => !Number.isInteger(row.id)) || new Set(results.map(row => row.id)).size !== results.length))) throw new Error('check results incomplete');
    return results;
  };
  const observations = await Promise.allSettled([
    (async () => collect(field === 'check_suites' ? suites : await read(program, path)))(),
    read(program, `${base}/status?per_page=100`),
  ]);
  const rejected = observations.find(result => result.status === 'rejected');
  if (rejected) throw rejected.reason;
  const [runs, status] = observations.map(result => result.value);
  const latest = await read(program);
  if (latest.state !== 'open') return { state: 'closed', conclusion: 'failure', terminal: true, head, url: latest.html_url };
  if (latest.head?.sha !== sha) return { state: 'head changed', conclusion: 'failure', terminal: true, head, url: latest.html_url };
  if (!Number.isInteger(status.total_count) || status.total_count < 0 || !['success', 'failure', 'error', 'pending'].includes(status.state)) throw new Error('check results incomplete');
  const pending = runs.some(run => run.status !== 'completed') || (status.total_count > 0 && status.state === 'pending');
  const failed = runs.some(run => run.status === 'completed' && !['success', 'neutral', 'skipped'].includes(run.conclusion)) || ['failure', 'error'].includes(status.state);
  const count = runs.length + status.total_count;
  if (count > 0) checkSha = source;
  if (latest.merge_commit_sha !== pr.merge_commit_sha) throw new Error('check source changed');
  const ready = !pending && count > 0;
  if (ready && !failed) {
    const again = await read(program, `${base}/check-suites?per_page=100`);
    if (again.total_count !== suites.total_count) throw new Error('check results changed');
    const verified = await collect(field === 'check_suites' ? again : await read(program, path));
    const signature = rows => JSON.stringify(rows.map(row => [row.id, row.status, row.conclusion]));
    if (signature(verified) !== signature(runs)) throw new Error('check results changed');
    const finalStatus = await read(program, `${base}/status?per_page=100`);
    const finalPR = await read(program);
    if (finalPR.head?.sha !== sha) return { state: 'head changed', conclusion: 'failure', terminal: true, head, url: finalPR.html_url };
    if (finalPR.state !== 'open') return { state: 'closed', conclusion: 'failure', terminal: true, head, url: finalPR.html_url };
    if (source === sha && await mergeChecks()) throw new Error('check source changed');
    if ((finalStatus.total_count > 0 && finalStatus.state !== 'success') || finalStatus.total_count !== status.total_count || finalPR.merge_commit_sha !== pr.merge_commit_sha) throw new Error('check results changed');
  }
  if (Date.now() >= Number(until)) throw new Error('timeout');
  const terminal = !pending && count > 0 && (failed || ready);
  return { state: terminal ? 'completed' : 'pending', conclusion: terminal ? failed ? 'failure' : 'success' : undefined, terminal, head, check_sha: checkSha, url: pr.html_url };
}

async function main() {
  const program = gh();
  const interval = Math.max(1, Number(every)) * 1000;
  if (!endpoint || !/^(?!\.+\/)[\w.-]+\/(?!\.+$)[\w.-]+$/.test(repo ?? '') || !/^\d+$/.test(id ?? '') || !(Number(max) >= 1) || !(Number(until) > 0)) return emit({ state: 'stopped', reason: 'invalid arguments' });
  if (!program) return emit({ state: 'stopped', reason: 'gh was not found' });
  let failures = 0, last = '';
  for (let poll = 0; poll < Number(max); poll++) {
    if (poll) await sleep(Math.min(interval, Math.max(0, Number(until) - Date.now())));
    if (Date.now() >= Number(until)) return emit({ state: 'stopped', reason: 'timeout' });
    try {
      const seen = kind === 'pr' ? await pull(program) : observe(await read(program));
      failures = 0;
      const key = `${seen.state}/${seen.conclusion ?? ''}/${seen.head ?? ''}/${seen.check_sha ?? ''}`;
      if (key !== last || seen.terminal) emit(seen);
      last = key;
      if (seen.terminal) return;
    } catch (error) {
      if (head && !last) { emit({ state: 'pending', head, check_sha: checkSha, terminal: false }); last = `pending//${head}`; }
      if (Date.now() >= Number(until)) return emit({ state: 'stopped', reason: 'timeout' });
      if (++failures >= MAX_FAILURES) return emit({ state: 'stopped', reason: `gh failed: ${error.message}` });
    }
  }
  emit({ state: 'stopped', reason: 'poll limit' });
}

await main();
