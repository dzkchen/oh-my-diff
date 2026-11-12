import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const mac = platform() === 'darwin';
const support = mac ? join(homedir(), 'Library/Application Support') : process.env.XDG_CONFIG_HOME || join(homedir(), '.config');

export const USER_PROFILES = mac
  ? ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Canary', 'Chromium', 'BraveSoftware/Brave-Browser', 'Microsoft Edge', 'Arc/User Data', 'Vivaldi', 'net.imput.helium']
  : ['google-chrome', 'google-chrome-beta', 'chromium', 'BraveSoftware/Brave-Browser', 'microsoft-edge', 'vivaldi'];

const BINARIES = mac
  ? ['Google Chrome', 'Google Chrome Beta', 'Google Chrome Canary', 'Chromium', 'Brave Browser', 'Microsoft Edge'].map(app => `/Applications/${app}.app/Contents/MacOS/${app}`)
  : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/brave-browser', '/usr/bin/microsoft-edge'];

function activePort(dir) {
  try {
    const [port, path] = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n');
    return port && path ? `ws://127.0.0.1:${port.trim()}${path.trim()}` : null;
  } catch {
    return null;
  }
}

export function userEndpoints() {
  return USER_PROFILES.map(name => ({ name, url: activePort(join(support, name)) })).filter(entry => entry.url);
}

export function findBrowser() {
  const configured = process.env.OMD_BROWSE_BROWSER;
  if (configured) return existsSync(configured) ? configured : null;
  return BINARIES.find(existsSync) ?? null;
}

export async function launchManaged(dataDir, { headless }) {
  const binary = findBrowser();
  if (!binary) throw new Error('No Chromium browser found; set OMD_BROWSE_BROWSER to its executable');
  const profile = join(dataDir, 'profile');
  mkdirSync(profile, { recursive: true });
  rmSync(join(profile, 'DevToolsActivePort'), { force: true });
  const args = [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-features=Translate', 'about:blank'];
  if (headless) args.unshift('--headless=new');
  const child = spawn(binary, args, { stdio: 'ignore', detached: !headless });
  if (!headless) child.unref();
  for (let waited = 0; waited < 15000; waited += 100) {
    const url = activePort(profile);
    if (url) return { url, child };
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error(`${binary} did not open a DevTools port`);
}

export class Connection {
  constructor(socket) {
    this.socket = socket;
    this.next = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    socket.addEventListener('message', event => this.receive(JSON.parse(String(event.data))));
    socket.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('Browser connection closed'));
      this.pending.clear();
      for (const listener of this.listeners) listener({ method: 'closed' });
    });
  }

  static open(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('timeout'));
      }, timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new Connection(socket));
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('refused'));
      }, { once: true });
    });
  }

  receive(message) {
    if (message.id === undefined) {
      for (const listener of this.listeners) listener(message);
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
    else entry.resolve(message.result);
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error('Browser connection closed'));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.socket.close();
  }
}
