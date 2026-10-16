import { AssertionError } from 'node:assert';
import { spawn, execFileSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const host = readFileSync(new URL('../runtime/omd/src/mods.rs', import.meta.url), 'utf8');
const table = name => host.match(new RegExp(`pub const ${name}: &\\[[^\\]]*\\] = &\\[([\\s\\S]*?)\\];`))[1];
const pairs = name => Object.fromEntries([...table(name).matchAll(/\("([a-z_]+)", "([a-z_.]+)"\)/g)].map(match => [match[1], match[2]]));
const names = name => [...table(name).matchAll(/"([a-z_]+)"/g)].map(match => match[1]);

export const surface = {
  events: pairs('MOD_EVENTS'),
  replacements: names('MOD_REPLACEMENT_POINTS'),
  middleware: names('MOD_MIDDLEWARE_EVENTS'),
  intercept: pairs('MOD_INTERCEPT_SURFACES'),
  state: 'store', contracts: 'contracts',
};

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
  const child = spawn('sh', ['-c', 'exec "$0" --max-old-space-size=64 --no-compilation-cache --no-lazy --enable-source-maps --no-warnings --experimental-vm-modules --disallow-code-generation-from-strings --input-type=module --eval "$1" < "$2" > "$3" 2> "$4"',
    process.execPath, runner, `${slot}.in`, `${slot}.out`, `${slot}.err`], { stdio: 'ignore' });
  child.unref();
  return { child, input: openSync(`${slot}.in`, 'w'), output: openSync(`${slot}.out`, 'r'), stderr: `${slot}.err`, buffer: Buffer.alloc(0) };
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

function frame(worker) {
  const text = line(worker);
  if (text !== null) return JSON.parse(text);
  if (Date.now() >= worker.deadline) throw new Error('runner_timed_out');
  throw new Error(`runner_exited_without_result: ${readFileSync(worker.stderr, 'utf8').trim()}`);
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
    writeSync(worker.input, JSON.stringify({ surface, ...request }) + '\n');
    return frame(worker);
  } finally {
    close(worker);
  }
}

const HOST_RECEIPT_BYTES = 131_072;
const MAX_HOST_CALLS = 128;

export function callback(request, host, receipts = [], { capture = error => !error.crash && !(error instanceof AssertionError) } = {}) {
  const worker = take(request);
  let spent = Buffer.byteLength(JSON.stringify(receipts));
  try {
    writeSync(worker.input, JSON.stringify({ surface, ...request, receipts, interactive: true }) + '\n');
    for (;;) {
      const output = frame(worker);
      if (!('call' in output)) return output;
      if (receipts.length >= MAX_HOST_CALLS) throw new Error('host_call_limit');
      let receipt;
      try {
        receipt = { value: host(output.call) };
      } catch (error) {
        if (!capture(error)) throw error;
        receipt = { error: error.message };
      }
      let bytes = Buffer.byteLength(JSON.stringify({ call: output.call, ...receipt }));
      const separator = receipts.length ? 1 : 0;
      if (bytes > HOST_RECEIPT_BYTES - spent - separator) {
        receipt = { error: `host_result_limit: the ${bytes}-byte result exceeds the ${HOST_RECEIPT_BYTES - spent - separator} bytes left in this callback; the operation ran, request a smaller page or an artifact` };
        bytes = Buffer.byteLength(JSON.stringify({ call: output.call, ...receipt }));
      }
      spent += bytes + separator;
      receipts.push({ call: output.call, ...receipt });
      if (spent > HOST_RECEIPT_BYTES) throw new Error('host_receipt_limit');
      writeSync(worker.input, JSON.stringify(receipt) + '\n');
    }
  } finally {
    close(worker);
  }
}
