import { spawn, execFileSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const directory = mkdtempSync(join(tmpdir(), 'omd-runner-'));
const watchdogs = new Set();
process.on('exit', () => {
  for (const watchdog of watchdogs) disarm(watchdog);
  rmSync(directory, { recursive: true, force: true });
});
const spares = [];
let slots = 0;

function boot() {
  const slot = join(directory, String(slots++));
  execFileSync('mkfifo', [`${slot}.in`, `${slot}.out`]);
  const child = spawn('sh', ['-c', 'exec "$0" --no-warnings --experimental-vm-modules --input-type=module --eval "$1" < "$2" > "$3"',
    process.execPath, runner, `${slot}.in`, `${slot}.out`], { stdio: 'ignore' });
  child.unref();
  return { child, input: openSync(`${slot}.in`, 'w'), output: openSync(`${slot}.out`, 'r'), buffer: Buffer.alloc(0) };
}

function take(request) {
  const worker = spares.shift() ?? boot();
  while (spares.length < 2) spares.push(boot());
  const ms = 2 * (request.hook_budget_ms ?? 1000) + 3000;
  worker.deadline = Date.now() + ms;
  worker.watchdog = spawn('sh', ['-c', 'sleep "$1"; kill -9 "$0"', String(worker.child.pid), String(ms / 1000)], { stdio: 'ignore', detached: true });
  worker.watchdog.unref();
  watchdogs.add(worker.watchdog);
  return worker;
}

function disarm(watchdog) {
  watchdogs.delete(watchdog);
  try { process.kill(-watchdog.pid, 'SIGKILL'); } catch {}
}

function expired(worker, text) {
  if (text === null && Date.now() >= worker.deadline) throw new Error('runner_timed_out');
  return text;
}

function line(worker) {
  for (;;) {
    const end = worker.buffer.indexOf(10);
    if (end >= 0) {
      const text = worker.buffer.subarray(0, end).toString();
      worker.buffer = worker.buffer.subarray(end + 1);
      return text;
    }
    const chunk = Buffer.alloc(65536);
    const read = readSync(worker.output, chunk);
    if (!read) {
      const rest = worker.buffer.toString();
      worker.buffer = Buffer.alloc(0);
      return rest || null;
    }
    worker.buffer = Buffer.concat([worker.buffer, chunk.subarray(0, read)]);
  }
}

function close(worker) {
  disarm(worker.watchdog);
  closeSync(worker.input);
  closeSync(worker.output);
  worker.child.kill();
}

export function runnerSync(request) {
  const worker = take(request);
  try {
    writeSync(worker.input, JSON.stringify(request) + '\n');
    const stdout = expired(worker, line(worker)) ?? '';
    let status = 0;
    try { status = 'error' in JSON.parse(stdout) ? 1 : 0; } catch { status = 1; }
    return { stdout, stderr: '', status, error: undefined };
  } finally {
    close(worker);
  }
}

export function callback(request, host, receipts, { capture = error => !error.crash } = {}) {
  const worker = take(request);
  try {
    writeSync(worker.input, JSON.stringify({ ...request, receipts, interactive: true }) + '\n');
    for (;;) {
      const text = expired(worker, line(worker));
      if (text === null) throw new Error('runner_exited_without_result');
      const frame = JSON.parse(text);
      if (!('call' in frame)) return frame;
      let receipt;
      try {
        receipt = { value: host(frame.call) };
      } catch (error) {
        if (!capture(error)) throw error;
        receipt = { error: error.message };
      }
      receipts.push({ call: frame.call, ...receipt });
      writeSync(worker.input, JSON.stringify(receipt) + '\n');
    }
  } finally {
    close(worker);
  }
}
