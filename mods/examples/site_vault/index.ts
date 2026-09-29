import type { ModAPI } from '@oh-my-diff/mod-api';

export default function activate(api: ModAPI) {
  api.command('vault_add', text => {
    const [label, origin] = String(text).split(/\s+/);
    const result = api.host.call('credentials.request', { action: 'enroll', kind: 'secret', label, origin });
    return { display: result.status === 'completed' ? `Stored secret ${label} for ${origin}` : 'Declined' };
  });
  api.command('vault_start', () => {
    const secrets = api.host.call('credentials.list', null).filter(profile => profile.kind === 'secret').map(profile => profile.id);
    api.host.call('sidecars.start', { id: 'browser', secrets });
    return { display: `Browser sidecar started with ${secrets.length} secret(s)` };
  });
}
