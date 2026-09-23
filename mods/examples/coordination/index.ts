import type { ModAPI } from '@oh-my-diff/mod-api';
export default function activate(api: ModAPI) {
  api.tool({ name: 'compare', label: 'Compare investigations', description: 'Compare two read-only native investigations', parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } }, args => {
    if (!args || Array.isArray(args) || typeof args !== 'object' || typeof args.prompt !== 'string') throw new Error('prompt required');
    const first = api.host.call('agents.spawn', { role: 'investigator', route: 'sol', prompt: args.prompt });
    api.progress('Investigator started');
    const second = api.host.call('agents.spawn', { role: 'reviewer', route: 'astra', prompt: `Independently inspect: ${args.prompt}` });
    api.progress('Reviewer started');
    const results = [first, second].map(agent => api.host.call('agents.wait', { handle: agent.handle, consume: true }));
    return { results };
  });
  api.on('agent_end', ({ role, status }) => {
    const finished = api.state.get();
    api.state.set([...(Array.isArray(finished) ? finished : []), `${role}:${status}`].slice(-16));
  });
}
