import { spawn, execFileSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runner = readFileSync(new URL('../runtime/omd/src/mods/runner.mjs', import.meta.url), 'utf8');
const directory = mkdtempSync(join(tmpdir(), 'omd-runner-'));
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
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

function take() {
  const worker = spares.shift() ?? boot();
  while (spares.length < 2) spares.push(boot());
  return worker;
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
  closeSync(worker.input);
  closeSync(worker.output);
  worker.child.kill();
}

export function runnerSync(request) {
  const worker = take();
  try {
    writeSync(worker.input, JSON.stringify(request) + '\n');
    const stdout = line(worker) ?? '';
    let status = 0;
    try { status = 'error' in JSON.parse(stdout) ? 1 : 0; } catch { status = 1; }
    return { stdout, stderr: '', status, error: undefined };
  } finally {
    close(worker);
  }
}

export function callback(request, host, receipts, { capture = error => !error.crash } = {}) {
  const worker = take();
  try {
    writeSync(worker.input, JSON.stringify({ ...request, receipts, interactive: true }) + '\n');
    for (;;) {
      const text = line(worker);
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
