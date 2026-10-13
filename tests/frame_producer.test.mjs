import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

test('raw producer keeps its published buffer unchanged until the matching acknowledgement', { timeout: 5000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-producer-'));
  const file = path.join(directory, 'pixels');
  await fs.writeFile(file, '');
  const child = spawn(process.execPath, [new URL('../scripts/frame_producer.mjs', import.meta.url).pathname, 'raw'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  const lines = readline.createInterface({ input: child.stdout });
  const frames = [];
  let resolve;
  lines.on('line', line => {
    const frame = JSON.parse(line).blit?.pixels;
    if (frame) { frames.push(frame); resolve?.(frame); resolve = undefined; }
  });
  const next = () => new Promise(done => { resolve = done; });
  const send = value => child.stdin.write(`${JSON.stringify(value)}\n`);
  try {
    const waiting = next();
    send({ pixels: { source: 'owned-buffer', path: file } });
    send({ box: { columns: 80, rows: 24, cell_px: { width: 8, height: 16 } } });
    const first = await waiting;
    assert.equal(first.source, 'owned-buffer');
    const pixels = await fs.readFile(file);
    assert.equal(pixels.length, first.width * first.height * 3);
    send({ pixels: { source: first.source, sequence: first.sequence + 1, ready: true } });
    send({ pixels: { source: 'foreign-buffer', sequence: first.sequence, ready: true } });
    await new Promise(done => setTimeout(done, 50));
    assert.equal(frames.length, 1);
    assert.deepEqual(await fs.readFile(file), pixels);
    const second = next();
    send({ pixels: { source: first.source, sequence: first.sequence, ready: true } });
    assert.equal((await second).sequence, first.sequence + 1);
    assert.notDeepEqual(await fs.readFile(file), pixels);
  } finally {
    child.kill();
    await closed;
    lines.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
