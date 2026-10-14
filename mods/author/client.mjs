import { encodeFrame, frameReader } from './frames.mjs';

const SUBPROTOCOL = 'codex-app-server';
const ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function webSocket(url, token, onText, onClose) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, token ? [SUBPROTOCOL, `codex.bearer.${token}`] : [SUBPROTOCOL]);
    let open = false;
    socket.onopen = () => {
      open = true;
      resolve({ send: text => socket.send(text), close: () => socket.close() });
    };
    socket.onmessage = event => onText(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data));
    socket.onerror = () => reject(new Error(`client_connect_failed: ${url}`));
    socket.onclose = () => open && onClose();
  });
}

async function unixSocket(path, onText, onClose) {
  const { connect } = await import('node:net');
  const { createHash } = await import('node:crypto');
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
  const accept = createHash('sha1').update(key + ACCEPT_GUID).digest('base64');
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let head = Buffer.alloc(0);
    let read = null;
    socket.on('error', reject);
    socket.on('close', () => (read ? onClose() : reject(new Error('client_connect_failed: closed during handshake'))));
    socket.on('connect', () => socket.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    socket.on('data', chunk => {
      if (read) return read(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      const lines = head.subarray(0, end).toString().split('\r\n');
      const accepted = lines.some(line => /^sec-websocket-accept:/i.test(line) && line.slice(line.indexOf(':') + 1).trim() === accept);
      if (!/^HTTP\/1\.1 101\b/.test(lines[0]) || !accepted) {
        socket.destroy();
        return reject(new Error(`client_connect_failed: ${lines[0]}`));
      }
      read = frameReader((opcode, payload) => {
        if (opcode === 1) onText(payload.toString());
        else if (opcode === 9) socket.write(encodeFrame(10, payload, true));
        else if (opcode === 8) socket.end(encodeFrame(8, payload.subarray(0, 2), true));
      });
      resolve({
        send: text => socket.write(encodeFrame(1, Buffer.from(text), true)),
        close: () => socket.end(encodeFrame(8, Buffer.from([0x03, 0xe8]), true)),
      });
      if (head.length > end + 4) read(head.subarray(end + 4));
    });
  });
}

async function stdio(command, onText, onClose) {
  const { spawn } = await import('node:child_process');
  const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    pending += chunk;
    for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (line.trim()) onText(line);
    }
  });
  child.on('exit', onClose);
  child.stdin.on('error', () => child.kill());
  return { send: text => child.stdin.write(`${text}\n`), close: () => child.stdin.end() };
}

function transport({ url, token, command }, onText, onClose) {
  if (url.startsWith('unix://')) return unixSocket(url.slice('unix://'.length), onText, onClose);
  if (/^wss?:\/\//.test(url)) return webSocket(url, token, onText, onClose);
  if (url === 'stdio' || url === 'stdio://') return stdio(command ?? ['codex', 'app-server'], onText, onClose);
  throw new Error(`client_url_unsupported: ${url}`);
}

/** @type {typeof import('../client.d.ts').unsupported} */
export function unsupported(component, renderer, drawable) {
  const formats = renderer.formats ?? [];
  const reason = !drawable.includes(component.type) ? 'this renderer does not draw it'
    : component.type === 'raster' && !formats.includes('cells') ? "a raster needs the 'cells' format"
      : component.type === 'image' && !formats.some(format => ['svg', 'png', 'jpeg'].includes(format)) ? "an image needs 'svg', 'png' or 'jpeg'"
        : null;
  if (!reason) return null;
  const fallback = component.alt ?? component.text ?? component.label ?? component.type;
  return Object.assign(new Error(`unsupported_element: ${component.type} '${component.id}': ${reason}; drawing its fallback "${fallback}"`),
    { code: /** @type {const} */ ('unsupported_element'), component: component.id, fallback });
}

function rpcError(error) {
  return Object.assign(new Error(error.message), { code: error.code, data: error.data });
}

class Session {
  constructor(options) {
    this.options = options;
    this.pending = new Map();
    this.next = 1;
    this.queue = Promise.resolve();
    this.resumed = new Map();
    this.attached = null;
    this.updated = {};
    this.attachment = null;
    this.epoch = null;
    this.revision = null;
    this.actionToken = null;
    this.link = null;
    this.generation = 0;
    this.closed = false;
    this.connecting = false;
  }

  async open() {
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    this.link = await transport(this.options, text => current() && this.receive(text), () => current() && this.dropped());
    await this.call('initialize', { clientInfo: { name: this.options.name, version: '1' }, capabilities: { experimentalApi: true } });
    this.link.send(JSON.stringify({ method: 'initialized' }));
  }

  call(method, params) {
    if (!this.link) return Promise.reject(new Error('client_disconnected'));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.link.send(JSON.stringify({ id, method, params }));
    });
  }

  receive(text) {
    const message = JSON.parse(text);
    if (message.method && message.id !== undefined) return this.serve(message);
    if (message.method) return this.notification(message.method, message.params);
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.error) waiter.reject(rpcError(message.error));
    else waiter.resolve(message.result);
  }

  notification(method, params) {
    if (method === 'omd/view/updated') {
      this.track(params);
      this.options.onView?.(params);
    } else if (method === 'omd/roster/updated') this.options.onRoster?.(params.roster);
    else if (method === 'omd/surface/mirrored') this.options.onMirrored?.(params);
    else this.options.onNotification?.(method, params);
  }

  serve({ id, method, params }) {
    const { onSurfaceCall, onServerRequest } = this.options;
    const surface = method === 'omd/surface/call';
    const link = this.link;
    const generation = this.generation;
    const current = () => !this.closed && generation === this.generation && link === this.link;
    const reply = message => current() && link?.send(JSON.stringify({ id, ...message }));
    if (!surface && !onServerRequest) return;
    Promise.resolve()
      .then(() => {
        if (!current()) return;
        if (!surface) return onServerRequest(method, params);
        if (!onSurfaceCall) throw Object.assign(new Error(`unhandled surface call: ${params?.operation}`), { code: -32601 });
        return onSurfaceCall(params);
      })
      .then(result => (surface || result !== undefined) && reply({ result: result ?? null }),
        error => reply({ error: { code: Number.isInteger(error?.code) ? error.code : -32000, message: String(error?.message ?? error) } }));
  }

  track(view) {
    this.epoch = view.epoch;
    this.revision = view.revision;
    this.actionToken = view.actionToken;
  }

  dropped() {
    this.link = null;
    this.actionToken = null;
    for (const waiter of this.pending.values()) waiter.reject(new Error('client_disconnected'));
    this.pending.clear();
    if (this.connecting) return;
    if (this.closed || this.options.reconnect === false) {
      this.closed = true;
      this.options.onClose?.();
      return;
    }
    this.reconnect();
  }

  async reconnect() {
    this.connecting = true;
    const previousEpoch = this.epoch;
    for (let delay = 250; !this.closed; delay = Math.min(delay * 2, 8000)) {
      await new Promise(resolve => setTimeout(resolve, delay));
      if (this.closed) break;
      try {
        await this.open();
        if (this.closed) {
          this.generation++;
          this.link.close();
          break;
        }
        if (this.attached) await this.attach(this.attached);
        if (this.attached && Object.keys(this.updated).length) await this.call('omd/client/update', this.updated);
        for (const params of this.resumed.values()) await this.call('thread/resume', params);
        this.connecting = false;
        this.options.onReconnect?.({ epoch: this.epoch, previousEpoch });
        return;
      } catch (error) {
        this.generation++;
        this.link?.close();
        this.dropped();
        if (error instanceof Error && 'code' in error && Number.isInteger(error.code)) this.closed = true;
      }
    }
    this.connecting = false;
    this.options.onClose?.();
  }

  async attach(params = {}) {
    this.attached = { name: this.options.name, renderer: this.options.renderer, operations: this.options.operations ?? [], ...params };
    this.attachment = await this.call('omd/client/attach', this.attached);
    this.epoch = this.attachment.epoch;
    return this.attachment;
  }

  async update(params) {
    const result = await this.call('omd/client/update', params);
    const { renderer, ...rest } = params;
    if (renderer && this.attached) this.attached = { ...this.attached, renderer };
    this.updated = { ...this.updated, ...rest };
    return result;
  }

  async detach() {
    const result = await this.call('omd/client/detach', {});
    this.attached = null;
    this.updated = {};
    return result;
  }

  async read() {
    const view = await this.call('omd/view/read', {});
    this.track(view);
    return view;
  }

  event(component, event) {
    return this.call('omd/client/event', { epoch: this.epoch, component, event });
  }

  action({ component, row, value }) {
    const run = this.queue.then(async () => {
      if (!this.actionToken) await this.read();
      const sent = this.actionToken;
      try {
        const result = await this.call('omd/action', { actionToken: sent, component, row, value });
        if (this.actionToken === sent) this.actionToken = result.actionToken;
        return result;
      } catch (error) {
        if (this.link) await this.read().catch(() => {});
        throw error;
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  render(slot, props) {
    return this.call('omd/render', { slot, props });
  }

  resource(reference) {
    return this.call('omd/resource/read', { reference });
  }

  recovery(apply) {
    return apply ? this.call('omd/recovery/apply', apply) : this.call('omd/recovery/read', {});
  }

  async request(method, params) {
    const result = await this.call(method, params);
    if (method === 'thread/resume') this.resumed.set(params.threadId, params);
    if (method === 'thread/unsubscribe') this.resumed.delete(params.threadId);
    return result;
  }

  close() {
    this.closed = true;
    if (this.link) this.link.close();
    else if (!this.connecting) this.options.onClose?.();
  }
}

/** @type {typeof import('../client.d.ts').connect} */
export async function connect(options) {
  const session = new Session(options);
  session.connecting = true;
  try {
    await session.open();
    await session.attach();
  } catch (error) {
    session.closed = true;
    session.link?.close();
    throw error;
  } finally {
    session.connecting = false;
  }
  return session;
}
