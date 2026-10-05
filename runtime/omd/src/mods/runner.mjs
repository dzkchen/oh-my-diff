import { stripTypeScriptTypes } from 'node:module';
import { createContext, SourceTextModule } from 'node:vm';
import { readSync, writeSync } from 'node:fs';

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor !== 24 || nodeMinor < 18) {
  process.stdout.write(JSON.stringify({ error: `unsupported_runtime: Node 24.18 or a later 24.x is required, found ${process.versions.node}` }));
  process.exit(1);
}

// A spare runner loads the TypeScript stripper before the host sends it a request.
stripTypeScriptTypes('let ready: boolean;');
let input = Buffer.alloc(0);
function readLine() {
  const chunk = Buffer.alloc(65536);
  let end;
  while ((end = input.indexOf(10)) < 0) {
    const read = readSync(0, chunk);
    if (!read) {
      end = input.length;
      break;
    }
    input = Buffer.concat([input, chunk.subarray(0, read)]);
    if (input.length > 524288) throw new Error('input_limit');
  }
  const line = input.subarray(0, end).toString();
  input = input.subarray(end + 1);
  return line;
}
const request = JSON.parse(readLine());
request.hook_budget_ms ??= 1000;
const globals = Object.create(null);
if (request.environment?.includes('crypto')) globals.crypto = globalThis.crypto;
globals.__exchange = frame => {
  try {
    writeSync(1, frame + '\n');
    return readLine();
  } catch {
    process.exit(1);
  }
};
globals.__clock = () => performance.now();
const context = createContext(globals, {
  codeGeneration: { strings: false, wasm: false },
});
const bootstrap = `
const request = JSON.parse(${JSON.stringify(JSON.stringify(request))});
if (Number.isSafeInteger(request.virtual_time_ms)) {
  const fixed = request.virtual_time_ms;
  globalThis.Date = class extends Date {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return fixed; }
  };
}
const handlers = new Map();
const tools = new Map();
let dynamicTools = null;
const commands = new Map();
const registrations = { tools: [], commands: [], events: [], replacements: [], contracts: [], builtins: [], interceptors: [] };
const interceptors = [];
const surface = request.surface;
registrations.services = [];
registrations.virtual_reads = [];
const serviceHandlers = new Map();
const virtualReaders = new Map();
const updates = [];
let state = structuredCloneFallback(request.state);
const initial = JSON.stringify(state ?? null);
const reads = new Set();
let tracking = null;
const subscriptions = [];
function track(key) {
  reads.add(key);
  tracking?.add(key);
}
const rendering = request.event === 'intercept' && request.payload?.surface === 'render';
let activating = true;
let pending = null;
const calls = [];
const receipts = request.receipts ?? [];
const suspension = Object.freeze({});
const exchange = globalThis.__exchange;
const clock = globalThis.__clock;
delete globalThis.__exchange;
delete globalThis.__clock;
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
function hostTryCall(operation, arguments_ = null) {
  if (activating) throw new Error('host_call_during_registration');
  if (pending) throw new Error('concurrent_host_call');
  const call = structuredCloneFallback({ operation, arguments: arguments_ });
  const index = calls.length;
  calls.push(call);
  if (index < receipts.length) {
    const receipt = receipts[index];
    if (JSON.stringify(canonical(receipt.call)) !== JSON.stringify(canonical(call))) throw new Error('host_call_replay_diverged');
    if (receipt.error) return { ok: false, error: receipt.error };
    return { ok: true, value: structuredCloneFallback(receipt.value) };
  }
  if (request.interactive && operation !== 'continuation.next' && operation !== 'time.sleep') {
    const receipt = JSON.parse(exchange(JSON.stringify({ call, updates })));
    return receipt.error ? { ok: false, error: receipt.error } : { ok: true, value: receipt.value };
  }
  pending = call;
  throw suspension;
}
function hostCall(operation, arguments_ = null) {
  const result = hostTryCall(operation, arguments_);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
function structuredCloneFallback(value) { return JSON.parse(JSON.stringify(value)); }
function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
function globMatch(glob, text) {
  const parts = glob.split('*');
  if (parts.length === 1) return glob === text;
  if (!text.startsWith(parts[0]) || !text.endsWith(parts[parts.length - 1])) return false;
  let at = parts[0].length;
  for (const part of parts.slice(1, -1)) {
    const found = text.indexOf(part, at);
    if (found < 0) return false;
    at = found + part.length;
  }
  return at <= text.length - parts[parts.length - 1].length;
}
function surfaces(pattern) {
  if (typeof pattern !== 'string' || pattern === '!*' || pattern.length > 64) return [];
  const negated = pattern.startsWith('!');
  return Object.keys(surface.intercept).filter(name => request.capabilities.includes(surface.intercept[name])
    && globMatch(negated ? pattern.slice(1) : pattern, name) !== negated);
}
function serializeMatcher(value, depth = 0) {
  if (depth > 6) throw new Error('invalid_interceptor_matcher: deeper than 6 levels');
  if (value instanceof RegExp) return { $regex: value.source, $flags: value.flags };
  if (Array.isArray(value)) return value.map(item => serializeMatcher(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key.startsWith('$')) throw new Error('invalid_interceptor_matcher: keys cannot start with $');
    return [key, serializeMatcher(item, depth + 1)];
  }));
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  throw new Error('invalid_interceptor_matcher');
}
function matches(matcher, value) {
  if (Array.isArray(matcher)) return matcher.some(alternative => matches(alternative, value));
  if (Array.isArray(value)) return value.some(item => matches(matcher, item));
  if (matcher instanceof RegExp) {
    matcher.lastIndex = 0;
    return value !== undefined && value !== null && typeof value !== 'object' && matcher.test(String(value));
  }
  if (matcher && typeof matcher === 'object') return !!value && typeof value === 'object' && Object.entries(matcher).every(([key, item]) => matches(item, value[key]));
  return matcher === value;
}
function intercept(event) {
  const entry = interceptors[Number(request.name)];
  if (!entry) throw new Error('unknown_handler');
  const { surface: name, input, original, origin, caught } = event;
  if (!caught && entry.matcher !== null && !matches(entry.matcher, input)) return { unmatched: true };
  const started = clock();
  let trace = Object.freeze([]);
  const signal = { aborted: false };
  const next = argument => {
    if (argument === undefined) return Promise.reject(new Error('continuation_input_required: ' + entry.location));
    if (caught?.called) return caught.error_after_next ? Promise.reject(new Error(caught.error_after_next)) : Promise.resolve(deepFreeze(structuredCloneFallback(caught.result)));
    let reply;
    try {
      reply = hostCall('continuation.next', { input: argument });
    } catch (error) {
      if (error === suspension) throw error;
      if (String(error?.message).startsWith('callback_cancelled')) signal.aborted = true;
      return Promise.reject(error);
    }
    trace = deepFreeze(reply.trace);
    return Promise.resolve(deepFreeze(reply.result));
  };
  Object.defineProperties(next, {
    event: { value: name },
    original: { value: deepFreeze(original) },
    origin: { value: deepFreeze(origin) },
    signal: { value: Object.freeze({ get aborted() { return signal.aborted; } }) },
    trace: { get: () => trace },
    budget: { value: Object.freeze({ ms: request.hook_budget_ms, get remainingMs() { return Math.max(0, request.hook_budget_ms - (clock() - started)); }, get hostCalls() { return Math.max(0, 32 - calls.length); } }) },
    is: { value: pattern => surfaces(pattern).includes(name) },
  });
  if (caught) Object.defineProperties(next, { error: { value: deepFreeze(caught.error) }, called: { value: caught.called } });
  const handler = caught ? entry.catch : entry.handler;
  return Promise.resolve(handler(deepFreeze(structuredCloneFallback(input)), next)).then(result => {
    if (result === undefined) throw new Error('interceptor_result_required: ' + entry.location);
    return rendering ? { result, reads: [...reads] } : { result };
  });
}
function requireCapability(name) {
  if (!request.capabilities.includes(name)) throw new Error('capability_denied: ' + name);
}
function writeState(value) {
  requireCapability(surface.state);
  if (rendering && !activating) throw new Error('render_side_effect_refused: state writes belong in events, commands or subscriptions');
  state = structuredCloneFallback(value);
}
function keyed() {
  requireCapability(surface.state);
  if (state === null || state === undefined) return {};
  if (typeof state !== 'object' || Array.isArray(state)) throw new Error('state_not_keyed: atoms need an object state');
  return state;
}
function cell(key, fallback, path) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(key)) throw new Error('invalid_atom_key: ' + key);
  const read = () => {
    track(key);
    const value = path === undefined ? keyed()[key] : keyed()[key]?.[path];
    return structuredCloneFallback(value === undefined ? fallback : value);
  };
  const write = value => {
    if (value === undefined) throw new Error('atom_value_required: ' + key);
    const next = { ...keyed() };
    next[key] = path === undefined ? value : { ...(next[key] ?? {}), [path]: value };
    writeState(next);
  };
  const atom = { key: path === undefined ? key : key + '/' + path, get: read, set: write, update(change) { write(change(read())); }, peek: () => {
    const value = path === undefined ? keyed()[key] : keyed()[key]?.[path];
    return JSON.stringify(value === undefined ? fallback : value);
  } };
  return Object.freeze(atom);
}
function derive(compute) {
  if (typeof compute !== 'function') throw new Error('handler_required: derive');
  let cached;
  let deps = null;
  let seen = null;
  const signature = () => JSON.stringify(deps.map(key => key === '*' ? state : keyed()[key]));
  const run = () => {
    const outer = tracking;
    tracking = new Set();
    try {
      cached = compute();
    } finally {
      deps = [...tracking];
      if (outer) deps.forEach(key => outer.add(key));
      tracking = outer;
    }
    seen = signature();
  };
  return Object.freeze({ key: null, get() {
    if (deps === null || seen !== signature()) run();
    else deps.forEach(track);
    return structuredCloneFallback(cached);
  }, peek() { return JSON.stringify(compute()); } });
}
async function flushSubscriptions() {
  if (rendering || !subscriptions.length) return;
  const before = (() => { const saved = state; state = JSON.parse(initial); try { return subscriptions.map(entry => entry.target.peek()); } finally { state = saved; } })();
  const seen = before.slice();
  for (let round = 0; round < 8; round += 1) {
    let changed = false;
    for (const [index, entry] of subscriptions.entries()) {
      if (!entry.active) continue;
      const now = entry.target.peek();
      if (now === seen[index]) continue;
      const previous = seen[index] === undefined ? undefined : JSON.parse(seen[index]);
      seen[index] = now;
      changed = true;
      await entry.handler(JSON.parse(now), previous);
    }
    if (!changed) return;
  }
  throw new Error('subscription_cascade_limit');
}
function unique(map, name, handler) {
  if (map.has(name)) throw new Error('conflict: ' + name);
  if (typeof handler !== 'function') throw new Error('handler_required: ' + name);
  map.set(name, handler);
}
const timers = new Map();
async function dispatchTimer(event) {
  const entry = timers.get(event?.key);
  if (!entry) return null;
  const result = await entry.handler({ key: entry.key });
  if (entry.repeat && result !== false) hostCall('events.schedule', { key: event.key, delay_ms: entry.ms });
  return null;
}
function timer(key, ms, handler, repeat) {
  requireCapability('events');
  if (!activating) throw new Error('timer_registration_outside_activation');
  if (typeof key !== 'string' || !/^[A-Za-z0-9_.-]{1,58}$/.test(key)) throw new Error('invalid_timer_key: ' + key);
  if (!Number.isSafeInteger(ms) || ms < 1000 || ms > 86400000) throw new Error('invalid_timer_interval: ' + key);
  if (typeof handler !== 'function') throw new Error('handler_required: ' + key);
  const scheduled = 'time:' + key;
  if (timers.has(scheduled)) throw new Error('conflict: ' + scheduled);
  if (!timers.size) {
    unique(handlers, 'timer', dispatchTimer);
    registrations.events.push('timer');
  }
  timers.set(scheduled, { key, ms, handler, repeat });
  return Object.freeze({
    start() { return hostCall('events.schedule', { key: scheduled, delay_ms: ms }); },
    cancel() { return hostCall('events.cancel', { key: scheduled }); },
  });
}
function workspacePath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\0')) throw new Error('invalid_workspace_path: ' + path);
  const parts = path.split('/').filter(part => part && part !== '.');
  if (!parts.length || parts.includes('..')) throw new Error('invalid_workspace_path: ' + path);
  return parts.join('/');
}
function number(value) { return Number.isFinite(value) ? value : null; }
const api = Object.freeze({
  version: request.api,
  fieldPolicies: Object.freeze(structuredCloneFallback(request.field_policies ?? {})),
  host: Object.freeze({ call: hostCall, tryCall: hostTryCall }),
  assets: Object.freeze({ read(name) {
    if (name === request.entrypoint) return { text: request.source, sha256: request.entrypoint_sha256 };
    if (typeof name !== 'string' || !Object.hasOwn(request.assets ?? {}, name)) throw new Error('package_asset_unavailable');
    return structuredCloneFallback(request.assets[name]);
  } }),
  services: Object.freeze({ call(name, method, input = null) { return hostCall('mods.service', { name, method, input }); } }),
  settings: Object.freeze(structuredCloneFallback(request.settings)),
  on(event, handler) {
    const capability = Object.hasOwn(surface.events, event) ? surface.events[event] : undefined;
    if (!capability) throw new Error('unsupported_event: ' + event);
    requireCapability(capability);
    unique(handlers, event, handler);
    registrations.events.push(event);
  },
  middleware(event, handler) {
    if (!surface.middleware.includes(event)) throw new Error('unsupported_middleware_event: ' + event);
    requireCapability('middleware');
    if (event === 'approval') requireCapability('approvals');
    unique(handlers, event, handler);
    registrations.events.push(event);
  },
  intercept(pattern, options, handler) {
    if (handler === undefined) [options, handler] = [{}, options];
    if (!activating) throw new Error('interceptor_registration_outside_activation');
    if (!surfaces(pattern).length) throw new Error('unsupported_intercept_pattern_or_capability: ' + pattern);
    if (typeof handler !== 'function') throw new Error('handler_required: ' + pattern);
    const known = ['match', 'required', 'before', 'after'];
    for (const key of Object.keys(options ?? {})) if (!known.includes(key)) throw new Error('unsupported_interceptor_option: ' + key);
    const frame = String(new Error().stack).split(String.fromCharCode(10)).find(line => line.includes(request.filename)) ?? '';
    const at = frame.slice(frame.lastIndexOf(request.filename) + request.filename.length).split(')')[0];
    const entry = { handler, catch: null, matcher: options?.match ?? null, location: request.filename.slice(request.filename.lastIndexOf('/') + 1) + at };
    const registration = { pattern, match: entry.matcher === null ? null : serializeMatcher(entry.matcher), required: options?.required === true,
      before: [...(options?.before ?? [])], after: [...(options?.after ?? [])], catch: false, location: entry.location };
    interceptors.push(entry);
    registrations.interceptors.push(registration);
    return Object.freeze({ catch(fallback) {
      if (!activating || entry.catch) throw new Error('interceptor_catch_conflict: ' + entry.location);
      if (typeof fallback !== 'function') throw new Error('handler_required: catch');
      entry.catch = fallback;
      registration.catch = true;
    } });
  },
  replace(point, handler) {
    if (!surface.replacements.includes(point)) throw new Error('unsupported_replacement_point: ' + point);
    api.on(point, handler);
    registrations.replacements.push(point);
  },
  contract(definition) {
    requireCapability(surface.contracts);
    if (!activating) throw new Error('contract_registration_outside_activation');
    if (registrations.contracts.some(entry => entry.id === definition?.id)) throw new Error('conflict: ' + definition?.id);
    registrations.contracts.push(structuredCloneFallback(definition));
  },
  builtins(controls) {
    requireCapability('builtins');
    if (!activating) throw new Error('builtins_registration_outside_activation');
    if (registrations.builtins.length) throw new Error('conflict: builtins');
    registrations.builtins.push(structuredCloneFallback(controls ?? {}));
  },
  provide(contract, handlers) {
    requireCapability('services');
    if (!activating) throw new Error('service_registration_outside_activation');
    if (!contract || typeof contract.name !== 'string' || typeof contract.version !== 'string' || !contract.methods || !handlers) throw new Error('invalid_service_registration');
    if (registrations.services.some(entry => entry.name === contract.name)) throw new Error('conflict: ' + contract.name);
    for (const name of Object.keys(contract.methods)) unique(serviceHandlers, contract.name + '.' + name, handlers[name]);
    registrations.services.push(structuredCloneFallback(contract));
  },
  dynamicTools(handler) {
    requireCapability('tools');
    if (!activating) throw new Error('dynamic_tools_registration_outside_activation');
    if (dynamicTools || typeof handler !== 'function') throw new Error('conflict: dynamicTools');
    dynamicTools = handler;
    registrations.dynamic_tools = true;
  },
  tool(spec, handler) {
    requireCapability('tools');
    unique(tools, spec.name, handler);
    registrations.tools.push(spec);
  },
  virtualRead(definition, handler) {
    requireCapability('virtual_reads');
    if (!activating) throw new Error('virtual_registration_outside_activation');
    if (!definition || typeof definition.scheme !== 'string' || typeof definition.version !== 'string') throw new Error('invalid_virtual_registration');
    unique(virtualReaders, definition.scheme, handler);
    registrations.virtual_reads.push(structuredCloneFallback(definition));
  },
  command(name, handler, options = {}) {
    requireCapability('commands');
    for (const key of Object.keys(options ?? {})) if (!['description', 'cli', 'args_hint', 'immediate'].includes(key)) throw new Error('unsupported_command_option: ' + key);
    unique(commands, name, handler);
    const entry = { name };
    for (const key of ['description', 'cli', 'args_hint', 'immediate']) if (options?.[key] !== undefined) entry[key] = options[key];
    registrations.commands.push(entry);
  },
  progress(text) {
    if (activating || request.event !== 'tool') throw new Error('progress_outside_tool');
    if (typeof text !== 'string' || text.length === 0 || text.length > 1024) throw new Error('invalid_progress');
    if (updates.length >= 32) throw new Error('progress_limit');
    updates.push(text);
  },
  state: Object.freeze({
    get() { requireCapability(surface.state); track('*'); return structuredCloneFallback(state); },
    set: writeState,
  }),
  atom(key, fallback = null) { return cell(key, fallback); },
  member(key, id, fallback = null) {
    if (typeof id !== 'string' || !id || id.length > 128) throw new Error('invalid_atom_member: ' + id);
    return cell(key, fallback, id);
  },
  derive,
  subscribe(target, handler) {
    if (!activating) throw new Error('subscription_outside_activation');
    if (!target || typeof target.peek !== 'function') throw new Error('invalid_subscription_target');
    if (typeof handler !== 'function') throw new Error('handler_required: subscribe');
    if (subscriptions.length >= 64) throw new Error('subscription_limit');
    const entry = { target, handler, active: true };
    subscriptions.push(entry);
    return () => { entry.active = false; };
  },
  unsupported(operation) { throw new Error('unsupported_operation: ' + operation); },
  package: Object.freeze({ id: request.package?.id ?? null, version: request.package?.version ?? null, sha256: request.entrypoint_sha256 ?? null }),
  session() { return hostCall('session.info', null); },
  time: Object.freeze({
    sleep(ms) { return hostCall('time.sleep', { ms }); },
    async wait(check, options = {}) {
      const interval = options.interval_ms ?? 1000;
      const timeout = options.timeout_ms ?? 10000;
      let waited = 0;
      for (;;) {
        const value = await check();
        if (value) return { value, waited_ms: waited, timed_out: false, cancelled: false };
        if (waited >= timeout) return { value, waited_ms: waited, timed_out: true, cancelled: false };
        const slept = hostCall('time.sleep', { ms: Math.min(interval, timeout - waited) });
        waited += slept.slept_ms;
        if (slept.cancelled) return { value, waited_ms: waited, timed_out: false, cancelled: true };
      }
    },
    after(key, delay_ms, handler) { return timer(key, delay_ms, handler, false); },
    every(key, interval_ms, handler) { return timer(key, interval_ms, handler, true); },
  }),
  fs: Object.freeze({
    exists(path) {
      const normalized = workspacePath(path);
      return hostCall('workspace.stat', { paths: [normalized] }).files[normalized] !== null;
    },
    canonical(path) {
      const normalized = workspacePath(path);
      const stat = hostCall('workspace.stat', { paths: [normalized], hash: true }).files[normalized];
      return stat ? { path: normalized, kind: stat.kind, sha256: stat.sha256 ?? null } : null;
    },
    ancestors(name, from) {
      if (typeof name !== 'string' || !name || name.includes('/')) throw new Error('invalid_ancestor_name: ' + name);
      let start = from;
      if (start === undefined) {
        const session = hostCall('session.info', null);
        const root = String(session.root);
        const cwd = String(session.cwd ?? root);
        start = cwd.startsWith(root + '/') ? cwd.slice(root.length + 1) : '';
      }
      const parts = start ? workspacePath(start).split('/') : [];
      const candidates = [];
      for (let depth = parts.length; depth >= 0 && candidates.length < 64; depth -= 1) candidates.push([...parts.slice(0, depth), name].join('/'));
      const files = hostCall('workspace.stat', { paths: candidates }).files;
      return candidates.filter(path => files[path]).map(path => ({ path, kind: files[path].kind }));
    },
  }),
  classify(text, labels, options = {}) {
    if (!Array.isArray(labels) || labels.length < 2 || labels.length > 32 || new Set(labels).size !== labels.length
      || labels.some(label => typeof label !== 'string' || !label || label.length > 64)) throw new Error('invalid_classify_labels');
    if (typeof options.route !== 'string') throw new Error('classify_route_required');
    const instructions = 'Classify the text into exactly one of these labels: ' + labels.join(', ') + '.'
      + (options.instructions ? ' ' + options.instructions : '') + ' Reply with JSON {"label": <label>}.';
    const call = { route: options.route, prompt: text, system: instructions,
      output: { schema: { type: 'object', properties: { label: { type: 'string', enum: labels } }, required: ['label'], additionalProperties: false } } };
    for (const key of ['effort', 'timeout_ms', 'max_output_tokens']) if (options[key] !== undefined) call[key] = options[key];
    const result = hostCall('model.complete', call);
    let label = null;
    try {
      const parsed = JSON.parse(result.text);
      if (labels.includes(parsed?.label)) label = parsed.label;
    } catch {}
    return { label, result };
  },
  usage: Object.freeze({
    summarize(response) {
      const usage = response?.usage && typeof response.usage === 'object' ? response.usage : null;
      const input = number(usage?.input_tokens);
      const output = number(usage?.output_tokens);
      const window = number(response?.context_window);
      const basis = response?.cost?.basis ?? 'unpriced';
      return {
        request_id: response?.request_id ?? null, route: response?.route ?? null, provider: response?.provider ?? null,
        credential: response?.credential ?? null, requested_model: response?.requested_model ?? null, served_model: response?.served_model ?? null,
        measured: usage !== null,
        tokens: { input, cached: number(usage?.input_tokens_details?.cached_tokens), cache_write: number(usage?.input_tokens_details?.cache_write_tokens),
          output, reasoning: number(usage?.output_tokens_details?.reasoning_tokens) },
        context: window !== null && input !== null ? { used: input + (output ?? 0), window, ratio: (input + (output ?? 0)) / window } : null,
        cost: { microusd: number(response?.cost?.microusd), basis,
          source: basis === 'settled' || basis === 'unsettled' ? 'configured_rates' : basis === 'included_subscription' ? 'subscription' : basis === 'synthetic' ? 'none' : 'unknown' },
        timing: response?.timing ?? null, synthetic: response?.synthetic ?? null,
      };
    },
    rateLimits() {
      const read = hostTryCall('app.request', { method: 'account/rateLimits/read', params: {} });
      return read.ok ? { available: true, value: read.value } : { available: false, reason: read.error };
    },
  }),
});
globalThis.__omd = { api, handlers, intercept, flushSubscriptions, tools, dynamicTool: name => dynamicTools && (input => dynamicTools({ name, arguments: input })), commands, serviceHandlers, virtualReaders, registrations, updates,
  state: () => rendering ? request.state : state, request, calls,
  pending: () => pending, ready: () => { activating = false; }, suspension };
`;
try {
  const setup = new SourceTextModule(bootstrap, { context });
  await setup.link(() => { throw new Error('unsupported_import'); });
  await setup.evaluate({ timeout: request.hook_budget_ms });
  const source = stripTypeScriptTypes(request.source);
  const mod = new SourceTextModule(source, { context, identifier: request.filename });
  const adapter = request.surface?.adapter;
  let adapt = null;
  const aliases = new Map();
  if (adapter) {
    const adapterSource = stripTypeScriptTypes(adapter.source);
    const adapterModule = new SourceTextModule(adapterSource, { context, identifier: adapter.filename });
    await adapterModule.link(() => { throw new Error('unsupported_import: adapter modules are self-contained'); });
    await adapterModule.evaluate({ timeout: request.hook_budget_ms });
    adapt = adapterModule.namespace.default;
    if (typeof adapt !== 'function') throw new Error('adapter_default_export_required');
    for (const [specifier, module] of Object.entries(adapter.aliases ?? {})) {
      const aliasSource = module.filename.endsWith('.ts') ? stripTypeScriptTypes(module.source) : module.source;
      const aliased = new SourceTextModule(aliasSource, { context, identifier: module.filename });
      await aliased.link(() => { throw new Error('unsupported_import: adapter aliases are self-contained'); });
      aliases.set(specifier, aliased);
    }
  }
  context.__adapt = adapt;
  await mod.link(async specifier => {
    if (aliases.has(specifier)) return aliases.get(specifier);
    throw new Error(`unsupported_import: ${specifier}; use type-only SDK imports and a self-contained module`);
  });
  await mod.evaluate({ timeout: request.hook_budget_ms });
  context.__activate = mod.namespace.default;
  const dispatch = new SourceTextModule(`
    const { api, handlers, tools, commands, serviceHandlers, virtualReaders, registrations, request } = globalThis.__omd;
    if (typeof globalThis.__activate !== 'function') throw new Error('default_export_required');
    const activation = typeof globalThis.__adapt === 'function' ? await globalThis.__adapt(api) : api;
    await globalThis.__activate(activation);
    globalThis.__omd.ready();
    let value = null;
    try {
    if (request.event !== 'inspect') {
      const handler = request.event === 'tool' ? tools.get(request.name) ?? globalThis.__omd.dynamicTool(request.name)
        : request.event === 'command' ? commands.get(request.name)
        : request.event === 'virtual_read' ? virtualReaders.get(request.name)
        : request.event === 'service' ? serviceHandlers.get(request.name)
        : request.event === 'intercept' ? globalThis.__omd.intercept : handlers.get(request.event);
      if (!handler && ['tool', 'command', 'service'].includes(request.event)) throw new Error('unknown_handler');
      if (handler) value = await handler(request.payload) ?? null;
      await globalThis.__omd.flushSubscriptions();
    }
    if (globalThis.__omd.pending()) throw new Error('swallowed_host_suspension');
    } catch (error) {
      if (error !== globalThis.__omd.suspension) throw error;
    }
    if (globalThis.__omd.calls.length < (request.receipts ?? []).length) throw new Error('host_call_replay_diverged');
    globalThis.__result = JSON.stringify({ registrations, state: globalThis.__omd.state(), value,
      calls: globalThis.__omd.calls, host_call: globalThis.__omd.pending(), updates: globalThis.__omd.updates });
  `, { context });
  await dispatch.link(() => { throw new Error('unsupported_import'); });
  await dispatch.evaluate(request.interactive ? {} : { timeout: request.hook_budget_ms });
  if (context.__result.length > 262144) throw new Error('output_limit');
  process.stdout.write(context.__result);
} catch (error) {
  const files = [request.filename, request.surface?.adapter?.filename,
    ...Object.values(request.surface?.adapter?.aliases ?? {}).map(module => module.filename)].filter(Boolean);
  const directories = [...new Set(files.map(file => file.slice(0, file.lastIndexOf('/'))))];
  const relative = text => directories.reduce((line, directory) =>
    line.replaceAll(directory + '/', directory.slice(directory.lastIndexOf('/') + 1) + '/'), text);
  const lines = String(error?.stack ?? error).split('\n');
  const frames = lines.filter(line => /^\s+at /.test(line));
  const described = [...lines.filter(line => !/^\s+at /.test(line)),
    ...frames.filter(line => directories.some(directory => line.includes(directory + '/'))).slice(0, 4)];
  process.stdout.write(JSON.stringify({ error: relative(described.join('\n')).slice(0, 768) }));
  process.exitCode = 1;
}
