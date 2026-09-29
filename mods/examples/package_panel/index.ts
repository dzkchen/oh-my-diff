import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.command('packages', () => {
    const { packages, generation } = api.host.call('packages.list', null);
    return { display: [`generation ${generation}`, ...packages.map(p => `${p.enabled ? '●' : '○'} ${p.id} ${p.version}${p.failed ? ` failed: ${p.failed}` : ''}`)].join('\n') };
  });
  api.command('disable', id => {
    const { generation } = api.host.call('packages.list', null);
    return api.host.call('packages.apply', { action: 'disable', id: String(id), expected_generation: generation });
  });
}
