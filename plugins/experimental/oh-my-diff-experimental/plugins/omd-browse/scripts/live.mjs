import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const KEY_NAMES = { Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown', Esc: 'Escape' };
const PRESS = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved', drag: 'mouseMoved' };

export function jpegWidth(buffer) {
  for (let at = 2; at + 9 < buffer.length;) {
    if (buffer[at] !== 0xff) return 0;
    const marker = buffer[at + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return buffer.readUInt16BE(at + 7);
    at += 2 + buffer.readUInt16BE(at + 2);
  }
  return 0;
}

export class Live {
  constructor(browser, dir) {
    this.browser = browser;
    this.dir = dir;
    this.path = join(dir, `${process.pid}.sock`);
    browser.changed = () => this.refresh();
  }

  start() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    rmSync(this.path, { force: true });
    this.server = createServer(socket => this.accept(socket));
    this.server.listen(this.path);
    this.server.unref();
    this.touch();
  }

  touch() {
    writeFileSync(join(this.dir, `${process.pid}.json`), JSON.stringify({ socket: this.path, pid: process.pid, used: Date.now() }), { mode: 0o600 });
  }

  stop() {
    this.server?.close();
    rmSync(this.path, { force: true });
    rmSync(join(this.dir, `${process.pid}.json`), { force: true });
  }

  accept(socket) {
    const viewer = { width: 640, height: 400, scale: 1, buttons: 0 };
    const send = message => socket.writable && socket.write(`${JSON.stringify(message)}\n`);
    viewer.frame = params => {
      const width = jpegWidth(Buffer.from(params.data.slice(0, 8192), 'base64'));
      if (width) viewer.scale = params.metadata.deviceWidth / width;
      send({ blit: { media_type: 'image/jpeg', base64: params.data } });
    };
    viewer.status = () => {
      const tab = this.browser.tabs.get(this.browser.current);
      send({ status: tab ? { tab: tab.id, title: tab.title ?? '', url: tab.url, user: !!tab.handoff?.message, reason: tab.handoff?.message ?? '' } : { tab: '', title: '', url: '', user: false, reason: '' } });
    };
    this.browser.viewers.add(viewer);
    createInterface({ input: socket }).on('line', line => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      this.input(viewer, message).catch(() => {});
    });
    socket.on('close', () => {
      this.browser.viewers.delete(viewer);
      this.refresh();
    });
    socket.on('error', () => {});
    this.refresh();
  }

  async input(viewer, message) {
    if (message.box) {
      const cell = message.box.cell_px ?? { width: 8, height: 16 };
      viewer.width = Math.min(1600, Math.max(160, message.box.columns * cell.width));
      viewer.height = Math.min(1600, Math.max(100, message.box.rows * cell.height));
      return this.refresh();
    }
    const tab = this.browser.conn && this.browser.tabs.get(this.browser.current);
    if (!tab) return;
    if (message.pointer) {
      const { action, button, x, y } = message.pointer;
      if (x === null || y === null) return;
      const point = { x: x * viewer.scale, y: y * viewer.scale };
      if (action === 'scroll_up' || action === 'scroll_down') {
        await this.browser.mouse(tab, 'mouseWheel', point.x, point.y, { deltaX: 0, deltaY: action === 'scroll_up' ? -120 : 120 });
        return;
      }
      const type = PRESS[action];
      if (!type) return;
      if (action === 'down') viewer.buttons = button === 'right' ? 2 : 1;
      await this.browser.send('Input.dispatchMouseEvent', { type, ...point, button: type === 'mouseMoved' ? (viewer.buttons ? 'left' : 'none') : button ?? 'left', buttons: viewer.buttons, clickCount: type === 'mouseMoved' ? 0 : 1 }, tab.sessionId);
      if (action === 'up') viewer.buttons = 0;
      return;
    }
    for (const event of message.input ?? []) {
      if ('paste' in event) await this.browser.send('Input.insertText', { text: event.paste }, tab.sessionId);
      else if (event.text) await this.browser.send('Input.insertText', { text: event.text }, tab.sessionId);
      else if (event.key) {
        const parts = event.key.split('+');
        const last = parts.pop();
        parts.push(KEY_NAMES[last] ?? last);
        await this.browser.press(tab, parts.join('+')).catch(() => {});
      }
    }
  }

  refresh() {
    for (const tab of this.browser.tabs.values()) this.browser.cast(tab).catch(() => {});
    for (const viewer of this.browser.viewers) viewer.status();
  }
}
