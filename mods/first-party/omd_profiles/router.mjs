import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const BODY_LIMIT = 64 * 1024 * 1024;
const DROPPED = ['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding', 'keep-alive', 'upgrade',
  'proxy-authorization', 'proxy-connection', 'authorization'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

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

function parts(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return (Array.isArray(content) ? content : []).flatMap(part => {
    if (['input_text', 'output_text', 'text'].includes(part?.type) && part.text) return [{ type: 'text', text: part.text }];
    const image = part?.type === 'input_image' && /^data:(image\/[a-z+]+);base64,(.+)$/.exec(part.image_url ?? '');
    return image ? [{ type: 'image', media: image[1], data: image[2], url: part.image_url }] : [];
  });
}

const textOf = content => parts(content).map(part => part.type === 'text' ? part.text : '[image]').join('\n');

// Codex sends namespaced and freeform tools; both providers take flat JSON-schema functions, so names are mapped both ways.
export function toolTable(body) {
  const tools = [];
  const reverse = {};
  const add = (spec, namespace = '') => {
    if (spec?.type === 'namespace') return (spec.tools ?? []).forEach(child => add(child, spec.name === 'functions' ? '' : spec.name));
    if (!['function', 'custom'].includes(spec?.type) || typeof spec.name !== 'string') return;
    const name = (namespace ? `${namespace}__${spec.name}` : spec.name).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
    if (reverse[name]) return;
    reverse[name] = { namespace, name: spec.name, kind: spec.type };
    const schema = spec.type === 'custom' ? { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] }
      : plain(spec.parameters) ? spec.parameters : { type: 'object', properties: {} };
    tools.push({ name, description: typeof spec.description === 'string' ? spec.description : '', schema });
  };
  for (const spec of body.tools ?? []) add(spec, spec.namespace ?? '');
  const name = item => Object.keys(reverse).find(key => reverse[key].name === item.name && reverse[key].namespace === (item.namespace ?? '')) ?? item.name;
  return { tools, reverse, name };
}

const THINKING = 'omd-thinking:';
// Anthropic thinking blocks ride in a reasoning item's encrypted_content, tagged with the profile that produced them.
export const sealThinking = (profile, blocks) => `${THINKING}${profile}:${Buffer.from(JSON.stringify(blocks)).toString('base64')}`;
export function openThinking(item, profile) {
  const text = typeof item?.encrypted_content === 'string' ? item.encrypted_content : '';
  const prefix = `${THINKING}${profile}:`;
  if (!text.startsWith(prefix)) return [];
  try { return JSON.parse(Buffer.from(text.slice(prefix.length), 'base64').toString('utf8')).filter(block => ['thinking', 'redacted_thinking'].includes(block?.type)); } catch { return []; }
}

// History as provider-neutral turns; search and hosted-tool items have no portable form, and only this profile's thinking survives.
export function turns(body, profile = null) {
  const table = toolTable(body);
  const system = body.instructions ? [body.instructions] : [];
  const list = [];
  for (const item of body.input ?? []) {
    if (item?.type === 'message') {
      if (item.role === 'system' || item.role === 'developer') {
        if (list.length) list.push({ role: 'user', content: [{ type: 'text', text: textOf(item.content) }] });
        else system.push(textOf(item.content));
      } else list.push({ role: item.role === 'assistant' ? 'assistant' : 'user', content: parts(item.content) });
    } else if (item?.type === 'reasoning' && profile) {
      const blocks = openThinking(item, profile);
      if (blocks.length) list.push({ role: 'assistant', content: blocks.map(block => ({ type: 'thinking', block })) });
    } else if (item?.type === 'function_call' || item?.type === 'custom_tool_call') {
      let input;
      try { input = item.type === 'custom_tool_call' ? { input: item.input } : JSON.parse(item.arguments || '{}'); } catch { input = { raw: item.arguments }; }
      list.push({ role: 'assistant', content: [{ type: 'call', id: item.call_id, name: table.name(item), input }] });
    } else if (item?.type === 'function_call_output' || item?.type === 'custom_tool_call_output') {
      const output = typeof item.output === 'string' ? [{ type: 'text', text: item.output }] : parts(item.output);
      list.push({ role: 'tool', content: [{ type: 'result', id: item.call_id, output }] });
    }
  }
  return { system: system.join('\n\n'), list, table };
}

export function chatRequest(body, profile) {
  const { system, list, table } = turns(body);
  const messages = system ? [{ role: 'system', content: system }] : [];
  for (const turn of list) {
    if (turn.role === 'tool') {
      for (const result of turn.content) messages.push({ role: 'tool', tool_call_id: result.id, content: result.output.map(part => part.text ?? '[image]').join('\n') });
      continue;
    }
    const calls = turn.content.filter(part => part.type === 'call').map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }));
    const content = turn.content.filter(part => part.type !== 'call').map(part => part.type === 'image' ? { type: 'image_url', image_url: { url: part.url } } : { type: 'text', text: part.text });
    const last = messages.at(-1);
    if (turn.role === 'assistant' && last?.role === 'assistant' && (calls.length || !content.length)) {
      last.tool_calls = [...last.tool_calls ?? [], ...calls];
      continue;
    }
    const text = content.every(part => part.type === 'text') ? content.map(part => part.text).join('\n') : null;
    messages.push({ role: turn.role, content: turn.role === 'assistant' ? text || null : text ?? content, ...calls.length ? { tool_calls: calls } : {} });
  }
  const effort = body.reasoning?.effort;
  const chatEffort = { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' }[effort];
  return { model: profile.model, messages, stream: true, stream_options: { include_usage: true },
    ...table.tools.length ? { tools: table.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.schema } })), parallel_tool_calls: body.parallel_tool_calls !== false } : {},
    ...profile.reasoning && chatEffort ? { reasoning_effort: chatEffort } : {} };
}

export function anthropicRequest(body, profile) {
  const { system, list, table } = turns(body, profile.reasoning ? profile.name : null);
  const messages = [];
  for (const turn of list) {
    const role = turn.role === 'assistant' ? 'assistant' : 'user';
    const content = turn.content.flatMap(part => part.type === 'thinking' ? [part.block] : part.type === 'text' ? [{ type: 'text', text: part.text }]
      : part.type === 'image' ? [{ type: 'image', source: { type: 'base64', media_type: part.media, data: part.data } }]
        : part.type === 'call' ? [{ type: 'tool_use', id: part.id, name: part.name, input: plain(part.input) ? part.input : { value: part.input } }]
          : [{ type: 'tool_result', tool_use_id: part.id, content: part.output.map(item => item.type === 'image'
            ? { type: 'image', source: { type: 'base64', media_type: item.media, data: item.data } } : { type: 'text', text: item.text || ' ' }) }]);
    if (!content.length) continue;
    if (messages.at(-1)?.role === role) messages.at(-1).content.push(...content);
    else messages.push({ role, content });
  }
  const effort = body.reasoning?.effort;
  const budget = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 24576, max: 32000 }[effort];
  const max = Math.min(profile.max_output ?? 32000, Number.isInteger(body.max_output_tokens) && body.max_output_tokens > 0 ? body.max_output_tokens : Infinity);
  return { model: profile.model, max_tokens: max, stream: true, messages, ...system ? { system } : {},
    ...table.tools.length ? { tools: table.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.schema })) } : {},
    ...profile.reasoning && budget && max > 2048 ? { thinking: { type: 'enabled', budget_tokens: Math.min(budget, max - 1024) } } : {} };
}

// Emits the Responses stream events Codex consumes from either provider's deltas.
export class Emitter {
  constructor(send, reverse, id) {
    Object.assign(this, { send, reverse, id, text: null, reasoning: null, calls: new Map(), usage: null, model: null, thinking: [], sealed: null, done: false });
    send({ type: 'response.created', response: { id } });
  }
  delta(kind, value) {
    if (!value) return;
    const field = kind === 'text' ? 'text' : 'reasoning';
    if (!this[field]) {
      this[field] = { id: `${this.id}-${field}`, value: '' };
      this.send({ type: 'response.output_item.added', item: kind === 'text'
        ? { type: 'message', id: this[field].id, role: 'assistant', content: [] } : { type: 'reasoning', id: this[field].id, summary: [] } });
      if (kind !== 'text') this.send({ type: 'response.reasoning_summary_part.added', item_id: this[field].id, summary_index: 0 });
    }
    this[field].value += value;
    this.send(kind === 'text' ? { type: 'response.output_text.delta', item_id: this.text.id, delta: value }
      : { type: 'response.reasoning_summary_text.delta', item_id: this.reasoning.id, summary_index: 0, delta: value });
  }
  call(key, { id, name, args }) {
    const call = this.calls.get(key) ?? { id: '', name: '', args: '' };
    this.calls.set(key, { id: id || call.id, name: name || call.name, args: call.args + (args ?? '') });
  }
  finish(usage) {
    const sealed = this.sealed && this.thinking.length ? { encrypted_content: this.sealed(this.thinking) } : {};
    if (this.reasoning || sealed.encrypted_content) this.send({ type: 'response.output_item.done', item: { type: 'reasoning', id: this.reasoning?.id ?? `${this.id}-reasoning`, summary: this.reasoning ? [{ type: 'summary_text', text: this.reasoning.value }] : [], ...sealed } });
    if (this.text) this.send({ type: 'response.output_item.done', item: { type: 'message', id: this.text.id, role: 'assistant', content: [{ type: 'output_text', text: this.text.value }] } });
    for (const call of this.calls.values()) {
      const tool = this.reverse[call.name] ?? { namespace: '', name: call.name, kind: 'function' };
      let input = {};
      try { input = call.args.trim() ? JSON.parse(call.args) : {}; } catch { input = { input: call.args }; }
      const item = tool.kind === 'custom'
        ? { type: 'custom_tool_call', id: call.id, call_id: call.id, ...tool.namespace ? { namespace: tool.namespace } : {}, name: tool.name, input: String(input.input ?? '') }
        : { type: 'function_call', id: call.id, call_id: call.id, ...tool.namespace ? { namespace: tool.namespace } : {}, name: tool.name, arguments: JSON.stringify(input) };
      this.send({ type: 'response.output_item.added', item });
      this.send({ type: 'response.output_item.done', item });
    }
    this.send({ type: 'response.completed', response: { id: this.id, ...this.model ? { model: this.model } : {}, usage } });
  }
}

export function frames(onData) {
  let pending = '';
  const decoder = new TextDecoder();
  return chunk => {
    pending += decoder.decode(chunk, { stream: true });
    for (let match; (match = /\r?\n\r?\n/.exec(pending));) {
      const data = pending.slice(0, match.index).split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      pending = pending.slice(match.index + match[0].length);
      if (data) onData(data === '[DONE]' ? { done: true } : JSON.parse(data));
    }
  };
}

export function chatEvents(emitter) {
  return event => {
    if (event.error) throw Object.assign(new Error(event.error.message ?? 'chat_stream_error'), { code: event.error.code ?? event.error.type });
    if (event.done || event.choices?.[0]?.finish_reason) emitter.done = true;
    const choice = event.choices?.[0]?.delta ?? {};
    emitter.delta('reasoning', choice.reasoning_content ?? choice.reasoning);
    emitter.delta('text', choice.content);
    for (const call of choice.tool_calls ?? []) emitter.call(call.index ?? 0, { id: call.id, name: call.function?.name, args: call.function?.arguments });
    if (typeof event.model === 'string') emitter.model = event.model;
    if (event.usage) {
      const details = event.usage.prompt_tokens_details ?? {};
      emitter.usage = { input_tokens: event.usage.prompt_tokens ?? 0,
        input_tokens_details: { cached_tokens: details.cached_tokens ?? 0, ...Number.isFinite(details.cache_write_tokens) ? { cache_write_tokens: details.cache_write_tokens } : {} },
        output_tokens: event.usage.completion_tokens ?? 0, output_tokens_details: { reasoning_tokens: event.usage.completion_tokens_details?.reasoning_tokens ?? 0 },
        total_tokens: event.usage.total_tokens ?? (event.usage.prompt_tokens ?? 0) + (event.usage.completion_tokens ?? 0), omd_native_usage: event.usage,
        ...Number.isFinite(event.usage.cost) ? { omd_reported_cost: { usd: event.usage.cost, basis: 'provider_billed' } } : {} };
    }
  };
}

// Anthropic cache entries live 5 minutes (or 1 hour when requested) from their last use; the shortest written TTL bounds the prefix.
export const cacheTtl = creation => creation?.ephemeral_5m_input_tokens > 0 ? 300 : creation?.ephemeral_1h_input_tokens > 0 ? 3600 : null;

export function anthropicEvents(emitter) {
  const usage = { input: 0, cached: 0, written: 0, output: 0 };
  let native = {};
  const blocks = {};
  return event => {
    if (event.type === 'message_start') {
      const start = event.message?.usage ?? {};
      native = start;
      if (typeof event.message?.model === 'string') emitter.model = event.message.model;
      Object.assign(usage, { input: start.input_tokens ?? 0, cached: start.cache_read_input_tokens ?? 0, written: start.cache_creation_input_tokens ?? 0, output: start.output_tokens ?? 0 });
    }
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') emitter.call(event.index, { id: event.content_block.id, name: event.content_block.name });
    if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') blocks[event.index] = { type: 'thinking', thinking: '', signature: '' };
    if (event.type === 'content_block_start' && event.content_block?.type === 'redacted_thinking') blocks[event.index] = { type: 'redacted_thinking', data: event.content_block.data };
    if (event.type === 'content_block_stop' && blocks[event.index]) emitter.thinking.push(blocks[event.index]);
    if (event.type === 'message_stop') emitter.done = true;
    if (event.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta') emitter.delta('text', event.delta.text);
      if (event.delta?.type === 'thinking_delta') {
        emitter.delta('reasoning', event.delta.thinking);
        if (blocks[event.index]) blocks[event.index].thinking += event.delta.thinking;
      }
      if (event.delta?.type === 'signature_delta' && blocks[event.index]) blocks[event.index].signature += event.delta.signature;
      if (event.delta?.type === 'input_json_delta') emitter.call(event.index, { args: event.delta.partial_json });
    }
    if (event.type === 'message_delta') {
      usage.output = event.usage?.output_tokens ?? usage.output;
      native = { ...native, ...event.usage };
    }
    if (event.type === 'error') throw Object.assign(new Error(event.error?.message ?? 'anthropic_stream_error'), { code: event.error?.type });
    const input = usage.input + usage.cached + usage.written;
    const ttl = cacheTtl(native.cache_creation);
    emitter.usage = { input_tokens: input, input_tokens_details: { cached_tokens: usage.cached, cache_write_tokens: usage.written }, output_tokens: usage.output,
      output_tokens_details: { reasoning_tokens: 0 }, total_tokens: input + usage.output, omd_native_usage: native, ...ttl ? { omd_cache_ttl_seconds: ttl } : {} };
  };
}

function post(url, headers, payload, signal) {
  const target = new URL(url);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = send(target, { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(payload) }, signal, timeout: 600_000 }, resolve);
    outgoing.on('timeout', () => outgoing.destroy(new Error('upstream_timeout')));
    outgoing.on('error', reject);
    outgoing.end(payload);
  });
}

// The native credential gateway adds the profile's token and only reaches the origin it was enrolled for.
function through(profile) {
  const gateway = process.env.OMD_CREDENTIAL_GATEWAY;
  if (!gateway) throw Object.assign(new Error('credential_gateway_unavailable'), { status: 503 });
  const target = new URL(profile.url);
  return `${gateway}/${profile.credential}${target.pathname}${target.search}`;
}

export async function forward(body, profile, inbound, response, signal) {
  const url = through(profile);
  if (profile.protocol === 'responses') {
    const headers = Object.fromEntries(Object.entries(inbound).filter(([key]) => !DROPPED.includes(key)));
    const upstream = await post(url, headers, JSON.stringify({ ...body, model: profile.model }), signal);
    response.writeHead(upstream.statusCode, Object.fromEntries(Object.entries(upstream.headers).filter(([key]) => !['transfer-encoding', 'connection', 'content-length'].includes(key))));
    for await (const chunk of upstream) response.write(chunk);
    return;
  }
  const anthropic = profile.protocol === 'anthropic';
  const payload = JSON.stringify(anthropic ? anthropicRequest(body, profile) : chatRequest(body, profile));
  const headers = { 'content-type': 'application/json', accept: 'text/event-stream',
    ...anthropic ? { 'x-omd-credential-header': 'x-api-key', 'anthropic-version': '2023-06-01' } : {} };
  const upstream = await post(url, headers, payload, signal);
  if (upstream.statusCode !== 200) {
    let text = '';
    for await (const chunk of upstream) if (text.length < 65_536) text += chunk;
    response.writeHead(upstream.statusCode, { 'content-type': upstream.headers['content-type'] ?? 'text/plain' }).end(text);
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
  const emitter = new Emitter(event => response.write(`data: ${JSON.stringify(event)}\n\n`), toolTable(body).reverse, `omd-${profile.name}-${Date.now()}`);
  if (anthropic && profile.reasoning) emitter.sealed = blocks => sealThinking(profile.name, blocks);
  const feed = frames(anthropic ? anthropicEvents(emitter) : chatEvents(emitter));
  for await (const chunk of upstream) feed(chunk);
  if (!emitter.done) throw Object.assign(new Error('upstream_stream_incomplete: the provider closed the stream before finishing'), { code: 'upstream_stream_incomplete' });
  const input = Math.ceil(payload.length / 4);
  const output = Math.ceil(((emitter.text?.value.length ?? 0) + (emitter.reasoning?.value.length ?? 0) + [...emitter.calls.values()].reduce((sum, call) => sum + call.args.length, 0)) / 4);
  emitter.finish(emitter.usage ?? { input_tokens: input, input_tokens_details: { cached_tokens: 0 }, output_tokens: output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: input + output, omd_usage_estimated: true });
}

// Reasoning produced before a switch stays with its account: every later request on that conversation drops it.
export function prepare(body, profile, last, foreign = new Map()) {
  const key = body.prompt_cache_key;
  const identity = item => item.id ?? item.encrypted_content;
  const reasoning = (body.input ?? []).filter(item => item?.type === 'reasoning');
  if (key && last.has(key) && last.get(key) !== profile.name) foreign.set(key, new Set([...foreign.get(key) ?? [], ...reasoning.map(identity)]));
  if (key) last.set(key, profile.name);
  const dropped = key ? foreign.get(key) : null;
  return dropped?.size ? { ...body, input: body.input.filter(item => item?.type !== 'reasoning' || !dropped.has(identity(item))) } : body;
}

// Inline images count as a fixed estimate instead of their base64 length.
export const estimate = input => Math.ceil(JSON.stringify(input ?? [], (key, value) => typeof value === 'string' && value.startsWith('data:image/') ? 'x'.repeat(6_000) : value).length / 4);

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

async function serve(routePath) {
  const route = JSON.parse(await readFile(routePath, 'utf8'));
  const token = process.env.OMD_PROFILES_LOCAL_TOKEN ?? '';
  const ready = process.env.OMD_READY_TOKEN ?? '';
  if (token.length < 32 || !ready) throw new Error('native_provider_tokens_required');
  const active = new Set();
  const last = new Map();
  const foreign = new Map();
  let nonce = ready;
  let stopping = false;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/_omd/ready') return void response.writeHead(200).end(`OMD_READY:${nonce}`);
    if (request.method === 'POST' && request.url === '/_omd/nonce') {
      if (request.headers.authorization !== `Bearer ${token}`) return void response.writeHead(401).end();
      nonce = String(await bodyOf(request, 256));
      return void response.writeHead(204).end();
    }
    if (request.method !== 'POST' || request.url !== '/v1/responses' || request.headers.origin) return void response.writeHead(404).end();
    const controller = new AbortController();
    active.add(controller);
    response.on('close', () => { if (!response.writableFinished) controller.abort(); });
    try {
      const body = JSON.parse(await bodyOf(request));
      const table = JSON.parse(await readFile(routePath, 'utf8')).profiles ?? route.profiles;
      const profile = table[body.model];
      if (request.headers.authorization !== `Bearer ${token}`) throw Object.assign(new Error('profile_caller_unauthorized'), { status: 401 });
      if (!profile) throw Object.assign(new Error(`profile_not_configured:${body.model}`), { status: 400 });
      const tokens = estimate(body.input);
      if (profile.window && tokens > profile.window) throw Object.assign(new Error(`context_length_exceeded: this thread (~${tokens} tokens) exceeds the ${profile.name} window of ${profile.window}; compact or switch back`), { status: 400 });
      await forward(prepare(body, profile, last, foreign), profile, request.headers, response, controller.signal);
    } catch (error) {
      const message = String(error?.message ?? 'profile_transport_failed').slice(0, 500);
      if (!response.headersSent) response.writeHead(error?.status ?? 502, { 'content-type': 'application/json' });
      if (!response.destroyed) response.write(error?.status ? JSON.stringify({ error: { message, code: message.split(':')[0] } })
        : `data: ${JSON.stringify({ type: 'response.failed', response: { error: { code: error?.code ?? 'profile_transport_failed', message } } })}\n\n`);
    } finally {
      active.delete(controller);
      response.end();
      if (stopping && !active.size) process.exit(0);
    }
  });
  const stop = () => { stopping = true; server.close(); if (!active.size) process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await claim(server, route.port, token, ready);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [action, routePath] = process.argv.slice(2);
  if (action !== 'serve') throw new Error('unsupported_profiles_router_action');
  await serve(routePath);
}
