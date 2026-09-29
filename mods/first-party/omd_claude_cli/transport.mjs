import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { translateRequest, responseEvents } from './index.ts';

const file = fileURLToPath(import.meta.url);
const models = new Set(['claude-sonnet-5', 'claude-haiku-4-5-20251001']);
const overrides = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'ANTHROPIC_FOUNDRY_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_API_KEY',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];

export function checkCli(claude, home = process.env.HOME, username = process.env.USER) {
  const conflicts = overrides.filter(name => process.env[name]);
  if (conflicts.length) throw new Error(`conflicting_api_or_cloud_overrides:${conflicts.join(',')}`);
  const version = spawnSync(claude, ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (version.status !== 0 || version.stdout.trim() !== '2.1.281 (Claude Code)') {
    throw new Error('claude_cli_2.1.281_required');
  }
  const probe = spawnSync(claude, ['auth', 'status'], { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, HOME: home, USER: username, LOGNAME: username } });
  let status;
  try { status = JSON.parse(probe.stdout); } catch { status = {}; }
  if (probe.status !== 0 || status.loggedIn !== true || status.authMethod !== 'claude.ai' ||
      status.apiProvider !== 'firstParty' || !['pro', 'max'].includes(status.subscriptionType)) {
    throw new Error('claude_ai_pro_or_max_login_required');
  }
}

async function bodyOf(request, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('request_size_limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export class Capture {
  constructor(onEvent = () => {}) {
    this.pending = '';
    this.decoder = new TextDecoder();
    this.message = null;
    this.complete = false;
    this.arguments = new Map();
    this.onEvent = onEvent;
  }
  feed(chunk) {
    this.pending += this.decoder.decode(chunk, { stream: true });
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.pending);
      if (!match) break;
      const frame = this.pending.slice(0, match.index);
      this.pending = this.pending.slice(match.index + match[0].length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (data) this.event(JSON.parse(data));
    }
  }
  event(event) {
    if (event.type === 'message_start') {
      if (this.message) throw new Error('multiple_claude_messages');
      this.message = structuredClone(event.message);
      this.onEvent({ type: 'response.created', response: { id: this.message.id } });
    }
    if (!this.message) return;
    if (event.type === 'content_block_start') {
      const block = structuredClone(event.content_block);
      this.message.content.push(block);
      if (block.type === 'text') {
        const item = { type: 'message', id: `${this.message.id}-text-${event.index}`, role: 'assistant', content: [] };
        this.onEvent({ type: 'response.output_item.added', item });
        if (block.text) this.onEvent({ type: 'response.output_text.delta', delta: block.text });
      }
    }
    if (event.type === 'content_block_delta') {
      const block = this.message.content[event.index];
      const delta = event.delta;
      const field = { text_delta: 'text', thinking_delta: 'thinking', signature_delta: 'signature' }[delta.type];
      if (field) block[field] = (block[field] ?? '') + delta[field];
      if (delta.type === 'text_delta') this.onEvent({ type: 'response.output_text.delta', delta: delta.text });
      if (delta.type === 'input_json_delta') this.arguments.set(event.index,
        (this.arguments.get(event.index) ?? '') + delta.partial_json);
    }
    if (event.type === 'content_block_stop') {
      const block = this.message.content[event.index];
      if (this.arguments.has(event.index)) {
        const raw = this.arguments.get(event.index);
        block.input = raw.trim() ? JSON.parse(raw) : {};
        this.arguments.delete(event.index);
      }
      if (block.type === 'text') this.onEvent({ type: 'response.output_item.done',
        item: { type: 'message', id: `${this.message.id}-text-${event.index}`, role: 'assistant',
          content: [{ type: 'output_text', text: block.text ?? '' }] } });
    }
    if (event.type === 'message_delta') {
      Object.assign(this.message, event.delta ?? {});
      Object.assign(this.message.usage, event.usage ?? {});
    }
    if (event.type === 'message_stop') this.complete = Boolean(this.message.stop_reason) && !this.arguments.size;
  }
}

export class Relay {
  constructor(upstream, onEvent = () => {}) {
    this.upstream = new URL(upstream);
    this.prefix = `/admit/${randomBytes(24).toString('base64url')}`;
    this.used = 0;
    this.denied = 0;
    this.status = null;
    this.requestId = null;
    this.failure = null;
    this.error = '';
    this.capture = new Capture(onEvent);
    this.sockets = new Set();
    this.server = createServer((request, response) => this.handle(request, response));
  }
  async listen() {
    await new Promise(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${this.server.address().port}${this.prefix}`;
  }
  abort() {
    for (const socket of this.sockets) socket.destroy();
    if (this.server.listening) {
      this.server.closeAllConnections();
      this.server.close();
    }
  }
  async handle(request, response) {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method !== 'POST' || url.pathname !== `${this.prefix}/v1/messages` || request.headers.origin) {
      response.writeHead(404).end();
      return;
    }
    if (this.used) {
      this.denied++;
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({
        type: 'error', error: { type: 'invalid_request_error', message: 'OMD_MODEL_ADMISSION_CONSUMED' }
      }));
      return;
    }
    this.used = 1;
    this.sockets.add(request.socket);
    try {
      const payload = await bodyOf(request, 8 * 1024 * 1024);
      const target = new URL('/v1/messages', this.upstream);
      const headers = { ...request.headers, 'accept-encoding': 'identity' };
      for (const key of ['host', 'connection', 'content-length', 'transfer-encoding', 'proxy-authorization', 'proxy-connection']) delete headers[key];
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
      await new Promise((resolve, reject) => {
        const upstream = send(target, { method: 'POST', headers, timeout: 180000 }, incoming => {
          this.status = incoming.statusCode;
          this.requestId = incoming.headers['request-id'] ?? incoming.headers['x-request-id'] ?? null;
          const forwarded = { ...incoming.headers, connection: 'close' };
          for (const key of ['transfer-encoding', 'server', 'date']) delete forwarded[key];
          response.writeHead(incoming.statusCode, forwarded);
          incoming.on('data', chunk => {
            try {
              if (incoming.statusCode === 200) this.capture.feed(chunk);
              else if (this.error.length < 65536) this.error += chunk.toString('utf8');
              response.write(chunk);
            } catch {
              this.failure = 'invalid_upstream_stream';
              incoming.destroy(new Error('invalid_upstream_stream'));
            }
          });
          incoming.on('end', () => { response.end(); resolve(); });
          incoming.on('error', reject);
          incoming.on('close', () => { if (!incoming.complete) reject(new Error('upstream_closed')); });
        });
        this.sockets.add(upstream);
        upstream.on('timeout', () => upstream.destroy(new Error('upstream_timeout')));
        upstream.on('error', reject);
        upstream.end(payload);
      });
    } catch (error) {
      this.failure = error?.constructor?.name ?? 'relay_error';
      response.destroy();
    } finally {
      this.sockets.delete(request.socket);
    }
  }
}

function eventQueue(child) {
  const values = [];
  let waiting = null;
  const push = value => {
    if (waiting) { const receive = waiting; waiting = null; receive(value); }
    else values.push(value);
  };
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try { push(JSON.parse(line)); }
    catch { push(new Error('invalid_claude_stream_json')); }
  });
  lines.on('close', () => push(null));
  return async () => values.length ? values.shift() : await new Promise(resolve => { waiting = resolve; });
}

function cancelChild(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
}

export async function runClaude(request, model, claude, signal, onEvent,
                                upstream = 'https://api.anthropic.com', home = process.env.HOME,
                                username = process.env.USER, translated = null) {
  if (signal.aborted) throw new Error('claude_request_cancelled');
  translated ??= translateRequest(request, model);
  const root = await mkdtemp('/private/tmp/omd-claude-');
  const relay = new Relay(upstream, onEvent);
  let child;
  const cancel = () => { cancelChild(child); relay.abort(); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    await relay.listen();
    await writeFile(join(root, 'tools.json'), JSON.stringify(translated.manifest));
    await writeFile(join(root, 'settings.json'), JSON.stringify({ env: {
      CLAUDE_CODE_EXTRA_BODY: JSON.stringify(translated.extra) } }));
    await writeFile(join(root, 'system.md'), translated.system);
    const mcp = { mcpServers: { omd: { command: process.execPath,
      args: [file, 'inert', join(root, 'tools.json')] } } };
    const argv = ['-p', '--model', model === 'claude-sonnet-5' ? `${model}[1m]` : model,
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--tools', '', '--system-prompt-file', join(root, 'system.md'),
      '--settings', join(root, 'settings.json'), '--setting-sources', '', '--strict-mcp-config',
      '--disable-slash-commands', '--max-turns', '1', '--permission-mode', 'dontAsk',
      '--no-session-persistence', '--mcp-config', JSON.stringify(mcp)];
    const env = { ...process.env, HOME: home, USER: username, LOGNAME: username, TMPDIR: root,
      ANTHROPIC_BASE_URL: relay.url,
      ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_MAX_RETRIES: '0', DISABLE_AUTO_COMPACT: '1', DISABLE_COMPACT: '1',
      CLAUDE_CODE_TOTAL_TOKENS_REMINDER: 'off' };
    delete env.OMD_CLAUDE_LOCAL_TOKEN;
    delete env.OMD_READY_TOKEN;
    if (translated.extra.max_tokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(translated.extra.max_tokens);
    child = spawn(claude, argv, { cwd: root, env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const exited = new Promise(resolve => child.once('close', resolve));
    const next = eventQueue(child);
    for (const [index, source] of translated.frames.entries()) {
      const frame = structuredClone(source);
      if (frame.type === 'user' && index < translated.frames.length - 1) frame.shouldQuery = false;
      child.stdin.write(`${JSON.stringify(frame)}\n`);
      if (frame.shouldQuery === false) {
        for (;;) {
          const answer = await next();
          if (answer === null) throw new Error('claude_history_replay_exited');
          if (answer instanceof Error) throw answer;
          if (answer.type === 'result') {
            if (answer.num_turns !== 0 || answer.is_error) throw new Error('claude_history_replay_failed');
            break;
          }
        }
      }
    }
    child.stdin.end();
    const assistants = [];
    const results = [];
    let stopped = false;
    for (;;) {
      const event = await next();
      if (event === null) break;
      if (event instanceof Error) throw event;
      if (event.type === 'assistant' && !event.error && !event.message?.error) assistants.push(event.message);
      if (event.type === 'result') results.push(event);
      if (event.type === 'stream_event' && event.event?.type === 'message_stop') stopped = true;
    }
    await exited;
    if (signal.aborted) throw new Error('claude_request_cancelled');
    if (relay.used !== 1 || relay.status !== 200 || !relay.capture.complete) {
      throw new Error(`claude_upstream_incomplete:${relay.status ?? 'no_request'}:${relay.failure ?? 'none'}`);
    }
    if (results.length !== 1 || !assistants.length || !stopped) throw new Error('claude_result_incomplete');
    const admission = { upstream_requests: relay.used, blocked_requests: relay.denied,
      request_id: relay.requestId };
    return responseEvents(relay.capture.message, admission, model, translated.reverse, true);
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    await rm(root, { recursive: true, force: true });
  }
}

async function inert(path) {
  const tools = JSON.parse(await readFile(path, 'utf8'));
  for await (const line of createInterface({ input: process.stdin })) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    let result = {};
    if (row.method === 'initialize') result = { protocolVersion: '2024-11-05',
      capabilities: { tools: {} }, serverInfo: { name: 'omd-inert-inventory', version: '1' } };
    if (row.method === 'tools/list') result = { tools };
    if (row.method === 'tools/call') result = { isError: true,
      content: [{ type: 'text', text: 'Denied: only the OMD host executes tools.' }] };
    if ('id' in row) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: row.id, result })}\n`);
  }
}

async function serve(port, model, claude, home, username, maxRequests) {
  if (!models.has(model)) throw new Error('unsupported_claude_model');
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 8) throw new Error('claude_task_request_limit_must_be_1_to_8');
  checkCli(claude, home, username);
  const localToken = process.env.OMD_CLAUDE_LOCAL_TOKEN ?? '';
  const readyToken = process.env.OMD_READY_TOKEN ?? '';
  if (localToken.length < 32 || !readyToken) throw new Error('native_provider_tokens_required');
  const active = new Set();
  let admitted = 0;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/_omd/ready') {
      response.writeHead(200).end(`OMD_READY:${readyToken}`);
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/responses') { response.writeHead(404).end(); return; }
    if (request.headers.authorization !== `Bearer ${localToken}`) { response.writeHead(401).end(); return; }
    let payload;
    let translated;
    try { payload = JSON.parse(await bodyOf(request, 8 * 1024 * 1024)); translated = translateRequest(payload, model); }
    catch { response.writeHead(400).end('invalid_claude_request'); return; }
    if (admitted >= maxRequests) { response.writeHead(429).end('claude_task_request_limit'); return; }
    admitted++;
    const controller = new AbortController();
    active.add(controller);
    response.on('close', () => controller.abort());
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    try {
      const send = event => response.write(`data: ${JSON.stringify(event)}\n\n`);
      const events = await runClaude(payload, model, claude, controller.signal, send,
        undefined, home, username, translated);
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (error) {
      const code = String(error?.message ?? 'claude_transport_failed').replace(/[^\w:.-]/g, '_').slice(0, 200);
      if (!response.destroyed) response.write(`data: ${JSON.stringify({ type: 'response.failed', response: { error: { code, message: code } } })}\n\n`);
    } finally {
      active.delete(controller);
      response.end();
    }
  });
  const stop = () => { for (const controller of active) controller.abort(); server.close(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
}

if (process.argv[1] === file) {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'inert') await inert(args[0]);
  else if (action === 'status') checkCli(args[0]);
  else if (action === 'serve') await serve(Number(args[0]), args[1], args[2], args[3], args[4], Number(args[5]));
  else throw new Error('unsupported_claude_transport_action');
}
