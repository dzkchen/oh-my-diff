import type { ModAPI } from '@oh-my-diff/mod-api';
export default function activate(api: ModAPI) {
  api.tool({ name: 'compare', label: 'Compare investigations', description: 'Compare two read-only native investigations', parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } }, args => {
    if (!args || Array.isArray(args) || typeof args !== 'object' || typeof args.prompt !== 'string') throw new Error('prompt required');
    const routes = api.host.call('routes.list', null).filter(route => route.available && route.roles.includes('worker') && route.billing === 'included_subscription');
    const firstRoute = routes[0];
    const secondRoute = routes.find(route => route.provider !== firstRoute?.provider || route.model !== firstRoute?.model);
    if (!firstRoute || !secondRoute) throw new Error('two_distinct_included_worker_routes_required');
    const snapshot = api.host.call('workspace.snapshot', {}).snapshot;
    const first = api.host.call('agents.spawn', { role: 'investigator', route: firstRoute.name, prompt: args.prompt, workspace: 'read_only', tools: [], snapshot });
    api.progress('Investigator started');
    const secondResult = api.host.tryCall('agents.spawn', { role: 'reviewer', route: secondRoute.name, prompt: `Independently inspect: ${args.prompt}`, workspace: 'read_only', tools: [], snapshot });
    if (!secondResult.ok) {
      api.host.tryCall('agents.cancel', { handle: first.handle });
      throw new Error(secondResult.error);
    }
    const second = secondResult.value;
    api.progress('Reviewer started');
    const results = [first, second].map(agent => api.host.call('agents.wait', { handle: agent.handle, consume: true }));
    return { results };
  });
  api.on('agent_end', ({ role, status }) => {
    const finished = api.state.get();
    api.state.set([...(Array.isArray(finished) ? finished : []), `${role}:${status}`].slice(-16));
  });
}
