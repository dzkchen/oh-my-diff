import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.command('packages', () => {
    const { packages, generation } = api.host.call('packages.list', null);
    return { display: [`generation ${generation}`, ...packages.map(p => `${p.enabled ? '●' : '○'} ${p.id} ${p.version} (saved default: ${p.inherited_enabled ? 'on' : 'off'})${p.failed ? ` failed: ${p.failed}` : ''}`)].join('\n') };
  });
  api.command('disable', id => {
    const { generation } = api.host.call('packages.list', null);
    return api.host.call('packages.apply', { action: 'disable', target: 'terminal', id: String(id), expected_generation: generation });
  });
  api.command('reset-mod', id => {
    const { generation } = api.host.call('packages.list', null);
    return api.host.call('packages.apply', { action: 'reset', id: String(id), expected_generation: generation });
  });
  api.command('save-mod-defaults', id => {
    const { generation } = api.host.call('packages.list', null);
    return api.host.call('packages.apply', { action: 'save-defaults', id: String(id), expected_generation: generation });
  });
}
