import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(import.meta.url);
const APPROVAL_TOOL = 'mod_omd_muse_approval';
const POSTURE = ['serve', '--trust-workspace', '--disable-write', '--sandbox-network', 'restricted'];

function uuid7() {
  const time = Date.now().toString(16).padStart(12, '0');
  const random = randomBytes(10).toString('hex');
  const variant = ((Number.parseInt(random.slice(4, 8), 16) & 0x3fff) | 0x8000).toString(16);
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(1, 4)}-${variant}-${random.slice(8, 20)}`;
}

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const spark = model => /^(muse-spark(?:-|$)|spark$)/i.test(model);

export class Host {
  constructor(binary, env, fingerprint) {
    this.binary = binary;
    this.env = env;
    this.fingerprint = fingerprint;
    this.child = null;
    this.pending = new Map();
    this.listeners = new Set();
    this.attached = new Set();
    this.next = 1;
  }
  async ensure() {
    if (this.child && this.child.exitCode === null && !this.child.killed) return;
    this.attached.clear();
    const child = spawn(this.binary, POSTURE, { env: this.env, stdio: ['pipe', 'pipe', 'ignore'] });
    this.child = child;
    child.on('error', () => this.fail(child, 'muse_serve_unavailable'));
    child.on('close', code => this.fail(child, `muse_serve_exited:${code}`));
    createInterface({ input: child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (typeof message.id === 'number' && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`muse_rpc_error:${message.error.code ?? ''}:${message.error.message ?? ''}`));
        else resolve(message.result ?? {});
      } else if (typeof message.method === 'string') {
        for (const listener of this.listeners) listener(message.method, message.params ?? {});
      }
    });
    const result = await this.request('initialize', { clientInfo: { name: 'omd_muse', title: 'Oh My Diff', version: '0.2.0' } });
    const found = result.schema?.fingerprint;
    if (this.fingerprint && found !== this.fingerprint) {
      child.kill('SIGKILL');
      throw new Error(`muse_schema_changed:${found ?? 'none'}:rerun_omd_package_muse_setup`);
    }
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
    return result;
  }
  fail(child, reason) {
    if (this.child !== child) return;
    this.child = null;
    for (const { reject } of this.pending.values()) reject(new Error(reason));
    this.pending.clear();
    for (const listener of this.listeners) listener('omd/hostExited', { reason });
  }
  request(method, params, ms = 30000) {
    const child = this.child;
    if (!child) return Promise.reject(new Error('muse_serve_not_running'));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`muse_rpc_timeout:${method}`)); }, ms);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  stop() {
    this.child?.kill('SIGTERM');
  }
}

function image(url) {
  const match = typeof url === 'string' ? /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/]+=*)$/i.exec(url) : null;
  if (!match) throw new Error('unsupported_image_input');
  return { type: 'image', mediaType: match[1].toLowerCase(), base64Data: match[2] };
}

// Muse keeps its own context and tools, so only the user/assistant conversation crosses; Codex's own prompt, tools and approval-relay items stay behind.
function conversation(input) {
  const messages = [];
  for (const item of input ?? []) {
    if (item?.type !== 'message' || !['user', 'assistant'].includes(item.role)) continue;
    const parts = typeof item.content === 'string' ? [{ type: 'input_text', text: item.content }] : item.content ?? [];
    const text = parts.filter(part => typeof part?.text === 'string').map(part => part.text).join('');
    const images = parts.filter(part => part?.type === 'input_image').map(part => image(part.image_url));
    if (item.role === 'assistant' && messages.at(-1)?.role === 'assistant') messages.at(-1).text += text;
    else messages.push({ role: item.role, text, images });
  }
  return messages;
}

function parts(messages, transcript) {
  const text = transcript
    ? messages.map(message => `## ${message.role === 'user' ? 'User' : 'Assistant'}\n${message.text}`).join('\n\n')
    : messages.map(message => message.text).join('\n\n');
  const images = messages.flatMap(message => message.images);
  if (!text.trim() && !images.length) throw new Error('muse_empty_input');
  return [{ type: 'text', text }, ...images];
}

const fingerprint = messages => digest(messages.map(({ role, text, images }) => [role, text, images.map(item => item.base64Data)]));

class Turn {
  constructor(sessionId, id) {
    this.sessionId = sessionId;
    this.id = id;
    this.events = [];
    this.waiting = null;
    this.text = '';
    this.usage = null;
    this.started = Date.now();
  }
  push(event) {
    if (this.waiting) { const receive = this.waiting; this.waiting = null; receive(event); }
    else this.events.push(event);
  }
  take(ms) {
    if (this.events.length) return Promise.resolve(this.events.shift());
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.waiting = null; resolve(null); }, ms);
      this.waiting = event => { clearTimeout(timer); resolve(event); };
    });
  }
}

function usage(value) {
  const number = key => Number.isFinite(value?.[key]) ? value[key] : 0;
  const cached = number('cachedTokens') + number('cacheReadTokens');
  const input = number('inputTokens') + cached + number('cacheWriteTokens');
  const output = number('outputTokens');
  return { input_tokens: input, input_tokens_details: { cached_tokens: cached, ...Number.isFinite(value?.cacheWriteTokens) ? { cache_write_tokens: value.cacheWriteTokens } : {} }, output_tokens: output,
    output_tokens_details: { reasoning_tokens: number('reasoningTokens') }, total_tokens: input + output,
    omd_native_usage: value ?? null };
}

class Router {
  constructor(host, statePath, cwd) {
    this.host = host;
    this.statePath = statePath;
    this.cwd = cwd;
    this.state = { sessions: {} };
    this.turns = new Map();
    this.parked = new Map();
    host.listeners.add((method, params) => this.notify(method, params));
  }
  async load() {
    try { this.state = JSON.parse(await readFile(this.statePath, 'utf8')); } catch {}
  }
  async save() {
    const sessions = Object.entries(this.state.sessions).sort((a, b) => b[1].at - a[1].at).slice(0, 200);
    this.state.sessions = Object.fromEntries(sessions);
    await writeFile(this.statePath, JSON.stringify(this.state));
  }
  notify(method, params) {
    if (method === 'omd/hostExited') {
      for (const turn of this.turns.values()) turn.push({ kind: 'end', terminal: 'failed', error: { message: params.reason } });
      return;
    }
    const turn = this.turns.get(params.sessionId);
    if (!turn) return;
    const item = params.item ?? {};
    if (method === 'item/delta' && typeof params.delta === 'string') {
      if ((params.field ?? 'text') === 'text') turn.push({ kind: 'text', delta: params.delta });
      else if (/^summary\.\d+$/.test(params.field)) turn.push({ kind: 'reasoning', delta: params.delta });
    } else if (method === 'item/completed' && ['toolCall', 'subagent', 'workflow', 'userShell'].includes(item.kind)) {
      const label = [item.tool ?? item.kind, String(item.args ?? '').slice(0, 160)].filter(Boolean).join(' ');
      turn.push({ kind: 'reasoning', delta: `\n[Muse ${item.status === 'completed' || item.status === undefined ? 'ran' : item.status}: ${label}]\n` });
    } else if (method === 'session/tokenUsage') {
      turn.usage = params.usage;
    } else if (method === 'approval/requested' || method === 'approval/updated') {
      if (params.approvalId && params.currentRequirementId && !turn.approvals?.has(params.approvalId)) {
        (turn.approvals ??= new Set()).add(params.approvalId);
        turn.push({ kind: 'approval', params });
      }
    } else if (method === 'userInput/requested') {
      this.host.request('userInput/cancel', { commandId: uuid7(), sessionId: params.sessionId,
        userInputId: params.userInputId, reason: 'OMD relays no clarifying questions; state assumptions in the answer' }).catch(() => {});
    } else if (method === 'turn/completed' && (!params.turnId || params.turnId === turn.id)) {
      turn.usage = params.usage ?? turn.usage;
      turn.push({ kind: 'end', terminal: params.terminal ?? 'completed', error: params.error, reason: params.reason });
    }
  }
  async session(messages, model, thread) {
    await this.host.ensure();
    for (let index = messages.length - 1; index >= 0 && messages[index].role === 'user'; index--) {
      const prefix = fingerprint(messages.slice(0, index));
      const found = Object.entries(this.state.sessions).find(([, session]) => session.head === prefix);
      if (!found) continue;
      let [id, known] = found;
      try {
        if (known.thread !== thread || this.turns.has(id)) {
          id = (await this.host.request('session/fork', { commandId: uuid7(), sessionId: id })).session.sessionId;
        } else if (!this.host.attached.has(id)) {
          await this.host.request('session/resume', { commandId: uuid7(), sessionId: id });
        }
        if (known.model !== model) await this.host.request('session/setModel', { commandId: uuid7(), sessionId: id,
          model: { modelId: model, ...(spark(model) ? { providerId: 'meta' } : {}) } });
        this.host.attached.add(id);
        return { id, input: parts(messages.slice(index), false) };
      } catch {
        break;
      }
    }
    const started = await this.host.request('session/start', { commandId: uuid7(), workspaceRoot: this.cwd,
      approvalMode: 'onRequest', modelId: model, ...(spark(model) ? { providerId: 'meta' } : {}) });
    const id = started.session.sessionId;
    this.host.attached.add(id);
    return { id, input: parts(messages, messages.length > 1) };
  }
  async start(payload, entry, thread) {
    const messages = conversation(payload.input);
    if (messages.at(-1)?.role !== 'user') throw new Error('muse_request_must_end_with_user_message');
    const { id, input } = await this.session(messages, entry.modelId, thread);
    const commandId = uuid7();
    const turn = new Turn(id, commandId);
    turn.messages = messages;
    turn.thread = thread;
    turn.model = entry.modelId;
    this.turns.set(id, turn);
    const effort = payload.reasoning?.effort;
    try {
      const started = await this.host.request('turn/start', { commandId, sessionId: id, input,
        ...(effort ? { reasoningEffort: effort === 'max' ? 'ultra' : effort } : {}) });
      turn.id = started.turnId ?? commandId;
    } catch (error) {
      this.turns.delete(id);
      throw error;
    }
    return turn;
  }
  async decide(key, approved) {
    const parked = this.parked.get(key);
    if (!parked) throw new Error('muse_approval_unknown_or_expired');
    this.parked.delete(key);
    clearTimeout(parked.timer);
    const { turn, params } = parked;
    if (!params) return turn;
    const choices = params.availableChoices ?? [];
    const choice = choices.find(item => approved ? item.decision === 'approved' : /^(denied|rejected|declined)$/.test(item.decision ?? ''));
    if (choice) {
      await this.host.request('approval/decide', { commandId: uuid7(), sessionId: turn.sessionId,
        approvalId: params.approvalId, choiceId: choice.choiceId, requirementId: params.currentRequirementId });
    } else {
      await this.interrupt(turn);
    }
    return turn;
  }
  async interrupt(turn) {
    await this.host.request('turn/interrupt', { commandId: uuid7(), sessionId: turn.sessionId, turnId: turn.id, retract: false }).catch(() => {});
  }
  park(turn, params) {
    const key = `omd_muse_${randomBytes(16).toString('hex')}`;
    const timer = setTimeout(() => { this.parked.delete(key); this.turns.delete(turn.sessionId); this.interrupt(turn); }, 600000);
    this.parked.set(key, { turn, params, timer });
    return key;
  }
  async finish(turn, completed) {
    this.turns.delete(turn.sessionId);
    if (!completed) return;
    this.state.sessions[turn.sessionId] = { head: fingerprint([...turn.messages, { role: 'assistant', text: turn.text, images: [] }]),
      thread: turn.thread, model: turn.model, at: Date.now() };
    await this.save();
  }
}

// Streams one Codex response from a Muse turn; the turn parks on an approval or, for tool-less callers, on a time slice.
async function drain(router, turn, send, relay, signal) {
  const id = `muse-${uuid7()}`;
  let text = false;
  let reasoning = '';
  send({ type: 'response.created', response: { id } });
  const close = () => {
    if (reasoning) send({ type: 'response.output_item.done', item: { type: 'reasoning', id: `${id}-reasoning`,
      summary: [{ type: 'summary_text', text: reasoning }] } });
    if (text !== false) send({ type: 'response.output_item.done', item: { type: 'message', id: `${id}-text`,
      role: 'assistant', content: [{ type: 'output_text', text }] } });
  };
  const say = delta => {
    if (text === false) { text = ''; send({ type: 'response.output_item.added', item: { type: 'message', id: `${id}-text`, role: 'assistant', content: [] } }); }
    text += delta;
    send({ type: 'response.output_text.delta', delta });
  };
  const complete = (extra = {}) => send({ type: 'response.completed', response: { id, ...extra } });
  const slice = Date.now();
  const abort = () => turn.push({ kind: 'abort' });
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      const event = await turn.take(15000);
      if (signal.aborted) {
        await router.interrupt(turn);
        router.turns.delete(turn.sessionId);
        throw new Error('muse_request_cancelled');
      }
      if (event === null) {
        send({ type: 'response.in_progress' });
        if (!relay && Date.now() - slice > 240000) {
          say(`\nOMD_MUSE_CONTINUE ${JSON.stringify({ key: router.park(turn, null) })}`);
          close();
          return complete();
        }
      } else if (event.kind === 'text') {
        turn.text += event.delta;
        say(event.delta);
      } else if (event.kind === 'reasoning') {
        if (!reasoning) {
          send({ type: 'response.output_item.added', item: { type: 'reasoning', id: `${id}-reasoning`, summary: [] } });
          send({ type: 'response.reasoning_summary_part.added', item_id: `${id}-reasoning`, summary_index: 0 });
        }
        reasoning += event.delta;
        send({ type: 'response.reasoning_summary_text.delta', item_id: `${id}-reasoning`, summary_index: 0, delta: event.delta });
      } else if (event.kind === 'approval') {
        const key = router.park(turn, event.params);
        const detail = { key, tool: String(event.params.toolName ?? 'tool'),
          summary: String(event.params.summary ?? event.params.reason ?? event.params.args ?? '').slice(0, 1000) };
        if (relay) {
          close();
          const item = { type: 'function_call', id: key, call_id: key, name: APPROVAL_TOOL, arguments: JSON.stringify(detail) };
          send({ type: 'response.output_item.added', item });
          send({ type: 'response.output_item.done', item });
        } else {
          say(`\nOMD_MUSE_APPROVAL ${JSON.stringify(detail)}`);
          close();
        }
        return complete();
      } else if (event.kind === 'end') {
        close();
        await router.finish(turn, event.terminal === 'completed');
        if (event.terminal !== 'completed') {
          const message = String(event.error?.message ?? event.reason ?? `muse_turn_${event.terminal}`).slice(0, 500);
          return send({ type: 'response.failed', response: { id, error: { code: `muse_turn_${event.terminal}`, message } } });
        }
        return complete({ usage: usage(turn.usage) });
      }
    }
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function resumption(payload) {
  const last = payload.input?.at(-1);
  if (last?.type === 'function_call_output' && String(last.call_id).startsWith('omd_muse_')) {
    let decision;
    try { decision = JSON.parse(typeof last.output === 'string' ? last.output : JSON.stringify(last.output)); } catch { decision = {}; }
    return { key: last.call_id, approved: decision.approved === true };
  }
  const text = conversation([last]).at(-1)?.text ?? '';
  const match = /^OMD_MUSE_(DECISION|CONTINUE) (\{[^\n]*\})$/.exec(text.trim());
  if (!match) return null;
  const detail = JSON.parse(match[2]);
  return { key: String(detail.key), approved: match[1] === 'DECISION' && detail.approved === true };
}

export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o077) throw new Error(`muse_data_directory_unsafe: ${path}`);
}

async function serve(routePath) {
  const route = JSON.parse(await readFile(routePath, 'utf8'));
  const token = process.env.OMD_MUSE_LOCAL_TOKEN ?? '';
  const ready = process.env.OMD_READY_TOKEN ?? '';
  if (token.length < 32 || !ready) throw new Error('native_provider_tokens_required');
  await privateDirectory(route.data);
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: route.home, USER: route.username, LOGNAME: route.username,
    TMPDIR: route.data, XDG_DATA_HOME: route.data, MUSE_EXPERIMENTAL_SDK_ENABLED: '1' };
  const host = new Host(route.muse, env, route.fingerprint);
  const router = new Router(host, join(route.data, 'omd-sessions.json'), process.cwd());
  await router.load();
  let nonce = ready;
  let active = 0;
  let stopping = false;
  const exit = () => { host.stop(); process.exit(0); };
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/_omd/ready') { response.writeHead(200).end(`OMD_READY:${nonce}`); return; }
    if (request.method !== 'POST' || !['/v1/responses', '/_omd/nonce'].includes(request.url)) { response.writeHead(404).end(); return; }
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url === '/_omd/nonce') { nonce = Buffer.concat(chunks).toString().slice(0, 256); response.writeHead(204).end(); return; }
    let payload;
    let entry;
    try {
      payload = JSON.parse(Buffer.concat(chunks));
      entry = route.models.find(model => model.slug === payload.model);
      if (!entry || payload.stream !== true) throw new Error('unsupported_muse_request');
    } catch (error) {
      response.writeHead(400).end(String(error.message));
      return;
    }
    const controller = new AbortController();
    active++;
    response.on('close', () => { if (!response.writableFinished) controller.abort(); });
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    const send = event => response.write(`data: ${JSON.stringify(event)}\n\n`);
    // Lead turns carry Codex tools; the deferred OMD approval tool is callable there even though search does not list it.
    const relay = Boolean(payload.tools?.length);
    try {
      const resumed = resumption(payload);
      const turn = resumed ? await router.decide(resumed.key, resumed.approved)
        : await router.start(payload, entry, String(request.headers['thread-id'] ?? ''));
      await drain(router, turn, send, relay, controller.signal);
    } catch (error) {
      const message = String(error?.message ?? 'muse_transport_failed').slice(0, 500);
      if (!response.destroyed) send({ type: 'response.failed', response: { error: { code: message.split(':')[0], message } } });
    } finally {
      response.end();
      if (!--active && stopping) exit();
    }
  });
  const stop = () => { stopping = true; server.close(); if (!active) exit(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await claim(server, route.port, token, ready);
}

// Concurrent sessions share the store's fixed port: a later transport hands its readiness nonce to the owner during the host's 3 s readiness window and takes the port over once the owner has drained and exited.
async function claim(server, port, token, ready) {
  const handoff = Date.now() + 3_000;
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
    if (Date.now() < handoff) await fetch(`http://127.0.0.1:${port}/_omd/nonce`, { method: 'POST',
      headers: { authorization: `Bearer ${token}` }, body: ready }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

if (process.argv[1] === file) {
  const [action, route] = process.argv.slice(2);
  if (action === 'serve') await serve(route);
  else throw new Error('unsupported_muse_transport_action');
}
