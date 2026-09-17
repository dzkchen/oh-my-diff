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
const context = createContext(Object.create(null), {
  codeGeneration: { strings: false, wasm: false },
});
const bootstrap = `
const request = JSON.parse(${JSON.stringify(JSON.stringify(request))});
const handlers = new Map();
const tools = new Map();
const commands = new Map();
const registrations = { tools: [], commands: [], events: [] };
let state = structuredCloneFallback(request.state);
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
  version: '0.1.0-experimental.1',
  settings: Object.freeze(structuredCloneFallback(request.settings)),
  on(event, handler) {
    const capability = { context: 'context', start: 'lifecycle', idle: 'lifecycle',
      stop: 'lifecycle', resume: 'lifecycle', tool_result: 'lifecycle' }[event];
    if (!capability) throw new Error('unsupported_event: ' + event);
    requireCapability(capability);
    unique(handlers, event, handler);
    registrations.events.push(event);
  },
  tool(spec, handler) {
    requireCapability('tools');
    unique(tools, spec.name, handler);
    registrations.tools.push(spec);
  },
  command(name, handler) {
    requireCapability('commands');
    unique(commands, name, handler);
    registrations.commands.push(name);
  },
  state: Object.freeze({
    get() { requireCapability('state'); return structuredCloneFallback(state); },
    set(value) { requireCapability('state'); state = structuredCloneFallback(value); },
  }),
  unsupported(operation) { throw new Error('unsupported_operation: ' + operation); },
});
globalThis.__omd = { api, handlers, tools, commands, registrations,
  state: () => state, request };
`;
try {
  const setup = new SourceTextModule(bootstrap, { context });
  await setup.link(() => { throw new Error('unsupported_import'); });
  await setup.evaluate({ timeout: 1000 });
  const source = stripTypeScriptTypes(request.source, { mode: 'strip', sourceUrl: request.filename });
  const mod = new SourceTextModule(source, { context, identifier: request.filename });
  await mod.link(specifier => { throw new Error(`unsupported_import: ${specifier}; use type-only SDK imports and a self-contained module`); });
  await mod.evaluate({ timeout: 1000 });
  context.__activate = mod.namespace.default;
  const dispatch = new SourceTextModule(`
    const { api, handlers, tools, commands, registrations, request } = globalThis.__omd;
    if (typeof globalThis.__activate !== 'function') throw new Error('default_export_required');
    await globalThis.__activate(api);
    let value = null;
    if (request.event !== 'inspect') {
      const handler = request.event === 'tool' ? tools.get(request.name)
        : request.event === 'command' ? commands.get(request.name) : handlers.get(request.event);
      if (!handler && ['tool', 'command'].includes(request.event)) throw new Error('unknown_handler');
      if (handler) value = await handler(request.payload) ?? null;
    }
    globalThis.__result = JSON.stringify({ registrations, state: globalThis.__omd.state(), value });
  `, { context });
  await dispatch.link(() => { throw new Error('unsupported_import'); });
  await dispatch.evaluate({ timeout: 1000 });
  if (context.__result.length > 65536) throw new Error('output_limit');
  process.stdout.write(context.__result);
} catch (error) {
  process.stdout.write(JSON.stringify({ error: String(error?.stack ?? error).slice(0, 768) }));
  process.exitCode = 1;
}
