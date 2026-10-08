import { request } from 'node:http';
import { pathToFileURL } from 'node:url';

const BLIT_BASE64 = 250_000;
const MAX_SIDE = 2048;
const KEYS = {
  Enter: [13, 'Enter', '\r'], Tab: [9, 'Tab'], Backspace: [8, 'Backspace'], Esc: [27, 'Escape'], Space: [32, ' ', ' ', 'Space'],
  Delete: [46, 'Delete'], Insert: [45, 'Insert'], Home: [36, 'Home'], End: [35, 'End'], PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'],
  Up: [38, 'ArrowUp'], Down: [40, 'ArrowDown'], Left: [37, 'ArrowLeft'], Right: [39, 'ArrowRight'],
  ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`F${index + 1}`, [112 + index, `F${index + 1}`]])),
};
const MODIFIERS = { Alt: 1, Ctrl: 2, Shift: 8 };
const BUTTONS = { left: 1, right: 2, middle: 4 };
const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
const emit = message => process.stdout.write(`${JSON.stringify(message)}\n`);

export function jpegSize(base64) {
  for (const length of [4096, base64.length]) {
    const bytes = Buffer.from(base64.slice(0, length), 'base64');
    for (let at = 2; at + 9 < bytes.length;) {
      if (bytes[at] !== 0xff) break;
      const marker = bytes[at + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
      at += 2 + bytes.readUInt16BE(at + 2);
    }
  }
  return null;
}

export function geometry(box, zoom, graphics, detail = 1) {
  const pixels = { width: box.columns * box.cell_px.width, height: box.rows * box.cell_px.height };
  const density = clamp(box.cell_px.height / 16, 1, 3) * zoom;
  const css = { width: Math.max(Math.round(pixels.width / density), 200), height: Math.max(Math.round(pixels.height / density), 150) };
  const limit = graphics === 'cells' ? Math.min(box.columns * 4 / pixels.width, box.rows * 8 / pixels.height) : MAX_SIDE / Math.max(pixels.width, pixels.height);
  const scale = Math.min(1, limit) * detail;
  const frame = { width: Math.max(Math.round(pixels.width * scale), 1), height: Math.max(Math.round(pixels.height * scale), 1) };
  return { css, frame, deviceScaleFactor: frame.width / css.width };
}

export function keyEvents(events) {
  const out = [];
  for (const event of events) {
    if ('paste' in event) {
      out.push({ text: String(event.paste) });
      continue;
    }
    const [, prefix = '', name = ''] = /^((?:(?:Ctrl|Alt|Shift)\+)*)(.*)$/.exec(event.key ?? '') ?? [];
    const modifiers = prefix.split('+').reduce((sum, part) => sum | (MODIFIERS[part] ?? 0), 0);
    const command = { 'Alt+Left': 'back', 'Alt+Right': 'forward', 'Ctrl+r': 'reload', F5: 'reload', 'Alt+Up': 'zoom_in', 'Alt+Down': 'zoom_out', 'Alt+0': 'zoom_reset' }[event.key ?? ''];
    if (command) {
      out.push({ command });
      continue;
    }
    const special = KEYS[name];
    const text = event.text && !/[\u0000-\u001f\u007f]/.test(event.text) && !(modifiers & 3) ? event.text : '';
    if (special) {
      const [code, key, typed, physical] = special;
      out.push({ key: { key, code: physical ?? key, windowsVirtualKeyCode: code, modifiers, text: modifiers & 3 ? '' : typed ?? '' } });
    } else if (text) {
      for (const character of text) {
        const upper = character.toUpperCase();
        const code = /^[A-Z]$/.test(upper) ? `Key${upper}` : /^[0-9]$/.test(character) ? `Digit${character}` : '';
        out.push({ key: { key: character, code, windowsVirtualKeyCode: code ? upper.charCodeAt(0) : 0, modifiers, text: character } });
      }
    } else if (/^[a-z0-9]$/.test(name)) {
      const upper = name.toUpperCase();
      out.push({ key: { key: name, code: /\d/.test(name) ? `Digit${name}` : `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), modifiers, text: '' } });
    }
  }
  return out;
}

export function startViewer({ url, session, input = process.stdin, write = emit, exit = code => process.exit(code) }) {
  const base = new URL(`${url}/pane/${session}/`);
  const waiting = new Map();
  let id = 0;
  let box = null;
  let graphics = 'kitty';
  let zoom = 1;
  let quality = 80;
  let tuned = 0;
  let small = 0;
  let detail = 1;
  let shape = null;
  let applied = '';
  let frame = null;
  let last = null;
  let generation = 0;
  let picking = false;
  let buttons = 0;
  let press = { at: 0, x: 0, y: 0, button: '', count: 0 };
  let position = { x: 0, y: 0 };
  let moving = null;
  let queue = Promise.resolve();
  let meta = '';
  let closed = false;

  const pipe = request(new URL('cdp', base), { method: 'POST', headers: { 'content-type': 'application/x-ndjson' } });
  const call = (method, params = {}) => closed ? Promise.reject(new Error('disconnected')) : new Promise((resolve, reject) => {
    waiting.set(++id, { resolve, reject });
    pipe.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  const quiet = promise => promise.catch(() => null);
  const serial = work => (queue = queue.then(work).catch(() => {}));
  const finish = error => {
    if (closed) return;
    closed = true;
    for (const { reject } of waiting.values()) reject(new Error('disconnected'));
    write({ error });
    exit(0);
  };

  const describe = async () => {
    const history = await quiet(call('Page.getNavigationHistory'));
    const entry = history?.entries?.[history.currentIndex];
    if (!entry) return;
    const next = { url: entry.url.slice(0, 2000), title: entry.title.slice(0, 200), zoom, generation };
    if (JSON.stringify(next) !== meta) write({ meta: next }), meta = JSON.stringify(next);
  };
  const apply = async (force = false) => {
    if (!box) return;
    shape = geometry(box, zoom, graphics, detail);
    const key = JSON.stringify([shape, quality]);
    if (key === applied && !force) return;
    applied = key;
    await quiet(call('Page.stopScreencast'));
    await call('Emulation.setDeviceMetricsOverride', { width: shape.css.width, height: shape.css.height, deviceScaleFactor: shape.deviceScaleFactor, mobile: false,
      screenWidth: shape.css.width, screenHeight: shape.css.height });
    await call('Page.startScreencast', { format: 'jpeg', quality, maxWidth: shape.frame.width, maxHeight: shape.frame.height, everyNthFrame: 1 });
  };
  const tune = smaller => {
    const now = Date.now();
    if (now - tuned < 1500) return;
    tuned = now;
    if (smaller) quality > 35 ? quality -= 10 : detail = Math.max(detail * 0.85, 0.4);
    else if (detail < 1) detail = Math.min(detail / 0.85, 1);
    else if (quality < 85) quality += 5;
    else return;
    serial(() => apply());
  };
  const screencast = ({ data, metadata, sessionId }) => {
    quiet(call('Page.screencastFrameAck', { sessionId }));
    if (data.length > BLIT_BASE64) return tune(true);
    small = data.length < BLIT_BASE64 / 3 ? small + 1 : 0;
    if (small > 30) small = 0, tune(false);
    const size = jpegSize(data);
    if (!size) return;
    frame = { ...size, css: { width: metadata.deviceWidth, height: metadata.deviceHeight } };
    last = { media_type: 'image/jpeg', base64: data };
    write({ blit: last });
  };

  const page = point => frame && typeof point.x === 'number'
    ? { x: point.x * frame.css.width / frame.width, y: point.y * frame.css.height / frame.height } : null;
  const mouse = (type, at, extra) => call('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, modifiers: 0, ...extra });
  const pointer = event => {
    const at = page(event);
    if (!at) return;
    const button = BUTTONS[event.button] ? event.button : 'left';
    if (picking) {
      if (event.action === 'up' && event.inside) {
        serial(async () => {
          const response = await fetch(new URL('pick', base), { method: 'POST', body: JSON.stringify({ x: at.x, y: at.y, generation }) }).catch(() => null);
          write({ pick: response?.ok ? await response.json() : { error: response ? `http_${response.status}` : 'disconnected' } });
        });
      }
      return;
    }
    if (event.action === 'move' || event.action === 'drag') {
      if (!event.inside && !buttons) return;
      position = at;
      if (moving) return void Object.assign(moving, { at, buttons });
      const queued = moving = { at, buttons };
      serial(async () => {
        if (moving === queued) moving = null;
        const held = Object.keys(BUTTONS).find(name => queued.buttons & BUTTONS[name]) ?? 'none';
        await mouse('mouseMoved', queued.at, { button: held, buttons: queued.buttons });
      });
      return;
    }
    moving = null;
    if (event.action === 'scroll_up' || event.action === 'scroll_down') {
      if (event.inside) serial(() => mouse('mouseWheel', at, { deltaX: 0, deltaY: event.action === 'scroll_up' ? -100 : 100, buttons: 0 }));
      return;
    }
    const { count } = press;
    if (event.action === 'down' && event.inside) {
      const now = Date.now();
      const repeat = now - press.at < 500 && press.button === button && Math.hypot(at.x - press.x, at.y - press.y) < 5;
      const clicks = repeat ? Math.min(count + 1, 3) : 1;
      press = { at: now, x: at.x, y: at.y, button, count: clicks };
      const mask = buttons |= BUTTONS[button];
      position = at;
      serial(() => mouse('mousePressed', at, { button, buttons: mask, clickCount: clicks }));
    } else if (event.action === 'up' && buttons & BUTTONS[button]) {
      const mask = buttons &= ~BUTTONS[button];
      serial(() => mouse('mouseReleased', at, { button, buttons: mask, clickCount: count }));
    }
  };
  const rezoom = next => {
    zoom = clamp(Math.round(next * 100) / 100, 0.5, 3);
    serial(async () => {
      await apply();
      await describe();
    });
  };
  const keyboard = events => {
    for (const event of keyEvents(events)) {
      if (event.command?.startsWith('zoom')) rezoom(event.command === 'zoom_reset' ? 1 : zoom * (event.command === 'zoom_in' ? 1.25 : 0.8));
      else if (event.command) navigate({ action: event.command });
      else if (event.text !== undefined) serial(() => call('Input.insertText', { text: event.text.slice(0, 65_536) }));
      else if (!picking) {
        const { text, ...key } = event.key;
        serial(async () => {
          await call('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...key, ...(text && { text, unmodifiedText: text }) });
          await call('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
        });
      }
    }
  };
  const navigate = ({ action, url: target }) => serial(async () => {
    if (action === 'navigate' && /^https?:\/\//i.test(String(target))) await call('Page.navigate', { url: String(target) });
    else if (action === 'reload') await call('Page.reload', {});
    else if (action === 'back' || action === 'forward') {
      const history = await call('Page.getNavigationHistory');
      const entry = history.entries[history.currentIndex + (action === 'back' ? -1 : 1)];
      if (entry) await call('Page.navigateToHistoryEntry', { entryId: entry.id });
    }
  });

  pipe.on('response', response => {
    if (response.statusCode !== 200) return finish(response.statusCode === 404 ? 'not_pane_enabled' : `http_${response.statusCode}`);
    let pending = '';
    response.setEncoding('utf8');
    response.on('data', chunk => {
      pending += chunk;
      for (let at = pending.indexOf('\n'); at >= 0; at = pending.indexOf('\n')) {
        const message = JSON.parse(pending.slice(0, at));
        pending = pending.slice(at + 1);
        if (message.id !== undefined) {
          const call = waiting.get(message.id);
          waiting.delete(message.id);
          if (message.error) call?.reject(new Error(message.error));
          else call?.resolve(message.result);
        } else if (message.method === 'Page.screencastFrame') screencast(message.params);
        else if (message.method) serial(describe);
        else if (message.attached) {
          generation = message.attached.generation;
          applied = '';
          serial(async () => {
            await quiet(call('Emulation.setFocusEmulationEnabled', { enabled: true }));
            await apply(true);
            await describe();
          });
        } else if (message.generation !== undefined) generation = message.generation;
        else if (message.error) write({ reply: { error: message.error } });
      }
    });
    response.on('close', () => finish('disconnected'));
  });
  pipe.on('error', () => finish('disconnected'));
  pipe.on('close', () => finish('disconnected'));
  pipe.flushHeaders();

  let buffered = '';
  input.setEncoding?.('utf8');
  input.on('data', chunk => {
    buffered += chunk;
    for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
      const message = JSON.parse(buffered.slice(0, at));
      buffered = buffered.slice(at + 1);
      if (message.box?.cell_px) {
        box = message.box;
        serial(() => apply());
      }
      if (message.graphics && message.graphics !== graphics) {
        graphics = message.graphics;
        serial(() => apply());
      }
      if (typeof message.zoom === 'number' && message.zoom !== zoom) rezoom(message.zoom);
      if ('picking' in message) picking = message.picking === true;
      if (message.nav) navigate(message.nav);
      if (message.repeat && last) write({ blit: last });
      if (message.pointer) pointer(message.pointer);
      if (message.input) keyboard(message.input);
    }
  });
  input.on('end', () => {
    closed = true;
    pipe.destroy();
    exit(0);
  });
  return { call, state: () => ({ box, zoom, quality, shape, frame, generation, buttons, position }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startViewer({ url: process.env.OH_MY_DIFF_PANE_URL, session: process.env.OH_MY_DIFF_PANE_SESSION });
}
