import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

const HELP = 'o open · c click · t type · p key · b/f back/forward · r reload · i image · / find · d done · q quit';
const [endpointFile, session = 'default'] = process.argv.slice(2);
let base = '';
const out = process.stdout;
const view = { url: '', title: '', text: [], scroll: 0, image: null, handoff: null, message: 'Loading…', prompt: null, find: '' };

async function call(action, body) {
  const response = await fetch(`${base}/pane/${session}/${action}`, body ? { method: 'POST', body: JSON.stringify(body) } : undefined);
  if (!response.ok) throw new Error(response.status === 404 ? `session ${session} is not enabled for panes (set "pane": true in its omd-browser profile)` : `HTTP ${response.status}`);
  return action === 'frame' ? Buffer.from(await response.arrayBuffer()) : response.json();
}

export function decodePng(buffer) {
  let offset = 8;
  let header = null;
  const data = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const chunk = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') header = { width: chunk.readUInt32BE(0), height: chunk.readUInt32BE(4), depth: chunk[8], color: chunk[9], interlace: chunk[12] };
    if (type === 'IDAT') data.push(chunk);
    offset += length + 12;
  }
  if (!header || header.depth !== 8 || ![2, 6].includes(header.color) || header.interlace) throw new Error('unsupported screenshot format');
  const bpp = header.color === 6 ? 4 : 3;
  const stride = header.width * bpp;
  const raw = inflateSync(Buffer.concat(data));
  const pixels = Buffer.alloc(stride * header.height);
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? pixels[y * stride + x - bpp] : 0;
      const up = y ? pixels[(y - 1) * stride + x] : 0;
      const corner = y && x >= bpp ? pixels[(y - 1) * stride + x - bpp] : 0;
      const guess = left + up - corner;
      const nearest = Math.abs(guess - left) <= Math.abs(guess - up) && Math.abs(guess - left) <= Math.abs(guess - corner) ? left : Math.abs(guess - up) <= Math.abs(guess - corner) ? up : corner;
      const predictor = [0, left, up, (left + up) >> 1, nearest][filter];
      pixels[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + predictor) & 0xff;
    }
  }
  return { width: header.width, height: header.height, pixel: (x, y) => [...pixels.subarray(y * stride + x * bpp, y * stride + x * bpp + 3)] };
}

export function halfBlocks(image, cols, rows) {
  return Array.from({ length: rows }, (_, row) => Array.from({ length: cols }, (_, col) => {
    const x = Math.floor(col * image.width / cols);
    const top = image.pixel(x, Math.floor(2 * row * image.height / (2 * rows)));
    const bottom = image.pixel(x, Math.floor((2 * row + 1) * image.height / (2 * rows)));
    return `\x1b[38;2;${top.join(';')}m\x1b[48;2;${bottom.join(';')}m▀`;
  }).join('') + '\x1b[0m');
}

function render() {
  const cols = out.columns || 80;
  const rows = out.rows || 24;
  const clip = text => text.length > cols ? `${text.slice(0, cols - 1)}…` : text;
  const lines = [`\x1b[7m${clip(`${view.title || 'Browser'} — ${view.url || session}`).padEnd(cols)}\x1b[0m`];
  if (view.handoff) lines.push(`\x1b[33m${clip(`Handed to you: ${view.handoff} · press d when done`)}\x1b[0m`);
  const height = Math.max(1, rows - lines.length - 1);
  const body = view.image?.pixel ? halfBlocks(view.image, cols, height)
    : view.text.slice(view.scroll, view.scroll + height).map(line => clip(line).replace(/\[(e\d+)\]/g, '\x1b[36m[$1]\x1b[0m'));
  const footer = view.prompt ? `${view.prompt.label}: ${view.prompt.value}█` : view.message || HELP;
  out.write(`\x1b[H\x1b[2J${[...lines, ...body, ...Array(height - body.length).fill(''), `\x1b[2m${clip(footer)}\x1b[0m`].join('\r\n')}`);
}

async function refresh() {
  try {
    const state = await call('state');
    Object.assign(view, { url: state.url, title: state.title, handoff: state.handoff, message: '',
      text: state.text.split('\n').map(line => line.replace(/\s*\[ref=(e\d+)\]/g, ' [$1]')) });
    view.scroll = Math.min(view.scroll, Math.max(0, view.text.length - 1));
    if (view.image) view.image = decodePng(await call('frame'));
  } catch (error) {
    view.message = error.message;
  }
  render();
}

async function act(body) {
  view.message = 'Working…';
  render();
  const result = await call('act', body).catch(error => ({ error: error.message }));
  await refresh();
  if (result.error) {
    view.message = result.error;
    render();
  }
}

function ask(label) {
  return new Promise(resolve => {
    view.prompt = { label, value: '', resolve };
    render();
  });
}

function find(query) {
  view.find = query || view.find;
  const needle = view.find.toLowerCase();
  const index = view.text.findIndex((line, position) => position > view.scroll && line.toLowerCase().includes(needle));
  view.message = index < 0 ? `No more matches for ${view.find}` : '';
  if (index >= 0) view.scroll = index;
  render();
}

async function key(input) {
  if (view.prompt) {
    const { prompt } = view;
    if (input === '\r' || input === '\x1b') {
      view.prompt = null;
      prompt.resolve(input === '\r' ? prompt.value.trim() || null : null);
    } else if (input === '\x7f') prompt.value = prompt.value.slice(0, -1);
    else if (input >= ' ' && !input.startsWith('\x1b')) prompt.value += input;
    return render();
  }
  const page = Math.max(1, (out.rows || 24) - 3);
  const scroll = { '\x1b[A': -1, '\x1b[B': 1, '\x1b[5~': -page, '\x1b[6~': page, ' ': page }[input];
  if (scroll) {
    view.scroll = Math.min(Math.max(0, view.text.length - 1), Math.max(0, view.scroll + scroll));
    return render();
  }
  if (input === 'q' || input === '\x03') {
    out.write('\x1b[?25h\x1b[0m\x1b[2J');
    process.exit(0);
  }
  if (input === 'o') {
    const target = await ask('Open URL');
    if (target) await act({ action: 'navigate', url: /^https?:\/\//i.test(target) ? target : `https://${target}` });
  } else if (input === 'c' || input === 't') {
    const ref = await ask('Element ref (e.g. e12)');
    const text = ref && input === 't' ? await ask(`Text for ${ref}`) : null;
    if (ref) await act(input === 'c' ? { action: 'click', ref } : { action: 'fill', ref, text: text ?? '' });
  } else if (input === 'p') {
    const pressed = await ask('Key (Enter, Tab, Escape, ArrowDown…)');
    if (pressed) await act({ action: 'press', key: pressed });
  } else if (input === 'b' || input === 'f') await act({ action: input === 'b' ? 'back' : 'forward' });
  else if (input === 'r') await act({ action: 'reload' });
  else if (input === 'i') {
    view.image = view.image ? null : {};
    await refresh();
  } else if (input === '/') find(await ask('Find'));
  else if (input === 'n') find('');
  else if (input === 'd' && view.handoff) {
    const note = await ask('Note for the agent (optional)');
    await call('done', { note: note ?? '' }).catch(() => {});
    await refresh();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  base = JSON.parse(readFileSync(endpointFile, 'utf8')).url;
  process.stdin.setRawMode?.(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', input => key(input));
  out.on('resize', render);
  out.write('\x1b[?25l');
  await refresh();
  setInterval(async () => {
    const status = await call('status').catch(() => null);
    if (status && (status.url !== view.url || status.title !== view.title || status.handoff !== view.handoff)) await refresh();
  }, 1_000);
}
