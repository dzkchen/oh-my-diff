import type { Json, ModAPI, ResourceRef } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  const retain = () => {
    const source = api.host.call('workspace.read', { paths: ['fact.txt'] }).files['fact.txt'];
    if (!source) throw new Error('fixture_fact_missing');
    return api.host.call('store.put', { key: 'fixture-fact', expected_revision: null,
      value: { id: 'fixture-fact', source: 'fact.txt:1', text: source.text, sha256: source.sha256 } });
  };
  const freeze = () => {
    const entry = api.host.call('store.get', { key: 'fixture-fact' });
    if (!entry) throw new Error('retain_fixture_fact_first');
    const reference = api.host.call('evidence.write', { media_type: 'application/json', label: 'Selected fixture fact', content: entry.value });
    api.state.set(reference);
    return reference;
  };
  api.tool({ name: 'worker', description: 'Exercise a read-only worker with a frozen fixture snapshot and selected fact.', parameters: { type: 'object', properties: {}, additionalProperties: false } }, () => {
    const evidence = freeze();
    const snapshot = api.host.call('workspace.snapshot', {}).snapshot;
    const route = api.host.call('routes.list', null).find(item => item.name === 'reviewer' && item.available && item.roles.includes('worker'));
    if (!route) throw new Error('configured_reviewer_route_unavailable');
    const worker = api.host.call('agents.spawn', { role: 'context_probe', route: route.name, prompt: 'Report the selected fixture fact.', tools: [], workspace: 'read_only', snapshot, evidence });
    return { route: route.name, worker: api.host.call('agents.wait', { handle: worker.handle, consume: true }) };
  });
  api.command('sessions', () => {
    const listed = api.host.tryCall('sessions.list', { limit: 2 });
    return listed.ok ? listed.value as unknown as Json : { display: 'Session listing runs from the CLI: omd example-sessions' };
  }, { cli: 'example-sessions' });
  api.command('inspect', () => api.host.call('store.get', { key: 'fixture-fact' }), { cli: 'example-inspect' });
  api.command('retain', retain);
  api.command('freeze', freeze);
  api.on('context', () => {
    const reference = api.state.get() as ResourceRef | null;
    if (!reference) return null;
    const result = api.host.tryCall('evidence.read', { reference, max_bytes: 4096 });
    return result.ok ? { text: result.value.text } : null;
  });
}
