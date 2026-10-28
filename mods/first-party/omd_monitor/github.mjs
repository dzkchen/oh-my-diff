import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [kind, repo, id, every, max, until] = process.argv.slice(2);
const FINAL = new Set(['success', 'failure', 'error', 'inactive']);
const TIMEOUT_MS = 20_000;
const MAX_FAILURES = 3;
const endpoint = { run: `repos/${repo}/actions/runs/${id}`, deployment: `repos/${repo}/deployments/${id}/statuses?per_page=1` }[kind];
let seq = 0;
const emit = line => console.log(JSON.stringify({ seq: ++seq, ...line, observed_at: new Date().toISOString() }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const gh = () => {
  const dirs = [...(process.env.PATH ?? '').split(':').filter(Boolean), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  return dirs.map(dir => join(dir, 'gh')).find(path => existsSync(path));
};

const read = program => new Promise((resolve, reject) => {
  const env = { ...process.env, HOME: process.env.HOME ?? homedir(), GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
  execFile(program, ['api', '--method', 'GET', endpoint], { timeout: TIMEOUT_MS, maxBuffer: 1 << 20, env }, (error, stdout, stderr) => {
    if (error) return reject(new Error((stderr || error.message).trim().split('\n')[0].slice(0, 160)));
    try { resolve(JSON.parse(stdout)); } catch { reject(new Error('gh returned unreadable JSON')); }
  });
});

const observe = body => {
  if (kind === 'run') return { state: body.status, conclusion: body.conclusion ?? undefined, url: body.html_url, terminal: body.status === 'completed' };
  const latest = Array.isArray(body) ? body[0] : undefined;
  return latest ? { state: latest.state, conclusion: latest.state, url: latest.log_url || latest.target_url || undefined, terminal: FINAL.has(latest.state) } : { state: 'pending', terminal: false };
};

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
      const seen = observe(await read(program));
      failures = 0;
      const key = `${seen.state}/${seen.conclusion ?? ''}`;
      if (key !== last || seen.terminal) emit(seen);
      last = key;
      if (seen.terminal) return;
    } catch (error) {
      if (++failures >= MAX_FAILURES) return emit({ state: 'stopped', reason: `gh failed: ${error.message}` });
    }
  }
  emit({ state: 'stopped', reason: 'poll limit' });
}

await main();
