import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const file = fileURLToPath(import.meta.url);
export const SDK_VERSION = '1.0.35';
const PREFIX = 'omd_cursor_';
const DISPATCH = 'omd_call';
const OUTPUTS = ['function_call_output', 'custom_tool_call_output', 'tool_search_output'];
const SETTLE_MS = [0, 15_000, 60_000, 300_000];

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const callId = () => `${PREFIX}${randomBytes(12).toString('hex')}`;

export async function loadSdk(entry) {
  try { return await import(pathToFileURL(entry).href); }
  catch (error) { throw new Error(`cursor_sdk_unavailable:${error.message}; rerun omd-package cursor --setup`); }
}

// Codex returns searched default-namespace tools under `functions`; they are called by their plain names.
const scope = spec => spec.name === 'functions' ? '' : String(spec.name ?? '');

export function inventory(payload) {
  const tools = {};
  const add = (spec, namespace = '') => {
    if (!plain(spec)) return;
    if (spec.type === 'namespace') { for (const child of spec.tools ?? []) add(child, scope(spec)); return; }
    if (!['function', 'custom', 'tool_search'].includes(spec.type)) return;
    const kind = spec.type === 'tool_search' ? 'search' : spec.type;
    const name = kind === 'search' ? 'tool_search' : namespace ? `${namespace}__${spec.name}` : String(spec.name);
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name) || name === DISPATCH) return;
    const schema = kind === 'custom' ? { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] }
      : plain(spec.parameters) ? spec.parameters : { type: 'object', properties: {} };
    tools[name] = { kind, namespace, name: spec.name ?? name, description: String(spec.description ?? ''), schema };
  };
  for (const spec of payload.tools ?? []) add(spec, spec.namespace ?? '');
  for (const item of payload.input ?? []) {
    if (item?.type === 'additional_tools') for (const group of item.tools ?? []) for (const spec of group.tools ?? []) add(spec, group.name);
    if (item?.type === 'tool_search_output') for (const spec of item.tools ?? []) add(spec, spec.namespace ?? '');
  }
  return tools;
}

function image(url) {
  const match = typeof url === 'string' ? /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/]+=*)$/i.exec(url) : null;
  if (!match) throw new Error('unsupported_image_input');
  return { data: match[2], mimeType: match[1].toLowerCase() };
}

function content(value) {
  const parts = typeof value === 'string' ? [{ type: 'input_text', text: value }] : Array.isArray(value) ? value : [];
  return { text: parts.filter(part => typeof part?.text === 'string').map(part => part.text).join(''),
    images: parts.filter(part => part?.type === 'input_image').map(part => image(part.image_url)) };
}

// Cursor keeps its own context, so the user/assistant conversation is the identity; tool exchanges and developer context ride along as text only when a new agent replays the transcript.
export function conversation(input) {
  const messages = [];
  const context = [];
  const append = (role, text, images = []) => {
    if (role === 'assistant' && messages.at(-1)?.role === 'assistant') messages.at(-1).text += text;
    else messages.push({ role, text, images, notes: [] });
  };
  for (const item of input ?? []) {
    if (item?.type === 'message' && ['user', 'assistant'].includes(item.role)) {
      const { text, images } = content(item.content);
      append(item.role, text, images);
    } else if (item?.type === 'message' && item.role === 'developer') {
      context.push(content(item.content).text);
    } else if (['function_call', 'custom_tool_call', 'tool_search_call'].includes(item?.type)) {
      const args = typeof item.arguments === 'string' ? item.arguments : item.input ?? JSON.stringify(item.arguments ?? {});
      (messages.at(-1)?.notes ?? context).push(`[called ${item.name ?? 'tool_search'} ${args}]`);
    } else if (OUTPUTS.includes(item?.type)) {
      const output = item.type === 'tool_search_output' ? `${(item.tools ?? []).length} tool group(s) loaded`
        : typeof item.output === 'string' ? item.output : content(item.output).text;
      (messages.at(-1)?.notes ?? context).push(`[result ${output.slice(0, 4000)}]`);
    }
  }
  return { messages, context };
}

const fingerprint = messages => digest(messages.map(({ role, text, images }) => [role, text, images.map(item => item.data)]));

export function prompt(messages, context, fresh, cwd, orphaned = false) {
  const images = messages.flatMap(message => message.images);
  if (!fresh) {
    const text = messages.map(message => message.text).join('\n\n');
    if (!text.trim() && !images.length) throw new Error('cursor_empty_input');
    return { text, images };
  }
  const transcript = messages.map(message => [`## ${message.role === 'user' ? 'User' : 'Assistant'}`, message.text, ...message.notes].join('\n')).join('\n\n');
  const text = [
    `You are the lead coding agent of an Oh My Diff session in ${cwd}. You have no built-in Cursor tools: act only through the tools of the custom-user-tools MCP server, which Oh My Diff runs in that workspace under its own permissions and approvals. A refused or failed call means the user or the host declined it; do not retry it another way.`,
    ...context.filter(Boolean).map(text => `<context>\n${text}\n</context>`),
    messages.length > 1 || orphaned ? `Conversation so far:\n\n${transcript}` : transcript,
    ...orphaned ? ['The previous Cursor run ended while its tool calls were running; continue from the tool results above.'] : []].join('\n\n');
  return { text, images };
}

function usage(value) {
  const number = key => Number.isFinite(value?.[key]) ? value[key] : 0;
  const cached = number('cacheReadTokens');
  const written = number('cacheWriteTokens');
  const input = number('inputTokens') + cached + written;
  return { input_tokens: input, input_tokens_details: { cached_tokens: cached, cache_write_tokens: written },
    output_tokens: number('outputTokens'), output_tokens_details: { reasoning_tokens: number('reasoningTokens') },
    total_tokens: input + number('outputTokens'), omd_native_usage: value ?? null };
}

const FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];
const add = (a, b) => Object.fromEntries(FIELDS.map(key => [key, (a?.[key] ?? 0) + (b?.[key] ?? 0)]));
const subtract = (a, b) => Object.fromEntries(FIELDS.map(key => [key, Math.max(0, (a?.[key] ?? 0) - (b?.[key] ?? 0))]));
const any = value => FIELDS.some(key => value?.[key] > 0);

function failure(error) {
  const message = String(error?.message ?? error ?? 'cursor_transport_failed').slice(0, 500);
  const name = String(error?.name ?? '');
  if (name === 'AuthenticationError') return { code: 'cursor_auth_failed', message: `${message}; rerun omd-package cursor --setup` };
  if (name === 'RateLimitError' || /usage.?limit|quota|rate.?limit/i.test(`${error?.code ?? ''} ${message}`)) {
    return { code: 'rate_limit_exceeded', message: `Cursor refused the request for plan usage or rate limits (${message}). OMD does not fall back to another route or paid key.` };
  }
  return { code: message.split(':')[0], message };
}

function toolResult(item) {
  if (item.type === 'tool_search_output') {
    const rows = Object.entries(inventory({ input: [item] })).map(([name, tool]) =>
      `- ${name}: ${tool.description}\n  parameters: ${JSON.stringify(tool.schema)}`);
    return rows.length ? `Loaded tools. Call them through ${DISPATCH} with {"name": "<tool>", "arguments": {...}}:\n${rows.join('\n')}` : 'No matching tools.';
  }
  if (Array.isArray(item.output)) {
    return { content: item.output.flatMap(part => part?.type === 'input_image' ? [{ type: 'image', ...image(part.image_url) }]
      : typeof part?.text === 'string' ? [{ type: 'text', text: part.text }] : []) };
  }
  return typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? null);
}

function callItem({ id, tool, args }) {
  if (tool.kind === 'search') return { type: 'tool_search_call', id, call_id: id, execution: 'client', arguments: args };
  if (tool.kind === 'custom') return { type: 'custom_tool_call', id, call_id: id, namespace: tool.namespace, name: tool.name, input: String(args.input ?? '') };
  return { type: 'function_call', id, call_id: id, namespace: tool.namespace, name: tool.name, arguments: JSON.stringify(args) };
}

class Turn {
  constructor(thread, messages, model) {
    this.thread = thread;
    this.messages = messages;
    this.model = model;
    this.events = [];
    this.waiting = null;
    this.calls = new Map();
    this.tools = {};
    this.text = '';
    this.pending = null;
    this.reported = null;
    this.timer = null;
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
  // Each OMD tool runs in Codex: the callback parks until the next request returns its output.
  call(name, args) {
    const tool = this.tools[name];
    if (!tool) return Promise.reject(new Error(`tool_not_in_omd_inventory:${name}`));
    return new Promise((resolve, reject) => {
      const id = callId();
      this.calls.set(id, { id, tool, args: plain(args) ? args : {}, resolve, reject });
      this.push({ kind: 'call', id });
    });
  }
  customTools() {
    const tools = Object.fromEntries(Object.entries(this.tools).map(([name, tool]) => [name, {
      description: tool.description, inputSchema: tool.schema, execute: args => this.call(name, args) }]));
    if (this.tools.tool_search) {
      tools[DISPATCH] = { description: 'Call a tool that tool_search loaded during this turn.',
        inputSchema: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } }, required: ['name'] },
        execute: args => this.call(String(args.name), args.arguments) };
    }
    return tools;
  }
  abandon(reason) {
    for (const call of this.calls.values()) call.reject(new Error(reason));
    this.calls.clear();
  }
}

export class Router {
  constructor(route, apiKey, cwd) {
    this.route = route;
    this.apiKey = apiKey;
    this.cwd = cwd;
    this.sdk = null;
    this.store = null;
    this.state = { agents: {} };
    this.statePath = join(route.data, 'omd-agents.json');
    this.agents = new Map();
    this.turns = new Map();
    this.charged = new Map();
    this.seen = new Map();
    this.notice = '';
    this.plan = null;
    this.planAt = 0;
  }
  async ready() {
    if (this.sdk) return;
    if (!this.apiKey) throw new Error('cursor_not_enrolled:run omd-package cursor --setup');
    if (this.route.credential_expires_at_ms && this.route.credential_expires_at_ms <= Date.now()) {
      throw new Error('cursor_credential_expired:rerun omd-package cursor --setup');
    }
    const sdk = await loadSdk(this.route.sdk);
    await mkdir(join(this.route.data, 'workspace'), { recursive: true, mode: 0o700 });
    this.store = new sdk.JsonlLocalAgentStore(join(this.route.data, 'agents'));
    try { this.state = JSON.parse(await readFile(this.statePath, 'utf8')); } catch {}
    this.sdk = sdk;
  }
  // Cursor's built-in tools, ambient settings and MCP servers stay off; the agent works in an empty private directory so nothing of the repository leaves except through OMD tools.
  options(model) {
    return { apiKey: this.apiKey, model, tools: ['mcp'], mcpServers: {},
      local: { cwd: join(this.route.data, 'workspace'), store: this.store, settingSources: [], sandboxOptions: { enabled: true } } };
  }
  busy(agentId) {
    return [...this.turns.values()].some(turn => turn.agentId === agentId);
  }
  async agent(messages, thread, model, orphaned) {
    for (let index = messages.length - 1; !orphaned && index >= 0 && messages[index].role === 'user'; index--) {
      const head = fingerprint(messages.slice(0, index));
      const found = Object.entries(this.state.agents).find(([, known]) => known.head === head);
      if (!found) continue;
      const [id, known] = found;
      if (known.thread !== thread || this.busy(id)) break;
      try {
        const agent = this.agents.get(id) ?? await this.sdk.Agent.resume(id, this.options(model));
        this.agents.set(id, agent);
        return { agent, input: messages.slice(index), fresh: false };
      } catch {
        break;
      }
    }
    const agent = await this.sdk.Agent.create(this.options(model));
    this.agents.set(agent.agentId, agent);
    return { agent, input: messages, fresh: true };
  }
  async start(payload, entry, thread) {
    await this.ready();
    for (const [key, turn] of this.turns) if (turn.thread === thread) await this.cancel(key, 'cursor_turn_superseded');
    const { messages, context } = conversation(payload.input);
    // Tool outputs with no parked run (the transport restarted mid-turn) continue in a new agent from the transcript.
    const orphaned = OUTPUTS.includes(payload.input?.at(-1)?.type);
    if (!messages.length || !orphaned && messages.at(-1).role !== 'user') throw new Error('cursor_request_must_end_with_user_message');
    const effort = payload.reasoning?.effort;
    const model = { id: entry.id, ...(entry.effort && entry.effort.values.includes(effort)
      ? { params: [{ id: entry.effort.id, value: effort }] } : {}) };
    const turn = new Turn(thread, messages, entry.slug);
    turn.tools = inventory(payload);
    const { agent, input, fresh } = await this.agent(messages, thread, model, orphaned);
    turn.agentId = agent.agentId;
    const key = callId();
    this.turns.set(key, turn);
    try {
      turn.run = await agent.send(prompt(input, context, fresh, this.cwd, orphaned), { model, local: { customTools: turn.customTools() },
        onDelta: ({ update }) => {
          if (update?.type === 'text-delta' && update.text) turn.push({ kind: 'text', delta: update.text });
          else if (update?.type === 'thinking-delta' && update.text) turn.push({ kind: 'reasoning', delta: update.text });
          else if (update?.type === 'turn-ended' && update.usage) turn.pending = add(turn.pending, update.usage);
        } });
    } catch (error) {
      this.turns.delete(key);
      throw error;
    }
    turn.run.wait().then(result => turn.push({ kind: 'end', result }), error => turn.push({ kind: 'end', error }));
    return { key, turn };
  }
  resume(payload) {
    const outputs = [];
    for (const item of [...payload.input ?? []].reverse()) {
      if (!OUTPUTS.includes(item?.type)) break;
      outputs.unshift(item);
    }
    if (!outputs.length || !outputs.every(item => String(item.call_id).startsWith(PREFIX))) return null;
    const entry = [...this.turns].find(([, turn]) => turn.calls.has(outputs[0].call_id));
    if (!entry) return null;
    const [key, turn] = entry;
    clearTimeout(turn.timer);
    turn.tools = inventory(payload);
    for (const item of outputs) {
      const call = turn.calls.get(item.call_id);
      if (!call) continue;
      turn.calls.delete(item.call_id);
      try { call.resolve(toolResult(item)); } catch (error) { call.reject(error); }
    }
    turn.abandon('tool_output_missing');
    return { key, turn };
  }
  park(key, turn) {
    turn.timer = setTimeout(() => this.cancel(key, 'cursor_tool_wait_expired'), 600_000);
    turn.timer.unref?.();
  }
  async cancel(key, reason) {
    const turn = this.turns.get(key);
    if (!turn) return;
    turn.abandon(reason);
    await this.finish(key, turn, false);
    await turn.run?.cancel().catch(() => {});
  }
  // An agent whose run did not complete holds a partial turn, so it is never resumed; the next request replays the transcript into a new agent.
  async finish(key, turn, completed) {
    if (turn.finished) return;
    turn.finished = true;
    this.turns.delete(key);
    clearTimeout(turn.timer);
    turn.abandon('cursor_run_ended');
    if (completed) {
      this.state.agents[turn.agentId] = { head: fingerprint([...turn.messages, { role: 'assistant', text: turn.text, images: [] }]),
        thread: turn.thread, model: turn.model, at: Date.now() };
    } else {
      delete this.state.agents[turn.agentId];
    }
    this.state.agents = Object.fromEntries(Object.entries(this.state.agents).sort((a, b) => b[1].at - a[1].at).slice(0, 200));
    await writeFile(this.statePath, JSON.stringify(this.state));
    this.settle(turn.agentId, turn.model, { thread: turn.thread, request_id: turn.requestId ?? null });
  }
  // Best effort over an undocumented dashboard RPC bundled in the SDK: plan pools and spend limits as Cursor's editor shows them, at most once a minute, never failing a request.
  async refreshPlan() {
    if (Date.now() - this.planAt < 60_000) return;
    this.planAt = Date.now();
    const base = { source: 'cursor_private_dashboard_rpc', undocumented: true, observed_at: Date.now() };
    try {
      const response = await fetch(`${this.route.backend_url ?? 'https://api2.cursor.sh'}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`, {
        method: 'POST', body: '{}', signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', 'connect-protocol-version': '1', 'x-cursor-client-type': 'sdk' } });
      if (!response.ok) throw new Error(`http_${response.status}`);
      const body = await response.json();
      this.plan = { ...base, billing_cycle_start: body.billingCycleStart ?? null, billing_cycle_end: body.billingCycleEnd ?? null,
        plan_usage: body.planUsage ?? null, spend_limit_usage: body.spendLimitUsage ?? null, enabled: body.enabled ?? null,
        message: body.displayMessage ?? null, auto_bucket_models: body.autoBucketModels ?? [] };
    } catch (error) {
      this.plan = { ...base, unavailable: String(error?.message ?? error).slice(0, 200) };
    }
    await appendFile(join(this.route.data, 'usage.jsonl'), `${JSON.stringify({ at: Date.now(), kind: 'plan', ...this.plan })}\n`).catch(() => {});
  }
  // Cursor settles billed cost some time after a run ends. The run's new usage entries are settled once all are priced (or at the last poll) against the OMD request that ended the run, and a charge is announced on the next response.
  settle(agentId, model, target) {
    const agent = this.agents.get(agentId);
    const seen = this.seen.get(agentId) ?? new Set();
    this.seen.set(agentId, seen);
    const total = (rows, key) => rows.reduce((sum, run) => sum + (run.cost?.[key] ?? 0), 0);
    let done = false;
    SETTLE_MS.forEach((delay, index) => setTimeout(async () => {
      if (index === 0) await this.refreshPlan();
      if (done) return;
      try {
        const report = await agent.getUsage();
        const fresh = (report?.runs ?? []).filter(run => !seen.has(run.runId));
        const priced = fresh.length ? fresh.every(run => plain(run.cost)) : plain(report?.cost);
        if (!priced && index < SETTLE_MS.length - 1) return;
        done = true;
        for (const run of fresh) seen.add(run.runId);
        const before = this.charged.get(agentId) ?? { raw: 0, charged: 0 };
        const cost = !priced ? null : fresh.length ? { raw_cents: total(fresh, 'rawCostCents'), charged_cents: total(fresh, 'chargedCents') }
          : { raw_cents: Math.max(0, report.cost.rawCostCents - before.raw), charged_cents: Math.max(0, report.cost.chargedCents - before.charged) };
        if (plain(report?.cost)) this.charged.set(agentId, { raw: report.cost.rawCostCents, charged: report.cost.chargedCents });
        await appendFile(join(this.route.data, 'usage.jsonl'), `${JSON.stringify({ at: Date.now(), kind: 'settlement', source: 'cursor_sdk.getUsage',
          agent_id: agentId, model, thread: target.thread, request_id: target.request_id,
          usage: fresh.length ? fresh.reduce((sum, run) => add(sum, run.usage), null) : report?.usage ?? null,
          cost, status: cost ? 'settled' : 'pending' })}\n`);
        if (cost?.charged_cents > 0) {
          this.notice = `Cursor charged ${cost.charged_cents.toFixed(2)}¢ beyond included usage for a run on agent ${agentId} (raw ${cost.raw_cents.toFixed(2)}¢); see /cursor usage.`;
        }
      } catch {}
    }, delay).unref?.());
  }
}

// Streams one Codex response from a Cursor run; the run parks whenever it calls OMD tools and continues on the request that returns their output.
async function drain(router, key, turn, send, signal) {
  const id = `cursor-${randomBytes(8).toString('hex')}`;
  let text = false;
  let reasoning = '';
  send({ type: 'response.created', response: { id } });
  const think = delta => {
    if (!reasoning) {
      send({ type: 'response.output_item.added', item: { type: 'reasoning', id: `${id}-reasoning`, summary: [] } });
      send({ type: 'response.reasoning_summary_part.added', item_id: `${id}-reasoning`, summary_index: 0 });
    }
    reasoning += delta;
    send({ type: 'response.reasoning_summary_text.delta', item_id: `${id}-reasoning`, summary_index: 0, delta });
  };
  const say = delta => {
    if (text === false) { text = ''; send({ type: 'response.output_item.added', item: { type: 'message', id: `${id}-text`, role: 'assistant', content: [] } }); }
    text += delta;
    send({ type: 'response.output_text.delta', delta });
  };
  const close = () => {
    if (reasoning) send({ type: 'response.output_item.done', item: { type: 'reasoning', id: `${id}-reasoning`,
      summary: [{ type: 'summary_text', text: reasoning }] } });
    if (text !== false) send({ type: 'response.output_item.done', item: { type: 'message', id: `${id}-text`,
      role: 'assistant', content: [{ type: 'output_text', text }] } });
  };
  const meta = extra => ({ agent_id: turn.agentId, run_id: turn.run?.id ?? null, request_id: turn.run?.requestId ?? null,
    model: turn.model, source: 'cursor_sdk', observed_at: Date.now(), plan: router.plan, ...extra });
  if (router.notice) { think(router.notice); router.notice = ''; }
  const abort = () => turn.push({ kind: 'abort' });
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      const event = await turn.take(15000);
      if (signal.aborted) {
        await router.cancel(key, 'cursor_request_cancelled');
        throw new Error('cursor_request_cancelled');
      }
      if (event === null) send({ type: 'response.in_progress' });
      else if (event.kind === 'text') { turn.text += event.delta; say(event.delta); }
      else if (event.kind === 'reasoning') think(event.delta);
      else if (event.kind === 'call') {
        const ids = [event.id];
        // Parallel calls arrive back to back; hand Codex every call issued before the run pauses.
        for (let next = await turn.take(50); next; next = await turn.take(50)) {
          if (next.kind !== 'call') { turn.events.unshift(next); break; }
          ids.push(next.id);
        }
        close();
        for (const callKey of ids) {
          const item = callItem(turn.calls.get(callKey));
          send({ type: 'response.output_item.added', item });
          send({ type: 'response.output_item.done', item });
        }
        const segment = turn.pending;
        turn.pending = null;
        turn.reported = add(turn.reported, segment);
        router.park(key, turn);
        return send({ type: 'response.completed', response: { id, ...(any(segment) ? { usage: { ...usage(segment), omd_cursor: meta({ cost: 'pending' }) } } : {}) } });
      } else if (event.kind === 'end') {
        close();
        const result = event.result ?? {};
        const completed = !event.error && result.status === 'finished';
        await router.finish(key, turn, completed);
        if (!completed) {
          const error = failure(event.error ?? result.error ?? `cursor_run_${result.status ?? 'failed'}`);
          return send({ type: 'response.failed', response: { id, error } });
        }
        const total = result.usage ?? (turn.pending ? add(turn.reported, turn.pending) : null);
        return send({ type: 'response.completed', response: { id, ...(total ? { usage: { ...usage(subtract(total, turn.reported)),
          omd_cursor: meta({ cost: 'pending', run_usage: total }) } } : {}) } });
      }
    }
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o077) throw new Error(`cursor_data_directory_unsafe: ${path}`);
}

export async function serve(routePath) {
  const route = JSON.parse(await readFile(routePath, 'utf8'));
  const token = process.env.OMD_CURSOR_LOCAL_TOKEN ?? '';
  const ready = process.env.OMD_READY_TOKEN ?? '';
  if (token.length < 32 || !ready) throw new Error('native_provider_tokens_required');
  let apiKey = '';
  try { apiKey = String(JSON.parse(process.env.OMD_SECRETS ?? '[]').find(secret => secret.id === route.secret_profile)?.value ?? ''); } catch {}
  await privateDirectory(route.data);
  process.env.HOME = route.data;
  process.env.TMPDIR = route.data;
  const router = new Router(route, apiKey, process.cwd());
  let nonce = ready;
  let active = 0;
  let stopping = false;
  const exit = () => process.exit(0);
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
      if (!entry || payload.stream !== true) throw new Error('unsupported_cursor_request');
    } catch (error) {
      response.writeHead(400).end(String(error.message));
      return;
    }
    const controller = new AbortController();
    active++;
    response.on('close', () => { if (!response.writableFinished) controller.abort(); });
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    const send = event => response.write(`data: ${JSON.stringify(event)}\n\n`);
    try {
      const { key, turn } = router.resume(payload) ?? await router.start(payload, entry, String(request.headers['thread-id'] ?? ''));
      turn.requestId = request.headers['x-omd-request-id'] ?? null;
      await drain(router, key, turn, send, controller.signal);
    } catch (error) {
      if (!response.destroyed) send({ type: 'response.failed', response: { error: failure(error) } });
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
  else throw new Error('unsupported_cursor_transport_action');
}
