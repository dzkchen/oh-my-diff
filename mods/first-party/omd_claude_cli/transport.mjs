import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_ENV_OVERRIDE, CLI_INSTALL, CLI_MINIMUM, cliSupported, translateRequest, responseEvents, reasoningItem } from './index.ts';

const file = fileURLToPath(import.meta.url);
const PLANS = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise' };
const BODY_LIMIT = 64 * 1024 * 1024;
const CLI_DEADLINE_MS = 30 * 60_000;

export function cliEnv(values = {}) {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !CLI_ENV_OVERRIDE.test(name))), ...values };
}

export const accountEnv = account => account?.config_dir ? { CLAUDE_CONFIG_DIR: account.config_dir } : {};
export const loginHint = (billing, account) => `\`/claude login${billing === 'api' ? ' api' : ''}${account && account.name !== 'default' ? ` ${account.name}` : ''}\``;

export function checkCli(claude, billing = 'subscription', home = process.env.HOME, username = process.env.USER, account = null) {
  checkVersion(claude);
  return checkAuth(claude, billing, home, username, account);
}

function checkVersion(claude) {
  const version = spawnSync(claude, ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (version.status !== 0 || !cliSupported(version.stdout)) {
    throw new Error(`claude_cli_unsupported: ${CLI_MINIMUM} or a newer 2.x is required; run claude update (or ${CLI_INSTALL})`);
  }
}

function checkAuth(claude, billing, home, username, account) {
  const probe = spawnSync(claude, ['auth', 'status'], { encoding: 'utf8', timeout: 10000,
    env: cliEnv({ HOME: home, USER: username, LOGNAME: username, ...accountEnv(account) }) });
  let status;
  try { status = JSON.parse(probe.stdout); } catch { status = {}; }
  const signedIn = probe.status === 0 && status.loggedIn === true && status.apiProvider === 'firstParty';
  if (billing === 'api') {
    if (!signedIn || status.authMethod !== 'api_key' || status.apiKeySource !== '/login managed key') {
      throw new Error(`claude_console_api_key_login_required: run ${loginHint(billing, account)}`);
    }
  } else if (!signedIn || status.authMethod !== 'claude.ai' || !PLANS[status.subscriptionType]) {
    throw new Error(`claude_ai_subscription_login_required: run ${loginHint(billing, account)}`);
  }
  return status;
}

export function providerNote(billing, plan, headers = {}, extraUsage = true) {
  if (billing === 'api') return 'Anthropic API credits (Console); no plan limits; balance: console.anthropic.com/settings/billing';
  const overage = headers['anthropic-ratelimit-unified-overage-status'];
  const state = usingOverage(headers) ? 'in use' : ['allowed', 'allowed_warning'].includes(overage) ? 'on'
    : overage === 'rejected' ? 'off' : 'unknown';
  return `Claude ${PLANS[plan] ?? 'subscription'} plan limits; extra usage ${state}${extraUsage ? '' : ', OMD stops at it'}; claude.ai/settings/usage`;
}

export function usingOverage(headers) {
  return headers['anthropic-ratelimit-unified-overage-in-use'] === 'true' ||
    (headers['anthropic-ratelimit-unified-status'] === 'rejected' &&
      ['allowed', 'allowed_warning'].includes(headers['anthropic-ratelimit-unified-overage-status']));
}

const cliEnvironment = /^# Environment\nYou have been invoked in the following environment: /;
const reminderOpen = '<system-reminder>\nAs you answer the user\'s questions, you can use the following context:\n';
const reminderMark = 'Claude Code attached this context automatically;';
const reminderClose = '</system-reminder>';

// The CLI adds its own temp-directory environment and account context; OMD's history already carries the session's.
export function withoutCliContext(body) {
  const cut = text => {
    const close = text.lastIndexOf(reminderClose);
    if (close < 0 || text.slice(close + reminderClose.length).trim()) return text;
    const previous = close ? text.lastIndexOf(reminderClose, close - 1) : -1;
    const start = text.indexOf(reminderOpen, previous < 0 ? 0 : previous + reminderClose.length);
    const mark = text.lastIndexOf(reminderMark, close - reminderMark.length);
    return start >= 0 && mark >= start + reminderOpen.length ? text.slice(0, start).trimEnd() : text;
  };
  const strip = block => {
    if (typeof block.text === 'string') block.text = cut(block.text);
    if (typeof block.content === 'string') block.content = cut(block.content);
    else if (Array.isArray(block.content)) {
      block.content.forEach(strip);
      block.content = block.content.filter(child => child.type !== 'text' || child.text);
    }
  };
  if (!Array.isArray(body.messages)) return body;
  body.messages.forEach(strip);
  body.messages = body.messages.filter(message => message.content?.length !== 0 && !(message.role === 'system' && (typeof message.content === 'string'
    ? cliEnvironment.test(message.content) : message.content?.some?.(block => cliEnvironment.test(block.text ?? '')))));
  return body;
}

async function bodyOf(request, limit = BODY_LIMIT) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('request_size_limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Maps the subscription's unified 5-hour and 7-day windows onto a `claude` rate-limit header family for /status.
export function limitHeaders(headers, note) {
  const out = { 'x-claude-limit-name': 'Claude', 'x-omd-provider-note': note };
  for (const [window, slot, minutes] of [['5h', 'primary', 300], ['7d', 'secondary', 10080]]) {
    const used = Number(headers[`anthropic-ratelimit-unified-${window}-utilization`]);
    if (headers[`anthropic-ratelimit-unified-${window}-utilization`] == null || !Number.isFinite(used)) continue;
    out[`x-claude-${slot}-used-percent`] = String(Math.round(used * 10000) / 100);
    out[`x-claude-${slot}-window-minutes`] = String(minutes);
    const reset = Number(headers[`anthropic-ratelimit-unified-${window}-reset`]);
    if (Number.isFinite(reset) && reset > 0) out[`x-claude-${slot}-reset-at`] = String(Math.round(reset));
  }
  return out;
}

function resetAt(headers, window) {
  const reset = Number(headers[`anthropic-ratelimit-unified-${window}-reset`] ?? headers['anthropic-ratelimit-unified-reset']);
  return Number.isFinite(reset) && reset > 0 ? reset * 1000 : null;
}

function resetText(headers, window) {
  const reset = resetAt(headers, window);
  return reset ? `; resets ${new Date(reset).toISOString()}` : '';
}

function overageWindow(headers) {
  return headers['anthropic-ratelimit-unified-representative-claim']?.startsWith('seven_day') ? '7d' : '5h';
}

// After a response reports extra usage, later requests stay stopped until the reported reset; without a usable reset they stay stopped until the provider restarts or extra_usage is enabled.
export function stoppedForExtraUsage(headers, now = Date.now()) {
  if (!usingOverage(headers)) return false;
  const reset = resetAt(headers, overageWindow(headers));
  return reset === null || reset > now;
}

export function extraUsageStop(headers) {
  const until = resetAt(headers, overageWindow(headers)) ? 'that reset' : 'the provider restarts or extra_usage is on';
  return { code: 'claude_extra_usage_blocked', message: `Claude plan limit reached and this request was served from extra usage${resetText(headers, overageWindow(headers))}. omd_claude_cli has extra_usage off, so OMD stopped and sends no further requests until ${until}; Anthropic may still bill this one request. Extra usage itself is controlled at claude.ai/settings/usage.` };
}

export function upstreamFailure(status, headers, body, billing = 'subscription', account = null) {
  const kind = headers['anthropic-ratelimit-unified-representative-claim'];
  if (status === 429 || (status !== 200 && headers['anthropic-ratelimit-unified-status'] === 'rejected')) {
    const overage = headers['anthropic-ratelimit-unified-overage-status'] === 'rejected'
      ? `; extra usage unavailable (${headers['anthropic-ratelimit-unified-overage-disabled-reason'] ?? 'not enabled'})` : '';
    return { code: 'rate_limit_exceeded', message: `Claude ${kind ?? (billing === 'api' ? 'API' : 'subscription')} limit reached${resetText(headers, overageWindow(headers))}${overage}` };
  }
  if (status === 400 && /prompt is too long/i.test(body)) {
    return { code: 'context_length_exceeded', message: 'Claude prompt is too long for the model context window' };
  }
  if (billing === 'api' && status === 400 && /credit balance is too low/i.test(body)) {
    return { code: 'claude_api_credits_exhausted', message: 'Anthropic API credit balance is too low. OMD never falls back to your subscription; purchased credits and auto-reload are managed at console.anthropic.com/settings/billing.' };
  }
  const login = loginHint(billing, account);
  if (status === 401 || (status === 403 && /oauth|revoked|authentication/i.test(body))) {
    return { code: 'claude_login_expired', message: billing === 'api'
      ? `Anthropic API key was rejected; run ${login} and retry`
      : `Claude login expired or was revoked; run ${login} and retry` };
  }
  if ((status === 403 || status === 404) && /model/i.test(body)) {
    return { code: 'claude_model_not_entitled', message: `Claude refused this model for your account (${status}); pick another model with /model, or run ${login} to sign in to an account that has it (${billing === 'api' ? 'Console workspace: console.anthropic.com' : 'plan: claude.ai/settings'})` };
  }
  return null;
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
  id(index, kind) {
    return `${this.message.id}-${kind}-${index}`;
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
      this.message.content[event.index] = block;
      if (block.type === 'text') {
        this.onEvent({ type: 'response.output_item.added',
          item: { type: 'message', id: this.id(event.index, 'text'), role: 'assistant', content: [] } });
        if (block.text) this.onEvent({ type: 'response.output_text.delta', delta: block.text });
      }
      if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        this.onEvent({ type: 'response.output_item.added',
          item: { type: 'reasoning', id: this.id(event.index, 'reasoning'), summary: [] } });
        if (block.type === 'thinking') this.onEvent({ type: 'response.reasoning_summary_part.added',
          item_id: this.id(event.index, 'reasoning'), summary_index: 0 });
      }
    }
    if (event.type === 'content_block_delta') {
      const block = this.message.content[event.index];
      const delta = event.delta;
      const field = { text_delta: 'text', thinking_delta: 'thinking', signature_delta: 'signature' }[delta.type];
      if (field) block[field] = (block[field] ?? '') + delta[field];
      if (delta.type === 'text_delta') this.onEvent({ type: 'response.output_text.delta', delta: delta.text });
      if (delta.type === 'thinking_delta') this.onEvent({ type: 'response.reasoning_summary_text.delta',
        item_id: this.id(event.index, 'reasoning'), summary_index: 0, delta: delta.thinking });
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
        item: { type: 'message', id: this.id(event.index, 'text'), role: 'assistant',
          content: [{ type: 'output_text', text: block.text ?? '' }] } });
      if (block.type === 'thinking' || block.type === 'redacted_thinking') this.onEvent({
        type: 'response.output_item.done', item: reasoningItem(block, this.id(event.index, 'reasoning')) });
    }
    if (event.type === 'message_delta') {
      Object.assign(this.message, event.delta ?? {});
      Object.assign(this.message.usage, event.usage ?? {});
    }
    if (event.type === 'message_stop') this.complete = Boolean(this.message.stop_reason) && !this.arguments.size;
  }
}

export class Relay {
  constructor(upstream, onEvent = () => {}, onHeaders = () => {}, policy = {}) {
    this.policy = { billing: 'subscription', extraUsage: true, ...policy };
    this.refusal = null;
    this.upstream = new URL(upstream);
    this.prefix = `/admit/${randomBytes(24).toString('base64url')}`;
    this.used = 0;
    this.denied = 0;
    this.status = null;
    this.headers = {};
    this.requestId = null;
    this.failure = null;
    this.error = '';
    this.capture = new Capture(onEvent);
    this.onHeaders = onHeaders;
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
      const body = JSON.parse(await bodyOf(request));
      const api = this.policy.billing === 'api';
      if (api ? !request.headers['x-api-key'] || request.headers.authorization
        : !/^Bearer /.test(request.headers.authorization ?? '') || request.headers['x-api-key']) {
        this.refusal = { code: 'claude_billing_route_mismatch', message: `The Claude CLI did not authenticate with the selected ${api ? 'Console API key' : 'claude.ai subscription'}; OMD sent nothing upstream. Run \`/claude login\` (or \`/claude login api\`) to choose the billing source again.` };
      } else if (this.policy.model && body.model !== this.policy.model) {
        this.refusal = { code: 'claude_model_mismatch', message: `The Claude CLI asked for a model other than ${this.policy.model}; OMD sent nothing upstream.` };
      }
      if (this.refusal) {
        response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({
          type: 'error', error: { type: 'invalid_request_error', message: this.refusal.code } }));
        return;
      }
      const target = new URL('/v1/messages', this.upstream);
      const headers = { ...request.headers, 'accept-encoding': 'identity' };
      for (const key of ['host', 'connection', 'content-length', 'transfer-encoding', 'proxy-authorization', 'proxy-connection']) delete headers[key];
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
      await new Promise((resolve, reject) => {
        const upstream = send(target, { method: 'POST', headers, timeout: 600000 }, incoming => {
          this.status = incoming.statusCode;
          this.headers = incoming.headers;
          this.requestId = incoming.headers['request-id'] ?? incoming.headers['x-request-id'] ?? null;
          this.onHeaders(incoming.statusCode, incoming.headers);
          if (!this.policy.extraUsage && usingOverage(incoming.headers)) {
            this.refusal = extraUsageStop(incoming.headers);
            incoming.destroy();
            response.destroy();
            resolve();
            return;
          }
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
        upstream.end(JSON.stringify(withoutCliContext(body)));
      });
    } catch (error) {
      this.failure = error?.constructor?.name ?? 'relay_error';
      response.destroy();
    } finally {
      this.sockets.delete(request.socket);
    }
  }
}

export function eventQueue(child) {
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

export function cliArgs(entry, effort) {
  const argv = ['-p', '--model', entry.cli, '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--include-partial-messages', '--tools', '', '--setting-sources', '', '--strict-mcp-config',
    '--disable-slash-commands', '--max-turns', '1', '--permission-mode', 'dontAsk', '--no-session-persistence'];
  if (entry.efforts.includes(effort)) argv.push('--effort', effort);
  if (entry.thinking) argv.push('--thinking-display', 'summarized');
  return argv;
}

export async function runClaude(request, entry, claude, signal, onEvent, {
  upstream = 'https://api.anthropic.com', home = process.env.HOME, username = process.env.USER,
  translated = null, onHeaders = () => {}, billing = 'subscription', extraUsage = true, account = null, deadlineMs = CLI_DEADLINE_MS } = {}) {
  let expired = false;
  const cancelled = () => { if (signal.aborted || expired) throw new Error('claude_request_cancelled'); };
  cancelled();
  translated ??= translateRequest(request, entry.slug);
  const relay = new Relay(upstream, onEvent, onHeaders, { billing, extraUsage, model: entry.model });
  let root;
  let child;
  let fault;
  const cancel = () => { cancelChild(child); relay.abort(); };
  const deadline = setTimeout(() => { expired = true; cancel(); }, deadlineMs);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    root = await mkdtemp('/private/tmp/omd-claude-');
    cancelled();
    await relay.listen();
    cancelled();
    await Promise.all([
      writeFile(join(root, 'tools.json'), JSON.stringify(translated.manifest)),
      writeFile(join(root, 'settings.json'), JSON.stringify({ env: {
        CLAUDE_CODE_EXTRA_BODY: JSON.stringify(translated.extra) } })),
      writeFile(join(root, 'system.md'), translated.system)]);
    cancelled();
    const mcp = { mcpServers: { omd: { command: process.execPath,
      args: [file, 'inert', join(root, 'tools.json')] } } };
    const argv = [...cliArgs(entry, translated.effort), '--system-prompt-file', join(root, 'system.md'),
      '--settings', join(root, 'settings.json'), '--mcp-config', JSON.stringify(mcp)];
    const env = cliEnv({ HOME: home, USER: username, LOGNAME: username, TMPDIR: root, ...accountEnv(account),
      ANTHROPIC_BASE_URL: relay.url,
      ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_MAX_RETRIES: '0', DISABLE_AUTO_COMPACT: '1', DISABLE_COMPACT: '1',
      CLAUDE_CODE_TOTAL_TOKENS_REMINDER: 'off' });
    delete env.OMD_CLAUDE_LOCAL_TOKEN;
    delete env.OMD_READY_TOKEN;
    if (translated.extra.max_tokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(translated.extra.max_tokens);
    child = spawn(claude, argv, { cwd: root, env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    child.on('error', error => { fault ??= error; });
    child.stdin.on('error', () => {});
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
    const results = [];
    let stopped = false;
    for (;;) {
      const event = await next();
      if (event === null) break;
      if (event instanceof Error) throw event;
      if (event.type === 'result') results.push(event);
      if (event.type === 'stream_event' && event.event?.type === 'message_stop') stopped = true;
    }
    await exited;
    if (signal.aborted) throw new Error('claude_request_cancelled');
    const failure = relay.refusal ?? upstreamFailure(relay.status, relay.headers, relay.error, billing, account);
    if (failure) throw Object.assign(new Error(failure.message), { code: failure.code });
    if (relay.used !== 1 || relay.status !== 200 || !relay.capture.complete) {
      let detail = relay.failure ?? 'none';
      try { detail = JSON.parse(relay.error).error.message ?? detail; } catch {}
      throw new Error(`claude_upstream_incomplete:${relay.status ?? 'no_request'}:${String(detail).slice(0, 300)}`);
    }
    if (results.length !== 1 || !stopped) throw new Error('claude_result_incomplete');
    const servedModel = String(relay.capture.message.model);
    if (servedModel !== entry.model && !new RegExp(`^${entry.model.replace(/[.]/g, '\\.')}-\\d{8}$`).test(servedModel)) {
      throw Object.assign(new Error(`Claude served ${relay.capture.message.model} instead of ${entry.model}`), { code: 'claude_model_mismatch' });
    }
    const served = results[0].modelUsage?.[entry.cli]?.contextWindow;
    if (served !== entry.window) throw new Error(`claude_context_window_changed:${served}:run_claude_login`);
    const admission = { upstream_requests: relay.used, blocked_requests: relay.denied,
      request_id: relay.requestId };
    return responseEvents(relay.capture.message, admission, entry.model, translated.reverse, true, results[0].total_cost_usd, billing);
  } catch (error) {
    if (signal.aborted) throw new Error('claude_request_cancelled');
    if (expired) throw Object.assign(new Error(`The Claude CLI did not finish within ${Math.round(deadlineMs / 60_000)} minutes (${relay.used ? 'it was still answering' : 'it never sent its request'}), so OMD stopped it. Retry the request; if it keeps happening, run /claude to check the CLI and login, or update the Claude CLI.`), { code: 'claude_upstream_incomplete' });
    throw fault ?? error;
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener('abort', cancel);
    cancel();
    if (root) await rm(root, { recursive: true, force: true });
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

// Concurrent sessions share the store's fixed port: during the host's 3 s readiness window a later transport hands the owner its readiness nonce sealed with the shared local token, so only a token holder can read it, and takes the port once the owner has drained and exited. A holder that never serves the nonce fails the start.
async function claim(server, port, token, ready) {
  const handoff = Date.now() + 3_000;
  let handedOff = false;
  for (;;) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      return;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
    if (Date.now() < handoff) {
      const signal = AbortSignal.timeout(500);
      await fetch(`http://127.0.0.1:${port}/_omd/nonce`, { method: 'POST', body: seal(token, ready), signal }).catch(() => {});
      handedOff ||= await fetch(`http://127.0.0.1:${port}/_omd/ready`, { signal }).then(reply => reply.text(), () => '') === `OMD_READY:${ready}`;
    } else if (!handedOff) throw new Error('provider_port_in_use');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

const sealKey = token => createHash('sha256').update(`omd-handoff\0${token}`).digest();

function seal(token, text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(token), iv);
  const data = Buffer.concat([cipher.update(text), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

function unseal(token, text) {
  const bytes = Buffer.from(text, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', sealKey(token), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString();
}

// An unreadable setting stops at extra usage rather than silently allowing paid overage.
export async function extraUsageAllowed(routePath, mod = dirname(file)) {
  const store = resolve(dirname(routePath), '../..');
  const paths = [mod, join(store, 'sources', 'omd_claude_cli')];
  try {
    const config = JSON.parse(await readFile(join(store, 'mods.json'), 'utf8'));
    const selection = config.mods.find(item => paths.includes(resolve(item.path)));
    return selection ? selection.settings?.extra_usage !== false : false;
  } catch { return false; }
}

export function accountLogins(route, home, username) {
  if (!Array.isArray(route.accounts)) throw new Error('claude_account_required: run `/claude login`');
  checkVersion(route.claude);
  const logins = new Map(route.accounts.map(account => {
    try { return [account.name, { plan: checkAuth(route.claude, account.billing, home, username, account).subscriptionType }]; }
    catch (error) { return [account.name, { error: error.message }]; }
  }));
  if (![...logins.values()].some(login => !login.error)) throw new Error(logins.values().next().value?.error ?? 'claude_account_required: run `/claude login`');
  return logins;
}

async function serve(routePath, home, username) {
  const route = JSON.parse(await readFile(routePath, 'utf8'));
  const logins = accountLogins(route, home, username);
  const models = route.accounts.flatMap(account => account.models.map(model => ({ ...model, account })));
  const token = process.env.OMD_CLAUDE_LOCAL_TOKEN ?? '';
  const ready = process.env.OMD_READY_TOKEN ?? '';
  if (token.length < 32 || !ready) throw new Error('native_provider_tokens_required');
  const active = new Set();
  let nonce = ready;
  const limits = new Map();
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/_omd/ready') {
      response.writeHead(200).end(`OMD_READY:${nonce}`);
      return;
    }
    if (request.method === 'POST' && request.url === '/_omd/nonce') {
      try { nonce = unseal(token, String(await bodyOf(request, 256))); } catch { response.writeHead(401).end(); return; }
      response.writeHead(204).end();
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/responses') { response.writeHead(404).end(); return; }
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
    let payload;
    let translated;
    let entry;
    try {
      payload = JSON.parse(await bodyOf(request));
      entry = models.find(model => model.slug === payload.model);
      translated = translateRequest(payload, entry?.slug);
    } catch (error) {
      response.writeHead(400).end(String(error?.message ?? 'invalid_claude_request'));
      return;
    }
    const controller = new AbortController();
    active.add(controller);
    response.on('close', () => { if (!response.writableFinished) controller.abort(); });
    const { account } = entry;
    const login = logins.get(account.name);
    const extraUsage = await extraUsageAllowed(routePath);
    const head = (headers = {}) => {
      if (!response.headersSent) response.writeHead(200, { 'content-type': 'text/event-stream',
        'cache-control': 'no-store', ...limitHeaders(headers, providerNote(account.billing, login.plan, headers, extraUsage)) });
    };
    const send = event => { head(); response.write(`data: ${JSON.stringify(event)}\n\n`); };
    try {
      if (login.error) throw Object.assign(new Error(login.error), { code: login.error.split(':')[0] });
      const seen = limits.get(account.name) ?? {};
      if (!extraUsage && stoppedForExtraUsage(seen)) {
        head(seen);
        throw Object.assign(new Error(extraUsageStop(seen).message), { code: 'claude_extra_usage_blocked' });
      }
      const events = await runClaude(payload, entry, route.claude, controller.signal, send,
        { home, username, translated, billing: account.billing, extraUsage, account,
          onHeaders: (_, headers) => { limits.set(account.name, headers); head(headers); } });
      for (const event of events) send(event);
    } catch (error) {
      const message = String(error?.message ?? 'claude_transport_failed').slice(0, 500);
      const code = error?.code ?? message.replace(/[^\w:.-]/g, '_').slice(0, 200);
      if (!response.destroyed) send({ type: 'response.failed', response: { error: { code, message } } });
    } finally {
      active.delete(controller);
      response.end();
      if (stopping && !active.size) process.exit(0);
    }
  });
  let stopping = false;
  const stop = () => { stopping = true; server.close(); if (!active.size) process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await claim(server, route.port, token, ready);
}

if (process.argv[1] === file) {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'inert') await inert(args[0]);
  else if (action === 'serve') await serve(args[0], args[1], args[2]);
  else throw new Error('unsupported_claude_transport_action');
}
