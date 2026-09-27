import type { ModAPI } from '@oh-my-diff/mod-api/0.1';
export default function activate(api: ModAPI) {
  api.tool({ name: 'count', label: 'Counter', description: 'Increment this mod\'s persistent counter.',
    parameters: { type: 'object', properties: {}, additionalProperties: false } }, () => {
    const count = Number(api.state.get() ?? 0) + 1;
    api.progress(`Counter at ${count}`);
    api.state.set(count);
    return { count };
  });
  api.command('reset', () => { api.state.set(0); return { display: 'Counter reset to 0' }; }, { description: 'Reset the persistent counter' });
  api.command('show', () => ({ display: `Counter is ${Number(api.state.get() ?? 0)}` }), { description: 'Show the persistent counter' });
  api.command('ask', args => ({ submit: `Use the counter tool ${typeof args === 'string' && args ? args : 'once'} and report the result.` }), { description: 'Ask the agent to use the counter' });
}
