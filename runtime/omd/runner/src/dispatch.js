const { api, handlers, tools, commands, serviceHandlers, virtualReaders, completers, registrations, request } = globalThis.__omd;
if (typeof globalThis.__activate !== 'function') throw new Error('default_export_required');
const activation = typeof globalThis.__adapt === 'function' ? await globalThis.__adapt(api) : api;
await globalThis.__activate(activation);
globalThis.__omd.ready();
globalThis.__dispatch = async () => {
let value = null;
if (request.event !== 'inspect') {
  const handler = request.event === 'tool' ? tools.get(request.name) ?? globalThis.__omd.dynamicTool(request.name)
    : request.event === 'command' ? commands.get(request.name)
    : request.event === 'virtual_read' ? virtualReaders.get(request.name)
    : request.event === 'service' ? serviceHandlers.get(request.name)
    : request.event === 'completion' && request.payload?.kind === 'token' ? completers.get(request.payload.trigger)
    : request.event === 'intercept' ? globalThis.__omd.intercept
    : request.event === 'component' ? globalThis.__omd.component : handlers.get(request.event);
  if (!handler && ['tool', 'command', 'service'].includes(request.event)) throw new Error('unknown_handler');
  if (handler) value = await handler(request.payload) ?? null;
  await globalThis.__omd.flushSubscriptions();
}
if (globalThis.__omd.calls.length < (request.receipts ?? []).length) throw new Error('host_call_replay_diverged');
return JSON.stringify({ registrations, state: globalThis.__omd.state(), ...globalThis.__omd.ui(), value,
  calls: globalThis.__omd.calls, updates: globalThis.__omd.updates });

};
globalThis.__result = await globalThis.__dispatch();
