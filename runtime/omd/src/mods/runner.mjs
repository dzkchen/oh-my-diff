import { stripTypeScriptTypes } from 'node:module';
import { createContext, SourceTextModule } from 'node:vm';

if (process.versions.node !== '24.18.0') {
  process.stdout.write(JSON.stringify({ error: 'unsupported_runtime: Node 24.18.0 required' }));
  process.exit(1);
}

let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 524288) throw new Error('input_limit');
}
const request = JSON.parse(input);
request.hook_budget_ms ??= 1000;
const globals = Object.create(null);
if (request.environment?.includes('crypto')) globals.crypto = globalThis.crypto;
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
const commands = new Map();
const registrations = { tools: [], commands: [], events: [], replacements: [], contracts: [] };
registrations.services = [];
const serviceHandlers = new Map();
const updates = [];
let submitted = null;
let state = structuredCloneFallback(request.state);
let activating = true;
let pending = null;
const calls = [];
const receipts = request.receipts ?? [];
const suspension = Object.freeze({});
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
  pending = call;
  throw suspension;
}
function hostCall(operation, arguments_ = null) {
  const result = hostTryCall(operation, arguments_);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
function structuredCloneFallback(value) { return JSON.parse(JSON.stringify(value)); }
function requireCapability(name) {
  if (!request.capabilities.includes(name)) throw new Error('capability_denied: ' + name);
}
function unique(map, name, handler) {
  if (map.has(name)) throw new Error('conflict: ' + name);
  if (typeof handler !== 'function') throw new Error('handler_required: ' + name);
  map.set(name, handler);
}
const api = Object.freeze({
  version: request.api,
  fieldPolicies: Object.freeze(structuredCloneFallback(request.field_policies ?? {})),
  host: Object.freeze({ call: hostCall, tryCall: hostTryCall }),
  services: Object.freeze({ call(name, method, input = null) { return hostCall('mods.service', { name, method, input }); } }),
  settings: Object.freeze(structuredCloneFallback(request.settings)),
  on(event, handler) {
    const capability = { context: 'context', tool_before: 'interception', tool_exposure: 'tools', routing: 'routing', worker_context: 'context', terminal: 'terminal', compaction: 'compaction', migrate: 'state', input: 'input', start: 'lifecycle', idle: 'lifecycle',
      stop: 'lifecycle', resume: 'lifecycle', tool_result: 'lifecycle', workspace_write: 'workspace', workspace_pre_rename: 'workspace', turn_start: 'lifecycle', turn_end: 'lifecycle', compaction_start: 'lifecycle', compaction_end: 'lifecycle', agent_end: 'lifecycle', workflow: 'workflow',
      model_request: 'middleware', response_stream: 'middleware', prompt: 'middleware', session: 'middleware', agent: 'middleware', tool_call: 'middleware', host_operation: 'middleware' }[event];
    if (!capability) throw new Error('unsupported_event: ' + event);
    requireCapability(capability);
    unique(handlers, event, handler);
    registrations.events.push(event);
  },
  middleware(event, handler) {
    if (!['model_request','response_stream','prompt','session','agent','tool_call','tool_result','host_operation'].includes(event)) throw new Error('unsupported_middleware_event: ' + event);
    requireCapability('middleware');
    unique(handlers, event, handler);
    registrations.events.push(event);
  },
  replace(point, handler) {
    if (!['tool_before','routing','worker_context','terminal','compaction','context','input'].includes(point)) throw new Error('unsupported_replacement_point: ' + point);
    api.on(point, handler);
    registrations.replacements.push(point);
  },
  contract(definition) {
    requireCapability('workflow');
    if (!activating) throw new Error('contract_registration_outside_activation');
    if (registrations.contracts.some(entry => entry.id === definition?.id)) throw new Error('conflict: ' + definition?.id);
    registrations.contracts.push(structuredCloneFallback(definition));
  },
  provide(contract, handlers) {
    requireCapability('services');
    if (!activating) throw new Error('service_registration_outside_activation');
    if (!contract || typeof contract.name !== 'string' || typeof contract.version !== 'string' || !contract.methods || !handlers) throw new Error('invalid_service_registration');
    if (registrations.services.some(entry => entry.name === contract.name)) throw new Error('conflict: ' + contract.name);
    for (const name of Object.keys(contract.methods)) unique(serviceHandlers, contract.name + '.' + name, handlers[name]);
    registrations.services.push(structuredCloneFallback(contract));
  },
  tool(spec, handler) {
    requireCapability('tools');
    unique(tools, spec.name, handler);
    registrations.tools.push(spec);
  },
  command(name, handler, options = {}) {
    requireCapability('commands');
    for (const key of Object.keys(options ?? {})) if (key !== 'description') throw new Error('unsupported_command_option: ' + key);
    unique(commands, name, handler);
    registrations.commands.push(options?.description === undefined ? { name } : { name, description: options.description });
  },
  progress(text) {
    if (activating || request.event !== 'tool') throw new Error('progress_outside_tool');
    if (typeof text !== 'string' || text.length === 0 || text.length > 1024) throw new Error('invalid_progress');
    if (updates.length >= 32) throw new Error('progress_limit');
    updates.push(text);
  },
  state: Object.freeze({
    get() { requireCapability('state'); return structuredCloneFallback(state); },
    set(value) { requireCapability('state'); state = structuredCloneFallback(value); },
  }),
  unsupported(operation) { throw new Error('unsupported_operation: ' + operation); },
});
function unsupportedPi(name) { throw new Error('unsupported_pi_operation: ' + name); }
function piText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.some(c => c?.type !== 'text' || typeof c.text !== 'string')) unsupportedPi('non_text_content');
  return content.map(c => c.text).join('\\n');
}
const piContext = new Proxy(Object.freeze({ hasUI: false }), {
  get(target, key) { if (key in target) return target[key]; return unsupportedPi('context.' + String(key)); },
});
const pi = new Proxy(Object.freeze({
  registerTool(spec) {
    for (const key of Object.keys(spec)) if (!['name','label','description','parameters','execute'].includes(key)) unsupportedPi('tool.' + key);
    const definition = {name:spec.name,description:spec.description,parameters:spec.parameters};
    if (spec.label !== undefined) definition.label = spec.label;
    api.tool(definition, async args => {
      let last = null;
      const onUpdate = partial => { last = piText(partial?.content); api.progress(last); };
      const result = await spec.execute('omd:' + request.name, args, undefined, onUpdate, piContext);
      if (!Array.isArray(result?.content) || result.content.some(c => c.type !== 'text' || typeof c.text !== 'string')) unsupportedPi('non_text_tool_result');
      return last === null ? result : { ...result, last_update: last };
    });
  },
  registerCommand(name, options) {
    for (const key of Object.keys(options)) if (!['description','handler'].includes(key)) unsupportedPi('command.' + key);
    api.command(name, async args => {
      if (typeof args !== 'string') throw new Error('pi_command_requires_string');
      const value = await options.handler(args, piContext);
      return submitted === null ? (value ?? null) : { submit: submitted };
    }, options.description === undefined ? {} : { description: options.description });
  },
  sendUserMessage(content, options) {
    if (activating || request.event !== 'command') unsupportedPi('sendUserMessage outside command');
    if (options !== undefined) unsupportedPi('sendUserMessage.options');
    if (submitted !== null) unsupportedPi('multiple_user_messages');
    submitted = piText(content);
  },
}), { get(target,key) { if (key in target) return target[key]; return unsupportedPi(String(key)); } });
globalThis.__omd = { api, pi, handlers, tools, commands, serviceHandlers, registrations, updates,
  state: () => state, request, calls,
  pending: () => pending, ready: () => { activating = false; }, suspension };
`;
try {
  const setup = new SourceTextModule(bootstrap, { context });
  await setup.link(() => { throw new Error('unsupported_import'); });
  await setup.evaluate({ timeout: request.hook_budget_ms });
  const source = stripTypeScriptTypes(request.source, { mode: 'transform', sourceMap: true, sourceUrl: request.filename });
  const mod = new SourceTextModule(source, { context, identifier: request.filename });
  await mod.link(async specifier => {
    if (request.adapter === 'pi-0.74-tools-commands-v1' && specifier === 'typebox') {
      const types = new SourceTextModule(`
        const optional = new WeakSet();
        export const Type = Object.freeze({
          String: (options = {}) => ({...options,type:'string'}),
          Number: (options = {}) => ({...options,type:'number'}),
          Integer: (options = {}) => ({...options,type:'integer'}),
          Boolean: (options = {}) => ({...options,type:'boolean'}),
          Literal: value => ({const:value,type:typeof value}),
          Array: (items,options = {}) => ({...options,type:'array',items}),
          Union: anyOf => ({anyOf}),
          Optional: schema => { const result = {...schema}; optional.add(result); return result; },
          Object: (properties,options = {}) => ({additionalProperties:false,...options,type:'object',properties,required:Object.keys(properties).filter(k=>!optional.has(properties[k]))}),
        });
      `, { context });
      await types.link(() => { throw new Error('unsupported_import'); });
      return types;
    }
    throw new Error(`unsupported_import: ${specifier}; use type-only SDK imports and a self-contained module`);
  });
  await mod.evaluate({ timeout: request.hook_budget_ms });
  context.__activate = mod.namespace.default;
  const dispatch = new SourceTextModule(`
    const { api, handlers, tools, commands, serviceHandlers, registrations, request } = globalThis.__omd;
    if (typeof globalThis.__activate !== 'function') throw new Error('default_export_required');
    await globalThis.__activate(request.adapter === "pi-0.74-tools-commands-v1" ? globalThis.__omd.pi : api);
    globalThis.__omd.ready();
    let value = null;
    try {
    if (request.event !== 'inspect') {
      const handler = request.event === 'tool' ? tools.get(request.name)
        : request.event === 'command' ? commands.get(request.name)
        : request.event === 'service' ? serviceHandlers.get(request.name) : handlers.get(request.event);
      if (!handler && ['tool', 'command', 'service'].includes(request.event)) throw new Error('unknown_handler');
      if (handler) value = await handler(request.payload) ?? null;
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
  await dispatch.evaluate({ timeout: request.hook_budget_ms });
  if (context.__result.length > 65536) throw new Error('output_limit');
  process.stdout.write(context.__result);
} catch (error) {
  process.stdout.write(JSON.stringify({ error: String(error?.stack ?? error).slice(0, 768) }));
  process.exitCode = 1;
}
