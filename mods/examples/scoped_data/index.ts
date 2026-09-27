import type { ModAPI, ResourceRef } from '@oh-my-diff/mod-api/0.1';

export default function activate(api: ModAPI) {
  api.tool({ name: 'worker', description: 'Exercise a worker with explicitly frozen fixture context.', parameters: { type: 'object', properties: {}, additionalProperties: false } }, () => {
    api.host.call('knowledge.retain', { expected_revision: 0, id: 'fixture-fact', label: 'Fixture source', source: { path: 'fact.txt', start_line: 1, end_line: 1 } });
    const snapshot = api.host.call('context.freeze', { mode: 'reuse', ids: ['fixture-fact'], max_bytes: 4096 });
    const presets = api.host.call('workers.presets', null);
    const worker = api.host.call('agents.spawn', { role: 'context_probe', route: 'sol', prompt: 'Report the selected fixture fact.', tools: [], context_snapshot: snapshot });
    return { presets, worker: api.host.call('agents.wait', { handle: worker.handle, consume: true }) };
  });
  api.command('sessions', () => api.host.call('sessions.list', { limit: 2 }), { cli: 'example-sessions' });
  api.command('inspect', () => api.host.call('knowledge.inspect', {}), { cli: 'example-inspect' });
  api.command('retain', () => api.host.call('knowledge.retain', { expected_revision: 0, id: 'fixture-fact', label: 'Fixture source', source: { path: 'fact.txt', start_line: 1, end_line: 1 } }));
  api.command('freeze', () => {
    const reference = api.host.call('context.freeze', { mode: 'reuse', ids: ['fixture-fact'], max_bytes: 4096 });
    api.state.set(reference);
    return reference;
  });
  api.on('context', () => {
    const reference = api.state.get() as ResourceRef | null;
    if (!reference) return null;
    const result = api.host.tryCall('context.deliver', { snapshot: reference });
    return result.ok ? { text: JSON.stringify(result.value) } : null;
  });
}
