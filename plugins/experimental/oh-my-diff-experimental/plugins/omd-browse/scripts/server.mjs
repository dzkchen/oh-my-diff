import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Browser, sleep } from './browser.mjs';
import { Live } from './live.mjs';
import { Secrets } from './secrets.mjs';
import { Shell } from './shell.mjs';
import { Sites } from './sites.mjs';
import { parseLine } from './text.mjs';

const VERSION = '0.3.0';
const env = process.env;
const DATA = env.OMD_BROWSE_DATA || join(env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'omd-browse');
const HEADLESS = env.OMD_BROWSE_HEADLESS === '1';
const ALLOW = (env.OMD_BROWSE_ALLOW || '').split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean);
const IDLE_MS = Number(env.OMD_BROWSE_IDLE_MINUTES || 15) * 60000;

function allowed(url) {
  if (!ALLOW.length) return true;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (['about:', 'data:', 'blob:'].includes(parsed.protocol)) return true;
  const host = parsed.host.toLowerCase();
  const name = parsed.hostname.toLowerCase();
  return ALLOW.some(entry => {
    const bare = entry.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return parsed.origin === entry || host === bare || name === bare || name.endsWith(`.${bare}`);
  });
}
allowed.active = ALLOW.length > 0;

const secrets = new Secrets(DATA);

async function hidden(prompt) {
  process.stderr.write(prompt);
  if (!process.stdin.isTTY) {
    for await (const line of createInterface({ input: process.stdin })) return line;
    return '';
  }
  process.stdin.setRawMode(true);
  let value = '';
  for await (const chunk of process.stdin) {
    for (const char of String(chunk)) {
      if (char === '\r' || char === '\n') {
        process.stdin.setRawMode(false);
        process.stderr.write('\n');
        return value;
      }
      if (char === '\u0003') process.exit(130);
      value = char === '\u007f' ? value.slice(0, -1) : value + char;
    }
  }
  return value;
}

async function cli(args) {
  const [area, action, name, ...rest] = args;
  const usage = 'secret add NAME --origin https://site [--origin …] [--totp] | secret list | secret rm NAME';
  if (area !== 'secret') throw new Error(usage);
  if (action === 'list') {
    for (const [key, entry] of Object.entries(secrets.list())) console.log(`${entry.totp ? 'totp' : 'secret'}:${key}  ${entry.origins.join(' ')}`);
    return;
  }
  if (action === 'rm') {
    console.log(secrets.remove(name) ? `Removed ${name}` : `No secret ${name}`);
    return;
  }
  if (action !== 'add' || !name) throw new Error(usage);
  const origins = rest.flatMap((word, index) => word === '--origin' ? [rest[index + 1]] : []).filter(Boolean);
  if (!origins.length) throw new Error('Give at least one --origin');
  const totp = rest.includes('--totp');
  const value = await hidden(totp ? 'TOTP seed (base32): ' : 'Value: ');
  if (!value) throw new Error('No value given');
  secrets.add(name, origins, value, totp);
  console.log(`Saved ${totp ? 'totp' : 'secret'}:${name} for ${origins.join(', ')}`);
}

function serve() {
  const browser = new Browser({ data: DATA, mode: env.OMD_BROWSE_MODE || 'auto', headless: HEADLESS, allowed, connectMs: Number(env.OMD_BROWSE_CONNECT_SECONDS || 60) * 1000 });
  const live = new Live(browser, join(DATA, 'live'));
  const write = message => process.stdout.write(`${JSON.stringify(message)}\n`);
  const asked = new Map();
  let nextAsk = 1;
  let elicits = false;
  const confirm = (message, signal) => {
    if (!elicits) return null;
    const id = `omd-${nextAsk++}`;
    write({ jsonrpc: '2.0', id, method: 'elicitation/create', params: { message, requestedSchema: { type: 'object', properties: {} } } });
    return new Promise(resolve => {
      const done = action => {
        asked.delete(id);
        resolve(action);
      };
      asked.set(id, done);
      signal?.addEventListener('abort', () => {
        write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'no longer needed' } });
        done('cancel');
      }, { once: true });
    });
  };
  const shell = new Shell({ browser, sites: new Sites(DATA), secrets, data: DATA, allowed, confirm });
  const tool = {
    name: 'browse',
    description: 'Use a real browser as a command line. Pages become man pages: `open URL` prints the outline, forms as commands with flags, tables and learned site APIs. Read with cat/ls/grep/links/table; act with click/fill/press or a form command (`search --q x`, `login --help`); actions print only what changed. `api` calls endpoints learned from what sites fetched, with the user\'s session. Chain with ";", filter with "| grep|head|tail|json". `ask REASON` hands sign-ins, 2FA, payments and CAPTCHAs to the user. `help` lists every command.',
    inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'A command line, such as `open news.ycombinator.com; cat | head 20`' } }, required: ['command'] },
    annotations: { openWorldHint: true },
  };

  const running = new Map();
  let queue = Promise.resolve();

  const handle = message => {
    const { id, method, params = {} } = message;
    if (method === undefined && asked.has(id)) {
      asked.get(id)(message.result?.action ?? 'cancel');
      return;
    }
    if (method === 'notifications/cancelled') {
      running.get(params.requestId)?.abort();
      return;
    }
    if (id === undefined) return;
    if (method === 'initialize') {
      elicits = !!params.capabilities?.elicitation;
      live.start();
    }
    if (method === 'initialize') write({ jsonrpc: '2.0', id, result: { protocolVersion: params.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'omd_browse', version: VERSION } } });
    else if (method === 'ping') write({ jsonrpc: '2.0', id, result: {} });
    else if (method === 'tools/list') write({ jsonrpc: '2.0', id, result: { tools: [tool] } });
    else if (method === 'tools/call') {
      const controller = new AbortController();
      running.set(id, controller);
      const command = String(params.arguments?.command ?? '');
      const run = async () => {
        if (params.name !== 'browse') throw new Error(`Unknown tool ${params.name}`);
        if (controller.signal.aborted) throw new Error('Cancelled');
        live.touch();
        return shell.exec(command, controller.signal);
      };
      const job = queue.then(run).then(
        result => write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result.text }, ...result.images.filter(Boolean).map(data => ({ type: 'image', data, mimeType: 'image/jpeg' }))], isError: !!result.error } }),
        error => write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error: ${error.message}` }], isError: true } }),
      ).finally(() => running.delete(id));
      const parsed = (() => {
        try {
          return parseLine(command);
        } catch {
          return [];
        }
      })();
      queue = parsed.length === 1 && parsed[0].length === 1 && ['ask', 'adopt'].includes(parsed[0][0][0]) ? queue : job;
    } else write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method ${method}` } });
  };

  const idle = setInterval(() => {
    if (browser.conn) browser.closeOwned(tab => !tab.handoff && !tab.recording && Date.now() - tab.lastUsed > IDLE_MS).catch(() => {});
  }, 60000);
  idle.unref();

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    live.stop();
    for (const tab of browser.tabs.values()) if (tab.recording) await browser.stopRecording(tab).catch(() => {});
    await Promise.race([browser.closeOwned(), sleep(2000)]).catch(() => {});
    browser.conn?.close();
    if (HEADLESS && browser.child && browser.child.exitCode === null) {
      browser.child.kill();
      await Promise.race([new Promise(resolve => browser.child.once('exit', resolve)), sleep(3000)]);
    }
    process.exit(0);
  };

  createInterface({ input: process.stdin }).on('line', line => {
    if (!line.trim()) return;
    try {
      handle(JSON.parse(line));
    } catch (error) {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: error.message } });
    }
  }).on('close', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[2]) {
  cli(process.argv.slice(2)).then(() => process.exit(0), error => {
    console.error(error.message);
    process.exit(1);
  });
} else serve();
