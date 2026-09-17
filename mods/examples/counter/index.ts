import type { ModAPI } from '../../api.d.ts';
export default function activate(api: ModAPI) {
  api.tool({ name: 'count', description: 'Increment this mod\'s persistent counter.',
    parameters: { type: 'object', properties: {}, additionalProperties: false } }, () => {
    const count = Number(api.state.get() ?? 0) + 1;
    api.state.set(count);
    return { count };
  });
  api.command('reset', () => { api.state.set(0); return { count: 0 }; });
}
