import fs from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';

const [transport = 'raw', log, mouseHelper] = process.argv.slice(2);
let width = 640, height = 384;
const tile = 16;
const output = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const chunk = (name, bytes) => {
  const type = Buffer.from(name), result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length);
  type.copy(result, 4); bytes.copy(result, 8);
  let crc = 0xffffffff;
  for (const byte of result.subarray(4, -4)) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
};
const png = pixels => {
  const rows = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) pixels.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
};
let source, fd, ready = true, boxed = false, sequence = 0;
let yaw = 0;
const logfd = log ? fs.openSync(log, 'w') : undefined;
// A separate group lets the helper release on stdin EOF if the managed producer is killed.
const mouse = mouseHelper ? spawn(mouseHelper, [], { detached: true, stdio: ['pipe', 'pipe', 'inherit'] }) : null;
if (mouse) readline.createInterface({ input: mouse.stdout }).on('line', line => {
  const event = JSON.parse(line);
  yaw += event.dx ?? 0;
  if (logfd !== undefined) fs.writeSync(logfd, `${JSON.stringify({ mouse: event, at_ns: Date.now() * 1e6 })}\n`);
});
if (log) output({ metrics: log });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.pointer?.action === 'down' && message.pointer?.inside) mouse?.stdin.write('lock\n');
  if (message.input?.some(event => event.key === 'Esc' || event.key?.includes('Super'))) mouse?.stdin.write('release\n');
  if (message.box) {
    boxed = true;
    const w = message.box.columns * (message.box.cell_px?.width ?? 8);
    const h = message.box.rows * (message.box.cell_px?.height ?? 16);
    const scale = Math.min(1, 1280 / Math.max(w, h));
    width = Math.max(tile * 27, Math.round(w * scale));
    height = Math.max(16, Math.round(h * scale));
  }
  if (message.pixels?.path) {
    source = message.pixels.source;
    fd = fs.openSync(message.pixels.path, 'r+');
  }
  if (message.pixels?.source === source && message.pixels?.sequence === sequence) {
    if (message.pixels.error) throw new Error(message.pixels.error);
    ready = message.pixels.ready;
    render();
  }
}).on('close', () => { mouse?.stdin.end('release\n'); setTimeout(() => process.exit(0), 100); });
const start = performance.now();
let deadline = 0;
function tick() {
  deadline += 1000 / 120;
  setTimeout(tick, Math.max(0, start + deadline - performance.now()));
  render();
}
function render() {
  if (!boxed || !ready || (transport === 'raw' && fd === undefined)) return;
  sequence++;
  const created = Date.now() * 1e6, cpu = process.cpuUsage(), began = performance.now();
  const pixels = Buffer.alloc(width * height * 3);
  const value = (sequence & 65535) | (((sequence & 255) ^ ((sequence >> 8) & 255) ^ 165) << 16);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = (((x + sequence * 4 + yaw) >> 4) & 15) * 16, g = (y >> 4) % 16 * 16, b = 96;
      if (y < tile && x < tile * 27) {
        const cell = Math.floor(x / tile);
        if (cell === 0) [r, g, b] = [255, 0, 255];
        else if (cell === 1) [r, g, b] = [0, 255, 255];
        else if (cell === 26) [r, g, b] = [255, 255, 0];
        else r = g = b = value & (1 << (cell - 2)) ? 255 : 0;
      }
      const at = (y * width + x) * 3;
      pixels[at] = r; pixels[at + 1] = g; pixels[at + 2] = b;
    }
  }
  const generated = performance.now();
  if (transport === 'raw') {
    fs.ftruncateSync(fd, pixels.length);
    fs.writeSync(fd, pixels, 0, pixels.length, 0);
    ready = false;
    output({ blit: { pixels: { source, format: 'rgb', width, height, sequence } } });
  } else output({ blit: { media_type: 'image/png', base64: png(pixels).toString('base64') } });
  const used = process.cpuUsage(cpu);
  if (logfd !== undefined) fs.writeSync(logfd, `${JSON.stringify({ sequence, width, height, created_ns: created, generate_ms: generated - began,
    encode_write_ms: performance.now() - generated, cpu_us: used.user + used.system })}\n`);
}
tick();
